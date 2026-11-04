//! 文件暂存架单元测试：路径安全、添加/删除生命周期、引用/托管语义、
//! 配额与磁盘安全、过期清理、孤儿兜底、分组、任务关联、备份读写。
//!
//! 数据隔离：全部使用 `Db::open_in_memory` + 独立临时目录，不触碰用户数据。

use super::*;

use serde_json::json;

struct TempRoot(PathBuf);
impl TempRoot {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("td-shelf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn shelf(&self) -> PathBuf {
        self.0.join("shelf")
    }
}
impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn tiny_png() -> Vec<u8> {
    // 2x2 纯色 PNG（经剪贴板 image 模块编码，保证可解码）
    let rgba = vec![
        200u8, 30, 30, 255, 30, 200, 30, 255, 30, 30, 200, 255, 240, 240, 240, 255,
    ];
    crate::clipboard::image::encode_png(&rgba, 2, 2).unwrap()
}

fn write_source(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

fn add_ref(db: &Db, root: &Path, src: &Path) -> ShelfItem {
    add_reference(db, root, &src.to_string_lossy(), "picker", None).unwrap()
}

// ── 路径安全 ────────────────────────────────────────────────

#[test]
fn managed_rel_only_accepts_whitelisted_layout() {
    assert!(safe_managed_rel("files/abc.png").is_ok());
    assert!(safe_managed_rel("images/abc.jpg").is_ok());
    assert!(safe_managed_rel("thumbs/abc.png").is_ok());
    // 绝对路径 / 反斜杠 / 穿越 / 非法目录
    assert!(safe_managed_rel("C:/x/y.png").is_err());
    assert!(safe_managed_rel("files\\abc.png").is_err());
    assert!(safe_managed_rel("files/../secret.txt").is_err());
    assert!(safe_managed_rel("../outside.png").is_err());
    assert!(safe_managed_rel("other/abc.png").is_err());
    assert!(safe_managed_rel("").is_err());
    assert!(safe_managed_rel("files/").is_err());
}

#[test]
fn original_path_normalization_blocks_traversal() {
    assert!(normalize_original_path("relative/file.txt").is_err());
    assert!(normalize_original_path("").is_err());
    assert!(normalize_original_path("bad\0path").is_err());
    let ok = normalize_original_path("D:\\a\\.\\b\\c.txt").unwrap();
    assert_eq!(ok, PathBuf::from("D:\\a\\b\\c.txt"));
    let up = normalize_original_path("D:\\a\\..\\b.txt").unwrap();
    assert_eq!(up, PathBuf::from("D:\\b.txt"));
    // 穿越超过根：无法继续上跳
    assert!(normalize_original_path("C:\\..\\..\\x").is_err());
}

#[test]
fn backup_rel_validation_accepts_shelf_namespace() {
    // 剪贴板命名空间不变
    assert!(crate::commands::backup::safe_asset_rel("images/a.png").is_ok());
    assert!(crate::commands::backup::safe_asset_rel("thumbs/a.png").is_ok());
    assert!(crate::commands::backup::safe_asset_rel("files/a.txt").is_err());
    // 暂存架命名空间
    assert!(crate::commands::backup::safe_asset_rel("shelf/files/a.txt").is_ok());
    assert!(crate::commands::backup::safe_asset_rel("shelf/images/a.jpg").is_ok());
    assert!(crate::commands::backup::safe_asset_rel("shelf/thumbs/a.png").is_ok());
    // 拒绝穿越与非法目录
    assert!(crate::commands::backup::safe_asset_rel("shelf/files/../a.txt").is_err());
    assert!(crate::commands::backup::safe_asset_rel("shelf/other/a.txt").is_err());
    assert!(crate::commands::backup::safe_asset_rel("shelf/files/").is_err());
    // 裸形式（写侧）
    assert!(crate::commands::backup::safe_shelf_rel("files/a.bin").is_ok());
    assert!(crate::commands::backup::safe_shelf_rel("thumbs/../x").is_err());
}

// ── 添加 / 删除生命周期 ─────────────────────────────────────

#[test]
fn add_reference_keeps_original_and_survives_item_delete() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "报告.txt", b"hello shelf");
    let item = add_ref(&db, &tmp.shelf(), &src);
    assert_eq!(item.kind, KIND_FILE);
    assert_eq!(item.storage_mode, MODE_REFERENCE);
    assert_eq!(item.byte_size, 11);
    assert_eq!(item.file_ext.as_deref(), Some("txt"));

    // 删除暂存条目：原文件必须原样保留
    let report = delete_items(&db, &tmp.shelf(), &[item.id.clone()], false).unwrap();
    assert_eq!(report.deleted, 1);
    assert_eq!(report.freed_bytes, 0, "引用模式不删除原文件，不统计释放字节");
    assert!(src.exists(), "删除暂存记录绝不能删除用户原文件");
    assert!(get_item(&db, &item.id).is_err());
}

