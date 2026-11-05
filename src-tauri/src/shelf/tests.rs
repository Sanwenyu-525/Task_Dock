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

// ── 文件操作：移动 ──────────────────────────────────────────

#[test]
fn fsops_move_reference_file_updates_path_and_keeps_item_identity() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src_dir = tmp.0.join("源 目录");
    std::fs::create_dir_all(&src_dir).unwrap();
    let file = write_source(&src_dir, "计划 文档.txt", b"abc");
    let item = add_ref(&db, &tmp.shelf(), &file);
    let target = tmp.0.join("目标 目录");
    std::fs::create_dir_all(&target).unwrap();

    let report = fsops::move_items(
        &db,
        &tmp.shelf(),
        &[item.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.success, 1, "{:?}", report.entries);
    assert_eq!(report.failed, 0);

    let moved = target.join("计划 文档.txt");
    assert!(!file.exists(), "移动后源文件不应残留");
    assert!(moved.exists(), "移动后目标文件必须存在");
    let refreshed = get_item(&db, &item.id).unwrap();
    assert_eq!(refreshed.id, item.id, "移动不得删旧建新");
    assert_eq!(
        refreshed.original_path.as_deref(),
        Some(moved.to_string_lossy().as_ref())
    );
    assert_eq!(refreshed.exists_state, "ok");
    assert_eq!(refreshed.kind, KIND_FILE);
    assert_eq!(refreshed.favorite, item.favorite);
    assert_eq!(refreshed.pinned, item.pinned);
    assert_eq!(refreshed.group_id, item.group_id);
}

#[test]
fn fsops_move_folder_updates_child_and_duplicate_references() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let folder = tmp.0.join("项目");
    std::fs::create_dir_all(&folder).unwrap();
    let child = write_source(&folder, "说明.md", b"# hi");
    let folder_item = add_ref(&db, &tmp.shelf(), &folder);
    let child_item = add_ref(&db, &tmp.shelf(), &child);
    // 同一文件被两条记录引用，移动父目录后都必须同步，不残留失效引用。
    let duplicate = add_ref(&db, &tmp.shelf(), &child);
    let target = tmp.0.join("归档");
    std::fs::create_dir_all(&target).unwrap();

    let report = fsops::move_items(
        &db,
        &tmp.shelf(),
        &[folder_item.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.success, 1);
    let moved_root = target.join("项目");
    assert!(!folder.exists());
    assert!(moved_root.join("说明.md").exists());
    for id in [&child_item.id, &duplicate.id] {
        let row = get_item(&db, id).unwrap();
        assert_eq!(
            row.original_path.as_deref(),
            Some(moved_root.join("说明.md").to_string_lossy().as_ref())
        );
        assert_eq!(row.exists_state, "ok");
    }
}

#[test]
fn fsops_move_rejects_same_dir_subdir_and_managed() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let dir = tmp.0.join("src");
    std::fs::create_dir_all(&dir).unwrap();
    let file = write_source(&dir, "a.txt", b"a");
    let item = add_ref(&db, &tmp.shelf(), &file);
    let report = fsops::move_items(
        &db,
        &tmp.shelf(),
        &[item.id.clone()],
        &dir.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.skipped, 1);
    assert!(file.exists());
    assert!(report.entries[0].reason.as_deref().unwrap().contains("目标目录"));

    // 文件夹移入自身子目录必须拒绝
    let folder = tmp.0.join("树");
    std::fs::create_dir_all(folder.join("子")).unwrap();
    let folder_item = add_ref(&db, &tmp.shelf(), &folder);
    let report = fsops::move_items(
        &db,
        &tmp.shelf(),
        &[folder_item.id.clone()],
        &folder.join("子").to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.failed, 1, "{:?}", report.entries);
    assert!(folder.exists(), "拒绝后源目录不得变化");

    // managed 副本不得被当作外部原文件移动
    let managed_src = write_source(&tmp.0, "托管.txt", b"managed");
    let managed = add_managed(
        &db,
        &tmp.shelf(),
        &managed_src.to_string_lossy(),
        "picker",
        None,
    )
    .unwrap();
    let report = fsops::move_items(
        &db,
        &tmp.shelf(),
        &[managed.id.clone()],
        &dir.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.failed, 1);
    assert!(report.entries[0]
        .reason
        .as_deref()
        .unwrap()
        .contains("托管副本"));
    assert_eq!(
        get_item(&db, &managed.id).unwrap().managed_path,
        managed.managed_path
    );
}

