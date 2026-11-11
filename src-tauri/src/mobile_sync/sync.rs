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
//! 同步实体：任务（task）、笔记（note）、收集箱（capture）。桌面端 notes 的正文列叫
//! `content`，协议与手机端叫 `body`；收集箱的 handled/converted 状态在 pull 时映射为墓碑，
//! 手机端只保留 inbox 条目。

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
use crate::notes::store::{MAX_CONTENT as NOTE_MAX_CONTENT, MAX_TITLE as NOTE_MAX_TITLE};
use crate::quick_capture::store::{
    KINDS as CAPTURE_KINDS, MAX_CLIENT_ID as CAPTURE_MAX_CLIENT_ID,
    MAX_CONTENT as CAPTURE_MAX_CONTENT,
};

/// 加密信封版本；手机端必须原样接受，未来换算法时递增。
pub const ENVELOPE_VERSION: u32 = 1;
/// AAD：把「方法 + 路径」绑进密文，跨端点重放会解密失败。
pub const AAD_PULL: &str = "taskdock-sync-v1|GET|/v1/changes";
pub const AAD_PUSH: &str = "taskdock-sync-v1|POST|/v1/ops";
/// 单页上限与协议一致（500）；push 单批上限防止异常客户端占满内存。
pub const MAX_PULL_LIMIT: usize = 500;
pub const MAX_PUSH_OPS: usize = 100;
/// 同步请求体上限：单条笔记正文上限 20 万字符（中文约 600KB），
/// 预留加密信封与 JSON 结构后取 1MB；手机端按 UTF-8 字节数分批。
pub const SYNC_MAX_BODY: usize = 1024 * 1024;

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
                changes.push(tombstone(&entity, &id, seq));
                continue;
            }
            let change = match entity.as_str() {
                "task" => load_task_change(conn, &id, seq)?,
                "note" => load_note_change(conn, &id, seq)?,
                "capture" => load_capture_change(conn, &id, seq)?,
                // 未知实体（未来扩展）跳过但推进游标，避免阻塞已知实体同步。
                _ => continue,
            };
            // 触发器保证有墓碑；若记录被其他路径物理清理而日志缺失，按删除处理。
            changes.push(change.unwrap_or_else(|| tombstone(&entity, &id, seq)));
        }
        Ok(PullPage {
            cursor: cursor.to_string(),
            changes,
        })
    })
}

