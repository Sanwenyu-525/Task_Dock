//! 手机同步 v1 的数据层：加密载荷、任务变更拉取、push 落库与冲突判定。
//!
//! 传输仍是局域网 HTTP，但业务数据不再明文上线：
//! - 密钥 = SHA-512("taskdock-sync-v1:" + token_hash)[0..32]；
//!   token_hash 是桌面端已存的 SHA-256(令牌)，手机端用 expo-crypto 现算同一个哈希。
//! - 载荷 = XSalsa20-Poly1305（tweetnacl secretbox 同算法），24 字节随机 nonce；
//! - 明文内嵌 AAD（方法与路径），解密后必须一致，防止跨端点重放。
//!
//! 同步语义（docs/MOBILE_STACK.md §3）：
//! - 变更日志由 SQLite 触发器维护，覆盖命令层与内部 SQL 的所有任务写路径；
//! - seq 即记录版本号，push 的 base_rev 必须与最新 seq 一致，否则返回冲突而不覆盖；
//! - 删除走墓碑（tasks 没有软删除列），手机端收到后只删本地副本；
//! - op_id 幂等，重复提交只 ack。
//!
//! 本轮只同步任务；notes / captures 的日志与映射留到后续迭代（未知实体跳过但推进游标）。

use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha512};
use uuid::Uuid;
use xsalsa20poly1305::aead::{Aead, KeyInit};
use xsalsa20poly1305::{Nonce, XSalsa20Poly1305};

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 加密信封版本；手机端必须原样接受，未来换算法时递增。
pub const ENVELOPE_VERSION: u32 = 1;
/// AAD：把「方法 + 路径」绑进密文，跨端点重放会解密失败。
pub const AAD_PULL: &str = "taskdock-sync-v1|GET|/v1/changes";
pub const AAD_PUSH: &str = "taskdock-sync-v1|POST|/v1/ops";
/// 单页上限与协议一致（500）；push 单批上限防止异常客户端占满内存。
pub const MAX_PULL_LIMIT: usize = 500;
pub const MAX_PUSH_OPS: usize = 100;
/// 同步请求体上限：500 条任务补丁远小于此值。
pub const SYNC_MAX_BODY: usize = 256 * 1024;

/// 从设备令牌哈希派生同步密钥。
///
/// 令牌哈希是 32 字节随机令牌的 SHA-256，熵已足够；这里用带域分离前缀的
/// SHA-512 截断到 32 字节，避免同一份哈希在鉴权与加密两处直接复用。
pub fn derive_key(token_hash_hex: &str) -> [u8; 32] {
    let mut hasher = Sha512::new();
    hasher.update(b"taskdock-sync-v1:");
    hasher.update(token_hash_hex.to_ascii_lowercase().as_bytes());
    let digest = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest[..32]);
    key
}

/// 生成加密信封：`{v, n, d}`；明文为 `{"aad": ..., "data": ...}`。
pub fn encrypt_envelope(key: &[u8; 32], aad: &str, data: &Value) -> AppResult<Value> {
    let cipher = XSalsa20Poly1305::new_from_slice(key)
        .map_err(|_| AppError::Validation("同步密钥长度错误".into()))?;
    let mut nonce_bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let plaintext = serde_json::to_vec(&json!({ "aad": aad, "data": data }))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|_| AppError::Unavailable("同步载荷加密失败".into()))?;
    Ok(json!({
        "v": ENVELOPE_VERSION,
        "n": STANDARD.encode(nonce_bytes),
        "d": STANDARD.encode(ciphertext),
    }))
}

