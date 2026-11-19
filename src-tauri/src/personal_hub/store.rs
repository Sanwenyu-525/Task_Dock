//! Personal Hub 独立 SQLite 存储（P3）。
//!
//! 位置：`%LOCALAPPDATA%\TaskDock\personal-hub\hub.db`（基线 §12）。
//! **不修改** `src-tauri/src/db/mod.rs` 的共享数据库与迁移；本文件使用独立的
//! `Personal Hub` 数据库文件，迁移版本化（`PRAGMA user_version`）。
//!
//! 数据安全（基线 §12）：
//! - 私钥只以 DPAPI 密文存 `ph_device_keys`，明文永不落盘；
//! - 邀请 secret 只存 SHA-256 哈希，不存明文；
//! - 审计表 append-only，只记设备 ID / 请求 ID / 指纹 / 结果，不记公钥正文、
//!   私钥、密码或任何会话正文。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};

use crate::personal_hub::error::{HubError, HubResult};

/// 当前 schema 版本；只追加迁移，不修改已发布版本。
const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE IF NOT EXISTS ph_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ph_device_keys (
        device_id             TEXT PRIMARY KEY,
        key_alg               TEXT NOT NULL,
        public_key_b64        TEXT NOT NULL,
        protected_private_key BLOB NOT NULL,
        created_at            TEXT NOT NULL,
        rotated_at            TEXT
    );

    CREATE TABLE IF NOT EXISTS ph_devices (
        device_id             TEXT PRIMARY KEY,
        device_type           TEXT NOT NULL,
        display_name          TEXT NOT NULL,
        identity_public_key   TEXT NOT NULL,
        identity_fingerprint  TEXT NOT NULL,
        capabilities          TEXT NOT NULL,
        paired_at             TEXT NOT NULL,
        last_seen_at          TEXT,
        revoked_at            TEXT,
        revoke_reason         TEXT
    );

    CREATE TABLE IF NOT EXISTS ph_pairing_invitations (
        invitation_id          TEXT PRIMARY KEY,
        issuer_device_id       TEXT NOT NULL,
        invitation_secret_hash TEXT NOT NULL,
        nonce                  TEXT NOT NULL,
        created_at             TEXT NOT NULL,
        expires_at             TEXT NOT NULL,
        consumed_at            TEXT,
        failed_attempts        INTEGER NOT NULL DEFAULT 0,
        status                 TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ph_invitations_status
        ON ph_pairing_invitations(status);

    CREATE TABLE IF NOT EXISTS ph_audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type  TEXT NOT NULL,
        device_id   TEXT,
        request_id  TEXT,
        fingerprint TEXT,
        result      TEXT NOT NULL,
        detail      TEXT,
        created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ph_audit_created_at
        ON ph_audit_log(created_at);
    "#,
];

