//! 全局搜索（v0.9）：统一本地只读检索层。
//!
//! 设计要点（详见 docs/global-search/README.md）：
//! - 单一命令 `global_search`：一次请求在**同一个只读连接**（`Db::with_read`，PRAGMA
//!   query_only）内完成全部已选分类的查询，天然一致快照，不为分类建独立线程。
//! - 只读：不写任何业务表；命中只返回元数据与短摘要，不读图片/HTML/大正文二进制。
//! - SQL 全部参数绑定；LIKE 模式统一转义 `\ % _` + `ESCAPE '\'`（对齐
//!   `clipboard::store::like_pattern` 的规范实现）。
//! - Agent 隔离：只搜 `agent_*.origin = 'real'` 且来源 `hidden = 0` 的会话/轮次
//!   （对齐 `agents::snapshot_query` 的可见性规则），不返回对话内容/payload/meta。
//! - 排序确定性：匹配等级（精确 > 标题前缀 > 标题包含 > 正文/元数据命中）稳定排序，
//!   同级保持 SQL 内业务次序（未完成优先 / 置顶收藏优先 / 时间新优先）。
//! - 分页：每类 `LIMIT limit+1` 判断 `has_more`，不一次加载全部历史。

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 支持的搜索分类（前端分类筛选与后端一一对应）。
pub const CATEGORIES: [&str; 9] = [
    "tasks",
    "clipboard",
    "capture",
    "shelf",
    "apps",
    "agents",
    "workspace",
    "planning",
    "notes",
];

/// 每类默认返回条数（任务书性能要求）。
pub const DEFAULT_LIMIT_PER_CATEGORY: u32 = 6;
/// 每类返回上限（防止 limit_per_category 传大值拖垮响应）。
pub const MAX_LIMIT_PER_CATEGORY: u32 = 20;
/// 搜索词最大长度（超出截断，防超长输入）。
pub const MAX_QUERY_CHARS: usize = 100;
/// 摘要字段截断长度（字符）。
const SNIPPET_MAX_CHARS: usize = 160;
/// 标题/副标题截断长度（字符）。
const TITLE_MAX_CHARS: usize = 80;

// ── 结果模型 ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct GlobalSearchResult {
    /// 结果自身的稳定 id（跳转定位主键；来源随 kind 而异，见各分类说明）。
    pub id: String,
    /// 所属分类（`CATEGORIES` 之一）。
    pub category: String,
    /// 分类内子类型（如 task/session/run/project/image…）。
    pub kind: String,
    pub title: String,
    pub subtitle: String,
    pub snippet: String,
    pub occurred_at: Option<String>,
    pub status: Option<String>,
    pub priority: Option<i64>,
    /// 跳转目标 id（通常与定位接口的 id 参数对应；无跳转语义时为 null）。
    pub target_id: Option<String>,
    /// 父级 id（如 run 的会话 id、快照的关联任务 id、feature 的项目 id）。
    pub parent_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GlobalSearchGroup {
    pub category: String,
    pub items: Vec<GlobalSearchResult>,
    /// 后端按 limit+1 探测：还有更多未返回的结果。
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
pub struct GlobalSearchResponse {
    /// 实际用于查询的关键词（trim/截断后）。
    pub query: String,
    /// 仅包含有命中的分组；组顺序固定（tasks → planning）。
    pub groups: Vec<GlobalSearchGroup>,
    pub total_returned: usize,
}

// ── 工具函数 ────────────────────────────────────────────────

/// LIKE 模式构造：转义 `\`、`%`、`_`，防止用户输入成为通配符。
/// 与 `clipboard::store::like_pattern` 语义一致（配套 `ESCAPE '\'`）。
fn like_pattern(q: &str) -> String {
    format!(
        "%{}%",
        q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    )
}

/// 字符边界安全的截断（按 char 计数，超出以 … 收尾；… 计入上限）。
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    if max <= 1 {
        return "…".to_string();
    }
    let keep = max - 1;
    let mut out: String = s.chars().take(keep).collect();
    out.push('…');
    out
}

/// 首行提取（收集箱内容可能是多行）。
fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("")
}

/// 匹配等级（纯函数，可测试）：
/// 0 = 标题精确匹配，1 = 标题前缀，2 = 标题包含，3 = 摘要/正文/元数据命中，
/// 4 = 其他列命中（如分类/标签/路径），数值越小越靠前。
fn rank_match(query: &str, title: &str, body: &str) -> u8 {
    let q = query.to_lowercase();
    if q.is_empty() {
        return 4;
    }
    let t = title.to_lowercase();
    if t == q {
        return 0;
    }
    if t.starts_with(&q) {
        return 1;
    }
    if t.contains(&q) {
        return 2;
    }
    if body.to_lowercase().contains(&q) {
        return 3;
    }
    4
}

/// 候选：匹配等级 + 结果。组内先按等级稳定排序，再截断。
type Candidate = (u8, GlobalSearchResult);

fn finish_group(
    category: &str,
    mut candidates: Vec<Candidate>,
    limit: usize,
) -> Option<GlobalSearchGroup> {
    if candidates.is_empty() {
        return None;
    }
    // 稳定排序：同级保持调用方给定的业务次序（SQL ORDER BY 已确定）。
    candidates.sort_by_key(|(rank, _)| *rank);
    let has_more = candidates.len() > limit;
    candidates.truncate(limit);
    Some(GlobalSearchGroup {
        category: category.to_string(),
        items: candidates.into_iter().map(|(_, r)| r).collect(),
        has_more,
    })
}

fn norm_limit(limit_per_category: u32) -> usize {
    let l = if limit_per_category == 0 {
        DEFAULT_LIMIT_PER_CATEGORY
    } else {
        limit_per_category
    };
    l.clamp(1, MAX_LIMIT_PER_CATEGORY) as usize
}

fn invalid_category(c: &str) -> AppError {
    AppError::Validation(format!(
        "global_search.categories 非法: {c}（允许: {}）",
        CATEGORIES.join("|")
    ))
}

// ── 各分类查询（同一 &Connection 内执行）─────────────────────