/// 解密信封并校验 AAD；失败一律返回不透明错误，不把底层原因回给客户端。
pub fn decrypt_envelope(key: &[u8; 32], aad: &str, envelope: &Value) -> Result<Value, String> {
    let object = envelope
        .as_object()
        .ok_or_else(|| "envelope_not_object".to_string())?;
    if object.get("v").and_then(Value::as_u64) != Some(ENVELOPE_VERSION as u64) {
        return Err("envelope_version_unsupported".into());
    }
    let nonce = object
        .get("n")
        .and_then(Value::as_str)
        .and_then(|value| STANDARD.decode(value).ok())
        .ok_or_else(|| "envelope_nonce_invalid".to_string())?;
    if nonce.len() != 24 {
        return Err("envelope_nonce_invalid".into());
    }
    let ciphertext = object
        .get("d")
        .and_then(Value::as_str)
        .and_then(|value| STANDARD.decode(value).ok())
        .ok_or_else(|| "envelope_payload_invalid".to_string())?;
    let cipher = XSalsa20Poly1305::new_from_slice(key).map_err(|_| "envelope_key_invalid".to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "envelope_decrypt_failed".to_string())?;
    let parsed: Value =
        serde_json::from_slice(&plaintext).map_err(|_| "envelope_json_invalid".to_string())?;
    let expected_aad = parsed.get("aad").and_then(Value::as_str);
    if expected_aad != Some(aad) {
        return Err("envelope_aad_mismatch".into());
    }
    Ok(parsed.get("data").cloned().unwrap_or(Value::Null))
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncChange {
    pub entity: String,
    pub id: String,
    /// 服务端版本号：最新变更的 seq；push 的 base_rev 与它比较。
    pub rev: i64,
    pub deleted: bool,
    pub fields: Value,
    /// 记录最后更新时间（epoch ms）；墓碑为 0。
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct PullPage {
    pub cursor: String,
    pub changes: Vec<SyncChange>,
}

#[derive(Debug, Deserialize)]
pub struct PushRequest {
    pub device_id: String,
    pub ops: Vec<SyncOp>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct SyncOp {
    pub op_id: String,
    pub entity: String,
    pub id: String,
    #[serde(default)]
    pub base_rev: i64,
    #[serde(default)]
    pub patch: Map<String, Value>,
    /// v1 扩展：删除操作没有字段补丁，单独标记；与 patch 互斥。
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Debug, Serialize)]
pub struct SyncConflict {
    pub op_id: String,
    pub reason: String,
    pub server_record: Option<SyncChange>,
}

#[derive(Debug, Serialize)]
pub struct PushResponse {
    pub ack: Vec<String>,
    pub conflicts: Vec<SyncConflict>,
}

/// 拉取 `since` 之后的变更。游标就是 seq，不透明字符串由调用方原样保存。
pub fn pull(db: &Db, since: i64, limit: usize) -> AppResult<PullPage> {
    let limit = limit.clamp(1, MAX_PULL_LIMIT) as i64;
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT seq, entity, id, deleted FROM sync_changes
             WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![since.max(0), limit], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;

        let mut changes = Vec::new();
        let mut cursor = since.max(0);
        for row in rows {
            let (seq, entity, id, deleted) = row?;
            cursor = seq;
            if deleted != 0 {
                changes.push(SyncChange {
                    entity,
                    id,
                    rev: seq,
                    deleted: true,
                    fields: json!({}),
                    updated_at: 0,
                });
                continue;
            }
            // 未知实体（未来 notes / captures）本轮跳过，但游标推进，避免阻塞任务同步。
            if entity != "task" {
                continue;
            }
            match load_task_change(conn, &id, seq)? {
                Some(change) => changes.push(change),
                // 触发器保证有墓碑；若记录被其他路径物理清理而日志缺失，按删除处理。
                None => changes.push(SyncChange {
                    entity,
                    id,
                    rev: seq,
                    deleted: true,
                    fields: json!({}),
                    updated_at: 0,
                }),
            }
        }
        Ok(PullPage {
            cursor: cursor.to_string(),
            changes,
        })
    })
}