pub const INVITATION_PENDING: &str = "pending";
pub const INVITATION_CONSUMED: &str = "consumed";
pub const INVITATION_EXPIRED: &str = "expired";
pub const INVITATION_REVOKED: &str = "revoked";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredDeviceKey {
    pub device_id: String,
    pub key_alg: String,
    pub public_key_b64: String,
    pub protected_private_key: Vec<u8>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredDevice {
    pub device_id: String,
    pub device_type: String,
    pub display_name: String,
    pub identity_public_key: String,
    pub identity_fingerprint: String,
    pub capabilities: Vec<String>,
    pub paired_at: String,
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
    pub revoke_reason: Option<String>,
}

impl StoredDevice {
    pub fn is_revoked(&self) -> bool {
        self.revoked_at.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredInvitation {
    pub invitation_id: String,
    pub issuer_device_id: String,
    pub invitation_secret_hash: String,
    pub nonce: String,
    pub created_at: String,
    pub expires_at: String,
    pub consumed_at: Option<String>,
    pub failed_attempts: i64,
    pub status: String,
}

pub struct HubStore {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl HubStore {
    /// 打开（必要时创建）hub.db 并执行 append-only 迁移。
    pub fn open(path: impl AsRef<Path>) -> HubResult<Arc<Self>> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                HubError::Storage(format!("create personal-hub dir failed: {}", e))
            })?;
        }
        let conn = Connection::open(&path)
            .map_err(|e| HubError::Storage(format!("open hub.db failed: {}", e)))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;")
            .map_err(|e| HubError::Storage(format!("configure hub.db failed: {}", e)))?;
        let store = Self {
            conn: Mutex::new(conn),
            path,
        };
        store.migrate()?;
        Ok(Arc::new(store))
    }

    /// 默认位置：`%LOCALAPPDATA%\TaskDock\personal-hub\hub.db`。
    /// `TASKDOCK_PH_DATA_DIR` 仅供测试/便携部署覆盖目录。
    pub fn open_default() -> HubResult<Arc<Self>> {
        let dir = default_data_dir()?;
        Self::open(dir.join("hub.db"))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn migrate(&self) -> HubResult<()> {
        let mut conn = self.conn.lock();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| HubError::Storage(format!("read user_version failed: {}", e)))?;
        if version < 0 || version as usize > MIGRATIONS.len() {
            return Err(HubError::Storage(format!(
                "hub.db schema version {} is newer than supported {}",
                version,
                MIGRATIONS.len()
            )));
        }
        for (index, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            let tx = conn
                .transaction()
                .map_err(|e| HubError::Storage(format!("begin migration failed: {}", e)))?;
            tx.execute_batch(sql)
                .map_err(|e| HubError::Storage(format!("migration v{} failed: {}", index + 1, e)))?;
            tx.execute_batch(&format!("PRAGMA user_version = {}", index + 1))
                .map_err(|e| HubError::Storage(format!("set user_version failed: {}", e)))?;
            tx.commit()
                .map_err(|e| HubError::Storage(format!("commit migration failed: {}", e)))?;
        }
        Ok(())
    }

    // ---- 设备身份密钥 ----

    /// 首次生成时插入；已存在返回 false（绝不覆盖既有身份）。
    pub fn insert_device_key(
        &self,
        device_id: &str,
        public_key_b64: &str,
        protected_private_key: &[u8],
        created_at: &str,
    ) -> HubResult<bool> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "INSERT OR IGNORE INTO ph_device_keys
                 (device_id, key_alg, public_key_b64, protected_private_key, created_at, rotated_at)
                 VALUES (?1, 'Ed25519', ?2, ?3, ?4, NULL)",
                params![device_id, public_key_b64, protected_private_key, created_at],
            )
            .map_err(|e| HubError::Storage(format!("insert device key failed: {}", e)))?;
        Ok(changed == 1)
    }

    pub fn load_device_key(&self) -> HubResult<Option<StoredDeviceKey>> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT device_id, key_alg, public_key_b64, protected_private_key, created_at
             FROM ph_device_keys ORDER BY created_at LIMIT 1",
            [],
            |row| {
                Ok(StoredDeviceKey {
                    device_id: row.get(0)?,
                    key_alg: row.get(1)?,
                    public_key_b64: row.get(2)?,
                    protected_private_key: row.get(3)?,
                    created_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|e| HubError::Storage(format!("load device key failed: {}", e)))
    }

    // ---- 已配对设备 ----

    /// 插入或更新设备元数据。**不复活已撤销设备**：调用方必须先检查撤销状态。
    pub fn upsert_device(&self, device: &StoredDevice) -> HubResult<()> {
        let capabilities = serde_json::to_string(&device.capabilities)
            .map_err(|e| HubError::Storage(format!("encode capabilities failed: {}", e)))?;
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO ph_devices
             (device_id, device_type, display_name, identity_public_key, identity_fingerprint,
              capabilities, paired_at, last_seen_at, revoked_at, revoke_reason)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(device_id) DO UPDATE SET
                display_name = excluded.display_name,
                last_seen_at = excluded.last_seen_at",
            params![
                device.device_id,
                device.device_type,
                device.display_name,
                device.identity_public_key,
                device.identity_fingerprint,
                capabilities,
                device.paired_at,
                device.last_seen_at,
                device.revoked_at,
                device.revoke_reason,
            ],
        )
        .map_err(|e| HubError::Storage(format!("upsert device failed: {}", e)))?;
        Ok(())
    }

    pub fn get_device(&self, device_id: &str) -> HubResult<Option<StoredDevice>> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT device_id, device_type, display_name, identity_public_key,
                    identity_fingerprint, capabilities, paired_at, last_seen_at,
                    revoked_at, revoke_reason
             FROM ph_devices WHERE device_id = ?1",
            params![device_id],
            row_to_device,
        )
        .optional()
        .map_err(|e| HubError::Storage(format!("get device failed: {}", e)))
    }

    /// 列出已配对设备（默认排除已撤销设备）。
    pub fn list_devices(&self, include_revoked: bool) -> HubResult<Vec<StoredDevice>> {
        let conn = self.conn.lock();
        let sql = if include_revoked {
            "SELECT device_id, device_type, display_name, identity_public_key,
                    identity_fingerprint, capabilities, paired_at, last_seen_at,
                    revoked_at, revoke_reason
             FROM ph_devices ORDER BY paired_at"
        } else {
            "SELECT device_id, device_type, display_name, identity_public_key,
                    identity_fingerprint, capabilities, paired_at, last_seen_at,
                    revoked_at, revoke_reason
             FROM ph_devices WHERE revoked_at IS NULL ORDER BY paired_at"
        };
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| HubError::Storage(format!("prepare list devices failed: {}", e)))?;
        let rows = stmt
            .query_map([], row_to_device)
            .map_err(|e| HubError::Storage(format!("list devices failed: {}", e)))?;
        let mut devices = Vec::new();
        for row in rows {
            devices.push(
                row.map_err(|e| HubError::Storage(format!("decode device failed: {}", e)))?,
            );
        }
        Ok(devices)
    }

    /// 置 `revoked_at`；返回是否发生了状态转换（已是撤销状态返回 false）。
    pub fn mark_device_revoked(
        &self,
        device_id: &str,
        revoked_at: &str,
        reason: &str,
    ) -> HubResult<bool> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE ph_devices
                 SET revoked_at = ?2, revoke_reason = ?3
                 WHERE device_id = ?1 AND revoked_at IS NULL",
                params![device_id, revoked_at, reason],
            )
            .map_err(|e| HubError::Storage(format!("revoke device failed: {}", e)))?;
        Ok(changed == 1)
    }

    // ---- 配对邀请 ----

    pub fn insert_invitation(&self, invitation: &StoredInvitation) -> HubResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO ph_pairing_invitations
             (invitation_id, issuer_device_id, invitation_secret_hash, nonce,
              created_at, expires_at, consumed_at, failed_attempts, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                invitation.invitation_id,
                invitation.issuer_device_id,
                invitation.invitation_secret_hash,
                invitation.nonce,
                invitation.created_at,
                invitation.expires_at,
                invitation.consumed_at,
                invitation.failed_attempts,
                invitation.status,
            ],
        )
        .map_err(|e| HubError::Storage(format!("insert invitation failed: {}", e)))?;
        Ok(())
    }

    pub fn get_invitation(&self, invitation_id: &str) -> HubResult<Option<StoredInvitation>> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT invitation_id, issuer_device_id, invitation_secret_hash, nonce,
                    created_at, expires_at, consumed_at, failed_attempts, status
             FROM ph_pairing_invitations WHERE invitation_id = ?1",
            params![invitation_id],
            |row| {
                Ok(StoredInvitation {
                    invitation_id: row.get(0)?,
                    issuer_device_id: row.get(1)?,
                    invitation_secret_hash: row.get(2)?,
                    nonce: row.get(3)?,
                    created_at: row.get(4)?,
                    expires_at: row.get(5)?,
                    consumed_at: row.get(6)?,
                    failed_attempts: row.get(7)?,
                    status: row.get(8)?,
                })
            },
        )
        .optional()
        .map_err(|e| HubError::Storage(format!("get invitation failed: {}", e)))
    }

    /// 只允许 `pending` 迁移到终态；已终态返回 false（防止重复消费/复活）。
    pub fn transition_invitation(
        &self,
        invitation_id: &str,
        to_status: &str,
        consumed_at: Option<&str>,
    ) -> HubResult<bool> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE ph_pairing_invitations
                 SET status = ?2, consumed_at = COALESCE(?3, consumed_at)
                 WHERE invitation_id = ?1 AND status = 'pending'",
                params![invitation_id, to_status, consumed_at],
            )
            .map_err(|e| HubError::Storage(format!("transition invitation failed: {}", e)))?;
        Ok(changed == 1)
    }

    // ---- 审计 ----

    #[allow(clippy::too_many_arguments)]
    pub fn append_audit(
        &self,
        event_type: &str,
        device_id: Option<&str>,
        request_id: Option<&str>,
        fingerprint: Option<&str>,
        result: &str,
        detail: Option<&str>,
        created_at: &str,
    ) -> HubResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO ph_audit_log
             (event_type, device_id, request_id, fingerprint, result, detail, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                event_type,
                device_id,
                request_id,
                fingerprint,
                result,
                detail,
                created_at
            ],
        )
        .map_err(|e| HubError::Storage(format!("append audit failed: {}", e)))?;
        Ok(())
    }

    #[cfg(test)]
    pub fn audit_count(&self, event_type: &str) -> HubResult<i64> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT COUNT(*) FROM ph_audit_log WHERE event_type = ?1",
            params![event_type],
            |row| row.get(0),
        )
        .map_err(|e| HubError::Storage(format!("count audit failed: {}", e)))
    }
}

