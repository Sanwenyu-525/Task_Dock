//! 剪贴板持久化：条目/资产/分组/排序/任务关联/粘贴审计/清理。
//!
//! 文字与元数据入库，图片原图与缩略图落盘（`clipboard_assets` 只存相对路径）。
//! 所有删除路径都先查引用（分组/任务关联/收藏置顶），避免误删仍被使用的内容。

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use chrono::{DateTime, Duration, Utc};
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::engine::{self, CollectFamily, GroupAction, GroupCandidate, GroupSession};
use super::image;
use super::secure;
use super::{
    CaptureOutcome, CapturedContent, CleanupReport, ClearReport, ClipboardGroup,
    ClipboardGroupItemPosition, ClipboardGroupPage, ClipboardItem, ClipboardStats, ClipboardView,
    DeleteReport, GroupKindCounts, KIND_FILES, KIND_IMAGE, KIND_URL, MAX_AUTO_GROUP_ITEMS,
    MAX_HTML_BYTES, MAX_TEXT_BYTES, PREVIEW_MAX_BYTES, PREVIEW_MAX_EDGE,
    PREVIEW_MAX_SOURCE_PIXELS,
};
use crate::db::{Db, Settings};
use crate::error::{AppError, AppResult};
use zeroize::Zeroizing;

/// 640px 预览派生的缓存角色名：只用于加密 AAD 绑定，不写入 `clipboard_assets`。
const PREVIEW_CACHE_ROLE: &str = "preview640";

const ITEM_FIELDS: &str =
    "i.id, i.kind, i.text, i.html, i.preview, i.title, i.title_source, i.byte_size,
 i.source_app, i.source_title, i.image_width, i.image_height, i.file_paths, i.favorite, i.pinned,
 i.copy_count, i.created_at, i.last_seen_at,
 EXISTS(SELECT 1 FROM clipboard_assets a WHERE a.item_id = i.id AND a.role = 'image') AS has_image,
 EXISTS(SELECT 1 FROM clipboard_assets a WHERE a.item_id = i.id AND a.role = 'thumb') AS has_thumb,
 i.source_kind";

/// 分页查询字段：不读取 `text`/`html`，避免把大正文带进 IPC；`text` 用 `preview` 填充，
/// 与既有列表接口的 compact 语义一致。
const PAGE_ITEM_FIELDS: &str =
    "i.id, i.kind, i.preview, i.title, i.title_source, i.byte_size,
     i.source_app, i.source_title, i.image_width, i.image_height, i.file_paths,
     i.favorite, i.pinned, i.copy_count, i.created_at, i.last_seen_at,
     EXISTS(SELECT 1 FROM clipboard_assets a WHERE a.item_id = i.id AND a.role = 'image') AS has_image,
     EXISTS(SELECT 1 FROM clipboard_assets a WHERE a.item_id = i.id AND a.role = 'thumb') AS has_thumb,
     i.source_kind";

const GROUP_FIELDS: &str = "g.id, g.name, g.mode, g.status, g.favorite, g.pinned, g.created_at,
 g.updated_at, g.closed_at,
 (SELECT COUNT(*) FROM clipboard_group_items gi WHERE gi.group_id = g.id) AS item_count,
 (SELECT COUNT(*) FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
   WHERE gi.group_id = g.id AND i.kind = 'image') AS image_count,
 COALESCE((SELECT i.preview FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
   WHERE gi.group_id = g.id ORDER BY gi.position LIMIT 1), '') AS preview,
 COALESCE((SELECT i.id FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
   WHERE gi.group_id = g.id ORDER BY gi.position LIMIT 1), '') AS preview_item_id";

/// 行映射内的字段解密：失败转换成 rusqlite 错误，让查询整体 fail-closed，
/// 绝不把密文当正文返回给界面。AAD 绑定条目 UUID 与字段名。
fn decrypt_item_field(item_id: &str, field: &str, raw: String) -> rusqlite::Result<String> {
    decrypt_item_field_app(item_id, field, raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(e),
        )
    })
}

/// 非行映射路径（自动分组、来源聚合、关联标签）使用的同源解密。
fn decrypt_item_field_app(item_id: &str, field: &str, raw: String) -> AppResult<String> {
    secure::decrypt_if_encrypted(&secure::item_field_aad(item_id, field), &raw)
}

fn map_item(row: &Row<'_>) -> rusqlite::Result<ClipboardItem> {
    let id: String = row.get(0)?;
    // 正文、HTML 与可检索元数据可能是密文（ADR-0012）：按条目 UUID 绑定的 AAD 解密；
    // 迁移前的明文没有前缀，原样返回。`preview` 已随本批加密，列表与搜索都走解密结果。
    let text = decrypt_item_field(&id, "text", row.get::<_, String>(2)?)?;
    let html = decrypt_item_field(&id, "html", row.get::<_, String>(3)?)?;
    let raw_paths: String = decrypt_item_field(&id, "file_paths", row.get(12)?)?;
    Ok(ClipboardItem {
        id: id.clone(),
        kind: row.get(1)?,
        text,
        html,
        preview: decrypt_item_field(&id, "preview", row.get(4)?)?,
        title: decrypt_item_field(&id, "title", row.get(5)?)?,
        title_source: row.get(6)?,
        byte_size: row.get(7)?,
        source_app: decrypt_item_field(&id, "source_app", row.get(8)?)?,
        source_title: decrypt_item_field(&id, "source_title", row.get(9)?)?,
        image_width: row.get::<_, Option<i64>>(10)?.map(|v| v.max(0) as u32),
        image_height: row.get::<_, Option<i64>>(11)?.map(|v| v.max(0) as u32),
        file_paths: serde_json::from_str(&raw_paths).unwrap_or_default(),
        favorite: row.get::<_, i64>(13)? != 0,
        pinned: row.get::<_, i64>(14)? != 0,
        copy_count: row.get(15)?,
        created_at: row.get(16)?,
        last_seen_at: row.get(17)?,
        has_image: row.get::<_, i64>(18)? != 0,
        has_thumb: row.get::<_, i64>(19)? != 0,
        source_kind: row.get(20)?,
    })
}

fn map_page_item(row: &Row<'_>) -> rusqlite::Result<ClipboardItem> {
    map_page_item_at(row, 0)
}

/// `offset` 用于在查询前额外选择分组 id 等列（封面查询）。
fn map_page_item_at(row: &Row<'_>, offset: usize) -> rusqlite::Result<ClipboardItem> {
    let id: String = row.get(offset)?;
    let kind: String = row.get(offset + 1)?;
    let preview: String = decrypt_item_field(&id, "preview", row.get(offset + 2)?)?;
    let raw_paths: String = decrypt_item_field(&id, "file_paths", row.get(offset + 10)?)?;
    // 分页不读正文：文本类回填 preview（与列表接口同一压缩协议）；
    // 图片的 preview 只是尺寸描述（「图片 1476×1198」），不是文字正文，
    // 写进 text 会凭空造出一条假正文。分页路径没有正文可回填，图片保持空串。
    let text = if kind == KIND_IMAGE {
        String::new()
    } else {
        preview.clone()
    };
    Ok(ClipboardItem {
        id: id.clone(),
        kind,
        text,
        html: String::new(),
        preview,
        title: decrypt_item_field(&id, "title", row.get(offset + 3)?)?,
        title_source: row.get(offset + 4)?,
        byte_size: row.get(offset + 5)?,
        source_app: decrypt_item_field(&id, "source_app", row.get(offset + 6)?)?,
        source_title: decrypt_item_field(&id, "source_title", row.get(offset + 7)?)?,
        image_width: row
            .get::<_, Option<i64>>(offset + 8)?
            .map(|v| v.max(0) as u32),
        image_height: row
            .get::<_, Option<i64>>(offset + 9)?
            .map(|v| v.max(0) as u32),
        file_paths: serde_json::from_str(&raw_paths).unwrap_or_default(),
        favorite: row.get::<_, i64>(offset + 11)? != 0,
        pinned: row.get::<_, i64>(offset + 12)? != 0,
        copy_count: row.get(offset + 13)?,
        created_at: row.get(offset + 14)?,
        last_seen_at: row.get(offset + 15)?,
        has_image: row.get::<_, i64>(offset + 16)? != 0,
        has_thumb: row.get::<_, i64>(offset + 17)? != 0,
        source_kind: row.get(offset + 18)?,
    })
}

fn map_group(row: &Row<'_>) -> rusqlite::Result<ClipboardGroup> {
    let preview_item_id: String = row.get(12)?;
    let raw_preview: String = row.get(11)?;
    let preview = if preview_item_id.is_empty() {
        raw_preview
    } else {
        decrypt_item_field(&preview_item_id, "preview", raw_preview)?
    };
    Ok(ClipboardGroup {
        id: row.get(0)?,
        name: row.get(1)?,
        mode: row.get(2)?,
        status: row.get(3)?,
        favorite: row.get::<_, i64>(4)? != 0,
        pinned: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        closed_at: row.get(8)?,
        item_count: row.get(9)?,
        image_count: row.get(10)?,
        preview,
        kind_counts: GroupKindCounts::default(),
        cover_items: Vec::new(),
        items: Vec::new(),
    })
}

/// 为分组列表批量补充类型计数与封面（两次批量查询，避免 N+1）。
///
/// 只读取轻量元数据：封面最多每组 3 张图片，且不读取正文与原图字节。
fn enrich_groups(conn: &Connection, groups: &mut [ClipboardGroup]) -> AppResult<()> {
    if groups.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = groups.iter().map(|g| g.id.clone()).collect();
    let placeholders = std::iter::repeat("?")
        .take(ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let args: Vec<Value> = ids.iter().cloned().map(Value::Text).collect();

    let mut stmt = conn.prepare(&format!(
        "SELECT gi.group_id, i.kind, COUNT(*) FROM clipboard_group_items gi
         JOIN clipboard_items i ON i.id = gi.item_id
         WHERE gi.group_id IN ({placeholders}) GROUP BY gi.group_id, i.kind"
    ))?;
    let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })?;
    let mut counts: std::collections::HashMap<String, GroupKindCounts> = Default::default();
    for r in rows {
        let (gid, kind, n) = r?;
        let entry = counts.entry(gid).or_default();
        match kind.as_str() {
            KIND_IMAGE => entry.image = n,
            "html" => entry.html = n,
            KIND_URL => entry.url = n,
            KIND_FILES => entry.files = n,
            _ => entry.text += n,
        }
    }
    for g in groups.iter_mut() {
        if let Some(c) = counts.remove(&g.id) {
            g.kind_counts = c;
        }
    }

    // 每组最多 3 张封面：窗口函数在 SQL 阶段限制，避免把大组的所有图片元数据带回来。
    // 外层显式按 group_id + position 排序：封面数组按查询返回顺序累积，
    // 不依赖 SQLite 的扫描/窗口计划恰好返回有序行。
    let mut stmt = conn.prepare(&format!(
        "SELECT x.group_id, {PAGE_ITEM_FIELDS} FROM (
           SELECT gi.group_id, gi.item_id, gi.position,
             ROW_NUMBER() OVER (PARTITION BY gi.group_id ORDER BY gi.position) AS rn
           FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
           WHERE gi.group_id IN ({placeholders}) AND i.kind = 'image'
         ) x JOIN clipboard_items i ON i.id = x.item_id
         WHERE x.rn <= 3
         ORDER BY x.group_id, x.position, x.rn"
    ))?;
    let rows = stmt.query_map(params_from_iter(args.iter()), |r| {
        Ok((r.get::<_, String>(0)?, map_page_item_at(r, 1)?))
    })?;
    let mut covers: std::collections::HashMap<String, Vec<ClipboardItem>> = Default::default();
    for r in rows {
        let (gid, item) = r?;
        covers.entry(gid).or_default().push(item);
    }
    for g in groups.iter_mut() {
        if let Some(c) = covers.remove(&g.id) {
            g.cover_items = c;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFilter {
    pub kind: Option<String>,
    pub search: Option<String>,
    pub favorite: bool,
    pub group_id: Option<String>,
    pub task_id: Option<String>,
    /// 精确匹配 `source_app`（保留原始进程标识，展示名由前端换算）。
    pub source_app: Option<String>,
    /// 最近 N 天；0/None 表示不限。用 `last_seen_at` 判定，不扫描正文。
    pub recent_days: Option<i64>,
    /// `recent`（默认，按采集/最近记录时间）或 `most_used`（按使用次数）。
    pub sort: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

fn item_filters(filter: &ClipboardFilter) -> (String, Vec<Value>) {
    let mut sql = String::from(" WHERE 1=1");
    let mut args: Vec<Value> = Vec::new();    if let Some(kind) = filter
        .kind
        .as_deref()
        .filter(|k| !k.is_empty() && *k != "all")
    {
        sql.push_str(" AND i.kind = ?");
        args.push(Value::Text(kind.into()));
    }
    if filter.favorite {
        sql.push_str(" AND i.favorite = 1");
    }
    if let Some(days) = filter.recent_days.filter(|d| *d > 0) {
        // `last_seen_at` 统一为 RFC3339；边界用与写入相同的时间格式，
        // 避免 SQLite 的 `datetime('now')`（空格分隔）与存储格式不可比。
        let cutoff = (Utc::now() - Duration::days(days.min(3650))).to_rfc3339();
        sql.push_str(" AND i.last_seen_at >= ?");
        args.push(Value::Text(cutoff));
    }
    if let Some(group) = filter.group_id.as_deref().filter(|g| !g.is_empty()) {
        sql.push_str(" AND EXISTS(SELECT 1 FROM clipboard_group_items gi WHERE gi.group_id = ? AND gi.item_id = i.id)");
        args.push(Value::Text(group.into()));
    }
    if let Some(task) = filter.task_id.as_deref().filter(|t| !t.is_empty()) {
        sql.push_str(
            " AND (EXISTS(SELECT 1 FROM clipboard_task_links lt WHERE lt.task_id = ? AND lt.target_type = 'item' AND lt.target_id = i.id)
                OR EXISTS(SELECT 1 FROM clipboard_task_links lt JOIN clipboard_group_items gi ON gi.group_id = lt.target_id
                          WHERE lt.task_id = ? AND lt.target_type = 'group' AND gi.item_id = i.id))",
        );
        args.push(Value::Text(task.into()));
        args.push(Value::Text(task.into()));
    }
    (sql, args)
}

/// 搜索/来源筛选在 SQL 侧失效（字段已加密）后，最多一次扫描的条目上限。
/// 固定 5000 条（按当前排序取最新/最常用），兼顾 50k 上限配置下的交互延迟；
/// 超出部分不参与解密搜索，该边界在 ADR §14 明确登记。
const POST_FILTER_SCAN_LIMIT: i64 = 5000;
/// 分组搜索时参与筛选的组上限（分组数量远小于条目上限）。
const GROUP_SEARCH_SCAN_LIMIT: i64 = 500;

/// 搜索与来源筛选都需要解密后才能比较；其余筛选仍由 SQL 先缩小范围。
fn has_post_filter(filter: &ClipboardFilter) -> bool {
    filter
        .search
        .as_deref()
        .map(str::trim)
        .is_some_and(|q| !q.is_empty())
        || filter
            .source_app
            .as_deref()
            .map(str::trim)
            .is_some_and(|s| !s.is_empty())
}

fn item_order(filter: &ClipboardFilter) -> &'static str {
    if filter.sort.as_deref() == Some("most_used") {
        // 置顶永远优先；其余按使用次数，同次数再用最近记录稳定排序。
        "i.pinned DESC, i.copy_count DESC, i.last_seen_at DESC"
    } else {
        "i.pinned DESC, i.last_seen_at DESC"
    }
}

/// 解密后比较：只读取分页字段（preview/title/source_*/file_paths），不加载大正文。
fn item_matches_search(item: &ClipboardItem, needle: &str) -> bool {
    let lower = needle.to_lowercase();
    item.preview.to_lowercase().contains(&lower)
        || item.title.to_lowercase().contains(&lower)
        || item.source_app.to_lowercase().contains(&lower)
        || item.source_title.to_lowercase().contains(&lower)
        || item
            .file_paths
            .iter()
            .any(|path| path.to_lowercase().contains(&lower))
}

/// 按 SQL 的既有排序读取候选页字段，再在 Rust 内解密过滤来源与搜索词。
fn scan_filtered_items(db: &Db, filter: &ClipboardFilter) -> AppResult<Vec<ClipboardItem>> {
    let mut base = filter.clone();
    base.search = None;
    base.source_app = None;
    let (where_sql, args) = item_filters(&base);
    let sql = format!(
        "SELECT {PAGE_ITEM_FIELDS} FROM clipboard_items i{where_sql}
         ORDER BY {} LIMIT {POST_FILTER_SCAN_LIMIT}",
        item_order(filter)
    );
    let mut items = db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args.iter()), map_page_item)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })?;
    if let Some(source) = filter
        .source_app
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        items.retain(|item| item.source_app.eq_ignore_ascii_case(source));
    }
    if let Some(q) = filter
        .search
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
    {
        items.retain(|item| item_matches_search(item, q));
    }
    Ok(items)
}

fn paginate_items(items: Vec<ClipboardItem>, filter: &ClipboardFilter) -> Vec<ClipboardItem> {
    let offset = filter.offset.unwrap_or(0).max(0) as usize;
    let limit = filter.limit.unwrap_or(80).clamp(1, 200) as usize;
    items.into_iter().skip(offset).take(limit).collect()
}

pub fn list_items(db: &Db, filter: &ClipboardFilter) -> AppResult<Vec<ClipboardItem>> {
    if has_post_filter(filter) {
        return Ok(paginate_items(scan_filtered_items(db, filter)?, filter));
    }
    let (where_sql, mut args) = item_filters(filter);
    let sql = format!(
        "SELECT {ITEM_FIELDS} FROM clipboard_items i{where_sql} ORDER BY {} LIMIT ? OFFSET ?",
        item_order(filter)
    );
    args.push(Value::Integer(filter.limit.unwrap_or(80).clamp(1, 200)));
    args.push(Value::Integer(filter.offset.unwrap_or(0).max(0)));
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args.iter()), map_item)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

pub fn count_items(db: &Db, filter: &ClipboardFilter) -> AppResult<i64> {
    if has_post_filter(filter) {
        return Ok(scan_filtered_items(db, filter)?.len() as i64);
    }
    let (where_sql, args) = item_filters(filter);
    let sql = format!("SELECT COUNT(*) FROM clipboard_items i{where_sql}");
    db.with_conn(|conn| {
        let n: i64 = conn.query_row(&sql, params_from_iter(args.iter()), |r| r.get(0))?;
        Ok(n)
    })
}

/// 来源应用筛选的可选项：按条目数降序，排除空来源。
///
/// Windows 进程标识大小写不稳定（`explorer.exe` / `Explorer.exe`），这里按
/// `LOWER(TRIM(source_app))` 聚合，取一个原始拼写作为展示键；筛选端用
/// `COLLATE NOCASE` 精确匹配，避免下拉出现两个同名来源。
/// 这是 `source_app` 的小型聚合查询（最多 50 项），不把整库历史拉到前端；
/// 当前没有 `source_app` 索引，但剪贴板上限为 5000 条，分组聚合成本可控。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSourceOption {
    pub app: String,
    pub count: i64,
}

pub fn list_source_apps(db: &Db, limit: i64) -> AppResult<Vec<ClipboardSourceOption>> {
    let limit = limit.clamp(1, 50);
    // source_app 已加密，无法 SQL GROUP BY：读取 id+app 后按 AAD 解密再聚合。
    // 上限与历史总量一致；空来源在解密后排除。
    let rows: Vec<(String, String)> = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, source_app FROM clipboard_items
             ORDER BY last_seen_at DESC LIMIT 5000",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })?;
    let mut grouped: std::collections::HashMap<String, (String, i64)> = Default::default();
    for (id, raw) in rows {
        let app = decrypt_item_field_app(&id, "source_app", raw)?;
        let app = app.trim();
        if app.is_empty() {
            continue;
        }
        let key = app.to_lowercase();
        grouped
            .entry(key)
            .and_modify(|(_, n)| *n += 1)
            .or_insert_with(|| (app.to_string(), 1));
    }
    let mut out: Vec<ClipboardSourceOption> = grouped
        .into_values()
        .map(|(app, count)| ClipboardSourceOption { app, count })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.app.cmp(&b.app)));
    out.truncate(limit as usize);
    Ok(out)
}

pub fn list_groups(db: &Db, filter: &ClipboardFilter) -> AppResult<Vec<ClipboardGroup>> {
    list_groups_with_scan(db, filter, None)
}

/// 分组列表；搜索时名称在 Rust 内匹配，成员条目使用已解密扫描结果，
/// 避免对密文 `preview`/`text` 执行必然失败的 SQL LIKE。
fn list_groups_with_scan(
    db: &Db,
    filter: &ClipboardFilter,
    scanned: Option<&[ClipboardItem]>,
) -> AppResult<Vec<ClipboardGroup>> {
    let search = filter
        .search
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty());
    let owned_scan = if search.is_some() && scanned.is_none() {
        Some(scan_filtered_items(db, filter)?)
    } else {
        None
    };
    let matched = scanned.or(owned_scan.as_deref());
    let mut sql = format!("SELECT {GROUP_FIELDS} FROM clipboard_groups g WHERE 1=1");
    let mut args: Vec<Value> = Vec::new();
    if filter.favorite {
        sql.push_str(" AND g.favorite = 1");
    }
    if let Some(task) = filter.task_id.as_deref().filter(|t| !t.is_empty()) {
        sql.push_str(" AND EXISTS(SELECT 1 FROM clipboard_task_links lt WHERE lt.task_id = ? AND lt.target_type = 'group' AND lt.target_id = g.id)");
        args.push(Value::Text(task.into()));
    }
    if let Some(group) = filter.group_id.as_deref().filter(|g| !g.is_empty()) {
        sql.push_str(" AND g.id = ?");
        args.push(Value::Text(group.into()));
    }
    sql.push_str(" ORDER BY g.pinned DESC, g.updated_at DESC LIMIT ?");
    args.push(Value::Integer(if search.is_some() {
        GROUP_SEARCH_SCAN_LIMIT
    } else {
        filter.limit.unwrap_or(100).clamp(1, 200)
    }));
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args.iter()), map_group)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        if let (Some(q), Some(items)) = (search, matched) {
            let needle = q.to_lowercase();
            let ids: HashSet<&str> = items.iter().map(|i| i.id.as_str()).collect();
            let mut member_of_match: HashSet<String> = HashSet::new();
            let mut stmt =
                conn.prepare("SELECT group_id, item_id FROM clipboard_group_items")?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (group_id, item_id) = row?;
                if ids.contains(item_id.as_str()) {
                    member_of_match.insert(group_id);
                }
            }
            out.retain(|g| g.name.to_lowercase().contains(&needle) || member_of_match.contains(&g.id));
            out.truncate(filter.limit.unwrap_or(100).clamp(1, 200) as usize);
        }
        enrich_groups(conn, &mut out)?;
        Ok(out)
    })
}

pub fn get_group(db: &Db, group_id: &str) -> AppResult<ClipboardGroup> {
    db.with_conn(|conn| {
        let mut group = conn
            .query_row(
                &format!("SELECT {GROUP_FIELDS} FROM clipboard_groups g WHERE g.id = ?1"),
                params![group_id],
                map_group,
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("分组不存在".into()))?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {ITEM_FIELDS} FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
             WHERE gi.group_id = ?1 ORDER BY gi.position"
        ))?;
        let rows = stmt.query_map(params![group_id], map_item)?;
        for r in rows {
            let item: ClipboardItem = r?;
            group.kind_counts.add(&item.kind);
            if item.kind == KIND_IMAGE && group.cover_items.len() < 3 {
                // 封面同样不制造假正文：只保留采集时真实存在的附带文本，
                // preview（尺寸描述）留在 preview 字段里独立保存。
                group.cover_items.push(engine::compact_item(&item));
            }
            group.items.push(item);
        }
        Ok(group)
    })
}

/// Lite 分组分页的 limit 上限与默认值（单次读取与 IPC 载荷有界）。
pub const GROUP_PAGE_MAX_LIMIT: i64 = 50;
pub const GROUP_PAGE_DEFAULT_LIMIT: i64 = 20;

/// 组内容版本（计数 + 组更新时间 + 组内最近加入/最近出现时间）。
///
/// `get_group_page` 与 `get_group_item_position` 共用同一公式，保证两个接口返回的
/// revision 不漂移（前端用 revision 对比判断「定位期间内容是否又变了」）。
/// 公式与字段顺序是前端缓存键的一部分，不得改动；只做一次有界聚合，不引入新表。
fn group_revision(
    conn: &Connection,
    group_id: &str,
    item_count: i64,
    image_count: i64,
    updated_at: &str,
) -> AppResult<String> {
    let (max_added, max_seen): (String, String) = conn.query_row(
        "SELECT COALESCE(MAX(gi.added_at), ''), COALESCE(MAX(i.last_seen_at), '')
         FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
         WHERE gi.group_id = ?1",
        params![group_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(format!(
        "{}:{}:{}:{}:{}",
        item_count, image_count, updated_at, max_added, max_seen
    ))
}

/// 有界分组分页：SQL 阶段按 `position` 排序、可选只取图片、再 LIMIT/OFFSET。
///
/// 与 `get_group` 的差异：
/// - 不读取 `text`/`html`，条目只带列表/缩略图字段；
/// - `total_count`/`image_count` 用分组聚合列，不受 LIMIT 影响；
/// - `limit` 超过 `GROUP_PAGE_MAX_LIMIT` 时截断（不报错），并返回实际生效值；
/// - 新增 `revision` 供前端按「组 + 分页 + imagesOnly + 内容版本」组成缓存键。
///
/// 兼容性：`get_group` 与整组复制（`clipboard_copy_group_rich` / `..._files` 走 `get_group`）
/// 保持原样，不受这里的 LIMIT 影响；复制路径不经过本函数。
pub fn get_group_page(
    db: &Db,
    group_id: &str,
    limit: Option<i64>,
    offset: Option<i64>,
    images_only: bool,
) -> AppResult<ClipboardGroupPage> {
    let limit = limit
        .unwrap_or(GROUP_PAGE_DEFAULT_LIMIT)
        .clamp(1, GROUP_PAGE_MAX_LIMIT);
    let offset = offset.unwrap_or(0).max(0);
    db.with_conn(|conn| {
        let group = conn
            .query_row(
                &format!("SELECT {GROUP_FIELDS} FROM clipboard_groups g WHERE g.id = ?1"),
                params![group_id],
                map_group,
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("分组不存在".into()))?;
        let mut sql = format!(
            "SELECT {PAGE_ITEM_FIELDS} FROM clipboard_group_items gi
             JOIN clipboard_items i ON i.id = gi.item_id
             WHERE gi.group_id = ?1"
        );
        if images_only {
            sql.push_str(" AND i.kind = 'image'");
        }
        // 顺序与 get_group 完全一致，分页不得打乱组内位置。
        sql.push_str(" ORDER BY gi.position LIMIT ?2 OFFSET ?3");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![group_id, limit, offset], map_page_item)?;
        let mut items = Vec::with_capacity(limit as usize);
        for r in rows {
            items.push(r?);
        }
        // 版本号：与 get_group_item_position 共用同一公式，避免两处 revision 漂移。
        let revision = group_revision(
            conn,
            group_id,
            group.item_count,
            group.image_count,
            &group.updated_at,
        )?;
        Ok(ClipboardGroupPage {
            group_id: group.id.clone(),
            items,
            total_count: group.item_count,
            image_count: group.image_count,
            offset,
            limit,
            revision,
        })
    })
}

/// 组内条目定位：返回指定条目在组内「图片条目」中的 0-based 序位。
///
/// 供 Lite 原图预览在组内容变化后按图片 ID 恢复身份（而不是按旧序号回退显示另一张图）：
/// - 组不存在 → `AppError::NotFound`，与 `get_group_page` 一致（前端据此退出预览）；
/// - 条目不在组内或不是图片 → `found=false, index=None`，不报错；
/// - 定位只做两条有界查询（序位 + 前序图片计数），不加载整组；
/// - `revision` 与 `get_group_page` 共用同一公式。
pub fn get_group_item_position(
    db: &Db,
    group_id: &str,
    item_id: &str,
) -> AppResult<ClipboardGroupItemPosition> {
    db.with_conn(|conn| {
        let group = conn
            .query_row(
                &format!("SELECT {GROUP_FIELDS} FROM clipboard_groups g WHERE g.id = ?1"),
                params![group_id],
                map_group,
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("分组不存在".into()))?;
        // 该条目在组内的 position；kind='image' 过滤保证只对图片条目给出序位。
        let position: Option<i64> = conn
            .query_row(
                "SELECT gi.position FROM clipboard_group_items gi
                 JOIN clipboard_items i ON i.id = gi.item_id
                 WHERE gi.group_id = ?1 AND gi.item_id = ?2 AND i.kind = 'image'",
                params![group_id, item_id],
                |r| r.get(0),
            )
            .optional()?;
        let index = match position {
            // 图片序位 = 组内排在它前面的图片条目数，与 get_group_page 的
            // imagesOnly 过滤 + position 排序完全一致。
            Some(pos) => {
                let before: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM clipboard_group_items gj
                     JOIN clipboard_items j ON j.id = gj.item_id
                     WHERE gj.group_id = ?1 AND j.kind = 'image' AND gj.position < ?2",
                    params![group_id, pos],
                    |r| r.get(0),
                )?;
                Some(before)
            }
            None => None,
        };
        let revision = group_revision(
            conn,
            group_id,
            group.item_count,
            group.image_count,
            &group.updated_at,
        )?;
        Ok(ClipboardGroupItemPosition {
            found: index.is_some(),
            index,
            image_count: group.image_count,
            total_count: group.item_count,
            revision,
        })
    })
}

pub fn get_item(db: &Db, item_id: &str) -> AppResult<ClipboardItem> {
    db.with_conn(|conn| {
        conn.query_row(
            &format!("SELECT {ITEM_FIELDS} FROM clipboard_items i WHERE i.id = ?1"),
            params![item_id],
            map_item,
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("剪贴板条目不存在".into()))
    })
}

