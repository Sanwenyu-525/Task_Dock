//! 快速笔记数据层：新建、编辑（乐观并发）、自动保存目标、置顶/收藏、搜索、
//! 任务 / 工作现场弱关联、删除、收集箱转笔记。
//!
//! 边界与约束：
//! - 纯文本 + 简单 Markdown 原文存储，不做富文本 / 双向链接 / 知识图谱；
//! - 正文只存库，错误信息不回显正文，长度校验只报上限；
//! - 时间统一 UTC RFC3339（`crate::agents::now_iso`），列表按置顶 + 最近更新；
//! - 「收集箱转笔记」只读取原条目，绝不修改原条目，靠 `source_capture_id` 唯一
//!   索引保证重试幂等；
//! - 自动保存的并发检测靠 `revision`：携带 `expected_revision` 不匹配时返回
//!   `CONFLICT`，前端保留草稿并允许显式覆盖。
//!
//! 本模块不修改 `db/mod.rs`：表结构由集成会话追加迁移，草稿见
//! `tmp/acceptance/quick-notes/schema.sql`（与 [`schema::NOTES_SCHEMA`] 一致）。

use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 标题上限（字符数）。
pub const MAX_TITLE: usize = 200;
/// 正文上限（字符数）。纯文本长期记录，留足长文空间。
pub const MAX_CONTENT: usize = 200_000;
/// 列表默认条数与上限。
pub const DEFAULT_LIST_LIMIT: u32 = 50;
pub const MAX_LIST_LIMIT: u32 = 200;

const SUMMARY_COLUMNS: &str = "id, title, pinned, favorite, task_id, workspace_id, \
     source_capture_id, revision, created_at, updated_at, length(content), substr(content, 1, 240)";
const NOTE_COLUMNS: &str = "id, title, content, pinned, favorite, task_id, workspace_id, \
     source_capture_id, revision, created_at, updated_at";

// ── 数据模型（IPC 序列化，字段 snake_case，与仓库既有命令一致）──

/// 列表摘要（不含完整正文，避免长文列表传输）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub excerpt: String,
    pub pinned: bool,
    pub favorite: bool,
    pub task_id: Option<String>,
    pub workspace_id: Option<String>,
    pub source_capture_id: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    /// 正文字符数（SQLite `length()` 对 TEXT 按字符计）。
    pub content_chars: i64,
}

/// 完整笔记。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content: String,
    pub pinned: bool,
    pub favorite: bool,
    pub task_id: Option<String>,
    pub workspace_id: Option<String>,
    pub source_capture_id: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CreateNoteInput {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
}

/// 更新入参。
///
/// `expected_revision`：自动保存携带的基线版本；为 `None` 不做并发检查。
/// `force`：冲突后用户显式选择覆盖；为 `true` 时忽略 `expected_revision`。
#[derive(Debug, Clone, Deserialize, Default)]
pub struct UpdateNoteInput {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub expected_revision: Option<i64>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ListFilter {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub pinned_only: bool,
    #[serde(default)]
    pub favorite_only: bool,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NoteTemplate {
    pub id: String,
    pub name: String,
    pub content: String,
}

/// 收集箱转笔记结果；`duplicate = true` 表示同一原条目此前已转过，本次未新建。
#[derive(Debug, Clone, Serialize)]
pub struct ConvertResult {
    pub note: Note,
    pub duplicate: bool,
}

// ── 校验与工具 ──────────────────────────────────────────────

fn validate(title: &str, content: &str) -> AppResult<()> {
    if title.chars().count() > MAX_TITLE {
        return Err(AppError::Validation(format!("标题超过 {} 字符", MAX_TITLE)));
    }
    if content.chars().count() > MAX_CONTENT {
        return Err(AppError::Validation(format!("正文超过 {} 字符", MAX_CONTENT)));
    }
    Ok(())
}

fn excerpt_of(preview: &str) -> String {
    let flat = preview.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 120 {
        let head: String = flat.chars().take(120).collect();
        format!("{}…", head)
    } else {
        flat
    }
}

fn like_pattern(query: &str) -> String {
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{}%", escaped)
}

fn clamp_limit(limit: Option<u32>) -> i64 {
    limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT) as i64
}

fn offset_of(offset: Option<u32>) -> i64 {
    offset.unwrap_or(0) as i64
}

/// 空白字符串归一化为 `None`，用于关联 ID。
fn normalize_link(raw: Option<String>) -> Option<String> {
    raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn ensure_task_exists(conn: &Connection, task_id: &str) -> AppResult<()> {
    let exists: Option<i64> = conn
        .query_row("SELECT 1 FROM tasks WHERE id = ?1", [task_id], |r| r.get(0))
        .optional()?;
    if exists.is_none() {
        return Err(AppError::NotFound("关联任务不存在或已删除".into()));
    }
    Ok(())
}

fn ensure_workspace_exists(conn: &Connection, workspace_id: &str) -> AppResult<()> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM workspace_snapshots WHERE id = ?1",
            [workspace_id],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(AppError::NotFound("关联工作现场不存在或已删除".into()));
    }
    Ok(())
}