/// 应用一批 push 操作；所有操作与幂等记录在同一事务内。
pub fn apply_push(db: &Db, device_id: &str, ops: &[SyncOp]) -> AppResult<PushResponse> {
    if ops.len() > MAX_PUSH_OPS {
        return Err(AppError::Validation(format!(
            "单批操作不能超过 {MAX_PUSH_OPS} 条"
        )));
    }
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let mut ack = Vec::new();
        let mut conflicts = Vec::new();

        for op in ops {
            if op.op_id.trim().is_empty() {
                conflicts.push(conflict(op, "invalid_patch", None));
                continue;
            }
            if op_id_applied(&tx, &op.op_id)? {
                ack.push(op.op_id.clone());
                continue;
            }
            if op.entity != "task" {
                conflicts.push(conflict(op, "invalid_patch", None));
                continue;
            }

            let latest = latest_seq(&tx, "task", &op.id)?;
            if op.deleted {
                match load_task_change(&tx, &op.id, latest)? {
                    None => {
                        // 服务器本来就没有：幂等成功，避免客户端反复重试。
                        record_op(&tx, &op.op_id, device_id)?;
                        ack.push(op.op_id.clone());
                    }
                    Some(server) => {
                        if latest != op.base_rev {
                            conflicts.push(conflict(op, "revision_mismatch", Some(server)));
                            continue;
                        }
                        tx.execute("DELETE FROM tasks WHERE id = ?1", params![op.id])?;
                        record_op(&tx, &op.op_id, device_id)?;
                        ack.push(op.op_id.clone());
                    }
                }
                continue;
            }

            match load_task_change(&tx, &op.id, latest)? {
                None => {
                    if op.base_rev != 0 {
                        conflicts.push(conflict(op, "record_missing", None));
                        continue;
                    }
                    match insert_task_from_patch(&tx, op) {
                        Ok(()) => {
                            record_op(&tx, &op.op_id, device_id)?;
                            ack.push(op.op_id.clone());
                        }
                        Err(AppError::Validation(message)) => {
                            conflicts.push(conflict(op, "invalid_patch", None));
                            tracing::debug!("手机 push 创建被拒绝：{message}");
                        }
                        Err(other) => return Err(other),
                    }
                }
                Some(server) => {
                    if latest != op.base_rev {
                        conflicts.push(conflict(op, "revision_mismatch", Some(server)));
                        continue;
                    }
                    match update_task_from_patch(&tx, &server, &op.patch) {
                        Ok(()) => {
                            record_op(&tx, &op.op_id, device_id)?;
                            ack.push(op.op_id.clone());
                        }
                        Err(AppError::Validation(message)) => {
                            conflicts.push(conflict(op, "invalid_patch", None));
                            tracing::debug!("手机 push 更新被拒绝：{message}");
                        }
                        Err(other) => return Err(other),
                    }
                }
            }
        }

        tx.commit()?;
        Ok(PushResponse { ack, conflicts })
    })
}

fn conflict(op: &SyncOp, reason: &str, server_record: Option<SyncChange>) -> SyncConflict {
    SyncConflict {
        op_id: op.op_id.clone(),
        reason: reason.to_string(),
        server_record,
    }
}

fn op_id_applied(conn: &Connection, op_id: &str) -> AppResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sync_ops WHERE op_id = ?1",
            params![op_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn record_op(conn: &Connection, op_id: &str, device_id: &str) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO sync_ops (op_id, device_id, applied_at) VALUES (?1, ?2, ?3)",
        params![op_id, device_id, now_iso()],
    )?;
    Ok(())
}