#[test]
fn add_reference_folder_and_missing_path() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let dir = tmp.0.join("项目目录");
    std::fs::create_dir_all(&dir).unwrap();
    let item = add_reference(&db, &tmp.shelf(), &dir.to_string_lossy(), "drag", None).unwrap();
    assert_eq!(item.kind, KIND_FOLDER);

    let err = add_reference(&db, &tmp.shelf(), "D:\\不存在\\x.txt", "picker", None);
    assert!(err.is_err());
    // 相对路径拒绝
    assert!(add_reference(&db, &tmp.shelf(), "x.txt", "picker", None).is_err());
}

#[test]
fn managed_copy_roundtrip_and_delete_removes_owned_file() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "数据.csv", "a,b,c\n1,2,3\n".as_bytes());
    let item = add_managed(&db, &tmp.shelf(), &src.to_string_lossy(), "drag", None).unwrap();
    assert_eq!(item.storage_mode, MODE_MANAGED);
    let rel = item.managed_path.clone().unwrap();
    assert!(rel.starts_with("files/"));
    let managed_abs = tmp.shelf().join(&rel);
    assert!(managed_abs.exists());
    assert_eq!(
        std::fs::read(&managed_abs).unwrap(),
        std::fs::read(&src).unwrap()
    );
    assert_ne!(managed_abs, src, "托管副本不得指向原文件");

    delete_items(&db, &tmp.shelf(), &[item.id.clone()], false).unwrap();
    assert!(!managed_abs.exists(), "删除托管条目必须删除 Task Dock 拥有的副本");
    assert!(src.exists(), "托管删除也不得触碰原文件");
}

#[test]
fn managed_png_generates_thumb() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "截图.png", &tiny_png());
    let item = add_managed(&db, &tmp.shelf(), &src.to_string_lossy(), "drag", None).unwrap();
    assert_eq!(item.kind, KIND_IMAGE);
    assert!(tmp.shelf().join(format!("thumbs/{}.png", item.id)).exists());
    let url = read_image_data_url(&db, &tmp.shelf(), &item.id, false).unwrap();
    assert!(url.unwrap().starts_with("data:image/png;base64,"));
}

#[test]
fn managed_copy_rejects_folder() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let dir = tmp.0.join("dir");
    std::fs::create_dir_all(&dir).unwrap();
    let err = add_managed(&db, &tmp.shelf(), &dir.to_string_lossy(), "drag", None).unwrap_err();
    assert!(err.to_string().contains("引用模式"), "文件夹必须明确拒绝托管: {err}");
}

#[test]
fn managed_quota_enforced_and_no_residue() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    db.set_setting("shelf_max_storage_mb", json!(1)).unwrap();
    let big = vec![0u8; 2 * 1024 * 1024];
    let src = write_source(&tmp.0, "big.bin", &big);
    let err = add_managed(&db, &tmp.shelf(), &src.to_string_lossy(), "drag", None).unwrap_err();
    assert!(err.to_string().contains("配额"), "超配额必须报错: {err}");
    let files = tmp.shelf().join("files");
    let leftover = std::fs::read_dir(&files).map(|d| d.count()).unwrap_or(0);
    assert_eq!(leftover, 0, "失败添加不得残留文件");
}