fn search_tasks(conn: &Connection, q: &str, pat: &str, limit: i64) -> AppResult<Vec<Candidate>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.title, t.description, t.status, t.priority, t.category, t.tags, \
                t.due_at, t.completed_at, t.updated_at \
         FROM tasks t \
         WHERE t.title LIKE ?1 ESCAPE '\\' OR t.description LIKE ?1 ESCAPE '\\' \
            OR t.category LIKE ?1 ESCAPE '\\' OR t.tags LIKE ?1 ESCAPE '\\' \
         ORDER BY (t.status = 'pending') DESC, t.updated_at DESC, t.id DESC \
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![pat, limit], |r| {
        let id: String = r.get(0)?;
        let title: String = r.get(1)?;
        let description: Option<String> = r.get(2)?;
        let status: String = r.get(3)?;
        let priority: i64 = r.get(4)?;
        let category: Option<String> = r.get(5)?;
        let tags_json: String = r.get(6)?;
        let due_at: Option<String> = r.get(7)?;
        let completed_at: Option<String> = r.get(8)?;
        let updated_at: String = r.get(9)?;
        Ok((id, title, description, status, priority, category, tags_json, due_at, completed_at, updated_at))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, title, description, status, priority, category, tags_json, due_at, completed_at, updated_at) = row?;
        let body = description.clone().unwrap_or_default();
        let rank = rank_match(q, &title, &body);
        let subtitle = match category.as_deref() {
            Some(c) if !c.trim().is_empty() => c.to_string(),
            _ => {
                // tags 为 JSON 数组字符串；仅在分类为空时取第一个标签做副标题。
                serde_json::from_str::<Vec<String>>(&tags_json)
                    .ok()
                    .and_then(|tags| tags.first().cloned())
                    .unwrap_or_default()
            }
        };
        out.push((
            rank,
            GlobalSearchResult {
                id: id.clone(),
                category: "tasks".into(),
                kind: "task".into(),
                title: truncate(&title, TITLE_MAX_CHARS),
                subtitle,
                snippet: truncate(body.trim(), SNIPPET_MAX_CHARS),
                occurred_at: due_at.or(completed_at).or(Some(updated_at)),
                status: Some(status),
                priority: Some(priority),
                target_id: Some(id),
                parent_id: None,
            },
        ));
    }
    Ok(out)
}

fn search_clipboard(
    conn: &Connection,
    q: &str,
    pat: &str,
    limit: i64,
) -> AppResult<Vec<Candidate>> {
    let mut stmt = conn.prepare(
        "SELECT i.id, i.kind, i.title, i.preview, i.source_app, i.source_title, \
                i.favorite, i.pinned, i.last_seen_at, i.byte_size \
         FROM clipboard_items i \
         WHERE i.text LIKE ?1 ESCAPE '\\' OR i.preview LIKE ?1 ESCAPE '\\' \
            OR i.title LIKE ?1 ESCAPE '\\' OR i.source_app LIKE ?1 ESCAPE '\\' \
            OR i.source_title LIKE ?1 ESCAPE '\\' OR i.file_paths LIKE ?1 ESCAPE '\\' \
         ORDER BY i.pinned DESC, i.favorite DESC, i.last_seen_at DESC, i.id DESC \
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![pat, limit], |r| {
        let id: String = r.get(0)?;
        let kind: String = r.get(1)?;
        let title: Option<String> = r.get(2)?;
        let preview: Option<String> = r.get(3)?;
        let source_app: Option<String> = r.get(4)?;
        let source_title: Option<String> = r.get(5)?;
        let favorite: i64 = r.get(6)?;
        let pinned: i64 = r.get(7)?;
        let last_seen_at: String = r.get(8)?;
        let byte_size: i64 = r.get(9)?;
        Ok((id, kind, title, preview, source_app, source_title, favorite, pinned, last_seen_at, byte_size))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, kind, title, preview, source_app, source_title, favorite, pinned, last_seen_at, _byte_size) = row?;
        // 展示标题：title 优先，其次 preview 首行；正文 text / html 不返回。
        let preview = preview.unwrap_or_default();
        let title = title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| first_line(&preview).to_string());
        let rank = rank_match(q, &title, &preview);
        let mut subtitle = source_app.unwrap_or_default();
        if favorite != 0 {
            if !subtitle.is_empty() {
                subtitle.push_str(" · ");
            }
            subtitle.push_str("已收藏");
        }
        if pinned != 0 {
            if !subtitle.is_empty() {
                subtitle.push_str(" · ");
            }
            subtitle.push_str("已置顶");
        }
        out.push((
            rank,
            GlobalSearchResult {
                id: id.clone(),
                category: "clipboard".into(),
                kind,
                title: truncate(&title, TITLE_MAX_CHARS),
                subtitle,
                snippet: truncate(preview.trim(), SNIPPET_MAX_CHARS),
                occurred_at: Some(last_seen_at),
                status: None,
                priority: None,
                target_id: Some(id),
                parent_id: None,
            },
        ));
    }
    Ok(out)
}

fn search_capture(conn: &Connection, q: &str, pat: &str, limit: i64) -> AppResult<Vec<Candidate>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.kind, c.content, c.url, c.note, c.status, c.created_at \
         FROM quick_capture_items c \
         WHERE c.content LIKE ?1 ESCAPE '\\' OR c.url LIKE ?1 ESCAPE '\\' \
            OR c.note LIKE ?1 ESCAPE '\\' OR c.kind LIKE ?1 ESCAPE '\\' \
         ORDER BY (c.status = 'inbox') DESC, c.created_at DESC, c.id DESC \
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![pat, limit], |r| {
        let id: String = r.get(0)?;
        let kind: String = r.get(1)?;
        let content: String = r.get(2)?;
        let url: Option<String> = r.get(3)?;
        let note: Option<String> = r.get(4)?;
        let status: String = r.get(5)?;
        let created_at: String = r.get(6)?;
        Ok((id, kind, content, url, note, status, created_at))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, kind, content, url, note, status, created_at) = row?;
        let title = first_line(&content).to_string();
        let body = note.clone().unwrap_or_else(|| content.clone());
        let rank = rank_match(q, &title, &body);
        // 未处理/已处理/已转任务的中文状态副标题；链接条目附 url 域名信息。
        let status_label = match status.as_str() {
            "inbox" => "未处理",
            "handled" => "已处理",
            "converted" => "已转任务",
            _ => status.as_str(),
        };
        let mut subtitle = status_label.to_string();
        if let Some(u) = url.as_deref() {
            if !u.is_empty() {
                subtitle.push_str(" · 链接");
            }
        }
        out.push((
            rank,
            GlobalSearchResult {
                id: id.clone(),
                category: "capture".into(),
                kind,
                title: truncate(&title, TITLE_MAX_CHARS),
                subtitle,
                snippet: truncate(body.trim(), SNIPPET_MAX_CHARS),
                occurred_at: Some(created_at),
                status: Some(status),
                priority: None,
                target_id: Some(id),
                parent_id: None,
            },
        ));
    }
    Ok(out)
}