// ── 文件操作：复制 ──────────────────────────────────────────

#[test]
fn fsops_copy_file_conflict_skip_and_rename_without_new_records() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let a_dir = tmp.0.join("a");
    let b_dir = tmp.0.join("b");
    std::fs::create_dir_all(&a_dir).unwrap();
    std::fs::create_dir_all(&b_dir).unwrap();
    let a = write_source(&a_dir, "同名.txt", b"one");
    let b = write_source(&b_dir, "同名.txt", b"two");
    let ia = add_ref(&db, &tmp.shelf(), &a);
    let ib = add_ref(&db, &tmp.shelf(), &b);
    let target = tmp.0.join("dest");
    std::fs::create_dir_all(&target).unwrap();
    let before = list(
        &db,
        &ListFilter {
            search: None,
            kind: "all".into(),
            group_id: "all".into(),
            favorite_only: false,
            limit: 100,
            offset: 0,
        },
    )
    .unwrap()
    .total;

    let report = fsops::copy_items(
        &db,
        &tmp.shelf(),
        &[ia.id.clone(), ib.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.success, 1, "{:?}", report.entries);
    assert_eq!(report.skipped, 1);
    assert!(a.exists() && b.exists(), "复制必须保留源文件");
    assert!(target.join("同名.txt").exists());

    let report = fsops::copy_items(
        &db,
        &tmp.shelf(),
        &[ib.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Rename,
        false,
    )
    .unwrap();
    assert_eq!(report.success, 1, "{:?}", report.entries);
    assert!(target.join("同名 (1).txt").exists());
    let after = list(
        &db,
        &ListFilter {
            search: None,
            kind: "all".into(),
            group_id: "all".into(),
            favorite_only: false,
            limit: 100,
            offset: 0,
        },
    )
    .unwrap()
    .total;
    assert_eq!(after, before, "复制到目录不得向暂存架重复添加记录");
}

#[test]
fn fsops_copy_folder_and_batch_partial_failure_keep_failed_entries() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let folder = tmp.0.join("素材");
    std::fs::create_dir_all(&folder).unwrap();
    write_source(&folder, "一.txt", b"1");
    write_source(&folder, "二.txt", b"2");
    let folder_item = add_ref(&db, &tmp.shelf(), &folder);

    let missing_dir = tmp.0.join("missing");
    std::fs::create_dir_all(&missing_dir).unwrap();
    let missing = write_source(&missing_dir, "lost.txt", b"x");
    let missing_item = add_ref(&db, &tmp.shelf(), &missing);
    std::fs::remove_file(&missing).unwrap();

    let target = tmp.0.join("out");
    std::fs::create_dir_all(&target).unwrap();
    let report = fsops::copy_items(
        &db,
        &tmp.shelf(),
        &[folder_item.id.clone(), missing_item.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.success, 1, "{:?}", report.entries);
    assert_eq!(report.failed, 1);
    assert!(target.join("素材").is_dir());
    assert!(target.join("素材").join("一.txt").exists());
    assert!(folder.exists());
    let failed = report
        .entries
        .iter()
        .find(|e| e.status == "failed")
        .unwrap();
    assert!(failed.reason.as_deref().unwrap().contains("失效"));
}

#[test]
fn fsops_managed_export_copy_keeps_managed_path_and_remove_after_only_record() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "导出.csv", b"a,b\n");
    let managed = add_managed(&db, &tmp.shelf(), &src.to_string_lossy(), "picker", None).unwrap();
    let managed_file = tmp
        .shelf()
        .join(managed.managed_path.as_deref().unwrap());
    let target = tmp.0.join("export");
    std::fs::create_dir_all(&target).unwrap();

    let report = fsops::copy_items(
        &db,
        &tmp.shelf(),
        &[managed.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.success, 1, "{:?}", report.entries);
    assert!(target.join("导出.csv").is_file());
    assert!(managed_file.exists(), "导出必须保留托管副本");
    assert_eq!(
        get_item(&db, &managed.id).unwrap().managed_path,
        managed.managed_path,
        "导出不得改写 managed_path"
    );

    let report = fsops::copy_items(
        &db,
        &tmp.shelf(),
        &[managed.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Rename,
        true,
    )
    .unwrap();
    assert_eq!(report.removed, 1);
    assert!(get_item(&db, &managed.id).is_err());
    assert!(target.join("导出 (1).csv").is_file(), "已移动的目标文件必须保留");
}

#[test]
fn fsops_copy_remove_after_keeps_reference_source_file() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "引用.txt", b"keep");
    let item = add_ref(&db, &tmp.shelf(), &src);
    let target = tmp.0.join("dest2");
    std::fs::create_dir_all(&target).unwrap();
    let report = fsops::copy_items(
        &db,
        &tmp.shelf(),
        &[item.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        true,
    )
    .unwrap();
    assert_eq!(report.removed, 1);
    assert!(src.exists(), "移除暂存记录不得删除用户原文件");
    assert!(target.join("引用.txt").exists());
}

