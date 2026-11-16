//! 生活效率系统 v1 的同步适配：桌面端 pull 载荷与手机 push 落库。
//!
//! 契约（与 `commands::life`、移动端 `apps/mobile/src/lib/sync/protocol.ts` 对齐）：
//! - 实体：`life_item` / `life_event` / `life_event_item` / `life_document_link`；
//! - 字段名一律 camelCase（与 task/note 协议一致），时间一律 epoch ms；
//! - 金额字段 `unitPriceMinor` / `totalPriceMinor` 是整数最小货币单位，不接受浮点；
//! - 商品名归一化只在服务端重算，不信任客户端提交的 `normalizedName`；
//! - 删除：商品/事件/票据关联为软删除（墓碑），事件明细为硬删除（触发器写墓碑）；
//! - 事件删除时连带硬删除明细、软删除票据关联，保证另一端不残留孤儿行；
//! - 外键顺序：商品 → 事件 → 事件明细 → 票据关联（批次内由 `entity_order` 保证）。

use super::*;
use crate::commands::life::{
    canonical_quantity, normalize_currency, normalize_name, LifeEventInput,
};

pub(crate) fn entity_order(entity: &str) -> u8 {
    match entity {
        "life_item" => 0,
        "life_event" => 1,
        "life_event_item" => 2,
        "life_document_link" => 3,
        _ => 4,
    }
}

struct LifeItemRow {
    name: String,
    category: String,
    aliases: String,
    note: String,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
}

fn load_life_item_row(conn: &Connection, id: &str) -> AppResult<Option<LifeItemRow>> {
    Ok(conn
        .query_row(
            "SELECT name, category, aliases, note, created_at, updated_at, deleted_at
             FROM life_items WHERE id = ?1",
            params![id],
            |row| {
                Ok(LifeItemRow {
                    name: row.get(0)?,
                    category: row.get(1)?,
                    aliases: row.get(2)?,
                    note: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    deleted_at: row.get(6)?,
                })
            },
        )
        .optional()?)
}

pub(crate) fn load_life_item_change(
    conn: &Connection,
    id: &str,
    rev: i64,
) -> AppResult<Option<SyncChange>> {
    let Some(row) = load_life_item_row(conn, id)? else {
        return Ok(None);
    };
    let updated_at = iso_to_ms(&row.updated_at).unwrap_or_else(now_ms);
    if row.deleted_at.is_some() {
        return Ok(Some(tombstone("life_item", id, rev)));
    }
    let aliases: Vec<String> = serde_json::from_str(&row.aliases).unwrap_or_default();
    let fields = json!({
        "name": row.name,
        "normalizedName": normalize_name(&row.name),
        "category": if row.category.is_empty() { Value::Null } else { json!(row.category) },
        "aliases": aliases,
        "note": if row.note.is_empty() { Value::Null } else { json!(row.note) },
        "createdAt": iso_to_ms(&row.created_at).unwrap_or(0),
        "updatedAt": updated_at,
    });
    Ok(Some(SyncChange {
        entity: "life_item".into(),
        id: id.to_string(),
        rev,
        deleted: false,
        fields,
        updated_at,
    }))
}

struct LifeEventRow {
    event_type: String,
    title: String,
    description: String,
    occurred_at: String,
    merchant: String,
    source: String,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
}

fn load_life_event_row(conn: &Connection, id: &str) -> AppResult<Option<LifeEventRow>> {
    Ok(conn
        .query_row(
            "SELECT event_type, title, description, occurred_at, merchant, source,
                    created_at, updated_at, deleted_at
             FROM life_events WHERE id = ?1",
            params![id],
            |row| {
                Ok(LifeEventRow {
                    event_type: row.get(0)?,
                    title: row.get(1)?,
                    description: row.get(2)?,
                    occurred_at: row.get(3)?,
                    merchant: row.get(4)?,
                    source: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    deleted_at: row.get(8)?,
                })
            },
        )
        .optional()?)
}

pub(crate) fn load_life_event_change(
    conn: &Connection,
    id: &str,
    rev: i64,
) -> AppResult<Option<SyncChange>> {
    let Some(row) = load_life_event_row(conn, id)? else {
        return Ok(None);
    };
    let updated_at = iso_to_ms(&row.updated_at).unwrap_or_else(now_ms);
    if row.deleted_at.is_some() {
        return Ok(Some(tombstone("life_event", id, rev)));
    }
    let fields = json!({
        "eventType": row.event_type,
        "title": row.title,
        "description": if row.description.is_empty() { Value::Null } else { json!(row.description) },
        "occurredAt": iso_to_ms(&row.occurred_at),
        "merchant": if row.merchant.is_empty() { Value::Null } else { json!(row.merchant) },
        "source": row.source,
        "createdAt": iso_to_ms(&row.created_at).unwrap_or(0),
        "updatedAt": updated_at,
    });
    Ok(Some(SyncChange {
        entity: "life_event".into(),
        id: id.to_string(),
        rev,
        deleted: false,
        fields,
        updated_at,
    }))
}