/// 某条记录的最新版本号；没有变更日志时为 0。
fn latest_seq(conn: &Connection, entity: &str, id: &str) -> AppResult<i64> {
    let seq: Option<i64> = conn
        .query_row(
            "SELECT MAX(seq) FROM sync_changes WHERE entity = ?1 AND id = ?2",
            params![entity, id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(seq.unwrap_or(0))
}

struct TaskRow {
    title: String,
    description: String,
    priority: i64,
    status: String,
    category: String,
    tags: String,
    due_at: Option<String>,
    remind_at: Option<String>,
    advance_minutes: i64,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
    rule_id: Option<String>,
    rule_freq: Option<String>,
    rule_interval: Option<i64>,
    rule_by_weekday: Option<String>,
    rule_by_monthday: Option<i64>,
    rule_by_setpos: Option<i64>,
    rule_anchor: Option<String>,
}

fn load_task_row(conn: &Connection, id: &str) -> AppResult<Option<TaskRow>> {
    Ok(conn
        .query_row(
            "SELECT t.title, t.description, t.priority, t.status, t.category, t.tags,
                    t.due_at, t.remind_at, t.advance_minutes,
                    t.created_at, t.updated_at, t.completed_at,
                    r.id, r.freq, r.interval, r.by_weekday, r.by_monthday, r.by_setpos, r.anchor
             FROM tasks t
             LEFT JOIN recurrence_rules r ON r.id = t.recurrence_rule_id
             WHERE t.id = ?1",
            params![id],
            |row| {
                Ok(TaskRow {
                    title: row.get(0)?,
                    description: row.get(1)?,
                    priority: row.get(2)?,
                    status: row.get(3)?,
                    category: row.get(4)?,
                    tags: row.get(5)?,
                    due_at: row.get(6)?,
                    remind_at: row.get(7)?,
                    advance_minutes: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    completed_at: row.get(11)?,
                    rule_id: row.get(12)?,
                    rule_freq: row.get(13)?,
                    rule_interval: row.get(14)?,
                    rule_by_weekday: row.get(15)?,
                    rule_by_monthday: row.get(16)?,
                    rule_by_setpos: row.get(17)?,
                    rule_anchor: row.get(18)?,
                })
            },
        )
        .optional()?)
}

/// 把桌面任务映射成手机端字段（camelCase），手机端可直接落库。
fn load_task_change(conn: &Connection, id: &str, rev: i64) -> AppResult<Option<SyncChange>> {
    let Some(row) = load_task_row(conn, id)? else {
        return Ok(None);
    };
    let tags: Vec<String> = serde_json::from_str(&row.tags).unwrap_or_default();
    let weekdays: Vec<i64> = row
        .rule_by_weekday
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    let recurrence = row.rule_freq.as_ref().map(|freq| {
        json!({
            "freq": freq,
            "interval": row.rule_interval.unwrap_or(1).max(1),
            "by_weekday": weekdays,
            "by_monthday": row.rule_by_monthday,
            "by_setpos": row.rule_by_setpos,
            "anchor": row.rule_anchor.as_deref().filter(|value| !value.is_empty()),
        })
        .to_string()
    });

    let updated_at = iso_to_ms(&row.updated_at).unwrap_or_else(now_ms);
    let fields = json!({
        "title": row.title,
        "description": row.description,
        "status": row.status,
        "priority": row.priority.clamp(0, 3),
        "category": if row.category.is_empty() { Value::Null } else { json!(row.category) },
        "tags": tags,
        "dueAt": row.due_at.as_deref().and_then(iso_to_ms),
        "remindAt": row.remind_at.as_deref().and_then(iso_to_ms),
        "advanceMinutes": if row.advance_minutes == 0 { Value::Null } else { json!(row.advance_minutes) },
        "recurrenceRule": recurrence,
        "createdAt": iso_to_ms(&row.created_at).unwrap_or(0),
        "updatedAt": updated_at,
        "completedAt": row.completed_at.as_deref().and_then(iso_to_ms),
    });

    Ok(Some(SyncChange {
        entity: "task".into(),
        id: id.to_string(),
        rev,
        deleted: false,
        fields,
        updated_at,
    }))
}

fn insert_task_from_patch(conn: &Connection, op: &SyncOp) -> AppResult<()> {
    let now = now_iso();
    let title = patch_string(&op.patch, "title")?.unwrap_or_default();
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Validation("任务标题不能为空".into()));
    }
    let description = patch_string(&op.patch, "description")?.unwrap_or_default();
    let priority = patch_i64(&op.patch, "priority")?.unwrap_or(2).clamp(0, 3);
    let status = patch_string(&op.patch, "status")?.unwrap_or_else(|| "pending".into());
    let status = validate_status(&status)?;
    let category = patch_string(&op.patch, "category")?.unwrap_or_default();
    let tags = patch_tags(&op.patch)?.unwrap_or_default();
    let due_at = patch_ms(&op.patch, "dueAt")?.map(ms_to_iso);
    let remind_at = patch_ms(&op.patch, "remindAt")?.map(ms_to_iso);
    let advance = patch_i64(&op.patch, "advanceMinutes")?.unwrap_or(0).max(0);
    let created_at = patch_ms(&op.patch, "createdAt")?
        .map(ms_to_iso)
        .unwrap_or_else(|| now.clone());
    let completed_at = match status.as_str() {
        "completed" => patch_ms(&op.patch, "completedAt")?
            .map(ms_to_iso)
            .or_else(|| Some(now.clone())),
        _ => None,
    };
    let rule_id = apply_recurrence_patch(conn, None, &op.patch, &now)?;

    conn.execute(
        "INSERT INTO tasks (id, title, description, priority, status, category, tags,
                            due_at, remind_at, advance_minutes, recurrence_rule_id,
                            created_at, updated_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            op.id,
            title,
            description,
            priority,
            status,
            category,
            serde_json::to_string(&tags)?,
            due_at,
            remind_at,
            advance,
            rule_id,
            created_at,
            now,
            completed_at,
        ],
    )?;
    Ok(())
}

