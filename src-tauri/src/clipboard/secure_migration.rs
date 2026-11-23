//! 剪贴板历史明文 → 密文迁移（Phase 3 核心，供命令层与测试复用）。
//!
//! 设计约束（`docs/clipboard/security-governance/05-migration-plan.md`）：
//! - 只处理**未加密**的 `text`/`html`；已带 `tdcl1:` 前缀的行跳过，重复执行幂等；
//! - 每批一个事务，批内“加密 → 解密往返 → 比对原文”，不一致立即回滚该批并返回错误；
//! - 中断续跑：混合状态可读（双读兼容），重跑只补齐剩余明文行；
//! - 完成或失败后都执行 `wal_checkpoint(TRUNCATE)`，减少旧明文页滞留 WAL；
//! - 不覆盖原始备份：本函数不删除任何备份或旧文件，备份/观察期由调用方负责；
//! - 不触碰 `preview`/`title`/关联表：本批只加密正文字段（见 ADR 实施分批说明）。

use rusqlite::params;

use crate::db::{Db, Settings};
use crate::error::{AppError, AppResult};

use super::secure;

/// 每批行数：与备份分块口径接近，控制单事务时长与内存占用。
const BATCH_ROWS: i64 = 200;

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

fn pending_where() -> &'static str {
    "(text <> '' AND substr(text, 1, 6) <> 'tdcl1:')
     OR (html <> '' AND substr(html, 1, 6) <> 'tdcl1:')"
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
        let batch: Vec<(String, String, String)> = db.with_conn(|conn| {
            let mut stmt = conn.prepare(&format!(
                "SELECT id, text, html FROM clipboard_items
                 WHERE {} ORDER BY rowid LIMIT ?1",
                pending_where()
            ))?;
            let rows = stmt.query_map(params![BATCH_ROWS], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
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
            for (id, text, html) in &batch {
                let stored_text = if text.is_empty() {
                    String::new()
                } else {
                    secure::encrypt_field(&key, &secure::item_field_aad(id, "text"), text)?
                };
                let stored_html = if html.is_empty() {
                    String::new()
                } else {
                    secure::encrypt_field(&key, &secure::item_field_aad(id, "html"), html)?
                };
                // 批内往返校验：写入前先证明密钥/AAD 能解回原文，避免把不可解内容写入。
                if !text.is_empty() {
                    let back = secure::decrypt_field(
                        &key,
                        &secure::item_field_aad(id, "text"),
                        &stored_text,
                    )?;
                    if &back != text {
                        return Err(AppError::Validation(
                            "剪贴板迁移往返校验失败（正文不一致）".into(),
                        ));
                    }
                }
                if !html.is_empty() {
                    let back = secure::decrypt_field(
                        &key,
                        &secure::item_field_aad(id, "html"),
                        &stored_html,
                    )?;
                    if &back != html {
                        return Err(AppError::Validation(
                            "剪贴板迁移往返校验失败（HTML 不一致）".into(),
                        ));
                    }
                }
                tx.execute(
                    "UPDATE clipboard_items SET text = ?1, html = ?2 WHERE id = ?3",
                    params![stored_text, stored_html, id],
                )?;
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

    static MIG_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
        let _guard = MIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        secure::reset_cache();
        let tmp = TempRoot::new();
        let db = Db::open(&tmp.0.join("app.db")).unwrap();
        let err = encrypt_existing_history(&db).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[cfg(windows)]
    #[test]
    fn migrates_plaintext_rows_and_is_idempotent() {
        let _guard = MIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
        assert_eq!(report.pending_before, 3);
        assert_eq!(report.encrypted_items, 3);
        assert_eq!(report.verified_items, 3);
        assert_eq!(report.leftovers, 0);
        assert!(report.wal_checkpointed);

        for id in &ids {
            assert!(raw_text(&db, id).starts_with("tdcl1:"));
            let item = store::get_item(&db, id).unwrap();
            assert!(item.text.starts_with(sentinel), "读路径必须解密");
        }
        // 图片条目没有正文，不应被误改。
        assert_eq!(raw_text(&db, &img), "");

        // 幂等：再次执行不再加密任何行。
        let again = encrypt_existing_history(&db).unwrap();
        assert_eq!(again.pending_before, 0);
        assert_eq!(again.encrypted_items, 0);
    }

    #[cfg(windows)]
    #[test]
    fn plaintext_scan_and_wal_contain_no_sentinel_after_migration() {
        let _guard = MIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

        // 数据库层面：正文不再命中哨兵（preview 本批仍为明文，单独断言不被扫成正文列）。
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