fn row_to_device(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredDevice> {
    let capabilities: String = row.get(5)?;
    Ok(StoredDevice {
        device_id: row.get(0)?,
        device_type: row.get(1)?,
        display_name: row.get(2)?,
        identity_public_key: row.get(3)?,
        identity_fingerprint: row.get(4)?,
        capabilities: serde_json::from_str(&capabilities).unwrap_or_default(),
        paired_at: row.get(6)?,
        last_seen_at: row.get(7)?,
        revoked_at: row.get(8)?,
        revoke_reason: row.get(9)?,
    })
}

/// `%LOCALAPPDATA%\TaskDock\personal-hub`；`TASKDOCK_PH_DATA_DIR` 可覆盖。
pub fn default_data_dir() -> HubResult<PathBuf> {
    if let Some(dir) = std::env::var_os("TASKDOCK_PH_DATA_DIR") {
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    let local = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| HubError::Storage("LOCALAPPDATA is not available".into()))?;
    Ok(PathBuf::from(local)
        .join("TaskDock")
        .join("personal-hub"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(tag: &str) -> (Arc<HubStore>, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "taskdock-ph-store-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join("hub.db");
        let store = HubStore::open(&path).expect("open temp hub.db");
        (store, dir)
    }

    #[test]
    fn migrations_are_idempotent_and_versioned() {
        let (store, dir) = temp_db("migrate");
        let path = store.path().to_path_buf();
        drop(store);
        let reopened = HubStore::open(&path).expect("reopen hub.db");
        assert_eq!(reopened.path(), path.as_path());
        drop(reopened);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn audit_is_append_only_and_queryable() {
        let (store, dir) = temp_db("audit");
        store
            .append_audit(
                "PAIRING_APPROVED",
                Some("device-1"),
                Some("request-1"),
                Some("0123456789abcdef0123456789abcdef"),
                "approved",
                None,
                "2026-11-19T00:00:00.000Z",
            )
            .unwrap();
        assert_eq!(store.audit_count("PAIRING_APPROVED").unwrap(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn invitation_transition_is_one_way() {
        let (store, dir) = temp_db("invitation");
        store
            .insert_invitation(&StoredInvitation {
                invitation_id: "i1".into(),
                issuer_device_id: "d1".into(),
                invitation_secret_hash: "h".into(),
                nonce: "n".into(),
                created_at: "2026-11-19T00:00:00.000Z".into(),
                expires_at: "2026-11-19T00:05:00.000Z".into(),
                consumed_at: None,
                failed_attempts: 0,
                status: INVITATION_PENDING.into(),
            })
            .unwrap();
        assert!(store
            .transition_invitation("i1", INVITATION_REVOKED, None)
            .unwrap());
        assert!(!store
            .transition_invitation("i1", INVITATION_CONSUMED, Some("now"))
            .unwrap());
        assert_eq!(
            store.get_invitation("i1").unwrap().unwrap().status,
            INVITATION_REVOKED
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