pub fn stats(db: &Db, settings: &Settings) -> AppResult<ClipboardStats> {
    db.with_conn(|conn| {
        let (items, images, files, favorites, bytes): (i64, i64, i64, i64, i64) = conn.query_row(
            "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN kind = 'image' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN kind = 'files' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(favorite), 0),
                COALESCE(SUM(byte_size), 0)
             FROM clipboard_items",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
        let groups: i64 =
            conn.query_row("SELECT COUNT(*) FROM clipboard_groups", [], |r| r.get(0))?;
        let asset_bytes: i64 = conn.query_row(
            "SELECT COALESCE(SUM(byte_size), 0) FROM clipboard_assets",
            [],
            |r| r.get(0),
        )?;
        Ok(ClipboardStats {
            items,
            groups,
            images,
            files,
            favorites,
            bytes,
            asset_bytes,
            max_items: settings.clipboard_max_items as i64,
            max_storage_bytes: settings.clipboard_max_storage_mb as i64 * 1024 * 1024,
            enabled: settings.clipboard_enabled,
            paused: settings.clipboard_paused,
            auto_group: settings.clipboard_auto_group,
        })
    })
}

pub fn view(db: &Db, filter: &ClipboardFilter, settings: &Settings) -> AppResult<ClipboardView> {
    // 搜索/来源筛选只能解密后比较：一次扫描同时供条目分页、总数与分组搜索，
    // 避免同一请求重复扫描、重复解密。
    let scanned = if has_post_filter(filter) {
        Some(scan_filtered_items(db, filter)?)
    } else {
        None
    };
    let total_items = match &scanned {
        Some(items) => items.len() as i64,
        None => count_items(db, filter)?,
    };
    let groups = list_groups_with_scan(db, filter, scanned.as_deref())?;
    let items = match scanned {
        Some(items) => paginate_items(items, filter),
        None => list_items(db, filter)?,
    };
    Ok(ClipboardView {
        items,
        groups,
        stats: stats(db, settings)?,
        total_items,
    })
}

// ── 资产文件 ────────────────────────────────────────────────

fn safe_rel(rel: &str) -> AppResult<&Path> {
    let p = Path::new(rel);
    if p.is_absolute() {
        return Err(AppError::Validation("资产路径不得为绝对路径".into()));
    }
    for c in p.components() {
        match c {
            Component::Normal(_) => {}
            _ => return Err(AppError::Validation("资产路径包含非法片段".into())),
        }
    }
    Ok(p)
}

pub fn asset_abs(root: &Path, rel: &str) -> AppResult<PathBuf> {
    Ok(root.join(safe_rel(rel)?))
}

struct AssetFile {
    id: String,
    role: &'static str,
    rel: String,
    size: i64,
    width: Option<i64>,
    height: Option<i64>,
}

fn write_assets(
    root: &Path,
    item_id: &str,
    img: &super::CapturedImage,
    cipher: Option<&[u8; 32]>,
) -> AppResult<Vec<AssetFile>> {
    let dir_img = root.join("images");
    let dir_thumb = root.join("thumbs");
    std::fs::create_dir_all(&dir_img)?;
    std::fs::create_dir_all(&dir_thumb)?;
    // 超大条目为守住内存预算不携带解码像素；像素缺失或与尺寸不符时按 png 重新解码，
    // 保证缩略图与入库原图来自同一份像素。
    let need = img.width as usize * img.height as usize * 4;
    let decoded;
    let (rgba, width, height) = if img.rgba.len() < need {
        let (r, w, h) = image::decode_png_rgba(&img.png)?;
        decoded = (r, w, h);
        (&decoded.0, decoded.1, decoded.2)
    } else {
        (&img.rgba, img.width, img.height)
    };
    let (thumb_rgba, tw, th) = image::thumbnail(rgba, width, height);
    let thumb_png = image::encode_png(&thumb_rgba, tw, th)?;

    // 资产静态加密（ADR-0012 批次 2）：开启后原图/缩略图以容器密文落盘，
    // 文件名与 `clipboard_assets.path` 布局不变，读取侧按魔数识别并解密。
    let (stored_img, stored_thumb) = match cipher {
        Some(cek) => (
            secure::encrypt_bytes(cek, &secure::item_asset_aad(item_id, "image"), &img.png)?,
            secure::encrypt_bytes(cek, &secure::item_asset_aad(item_id, "thumb"), &thumb_png)?,
        ),
        None => (img.png.clone(), thumb_png.clone()),
    };

    let rel_img = format!("images/{item_id}.png");
    let rel_thumb = format!("thumbs/{item_id}.png");
    let abs_img = root.join(&rel_img);
    let abs_thumb = root.join(&rel_thumb);
    let write = |path: &Path, bytes: &[u8]| -> AppResult<()> {
        let tmp = path.with_extension("png.tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, path).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })?;
        Ok(())
    };
    if let Err(e) = write(&abs_img, &stored_img).and_then(|_| write(&abs_thumb, &stored_thumb)) {
        let _ = std::fs::remove_file(&abs_img);
        let _ = std::fs::remove_file(&abs_thumb);
        return Err(e);
    }
    Ok(vec![
        AssetFile {
            id: uuid::Uuid::new_v4().to_string(),
            role: "image",
            rel: rel_img,
            // 记录实际落盘字节，容量统计与磁盘事实一致（密文比明文多 28 字节头）。
            size: stored_img.len() as i64,
            width: Some(img.width as i64),
            height: Some(img.height as i64),
        },
        AssetFile {
            id: uuid::Uuid::new_v4().to_string(),
            role: "thumb",
            rel: rel_thumb,
            size: stored_thumb.len() as i64,
            width: Some(tw as i64),
            height: Some(th as i64),
        },
    ])
}

fn trim_utf8(mut s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut cut = max;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
    s.push('…');
    s
}

fn normalize(payload: &CapturedContent) -> CapturedContent {
    let mut p = payload.clone();
    p.text = trim_utf8(p.text, MAX_TEXT_BYTES);
    // 采集侧只做长度截断，不改写 HTML 原文。
    // 预览安全由渲染层白名单保证（HtmlReader 不渲染主动内容、不发起任何资源请求），
    // 复制要还原用户原本复制到的格式；采集时的一次性正则清洗既不是可靠的安全边界，
    // 又会把原文改坏（Word/浏览器富文本的 <style> 块会被整段删除）。
    p.html = trim_utf8(p.html, MAX_HTML_BYTES);
    // 摘要只需要「可读文本视图」：用净化副本派生，避免 script/style 正文混进预览。
    let plain_html = engine::sanitize_html(&p.html);
    p.preview = engine::make_preview(
        &p.kind,
        &p.text,
        &plain_html,
        &p.file_paths,
        p.image.as_ref().map(|i| i.width),
        p.image.as_ref().map(|i| i.height),
    );
    p.byte_size = match p.kind.as_str() {
        KIND_IMAGE => p.image.as_ref().map(|i| i.png.len() as i64).unwrap_or(0),
        KIND_FILES => {
            let mut total: u64 = 0;
            for f in &p.file_paths {
                if let Ok(m) = std::fs::metadata(f) {
                    if m.is_file() {
                        total = total.saturating_add(m.len());
                    }
                }
            }
            total.min(i64::MAX as u64) as i64
        }
        _ => (p.text.len() + p.html.len()) as i64,
    };
    p
}

/// 应用名是否是可用于覆盖旧值的“已识别来源”。
/// 空串与 `unknown` 都表示没有识别到，不能覆盖可信来源。
pub(crate) fn source_app_is_known(app: &str) -> bool {
    let app = app.trim();
    !app.is_empty() && !app.eq_ignore_ascii_case("unknown")
}

/// 识别方式是否是有效快照：只有 `owner`（系统记录的剪贴板所有者）与
/// `foreground`（前台窗口推断）能作为来源写入；`unknown`/空串不构成一次可信采集。
pub(crate) fn source_kind_is_known(kind: &str) -> bool {
    matches!(kind.trim(), "owner" | "foreground")
}

/// 重复内容再次采集时如何更新来源三字段。
///
/// `source_app` / `source_title` / `source_kind` 是**同一次采集的完整快照**：
/// - 新快照可识别（应用已识别且识别方式有效）→ 三字段全部替换为新采集的值，
///   新标题为空时也写入空串，绝不保留与新应用无关的旧标题；
/// - 新快照不可识别（空串或 `unknown`，或识别方式缺失）→ 整体保留旧快照，
///   不用 `unknown` 覆盖已识别应用，也不拼出“新应用 + 旧标题”的混合来源。
pub(crate) fn reconcile_source_snapshot(
    prev: (&str, &str, &str),
    next: (&str, &str, &str),
) -> (String, String, String) {
    let (new_app, new_title, new_kind) = next;
    if source_app_is_known(new_app) && source_kind_is_known(new_kind) {
        return (
            new_app.to_string(),
            new_title.to_string(),
            new_kind.to_string(),
        );
    }
    (prev.0.to_string(), prev.1.to_string(), prev.2.to_string())
}

fn find_by_hash(db: &Db, hash: &str) -> AppResult<Option<ClipboardItem>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                &format!("SELECT {ITEM_FIELDS} FROM clipboard_items i WHERE i.content_hash = ?1"),
                params![hash],
                map_item,
            )
            .optional()?)
    })
}

struct OpenGroup {
    id: String,
    family: CollectFamily,
    has_image: bool,
    last_at: Option<DateTime<Utc>>,
    item_count: usize,
    last_source_app: Option<String>,
    last_source_known: bool,
    last_image_source_app: Option<String>,
    last_image_source_known: bool,
    name_source: String,
}

/// 当前收集中的自动分组：家族、最后一条内容（任意类型）时间与来源、组内条数。
fn open_group(conn: &Connection) -> AppResult<Option<OpenGroup>> {
    let row: Option<(
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
    )> = conn
        .query_row(
            "SELECT g.id,
                (SELECT i.created_at FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
                 WHERE gi.group_id = g.id ORDER BY gi.position DESC LIMIT 1) AS last_at,
                (SELECT i.kind FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
                 WHERE gi.group_id = g.id ORDER BY gi.position DESC LIMIT 1) AS last_kind,
                (SELECT i.source_app FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
                 WHERE gi.group_id = g.id ORDER BY gi.position DESC LIMIT 1) AS last_source,
                (SELECT i.id FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
                 WHERE gi.group_id = g.id ORDER BY gi.position DESC LIMIT 1) AS last_source_id,
                (SELECT COUNT(*) FROM clipboard_group_items gi WHERE gi.group_id = g.id) AS cnt,
                (SELECT i.source_app FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
                 WHERE gi.group_id = g.id AND i.kind = 'image' ORDER BY gi.position DESC LIMIT 1) AS image_source,
                (SELECT i.id FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
                 WHERE gi.group_id = g.id AND i.kind = 'image' ORDER BY gi.position DESC LIMIT 1) AS image_source_id,
                (SELECT i.source_kind FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
                 WHERE gi.group_id = g.id ORDER BY gi.position DESC LIMIT 1) AS last_source_kind,
                (SELECT i.source_kind FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
                 WHERE gi.group_id = g.id AND i.kind = 'image' ORDER BY gi.position DESC LIMIT 1) AS image_source_kind,
                g.name_source
             FROM clipboard_groups g WHERE g.status = 'collecting'
             ORDER BY g.updated_at DESC LIMIT 1",
            [],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                ))
            },
        )
        .optional()?;
    let Some((
        id,
        last_at,
        last_kind,
        last_source,
        last_source_id,
        cnt,
        image_source,
        image_source_id,
        last_source_kind,
        image_source_kind,
        name_source,
    )) = row
    else {
        return Ok(None);
    };
    let last_source = match (last_source_id.as_deref(), last_source) {
        (Some(item_id), Some(raw)) => {
            Some(decrypt_item_field_app(item_id, "source_app", raw)?)
        }
        _ => None,
    };
    let image_source = match (image_source_id.as_deref(), image_source) {
        (Some(item_id), Some(raw)) => {
            Some(decrypt_item_field_app(item_id, "source_app", raw)?)
        }
        _ => None,
    };
    let last_family = last_kind
        .as_deref()
        .map(CollectFamily::of_kind)
        .unwrap_or(CollectFamily::Text);
    let has_image = image_source.is_some();
    // 家族按「组内是否已有该类内容」判定，用于命名与兼容比较；图片优先，
    // 其次文件，再次文本，最后链接。
    let family_sql: (bool, bool) = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
                    WHERE gi.group_id = ?1 AND i.kind IN ('text','html')),
                EXISTS(SELECT 1 FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
                    WHERE gi.group_id = ?1 AND i.kind = 'files')",
        params![id],
        |r| Ok((r.get::<_, i64>(0)? != 0, r.get::<_, i64>(1)? != 0)),
    )?;
    let family = if has_image {
        CollectFamily::Image
    } else if family_sql.1 {
        CollectFamily::File
    } else if family_sql.0 {
        CollectFamily::Text
    } else if last_family == CollectFamily::Text {
        CollectFamily::Link
    } else {
        last_family
    };
    Ok(Some(OpenGroup {
        id,
        family,
        has_image,
        last_at: last_at.as_deref().and_then(parse_iso),
        item_count: cnt.max(0) as usize,
        last_source_known: source_app_is_known(last_source.as_deref().unwrap_or(""))
            && source_kind_is_known(last_source_kind.as_deref().unwrap_or("")),
        last_source_app: last_source,
        last_image_source_known: source_app_is_known(image_source.as_deref().unwrap_or(""))
            && source_kind_is_known(image_source_kind.as_deref().unwrap_or("")),
        last_image_source_app: image_source,
        name_source,
    }))
}

fn parse_iso(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// 时间兜底命名的组在关闭收集时补上数量；用户改名的组（manual）不参与。
fn finalize_auto_group_name(conn: &Connection, group_id: &str) -> AppResult<()> {
    let name: Option<(String, String)> = conn
        .query_row(
            "SELECT name, name_source FROM clipboard_groups WHERE id = ?1",
            params![group_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((name, source)) = name else {
        return Ok(());
    };
    if source != "auto_time" {
        return Ok(());
    }
    let (images, files, total): (i64, i64, i64) = conn.query_row(
        "SELECT
           COALESCE(SUM(CASE WHEN i.kind = 'image' THEN 1 ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN i.kind = 'files' THEN 1 ELSE 0 END), 0),
           COUNT(*)
         FROM clipboard_group_items gi JOIN clipboard_items i ON i.id = gi.item_id
         WHERE gi.group_id = ?1",
        params![group_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    // 数量单位随内容类型变化：截图组「张」、文件组「个文件」、其余「项」。
    let (count, unit) = if images > 0 {
        (images, "张")
    } else if files > 0 {
        (files, "个文件")
    } else {
        (total, "项")
    };
    let count = count.max(0) as usize;
    if count == 0 {
        return Ok(());
    }
    let finalized = engine::finalize_time_group_name(&name, count, unit);
    conn.execute(
        "UPDATE clipboard_groups SET name = ?1, updated_at = ?2 WHERE id = ?3 AND name_source = 'auto_time'",
        params![finalized, crate::agents::now_iso(), group_id],
    )?;
    Ok(())
}

fn close_group_conn(conn: &Connection, group_id: &str) -> AppResult<()> {
    let now = crate::agents::now_iso();
    finalize_auto_group_name(conn, group_id)?;
    conn.execute(
        "UPDATE clipboard_groups SET status = 'closed', closed_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'collecting'",
        params![now, group_id],
    )?;
    Ok(())
}

fn close_all_collecting(conn: &Connection) -> AppResult<()> {
    let now = crate::agents::now_iso();
    let ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM clipboard_groups WHERE status = 'collecting' AND name_source = 'auto_time'",
        )?;
        let mapped = stmt.query_map([], |r| r.get::<_, String>(0))?;
        mapped.collect::<Result<Vec<_>, _>>()?
    };
    for id in ids {
        finalize_auto_group_name(conn, &id)?;
    }
    conn.execute(
        "UPDATE clipboard_groups SET status = 'closed', closed_at = ?1, updated_at = ?1 WHERE status = 'collecting'",
        params![now],
    )?;
    Ok(())
}

// ── 连续收集候选（轻量元数据，不持有正文/图片）────────────────

const CANDIDATE_KEY: &str = "clipboard_group_candidate";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CandidateRow {
    item_id: String,
    /// image | text | link | file
    family: String,
    at: String,
    source_app: String,
    source_known: bool,
    /// 写入候选的进程标识：重启后旧候选不再续用。
    boot: String,
}

/// 进程级启动标识：跨重启的候选一律失效（与自动收集会话重启后关闭保持一致）。
fn boot_id() -> &'static str {
    static BOOT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    BOOT.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

fn family_code(family: CollectFamily) -> &'static str {
    match family {
        CollectFamily::Image => "image",
        CollectFamily::Text => "text",
        CollectFamily::Link => "link",
        CollectFamily::File => "file",
    }
}

fn family_from_code(code: &str) -> CollectFamily {
    match code {
        "image" => CollectFamily::Image,
        "link" => CollectFamily::Link,
        "file" => CollectFamily::File,
        _ => CollectFamily::Text,
    }
}

fn read_candidate(conn: &Connection) -> AppResult<Option<CandidateRow>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM application_settings WHERE key = ?1",
            params![CANDIDATE_KEY],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw.and_then(|s| serde_json::from_str::<CandidateRow>(&s).ok()))
}

fn clear_candidate(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "DELETE FROM application_settings WHERE key = ?1",
        params![CANDIDATE_KEY],
    )?;
    Ok(())
}

/// 读取可用候选：启动标识不匹配、条目已删除时自动清理。
fn load_candidate(conn: &Connection) -> AppResult<Option<CandidateRow>> {
    let Some(row) = read_candidate(conn)? else {
        return Ok(None);
    };
    if row.boot != boot_id() {
        clear_candidate(conn)?;
        return Ok(None);
    }
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM clipboard_items WHERE id = ?1)",
        params![row.item_id],
        |r| Ok(r.get::<_, i64>(0)? != 0),
    )?;
    if !exists {
        clear_candidate(conn)?;
        return Ok(None);
    }
    Ok(Some(row))
}

fn save_candidate(
    conn: &Connection,
    item_id: &str,
    family: CollectFamily,
    at: &str,
    source_app: &str,
    source_known: bool,
) -> AppResult<()> {
    let row = CandidateRow {
        item_id: item_id.to_string(),
        family: family_code(family).to_string(),
        at: at.to_string(),
        source_app: source_app.to_string(),
        source_known,
        boot: boot_id().to_string(),
    };
    conn.execute(
        "INSERT INTO application_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![
            CANDIDATE_KEY,
            serde_json::to_string(&row)?,
            crate::agents::now_iso()
        ],
    )?;
    Ok(())
}

/// 候选条目是否已被归入任意分组（手动整理过就不要再并入自动组）。
fn item_grouped(conn: &Connection, item_id: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM clipboard_group_items WHERE item_id = ?1)",
        params![item_id],
        |r| Ok(r.get::<_, i64>(0)? != 0),
    )?)
}

/// 候选条目中最可靠的来源主题（自动标题优先，其次来源窗口标题、摘要）。
fn candidate_topic(conn: &Connection, item_id: &str) -> AppResult<Option<String>> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT title, source_title, preview FROM clipboard_items WHERE id = ?1",
            params![item_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((title, source_title, preview)) = row else {
        return Ok(None);
    };
    // 三个字段都按条目 AAD 解密；任一解不开即失败，不能静默用兜底标题掩盖密钥问题。
    let decoded = [
        (title, "title"),
        (source_title, "source_title"),
        (preview, "preview"),
    ]
    .into_iter()
    .map(|(value, field)| secure::decrypt_if_encrypted(&secure::item_field_aad(item_id, field), &value))
    .collect::<AppResult<Vec<_>>>()?;
    Ok(decoded.into_iter().find_map(|s| engine::group_topic(&s)))
}

/// 两个内容家族合成一个组时的命名家族：图片优先，其次文件、链接、文本。
fn name_family(first: CollectFamily, second: CollectFamily) -> CollectFamily {
    if first == CollectFamily::Image || second == CollectFamily::Image {
        CollectFamily::Image
    } else if first == CollectFamily::File || second == CollectFamily::File {
        CollectFamily::File
    } else if first == CollectFamily::Link && second == CollectFamily::Link {
        CollectFamily::Link
    } else {
        CollectFamily::Text
    }
}

fn next_group_seq(conn: &Connection) -> AppResult<i64> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM application_settings WHERE key = 'clipboard_group_seq'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let n = raw
        .and_then(|s| serde_json::from_str::<i64>(&s).ok())
        .unwrap_or(0)
        + 1;
    let now = crate::agents::now_iso();
    conn.execute(
        "INSERT INTO application_settings (key, value, updated_at) VALUES ('clipboard_group_seq', ?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![serde_json::to_string(&n)?, now],
    )?;
    Ok(n)
}

fn create_group_row(
    conn: &Connection,
    name: &str,
    name_source: &str,
    mode: &str,
    status: &str,
    now: &str,
) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO clipboard_groups (id, name, name_source, mode, status, favorite, pinned, created_at, updated_at, closed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6, ?6, ?7)",
        params![
            id,
            name,
            name_source,
            mode,
            status,
            now,
            if status == "closed" { Some(now) } else { None }
        ],
    )?;
    Ok(id)
}

fn append_group_item(
    conn: &Connection,
    group_id: &str,
    item_id: &str,
    origin: &str,
    now: &str,
) -> AppResult<bool> {
    let pos: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM clipboard_group_items WHERE group_id = ?1",
        params![group_id],
        |r| r.get(0),
    )?;
    let n = conn.execute(
        "INSERT OR IGNORE INTO clipboard_group_items (group_id, item_id, position, origin, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![group_id, item_id, pos, origin, now],
    )?;
    if n > 0 {
        conn.execute(
            "UPDATE clipboard_groups SET updated_at = ?1 WHERE id = ?2",
            params![now, group_id],
        )?;
    }
    Ok(n > 0)
}

/// 记录一次剪贴板变化：去重 → 落盘 → 入库 → 自动分组。
pub fn record_capture(
    db: &Db,
    root: &Path,
    payload: &CapturedContent,
    settings: &Settings,
) -> AppResult<CaptureOutcome> {
    let p = normalize(payload);
    if p.kind.is_empty() {
        return Err(AppError::Validation("剪贴板内容类型无效".into()));
    }
    let hash = engine::hash_of(&p);
    if let Some(existing) = find_by_hash(db, &hash)? {
        // 来源三字段作为一个整体决定是否替换，不能各字段独立 CASE：
        // 否则一次“新应用 + 空标题”的采集会把旧标题留在新应用上。
        let (source_app, source_title, source_kind) = reconcile_source_snapshot(
            (
                &existing.source_app,
                &existing.source_title,
                &existing.source_kind,
            ),
            (&p.source_app, &p.source_title, &p.source_kind),
        );
        let stored_source_app = secure::encrypt_for_write(
            db,
            settings.clipboard_encrypt_history,
            &secure::item_field_aad(&existing.id, "source_app"),
            &source_app,
        )?;
        let stored_source_title = secure::encrypt_for_write(
            db,
            settings.clipboard_encrypt_history,
            &secure::item_field_aad(&existing.id, "source_title"),
            &source_title,
        )?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE clipboard_items SET copy_count = copy_count + 1, last_seen_at = ?1,
                    source_app = ?2, source_title = ?3, source_kind = ?4
                 WHERE id = ?5",
                params![
                    crate::agents::now_iso(),
                    stored_source_app,
                    stored_source_title,
                    source_kind,
                    existing.id
                ],
            )?;
            Ok(())
        })?;
        let item = get_item(db, &existing.id)?;
        return Ok(CaptureOutcome {
            item,
            created: false,
            group_id: None,
            skipped_reason: None,
        });
    }

    let item_id = uuid::Uuid::new_v4().to_string();
    // 资产加密开关与正文字段共用同一开关：CEK 只解封装一次，图像写入与正文入库
    // 使用同一把密钥，避免出现“正文密文、图片明文”的半套状态。
    let asset_key = if settings.clipboard_encrypt_history {
        Some(secure::cek(db)?)
    } else {
        None
    };
    let assets = match &p.image {
        Some(img) => Some(write_assets(
            root,
            &item_id,
            img,
            asset_key.as_ref().map(|k| &**k),
        )?),
        None => None,
    };
    let now = Utc::now();
    let now_iso = now.to_rfc3339();
    let file_paths_json = serde_json::to_string(&p.file_paths)?;
    // 标题在入库前一次性生成（worker 线程内，不在 Win32 回调/UI 路径）；
    // 输入已受 MAX_TEXT_BYTES / MAX_HTML_BYTES 限制，规则本身 O(行数)。
    // 标题与摘要同源：只从净化后的文本视图取，script/style 正文不参与命名。
    let title = engine::make_title(
        &p.kind,
        &p.text,
        &engine::sanitize_html(&p.html),
        &p.file_paths,
        p.image.as_ref().map(|i| i.width),
        p.image.as_ref().map(|i| i.height),
    );

    // 正文入库前加密（ADR-0012）：开关开启时缺信封会创建 CEK，失败直接返回错误，
    // 绝不降级为明文落库。`preview`/`title`/`source_*`/`file_paths` 使用同一开关与 CEK，
    // 搜索改为解密后过滤，不再依赖 SQL LIKE 命中密文。
    let stored_text = secure::encrypt_for_write(
        db,
        settings.clipboard_encrypt_history,
        &secure::item_field_aad(&item_id, "text"),
        &p.text,
    )?;
    let stored_html = secure::encrypt_for_write(
        db,
        settings.clipboard_encrypt_history,
        &secure::item_field_aad(&item_id, "html"),
        &p.html,
    )?;
    // 元数据与正文共用同一开关与 CEK：preview/title/source_*/file_paths 全量加密。
    let stored_preview = secure::encrypt_for_write(
        db,
        settings.clipboard_encrypt_history,
        &secure::item_field_aad(&item_id, "preview"),
        &p.preview,
    )?;
    let stored_title = secure::encrypt_for_write(
        db,
        settings.clipboard_encrypt_history,
        &secure::item_field_aad(&item_id, "title"),
        &title,
    )?;
    let stored_source_app = secure::encrypt_for_write(
        db,
        settings.clipboard_encrypt_history,
        &secure::item_field_aad(&item_id, "source_app"),
        &p.source_app,
    )?;
    let stored_source_title = secure::encrypt_for_write(
        db,
        settings.clipboard_encrypt_history,
        &secure::item_field_aad(&item_id, "source_title"),
        &p.source_title,
    )?;
    let stored_paths = secure::encrypt_for_write(
        db,
        settings.clipboard_encrypt_history,
        &secure::item_field_aad(&item_id, "file_paths"),
        &file_paths_json,
    )?;

    let result = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        // 文件已落盘；若此处唯一约束冲突（极端并发），回滚后按重复处理
        let insert = tx.execute(
            "INSERT INTO clipboard_items
             (id, kind, text, html, preview, title, title_source, content_hash, byte_size, source_app, source_title,
              image_width, image_height, file_paths, favorite, pinned, copy_count, created_at, last_seen_at, source_kind)
             VALUES (?1,?2,?3,?4,?5,?6,'auto',?7,?8,?9,?10,?11,?12,?13,0,0,1,?14,?14,?15)",
            params![
                item_id,
                p.kind,
                stored_text,
                stored_html,
                stored_preview,
                stored_title,
                hash,
                p.byte_size,
                stored_source_app,
                stored_source_title,
                p.image.as_ref().map(|i| i.width as i64),
                p.image.as_ref().map(|i| i.height as i64),
                stored_paths,
                now_iso,
                p.source_kind
            ],
        );
        if let Err(e) = insert {
            let _ = tx.rollback();
            return Err(AppError::from(e));
        }
        if let Some(assets) = &assets {
            for a in assets {
                tx.execute(
                    "INSERT INTO clipboard_assets (id, item_id, role, path, byte_size, width, height, created_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![a.id, item_id, a.role, a.rel, a.size, a.width, a.height, now_iso],
                )?;
            }
        }

        let open = open_group(&tx)?;
        let candidate = load_candidate(&tx)?;
        let candidate_at = candidate.as_ref().and_then(|c| parse_iso(&c.at));
        let source_known =
            source_app_is_known(&p.source_app) && source_kind_is_known(&p.source_kind);
        let action = {
            let session = open.as_ref().map(|o| GroupSession {
                family: o.family,
                has_image: o.has_image,
                last_at: o.last_at,
                item_count: o.item_count,
                last_source_app: o.last_source_app.as_deref(),
                last_source_known: o.last_source_known,
                last_image_source_app: o.last_image_source_app.as_deref(),
                last_image_source_known: o.last_image_source_known,
                name_source: &o.name_source,
            });
            let candidate_view = candidate.as_ref().zip(candidate_at).map(|(c, at)| GroupCandidate {
                item_id: &c.item_id,
                family: family_from_code(&c.family),
                at,
                source_app: &c.source_app,
                source_known: c.source_known,
            });
            engine::decide_group(
                &p.kind,
                settings.clipboard_auto_group,
                now,
                settings.clipboard_group_window_secs as i64,
                session.as_ref(),
                candidate_view.as_ref(),
                &p.source_app,
                source_known,
            )
        };
        let window = Duration::seconds(settings.clipboard_group_window_secs.max(1) as i64);
        let session_stale = open
            .as_ref()
            .map(|o| {
                o.item_count >= MAX_AUTO_GROUP_ITEMS
                    || o.last_at.map(|t| now - t > window).unwrap_or(true)
            })
            .unwrap_or(false);
        let item_family = CollectFamily::of_kind(&p.kind);
        let group_id = match action {
            GroupAction::Append => {
                if let Some(o) = open.as_ref() {
                    append_group_item(&tx, &o.id, &item_id, "auto", &now_iso)?;
                    // 关联文本主题只在时间兜底组上生效：可靠来源标题优先，
                    // 用户手动改名（manual）永不自动覆盖。
                    if o.name_source == "auto_time"
                        && !matches!(p.kind.as_str(), KIND_IMAGE | KIND_FILES)
                    {
                        let topic_src = if p.text.trim().is_empty() { &p.preview } else { &p.text };
                        if let Some(topic) = engine::group_topic(topic_src) {
                            let name = engine::topic_group_name(o.family, &topic);
                            tx.execute(
                                "UPDATE clipboard_groups SET name = ?1, name_source = 'auto_source', updated_at = ?2
                                 WHERE id = ?3 AND name_source = 'auto_time'",
                                params![name, now_iso, o.id],
                            )?;
                        }
                    }
                    clear_candidate(&tx)?;
                    Some(o.id.clone())
                } else {
                    None
                }
            }
            GroupAction::CreateWithCandidate => {
                // 候选条目可能已被手动整理或删除：不再并入自动组。
                let candidate_ok = match candidate.as_ref() {
                    Some(c) => !item_grouped(&tx, &c.item_id)? && candidate_at.is_some(),
                    None => false,
                };
                if candidate_ok {
                    close_all_collecting(&tx)?;
                    let cand = candidate.as_ref().expect("candidate checked");
                    let first_family = family_from_code(&cand.family);
                    let topic = candidate_topic(&tx, &cand.item_id)?;
                    let _seq = next_group_seq(&tx)?;
                    let (name, name_source) = engine::auto_group_name(
                        name_family(first_family, item_family),
                        topic.as_deref(),
                        &engine::local_time_label(),
                    );
                    let gid =
                        create_group_row(&tx, &name, name_source, "auto", "collecting", &now_iso)?;
                    append_group_item(&tx, &gid, &cand.item_id, "auto", &now_iso)?;
                    append_group_item(&tx, &gid, &item_id, "auto", &now_iso)?;
                    clear_candidate(&tx)?;
                    Some(gid)
                } else {
                    clear_candidate(&tx)?;
                    save_candidate(
                        &tx,
                        &item_id,
                        item_family,
                        &now_iso,
                        &p.source_app,
                        source_known,
                    )?;
                    None
                }
            }
            GroupAction::Candidate => {
                // 不能并入：结束已满额/过期的收集会话，当前条目成为新候选。
                if session_stale {
                    if let Some(o) = open.as_ref() {
                        close_group_conn(&tx, &o.id)?;
                    }
                }
                save_candidate(
                    &tx,
                    &item_id,
                    item_family,
                    &now_iso,
                    &p.source_app,
                    source_known,
                )?;
                None
            }
            GroupAction::None => {
                if session_stale {
                    if let Some(o) = open.as_ref() {
                        close_group_conn(&tx, &o.id)?;
                    }
                }
                // 自动分组关闭时不保留候选。
                clear_candidate(&tx)?;
                None
            }
        };
        tx.commit()?;
        Ok(group_id)
    });

    let group_id = match result {
        Ok(g) => g,
        Err(e) => {
            if let Some(assets) = &assets {
                for a in assets {
                    if let Ok(abs) = asset_abs(root, &a.rel) {
                        let _ = std::fs::remove_file(abs);
                    }
                }
            }
            return Err(e);
        }
    };
    Ok(CaptureOutcome {
        item: get_item(db, &item_id)?,
        created: true,
        group_id,
        skipped_reason: None,
    })
}

