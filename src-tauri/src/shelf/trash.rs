//! 暂存条目回收站：软删除快照、撤销恢复与保留期清理。
//!
//! 与 `shelf::delete_items` 的区别：本模块面向「可撤销删除」——
//! - 软删除只把整行 + 标签 + 任务/项目关联写成 JSON 快照存进 `shelf_trash`，
//!   再从 `shelf_items` 删行；托管文件与缩略图在保留期内**原样保留**；
//! - 撤销按快照恢复行与关系，不覆盖恢复时已存在的同 id 条目；
//! - 只有 `purge_*`（过期或用户显式清理）才删除托管文件。
//!
//! 安全边界：
//! - 恢复时按 `PRAGMA table_info` 裁剪未知列，兼容旧快照/未来加列；
//! - 清理托管文件统一经 `safe_managed_rel` + canonical 根目录复核，绝不逃逸 shelf 根；
//! - 报告只含计数，不输出条目内容或路径明文。

use std::collections::HashSet;
use std::path::Path;

use chrono::{Duration, Utc};
use rusqlite::types::{ToSql, Value as SqlValue, ValueRef};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{Map, Value as JsonValue};

use super::{is_within_root, now_iso, safe_managed_rel};
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 回收站保留时长：7 天。
pub const TRASH_RETENTION_HOURS: i64 = 7 * 24;
/// 单次软删除的条目上限：超出部分不处理（不静默丢弃计数，调用方按 removed 判断）。
pub const MAX_TRASH_ITEMS: usize = 500;

#[derive(Debug, Clone, Serialize)]
pub struct TrashDeleteReport {
    pub batch_id: String,
    pub removed: usize,
    pub skipped_protected: usize,
    pub managed_retained: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrashRestoreReport {
    pub batch_id: String,
    pub restored: usize,
    pub conflicts: usize,
    pub restored_relations: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrashPurgeReport {
    pub batches: usize,
    pub items: usize,
    pub freed_bytes: i64,
    pub failed_files: usize,
}

struct Snapshot {
    payload: String,
    protected: bool,
    has_managed: bool,
}

struct TrashRow {
    id: String,
    batch_id: String,
    deleted_at: String,
    payload: String,
}

// ── 软删除 ──────────────────────────────────────────────────

/// 把条目移入回收站：快照整行与关系后删除 `shelf_items` 行，不删除任何托管文件。
pub fn soft_delete(
    db: &Db,
    ids: &[String],
    include_protected: bool,
) -> AppResult<TrashDeleteReport> {
    if ids.is_empty() {
        return Ok(empty_delete_report());
    }
    let mut seen = HashSet::new();
    let unique: Vec<String> = ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .filter(|id| seen.insert(id.to_string()))
        .map(str::to_string)
        .take(MAX_TRASH_ITEMS)
        .collect();
    if unique.is_empty() {
        return Ok(empty_delete_report());
    }

    let batch_id = uuid::Uuid::new_v4().to_string();
    let (removed, skipped_protected, managed_retained) = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut removed = 0usize;
        let mut skipped_protected = 0usize;
        let mut managed_retained = 0usize;
        for id in &unique {
            let Some(snapshot) = snapshot_item(&tx, id)? else {
                continue;
            };
            if !include_protected && snapshot.protected {
                skipped_protected += 1;
                continue;
            }
            tx.execute(
                "INSERT INTO shelf_trash (id, batch_id, deleted_at, payload) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    batch_id,
                    now_iso(),
                    snapshot.payload
                ],
            )?;
            tx.execute("DELETE FROM shelf_items WHERE id = ?1", params![id])?;
            removed += 1;
            if snapshot.has_managed {
                managed_retained += 1;
            }
        }
        tx.commit()?;
        Ok((removed, skipped_protected, managed_retained))
    })?;

    Ok(TrashDeleteReport {
        batch_id: if removed > 0 {
            batch_id
        } else {
            String::new()
        },
        removed,
        skipped_protected,
        managed_retained,
    })
}

fn empty_delete_report() -> TrashDeleteReport {
    TrashDeleteReport {
        batch_id: String::new(),
        removed: 0,
        skipped_protected: 0,
        managed_retained: 0,
    }
}