#[test]
fn interrupted_copy_part_file_purged() {
    let tmp = TempRoot::new();
    let files = tmp.shelf().join("files");
    std::fs::create_dir_all(&files).unwrap();
    std::fs::write(files.join("ghost.bin.part"), b"half").unwrap();
    std::fs::write(files.join("real.bin"), b"full").unwrap();
    purge_part_files(&tmp.shelf());
    assert!(!files.join("ghost.bin.part").exists());
    assert!(files.join("real.bin").exists());
}

// ── 链接 / 文本 ─────────────────────────────────────────────

#[test]
fn link_and_text_items() {
    let db = Db::open_in_memory().unwrap();
    let link = add_link(&db, "https://example.com/docs?page=1", None).unwrap();
    assert_eq!(link.kind, KIND_LINK);
    assert_eq!(
        link.content.as_deref(),
        Some("https://example.com/docs?page=1")
    );
    // 非法 URL 拒绝
    assert!(add_link(&db, "javascript:alert(1)", None).is_err());
    assert!(add_link(&db, "file:///c:/windows", None).is_err());

    let text = add_text(&db, "第一行\n第二行", "manual", None).unwrap();
    assert_eq!(text.kind, KIND_TEXT);
    assert!(text.display_name.contains("第一行"));
    assert!(add_text(&db, "   ", "manual", None).is_err());
    // 单条读取必须带出 content（回归：列表查询不含 content，get_item 必须单独补）
    let (content, truncated) = read_text(&db, Path::new(""), &text.id).unwrap();
    assert_eq!(content, "第一行\n第二行");
    assert!(!truncated);
    // content 不进列表载荷（大文本不进前端内存）
    let page = list(&db, &ListFilter { limit: 10, ..Default::default() }).unwrap();
    assert!(page.items.iter().all(|i| i.content.is_none()));
}

// ── 更新 / 分组 ─────────────────────────────────────────────

#[test]
fn group_lifecycle_and_builtin_protection() {
    let db = Db::open_in_memory().unwrap();
    let groups = list_groups(&db).unwrap();
    assert_eq!(groups.len(), 3, "v22 迁移种子化三个内置分组");
    assert!(groups.iter().any(|g| g.id == "shelf-default"));

    let g = group_create(&db, "周会材料").unwrap();
    assert!(!g.builtin);
    assert!(group_create(&db, "周会材料").is_err(), "重名分组必须拒绝");

    group_rename(&db, &g.id, "评审材料").unwrap();
    let names: Vec<String> = list_groups(&db).unwrap().into_iter().map(|x| x.name).collect();
    assert!(names.contains(&"评审材料".to_string()));

    // 条目归位：删分组后条目进默认分组
    let item = add_text(&db, "便签", "manual", Some(&g.id)).unwrap();
    group_delete(&db, &g.id).unwrap();
    let moved = get_item(&db, &item.id).unwrap();
    assert_eq!(moved.group_id.as_deref(), Some("shelf-default"));
    assert!(group_delete(&db, "shelf-default").is_err());
    assert!(group_delete(&db, "不存在的分组").is_err());
}

#[test]
fn update_patch_and_expire_validation() {
    let db = Db::open_in_memory().unwrap();
    let item = add_text(&db, "待办内容", "manual", None).unwrap();
    let updated = update(
        &db,
        &item.id,
        &UpdatePatch {
            favorite: Some(true),
            pinned: Some(true),
            expire_at: Some(Some("2026-12-01T00:00:00Z".into())),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(updated.favorite && updated.pinned);
    assert_eq!(updated.expire_at.as_deref(), Some("2026-12-01T00:00:00Z"));
    assert!(update(
        &db,
        &item.id,
        &UpdatePatch {
            expire_at: Some(Some("不是时间".into())),
            ..Default::default()
        },
    )
    .is_err());
    assert!(update(&db, "不存在", &UpdatePatch::default()).is_err());
}

// ── 删除保护 / 清空 ─────────────────────────────────────────

#[test]
fn delete_skips_protected_unless_confirmed() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "keep.bin", b"keep");
    let item = add_managed(&db, &tmp.shelf(), &src.to_string_lossy(), "drag", None).unwrap();
    update(
        &db,
        &item.id,
        &UpdatePatch {
            favorite: Some(true),
            ..Default::default()
        },
    )
    .unwrap();

    let r = delete_items(&db, &tmp.shelf(), &[item.id.clone()], false).unwrap();
    assert_eq!(r.deleted, 0);
    assert_eq!(r.skipped, 1);
    assert!(get_item(&db, &item.id).is_ok(), "收藏条目默认保护");

    let r2 = delete_items(&db, &tmp.shelf(), &[item.id.clone()], true).unwrap();
    assert_eq!(r2.deleted, 1);
    assert!(get_item(&db, &item.id).is_err());
}