fn search_shelf(conn: &Connection, q: &str, pat: &str, limit: i64) -> AppResult<Vec<Candidate>> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.kind, s.display_name, s.note, s.exists_state, s.byte_size, \
                s.storage_mode, s.updated_at \
         FROM shelf_items s \
         WHERE s.display_name LIKE ?1 ESCAPE '\\' OR s.content LIKE ?1 ESCAPE '\\' \
            OR s.note LIKE ?1 ESCAPE '\\' \
            OR s.original_path LIKE ?1 ESCAPE '\\' OR s.managed_path LIKE ?1 ESCAPE '\\' \
         ORDER BY s.pinned DESC, s.updated_at DESC, s.id DESC \
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![pat, limit], |r| {
        let id: String = r.get(0)?;
        let kind: String = r.get(1)?;
        let display_name: String = r.get(2)?;
        let note: Option<String> = r.get(3)?;
        let exists_state: String = r.get(4)?;
        let byte_size: i64 = r.get(5)?;
        let storage_mode: String = r.get(6)?;
        let updated_at: String = r.get(7)?;
        Ok((id, kind, display_name, note, exists_state, byte_size, storage_mode, updated_at))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, kind, display_name, note, exists_state, _byte_size, storage_mode, updated_at) = row?;
        let rank = rank_match(q, &display_name, &note.clone().unwrap_or_default());
        // 引用文件已失效时如实标注，不伪装成正常文件。
        let missing = exists_state == "missing";
        let mut subtitle = match storage_mode.as_str() {
            "managed" => "托管副本".to_string(),
            "link" => "链接".to_string(),
            _ => "引用".to_string(),
        };
        if missing {
            subtitle.push_str(" · 文件已失效");
        }
        out.push((
            rank,
            GlobalSearchResult {
                id: id.clone(),
                category: "shelf".into(),
                kind,
                title: truncate(&display_name, TITLE_MAX_CHARS),
                subtitle,
                snippet: truncate(note.clone().unwrap_or_default().trim(), SNIPPET_MAX_CHARS),
                occurred_at: Some(updated_at),
                status: Some(if missing { "missing".into() } else { exists_state }),
                priority: None,
                target_id: Some(id),
                parent_id: None,
            },
        ));
    }
    Ok(out)
}

fn search_apps(conn: &Connection, q: &str, pat: &str, limit: i64) -> AppResult<Vec<Candidate>> {
    let mut stmt = conn.prepare(
        "SELECT n.id, n.display_name, n.target_type, n.category, n.url, n.use_count, n.updated_at \
         FROM navigation_targets n \
         WHERE n.hidden = 0 AND (n.display_name LIKE ?1 ESCAPE '\\' OR n.category LIKE ?1 ESCAPE '\\' \
            OR n.url LIKE ?1 ESCAPE '\\' OR n.path LIKE ?1 ESCAPE '\\' \
            OR n.app_key LIKE ?1 ESCAPE '\\' OR n.window_title_hint LIKE ?1 ESCAPE '\\' \
            OR n.exe_path LIKE ?1 ESCAPE '\\') \
         ORDER BY n.favorite DESC, n.use_count DESC, n.display_name COLLATE NOCASE, n.id DESC \
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![pat, limit], |r| {
        let id: String = r.get(0)?;
        let display_name: String = r.get(1)?;
        let target_type: String = r.get(2)?;
        let category: Option<String> = r.get(3)?;
        let url: Option<String> = r.get(4)?;
        let use_count: i64 = r.get(5)?;
        let updated_at: String = r.get(6)?;
        Ok((id, display_name, target_type, category, url, use_count, updated_at))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, display_name, target_type, category, url, use_count, updated_at) = row?;
        let body = format!("{} {}", category.clone().unwrap_or_default(), url.clone().unwrap_or_default());
        let rank = rank_match(q, &display_name, &body);
        out.push((
            rank,
            GlobalSearchResult {
                id: id.clone(),
                category: "apps".into(),
                kind: target_type,
                title: truncate(&display_name, TITLE_MAX_CHARS),
                subtitle: category.unwrap_or_default(),
                snippet: if use_count > 0 {
                    format!("已使用 {use_count} 次")
                } else {
                    String::new()
                },
                occurred_at: Some(updated_at),
                status: None,
                priority: None,
                target_id: Some(id),
                parent_id: None,
            },
        ));
    }
    Ok(out)
}

/// Agent 会话与执行轮次。强制 `origin = 'real'` 且来源 `hidden = 0`；
/// 只搜标题/外部 ID/来源名/任务标题，不触碰对话内容与 payload。
/// 来源名称命中的时候返回该来源的最近会话（保证每条结果都可精确跳转）。
fn search_agents(conn: &Connection, q: &str, pat: &str, limit: i64) -> AppResult<Vec<Candidate>> {
    let mut out = Vec::new();
    // 会话：标题 / 外部 ID / 来源名命中。
    {
        let mut stmt = conn.prepare(
            "SELECT s.id, s.title, s.external_id, s.status, s.source_id, src.display_name, s.last_seen_at \
             FROM agent_sessions s JOIN agent_sources src ON src.id = s.source_id \
             WHERE s.origin = 'real' AND src.hidden = 0 \
               AND (s.title LIKE ?1 ESCAPE '\\' OR s.external_id LIKE ?1 ESCAPE '\\' \
                 OR src.display_name LIKE ?1 ESCAPE '\\') \
             ORDER BY s.last_seen_at DESC, s.id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pat, limit], |r| {
            let id: String = r.get(0)?;
            let title: Option<String> = r.get(1)?;
            let external_id: Option<String> = r.get(2)?;
            let status: Option<String> = r.get(3)?;
            let source_id: String = r.get(4)?;
            let source_name: String = r.get(5)?;
            let last_seen_at: String = r.get(6)?;
            Ok((id, title, external_id, status, source_id, source_name, last_seen_at))
        })?;
        for row in rows {
            let (id, title, external_id, status, source_id, source_name, last_seen_at) = row?;
            let title = title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| external_id.clone().unwrap_or_else(|| id.clone()));
            let body = format!("{source_name} {}", external_id.clone().unwrap_or_default());
            let rank = rank_match(q, &title, &body);
            out.push((
                rank,
                GlobalSearchResult {
                    id: id.clone(),
                    category: "agents".into(),
                    kind: "session".into(),
                    title: truncate(&title, TITLE_MAX_CHARS),
                    subtitle: format!("会话 · {source_name}"),
                    snippet: external_id.map(|e| truncate(&e, SNIPPET_MAX_CHARS)).unwrap_or_default(),
                    occurred_at: Some(last_seen_at),
                    status,
                    priority: None,
                    target_id: Some(id),
                    parent_id: Some(source_id),
                },
            ));
        }
    }
    // 轮次：任务标题命中。
    {
        let mut stmt = conn.prepare(
            "SELECT r.id, r.session_id, r.task_title, r.status, r.source_id, src.display_name, r.updated_at \
             FROM agent_runs r JOIN agent_sources src ON src.id = r.source_id \
             WHERE r.origin = 'real' AND src.hidden = 0 AND r.task_title LIKE ?1 ESCAPE '\\' \
             ORDER BY r.updated_at DESC, r.id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pat, limit], |r| {
            let id: String = r.get(0)?;
            let session_id: String = r.get(1)?;
            let task_title: Option<String> = r.get(2)?;
            let status: Option<String> = r.get(3)?;
            let source_id: String = r.get(4)?;
            let source_name: String = r.get(5)?;
            let updated_at: String = r.get(6)?;
            Ok((id, session_id, task_title, status, source_id, source_name, updated_at))
        })?;
        for row in rows {
            let (id, session_id, task_title, status, source_id, source_name, updated_at) = row?;
            let title = task_title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "未命名轮次".into());
            let rank = rank_match(q, &title, &source_name);
            out.push((
                rank,
                GlobalSearchResult {
                    id: id.clone(),
                    category: "agents".into(),
                    kind: "run".into(),
                    title: truncate(&title, TITLE_MAX_CHARS),
                    subtitle: format!("轮次 · {source_name}"),
                    snippet: String::new(),
                    occurred_at: Some(updated_at),
                    status,
                    priority: None,
                    target_id: Some(session_id),
                    parent_id: Some(source_id),
                },
            ));
        }
    }
    Ok(out)
}

