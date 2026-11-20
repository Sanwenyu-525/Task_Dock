//! 独立保险箱库：`secure-vault.db`。
//!
//! 只存密文与不透明元数据；**不复用**主库的 `MIGRATIONS` / `BACKUP_TABLES`。

use std::path::{Path, PathBuf};

use hmac::{Hmac, Mac};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use sha2::Sha256;

use crate::secure_vault::crypto::kdf::{derive_digest_key, Argon2Params};
use crate::secure_vault::crypto::secret_bytes::b64_encode;
use crate::secure_vault::crypto::ENVELOPE_VERSION;
use crate::secure_vault::error::VaultError;

pub const SCHEMA_VERSION: u32 = 1;

/// 审计保留「数量上限」：超出后删除最旧（替代原 500 条硬截断，上限放宽到 1000）。
pub const AUDIT_MAX_ROWS: i64 = 1000;
/// 审计保留「时间上限」（天）：更早的行删除最旧优先。
pub const AUDIT_MAX_AGE_DAYS: i64 = 90;

#[derive(Debug, Clone)]
pub struct StoredEnvelope {
    pub slot: String,
    pub envelope_json: String,
    pub dek_ver: u32,
}

#[derive(Debug, Clone)]
pub struct StoredRecord {
    pub id: String,
    pub rev: i64,
    pub dek_ver: u32,
    pub alg_ver: u32,
    pub data_ver: u32,
    pub meta_nonce: [u8; 12],
    pub meta_ct: Vec<u8>,
    pub secret_nonce: [u8; 12],
    pub secret_ct: Vec<u8>,
    pub tombstone: i64,
}

#[derive(Debug, Clone)]
pub struct StoredUsage {
    pub record_id: String,
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
    pub alg_ver: u32,
    pub dek_ver: u32,
}

#[derive(Debug, Clone)]
pub struct StoredSetting {
    pub key: String,
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
    pub alg_ver: u32,
    pub dek_ver: u32,
}

#[derive(Debug, Clone)]
pub struct StoredName {
    pub id: String,
    pub sort_order: i64,
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
    pub dek_ver: u32,
}

#[derive(Debug, Clone)]
pub struct AuditRow {
    pub id: i64,
    pub at: String,
    pub event: String,
    pub outcome: String,
    pub reason_code: Option<String>,
    pub count: Option<i64>,
}

pub struct VaultStore {
    path: PathBuf,
    conn: Mutex<Connection>,
}