// ── 过期清理 ────────────────────────────────────────────────

#[test]
fn cleanup_expired_respects_protection_and_dry_run() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let mut settings = Settings::default();
    settings.shelf_retention_days = 7;

    let a = add_text(&db, "普通旧条目", "manual", None).unwrap();
    let b = add_text(&db, "收藏旧条目", "manual", None).unwrap();
    update(
        &db,
        &b.id,
        &UpdatePatch {
            favorite: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    // 人为把 created_at 拨到 30 天前
    let old = (Utc::now() - Duration::days(30)).to_rfc3339_opts(SecondsFormat::Millis, true);
    db.with_conn(|conn| {
        conn.execute("UPDATE shelf_items SET created_at = ?1", params![&old])?;
        Ok(())
    })
    .unwrap();

    // dry_run：只统计，不删除
    let preview = cleanup_expired(&db, &tmp.shelf(), &settings, true, false).unwrap();
    assert_eq!(preview.candidates, 1, "收藏条目不计入候选");
    assert_eq!(preview.skipped_protected, 1);
    assert!(get_item(&db, &a.id).is_ok());

    // 执行：普通条目删除、收藏保留
    let run = cleanup_expired(&db, &tmp.shelf(), &settings, false, false).unwrap();
    assert_eq!(run.candidates, 1);
    assert!(get_item(&db, &a.id).is_err());
    assert!(get_item(&db, &b.id).is_ok(), "收藏条目永不被自动清理");

    // 显式包含保护：用户确认后可清
    let run2 = cleanup_expired(&db, &tmp.shelf(), &settings, false, true).unwrap();
    assert_eq!(run2.candidates, 1);
    assert!(get_item(&db, &b.id).is_err());
}

#[test]
fn explicit_expire_at_triggers_cleanup() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let settings = Settings::default();
    let item = add_text(&db, "临时内容", "manual", None).unwrap();
    let past = (Utc::now() - Duration::hours(1)).to_rfc3339_opts(SecondsFormat::Millis, true);
    update(
        &db,
        &item.id,
        &UpdatePatch {
            expire_at: Some(Some(past)),
            ..Default::default()
        },
    )
    .unwrap();
    let run = cleanup_expired(&db, &tmp.shelf(), &settings, false, false).unwrap();
    assert_eq!(run.candidates, 1);
    assert!(get_item(&db, &item.id).is_err());
}

// ── 孤儿文件兜底 ────────────────────────────────────────────

#[test]
fn orphan_files_removed_only_when_unreferenced() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "ok.bin", b"data");
    let item = add_managed(&db, &tmp.shelf(), &src.to_string_lossy(), "drag", None).unwrap();
        // 手工制造孤儿与 .part
        let orphan = tmp.shelf().join("files/deadbeef.bin");
        std::fs::write(&orphan, b"orphan").unwrap();
        let images = tmp.shelf().join("images");
        std::fs::create_dir_all(&images).unwrap();
        let part = images.join("half.png.part");
        std::fs::write(&part, b"half").unwrap();
    let removed = purge_orphan_files(&db, &tmp.shelf());
    assert!(removed >= 2, "孤儿与 .part 都应被移除（实际 {removed}）");
    assert!(!orphan.exists());
    assert!(!part.exists());
    // 在管文件保留
    let rel = item.managed_path.clone().unwrap();
    assert!(tmp.shelf().join(&rel).exists(), "在管托管文件不得被孤儿清理误删");
}