// ── 失效重定位 / 恢复 / 最近目录 ────────────────────────────

#[test]
fn fsops_relocate_validates_type_and_mode() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let old = write_source(&tmp.0, "旧.txt", b"old");
    let item = add_ref(&db, &tmp.shelf(), &old);
    std::fs::remove_file(&old).unwrap();

    let new = write_source(&tmp.0, "新 文件.txt", b"new!");
    let updated = fsops::relocate_item(&db, &item.id, &new.to_string_lossy()).unwrap();
    assert_eq!(updated.id, item.id);
    assert_eq!(
        updated.original_path.as_deref(),
        Some(new.to_string_lossy().as_ref())
    );
    assert_eq!(updated.exists_state, "ok");
    assert_eq!(updated.byte_size, 4);

    let folder = tmp.0.join("目录");
    std::fs::create_dir_all(&folder).unwrap();
    let file_item = add_ref(&db, &tmp.shelf(), &new);
    assert!(fsops::relocate_item(&db, &file_item.id, &folder.to_string_lossy()).is_err());

    let managed_src = write_source(&tmp.0, "m.txt", b"m");
    let managed = add_managed(
        &db,
        &tmp.shelf(),
        &managed_src.to_string_lossy(),
        "picker",
        None,
    )
    .unwrap();
    let err = fsops::relocate_item(&db, &managed.id, &managed_src.to_string_lossy()).unwrap_err();
    assert!(err.to_string().contains("托管副本"));
}

#[test]
fn fsops_recovery_after_disk_move_rewrites_paths() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "崩溃.txt", b"data");
    let item = add_ref(&db, &tmp.shelf(), &src);
    let target = tmp.0.join("恢复目标.txt");
    // 模拟：磁盘已移动、进程在写库前退出，日志停留在 moved。
    std::fs::rename(&src, &target).unwrap();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO shelf_file_ops (id, item_id, op, phase, source, target, created_at) \
             VALUES ('op1', ?1, 'move', 'moved', ?2, ?3, '2026-01-01T00:00:00Z')",
            params![
                item.id,
                src.to_string_lossy(),
                target.to_string_lossy()
            ],
        )?;
        Ok(())
    })
    .unwrap();

    fsops::recover_pending_file_ops(&db);
    let row = get_item(&db, &item.id).unwrap();
    assert_eq!(
        row.original_path.as_deref(),
        Some(target.to_string_lossy().as_ref())
    );
    let left: i64 = db
        .with_read(|conn| {
            conn.query_row("SELECT COUNT(*) FROM shelf_file_ops", [], |r| r.get(0))
                .map_err(AppError::from)
        })
        .unwrap();
    assert_eq!(left, 0, "恢复成功后必须清理日志");
}