fn update_task_from_patch(conn: &Connection, current: &SyncChange, patch: &Map<String, Value>) -> AppResult<()> {
    let id = &current.id;
    let row = load_task_row(conn, id)?
        .ok_or_else(|| AppError::Validation("任务在更新过程中消失".into()))?;
    let now = now_iso();

    let title = match patch_string(patch, "title")? {
        Some(value) => {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                return Err(AppError::Validation("任务标题不能为空".into()));
            }
            trimmed
        }
        None => row.title,
    };
    let description = patch_string(patch, "description")?.unwrap_or(row.description);
    let priority = if patch.contains_key("priority") {
        patch_i64(patch, "priority")?.unwrap_or(0)
    } else {
        row.priority
    }
    .clamp(0, 3);
    let status = match patch_string(patch, "status")? {
        Some(value) => validate_status(&value)?,
        None => row.status.clone(),
    };
    let category = patch_string(patch, "category")?.unwrap_or(row.category);
    let tags = if patch.contains_key("tags") {
        patch_tags(patch)?.unwrap_or_default()
    } else {
        serde_json::from_str::<Vec<String>>(&row.tags).unwrap_or_default()
    };
    let due_at = if patch.contains_key("dueAt") {
        patch_ms(patch, "dueAt")?.map(ms_to_iso)
    } else {
        row.due_at
    };
    let remind_at = if patch.contains_key("remindAt") {
        patch_ms(patch, "remindAt")?.map(ms_to_iso)
    } else {
        row.remind_at
    };
    let advance = if patch.contains_key("advanceMinutes") {
        patch_i64(patch, "advanceMinutes")?.unwrap_or(0).max(0)
    } else {
        row.advance_minutes
    };
    let completed_at = if patch.contains_key("completedAt") {
        patch_ms(patch, "completedAt")?.map(ms_to_iso)
    } else if status != row.status {
        if status == "completed" {
            Some(now.clone())
        } else {
            None
        }
    } else {
        row.completed_at
    };
    let rule_id = apply_recurrence_patch(conn, row.rule_id.as_deref(), patch, &now)?;

    conn.execute(
        "UPDATE tasks SET title = ?1, description = ?2, priority = ?3, status = ?4,
                          category = ?5, tags = ?6, due_at = ?7, remind_at = ?8,
                          advance_minutes = ?9, recurrence_rule_id = ?10,
                          updated_at = ?11, completed_at = ?12
         WHERE id = ?13",
        params![
            title,
            description,
            priority,
            status,
            category,
            serde_json::to_string(&tags)?,
            due_at,
            remind_at,
            advance,
            rule_id,
            now,
            completed_at,
            id,
        ],
    )?;
    Ok(())
}

