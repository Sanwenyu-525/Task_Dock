//! 全局快速捕获（v0.7）：收集箱与草稿的 SQLite 存储层。
//!
//! 约束（对应 PLAN 第 3–5 节）：
//! - **单事务幂等提交**：`client_id` 唯一索引 + 事务内查重，重复提交只返回已有
//!   记录，绝不重复建任务；task/todo 的任务与收集箱条目同事务写入，任何一步
//!   失败整体回滚（不留孤儿任务，也不丢草稿）。
//! - **正文只存库**：错误信息、日志都不回显捕获正文，长度校验只报上限。
//! - 时间统一 UTC RFC3339（`crate::agents::now_iso`），列表按 `created_at DESC`。
//! - `source` 记录入口来源（当前固定 `capture`），供后续统计/排查，不含身份信息。

use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::agents::now_iso;
use crate::commands::tasks::{create_task_tx, TaskInput};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::nlp;

/// 合法捕获类型（与迁移 v17 的 CHECK、settings 白名单保持一致）。
pub const KINDS: &[&str] = &["task", "idea", "text", "todo", "link"];
/// 合法收集箱状态。
pub const STATUSES: &[&str] = &["inbox", "handled", "converted"];
/// 默认类型（设置缺失/非法时的回退值）。
pub const DEFAULT_KIND: &str = "task";
/// 设置键：上次选择的捕获类型。
pub const SETTING_LAST_TYPE: &str = "quick_capture_last_type";

/// 正文上限（trim 后字符数）。
pub const MAX_CONTENT: usize = 4000;
/// 链接上限。
pub const MAX_URL: usize = 2048;
/// 备注上限。
pub const MAX_NOTE: usize = 2000;
/// `client_id` 上限（前端 uuid，留足余量）。
pub const MAX_CLIENT_ID: usize = 128;
/// 任务标题上限（与 tasks::check_title 一致）。
pub const MAX_TITLE: usize = 200;
/// 任务描述上限（超出截断；标题绝不截断）。
pub const MAX_DESCRIPTION: usize = 1000;
/// 列表默认条数与上限。
pub const DEFAULT_LIST_LIMIT: u32 = 50;
pub const MAX_LIST_LIMIT: u32 = 200;
/// 入口来源标记。
const SOURCE_CAPTURE: &str = "capture";

const ITEM_COLUMNS: &str =
    "id, client_id, kind, content, url, note, status, task_id, source, created_at, updated_at";

// ── 数据模型（IPC 序列化，字段 snake_case，与仓库既有命令一致）──

/// 收集箱条目。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CaptureItem {
    pub id: String,
    pub client_id: String,
    pub kind: String,
    pub content: String,
    pub url: Option<String>,
    pub note: Option<String>,
    /// inbox（待处理）/ handled（已处理）/ converted（已转任务）
    pub status: String,
    pub task_id: Option<String>,
    pub source: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 单行草稿（`quick_capture_state` 恢复用）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CaptureDraft {
    pub kind: String,
    pub content: String,
    pub updated_at: String,
}

/// 快速捕获窗口初始状态。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CaptureState {
    pub draft: Option<CaptureDraft>,
    pub last_type: String,
    pub inbox_count: u32,
}

/// 提交入参（前端每次打开窗口生成一个 `client_id`，重试复用同一个）。
#[derive(Debug, Clone, Deserialize)]
pub struct SubmitCaptureInput {
    pub client_id: String,
    pub kind: String,
    pub content: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

/// 提交结果。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SubmitCaptureResult {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub task_id: Option<String>,
    /// true = 同一 `client_id` 已提交过，本次未新建任何数据
    pub duplicate: bool,
    pub created_at: String,
}

/// 草稿保存结果：前端只有拿到 `saved_at` 才显示「已保存」。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DraftSaved {
    pub saved_at: String,
}

// ── 校验 ────────────────────────────────────────────────────

fn is_kind(kind: &str) -> bool {
    KINDS.contains(&kind)
}

fn is_status(status: &str) -> bool {
    STATUSES.contains(&status)
}