#[test]
fn fsops_recent_dirs_dedup_order_pin_and_limit() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let mut dirs = Vec::new();
    for i in 0..9 {
        let d = tmp.0.join(format!("dir{i}"));
        std::fs::create_dir_all(&d).unwrap();
        fsops::touch_recent_dir(&db, &d.to_string_lossy()).unwrap();
        dirs.push(d);
    }
    let list = fsops::list_recent_dirs(&db).unwrap();
    assert_eq!(list.len(), fsops::MAX_RECENT_DIRS, "最多保留 8 个");
    assert!(!list.iter().any(|d| d.path == dirs[0].to_string_lossy()),
        "超限时淘汰最久未用目录");

    // 去重：再次使用不新增
    fsops::touch_recent_dir(&db, &dirs[8].to_string_lossy()).unwrap();
    assert_eq!(fsops::list_recent_dirs(&db).unwrap().len(), 8);

    fsops::set_recent_dir_pinned(&db, &dirs[8].to_string_lossy(), true).unwrap();
    let list = fsops::list_recent_dirs(&db).unwrap();
    assert!(list[0].pinned, "固定目录排在最前");
    assert_eq!(list[0].path, dirs[8].to_string_lossy());

    fsops::remove_recent_dir(&db, &dirs[7].to_string_lossy()).unwrap();
    assert_eq!(fsops::list_recent_dirs(&db).unwrap().len(), 7);
    fsops::clear_recent_dirs(&db).unwrap();
    assert!(fsops::list_recent_dirs(&db).unwrap().is_empty());
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
            data_dir: Some(&tmp.0),
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
            data_dir: None,
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

// ── 跨卷移动：内容校验 / 部分删除 / 故障注入恢复 ─────────────

fn clear_faults() {
    fsops::test_support::clear();
}

fn insert_journal_row(db: &Db, item_id: &str, op: &str, phase: &str, src: &Path, dst: &Path) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO shelf_file_ops (id, item_id, op, phase, source, target, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                item_id,
                op,
                phase,
                src.to_string_lossy(),
                dst.to_string_lossy(),
                now_iso()
            ],
        )?;
        Ok(())
    })
    .unwrap();
}

fn journal_count(db: &Db) -> i64 {
    db.with_read(|conn| {
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM shelf_file_ops", [], |r| r.get(0))?;
        Ok(n)
    })
    .unwrap()
}

fn tree_files(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                stack.push(path);
            } else {
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, std::fs::read(&path).unwrap()));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[test]
fn fsops_cross_volume_detects_corrupted_copy_and_keeps_source() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = tmp.0.join("树");
    std::fs::create_dir_all(src.join("空目录")).unwrap();
    std::fs::write(src.join("甲.txt"), b"content-alpha").unwrap();
    std::fs::write(src.join("乙.txt"), b"content-beta").unwrap();
    let item = add_ref(&db, &tmp.shelf(), &src);
    let target = tmp.0.join("dest");
    std::fs::create_dir_all(&target).unwrap();

    fsops::test_support::set_always("force_cross_volume");
    fsops::test_support::set_once("copy_corrupt");
    let report = fsops::move_items(
        &db,
        &tmp.shelf(),
        &[item.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.failed, 1, "{:?}", report.entries);
    assert!(src.exists(), "校验失败后源目录必须完整保留");
    assert!(!target.join("树").exists(), "校验失败不得建立最终目标");
    assert_eq!(
        tree_files(&src),
        vec![
            ("乙.txt".to_string(), b"content-beta".to_vec()),
            ("甲.txt".to_string(), b"content-alpha".to_vec())
        ]
    );
    assert_eq!(
        get_item(&db, &item.id).unwrap().original_path.as_deref(),
        Some(src.to_string_lossy().as_ref())
    );
    let leftovers: Vec<_> = std::fs::read_dir(&target)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(leftovers.is_empty(), "失败后不得残留临时副本: {leftovers:?}");
    clear_faults();
}