fn validate_status(value: &str) -> AppResult<String> {
    match value {
        "pending" | "completed" => Ok(value.to_string()),
        _ => Err(AppError::Validation("任务状态必须是 pending 或 completed".into())),
    }
}

fn apply_recurrence_patch(
    conn: &Connection,
    current_rule_id: Option<&str>,
    patch: &Map<String, Value>,
    now: &str,
) -> AppResult<Option<String>> {
    if !patch.contains_key("recurrenceRule") {
        return Ok(current_rule_id.map(str::to_string));
    }
    let raw = &patch["recurrenceRule"];
    let rule = match raw {
        Value::Null => return Ok(None),
        Value::String(text) if text.trim().is_empty() => return Ok(None),
        Value::String(text) => serde_json::from_str::<Value>(text)
            .map_err(|_| AppError::Validation("recurrenceRule 不是合法 JSON".into()))?,
        _ => return Err(AppError::Validation("recurrenceRule 必须是字符串或 null".into())),
    };
    let freq = rule
        .get("freq")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Validation("重复规则缺少 freq".into()))?;
    if !matches!(freq, "daily" | "weekly" | "monthly") {
        return Err(AppError::Validation("重复规则 freq 不受支持".into()));
    }
    let interval = rule
        .get("interval")
        .and_then(value_to_i64)
        .unwrap_or(1)
        .max(1);
    let weekdays = rule
        .get("by_weekday")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(value_to_i64)
                .filter(|day| (1..=7).contains(day))
                .collect::<Vec<i64>>()
        })
        .unwrap_or_default();
    let by_monthday = rule.get("by_monthday").and_then(value_to_i64);
    let by_setpos = rule.get("by_setpos").and_then(value_to_i64);
    let anchor = rule.get("anchor").and_then(Value::as_str).unwrap_or("");
    let weekdays_json = serde_json::to_string(&weekdays)?;

    if let Some(rule_id) = current_rule_id {
        conn.execute(
            "UPDATE recurrence_rules
                SET freq = ?1, interval = ?2, by_weekday = ?3, by_monthday = ?4,
                    by_setpos = ?5, anchor = ?6
              WHERE id = ?7",
            params![freq, interval, weekdays_json, by_monthday, by_setpos, anchor, rule_id],
        )?;
        return Ok(Some(rule_id.to_string()));
    }

    let rule_id = Uuid::new_v4().simple().to_string();
    conn.execute(
        "INSERT INTO recurrence_rules (id, freq, interval, by_weekday, by_monthday, by_setpos, anchor, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![rule_id, freq, interval, weekdays_json, by_monthday, by_setpos, anchor, now],
    )?;
    Ok(Some(rule_id))
}

fn patch_string(patch: &Map<String, Value>, key: &str) -> AppResult<Option<String>> {
    match patch.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(String::new())),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(AppError::Validation(format!("{key} 必须是字符串或 null"))),
    }
}

fn patch_i64(patch: &Map<String, Value>, key: &str) -> AppResult<Option<i64>> {
    match patch.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value_to_i64(value)
            .map(Some)
            .ok_or_else(|| AppError::Validation(format!("{key} 必须是整数或 null"))),
    }
}

fn patch_ms(patch: &Map<String, Value>, key: &str) -> AppResult<Option<i64>> {
    patch_i64(patch, key)
}