/// 可选字段归一化：空白 → None；超长 → Validation（不回显正文）。
fn normalize_opt(v: Option<String>, max: usize, label: &str) -> AppResult<Option<String>> {
    match v {
        None => Ok(None),
        Some(s) => {
            let t = s.trim();
            if t.is_empty() {
                Ok(None)
            } else if t.chars().count() > max {
                Err(AppError::Validation(format!("{}超过 {} 字符", label, max)))
            } else {
                Ok(Some(t.to_string()))
            }
        }
    }
}

struct ValidatedSubmit {
    client_id: String,
    kind: String,
    content: String,
    url: Option<String>,
    note: Option<String>,
}

fn validate_submit(input: SubmitCaptureInput) -> AppResult<ValidatedSubmit> {
    let client_id = input.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err(AppError::Validation("client_id 不能为空".into()));
    }
    if client_id.chars().count() > MAX_CLIENT_ID {
        return Err(AppError::Validation(format!(
            "client_id 超过 {} 字符",
            MAX_CLIENT_ID
        )));
    }
    let kind = input.kind.trim().to_string();
    if !is_kind(&kind) {
        return Err(AppError::Validation("未知的捕获类型".into()));
    }
    let content = input.content.trim().to_string();
    if content.is_empty() {
        return Err(AppError::Validation("内容不能为空".into()));
    }
    if content.chars().count() > MAX_CONTENT {
        return Err(AppError::Validation(format!(
            "内容超过 {} 字符",
            MAX_CONTENT
        )));
    }
    let url = normalize_opt(input.url, MAX_URL, "链接")?;
    let note = normalize_opt(input.note, MAX_NOTE, "备注")?;
    Ok(ValidatedSubmit {
        client_id,
        kind,
        content,
        url,
        note,
    })
}

/// 按字符截断（标题/正文校验之外，仅描述允许截断）。
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// 取正文首行（trim）与剩余内容（trim）。
fn split_first_line(content: &str) -> (&str, &str) {
    match content.split_once('\n') {
        Some((first, rest)) => (first.trim(), rest.trim()),
        None => (content.trim(), ""),
    }
}

/// 构造任务入参：
/// - task：复用自然语言解析（时间/重复/提前提醒），标题取解析结果；
/// - todo：只取标题与描述，不解析时间、不写提醒（PLAN §3.1）。
fn build_task_input(kind: &str, content: &str) -> AppResult<TaskInput> {
    let (first, rest) = split_first_line(content);
    if first.is_empty() {
        return Err(AppError::Validation("内容不能为空".into()));
    }
    // 标题不静默截断：超长直接拒绝（错误信息不含正文）
    if first.chars().count() > MAX_TITLE {
        return Err(AppError::Validation(format!(
            "任务标题超过 {} 字符",
            MAX_TITLE
        )));
    }
    let description = truncate_chars(rest, MAX_DESCRIPTION);
    if kind == "todo" {
        return Ok(TaskInput {
            title: first.to_string(),
            description,
            ..Default::default()
        });
    }
    let parsed = nlp::parse(first);
    let parsed_title = parsed.title.trim();
    let title = if parsed_title.is_empty() {
        first.to_string()
    } else {
        parsed_title.to_string()
    };
    Ok(TaskInput {
        title,
        description,
        priority: None,
        category: None,
        tags: None,
        due_at: parsed
            .due_at
            .map(|d| Some(d.with_timezone(&Utc).to_rfc3339())),
        remind_at: None,
        advance_minutes: parsed.advance_minutes,
        recurrence: parsed.recurrence.map(Some),
    })
}

/// 在调用方事务内按类型建任务：task/todo 建任务，其余只进收集箱。
fn create_task_for(
    tx: &rusqlite::Transaction<'_>,
    kind: &str,
    content: &str,
) -> AppResult<Option<String>> {
    if kind != "task" && kind != "todo" {
        return Ok(None);
    }
    let input = build_task_input(kind, content)?;
    let task_id = create_task_tx(tx, input)?;
    Ok(Some(task_id))
}