fn row_to_summary(row: &Row<'_>) -> rusqlite::Result<NoteSummary> {
    let preview: String = row.get(11)?;
    Ok(NoteSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        excerpt: excerpt_of(&preview),
        pinned: row.get::<_, i64>(2)? != 0,
        favorite: row.get::<_, i64>(3)? != 0,
        task_id: row.get(4)?,
        workspace_id: row.get(5)?,
        source_capture_id: row.get(6)?,
        revision: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        content_chars: row.get(10)?,
    })
}

fn row_to_note(row: &Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        title: row.get(1)?,
        content: row.get(2)?,
        pinned: row.get::<_, i64>(3)? != 0,
        favorite: row.get::<_, i64>(4)? != 0,
        task_id: row.get(5)?,
        workspace_id: row.get(6)?,
        source_capture_id: row.get(7)?,
        revision: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn get_in_conn(conn: &Connection, id: &str) -> AppResult<Note> {
    conn.query_row(
        &format!("SELECT {} FROM notes WHERE id = ?1", NOTE_COLUMNS),
        [id],
        row_to_note,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("笔记不存在或已删除".into()))
}

// ── 查询 ────────────────────────────────────────────────────

/// 列表 / 搜索。`query` 匹配标题或正文（`%` `_` 按字面量处理）。
pub fn list(db: &Db, filter: &ListFilter) -> AppResult<Vec<NoteSummary>> {
    db.with_read(|conn| list_in_conn(conn, filter))
}

pub(crate) fn list_in_conn(conn: &Connection, filter: &ListFilter) -> AppResult<Vec<NoteSummary>> {
    let mut sql = format!("SELECT {} FROM notes WHERE 1 = 1", SUMMARY_COLUMNS);
    let mut values: Vec<Value> = Vec::new();

    if let Some(query) = filter.query.as_deref().map(str::trim).filter(|q| !q.is_empty()) {
        sql.push_str(" AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
        let pattern = like_pattern(query);
        values.push(Value::Text(pattern.clone()));
        values.push(Value::Text(pattern));
    }
    if filter.pinned_only {
        sql.push_str(" AND pinned = 1");
    }
    if filter.favorite_only {
        sql.push_str(" AND favorite = 1");
    }
    if let Some(task_id) = filter.task_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        sql.push_str(" AND task_id = ?");
        values.push(Value::Text(task_id.to_string()));
    }
    if let Some(workspace_id) = filter
        .workspace_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        sql.push_str(" AND workspace_id = ?");
        values.push(Value::Text(workspace_id.to_string()));
    }

    sql.push_str(" ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ? OFFSET ?");
    values.push(Value::Integer(clamp_limit(filter.limit)));
    values.push(Value::Integer(offset_of(filter.offset)));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(values), row_to_summary)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 全局搜索的稳定查询接口：只读连接可用，字段见 [`NoteSummary`]。