fn search_workspace(conn: &Connection, q: &str, pat: &str, limit: i64) -> AppResult<Vec<Candidate>> {
    let mut stmt = conn.prepare(
        "SELECT w.id, w.task_id, t.title, w.name, w.note, w.source, w.item_count, w.updated_at \
         FROM workspace_snapshots w LEFT JOIN tasks t ON t.id = w.task_id \
         WHERE w.name LIKE ?1 ESCAPE '\\' OR w.note LIKE ?1 ESCAPE '\\' OR t.title LIKE ?1 ESCAPE '\\' \
         ORDER BY w.updated_at DESC, w.id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![pat, limit], |r| {
        let id: String = r.get(0)?;
        let task_id: Option<String> = r.get(1)?;
        let task_title: Option<String> = r.get(2)?;
        let name: String = r.get(3)?;
        let note: Option<String> = r.get(4)?;
        let source: String = r.get(5)?;
        let item_count: i64 = r.get(6)?;
        let updated_at: String = r.get(7)?;
        Ok((id, task_id, task_title, name, note, source, item_count, updated_at))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, task_id, task_title, name, note, source, item_count, updated_at) = row?;
        let body = format!("{} {}", note.clone().unwrap_or_default(), task_title.clone().unwrap_or_default());
        let rank = rank_match(q, &name, &body);
        let subtitle = match task_title.as_deref() {
            Some(t) if !t.trim().is_empty() => format!("关联任务 · {t}"),
            _ => format!("来源 · {source}"),
        };
        out.push((
            rank,
            GlobalSearchResult {
                id: id.clone(),
                category: "workspace".into(),
                kind: "snapshot".into(),
                title: truncate(&name, TITLE_MAX_CHARS),
                subtitle,
                snippet: {
                    let mut s = truncate(note.clone().unwrap_or_default().trim(), SNIPPET_MAX_CHARS);
                    if item_count > 0 {
                        if !s.is_empty() {
                            s.push_str(" · ");
                        }
                        s.push_str(&format!("{item_count} 个条目"));
                    }
                    s
                },
                occurred_at: Some(updated_at),
                status: None,
                priority: None,
                target_id: Some(id),
                parent_id: task_id,
            },
        ));
    }
    Ok(out)
}

fn search_planning(conn: &Connection, q: &str, pat: &str, limit: i64) -> AppResult<Vec<Candidate>> {
    let mut out = Vec::new();
    // 项目（含归档，前端/文档标注语义；不修改任何规划数据）。
    {
        let mut stmt = conn.prepare(
            "SELECT p.id, p.name, p.description, p.status, p.archived, p.updated_at \
             FROM planning_projects p \
             WHERE p.name LIKE ?1 ESCAPE '\\' OR p.description LIKE ?1 ESCAPE '\\' \
             ORDER BY p.archived ASC, p.updated_at DESC, p.id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pat, limit], |r| {
            let id: String = r.get(0)?;
            let name: String = r.get(1)?;
            let description: Option<String> = r.get(2)?;
            let status: String = r.get(3)?;
            let archived: i64 = r.get(4)?;
            let updated_at: String = r.get(5)?;
            Ok((id, name, description, status, archived, updated_at))
        })?;
        for row in rows {
            let (id, name, description, status, archived, updated_at) = row?;
            let body = description.clone().unwrap_or_default();
            let rank = rank_match(q, &name, &body);
            let mut subtitle = "项目".to_string();
            if archived != 0 {
                subtitle.push_str(" · 已归档");
            }
            out.push((
                rank,
                GlobalSearchResult {
                    id: id.clone(),
                    category: "planning".into(),
                    kind: "project".into(),
                    title: truncate(&name, TITLE_MAX_CHARS),
                    subtitle,
                    snippet: truncate(body.trim(), SNIPPET_MAX_CHARS),
                    occurred_at: Some(updated_at),
                    status: Some(status),
                    priority: None,
                    target_id: Some(id),
                    parent_id: None,
                },
            ));
        }
    }
    // 功能。
    {
        let mut stmt = conn.prepare(
            "SELECT f.id, f.project_id, f.title, f.description, f.status, f.priority, p.name, f.updated_at \
             FROM planning_features f JOIN planning_projects p ON p.id = f.project_id \
             WHERE f.title LIKE ?1 ESCAPE '\\' OR f.description LIKE ?1 ESCAPE '\\' \
             ORDER BY f.updated_at DESC, f.id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pat, limit], |r| {
            let id: String = r.get(0)?;
            let project_id: String = r.get(1)?;
            let title: String = r.get(2)?;
            let description: Option<String> = r.get(3)?;
            let status: String = r.get(4)?;
            let priority: Option<String> = r.get(5)?;
            let project_name: String = r.get(6)?;
            let updated_at: String = r.get(7)?;
            Ok((id, project_id, title, description, status, priority, project_name, updated_at))
        })?;
        for row in rows {
            let (id, project_id, title, description, status, priority, project_name, updated_at) = row?;
            let body = description.clone().unwrap_or_default();
            let rank = rank_match(q, &title, &body);
            out.push((
                rank,
                GlobalSearchResult {
                    id: id.clone(),
                    category: "planning".into(),
                    kind: "feature".into(),
                    title: truncate(&title, TITLE_MAX_CHARS),
                    subtitle: format!("功能 · {project_name}"),
                    snippet: truncate(body.trim(), SNIPPET_MAX_CHARS),
                    occurred_at: Some(updated_at),
                    status: Some(status),
                    priority: priority.map(|p| match p.as_str() {
                        "P0" => 0,
                        "P1" => 1,
                        "P2" => 2,
                        _ => 3,
                    }),
                    target_id: Some(id),
                    parent_id: Some(project_id),
                },
            ));
        }
    }
    // 里程碑。
    {
        let mut stmt = conn.prepare(
            "SELECT m.id, m.project_id, m.name, m.description, p.name, m.updated_at \
             FROM planning_milestones m JOIN planning_projects p ON p.id = m.project_id \
             WHERE m.name LIKE ?1 ESCAPE '\\' OR m.description LIKE ?1 ESCAPE '\\' \
             ORDER BY m.updated_at DESC, m.id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pat, limit], |r| {
            let id: String = r.get(0)?;
            let project_id: String = r.get(1)?;
            let name: String = r.get(2)?;
            let description: Option<String> = r.get(3)?;
            let project_name: String = r.get(4)?;
            let updated_at: String = r.get(5)?;
            Ok((id, project_id, name, description, project_name, updated_at))
        })?;
        for row in rows {
            let (id, project_id, name, description, project_name, updated_at) = row?;
            let body = description.clone().unwrap_or_default();
            let rank = rank_match(q, &name, &body);
            out.push((
                rank,
                GlobalSearchResult {
                    id: id.clone(),
                    category: "planning".into(),
                    kind: "milestone".into(),
                    title: truncate(&name, TITLE_MAX_CHARS),
                    subtitle: format!("里程碑 · {project_name}"),
                    snippet: truncate(body.trim(), SNIPPET_MAX_CHARS),
                    occurred_at: Some(updated_at),
                    status: None,
                    priority: None,
                    target_id: Some(id),
                    parent_id: Some(project_id),
                },
            ));
        }
    }
    Ok(out)
}