// ── 编辑操作 ────────────────────────────────────────────────

/// 记录一次显式复制（使用次数）。
///
/// 只累加 `copy_count`，**不更新 `last_seen_at`**：列表按 `last_seen_at` 排序，
/// 复制旧条目若同时刷新时间，会让它立刻跳到列表顶部，用户正在浏览的位置随之丢失。
/// 「最近采集时间」只应由 `record_capture`（真实剪贴板事件）推进。
pub fn bump_copy(db: &Db, item_id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE clipboard_items SET copy_count = copy_count + 1 WHERE id = ?1",
            params![item_id],
        )?;
        Ok(())
    })
}

/// 手动编辑标题：`title` 非空时设为 manual（此后自动规则与去重都不再覆盖）；
/// 传空串表示清除手动标题，按现有内容重新生成 auto 标题。
pub fn rename_item(db: &Db, item_id: &str, title: &str) -> AppResult<ClipboardItem> {
    let trimmed = title.trim();
    let (new_title, source) = if trimmed.is_empty() {
        let item = get_item(db, item_id)?;
        // 与采集入库一致：标题只从净化后的 HTML 提取，避免把 <script>/样式
        // 文本当成正文标题。
        let safe_html = engine::sanitize_html(&item.html);
        let regen = engine::make_title(
            &item.kind,
            &item.text,
            &safe_html,
            &item.file_paths,
            item.image_width,
            item.image_height,
        );
        (regen, "auto")
    } else {
        (engine::truncate_chars(trimmed, 80), "manual")
    };
    let stored_title = secure::encrypt_for_write(
        db,
        Settings::load_clipboard(db).settings.clipboard_encrypt_history,
        &secure::item_field_aad(item_id, "title"),
        &new_title,
    )?;
    let n = db.with_conn(|conn| {
        Ok(conn.execute(
            "UPDATE clipboard_items SET title = ?1, title_source = ?2 WHERE id = ?3",
            params![stored_title, source, item_id],
        )?)
    })?;
    if n == 0 {
        return Err(AppError::NotFound("剪贴板条目不存在".into()));
    }
    get_item(db, item_id)
}

/// 按传入顺序批量读取条目（多选批量复制/粘贴用）；不存在的 id 跳过。
pub fn get_items_by_ids(db: &Db, ids: &[String]) -> AppResult<Vec<ClipboardItem>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    // 去重保持首次顺序，避免同一条目重复写入剪贴板
    let mut unique: Vec<&String> = Vec::new();
    for id in ids {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    let ph = placeholders(unique.len());
    let sql = format!("SELECT {ITEM_FIELDS} FROM clipboard_items i WHERE i.id IN ({ph})");
    let map: std::collections::HashMap<String, ClipboardItem> = db.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params_from_iter(unique.iter().map(|s| s.to_string())),
            map_item,
        )?;
        let mut m = std::collections::HashMap::new();
        for r in rows {
            let item = r?;
            m.insert(item.id.clone(), item);
        }
        Ok(m)
    })?;
    Ok(unique
        .into_iter()
        .filter_map(|id| map.get(id.as_str()).cloned())
        .collect())
}

/// 固定多选粘贴计划的顺序和总数：失效项仍入计划，由执行器记录 skipped，不能静默裁剪。
pub fn prepare_paste_selection(db: &Db, ids: &[String]) -> AppResult<Vec<String>> {
    if ids.is_empty() || ids.len() > 1000 || ids.iter().any(|id| id.is_empty() || id.len() > 128) {
        return Err(AppError::Validation("逐项粘贴需要 1–1000 个有效条目标识".into()));
    }
    let mut seen = HashSet::new();
    let selected: Vec<String> = ids.iter().filter(|id| seen.insert(id.as_str())).cloned().collect();
    if get_items_by_ids(db, &selected)?.is_empty() {
        return Err(AppError::Validation("所选条目不存在或已删除".into()));
    }
    Ok(selected)
}

pub fn toggle_item_flag(db: &Db, item_id: &str, flag: &str) -> AppResult<ClipboardItem> {
    let column = match flag {
        "favorite" => "favorite",
        "pinned" => "pinned",
        _ => return Err(AppError::Validation("未知标记".into())),
    };
    db.with_conn(|conn| {
        conn.execute(
            &format!("UPDATE clipboard_items SET {column} = 1 - {column} WHERE id = ?1"),
            params![item_id],
        )?;
        Ok(())
    })?;
    get_item(db, item_id)
}

pub fn toggle_group_flag(db: &Db, group_id: &str, flag: &str) -> AppResult<ClipboardGroup> {
    let column = match flag {
        "favorite" => "favorite",
        "pinned" => "pinned",
        _ => return Err(AppError::Validation("未知标记".into())),
    };
    db.with_conn(|conn| {
        conn.execute(
            &format!("UPDATE clipboard_groups SET {column} = 1 - {column}, updated_at = ?1 WHERE id = ?2"),
            params![crate::agents::now_iso(), group_id],
        )?;
        Ok(())
    })?;
    get_group(db, group_id)
}

pub fn close_group(db: &Db, group_id: &str) -> AppResult<ClipboardGroup> {
    db.with_conn(|conn| {
        close_group_conn(conn, group_id)?;
        Ok(())
    })?;
    get_group(db, group_id)
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

fn collect_asset_paths(conn: &Connection, ids: &[String]) -> AppResult<Vec<String>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT path FROM clipboard_assets WHERE item_id IN ({})",
        placeholders(ids.len())
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(ids.iter()), |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 删除条目（显式操作）：级联清掉分组条目与任务关联；空分组一并清理。
fn delete_items_conn(conn: &Connection, ids: &[String]) -> AppResult<(i64, Vec<String>)> {
    if ids.is_empty() {
        return Ok((0, Vec::new()));
    }
    let ph = placeholders(ids.len());
    let paths = collect_asset_paths(conn, ids)?;
    conn.execute(
        &format!(
            "DELETE FROM clipboard_task_links WHERE target_type = 'item' AND target_id IN ({ph})"
        ),
        params_from_iter(ids.iter()),
    )?;
    let deleted = conn.execute(
        &format!("DELETE FROM clipboard_items WHERE id IN ({ph})"),
        params_from_iter(ids.iter()),
    )? as i64;
    conn.execute(
        &format!("DELETE FROM clipboard_snapshot_links WHERE target_type = 'item' AND target_id IN ({ph})"),
        params_from_iter(ids.iter()),
    )?;
    // 被删条目所在的分组若已空，分组与关联一起清理
    let empty_groups: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT g.id FROM clipboard_groups g WHERE NOT EXISTS
             (SELECT 1 FROM clipboard_group_items gi WHERE gi.group_id = g.id)",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut v = Vec::new();
        for r in rows {
            v.push(r?);
        }
        v
    };
    for gid in &empty_groups {
        conn.execute(
            "DELETE FROM clipboard_snapshot_links WHERE target_type = 'group' AND target_id = ?1",
            params![gid],
        )?;
        conn.execute(
            "DELETE FROM clipboard_task_links WHERE target_type = 'group' AND target_id = ?1",
            params![gid],
        )?;
        conn.execute("DELETE FROM clipboard_groups WHERE id = ?1", params![gid])?;
    }
    // 候选条目被删除后不再续用，避免下一条相关内容并入已不存在的内容。
    if let Some(cand) = read_candidate(conn)? {
        if ids.iter().any(|id| id == &cand.item_id) {
            clear_candidate(conn)?;
        }
    }
    Ok((deleted, paths))
}

fn remove_files_unreferenced(db: &Db, root: &Path, paths: Vec<String>) -> i64 {
    let mut freed = 0i64;
    let mut seen = HashSet::new();
    for rel in paths {
        if !seen.insert(rel.clone()) {
            continue;
        }
        let still: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM clipboard_assets WHERE path = ?1",
                    params![rel],
                    |r| r.get(0),
                )?)
            })
            .unwrap_or(1);
        if still > 0 {
            continue;
        }
        if let Ok(abs) = asset_abs(root, &rel) {
            if let Ok(meta) = std::fs::metadata(&abs) {
                if std::fs::remove_file(&abs).is_ok() {
                    freed += meta.len() as i64;
                }
            }
        }
        // 该条目不再被引用时，同步清掉为其解出的明文派生缓存（批次 2 过渡接口）。
        if let Some(stem) = rel
            .strip_prefix("images/")
            .and_then(|name| name.strip_suffix(".png"))
        {
            let _ = std::fs::remove_file(root.join("transient").join(format!("{stem}-image.png")));
        }
    }
    freed
}

pub fn delete_items(db: &Db, root: &Path, ids: &[String]) -> AppResult<DeleteReport> {
    if ids.is_empty() {
        return Ok(DeleteReport {
            deleted: 0,
            freed_bytes: 0,
            retained_shared: 0,
            groups_deleted: 0,
        });
    }
    let (deleted, paths) = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let (n, p) = delete_items_conn(&tx, ids)?;
        tx.commit()?;
        Ok((n, p))
    })?;
    let freed = remove_files_unreferenced(db, root, paths);
    remove_transient_for(root, ids);
    Ok(DeleteReport {
        deleted,
        freed_bytes: freed,
        retained_shared: 0,
        groups_deleted: 0,
    })
}

/// 删除分组：默认保留内容；`also_delete_items` 时只删除不再被其他分组/任务/工作现场引用、
/// 且未收藏/置顶的条目（引用安全）。
pub fn delete_group(
    db: &Db,
    root: &Path,
    group_id: &str,
    also_delete_items: bool,
) -> AppResult<DeleteReport> {
    let (report, paths) = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let total: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM clipboard_group_items WHERE group_id = ?1",
                params![group_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let candidates: Vec<String> = if also_delete_items {
            let mut stmt = tx.prepare(
                "SELECT gi.item_id FROM clipboard_group_items gi
                 WHERE gi.group_id = ?1
                   AND NOT EXISTS (SELECT 1 FROM clipboard_group_items other
                                   WHERE other.item_id = gi.item_id AND other.group_id <> ?1)
                   AND NOT EXISTS (SELECT 1 FROM clipboard_task_links lt
                                   WHERE lt.target_type = 'item' AND lt.target_id = gi.item_id)
                   AND NOT EXISTS (SELECT 1 FROM clipboard_snapshot_links ls
                                   WHERE ls.target_type = 'item' AND ls.target_id = gi.item_id)
                   AND NOT EXISTS (SELECT 1 FROM clipboard_items i
                                   WHERE i.id = gi.item_id AND (i.favorite = 1 OR i.pinned = 1))",
            )?;
            let rows = stmt.query_map(params![group_id], |r| r.get::<_, String>(0))?;
            let mut v = Vec::new();
            for r in rows {
                v.push(r?);
            }
            v
        } else {
            Vec::new()
        };
        tx.execute(
            "DELETE FROM clipboard_task_links WHERE target_type = 'group' AND target_id = ?1",
            params![group_id],
        )?;
        tx.execute(
            "DELETE FROM clipboard_snapshot_links WHERE target_type = 'group' AND target_id = ?1",
            params![group_id],
        )?;
        // rows affected：0 说明分组本来就不存在，不能让前端当成删除成功
        let groups_deleted = tx.execute(
            "DELETE FROM clipboard_groups WHERE id = ?1",
            params![group_id],
        )? as i64;
        let (deleted, paths) = delete_items_conn(&tx, &candidates)?;
        tx.commit()?;
        let retained = if also_delete_items {
            (total - deleted).max(0)
        } else {
            0
        };
        Ok((
            DeleteReport {
                deleted,
                freed_bytes: 0,
                retained_shared: retained,
                groups_deleted,
            },
            paths,
        ))
    })?;
    let mut report = report;
    report.freed_bytes = remove_files_unreferenced(db, root, paths);
    Ok(report)
}

pub fn create_manual_group(db: &Db, name: &str, item_ids: &[String]) -> AppResult<ClipboardGroup> {
    let name = normalize_group_name(name, "手动分组");
    let now = crate::agents::now_iso();
    let group_id = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let gid = create_group_row(&tx, &name, "manual", "manual", "closed", &now)?;
        let mut added = 0;
        for id in item_ids {
            let exists: i64 = tx.query_row(
                "SELECT COUNT(*) FROM clipboard_items WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )?;
            if exists > 0 && append_group_item(&tx, &gid, id, "manual", &now)? {
                added += 1;
            }
        }
        if added == 0 {
            let _ = tx.rollback();
            return Err(AppError::Validation("未选择有效条目".into()));
        }
        tx.commit()?;
        Ok(gid)
    })?;
    get_group(db, &group_id)
}

fn normalize_group_name(name: &str, fallback: &str) -> String {
    let n = name.trim();
    let n = if n.is_empty() { fallback } else { n };
    engine::truncate_chars(n, 80)
}

pub fn rename_group(db: &Db, group_id: &str, name: &str) -> AppResult<ClipboardGroup> {
    let name = normalize_group_name(name, "未命名分组");
    db.with_conn(|conn| {
        let n = conn.execute(
            "UPDATE clipboard_groups SET name = ?1, name_source = 'manual', updated_at = ?2 WHERE id = ?3",
            params![name, crate::agents::now_iso(), group_id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound("分组不存在".into()));
        }
        Ok(())
    })?;
    get_group(db, group_id)
}

pub fn add_to_group(db: &Db, group_id: &str, item_ids: &[String]) -> AppResult<ClipboardGroup> {
    let now = crate::agents::now_iso();
    db.with_conn(|conn| {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM clipboard_groups WHERE id = ?1",
            params![group_id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(AppError::NotFound("分组不存在".into()));
        }
        let tx = conn.unchecked_transaction()?;
        for id in item_ids {
            let ok: i64 = tx.query_row(
                "SELECT COUNT(*) FROM clipboard_items WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )?;
            if ok > 0 {
                append_group_item(&tx, group_id, id, "manual", &now)?;
            }
        }
        tx.commit()?;
        Ok(())
    })?;
    get_group(db, group_id)
}

fn reindex_group(conn: &Connection, group_id: &str) -> AppResult<()> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT item_id FROM clipboard_group_items WHERE group_id = ?1 ORDER BY position, added_at",
        )?;
        let rows = stmt.query_map(params![group_id], |r| r.get::<_, String>(0))?;
        let mut v = Vec::new();
        for r in rows {
            v.push(r?);
        }
        v
    };
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE clipboard_group_items SET position = ?1 WHERE group_id = ?2 AND item_id = ?3",
            params![i as i64, group_id, id],
        )?;
    }
    Ok(())
}

pub fn remove_group_item(db: &Db, group_id: &str, item_id: &str) -> AppResult<ClipboardGroup> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM clipboard_group_items WHERE group_id = ?1 AND item_id = ?2",
            params![group_id, item_id],
        )?;
        reindex_group(&tx, group_id)?;
        tx.execute(
            "UPDATE clipboard_groups SET updated_at = ?1 WHERE id = ?2",
            params![crate::agents::now_iso(), group_id],
        )?;
        tx.commit()?;
        Ok(())
    })?;
    get_group(db, group_id)
}

pub fn move_group_item(
    db: &Db,
    group_id: &str,
    item_id: &str,
    new_index: i64,
) -> AppResult<ClipboardGroup> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut ids: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT item_id FROM clipboard_group_items WHERE group_id = ?1 ORDER BY position, added_at",
            )?;
            let rows = stmt.query_map(params![group_id], |r| r.get::<_, String>(0))?;
            let mut v = Vec::new();
            for r in rows {
                v.push(r?);
            }
            v
        };
        let from = ids
            .iter()
            .position(|x| x == item_id)
            .ok_or_else(|| AppError::NotFound("条目不在该分组中".into()))?;
        let moved = ids.remove(from);
        let idx = new_index.clamp(0, ids.len() as i64) as usize;
        ids.insert(idx, moved);
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE clipboard_group_items SET position = ?1 WHERE group_id = ?2 AND item_id = ?3",
                params![i as i64, group_id, id],
            )?;
        }
        tx.execute(
            "UPDATE clipboard_groups SET updated_at = ?1 WHERE id = ?2",
            params![crate::agents::now_iso(), group_id],
        )?;
        tx.commit()?;
        Ok(())
    })?;
    get_group(db, group_id)
}

pub fn split_group(
    db: &Db,
    group_id: &str,
    item_ids: &[String],
    name: &str,
) -> AppResult<ClipboardGroup> {
    let now = crate::agents::now_iso();
    let name = normalize_group_name(name, "拆分分组");
    let new_id = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut source: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT item_id FROM clipboard_group_items WHERE group_id = ?1 ORDER BY position, added_at",
            )?;
            let rows = stmt.query_map(params![group_id], |r| r.get::<_, String>(0))?;
            let mut v = Vec::new();
            for r in rows {
                v.push(r?);
            }
            v
        };
        let picked: HashSet<&String> = item_ids.iter().collect();
        let selected: Vec<String> = source
            .iter()
            .filter(|id| picked.contains(id))
            .cloned()
            .collect();
        if selected.is_empty() {
            let _ = tx.rollback();
            return Err(AppError::Validation("未选择属于该分组的条目".into()));
        }
        let gid = create_group_row(&tx, &name, "manual", "manual", "closed", &now)?;
        for id in &selected {
            append_group_item(&tx, &gid, id, "manual", &now)?;
            tx.execute(
                "DELETE FROM clipboard_group_items WHERE group_id = ?1 AND item_id = ?2",
                params![group_id, id],
            )?;
        }
        source.retain(|id| !picked.contains(id));
        reindex_group(&tx, group_id)?;
        if source.is_empty() {
            tx.execute(
                "DELETE FROM clipboard_snapshot_links WHERE target_type = 'group' AND target_id = ?1",
                params![group_id],
            )?;
            tx.execute(
                "DELETE FROM clipboard_task_links WHERE target_type = 'group' AND target_id = ?1",
                params![group_id],
            )?;
            tx.execute("DELETE FROM clipboard_groups WHERE id = ?1", params![group_id])?;
        } else {
            tx.execute(
                "UPDATE clipboard_groups SET updated_at = ?1 WHERE id = ?2",
                params![now, group_id],
            )?;
        }
        tx.commit()?;
        Ok(gid)
    })?;
    get_group(db, &new_id)
}

pub fn merge_groups(db: &Db, group_ids: &[String], name: &str) -> AppResult<ClipboardGroup> {
    if group_ids.len() < 2 {
        return Err(AppError::Validation("至少选择两个分组".into()));
    }
    let name = normalize_group_name(name, "合并分组");
    let now = crate::agents::now_iso();
    let new_id = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let gid = create_group_row(&tx, &name, "manual", "manual", "closed", &now)?;
        let mut seen = HashSet::new();
        for source in group_ids {
            let ids: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT item_id FROM clipboard_group_items WHERE group_id = ?1 ORDER BY position, added_at",
                )?;
                let rows = stmt.query_map(params![source], |r| r.get::<_, String>(0))?;
                let mut v = Vec::new();
                for r in rows {
                    v.push(r?);
                }
                v
            };
            for id in ids {
                if seen.insert(id.clone()) {
                    append_group_item(&tx, &gid, &id, "manual", &now)?;
                }
            }
        }
        if seen.is_empty() {
            let _ = tx.rollback();
            return Err(AppError::Validation("所选分组没有内容".into()));
        }
        tx.commit()?;
        Ok(gid)
    })?;
    get_group(db, &new_id)
}

// ── 任务关联 ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardTaskLink {
    pub id: String,
    pub task_id: String,
    pub target_type: String,
    pub target_id: String,
    pub created_at: String,
    pub label: String,
    pub kind: String,
}

pub fn link_task(
    db: &Db,
    task_id: &str,
    target_type: &str,
    target_id: &str,
) -> AppResult<ClipboardTaskLink> {
    if target_type != "item" && target_type != "group" {
        return Err(AppError::Validation("未知关联类型".into()));
    }
    db.with_conn(|conn| {
        let task: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tasks WHERE id = ?1",
            params![task_id],
            |r| r.get(0),
        )?;
        if task == 0 {
            return Err(AppError::NotFound("任务不存在".into()));
        }
        let exists: i64 = if target_type == "item" {
            conn.query_row(
                "SELECT COUNT(*) FROM clipboard_items WHERE id = ?1",
                params![target_id],
                |r| r.get(0),
            )?
        } else {
            conn.query_row(
                "SELECT COUNT(*) FROM clipboard_groups WHERE id = ?1",
                params![target_id],
                |r| r.get(0),
            )?
        };
        if exists == 0 {
            return Err(AppError::NotFound("剪贴板内容不存在".into()));
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT OR IGNORE INTO clipboard_task_links (id, task_id, target_type, target_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, task_id, target_type, target_id, crate::agents::now_iso()],
        )?;
        let link_id: String = conn.query_row(
            "SELECT id FROM clipboard_task_links WHERE task_id = ?1 AND target_type = ?2 AND target_id = ?3",
            params![task_id, target_type, target_id],
            |r| r.get(0),
        )?;
        Ok(ClipboardTaskLink {
            id: link_id,
            task_id: task_id.into(),
            target_type: target_type.into(),
            target_id: target_id.into(),
            created_at: crate::agents::now_iso(),
            label: String::new(),
            kind: String::new(),
        })
    })
}

pub fn unlink_task(db: &Db, link_id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let n = conn.execute(
            "DELETE FROM clipboard_task_links WHERE id = ?1",
            params![link_id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound("关联不存在".into()));
        }
        Ok(())
    })
}

pub fn task_links(db: &Db, task_id: &str) -> AppResult<Vec<ClipboardTaskLink>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT l.id, l.task_id, l.target_type, l.target_id, l.created_at,
                CASE WHEN l.target_type = 'item'
                  THEN COALESCE((SELECT preview FROM clipboard_items WHERE id = l.target_id), '')
                  ELSE COALESCE((SELECT name FROM clipboard_groups WHERE id = l.target_id), '') END AS label,
                CASE WHEN l.target_type = 'item'
                  THEN COALESCE((SELECT kind FROM clipboard_items WHERE id = l.target_id), '')
                  ELSE 'group' END AS kind
             FROM clipboard_task_links l WHERE l.task_id = ?1 ORDER BY l.created_at",
        )?;
        let rows = stmt.query_map(params![task_id], |r| {
            let target_type: String = r.get(2)?;
            let target_id: String = r.get(3)?;
            let label: String = r.get(5)?;
            let label = if target_type == "item" {
                decrypt_item_field(&target_id, "preview", label)?
            } else {
                label
            };
            Ok(ClipboardTaskLink {
                id: r.get(0)?,
                task_id: r.get(1)?,
                target_type,
                target_id,
                created_at: r.get(4)?,
                label,
                kind: r.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

// ── 工作现场关联（v0.5）────────────────────────────────────
// 现场 ↔ 剪贴板素材只写关联不复制内容；删除现场或素材时关联级联消失。

#[derive(Debug, Clone, Serialize)]
pub struct ClipboardSnapshotLink {
    pub id: String,
    pub snapshot_id: String,
    pub target_type: String,
    pub target_id: String,
    pub created_at: String,
    pub label: String,
    pub kind: String,
}

pub fn link_snapshot(
    db: &Db,
    snapshot_id: &str,
    target_type: &str,
    target_id: &str,
) -> AppResult<ClipboardSnapshotLink> {
    if target_type != "item" && target_type != "group" {
        return Err(AppError::Validation("未知关联类型".into()));
    }
    db.with_conn(|conn| {
        let snapshot: i64 = conn.query_row(
            "SELECT COUNT(*) FROM workspace_snapshots WHERE id = ?1",
            params![snapshot_id],
            |r| r.get(0),
        )?;
        if snapshot == 0 {
            return Err(AppError::NotFound("工作现场不存在".into()));
        }
        let exists: i64 = if target_type == "item" {
            conn.query_row(
                "SELECT COUNT(*) FROM clipboard_items WHERE id = ?1",
                params![target_id],
                |r| r.get(0),
            )?
        } else {
            conn.query_row(
                "SELECT COUNT(*) FROM clipboard_groups WHERE id = ?1",
                params![target_id],
                |r| r.get(0),
            )?
        };
        if exists == 0 {
            return Err(AppError::NotFound("剪贴板内容不存在".into()));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = crate::agents::now_iso();
        conn.execute(
            "INSERT OR IGNORE INTO clipboard_snapshot_links
               (id, snapshot_id, target_type, target_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, snapshot_id, target_type, target_id, now],
        )?;
        let real_id: String = conn.query_row(
            "SELECT id FROM clipboard_snapshot_links
             WHERE snapshot_id = ?1 AND target_type = ?2 AND target_id = ?3",
            params![snapshot_id, target_type, target_id],
            |r| r.get(0),
        )?;
        Ok(ClipboardSnapshotLink {
            id: real_id,
            snapshot_id: snapshot_id.into(),
            target_type: target_type.into(),
            target_id: target_id.into(),
            created_at: now,
            label: String::new(),
            kind: String::new(),
        })
    })
}

pub fn unlink_snapshot(db: &Db, link_id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let n = conn.execute(
            "DELETE FROM clipboard_snapshot_links WHERE id = ?1",
            params![link_id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound("关联不存在".into()));
        }
        Ok(())
    })
}

pub fn snapshot_links(db: &Db, snapshot_id: &str) -> AppResult<Vec<ClipboardSnapshotLink>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT l.id, l.snapshot_id, l.target_type, l.target_id, l.created_at,
                CASE WHEN l.target_type = 'item'
                  THEN COALESCE((SELECT preview FROM clipboard_items WHERE id = l.target_id), '')
                  ELSE COALESCE((SELECT name FROM clipboard_groups WHERE id = l.target_id), '') END AS label,
                CASE WHEN l.target_type = 'item'
                  THEN COALESCE((SELECT kind FROM clipboard_items WHERE id = l.target_id), '')
                  ELSE 'group' END AS kind
             FROM clipboard_snapshot_links l WHERE l.snapshot_id = ?1 ORDER BY l.created_at",
        )?;
        let rows = stmt.query_map(params![snapshot_id], |r| {
            let target_type: String = r.get(2)?;
            let target_id: String = r.get(3)?;
            let label: String = r.get(5)?;
            let label = if target_type == "item" {
                decrypt_item_field(&target_id, "preview", label)?
            } else {
                label
            };
            Ok(ClipboardSnapshotLink {
                id: r.get(0)?,
                snapshot_id: r.get(1)?,
                target_type,
                target_id,
                created_at: r.get(4)?,
                label,
                kind: r.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

// ── 粘贴任务审计 ────────────────────────────────────────────

/// 粘贴任务审计行。
///
/// 隐私边界（ADR-0012 §3.2，批次 11 复核）：`target_title`/`target_exe`/`message` 是
/// 粘贴操作元数据，不保存剪贴板正文；`target_title` 可能包含窗口文档名，属于已登记
/// 残余风险。不要在这里顺手写入条目正文或预览。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasteJob {
    pub id: String,
    pub group_id: String,
    pub target_title: String,
    pub target_exe: String,
    pub status: String,
    pub total: i64,
    pub sent: i64,
    /// 从逐项持久化状态读取，跨重启保留，无需增加第二套计数列。
    #[serde(default)]
    pub skipped: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub message: String,
    pub remaining_items: Vec<String>,
    /// 按键可能已经发出但无法证明的条目：不进入待处理队列，不会被自动重发。
    #[serde(default)]
    pub uncertain_items: Vec<String>,
    pub restored: bool,
}

/// 单个条目的持久化状态。用户可以看到「第几项、什么类型、走到哪一步、是否发过按键」。
///
/// `error_message` 只放状态机文案、序号或错误码，不放被粘贴条目正文（批次 11 复核）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasteItemRow {
    pub job_id: String,
    pub position: i64,
    pub item_id: String,
    pub kind: String,
    pub state: String,
    pub error_message: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub key_sent: bool,
    pub confirmed: bool,
    pub retry_safe: bool,
    /// SendInput 的投递时刻（v56）。非空即代表「可能已经产生外部副作用」。
    #[serde(default)]
    pub dispatch_started_at: Option<String>,
}

pub fn create_paste_job(
    db: &Db,
    group_id: &str,
    target_title: &str,
    target_exe: &str,
    item_ids: &[String],
) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO clipboard_paste_jobs
             (id, group_id, target_title, target_exe, status, total, sent, started_at, ended_at, message, remaining_items, restored)
             VALUES (?1, ?2, ?3, ?4, 'running', ?5, 0, ?6, NULL, '', ?7, 0)",
            params![
                id,
                group_id,
                target_title,
                target_exe,
                item_ids.len() as i64,
                crate::agents::now_iso(),
                serde_json::to_string(item_ids)?
            ],
        )?;
        Ok(())
    })?;
    Ok(id)
}

/// 继续任务前重置状态（保留累计 sent/total）。
pub fn reset_paste_job(db: &Db, id: &str, sent: i64, remaining: &[String]) -> AppResult<()> {
    db.with_conn(|conn| {
        let n = conn.execute(
            "UPDATE clipboard_paste_jobs SET status = 'running', sent = ?1, remaining_items = ?2,
                message = '', ended_at = NULL, restored = 0 WHERE id = ?3",
            params![sent, serde_json::to_string(remaining)?, id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound("粘贴任务不存在".into()));
        }
        Ok(())
    })
}

pub fn update_paste_job(
    db: &Db,
    id: &str,
    sent: i64,
    remaining: &[String],
    message: &str,
) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE clipboard_paste_jobs SET sent = ?1, remaining_items = ?2, message = ?3 WHERE id = ?4",
            params![sent, serde_json::to_string(remaining)?, message, id],
        )?;
        Ok(())
    })
}

