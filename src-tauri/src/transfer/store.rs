//! 工作篮条目数据层。
//!
//! 关键约束：
//! - 所有写入在**单一写连接**上完成（`Db::with_conn`），去重检查与插入在同一事务内，
//!   避免并发加入同一条内容产生两行；
//! - 正文分级：≤64KB 内联；更大写入 `transfer_contents`；>512KB 拒绝；
//! - 列表查询不读取 `transfer_contents` 的大字段（按需批量解析）；
//! - 引用可用性在读取时计算（不落库），失效不删除条目，只标记不可用；
//! - 清理只动终态且非固定的行，绝不默认删除用户尚未处理的内容；
//! - **禁止在 `with_conn` 闭包内再次调用 `with_conn`**（单写连接会自锁）。

use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension, Row};
use serde_json::json;

use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::file_workspace as fw;

use super::{
    content_hash, dedupe_key, is_allowed, TransferAddReport, TransferCounts, TransferFilter,
    TransferItem, TransferItemInput, TransferItemPatch, TransferPage, TransferRejection, ITEM_TYPES,
    MAX_ADD_BATCH, MAX_CONTENT, MAX_DESCRIPTION_CHARS, MAX_INLINE_CONTENT, MAX_LIST_LIMIT,
    MAX_TITLE_CHARS, SOURCE_MODULES,
};

const COLUMNS: &str = "id, item_type, source_module, source_id, dedupe_key, title, description, \
     content, content_ref, payload_json, sort_order, pinned, status, error_code, error_message, \
     last_target, created_at, updated_at, sent_at, expires_at";

fn read_item(row: &Row<'_>) -> rusqlite::Result<TransferItem> {
    let payload_json: String = row.get(9)?;
    Ok(TransferItem {
        id: row.get(0)?,
        item_type: row.get(1)?,
        source_module: row.get(2)?,
        source_id: row.get(3)?,
        title: row.get(5)?,
        description: row.get(6)?,
        content: row.get(7)?,
        payload: serde_json::from_str(&payload_json).unwrap_or_else(|_| json!({})),
        sort_order: row.get(10)?,
        pinned: row.get::<_, i64>(11)? != 0,
        status: row.get(12)?,
        error_code: row.get(13)?,
        error_message: row.get(14)?,
        last_target: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
        sent_at: row.get(18)?,
        expires_at: row.get(19)?,
        available: true,
        unavailable_reason: String::new(),
    })
}