/// 快速笔记：复用 notes 模块已公开的稳定查询接口（LIKE 转义在 notes 内部完成，
/// 这里不重复拼 pattern）。笔记是用户长期记录，分类与收集箱（临时）严格区分。
fn search_notes(conn: &Connection, q: &str, limit: i64) -> AppResult<Vec<Candidate>> {
    let mut out = Vec::new();
    for note in crate::notes::store::search_in_conn(conn, q, limit)? {
        let raw_title = note.title.trim();
        let title = if raw_title.is_empty() {
            "无标题笔记".to_string()
        } else {
            raw_title.to_string()
        };
        let mut subtitle = "笔记".to_string();
        if note.favorite {
            subtitle.push_str(" · 收藏");
        } else if note.pinned {
            subtitle.push_str(" · 置顶");
        }
        let rank = rank_match(q, &title, &note.excerpt);
        out.push((
            rank,
            GlobalSearchResult {
                id: note.id.clone(),
                category: "notes".into(),
                kind: "note".into(),
                title: truncate(&title, TITLE_MAX_CHARS),
                subtitle,
                snippet: truncate(note.excerpt.trim(), SNIPPET_MAX_CHARS),
                occurred_at: Some(note.updated_at),
                status: None,
                priority: None,
                target_id: Some(note.id),
                parent_id: None,
            },
        ));
    }
    Ok(out)
}

// ── 入口 ────────────────────────────────────────────────────

/// 执行统一搜索。`categories` 为空/None 表示全部分类；非法分类名返回 Validation 错误。
/// 全程单只读连接（`with_read`），不写任何表。
pub fn run_search(
    db: &Db,
    query: &str,
    categories: &[String],
    limit_per_category: u32,
) -> AppResult<GlobalSearchResponse> {
    for c in categories {
        if !CATEGORIES.contains(&c.as_str()) {
            return Err(invalid_category(c));
        }
    }
    let trimmed = query.trim();
    let query = truncate(trimmed, MAX_QUERY_CHARS);
    let empty = |q: String| GlobalSearchResponse { query: q, groups: Vec::new(), total_returned: 0 };
    if trimmed.is_empty() {
        return Ok(empty(query));
    }
    let pat = like_pattern(&query);
    let limit = norm_limit(limit_per_category);
    // limit+1：多取一条用于 has_more 探测（结果在 finish_group 截回 limit）。
    let sql_limit = limit as i64 + 1;
    let want = |c: &str| categories.is_empty() || categories.iter().any(|x| x == c);

    let mut groups: Vec<GlobalSearchGroup> = Vec::new();
    db.with_read(|conn| {
        // 组顺序固定；仅收录有命中的分组。
        let mut push = |category: &str, candidates: AppResult<Vec<Candidate>>| -> AppResult<()> {
            if let Some(g) = finish_group(category, candidates?, limit) {
                groups.push(g);
            }
            Ok(())
        };
        if want("tasks") {
            push("tasks", search_tasks(conn, &query, &pat, sql_limit))?;
        }
        if want("clipboard") {
            push("clipboard", search_clipboard(conn, &query, &pat, sql_limit))?;
        }
        if want("capture") {
            push("capture", search_capture(conn, &query, &pat, sql_limit))?;
        }
        if want("shelf") {
            push("shelf", search_shelf(conn, &query, &pat, sql_limit))?;
        }
        if want("apps") {
            push("apps", search_apps(conn, &query, &pat, sql_limit))?;
        }
        if want("agents") {
            push("agents", search_agents(conn, &query, &pat, sql_limit))?;
        }
        if want("workspace") {
            push("workspace", search_workspace(conn, &query, &pat, sql_limit))?;
        }
        if want("planning") {
            push("planning", search_planning(conn, &query, &pat, sql_limit))?;
        }
        if want("notes") {
            push("notes", search_notes(conn, &query, sql_limit))?;
        }
        Ok(())
    })?;

    let total_returned = groups.iter().map(|g| g.items.len()).sum();
    Ok(GlobalSearchResponse { query, groups, total_returned })
}