/// 结束任务。`uncertain` 与本任务历史上已经累积的不确定项**合并**，绝不覆盖：
/// 续跑时 `run_plan` 只知道自己这一轮的不确定项，直接写回会把上一轮的历史抹掉。
/// 返回合并后的累计未解决数量，供事件与 UI 使用。
pub fn finish_paste_job(
    db: &Db,
    id: &str,
    status: &str,
    sent: i64,
    remaining: &[String],
    uncertain: &[String],
    message: &str,
    restored: bool,
) -> AppResult<usize> {
    db.with_transaction(|conn| {
        let existing: String = conn.query_row(
            "SELECT uncertain_items FROM clipboard_paste_jobs WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        let mut list: Vec<String> = serde_json::from_str(&existing).unwrap_or_default();
        for item in uncertain {
            if !list.contains(item) {
                list.push(item.clone());
            }
        }

        // 防御性一致性：任务级 uncertain 集合是权威「未解决」清单，逐项状态必须与它一致。
        // 正常的 run_plan 已在发送失败时写过 uncertain；这里再兜底一次，覆盖旧库/异常收尾，
        // 并把这些条目从 remaining 剔除，确保续跑绝不自动重发。
        let mut remaining_list = remaining.to_vec();
        remaining_list.retain(|item| !list.contains(item));
        let now = crate::agents::now_iso();
        for item in &list {
            conn.execute(
                "UPDATE clipboard_paste_items
                 SET state = 'uncertain', key_sent = 1, confirmed = 0, retry_safe = 0,
                     finished_at = COALESCE(finished_at, ?1),
                     dispatch_started_at = COALESCE(dispatch_started_at, ?1)
                 WHERE job_id = ?2 AND item_id = ?3",
                params![now, id, item],
            )?;
        }

        conn.execute(
            "UPDATE clipboard_paste_jobs SET status = ?1, sent = ?2, remaining_items = ?3,
                uncertain_items = ?4, message = ?5, restored = ?6, ended_at = ?7 WHERE id = ?8",
            params![
                status,
                sent,
                serde_json::to_string(&remaining_list)?,
                serde_json::to_string(&list)?,
                message,
                if restored { 1 } else { 0 },
                now,
                id
            ],
        )?;
        Ok(list.len())
    })
}

/// 「可恢复」谓词（第三轮收口重定义）：
///
/// 满足任一即可，且状态必须属于 `paused` / `interrupted` / `failed`：
/// a) 收敛后仍有剩余条目；b) 存在尚未解决的 uncertain 项。
///
/// 明确排除：`completed`；`running`（本进程活动任务，不由本查询找回）；
/// `cancelled`；uncertain 已全部解决；剩余条目在「底层条目已不存在」过滤后为空
/// 且无 unresolved uncertain 的任务。
fn job_is_resumable(job: &PasteJob) -> bool {
    if !matches!(
        job.status.as_str(),
        "paused" | "interrupted" | "failed"
    ) {
        return false;
    }
    !job.remaining_items.is_empty() || !job.uncertain_items.is_empty()
}

/// 收敛一个任务的剩余队列：只保留 `clipboard_items` 中仍存在的条目。
fn reconcile_remaining(conn: &Connection, job: &mut PasteJob) {
    job.remaining_items
        .retain(|item| get_item_quiet(conn, item).is_some());
}

/// 全部「可以继续」的任务，按 `started_at DESC`（同刻按 id 倒序）。
///
/// 与旧的单值查询不同：旧任务不会被更新的新任务静默覆盖。`group_id` 为 `None`
/// 时返回全部分组；传入则只返回该分组。返回前每个任务都收敛一次剩余队列。
pub fn resumable_paste_jobs(
    db: &Db,
    group_id: Option<&str>,
) -> AppResult<Vec<PasteJob>> {
    db.with_conn(|conn| {
        let mut sql = String::from(
            "SELECT id, group_id, target_title, target_exe, status, total, sent, started_at,
                    ended_at, message, remaining_items, uncertain_items, restored,
                    (SELECT COUNT(*) FROM clipboard_paste_items pi
                     WHERE pi.job_id = clipboard_paste_jobs.id AND pi.state = 'skipped')
             FROM clipboard_paste_jobs
             WHERE (status IN ('paused', 'interrupted', 'failed')
                OR uncertain_items NOT IN ('', '[]'))",
        );
        let mut args: Vec<Value> = Vec::new();
        if let Some(group) = group_id {
            sql.push_str(" AND group_id = ?");
            args.push(Value::from(group.to_string()));
        }
        sql.push_str(" ORDER BY started_at DESC, id DESC");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(args), |r| row_to_paste_job(r))?;
        let mut jobs: Vec<PasteJob> = rows.collect::<Result<Vec<_>, _>>()?;
        for job in &mut jobs {
            reconcile_remaining(conn, job);
        }
        jobs.retain(|j| job_is_resumable(j));
        Ok(jobs)
    })
}

/// 最近一个「可以继续」的任务（兼容旧调用方）。
///
/// 内部复用 [`resumable_paste_jobs`] 的新谓词，行为不回退：旧的 paused/interrupted
/// 有剩余仍会命中，同时覆盖 failed 有剩余、以及只有 unresolved uncertain 的任务。
pub fn latest_resumable_paste_job(db: &Db) -> AppResult<Option<PasteJob>> {
    Ok(resumable_paste_jobs(db, None)?.into_iter().next())
}

fn row_to_paste_job(r: &rusqlite::Row<'_>) -> rusqlite::Result<PasteJob> {
    let remaining: String = r.get(10)?;
    let uncertain: String = r.get(11)?;
    Ok(PasteJob {
        id: r.get(0)?,
        group_id: r.get(1)?,
        target_title: r.get(2)?,
        target_exe: r.get(3)?,
        status: r.get(4)?,
        total: r.get(5)?,
        sent: r.get(6)?,
        skipped: r.get(13)?,
        started_at: r.get(7)?,
        ended_at: r.get(8)?,
        message: r.get(9)?,
        remaining_items: serde_json::from_str(&remaining).unwrap_or_default(),
        uncertain_items: serde_json::from_str(&uncertain).unwrap_or_default(),
        restored: r.get::<_, i64>(12)? != 0,
    })
}

pub fn get_paste_job(db: &Db, id: &str) -> AppResult<PasteJob> {
    db.with_conn(|conn| {
        let mut job = conn
            .query_row(
                "SELECT id, group_id, target_title, target_exe, status, total, sent, started_at,
                        ended_at, message, remaining_items, uncertain_items, restored,
                        (SELECT COUNT(*) FROM clipboard_paste_items pi
                         WHERE pi.job_id = clipboard_paste_jobs.id AND pi.state = 'skipped')
                 FROM clipboard_paste_jobs WHERE id = ?1",
                params![id],
                row_to_paste_job,
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("粘贴任务不存在".into()))?;
        job.remaining_items
            .retain(|id| get_item_quiet(conn, id).is_some());
        Ok(job)
    })
}

fn get_item_quiet(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row(
        "SELECT id FROM clipboard_items WHERE id = ?1",
        params![id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// 应用启动时收尾上一次进程留下的「运行中」任务。
///
/// 关键点：处于 `dispatching` 的条目意味着**按键可能已经发出但进程没来得及记录**，
/// 必须转成 `uncertain`（retry_safe=0）并并入任务的 `uncertain_items`，
/// 否则续跑时会把它们当待处理项自动重发，造成重复粘贴。
pub fn interrupt_stale_paste_jobs(db: &Db) -> AppResult<i64> {
    db.with_transaction(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id FROM clipboard_paste_jobs WHERE status = 'running' AND ended_at IS NULL",
        )?;
        let ids: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let now = crate::agents::now_iso();
        for id in &ids {
            let promoted = promote_dispatching_items(conn, id, &now)?;
            let mut uncertain_json = String::new();
            if !promoted.is_empty() {
                uncertain_json = serde_json::to_string(&promoted)?;
            }
            if uncertain_json.is_empty() {
                conn.execute(
                    "UPDATE clipboard_paste_jobs SET status = 'interrupted', ended_at = ?1,
                        message = CASE WHEN message = '' THEN '应用退出或任务中断' ELSE message END
                     WHERE id = ?2",
                    params![now, id],
                )?;
            } else {
                // 把崩溃锚点并入历史不确定集合，不覆盖用户已经确认过的记录。
                let existing: String = conn.query_row(
                    "SELECT uncertain_items FROM clipboard_paste_jobs WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )?;
                let mut list: Vec<String> = serde_json::from_str(&existing).unwrap_or_default();
                for item in promoted {
                    if !list.contains(&item) {
                        list.push(item);
                    }
                }
                conn.execute(
                    "UPDATE clipboard_paste_jobs SET status = 'interrupted', ended_at = ?1,
                        uncertain_items = ?2,
                        message = CASE WHEN message = '' THEN '应用退出或任务中断（按键发送阶段崩溃）' ELSE message END
                     WHERE id = ?3",
                    params![now, serde_json::to_string(&list)?, id],
                )?;
            }
        }
        Ok(ids.len() as i64)
    })
}

/// 把 `dispatching` 条目转成 `uncertain`，返回被转换的 item_id。
/// `dispatching` 是「SendInput 已调用或即将调用」的崩溃锚点：无法证明是否送达，
/// 只能按最坏情况处理——不自动重发、等用户确认。
fn promote_dispatching_items(
    conn: &Connection,
    job_id: &str,
    now: &str,
) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT item_id FROM clipboard_paste_items WHERE job_id = ?1 AND state = 'dispatching'",
    )?;
    let items: Vec<String> = stmt
        .query_map(params![job_id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    if items.is_empty() {
        return Ok(items);
    }
    conn.execute(
        "UPDATE clipboard_paste_items
         SET state = 'uncertain', error_message = ?1, finished_at = ?2, retry_safe = 0
         WHERE job_id = ?3 AND state = 'dispatching'",
        params![
            "发送阶段进程中断：按键可能已发出，结果不确定，不会自动重发",
            now,
            job_id
        ],
    )?;
    Ok(items)
}

/// 续跑前/打开页面时调用：把崩溃锚点收敛成 uncertain 并并入任务集合。
/// 幂等：没有 `dispatching` 条目时返回历史累计数量。
pub fn reconcile_dispatching_items(db: &Db, job_id: &str) -> AppResult<usize> {    db.with_transaction(|conn| {
        let now = crate::agents::now_iso();
        let promoted = promote_dispatching_items(conn, job_id, &now)?;
        let existing: String = conn.query_row(
            "SELECT uncertain_items FROM clipboard_paste_jobs WHERE id = ?1",
            params![job_id],
            |r| r.get(0),
        )?;
        let mut list: Vec<String> = serde_json::from_str(&existing).unwrap_or_default();
        for item in promoted {
            if !list.contains(&item) {
                list.push(item);
            }
        }
        conn.execute(
            "UPDATE clipboard_paste_jobs SET uncertain_items = ?1 WHERE id = ?2",
            params![serde_json::to_string(&list)?, job_id],
        )?;
        Ok(list.len())
    })
}

/// 用户显式处置一个「结果不确定」条目。两种动作，语义完全不同：
/// - `received`：用户确认目标应用已经收到 → 标记 confirmed，从不确定集合移除；
/// - `resend`：用户确认没收到、明确要求重发 → 放回待处理队列（按原始 position 排序），
///   并从不确定集合移除。
/// 任何情况下都不允许自动把 uncertain 变成 pending——那正是重复粘贴的来源。
pub fn resolve_uncertain_item(
    db: &Db,
    job_id: &str,
    item_id: &str,
    action: &str,
) -> AppResult<()> {
    if !matches!(action, "received" | "resend") {
        return Err(AppError::Validation(
            "action 必须是 received 或 resend".into(),
        ));
    }
    db.with_transaction(|conn| {
        let existing: String = conn.query_row(
            "SELECT uncertain_items FROM clipboard_paste_jobs WHERE id = ?1",
            params![job_id],
            |r| r.get(0),
        )?;
        let mut uncertain: Vec<String> = serde_json::from_str(&existing).unwrap_or_default();
        if !uncertain.iter().any(|id| id == item_id) {
            return Err(AppError::Validation(
                "该条目不在不确定集合，不能按不确定项处置".into(),
            ));
        }
        uncertain.retain(|id| id != item_id);
        conn.execute(
            "UPDATE clipboard_paste_jobs SET uncertain_items = ?1 WHERE id = ?2",
            params![serde_json::to_string(&uncertain)?, job_id],
        )?;

        if action == "received" {
            write_paste_item_state(
                conn,
                job_id,
                item_id,
                "confirmed",
                Some("用户确认目标已接收（不再重发）"),
            )?;
            return Ok(());
        }

        // resend：按原始 position 重新排进 remaining，保持「原始顺序」契约。
        let remaining_json: String = conn.query_row(
            "SELECT remaining_items FROM clipboard_paste_jobs WHERE id = ?1",
            params![job_id],
            |r| r.get(0),
        )?;
        let mut remaining: Vec<String> = serde_json::from_str(&remaining_json).unwrap_or_default();
        if !remaining.iter().any(|id| id == item_id) {
            remaining.push(item_id.to_string());
        }
        let mut stmt =
            conn.prepare("SELECT item_id, position FROM clipboard_paste_items WHERE job_id = ?1")?;
        let positions: Vec<(String, i64)> = stmt
            .query_map(params![job_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);
        let order: std::collections::HashMap<String, i64> =
            positions.into_iter().collect();
        remaining.sort_by_key(|id| order.get(id).copied().unwrap_or(i64::MAX));
        conn.execute(
            "UPDATE clipboard_paste_jobs SET remaining_items = ?1, status = 'paused' WHERE id = ?2",
            params![serde_json::to_string(&remaining)?, job_id],
        )?;
        write_paste_item_state(
            conn,
            job_id,
            item_id,
            "pending",
            Some("用户确认未接收，已排入重发（需再次点击继续）"),
        )?;
        // 重新进入 pending 属于一次全新尝试，必须清掉上一轮的终态/投递痕迹：
        // - finished_at 非空会让 UI 误以为本项已完成，也可能让恢复查询误判；
        // - dispatch_started_at 必须在下一次发送时才重新写；
        // - key_sent / confirmed / retry_safe 表达「当前尝试」语义：新一轮尚未发按键、
        //   未确认，因此 key_sent=0、confirmed=0、retry_safe=1。
        //   历史「上一轮曾发过按键」在现有列模型下不单独保留；如需跨尝试留痕，
        //   需要新增 attempt 计数列（见第三轮收口回报，本轮不加迁移）。
        conn.execute(
            "UPDATE clipboard_paste_items
             SET finished_at = NULL, dispatch_started_at = NULL,
                 key_sent = 0, confirmed = 0, retry_safe = 1
             WHERE job_id = ?1 AND item_id = ?2",
            params![job_id, item_id],
        )?;
        Ok(())
    })
}

// ── 逐项状态 ──────────────────────────────────────────────

/// 建立任务时登记逐项记录。`position_offset` 用于续跑的历史任务：
/// 新任务从 0 开始，续跑任务按原始顺序偏移，保持「第几项」可追溯。
pub fn seed_paste_items(
    db: &Db,
    job_id: &str,
    item_ids: &[String],
    position_offset: i64,
) -> AppResult<()> {
    db.with_conn(|conn| {
        for (idx, id) in item_ids.iter().enumerate() {
            let kind: String = conn
                .query_row(
                    "SELECT kind FROM clipboard_items WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or_default();
            conn.execute(
                "INSERT OR IGNORE INTO clipboard_paste_items
                 (job_id, position, item_id, kind, state, error_message,
                  started_at, finished_at, key_sent, confirmed, retry_safe)
                 VALUES (?1, ?2, ?3, ?4, 'pending', '', NULL, NULL, 0, 0, 1)",
                params![job_id, position_offset + idx as i64, id, kind],
            )?;
        }
        Ok(())
    })
}

/// 记录一次状态跃迁。已经开始过的条目不会被后续跃迁覆盖开始时间；
/// 终态写完成时间。`retry_safe` 只在「没发过按键」时为真——发过按键的条目
/// 重试就可能造成重复粘贴，必须由用户显式确认。
pub fn record_paste_item_state(
    db: &Db,
    job_id: &str,
    item_id: &str,
    state: &str,
    note: Option<&str>,
) -> AppResult<()> {
    db.with_conn(|conn| write_paste_item_state(conn, job_id, item_id, state, note))
}

/// 一步状态跃迁：任务进度与逐项状态必须落在**同一个事务**里。
/// 否则崩溃后会看到「任务说已发送 N 项、条目还停在 pending」这种互相矛盾的现场。
pub fn record_paste_step(
    db: &Db,
    job_id: &str,
    sent: i64,
    remaining: &[String],
    item_id: &str,
    state: &str,
    note: Option<&str>,
) -> AppResult<()> {
    db.with_transaction(|conn| {
        conn.execute(
            "UPDATE clipboard_paste_jobs SET sent = ?1, remaining_items = ?2, message = ?3 WHERE id = ?4",
            params![sent, serde_json::to_string(remaining)?, "运行中", job_id],
        )?;
        write_paste_item_state(conn, job_id, item_id, state, note)
    })
}

/// `InputSent` 专用落库：任务计数（`next_sent = 当前 sent + 1`）、剩余队列剔除本项、
/// 逐项 `input_sent` 状态必须在**同一个事务**内一致提交。
///
/// 事务内断言 sent 恰好递增 1；不一致直接返回错误，不静默写坏计数。Settling 只是
/// 后续观察阶段，不再回写 sent/remaining。这样即使进程在 InputSent 提交后、
/// Settling 落库前退出，重启后计数与逐项状态也一致，该项不会既不在 remaining 也不在
/// sent 里，更不会被重发。
pub fn record_paste_input_sent_step(
    db: &Db,
    job_id: &str,
    next_sent: i64,
    remaining: &[String],
    item_id: &str,
    note: Option<&str>,
) -> AppResult<()> {
    db.with_transaction(|conn| {
        let current: i64 = conn.query_row(
            "SELECT sent FROM clipboard_paste_jobs WHERE id = ?1",
            params![job_id],
            |r| r.get(0),
        )?;
        if next_sent != current + 1 {
            return Err(AppError::Validation(format!(
                "InputSent 计数不一致：当前 sent={current}，提交 sent={next_sent}（应恰好 +1）"
            )));
        }
        conn.execute(
            "UPDATE clipboard_paste_jobs SET sent = ?1, remaining_items = ?2, message = ?3 WHERE id = ?4",
            params![next_sent, serde_json::to_string(remaining)?, "运行中", job_id],
        )?;
        write_paste_item_state(conn, job_id, item_id, "input_sent", note)
    })
}

fn write_paste_item_state(
    conn: &Connection,
    job_id: &str,
    item_id: &str,
    state: &str,
    note: Option<&str>,
) -> AppResult<()> {
    let terminal = matches!(
        state,
        "confirmed" | "unverified" | "failed" | "skipped" | "uncertain" | "cancelled"
    );
    let started = matches!(
        state,
        "preparing"
            | "dispatching"
            | "clipboard_written"
            | "input_sent"
            | "settling"
            | "confirmed"
            | "unverified"
            | "failed"
            | "skipped"
            | "uncertain"
            | "cancelled"
    );
    let key_sent = matches!(
        state,
        "input_sent" | "settling" | "confirmed" | "unverified" | "uncertain"
    );
    // dispatching = 按键正在投递：可能已经送达，绝不能标成可安全重试。
    let dispatching = state == "dispatching";
    let now = crate::agents::now_iso();
    let started_at = if started { Some(now.clone()) } else { None };
    let finished_at = if terminal { Some(now.clone()) } else { None };
    let dispatch_at = if dispatching { Some(now) } else { None };
    let retry_safe = !key_sent && !dispatching;
    let confirmed = state == "confirmed";
    let n = conn.execute(
        "UPDATE clipboard_paste_items
         SET state = ?3, error_message = ?4,
             started_at = COALESCE(started_at, ?5),
             finished_at = COALESCE(?6, finished_at),
             key_sent = CASE WHEN ?7 THEN 1 ELSE key_sent END,
             confirmed = CASE WHEN ?8 THEN 1 ELSE confirmed END,
             retry_safe = ?9,
             dispatch_started_at = COALESCE(?10, dispatch_started_at)
         WHERE job_id = ?1 AND item_id = ?2",
        params![
            job_id,
            item_id,
            state,
            note.unwrap_or(""),
            started_at,
            finished_at,
            key_sent,
            confirmed,
            retry_safe,
            dispatch_at
        ],
    )?;
    if n == 0 {
        conn.execute(
            "INSERT INTO clipboard_paste_items
             (job_id, position, item_id, kind, state, error_message,
              started_at, finished_at, key_sent, confirmed, retry_safe, dispatch_started_at)
             VALUES (?1, 0, ?2, '', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                job_id,
                item_id,
                state,
                note.unwrap_or(""),
                started_at,
                finished_at,
                key_sent,
                confirmed,
                retry_safe,
                dispatch_at
            ],
        )?;
    }
    Ok(())
}

pub fn list_paste_items(db: &Db, job_id: &str) -> AppResult<Vec<PasteItemRow>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT job_id, position, item_id, kind, state, error_message,
                    started_at, finished_at, key_sent, confirmed, retry_safe, dispatch_started_at
             FROM clipboard_paste_items WHERE job_id = ?1 ORDER BY position ASC",
        )?;
        let rows = stmt
            .query_map(params![job_id], |r| {
                Ok(PasteItemRow {
                    job_id: r.get(0)?,
                    position: r.get(1)?,
                    item_id: r.get(2)?,
                    kind: r.get(3)?,
                    state: r.get(4)?,
                    error_message: r.get(5)?,
                    started_at: r.get(6)?,
                    finished_at: r.get(7)?,
                    key_sent: r.get::<_, i64>(8)? != 0,
                    confirmed: r.get::<_, i64>(9)? != 0,
                    retry_safe: r.get::<_, i64>(10)? != 0,
                    dispatch_started_at: r.get(11)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

// ── 清理与维护 ──────────────────────────────────────────────

fn now_cutoff(days: u32) -> String {
    (Utc::now() - Duration::days(days.max(1) as i64)).to_rfc3339()
}

pub fn cleanup(db: &Db, root: &Path, settings: &Settings) -> AppResult<CleanupReport> {
    let mut report = CleanupReport {
        items_deleted: 0,
        groups_closed: 0,
        bytes_freed: 0,
        orphan_files_removed: 0,
    };
    // 1) 关闭过期的自动收集会话（最后一条内容早于分组窗口，任意内容类型）
    let closed = db.with_conn(|conn| {
        let cutoff = (Utc::now()
            - Duration::seconds(settings.clipboard_group_window_secs.max(1) as i64))
        .to_rfc3339();
        let n = conn.execute(
            "UPDATE clipboard_groups SET status = 'closed', closed_at = ?1, updated_at = ?1
             WHERE status = 'collecting' AND COALESCE(
               (SELECT MAX(i.created_at) FROM clipboard_group_items gi
                JOIN clipboard_items i ON i.id = gi.item_id
                WHERE gi.group_id = clipboard_groups.id), updated_at) < ?2",
            params![crate::agents::now_iso(), cutoff],
        )?;
        Ok(n as i64)
    })?;
    report.groups_closed = closed;
    // 过期候选不会在下次采集时续用；这里顺手清理，避免长期占用设置表。
    db.with_conn(|conn| {
        let cutoff = (Utc::now()
            - Duration::seconds(settings.clipboard_group_window_secs.max(1) as i64))
        .to_rfc3339();
        if let Some(cand) = read_candidate(conn)? {
            let expired = parse_iso(&cand.at)
                .map(|at| at.to_rfc3339() < cutoff)
                .unwrap_or(true);
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM clipboard_items WHERE id = ?1)",
                params![cand.item_id],
                |r| Ok(r.get::<_, i64>(0)? != 0),
            )?;
            if expired || !exists || cand.boot != boot_id() {
                clear_candidate(conn)?;
            }
        }
        Ok(())
    })?;

    // 2) 保留期 + 条数上限 + 资产容量（收藏/置顶不参与）
    let (ids, freed, asset_paths) = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT i.id, i.last_seen_at, i.kind, i.byte_size,
                COALESCE((SELECT SUM(a.byte_size) FROM clipboard_assets a WHERE a.item_id = i.id), 0) AS asset_bytes
             FROM clipboard_items i WHERE i.favorite = 0 AND i.pinned = 0
             ORDER BY i.last_seen_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?;
        let mut rows_v = Vec::new();
        for r in rows {
            rows_v.push(r?);
        }
        let mut to_delete: HashSet<String> = HashSet::new();
        let mut freed = 0i64;
        let cutoff = now_cutoff(settings.clipboard_retention_days);
        for (id, last, _kind, _size, _asset) in &rows_v {
            if *last < cutoff {
                to_delete.insert(id.clone());
            }
        }
        // 条数上限：仅统计未被保留期命中的条目，删除最旧的超额部分
        let mut alive: Vec<&(String, String, String, i64, i64)> =
            rows_v.iter().filter(|r| !to_delete.contains(&r.0)).collect();
        let max = settings.clipboard_max_items.max(20) as usize;
        if alive.len() > max {
            for r in alive.drain(..alive.len() - max) {
                to_delete.insert(r.0.clone());
            }
        }
        // 存储上限：按最旧优先释放资产
        let total_assets: i64 = conn.query_row(
            "SELECT COALESCE(SUM(byte_size), 0) FROM clipboard_assets",
            [],
            |r| r.get(0),
        )?;
        let cap = settings.clipboard_max_storage_mb as i64 * 1024 * 1024;
        if total_assets > cap {
            let mut remaining = total_assets;
            let mut candidates: Vec<&(String, String, String, i64, i64)> = rows_v
                .iter()
                .filter(|r| !to_delete.contains(&r.0) && r.4 > 0)
                .collect();
            candidates.sort_by(|a, b| a.1.cmp(&b.1));
            for r in candidates {
                if remaining <= cap {
                    break;
                }
                remaining -= r.4;
                to_delete.insert(r.0.clone());
            }
        }
        for (id, _last, kind, size, asset) in &rows_v {
            if to_delete.contains(id) {
                freed += if kind == KIND_FILES { 0 } else { size + asset };
            }
        }
        let ids: Vec<String> = to_delete.into_iter().collect();
        let (deleted, paths) = delete_items_conn(conn, &ids)?;
        Ok((deleted, freed, paths))
    })?;
    report.items_deleted = ids;
    report.bytes_freed = freed + remove_files_unreferenced(db, root, asset_paths);

    // 3) 孤儿文件（应用崩溃/手工改库留下的无引用资产）
    report.orphan_files_removed = cleanup_orphan_files(db, root)?;
    Ok(report)
}

#[derive(Debug, Default, Clone, Copy)]
struct FilePurge {
    removed: i64,
    freed_bytes: i64,
    failed: i64,
}

/// 删除剪贴板根目录下所有「数据库已不再引用」的内部缓存文件。
///
/// 删除失败必须计数：数据库已经清空时，文件残留不能谎报为清理成功；
/// 下次清理会再尝试。只处理 `images/`、`thumbs/` 下的普通文件，
/// 绝不触碰外部路径指向的原始文件。
fn purge_orphan_files(db: &Db, root: &Path) -> AppResult<FilePurge> {
    let referenced: HashSet<String> = db.with_conn(|conn| {
        let mut stmt = conn.prepare("SELECT path FROM clipboard_assets")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut set = HashSet::new();
        for r in rows {
            set.insert(r?);
        }
        Ok(set)
    })?;
    let mut report = FilePurge::default();
    for sub in ["images", "thumbs"] {
        let dir = root.join(sub);
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            // 目录不存在（从未写入过该类资产）是正常情况，不计失败。
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            // 权限不足、路径被非目录占用等真实 IO 故障：不能假装已清理干净。
            // 计入失败数让调用方如实报告，并保留文件供下次清理重试。
            Err(e) => {
                report.failed += 1;
                tracing::warn!("剪贴板缓存目录读取失败（{}）：{}", sub, e.kind());
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                // 枚举过程中目录项消失属正常竞态；其它读取错误必须计入失败。
                Err(e) => {
                    report.failed += 1;
                    tracing::warn!("剪贴板缓存目录项读取失败（{}）：{}", sub, e.kind());
                    continue;
                }
            };
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(meta) => meta,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    report.failed += 1;
                    tracing::warn!("剪贴板缓存文件元数据读取失败：{}", e.kind());
                    continue;
                }
            };
            if !meta.is_file() {
                continue;
            }
            let rel = format!("{sub}/{}", entry.file_name().to_string_lossy());
            if referenced.contains(&rel) {
                continue;
            }
            match std::fs::remove_file(&path) {
                Ok(()) => {
                    report.removed += 1;
                    report.freed_bytes += meta.len() as i64;
                }
                // 文件已被其他维护动作删掉不算失败。
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    report.failed += 1;
                    tracing::warn!("剪贴板缓存文件删除失败：{}", e.kind());
                }
            }
        }
    }
    Ok(report)
}

fn cleanup_orphan_files(db: &Db, root: &Path) -> AppResult<i64> {
    Ok(purge_orphan_files(db, root)?.removed)
}

/// 清空全部剪贴板历史（用户显式操作，不可撤销）。
///
/// 与时间/容量清理不同：这里删除**全部**条目与分组，包括收藏、置顶、
/// 被任务或工作现场关联的内容；只解除剪贴板关联，任务与现场本身保留。
/// 数据库删除在单事务中完成，提交成功后才按实际引用关系清理内部缓存；
/// 系统剪贴板与外部原始文件完全不受影响。
pub fn clear_history(db: &Db, root: &Path) -> AppResult<ClearReport> {
    let (items, groups) = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let items: i64 = tx.query_row("SELECT COUNT(*) FROM clipboard_items", [], |r| r.get(0))?;
        let groups: i64 =
            tx.query_row("SELECT COUNT(*) FROM clipboard_groups", [], |r| r.get(0))?;
        // 任务/工作现场只解除指向剪贴板的关联，不删除任务或现场本身。
        tx.execute("DELETE FROM clipboard_task_links", [])?;
        tx.execute("DELETE FROM clipboard_snapshot_links", [])?;
        tx.execute("DELETE FROM clipboard_group_items", [])?;
        tx.execute("DELETE FROM clipboard_groups", [])?;
        tx.execute("DELETE FROM clipboard_assets", [])?;
        tx.execute("DELETE FROM clipboard_items", [])?;
        tx.commit()?;
        Ok((items, groups))
    })?;
    let purge = purge_orphan_files(db, root)?;
    // 清空历史后派生明文缓存必须一起消失，否则 OCR/另存留下的原图副本仍在盘上。
    purge_transient_assets(root);
    Ok(ClearReport {
        items,
        groups,
        freed_bytes: purge.freed_bytes,
        failed_files: purge.failed,
    })
}

// ── 资产读取（缩略图/大图 data URL）──────────────────────────

fn asset_rel(db: &Db, item_id: &str, role: &str) -> AppResult<Option<String>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT path FROM clipboard_assets WHERE item_id = ?1 AND role = ?2",
                params![item_id, role],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    })
}

fn png_data_url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// 读取资产并透明解密：兼容迁移前的明文 PNG 与批次 2 的容器密文。
///
/// 返回 `Zeroizing`，明文只在本调用栈内存在；缺密钥时 fail-closed（不返回密文）。
fn read_asset_plain(
    db: &Db,
    root: &Path,
    item_id: &str,
    role: &str,
) -> AppResult<Option<Zeroizing<Vec<u8>>>> {
    let Some(rel) = asset_rel(db, item_id, role)? else {
        return Ok(None);
    };
    let abs = asset_abs(root, &rel)?;
    let stored = match std::fs::read(&abs) {
        Ok(bytes) => bytes,
        // 缺图是正常状态（历史条目/清理后），不当作加密失败。
        Err(_) => return Ok(None),
    };
    Ok(Some(secure::decrypt_blob_if_encrypted(
        &secure::item_asset_aad(item_id, role),
        &stored,
    )?))
}

fn data_url(
    db: &Db,
    root: &Path,
    item_id: &str,
    role: &str,
    max_bytes: usize,
) -> AppResult<Option<String>> {
    let Some(plain) = read_asset_plain(db, root, item_id, role)? else {
        return Ok(None);
    };
    // 上限按解密后明文长度判定，避免密文头让边界判断偏移。
    if plain.len() > max_bytes {
        return Err(AppError::Validation("图片过大，无法内联预览".into()));
    }
    Ok(Some(png_data_url(&plain)))
}

pub fn thumb_data_url(db: &Db, root: &Path, item_id: &str) -> AppResult<Option<String>> {
    data_url(db, root, item_id, "thumb", 4 * 1024 * 1024)
}