fn tombstone(entity: &str, id: &str, rev: i64) -> SyncChange {
    SyncChange {
        entity: entity.to_string(),
        id: id.to_string(),
        rev,
        deleted: true,
        fields: json!({}),
        updated_at: 0,
    }
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

            let outcome = match op.entity.as_str() {
                "task" => apply_task_op(&tx, device_id, op, &mut ack, &mut conflicts),
                "note" => apply_note_op(&tx, device_id, op, &mut ack, &mut conflicts),
                "capture" => apply_capture_op(&tx, device_id, op, &mut ack, &mut conflicts),
                _ => {
                    conflicts.push(conflict(op, "invalid_patch", None));
                    Ok(())
                }
            };
            match outcome {
                Ok(()) => {}
                Err(AppError::Validation(message)) => {
                    conflicts.push(conflict(op, "invalid_patch", None));
                    tracing::debug!("手机 push 被拒绝：{message}");
                }
                Err(other) => return Err(other),
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

fn ack_op(
    conn: &Connection,
    device_id: &str,
    op: &SyncOp,
    ack: &mut Vec<String>,
) -> AppResult<()> {
    record_op(conn, &op.op_id, device_id)?;
    ack.push(op.op_id.clone());
    Ok(())
}

fn apply_task_op(
    conn: &Connection,
    device_id: &str,
    op: &SyncOp,
    ack: &mut Vec<String>,
    conflicts: &mut Vec<SyncConflict>,
) -> AppResult<()> {
    let latest = latest_seq(conn, "task", &op.id)?;
    if op.deleted {
        match load_task_change(conn, &op.id, latest)? {
            None => {
                // 服务器本来就没有：幂等成功，避免客户端反复重试。
                ack_op(conn, device_id, op, ack)?;
            }
            Some(server) => {
                if latest != op.base_rev {
                    conflicts.push(conflict(op, "revision_mismatch", Some(server)));
                } else {
                    conn.execute("DELETE FROM tasks WHERE id = ?1", params![op.id])?;
                    ack_op(conn, device_id, op, ack)?;
                }
            }
        }
        return Ok(());
    }

    match load_task_change(conn, &op.id, latest)? {
        None => {
            if op.base_rev != 0 {
                conflicts.push(conflict(op, "record_missing", None));
            } else {
                insert_task_from_patch(conn, op)?;
                ack_op(conn, device_id, op, ack)?;
            }
        }
        Some(server) => {
            if latest != op.base_rev {
                conflicts.push(conflict(op, "revision_mismatch", Some(server)));
            } else {
                update_task_from_patch(conn, &server, &op.patch)?;
                ack_op(conn, device_id, op, ack)?;
            }
        }
    }
    Ok(())
}

fn apply_note_op(
    conn: &Connection,
    device_id: &str,
    op: &SyncOp,
    ack: &mut Vec<String>,
    conflicts: &mut Vec<SyncConflict>,
) -> AppResult<()> {
    let latest = latest_seq(conn, "note", &op.id)?;
    if op.deleted {
        match load_note_change(conn, &op.id, latest)? {
            None => {
                ack_op(conn, device_id, op, ack)?;
            }
            Some(server) => {
                if latest != op.base_rev {
                    conflicts.push(conflict(op, "revision_mismatch", Some(server)));
                } else {
                    conn.execute("DELETE FROM notes WHERE id = ?1", params![op.id])?;
                    ack_op(conn, device_id, op, ack)?;
                }
            }
        }
        return Ok(());
    }

    match load_note_change(conn, &op.id, latest)? {
        None => {
            if op.base_rev != 0 {
                conflicts.push(conflict(op, "record_missing", None));
            } else {
                insert_note_from_patch(conn, op)?;
                ack_op(conn, device_id, op, ack)?;
            }
        }
        Some(server) => {
            if latest != op.base_rev {
                conflicts.push(conflict(op, "revision_mismatch", Some(server)));
            } else {
                update_note_from_patch(conn, &server, &op.patch)?;
                ack_op(conn, device_id, op, ack)?;
            }
        }
    }
    Ok(())
}

fn apply_capture_op(
    conn: &Connection,
    device_id: &str,
    op: &SyncOp,
    ack: &mut Vec<String>,
    conflicts: &mut Vec<SyncConflict>,
) -> AppResult<()> {
    let latest = latest_seq(conn, "capture", &op.id)?;
    if op.deleted {
        match load_capture_change(conn, &op.id, latest)? {
            None => {
                ack_op(conn, device_id, op, ack)?;
            }
            Some(server) => {
                if latest != op.base_rev {
                    conflicts.push(conflict(op, "revision_mismatch", Some(server)));
                } else {
                    // 桌面端已 handled/converted 的行同样按删除处理：手机端本来也不再展示。
                    conn.execute("DELETE FROM quick_capture_items WHERE id = ?1", params![op.id])?;
                    ack_op(conn, device_id, op, ack)?;
                }
            }
        }
        return Ok(());
    }

    match load_capture_change(conn, &op.id, latest)? {
        None => {
            if op.base_rev != 0 {
                conflicts.push(conflict(op, "record_missing", None));
            } else {
                insert_capture_from_patch(conn, op)?;
                ack_op(conn, device_id, op, ack)?;
            }
        }
        Some(server) => {
            // 已 handled/converted 的条目对手机端是墓碑，不再接受内容更新。
            if server.deleted || latest != op.base_rev {
                conflicts.push(conflict(op, "revision_mismatch", Some(server)));
            } else {
                update_capture_from_patch(conn, op)?;
                ack_op(conn, device_id, op, ack)?;
            }
        }
    }
    Ok(())
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

struct NoteRow {
    title: String,
    content: String,
    pinned: i64,
    favorite: i64,
    created_at: String,
    updated_at: String,
}

fn load_note_row(conn: &Connection, id: &str) -> AppResult<Option<NoteRow>> {
    Ok(conn
        .query_row(
            "SELECT title, content, pinned, favorite, created_at, updated_at
               FROM notes WHERE id = ?1",
            params![id],
            |row| {
                Ok(NoteRow {
                    title: row.get(0)?,
                    content: row.get(1)?,
                    pinned: row.get(2)?,
                    favorite: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .optional()?)
}

/// 桌面笔记映射为手机字段：content → body，favorite → favorited。
/// task_id / workspace_id 是桌面端关联，手机端没有对应字段，暂不下发也不覆盖。
fn load_note_change(conn: &Connection, id: &str, rev: i64) -> AppResult<Option<SyncChange>> {
    let Some(row) = load_note_row(conn, id)? else {
        return Ok(None);
    };
    let updated_at = iso_to_ms(&row.updated_at).unwrap_or_else(now_ms);
    let fields = json!({
        "title": row.title,
        "body": row.content,
        "pinned": row.pinned != 0,
        "favorited": row.favorite != 0,
        "createdAt": iso_to_ms(&row.created_at).unwrap_or(0),
        "updatedAt": updated_at,
    });
    Ok(Some(SyncChange {
        entity: "note".into(),
        id: id.to_string(),
        rev,
        deleted: false,
        fields,
        updated_at,
    }))
}

struct CaptureRow {
    client_id: String,
    kind: String,
    content: String,
    status: String,
    created_at: String,
    updated_at: String,
}

fn load_capture_row(conn: &Connection, id: &str) -> AppResult<Option<CaptureRow>> {
    Ok(conn
        .query_row(
            "SELECT client_id, kind, content, status, created_at, updated_at
               FROM quick_capture_items WHERE id = ?1",
            params![id],
            |row| {
                Ok(CaptureRow {
                    client_id: row.get(0)?,
                    kind: row.get(1)?,
                    content: row.get(2)?,
                    status: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .optional()?)
}

/// 收集箱只把 inbox 条目下发给手机；handled/converted 与硬删除一样是墓碑。
fn load_capture_change(conn: &Connection, id: &str, rev: i64) -> AppResult<Option<SyncChange>> {
    let Some(row) = load_capture_row(conn, id)? else {
        return Ok(None);
    };
    if row.status != "inbox" {
        return Ok(Some(tombstone("capture", id, rev)));
    }
    let updated_at = iso_to_ms(&row.updated_at).unwrap_or_else(now_ms);
    let fields = json!({
        "clientId": row.client_id,
        "kind": row.kind,
        "content": row.content,
        "createdAt": iso_to_ms(&row.created_at).unwrap_or(0),
        "updatedAt": updated_at,
    });
    Ok(Some(SyncChange {
        entity: "capture".into(),
        id: id.to_string(),
        rev,
        deleted: false,
        fields,
        updated_at,
    }))
}

fn validate_note(title: &str, content: &str) -> AppResult<()> {
    if title.chars().count() > NOTE_MAX_TITLE {
        return Err(AppError::Validation(format!(
            "笔记标题超过 {NOTE_MAX_TITLE} 字符"
        )));
    }
    if content.chars().count() > NOTE_MAX_CONTENT {
        return Err(AppError::Validation(format!(
            "笔记正文超过 {NOTE_MAX_CONTENT} 字符"
        )));
    }
    Ok(())
}

fn insert_note_from_patch(conn: &Connection, op: &SyncOp) -> AppResult<()> {
    let now = now_iso();
    let title = patch_string(&op.patch, "title")?.unwrap_or_default();
    let content = patch_string(&op.patch, "body")?.unwrap_or_default();
    validate_note(&title, &content)?;
    let pinned = patch_bool(&op.patch, "pinned")?.unwrap_or(false);
    let favorite = patch_bool(&op.patch, "favorited")?.unwrap_or(false);
    let created_at = patch_ms(&op.patch, "createdAt")?
        .map(ms_to_iso)
        .unwrap_or_else(|| now.clone());
    conn.execute(
        "INSERT INTO notes (id, title, content, pinned, favorite, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)",
        params![
            op.id,
            title,
            content,
            if pinned { 1 } else { 0 },
            if favorite { 1 } else { 0 },
            created_at,
            now,
        ],
    )?;
    Ok(())
}

fn update_note_from_patch(
    conn: &Connection,
    current: &SyncChange,
    patch: &Map<String, Value>,
) -> AppResult<()> {
    let row = load_note_row(conn, &current.id)?
        .ok_or_else(|| AppError::Validation("笔记在更新过程中消失".into()))?;
    let title = patch_string(patch, "title")?.unwrap_or(row.title);
    let content = patch_string(patch, "body")?.unwrap_or(row.content);
    validate_note(&title, &content)?;
    let pinned = patch_bool(patch, "pinned")?
        .map(|value| if value { 1 } else { 0 })
        .unwrap_or(row.pinned);
    let favorite = patch_bool(patch, "favorited")?
        .map(|value| if value { 1 } else { 0 })
        .unwrap_or(row.favorite);
    conn.execute(
        "UPDATE notes
            SET title = ?1, content = ?2, pinned = ?3, favorite = ?4,
                revision = revision + 1, updated_at = ?5
          WHERE id = ?6",
        params![title, content, pinned, favorite, now_iso(), current.id],
    )?;
    Ok(())
}

fn capture_client_id_exists(conn: &Connection, client_id: &str, id: &str) -> AppResult<bool> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM quick_capture_items WHERE client_id = ?1",
            params![client_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(existing.is_some_and(|existing_id| existing_id != id))
}

fn insert_capture_from_patch(conn: &Connection, op: &SyncOp) -> AppResult<()> {
    let now = now_iso();
    let client_id = patch_string(&op.patch, "clientId")?
        .unwrap_or_else(|| op.id.clone())
        .trim()
        .to_string();
    if client_id.is_empty() {
        return Err(AppError::Validation("clientId 不能为空".into()));
    }
    if client_id.chars().count() > CAPTURE_MAX_CLIENT_ID {
        return Err(AppError::Validation(format!(
            "clientId 超过 {CAPTURE_MAX_CLIENT_ID} 字符"
        )));
    }
    // 重复 client_id 已存在：同一 id 视为幂等成功，不同 id 拒绝（桌面唯一索引约束）。
    if capture_client_id_exists(conn, &client_id, &op.id)? {
        return Err(AppError::Validation("clientId 已被其他条目占用".into()));
    }
    let content = patch_string(&op.patch, "content")?
        .unwrap_or_default()
        .trim()
        .to_string();
    if content.is_empty() {
        return Err(AppError::Validation("收集箱内容不能为空".into()));
    }
    if content.chars().count() > CAPTURE_MAX_CONTENT {
        return Err(AppError::Validation(format!(
            "收集箱内容超过 {CAPTURE_MAX_CONTENT} 字符"
        )));
    }
    let kind = patch_string(&op.patch, "kind")?.unwrap_or_else(|| "text".into());
    if !CAPTURE_KINDS.contains(&kind.as_str()) {
        return Err(AppError::Validation("未知的收集箱类型".into()));
    }
    let created_at = patch_ms(&op.patch, "createdAt")?
        .map(ms_to_iso)
        .unwrap_or_else(|| now.clone());
    conn.execute(
        "INSERT INTO quick_capture_items
           (id, client_id, kind, content, url, note, status, task_id, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, NULL, 'inbox', NULL, 'mobile', ?5, ?6)",
        params![op.id, client_id, kind, content, created_at, now],
    )?;
    Ok(())
}

fn update_capture_from_patch(conn: &Connection, op: &SyncOp) -> AppResult<()> {
    let row = load_capture_row(conn, &op.id)?
        .ok_or_else(|| AppError::Validation("收集箱条目在更新过程中消失".into()))?;
    let content = match patch_string(&op.patch, "content")? {
        Some(value) => value.trim().to_string(),
        None => row.content,
    };
    if content.is_empty() {
        return Err(AppError::Validation("收集箱内容不能为空".into()));
    }
    if content.chars().count() > CAPTURE_MAX_CONTENT {
        return Err(AppError::Validation(format!(
            "收集箱内容超过 {CAPTURE_MAX_CONTENT} 字符"
        )));
    }
    let kind = match patch_string(&op.patch, "kind")? {
        Some(value) if CAPTURE_KINDS.contains(&value.as_str()) => value,
        Some(_) => return Err(AppError::Validation("未知的收集箱类型".into())),
        None => row.kind,
    };
    conn.execute(
        "UPDATE quick_capture_items SET content = ?1, kind = ?2, updated_at = ?3 WHERE id = ?4",
        params![content, kind, now_iso(), op.id],
    )?;
    Ok(())
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

fn patch_bool(patch: &Map<String, Value>, key: &str) -> AppResult<Option<bool>> {
    match patch.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(AppError::Validation(format!("{key} 必须是布尔值或 null"))),
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
        op_for("task", op_id, id, base_rev, patch)
    }

    fn op_for(entity: &str, op_id: &str, id: &str, base_rev: i64, patch: Value) -> SyncOp {
        SyncOp {
            op_id: op_id.into(),
            entity: entity.into(),
            id: id.into(),
            base_rev,
            patch: patch.as_object().cloned().unwrap_or_default(),
            deleted: false,
        }
    }

    fn insert_note(db: &Db, id: &str, title: &str, content: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO notes (id, title, content, pinned, favorite, revision, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 0, 0, 1,
                         strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                         strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![id, title, content],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn insert_capture(db: &Db, id: &str, client_id: &str, content: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO quick_capture_items
                   (id, client_id, kind, content, status, created_at, updated_at)
                 VALUES (?1, ?2, 'text', ?3, 'inbox',
                         strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                         strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                params![id, client_id, content],
            )?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn derive_key_matches_mobile_fixed_vector() {
        // 与 apps/mobile/src/lib/sync/__tests__/crypto.test.ts 的固定向量互为校验：
        // 双端 KDF 必须逐字节一致，否则同步载荷互相解不开。
        let token = "a".repeat(64);
        let key = derive_key(&hash_token(&token));
        let hex: String = key.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(
            hex,
            "282257e1912be9b743d7cb7eeab3056560492ab079a14bf613468fa30f0a5164"
        );
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

    #[test]
    fn note_pull_trigger_maps_content_to_body() {
        let db = test_db();
        insert_note(&db, "n1", "桌面笔记", "第一行\n第二行");
        let page = pull(&db, 0, 500).unwrap();
        let change = page.changes.iter().find(|c| c.id == "n1").unwrap();
        assert_eq!(change.entity, "note");
        assert!(!change.deleted);
        assert_eq!(change.fields["title"], "桌面笔记");
        assert_eq!(change.fields["body"], "第一行\n第二行");
        assert_eq!(change.fields["pinned"], false);
        assert!(change.fields["updatedAt"].as_i64().unwrap() > 0);

        // 桌面端修改后再次拉取：同一记录出现新版本
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE notes SET title='改名', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='n1'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let next = pull(&db, page.cursor.parse().unwrap(), 500).unwrap();
        let updated = next.changes.iter().find(|c| c.id == "n1").unwrap();
        assert_eq!(updated.fields["title"], "改名");
        assert!(updated.rev > change.rev);
    }

    #[test]
    fn note_push_create_update_delete_and_conflict() {
        let db = test_db();
        let create = op_for(
            "note",
            "op-n1",
            "n1",
            0,
            json!({
                "title": "手机笔记",
                "body": "正文",
                "pinned": true,
                "favorited": false,
                "createdAt": 1_700_000_000_000i64,
            }),
        );
        let first = apply_push(&db, "device-1", &[create]).unwrap();
        assert_eq!(first.ack, vec!["op-n1"]);
        let row: (String, String, i64, i64, i64) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT title, content, pinned, favorite, revision FROM notes WHERE id='n1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                )?)
            })
            .unwrap();
        assert_eq!(row, ("手机笔记".into(), "正文".into(), 1, 0, 1));

        let rev = pull(&db, 0, 500)
            .unwrap()
            .changes
            .iter()
            .find(|c| c.id == "n1")
            .unwrap()
            .rev;
        let update = op_for("note", "op-n2", "n1", rev, json!({"body": "新正文"}));
        assert_eq!(apply_push(&db, "device-1", &[update]).unwrap().ack, vec!["op-n2"]);
        let (content, revision): (String, i64) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT content, revision FROM notes WHERE id='n1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?)
            })
            .unwrap();
        assert_eq!((content.as_str(), revision), ("新正文", 2));

        // 桌面端又改过：旧 base_rev 的 push 必须冲突且不覆盖
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE notes SET title='桌面新标题', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='n1'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let stale = op_for("note", "op-n3", "n1", rev, json!({"title": "手机旧标题"}));
        let result = apply_push(&db, "device-1", &[stale]).unwrap();
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(result.conflicts[0].reason, "revision_mismatch");
        assert_eq!(
            result.conflicts[0].server_record.as_ref().unwrap().fields["title"],
            "桌面新标题"
        );
        let title: String = db
            .with_conn(|conn| Ok(conn.query_row("SELECT title FROM notes WHERE id='n1'", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(title, "桌面新标题");

        let latest = pull(&db, 0, 500)
            .unwrap()
            .changes
            .iter()
            .filter(|c| c.id == "n1")
            .next_back()
            .unwrap()
            .rev;
        let mut delete = op_for("note", "op-n4", "n1", latest, json!({}));
        delete.deleted = true;
        assert_eq!(apply_push(&db, "device-1", &[delete]).unwrap().ack, vec!["op-n4"]);
        let exists: i64 = db
            .with_conn(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM notes WHERE id='n1'", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(exists, 0);
        let tombstone = pull(&db, 0, 500)
            .unwrap()
            .changes
            .iter()
            .filter(|c| c.id == "n1")
            .next_back()
            .unwrap()
            .clone();
        assert!(tombstone.deleted);
    }

    #[test]
    fn capture_pull_only_inbox_and_status_change_is_tombstone() {
        let db = test_db();
        insert_capture(&db, "c1", "client-1", "买牛奶");
        let page = pull(&db, 0, 500).unwrap();
        let change = page.changes.iter().find(|c| c.id == "c1").unwrap();
        assert_eq!(change.entity, "capture");
        assert!(!change.deleted);
        assert_eq!(change.fields["content"], "买牛奶");
        assert_eq!(change.fields["clientId"], "client-1");

        // 桌面端标记已处理：手机端按墓碑处理
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE quick_capture_items
                    SET status='handled', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                  WHERE id='c1'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let next = pull(&db, page.cursor.parse().unwrap(), 500).unwrap();
        let handled = next.changes.iter().find(|c| c.id == "c1").unwrap();
        assert!(handled.deleted);
        assert!(handled.rev > change.rev);
    }

    #[test]
    fn capture_push_create_delete_and_duplicate_client_id() {
        let db = test_db();
        let create = op_for(
            "capture",
            "op-c1",
            "c1",
            0,
            json!({"clientId": "client-1", "content": "手机收集", "kind": "text", "createdAt": 1_700_000_000_000i64}),
        );
        let first = apply_push(&db, "device-1", &[create.clone()]).unwrap();
        assert_eq!(first.ack, vec!["op-c1"]);
        let row: (String, String, String) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT client_id, content, status FROM quick_capture_items WHERE id='c1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?)
            })
            .unwrap();
        assert_eq!(row, ("client-1".into(), "手机收集".into(), "inbox".into()));
        assert_eq!(apply_push(&db, "device-1", &[create]).unwrap().ack, vec!["op-c1"]);

        // 不同 id 复用同一 client_id：拒绝而不是撞唯一索引
        let duplicate = op_for(
            "capture",
            "op-c2",
            "c2",
            0,
            json!({"clientId": "client-1", "content": "另一条"}),
        );
        let result = apply_push(&db, "device-1", &[duplicate]).unwrap();
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(result.conflicts[0].reason, "invalid_patch");

        let rev = pull(&db, 0, 500)
            .unwrap()
            .changes
            .iter()
            .find(|c| c.id == "c1")
            .unwrap()
            .rev;
        let mut delete = op_for("capture", "op-c3", "c1", rev, json!({}));
        delete.deleted = true;
        assert_eq!(apply_push(&db, "device-1", &[delete]).unwrap().ack, vec!["op-c3"]);
        let exists: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM quick_capture_items WHERE id='c1'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(exists, 0);
    }
}