fn to_submit_result(item: CaptureItem, duplicate: bool) -> SubmitCaptureResult {
    SubmitCaptureResult {
        id: item.id,
        kind: item.kind,
        status: item.status,
        task_id: item.task_id,
        duplicate,
        created_at: item.created_at,
    }
}

// ── 行映射与查询 ────────────────────────────────────────────

fn row_to_item(r: &rusqlite::Row<'_>) -> rusqlite::Result<CaptureItem> {
    Ok(CaptureItem {
        id: r.get(0)?,
        client_id: r.get(1)?,
        kind: r.get(2)?,
        content: r.get(3)?,
        url: r.get(4)?,
        note: r.get(5)?,
        status: r.get(6)?,
        task_id: r.get(7)?,
        source: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

fn find_by_id(conn: &rusqlite::Connection, id: &str) -> AppResult<Option<CaptureItem>> {
    conn.query_row(
        &format!("SELECT {ITEM_COLUMNS} FROM quick_capture_items WHERE id = ?1"),
        rusqlite::params![id],
        row_to_item,
    )
    .optional()
    .map_err(AppError::from)
}

fn find_by_client(conn: &rusqlite::Connection, client_id: &str) -> AppResult<Option<CaptureItem>> {
    conn.query_row(
        &format!("SELECT {ITEM_COLUMNS} FROM quick_capture_items WHERE client_id = ?1"),
        rusqlite::params![client_id],
        row_to_item,
    )
    .optional()
    .map_err(AppError::from)
}

/// 唯一索引冲突判定（SQLITE_CONSTRAINT_UNIQUE = 2067）。
fn is_unique_violation(err: &rusqlite::Error) -> bool {
    match err {
        rusqlite::Error::SqliteFailure(e, _) => {
            e.code == rusqlite::ErrorCode::ConstraintViolation && e.extended_code == 2067
        }
        _ => false,
    }
}

/// 读取上次选择的捕获类型：缺失/非法一律回退默认 task。
pub fn last_type(db: &Db) -> String {
    db.get_setting(SETTING_LAST_TYPE)
        .ok()
        .flatten()
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|s| is_kind(s))
        .unwrap_or_else(|| DEFAULT_KIND.to_string())
}

// ── 公开操作 ────────────────────────────────────────────────

/// 窗口初始状态：草稿、上次类型、收集箱待处理数。
pub fn state(db: &Db) -> AppResult<CaptureState> {
    let draft = db.with_read(|conn| {
        conn.query_row(
            "SELECT kind, content, updated_at FROM quick_capture_draft WHERE id = 'active'",
            [],
            |r| {
                Ok(CaptureDraft {
                    kind: r.get(0)?,
                    content: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            },
        )
        .optional()
        .map_err(AppError::from)
    })?;
    let inbox_count = db.with_read(|conn| {
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM quick_capture_items WHERE status = 'inbox'",
            [],
            |r| r.get(0),
        )?;
        Ok::<_, AppError>(n.max(0) as u32)
    })?;
    Ok(CaptureState {
        draft,
        last_type: last_type(db),
        inbox_count,
    })
}

/// 保存草稿：内容 trim 为空则清空草稿；否则单行 upsert（原始内容保留）。
/// 返回 `saved_at`（前端据此显示「已保存」，不猜测）。
pub fn save_draft(db: &Db, kind: &str, content: &str) -> AppResult<DraftSaved> {
    let kind = kind.trim();
    if !is_kind(kind) {
        return Err(AppError::Validation("未知的捕获类型".into()));
    }
    let trimmed = content.trim();
    if !trimmed.is_empty() && trimmed.chars().count() > MAX_CONTENT {
        return Err(AppError::Validation(format!(
            "内容超过 {} 字符",
            MAX_CONTENT
        )));
    }
    let now = now_iso();
    db.with_conn(|conn| {
        if trimmed.is_empty() {
            conn.execute("DELETE FROM quick_capture_draft WHERE id = 'active'", [])?;
        } else {
            conn.execute(
                "INSERT INTO quick_capture_draft (id, kind, content, updated_at)
                 VALUES ('active', ?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET
                   kind = excluded.kind,
                   content = excluded.content,
                   updated_at = excluded.updated_at",
                rusqlite::params![kind, content, now],
            )?;
        }
        Ok::<_, AppError>(())
    })?;
    Ok(DraftSaved { saved_at: now })
}

/// 清空草稿（用户显式丢弃）。
pub fn clear_draft(db: &Db) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute("DELETE FROM quick_capture_draft WHERE id = 'active'", [])?;
        Ok(())
    })
}

/// 记录上次选择的类型（只写设置，不写草稿）。
pub fn set_last_type(db: &Db, kind: &str) -> AppResult<()> {
    let kind = kind.trim();
    if !is_kind(kind) {
        return Err(AppError::Validation("未知的捕获类型".into()));
    }
    db.set_setting(
        SETTING_LAST_TYPE,
        serde_json::Value::String(kind.to_string()),
    )
}

/// 提交捕获（单事务、幂等）。
///
/// 顺序：client_id 查重 → 插入条目（inbox）→ task/todo 同事务建任务 →
/// 回写 converted/task_id → 删草稿 → 提交。任一步失败整体回滚；唯一索引
/// 冲突（并发重复提交）回查已有记录并标记 duplicate。
pub fn submit(db: &Db, input: SubmitCaptureInput) -> AppResult<SubmitCaptureResult> {
    let v = validate_submit(input)?;
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Some(existing) = find_by_client(&tx, &v.client_id)? {
            // 幂等重试已成功过：若草稿仍是本次提交的 kind/content（trim 后），
            // 一并清掉——否则下次唤起会恢复旧草稿，用户再提交会生成新
            // client_id 而重复建任务。草稿已被用户改写时保留，避免误删。
            tx.execute(
                "DELETE FROM quick_capture_draft
                 WHERE id = 'active' AND kind = ?1
                   AND TRIM(content, ' ' || char(9) || char(10) || char(13)) = ?2",
                rusqlite::params![v.kind, v.content],
            )?;
            tx.commit()?;
            return Ok(to_submit_result(existing, true));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_iso();
        let inserted = tx.execute(
            "INSERT INTO quick_capture_items
               (id, client_id, kind, content, url, note, status, task_id, source, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'inbox', NULL, ?7, ?8, ?8)",
            rusqlite::params![
                id,
                v.client_id,
                v.kind,
                v.content,
                v.url,
                v.note,
                SOURCE_CAPTURE,
                now
            ],
        );
        if let Err(err) = inserted {
            if !is_unique_violation(&err) {
                return Err(AppError::from(err));
            }
            // 并发下同一 client_id 已被另一请求提交：回查返回 duplicate
            drop(tx);
            let existing = find_by_client(conn, &v.client_id)?
                .ok_or_else(|| AppError::Conflict("捕获提交冲突，请重试".into()))?;
            // 同上：仅清理与本次提交内容一致的草稿
            conn.execute(
                "DELETE FROM quick_capture_draft
                 WHERE id = 'active' AND kind = ?1
                   AND TRIM(content, ' ' || char(9) || char(10) || char(13)) = ?2",
                rusqlite::params![v.kind, v.content],
            )?;
            return Ok(to_submit_result(existing, true));
        }
        let task_id = create_task_for(&tx, &v.kind, &v.content)?;
        if let Some(tid) = &task_id {
            tx.execute(
                "UPDATE quick_capture_items
                 SET status = 'converted', task_id = ?1, updated_at = ?2
                 WHERE id = ?3",
                rusqlite::params![tid, now, id],
            )?;
        }
        // 提交成功才清草稿（同一事务，失败时草稿保留供重试）
        tx.execute("DELETE FROM quick_capture_draft WHERE id = 'active'", [])?;
        let item = find_by_id(&tx, &id)?
            .ok_or_else(|| AppError::NotFound("捕获记录不存在".into()))?;
        tx.commit()?;
        Ok(to_submit_result(item, false))
    })
}