// ── 存在性检查 ──────────────────────────────────────────────

#[test]
fn exists_check_flags_missing_reference() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "gone.txt", b"x");
    let item = add_ref(&db, &tmp.shelf(), &src);
    std::fs::remove_file(&src).unwrap();
    let reports = check_exists(&db, &tmp.shelf(), &[item.id.clone()]).unwrap();
    assert_eq!(reports[0].exists_state, "missing");
    let after = get_item(&db, &item.id).unwrap();
    assert_eq!(after.exists_state, "missing");
    // 链接恒 ok
    let link = add_link(&db, "https://example.com", None).unwrap();
    let lr = check_exists(&db, &tmp.shelf(), &[link.id]).unwrap();
    assert_eq!(lr[0].exists_state, "ok");
}

// ── 任务关联 ────────────────────────────────────────────────

#[test]
fn task_link_idempotent_and_cascade() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let now = now_iso();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1','开发任务',?1,?1)",
            params![&now],
        )?;
        Ok(())
    })
    .unwrap();
    let item = add_text(&db, "相关日志", "manual", None).unwrap();
    link_task(&db, &item.id, "t1").unwrap();
    link_task(&db, &item.id, "t1").unwrap(); // 幂等
    let links = task_links(&db, &item.id).unwrap();
    assert_eq!(links.len(), 1, "重复关联不得产生第二行");
    assert_eq!(links[0].task_title, "开发任务");
    assert!(link_task(&db, &item.id, "不存在").is_err());

    // 删除任务只级联删关联，条目保留
    db.with_conn(|conn| {
        conn.execute("DELETE FROM tasks WHERE id='t1'", [])?;
        Ok(())
    })
    .unwrap();
    assert!(get_item(&db, &item.id).is_ok(), "删除任务不得静默删除暂存资源");
    assert!(task_links(&db, &item.id).unwrap().is_empty());
    let _ = tmp;
}

// ── 备份 / 恢复 ─────────────────────────────────────────────

#[test]
fn backup_roundtrip_includes_shelf_managed_files() {
    use crate::commands::backup::{read_bundle, write_bundle, BackupKind, BackupSources};
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "附件.bin", b"payload-123");
    add_managed(&db, &tmp.shelf(), &src.to_string_lossy(), "drag", None).unwrap();
    let png_src = write_source(&tmp.0, "图片.png", &tiny_png());
    add_managed(&db, &tmp.shelf(), &png_src.to_string_lossy(), "drag", None).unwrap();

    let bundle = tmp.0.join("bundle.json");
    let written = write_bundle(
        &db,
        BackupSources {
            archive_dir: None,
            clipboard_dir: Some(&tmp.0.join("clipboard")),
            shelf_dir: Some(&tmp.shelf()),
        },
        &bundle,
        BackupKind::Full,
    )
    .unwrap();
    // 2 个托管文件 + 1 个缩略图
    assert_eq!(
        written.counts.get("shelf_assets").and_then(|v| v.as_i64()),
        Some(3)
    );

    // 读回：完整性校验通过且 shelf 资产全部落暂存
    let staging = tmp.0.join("staging");
    let read = read_bundle(&bundle, &staging).unwrap();
    let shelf_assets: Vec<_> = read
        .assets
        .iter()
        .filter(|a| a.rel.starts_with("shelf/"))
        .collect();
    assert_eq!(shelf_assets.len(), 3);
}

#[test]
fn backup_rejects_missing_shelf_dir_when_managed_items_exist() {
    use crate::commands::backup::{write_bundle, BackupKind, BackupSources};
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "x.bin", b"x");
    add_managed(&db, &tmp.shelf(), &src.to_string_lossy(), "drag", None).unwrap();
    let err = write_bundle(
        &db,
        BackupSources {
            archive_dir: None,
            clipboard_dir: None,
            shelf_dir: None,
        },
        &tmp.0.join("b.json"),
        BackupKind::Full,
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("暂存架托管目录"),
        "不得静默产出无文件的备份: {err}"
    );
}