/// 集成会话在全局搜索私有模块内调用本函数并映射为搜索结果，不需要改本模块。
pub fn search_in_conn(conn: &Connection, query: &str, limit: i64) -> AppResult<Vec<NoteSummary>> {
    let filter = ListFilter {
        query: Some(query.to_string()),
        limit: Some(limit.clamp(1, MAX_LIST_LIMIT as i64) as u32),
        ..Default::default()
    };
    list_in_conn(conn, &filter)
}

/// 命令层搜索入口（同一查询语义，供前端 / 插件复用）。
pub fn search(db: &Db, query: &str, limit: Option<u32>) -> AppResult<Vec<NoteSummary>> {
    let filter = ListFilter {
        query: Some(query.to_string()),
        limit,
        ..Default::default()
    };
    list(db, &filter)
}

pub fn get(db: &Db, id: &str) -> AppResult<Note> {
    db.with_read(|conn| get_in_conn(conn, id))
}

// ── 写入 ────────────────────────────────────────────────────

pub fn create(db: &Db, input: CreateNoteInput) -> AppResult<Note> {
    let title = input.title.unwrap_or_default();
    let content = input.content.unwrap_or_default();
    validate(&title, &content)?;

    let now = now_iso();
    let note = Note {
        id: uuid::Uuid::new_v4().to_string(),
        title,
        content,
        pinned: false,
        favorite: false,
        task_id: None,
        workspace_id: None,
        source_capture_id: None,
        revision: 1,
        created_at: now.clone(),
        updated_at: now,
    };

    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO notes (id, title, content, pinned, favorite, task_id, workspace_id, \
             source_capture_id, revision, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 0, 0, NULL, NULL, NULL, 1, ?4, ?4)",
            params![note.id, note.title, note.content, note.created_at],
        )?;
        Ok(())
    })?;
    Ok(note)
}

/// 更新标题 / 正文。内容未变化时不写库、不递增 revision。
pub fn update(db: &Db, id: &str, input: UpdateNoteInput) -> AppResult<Note> {
    validate(&input.title, &input.content)?;
    let now = now_iso();

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let current = get_in_conn(&tx, id)?;

        if !input.force {
            if let Some(expected) = input.expected_revision {
                if expected != current.revision {
                    return Err(AppError::Conflict(
                        "笔记已在其他位置更新，请查看最新内容后再保存".into(),
                    ));
                }
            }
        }

        if current.title == input.title && current.content == input.content {
            tx.commit()?;
            return Ok(current);
        }

        let changed = tx.execute(
            "UPDATE notes SET title = ?2, content = ?3, revision = revision + 1, updated_at = ?4 \
             WHERE id = ?1 AND revision = ?5",
            params![id, input.title, input.content, now, current.revision],
        )?;
        if changed == 0 {
            return Err(AppError::Conflict(
                "笔记已在其他位置更新，请查看最新内容后再保存".into(),
            ));
        }
        let updated = get_in_conn(&tx, id)?;
        tx.commit()?;
        Ok(updated)
    })
}

/// 置顶 / 收藏。两者都不改变 `revision` 与 `updated_at`（不是内容编辑）。
pub fn set_flags(
    db: &Db,
    id: &str,
    pinned: Option<bool>,
    favorite: Option<bool>,
) -> AppResult<Note> {
    db.with_conn(|conn| {
        let changed = conn.execute(
            "UPDATE notes SET pinned = COALESCE(?2, pinned), \
             favorite = COALESCE(?3, favorite) WHERE id = ?1",
            params![id, pinned, favorite],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("笔记不存在或已删除".into()));
        }
        get_in_conn(conn, id)
    })
}