// ── 测试 ────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(tag: &str) -> (std::path::PathBuf, Db) {
        let dir = std::env::temp_dir().join(format!("td-gs-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.clone(), Db::open(&dir.join("t.db")).unwrap())
    }

    /// 在全部业务表里 seed 一批覆盖命中面最小的行（迁移已建全表）。
    fn seed_all(db: &Db) {
        db.with_conn(|c| {
            // 任务：待办 + 已完成 + 标签命中。
            c.execute(
                "INSERT INTO tasks (id,title,description,status,category,tags,priority,created_at,updated_at) \
                 VALUES ('t1','修复登录页面异常','登录页 500','pending','bug','[\"登录\"]',1,'2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            c.execute(
                "INSERT INTO tasks (id,title,description,status,category,tags,priority,created_at,updated_at,completed_at) \
                 VALUES ('t2','登录模块 UI 优化','','completed','ui','[]',2,'2026-11-01T09:00:00Z','2026-11-02T09:00:00Z','2026-11-02T09:00:00Z')",
                [],
            )?;
            // 剪贴板：正文命中 + 来源命中。
            c.execute(
                "INSERT INTO clipboard_items (id,kind,text,preview,content_hash,byte_size,source_app,source_title,favorite,pinned,copy_count,created_at,last_seen_at) \
                 VALUES ('c1','text','登录 API 请求示例','登录 API 请求示例','hash-c1',10,'chrome','登录页 - Chrome',0,0,1,'2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            c.execute(
                "INSERT INTO clipboard_items (id,kind,text,preview,content_hash,byte_size,source_app,source_title,favorite,pinned,copy_count,created_at,last_seen_at) \
                 VALUES ('c2','text','无关内容','无关内容','hash-c2',10,'login-manager','登录管理器',0,0,1,'2026-11-01T11:00:00Z','2026-11-01T11:00:00Z')",
                [],
            )?;
            // 收集箱：想法 + 链接。
            c.execute(
                "INSERT INTO quick_capture_items (id,client_id,kind,content,url,note,status,created_at,updated_at) \
                 VALUES ('q1','cli-1','idea','收集登录流程的想法',NULL,NULL,'inbox','2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            c.execute(
                "INSERT INTO quick_capture_items (id,client_id,kind,content,url,note,status,created_at,updated_at) \
                 VALUES ('q2','cli-2','link','参考资料','https://example.com/login-doc','登录文档','converted','2026-11-01T12:00:00Z','2026-11-01T12:00:00Z')",
                [],
            )?;
            // 暂存架：名称命中 + 备注命中 + 失效引用。
            c.execute(
                "INSERT INTO shelf_items (id,kind,display_name,source_kind,storage_mode,byte_size,exists_state,note,created_at,updated_at) \
                 VALUES ('s1','file','登录页设计图.png','manual','managed',2048,'ok','','2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            c.execute(
                "INSERT INTO shelf_items (id,kind,display_name,source_kind,storage_mode,byte_size,exists_state,note,created_at,updated_at) \
                 VALUES ('s2','file','spec-v2.pdf','manual','reference',4096,'missing','登录接口规格说明','2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            // 应用：已保存目标（含隐藏项，hidden 不应命中）。
            c.execute(
                "INSERT INTO navigation_targets (id,display_name,target_type,hidden,created_at,updated_at) \
                 VALUES ('n1','登录调试环境','application',0,'2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            c.execute(
                "INSERT INTO navigation_targets (id,display_name,target_type,hidden,created_at,updated_at) \
                 VALUES ('n2','隐藏目标','application',1,'2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            // Agent：真实来源+会话+轮次，mock 来源+会话（不得命中）。
            c.execute(
                "INSERT INTO agent_sources (id,display_name,kind,enabled,hidden,category,created_at,updated_at) \
                 VALUES ('src1','Codex','cli',1,0,'real','2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            c.execute(
                "INSERT INTO agent_sessions (id,source_id,external_id,title,status,first_seen_at,last_seen_at,origin) \
                 VALUES ('sess1','src1','ext-1','登录模块开发会话','active','2026-11-01T10:00:00Z','2026-11-01T10:00:00Z','real')",
                [],
            )?;
            c.execute(
                "INSERT INTO agent_runs (id,session_id,source_id,task_title,status,started_at,updated_at,origin) \
                 VALUES ('run1','sess1','src1','修复登录状态异常','completed','2026-11-01T10:00:00Z','2026-11-01T10:00:00Z','real')",
                [],
            )?;
            c.execute(
                "INSERT INTO agent_sources (id,display_name,kind,enabled,hidden,category,created_at,updated_at) \
                 VALUES ('src2','Mock 来源','cli',1,0,'mock','2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            c.execute(
                "INSERT INTO agent_sessions (id,source_id,external_id,title,status,first_seen_at,last_seen_at,origin) \
                 VALUES ('sess2','src2','ext-2','登录 mock 会话','active','2026-11-01T10:00:00Z','2026-11-01T10:00:00Z','mock')",
                [],
            )?;
            // 工作现场：名称命中 + 关联任务标题命中。
            c.execute(
                "INSERT INTO workspace_snapshots (id,task_id,name,note,source,item_count,created_at,updated_at) \
                 VALUES ('w1','t1','登录功能开发现场','含浏览器与终端','task',3,'2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            // 规划中心：项目 + 功能 + 里程碑。
            c.execute(
                "INSERT INTO planning_projects (id,name,description,status,archived,created_at,updated_at) \
                 VALUES ('p1','登录系统改造','统一认证','in_progress',0,'2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            c.execute(
                "INSERT INTO planning_features (id,project_id,title,description,status,priority,created_at,updated_at) \
                 VALUES ('f1','p1','用户认证模块','账号密码登录','planned','P1','2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            c.execute(
                "INSERT INTO planning_milestones (id,project_id,name,description,created_at,updated_at) \
                 VALUES ('m1','p1','登录上线里程碑','','2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    fn hit(rs: &GlobalSearchResponse, category: &str, id: &str) -> bool {
        rs.groups
            .iter()
            .find(|g| g.category == category)
            .map(|g| g.items.iter().any(|i| i.id == id))
            .unwrap_or(false)
    }

    #[test]
    fn like_pattern_escapes_wildcards() {
        assert_eq!(like_pattern("100%"), "%100\\%%");
        assert_eq!(like_pattern("a_b"), "%a\\_b%");
        assert_eq!(like_pattern("a\\b"), "%a\\\\b%");
        // 数据库层面验证：'%' 输入不应通配任意内容。
        let (_dir, db) = temp_db("escape");
        seed_all(&db);
        let rs = run_search(&db, "%", &[], 0).unwrap();
        // 仅当标题/正文真实包含 % 时才命中；seed 数据不含 %。
        assert!(rs.groups.is_empty(), "百分号不应作为通配符命中任何数据");
    }

    #[test]
    fn rank_match_levels_are_ordered() {
        assert_eq!(rank_match("登录", "登录", ""), 0);
        assert_eq!(rank_match("登录", "登录页面", ""), 1);
        assert_eq!(rank_match("登录", "修复登录页面", ""), 2);
        assert_eq!(rank_match("登录", "任务", "关于登录的描述"), 3);
        assert_eq!(rank_match("登录", "任务", "标签命中"), 4);
    }

    #[test]
    fn search_hits_all_categories() {
        let (_dir, db) = temp_db("all");
        seed_all(&db);
        let rs = run_search(&db, "登录", &[], 0).unwrap();
        assert_eq!(rs.query, "登录");
        assert!(hit(&rs, "tasks", "t1"), "待办任务应命中");
        assert!(hit(&rs, "tasks", "t2"), "已完成任务也应命中");
        assert!(hit(&rs, "clipboard", "c1"), "剪贴板正文命中");
        assert!(hit(&rs, "clipboard", "c2"), "剪贴板来源窗口命中");
        assert!(hit(&rs, "capture", "q1"), "收集箱想法命中");
        assert!(hit(&rs, "capture", "q2"), "收集箱链接备注命中");
        assert!(hit(&rs, "shelf", "s1"), "暂存架文件名命中");
        assert!(hit(&rs, "shelf", "s2"), "暂存架备注命中");
        assert!(hit(&rs, "apps", "n1"), "应用显示名命中");
        assert!(!hit(&rs, "apps", "n2"), "隐藏目标不得命中");
        assert!(hit(&rs, "agents", "sess1"), "Agent 会话标题命中");
        assert!(!hit(&rs, "agents", "sess2"), "mock 来源会话不得命中");
        assert!(hit(&rs, "workspace", "w1"), "工作现场名称命中");
        assert!(hit(&rs, "planning", "p1"), "规划项目命中");
        assert!(hit(&rs, "planning", "f1"), "规划功能命中");
        assert!(hit(&rs, "planning", "m1"), "规划里程碑命中");
    }

    #[test]
    fn agent_mock_data_is_isolated() {
        let (_dir, db) = temp_db("agent-iso");
        seed_all(&db);
        let rs = run_search(&db, "mock", &["agents".into()], 0).unwrap();
        assert!(rs.groups.iter().all(|g| g.items.iter().all(|i| i.id != "sess2")));
        // benchmark 类别来源同样不出现。
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO agent_sources (id,display_name,kind,enabled,hidden,category,created_at,updated_at) \
                 VALUES ('src3','Benchmark 登录','cli',1,1,'benchmark','2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            c.execute(
                "INSERT INTO agent_sessions (id,source_id,external_id,title,status,first_seen_at,last_seen_at,origin) \
                 VALUES ('sess3','src3','ext-3','登录 benchmark 会话','active','2026-11-01T10:00:00Z','2026-11-01T10:00:00Z','real')",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let rs2 = run_search(&db, "benchmark", &["agents".into()], 0).unwrap();
        // 与 snapshot_query 相同的口径：来源 hidden=1 即整体不可见（无论 origin）。
        // benchmark 来源按现有 seed 惯例登记为 hidden=1，其会话不得进入搜索结果。
        let visible = rs2
            .groups
            .first()
            .map(|g| g.items.iter().all(|i| i.parent_id.as_deref() != Some("src3")))
            .unwrap_or(true);
        assert!(visible, "hidden=1 的 benchmark 来源不得进入搜索结果");
    }

    #[test]
    fn pending_tasks_rank_before_completed() {
        let (_dir, db) = temp_db("rank");
        seed_all(&db);
        // t3/t4 同标题（同匹配等级），仅状态不同：待办必须排在已完成前。
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id,title,description,status,category,tags,priority,created_at,updated_at) \
                 VALUES ('t3','登录诊断','','pending','bug','[]',1,'2026-11-01T10:00:00Z','2026-11-03T10:00:00Z')",
                [],
            )?;
            c.execute(
                "INSERT INTO tasks (id,title,description,status,category,tags,priority,created_at,updated_at) \
                 VALUES ('t4','登录诊断','','completed','bug','[]',1,'2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let rs = run_search(&db, "登录", &["tasks".into()], 0).unwrap();
        let items = &rs.groups[0].items;
        // t2/t3/t4 都是标题前缀（等级 1）：组内未完成（t3）排最前；t1 是标题包含（等级 2）垫底。
        assert_eq!(items[0].id, "t3", "同等级内待办任务应排在已完成前");
        let t3 = items.iter().position(|i| i.id == "t3").expect("t3 应命中");
        let t4 = items.iter().position(|i| i.id == "t4").expect("t4 应命中");
        let t2 = items.iter().position(|i| i.id == "t2").expect("t2 应命中");
        let t1 = items.iter().position(|i| i.id == "t1").expect("t1 应命中");
        assert!(t3 < t4, "相同匹配等级内待办任务应排在已完成前");
        assert!(t2 < t1, "标题前缀命中应排在标题包含前");
    }

    #[test]
    fn limit_plus_one_reports_has_more() {
        let (_dir, db) = temp_db("limit");
        seed_all(&db);
        // 收集箱 2 条命中「收集/参考」不同词；用 limit=1 探测 has_more。
        let rs = run_search(&db, "登录", &["capture".into()], 1).unwrap();
        // q1 命中「登录」；q2 命中「登录文档」。limit=1 → has_more=true。
        let g = rs.groups.first().expect("capture 组应有结果");
        assert_eq!(g.items.len(), 1);
        assert!(g.has_more, "limit+1 应探测到更多结果");
    }

    #[test]
    fn empty_and_whitespace_queries_return_empty() {
        let (_dir, db) = temp_db("empty");
        seed_all(&db);
        for q in ["", "   ", "\u{3000}"] {
            let rs = run_search(&db, q, &[], 0).unwrap();
            assert!(rs.groups.is_empty(), "空白查询应返回空");
            assert_eq!(rs.total_returned, 0);
        }
    }

    #[test]
    fn special_sql_chars_do_not_error_or_wildcard() {
        let (_dir, db) = temp_db("special");
        seed_all(&db);
        for q in ["'", "\"", "--", ";", "\\", "%_", "【】", "登录'_x"] {
            let rs = run_search(&db, q, &[], 0);
            assert!(rs.is_ok(), "特殊字符查询不应报错: {q}");
        }
    }

    #[test]
    fn overlong_query_is_truncated_not_rejected() {
        let (_dir, db) = temp_db("long");
        seed_all(&db);
        let q = "登".repeat(500);
        let rs = run_search(&db, &q, &[], 0).unwrap();
        assert_eq!(rs.query.chars().count(), MAX_QUERY_CHARS);
    }

    #[test]
    fn invalid_category_is_rejected() {
        let (_dir, db) = temp_db("cat");
        seed_all(&db);
        // 注意："notes" 自 v0.10 起是合法分类，这里用真正未知的分类名。
        let err = run_search(&db, "登录", &["unknown_category".into()], 0).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn notes_are_searchable_and_located() {
        let (_dir, db) = temp_db("notes");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO notes (id, title, content, pinned, favorite, revision, created_at, updated_at)
                 VALUES ('n1','登录设计备忘','登录页要支持扫码与验证码',1,0,1,'2026-11-01T10:00:00Z','2026-11-01T10:00:00Z')",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let rs = run_search(&db, "登录", &["notes".into()], 5).unwrap();
        assert_eq!(rs.groups.len(), 1);
        let group = &rs.groups[0];
        assert_eq!(group.category, "notes");
        let item = &group.items[0];
        assert_eq!(item.kind, "note");
        assert_eq!(item.target_id.as_deref(), Some("n1"));
        assert_eq!(item.title, "登录设计备忘");
        assert!(item.subtitle.contains("笔记"));
        assert!(item.snippet.contains("扫码"));
    }

    #[test]
    fn category_filter_only_queries_selected() {
        let (_dir, db) = temp_db("filter");
        seed_all(&db);
        let rs = run_search(&db, "登录", &["tasks".into()], 0).unwrap();
        assert_eq!(rs.groups.len(), 1);
        assert_eq!(rs.groups[0].category, "tasks");
    }

    #[test]
    fn same_title_records_with_different_ids_both_surface() {
        let (_dir, db) = temp_db("dup");
        seed_all(&db);
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO quick_capture_items (id,client_id,kind,content,status,created_at,updated_at) \
                 VALUES ('q3','cli-3','text','登录流程备忘','inbox','2026-11-01T13:00:00Z','2026-11-01T13:00:00Z')",
                [],
            )?;
            c.execute(
                "INSERT INTO quick_capture_items (id,client_id,kind,content,status,created_at,updated_at) \
                 VALUES ('q4','cli-4','text','登录流程备忘','inbox','2026-11-01T14:00:00Z','2026-11-01T14:00:00Z')",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let rs = run_search(&db, "登录流程备忘", &["capture".into()], 0).unwrap();
        let ids: Vec<&str> = rs.groups[0].items.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"q3") && ids.contains(&"q4"), "同名不同 ID 记录都应返回");
    }

    #[test]
    fn unicode_and_mixed_case_match() {
        let (_dir, db) = temp_db("unicode");
        seed_all(&db);
        // LIKE 对 ASCII 不区分大小写：PDF 命中 spec-v2.pdf 的 display_name。
        let rs = run_search(&db, "PDF", &["shelf".into()], 0).unwrap();
        assert!(hit(&rs, "shelf", "s2"), "ASCII 大小写不敏感命中");
        let rs2 = run_search(&db, "认证模块", &["planning".into()], 0).unwrap();
        assert!(hit(&rs2, "planning", "f1"), "中文多字节命中");
    }

    #[test]
    fn shelf_missing_reference_is_marked() {
        let (_dir, db) = temp_db("missing");
        seed_all(&db);
        let rs = run_search(&db, "spec-v2", &["shelf".into()], 0).unwrap();
        let item = &rs.groups[0].items[0];
        assert_eq!(item.status.as_deref(), Some("missing"));
        assert!(item.subtitle.contains("已失效"), "引用失效必须如实标注");
    }

    /// 万级数据基准（任务书 §8）：10k 任务 + 10k 收集箱 + 2k 剪贴板 + 1k 暂存架，
    /// 全分类一次查询。断言宽松上限防退化失控，实际耗时打印到输出供验收记录。
    #[test]
    fn search_scale_benchmark_10k_rows() {
        let (_dir, db) = temp_db("perf");
        db.with_conn(|c| {
            c.execute_batch("BEGIN").unwrap();
            for i in 0..10_000 {
                c.execute(
                    "INSERT INTO tasks (id,title,description,status,category,tags,priority,created_at,updated_at) \
                     VALUES (?1,?2,'性能基准描述','pending','bench','[]',1,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')",
                    rusqlite::params![format!("pt-{i}"), format!("基准任务第 {i} 号")],
                )
                .unwrap();
            }
            for i in 0..10_000 {
                c.execute(
                    "INSERT INTO quick_capture_items (id,client_id,kind,content,status,created_at,updated_at) \
                     VALUES (?1,?2,'text',?3,'inbox','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')",
                    rusqlite::params![format!("pq-{i}"), format!("cli-{i}"), format!("收集的基准想法 {i}")],
                )
                .unwrap();
            }
            for i in 0..2_000 {
                c.execute(
                    "INSERT INTO clipboard_items (id,kind,text,preview,content_hash,byte_size,source_app,source_title,favorite,pinned,copy_count,created_at,last_seen_at) \
                     VALUES (?1,'text',?2,?2,?3,10,'bench','基准窗口',0,0,1,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')",
                    rusqlite::params![format!("pc-{i}"), format!("剪贴板基准内容 {i}"), format!("hash-perf-{i}")],
                )
                .unwrap();
            }
            for i in 0..1_000 {
                c.execute(
                    "INSERT INTO shelf_items (id,kind,display_name,source_kind,storage_mode,byte_size,exists_state,note,created_at,updated_at) \
                     VALUES (?1,'file',?2,'manual','managed',1024,'ok','基准备注','2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')",
                    rusqlite::params![format!("ps-{i}"), format!("基准文件-{i}.bin")],
                )
                .unwrap();
            }
            c.execute_batch("COMMIT").unwrap();
            Ok::<_, AppError>(())
        })
        .unwrap();

        // 常规词：命中小子集（高频子串）。
        let t0 = std::time::Instant::now();
        let rs = run_search(&db, "5000", &[], 6).unwrap();
        let hit_ms = t0.elapsed().as_millis();
        assert!(!rs.groups.is_empty(), "应命中编号 5000 系列");
        // 空结果词：全表扫描最坏路径（LIKE 不命中仍要扫完）。
        let t1 = std::time::Instant::now();
        let _ = run_search(&db, "绝不存在的搜索词xyzzy", &[], 6).unwrap();
        let miss_ms = t1.elapsed().as_millis();
        println!("benchmark: 10k rows, hit {hit_ms} ms, miss {miss_ms} ms, total_returned={}", rs.total_returned);
        // 宽松上限：LIKE 扫描在 23k 行内不应接近秒级（防退化失控；非严格 SLA）。
        assert!(hit_ms < 2000, "命中查询 {hit_ms} ms 超出宽松上限");
        assert!(miss_ms < 2000, "空结果查询 {miss_ms} ms 超出宽松上限");
    }
}