fn patch_tags(patch: &Map<String, Value>) -> AppResult<Option<Vec<String>>> {
    match patch.get("tags") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => {
            let mut tags = Vec::with_capacity(items.len());
            for item in items {
                let tag = item
                    .as_str()
                    .map(str::trim)
                    .filter(|tag| !tag.is_empty())
                    .ok_or_else(|| AppError::Validation("tags 必须是字符串数组".into()))?;
                tags.push(tag.to_string());
            }
            Ok(Some(tags))
        }
        Some(_) => Err(AppError::Validation("tags 必须是字符串数组或 null".into())),
    }
}

fn value_to_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|number| number as i64))
}

fn iso_to_ms(raw: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|value| value.timestamp_millis())
}

fn ms_to_iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, false)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, false)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

/// 供推送结果去做「已处理 op」校验的辅助：仅测试使用。
#[cfg(test)]
fn applied_op_count(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM sync_ops", [], |row| row.get(0))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn insert_task(db: &Db, id: &str, title: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags,
                                    advance_minutes, created_at, updated_at)
                 VALUES (?1, ?2, '', 2, 'pending', '', '[]', 0,
                         strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![id, title],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn op(op_id: &str, id: &str, base_rev: i64, patch: Value) -> SyncOp {
        SyncOp {
            op_id: op_id.into(),
            entity: "task".into(),
            id: id.into(),
            base_rev,
            patch: patch.as_object().cloned().unwrap_or_default(),
            deleted: false,
        }
    }

    #[test]
    fn crypto_roundtrip_and_aad_binding() {
        let key = derive_key(&"ab".repeat(32));
        let envelope = encrypt_envelope(&key, AAD_PULL, &json!({"hello": "世界"})).unwrap();
        assert_eq!(envelope["v"], 1);
        let data = decrypt_envelope(&key, AAD_PULL, &envelope).unwrap();
        assert_eq!(data["hello"], "世界");
        assert!(decrypt_envelope(&key, AAD_PUSH, &envelope).is_err());
        let other = derive_key(&"cd".repeat(32));
        assert!(decrypt_envelope(&other, AAD_PULL, &envelope).is_err());
    }

    #[test]
    fn decrypts_tweetnacl_mobile_vector() {
        // 由手机端同一套实现（tweetnacl secretbox）生成：key = SHA-512(
        // "taskdock-sync-v1:" + "ab"*32)[0..32]，nonce = 0..23，
        // 明文 = {"aad":AAD_PULL,"data":{"hello":"世界"}}。
        // 桌面端能解开即证明 KDF、算法与信封格式跨语言一致。
        let key = derive_key(&"ab".repeat(32));
        let envelope = json!({
            "v": 1,
            "n": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX",
            "d": "ZxHpMc8z80dfscbWvyOmMw6ppYPFC3Hb/F4NSyR4obMD5BiJD/94ktw+I3On7uhrweMOi5oKfQdtV8yf7z+2M+aAeqp8v5YwC/oWfWV+9DyG7YAl"
        });
        let data = decrypt_envelope(&key, AAD_PULL, &envelope).unwrap();
        assert_eq!(data["hello"], "世界");
    }

    #[test]
    fn trigger_writes_change_log_on_insert_update_delete() {
        let db = test_db();
        insert_task(&db, "t1", "写日志");
        let seq1: i64 = db
            .with_conn(|conn| Ok(conn.query_row("SELECT MAX(seq) FROM sync_changes", [], |r| r.get(0))?))
            .unwrap();
        assert!(seq1 > 0);

        db.with_conn(|conn| {
            conn.execute("UPDATE tasks SET title='改名', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='t1'", [])?;
            Ok(())
        })
        .unwrap();
        let seq2: i64 = db
            .with_conn(|conn| Ok(conn.query_row("SELECT MAX(seq) FROM sync_changes", [], |r| r.get(0))?))
            .unwrap();
        assert!(seq2 > seq1);

        db.with_conn(|conn| {
            conn.execute("DELETE FROM tasks WHERE id='t1'", [])?;
            Ok(())
        })
        .unwrap();
        let deleted: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT deleted FROM sync_changes WHERE entity='task' AND id='t1' ORDER BY seq DESC LIMIT 1",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(deleted, 1);
    }

    #[test]
    fn pull_returns_fields_and_advances_cursor() {
        let db = test_db();
        insert_task(&db, "t1", "拉取我");
        let page = pull(&db, 0, 500).unwrap();
        assert!(!page.changes.is_empty());
        let change = page.changes.iter().find(|c| c.id == "t1").unwrap();
        assert_eq!(change.deleted, false);
        assert_eq!(change.fields["title"], "拉取我");
        assert!(change.rev > 0);
        let cursor: i64 = page.cursor.parse().unwrap();
        assert!(cursor > 0);
        let empty = pull(&db, cursor, 500).unwrap();
        assert!(empty.changes.is_empty());
    }

    #[test]
    fn push_create_update_and_dedupe() {
        let db = test_db();
        let create = op("op-1", "t1", 0, json!({"title": "手机创建", "priority": 1}));
        let first = apply_push(&db, "device-1", &[create.clone()]).unwrap();
        assert_eq!(first.ack, vec!["op-1"]);
        assert!(first.conflicts.is_empty());

        let row: (String, i64) = db
            .with_conn(|conn| {
                Ok(conn.query_row("SELECT title, priority FROM tasks WHERE id='t1'", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?)
            })
            .unwrap();
        assert_eq!(row, ("手机创建".into(), 1));

        // 重放同一 op：只 ack，不重复写
        let replay = apply_push(&db, "device-1", &[create]).unwrap();
        assert_eq!(replay.ack, vec!["op-1"]);
        assert_eq!(db.with_conn(|conn| applied_op_count(conn)).unwrap(), 1);

        let latest = pull(&db, 0, 500)
            .unwrap()
            .changes
            .iter()
            .find(|c| c.id == "t1")
            .unwrap()
            .rev;
        let update = op("op-2", "t1", latest, json!({"title": "改自手机"}));
        let result = apply_push(&db, "device-1", &[update]).unwrap();
        assert_eq!(result.ack, vec!["op-2"]);
    }

    #[test]
    fn push_conflict_does_not_overwrite() {
        let db = test_db();
        insert_task(&db, "t1", "桌面原文");
        let rev = pull(&db, 0, 500)
            .unwrap()
            .changes
            .iter()
            .find(|c| c.id == "t1")
            .unwrap()
            .rev;

        // 模拟桌面端又改了一次
        db.with_conn(|conn| {
            conn.execute("UPDATE tasks SET title='桌面新文', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='t1'", [])?;
            Ok(())
        })
        .unwrap();

        let result = apply_push(
            &db,
            "device-1",
            &[op("op-3", "t1", rev, json!({"title": "手机旧版本"}))],
        )
        .unwrap();
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(result.conflicts[0].reason, "revision_mismatch");
        assert_eq!(result.conflicts[0].server_record.as_ref().unwrap().fields["title"], "桌面新文");

        let title: String = db
            .with_conn(|conn| Ok(conn.query_row("SELECT title FROM tasks WHERE id='t1'", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(title, "桌面新文");
    }

    #[test]
    fn push_delete_writes_tombstone() {
        let db = test_db();
        insert_task(&db, "t1", "待删除");
        let rev = pull(&db, 0, 500)
            .unwrap()
            .changes
            .iter()
            .find(|c| c.id == "t1")
            .unwrap()
            .rev;
        let mut delete = op("op-del", "t1", rev, json!({}));
        delete.deleted = true;
        let result = apply_push(&db, "device-1", &[delete]).unwrap();
        assert_eq!(result.ack, vec!["op-del"]);

        let exists: i64 = db
            .with_conn(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM tasks WHERE id='t1'", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(exists, 0);

        let page = pull(&db, 0, 500).unwrap();
        let tombstone = page.changes.iter().rev().find(|c| c.id == "t1").unwrap();
        assert!(tombstone.deleted);
    }
}