/// 列出收集箱：status 为 None/"all" 时返回全部，否则按状态过滤。
pub fn list(
    db: &Db,
    status: Option<&str>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> AppResult<Vec<CaptureItem>> {
    let status = match status.map(str::trim) {
        None | Some("") | Some("all") => None,
        Some(s) if is_status(s) => Some(s.to_string()),
        Some(_) => return Err(AppError::Validation("未知的收集箱状态".into())),
    };
    let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT) as i64;
    let offset = offset.unwrap_or(0) as i64;
    db.with_read(|conn| {
        let sql = format!(
            "SELECT {ITEM_COLUMNS} FROM quick_capture_items
             WHERE (?1 IS NULL OR status = ?1)
             ORDER BY created_at DESC, id DESC
             LIMIT ?2 OFFSET ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params![status, limit, offset], row_to_item)?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }
        Ok(items)
    })
}

/// 标记已处理。已 converted 的条目保持 converted（任务已存在，不降级）。
pub fn mark_handled(db: &Db, id: &str) -> AppResult<CaptureItem> {
    db.with_conn(|conn| {
        let item = find_by_id(conn, id)?
            .ok_or_else(|| AppError::NotFound(format!("捕获记录不存在: {}", id)))?;
        if item.status == "converted" {
            return Ok(item);
        }
        let now = now_iso();
        conn.execute(
            "UPDATE quick_capture_items SET status = 'handled', updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, id],
        )?;
        Ok(CaptureItem {
            status: "handled".into(),
            updated_at: now,
            ..item
        })
    })
}