/// 关联任务；`task_id = None` 表示取消关联。
pub fn set_task_link(db: &Db, id: &str, task_id: Option<String>) -> AppResult<Note> {
    let link = normalize_link(task_id);
    db.with_conn(|conn| {
        if let Some(task_id) = link.as_deref() {
            ensure_task_exists(conn, task_id)?;
        }
        let changed = conn.execute(
            "UPDATE notes SET task_id = ?2 WHERE id = ?1",
            params![id, link],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("笔记不存在或已删除".into()));
        }
        get_in_conn(conn, id)
    })
}

/// 关联工作现场；`workspace_id = None` 表示取消关联。
pub fn set_workspace_link(db: &Db, id: &str, workspace_id: Option<String>) -> AppResult<Note> {
    let link = normalize_link(workspace_id);
    db.with_conn(|conn| {
        if let Some(workspace_id) = link.as_deref() {
            ensure_workspace_exists(conn, workspace_id)?;
        }
        let changed = conn.execute(
            "UPDATE notes SET workspace_id = ?2 WHERE id = ?1",
            params![id, link],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("笔记不存在或已删除".into()));
        }
        get_in_conn(conn, id)
    })
}

/// 删除笔记。返回是否实际删除（重复调用幂等）。
pub fn delete(db: &Db, id: &str) -> AppResult<bool> {
    db.with_conn(|conn| Ok(conn.execute("DELETE FROM notes WHERE id = ?1", [id])? > 0))
}

// ── 收集箱转笔记 ────────────────────────────────────────────

fn find_by_source(conn: &Connection, capture_id: &str) -> AppResult<Option<Note>> {
    conn.query_row(
        &format!(
            "SELECT {} FROM notes WHERE source_capture_id = ?1",
            NOTE_COLUMNS
        ),
        [capture_id],
        row_to_note,
    )
    .optional()
    .map_err(AppError::from)
}

fn is_unique_violation(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(e, _)
            if e.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

fn first_line_title(content: &str) -> String {
    let line = content.lines().next().unwrap_or("").trim();
    let title: String = line.chars().take(MAX_TITLE).collect();
    if title.is_empty() {
        "收集箱笔记".to_string()
    } else {
        title
    }
}

/// 把收集箱条目转为独立笔记。
///
/// - 原条目不做任何修改（默认保留在收集箱，用户可自行处理）；
/// - 同一 `capture_id` 重试只返回已有笔记（`duplicate = true`），不会重复创建；
/// - 链接条目的 URL / 备注会追加在正文末尾，正文原文完整保留。
pub fn convert_capture(db: &Db, capture_id: &str) -> AppResult<ConvertResult> {
    let capture_id = capture_id.trim();
    if capture_id.is_empty() {
        return Err(AppError::Validation("收集箱条目 ID 不能为空".into()));
    }

    match convert_capture_inner(db, capture_id) {
        Ok(result) => Ok(result),
        Err(AppError::Db(err)) if is_unique_violation(&err) => {
            // 并发竞争兜底：唯一索引命中说明另一请求已创建，按重复返回。
            match db.with_read(|conn| find_by_source(conn, capture_id))? {
                Some(note) => Ok(ConvertResult {
                    note,
                    duplicate: true,
                }),
                None => Err(AppError::Db(err)),
            }
        }
        Err(err) => Err(err),
    }
}

fn convert_capture_inner(db: &Db, capture_id: &str) -> AppResult<ConvertResult> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Some(note) = find_by_source(&tx, capture_id)? {
            tx.commit()?;
            return Ok(ConvertResult {
                note,
                duplicate: true,
            });
        }

        let item = tx
            .query_row(
                "SELECT content, url, note FROM quick_capture_items WHERE id = ?1",
                [capture_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((content, url, note_text)) = item else {
            return Err(AppError::NotFound("收集箱条目不存在或已删除".into()));
        };

        let title = first_line_title(&content);
        let mut body = content;
        if let Some(url) = normalize_link(url) {
            if !body.contains(&url) {
                body.push_str("\n\n");
                body.push_str(&url);
            }
        }
        if let Some(extra) = normalize_link(note_text) {
            body.push_str("\n\n备注：");
            body.push_str(&extra);
        }
        validate(&title, &body)?;

        let now = now_iso();
        let note = Note {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            content: body,
            pinned: false,
            favorite: false,
            task_id: None,
            workspace_id: None,
            source_capture_id: Some(capture_id.to_string()),
            revision: 1,
            created_at: now.clone(),
            updated_at: now,
        };
        tx.execute(
            "INSERT INTO notes (id, title, content, pinned, favorite, task_id, workspace_id, \
             source_capture_id, revision, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 0, 0, NULL, NULL, ?4, 1, ?5, ?5)",
            params![
                note.id,
                note.title,
                note.content,
                note.source_capture_id,
                note.created_at
            ],
        )?;
        tx.commit()?;
        Ok(ConvertResult {
            note,
            duplicate: false,
        })
    })
}

