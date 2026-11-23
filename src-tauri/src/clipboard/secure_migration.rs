//! 剪贴板历史明文 → 密文迁移（Phase 3 核心，供命令层与测试复用）。
//!
//! 设计约束（`docs/clipboard/security-governance/05-migration-plan.md`）：
//! - 只处理**未加密**的 `text`/`html`/`preview`/`title`/`source_*`/`file_paths`；
//!   已带 `tdcl1:` 前缀的字段跳过，重复执行幂等；
//! - 每批一个事务，批内“加密 → 解密往返 → 比对原文”，不一致立即回滚该批并返回错误；
//! - 中断续跑：混合状态可读（双读兼容），重跑只补齐剩余明文行；
//! - 完成或失败后都执行 `wal_checkpoint(TRUNCATE)`，减少旧明文页滞留 WAL；
//! - 不覆盖原始备份：本函数不删除任何备份或旧文件，备份/观察期由调用方负责；
//! - 不触碰关联表/缓存：本批只加密条目自身可检索元数据（见 ADR 实施分批说明）。

use rusqlite::{params, params_from_iter, types::Value};

use crate::db::{Db, Settings};
use crate::error::{AppError, AppResult};

use super::secure;

/// 每批行数：与备份分块口径接近，控制单事务时长与内存占用。
const BATCH_ROWS: i64 = 200;
/// 随正文一起迁移的条目字段；`preview/title/source_*/file_paths` 与正文共用 AAD 前缀。
const MIGRATED_FIELDS: [&str; 7] = [
    "text",
    "html",
    "preview",
    "title",
    "source_app",
    "source_title",
    "file_paths",
];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationReport {
    /// 迁移前待加密行数（text 或 html 为明文且非空）。
    pub pending_before: i64,
    /// 本次实际加密的行数。
    pub encrypted_items: i64,
    /// 批内往返校验通过的行数。
    pub verified_items: i64,
    /// 结束后仍残留的明文行数（应为 0）。
    pub leftovers: i64,
    /// WAL checkpoint 是否执行成功（失败不回滚已完成的数据加密）。
    pub wal_checkpointed: bool,
}

/// 迁移前安全备份的可核对信息（路径与哈希，不含正文）。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationBackup {
    pub dir: String,
    pub db_sha256: String,
    pub db_bytes: i64,
    pub items: i64,
    pub assets: i64,
    pub created_at: String,
}

/// 带备份保护的迁移结果。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationOutcome {
    pub report: MigrationSummary,
    pub backup: MigrationBackup,
    /// 本次加密的历史图片资产数（原图 + 缩略图）。
    pub assets_encrypted: i64,
    /// 已是密文或缺失而跳过的资产数。
    pub assets_skipped: i64,
    /// 清理掉的 640 预览派生缓存数量（迁移后按需重建为密文）。
    pub preview_cache_purged: i64,
}

/// 可序列化的迁移计数（避免把内部结构直接暴露给前端）。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationSummary {
    pub pendingBefore: i64,
    pub encryptedItems: i64,
    pub verifiedItems: i64,
    pub leftovers: i64,
    pub walCheckpointed: bool,
}

impl MigrationSummary {
    fn from_report(r: &MigrationReport) -> Self {
        Self {
            pendingBefore: r.pending_before,
            encryptedItems: r.encrypted_items,
            verifiedItems: r.verified_items,
            leftovers: r.leftovers,
            walCheckpointed: r.wal_checkpointed,
        }
    }
}

fn pending_where() -> &'static str {
    "(text <> '' AND substr(text, 1, 6) <> 'tdcl1:')
     OR (html <> '' AND substr(html, 1, 6) <> 'tdcl1:')
     OR (preview <> '' AND substr(preview, 1, 6) <> 'tdcl1:')
     OR (title <> '' AND substr(title, 1, 6) <> 'tdcl1:')
     OR (source_app <> '' AND substr(source_app, 1, 6) <> 'tdcl1:')
     OR (source_title <> '' AND substr(source_title, 1, 6) <> 'tdcl1:')
     OR (file_paths <> '' AND substr(file_paths, 1, 6) <> 'tdcl1:')"
}

fn count_pending(db: &Db) -> AppResult<i64> {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            &format!("SELECT COUNT(*) FROM clipboard_items WHERE {}", pending_where()),
            [],
            |r| r.get(0),
        )?)
    })
}