/// 工作台预览图：最长边 640px，按需从原图生成并落盘缓存。
///
/// 为什么不直接用原图：列表卡片一次可见 10–20 张，原图 data URL 单条可达数十 MB，
/// 会同时压垮 IPC 与前端内存。为什么不直接放大 192px 缩略图：2× DPI 下 300px 宽
/// 显示会明显发虚。
///
/// - 缓存文件放 `thumbs/<id>-preview-640.png`，**不写 `clipboard_assets`**：
///   预览是纯派生缓存，缺失可重建，不参与引用计数，也不会让数据库迁移发生变化；
///   资源清理把它当孤立缩略图清掉是预期行为（下次访问自动重建）。
/// - 源图缺失、解码失败或超过 1600 万像素时回退缩略图，保证 UI 永远有可用图像，
///   不因预览失败把卡片变成空白。
/// - 写盘用唯一临时名 + rename，并发请求最多重复计算一次，不会读到半截文件。
pub fn preview_data_url(db: &Db, root: &Path, item_id: &str) -> AppResult<Option<String>> {
    let Some(rel) = asset_rel(db, item_id, "image")? else {
        return thumb_data_url(db, root, item_id);
    };
    let abs = asset_abs(root, &rel)?;
    if !abs.is_file() {
        return thumb_data_url(db, root, item_id);
    }
    let cache_rel = format!("thumbs/{item_id}-preview-{PREVIEW_MAX_EDGE}.png");
    let cache_abs = match asset_abs(root, &cache_rel) {
        Ok(path) => path,
        Err(_) => return thumb_data_url(db, root, item_id),
    };
    if let Ok(meta) = std::fs::metadata(&cache_abs) {
        let len = meta.len() as usize;
        // 密文缓存比明文多 28 字节头，上限留出余量后按解密结果再校验。
        if len > 0 && len <= PREVIEW_MAX_BYTES + 64 {
            if let Ok(stored) = std::fs::read(&cache_abs) {
                if let Ok(plain) = secure::decrypt_blob_if_encrypted(
                    &secure::item_asset_aad(item_id, PREVIEW_CACHE_ROLE),
                    &stored,
                ) {
                    if !plain.is_empty() && plain.len() <= PREVIEW_MAX_BYTES {
                        return Ok(Some(png_data_url(&plain)));
                    }
                }
            }
        }
    }
    let bytes = match read_asset_plain(db, root, item_id, "image") {
        Ok(Some(bytes)) => bytes,
        _ => return thumb_data_url(db, root, item_id),
    };
    let (rgba, width, height) = match image::decode_png_rgba(&bytes) {
        Ok(value) => value,
        Err(_) => return thumb_data_url(db, root, item_id),
    };
    if (width as u64) * (height as u64) > PREVIEW_MAX_SOURCE_PIXELS {
        return thumb_data_url(db, root, item_id);
    }
    let (preview_rgba, pw, ph) = image::resize_to_max_edge(&rgba, width, height, PREVIEW_MAX_EDGE);
    let png = image::encode_png(&preview_rgba, pw, ph)?;
    if png.len() <= PREVIEW_MAX_BYTES {
        if let Some(parent) = cache_abs.parent() {
            let _ = std::fs::create_dir_all(parent);
            let tmp = parent.join(format!(
                "{item_id}-preview-{PREVIEW_MAX_EDGE}.{}.tmp",
                uuid::Uuid::new_v4()
            ));
            // 派生缓存与历史数据同等级加密；密钥不可用时退回明文缓存（迁移前行为）。
            let cache_bytes = secure::maybe_encrypt_blob(
                &secure::item_asset_aad(item_id, PREVIEW_CACHE_ROLE),
                &png,
            )
            .unwrap_or_else(|_| png.clone());
            let ok = std::fs::write(&tmp, &cache_bytes).is_ok()
                && std::fs::rename(&tmp, &cache_abs).is_ok();
            if !ok {
                let _ = std::fs::remove_file(&tmp);
            }
        }
    }
    Ok(Some(png_data_url(&png)))
}

pub fn image_data_url(db: &Db, root: &Path, item_id: &str) -> AppResult<Option<String>> {
    data_url(db, root, item_id, "image", 40 * 1024 * 1024)
}

pub fn image_png(db: &Db, root: &Path, item_id: &str) -> Option<Vec<u8>> {
    read_asset_plain(db, root, item_id, "image")
        .ok()
        .flatten()
        .map(|bytes| bytes.to_vec())
}

/// 需要“明文文件路径”的消费方（OCR/另存/外发）专用：密文资产按需解密到
/// `transient/` 派生目录并返回该路径；明文资产直接返回原路径。
///
/// 这是过渡接口：明文缓存只服务于必须读文件的旧调用链，启动、删除、清空历史
/// 都会清理；后续批次应改为直接消费字节流，彻底取消明文落地。
pub fn image_abs_path(db: &Db, root: &Path, item_id: &str) -> Option<PathBuf> {
    let rel = asset_rel(db, item_id, "image").ok()??;
    materialize_plain_image(root, item_id, &rel)
}