fn load_contents(conn: &Connection, refs: &[String]) -> AppResult<Vec<(String, String)>> {
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (1..=refs.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!("SELECT id, body FROM transfer_contents WHERE id IN ({placeholders})");
    let mut stmt = conn.prepare(&sql)?;
    let values: Vec<Value> = refs.iter().map(|r| Value::Text(r.clone())).collect();
    let rows = stmt.query_map(params_from_iter(values), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// 批量读取条目（按给定 id 顺序返回；用于执行与详情）。
pub fn load_items(db: &Db, ids: &[String]) -> AppResult<Vec<TransferItem>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    db.with_conn(|conn| load_items_in_conn(conn, ids))
}

pub(crate) fn load_items_in_conn(
    conn: &Connection,
    ids: &[String],
) -> AppResult<Vec<TransferItem>> {
    let placeholders = (1..=ids.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql =
        format!("SELECT {COLUMNS}, content_ref FROM transfer_items WHERE id IN ({placeholders})");
    let mut stmt = conn.prepare(&sql)?;
    let values: Vec<Value> = ids.iter().map(|id| Value::Text(id.clone())).collect();
    let rows = stmt.query_map(params_from_iter(values), |row| {
        let item = read_item(row)?;
        let cref: Option<String> = row.get(20)?;
        Ok((item, cref))
    })?;
    let mut by_id: std::collections::HashMap<String, (TransferItem, Option<String>)> =
        std::collections::HashMap::new();
    for row in rows {
        let (item, cref) = row?;
        by_id.insert(item.id.clone(), (item, cref));
    }
    let refs: Vec<String> = by_id.values().filter_map(|(_, r)| r.clone()).collect();
    let bodies: std::collections::HashMap<String, String> =
        load_contents(conn, &refs)?.into_iter().collect();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some((mut item, cref)) = by_id.remove(id) {
            if item.content.is_empty() {
                if let Some(r) = cref {
                    item.content = bodies.get(&r).cloned().unwrap_or_default();
                }
            }
            annotate_availability(conn, &mut item)?;
            out.push(item);
        }
    }
    Ok(out)
}

pub(crate) fn load_one(conn: &Connection, id: &str) -> AppResult<TransferItem> {
    let sql = format!("SELECT {COLUMNS}, content_ref FROM transfer_items WHERE id = ?1");
    let (mut item, cref) = conn
        .query_row(&sql, params![id], |row| {
            Ok((read_item(row)?, row.get::<_, Option<String>>(20)?))
        })
        .optional()?
        .ok_or_else(|| AppError::NotFound("工作篮条目不存在".into()))?;
    if item.content.is_empty() {
        if let Some(cref) = cref {
            item.content = conn
                .query_row(
                    "SELECT body FROM transfer_contents WHERE id = ?1",
                    params![cref],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .unwrap_or_default();
        }
    }
    Ok(item)
}

fn derive_title(input: &TransferItemInput, normalized_content: &str) -> String {
    if !input.title.trim().is_empty() {
        return truncate_chars(input.title.trim(), MAX_TITLE_CHARS);
    }
    let from_content = normalized_content
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if !from_content.is_empty() {
        return truncate_chars(&from_content, 60);
    }
    if let Some(name) = input.payload.get("name").and_then(|v| v.as_str()) {
        if !name.trim().is_empty() {
            return truncate_chars(name.trim(), MAX_TITLE_CHARS);
        }
    }
    if let Some(path) = input.payload.get("path").and_then(|v| v.as_str()) {
        if let Some(name) = std::path::Path::new(path).file_name() {
            return truncate_chars(&name.to_string_lossy(), MAX_TITLE_CHARS);
        }
    }
    if let Some(snapshot) = input.payload.get("snapshotTitle").and_then(|v| v.as_str()) {
        if !snapshot.trim().is_empty() {
            return truncate_chars(snapshot.trim(), MAX_TITLE_CHARS);
        }
    }
    "未命名内容".to_string()
}

fn truncate_chars(value: &str, max: usize) -> String {
    let mut out = String::new();
    for (idx, ch) in value.chars().enumerate() {
        if idx >= max {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

fn validate_content_size(content: &str, title: &str) -> AppResult<()> {
    if content.len() > MAX_CONTENT {
        return Err(AppError::Validation(format!(
            "TRANSFER_CONTENT_TOO_LARGE|{title}|正文超过 {}KB，请另存为文件后再加入",
            MAX_CONTENT / 1024
        )));
    }
    Ok(())
}

/// 引用是否存在（实体类型 → 表名）。仅做轻量主键查询。
pub(crate) fn entity_exists(conn: &Connection, entity_type: &str, id: &str) -> AppResult<bool> {
    let table = match entity_type {
        "task" => "tasks",
        "workspace_project" => "workspace_projects",
        "planning_project" => "planning_projects",
        "planning_feature" => "planning_features",
        "planning_step" => "planning_steps",
        "knowledge_doc" => "knowledge_documents",
        "capture" => "quick_capture_items",
        "shelf_item" => "shelf_items",
        "clipboard_item" => "clipboard_items",
        "file" => return Ok(std::path::Path::new(id).is_file()),
        _ => return Ok(false),
    };
    let sql = format!("SELECT 1 FROM {table} WHERE id = ?1 LIMIT 1");
    Ok(conn
        .query_row(&sql, params![id], |_| Ok(()))
        .optional()?
        .is_some())
}

fn clipboard_item_exists(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM clipboard_items WHERE id = ?1 LIMIT 1",
            params![id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

struct Prepared {
    item_type: String,
    source_module: String,
    source_id: String,
    dedupe: String,
    title: String,
    description: String,
    content: String,
    overflow: Option<String>,
    payload: serde_json::Value,
    pinned: bool,
    id: Option<String>,
}

fn reject(title: impl Into<String>, code: &str, message: impl Into<String>) -> Result<Prepared, TransferRejection> {
    Err(TransferRejection {
        title: title.into(),
        code: code.into(),
        message: message.into(),
    })
}

fn prepare(conn: &Connection, input: &TransferItemInput) -> AppResult<Result<Prepared, TransferRejection>> {
    let item_type = input.item_type.trim();
    if !is_allowed(ITEM_TYPES, item_type) {
        return Ok(reject(input.title.clone(), "validation", format!("未知内容类型: {item_type}")));
    }
    let source_module = input.source_module.trim();
    if !is_allowed(SOURCE_MODULES, source_module) {
        return Ok(reject(
            input.title.clone(),
            "validation",
            format!("未知来源模块: {source_module}"),
        ));
    }

    let mut content = input.content.clone();
    let mut payload = if input.payload.is_null() {
        json!({})
    } else {
        input.payload.clone()
    };
    let mut source_id = input.source_id.trim().to_string();
    let mut fallback = String::new();

    match item_type {
        "text" | "richtext" | "url" => {
            if content.trim().is_empty() {
                return Ok(reject(derive_title(input, &content), "validation", "内容为空"));
            }
            let title = derive_title(input, &content);
            if let Err(e) = validate_content_size(&content, &title) {
                return Ok(reject(title, "TRANSFER_CONTENT_TOO_LARGE", e.to_string()));
            }
            if source_id.is_empty() {
                fallback = content_hash(&content);
            }
        }
        "file" | "directory" => {
            let raw = payload
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let Ok(path) = fw::validate_abs_path(&raw) else {
                return Ok(reject(
                    derive_title(input, ""),
                    "TRANSFER_SOURCE_MISSING",
                    "路径为空或不是绝对路径",
                ));
            };
            let Some(meta) = std::fs::metadata(&path).ok() else {
                return Ok(reject(
                    derive_title(input, ""),
                    "TRANSFER_SOURCE_MISSING",
                    "文件或目录不存在",
                ));
            };
            let is_dir = meta.is_dir();
            if (item_type == "directory") != is_dir {
                return Ok(reject(
                    derive_title(input, ""),
                    "validation",
                    "类型与路径实际形态不一致",
                ));
            }
            let normalized = path.to_string_lossy().to_string();
            if let Some(map) = payload.as_object_mut() {
                map.insert("path".into(), json!(normalized));
                if map.get("size").is_none() {
                    map.insert("size".into(), json!(meta.len()));
                }
            }
            source_id = normalized.to_ascii_lowercase();
            content.clear();
        }
        "image" | "clipboard" => {
            let cid = payload
                .get("clipboardItemId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if cid.is_empty() {
                return Ok(reject(
                    derive_title(input, ""),
                    "validation",
                    "缺少剪贴板条目引用",
                ));
            }
            if !clipboard_item_exists(conn, &cid)? {
                return Ok(reject(
                    derive_title(input, ""),
                    "TRANSFER_SOURCE_MISSING",
                    "剪贴板条目已被清理",
                ));
            }
            source_id = cid;
            content.clear();
        }
        "task" | "project" | "planning" | "knowledge" | "capture" => {
            if source_id.is_empty() {
                return Ok(reject(derive_title(input, ""), "validation", "缺少实体 id"));
            }
            let entity_type = match item_type {
                "task" => "task",
                "project" => "workspace_project",
                "planning" => "planning_feature",
                "knowledge" => "knowledge_doc",
                "capture" => "capture",
                _ => unreachable!(),
            };
            if !entity_exists(conn, entity_type, &source_id)? {
                return Ok(reject(
                    derive_title(input, ""),
                    "TRANSFER_SOURCE_MISSING",
                    "来源实体不存在或已被删除",
                ));
            }
            content.clear();
        }
        _ => return Ok(reject(input.title.clone(), "validation", "未知内容类型")),
    }

    let title = derive_title(input, &content);
    let description = truncate_chars(input.description.trim(), MAX_DESCRIPTION_CHARS);
    let dedupe = dedupe_key(item_type, source_module, &source_id, &fallback);
    let overflow = if content.len() > MAX_INLINE_CONTENT {
        Some(content.clone())
    } else {
        None
    };
    let stored_content = if overflow.is_some() {
        String::new()
    } else {
        content
    };
    Ok(Ok(Prepared {
        item_type: item_type.to_string(),
        source_module: source_module.to_string(),
        source_id,
        dedupe,
        title,
        description,
        content: stored_content,
        overflow,
        payload,
        pinned: input.pinned,
        id: input.id.clone().filter(|id| !id.trim().is_empty()),
    }))
}

fn is_unique_violation(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(code, _)
            if code.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

fn find_active_by_dedupe(conn: &Connection, dedupe: &str) -> AppResult<Option<TransferItem>> {
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM transfer_items WHERE dedupe_key = ?1
             AND status IN ('ready','sending','failed') LIMIT 1",
            params![dedupe],
            |row| row.get(0),
        )
        .optional()?;
    match id {
        Some(id) => Ok(Some(load_one(conn, &id)?)),
        None => Ok(None),
    }
}

/// 加入条目：逐条校验，部分成功（其余条目继续）。
pub fn add_items(db: &Db, inputs: Vec<TransferItemInput>) -> AppResult<TransferAddReport> {
    if inputs.is_empty() {
        return Err(AppError::Validation("没有要加入的内容".into()));
    }
    if inputs.len() > MAX_ADD_BATCH {
        return Err(AppError::Validation(format!(
            "单次最多加入 {MAX_ADD_BATCH} 条"
        )));
    }
    let report = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut items = Vec::new();
        let mut duplicates = 0usize;
        let mut rejected = Vec::new();
        for input in &inputs {
            match prepare(&tx, input)? {
                Err(rej) => rejected.push(rej),
                Ok(prep) => {
                    if let Some(existing) = find_active_by_dedupe(&tx, &prep.dedupe)? {
                        duplicates += 1;
                        items.push(existing);
                        continue;
                    }
                    let id = prep
                        .id
                        .clone()
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    let now = now_iso();
                    let sort_order: f64 = tx.query_row(
                        "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM transfer_items",
                        [],
                        |row| row.get(0),
                    )?;
                    let content_ref = if let Some(body) = &prep.overflow {
                        let cid = uuid::Uuid::new_v4().to_string();
                        tx.execute(
                            "INSERT INTO transfer_contents (id, body, created_at) VALUES (?1, ?2, ?3)",
                            params![cid, body, now],
                        )?;
                        Some(cid)
                    } else {
                        None
                    };
                    let payload_json =
                        serde_json::to_string(&prep.payload).unwrap_or_else(|_| "{}".into());
                    let insert = tx.execute(
                        "INSERT INTO transfer_items (
                            id, item_type, source_module, source_id, dedupe_key, title, description,
                            content, content_ref, payload_json, sort_order, pinned, status,
                            error_code, error_message, last_target, created_at, updated_at,
                            sent_at, expires_at
                         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'ready','','','',?13,?13,NULL,NULL)",
                        params![
                            id,
                            prep.item_type,
                            prep.source_module,
                            prep.source_id,
                            prep.dedupe,
                            prep.title,
                            prep.description,
                            prep.content,
                            content_ref,
                            payload_json,
                            sort_order,
                            if prep.pinned { 1i64 } else { 0i64 },
                            now
                        ],
                    );
                    match insert {
                        Ok(_) => items.push(load_one(&tx, &id)?),
                        Err(e) if is_unique_violation(&e) => {
                            if let Some(existing) = find_active_by_dedupe(&tx, &prep.dedupe)? {
                                duplicates += 1;
                                items.push(existing);
                            } else {
                                rejected.push(TransferRejection {
                                    title: prep.title.clone(),
                                    code: "conflict".into(),
                                    message: "重复加入失败".into(),
                                });
                            }
                        }
                        Err(e) => return Err(AppError::from(e)),
                    }
                }
            }
        }
        tx.commit()?;
        Ok(TransferAddReport {
            items,
            duplicates,
            rejected,
        })
    })?;
    // 清理在写入连接释放之后执行（不能在 with_conn 内嵌套 with_conn）。
    let _ = sweep(db, super::DEFAULT_SENT_RETENTION_DAYS);
    Ok(report)
}

fn annotate_availability(conn: &Connection, item: &mut TransferItem) -> AppResult<()> {
    item.available = true;
    item.unavailable_reason.clear();
    match item.item_type.as_str() {
        "file" | "directory" => {
            let path = item
                .payload
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if path.is_empty() || std::fs::metadata(path).is_err() {
                item.available = false;
                item.unavailable_reason = "TRANSFER_SOURCE_MISSING".into();
            }
        }
        "image" | "clipboard" => {
            let cid = item
                .payload
                .get("clipboardItemId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if cid.is_empty() || !clipboard_item_exists(conn, cid)? {
                item.available = false;
                item.unavailable_reason = "TRANSFER_SOURCE_MISSING".into();
            }
        }
        "task" | "project" | "planning" | "knowledge" | "capture" => {
            let entity_type = match item.item_type.as_str() {
                "task" => "task",
                "project" => "workspace_project",
                "planning" => "planning_feature",
                "knowledge" => "knowledge_doc",
                "capture" => "capture",
                _ => "",
            };
            if item.source_id.is_empty() || !entity_exists(conn, entity_type, &item.source_id)? {
                item.available = false;
                item.unavailable_reason = "TRANSFER_SOURCE_MISSING".into();
            }
        }
        _ => {}
    }
    Ok(())
}

/// 列表查询：分页 + 过滤 + 引用可用性。
pub fn list(db: &Db, filter: &TransferFilter) -> AppResult<TransferPage> {
    db.with_conn(|conn| {
        let mut wheres: Vec<String> = Vec::new();
        let mut values: Vec<Value> = Vec::new();
        if !filter.item_types.is_empty() {
            let valid: Vec<Value> = filter
                .item_types
                .iter()
                .filter(|t| is_allowed(ITEM_TYPES, t))
                .map(|t| Value::Text(t.clone()))
                .collect();
            if !valid.is_empty() {
                let start = values.len() + 1;
                let placeholders = (0..valid.len())
                    .map(|i| format!("?{}", start + i))
                    .collect::<Vec<_>>()
                    .join(",");
                wheres.push(format!("item_type IN ({placeholders})"));
                values.extend(valid);
            }
        }
        if !filter.source_modules.is_empty() {
            let valid: Vec<Value> = filter
                .source_modules
                .iter()
                .filter(|t| is_allowed(SOURCE_MODULES, t))
                .map(|t| Value::Text(t.clone()))
                .collect();
            if !valid.is_empty() {
                let start = values.len() + 1;
                let placeholders = (0..valid.len())
                    .map(|i| format!("?{}", start + i))
                    .collect::<Vec<_>>()
                    .join(",");
                wheres.push(format!("source_module IN ({placeholders})"));
                values.extend(valid);
            }
        }
        if let Some(status) = filter.status.as_deref().filter(|s| !s.trim().is_empty()) {
            if matches!(status, "ready" | "sending" | "sent" | "failed" | "expired") {
                let idx = values.len() + 1;
                wheres.push(format!("status = ?{idx}"));
                values.push(Value::Text(status.to_string()));
            }
        }
        if let Some(term) = filter
            .search
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let idx = values.len() + 1;
            wheres.push(format!(
                "(title LIKE ?{idx} OR description LIKE ?{idx} OR content LIKE ?{idx})"
            ));
            values.push(Value::Text(format!("%{term}%")));
        }
        if filter.pinned_only {
            wheres.push("pinned = 1".into());
        }
        let where_sql = if wheres.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", wheres.join(" AND "))
        };
        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM transfer_items{where_sql}"),
            params_from_iter(values.clone()),
            |row| row.get(0),
        )?;
        let limit = filter
            .limit
            .unwrap_or(super::DEFAULT_LIST_LIMIT)
            .min(MAX_LIST_LIMIT) as i64;
        let offset = filter.offset.unwrap_or(0) as i64;
        let sql = format!(
            "SELECT {COLUMNS}, content_ref FROM transfer_items{where_sql}
             ORDER BY pinned DESC, sort_order ASC, created_at ASC LIMIT ?{} OFFSET ?{}",
            values.len() + 1,
            values.len() + 2
        );
        values.push(Value::Integer(limit));
        values.push(Value::Integer(offset));
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(values), |row| {
            Ok((read_item(row)?, row.get::<_, Option<String>>(20)?))
        })?;
        let mut pairs = Vec::new();
        for row in rows {
            pairs.push(row?);
        }
        let refs: Vec<String> = pairs.iter().filter_map(|(_, r)| r.clone()).collect();
        let bodies: std::collections::HashMap<String, String> =
            load_contents(conn, &refs)?.into_iter().collect();
        let mut items: Vec<TransferItem> = Vec::with_capacity(pairs.len());
        for (mut item, cref) in pairs {
            if item.content.is_empty() {
                if let Some(r) = cref {
                    item.content = bodies.get(&r).cloned().unwrap_or_default();
                }
            }
            annotate_availability(conn, &mut item)?;
            items.push(item);
        }
        Ok(TransferPage { items, total })
    })
}

pub fn get(db: &Db, id: &str) -> AppResult<TransferItem> {
    db.with_conn(|conn| {
        let mut item = load_one(conn, id)?;
        annotate_availability(conn, &mut item)?;
        Ok(item)
    })
}

pub fn update(db: &Db, id: &str, patch: &TransferItemPatch) -> AppResult<TransferItem> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut item = load_one(&tx, id)?;
        let mut content_changed = false;
        if let Some(title) = patch.title.as_deref() {
            item.title = truncate_chars(title.trim(), MAX_TITLE_CHARS);
        }
        if let Some(desc) = patch.description.as_deref() {
            item.description = truncate_chars(desc.trim(), MAX_DESCRIPTION_CHARS);
        }
        if let Some(pinned) = patch.pinned {
            item.pinned = pinned;
        }
        if let Some(status) = patch.status.as_deref() {
            if !matches!(status, "ready" | "expired") {
                return Err(AppError::Validation("只能手动设置为 ready 或 expired".into()));
            }
            item.status = status.to_string();
        }
        if let Some(content) = patch.content.as_deref() {
            if matches!(item.item_type.as_str(), "text" | "richtext" | "url") {
                validate_content_size(content, &item.title)?;
                item.content = content.to_string();
                content_changed = true;
            } else {
                return Err(AppError::Validation("只有文本类条目可以修改正文".into()));
            }
        }
        let now = now_iso();
        let mut content_ref: Option<String> = tx
            .query_row(
                "SELECT content_ref FROM transfer_items WHERE id = ?1",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        if content_changed {
            let dedupe = dedupe_key(
                &item.item_type,
                &item.source_module,
                &item.source_id,
                &content_hash(&item.content),
            );
            if let Some(other) = tx
                .query_row(
                    "SELECT id FROM transfer_items WHERE dedupe_key = ?1
                     AND status IN ('ready','sending','failed') AND id <> ?2 LIMIT 1",
                    params![dedupe, id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
            {
                return Err(AppError::Conflict(format!("内容已在工作篮中（条目 {other}）")));
            }
            if item.content.len() > MAX_INLINE_CONTENT {
                let cid = uuid::Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO transfer_contents (id, body, created_at) VALUES (?1, ?2, ?3)",
                    params![cid, item.content, now],
                )?;
                content_ref = Some(cid);
            } else {
                content_ref = None;
            }
        }
        let stored_content = if content_ref.is_some() {
            String::new()
        } else {
            item.content.clone()
        };
        tx.execute(
            "UPDATE transfer_items SET title = ?2, description = ?3, content = ?4,
             content_ref = ?5, pinned = ?6, status = ?7, updated_at = ?8 WHERE id = ?1",
            params![
                id,
                item.title,
                item.description,
                stored_content,
                content_ref,
                if item.pinned { 1i64 } else { 0i64 },
                item.status,
                now
            ],
        )?;
        tx.commit()?;
        let mut updated = load_one(conn, id)?;
        annotate_availability(conn, &mut updated)?;
        Ok(updated)
    })
}

