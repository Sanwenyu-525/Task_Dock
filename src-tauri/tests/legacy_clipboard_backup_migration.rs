// 旧格式（未密封）剪贴板备份导入加密目标时的一次性迁移验收。

use std::path::Path;

use task_dock_lib::commands::backup::{
    bundle_meta, normalize_clipboard_for_restore, read_bundle, write_bundle, BackupKind,
    BackupSources,
};
use task_dock_lib::db::Db;
use task_dock_lib::error::AppError;

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "td-legacy-clipboard-{tag}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn seed(db: &Db, root: &Path) {
    std::fs::create_dir_all(root.join("images")).unwrap();
    std::fs::create_dir_all(root.join("thumbs")).unwrap();
    let image = b"\x89PNG\r\n\x1a\nlegacy-image-bytes";
    let thumb = b"\x89PNG\r\n\x1a\nlegacy-thumb";
    std::fs::write(root.join("images/i1.png"), image).unwrap();
    std::fs::write(root.join("thumbs/i1.png"), thumb).unwrap();
    let now = "2026-11-23T00:00:00Z";
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO clipboard_items (id,kind,text,html,preview,content_hash,byte_size,source_app,source_title,image_width,image_height,file_paths,favorite,pinned,copy_count,created_at,last_seen_at) \
             VALUES ('i1','image','LEGACY-BODY','','legacy-preview','legacy-hash',?1,'legacy-app','legacy-window',10,10,'[\"C:/legacy.txt\"]',0,0,1,?2,?2)",
            rusqlite::params![image.len() as i64, now],
        )?;
        conn.execute(
            "INSERT INTO clipboard_assets (id,item_id,role,path,byte_size,width,height,created_at) \
             VALUES ('a1','i1','image','images/i1.png',?1,10,10,?2)",
            rusqlite::params![image.len() as i64, now],
        )?;
        conn.execute(
            "INSERT INTO clipboard_assets (id,item_id,role,path,byte_size,width,height,created_at) \
             VALUES ('a2','i1','thumb','thumbs/i1.png',?1,10,10,?2)",
            rusqlite::params![thumb.len() as i64, now],
        )?;
        Ok::<_, AppError>(())
    })
    .unwrap();
}

#[test]
fn legacy_plain_bundle_is_encrypted_on_import() {
    let dir = temp_dir("migration");
    let root = dir.join("clipboard");
    let source_db = Db::open_in_memory().unwrap();
    seed(&source_db, &root);

    let source = dir.join("legacy-plain.json");
    write_bundle(
        &source_db,
        BackupSources {
            archive_dir: None,
            clipboard_dir: Some(&root),
            shelf_dir: None,
            data_dir: None,
        },
        &source,
        BackupKind::Full,
    )
    .unwrap();

    let meta = bundle_meta(&source).unwrap();
    assert_eq!(meta["clipboard_sealed"], false);
    assert_eq!(meta["clipboard_migration_required"], true);

    let target_db = Db::open_in_memory().unwrap();
    target_db
        .set_setting("clipboard_encrypt_history", serde_json::json!(true))
        .unwrap();
    let mut read = read_bundle(&source, &dir.join("staging")).unwrap();
    assert!(!read.clipboard_sealed, "旧包必须被识别为未密封");
    let report = normalize_clipboard_for_restore(&target_db, &mut read).unwrap();
    assert!(report.encrypted);
    assert_eq!(report.rows, 1);
    assert_eq!(report.assets, 2);

    let row_line = std::fs::read_to_string(read.rows_dir.join("clipboard_items.jsonl")).unwrap();
    let row: serde_json::Value = serde_json::from_str(row_line.trim()).unwrap();
    let stored = row["text"].as_str().unwrap();
    assert!(
        task_dock_lib::clipboard::secure::is_encrypted_field(stored),
        "旧明文正文必须迁移为 CEK 字段密文"
    );
    assert_eq!(
        task_dock_lib::clipboard::secure::decrypt_if_encrypted(
            &task_dock_lib::clipboard::secure::item_field_aad("i1", "text"),
            stored,
        )
        .unwrap(),
        "LEGACY-BODY"
    );

    for (rel, aad, plain) in [
        (
            "images/i1.png",
            task_dock_lib::clipboard::secure::item_asset_aad("i1", "image"),
            &b"\x89PNG\r\n\x1a\nlegacy-image-bytes"[..],
        ),
        (
            "thumbs/i1.png",
            task_dock_lib::clipboard::secure::item_asset_aad("i1", "thumb"),
            &b"\x89PNG\r\n\x1a\nlegacy-thumb"[..],
        ),
    ] {
        let asset = read.assets.iter().find(|a| a.rel == rel).unwrap();
        let bytes = std::fs::read(&asset.path).unwrap();
        assert!(
            task_dock_lib::clipboard::secure::is_encrypted_blob(&bytes),
            "{rel} 必须迁移为 CEK 容器"
        );
        let opened =
            task_dock_lib::clipboard::secure::decrypt_blob_if_encrypted(&aad, &bytes).unwrap();
        assert_eq!(&opened[..], plain);
    }

    std::fs::remove_dir_all(dir).ok();
}