fn snapshot_item(conn: &Connection, id: &str) -> AppResult<Option<Snapshot>> {
    let mut stmt = conn.prepare("SELECT * FROM shelf_items WHERE id = ?1")?;
    let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
    let row = stmt
        .query_row(params![id], |row| {
            let mut values = Vec::with_capacity(columns.len());
            for i in 0..columns.len() {
                values.push(value_to_json(row.get_ref(i)?));
            }
            Ok(values)
        })
        .optional()?;
    let Some(values) = row else {
        return Ok(None);
    };
    let mut item = Map::new();
    for (name, value) in columns.into_iter().zip(values) {
        item.insert(name, value);
    }
    let item_value = JsonValue::Object(item);
    let protected = item_value
        .get("favorite")
        .and_then(JsonValue::as_i64)
        .unwrap_or(0)
        != 0
        || item_value
            .get("pinned")
            .and_then(JsonValue::as_i64)
            .unwrap_or(0)
            != 0
        || item_value
            .get("scene_id")
            .map(|v| !v.is_null())
            .unwrap_or(false);
    let has_managed = item_value
        .get("managed_path")
        .and_then(JsonValue::as_str)
        .is_some_and(|s| !s.is_empty());

    let payload = serde_json::json!({
        "item": item_value,
        "tags": tag_rows(conn, id)?,
        "task_links": task_link_rows(conn, id)?,
        "project_links": project_link_rows(conn, id)?,
    })
    .to_string();

    Ok(Some(Snapshot {
        payload,
        protected,
        has_managed,
    }))
}