impl VaultStore {
    pub fn open(path: &Path) -> Result<Self, VaultError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        let _mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
        conn.execute_batch(
            "PRAGMA synchronous=FULL;
             PRAGMA foreign_keys=ON;
             PRAGMA temp_store=MEMORY;
             PRAGMA secure_delete=ON;
             PRAGMA busy_timeout=5000;",
        )?;
        let store = Self {
            path: path.to_path_buf(),
            conn: Mutex::new(conn),
        };
        store.ensure_schema()?;
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn ensure_schema(&self) -> Result<(), VaultError> {
        let mut conn = self.conn.lock();
        let has_meta: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='vault_meta'",
            [],
            |r| r.get(0),
        )?;
        if has_meta == 0 {
            let tx = conn.transaction()?;
            tx.execute_batch(
                "CREATE TABLE vault_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
                 CREATE TABLE key_envelopes (
                   id TEXT PRIMARY KEY NOT NULL,
                   slot TEXT NOT NULL,
                   envelope_json TEXT NOT NULL,
                   dek_ver INTEGER NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE UNIQUE INDEX idx_envelopes_slot ON key_envelopes(slot);
                 CREATE TABLE records (
                   id TEXT PRIMARY KEY NOT NULL,
                   rev INTEGER NOT NULL,
                   dek_ver INTEGER NOT NULL,
                   alg_ver INTEGER NOT NULL,
                   data_ver INTEGER NOT NULL,
                   meta_nonce BLOB NOT NULL,
                   meta_ct BLOB NOT NULL,
                   secret_nonce BLOB NOT NULL,
                   secret_ct BLOB NOT NULL,
                   tombstone INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE INDEX idx_records_tombstone_rev ON records(tombstone, rev);
                 CREATE TABLE record_usage (
                   record_id TEXT PRIMARY KEY NOT NULL,
                   used_nonce BLOB NOT NULL,
                   used_ct BLOB NOT NULL,
                   alg_ver INTEGER NOT NULL,
                   dek_ver INTEGER NOT NULL
                 );
                 CREATE TABLE categories (
                   id TEXT PRIMARY KEY NOT NULL,
                   sort_order INTEGER NOT NULL,
                   name_nonce BLOB NOT NULL,
                   name_ct BLOB NOT NULL,
                   alg_ver INTEGER NOT NULL,
                   dek_ver INTEGER NOT NULL
                 );
                 CREATE TABLE tags (
                   id TEXT PRIMARY KEY NOT NULL,
                   name_nonce BLOB NOT NULL,
                   name_ct BLOB NOT NULL,
                   alg_ver INTEGER NOT NULL,
                   dek_ver INTEGER NOT NULL
                 );
                 CREATE TABLE settings (
                   key TEXT PRIMARY KEY NOT NULL,
                   value_nonce BLOB NOT NULL,
                   value_ct BLOB NOT NULL,
                   alg_ver INTEGER NOT NULL,
                   dek_ver INTEGER NOT NULL
                 );
                 CREATE TABLE audit (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   at TEXT NOT NULL,
                   event TEXT NOT NULL,
                   outcome TEXT NOT NULL,
                   reason_code TEXT,
                   count INTEGER
                 );",
            )?;
            tx.execute(
                "INSERT INTO vault_meta(key,value) VALUES('schema_version', ?1)",
                params![SCHEMA_VERSION.to_string()],
            )?;
            tx.commit()?;
            return Ok(());
        }
        let version: Option<String> = conn
            .query_row(
                "SELECT value FROM vault_meta WHERE key='schema_version'",
                [],
                |r| r.get(0),
            )
            .ok();
        let version = version.and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
        if version > SCHEMA_VERSION {
            return Err(VaultError::format_unsupported(version, SCHEMA_VERSION));
        }
        if version == 0 {
            // 旧库（理论上不存在）：补写版本，不做结构变更。
            conn.execute(
                "INSERT OR REPLACE INTO vault_meta(key,value) VALUES('schema_version', ?1)",
                params![SCHEMA_VERSION.to_string()],
            )?;
        }
        Ok(())
    }

    pub fn is_initialized(&self) -> Result<bool, VaultError> {
        let conn = self.conn.lock();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM key_envelopes WHERE slot='master'",
            [],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>, VaultError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT value FROM vault_meta WHERE key=?1")?;
        let mut rows = stmt.query(params![key])?;
        Ok(rows.next()?.map(|r| r.get::<_, String>(0)).transpose()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), VaultError> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO vault_meta(key,value) VALUES(?1,?2)",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn set_meta_batch(&self, pairs: &[(&str, String)]) -> Result<(), VaultError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for (k, v) in pairs {
            tx.execute(
                "INSERT OR REPLACE INTO vault_meta(key,value) VALUES(?1,?2)",
                params![k, v],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn next_rev(&self) -> Result<i64, VaultError> {
        Ok(self
            .get_meta("next_rev")?
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(1))
    }

    pub fn load_envelopes(&self) -> Result<Vec<StoredEnvelope>, VaultError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT slot, envelope_json, dek_ver FROM key_envelopes ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(StoredEnvelope {
                slot: r.get(0)?,
                envelope_json: r.get(1)?,
                dek_ver: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn get_envelope(&self, slot: &str) -> Result<Option<StoredEnvelope>, VaultError> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare("SELECT slot, envelope_json, dek_ver FROM key_envelopes WHERE slot=?1")?;
        let mut rows = stmt.query(params![slot])?;
        Ok(rows
            .next()?
            .map(|r| {
                Ok::<_, rusqlite::Error>(StoredEnvelope {
                    slot: r.get(0)?,
                    envelope_json: r.get(1)?,
                    dek_ver: r.get(2)?,
                })
            })
            .transpose()?)
    }

    pub fn put_envelope(
        &self,
        slot: &str,
        envelope_json: &str,
        dek_ver: u32,
        created_at: &str,
    ) -> Result<(), VaultError> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO key_envelopes(id,slot,envelope_json,dek_ver,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?5)
             ON CONFLICT(slot) DO UPDATE SET envelope_json=excluded.envelope_json,
               dek_ver=excluded.dek_ver, updated_at=excluded.updated_at",
            params![
                uuid::Uuid::new_v4().to_string(),
                slot,
                envelope_json,
                dek_ver,
                created_at
            ],
        )?;
        Ok(())
    }

    pub fn read_all_records(&self) -> Result<Vec<StoredRecord>, VaultError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id,rev,dek_ver,alg_ver,data_ver,meta_nonce,meta_ct,secret_nonce,secret_ct,tombstone
             FROM records ORDER BY rev ASC",
        )?;
        let rows = stmt.query_map([], row_to_record)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn get_record(&self, id: &str) -> Result<Option<StoredRecord>, VaultError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id,rev,dek_ver,alg_ver,data_ver,meta_nonce,meta_ct,secret_nonce,secret_ct,tombstone
             FROM records WHERE id=?1",
        )?;
        let mut rows = stmt.query(params![id])?;
        Ok(rows.next()?.map(row_to_record).transpose()?)
    }

    /// 写入一条记录并把 `next_rev` / 摘要放进**同一个事务**。
    pub fn write_record(
        &self,
        rec: &StoredRecord,
        next_rev: i64,
        dek: &[u8; 32],
        vault_salt: &[u8; 16],
    ) -> Result<[u8; 32], VaultError> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO records(id,rev,dek_ver,alg_ver,data_ver,meta_nonce,meta_ct,secret_nonce,secret_ct,tombstone)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(id) DO UPDATE SET rev=excluded.rev, dek_ver=excluded.dek_ver,
               alg_ver=excluded.alg_ver, data_ver=excluded.data_ver,
               meta_nonce=excluded.meta_nonce, meta_ct=excluded.meta_ct,
               secret_nonce=excluded.secret_nonce, secret_ct=excluded.secret_ct,
               tombstone=excluded.tombstone",
            params![
                &rec.id,
                rec.rev,
                rec.dek_ver,
                rec.alg_ver,
                rec.data_ver,
                rec.meta_nonce.as_slice(),
                &rec.meta_ct,
                rec.secret_nonce.as_slice(),
                &rec.secret_ct,
                rec.tombstone
            ],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO vault_meta(key,value) VALUES('next_rev',?1)",
            params![next_rev.to_string()],
        )?;
        let digest = digest_conn(&tx, dek, vault_salt)?;
        tx.execute(
            "INSERT OR REPLACE INTO vault_meta(key,value) VALUES('digest_hmac',?1)",
            params![b64_encode(&digest)],
        )?;
        tx.commit()?;
        Ok(digest)
    }

    pub fn delete_usage(&self, record_id: &str) -> Result<(), VaultError> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM record_usage WHERE record_id=?1",
            params![record_id],
        )?;
        Ok(())
    }

    pub fn load_usage(&self) -> Result<Vec<StoredUsage>, VaultError> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare("SELECT record_id,used_nonce,used_ct,alg_ver,dek_ver FROM record_usage")?;
        let rows = stmt.query_map([], |r| {
            Ok(StoredUsage {
                record_id: r.get(0)?,
                nonce: blob_nonce(r.get(1)?)?,
                ciphertext: r.get(2)?,
                alg_ver: r.get(3)?,
                dek_ver: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn put_usage(&self, usage: &StoredUsage) -> Result<(), VaultError> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO record_usage(record_id,used_nonce,used_ct,alg_ver,dek_ver)
             VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(record_id) DO UPDATE SET used_nonce=excluded.used_nonce,
               used_ct=excluded.used_ct, alg_ver=excluded.alg_ver, dek_ver=excluded.dek_ver",
            params![
                &usage.record_id,
                usage.nonce.as_slice(),
                &usage.ciphertext,
                usage.alg_ver,
                usage.dek_ver
            ],
        )?;
        Ok(())
    }

    pub fn load_settings(&self) -> Result<Vec<StoredSetting>, VaultError> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare("SELECT key,value_nonce,value_ct,alg_ver,dek_ver FROM settings")?;
        let rows = stmt.query_map([], |r| {
            Ok(StoredSetting {
                key: r.get(0)?,
                nonce: blob_nonce(r.get(1)?)?,
                ciphertext: r.get(2)?,
                alg_ver: r.get(3)?,
                dek_ver: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn put_setting(
        &self,
        key: &str,
        nonce: &[u8; 12],
        ciphertext: &[u8],
        dek_ver: u32,
    ) -> Result<(), VaultError> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO settings(key,value_nonce,value_ct,alg_ver,dek_ver)
             VALUES(?1,?2,?3,1,?4)
             ON CONFLICT(key) DO UPDATE SET value_nonce=excluded.value_nonce,
               value_ct=excluded.value_ct, dek_ver=excluded.dek_ver",
            params![key, nonce.as_slice(), &ciphertext, dek_ver],
        )?;
        Ok(())
    }

    pub fn load_categories(&self) -> Result<Vec<StoredName>, VaultError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id,sort_order,name_nonce,name_ct,dek_ver FROM categories ORDER BY sort_order ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(StoredName {
                id: r.get(0)?,
                sort_order: r.get(1)?,
                nonce: blob_nonce(r.get(2)?)?,
                ciphertext: r.get(3)?,
                dek_ver: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn put_category(&self, row: &StoredName) -> Result<(), VaultError> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO categories(id,sort_order,name_nonce,name_ct,alg_ver,dek_ver)
             VALUES(?1,?2,?3,?4,1,?5)
             ON CONFLICT(id) DO UPDATE SET sort_order=excluded.sort_order,
               name_nonce=excluded.name_nonce, name_ct=excluded.name_ct, dek_ver=excluded.dek_ver",
            params![
                &row.id,
                row.sort_order,
                row.nonce.as_slice(),
                &row.ciphertext,
                row.dek_ver
            ],
        )?;
        Ok(())
    }

    pub fn delete_category(&self, id: &str) -> Result<(), VaultError> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM categories WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn load_tags(&self) -> Result<Vec<StoredName>, VaultError> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare("SELECT id,name_nonce,name_ct,dek_ver FROM tags ORDER BY id ASC")?;
        let rows = stmt.query_map([], |r| {
            Ok(StoredName {
                id: r.get(0)?,
                sort_order: 0,
                nonce: blob_nonce(r.get(1)?)?,
                ciphertext: r.get(2)?,
                dek_ver: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn put_tag(&self, row: &StoredName) -> Result<(), VaultError> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO tags(id,name_nonce,name_ct,alg_ver,dek_ver)
             VALUES(?1,?2,?3,1,?4)
             ON CONFLICT(id) DO UPDATE SET name_nonce=excluded.name_nonce,
               name_ct=excluded.name_ct, dek_ver=excluded.dek_ver",
            params![&row.id, row.nonce.as_slice(), &row.ciphertext, row.dek_ver],
        )?;
        Ok(())
    }

    pub fn delete_tag(&self, id: &str) -> Result<(), VaultError> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM tags WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn audit(
        &self,
        event: &str,
        outcome: &str,
        reason: Option<&str>,
        count: Option<i64>,
    ) -> Result<(), VaultError> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO audit(at,event,outcome,reason_code,count) VALUES(?1,?2,?3,?4,?5)",
            params![
                chrono::Utc::now().to_rfc3339(),
                event,
                outcome,
                reason,
                count
            ],
        )?;
        prune_audit(&conn)?;
        Ok(())
    }

    pub fn load_audit(&self, limit: usize) -> Result<Vec<AuditRow>, VaultError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id,at,event,outcome,reason_code,count FROM audit ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |r| {
            Ok(AuditRow {
                id: r.get(0)?,
                at: r.get(1)?,
                event: r.get(2)?,
                outcome: r.get(3)?,
                reason_code: r.get(4)?,
                count: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn digest_of(&self, dek: &[u8; 32], vault_salt: &[u8; 16]) -> Result<[u8; 32], VaultError> {
        let conn = self.conn.lock();
        digest_conn(&conn, dek, vault_salt)
    }
}

/// 审计保留「时间 + 数量」双上限（调用点签名不变）：
/// - 数量：只保留最近 [`AUDIT_MAX_ROWS`] 条（id 单调递增 = 写入顺序）；
/// - 时间：删除 [`AUDIT_MAX_AGE_DAYS`] 天前的行。
///
/// `at` 是 RFC3339 字符串，`to_rfc3339` 的亚秒精度可变，字典序比较不可靠，
/// 因此时间维度在 Rust 侧解析比对（行数受数量上限约束，全量扫描代价可忽略）。
fn prune_audit(conn: &Connection) -> Result<(), VaultError> {
    conn.execute(
        "DELETE FROM audit WHERE id IN (SELECT id FROM audit ORDER BY id DESC LIMIT -1 OFFSET ?1)",
        params![AUDIT_MAX_ROWS],
    )?;
    let cutoff = chrono::Utc::now() - chrono::Duration::days(AUDIT_MAX_AGE_DAYS);
    let stale: Vec<i64> = {
        let mut stmt = conn.prepare("SELECT id, at FROM audit")?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?;
        let mut stale = Vec::new();
        for row in rows {
            let (id, at) = row?;
            match chrono::DateTime::parse_from_rfc3339(&at) {
                // 解析失败的时间戳视为异常行，一并按过期处理（宁删勿留脏数据）。
                Ok(parsed) => {
                    if parsed.with_timezone(&chrono::Utc) < cutoff {
                        stale.push(id);
                    }
                }
                Err(_) => stale.push(id),
            }
        }
        stale
    };
    for id in stale {
        conn.execute("DELETE FROM audit WHERE id = ?1", params![id])?;
    }
    Ok(())
}

fn digest_conn(
    conn: &Connection,
    dek: &[u8; 32],
    vault_salt: &[u8; 16],
) -> Result<[u8; 32], VaultError> {
    let key = derive_digest_key(dek, vault_salt)?;
    let mut stmt = conn.prepare("SELECT id,rev FROM records WHERE tombstone=0 ORDER BY id ASC")?;
    let mut rows = stmt.query([])?;
    let mut mac =
        Hmac::<Sha256>::new_from_slice(&key[..]).map_err(|_| VaultError::internal("hmac:key"))?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let rev: i64 = row.get(1)?;
        mac.update(format!("{id}:{rev}\n").as_bytes());
    }
    let out = mac.finalize().into_bytes();
    let mut buf = [0u8; 32];
    buf.copy_from_slice(&out);
    Ok(buf)
}

fn row_to_record(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRecord> {
    Ok(StoredRecord {
        id: r.get(0)?,
        rev: r.get(1)?,
        dek_ver: r.get(2)?,
        alg_ver: r.get(3)?,
        data_ver: r.get(4)?,
        meta_nonce: blob_nonce(r.get(5)?)?,
        meta_ct: r.get(6)?,
        secret_nonce: blob_nonce(r.get(7)?)?,
        secret_ct: r.get(8)?,
        tombstone: r.get(9)?,
    })
}

fn blob_nonce(bytes: Vec<u8>) -> rusqlite::Result<[u8; 12]> {
    if bytes.len() != 12 {
        return Err(rusqlite::Error::InvalidColumnType(
            0,
            "nonce".into(),
            rusqlite::types::Type::Blob,
        ));
    }
    let mut out = [0u8; 12];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// 建库时的初始参数（由命令层计算后传入）。
pub struct Bootstrap {
    pub vault_id: String,
    pub vault_salt_b64: String,
    pub argon2: Argon2Params,
    pub dek_ver: u32,
    pub master_envelope: String,
    pub recovery_envelope: String,
    pub created_at: String,
}

pub fn bootstrap(store: &VaultStore, b: &Bootstrap, dek: &[u8; 32]) -> Result<(), VaultError> {
    let digest = store.digest_of(dek, &decode_salt(&b.vault_salt_b64)?)?;
    let mut meta: Vec<(&str, String)> = vec![
        ("schema_version", SCHEMA_VERSION.to_string()),
        ("vault_id", b.vault_id.clone()),
        ("vault_salt", b.vault_salt_b64.clone()),
        ("next_rev", "1".to_string()),
        ("generation", "1".to_string()),
        ("digest_hmac", b64_encode(&digest)),
        ("fail_count", "0".to_string()),
        ("created_at", b.created_at.clone()),
        ("master_reforged_at", b.created_at.clone()),
        ("envelope_version", ENVELOPE_VERSION.to_string()),
        ("kdf_m_cost_kib", b.argon2.m_cost_kib.to_string()),
        ("kdf_t_cost", b.argon2.t_cost.to_string()),
        ("kdf_p_cost", b.argon2.p_cost.to_string()),
    ];
    meta.push(("dek_ver", b.dek_ver.to_string()));
    store.set_meta_batch(&meta)?;
    store.put_envelope("master", &b.master_envelope, b.dek_ver, &b.created_at)?;
    store.put_envelope("recovery", &b.recovery_envelope, b.dek_ver, &b.created_at)?;
    Ok(())
}

pub fn decode_salt(b64: &str) -> Result<[u8; 16], VaultError> {
    let bytes = crate::secure_vault::crypto::secret_bytes::b64_decode(b64)?;
    if bytes.len() != 16 {
        return Err(VaultError::corrupt());
    }
    let mut out = [0u8; 16];
    out.copy_from_slice(&bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> VaultStore {
        let dir = std::env::temp_dir().join(format!(
            "taskdock-vault-audit-test-{}-{}",
            tag,
            uuid::Uuid::new_v4().simple()
        ));
        VaultStore::open(&dir.join("secure-vault.db")).unwrap()
    }

    fn audit_total(store: &VaultStore) -> i64 {
        let conn = store.conn.lock();
        conn.query_row("SELECT COUNT(*) FROM audit", [], |r| r.get(0))
            .unwrap()
    }

    fn audit_min_id(store: &VaultStore) -> i64 {
        let conn = store.conn.lock();
        conn.query_row("SELECT COALESCE(MIN(id), 0) FROM audit", [], |r| r.get(0))
            .unwrap()
    }

    fn audit_newest_event(store: &VaultStore) -> String {
        let conn = store.conn.lock();
        conn.query_row(
            "SELECT event FROM audit ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn cleanup(store: &VaultStore) {
        if let Some(parent) = store.path.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn audit_count_cap_keeps_newest_rows() {
        let store = temp_store("count");
        {
            let conn = store.conn.lock();
            conn.execute_batch("BEGIN").unwrap();
            for _ in 0..1000 {
                conn.execute(
                    "INSERT INTO audit(at,event,outcome,reason_code,count) VALUES(?1,'filler','ok',NULL,NULL)",
                    params![chrono::Utc::now().to_rfc3339()],
                )
                .unwrap();
            }
            conn.execute_batch("COMMIT").unwrap();
        }
        // 第 1001 条写入触发数量上限：删除最旧，保留最新 1000 条。
        store.audit("vault_create", "ok", None, None).unwrap();
        assert_eq!(audit_total(&store), AUDIT_MAX_ROWS);
        assert!(audit_min_id(&store) > 1, "最早一批 filler 行应被裁剪");
        assert_eq!(audit_newest_event(&store), "vault_create");
        cleanup(&store);
    }

    #[test]
    fn audit_time_cap_deletes_rows_older_than_window() {
        let store = temp_store("time");
        let old_at = (chrono::Utc::now() - chrono::Duration::days(AUDIT_MAX_AGE_DAYS + 5))
            .to_rfc3339();
        {
            let conn = store.conn.lock();
            for _ in 0..5 {
                conn.execute(
                    "INSERT INTO audit(at,event,outcome,reason_code,count) VALUES(?1,'old','ok',NULL,NULL)",
                    params![old_at],
                )
                .unwrap();
            }
        }
        // 行数远低于数量上限，但全部超出 90 天 → 时间上限删除
        store.audit("unlock", "ok", None, None).unwrap();
        assert_eq!(audit_total(&store), 1);
        assert_eq!(audit_newest_event(&store), "unlock");
        cleanup(&store);
    }

    #[test]
    fn audit_rows_within_window_and_limit_are_kept() {
        let store = temp_store("keep");
        for _ in 0..3 {
            store.audit("unlock", "ok", None, None).unwrap();
        }
        assert_eq!(audit_total(&store), 3);
        cleanup(&store);
    }
}