/// 把已有明文历史加密为当前 CEK 密文。
///
/// 前置：`clipboard_encrypt_history` 已开启（否则报错，不做任何写入）。
/// 未配置信封时由 `secure::cek` 创建（调用方应已保证备份可用）。
pub fn encrypt_existing_history(db: &Db) -> AppResult<MigrationReport> {
    let settings = Settings::load(db)?;
    if !settings.clipboard_encrypt_history {
        return Err(AppError::Validation(
            "未开启剪贴板历史加密，拒绝迁移".into(),
        ));
    }
    let key = secure::cek(db)?;
    let pending_before = count_pending(db)?;
    let mut report = MigrationReport {
        pending_before,
        ..Default::default()
    };

    loop {
        // 每轮只取当前仍为明文的行：批内更新后自然减少，重跑也只会补齐剩余。
        let batch: Vec<Vec<String>> = db.with_conn(|conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT id, text, html, preview, title, source_app, source_title, file_paths
                 FROM clipboard_items WHERE {} ORDER BY rowid LIMIT ?1",
                pending_where()
            ))?;
            let rows = stmt.query_map(params![BATCH_ROWS], |r| {
                let mut out = Vec::with_capacity(8);
                for idx in 0..8 {
                    out.push(r.get::<_, String>(idx)?);
                }
                Ok(out)
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })?;
        if batch.is_empty() {
            break;
        }

        let tx_result = db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let mut verified = 0i64;
            for row in &batch {
                let id = &row[0];
                let mut values: Vec<Value> = Vec::with_capacity(MIGRATED_FIELDS.len());
                for (idx, field) in MIGRATED_FIELDS.iter().enumerate() {
                    let plain = &row[idx + 1];
                    // 部分升级时同一行可能已有早期批次加密的字段；必须原样保留，
                    // 否则会把 `tdcl1:` 密文再套一层，读路径只能解出密文。
                    if plain.is_empty() || secure::is_encrypted_field(plain) {
                        values.push(Value::Text(plain.clone()));
                        continue;
                    }
                    let aad = secure::item_field_aad(id, field);
                    let stored = secure::encrypt_field(&key, &aad, plain)?;
                    // 批内往返校验：写入前先证明密钥/AAD 能解回原文，避免把不可解内容写入。
                    let back = secure::decrypt_field(&key, &aad, &stored)?;
                    if &back != plain {
                        return Err(AppError::Validation(format!(
                            "剪贴板迁移往返校验失败（{field} 不一致）"
                        )));
                    }
                    values.push(Value::Text(stored));
                }
                let assignments: Vec<String> = MIGRATED_FIELDS
                    .iter()
                    .enumerate()
                    .map(|(i, field)| format!("{field} = ?{}", i + 1))
                    .collect();
                let sql = format!(
                    "UPDATE clipboard_items SET {} WHERE id = ?{}",
                    assignments.join(", "),
                    MIGRATED_FIELDS.len() + 1
                );
                values.push(Value::Text(id.clone()));
                tx.execute(&sql, params_from_iter(values))?;
                verified += 1;
            }
            tx.commit()?;
            Ok(verified)
        });

        match tx_result {
            Ok(verified) => {
                report.encrypted_items += batch.len() as i64;
                report.verified_items += verified;
            }
            // 整批回滚，已提交批次保留（可续跑）；错误原样上抛，由调用方决定回滚或重试。
            Err(e) => {
                report.leftovers = count_pending(db).unwrap_or(-1);
                let _ = wal_checkpoint(db);
                return Err(e);
            }
        }
    }

    report.leftovers = count_pending(db)?;
    report.wal_checkpointed = wal_checkpoint(db).is_ok();
    Ok(report)
}

/// 把 WAL 落回主库并截断，降低已删除/已改写明文页的滞留面。
///
/// 失败不视为迁移失败：数据已完成加密，WAL 仍会由 SQLite 正常 checkpoint 回收。
pub fn wal_checkpoint(db: &Db) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    })
}

// ── 带备份保护的整体迁移（批次 3）────────────────────────────

fn sha256_file(path: &std::path::Path) -> AppResult<(String, i64)> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut total = 0i64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        use sha2::Digest;
        hasher.update(&buf[..n]);
        total += n as i64;
    }
    use sha2::Digest;
    Ok((hex_encode(&hasher.finalize()), total))
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn count_conn(conn: &rusqlite::Connection, sql: &str) -> AppResult<i64> {
    Ok(conn.query_row(sql, [], |r| r.get(0))?)
}