#[test]
fn fsops_cross_volume_move_preserves_nested_and_empty_dirs() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = tmp.0.join("源");
    std::fs::create_dir_all(src.join("嵌套/空")).unwrap();
    std::fs::write(src.join("嵌套/说明 文档.txt"), b"unicode").unwrap();
    let item = add_ref(&db, &tmp.shelf(), &src);
    let target = tmp.0.join("目标");
    std::fs::create_dir_all(&target).unwrap();

    fsops::test_support::set_always("force_cross_volume");
    let report = fsops::move_items(
        &db,
        &tmp.shelf(),
        &[item.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.success, 1, "{:?}", report.entries);
    let moved = target.join("源");
    assert!(!src.exists());
    assert!(moved.join("嵌套/空").is_dir(), "空目录必须保留");
    assert_eq!(
        std::fs::read(moved.join("嵌套/说明 文档.txt")).unwrap(),
        b"unicode"
    );
    assert_eq!(
        get_item(&db, &item.id).unwrap().original_path.as_deref(),
        Some(moved.to_string_lossy().as_ref())
    );
    assert_eq!(journal_count(&db), 0);
    clear_faults();
}

#[test]
fn fsops_partial_source_delete_keeps_only_complete_target() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = tmp.0.join("源");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("a.txt"), b"aaa").unwrap();
    std::fs::write(src.join("b.txt"), b"bbb").unwrap();
    let item = add_ref(&db, &tmp.shelf(), &src);
    let target = tmp.0.join("目标");
    std::fs::create_dir_all(&target).unwrap();

    fsops::test_support::set_always("force_cross_volume");
    fsops::test_support::set_always("source_remove_partial_first");
    let report = fsops::move_items(
        &db,
        &tmp.shelf(),
        &[item.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.partial, 1, "{:?}", report.entries);
    assert_eq!(report.failed, 0);
    let moved = target.join("源");
    assert_eq!(
        tree_files(&moved),
        vec![
            ("a.txt".to_string(), b"aaa".to_vec()),
            ("b.txt".to_string(), b"bbb".to_vec())
        ],
        "目标必须是完整副本"
    );
    assert!(src.exists(), "部分删除后源可能残留，不得递归清理");
    assert!(report.entries[0].residual_source.is_some());
    assert!(report.entries[0].recovery.is_some());
    assert_eq!(
        get_item(&db, &item.id).unwrap().original_path.as_deref(),
        Some(moved.to_string_lossy().as_ref()),
        "目标完整时应把引用切到目标"
    );
    assert_eq!(journal_count(&db), 0);
    clear_faults();
}

#[test]
fn fsops_partial_subdir_delete_keeps_target_and_residual_source() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = tmp.0.join("源");
    std::fs::create_dir_all(src.join("子")).unwrap();
    std::fs::write(src.join("子/一.txt"), b"one").unwrap();
    std::fs::write(src.join("保留.txt"), b"keep").unwrap();
    let item = add_ref(&db, &tmp.shelf(), &src);
    let target = tmp.0.join("目标");
    std::fs::create_dir_all(&target).unwrap();

    fsops::test_support::set_always("force_cross_volume");
    fsops::test_support::set_always("source_remove_partial_subdir");
    let report = fsops::move_items(
        &db,
        &tmp.shelf(),
        &[item.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.partial, 1, "{:?}", report.entries);
    let moved = target.join("源");
    assert!(moved.join("子/一.txt").exists());
    assert!(moved.join("保留.txt").exists());
    assert!(!src.join("子").exists(), "注入的故障应模拟部分子目录删除");
    assert!(src.join("保留.txt").exists());
    assert_eq!(
        get_item(&db, &item.id).unwrap().original_path.as_deref(),
        Some(moved.to_string_lossy().as_ref())
    );
    clear_faults();
}

#[test]
fn fsops_journal_phase_failure_never_deletes_source() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "a.txt", b"payload");
    let item = add_ref(&db, &tmp.shelf(), &src);
    let target = tmp.0.join("目标");
    std::fs::create_dir_all(&target).unwrap();

    fsops::test_support::set_always("force_cross_volume");
    fsops::test_support::set_once("journal_copied_fail");
    let report = fsops::move_items(
        &db,
        &tmp.shelf(),
        &[item.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.partial, 1, "{:?}", report.entries);
    let moved = target.join("a.txt");
    assert!(moved.exists(), "已校验目标必须保留");
    assert!(src.exists(), "日志阶段失败时不得删除源");
    // 模拟重启恢复：只清理本次临时副本/日志，不删除源与最终目标。
    fsops::recover_pending_file_ops(&db);
    assert!(moved.exists());
    assert!(src.exists());
    assert_eq!(journal_count(&db), 0);
    clear_faults();
}