/// 删除收集箱条目（已 converted 的条目删除不影响已建任务）。
pub fn delete(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let n = conn.execute(
            "DELETE FROM quick_capture_items WHERE id = ?1",
            rusqlite::params![id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound(format!("捕获记录不存在: {}", id)));
        }
        Ok(())
    })
}

/// 把收集箱条目转为任务：任务与状态回写同事务；已 converted 幂等返回。
pub fn convert_to_task(db: &Db, id: &str) -> AppResult<CaptureItem> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let item = find_by_id(&tx, id)?
            .ok_or_else(|| AppError::NotFound(format!("捕获记录不存在: {}", id)))?;
        if item.status == "converted" {
            return Ok(item);
        }
        let input = build_task_input("task", &item.content)?;
        let task_id = create_task_tx(&tx, input)?;
        let now = now_iso();
        tx.execute(
            "UPDATE quick_capture_items
             SET status = 'converted', task_id = ?1, updated_at = ?2
             WHERE id = ?3",
            rusqlite::params![task_id, now, id],
        )?;
        tx.commit()?;
        Ok(CaptureItem {
            status: "converted".into(),
            task_id: Some(task_id),
            updated_at: now,
            ..item
        })
    })
}

// ── 单测 ────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::tasks::get_task;

    /// 临时数据目录 + 文件库（与 db::tests 的 temp_dir 范式一致）。
    fn temp_db(tag: &str) -> (std::path::PathBuf, Db) {
        let dir = std::env::temp_dir().join(format!("td-qc-{}-{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        let db = Db::open(&dir.join("t.db")).expect("打开临时数据库失败");
        (dir, db)
    }

    fn cleanup(dir: &std::path::Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    fn input(client_id: &str, kind: &str, content: &str) -> SubmitCaptureInput {
        SubmitCaptureInput {
            client_id: client_id.into(),
            kind: kind.into(),
            content: content.into(),
            url: None,
            note: None,
        }
    }

    fn count_rows(db: &Db, table: &str) -> i64 {
        db.with_read(|conn| {
            let n: i64 =
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
            Ok::<_, AppError>(n)
        })
        .expect("统计行数失败")
    }

    #[test]
    fn migration_creates_quick_capture_tables_and_indexes() {
        let (dir, db) = temp_db("migrate");
        let tables: Vec<String> = db
            .with_read(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table'
                     AND name IN ('quick_capture_items', 'quick_capture_draft')",
                )?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row?);
                }
                Ok(out)
            })
            .expect("查询表失败");
        assert_eq!(tables.len(), 2, "两张新表都应存在: {:?}", tables);

        let indexes: Vec<String> = db
            .with_read(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'index'
                     AND name IN ('idx_quick_capture_client',
                                  'idx_quick_capture_status_created',
                                  'idx_quick_capture_task')",
                )?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row?);
                }
                Ok(out)
            })
            .expect("查询索引失败");
        assert_eq!(indexes.len(), 3, "三个新索引都应存在: {:?}", indexes);
        drop(db);
        cleanup(&dir);
    }

    #[test]
    fn all_five_kinds_land_in_expected_place() {
        let (dir, db) = temp_db("kinds");
        // 非任务类型：只进收集箱，status = inbox
        for kind in ["idea", "text", "link"] {
            let mut inp = input(&format!("c-{kind}"), kind, "随手记一条");
            if kind == "link" {
                inp.url = Some("https://example.com/a".into());
                inp.note = Some("待读".into());
            }
            let r = submit(&db, inp).expect("提交应成功");
            assert_eq!(r.status, "inbox", "{kind} 应进收集箱");
            assert!(r.task_id.is_none(), "{kind} 不应建任务");
            assert!(!r.duplicate);
        }
        // task/todo：建任务并转 converted
        for kind in ["task", "todo"] {
            let r = submit(&db, input(&format!("c-{kind}"), kind, "写周报")).expect("提交应成功");
            assert_eq!(r.status, "converted", "{kind} 应转任务");
            let tid = r.task_id.expect("应有 task_id");
            let task = get_task(&db, &tid).expect("任务应可查询");
            assert_eq!(task.title, "写周报");
        }
        // link 的 url/note 落库
        let items = list(&db, Some("inbox"), None, None).expect("列表应成功");
        let link = items
            .iter()
            .find(|i| i.kind == "link")
            .expect("应有 link 条目");
        assert_eq!(link.url.as_deref(), Some("https://example.com/a"));
        assert_eq!(link.note.as_deref(), Some("待读"));
        assert_eq!(count_rows(&db, "quick_capture_items"), 5);
        drop(db);
        cleanup(&dir);
    }

    #[test]
    fn empty_and_overlong_content_rejected_without_rows() {
        let (dir, db) = temp_db("validate");
        for content in ["", "   ", "\n\t "] {
            let err = submit(&db, input("c-empty", "text", content)).unwrap_err();
            assert!(matches!(err, AppError::Validation(_)), "空内容应拒绝");
        }
        let too_long = "字".repeat(MAX_CONTENT + 1);
        let err = submit(&db, input("c-long", "text", &too_long)).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)), "超长内容应拒绝");
        // 标题超长：不静默截断
        let long_title = "标".repeat(MAX_TITLE + 1);
        let err = submit(&db, input("c-title", "task", &long_title)).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)), "超长标题应拒绝");
        assert_eq!(count_rows(&db, "quick_capture_items"), 0, "拒绝不得落行");
        assert_eq!(count_rows(&db, "tasks"), 0, "拒绝不得建任务");
        drop(db);
        cleanup(&dir);
    }

    #[test]
    fn duplicate_submit_is_idempotent_and_does_not_create_task_twice() {
        let (dir, db) = temp_db("idempotent");
        let first = submit(&db, input("same-client", "task", "交周报")).expect("首次提交");
        assert!(!first.duplicate);
        assert_eq!(first.status, "converted");
        let again = submit(&db, input("same-client", "task", "交周报")).expect("重复提交");
        assert!(again.duplicate, "重复提交应标记 duplicate");
        assert_eq!(again.id, first.id);
        assert_eq!(again.task_id, first.task_id);
        assert_eq!(count_rows(&db, "quick_capture_items"), 1);
        assert_eq!(count_rows(&db, "tasks"), 1, "不得重复建任务");
        drop(db);
        cleanup(&dir);
    }

    #[test]
    fn duplicate_retry_clears_matching_draft_but_keeps_edited_draft() {
        let (dir, db) = temp_db("duplicate-draft");
        // 模拟「首次提交成功但响应丢失 → 前端用同一 client_id 重试」：
        // 重试前草稿仍停在提交内容上（前端失败路径会 flush 草稿）。
        let first = submit(&db, input("retry-client", "task", "交周报")).expect("首次提交");
        assert!(!first.duplicate);
        save_draft(&db, "task", "交周报  ").expect("保存草稿");
        let again = submit(&db, input("retry-client", "task", "交周报")).expect("重试提交");
        assert!(again.duplicate, "重试应返回 duplicate");
        assert!(
            state(&db).expect("状态").draft.is_none(),
            "重试成功（duplicate）应清掉与提交内容一致的草稿，否则下次唤起会重复建任务"
        );

        // 用户在失败重试期间改写过草稿：duplicate 不得误删这份新草稿。
        save_draft(&db, "text", "改过的新想法").expect("保存新草稿");
        let third = submit(&db, input("retry-client", "task", "交周报")).expect("再次重试");
        assert!(third.duplicate);
        let draft = state(&db).expect("状态").draft.expect("新草稿应保留");
        assert_eq!(draft.kind, "text");
        assert_eq!(draft.content, "改过的新想法");
        assert_eq!(count_rows(&db, "quick_capture_items"), 1, "不得新增条目");
        assert_eq!(count_rows(&db, "tasks"), 1, "不得重复建任务");
        drop(db);
        cleanup(&dir);
    }

    #[test]
    fn failed_task_creation_rolls_back_item_and_keeps_draft() {
        let (dir, db) = temp_db("rollback");
        save_draft(&db, "task", "草稿正文").expect("保存草稿");
        // 首行超 200 字符 → 建任务校验失败 → 整个提交事务回滚
        let long_title = "长".repeat(MAX_TITLE + 1);
        let err = submit(&db, input("c-rollback", "task", &long_title)).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        assert_eq!(count_rows(&db, "quick_capture_items"), 0, "条目应回滚");
        assert_eq!(count_rows(&db, "tasks"), 0, "任务应回滚");
        let st = state(&db).expect("状态应可读");
        assert!(st.draft.is_some(), "提交失败不得丢草稿");
        drop(db);
        cleanup(&dir);
    }

    #[test]
    fn draft_save_restore_clear_and_not_confused_with_items() {
        let (dir, db) = temp_db("draft");
        // 初始无草稿
        assert!(state(&db).expect("状态").draft.is_none());
        // 保存 → 恢复
        let saved = save_draft(&db, "idea", "半截想法").expect("保存草稿");
        assert!(!saved.saved_at.is_empty());
        let st = state(&db).expect("状态");
        let draft = st.draft.expect("应有草稿");
        assert_eq!(draft.kind, "idea");
        assert_eq!(draft.content, "半截想法");
        // 草稿不是收集箱条目
        assert_eq!(count_rows(&db, "quick_capture_items"), 0);
        // 空内容 = 清空草稿
        let cleared = save_draft(&db, "idea", "   ").expect("清空草稿");
        assert!(!cleared.saved_at.is_empty());
        assert!(state(&db).expect("状态").draft.is_none());
        // clear_draft 幂等
        clear_draft(&db).expect("清空应成功");
        assert!(state(&db).expect("状态").draft.is_none());
        // 提交成功在事务内清草稿
        save_draft(&db, "text", "待提交").expect("保存草稿");
        submit(&db, input("c-draft", "text", "待提交")).expect("提交");
        assert!(state(&db).expect("状态").draft.is_none(), "提交成功应清草稿");
        drop(db);
        cleanup(&dir);
    }

    #[test]
    fn mark_handled_delete_and_convert() {
        let (dir, db) = temp_db("ops");
        let idea = submit(&db, input("c-idea", "idea", "灵感")).expect("提交");
        let handled = mark_handled(&db, &idea.id).expect("标记已处理");
        assert_eq!(handled.status, "handled");
        assert_eq!(count_rows(&db, "quick_capture_items"), 1);

        let link = submit(&db, input("c-link", "link", "https://example.com")).expect("提交");
        let converted = convert_to_task(&db, &link.id).expect("转任务");
        assert_eq!(converted.status, "converted");
        let tid = converted.task_id.expect("应有 task_id");
        assert_eq!(get_task(&db, &tid).expect("任务应可查").title, "https://example.com");
        // 幂等：再次转换不新建任务
        let again = convert_to_task(&db, &link.id).expect("再次转任务");
        assert_eq!(again.task_id.as_deref(), Some(tid.as_str()));
        assert_eq!(count_rows(&db, "tasks"), 1, "不得重复建任务");

        delete(&db, &idea.id).expect("删除应成功");
        let err = delete(&db, &idea.id).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)), "重复删除应 NotFound");
        // 删除 converted 条目不删除任务
        delete(&db, &link.id).expect("删除应成功");
        assert_eq!(count_rows(&db, "tasks"), 1);
        drop(db);
        cleanup(&dir);
    }

    #[test]
    fn task_and_todo_submit_create_queryable_tasks() {
        let (dir, db) = temp_db("tasks");
        // task：复用自然语言解析（时间进入 due_at）
        let r = submit(&db, input("c-task", "task", "明天下午三点开会")).expect("提交 task");
        let task = get_task(&db, &r.task_id.expect("task_id")).expect("任务应可查");
        assert_eq!(task.title, "开会");
        assert!(task.due_at.is_some(), "task 类型应解析时间");
        // todo：只建任务，不解析时间/提醒
        let r = submit(&db, input("c-todo", "todo", "明天下午三点写周报")).expect("提交 todo");
        let todo = get_task(&db, &r.task_id.expect("task_id")).expect("任务应可查");
        assert_eq!(todo.title, "明天下午三点写周报");
        assert!(todo.due_at.is_none(), "todo 不解析时间");
        assert!(todo.remind_at.is_none(), "todo 不写提醒");
        // 多行正文：首行进标题，其余进描述
        let r = submit(&db, input("c-multi", "todo", "写周报\n第二行说明\n第三行")).expect("提交");
        let multi = get_task(&db, &r.task_id.expect("task_id")).expect("任务应可查");
        assert_eq!(multi.title, "写周报");
        assert!(multi.description.contains("第二行说明"));
        drop(db);
        cleanup(&dir);
    }

    #[test]
    fn list_filters_and_limits() {
        let (dir, db) = temp_db("list");
        for i in 0..3 {
            submit(&db, input(&format!("c-inbox-{i}"), "idea", "想法")).expect("提交");
        }
        let r = submit(&db, input("c-task", "task", "任务")).expect("提交");
        assert_eq!(r.status, "converted");

        let inbox = list(&db, Some("inbox"), None, None).expect("列表");
        assert_eq!(inbox.len(), 3);
        assert!(inbox.iter().all(|i| i.status == "inbox"));
        let all = list(&db, None, None, None).expect("列表");
        assert_eq!(all.len(), 4);
        let all_explicit = list(&db, Some("all"), None, None).expect("列表");
        assert_eq!(all_explicit.len(), 4);
        let page = list(&db, None, Some(2), Some(1)).expect("分页");
        assert_eq!(page.len(), 2);
        // 非法状态拒绝
        assert!(matches!(
            list(&db, Some("bogus"), None, None),
            Err(AppError::Validation(_))
        ));
        // 上限夹取：请求超大 limit 不应报错
        let capped = list(&db, None, Some(9999), None).expect("夹取上限");
        assert_eq!(capped.len(), 4);
        drop(db);
        cleanup(&dir);
    }

    #[test]
    fn last_type_setting_and_state() {
        let (dir, db) = temp_db("settings");
        assert_eq!(last_type(&db), "task", "缺失时回退 task");
        set_last_type(&db, "todo").expect("写设置");
        assert_eq!(last_type(&db), "todo");
        assert_eq!(state(&db).expect("状态").last_type, "todo");
        assert!(matches!(
            set_last_type(&db, "bogus"),
            Err(AppError::Validation(_))
        ));
        // 直接写非法值：读取时回退默认，不 panic
        db.set_setting(
            SETTING_LAST_TYPE,
            serde_json::Value::String("bogus".into()),
        )
        .expect("写设置");
        assert_eq!(last_type(&db), "task");
        drop(db);
        cleanup(&dir);
    }
}