fn copy_dir_files(from: &std::path::Path, to: &std::path::Path) -> AppResult<i64> {
    if !from.is_dir() {
        return Ok(0);
    }
    std::fs::create_dir_all(to)?;
    let mut copied = 0i64;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name,
            None => continue,
        };
        std::fs::copy(&path, to.join(name))?;
        copied += 1;
    }
    Ok(copied)
}

/// 迁移前安全备份：`VACUUM INTO` 一致性快照 + 资产目录拷贝 + 回读校验。
///
/// 回读校验不通过时**不返回备份**，调用方必须中止迁移；任何迁移前的写入都还没发生。
fn create_backup(db: &Db, root: &std::path::Path) -> AppResult<MigrationBackup> {
    let data_dir = root.parent().unwrap_or(root);
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let dir = data_dir
        .join("clipboard-migrate")
        .join(format!("backup-{stamp}"));
    std::fs::create_dir_all(&dir)?;

    let db_copy = dir.join("task-dock.db");
    // VACUUM INTO 生成一致性快照（WAL 内容一并落盘），不修改源库。
    let copy_path = db_copy.display().to_string();
    db.with_conn(|conn| {
        conn.execute("VACUUM INTO ?1", params![copy_path])?;
        Ok(())
    })?;

    let assets = copy_dir_files(&root.join("images"), &dir.join("images"))?
        + copy_dir_files(&root.join("thumbs"), &dir.join("thumbs"))?;

    let (db_sha256, db_bytes) = sha256_file(&db_copy)?;
    if db_bytes <= 0 || db_sha256.is_empty() {
        return Err(AppError::Validation("迁移备份快照为空，已中止".into()));
    }

    // 回读校验：只读打开备份库核对条目/资产计数，避免“备份文件存在但不可用”。
    let src = db.with_conn(|conn| {
        Ok((
            count_conn(conn, "SELECT COUNT(*) FROM clipboard_items")?,
            count_conn(conn, "SELECT COUNT(*) FROM clipboard_assets")?,
        ))
    })?;
    let conn = rusqlite::Connection::open_with_flags(
        &db_copy,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let items = count_conn(&conn, "SELECT COUNT(*) FROM clipboard_items")?;
    let assets_rows = count_conn(&conn, "SELECT COUNT(*) FROM clipboard_assets")?;
    drop(conn);
    if (items, assets_rows) != src {
        return Err(AppError::Validation(format!(
            "迁移备份校验失败（条目/资产计数不一致：备份 {items}/{assets_rows}，源 {}/{}）",
            src.0, src.1
        )));
    }

    Ok(MigrationBackup {
        dir: dir.display().to_string(),
        db_sha256,
        db_bytes,
        items,
        assets: assets_rows.max(assets),
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// 历史图片资产加密：已是密文的跳过；明文加密后**回读解密比对**才落盘。
fn encrypt_assets(db: &Db, root: &std::path::Path, key: &[u8; 32]) -> AppResult<(i64, i64)> {
    let rows: Vec<(String, String, String)> = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT item_id, role, path FROM clipboard_assets
             WHERE role IN ('image', 'thumb') ORDER BY rowid",
        )?;
        let mapped = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in mapped {
            out.push(row?);
        }
        Ok(out)
    })?;

    let mut encrypted = 0i64;
    let mut skipped = 0i64;
    for (item_id, role, rel) in rows {
        let abs = root.join(&rel);
        let stored = match std::fs::read(&abs) {
            Ok(bytes) => bytes,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        if secure::is_encrypted_blob(&stored) {
            skipped += 1;
            continue;
        }
        let aad = secure::item_asset_aad(&item_id, &role);
        let ciphertext = secure::encrypt_bytes(key, &aad, &stored)?;
        let back = secure::decrypt_bytes(key, &aad, &ciphertext)?;
        if back.as_slice() != stored.as_slice() {
            return Err(AppError::Validation(format!(
                "图片资产迁移往返校验失败（{rel}），该文件保持明文"
            )));
        }
        let tmp = abs.with_extension("png.tmp");
        std::fs::write(&tmp, &ciphertext)?;
        std::fs::rename(&tmp, &abs).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })?;
        encrypted += 1;
    }
    Ok((encrypted, skipped))
}

/// 清掉 640 预览派生缓存：迁移后按需重建，避免把明文派生图留在盘上。
fn purge_preview_caches(root: &std::path::Path) -> i64 {
    let dir = root.join("thumbs");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let mut purged = 0i64;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.contains("-preview-") && entry.path().is_file() {
            if std::fs::remove_file(entry.path()).is_ok() {
                purged += 1;
            }
        }
    }
    purged
}

