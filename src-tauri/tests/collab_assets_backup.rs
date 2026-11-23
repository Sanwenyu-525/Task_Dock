//! 可视化资产备份/恢复集成测试（独立文件）。
//!
//! 覆盖：单/多图、SHA-256 去重、缺失文件、损坏备份、路径逃逸、恢复
//! 到不同数据目录、恢复中途失败、Quick/Full 语义，以及恢复后 `AssetImage`
//! 走 `collab_asset_read` 仍能读到真实字节。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, Once};

use rusqlite::Connection;

use task_dock_lib::collab::actor::Actor;
use task_dock_lib::collab::model::*;
use task_dock_lib::collab::service::Core;
use task_dock_lib::commands::backup::{self, BackupKind, BackupSources};
use task_dock_lib::commands::restore::{restore_bundle, RestoreOptions};
use task_dock_lib::db::Db;
use task_dock_lib::error::AppError;

const PROJECT: &str = "proj-collab-assets";

static ENV_LOCK: Mutex<()> = Mutex::new(());
static ENV_INIT: Once = Once::new();

/// 环境变量是进程级的：本文件所有用例串行执行，避免互相改写数据目录。
fn lock_env() -> MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "taskdock-collab-assets-{}-{}-{}",
        tag,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("临时目录");
    dir
}

fn use_data_dir(dir: &Path) {
    ENV_INIT.call_once(|| {});
    std::env::set_var("TASK_DOCK_DATA_DIR", dir);
}