struct LifeEventItemRow {
    event_id: String,
    item_id: Option<String>,
    item_name_snapshot: String,
    quantity_value: Option<String>,
    quantity_unit: String,
    unit_price_minor: Option<i64>,
    total_price_minor: Option<i64>,
    currency: String,
    note: String,
    created_at: String,
    updated_at: String,
}

fn load_life_event_item_row(
    conn: &Connection,
    id: &str,
) -> AppResult<Option<LifeEventItemRow>> {
    Ok(conn
        .query_row(
            "SELECT event_id, item_id, item_name_snapshot, quantity_value, quantity_unit,
                    unit_price_minor, total_price_minor, currency, note, created_at, updated_at
             FROM life_event_items WHERE id = ?1",
            params![id],
            |row| {
                Ok(LifeEventItemRow {
                    event_id: row.get(0)?,
                    item_id: row.get(1)?,
                    item_name_snapshot: row.get(2)?,
                    quantity_value: row.get(3)?,
                    quantity_unit: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    unit_price_minor: row.get(5)?,
                    total_price_minor: row.get(6)?,
                    currency: row.get(7)?,
                    note: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            },
        )
        .optional()?)
}

pub(crate) fn load_life_event_item_change(
    conn: &Connection,
    id: &str,
    rev: i64,
) -> AppResult<Option<SyncChange>> {
    let Some(row) = load_life_event_item_row(conn, id)? else {
        return Ok(None);
    };
    let updated_at = iso_to_ms(&row.updated_at).unwrap_or_else(now_ms);
    let fields = json!({
        "eventId": row.event_id,
        "itemId": row.item_id,
        "itemNameSnapshot": row.item_name_snapshot,
        "quantityValue": row.quantity_value,
        "quantityUnit": if row.quantity_unit.is_empty() { Value::Null } else { json!(row.quantity_unit) },
        "unitPriceMinor": row.unit_price_minor,
        "totalPriceMinor": row.total_price_minor,
        "currency": if row.currency.is_empty() { Value::Null } else { json!(row.currency) },
        "note": if row.note.is_empty() { Value::Null } else { json!(row.note) },
        "createdAt": iso_to_ms(&row.created_at).unwrap_or(0),
        "updatedAt": updated_at,
    });
    Ok(Some(SyncChange {
        entity: "life_event_item".into(),
        id: id.to_string(),
        rev,
        deleted: false,
        fields,
        updated_at,
    }))
}

struct LifeDocumentLinkRow {
    owner_type: String,
    owner_id: String,
    document_ref: String,
    document_source: String,
    document_name: String,
    mime: String,
    byte_size: Option<i64>,
    remote_ref: Option<String>,
    remote_source: Option<String>,
    transfer_state: String,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
}

fn load_life_document_link_row(
    conn: &Connection,
    id: &str,
) -> AppResult<Option<LifeDocumentLinkRow>> {
    Ok(conn
        .query_row(
            "SELECT owner_type, owner_id, document_ref, document_source, document_name,
                    mime, byte_size, remote_ref, remote_source, transfer_state,
                    created_at, updated_at, deleted_at
             FROM life_document_links WHERE id = ?1",
            params![id],
            |row| {
                Ok(LifeDocumentLinkRow {
                    owner_type: row.get(0)?,
                    owner_id: row.get(1)?,
                    document_ref: row.get(2)?,
                    document_source: row.get(3)?,
                    document_name: row.get(4)?,
                    mime: row.get(5)?,
                    byte_size: row.get(6)?,
                    remote_ref: row.get(7)?,
                    remote_source: row.get(8)?,
                    transfer_state: row.get(9)?,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                    deleted_at: row.get(12)?,
                })
            },
        )
        .optional()?)
}

pub(crate) fn load_life_document_link_change(
    conn: &Connection,
    id: &str,
    rev: i64,
) -> AppResult<Option<SyncChange>> {
    let Some(row) = load_life_document_link_row(conn, id)? else {
        return Ok(None);
    };
    let updated_at = iso_to_ms(&row.updated_at).unwrap_or_else(now_ms);
    if row.deleted_at.is_some() {
        return Ok(Some(tombstone("life_document_link", id, rev)));
    }
    let fields = json!({
        "ownerType": row.owner_type,
        "ownerId": row.owner_id,
        "documentRef": row.document_ref,
        "documentSource": row.document_source,
        "documentName": if row.document_name.is_empty() { Value::Null } else { json!(row.document_name) },
        "mime": if row.mime.is_empty() { Value::Null } else { json!(row.mime) },
        "byteSize": row.byte_size,
        "remoteRef": row.remote_ref,
        "remoteSource": row.remote_source,
        "transferState": row.transfer_state,
        "createdAt": iso_to_ms(&row.created_at).unwrap_or(0),
        "updatedAt": updated_at,
    });
    Ok(Some(SyncChange {
        entity: "life_document_link".into(),
        id: id.to_string(),
        rev,
        deleted: false,
        fields,
        updated_at,
    }))
}

// ── push 落库 ───────────────────────────────────────────────

pub(crate) fn apply_life_item_op(
    conn: &Connection,
    device_id: &str,
    op: &SyncOp,
    ack: &mut Vec<String>,
    conflicts: &mut Vec<SyncConflict>,
) -> AppResult<()> {
    let latest = latest_seq(conn, "life_item", &op.id)?;
    if op.deleted {
        match load_life_item_change(conn, &op.id, latest)? {
            None => ack_op(conn, device_id, op, ack)?,
            Some(server) if server.deleted => ack_op(conn, device_id, op, ack)?,
            Some(server) => {
                if latest != op.base_rev {
                    conflicts.push(conflict(op, "revision_mismatch", Some(server)));
                } else {
                    let now = now_iso();
                    conn.execute(
                        "UPDATE life_items SET deleted_at = ?1, updated_at = ?1
                         WHERE id = ?2 AND deleted_at IS NULL",
                        params![now, op.id],
                    )?;
                    // 商品级票据关联一并解除；事件历史保留名称快照。
                    conn.execute(
                        "UPDATE life_document_links SET deleted_at = ?1, updated_at = ?1
                         WHERE owner_type = 'item' AND owner_id = ?2 AND deleted_at IS NULL",
                        params![now, op.id],
                    )?;
                    ack_op(conn, device_id, op, ack)?;
                }
            }
        }
        return Ok(());
    }

    match load_life_item_change(conn, &op.id, latest)? {
        None => {
            if op.base_rev != 0 {
                conflicts.push(conflict(op, "record_missing", None));
            } else {
                insert_life_item_from_patch(conn, op)?;
                ack_op(conn, device_id, op, ack)?;
            }
        }
        Some(server) => {
            if server.deleted {
                conflicts.push(conflict(op, "record_missing", Some(server)));
            } else if latest != op.base_rev {
                conflicts.push(conflict(op, "revision_mismatch", Some(server)));
            } else {
                update_life_item_from_patch(conn, &op.id, &op.patch)?;
                ack_op(conn, device_id, op, ack)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn apply_life_event_op(
    conn: &Connection,
    device_id: &str,
    op: &SyncOp,
    ack: &mut Vec<String>,
    conflicts: &mut Vec<SyncConflict>,
) -> AppResult<()> {
    let latest = latest_seq(conn, "life_event", &op.id)?;
    if op.deleted {
        match load_life_event_change(conn, &op.id, latest)? {
            None => ack_op(conn, device_id, op, ack)?,
            Some(server) if server.deleted => ack_op(conn, device_id, op, ack)?,
            Some(server) => {
                if latest != op.base_rev {
                    conflicts.push(conflict(op, "revision_mismatch", Some(server)));
                } else {
                    soft_delete_event(conn, &op.id)?;
                    ack_op(conn, device_id, op, ack)?;
                }
            }
        }
        return Ok(());
    }

    match load_life_event_change(conn, &op.id, latest)? {
        None => {
            if op.base_rev != 0 {
                conflicts.push(conflict(op, "record_missing", None));
            } else {
                insert_life_event_from_patch(conn, op)?;
                ack_op(conn, device_id, op, ack)?;
            }
        }
        Some(server) => {
            if server.deleted {
                conflicts.push(conflict(op, "record_missing", Some(server)));
            } else if latest != op.base_rev {
                conflicts.push(conflict(op, "revision_mismatch", Some(server)));
            } else {
                update_life_event_from_patch(conn, &op.id, &op.patch)?;
                ack_op(conn, device_id, op, ack)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn apply_life_event_item_op(
    conn: &Connection,
    device_id: &str,
    op: &SyncOp,
    ack: &mut Vec<String>,
    conflicts: &mut Vec<SyncConflict>,
) -> AppResult<()> {
    let latest = latest_seq(conn, "life_event_item", &op.id)?;
    if op.deleted {
        match load_life_event_item_change(conn, &op.id, latest)? {
            None => ack_op(conn, device_id, op, ack)?,
            Some(server) => {
                if latest != op.base_rev {
                    conflicts.push(conflict(op, "revision_mismatch", Some(server)));
                } else {
                    conn.execute("DELETE FROM life_event_items WHERE id = ?1", params![op.id])?;
                    ack_op(conn, device_id, op, ack)?;
                }
            }
        }
        return Ok(());
    }

    match load_life_event_item_change(conn, &op.id, latest)? {
        None => {
            if op.base_rev != 0 {
                conflicts.push(conflict(op, "record_missing", None));
            } else {
                insert_life_event_item_from_patch(conn, op)?;
                ack_op(conn, device_id, op, ack)?;
            }
        }
        Some(server) => {
            if latest != op.base_rev {
                conflicts.push(conflict(op, "revision_mismatch", Some(server)));
            } else {
                update_life_event_item_from_patch(conn, &op.id, &op.patch)?;
                ack_op(conn, device_id, op, ack)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn apply_life_document_link_op(
    conn: &Connection,
    device_id: &str,
    op: &SyncOp,
    ack: &mut Vec<String>,
    conflicts: &mut Vec<SyncConflict>,
) -> AppResult<()> {
    let latest = latest_seq(conn, "life_document_link", &op.id)?;
    if op.deleted {
        match load_life_document_link_change(conn, &op.id, latest)? {
            None => ack_op(conn, device_id, op, ack)?,
            Some(server) if server.deleted => ack_op(conn, device_id, op, ack)?,
            Some(server) => {
                if latest != op.base_rev {
                    conflicts.push(conflict(op, "revision_mismatch", Some(server)));
                } else {
                    let now = now_iso();
                    conn.execute(
                        "UPDATE life_document_links SET deleted_at = ?1, updated_at = ?1
                         WHERE id = ?2 AND deleted_at IS NULL",
                        params![now, op.id],
                    )?;
                    ack_op(conn, device_id, op, ack)?;
                }
            }
        }
        return Ok(());
    }

    match load_life_document_link_change(conn, &op.id, latest)? {
        None => {
            if op.base_rev != 0 {
                conflicts.push(conflict(op, "record_missing", None));
            } else {
                insert_life_document_link_from_patch(conn, op)?;
                ack_op(conn, device_id, op, ack)?;
            }
        }
        Some(server) => {
            if server.deleted {
                conflicts.push(conflict(op, "record_missing", Some(server)));
            } else if latest != op.base_rev {
                conflicts.push(conflict(op, "revision_mismatch", Some(server)));
            } else {
                update_life_document_link_from_patch(conn, &op.id, &op.patch)?;
                ack_op(conn, device_id, op, ack)?;
            }
        }
    }
    Ok(())
}

fn soft_delete_event(conn: &Connection, event_id: &str) -> AppResult<()> {
    let now = now_iso();
    conn.execute(
        "UPDATE life_events SET deleted_at = ?1, updated_at = ?1
         WHERE id = ?2 AND deleted_at IS NULL",
        params![now, event_id],
    )?;
    // 明细硬删除：触发器写墓碑，手机端按墓碑清副本。
    conn.execute(
        "DELETE FROM life_event_items WHERE event_id = ?1",
        params![event_id],
    )?;
    conn.execute(
        "UPDATE life_document_links SET deleted_at = ?1, updated_at = ?1
         WHERE owner_type = 'event' AND owner_id = ?2 AND deleted_at IS NULL",
        params![now, event_id],
    )?;
    Ok(())
}

// ── 字段校验与写入 ──────────────────────────────────────────

fn required_text(patch: &Map<String, Value>, key: &str, label: &str, max: usize) -> AppResult<String> {
    let value = patch_string(patch, key)?.unwrap_or_default();
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::Validation(format!("{label}不能为空")));
    }
    if trimmed.chars().count() > max {
        return Err(AppError::Validation(format!("{label}超过 {max} 字符")));
    }
    Ok(trimmed)
}

fn optional_text(patch: &Map<String, Value>, key: &str, max: usize) -> AppResult<Option<String>> {
    let Some(value) = patch_string(patch, key)? else {
        return Ok(None);
    };
    let trimmed = value.trim().to_string();
    if trimmed.chars().count() > max {
        return Err(AppError::Validation(format!("{key} 超过 {max} 字符")));
    }
    Ok(Some(trimmed))
}

fn optional_text_value(patch: &Map<String, Value>, key: &str) -> AppResult<Option<String>> {
    match patch.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(Value::Number(value)) => Ok(Some(value.to_string())),
        Some(_) => Err(AppError::Validation(format!(
            "{key} 必须是字符串或 null"
        ))),
    }
}

fn patch_iso_required(patch: &Map<String, Value>, key: &str) -> AppResult<String> {
    let ms = patch_ms(patch, key)?
        .ok_or_else(|| AppError::Validation(format!("{key} 不能为空")))?;
    if ms <= 0 {
        return Err(AppError::Validation(format!("{key} 非法")));
    }
    Ok(ms_to_iso(ms))
}

fn patch_iso_optional(patch: &Map<String, Value>, key: &str) -> AppResult<Option<String>> {
    match patch_ms(patch, key)? {
        None => Ok(None),
        Some(ms) if ms > 0 => Ok(Some(ms_to_iso(ms))),
        Some(_) => Err(AppError::Validation(format!("{key} 非法"))),
    }
}

fn patch_quantity(patch: &Map<String, Value>, key: &str) -> AppResult<Option<String>> {
    match optional_text_value(patch, key)? {
        None => Ok(None),
        Some(raw) => canonical_quantity(&raw),
    }
}

fn patch_money(patch: &Map<String, Value>, key: &str) -> AppResult<Option<i64>> {
    match patch_i64(patch, key)? {
        None => Ok(None),
        Some(value) if value < 0 => Err(AppError::Validation(format!("{key} 不能为负数"))),
        Some(value) => Ok(Some(value)),
    }
}

fn patch_currency(patch: &Map<String, Value>) -> AppResult<String> {
    let text = patch_string(patch, "currency")?.unwrap_or_default();
    normalize_currency(Some(text.as_str())).map_err(|_| {
        AppError::Validation("currency 必须是三位字母代码或 null".into())
    })
}

fn patch_aliases(patch: &Map<String, Value>) -> AppResult<Option<Vec<String>>> {
    match patch.get("aliases") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => {
            let mut aliases = Vec::new();
            for item in items {
                let alias = item
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && value.chars().count() <= 40)
                    .ok_or_else(|| AppError::Validation("aliases 必须是字符串数组".into()))?;
                if aliases
                    .iter()
                    .any(|existing: &String| normalize_name(existing) == normalize_name(alias))
                {
                    continue;
                }
                aliases.push(alias.to_string());
                if aliases.len() >= 8 {
                    break;
                }
            }
            Ok(Some(aliases))
        }
        Some(_) => Err(AppError::Validation("aliases 必须是字符串数组或 null".into())),
    }
}

fn validate_event_type(value: &str) -> AppResult<String> {
    match value {
        "purchase" | "maintenance" | "general" => Ok(value.to_string()),
        _ => Err(AppError::Validation(
            "eventType 必须是 purchase / maintenance / general".into(),
        )),
    }
}

fn validate_event_source(value: &str) -> AppResult<String> {
    match value {
        "manual" | "capture" => Ok(value.to_string()),
        _ => Err(AppError::Validation("source 必须是 manual 或 capture".into())),
    }
}

fn validate_link_owner_type(value: &str) -> AppResult<String> {
    match value {
        "event" | "item" => Ok(value.to_string()),
        _ => Err(AppError::Validation("ownerType 必须是 event 或 item".into())),
    }
}

fn validate_link_source(value: &str) -> AppResult<String> {
    match value {
        "capture_asset" | "shelf_item" | "attachment" | "file" => Ok(value.to_string()),
        _ => Err(AppError::Validation("documentSource 非法".into())),
    }
}

fn validate_transfer_state(value: &str) -> AppResult<String> {
    match value {
        "local" | "metadata_only" | "transferred" | "missing" => Ok(value.to_string()),
        _ => Err(AppError::Validation("transferState 非法".into())),
    }
}

fn ensure_life_item_target(
    conn: &Connection,
    item_id: Option<&str>,
) -> AppResult<Option<String>> {
    let Some(id) = item_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let exists: Option<String> = conn
        .query_row(
            "SELECT id FROM life_items WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(AppError::Validation("itemId 指向的商品不存在".into()));
    }
    Ok(Some(id.to_string()))
}

fn ensure_life_event_target(conn: &Connection, event_id: &str) -> AppResult<()> {
    let exists: Option<String> = conn
        .query_row(
            "SELECT id FROM life_events WHERE id = ?1 AND deleted_at IS NULL",
            params![event_id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(AppError::Validation("eventId 指向的生活事件不存在".into()));
    }
    Ok(())
}

fn insert_life_item_from_patch(conn: &Connection, op: &SyncOp) -> AppResult<()> {
    let name = required_text(&op.patch, "name", "商品名称", 80)?;
    let normalized = normalize_name(&name);
    if normalized.is_empty() {
        return Err(AppError::Validation("商品名称不合法".into()));
    }
    let category = patch_string(&op.patch, "category")?
        .unwrap_or_default()
        .trim()
        .to_string();
    let note = patch_string(&op.patch, "note")?
        .unwrap_or_default()
        .trim()
        .to_string();
    let aliases = patch_aliases(&op.patch)?.unwrap_or_default();
    let created_at = patch_iso_optional(&op.patch, "createdAt")?.unwrap_or_else(now_iso);
    let updated_at = patch_iso_optional(&op.patch, "updatedAt")?
        .unwrap_or_else(|| created_at.clone());
    // 同名商品必须复用，不制造重复商品。
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM life_items WHERE normalized_name = ?1 AND deleted_at IS NULL",
            params![normalized],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(other_id) = existing {
        return Err(AppError::Validation(format!(
            "已存在同名商品 {other_id}，请先复用而不是新建"
        )));
    }
    conn.execute(
        "INSERT INTO life_items
         (id, name, normalized_name, category, aliases, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            op.id,
            name,
            normalized,
            category,
            serde_json::to_string(&aliases)?,
            note,
            created_at,
            updated_at
        ],
    )?;
    Ok(())
}

fn update_life_item_from_patch(
    conn: &Connection,
    id: &str,
    patch: &Map<String, Value>,
) -> AppResult<()> {
    let row = load_life_item_row(conn, id)?
        .ok_or_else(|| AppError::Validation("商品在更新过程中消失".into()))?;
    let name = match patch_string(patch, "name")? {
        Some(value) => {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                return Err(AppError::Validation("商品名称不能为空".into()));
            }
            trimmed
        }
        None => row.name.clone(),
    };
    let normalized = normalize_name(&name);
    let other: Option<String> = conn
        .query_row(
            "SELECT id FROM life_items
             WHERE normalized_name = ?1 AND deleted_at IS NULL AND id <> ?2",
            params![normalized, id],
            |r| r.get(0),
        )
        .optional()?;
    if other.is_some() {
        return Err(AppError::Validation("已存在同名商品".into()));
    }
    let category = match patch_string(patch, "category")? {
        Some(value) => value.trim().to_string(),
        None => row.category.clone(),
    };
    let note = match patch_string(patch, "note")? {
        Some(value) => value.trim().to_string(),
        None => row.note.clone(),
    };
    let aliases = match patch_aliases(patch)? {
        Some(value) => serde_json::to_string(&value)?,
        None => row.aliases.clone(),
    };
    let now = now_iso();
    conn.execute(
        "UPDATE life_items SET name = ?1, normalized_name = ?2, category = ?3,
                              aliases = ?4, note = ?5, updated_at = ?6
         WHERE id = ?7 AND deleted_at IS NULL",
        params![name, normalized, category, aliases, note, now, id],
    )?;
    Ok(())
}

fn insert_life_event_from_patch(conn: &Connection, op: &SyncOp) -> AppResult<()> {
    let event_type = validate_event_type(
        &patch_string(&op.patch, "eventType")?.unwrap_or_else(|| "purchase".to_string()),
    )?;
    let source = validate_event_source(
        &patch_string(&op.patch, "source")?.unwrap_or_else(|| "manual".to_string()),
    )?;
    let occurred_at = patch_iso_required(&op.patch, "occurredAt")?;
    let title = required_text(&op.patch, "title", "标题", 120)?;
    let description = patch_string(&op.patch, "description")?
        .unwrap_or_default()
        .trim()
        .to_string();
    let merchant = patch_string(&op.patch, "merchant")?
        .unwrap_or_default()
        .trim()
        .to_string();
    let created_at = patch_iso_optional(&op.patch, "createdAt")?.unwrap_or_else(now_iso);
    let updated_at = patch_iso_optional(&op.patch, "updatedAt")?
        .unwrap_or_else(|| created_at.clone());
    conn.execute(
        "INSERT INTO life_events
         (id, event_type, title, description, occurred_at, merchant, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            op.id,
            event_type,
            title,
            description,
            occurred_at,
            merchant,
            source,
            created_at,
            updated_at
        ],
    )?;
    Ok(())
}

fn update_life_event_from_patch(
    conn: &Connection,
    id: &str,
    patch: &Map<String, Value>,
) -> AppResult<()> {
    let row = load_life_event_row(conn, id)?
        .ok_or_else(|| AppError::Validation("生活事件在更新过程中消失".into()))?;
    if row.deleted_at.is_some() {
        return Err(AppError::Validation("生活事件已删除".into()));
    }
    let event_type = match patch_string(patch, "eventType")? {
        Some(value) => validate_event_type(&value)?,
        None => row.event_type.clone(),
    };
    let title = match patch_string(patch, "title")? {
        Some(value) => {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                return Err(AppError::Validation("标题不能为空".into()));
            }
            trimmed
        }
        None => row.title.clone(),
    };
    let description = match patch_string(patch, "description")? {
        Some(value) => value.trim().to_string(),
        None => row.description.clone(),
    };
    let occurred_at = match patch_iso_optional(patch, "occurredAt")? {
        Some(value) => value,
        None => row.occurred_at.clone(),
    };
    let merchant = match patch_string(patch, "merchant")? {
        Some(value) => value.trim().to_string(),
        None => row.merchant.clone(),
    };
    let source = match patch_string(patch, "source")? {
        Some(value) => validate_event_source(&value)?,
        None => row.source.clone(),
    };
    let now = now_iso();
    conn.execute(
        "UPDATE life_events SET event_type = ?1, title = ?2, description = ?3,
                               occurred_at = ?4, merchant = ?5, source = ?6, updated_at = ?7
         WHERE id = ?8 AND deleted_at IS NULL",
        params![
            event_type,
            title,
            description,
            occurred_at,
            merchant,
            source,
            now,
            id
        ],
    )?;
    Ok(())
}

fn insert_life_event_item_from_patch(conn: &Connection, op: &SyncOp) -> AppResult<()> {
    let event_id = required_text(&op.patch, "eventId", "eventId", 64)?;
    ensure_life_event_target(conn, &event_id)?;
    let item_id = ensure_life_item_target(
        conn,
        patch_string(&op.patch, "itemId")?.as_deref(),
    )?;
    let snapshot = required_text(&op.patch, "itemNameSnapshot", "商品名称快照", 80)?;
    let quantity = patch_quantity(&op.patch, "quantityValue")?;
    let unit = patch_string(&op.patch, "quantityUnit")?
        .unwrap_or_default()
        .trim()
        .to_string();
    let unit_price = patch_money(&op.patch, "unitPriceMinor")?;
    let total_price = patch_money(&op.patch, "totalPriceMinor")?;
    let currency = patch_currency(&op.patch)?;
    let note = patch_string(&op.patch, "note")?
        .unwrap_or_default()
        .trim()
        .to_string();
    let created_at = patch_iso_optional(&op.patch, "createdAt")?.unwrap_or_else(now_iso);
    let updated_at = patch_iso_optional(&op.patch, "updatedAt")?
        .unwrap_or_else(|| created_at.clone());
    conn.execute(
        "INSERT INTO life_event_items
         (id, event_id, item_id, item_name_snapshot, quantity_value, quantity_unit,
          unit_price_minor, total_price_minor, currency, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            op.id,
            event_id,
            item_id,
            snapshot,
            quantity,
            unit,
            unit_price,
            total_price,
            currency,
            note,
            created_at,
            updated_at
        ],
    )?;
    Ok(())
}

fn update_life_event_item_from_patch(
    conn: &Connection,
    id: &str,
    patch: &Map<String, Value>,
) -> AppResult<()> {
    let row = load_life_event_item_row(conn, id)?
        .ok_or_else(|| AppError::Validation("事件明细在更新过程中消失".into()))?;
    let event_id = match patch_string(patch, "eventId")? {
        Some(value) => {
            let trimmed = value.trim().to_string();
            ensure_life_event_target(conn, &trimmed)?;
            trimmed
        }
        None => row.event_id.clone(),
    };
    let item_id = if patch.contains_key("itemId") {
        ensure_life_item_target(conn, patch_string(patch, "itemId")?.as_deref())?
    } else {
        row.item_id.clone()
    };
    let snapshot = match patch_string(patch, "itemNameSnapshot")? {
        Some(value) => {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                return Err(AppError::Validation("商品名称快照不能为空".into()));
            }
            trimmed
        }
        None => row.item_name_snapshot.clone(),
    };
    let quantity = if patch.contains_key("quantityValue") {
        patch_quantity(patch, "quantityValue")?
    } else {
        row.quantity_value.clone()
    };
    let unit = match patch_string(patch, "quantityUnit")? {
        Some(value) => value.trim().to_string(),
        None => row.quantity_unit.clone(),
    };
    let unit_price = if patch.contains_key("unitPriceMinor") {
        patch_money(patch, "unitPriceMinor")?
    } else {
        row.unit_price_minor
    };
    let total_price = if patch.contains_key("totalPriceMinor") {
        patch_money(patch, "totalPriceMinor")?
    } else {
        row.total_price_minor
    };
    let currency = if patch.contains_key("currency") {
        patch_currency(patch)?
    } else {
        row.currency.clone()
    };
    let note = match patch_string(patch, "note")? {
        Some(value) => value.trim().to_string(),
        None => row.note.clone(),
    };
    let now = now_iso();
    conn.execute(
        "UPDATE life_event_items
         SET event_id = ?1, item_id = ?2, item_name_snapshot = ?3, quantity_value = ?4,
             quantity_unit = ?5, unit_price_minor = ?6, total_price_minor = ?7,
             currency = ?8, note = ?9, updated_at = ?10
         WHERE id = ?11",
        params![
            event_id,
            item_id,
            snapshot,
            quantity,
            unit,
            unit_price,
            total_price,
            currency,
            note,
            now,
            id
        ],
    )?;
    Ok(())
}

fn ensure_link_owner(
    conn: &Connection,
    owner_type: &str,
    owner_id: &str,
) -> AppResult<()> {
    let exists = match owner_type {
        "event" => conn
            .query_row(
                "SELECT 1 FROM life_events WHERE id = ?1 AND deleted_at IS NULL",
                params![owner_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some(),
        "item" => conn
            .query_row(
                "SELECT 1 FROM life_items WHERE id = ?1 AND deleted_at IS NULL",
                params![owner_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some(),
        _ => false,
    };
    if !exists {
        return Err(AppError::Validation("票据关联对象不存在或已删除".into()));
    }
    Ok(())
}

fn ensure_link_unique(
    conn: &Connection,
    owner_type: &str,
    owner_id: &str,
    document_ref: &str,
    document_source: &str,
    exclude_id: Option<&str>,
) -> AppResult<()> {
    let existing: Option<String> = match exclude_id {
        Some(id) => conn
            .query_row(
                "SELECT id FROM life_document_links
                 WHERE deleted_at IS NULL AND owner_type = ?1 AND owner_id = ?2
                   AND document_ref = ?3 AND document_source = ?4 AND id <> ?5",
                params![owner_type, owner_id, document_ref, document_source, id],
                |row| row.get(0),
            )
            .optional()?,
        None => conn
            .query_row(
                "SELECT id FROM life_document_links
                 WHERE deleted_at IS NULL AND owner_type = ?1 AND owner_id = ?2
                   AND document_ref = ?3 AND document_source = ?4",
                params![owner_type, owner_id, document_ref, document_source],
                |row| row.get(0),
            )
            .optional()?,
    };
    if existing.is_some() {
        return Err(AppError::Validation(
            "同一票据已关联到该对象，不重复建立关联".into(),
        ));
    }
    Ok(())
}

fn insert_life_document_link_from_patch(conn: &Connection, op: &SyncOp) -> AppResult<()> {
    let owner_type = validate_link_owner_type(
        &required_text(&op.patch, "ownerType", "ownerType", 16)?,
    )?;
    let owner_id = required_text(&op.patch, "ownerId", "ownerId", 64)?;
    ensure_link_owner(conn, &owner_type, &owner_id)?;
    let document_ref = required_text(&op.patch, "documentRef", "票据引用", 500)?;
    let document_source = validate_link_source(
        &required_text(&op.patch, "documentSource", "documentSource", 32)?,
    )?;
    ensure_link_unique(conn, &owner_type, &owner_id, &document_ref, &document_source, None)?;
    let document_name = patch_string(&op.patch, "documentName")?
        .unwrap_or_default()
        .trim()
        .to_string();
    let mime = patch_string(&op.patch, "mime")?
        .unwrap_or_default()
        .trim()
        .to_string();
    let byte_size = patch_i64(&op.patch, "byteSize")?;
    let remote_ref = match patch_string(&op.patch, "remoteRef")? {
        Some(value) if !value.trim().is_empty() => {
            let trimmed = value.trim().to_string();
            if trimmed.chars().count() > 500 {
                return Err(AppError::Validation("远端票据引用过长".into()));
            }
            Some(trimmed)
        }
        _ => None,
    };
    let remote_source = match patch_string(&op.patch, "remoteSource")? {
        Some(value) if !value.trim().is_empty() => {
            let trimmed = value.trim();
            if !matches!(trimmed, "shelf_item" | "file") {
                return Err(AppError::Validation("remoteSource 只能是 shelf_item 或 file".into()));
            }
            Some(trimmed.to_string())
        }
        _ => None,
    };
    let transfer_state = validate_transfer_state(
        &patch_string(&op.patch, "transferState")?.unwrap_or_else(|| "metadata_only".to_string()),
    )?;
    let created_at = patch_iso_optional(&op.patch, "createdAt")?.unwrap_or_else(now_iso);
    let updated_at = patch_iso_optional(&op.patch, "updatedAt")?
        .unwrap_or_else(|| created_at.clone());
    conn.execute(
        "INSERT INTO life_document_links
         (id, owner_type, owner_id, document_ref, document_source, document_name, mime,
          byte_size, remote_ref, remote_source, transfer_state, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            op.id,
            owner_type,
            owner_id,
            document_ref,
            document_source,
            document_name,
            mime,
            byte_size,
            remote_ref,
            remote_source,
            transfer_state,
            created_at,
            updated_at
        ],
    )?;
    Ok(())
}

fn update_life_document_link_from_patch(
    conn: &Connection,
    id: &str,
    patch: &Map<String, Value>,
) -> AppResult<()> {
    let row = load_life_document_link_row(conn, id)?
        .ok_or_else(|| AppError::Validation("票据关联在更新过程中消失".into()))?;
    if row.deleted_at.is_some() {
        return Err(AppError::Validation("票据关联已解除".into()));
    }
    let owner_type = match patch_string(patch, "ownerType")? {
        Some(value) => validate_link_owner_type(&value)?,
        None => row.owner_type.clone(),
    };
    let owner_id = match patch_string(patch, "ownerId")? {
        Some(value) => value.trim().to_string(),
        None => row.owner_id.clone(),
    };
    ensure_link_owner(conn, &owner_type, &owner_id)?;
    let document_ref = match patch_string(patch, "documentRef")? {
        Some(value) => {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                return Err(AppError::Validation("票据引用不能为空".into()));
            }
            trimmed
        }
        None => row.document_ref.clone(),
    };
    let document_source = match patch_string(patch, "documentSource")? {
        Some(value) => validate_link_source(&value)?,
        None => row.document_source.clone(),
    };
    ensure_link_unique(
        conn,
        &owner_type,
        &owner_id,
        &document_ref,
        &document_source,
        Some(id),
    )?;
    let document_name = patch_string(patch, "documentName")?
        .map(|v| v.trim().to_string())
        .unwrap_or_else(|| row.document_name.clone());
    let mime = patch_string(patch, "mime")?
        .map(|v| v.trim().to_string())
        .unwrap_or_else(|| row.mime.clone());
    let byte_size = if patch.contains_key("byteSize") {
        patch_i64(patch, "byteSize")?
    } else {
        row.byte_size
    };
    let remote_ref = if patch.contains_key("remoteRef") {
        match patch_string(patch, "remoteRef")? {
            Some(value) if !value.trim().is_empty() => {
                let trimmed = value.trim().to_string();
                if trimmed.chars().count() > 500 {
                    return Err(AppError::Validation("远端票据引用过长".into()));
                }
                Some(trimmed)
            }
            _ => None,
        }
    } else {
        row.remote_ref.clone()
    };
    let remote_source = if patch.contains_key("remoteSource") {
        match patch_string(patch, "remoteSource")? {
            Some(value) if !value.trim().is_empty() => {
                let trimmed = value.trim();
                if !matches!(trimmed, "shelf_item" | "file") {
                    return Err(AppError::Validation(
                        "remoteSource 只能是 shelf_item 或 file".into(),
                    ));
                }
                Some(trimmed.to_string())
            }
            _ => None,
        }
    } else {
        row.remote_source.clone()
    };
    let transfer_state = match patch_string(patch, "transferState")? {
        Some(value) => validate_transfer_state(&value)?,
        None => row.transfer_state.clone(),
    };
    let now = now_iso();
    conn.execute(
        "UPDATE life_document_links
         SET owner_type = ?1, owner_id = ?2, document_ref = ?3, document_source = ?4,
             document_name = ?5, mime = ?6, byte_size = ?7, remote_ref = ?8,
             remote_source = ?9, transfer_state = ?10, updated_at = ?11
         WHERE id = ?12 AND deleted_at IS NULL",
        params![
            owner_type,
            owner_id,
            document_ref,
            document_source,
            document_name,
            mime,
            byte_size,
            remote_ref,
            remote_source,
            transfer_state,
            now,
            id
        ],
    )?;
    Ok(())
}

// 允许移动端把「票据文件传输状态」作为独立操作推送（不携带文件字节）。
// 文件本身仍走既有的 `mobile_sync::files` 通道。
#[allow(dead_code)]
fn _life_event_input_contract_marker(_input: &LifeEventInput) {}