#[test]
fn fsops_db_update_failure_keeps_target_and_recovers() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "a.txt", b"payload");
    let item = add_ref(&db, &tmp.shelf(), &src);
    let target = tmp.0.join("目标");
    std::fs::create_dir_all(&target).unwrap();

    fsops::test_support::set_always("force_cross_volume");
    fsops::test_support::set_once("db_rewrite_fail");
    let report = fsops::move_items(
        &db,
        &tmp.shelf(),
        &[item.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.partial, 1, "{:?}", report.entries);
    let moved = target.join("a.txt");
    assert!(moved.exists(), "数据库写入失败不得删除唯一完整副本");
    assert!(!src.exists());
    assert_eq!(
        get_item(&db, &item.id).unwrap().original_path.as_deref(),
        Some(src.to_string_lossy().as_ref())
    );
    fsops::recover_pending_file_ops(&db);
    assert!(moved.exists());
    assert_eq!(
        get_item(&db, &item.id).unwrap().original_path.as_deref(),
        Some(moved.to_string_lossy().as_ref())
    );
    assert_eq!(journal_count(&db), 0);
    clear_faults();
}

#[test]
fn recover_keeps_target_and_residual_source_after_crash() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = tmp.0.join("源");
    let dst = tmp.0.join("目标");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::create_dir_all(&dst).unwrap();
    // 构造「源被部分删除、目标完整」的中断现场。
    std::fs::write(src.join("残留.txt"), b"residual").unwrap();
    std::fs::write(dst.join("完整.txt"), b"complete").unwrap();
    let item = add_ref(&db, &tmp.shelf(), &src);
    insert_journal_row(&db, &item.id, "move", "copied", &src, &dst);

    fsops::recover_pending_file_ops(&db);
    assert!(dst.join("完整.txt").exists(), "恢复不得删除完整目标");
    assert!(src.join("残留.txt").exists(), "恢复不得递归清理残留源");
    assert_eq!(
        get_item(&db, &item.id).unwrap().original_path.as_deref(),
        Some(dst.to_string_lossy().as_ref())
    );
    assert_eq!(journal_count(&db), 0);
}

#[test]
fn recover_is_idempotent_and_keeps_diagnostic_when_both_missing() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = tmp.0.join("源");
    let dst = tmp.0.join("目标");
    std::fs::create_dir_all(&src).unwrap();
    let item = add_ref(&db, &tmp.shelf(), &src);
    std::fs::remove_dir(&src).unwrap();
    insert_journal_row(&db, &item.id, "move", "moved", &src, &dst);

    fsops::recover_pending_file_ops(&db);
    fsops::recover_pending_file_ops(&db);
    assert_eq!(journal_count(&db), 1, "无法判定的异常必须保留诊断日志");
    assert!(!src.exists() && !dst.exists());
}

#[test]
fn fsops_parent_and_child_in_same_batch_moves_child_with_parent() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let folder = tmp.0.join("项目");
    std::fs::create_dir_all(&folder).unwrap();
    let child = write_source(&folder, "说明.md", b"# hi");
    let folder_item = add_ref(&db, &tmp.shelf(), &folder);
    let child_item = add_ref(&db, &tmp.shelf(), &child);
    let target = tmp.0.join("归档");
    std::fs::create_dir_all(&target).unwrap();

    // 子项排在父项之前，也必须由父目录先处理。
    let report = fsops::move_items(
        &db,
        &tmp.shelf(),
        &[child_item.id.clone(), folder_item.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.success, 1, "{:?}", report.entries);
    assert_eq!(report.skipped, 1);
    let moved = target.join("项目").join("说明.md");
    assert!(moved.exists());
    assert_eq!(
        Path::new(
            get_item(&db, &child_item.id)
                .unwrap()
                .original_path
                .as_deref()
                .unwrap()
        ),
        moved,
        "子记录引用必须随父目录更新"
    );
    assert!(get_item(&db, &child_item.id).is_ok(), "子记录必须保留");
}