pub fn remove(db: &Db, ids: &[String]) -> AppResult<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut removed = 0usize;
        for id in ids {
            removed += tx.execute("DELETE FROM transfer_items WHERE id = ?1", params![id])?;
        }
        tx.execute(
            "DELETE FROM transfer_contents WHERE id NOT IN (
                SELECT content_ref FROM transfer_items WHERE content_ref IS NOT NULL
             )",
            [],
        )?;
        tx.commit()?;
        Ok(removed)
    })
}

pub fn reorder(db: &Db, ids: &[String]) -> AppResult<()> {
    if ids.is_empty() {
        return Err(AppError::Validation("没有要排序的条目".into()));
    }
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let ordered: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM transfer_items
                 ORDER BY pinned DESC, sort_order ASC, created_at ASC",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            out
        };
        for id in ids {
            if !ordered.iter().any(|existing| existing == id) {
                return Err(AppError::NotFound(format!("条目不存在: {id}")));
            }
        }
        let positions: Vec<usize> = ordered
            .iter()
            .enumerate()
            .filter(|(_, id)| ids.iter().any(|s| s == *id))
            .map(|(idx, _)| idx)
            .collect();
        let mut reordered = ordered.clone();
        for (slot, idx) in positions.iter().enumerate() {
            if let Some(next) = ids.get(slot) {
                reordered[*idx] = next.clone();
            }
        }
        // 调用方只传了部分 id：未覆盖到的按新顺序追加，绝不丢行。
        if ids.len() > positions.len() {
            for id in ids.iter().skip(positions.len()) {
                reordered.retain(|existing| existing != id);
                reordered.push(id.clone());
            }
        }
        for (index, id) in reordered.iter().enumerate() {
            tx.execute(
                "UPDATE transfer_items SET sort_order = ?2 WHERE id = ?1",
                params![id, (index + 1) as f64],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

pub fn pin(db: &Db, id: &str, pinned: bool) -> AppResult<TransferItem> {
    db.with_conn(|conn| {
        let changed = conn.execute(
            "UPDATE transfer_items SET pinned = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, if pinned { 1i64 } else { 0i64 }, now_iso()],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("工作篮条目不存在".into()));
        }
        let mut item = load_one(conn, id)?;
        annotate_availability(conn, &mut item)?;
        Ok(item)
    })
}

pub fn clear_temporary(db: &Db) -> AppResult<usize> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let removed = tx.execute(
            "DELETE FROM transfer_items WHERE pinned = 0 AND status IN ('ready','expired')",
            [],
        )?;
        tx.execute(
            "DELETE FROM transfer_contents WHERE id NOT IN (
                SELECT content_ref FROM transfer_items WHERE content_ref IS NOT NULL
             )",
            [],
        )?;
        tx.commit()?;
        Ok(removed)
    })
}