/// 整体迁移入口（命令层与测试使用）：先做可核对备份，再加密正文与历史图片。
///
/// 顺序保证：备份未通过校验时不做任何加密；正文迁移失败时图片尚未加密；
/// 全流程幂等，可在任意中断点重跑。
pub fn encrypt_existing_history_with_backup(
    db: &Db,
    root: &std::path::Path,
) -> AppResult<MigrationOutcome> {
    let settings = Settings::load(db)?;
    if !settings.clipboard_encrypt_history {
        return Err(AppError::Validation(
            "未开启剪贴板历史加密，拒绝迁移".into(),
        ));
    }
    // 先 checkpoint 一次，让备份快照尽量包含已落盘的写入。
    let _ = wal_checkpoint(db);
    let backup = create_backup(db, root)?;
    let key = secure::cek(db)?;

    let report = encrypt_existing_history(db)?;
    let (assets_encrypted, assets_skipped) = encrypt_assets(db, root, &key)?;
    let preview_cache_purged = purge_preview_caches(root);
    super::store::purge_transient_assets(root);
    let _ = wal_checkpoint(db);

    Ok(MigrationOutcome {
        report: MigrationSummary::from_report(&report),
        backup,
        assets_encrypted,
        assets_skipped,
        preview_cache_purged,
    })
}