#[test]
fn fsops_duplicate_physical_path_in_batch_is_skipped() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "same.txt", b"same");
    let a = add_ref(&db, &tmp.shelf(), &src);
    let b = add_ref(&db, &tmp.shelf(), &src);
    let target = tmp.0.join("目标");
    std::fs::create_dir_all(&target).unwrap();

    let report = fsops::move_items(
        &db,
        &tmp.shelf(),
        &[a.id.clone(), b.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.success, 1, "{:?}", report.entries);
    assert_eq!(report.skipped, 1);
    assert_eq!(
        std::fs::read_dir(&target).unwrap().count(),
        1,
        "同一物理路径不得重复复制/移动"
    );
    for id in [&a.id, &b.id] {
        assert_eq!(
            get_item(&db, id).unwrap().original_path.as_deref(),
            Some(target.join("same.txt").to_string_lossy().as_ref())
        );
    }
}

#[test]
fn copy_rejects_self_and_descendant_target() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let folder = tmp.0.join("树");
    std::fs::create_dir_all(folder.join("子")).unwrap();
    std::fs::write(folder.join("a.txt"), b"a").unwrap();
    let item = add_ref(&db, &tmp.shelf(), &folder);

    for target in [folder.clone(), folder.join("子")] {
        let report = fsops::copy_items(
            &db,
            &tmp.shelf(),
            &[item.id.clone()],
            &target.to_string_lossy(),
            fsops::ConflictStrategy::Skip,
            false,
        )
        .unwrap();
        assert_eq!(report.failed, 1, "{:?}", report.entries);
        assert!(report.entries[0]
            .reason
            .as_deref()
            .unwrap()
            .contains("自身"));
    }
    assert_eq!(
        tree_files(&folder),
        vec![("a.txt".to_string(), b"a".to_vec())],
        "拒绝后不得产生重复副本"
    );
}

#[test]
fn copy_target_race_does_not_silently_overwrite() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "a.txt", b"original");
    let item = add_ref(&db, &tmp.shelf(), &src);
    let target = tmp.0.join("目标");
    std::fs::create_dir_all(&target).unwrap();

    fsops::test_support::set_always("force_cross_volume");
    fsops::test_support::set_once("target_race");
    let report = fsops::move_items(
        &db,
        &tmp.shelf(),
        &[item.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        false,
    )
    .unwrap();
    assert_eq!(report.failed, 1, "{:?}", report.entries);
    assert_eq!(
        std::fs::read(target.join("a.txt")).unwrap(),
        b"racer",
        "已存在的目标不得被静默覆盖"
    );
    assert_eq!(std::fs::read(&src).unwrap(), b"original");
    clear_faults();
}

#[test]
fn finish_report_distinguishes_record_cleanup_failure() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "a.txt", b"a");
    let item = add_ref(&db, &tmp.shelf(), &src);
    let target = tmp.0.join("目标");
    std::fs::create_dir_all(&target).unwrap();

    fsops::test_support::set_once("record_delete_fail");
    let report = fsops::move_items(
        &db,
        &tmp.shelf(),
        &[item.id.clone()],
        &target.to_string_lossy(),
        fsops::ConflictStrategy::Skip,
        true,
    )
    .unwrap();
    assert_eq!(report.success, 1, "文件操作成功不得被记录清理失败掩盖");
    assert_eq!(report.record_cleanup_failed, 1);
    assert!(report.record_cleanup_error.is_some());
    assert_eq!(report.removed, 0);
    assert!(target.join("a.txt").exists());
    assert!(get_item(&db, &item.id).is_ok(), "失败项记录必须保留可恢复");
    assert!(report.entries[0]
        .reason
        .as_deref()
        .unwrap()
        .contains("移除暂存记录失败"));
    clear_faults();
}