// ── 模板（内置轻量文本模板，不单独建表）────────────────────

pub fn templates() -> Vec<NoteTemplate> {
    vec![
        NoteTemplate {
            id: "meeting".into(),
            name: "会议记录".into(),
            content: "## 会议记录\n时间：\n参与人：\n议题：\n\n## 结论\n\n## 待办\n- ".into(),
        },
        NoteTemplate {
            id: "reading".into(),
            name: "阅读摘录".into(),
            content: "## 摘录\n来源：\n\n## 要点\n- \n\n## 我的想法\n".into(),
        },
        NoteTemplate {
            id: "weekly".into(),
            name: "本周回顾".into(),
            content:
                "## 本周完成\n- \n\n## 进行中\n- \n\n## 下周计划\n- \n\n## 风险 / 需要支持\n- "
                    .into(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(tag: &str) -> (std::path::PathBuf, Db) {
        let dir = std::env::temp_dir().join(format!("td-notes-{}-{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");
        // notes 表由迁移 v25 创建（见 `tmp/acceptance/quick-notes/schema.sql`）
        let db = Db::open(&dir.join("t.db")).expect("打开临时数据库失败");
        (dir, db)
    }

    fn cleanup(dir: &std::path::Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    fn new_note(db: &Db, title: &str, content: &str) -> Note {
        create(
            db,
            CreateNoteInput {
                title: Some(title.into()),
                content: Some(content.into()),
            },
        )
        .expect("创建笔记失败")
    }

    fn update_input(title: &str, content: &str, revision: Option<i64>) -> UpdateNoteInput {
        UpdateNoteInput {
            title: title.into(),
            content: content.into(),
            expected_revision: revision,
            force: false,
        }
    }

    fn insert_task(db: &Db, id: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                params![id, format!("任务{}", id), now_iso()],
            )?;
            Ok(())
        })
        .expect("插入任务失败");
    }

    fn insert_workspace(db: &Db, id: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspace_snapshots (id, name, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?3)",
                params![id, format!("现场{}", id), now_iso()],
            )?;
            Ok(())
        })
        .expect("插入工作现场失败");
    }

    fn insert_capture(db: &Db, id: &str, content: &str, url: Option<&str>, note: Option<&str>) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO quick_capture_items \
                 (id, client_id, kind, content, url, note, status, created_at, updated_at) \
                 VALUES (?1, ?1, 'text', ?2, ?3, ?4, 'inbox', ?5, ?5)",
                params![id, content, url, note, now_iso()],
            )?;
            Ok(())
        })
        .expect("插入收集箱条目失败");
    }

    #[test]
    fn schema_and_crud_roundtrip() {
        let (dir, db) = temp_db("crud");
        let note = new_note(&db, "标题", "第一行\n第二行");
        assert_eq!(note.revision, 1);
        assert!(!note.pinned && !note.favorite);

        let fetched = get(&db, &note.id).expect("读取笔记失败");
        assert_eq!(fetched.content, "第一行\n第二行");

        let updated = update(&db, &note.id, update_input("新标题", "新正文", Some(1)))
            .expect("更新失败");
        assert_eq!(updated.revision, 2);
        assert_eq!(updated.title, "新标题");

        assert!(delete(&db, &note.id).expect("删除失败"));
        assert!(!delete(&db, &note.id).expect("重复删除应幂等"));
        assert!(matches!(get(&db, &note.id), Err(AppError::NotFound(_))));

        cleanup(&dir);
    }

    #[test]
    fn empty_note_is_allowed_but_limits_are_enforced() {
        let (dir, db) = temp_db("limits");
        let empty = create(&db, CreateNoteInput::default()).expect("空笔记应允许创建");
        assert_eq!(empty.title, "");
        assert_eq!(empty.content, "");

        let too_long_title = "字".repeat(MAX_TITLE + 1);
        let err = create(
            &db,
            CreateNoteInput {
                title: Some(too_long_title),
                content: None,
            },
        )
        .expect_err("超长标题应拒绝");
        assert!(matches!(err, AppError::Validation(_)));

        let too_long_content = "字".repeat(MAX_CONTENT + 1);
        let err = create(
            &db,
            CreateNoteInput {
                title: None,
                content: Some(too_long_content),
            },
        )
        .expect_err("超长正文应拒绝");
        assert!(matches!(err, AppError::Validation(_)));
        cleanup(&dir);
    }

    #[test]
    fn long_text_roundtrip() {
        let (dir, db) = temp_db("long");
        let content = "长文".repeat(30_000); // 60,000 字符
        let note = new_note(&db, "长文", &content);
        let fetched = get(&db, &note.id).expect("读取长文失败");
        assert_eq!(fetched.content.chars().count(), content.chars().count());
        let list = list(&db, &ListFilter::default()).expect("列表失败");
        assert_eq!(list[0].content_chars as usize, content.chars().count());
        cleanup(&dir);
    }

    #[test]
    fn noop_update_does_not_bump_revision() {
        let (dir, db) = temp_db("noop");
        let note = new_note(&db, "标题", "正文");
        let same = update(&db, &note.id, update_input("标题", "正文", Some(1))).expect("更新失败");
        assert_eq!(same.revision, 1);
        cleanup(&dir);
    }

    #[test]
    fn revision_conflict_detected_and_force_overrides() {
        let (dir, db) = temp_db("conflict");
        let note = new_note(&db, "标题", "正文");
        update(&db, &note.id, update_input("标题", "别人改过", None)).expect("更新失败");

        let err = update(&db, &note.id, update_input("我的标题", "我的正文", Some(1)))
            .expect_err("旧版本应冲突");
        assert!(matches!(err, AppError::Conflict(_)));

        let forced = update(
            &db,
            &note.id,
            UpdateNoteInput {
                title: "我的标题".into(),
                content: "我的正文".into(),
                expected_revision: Some(1),
                force: true,
            },
        )
        .expect("显式覆盖应成功");
        assert_eq!(forced.title, "我的标题");
        assert_eq!(forced.revision, 3);
        cleanup(&dir);
    }

    #[test]
    fn pin_and_favorite_ordering() {
        let (dir, db) = temp_db("flags");
        let a = new_note(&db, "A", "");
        let b = new_note(&db, "B", "");
        let c = new_note(&db, "C", "");
        set_flags(&db, &a.id, Some(true), None).expect("置顶失败");
        set_flags(&db, &c.id, None, Some(true)).expect("收藏失败");

        let all = list(&db, &ListFilter::default()).expect("列表失败");
        assert_eq!(all[0].id, a.id, "置顶优先");
        assert_eq!(all.len(), 3);

        let pinned = list(
            &db,
            &ListFilter {
                pinned_only: true,
                ..Default::default()
            },
        )
        .expect("置顶筛选失败");
        assert_eq!(pinned.len(), 1);
        assert_eq!(pinned[0].id, a.id);

        let favorites = list(
            &db,
            &ListFilter {
                favorite_only: true,
                ..Default::default()
            },
        )
        .expect("收藏筛选失败");
        assert_eq!(favorites.len(), 1);
        assert_eq!(favorites[0].id, c.id);

        let b_after = get(&db, &b.id).expect("读取失败");
        assert_eq!(b_after.revision, 1);
        cleanup(&dir);
    }

    #[test]
    fn search_matches_title_and_content_and_escapes_wildcards() {
        let (dir, db) = temp_db("search");
        let a = new_note(&db, "会议纪要", "讨论了发布计划");
        let _b = new_note(&db, "读书", "100% 完成");
        let hits = search(&db, "发布", None).expect("搜索失败");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, a.id);

        // `%` 按字面量匹配，不能变成通配符
        let literal = search(&db, "100%", None).expect("搜索失败");
        assert_eq!(literal.len(), 1);

        let none = search(&db, "不存在的关键词", None).expect("搜索失败");
        assert!(none.is_empty());
        cleanup(&dir);
    }

    #[test]
    fn links_validate_and_clear() {
        let (dir, db) = temp_db("links");
        insert_task(&db, "t1");
        insert_workspace(&db, "w1");
        let note = new_note(&db, "关联", "正文");

        let linked = set_task_link(&db, &note.id, Some("t1".into())).expect("关联任务失败");
        assert_eq!(linked.task_id.as_deref(), Some("t1"));
        let linked = set_workspace_link(&db, &note.id, Some("w1".into())).expect("关联现场失败");
        assert_eq!(linked.workspace_id.as_deref(), Some("w1"));

        let by_task = list(
            &db,
            &ListFilter {
                task_id: Some("t1".into()),
                ..Default::default()
            },
        )
        .expect("按任务筛选失败");
        assert_eq!(by_task.len(), 1);

        let cleared = set_task_link(&db, &note.id, None).expect("取消关联失败");
        assert!(cleared.task_id.is_none());

        let err = set_task_link(&db, &note.id, Some("missing".into())).expect_err("不存在的任务应拒绝");
        assert!(matches!(err, AppError::NotFound(_)));
        cleanup(&dir);
    }

    #[test]
    fn convert_capture_preserves_source_and_is_idempotent() {
        let (dir, db) = temp_db("convert");
        insert_capture(
            &db,
            "cap1",
            "这是一条收集箱想法\n第二行",
            Some("https://example.com/a"),
            Some("补充备注"),
        );

        let first = convert_capture(&db, "cap1").expect("转换失败");
        assert!(!first.duplicate);
        assert_eq!(first.note.title, "这是一条收集箱想法");
        assert_eq!(first.note.source_capture_id.as_deref(), Some("cap1"));
        assert!(first.note.content.contains("https://example.com/a"));
        assert!(first.note.content.contains("补充备注"));

        // 原条目保持不变
        let original = db
            .with_read(|conn| {
                conn.query_row(
                    "SELECT content, status FROM quick_capture_items WHERE id = 'cap1'",
                    [],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .map_err(AppError::from)
            })
            .expect("读取原条目失败");
        assert_eq!(original.0, "这是一条收集箱想法\n第二行");
        assert_eq!(original.1, "inbox");

        // 重试不重复创建
        let second = convert_capture(&db, "cap1").expect("重试失败");
        assert!(second.duplicate);
        assert_eq!(second.note.id, first.note.id);
        let count = db
            .with_read(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM notes WHERE source_capture_id = 'cap1'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(AppError::from)
            })
            .expect("统计失败");
        assert_eq!(count, 1);

        let err = convert_capture(&db, "missing").expect_err("不存在的条目应失败");
        assert!(matches!(err, AppError::NotFound(_)));
        cleanup(&dir);
    }

    #[test]
    fn templates_are_non_empty() {
        let templates = templates();
        assert!(!templates.is_empty());
        assert!(templates.iter().all(|t| !t.name.is_empty() && !t.content.is_empty()));
    }
}