pub fn counts(db: &Db) -> AppResult<TransferCounts> {
    db.with_read(|conn| {
        let total = conn.query_row("SELECT COUNT(*) FROM transfer_items", [], |r| r.get(0))?;
        let ready = conn.query_row(
            "SELECT COUNT(*) FROM transfer_items WHERE status = 'ready'",
            [],
            |r| r.get(0),
        )?;
        let failed = conn.query_row(
            "SELECT COUNT(*) FROM transfer_items WHERE status = 'failed'",
            [],
            |r| r.get(0),
        )?;
        let pinned = conn.query_row(
            "SELECT COUNT(*) FROM transfer_items WHERE pinned = 1",
            [],
            |r| r.get(0),
        )?;
        Ok(TransferCounts {
            total,
            ready,
            failed,
            pinned,
        })
    })
}

/// 清理终态条目：只按天淘汰发送成功与过期项，固定项永不清理。
pub fn sweep(db: &Db, sent_retention_days: i64) -> AppResult<usize> {
    let sent_days = sent_retention_days.max(0);
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut removed = 0usize;
        if sent_days > 0 {
            let cutoff = chrono::Utc::now() - chrono::Duration::days(sent_days);
            removed += tx.execute(
                "DELETE FROM transfer_items
                 WHERE pinned = 0 AND status = 'sent' AND sent_at IS NOT NULL AND sent_at < ?1",
                params![cutoff.to_rfc3339()],
            )?;
        }
        let cutoff = chrono::Utc::now() - chrono::Duration::days(super::EXPIRED_RETENTION_DAYS);
        removed += tx.execute(
            "DELETE FROM transfer_items
             WHERE pinned = 0 AND status = 'expired' AND updated_at < ?1",
            params![cutoff.to_rfc3339()],
        )?;
        if removed > 0 {
            tx.execute(
                "DELETE FROM transfer_contents WHERE id NOT IN (
                    SELECT content_ref FROM transfer_items WHERE content_ref IS NOT NULL
                 )",
                [],
            )?;
        }
        tx.commit()?;
        Ok(removed)
    })
}