/// 密文资产解密并落到 `transient/`；明文资产直接返回原路径。
fn materialize_plain_image(root: &Path, item_id: &str, rel: &str) -> Option<PathBuf> {
    let abs = asset_abs(root, &rel.to_owned()).ok()?;
    let stored = std::fs::read(&abs).ok()?;
    if !secure::is_encrypted_blob(&stored) {
        return Some(abs);
    }
    let plain = secure::decrypt_blob_if_encrypted(
        &secure::item_asset_aad(item_id, "image"),
        &stored,
    )
    .ok()?;
    let dir = root.join("transient");
    std::fs::create_dir_all(&dir).ok()?;
    let target = dir.join(format!("{item_id}-image.png"));
    let tmp = dir.join(format!("{item_id}-image-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, plain.as_slice()).ok()?;
    std::fs::rename(&tmp, &target)
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
        .ok()?;
    Some(target)
}

/// 清理 `transient/` 派生明文缓存（启动/清空历史后调用）。
pub fn purge_transient_assets(root: &Path) -> usize {
    let dir = root.join("transient");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// 删除指定条目的派生明文缓存（不触碰其他条目）。
fn remove_transient_for(root: &Path, ids: &[String]) {
    let dir = root.join("transient");
    for id in ids {
        let _ = std::fs::remove_file(dir.join(format!("{id}-image.png")));
    }
}

/// 供工作篮仅持连接时读取剪贴板条目（不重复实现行映射）。
pub fn get_item_by_conn(conn: &Connection, item_id: &str) -> AppResult<ClipboardItem> {
    conn.query_row(
        &format!("SELECT {ITEM_FIELDS} FROM clipboard_items i WHERE i.id = ?1"),
        params![item_id],
        map_item,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("剪贴板条目不存在".into()))
}

/// 供工作篮规划/执行阶段解析图片缓存路径（连接 + 缓存根，不构造第二套存储）。
pub fn image_abs_path_by_conn(
    conn: &Connection,
    root: &Path,
    item_id: &str,
) -> Option<PathBuf> {
    let rel: Option<String> = conn
        .query_row(
            "SELECT path FROM clipboard_assets WHERE item_id = ?1 AND role = 'image'",
            params![item_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    let rel = rel?;
    materialize_plain_image(root, item_id, &rel)
}

/// 条目内容哈希：OCR 结果缓存的第二重身份（与条目 id 组合），内容变化即失效。
/// 只返回哈希，不返回正文或像素。
pub fn content_hash(db: &Db, item_id: &str) -> AppResult<Option<String>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT content_hash FROM clipboard_items WHERE id = ?1",
                params![item_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clipboard::CapturedImage;

    struct TempRoot(PathBuf);
    impl TempRoot {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("td-clip-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn settings() -> Settings {
        Settings::default()
    }

    fn text_payload(text: &str) -> CapturedContent {
        CapturedContent {
            kind: "text".into(),
            text: text.into(),
            html: String::new(),
            preview: String::new(),
            file_paths: vec![],
            image: None,
            source_app: "notepad.exe".into(),
            source_title: "记事本".into(),
            source_kind: "owner".into(),
            byte_size: 0,
        }
    }

    /// 加密用例共用 `secure::TEST_LOCK`：CEK 进程缓存是全局的，跨模块并行会互相覆盖。

    fn raw_item_text(db: &Db, id: &str) -> String {
        raw_item_field(db, id, "text")
    }

    fn raw_item_field(db: &Db, id: &str, field: &str) -> String {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                &format!("SELECT {field} FROM clipboard_items WHERE id = ?1"),
                params![id],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap()
    }

    #[test]
    fn encrypt_history_off_keeps_plaintext_body() {
        let _guard = secure::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        secure::reset_cache();
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        let root = tmp.0.join("clipboard");
        let s = settings();
        assert!(!s.clipboard_encrypt_history, "默认必须保持迁移前明文行为");
        let out = record_capture(&db, &root, &text_payload("默认明文正文"), &s).unwrap();
        assert_eq!(raw_item_text(&db, &out.item.id), "默认明文正文");
        assert_eq!(get_item(&db, &out.item.id).unwrap().text, "默认明文正文");
    }

    #[cfg(windows)]
    #[test]
    fn encrypt_history_on_writes_ciphertext_and_reads_plaintext() {
        let _guard = secure::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        secure::reset_cache();
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        let root = tmp.0.join("clipboard");
        let mut s = settings();
        s.clipboard_encrypt_history = true;
        let sentinel = "TDCLIP-STORE-SENTINEL-7c1d";
        let mut payload = text_payload(sentinel);
        payload.html = format!("<p>{sentinel}</p>");
        let out = record_capture(&db, &root, &payload, &s).unwrap();

        let raw = raw_item_text(&db, &out.item.id);
        assert!(raw.starts_with("tdcl1:"), "落库必须是密文前缀");
        assert!(!raw.contains(sentinel), "库内不得出现明文哨兵");
        // 元数据与正文同批加密：preview/title/source_*/file_paths 不得留下明文。
        for field in [
            "preview",
            "title",
            "source_app",
            "source_title",
            "file_paths",
        ] {
            let raw = raw_item_field(&db, &out.item.id, field);
            assert!(
                raw.starts_with("tdcl1:"),
                "{field} 落库必须加密，实际: {raw}"
            );
            assert!(!raw.contains(sentinel), "{field} 不得出现明文哨兵");
        }
        assert_eq!(out.item.text, sentinel, "返回给上层的条目必须已解密");
        assert_eq!(get_item(&db, &out.item.id).unwrap().html, payload.html);
        let item = get_item(&db, &out.item.id).unwrap();
        assert_eq!(item.preview, out.item.preview, "preview 读取必须解密");
        assert_eq!(item.source_app, out.item.source_app, "来源读取必须解密");
        // 搜索改为“解密后过滤”：preview 已加密也能命中，且不泄露整段密文。
        let page = list_items(
            &db,
            &ClipboardFilter {
                search: Some("TDCLIP-STORE".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(page.iter().any(|i| i.id == out.item.id), "搜索必须仍能命中");
        assert!(page.iter().all(|i| !i.text.starts_with("tdcl1:")));
        assert!(page
            .iter()
            .all(|i| !i.preview.starts_with("tdcl1:") && !i.title.starts_with("tdcl1:")));

        // 来源筛选与来源聚合也必须先解密：不能拿密文做 SQL 等值/分组。
        let by_source = ClipboardFilter {
            source_app: Some(out.item.source_app.clone()),
            ..Default::default()
        };
        let source_hits = list_items(&db, &by_source).unwrap();
        assert!(source_hits.iter().any(|i| i.id == out.item.id));
        assert_eq!(count_items(&db, &by_source).unwrap(), 1);
        let sources = list_source_apps(&db, 8).unwrap();
        assert!(
            sources.iter().all(|s| !s.app.starts_with("tdcl1:")),
            "来源聚合不得返回密文"
        );
        assert!(sources
            .iter()
            .any(|s| s.app == out.item.source_app && s.count == 1));

        // 分组封面 preview 来自成员条目，也必须解密；分组搜索依赖成员解密结果。
        let group = create_manual_group(&db, "加密分组", &[out.item.id.clone()]).unwrap();
        let group = get_group(&db, &group.id).unwrap();
        assert!(
            !group.preview.starts_with("tdcl1:"),
            "分组预览不得是密文: {}",
            group.preview
        );
        let groups = list_groups(
            &db,
            &ClipboardFilter {
                search: Some("TDCLIP-STORE".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            groups.iter().any(|g| g.id == group.id),
            "成员条目命中时分组也必须命中"
        );
        // 去重依赖明文哈希：同一内容再次采集仍是同一行。
        let again = record_capture(&db, &root, &payload, &s).unwrap();
        assert!(!again.created);
        assert_eq!(again.item.id, out.item.id);
    }

    #[cfg(windows)]
    #[test]
    fn encrypted_history_reads_back_after_restart_with_empty_cache() {
        let _guard = secure::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        secure::reset_cache();
        let tmp = TempRoot::new();
        let db_path = tmp.0.join("app.db");
        let root = tmp.0.join("clipboard");
        let mut s = settings();
        s.clipboard_encrypt_history = true;
        let id = {
            let db = Db::open(&db_path).unwrap();
            let out = record_capture(&db, &root, &text_payload("重启后仍可读"), &s).unwrap();
            out.item.id
        };
        // 模拟进程重启：清空内存缓存后重新打开库，必须能按信封重新解封装。
        secure::reset_cache();
        let db = Db::open(&db_path).unwrap();
        secure::prime_cache(&db).unwrap();
        assert_eq!(get_item(&db, &id).unwrap().text, "重启后仍可读");
    }

    #[cfg(windows)]
    #[test]
    fn encrypted_history_fails_closed_when_envelope_is_gone() {
        let _guard = secure::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        secure::reset_cache();
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        let root = tmp.0.join("clipboard");
        let mut s = settings();
        s.clipboard_encrypt_history = true;
        let out = record_capture(&db, &root, &text_payload("密钥丢失场景"), &s).unwrap();
        // 信封被删（用户配置损坏/误删）：不得把密文当正文返回。
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM application_settings WHERE key = ?1",
                params![secure::ENVELOPE_SETTING_KEY],
            )?;
            Ok(())
        })
        .unwrap();
        secure::reset_cache();
        let err = get_item(&db, &out.item.id).unwrap_err();
        assert!(matches!(err, AppError::Db(_)), "读取必须整体失败: {err}");
    }

    #[cfg(windows)]
    #[test]
    fn encrypt_history_on_encrypts_image_assets_and_reads_them_back() {
        let _guard = secure::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        secure::reset_cache();
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        let root = tmp.0.join("clipboard");
        let mut s = settings();
        s.clipboard_encrypt_history = true;
        let out = record_capture(&db, &root, &solid_image([12, 34, 56, 255], 8, 6), &s).unwrap();
        let id = out.item.id.clone();

        // 落盘必须是容器密文，且不再能当 PNG 解码。
        let raw = std::fs::read(root.join("images").join(format!("{id}.png"))).unwrap();
        assert!(secure::is_encrypted_blob(&raw), "原图必须为密文容器");
        assert!(
            crate::clipboard::image::decode_png_rgba(&raw).is_err(),
            "密文不得被当作合法 PNG"
        );
        let raw_thumb = std::fs::read(root.join("thumbs").join(format!("{id}.png"))).unwrap();
        assert!(secure::is_encrypted_blob(&raw_thumb), "缩略图必须为密文容器");

        // 读取路径透明解密：字节可解码，data URL 可用。
        let png = image_png(&db, &root, &id).expect("原图必须可读");
        assert_eq!(&png[..4], b"\x89PNG");
        let url = image_data_url(&db, &root, &id).unwrap().expect("应能内联");
        assert!(url.starts_with("data:image/png;base64,"));
        assert!(thumb_data_url(&db, &root, &id).unwrap().is_some());

        // 需要文件路径的旧消费方拿到的是 transient 明文副本，可被清理。
        let path = image_abs_path(&db, &root, &id).expect("应能解出明文路径");
        assert!(path.starts_with(root.join("transient")));
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], b"\x89PNG");
        assert!(purge_transient_assets(&root) >= 1);
        assert!(!path.exists(), "启动/清空后不得残留明文副本");
        // 暂存架快照不能把资产容器密文当 PNG：必须走解密后的字节。
        match crate::shelf::snapshot_clipboard_item(&db, &root, &id).unwrap() {
            crate::shelf::ClipboardSnapshot::ImagePng { png } => {
                assert_eq!(&png[..4], b"\x89PNG", "快照必须是可解码 PNG")
            }
            _ => panic!("图片快照类型不符，未返回解密 PNG"),
        }
        // 删除条目时同样清理。
        let _ = image_abs_path(&db, &root, &id);
        delete_items(&db, &root, &[id.clone()]).unwrap();
        assert!(!root
            .join("transient")
            .join(format!("{id}-image.png"))
            .exists());
    }

    #[test]
    fn legacy_plaintext_image_assets_stay_plaintext_and_path_is_original() {
        let _guard = secure::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        secure::reset_cache();
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        let root = tmp.0.join("clipboard");
        let s = settings();
        let out = record_capture(&db, &root, &solid_image([7, 8, 9, 255], 5, 4), &s).unwrap();
        let id = out.item.id.clone();
        let abs = root.join("images").join(format!("{id}.png"));
        let raw = std::fs::read(&abs).unwrap();
        assert_eq!(&raw[..4], b"\x89PNG", "默认必须保持迁移前明文 PNG");
        assert_eq!(image_abs_path(&db, &root, &id).unwrap(), abs);
        assert!(image_data_url(&db, &root, &id).unwrap().is_some());
    }

    #[cfg(windows)]
    #[test]
    fn preview_cache_is_encrypted_and_reused() {
        let _guard = secure::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        secure::reset_cache();
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        let root = tmp.0.join("clipboard");
        let mut s = settings();
        s.clipboard_encrypt_history = true;
        let out = record_capture(&db, &root, &solid_image([90, 120, 150, 255], 40, 30), &s).unwrap();
        let id = out.item.id.clone();

        let first = preview_data_url(&db, &root, &id).unwrap().expect("应有预览");
        let cache = root
            .join("thumbs")
            .join(format!("{id}-preview-{PREVIEW_MAX_EDGE}.png"));
        assert!(cache.exists(), "预览缓存应已落盘");
        let stored = std::fs::read(&cache).unwrap();
        assert!(secure::is_encrypted_blob(&stored), "派生缓存必须加密");
        let second = preview_data_url(&db, &root, &id).unwrap().expect("缓存应可读");
        assert_eq!(first, second, "密文缓存解密后必须与首次结果一致");
    }

    fn url_payload(url: &str) -> CapturedContent {
        CapturedContent {
            kind: "url".into(),
            text: url.into(),
            html: String::new(),
            preview: String::new(),
            file_paths: vec![],
            image: None,
            source_app: "chrome.exe".into(),
            source_title: "浏览器".into(),
            source_kind: "owner".into(),
            byte_size: 0,
        }
    }

    fn files_payload(paths: &[&str]) -> CapturedContent {
        CapturedContent {
            kind: "files".into(),
            text: String::new(),
            html: String::new(),
            preview: String::new(),
            file_paths: paths.iter().map(|p| p.to_string()).collect(),
            image: None,
            source_app: "explorer.exe".into(),
            source_title: "文件资源管理器".into(),
            source_kind: "owner".into(),
            byte_size: 0,
        }
    }

    fn from_unknown_source(mut p: CapturedContent) -> CapturedContent {
        p.source_app = String::new();
        p.source_title = String::new();
        p.source_kind = "unknown".into();
        p
    }

    fn image_payload(color: u8) -> CapturedContent {
        let (w, h) = (40u32, 30u32);
        let rgba: Vec<u8> = (0..(w * h))
            .flat_map(|i| [color, (i % 200) as u8, 90, 255])
            .collect();
        let img = CapturedImage {
            png: image::encode_png(&rgba, w, h).unwrap(),
            width: w,
            height: h,
            rgba,
        };
        CapturedContent {
            kind: "image".into(),
            text: String::new(),
            html: String::new(),
            preview: String::new(),
            file_paths: vec![],
            image: Some(img),
            source_app: "snippingtool.exe".into(),
            source_title: "截图工具".into(),
            source_kind: "owner".into(),
            byte_size: 0,
        }
    }

    fn solid_image(rgba_color: [u8; 4], w: u32, h: u32) -> CapturedContent {
        let rgba: Vec<u8> = rgba_color
            .iter()
            .copied()
            .cycle()
            .take((w * h * 4) as usize)
            .collect();
        let img = CapturedImage {
            png: image::encode_png(&rgba, w, h).unwrap(),
            width: w,
            height: h,
            rgba,
        };
        CapturedContent {
            kind: "image".into(),
            text: String::new(),
            html: String::new(),
            preview: String::new(),
            file_paths: vec![],
            image: Some(img),
            source_app: "snippingtool.exe".into(),
            source_title: "截图工具".into(),
            source_kind: "owner".into(),
            byte_size: 0,
        }
    }

    #[test]
    fn red_green_text_blue_group_survives_restart_with_exact_pixels() {
        let tmp = TempRoot::new();
        let db_path = tmp.0.join("app.db");
        let root = tmp.0.join("clipboard");
        let mut s = settings();
        s.clipboard_group_window_secs = 45;
        let mut mid_text = text_payload("中间文本 C");
        // 「截图 A→文字说明→截图 B」：说明文字与截图来自同一应用会话时必须保留顺序
        mid_text.source_app = "snippingtool.exe".into();
        let payloads = [
            solid_image([220, 40, 40, 255], 37, 23),
            solid_image([40, 180, 80, 255], 53, 31),
            mid_text,
            solid_image([40, 80, 220, 255], 61, 17),
        ];

        let (group_id, ids) = {
            let db = Db::open(&db_path).unwrap();
            let mut group_id: Option<String> = None;
            let mut ids = Vec::new();
            for p in &payloads {
                let out = record_capture(&db, &root, p, &s).unwrap();
                assert!(out.created, "四种内容互不相同，必须各建一条");
                if p.kind == "image" {
                    group_id = group_id.or(out.group_id);
                }
                ids.push(out.item.id);
            }
            (group_id.expect("首张图片应建组"), ids)
        };

        // 模拟重启：关闭数据库后重新打开，顺序/分组/像素/哈希必须全部持久化。
        let db = Db::open(&db_path).unwrap();
        let g = get_group(&db, &group_id).unwrap();
        assert_eq!(g.items.len(), 4);
        assert_eq!(
            g.items.iter().map(|i| i.kind.as_str()).collect::<Vec<_>>(),
            vec!["image", "image", "text", "image"],
            "A/B/C/D 的实际复制顺序不得被分组打乱"
        );
        assert_eq!(g.image_count, 3);
        assert_eq!(
            g.items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            ids.iter().map(|s| s.as_str()).collect::<Vec<_>>()
        );

        let expected = [
            ([220u8, 40, 40, 255], 37u32, 23u32),
            ([40, 180, 80, 255], 53, 31),
            ([0, 0, 0, 0], 0, 0),
            ([40, 80, 220, 255], 61, 17),
        ];
        for (idx, (color, w, h)) in expected.iter().enumerate() {
            let item = &g.items[idx];
            if item.kind == "text" {
                assert_eq!(item.text, "中间文本 C");
                continue;
            }
            let png = image_png(&db, &root, &item.id).expect("原图必须落盘");
            let (rgba, pw, ph) = image::decode_png_rgba(&png).unwrap();
            assert_eq!((pw, ph), (*w, *h), "第 {} 张图片尺寸不符", idx + 1);
            assert_eq!(item.image_width, Some(*w));
            assert_eq!(item.image_height, Some(*h));
            assert_eq!(&rgba[0..4], color.as_slice());
            assert_eq!(&rgba[rgba.len() - 4..], color.as_slice());
            assert!(
                rgba.chunks_exact(4).all(|px| px == color.as_slice()),
                "纯色图片的所有像素必须保持原色（含 Alpha）"
            );
            let (hash, byte_size): (String, i64) = db
                .with_conn(|conn| {
                    Ok(conn.query_row(
                        "SELECT content_hash, byte_size FROM clipboard_items WHERE id = ?1",
                        params![item.id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )?)
                })
                .unwrap();
            assert_eq!(hash, engine::hash_of(&normalize(&payloads[idx])));
            assert_eq!(
                byte_size,
                png.len() as i64,
                "记录的文件大小必须是真实 PNG 字节数"
            );
        }
    }

    fn task(db: &Db, id: &str) {
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?1, '任务', 'now', 'now')",
                params![id],
            )?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn records_text_and_dedupes_without_new_row() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let a = record_capture(&db, &root.0, &text_payload("你好"), &settings()).unwrap();
        assert!(a.created);
        assert_eq!(a.item.kind, "text");
        assert_eq!(a.item.preview, "你好");
        let b = record_capture(&db, &root.0, &text_payload("你好"), &settings()).unwrap();
        assert!(!b.created);
        assert_eq!(b.item.copy_count, 2);
        let items = list_items(&db, &ClipboardFilter::default()).unwrap();
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn filters_by_source_recent_window_and_usage_sort() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let old = record_capture(&db, &root.0, &text_payload("旧但常用"), &s).unwrap();
        let chrome = record_capture(&db, &root.0, &url_payload("https://example.com/a"), &s).unwrap();
        db.with_conn(|c| {
            c.execute(
                "UPDATE clipboard_items SET last_seen_at = ?1 WHERE id = ?2",
                params!["2020-01-01T00:00:00Z", old.item.id],
            )?;
            c.execute(
                "UPDATE clipboard_items SET last_seen_at = ?1 WHERE id = ?2",
                params![crate::agents::now_iso(), chrome.item.id],
            )?;
            Ok(())
        })
        .unwrap();
        bump_copy(&db, &old.item.id).unwrap();
        bump_copy(&db, &old.item.id).unwrap();

        let source_filter = ClipboardFilter {
            source_app: Some("chrome.exe".into()),
            ..Default::default()
        };
        let hits = list_items(&db, &source_filter).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, chrome.item.id);
        assert_eq!(count_items(&db, &source_filter).unwrap(), 1);

        let recent = ClipboardFilter {
            recent_days: Some(7),
            ..Default::default()
        };
        let hits = list_items(&db, &recent).unwrap();
        assert_eq!(hits.len(), 1, "2020 年的旧条目必须被时间窗口排除");
        assert_eq!(hits[0].id, chrome.item.id);

        let most_used = ClipboardFilter {
            sort: Some("most_used".into()),
            ..Default::default()
        };
        let hits = list_items(&db, &most_used).unwrap();
        assert_eq!(hits[0].id, old.item.id, "使用次数排序应把旧但常用条目放前");
        assert_eq!(hits[1].id, chrome.item.id);
    }

    #[test]
    fn source_options_merge_case_and_filter_matches_nocase() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let mut upper = text_payload("大小写来源");
        upper.source_app = "NOTEPAD.EXE".into();
        let item = record_capture(&db, &root.0, &upper, &s).unwrap();

        let filter = ClipboardFilter {
            source_app: Some("notepad.exe".into()),
            ..Default::default()
        };
        let hits = list_items(&db, &filter).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, item.item.id);

        let sources = list_source_apps(&db, 8).unwrap();
        assert_eq!(sources.len(), 1, "大小写不同的同一进程只保留一个来源项");
        assert_eq!(sources[0].count, 1);
        assert_eq!(sources[0].app.to_lowercase(), "notepad.exe");
    }

    #[test]
    fn screenshot_group_name_uses_source_then_text_and_protects_manual_rename() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_group_window_secs = 45;

        // 来源标题不可靠 → 时间兜底命名
        let mut img = solid_image([200, 100, 40, 255], 30, 20);
        img.source_title = String::new();
        let first = record_capture(&db, &root.0, &img, &s).unwrap();
        assert!(first.group_id.is_none(), "首条截图只成为候选");
        // 标题、来源标题与摘要都不可靠时，候选没有可用主题。
        db.with_conn(|c| {
            c.execute(
                "UPDATE clipboard_items SET title = '', preview = '' WHERE id = ?1",
                params![first.item.id],
            )?;
            Ok(())
        })
        .unwrap();
        let second = record_capture(&db, &root.0, &image_payload(2), &s).unwrap();
        let gid = second.group_id.expect("同来源的第二张截图应建组");
        let g = get_group(&db, &gid).unwrap();
        assert!(
            g.name.starts_with("截图 · "),
            "不得再使用「截图组 N」: {}",
            g.name
        );
        assert!(!g.name.contains("截图组"), "{}", g.name);

        // 关联文本主题优先于时间兜底
        let mut note = text_payload("版本评审记录\n第二行");
        note.source_app = "snippingtool.exe".into();
        record_capture(&db, &root.0, &note, &s).unwrap();
        let g = get_group(&db, &gid).unwrap();
        assert_eq!(g.name, "截图 · 版本评审记录");

        // 用户手动改名后，后续自动命名绝不覆盖
        rename_group(&db, &gid, "我的评审截图").unwrap();
        let mut later = text_payload("补充说明");
        later.source_app = "snippingtool.exe".into();
        record_capture(&db, &root.0, &later, &s).unwrap();
        assert_eq!(get_group(&db, &gid).unwrap().name, "我的评审截图");
    }

    #[test]
    fn copy_bump_counts_usage_without_reordering_history() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let old = record_capture(&db, &root.0, &text_payload("旧内容"), &s).unwrap();
        let newest = record_capture(&db, &root.0, &text_payload("新内容"), &s).unwrap();
        // 固定时间，避免断言依赖两次 record_capture 的纳秒差
        db.with_conn(|c| {
            c.execute(
                "UPDATE clipboard_items SET last_seen_at = ?1 WHERE id = ?2",
                params!["2026-01-01T00:00:00Z", old.item.id],
            )?;
            c.execute(
                "UPDATE clipboard_items SET last_seen_at = ?1 WHERE id = ?2",
                params!["2026-01-02T00:00:00Z", newest.item.id],
            )?;
            Ok(())
        })
        .unwrap();

        bump_copy(&db, &old.item.id).unwrap();
        let items = list_items(&db, &ClipboardFilter::default()).unwrap();
        assert_eq!(items[0].id, newest.item.id, "复制旧条目不得改变排序");
        assert_eq!(items[1].id, old.item.id);
        assert_eq!(
            items[1].copy_count,
            old.item.copy_count + 1,
            "使用次数仍要累加"
        );
        assert_eq!(
            items[1].last_seen_at, "2026-01-01T00:00:00Z",
            "复制是使用操作，不得把 last_seen_at 当作新的采集时间"
        );
    }

    #[test]
    fn clear_history_removes_items_groups_links_and_internal_assets() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;

        // 外部原始文件：清空历史绝不能删除它（不在剪贴板缓存目录内）
        let external =
            std::env::temp_dir().join(format!("td-clip-external-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&external, b"original").unwrap();
        let mut file_payload = text_payload("");
        file_payload.kind = "files".into();
        file_payload.file_paths = vec![external.to_string_lossy().into_owned()];

        let text = record_capture(&db, &root.0, &text_payload("收藏内容"), &s).unwrap();
        toggle_item_flag(&db, &text.item.id, "favorite").unwrap();
        let image = record_capture(&db, &root.0, &image_payload(9), &s).unwrap();
        toggle_item_flag(&db, &image.item.id, "pinned").unwrap();
        record_capture(&db, &root.0, &file_payload, &s).unwrap();
        let group = create_manual_group(
            &db,
            "测试分组",
            &[text.item.id.clone(), image.item.id.clone()],
        )
        .unwrap();

        task(&db, "t1");
        link_task(&db, "t1", "item", &text.item.id).unwrap();
        link_task(&db, "t1", "group", &group.id).unwrap();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO workspace_snapshots
                 (id, name, note, source, item_count, created_at, updated_at)
                 VALUES ('w1', '现场', '', 'manual', 0, 'now', 'now')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        link_snapshot(&db, "w1", "item", &text.item.id).unwrap();

        let rel_image = asset_rel(&db, &image.item.id, "image").unwrap().unwrap();
        let abs_image = asset_abs(&root.0, &rel_image).unwrap();
        let rel_thumb = asset_rel(&db, &image.item.id, "thumb").unwrap().unwrap();
        let abs_thumb = asset_abs(&root.0, &rel_thumb).unwrap();
        assert!(abs_image.exists() && abs_thumb.exists());

        let report = clear_history(&db, &root.0).unwrap();
        assert_eq!(report.items, 3, "全部条目都要删除，而不是只删当前页");
        assert_eq!(report.groups, 1);
        assert!(report.freed_bytes > 0);
        assert_eq!(report.failed_files, 0);

        assert_eq!(count_items(&db, &ClipboardFilter::default()).unwrap(), 0);
        let stats_now = stats(&db, &s).unwrap();
        assert_eq!(stats_now.items, 0);
        assert_eq!(stats_now.groups, 0);
        assert!(!abs_image.exists(), "失去引用的原图缓存必须清理");
        assert!(!abs_thumb.exists(), "失去引用的缩略图缓存必须清理");
        assert!(external.exists(), "外部原始文件绝不能被删除");
        assert!(
            task_links(&db, "t1").unwrap().is_empty(),
            "只解除剪贴板关联"
        );
        assert!(snapshot_links(&db, "w1").unwrap().is_empty());
        let tasks: i64 = db
            .with_conn(|c| Ok(c.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(tasks, 1, "任务本身不得被删除");
        let snapshots: i64 = db
            .with_conn(|c| {
                Ok(c.query_row("SELECT COUNT(*) FROM workspace_snapshots", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(snapshots, 1, "工作现场本身不得被删除");
        assert!(
            Settings::load_clipboard(&db).settings.clipboard_enabled,
            "应用设置不属于剪贴板历史，必须保留"
        );
        let _ = std::fs::remove_file(&external);
    }

    #[test]
    fn clear_history_is_idempotent_on_empty_store() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let first = clear_history(&db, &root.0).unwrap();
        assert_eq!(first.items, 0);
        assert_eq!(first.groups, 0);
        let second = clear_history(&db, &root.0).unwrap();
        assert_eq!(second.items, 0);
        assert_eq!(second.groups, 0);
        // 从未创建过 images/thumbs 目录属正常情况，不得计为失败
        assert_eq!(first.failed_files, 0);
        assert_eq!(second.failed_files, 0);
    }

    #[test]
    fn purge_orphan_files_reports_directory_io_error_and_keeps_cleaning_others() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        // images 被普通文件占用：read_dir 返回真实 IO 错误（非 NotFound），
        // 不能被静默跳过，否则调用方会误以为缓存已全部清理。
        std::fs::write(root.0.join("images"), b"not a directory").unwrap();
        std::fs::create_dir_all(root.0.join("thumbs")).unwrap();
        let orphan = root.0.join("thumbs").join("orphan.png");
        std::fs::write(&orphan, b"cache").unwrap();

        let purge = purge_orphan_files(&db, &root.0).unwrap();
        assert!(
            purge.failed >= 1,
            "目录读取失败必须计入 failed，实际 failed={}",
            purge.failed
        );
        assert_eq!(purge.removed, 1, "其它可读目录仍要正常清理");
        assert!(!orphan.exists());

        // 失败可重试：修好目录后再次清理，不再报告目录级失败。
        std::fs::remove_file(root.0.join("images")).unwrap();
        std::fs::create_dir_all(root.0.join("images")).unwrap();
        let again = purge_orphan_files(&db, &root.0).unwrap();
        assert_eq!(again.failed, 0);
    }

    #[test]
    fn purge_orphan_files_keeps_referenced_assets() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let image = record_capture(&db, &root.0, &image_payload(3), &s).unwrap();
        let rel = asset_rel(&db, &image.item.id, "image").unwrap().unwrap();
        let abs = asset_abs(&root.0, &rel).unwrap();
        assert!(abs.exists());

        let purge = purge_orphan_files(&db, &root.0).unwrap();
        assert_eq!(purge.removed, 0);
        assert_eq!(purge.failed, 0);
        assert!(abs.exists(), "仍被数据库引用的缓存文件绝不能被当成孤儿删除");
    }

    #[test]
    fn interleaved_text_keeps_screenshot_group_order() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_group_window_secs = 45;
        let first = record_capture(&db, &root.0, &image_payload(1), &s).unwrap();
        assert!(first.group_id.is_none(), "首张截图只成为候选");
        let mut note1 = text_payload("第一段说明");
        note1.source_app = "snippingtool.exe".into();
        let gid = record_capture(&db, &root.0, &note1, &s)
            .unwrap()
            .group_id
            .expect("第二项应与候选一起建组");
        record_capture(&db, &root.0, &image_payload(2), &s).unwrap();
        let mut note2 = text_payload("第二段说明");
        note2.source_app = "snippingtool.exe".into();
        record_capture(&db, &root.0, &note2, &s).unwrap();
        let g = get_group(&db, &gid).unwrap();
        assert_eq!(g.items.len(), 4);
        let kinds: Vec<&str> = g.items.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(
            kinds,
            vec!["image", "text", "image", "text"],
            "必须保留实际顺序"
        );
        assert_eq!(g.image_count, 2);
        assert_eq!(g.mode, "auto");
        assert_eq!(g.status, "collecting");
    }

    #[test]
    fn cross_source_text_stays_in_group_but_foreign_image_starts_new_session() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_group_window_secs = 45;
        let first = record_capture(&db, &root.0, &image_payload(1), &s).unwrap();
        assert!(first.group_id.is_none(), "首张截图只成为候选");

        // 「截图 A → 文字 → 截图 B」：文字来自其他应用也必须留在截图流里，
        // 不能用来源应用把用户真实顺序拆散。
        let mut note = text_payload("来自其他应用的说明文字");
        note.source_app = "chrome.exe".into();
        let out = record_capture(&db, &root.0, &note, &s).unwrap();
        let gid = out.group_id.clone().expect("第二项应与候选一起建组");
        assert!(out.created);
        assert_eq!(
            out.group_id.as_deref(),
            Some(gid.as_str()),
            "跨来源文本必须并入当前截图组，保持实际顺序"
        );

        let mut unknown_src = text_payload("来源未知的说明");
        unknown_src.source_app = String::new();
        let out2 = record_capture(&db, &root.0, &unknown_src, &s).unwrap();
        assert_eq!(out2.group_id.as_deref(), Some(gid.as_str()));

        // 同来源的下一条截图继续追加
        let c = record_capture(&db, &root.0, &image_payload(2), &s).unwrap();
        assert_eq!(c.group_id.as_deref(), Some(gid.as_str()));
        let g = get_group(&db, &gid).unwrap();
        assert_eq!(g.items.len(), 4);
        assert_eq!(
            g.items.iter().map(|i| i.kind.as_str()).collect::<Vec<_>>(),
            vec!["image", "text", "text", "image"]
        );
        assert_eq!(g.image_count, 2);

        // 另一张图片且来源明确不同 → 先成为候选，不进入当前截图组
        let mut foreign = image_payload(3);
        foreign.source_app = "chrome.exe".into();
        let d = record_capture(&db, &root.0, &foreign, &s).unwrap();
        assert!(
            d.group_id.is_none(),
            "异来源图片先成为候选，不得混入当前截图组"
        );
        let old = get_group(&db, &gid).unwrap();
        assert_eq!(old.items.len(), 4, "旧截图组的顺序与内容不得被改变");
        assert!(
            old.items.iter().all(|i| i.id != d.item.id),
            "异来源图片不得进入旧组"
        );
        // 旧会话结束后，同来源的下一条图片与候选一起成组。
        close_group(&db, &gid).unwrap();
        let mut foreign2 = image_payload(4);
        foreign2.source_app = "chrome.exe".into();
        let e = record_capture(&db, &root.0, &foreign2, &s).unwrap();
        let new_gid = e.group_id.expect("同来源的第二张图片应与候选成组");
        assert_ne!(new_gid, gid, "不同来源的图片不得混入同一截图组");
        let old = get_group(&db, &gid).unwrap();
        assert_eq!(old.status, "closed", "旧截图会话必须结束");
        let new = get_group(&db, &new_gid).unwrap();
        assert_eq!(new.items.len(), 2);
    }

    #[test]
    fn auto_title_lifecycle_and_search() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let a = record_capture(&db, &root.0, &text_payload("第一条说明文字"), &s).unwrap();
        assert_eq!(a.item.title_source, "auto");
        assert!(!a.item.title.is_empty(), "文本采集时应生成自动标题");

        // 手动标题：非空 → manual
        let renamed = rename_item(&db, &a.item.id, "  我的手动标题  ").unwrap();
        assert_eq!(renamed.title, "我的手动标题");
        assert_eq!(renamed.title_source, "manual");

        // 去重路径不覆盖手动标题（同内容再次采集只累加计数）
        let again = record_capture(&db, &root.0, &text_payload("第一条说明文字"), &s).unwrap();
        assert!(!again.created);
        assert_eq!(again.item.title, "我的手动标题");
        assert_eq!(again.item.title_source, "manual");

        // 标题可被搜索命中（内容中不含该关键词）
        let f = ClipboardFilter {
            search: Some("独特关键词XYZ".into()),
            ..Default::default()
        };
        assert!(list_items(&db, &f).unwrap().is_empty());
        rename_item(&db, &a.item.id, "独特关键词XYZ").unwrap();
        let hits = list_items(&db, &f).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, a.item.id);

        // 清空（纯空白）→ 恢复自动标题
        let regen = rename_item(&db, &a.item.id, "   ").unwrap();
        assert_eq!(regen.title_source, "auto");
        assert!(!regen.title.is_empty());
        assert_ne!(regen.title, "独特关键词XYZ");

        // 不存在的条目返回 NotFound
        let err = rename_item(&db, "no-such-id", "标题").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn consecutive_text_link_and_file_copies_collect_by_type() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_group_window_secs = 45;

        // 连续文本：第二条才成立正式组，组内按实际顺序保留两段。
        let t1 = record_capture(&db, &root.0, &text_payload("第一段文本"), &s).unwrap();
        assert!(t1.group_id.is_none());
        let t2 = record_capture(&db, &root.0, &text_payload("第二段文本"), &s).unwrap();
        let text_group = t2.group_id.expect("连续文本应成组");
        let g = get_group(&db, &text_group).unwrap();
        assert_eq!(g.mode, "auto");
        assert_eq!(g.status, "collecting");
        assert_eq!(g.kind_counts.text, 2, "两段文本计入文本数量");
        assert_eq!(g.kind_counts.image, 0);
        close_group(&db, &text_group).unwrap();

        // 连续链接：同来源的相邻链接成组。
        let u1 = record_capture(&db, &root.0, &url_payload("https://example.com/one"), &s).unwrap();
        assert!(u1.group_id.is_none());
        let u2 = record_capture(&db, &root.0, &url_payload("https://example.com/two"), &s).unwrap();
        let link_group = u2.group_id.expect("连续链接应成组");
        let g = get_group(&db, &link_group).unwrap();
        assert_eq!(g.kind_counts.url, 2);
        assert_eq!(g.kind_counts.text, 0, "链接不重复计入文本");
        close_group(&db, &link_group).unwrap();

        // 连续文件：每次复制一个文件条目，相邻条目成文件组。
        let f1 = record_capture(&db, &root.0, &files_payload(&["C:\\tmp\\报告.docx"]), &s).unwrap();
        assert!(f1.group_id.is_none());
        let f2 = record_capture(&db, &root.0, &files_payload(&["C:\\tmp\\预算.xlsx"]), &s).unwrap();
        let file_group = f2.group_id.expect("连续文件应成组");
        let g = get_group(&db, &file_group).unwrap();
        assert_eq!(g.kind_counts.files, 2);
        assert_eq!(g.kind_counts.image, 0);
    }

    #[test]
    fn single_multi_file_copy_only_becomes_candidate() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let out = record_capture(
            &db,
            &root.0,
            &files_payload(&["C:\\tmp\\a.png", "C:\\tmp\\b.txt"]),
            &s,
        )
        .unwrap();
        assert!(out.group_id.is_none(), "一次复制多个文件仍是一条文件条目");
        assert!(list_groups(&db, &ClipboardFilter::default())
            .unwrap()
            .is_empty());
        let cand = db
            .with_conn(|c| read_candidate(c))
            .unwrap()
            .expect("单条文件复制应保留候选，等待下一次连续复制");
        assert_eq!(cand.item_id, out.item.id);
        assert_eq!(cand.family, "file");
    }

    #[test]
    fn unknown_source_text_copies_stay_ungrouped() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let a = record_capture(
            &db,
            &root.0,
            &from_unknown_source(text_payload("来源未知一")),
            &s,
        )
        .unwrap();
        let b = record_capture(
            &db,
            &root.0,
            &from_unknown_source(text_payload("来源未知二")),
            &s,
        )
        .unwrap();
        assert!(a.group_id.is_none());
        assert!(b.group_id.is_none(), "来源未知时保守处理，不按时间猜测");
        assert!(list_groups(&db, &ClipboardFilter::default())
            .unwrap()
            .is_empty());
        let cand = db.with_conn(|c| read_candidate(c)).unwrap().unwrap();
        assert_eq!(cand.item_id, b.item.id, "后一条覆盖候选");
        assert!(!cand.source_known);
    }

    #[test]
    fn manual_grouping_clears_candidate_promotion() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let a = record_capture(&db, &root.0, &text_payload("候选内容"), &s).unwrap();
        assert!(a.group_id.is_none());
        let manual =
            create_manual_group(&db, "手动整理", std::slice::from_ref(&a.item.id)).unwrap();
        assert_eq!(manual.mode, "manual");

        let b = record_capture(&db, &root.0, &text_payload("后续内容"), &s).unwrap();
        assert!(b.group_id.is_none(), "候选已被手动归类，不能再被自动组拉入");
        assert_eq!(
            list_groups(&db, &ClipboardFilter::default()).unwrap().len(),
            1,
            "只保留手动分组"
        );
        let cand = db.with_conn(|c| read_candidate(c)).unwrap().unwrap();
        assert_eq!(cand.item_id, b.item.id);
    }

    #[test]
    fn manual_close_starts_a_new_collection_session() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let a = record_capture(&db, &root.0, &text_payload("会话一"), &s).unwrap();
        assert!(a.group_id.is_none());
        let b = record_capture(&db, &root.0, &text_payload("会话二"), &s).unwrap();
        let g1 = b.group_id.expect("连续文本应成组");
        let closed = close_group(&db, &g1).unwrap();
        assert_eq!(closed.status, "closed");

        let c = record_capture(&db, &root.0, &text_payload("会话三"), &s).unwrap();
        assert!(c.group_id.is_none(), "手动结束后第一条只成为候选");
        let d = record_capture(&db, &root.0, &text_payload("会话四"), &s).unwrap();
        let g2 = d.group_id.expect("下一段连续文本应开新组");
        assert_ne!(g1, g2);
        assert_eq!(get_group(&db, &g1).unwrap().items.len(), 2);
    }

    #[test]
    fn other_app_collection_is_not_blocked_by_open_session() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_group_window_secs = 45;

        // A 应用连续文本组成会话。
        let a1 = record_capture(&db, &root.0, &text_payload("A 一"), &s).unwrap();
        assert!(a1.group_id.is_none());
        let a2 = record_capture(&db, &root.0, &text_payload("A 二"), &s).unwrap();
        let ga = a2.group_id.expect("A 应用连续文本应成组");

        // B 应用插入复制：第一条成为候选，第二条应与候选成组，而不是被 A 的会话挡住。
        let b1 = record_capture(&db, &root.0, &url_payload("https://example.com/b1"), &s).unwrap();
        assert!(b1.group_id.is_none());
        let b2 = record_capture(&db, &root.0, &url_payload("https://example.com/b2"), &s).unwrap();
        let gb = b2.group_id.expect("B 应用连续链接应独立成组");
        assert_ne!(ga, gb);
        let g = get_group(&db, &gb).unwrap();
        assert_eq!(g.kind_counts.url, 2);
        assert_eq!(
            get_group(&db, &ga).unwrap().status,
            "closed",
            "A 的会话因另一应用开始新收集而结束，但内容保留"
        );
        assert_eq!(get_group(&db, &ga).unwrap().items.len(), 2);
    }

    #[test]
    fn auto_group_stops_at_item_limit_and_restarts() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let first = record_capture(&db, &root.0, &text_payload("上限 1"), &s).unwrap();
        assert!(first.group_id.is_none());
        let mut gid = None;
        for i in 2..=MAX_AUTO_GROUP_ITEMS {
            let out =
                record_capture(&db, &root.0, &text_payload(&format!("上限 {}", i)), &s).unwrap();
            gid = gid.or(out.group_id);
        }
        let gid = gid.expect("应形成文本组");
        let g = get_group(&db, &gid).unwrap();
        assert_eq!(g.items.len(), MAX_AUTO_GROUP_ITEMS, "组内数量有上限");
        assert_eq!(g.status, "collecting", "达到上限的最后一条仍属于当前会话");

        let overflow = record_capture(&db, &root.0, &text_payload("上限 溢出"), &s).unwrap();
        assert!(overflow.group_id.is_none(), "超限条目只成为新候选");
        assert_eq!(
            get_group(&db, &gid).unwrap().status,
            "closed",
            "下一条到来时结束已满的会话"
        );
        assert_eq!(
            get_group(&db, &gid).unwrap().items.len(),
            MAX_AUTO_GROUP_ITEMS,
            "已满会话内容保留"
        );
        let next = record_capture(&db, &root.0, &text_payload("上限 新组"), &s).unwrap();
        let g2 = next.group_id.expect("超限后的连续内容应可成新组");
        assert_ne!(g2, gid);
    }

    #[test]
    fn duplicate_capture_keeps_candidate_and_creates_no_group() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let a = record_capture(&db, &root.0, &text_payload("相同内容"), &s).unwrap();
        assert!(a.group_id.is_none());
        let dup = record_capture(&db, &root.0, &text_payload("相同内容"), &s).unwrap();
        assert!(!dup.created, "相同内容遵守现有去重");
        assert!(dup.group_id.is_none());
        assert_eq!(
            list_items(&db, &ClipboardFilter::default()).unwrap().len(),
            1
        );
        assert!(list_groups(&db, &ClipboardFilter::default())
            .unwrap()
            .is_empty());
        let cand = db.with_conn(|c| read_candidate(c)).unwrap().unwrap();
        assert_eq!(cand.item_id, a.item.id, "去重不覆盖候选");
    }

    #[test]
    fn candidate_from_previous_boot_is_not_reused() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let a = record_capture(&db, &root.0, &text_payload("重启前候选"), &s).unwrap();
        assert!(a.group_id.is_none());
        // 模拟上一次进程留下的候选：启动标识与当前进程不同。
        db.with_conn(|c| {
            let mut row = read_candidate(c)?.unwrap();
            row.boot = "previous-process".into();
            c.execute(
                "UPDATE application_settings SET value = ?1 WHERE key = ?2",
                params![serde_json::to_string(&row)?, CANDIDATE_KEY],
            )?;
            Ok(())
        })
        .unwrap();

        let b = record_capture(&db, &root.0, &text_payload("重启后内容"), &s).unwrap();
        assert!(b.group_id.is_none(), "跨重启的旧候选不得续用");
        assert!(list_groups(&db, &ClipboardFilter::default())
            .unwrap()
            .is_empty());
        let cand = db.with_conn(|c| read_candidate(c)).unwrap().unwrap();
        assert_eq!(cand.item_id, b.item.id);
    }

    #[test]
    fn auto_title_covers_image_and_files_kinds() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;
        let img = record_capture(&db, &root.0, &image_payload(5), &s).unwrap();
        assert_eq!(img.item.title, "截图 40×30");
        assert_eq!(img.item.title_source, "auto");

        let mut files = text_payload("");
        files.kind = "files".into();
        files.file_paths = vec!["C:\\tmp\\设计稿.png".into(), "C:\\tmp\\说明.txt".into()];
        let f = record_capture(&db, &root.0, &files, &s).unwrap();
        assert!(f.item.title.starts_with("设计稿"), "文件标题应含首个文件名");
        assert!(f.item.title.contains("2 个文件"));
    }

    #[test]
    fn separate_sessions_create_new_group_after_window() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_group_window_secs = 5;
        let a = record_capture(&db, &root.0, &image_payload(1), &s).unwrap();
        assert!(a.group_id.is_none(), "首张截图只成为候选");
        let b = record_capture(&db, &root.0, &image_payload(9), &s).unwrap();
        let g1 = b.group_id.expect("同来源的第二张截图应建组");
        db.with_conn(|c| {
            c.execute(
                "UPDATE clipboard_items SET created_at = ?1 WHERE id = ?2",
                params![(Utc::now() - Duration::seconds(10)).to_rfc3339(), b.item.id],
            )?;
            Ok(())
        })
        .unwrap();
        let c = record_capture(&db, &root.0, &image_payload(2), &s).unwrap();
        assert!(c.group_id.is_none(), "超窗口的截图只成为候选");
        let first = get_group(&db, &g1).unwrap();
        assert_eq!(first.status, "closed", "过期后旧组自动结束");
        let d = record_capture(&db, &root.0, &image_payload(3), &s).unwrap();
        let g2 = d.group_id.expect("同来源的第二张截图应建新组");
        assert_ne!(g1, g2);
    }

    #[test]
    fn reorder_remove_and_split_persist() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;
        let a = record_capture(&db, &root.0, &text_payload("A"), &s).unwrap();
        let b = record_capture(&db, &root.0, &text_payload("B"), &s).unwrap();
        let c = record_capture(&db, &root.0, &text_payload("C"), &s).unwrap();
        let ids = vec![a.item.id.clone(), b.item.id.clone(), c.item.id.clone()];
        let g = create_manual_group(&db, "资料", &ids).unwrap();
        let g = move_group_item(&db, &g.id, &c.item.id, 0).unwrap();
        let order: Vec<&str> = g.items.iter().map(|i| i.text.as_str()).collect();
        assert_eq!(order, vec!["C", "A", "B"]);

        let split = split_group(&db, &g.id, std::slice::from_ref(&a.item.id), "拆分").unwrap();
        assert_eq!(split.items.len(), 1);
        let left = get_group(&db, &g.id).unwrap();
        assert_eq!(left.items.len(), 2);

        let left = remove_group_item(&db, &g.id, &b.item.id).unwrap();
        assert_eq!(left.items.len(), 1);
        assert!(get_item(&db, &b.item.id).is_ok(), "移出分组不删除内容");
    }

    #[test]
    fn backend_round2_paste_selection_keeps_missing_ids_and_reports_skipped() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let a = record_capture(&db, &root.0, &text_payload("paste selection"), &settings()).unwrap();
        let requested = vec![a.item.id.clone(), "missing".into(), a.item.id.clone()];
        let selected = prepare_paste_selection(&db, &requested).unwrap();
        assert_eq!(selected, vec![a.item.id, "missing".into()]);
        let job_id = create_paste_job(&db, "", "test", "test", &selected).unwrap();
        seed_paste_items(&db, &job_id, &selected, 0).unwrap();
        record_paste_item_state(&db, &job_id, "missing", "skipped", Some("已删除")).unwrap();
        let job = get_paste_job(&db, &job_id).unwrap();
        assert_eq!(job.total, 2);
        assert_eq!(job.skipped, 1);
        assert!(prepare_paste_selection(&db, &["gone".into()]).is_err());
        assert!(prepare_paste_selection(&db, &[]).is_err());
        assert!(prepare_paste_selection(&db, &vec!["x".into(); 1001]).is_err());
    }

    fn continuation_snapshot(db: &Db) {
        db.with_conn(|c| {
            c.execute("INSERT INTO workspace_snapshots
                (id, name, note, source, item_count, created_at, updated_at)
                VALUES ('continuation', 'fixture', '', 'manual', 0, 'now', 'now')", [])?;
            Ok(())
        }).unwrap();
    }

    #[test]
    fn backend_continuation_deletion_cleans_snapshot_links() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;
        let a = record_capture(&db, &root.0, &text_payload("linked"), &s).unwrap();
        let group = create_manual_group(&db, "fixture", &[a.item.id.clone()]).unwrap();
        continuation_snapshot(&db);
        link_snapshot(&db, "continuation", "item", &a.item.id).unwrap();
        link_snapshot(&db, "continuation", "group", &group.id).unwrap();
        delete_items(&db, &root.0, &[a.item.id.clone()]).unwrap();
        assert!(snapshot_links(&db, "continuation").unwrap().is_empty());
    }

    #[test]
    fn backend_continuation_group_delete_retains_snapshot_material() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;
        let a = record_capture(&db, &root.0, &text_payload("linked"), &s).unwrap();
        let group = create_manual_group(&db, "fixture", &[a.item.id.clone()]).unwrap();
        continuation_snapshot(&db);
        link_snapshot(&db, "continuation", "item", &a.item.id).unwrap();
        link_snapshot(&db, "continuation", "group", &group.id).unwrap();
        let report = delete_group(&db, &root.0, &group.id, true).unwrap();
        assert_eq!(report.deleted, 0);
        assert_eq!(report.retained_shared, 1);
        assert!(get_item(&db, &a.item.id).is_ok());
        let links = snapshot_links(&db, "continuation").unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target_type, "item");
    }

    #[test]
    fn backend_continuation_split_cleans_removed_group_snapshot_link() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;
        let a = record_capture(&db, &root.0, &text_payload("split"), &s).unwrap();
        let ids = [a.item.id.clone()];
        let group = create_manual_group(&db, "fixture", &ids).unwrap();
        continuation_snapshot(&db);
        link_snapshot(&db, "continuation", "group", &group.id).unwrap();
        let split = split_group(&db, &group.id, &ids, "new").unwrap();
        assert_eq!(split.items.len(), 1);
        assert!(snapshot_links(&db, "continuation").unwrap().is_empty());
    }

    #[test]
    fn group_deletion_is_reference_safe() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;
        let a = record_capture(&db, &root.0, &text_payload("共享内容"), &s).unwrap();
        let b = record_capture(&db, &root.0, &text_payload("独占内容"), &s).unwrap();
        let g1 = create_manual_group(&db, "组一", &[a.item.id.clone(), b.item.id.clone()]).unwrap();
        let g2 = create_manual_group(&db, "组二", std::slice::from_ref(&a.item.id)).unwrap();

        let report = delete_group(&db, &root.0, &g1.id, true).unwrap();
        assert_eq!(report.deleted, 1, "只删除不再被引用的独占条目");
        assert_eq!(report.retained_shared, 1);
        assert_eq!(report.groups_deleted, 1);
        assert!(
            get_item(&db, &a.item.id).is_ok(),
            "仍被组二引用的条目必须保留"
        );
        assert!(get_item(&db, &b.item.id).is_err());
        assert!(get_group(&db, &g2.id).is_ok());

        // 删除分组（不删内容）后条目仍在
        let report = delete_group(&db, &root.0, &g2.id, false).unwrap();
        assert_eq!(report.groups_deleted, 1, "分组本身被删除");
        assert_eq!(report.deleted, 0, "保留条目时不删除内容");
        assert!(get_item(&db, &a.item.id).is_ok());

        // 分组不存在：命令成功但 groups_deleted 为 0，前端不能当成删除成功
        let missing = delete_group(&db, &root.0, "no-such-group", false).unwrap();
        assert_eq!(missing.groups_deleted, 0);
    }

    #[test]
    fn task_link_cascades_on_task_delete_but_content_survives() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let a = record_capture(&db, &root.0, &text_payload("会议纪要"), &s).unwrap();
        task(&db, "t1");
        let link = link_task(&db, "t1", "item", &a.item.id).unwrap();
        assert_eq!(task_links(&db, "t1").unwrap().len(), 1);
        db.with_conn(|c| {
            c.execute("DELETE FROM tasks WHERE id = 't1'", [])?;
            Ok(())
        })
        .unwrap();
        assert!(task_links(&db, "t1").unwrap().is_empty());
        assert!(
            get_item(&db, &a.item.id).is_ok(),
            "任务删除不得删除剪贴板内容"
        );
        let _ = link;
    }

    #[test]
    fn oversized_capture_without_rgba_still_gets_exact_thumb() {
        // 超预算条目为了守住内存只带 png 入队；缩略图必须由 png 重新解码，
        // 既不能缺文件，也不能用与尺寸不符的残缺像素生成。
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;

        let reference = |color: u8| -> Vec<u8> {
            let mut c = image_payload(color);
            let img = c.image.take().unwrap();
            let (rgba, w, h) = image::decode_png_rgba(&img.png).unwrap();
            let (thumb, tw, th) = image::thumbnail(&rgba, w, h);
            image::encode_png(&thumb, tw, th).unwrap()
        };

        let mut no_rgba = image_payload(77);
        no_rgba.image.as_mut().unwrap().rgba = Vec::new();
        let a = record_capture(&db, &root.0, &no_rgba, &s).unwrap();
        assert!(a.created, "去掉像素不影响入库");
        assert!(a.item.has_image && a.item.has_thumb);

        let mut short_rgba = image_payload(88);
        short_rgba.image.as_mut().unwrap().rgba.truncate(4);
        let b = record_capture(&db, &root.0, &short_rgba, &s).unwrap();
        assert!(b.created && b.item.has_thumb);

        let read_thumb = |id: &str| -> Vec<u8> {
            let rel = asset_rel(&db, id, "thumb").unwrap().unwrap();
            std::fs::read(asset_abs(&root.0, &rel).unwrap()).unwrap()
        };
        assert_eq!(
            read_thumb(&a.item.id),
            reference(77),
            "无像素条目必须由 png 重新解码生成同一份缩略图"
        );
        assert_eq!(
            read_thumb(&b.item.id),
            reference(88),
            "像素长度不足时不得用残缺数据生成缩略图"
        );
    }

    #[test]
    fn image_assets_land_on_disk_and_cleanup_removes_files() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_group_window_secs = 45;
        let a = record_capture(&db, &root.0, &image_payload(7), &s).unwrap();
        assert!(a.item.has_image && a.item.has_thumb);
        let rel = asset_rel(&db, &a.item.id, "image").unwrap().unwrap();
        let abs = asset_abs(&root.0, &rel).unwrap();
        assert!(abs.exists());
        assert!(thumb_data_url(&db, &root.0, &a.item.id)
            .unwrap()
            .unwrap()
            .starts_with("data:image/png;base64,"));

        delete_items(&db, &root.0, std::slice::from_ref(&a.item.id)).unwrap();
        assert!(!abs.exists(), "引用归零后必须删除图片文件");
        assert!(get_item(&db, &a.item.id).is_err());
    }

    #[test]
    fn retention_and_item_cap_delete_only_unprotected() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;
        s.clipboard_retention_days = 1;
        s.clipboard_max_items = 20;
        let old = record_capture(&db, &root.0, &text_payload("旧内容"), &s).unwrap();
        let keep = record_capture(&db, &root.0, &text_payload("收藏内容"), &s).unwrap();
        toggle_item_flag(&db, &keep.item.id, "favorite").unwrap();
        db.with_conn(|c| {
            c.execute(
                "UPDATE clipboard_items SET last_seen_at = ?1 WHERE id = ?2",
                params![(Utc::now() - Duration::days(5)).to_rfc3339(), old.item.id],
            )?;
            Ok(())
        })
        .unwrap();
        let report = cleanup(&db, &root.0, &s).unwrap();
        assert_eq!(report.items_deleted, 1);
        assert!(get_item(&db, &old.item.id).is_err());
        assert!(
            get_item(&db, &keep.item.id).is_ok(),
            "收藏内容不受保留期影响"
        );
    }

    #[test]
    fn paste_job_tracks_remaining_and_interruption() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let a = record_capture(&db, &root.0, &text_payload("一"), &s).unwrap();
        let b = record_capture(&db, &root.0, &text_payload("二"), &s).unwrap();
        let ids = vec![a.item.id.clone(), b.item.id.clone()];
        let job = create_paste_job(&db, "", "记事本", "notepad.exe", &ids).unwrap();
        update_paste_job(
            &db,
            &job,
            1,
            std::slice::from_ref(&b.item.id),
            "已发送 1 项",
        )
        .unwrap();
        let row = get_paste_job(&db, &job).unwrap();
        assert_eq!(row.sent, 1);
        assert_eq!(row.remaining_items, vec![b.item.id.clone()]);
        assert_eq!(interrupt_stale_paste_jobs(&db).unwrap(), 1);
        let row = get_paste_job(&db, &job).unwrap();
        assert_eq!(row.status, "interrupted");
    }

    #[test]
    fn paste_job_records_per_item_state_and_uncertain_bucket() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let a = record_capture(&db, &root.0, &text_payload("一"), &s).unwrap();
        let b = record_capture(&db, &root.0, &text_payload("二"), &s).unwrap();
        let ids = vec![a.item.id.clone(), b.item.id.clone()];
        let job = create_paste_job(&db, "", "记事本", "notepad.exe", &ids).unwrap();
        seed_paste_items(&db, &job, &ids, 0).unwrap();
        record_paste_item_state(&db, &job, &a.item.id, "preparing", None).unwrap();
        record_paste_item_state(&db, &job, &a.item.id, "input_sent", None).unwrap();
        record_paste_item_state(&db, &job, &a.item.id, "unverified", Some("无接收信号")).unwrap();
        record_paste_item_state(&db, &job, &b.item.id, "uncertain", Some("按键发送失败"))
            .unwrap();
        let rows = list_paste_items(&db, &job).unwrap();
        assert_eq!(rows.len(), 2, "每个条目都要有独立状态行");
        assert_eq!(rows[0].position, 0, "原始顺序必须保留");
        assert_eq!(rows[0].state, "unverified");
        assert!(rows[0].key_sent, "发过按键的条目必须记录 key_sent");
        assert!(!rows[0].retry_safe, "发过按键的条目不得标为可安全重试");
        assert!(rows[0].finished_at.is_some());
        assert_eq!(rows[1].position, 1);
        assert_eq!(rows[1].state, "uncertain");
        // uncertain 的定义是「按键可能已经发出、也可能没有」：保守记录 key_sent=1，
        // 宁可阻止自动重发也不能把可能已送达的条目当没发过。旧断言要求 !key_sent，
        // 与 v55 的状态机语义矛盾（该断言在本轮统一测试里第一次被真正执行到）。
        assert!(
            rows[1].key_sent,
            "结果不确定的条目必须按「可能已发送」记录，否则会被当安全重试"
        );
        assert!(!rows[1].retry_safe, "不确定项不得标为可安全重试");

        finish_paste_job(
            &db,
            &job,
            "failed",
            1,
            &[],
            std::slice::from_ref(&b.item.id),
            "1 项结果不确定",
            false,
        )
        .unwrap();
        let job_row = get_paste_job(&db, &job).unwrap();
        assert_eq!(
            job_row.uncertain_items,
            vec![b.item.id.clone()],
            "不确定项单列保存，resume 不会自动重发"
        );
        assert!(job_row.remaining_items.is_empty());
        assert_eq!(job_row.status, "failed");
    }

    #[test]
    fn dispatching_items_survive_crash_as_uncertain_and_never_auto_resend() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let a = record_capture(&db, &root.0, &text_payload("一"), &s).unwrap();
        let b = record_capture(&db, &root.0, &text_payload("二"), &s).unwrap();
        let ids = vec![a.item.id.clone(), b.item.id.clone()];
        let job = create_paste_job(&db, "", "记事本", "notepad.exe", &ids).unwrap();
        seed_paste_items(&db, &job, &ids, 0).unwrap();

        // 模拟「SendInput 之后、落库之前进程被杀」：数据库里只有 dispatching 这条锚点。
        record_paste_step(
            &db,
            &job,
            0,
            &ids,
            &a.item.id,
            "dispatching",
            Some("Ctrl+V 即将发送"),
        )
        .unwrap();
        let row = &list_paste_items(&db, &job).unwrap()[0];
        assert_eq!(row.state, "dispatching");
        assert!(
            !row.retry_safe,
            "正在发送的条目绝不能标成可安全重试"
        );
        assert!(
            row.dispatch_started_at.is_some(),
            "必须记下投递时刻，崩溃后据此判断可能已送达"
        );

        // 应用重启：运行中任务被收尾，dispatching 项转 uncertain 并进不确定集合。
        assert_eq!(interrupt_stale_paste_jobs(&db).unwrap(), 1);
        let job_row = get_paste_job(&db, &job).unwrap();
        assert_eq!(job_row.status, "interrupted");
        assert_eq!(job_row.uncertain_items, vec![a.item.id.clone()]);
        let rows = list_paste_items(&db, &job).unwrap();
        assert_eq!(rows[0].state, "uncertain");
        assert!(!rows[0].retry_safe);
        assert!(
            job_row.remaining_items.contains(&a.item.id),
            "剩余队列仍保留该项：是否重发必须由用户显式决定，而不是自动重发"
        );
    }

    #[test]
    fn finish_paste_job_merges_historical_uncertain_instead_of_overwriting() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let first = record_capture(&db, &root.0, &text_payload("一"), &s).unwrap();
        let second = record_capture(&db, &root.0, &text_payload("二"), &s).unwrap();
        let ids = vec![first.item.id.clone(), second.item.id.clone()];
        let job = create_paste_job(&db, "", "记事本", "notepad.exe", &ids).unwrap();
        seed_paste_items(&db, &job, &ids, 0).unwrap();

        // 第一轮：第 1 项结果不确定。
        finish_paste_job(
            &db,
            &job,
            "failed",
            0,
            std::slice::from_ref(&second.item.id),
            std::slice::from_ref(&first.item.id),
            "第 1 项不确定",
            false,
        )
        .unwrap();
        // 第二轮续跑：只剩第 2 项，本轮没有新的不确定项。
        let total = finish_paste_job(
            &db,
            &job,
            "completed",
            1,
            &[],
            &[],
            "续跑完成",
            false,
        )
        .unwrap();
        let row = get_paste_job(&db, &job).unwrap();
        assert_eq!(
            row.uncertain_items,
            vec![first.item.id.clone()],
            "续跑不得用空集合覆盖上一轮的不确定项"
        );
        assert_eq!(total, 1, "事件与 UI 必须报告累计未解决数量");
    }

    #[test]
    fn resolve_uncertain_resend_restores_original_order() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let a = record_capture(&db, &root.0, &text_payload("一"), &s).unwrap();
        let b = record_capture(&db, &root.0, &text_payload("二"), &s).unwrap();
        let c = record_capture(&db, &root.0, &text_payload("三"), &s).unwrap();
        let ids = vec![a.item.id.clone(), b.item.id.clone(), c.item.id.clone()];
        let job = create_paste_job(&db, "", "记事本", "notepad.exe", &ids).unwrap();
        seed_paste_items(&db, &job, &ids, 0).unwrap();
        finish_paste_job(
            &db,
            &job,
            "failed",
            2,
            std::slice::from_ref(&b.item.id),
            std::slice::from_ref(&a.item.id),
            "第 1 项不确定",
            false,
        )
        .unwrap();

        // 用户确认「没收到，重发」：第 1 项回到待处理队列，并且按原始顺序排在前面。
        resolve_uncertain_item(&db, &job, &a.item.id, "resend").unwrap();
        let row = get_paste_job(&db, &job).unwrap();
        assert!(row.uncertain_items.is_empty());
        assert_eq!(row.remaining_items, vec![a.item.id.clone(), b.item.id.clone()]);
        assert_eq!(row.status, "paused", "重发需要用户再点继续，不自动开跑");

        // 未在不确定集合里的条目不能被当成不确定项处置。
        assert!(
            resolve_uncertain_item(&db, &job, &c.item.id, "resend").is_err(),
            "不在不确定集合的条目必须拒绝处置"
        );
    }

    #[test]
    fn html_raw_is_preserved_while_preview_stays_clean() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let mut p = text_payload("正文");
        p.kind = "html".into();
        p.html =
            "<div onclick=\"x()\">正文<script>alert(1)</script><style>.a{color:red}</style></div>"
                .into();
        let a = record_capture(&db, &root.0, &p, &s).unwrap();
        // 原文原样保留：复制富文本要还原用户当时复制到的格式，采集侧不做破坏性改写
        assert!(a.item.html.contains("<script"), "原始 HTML 必须原样保留");
        assert!(a.item.html.contains("<style"), "样式块不能被采集侧删除");
        assert!(a.item.html.contains("onclick"), "属性也不在采集侧剥离");
        // 但摘要/标题只从净化视图派生，不吸收脚本与样式正文
        assert!(!a.item.preview.contains("alert"), "预览不得混入脚本正文");
        assert!(!a.item.title.contains("alert"), "标题不得混入脚本正文");
        assert!(a.item.preview.contains("正文"));
        // 去重键按净化视图规范化：同一内容重复复制不会新增条目（升级前后一致）
        let b = record_capture(&db, &root.0, &p, &s).unwrap();
        assert!(!b.created, "同一条富文本必须命中去重而不是新增");
        assert_eq!(b.item.id, a.item.id);
        assert_eq!(
            count_items(&db, &ClipboardFilter::default()).unwrap(),
            1,
            "去重后只应有一条记录"
        );
    }

    /// 来源三字段必须始终来自同一次采集：应用已识别时 kind 必须有效；
    /// 应用未知时不得挂着标题或 owner/foreground 识别方式。
    fn assert_source_consistent(item: &ClipboardItem, label: &str) {
        if source_app_is_known(&item.source_app) {
            assert!(
                source_kind_is_known(&item.source_kind),
                "{label}：已知应用 {} 的识别方式必须有效，实际 {:?}",
                item.source_app,
                item.source_kind
            );
        } else {
            assert!(
                item.source_title.is_empty(),
                "{label}：来源未知时不得保留标题 {:?}",
                item.source_title
            );
            assert!(
                matches!(item.source_kind.as_str(), "" | "unknown"),
                "{label}：来源未知时识别方式只能是空串或 unknown，实际 {:?}",
                item.source_kind
            );
        }
    }

    fn with_source(text: &str, app: &str, title: &str, kind: &str) -> CapturedContent {
        let mut p = text_payload(text);
        p.source_app = app.into();
        p.source_title = title.into();
        p.source_kind = kind.into();
        p
    }

    #[test]
    fn record_capture_replaces_source_snapshot_atomically() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let text = "跨应用重复复制 · 来源快照";

        let first = record_capture(
            &db,
            &root.0,
            &with_source(text, "chrome.exe", "OpenCode Console", "owner"),
            &s,
        )
        .unwrap();
        assert!(first.created);
        let id = first.item.id.clone();
        assert_eq!(first.item.source_app, "chrome.exe");
        assert_eq!(first.item.source_title, "OpenCode Console");
        assert_eq!(first.item.source_kind, "owner");

        // 同来源重复采集：三字段保持，次数递增
        let same = record_capture(
            &db,
            &root.0,
            &with_source(text, "chrome.exe", "OpenCode Console", "owner"),
            &s,
        )
        .unwrap();
        assert!(!same.created);
        assert_eq!(same.item.copy_count, 2);
        assert_eq!(
            (
                same.item.source_app.as_str(),
                same.item.source_title.as_str(),
                same.item.source_kind.as_str()
            ),
            ("chrome.exe", "OpenCode Console", "owner")
        );

        // Chrome → Snipaste，且新标题为空：旧标题必须被清掉，不能拼成混合快照
        let snip = record_capture(
            &db,
            &root.0,
            &with_source(text, "snipaste.exe", "", "owner"),
            &s,
        )
        .unwrap();
        assert_eq!(snip.item.source_app, "snipaste.exe");
        assert_eq!(snip.item.source_title, "", "新标题为空时不得保留旧标题");
        assert_eq!(snip.item.source_kind, "owner");
        assert_source_consistent(&snip.item, "Chrome→Snipaste");

        // Snipaste → Chrome：应用、标题、识别方式全部来自新采集
        let chrome = record_capture(
            &db,
            &root.0,
            &with_source(text, "chrome.exe", "OpenCode Console", "foreground"),
            &s,
        )
        .unwrap();
        assert_eq!(
            (
                chrome.item.source_app.as_str(),
                chrome.item.source_title.as_str(),
                chrome.item.source_kind.as_str()
            ),
            ("chrome.exe", "OpenCode Console", "foreground")
        );

        // owner → foreground / foreground → owner：识别方式随同一次快照更新
        let owner = record_capture(
            &db,
            &root.0,
            &with_source(text, "chrome.exe", "OpenCode Console", "owner"),
            &s,
        )
        .unwrap();
        assert_eq!(owner.item.source_kind, "owner");

        // 已知 → unknown：保守保留可信旧来源，不制造虚假来源
        let unknown = record_capture(
            &db,
            &root.0,
            &with_source(text, "unknown", "", "unknown"),
            &s,
        )
        .unwrap();
        assert_eq!(unknown.item.source_app, "chrome.exe");
        assert_eq!(unknown.item.source_title, "OpenCode Console");
        assert_eq!(unknown.item.source_kind, "owner");

        // 空串来源同理不得覆盖
        let blank = record_capture(&db, &root.0, &with_source(text, "", "", ""), &s).unwrap();
        assert_eq!(blank.item.source_app, "chrome.exe");

        // unknown → 已知：可信来源恢复
        let known = record_capture(
            &db,
            &root.0,
            &with_source(text, "msedge.exe", "Edge 窗口", "owner"),
            &s,
        )
        .unwrap();
        assert_eq!(
            (
                known.item.source_app.as_str(),
                known.item.source_title.as_str(),
                known.item.source_kind.as_str()
            ),
            ("msedge.exe", "Edge 窗口", "owner")
        );

        // 应用已知但识别方式缺失（进行中的半快照）不得覆盖旧快照
        let half = record_capture(
            &db,
            &root.0,
            &with_source(text, "notepad.exe", "记事本", ""),
            &s,
        )
        .unwrap();
        assert_eq!(half.item.source_app, "msedge.exe");

        // 旧记录 source_kind="" 时，新可信采集必须补齐识别方式
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE clipboard_items SET source_app = 'legacy.exe', source_title = '旧标题',
                    source_kind = '' WHERE id = ?1",
                params![id],
            )?;
            Ok(())
        })
        .unwrap();
        let legacy = record_capture(
            &db,
            &root.0,
            &with_source(text, "code.exe", "VS Code", "owner"),
            &s,
        )
        .unwrap();
        assert_eq!(
            (
                legacy.item.source_app.as_str(),
                legacy.item.source_title.as_str(),
                legacy.item.source_kind.as_str()
            ),
            ("code.exe", "VS Code", "owner"),
            "旧记录缺失识别方式时，新快照应完整替换三字段"
        );
        assert_eq!(legacy.item.copy_count, 10, "每次重复采集都必须计入次数");
        assert_eq!(
            count_items(&db, &ClipboardFilter::default()).unwrap(),
            1,
            "来源变化不得改变内容去重：同内容始终只有一条"
        );
        let hash: String = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT content_hash FROM clipboard_items WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(
            hash,
            engine::hash_of(&normalize(&with_source(text, "chrome.exe", "x", "owner"))),
            "来源字段不参与内容去重哈希"
        );
        assert_source_consistent(&legacy.item, "最终快照");
    }

    #[test]
    fn reconcile_source_snapshot_is_pure_and_snapshot_wide() {
        let prev = ("chrome.exe", "OpenCode Console", "owner");
        assert_eq!(
            reconcile_source_snapshot(prev, ("snipaste.exe", "", "owner")),
            ("snipaste.exe".into(), "".into(), "owner".into()),
            "新标题为空也必须整体替换，不能保留旧标题"
        );
        assert_eq!(
            reconcile_source_snapshot(prev, ("unknown", "", "unknown")),
            (
                "chrome.exe".into(),
                "OpenCode Console".into(),
                "owner".into()
            ),
            "unknown 不得覆盖已识别来源"
        );
        assert_eq!(
            reconcile_source_snapshot(prev, ("", "", "")),
            (
                "chrome.exe".into(),
                "OpenCode Console".into(),
                "owner".into()
            )
        );
        assert_eq!(
            reconcile_source_snapshot(prev, ("notepad.exe", "记事本", "unknown")),
            (
                "chrome.exe".into(),
                "OpenCode Console".into(),
                "owner".into()
            ),
            "识别方式缺失的半快照不构成可替换来源"
        );
        assert_eq!(
            reconcile_source_snapshot(
                ("legacy.exe", "旧标题", ""),
                ("code.exe", "VS Code", "foreground")
            ),
            ("code.exe".into(), "VS Code".into(), "foreground".into()),
            "旧记录缺 kind 时可被新快照补齐"
        );
    }

    #[test]
    fn image_capture_failure_leaves_no_partial_row() {
        let db = Db::open_in_memory().unwrap();
        let bad_root = std::env::temp_dir().join(format!("td-clip-bad-{}", uuid::Uuid::new_v4()));
        std::fs::write(&bad_root, b"not a directory").unwrap();
        let err = record_capture(&db, &bad_root, &image_payload(7), &settings());
        assert!(err.is_err(), "资产目录不可写时必须返回错误");
        assert_eq!(
            count_items(&db, &ClipboardFilter::default()).unwrap(),
            0,
            "资产写入失败后不能留下半条数据库记录"
        );
        let _ = std::fs::remove_file(&bad_root);
    }

    // ── Lite 分组分页（有界查询）────────────────────────────

    fn capture_ids(
        db: &Db,
        root: &Path,
        payloads: impl IntoIterator<Item = CapturedContent>,
        s: &Settings,
    ) -> Vec<String> {
        payloads
            .into_iter()
            .map(|p| record_capture(db, root, &p, s).unwrap().item.id)
            .collect()
    }

    #[test]
    fn group_page_reports_true_counts_for_one_and_nine_images() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;

        let one_id = record_capture(&db, &root.0, &image_payload(3), &s)
            .unwrap()
            .item
            .id;
        let one = create_manual_group(&db, "单图", std::slice::from_ref(&one_id)).unwrap();
        let page = get_group_page(&db, &one.id, Some(1), Some(0), true).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!((page.total_count, page.image_count), (1, 1));
        assert!(page.items[0].has_thumb, "封面查询必须带缩略图标记");

        let ids = capture_ids(&db, &root.0, (0..9).map(image_payload), &s);
        let nine = create_manual_group(&db, "九图", &ids).unwrap();
        let page = get_group_page(&db, &nine.id, Some(9), Some(0), true).unwrap();
        assert_eq!(page.items.len(), 9);
        assert_eq!((page.total_count, page.image_count), (9, 9));
        assert_eq!(
            page.items.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
            ids,
            "组内顺序必须与创建顺序一致"
        );

        // 超过上限按 50 截断，实际生效值必须回传，避免前端误判拿到了全部数据。
        let clamped = get_group_page(&db, &nine.id, Some(999), Some(-3), false).unwrap();
        assert_eq!(clamped.limit, GROUP_PAGE_MAX_LIMIT);
        assert_eq!(clamped.offset, 0, "负 offset 归零");
        assert_eq!(clamped.items.len(), 9);
        assert_eq!(clamped.total_count, 9, "截断不影响真实总数");
    }

    #[test]
    fn group_page_hundred_images_reads_only_requested_page() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;

        let ids = capture_ids(&db, &root.0, (0..100).map(image_payload), &s);
        let g = create_manual_group(&db, "百图", &ids).unwrap();
        // 兼容性：完整详情接口行为不变，仍返回全部条目（整组复制走这里）。
        let full = get_group(&db, &g.id).unwrap();
        assert_eq!(full.items.len(), 100);
        let full_ids: Vec<String> = full.items.iter().map(|i| i.id.clone()).collect();

        let page = get_group_page(&db, &g.id, Some(9), Some(0), true).unwrap();
        assert_eq!(page.items.len(), 9);
        assert_eq!(
            page.items.iter().map(|i| i.id.clone()).collect::<Vec<_>>(),
            full_ids[..9].to_vec(),
            "Lite 第一页必须与完整查询的前 9 条一致"
        );
        assert_eq!((page.total_count, page.image_count), (100, 100));

        let page2 = get_group_page(&db, &g.id, Some(9), Some(9), true).unwrap();
        assert_eq!(page2.offset, 9);
        assert_eq!(page2.items[0].id, full_ids[9]);

        let full_bytes = serde_json::to_vec(&full.items).unwrap().len();
        let page_bytes = serde_json::to_vec(&page.items).unwrap().len();
        assert!(
            page_bytes * 5 < full_bytes,
            "分页载荷必须显著小于整组（{} vs {}）",
            page_bytes,
            full_bytes
        );
    }

    #[test]
    fn group_page_five_hundred_mixed_items_preserves_order_and_omits_body() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;

        let mut payloads = Vec::new();
        for i in 0..500 {
            if i % 2 == 0 {
                payloads.push(text_payload(&format!("记录 {i} {}", "x".repeat(8000))));
            } else {
                payloads.push(image_payload((i / 2) as u8));
            }
        }
        let ids = capture_ids(&db, &root.0, payloads, &s);
        let g = create_manual_group(&db, "五百", &ids).unwrap();

        let full = get_group(&db, &g.id).unwrap();
        assert_eq!(full.items.len(), 500);

        // imagesOnly 在 SQL 阶段筛掉文本，按 position 顺序分页。
        let mut collected = Vec::new();
        let mut offset = 0;
        loop {
            let page = get_group_page(&db, &g.id, Some(50), Some(offset), true).unwrap();
            let n = page.items.len();
            assert_eq!((page.total_count, page.image_count), (500, 250));
            collected.extend(page.items.iter().map(|i| i.id.clone()));
            if n == 0 {
                break;
            }
            offset += n as i64;
        }
        let expected: Vec<String> = full
            .items
            .iter()
            .filter(|i| i.kind == "image")
            .map(|i| i.id.clone())
            .collect();
        assert_eq!(collected, expected, "分页拼接必须等于完整图片顺序");

        // 任一页都不携带完整正文/HTML。
        let page = get_group_page(&db, &g.id, Some(50), Some(0), false).unwrap();
        for item in &page.items {
            assert!(item.html.is_empty(), "分页条目不得携带 HTML");
            if item.kind == KIND_IMAGE {
                // 图片没有正文：尺寸描述只留在 preview，不得当成文字正文
                assert!(item.text.is_empty(), "分页图片条目不得携带正文");
                assert!(
                    item.preview.starts_with("图片"),
                    "图片预览只描述尺寸：{}",
                    item.preview
                );
            } else {
                assert_eq!(item.text, item.preview, "分页文本条目 text 只回填 preview");
            }
            assert!(item.preview.chars().count() <= 220);
        }
        let long_text = full
            .items
            .iter()
            .find(|i| i.kind == "text")
            .expect("混合记录应包含文本");
        assert!(long_text.text.len() > 8000, "完整查询仍保留正文");

        let full_bytes = serde_json::to_vec(&full.items).unwrap().len();
        let page_bytes = serde_json::to_vec(&page.items).unwrap().len();
        assert!(
            page_bytes * 4 < full_bytes,
            "500 条混排下分页载荷应显著更小（{} vs {}）",
            page_bytes,
            full_bytes
        );
    }

    #[test]
    fn group_page_keeps_interleaved_order_and_cover_falls_back_after_delete() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_group_window_secs = 45;
        let first = record_capture(&db, &root.0, &image_payload(1), &s).unwrap();
        assert!(first.group_id.is_none(), "首张截图只成为候选");
        let mut note = text_payload("说明");
        note.source_app = "snippingtool.exe".into();
        let gid = record_capture(&db, &root.0, &note, &s)
            .unwrap()
            .group_id
            .expect("第二项应与候选一起建组");
        record_capture(&db, &root.0, &image_payload(2), &s).unwrap();

        let full = get_group(&db, &gid).unwrap();
        let page = get_group_page(&db, &gid, Some(10), Some(0), false).unwrap();
        assert_eq!(
            page.items
                .iter()
                .map(|i| i.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["image", "text", "image"],
            "分页不得打乱图片/文字交错顺序"
        );
        assert_eq!(page.total_count, 3);
        assert_eq!(page.image_count, 2);

        // 封面：只取 1 条图片；封面被删后自动回退到下一张真实存在的图片。
        let cover = get_group_page(&db, &gid, Some(1), Some(0), true).unwrap();
        assert_eq!(cover.items.len(), 1);
        assert_eq!(cover.items[0].id, full.items[0].id);
        delete_items(&db, &root.0, std::slice::from_ref(&cover.items[0].id)).unwrap();
        let cover = get_group_page(&db, &gid, Some(1), Some(0), true).unwrap();
        assert_eq!(cover.items.len(), 1);
        assert_eq!(
            cover.items[0].id, full.items[2].id,
            "封面被删后回退到下一张图"
        );
        assert_eq!((cover.total_count, cover.image_count), (2, 1));
        assert!(get_group(&db, &gid).is_ok(), "组内仍有内容，分组必须保留");

        // 组不存在时必须与「空组」区分：返回 NOT_FOUND 而不是空页。
        assert_eq!(
            get_group_page(&db, "missing-group", Some(1), None, true)
                .unwrap_err()
                .code(),
            "NOT_FOUND"
        );
    }

    #[test]
    fn group_page_not_found_and_read_failure_are_errors() {
        let db = Db::open_in_memory().unwrap();
        let err = get_group_page(&db, "missing-group", Some(10), Some(0), true).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");

        // 模拟读取失败（隔离库内删表）：错误必须冒泡，不能返回空页伪装成功。
        let root = TempRoot::new();
        let s = settings();
        let a = record_capture(&db, &root.0, &image_payload(1), &s).unwrap();
        assert!(a.group_id.is_none(), "首张截图只成为候选");
        let b = record_capture(&db, &root.0, &image_payload(2), &s).unwrap();
        let gid = b.group_id.expect("同来源的第二张截图应建组");
        db.with_conn(|c| {
            c.execute("DROP TABLE clipboard_group_items", [])?;
            Ok(())
        })
        .unwrap();
        let failed = get_group_page(&db, &gid, Some(1), Some(0), true);
        assert!(failed.is_err(), "底层读取失败必须返回错误");
    }

    // ── 组内条目定位（get_group_item_position）────────────────

    #[test]
    fn group_item_position_counts_only_images_before_target() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;

        let img1 = record_capture(&db, &root.0, &image_payload(1), &s)
            .unwrap()
            .item
            .id;
        let note = record_capture(&db, &root.0, &text_payload("说明"), &s)
            .unwrap()
            .item
            .id;
        let img2 = record_capture(&db, &root.0, &image_payload(2), &s)
            .unwrap()
            .item
            .id;
        let files = record_capture(&db, &root.0, &files_payload(&["C:\\a.png"]), &s)
            .unwrap()
            .item
            .id;
        let img3 = record_capture(&db, &root.0, &image_payload(3), &s)
            .unwrap()
            .item
            .id;
        let g = create_manual_group(
            &db,
            "混合组",
            &[
                img1.clone(),
                note.clone(),
                img2.clone(),
                files.clone(),
                img3.clone(),
            ],
        )
        .unwrap();
        let page = get_group_page(&db, &g.id, Some(50), Some(0), true).unwrap();
        assert_eq!(page.image_count, 3, "组内图片总数必须只数图片条目");

        // 前面有非图片条目时，index 只数图片条目（img3 之前有 img1/img2 两张图）。
        let pos = get_group_item_position(&db, &g.id, &img3).unwrap();
        assert!(pos.found);
        assert_eq!(pos.index, Some(2));
        assert_eq!(pos.image_count, 3);
        assert_eq!(pos.total_count, 5);
        let pos1 = get_group_item_position(&db, &g.id, &img1).unwrap();
        assert_eq!(pos1.index, Some(0));
        let pos2 = get_group_item_position(&db, &g.id, &img2).unwrap();
        assert_eq!(pos2.index, Some(1));

        // 非图片条目在组内但不是图片：found=false，不报错。
        let note_pos = get_group_item_position(&db, &g.id, &note).unwrap();
        assert!(!note_pos.found);
        assert_eq!(note_pos.index, None);
        assert_eq!((note_pos.image_count, note_pos.total_count), (3, 5));

        // 不在本组内的条目：found=false，不报错。
        let outsider = record_capture(&db, &root.0, &image_payload(4), &s)
            .unwrap()
            .item
            .id;
        let outside = get_group_item_position(&db, &g.id, &outsider).unwrap();
        assert!(!outside.found);
        assert_eq!(outside.index, None);
        assert_eq!((outside.image_count, outside.total_count), (3, 5));
    }

    #[test]
    fn group_item_position_missing_group_is_not_found() {
        let db = Db::open_in_memory().unwrap();
        let err = get_group_item_position(&db, "missing-group", "any-item").unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn group_item_position_revision_matches_group_page() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;

        let a = record_capture(&db, &root.0, &image_payload(1), &s)
            .unwrap()
            .item
            .id;
        let b = record_capture(&db, &root.0, &image_payload(2), &s)
            .unwrap()
            .item
            .id;
        let g = create_manual_group(&db, "版本组", &[a, b.clone()]).unwrap();

        let page = get_group_page(&db, &g.id, Some(9), Some(0), true).unwrap();
        let pos = get_group_item_position(&db, &g.id, &b).unwrap();
        assert!(pos.found);
        assert_eq!(pos.index, Some(1));
        assert_eq!(
            pos.revision, page.revision,
            "定位接口与分页接口的 revision 不得漂移"
        );

        // 组内容变化后两者必须同步变化（前端靠 revision 一致性判断数据是否可信）。
        let c = record_capture(&db, &root.0, &image_payload(3), &s)
            .unwrap()
            .item
            .id;
        add_to_group(&db, &g.id, std::slice::from_ref(&c)).unwrap();
        let page2 = get_group_page(&db, &g.id, Some(9), Some(0), true).unwrap();
        let pos2 = get_group_item_position(&db, &g.id, &b).unwrap();
        assert_ne!(pos2.revision, page.revision);
        assert_eq!(pos2.revision, page2.revision);
        assert_eq!(pos2.index, Some(1), "追加到组尾不影响已有图片的序位");
    }

    #[test]
    fn group_page_switches_groups_and_revision_invalidates() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;

        let a = record_capture(&db, &root.0, &image_payload(1), &s).unwrap();
        let b = record_capture(&db, &root.0, &image_payload(2), &s).unwrap();
        let g1 = create_manual_group(&db, "组一", std::slice::from_ref(&a.item.id)).unwrap();
        let g2 = create_manual_group(&db, "组二", &[b.item.id.clone(), a.item.id.clone()]).unwrap();

        // 快速切换不同组：响应必须带 groupId，且各页条目互不串组。
        for round in 0..10 {
            let p1 = get_group_page(&db, &g1.id, Some(1), Some(0), false).unwrap();
            assert_eq!(p1.group_id, g1.id);
            assert_eq!(p1.items[0].id, a.item.id);
            let p2 = get_group_page(&db, &g2.id, Some(2), Some(0), false).unwrap();
            assert_eq!(p2.group_id, g2.id);
            assert_eq!(p2.items[0].id, b.item.id);
            assert_eq!(p2.total_count, 2);
            assert!(round < 10);
        }

        // 重复打开同一组：内容未变时 revision 稳定（可复用缓存）。
        let first = get_group_page(&db, &g1.id, Some(1), Some(0), false).unwrap();
        let again = get_group_page(&db, &g1.id, Some(1), Some(0), false).unwrap();
        assert_eq!(first.revision, again.revision);
        assert_eq!(first.items.len(), again.items.len());

        // 组内容变化后 revision 必须变化，且分页拿到新条目。
        add_to_group(&db, &g1.id, std::slice::from_ref(&b.item.id)).unwrap();
        let changed = get_group_page(&db, &g1.id, Some(5), Some(0), false).unwrap();
        assert_ne!(changed.revision, first.revision, "组成员变化后缓存必须失效");
        assert_eq!(changed.total_count, 2);
        assert_eq!(changed.items.len(), 2);

        // 不同 imagesOnly/分页不得复用同一缓存键语义：分页内容确实随参数变化。
        let images = get_group_page(&db, &g1.id, Some(5), Some(0), true).unwrap();
        let all = get_group_page(&db, &g1.id, Some(5), Some(0), false).unwrap();
        assert_eq!(images.items.len(), all.items.len());
        let page2 = get_group_page(&db, &g1.id, Some(1), Some(1), false).unwrap();
        assert_eq!(page2.offset, 1);
        assert_eq!(page2.items[0].id, b.item.id);
    }

    // ── 分组封面顺序稳定性 ─────────────────────────────

    fn cover_ids(groups: &[ClipboardGroup], group_id: &str) -> Vec<String> {
        groups
            .iter()
            .find(|g| g.id == group_id)
            .map(|g| g.cover_items.iter().map(|i| i.id.clone()).collect())
            .unwrap_or_default()
    }

    #[test]
    fn group_cover_items_stay_in_position_order_across_groups() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;

        let a = capture_ids(&db, &root.0, (1..=6).map(image_payload), &s);
        let b = capture_ids(&db, &root.0, (11..=16).map(image_payload), &s);
        let ga = create_manual_group(&db, "组 A", &a).unwrap();
        let gb = create_manual_group(&db, "组 B", &b).unwrap();

        // 多组混合：每组的封面都必须是本组 position 最小的前 3 张。
        for _ in 0..5 {
            let groups = list_groups(&db, &ClipboardFilter::default()).unwrap();
            assert_eq!(cover_ids(&groups, &ga.id), a[..3].to_vec());
            assert_eq!(cover_ids(&groups, &gb.id), b[..3].to_vec());
            for (gid, ids) in [(&ga.id, &a), (&gb.id, &b)] {
                for id in cover_ids(&groups, gid) {
                    assert!(ids.contains(&id), "封面不得串到其它分组");
                }
            }
        }
    }

    #[test]
    fn group_cover_items_follow_reorder_and_deletion() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let mut s = settings();
        s.clipboard_auto_group = false;

        let ids = capture_ids(&db, &root.0, (21..=25).map(image_payload), &s);
        let g = create_manual_group(&db, "重排", &ids).unwrap();
        assert_eq!(
            cover_ids(
                &list_groups(&db, &ClipboardFilter::default()).unwrap(),
                &g.id
            ),
            ids[..3].to_vec()
        );

        // 重排：最后一张移到最前，封面顺序必须跟随 position。
        move_group_item(&db, &g.id, &ids[4], 0).unwrap();
        assert_eq!(
            cover_ids(
                &list_groups(&db, &ClipboardFilter::default()).unwrap(),
                &g.id
            ),
            vec![ids[4].clone(), ids[0].clone(), ids[1].clone()]
        );

        // 从组内移除一条（条目本身保留）。
        remove_group_item(&db, &g.id, &ids[0]).unwrap();
        assert_eq!(
            cover_ids(
                &list_groups(&db, &ClipboardFilter::default()).unwrap(),
                &g.id
            ),
            vec![ids[4].clone(), ids[1].clone(), ids[2].clone()]
        );

        // 删除底层条目后，封面按剩余条目的 position 重新收敛。
        delete_items(&db, &root.0, &[ids[2].clone()]).unwrap();
        for _ in 0..3 {
            let groups = list_groups(&db, &ClipboardFilter::default()).unwrap();
            assert_eq!(
                cover_ids(&groups, &g.id),
                vec![ids[4].clone(), ids[1].clone(), ids[3].clone()]
            );
            assert_eq!(groups.iter().find(|x| x.id == g.id).unwrap().image_count, 3);
        }
    }

    // ── SQLite 故障注入：关键状态落库失败时必须返回错误，且不得留下半个现场 ──

    #[test]
    fn readonly_db_rejects_paste_step_and_keeps_previous_state() {
        let tmp = TempRoot::new();
        let db_path = tmp.0.join("app.db");
        let (job, item) = {
            let db = Db::open(&db_path).unwrap();
            let root = TempRoot::new();
            let s = settings();
            let a = record_capture(&db, &root.0, &text_payload("一"), &s).unwrap();
            let b = record_capture(&db, &root.0, &text_payload("二"), &s).unwrap();
            let ids = vec![a.item.id.clone(), b.item.id.clone()];
            let job = create_paste_job(&db, "", "记事本", "notepad.exe", &ids).unwrap();
            (job, a.item.id.clone())
        };
        let db = Db::open(&db_path).unwrap();
        db.with_conn(|conn| {
            conn.pragma_update(None, "query_only", true)?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        // 模拟「只读库上执行 dispatching 落库」：必须拿到 Err，而不是静默成功。
        let err = record_paste_step(
            &db,
            &job,
            1,
            &[],
            &item,
            "dispatching",
            Some("写入应失败"),
        )
        .expect_err("只读库必须报错");
        assert!(
            !err.to_string().is_empty(),
            "错误必须带可读原因，便于诊断中心定位"
        );

        // 只读解除后读回：任务进度与逐项状态都保持原样，没有被写坏。
        db.with_conn(|conn| {
            conn.pragma_update(None, "query_only", false)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let row = get_paste_job(&db, &job).unwrap();
        assert_eq!(row.sent, 0, "失败的那一步不得计入已发送");
        assert_eq!(row.remaining_items.len(), 2);
        assert!(
            list_paste_items(&db, &job).unwrap().is_empty(),
            "写失败时不得留下半条逐项记录"
        );
    }

    #[test]
    fn full_disk_simulation_returns_error_instead_of_fake_progress() {
        let tmp = TempRoot::new();
        let db_path = tmp.0.join("app.db");
        let (job, item) = {
            let db = Db::open(&db_path).unwrap();
            let root = TempRoot::new();
            let s = settings();
            let a = record_capture(&db, &root.0, &text_payload("一"), &s).unwrap();
            let ids = vec![a.item.id.clone()];
            let job = create_paste_job(&db, "", "记事本", "notepad.exe", &ids).unwrap();
            (job, a.item.id.clone())
        };
        let db = Db::open(&db_path).unwrap();
        // 磁盘空间不足的等价模拟：把 max_page_count 压到当前页数，再写入必然 SQLITE_FULL。
        let pages: i64 = db
            .with_read(|conn| conn.query_row("PRAGMA page_count", [], |r| r.get(0)).map_err(AppError::from))
            .unwrap();
        db.with_conn(|conn| {
            conn.pragma_update(None, "max_page_count", pages)?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        // 写一条足够大的 note，确保需要新页 → 触发 SQLITE_FULL 分支。
        let big = "x".repeat(200_000);
        let err = record_paste_step(&db, &job, 1, &[], &item, "dispatching", Some(&big))
            .expect_err("空间不足必须报错");
        let text = err.to_string();
        assert!(
            text.to_lowercase().contains("full")
                || text.contains("空间")
                || text.contains("disk"),
            "错误信息应能看出是空间问题，实际：{text}"
        );
        let row = get_paste_job(&db, &job).unwrap();
        assert_eq!(row.sent, 0, "写入失败时任务进度不得前进");
    }

    #[test]
    fn busy_database_surfaces_error_and_does_not_claim_sent() {
        let tmp = TempRoot::new();
        let db_path = tmp.0.join("app.db");
        let (job, item) = {
            let db = Db::open(&db_path).unwrap();
            let root = TempRoot::new();
            let s = settings();
            let a = record_capture(&db, &root.0, &text_payload("一"), &s).unwrap();
            let ids = vec![a.item.id.clone()];
            let job = create_paste_job(&db, "", "记事本", "notepad.exe", &ids).unwrap();
            (job, a.item.id.clone())
        };
        let db = Db::open(&db_path).unwrap();
        // 总线立刻报 BUSY，不要让测试卡在默认 busy_timeout 上。
        db.with_conn(|conn| {
            conn.busy_timeout(std::time::Duration::from_millis(1))?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        // 另一个连接持写锁：本连接的写入会 BUSY/超时，必须冒泡成 Err。
        let holder = rusqlite::Connection::open(&db_path).unwrap();
        holder.execute_batch("BEGIN IMMEDIATE;").unwrap();
        let err = record_paste_step(&db, &job, 1, &[], &item, "dispatching", Some("锁竞争"))
            .expect_err("持锁写入必须报错");
        assert!(!err.to_string().is_empty());
        holder.execute_batch("ROLLBACK;").unwrap();
        drop(holder);
        let row = get_paste_job(&db, &job).unwrap();
        assert_eq!(row.sent, 0);
    }

    // ── 第三轮收口：启动恢复解耦 / 可恢复列表 / InputSent 计数 / uncertain 语义 ──

    fn seed_job_with_items(
        db: &Db,
        root: &Path,
        s: &Settings,
        texts: &[&str],
        group_id: &str,
    ) -> (Vec<String>, String) {
        let ids: Vec<String> = texts
            .iter()
            .map(|t| record_capture(db, root, &text_payload(t), s).unwrap().item.id)
            .collect();
        let job = create_paste_job(db, group_id, "记事本", "notepad.exe", &ids).unwrap();
        seed_paste_items(db, &job, &ids, 0).unwrap();
        (ids, job)
    }

    #[allow(clippy::too_many_arguments)]
    fn set_job_row(
        db: &Db,
        job: &str,
        status: &str,
        sent: i64,
        remaining: &[String],
        uncertain: &[String],
        started_at: &str,
    ) {
        db.with_conn(|c| {
            c.execute(
                "UPDATE clipboard_paste_jobs SET status=?1, sent=?2, remaining_items=?3,
                    uncertain_items=?4, started_at=?5, ended_at=NULL WHERE id=?6",
                params![
                    status,
                    sent,
                    serde_json::to_string(remaining)?,
                    serde_json::to_string(uncertain)?,
                    started_at,
                    job
                ],
            )?;
            Ok(())
        })
        .unwrap();
    }

    // ── 3.1 启动恢复：与监听开关/暂停解耦 ──

    #[test]
    fn startup_recovery_marks_running_jobs_interrupted() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (_ids, job) = seed_job_with_items(&db, &root.0, &s, &["一"], "");
        // 恢复函数本身不读取 clipboard_enabled / clipboard_paused（签名无 Settings），
        // 因此启用/停用/暂停重启都会走到同一段收尾。
        assert_eq!(interrupt_stale_paste_jobs(&db).unwrap(), 1);
        assert_eq!(get_paste_job(&db, &job).unwrap().status, "interrupted");
    }

    #[test]
    fn startup_recovery_merges_dispatching_into_historical_uncertain() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (ids, job) = seed_job_with_items(&db, &root.0, &s, &["一", "二"], "");
        // 历史已有 uncertain：二。
        finish_paste_job(
            &db,
            &job,
            "failed",
            0,
            &ids,
            std::slice::from_ref(&ids[1]),
            "历史不确定",
            false,
        )
        .unwrap();
        // 恢复前把任务拨回 running（模拟上一轮进程退出时仍在运行），保留历史 uncertain。
        set_job_row(&db, &job, "running", 0, &ids, &[ids[1].clone()], "2026-01-01T00:00:00Z");
        record_paste_step(&db, &job, 0, &ids, &ids[0], "dispatching", None).unwrap();
        interrupt_stale_paste_jobs(&db).unwrap();
        let row = get_paste_job(&db, &job).unwrap();
        assert!(row.uncertain_items.contains(&ids[0]), "崩溃锚点必须并入 uncertain");
        assert!(
            row.uncertain_items.contains(&ids[1]),
            "历史 uncertain 不得被覆盖"
        );
    }

    #[test]
    fn startup_recovery_keeps_input_sent_item_out_of_uncertain() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (ids, job) = seed_job_with_items(&db, &root.0, &s, &["一", "二"], "");
        record_paste_input_sent_step(
            &db,
            &job,
            1,
            std::slice::from_ref(&ids[1]),
            &ids[0],
            None,
        )
        .unwrap();
        interrupt_stale_paste_jobs(&db).unwrap();
        let row = get_paste_job(&db, &job).unwrap();
        assert!(
            !row.uncertain_items.contains(&ids[0]),
            "input_sent 项不得被转成 uncertain"
        );
        let item = list_paste_items(&db, &job)
            .unwrap()
            .into_iter()
            .find(|r| r.item_id == ids[0])
            .unwrap();
        assert_eq!(item.state, "input_sent");
    }

    #[test]
    fn startup_recovery_handles_multiple_historical_jobs() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (_i1, j1) = seed_job_with_items(&db, &root.0, &s, &["一"], "");
        let (_i2, j2) = seed_job_with_items(&db, &root.0, &s, &["二"], "");
        assert_eq!(interrupt_stale_paste_jobs(&db).unwrap(), 2);
        assert_eq!(get_paste_job(&db, &j1).unwrap().status, "interrupted");
        assert_eq!(get_paste_job(&db, &j2).unwrap().status, "interrupted");
    }

    #[test]
    fn startup_recovery_is_idempotent() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (_ids, job) = seed_job_with_items(&db, &root.0, &s, &["一"], "");
        assert_eq!(interrupt_stale_paste_jobs(&db).unwrap(), 1);
        assert_eq!(interrupt_stale_paste_jobs(&db).unwrap(), 0);
        assert_eq!(get_paste_job(&db, &job).unwrap().status, "interrupted");
    }

    #[test]
    fn startup_recovery_readonly_db_reports_error_without_panic() {
        let tmp = TempRoot::new();
        let db_path = tmp.0.join("app.db");
        let (_ids, job) = {
            let db = Db::open(&db_path).unwrap();
            let root = TempRoot::new();
            let s = settings();
            seed_job_with_items(&db, &root.0, &s, &["一"], "")
        };
        let db = Db::open(&db_path).unwrap();
        db.with_conn(|conn| {
            conn.pragma_update(None, "query_only", true)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let err = interrupt_stale_paste_jobs(&db).expect_err("只读库必须报错，而不是 panic");
        assert!(!err.to_string().is_empty());
        db.with_conn(|conn| {
            conn.pragma_update(None, "query_only", false)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let row = get_paste_job(&db, &job).unwrap();
        assert_eq!(row.status, "running", "失败的恢复不得改写原状态");
    }

    #[test]
    fn startup_recovery_busy_db_reports_error() {
        let tmp = TempRoot::new();
        let db_path = tmp.0.join("app.db");
        let (_ids, _job) = {
            let db = Db::open(&db_path).unwrap();
            let root = TempRoot::new();
            let s = settings();
            seed_job_with_items(&db, &root.0, &s, &["一"], "")
        };
        let db = Db::open(&db_path).unwrap();
        db.with_conn(|conn| {
            conn.busy_timeout(std::time::Duration::from_millis(1))?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let holder = rusqlite::Connection::open(&db_path).unwrap();
        holder.execute_batch("BEGIN IMMEDIATE;").unwrap();
        let err = interrupt_stale_paste_jobs(&db).expect_err("持锁写入必须报错");
        assert!(!err.to_string().is_empty());
        holder.execute_batch("ROLLBACK;").unwrap();
        drop(holder);
    }

    // ── 3.2 可恢复任务列表 ──

    #[test]
    fn resumable_jobs_lists_candidates_in_started_at_desc_order() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (i1, j1) = seed_job_with_items(&db, &root.0, &s, &["甲"], "");
        let (i2, j2) = seed_job_with_items(&db, &root.0, &s, &["乙"], "");
        let (i3, j3) = seed_job_with_items(&db, &root.0, &s, &["丙"], "");
        set_job_row(&db, &j1, "paused", 0, &i1, &[], "2026-01-01T00:00:01Z");
        set_job_row(&db, &j2, "failed", 0, &i2, &[], "2026-01-01T00:00:03Z");
        // j3 只有 unresolved uncertain，剩余为空。
        set_job_row(&db, &j3, "interrupted", 0, &[], &i3, "2026-01-01T00:00:02Z");
        let jobs = resumable_paste_jobs(&db, None).unwrap();
        let order: Vec<String> = jobs.iter().map(|j| j.id.clone()).collect();
        assert_eq!(order, vec![j2.clone(), j3.clone(), j1.clone()]);
    }

    #[test]
    fn resumable_jobs_filters_by_group_id() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (ia, ja) = seed_job_with_items(&db, &root.0, &s, &["甲"], "g1");
        let (ib, jb) = seed_job_with_items(&db, &root.0, &s, &["乙"], "g2");
        set_job_row(&db, &ja, "paused", 0, &ia, &[], "2026-01-01T00:00:01Z");
        set_job_row(&db, &jb, "paused", 0, &ib, &[], "2026-01-01T00:00:02Z");
        let g1 = resumable_paste_jobs(&db, Some("g1")).unwrap();
        assert_eq!(g1.len(), 1);
        assert_eq!(g1[0].id, ja);
    }

    #[test]
    fn resumable_jobs_excludes_completed_cancelled_and_resolved() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (_ic, jc) = seed_job_with_items(&db, &root.0, &s, &["完成"], "");
        set_job_row(&db, &jc, "completed", 1, &[], &[], "2026-01-01T00:00:01Z");
        let (_ix, jx) = seed_job_with_items(&db, &root.0, &s, &["取消"], "");
        set_job_row(&db, &jx, "cancelled", 0, &[], &[], "2026-01-01T00:00:02Z");
        let (ir, jr) = seed_job_with_items(&db, &root.0, &s, &["已确认"], "");
        set_job_row(&db, &jr, "interrupted", 0, &[], &ir, "2026-01-01T00:00:03Z");
        resolve_uncertain_item(&db, &jr, &ir[0], "received").unwrap();
        let jobs = resumable_paste_jobs(&db, None).unwrap();
        assert!(jobs.is_empty());
    }

    #[test]
    fn resumable_jobs_keeps_older_job_when_newer_exists() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (io, jo) = seed_job_with_items(&db, &root.0, &s, &["旧"], "");
        let (in_, jn) = seed_job_with_items(&db, &root.0, &s, &["新"], "");
        set_job_row(&db, &jo, "paused", 0, &io, &[], "2026-01-01T00:00:01Z");
        set_job_row(&db, &jn, "paused", 0, &in_, &[], "2026-01-01T00:00:02Z");
        let jobs = resumable_paste_jobs(&db, None).unwrap();
        assert_eq!(jobs.len(), 2, "旧任务不得被新任务静默覆盖");
        assert!(jobs.iter().any(|j| j.id == jo));
        assert!(jobs.iter().any(|j| j.id == jn));
    }

    #[test]
    fn resumable_jobs_filters_deleted_items_from_remaining() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (ids, job) = seed_job_with_items(&db, &root.0, &s, &["甲", "乙"], "");
        set_job_row(&db, &job, "paused", 0, &ids, &[], "2026-01-01T00:00:01Z");
        delete_items(&db, &root.0, &[ids[0].clone()]).unwrap();
        let jobs = resumable_paste_jobs(&db, None).unwrap();
        let row = jobs.iter().find(|j| j.id == job).unwrap();
        assert_eq!(
            row.remaining_items,
            vec![ids[1].clone()],
            "已删除条目必须被收敛掉"
        );

        // 唯一剩余条目已被删除、又无 uncertain：任务不得出现在列表里。
        let (ids2, job2) = seed_job_with_items(&db, &root.0, &s, &["丙"], "");
        set_job_row(&db, &job2, "paused", 0, &ids2, &[], "2026-01-01T00:00:02Z");
        delete_items(&db, &root.0, &[ids2[0].clone()]).unwrap();
        let jobs2 = resumable_paste_jobs(&db, None).unwrap();
        assert!(jobs2.iter().find(|j| j.id == job2).is_none());
    }

    #[test]
    fn latest_resumable_paste_job_compat_returns_newest() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (io, jo) = seed_job_with_items(&db, &root.0, &s, &["旧"], "");
        let (in_, jn) = seed_job_with_items(&db, &root.0, &s, &["新"], "");
        set_job_row(&db, &jo, "paused", 0, &io, &[], "2026-01-01T00:00:01Z");
        set_job_row(&db, &jn, "paused", 0, &in_, &[], "2026-01-01T00:00:02Z");
        let latest = latest_resumable_paste_job(&db).unwrap().unwrap();
        assert_eq!(latest.id, jn);
    }

    // ── 3.4 InputSent 计数时序 ──

    #[test]
    fn input_sent_step_commits_count_and_remaining_atomically() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (ids, job) = seed_job_with_items(&db, &root.0, &s, &["一", "二"], "");
        record_paste_input_sent_step(
            &db,
            &job,
            1,
            std::slice::from_ref(&ids[1]),
            &ids[0],
            None,
        )
        .unwrap();
        let row = get_paste_job(&db, &job).unwrap();
        assert_eq!(row.sent, 1);
        assert_eq!(row.remaining_items, vec![ids[1].clone()]);
        let item = list_paste_items(&db, &job)
            .unwrap()
            .into_iter()
            .find(|r| r.item_id == ids[0])
            .unwrap();
        assert_eq!(item.state, "input_sent");
    }

    #[test]
    fn input_sent_step_rejects_non_incrementing_sent() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (ids, job) = seed_job_with_items(&db, &root.0, &s, &["一", "二"], "");
        // next_sent=2 而当前 sent=0：不是恰好 +1，必须报错而不是静默写坏计数。
        let err = record_paste_input_sent_step(
            &db,
            &job,
            2,
            std::slice::from_ref(&ids[1]),
            &ids[0],
            None,
        )
        .expect_err("计数不一致必须返回错误");
        assert!(!err.to_string().is_empty());
        let row = get_paste_job(&db, &job).unwrap();
        assert_eq!(row.sent, 0);
        assert_eq!(row.remaining_items, ids);
    }

    #[test]
    fn input_sent_crash_reopen_keeps_consistent_state_and_skips_resend() {
        let tmp = TempRoot::new();
        let db_path = tmp.0.join("app.db");
        let (ids, job) = {
            let db = Db::open(&db_path).unwrap();
            let root = TempRoot::new();
            let s = settings();
            seed_job_with_items(&db, &root.0, &s, &["一", "二"], "")
        };
        // 模拟「SendInput 成功 → InputSent 已落库 → Settling 未落库 → 进程退出」。
        let db = Db::open(&db_path).unwrap();
        record_paste_input_sent_step(
            &db,
            &job,
            1,
            std::slice::from_ref(&ids[1]),
            &ids[0],
            None,
        )
        .unwrap();
        drop(db);
        // 重新打开同一数据库文件，不伪造内存状态。
        let db = Db::open(&db_path).unwrap();
        let row = get_paste_job(&db, &job).unwrap();
        assert_eq!(row.sent, 1, "InputSent 提交后 sent 必须已 +1");
        assert_eq!(
            row.remaining_items,
            vec![ids[1].clone()],
            "已发送项不得留在剩余队列"
        );
        assert!(!row.remaining_items.contains(&ids[0]));
        let item = list_paste_items(&db, &job)
            .unwrap()
            .into_iter()
            .find(|r| r.item_id == ids[0])
            .unwrap();
        assert_eq!(item.state, "input_sent");
    }

    #[test]
    fn settling_step_does_not_advance_count() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (ids, job) = seed_job_with_items(&db, &root.0, &s, &["一", "二"], "");
        record_paste_input_sent_step(
            &db,
            &job,
            1,
            std::slice::from_ref(&ids[1]),
            &ids[0],
            None,
        )
        .unwrap();
        record_paste_step(
            &db,
            &job,
            1,
            std::slice::from_ref(&ids[1]),
            &ids[0],
            "settling",
            None,
        )
        .unwrap();
        let row = get_paste_job(&db, &job).unwrap();
        assert_eq!(row.sent, 1, "Settling 观察阶段不得再推进计数");
        assert_eq!(row.remaining_items, vec![ids[1].clone()]);
    }

    // ── 3.5 finish 持久化失败：DB 侧现场 ──

    #[test]
    fn finish_persist_failure_keeps_running_until_startup_recovery() {
        let tmp = TempRoot::new();
        let db_path = tmp.0.join("app.db");
        let (ids, job) = {
            let db = Db::open(&db_path).unwrap();
            let root = TempRoot::new();
            let s = settings();
            seed_job_with_items(&db, &root.0, &s, &["一"], "")
        };
        let db = Db::open(&db_path).unwrap();
        db.with_conn(|conn| {
            conn.pragma_update(None, "query_only", true)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let err = finish_paste_job(
            &db,
            &job,
            "completed",
            1,
            &[],
            &[],
            "完成",
            false,
        )
        .expect_err("只读库收尾必须报错");
        assert!(!err.to_string().is_empty());
        db.with_conn(|conn| {
            conn.pragma_update(None, "query_only", false)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let row = get_paste_job(&db, &job).unwrap();
        assert_eq!(row.status, "running", "持久化失败不得把任务写成完成态");
        // 重启后由启动恢复识别为 interrupted（与 3.1 串起来，同一数据库文件验证）。
        assert_eq!(interrupt_stale_paste_jobs(&db).unwrap(), 1);
        assert_eq!(get_paste_job(&db, &job).unwrap().status, "interrupted");
        let _ = ids;
    }

    // ── 3.6 uncertain 安全语义与字段自洽 ──

    #[test]
    fn resend_clears_terminal_markers_and_resets_per_attempt_flags() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (ids, job) = seed_job_with_items(&db, &root.0, &s, &["甲", "乙", "丙"], "");
        finish_paste_job(
            &db,
            &job,
            "failed",
            2,
            std::slice::from_ref(&ids[1]),
            std::slice::from_ref(&ids[0]),
            "不确定",
            false,
        )
        .unwrap();
        // 显式落到 uncertain 终态（写 finished_at/key_sent），并残留上一轮投递时间，
        // 验证 resend 回 pending 时这些痕迹被清掉。
        record_paste_item_state(&db, &job, &ids[0], "uncertain", Some("不确定")).unwrap();
        db.with_conn(|c| {
            c.execute(
                "UPDATE clipboard_paste_items SET dispatch_started_at = ?1
                 WHERE job_id = ?2 AND item_id = ?3",
                params!["2026-01-01T00:00:00Z", job, ids[0]],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        resolve_uncertain_item(&db, &job, &ids[0], "resend").unwrap();
        let row = get_paste_job(&db, &job).unwrap();
        assert_eq!(
            row.remaining_items,
            vec![ids[0].clone(), ids[1].clone()],
            "重发按原始 position 升序排回队列"
        );
        let item = list_paste_items(&db, &job)
            .unwrap()
            .into_iter()
            .find(|r| r.item_id == ids[0])
            .unwrap();
        assert_eq!(item.state, "pending");
        assert!(item.finished_at.is_none(), "pending 阶段不得残留 finished_at");
        assert!(
            item.dispatch_started_at.is_none(),
            "重新 pending 必须清空 dispatch_started_at"
        );
        assert!(!item.key_sent, "新一轮尝试尚未发按键");
        assert!(!item.confirmed);
        assert!(item.retry_safe, "新一轮未发按键，可安全重试");
    }

    #[test]
    fn received_confirms_and_removes_from_unresolved_set() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (ids, job) = seed_job_with_items(&db, &root.0, &s, &["一", "二"], "");
        finish_paste_job(
            &db,
            &job,
            "failed",
            1,
            std::slice::from_ref(&ids[1]),
            std::slice::from_ref(&ids[0]),
            "不确定",
            false,
        )
        .unwrap();
        resolve_uncertain_item(&db, &job, &ids[0], "received").unwrap();
        let row = get_paste_job(&db, &job).unwrap();
        assert!(row.uncertain_items.is_empty());
        let item = list_paste_items(&db, &job)
            .unwrap()
            .into_iter()
            .find(|r| r.item_id == ids[0])
            .unwrap();
        assert_eq!(item.state, "confirmed");
        assert!(item.confirmed);
    }

    #[test]
    fn uncertain_stays_uncertain_across_repeated_recovery() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (ids, job) = seed_job_with_items(&db, &root.0, &s, &["一", "二"], "");
        finish_paste_job(
            &db,
            &job,
            "failed",
            1,
            std::slice::from_ref(&ids[1]),
            std::slice::from_ref(&ids[0]),
            "不确定",
            false,
        )
        .unwrap();
        interrupt_stale_paste_jobs(&db).unwrap();
        interrupt_stale_paste_jobs(&db).unwrap();
        let row = get_paste_job(&db, &job).unwrap();
        assert!(row.uncertain_items.contains(&ids[0]), "不处置时不得自动移除");
        let item = list_paste_items(&db, &job)
            .unwrap()
            .into_iter()
            .find(|r| r.item_id == ids[0])
            .unwrap();
        assert_eq!(item.state, "uncertain", "不确定项绝不自动变 pending");
    }

    #[test]
    fn two_uncertain_items_resolved_independently() {
        let db = Db::open_in_memory().unwrap();
        let root = TempRoot::new();
        let s = settings();
        let (ids, job) = seed_job_with_items(&db, &root.0, &s, &["甲", "乙", "丙"], "");
        finish_paste_job(
            &db,
            &job,
            "failed",
            1,
            std::slice::from_ref(&ids[2]),
            &[ids[0].clone(), ids[1].clone()],
            "两项不确定",
            false,
        )
        .unwrap();
        // 甲确认已接收；乙明确要求重发。两项处置互不影响。
        resolve_uncertain_item(&db, &job, &ids[0], "received").unwrap();
        resolve_uncertain_item(&db, &job, &ids[1], "resend").unwrap();
        let row = get_paste_job(&db, &job).unwrap();
        assert!(row.uncertain_items.is_empty());
        assert!(!row.remaining_items.contains(&ids[0]), "confirmed 项不回队列");
        assert!(row.remaining_items.contains(&ids[1]), "resend 项回队列");
        let a = list_paste_items(&db, &job)
            .unwrap()
            .into_iter()
            .find(|r| r.item_id == ids[0])
            .unwrap();
        let b = list_paste_items(&db, &job)
            .unwrap()
            .into_iter()
            .find(|r| r.item_id == ids[1])
            .unwrap();
        assert_eq!(a.state, "confirmed");
        assert_eq!(b.state, "pending");
    }
}