fn setup_db() -> Db {
    let db = Db::open_in_memory().expect("内存库");
    db.with_transaction(|conn: &Connection| {
        conn.execute(
            "INSERT INTO planning_projects (id, name, description, status, created_at, updated_at)
             VALUES (?1, '资产备份测试', '测试', 'planning', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![PROJECT],
        )?;
        Ok(())
    })
    .expect("项目");
    db
}

fn write_png(path: &Path, seed: u8) {
    // 内容不需要是真实 PNG：导入只校验扩展名与大小，读取按字节原样返回。
    let mut bytes = vec![0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.extend(std::iter::repeat(seed).take(64));
    std::fs::write(path, bytes).expect("写测试图片");
}

fn import(db: &Db, path: &Path) -> VisualAsset {
    db.with_transaction(|conn| {
        Core::new(conn).import_visual_asset(
            &Actor::ui(),
            PROJECT,
            &VisualAssetInput {
                path: path.to_string_lossy().to_string(),
                title: "截图".to_string(),
                document_id: None,
            },
        )
    })
    .expect("导入资产")
}

fn sources(data_dir: &Path) -> BackupSources<'_> {
    BackupSources {
        archive_dir: None,
        clipboard_dir: None,
        shelf_dir: None,
        data_dir: Some(data_dir),
    }
}

fn write_backup(db: &Db, data_dir: &Path, kind: BackupKind, name: &str) -> PathBuf {
    let target = data_dir.join("backups").join(name);
    backup::write_bundle(db, sources(data_dir), &target, kind).expect("写备份");
    target
}

fn asset_rows(db: &Db) -> Vec<(String, String, String)> {
    db.with_conn(|conn| {
        let mut stmt =
            conn.prepare("SELECT id, path, sha256 FROM collab_visual_assets ORDER BY id")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .expect("资产行")
}

#[test]
fn collab_assets_survive_full_and_quick_backup_restore() {
    let _guard = lock_env();
    let source_dir = temp_dir("source");
    use_data_dir(&source_dir);
    let db = setup_db();

    let src_a = source_dir.join("a.png");
    let src_b = source_dir.join("b.png");
    write_png(&src_a, 1);
    write_png(&src_b, 2);
    let first = import(&db, &src_a);
    let second = import(&db, &src_b);
    assert_ne!(first.id, second.id);

    // 同内容再次导入（不同文件名）必须命中去重，不新增行也不重复打包。
    let dup = source_dir.join("a-copy.png");
    std::fs::copy(&src_a, &dup).expect("复制");
    let again = import(&db, &dup);
    assert_eq!(again.id, first.id, "同 SHA-256 必须复用同一资产行");
    assert_eq!(asset_rows(&db).len(), 2);

    for (kind, name) in [
        (BackupKind::Full, "full.tdb"),
        (BackupKind::Quick, "quick.tdb"),
    ] {
        let bundle = write_backup(&db, &source_dir, kind, name);
        let staging = temp_dir(&format!("staging-{name}"));
        let read = backup::read_bundle(&bundle, &staging).expect("读取备份");
        let collab: Vec<_> = read
            .assets
            .iter()
            .filter(|a| a.rel.starts_with("collab/"))
            .collect();
        assert_eq!(
            collab.len(),
            2,
            "{:?} 备份必须打包全部协作资产（实际 {:?}）",
            kind,
            read.assets.iter().map(|a| a.rel.clone()).collect::<Vec<_>>()
        );
        for asset in &collab {
            assert_eq!(asset.sha256.len(), 64, "必须记录 SHA-256");
            assert!(
                Path::new(&asset.rel).components().count() == 3,
                "相对路径应为 collab/<project>/<file>：{}",
                asset.rel
            );
        }
        assert!(read.assets.iter().all(|a| !a.path.as_os_str().is_empty()));
    }

    // 恢复到一个全新的数据目录：文件与数据库路径都要指向新目录。
    let bundle = write_backup(&db, &source_dir, BackupKind::Full, "restore.tdb");
    let target_dir = temp_dir("target");
    let restored = Db::open_in_memory().expect("恢复库");
    let outcome = restore_bundle(
        &target_dir,
        &restored,
        &bundle,
        &RestoreOptions {
            allow_partial: true,
            ..Default::default()
        },
    )
    .expect("恢复备份");
    assert!(outcome.assets >= 2, "应恢复至少 2 个资产文件");

    let rows = asset_rows(&restored);
    assert_eq!(rows.len(), 2);
    for (id, path, sha) in &rows {
        assert!(
            path.starts_with(&target_dir.join("collab-assets").to_string_lossy().to_string()),
            "路径必须映射到当前设备数据目录：{path}"
        );
        assert!(Path::new(path).is_file(), "数据库路径必须指向真实文件：{path}");
        let bytes = std::fs::read(path).expect("读取恢复文件");
        assert_eq!(
            task_dock_lib::collab::util::sha256_bytes(&bytes),
            *sha,
            "资产 {id} 的 SHA-256 必须一致"
        );
    }

    // 切到新目录后，AssetImage 依赖的受控读取必须能拿到原图字节。
    use_data_dir(&target_dir);
    let content = restored
        .with_conn(|conn| Core::new(conn).read_visual_asset(&Actor::ui(), &first.id))
        .expect("读取资产");
    assert_eq!(content.mime, "image/png");
    let decoded = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(content.base64)
            .expect("base64")
    };
    assert_eq!(decoded, std::fs::read(&src_a).expect("原图"));

    // 切回源目录，避免影响同文件内后续断言。
    use_data_dir(&source_dir);
}

#[test]
fn backup_fails_when_collab_asset_file_is_missing() {
    let _guard = lock_env();
    let source_dir = temp_dir("missing");
    use_data_dir(&source_dir);
    let db = setup_db();
    let src = source_dir.join("a.png");
    write_png(&src, 3);
    let asset = import(&db, &src);
    std::fs::remove_file(&asset.path).expect("删除资产文件");

    let target = source_dir.join("backups").join("missing.tdb");
    let err = backup::write_bundle(
        &db,
        sources(&source_dir),
        &target,
        BackupKind::Full,
    )
    .expect_err("缺失资产必须阻断备份");
    assert!(
        err.to_string().contains("协作资产文件缺失"),
        "错误信息必须明确指出缺失资产：{err}"
    );
    assert!(!target.exists(), "失败的备份不得留下产物");

    use_data_dir(&source_dir);
}

#[test]
fn tampered_bundle_is_rejected_before_touching_files() {
    let _guard = lock_env();
    let source_dir = temp_dir("tamper");
    use_data_dir(&source_dir);
    let db = setup_db();
    let src = source_dir.join("a.png");
    write_png(&src, 4);
    import(&db, &src);
    let bundle = write_backup(&db, &source_dir, BackupKind::Full, "tamper.tdb");

    // 把资产记录路径改成逃逸路径：读取端必须在落盘前拒绝。
    let raw = std::fs::read_to_string(&bundle).expect("读取备份文本");
    let tampered = raw.replacen("collab/", "collab/../../", 1);
    assert_ne!(raw, tampered, "测试需要真正改到资产记录");
    let evil = source_dir.join("backups").join("evil.tdb");
    std::fs::write(&evil, tampered).expect("写篡改备份");

    let staging = temp_dir("tamper-staging");
    let err = backup::read_bundle(&evil, &staging).expect_err("篡改备份必须拒绝");
    assert!(
        matches!(err, AppError::Validation(_)),
        "应以校验错误拒绝：{err}"
    );

    // 损坏内容同样必须拒绝（不能解出部分资产就当成功）。
    let raw = std::fs::read_to_string(&bundle).expect("读取备份文本");
    let broken = raw.replacen("\"data\":\"", "\"data\":\"AAAA", 1);
    let broken_path = source_dir.join("backups").join("broken.tdb");
    std::fs::write(&broken_path, broken).expect("写损坏备份");
    let err = backup::read_bundle(&broken_path, &staging).expect_err("损坏备份必须拒绝");
    assert!(matches!(err, AppError::Validation(_)), "实际：{err}");

    use_data_dir(&source_dir);
}

#[test]
fn restore_failure_rolls_back_collab_asset_files() {
    let _guard = lock_env();
    let source_dir = temp_dir("rollback-src");
    use_data_dir(&source_dir);
    let db = setup_db();
    let src = source_dir.join("a.png");
    write_png(&src, 5);
    let asset = import(&db, &src);
    let file_name = Path::new(&asset.path)
        .file_name()
        .expect("文件名")
        .to_string_lossy()
        .to_string();
    let bundle = write_backup(&db, &source_dir, BackupKind::Full, "rollback.tdb");

    let target_dir = temp_dir("rollback-target");
    let restored = Db::open_in_memory().expect("恢复库");
    let err = restore_bundle(
        &target_dir,
        &restored,
        &bundle,
        &RestoreOptions {
            allow_partial: true,
            faults: task_dock_lib::commands::restore::RestoreFaults {
                fail_asset_at: Some(0),
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .expect_err("第 0 个资产提交失败必须整体回滚");
    assert!(err.to_string().contains("已自动回滚"), "实际：{err}");

    let project_dir = target_dir.join("collab-assets").join(PROJECT);
    assert!(
        !project_dir.join(&file_name).exists(),
        "回滚后不得留下未完成的资产文件"
    );
    let rows = asset_rows(&restored);
    assert!(rows.is_empty(), "回滚后恢复库不得保留资产行");

    use_data_dir(&source_dir);
}