fn value_to_json(value: ValueRef<'_>) -> JsonValue {
    match value {
        ValueRef::Null => JsonValue::Null,
        ValueRef::Integer(i) => JsonValue::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        ValueRef::Text(bytes) => JsonValue::String(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(bytes) => JsonValue::Array(bytes.iter().map(|b| JsonValue::from(*b)).collect()),
    }
}

fn tag_rows(conn: &Connection, item_id: &str) -> AppResult<Vec<JsonValue>> {
    let mut stmt = conn.prepare(
        "SELECT tag, created_at FROM shelf_tags WHERE item_id = ?1 \
         ORDER BY created_at ASC, tag ASC",
    )?;
    let rows = stmt.query_map(params![item_id], |row| {
        Ok(serde_json::json!({
            "tag": row.get::<_, String>(0)?,
            "created_at": row.get::<_, String>(1)?,
        }))
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn task_link_rows(conn: &Connection, item_id: &str) -> AppResult<Vec<JsonValue>> {
    let mut stmt = conn.prepare(
        "SELECT task_id, created_at FROM shelf_task_links WHERE item_id = ?1 \
         ORDER BY created_at ASC, task_id ASC",
    )?;
    let rows = stmt.query_map(params![item_id], |row| {
        Ok(serde_json::json!({
            "task_id": row.get::<_, String>(0)?,
            "created_at": row.get::<_, String>(1)?,
        }))
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn project_link_rows(conn: &Connection, item_id: &str) -> AppResult<Vec<JsonValue>> {
    let mut stmt = conn.prepare(
        "SELECT project_id, created_at FROM shelf_project_links WHERE item_id = ?1 \
         ORDER BY created_at ASC, project_id ASC",
    )?;
    let rows = stmt.query_map(params![item_id], |row| {
        Ok(serde_json::json!({
            "project_id": row.get::<_, String>(0)?,
            "created_at": row.get::<_, String>(1)?,
        }))
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

// ── 恢复 ────────────────────────────────────────────────────

/// 撤销一次软删除：恢复仍不存在的条目与关系；同 id 已存在的条目只计冲突，
/// 不覆盖现存数据，并删除对应回收站行。批次不存在返回全 0。
pub fn restore(db: &Db, batch_id: &str) -> AppResult<TrashRestoreReport> {
    let batch = batch_id.trim();
    if batch.is_empty() {
        return Ok(empty_restore_report(batch));
    }
    db.with_conn(|conn| restore_inner(conn, batch))
}

fn empty_restore_report(batch: &str) -> TrashRestoreReport {
    TrashRestoreReport {
        batch_id: batch.to_string(),
        restored: 0,
        conflicts: 0,
        restored_relations: 0,
    }
}

fn restore_inner(conn: &Connection, batch_id: &str) -> AppResult<TrashRestoreReport> {
    let tx = conn.unchecked_transaction()?;
    let columns = table_columns(&tx, "shelf_items")?;
    let rows = {
        let mut stmt = tx.prepare(
            "SELECT id, payload FROM shelf_trash WHERE batch_id = ?1 ORDER BY rowid ASC",
        )?;
        let mapped = stmt.query_map(params![batch_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for row in mapped {
            out.push(row?);
        }
        out
    };
    let mut report = empty_restore_report(batch_id);
    for (trash_id, payload) in rows {
        let snapshot: JsonValue = serde_json::from_str(&payload)?;
        let mut item = snapshot
            .get("item")
            .and_then(JsonValue::as_object)
            .cloned()
            .ok_or_else(|| AppError::Validation("回收站快照缺少 item".into()))?;
        let item_id = item
            .get("id")
            .and_then(JsonValue::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::Validation("回收站快照缺少条目 id".into()))?
            .to_string();

        let exists = tx
            .query_row(
                "SELECT 1 FROM shelf_items WHERE id = ?1",
                params![item_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if exists {
            report.conflicts += 1;
            tx.execute("DELETE FROM shelf_trash WHERE id = ?1", params![trash_id])?;
            continue;
        }

        // 分组可能已在删除后被人为清理：指向不存在的分组时置 NULL，避免恢复失败。
        if let Some(group_id) = item
            .get("group_id")
            .and_then(JsonValue::as_str)
            .map(str::to_string)
        {
            let group_exists = tx
                .query_row(
                    "SELECT 1 FROM shelf_groups WHERE id = ?1",
                    params![group_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !group_exists {
                item.insert("group_id".into(), JsonValue::Null);
            }
        }

        insert_snapshot_item(&tx, &columns, &item)?;
        report.restored_relations += restore_relations(&tx, &snapshot, &item_id)?;
        tx.execute("DELETE FROM shelf_trash WHERE id = ?1", params![trash_id])?;
        report.restored += 1;
    }
    tx.commit()?;
    Ok(report)
}

fn table_columns(conn: &Connection, table: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn insert_snapshot_item(
    conn: &Connection,
    columns: &[String],
    item: &Map<String, JsonValue>,
) -> AppResult<()> {
    if !item.contains_key("id") {
        return Err(AppError::Validation("回收站快照缺少 id".into()));
    }
    let cols: Vec<&String> = columns
        .iter()
        .filter(|column| item.contains_key(column.as_str()))
        .collect();
    let names = cols
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = vec!["?"; cols.len()].join(", ");
    let sql = format!("INSERT INTO shelf_items ({names}) VALUES ({placeholders})");
    let values = cols
        .iter()
        .map(|column| json_to_sql(item.get(column.as_str()).unwrap_or(&JsonValue::Null)))
        .collect::<AppResult<Vec<SqlValue>>>()?;
    let refs: Vec<&dyn ToSql> = values.iter().map(|value| value as &dyn ToSql).collect();
    conn.execute(&sql, refs.as_slice())?;
    Ok(())
}

fn json_to_sql(value: &JsonValue) -> AppResult<SqlValue> {
    Ok(match value {
        JsonValue::Null => SqlValue::Null,
        JsonValue::Bool(flag) => SqlValue::Integer(i64::from(*flag)),
        JsonValue::Number(number) => match number.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None => SqlValue::Real(number.as_f64().unwrap_or(0.0)),
        },
        JsonValue::String(text) => SqlValue::Text(text.clone()),
        JsonValue::Array(values) => {
            let mut bytes = Vec::with_capacity(values.len());
            for value in values {
                match value.as_u64() {
                    Some(byte) if byte <= 255 => bytes.push(byte as u8),
                    _ => return Ok(SqlValue::Text(value.to_string())),
                }
            }
            SqlValue::Blob(bytes)
        }
        JsonValue::Object(_) => SqlValue::Text(value.to_string()),
    })
}

/// 恢复标签/任务关联/项目关联；只恢复目标仍存在的关系，返回实际写入行数。
fn restore_relations(
    conn: &Connection,
    snapshot: &JsonValue,
    item_id: &str,
) -> AppResult<usize> {
    let mut restored = 0usize;

    if let Some(tags) = snapshot.get("tags").and_then(JsonValue::as_array) {
        for tag in tags {
            let name = tag
                .as_str()
                .or_else(|| tag.get("tag").and_then(JsonValue::as_str));
            let Some(name) = name.filter(|name| !name.is_empty()) else {
                continue;
            };
            let created_at = tag
                .get("created_at")
                .and_then(JsonValue::as_str)
                .map(str::to_string)
                .unwrap_or_else(now_iso);
            restored += conn.execute(
                "INSERT OR IGNORE INTO shelf_tags (item_id, tag, created_at) \
                 VALUES (?1, ?2, ?3)",
                params![item_id, name, created_at],
            )?;
        }
    }

    if let Some(links) = snapshot.get("task_links").and_then(JsonValue::as_array) {
        for link in links {
            let Some(task_id) = link
                .get("task_id")
                .and_then(JsonValue::as_str)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            let exists = conn
                .query_row(
                    "SELECT 1 FROM tasks WHERE id = ?1",
                    params![task_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !exists {
                continue;
            }
            let created_at = link
                .get("created_at")
                .and_then(JsonValue::as_str)
                .map(str::to_string)
                .unwrap_or_else(now_iso);
            restored += conn.execute(
                "INSERT OR IGNORE INTO shelf_task_links (task_id, item_id, created_at) \
                 VALUES (?1, ?2, ?3)",
                params![task_id, item_id, created_at],
            )?;
        }
    }

    if let Some(links) = snapshot
        .get("project_links")
        .and_then(JsonValue::as_array)
    {
        for link in links {
            let Some(project_id) = link
                .get("project_id")
                .and_then(JsonValue::as_str)
                .filter(|id| !id.is_empty())
            else {
                continue;
            };
            let exists = conn
                .query_row(
                    "SELECT 1 FROM workspace_projects WHERE id = ?1",
                    params![project_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !exists {
                continue;
            }
            let created_at = link
                .get("created_at")
                .and_then(JsonValue::as_str)
                .map(str::to_string)
                .unwrap_or_else(now_iso);
            restored += conn.execute(
                "INSERT OR IGNORE INTO shelf_project_links (project_id, item_id, created_at) \
                 VALUES (?1, ?2, ?3)",
                params![project_id, item_id, created_at],
            )?;
        }
    }

    Ok(restored)
}

// ── 清理 ────────────────────────────────────────────────────

/// 清理一个批次：删除快照登记的托管文件与缩略图，然后删除回收站行。
pub fn purge_batch(db: &Db, root: &Path, batch_id: &str) -> AppResult<TrashPurgeReport> {
    let batch = batch_id.trim();
    if batch.is_empty() {
        return Ok(empty_purge_report());
    }
    let rows = load_rows(db, Some(batch))?;
    purge_rows(db, root, rows)
}

/// 清理超过保留期的批次（`deleted_at` 早于 now-7 天）。
pub fn purge_expired(db: &Db, root: &Path) -> AppResult<TrashPurgeReport> {
    let rows = load_rows(db, None)?;
    let cutoff = Utc::now() - Duration::hours(TRASH_RETENTION_HOURS);
    let expired: Vec<TrashRow> = rows
        .into_iter()
        .filter(|row| {
            chrono::DateTime::parse_from_rfc3339(&row.deleted_at)
                .map(|parsed| parsed.with_timezone(&Utc) < cutoff)
                .unwrap_or(false)
        })
        .collect();
    purge_rows(db, root, expired)
}

/// 回收站当前条目数。
pub fn count(db: &Db) -> AppResult<i64> {
    db.with_read(|conn| {
        conn.query_row("SELECT COUNT(*) FROM shelf_trash", [], |row| row.get(0))
            .map_err(AppError::from)
    })
}

fn empty_purge_report() -> TrashPurgeReport {
    TrashPurgeReport {
        batches: 0,
        items: 0,
        freed_bytes: 0,
        failed_files: 0,
    }
}

fn load_rows(db: &Db, batch_id: Option<&str>) -> AppResult<Vec<TrashRow>> {
    db.with_read(|conn| {
        let map_row = |row: &rusqlite::Row<'_>| {
            Ok(TrashRow {
                id: row.get(0)?,
                batch_id: row.get(1)?,
                deleted_at: row.get(2)?,
                payload: row.get(3)?,
            })
        };
        let mut out = Vec::new();
        match batch_id {
            Some(batch) => {
                let mut stmt = conn.prepare(
                    "SELECT id, batch_id, deleted_at, payload FROM shelf_trash \
                     WHERE batch_id = ?1 ORDER BY rowid ASC",
                )?;
                let rows = stmt.query_map(params![batch], map_row)?;
                for row in rows {
                    out.push(row?);
                }
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT id, batch_id, deleted_at, payload FROM shelf_trash ORDER BY rowid ASC",
                )?;
                let rows = stmt.query_map([], map_row)?;
                for row in rows {
                    out.push(row?);
                }
            }
        }
        Ok(out)
    })
}

fn purge_rows(db: &Db, root: &Path, rows: Vec<TrashRow>) -> AppResult<TrashPurgeReport> {
    if rows.is_empty() {
        return Ok(empty_purge_report());
    }
    let batches = rows
        .iter()
        .map(|row| row.batch_id.as_str())
        .collect::<HashSet<_>>()
        .len();
    let mut freed_bytes = 0i64;
    let mut failed_files = 0usize;
    for row in &rows {
        // 快照损坏时无法定位托管文件：只删除回收站行，避免占位永久卡住。
        if let Ok(snapshot) = serde_json::from_str::<JsonValue>(&row.payload) {
            if let Some(item) = snapshot.get("item") {
                purge_item_files(root, item, &mut freed_bytes, &mut failed_files);
            }
        }
    }
    let mut items = 0usize;
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for row in &rows {
            items += tx.execute("DELETE FROM shelf_trash WHERE id = ?1", params![row.id])?;
        }
        tx.commit()?;
        Ok(())
    })?;
    Ok(TrashPurgeReport {
        batches,
        items,
        freed_bytes,
        failed_files,
    })
}

fn purge_item_files(
    root: &Path,
    item: &JsonValue,
    freed_bytes: &mut i64,
    failed_files: &mut usize,
) {
    let byte_size = item
        .get("byte_size")
        .and_then(JsonValue::as_i64)
        .unwrap_or(0);
    if let Some(rel) = item
        .get("managed_path")
        .and_then(JsonValue::as_str)
        .filter(|rel| !rel.is_empty())
    {
        match safe_managed_rel(rel) {
            Ok(path) => remove_owned_file(root, &root.join(path), byte_size, freed_bytes, failed_files),
            Err(_) => *failed_files += 1,
        }
    }
    if let Some(id) = item
        .get("id")
        .and_then(JsonValue::as_str)
        .filter(|id| !id.is_empty())
    {
        match safe_managed_rel(&format!("thumbs/{id}.png")) {
            Ok(path) => remove_owned_file(root, &root.join(path), 0, freed_bytes, failed_files),
            Err(_) => *failed_files += 1,
        }
    }
}

fn remove_owned_file(
    root: &Path,
    file: &Path,
    size: i64,
    freed_bytes: &mut i64,
    failed_files: &mut usize,
) {
    match std::fs::symlink_metadata(file) {
        Ok(_) if is_within_root(root, file) => match std::fs::remove_file(file) {
            Ok(()) => *freed_bytes += size,
            Err(_) => *failed_files += 1,
        },
        Ok(_) => *failed_files += 1,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => *failed_files += 1,
    }
}

// ── 测试 ────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use rusqlite::params;

    fn test_db() -> Db {
        Db::open_in_memory().expect("in-memory db")
    }

    fn test_root(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "td-shelf-trash-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(dir.join("files")).expect("files dir");
        std::fs::create_dir_all(dir.join("thumbs")).expect("thumbs dir");
        dir
    }

    fn cleanup(root: &Path) {
        let _ = std::fs::remove_dir_all(root);
    }

    fn seed(db: &Db, text: &str) -> String {
        crate::shelf::add_text(db, text, "manual", None)
            .expect("add text")
            .id
    }

    /// 给条目挂上真实托管文件并返回其绝对路径。
    fn attach_managed(db: &Db, root: &Path, id: &str) -> std::path::PathBuf {
        let name = format!("{}.txt", uuid::Uuid::new_v4());
        let rel = format!("files/{name}");
        let abs = root.join("files").join(&name);
        let content = b"managed-bytes";
        std::fs::write(&abs, content).expect("write managed file");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE shelf_items SET managed_path = ?1, byte_size = ?2 WHERE id = ?3",
                params![rel, content.len() as i64, id],
            )
            .map_err(AppError::from)
        })
        .expect("update managed_path");
        abs
    }

    fn item_exists(db: &Db, id: &str) -> bool {
        db.with_read(|conn| {
            conn.query_row(
                "SELECT 1 FROM shelf_items WHERE id = ?1",
                params![id],
                |_| Ok(()),
            )
            .optional()
            .map(|row| row.is_some())
            .map_err(AppError::from)
        })
        .expect("query item")
    }

    fn insert_task(db: &Db, id: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tasks (id, title, created_at, updated_at) VALUES (?1, 't', ?2, ?2)",
                params![id, now_iso()],
            )
            .map_err(AppError::from)
        })
        .expect("insert task");
    }

    fn insert_project(db: &Db, id: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspace_projects \
                 (id, name, kind, status, root_path, note, created_at, updated_at) \
                 VALUES (?1, 'p', 'general', 'active', '', '', ?2, ?2)",
                params![id, now_iso()],
            )
            .map_err(AppError::from)
        })
        .expect("insert project");
    }

    #[test]
    fn soft_delete_keeps_managed_file_and_writes_snapshot() {
        let db = test_db();
        let root = test_root("soft-delete");
        let id = seed(&db, "soft delete item");
        let file = attach_managed(&db, &root, &id);
        let thumb = root.join("thumbs").join(format!("{id}.png"));
        std::fs::write(&thumb, b"thumb").expect("write thumb");

        let report = soft_delete(&db, &[id.clone()], false).expect("soft delete");
        assert_eq!(report.removed, 1);
        assert_eq!(report.skipped_protected, 0);
        assert_eq!(report.managed_retained, 1);
        assert!(!report.batch_id.is_empty());
        assert!(!item_exists(&db, &id));
        assert!(file.exists(), "托管文件必须保留到清理阶段");
        assert!(thumb.exists(), "缩略图必须保留到清理阶段");
        assert_eq!(count(&db).unwrap(), 1);

        let payload: String = db
            .with_read(|conn| {
                conn.query_row(
                    "SELECT payload FROM shelf_trash WHERE batch_id = ?1",
                    params![report.batch_id],
                    |row| row.get(0),
                )
                .map_err(AppError::from)
            })
            .expect("payload");
        let snapshot: JsonValue = serde_json::from_str(&payload).expect("snapshot json");
        let expected_rel = format!(
            "files/{}",
            file.file_name().unwrap().to_string_lossy()
        );
        assert_eq!(
            snapshot["item"]["managed_path"].as_str(),
            Some(expected_rel.as_str())
        );
        assert!(snapshot["tags"].is_array());

        cleanup(&root);
    }

    #[test]
    fn restore_brings_back_row_tags_group_and_relations() {
        let db = test_db();
        let root = test_root("restore");
        let group = crate::shelf::group_create(&db, "恢复分组").expect("group");
        let id = crate::shelf::add_text(&db, "restore item", "manual", Some(&group.id))
            .expect("add text")
            .id;
        let file = attach_managed(&db, &root, &id);
        let task_id = "task-restore";
        let project_id = "project-restore";
        insert_task(&db, task_id);
        insert_project(&db, project_id);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO shelf_task_links (task_id, item_id, created_at) VALUES (?1, ?2, ?3)",
                params![task_id, id, now_iso()],
            )?;
            conn.execute(
                "INSERT INTO shelf_project_links (project_id, item_id, created_at) \
                 VALUES (?1, ?2, ?3)",
                params![project_id, id, now_iso()],
            )?;
            Ok(())
        })
        .expect("insert links");
        crate::shelf::tags::add_tags(&db, &[id.clone()], &["素材".into()]).expect("tags");

        let report = soft_delete(&db, &[id.clone()], false).expect("soft delete");
        assert_eq!(report.removed, 1);
        assert!(!item_exists(&db, &id));

        let restored = restore(&db, &report.batch_id).expect("restore");
        assert_eq!(restored.restored, 1);
        assert_eq!(restored.conflicts, 0);
        assert_eq!(restored.restored_relations, 3);
        assert!(item_exists(&db, &id));
        assert_eq!(count(&db).unwrap(), 0);
        assert!(file.exists(), "恢复后托管文件仍可用");

        let (group_id, favorite): (Option<String>, i64) = db
            .with_read(|conn| {
                conn.query_row(
                    "SELECT group_id, favorite FROM shelf_items WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(AppError::from)
            })
            .expect("restored row");
        assert_eq!(group_id.as_deref(), Some(group.id.as_str()));
        assert_eq!(favorite, 0);
        assert_eq!(
            crate::shelf::tags::item_tags(&db, &id).unwrap(),
            vec!["素材".to_string()]
        );
        let links: (i64, i64) = db
            .with_read(|conn| {
                let tasks: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM shelf_task_links WHERE item_id = ?1",
                    params![id],
                    |row| row.get(0),
                )?;
                let projects: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM shelf_project_links WHERE item_id = ?1",
                    params![id],
                    |row| row.get(0),
                )?;
                Ok((tasks, projects))
            })
            .expect("restored links");
        assert_eq!(links, (1, 1));

        cleanup(&root);
    }

    #[test]
    fn restore_nulls_missing_group() {
        let db = test_db();
        let root = test_root("restore-group");
        let group = crate::shelf::group_create(&db, "临时分组").expect("group");
        let id = crate::shelf::add_text(&db, "group item", "manual", Some(&group.id))
            .expect("add text")
            .id;
        attach_managed(&db, &root, &id);
        let report = soft_delete(&db, &[id.clone()], false).expect("soft delete");
        crate::shelf::group_delete(&db, &group.id).expect("delete group");

        let restored = restore(&db, &report.batch_id).expect("restore");
        assert_eq!(restored.restored, 1);
        let group_id: Option<String> = db
            .with_read(|conn| {
                conn.query_row(
                    "SELECT group_id FROM shelf_items WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .map_err(AppError::from)
            })
            .expect("group id");
        assert_eq!(group_id, None, "已删除的分组必须置 NULL");

        cleanup(&root);
    }

    #[test]
    fn protected_items_are_skipped_unless_explicit() {
        let db = test_db();
        let id = seed(&db, "protected item");
        db.with_conn(|conn| {
            conn.execute("UPDATE shelf_items SET favorite = 1 WHERE id = ?1", params![id])
                .map_err(AppError::from)
        })
        .expect("favorite");

        let report = soft_delete(&db, &[id.clone()], false).expect("soft delete");
        assert_eq!(report.removed, 0);
        assert_eq!(report.skipped_protected, 1);
        assert!(report.batch_id.is_empty());
        assert!(item_exists(&db, &id));

        let forced = soft_delete(&db, &[id.clone()], true).expect("soft delete forced");
        assert_eq!(forced.removed, 1);
        assert_eq!(forced.skipped_protected, 0);
        assert!(!item_exists(&db, &id));
    }

    #[test]
    fn restore_does_not_overwrite_existing_item() {
        let db = test_db();
        let id = seed(&db, "original item");
        let report = soft_delete(&db, &[id.clone()], false).expect("soft delete");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO shelf_items \
                 (id, kind, display_name, source_kind, storage_mode, byte_size, created_at, updated_at) \
                 VALUES (?1, 'text', 'current item', 'manual', 'reference', 0, ?2, ?2)",
                params![id, now_iso()],
            )
            .map_err(AppError::from)
        })
        .expect("reinsert same id");

        let restored = restore(&db, &report.batch_id).expect("restore");
        assert_eq!(restored.restored, 0);
        assert_eq!(restored.conflicts, 1);
        assert_eq!(count(&db).unwrap(), 0);
        let name: String = db
            .with_read(|conn| {
                conn.query_row(
                    "SELECT display_name FROM shelf_items WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .map_err(AppError::from)
            })
            .expect("name");
        assert_eq!(name, "current item", "冲突时不得覆盖现存条目");
    }

    #[test]
    fn restore_unknown_batch_returns_zeros() {
        let db = test_db();
        let report = restore(&db, "no-such-batch").expect("restore");
        assert_eq!(report.restored, 0);
        assert_eq!(report.conflicts, 0);
        assert_eq!(report.restored_relations, 0);
    }

    #[test]
    fn purge_batch_deletes_files_and_trash_rows() {
        let db = test_db();
        let root = test_root("purge");
        let id = seed(&db, "purge item");
        let file = attach_managed(&db, &root, &id);
        let thumb = root.join("thumbs").join(format!("{id}.png"));
        std::fs::write(&thumb, b"thumb").expect("write thumb");
        let keep = seed(&db, "keep item");
        let report = soft_delete(&db, &[id.clone()], false).expect("soft delete");

        let purged = purge_batch(&db, &root, &report.batch_id).expect("purge");
        assert_eq!(purged.batches, 1);
        assert_eq!(purged.items, 1);
        assert_eq!(purged.freed_bytes, b"managed-bytes".len() as i64);
        assert_eq!(purged.failed_files, 0);
        assert!(!file.exists());
        assert!(!thumb.exists());
        assert_eq!(count(&db).unwrap(), 0);
        assert!(item_exists(&db, &keep), "清理回收站不得影响现存条目");

        cleanup(&root);
    }

    #[test]
    fn purge_expired_only_removes_old_batches() {
        let db = test_db();
        let root = test_root("expired");
        let old_id = seed(&db, "old item");
        let old_file = attach_managed(&db, &root, &old_id);
        let old_batch = soft_delete(&db, &[old_id.clone()], false).expect("soft delete old");
        let new_id = seed(&db, "new item");
        let new_file = attach_managed(&db, &root, &new_id);
        let new_batch = soft_delete(&db, &[new_id], false).expect("soft delete new");

        let old_time = (Utc::now() - Duration::hours(TRASH_RETENTION_HOURS + 1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE shelf_trash SET deleted_at = ?1 WHERE batch_id = ?2",
                params![old_time, old_batch.batch_id],
            )
            .map_err(AppError::from)
        })
        .expect("age old batch");

        let purged = purge_expired(&db, &root).expect("purge expired");
        assert_eq!(purged.batches, 1);
        assert_eq!(purged.items, 1);
        assert!(!old_file.exists());
        assert!(new_file.exists());
        assert_eq!(count(&db).unwrap(), 1);

        let remaining: String = db
            .with_read(|conn| {
                conn.query_row("SELECT batch_id FROM shelf_trash", [], |row| row.get(0))
                    .map_err(AppError::from)
            })
            .expect("remaining batch");
        assert_eq!(remaining, new_batch.batch_id);

        cleanup(&root);
    }

    #[test]
    fn soft_delete_caps_batch_size() {
        let db = test_db();
        let ids: Vec<String> = (0..=MAX_TRASH_ITEMS)
            .map(|i| seed(&db, &format!("cap item {i}")))
            .collect();
        let report = soft_delete(&db, &ids, false).expect("soft delete");
        assert_eq!(report.removed, MAX_TRASH_ITEMS);
        assert_eq!(count(&db).unwrap(), MAX_TRASH_ITEMS as i64);
        assert!(item_exists(&db, &ids[MAX_TRASH_ITEMS]), "超出上限的条目保持不动");
    }

    #[test]
    fn empty_and_duplicate_input_is_stable() {
        let db = test_db();
        let report = soft_delete(&db, &[], false).expect("empty input");
        assert_eq!(report.removed, 0);
        assert!(report.batch_id.is_empty());

        let id = seed(&db, "dup item");
        let duplicated = vec![id.clone(), id.clone(), format!("  {id}  ")];
        let report = soft_delete(&db, &duplicated, false).expect("duplicates");
        assert_eq!(report.removed, 1);
        assert_eq!(count(&db).unwrap(), 1);
    }

    /// 回收站保留期内，孤儿清理不得把快照仍引用的托管文件/缩略图当无主文件删除。
    /// 这是撤销真实可用的前提（否则只恢复记录、文件已被永久删掉）。
    #[test]
    fn orphan_cleanup_keeps_managed_files_referenced_by_trash() {
        let db = test_db();
        let root = test_root("orphan-safety");
        let id = seed(&db, "截图.png");
        let managed = attach_managed(&db, &root, &id);
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE shelf_items SET kind = 'image', file_ext = 'png' WHERE id = ?1",
                params![id],
            )
            .map_err(AppError::from)
        })
        .unwrap();
        let thumb = root.join("thumbs").join(format!("{id}.png"));
        std::fs::write(&thumb, b"thumb").expect("write thumb");

        let deleted = soft_delete(&db, std::slice::from_ref(&id), false).expect("soft delete");
        assert_eq!(deleted.removed, 1);
        assert!(managed.exists() && thumb.exists(), "软删除不得动托管副本");

        let orphans = crate::shelf::purge_orphan_files(&db, &root).expect("orphan cleanup");
        assert_eq!(orphans.removed_files, 0, "回收站引用必须计入孤儿清理引用集");
        assert!(managed.exists(), "保留期内托管主文件必须存在");
        assert!(thumb.exists(), "保留期内缩略图必须存在");

        let restored = restore(&db, &deleted.batch_id).expect("restore");
        assert_eq!(restored.restored, 1);
        assert!(managed.exists(), "撤销后文件仍可用");

        cleanup(&root);
    }
}