/// 明文哨兵扫描：返回命中的「表/列」清单（只报位置与计数，不回显正文）。
///
/// 覆盖正文、HTML、预览与标题；用于迁移后确认没有明文残留。
pub fn scan_plaintext_needles(db: &Db, needles: &[&str]) -> AppResult<Vec<(String, i64)>> {
    let mut hits = Vec::new();
    for (table, column) in [
        ("clipboard_items", "text"),
        ("clipboard_items", "html"),
        ("clipboard_items", "preview"),
        ("clipboard_items", "title"),
        ("clipboard_items", "source_app"),
        ("clipboard_items", "source_title"),
        ("clipboard_items", "file_paths"),
    ] {
        let mut count = 0i64;
        for needle in needles {
            if needle.is_empty() {
                continue;
            }
            let n: i64 = db.with_conn(|conn| {
                Ok(conn.query_row(
                    &format!(
                        "SELECT COUNT(*) FROM {table} WHERE instr({column}, ?1) > 0"
                    ),
                    params![needle],
                    |r| r.get(0),
                )?)
            })?;
            count += n;
        }
        if count > 0 {
            hits.push((format!("{table}.{column}"), count));
        }
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::clipboard::store::{self, ClipboardFilter};
    use crate::clipboard::{CapturedContent, CapturedImage};

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("td-clip-mig-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            secure::reset_cache();
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 迁移会清空/加载全局 CEK 缓存，必须与 store/secure 加密用例共用同一把测试锁。

    fn text(text: &str) -> CapturedContent {
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

    fn image() -> CapturedContent {
        let rgba = vec![9u8, 8, 7, 255].repeat(16);
        CapturedContent {
            kind: "image".into(),
            text: String::new(),
            html: String::new(),
            preview: String::new(),
            file_paths: vec![],
            image: Some(CapturedImage {
                png: crate::clipboard::image::encode_png(&rgba, 4, 4).unwrap(),
                width: 4,
                height: 4,
                rgba,
            }),
            source_app: "snippingtool.exe".into(),
            source_title: "截图".into(),
            source_kind: "owner".into(),
            byte_size: 0,
        }
    }

    fn raw_text(db: &Db, id: &str) -> String {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT text FROM clipboard_items WHERE id = ?1",
                params![id],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap()
    }

    fn raw_field(db: &Db, id: &str, field: &str) -> String {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                &format!("SELECT {field} FROM clipboard_items WHERE id = ?1"),
                params![id],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap()
    }

    fn enable(db: &Db, on: bool) {
        let mut s = Settings::default();
        s.clipboard_encrypt_history = on;
        db.set_setting(
            "clipboard_encrypt_history",
            serde_json::json!(s.clipboard_encrypt_history),
        )
        .unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn refuses_when_switch_is_off() {
        let _guard = secure::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        secure::reset_cache();
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        let err = encrypt_existing_history(&db).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[cfg(windows)]
    #[test]
    fn migrates_plaintext_rows_and_is_idempotent() {
        let _guard = secure::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        secure::reset_cache();
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        let root = tmp.0.join("clipboard");
        let mut s = Settings::default();
        s.clipboard_encrypt_history = false;
        let sentinel = "TDCLIP-MIG-SENTINEL-4b9e";
        let ids: Vec<String> = (0..3)
            .map(|i| {
                let p = text(&format!("{sentinel}-{i}"));
                store::record_capture(&db, &root, &p, &s).unwrap().item.id
            })
            .collect();
        let img = store::record_capture(&db, &root, &image(), &s).unwrap().item.id;
        assert!(raw_text(&db, &ids[0]).starts_with(sentinel), "迁移前必须是明文");

        enable(&db, true);
        let report = encrypt_existing_history(&db).unwrap();
        // 图片条目虽无正文，但 preview/title/source_* 也属迁移字段。
        assert_eq!(report.pending_before, 4);
        assert_eq!(report.encrypted_items, 4);
        assert_eq!(report.verified_items, 4);
        assert_eq!(report.leftovers, 0);
        assert!(report.wal_checkpointed);

        for id in &ids {
            assert!(raw_text(&db, id).starts_with("tdcl1:"));
            let item = store::get_item(&db, id).unwrap();
            assert!(item.text.starts_with(sentinel), "读路径必须解密");
        }
        // 图片条目没有正文，正文仍为空；但其来源元数据已随本批加密。
        assert_eq!(raw_text(&db, &img), "");
        let raw_source = raw_field(&db, &img, "source_app");
        assert!(raw_source.starts_with("tdcl1:"), "来源字段应加密");
        assert_eq!(
            store::get_item(&db, &img).unwrap().source_app,
            "snippingtool.exe",
            "来源字段读路径必须解密"
        );

        // 幂等：再次执行不再加密任何行。
        let again = encrypt_existing_history(&db).unwrap();
        assert_eq!(again.pending_before, 0);
        assert_eq!(again.encrypted_items, 0);
    }

    #[cfg(windows)]
    #[test]
    fn partial_upgrade_preserves_already_encrypted_fields() {
        let _guard = secure::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        secure::reset_cache();
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        let root = tmp.0.join("clipboard");
        let mut s = Settings::default();
        s.clipboard_encrypt_history = true;
        let sentinel = "TDCLIP-PARTIAL-SENTINEL-7c2a";
        let id = store::record_capture(&db, &root, &text(sentinel), &s)
            .unwrap()
            .item
            .id;
        let encrypted_text = raw_text(&db, &id);
        assert!(encrypted_text.starts_with("tdcl1:"));
        enable(&db, true);

        // 模拟早期批次只加密正文、元数据仍为明文的半迁移状态。
        db.with_conn(|c| {
            c.execute(
                "UPDATE clipboard_items SET preview='partial-preview', title='partial-title', \
                 source_app='partial-app', source_title='partial-window', file_paths='[\"C:/p.txt\"]' \
                 WHERE id=?1",
                rusqlite::params![id],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let report = encrypt_existing_history(&db).unwrap();
        assert_eq!(report.pending_before, 1);
        assert_eq!(report.leftovers, 0);
        assert_eq!(
            raw_text(&db, &id),
            encrypted_text,
            "已加密正文不得被再次套壳"
        );
        let item = store::get_item(&db, &id).unwrap();
        assert_eq!(item.text, sentinel);
        assert_eq!(item.preview, "partial-preview");
        assert_eq!(item.title, "partial-title");
        assert_eq!(item.source_app, "partial-app");
        assert_eq!(item.source_title, "partial-window");
        assert_eq!(item.file_paths, vec!["C:/p.txt".to_string()]);
    }

    #[cfg(windows)]
    #[test]
    fn backup_protected_migration_encrypts_text_and_images() {
        let _guard = secure::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        secure::reset_cache();
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        let root = tmp.0.join("clipboard");
        std::fs::create_dir_all(&root).unwrap();
        let mut s = Settings::default();
        s.clipboard_encrypt_history = false;
        let sentinel = "TDCLIP-BK-SENTINEL-2e7c";
        let text_id = store::record_capture(&db, &root, &text(sentinel), &s)
            .unwrap()
            .item
            .id;
        let img_id = store::record_capture(&db, &root, &image(), &s)
            .unwrap()
            .item
            .id;
        let img_rel = format!("images/{img_id}.png");
        let img_plain = std::fs::read(root.join(&img_rel)).unwrap();
        assert_eq!(&img_plain[..4], b"\x89PNG", "迁移前图片必须是明文 PNG");

        enable(&db, true);
        let outcome = encrypt_existing_history_with_backup(&db, &root).unwrap();
        assert_eq!(outcome.report.encryptedItems, 2);
        assert_eq!(outcome.report.leftovers, 0);
        assert_eq!(outcome.assets_encrypted, 2, "原图与缩略图都应加密");
        // 备份必须先存在且可核对：数据库快照 + 图片副本 + 哈希。
        let backup = std::path::PathBuf::from(&outcome.backup.dir);
        assert!(backup.join("task-dock.db").is_file(), "备份库必须存在");
        assert!(backup.join("images").is_dir(), "备份必须包含图片目录");
        assert!(!outcome.backup.db_sha256.is_empty());
        assert_eq!(outcome.backup.items, 2);
        assert!(outcome.backup.db_bytes > 0);

        // 正文与图片都已变密文，读取仍透明解密。
        assert!(raw_text(&db, &text_id).starts_with("tdcl1:"));
        let img_stored = std::fs::read(root.join(&img_rel)).unwrap();
        assert!(secure::is_encrypted_blob(&img_stored));
        assert_eq!(store::get_item(&db, &text_id).unwrap().text, sentinel);
        let png = store::image_png(&db, &root, &img_id).expect("图片应仍可读");
        assert_eq!(&png[..4], b"\x89PNG");

        // 幂等：重跑不再加密任何内容，已有密文被跳过。
        let again = encrypt_existing_history_with_backup(&db, &root).unwrap();
        assert_eq!(again.report.encryptedItems, 0);
        assert_eq!(again.report.pendingBefore, 0);
        assert_eq!(again.assets_encrypted, 0);
        assert!(again.assets_skipped >= 2);
    }

    #[cfg(windows)]
    #[test]
    fn migration_aborts_before_writes_when_backup_cannot_be_created() {
        let _guard = secure::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        secure::reset_cache();
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        let root = tmp.0.join("clipboard");
        std::fs::create_dir_all(&root).unwrap();
        let sentinel = "TDCLIP-ABORT-SENTINEL-55d1";
        let mut s = Settings::default();
        s.clipboard_encrypt_history = false;
        let id = store::record_capture(&db, &root, &text(sentinel), &s)
            .unwrap()
            .item
            .id;
        // 让备份目录无法创建（同名文件占位）：迁移必须在任何加密写入前中止。
        std::fs::write(tmp.0.join("clipboard-migrate"), b"not-a-dir").unwrap();
        enable(&db, true);
        let err = encrypt_existing_history_with_backup(&db, &root).unwrap_err();
        assert!(!err.to_string().is_empty());
        assert_eq!(raw_text(&db, &id), sentinel, "备份失败时不得写入任何密文");
    }

    #[cfg(windows)]
    #[test]
    fn plaintext_scan_and_wal_contain_no_sentinel_after_migration() {
        let _guard = secure::TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        secure::reset_cache();
        let tmp = TempRoot::new();
        let db_path = tmp.0.join("app.db");
        let root = tmp.0.join("clipboard");
        let sentinel = "TDCLIP-WAL-SENTINEL-91af";
        let mut s = Settings::default();
        s.clipboard_encrypt_history = false;
        let id = {
            let db = Db::open(&db_path).unwrap();
            let out = store::record_capture(&db, &root, &text(sentinel), &s).unwrap();
            out.item.id
        };
        let db = Db::open(&db_path).unwrap();
        enable(&db, true);
        let report = encrypt_existing_history(&db).unwrap();
        assert!(report.wal_checkpointed);

        // 数据库层面：正文不再命中哨兵（同一哨兵也出现在 preview/title 等已加密列）。
        let hits = scan_plaintext_needles(&db, &[sentinel]).unwrap();
        assert!(
            !hits.iter().any(|(col, _)| col == "clipboard_items.text"),
            "正文列不得残留明文: {hits:?}"
        );
        // WAL：checkpoint(TRUNCATE) 后文件应已截断，不得含哨兵原文。
        let wal = PathBuf::from(format!("{}-wal", db_path.display()));
        if let Ok(bytes) = std::fs::read(&wal) {
            assert!(
                !bytes.windows(sentinel.len()).any(|w| w == sentinel.as_bytes()),
                "WAL 截断后不得残留明文哨兵"
            );
        }
        // 读取仍然正确。
        assert_eq!(store::get_item(&db, &id).unwrap().text, sentinel);
        // 搜索面（preview）仍可命中，说明加密没有把列表/搜索一起打断。
        let page = store::list_items(
            &db,
            &ClipboardFilter {
                search: Some("TDCLIP-WAL".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(page.iter().any(|i| i.id == id));
    }
}