/// 批次终态：把条目更新为 sent / failed（真实结果，不以事件代替）。
pub fn mark_outcome(
    db: &Db,
    outcomes: &[(String, bool, String, String)],
    target_ref: &str,
    retention_days: i64,
) -> AppResult<()> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let now = now_iso();
        let sent_expiry = if retention_days > 0 {
            Some((chrono::Utc::now() + chrono::Duration::days(retention_days)).to_rfc3339())
        } else {
            None
        };
        for (id, ok, code, message) in outcomes {
            if *ok {
                tx.execute(
                    "UPDATE transfer_items SET status = 'sent', sent_at = ?2, updated_at = ?2,
                     error_code = '', error_message = '', last_target = ?3, expires_at = ?4
                     WHERE id = ?1",
                    params![id, now, target_ref, sent_expiry],
                )?;
            } else {
                tx.execute(
                    "UPDATE transfer_items SET status = 'failed', updated_at = ?2,
                     error_code = ?3, error_message = ?4 WHERE id = ?1",
                    params![id, now, code, message],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    })
}

pub fn mark_sending(db: &Db, ids: &[String]) -> AppResult<()> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let now = now_iso();
        for id in ids {
            tx.execute(
                "UPDATE transfer_items SET status = 'sending', updated_at = ?2 WHERE id = ?1",
                params![id, now],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

/// 完整正文（含溢出内容）：供执行层使用。
pub fn resolve_text(conn: &Connection, item: &TransferItem) -> AppResult<String> {
    if !item.content.is_empty() {
        return Ok(item.content.clone());
    }
    let cref: Option<String> = conn
        .query_row(
            "SELECT content_ref FROM transfer_items WHERE id = ?1",
            params![item.id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    if let Some(cref) = cref {
        return Ok(conn
            .query_row(
                "SELECT body FROM transfer_contents WHERE id = ?1",
                params![cref],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_default());
    }
    Ok(String::new())
}
