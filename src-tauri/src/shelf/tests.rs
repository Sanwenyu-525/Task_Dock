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
            sort: "default".into(),
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
            sort: "default".into(),
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


// ── 收集箱文件投递（v35） ──────────────────────────────────

/// 建一个真实目标目录 + 目标配置。
fn add_target(
    db: &Db,
    root: &Path,
    base: &Path,
    name: &str,
    dir_name: &str,
) -> drop_targets::DropTarget {
    let dir = base.join(dir_name);
    std::fs::create_dir_all(&dir).unwrap();
    drop_targets::create(db, root, name, &dir.to_string_lossy(), true, "copy", "rename").unwrap()
}

#[test]
fn drop_target_crud_persists_name_order_visibility_and_modes() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();

    let a = add_target(&db, &root, &tmp.0, "工作资料", "work");
    assert!(a.available);
    assert_eq!(a.op_mode, "copy", "默认复制，绝不默认移动");
    assert_eq!(a.conflict, "rename", "默认自动重命名，避免误以为已保存");
    assert!(a.show_in_capsule);

    let b = drop_targets::create(
        &db,
        &root,
        "",
        &tmp.0.join("images").to_string_lossy(),
        false,
        "move",
        "skip",
    );
    // 目录不存在时明确拒绝（不写入一条永远不可用的配置）
    assert!(b.is_err());

    std::fs::create_dir_all(tmp.0.join("images")).unwrap();
    let b = drop_targets::create(
        &db,
        &root,
        "",
        &tmp.0.join("images").to_string_lossy(),
        false,
        "move",
        "skip",
    )
    .unwrap();
    assert_eq!(b.name, "images", "留空名称回退为目录名");
    assert_eq!(b.op_mode, "move");
    assert_eq!(b.conflict, "skip");
    assert!(!b.show_in_capsule);

    let list = drop_targets::list(&db).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].id, a.id, "按创建顺序排序");

    // 重命名 + 改模式 + 改可见性
    let updated = drop_targets::update(
        &db,
        &root,
        &a.id,
        &drop_targets::DropTargetPatch {
            name: Some("工作".into()),
            show_in_capsule: Some(false),
            op_mode: Some("move".into()),
            conflict: Some("skip".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(updated.name, "工作");
    assert_eq!(updated.op_mode, "move");
    assert_eq!(updated.conflict, "skip");
    assert!(!updated.show_in_capsule);

    // 排序：b 上移
    let ordered = drop_targets::reorder(&db, &b.id, "up").unwrap();
    assert_eq!(ordered[0].id, b.id);
    // 已在首位的继续上移不报错、不改变顺序
    let again = drop_targets::reorder(&db, &b.id, "up").unwrap();
    assert_eq!(again[0].id, b.id);

    // 删除只删配置：真实目录仍在
    drop_targets::delete(&db, &b.id).unwrap();
    assert_eq!(drop_targets::list(&db).unwrap().len(), 1);
    assert!(tmp.0.join("images").is_dir(), "删除配置不得删除真实目录");
    assert!(drop_targets::delete(&db, &b.id).is_err(), "重复删除返回未找到");
}

#[test]
fn drop_target_rejects_duplicate_path_case_insensitively_and_inside_shelf_root() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    std::fs::create_dir_all(tmp.0.join("Work")).unwrap();

    drop_targets::create(&db, &root, "工作", &tmp.0.join("Work").to_string_lossy(), true, "", "")
        .unwrap();
    let dup = drop_targets::create(
        &db,
        &root,
        "工作2",
        &tmp.0.join("work").to_string_lossy(),
        true,
        "",
        "",
    );
    assert!(dup.is_err(), "Windows 路径大小写不敏感，重复目录必须拒绝");

    // 暂存架内部目录不得作为投递目标（会被清理兜底误删）
    std::fs::create_dir_all(root.join("files")).unwrap();
    let inside = drop_targets::create(
        &db,
        &root,
        "架内",
        &root.join("files").to_string_lossy(),
        true,
        "",
        "",
    );
    assert!(inside.is_err());

    let relative = drop_targets::create(&db, &root, "相对", "relative\\dir", true, "", "");
    assert!(relative.is_err(), "只接受绝对路径");
}

#[test]
fn drop_target_update_path_keeps_other_fields_and_checks_duplicates() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let a = add_target(&db, &root, &tmp.0, "A", "a");
    let b = add_target(&db, &root, &tmp.0, "B", "b");

    let moved = drop_targets::update(
        &db,
        &root,
        &a.id,
        &drop_targets::DropTargetPatch {
            path: Some(tmp.0.join("b").to_string_lossy().into_owned()),
            ..Default::default()
        },
    );
    assert!(moved.is_err(), "把路径改成另一个已配置目录必须拒绝");

    std::fs::create_dir_all(tmp.0.join("c")).unwrap();
    let moved = drop_targets::update(
        &db,
        &root,
        &a.id,
        &drop_targets::DropTargetPatch {
            path: Some(tmp.0.join("c").to_string_lossy().into_owned()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(moved.path.ends_with("c"));
    assert_eq!(moved.name, "A", "改路径不改别名");
    assert_eq!(drop_targets::get(&db, &b.id).unwrap().name, "B");
}

#[test]
fn drop_copies_file_and_keeps_source() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let src_dir = tmp.0.join("src");
    std::fs::create_dir_all(&src_dir).unwrap();
    let src = write_source(&src_dir, "报告 2026.txt", b"hello");
    let target = add_target(&db, &root, &tmp.0, "归档", "out");

    let report = fsops::drop_paths(
        &db,
        &root,
        &target,
        &[src.to_string_lossy().into_owned()],
        "batch-1",
    )
    .unwrap();
    assert_eq!(report.success, 1, "{:?}", report.entries);
    assert_eq!(report.op, "copy");
    assert!(src.exists(), "复制模式必须保留源文件");
    let copied = tmp.0.join("out").join("报告 2026.txt");
    assert!(copied.exists());
    assert_eq!(std::fs::read(&copied).unwrap(), b"hello");
    assert_eq!(
        list(&db, &ListFilter { search: None, kind: "all".into(), group_id: "all".into(), favorite_only: false, limit: 10, offset: 0, sort: "default".into() })
            .unwrap()
            .total,
        0,
        "投递不得悄悄创建暂存记录"
    );
}

#[test]
fn drop_conflict_default_renames_and_skip_strategy_skips() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let src = write_source(&tmp.0, "重名.txt", b"new");
    let target = add_target(&db, &root, &tmp.0, "归档", "out");
    std::fs::write(tmp.0.join("out").join("重名.txt"), b"old").unwrap();

    let report = fsops::drop_paths(&db, &root, &target, &[src.to_string_lossy().into_owned()], "b1")
        .unwrap();
    assert_eq!(report.success, 1, "{:?}", report.entries);
    assert!(tmp.0.join("out").join("重名 (1).txt").exists());
    assert_eq!(
        std::fs::read(tmp.0.join("out").join("重名.txt")).unwrap(),
        b"old",
        "绝不覆盖已有同名文件"
    );

    let skip_target = drop_targets::create(
        &db,
        &root,
        "跳过",
        &tmp.0.join("out").to_string_lossy(),
        true,
        "copy",
        "skip",
    );
    // 同路径已存在配置会被拒绝：换一个目录验证 skip
    assert!(skip_target.is_err());
    std::fs::create_dir_all(tmp.0.join("out2")).unwrap();
    std::fs::write(tmp.0.join("out2").join("重名.txt"), b"old").unwrap();
    let skip_target = drop_targets::create(
        &db,
        &root,
        "跳过",
        &tmp.0.join("out2").to_string_lossy(),
        true,
        "copy",
        "skip",
    )
    .unwrap();
    let report = fsops::drop_paths(&db, &root, &skip_target, &[src.to_string_lossy().into_owned()], "b2")
        .unwrap();
    assert_eq!(report.skipped, 1, "{:?}", report.entries);
    assert_eq!(report.success, 0);
    assert_eq!(
        std::fs::read(tmp.0.join("out2").join("重名.txt")).unwrap(),
        b"old"
    );
}

#[test]
fn drop_folder_keeps_structure_and_empty_dirs() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let folder = tmp.0.join("项目");
    std::fs::create_dir_all(folder.join("子目录")).unwrap();
    std::fs::create_dir_all(folder.join("空目录")).unwrap();
    write_source(&folder, "a.txt", b"a");
    write_source(&folder.join("子目录"), "b.txt", b"b");
    let target = add_target(&db, &root, &tmp.0, "归档", "out");

    let report =
        fsops::drop_paths(&db, &root, &target, &[folder.to_string_lossy().into_owned()], "b1").unwrap();
    assert_eq!(report.success, 1, "{:?}", report.entries);
    let out = tmp.0.join("out").join("项目");
    assert!(out.join("a.txt").exists());
    assert!(out.join("子目录").join("b.txt").exists());
    assert!(out.join("空目录").is_dir(), "空目录必须保留");
    assert!(folder.exists(), "复制模式保留源目录");
}

#[test]
fn drop_move_removes_source_only_after_target_complete() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let src = write_source(&tmp.0, "移动.txt", b"payload");
    let dir = tmp.0.join("out");
    std::fs::create_dir_all(&dir).unwrap();
    let target = drop_targets::create(
        &db,
        &root,
        "移动目标",
        &dir.to_string_lossy(),
        true,
        "move",
        "rename",
    )
    .unwrap();

    let report =
        fsops::drop_paths(&db, &root, &target, &[src.to_string_lossy().into_owned()], "b1").unwrap();
    assert_eq!(report.success, 1, "{:?}", report.entries);
    assert_eq!(report.op, "move");
    assert!(!src.exists(), "移动模式必须清理源文件");
    assert_eq!(std::fs::read(dir.join("移动.txt")).unwrap(), b"payload");
}

#[test]
fn drop_skips_same_dir_and_duplicate_batch_entries() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let dir = tmp.0.join("out");
    std::fs::create_dir_all(&dir).unwrap();
    let inside = write_source(&dir, "already.txt", b"x");
    let target = add_target(&db, &root, &tmp.0, "归档", "out");

    let report = fsops::drop_paths(
        &db,
        &root,
        &target,
        &[
            inside.to_string_lossy().into_owned(),
            inside.to_string_lossy().into_owned(),
        ],
        "b1",
    )
    .unwrap();
    assert_eq!(report.total, 1, "同批次重复路径先去重");
    assert_eq!(report.skipped, 1, "{:?}", report.entries);
    assert_eq!(report.success, 0);
    assert!(!dir.join("already (1).txt").exists(), "同目录不得产生额外副本");
}

#[test]
fn drop_batch_partial_failure_isolated_and_missing_source_reported() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let ok = write_source(&tmp.0, "ok.txt", b"1");
    let gone = write_source(&tmp.0, "gone.txt", b"2");
    std::fs::remove_file(&gone).unwrap();
    let target = add_target(&db, &root, &tmp.0, "归档", "out");

    let report = fsops::drop_paths(
        &db,
        &root,
        &target,
        &[ok.to_string_lossy().into_owned(), gone.to_string_lossy().into_owned()],
        "b1",
    )
    .unwrap();
    assert_eq!(report.success, 1);
    assert_eq!(report.failed, 1);
    let failed = report.entries.iter().find(|e| e.status == "failed").unwrap();
    assert!(failed.reason.as_deref().unwrap().contains("已不存在"));
    assert!(tmp.0.join("out").join("ok.txt").exists());
}

#[test]
fn drop_parent_and_child_in_one_batch_processes_parent_only() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let folder = tmp.0.join("嵌套");
    std::fs::create_dir_all(&folder).unwrap();
    let child = write_source(&folder, "child.txt", b"c");
    let target = add_target(&db, &root, &tmp.0, "归档", "out");

    let report = fsops::drop_paths(
        &db,
        &root,
        &target,
        &[child.to_string_lossy().into_owned(), folder.to_string_lossy().into_owned()],
        "b1",
    )
    .unwrap();
    assert_eq!(report.success, 1, "{:?}", report.entries);
    assert_eq!(report.skipped, 1);
    assert!(tmp.0.join("out").join("嵌套").join("child.txt").exists());
    assert!(!tmp.0.join("out").join("child.txt").exists(), "子项不得被单独复制到根");
}

/// 移动模式下父目录被搬走后源路径已不存在：类型必须在操作前判定，子项不能误报失败。
#[test]
fn drop_move_parent_and_child_counts_child_as_carried_by_parent() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let folder = tmp.0.join("移动嵌套");
    std::fs::create_dir_all(folder.join("sub")).unwrap();
    let child = write_source(&folder, "child.txt", b"c");
    let grandchild = write_source(&folder.join("sub"), "deep.txt", b"d");
    let dir = tmp.0.join("moved");
    std::fs::create_dir_all(&dir).unwrap();
    let target = drop_targets::create(
        &db,
        &root,
        "移动目标",
        &dir.to_string_lossy(),
        true,
        "move",
        "rename",
    )
    .unwrap();

    let report = fsops::drop_paths(
        &db,
        &root,
        &target,
        &[
            grandchild.to_string_lossy().into_owned(),
            child.to_string_lossy().into_owned(),
            folder.to_string_lossy().into_owned(),
        ],
        "b-move-tree",
    )
    .unwrap();

    assert_eq!(report.total, 3);
    assert_eq!(report.success, 1, "{:?}", report.entries);
    assert_eq!(report.skipped, 2, "{:?}", report.entries);
    assert_eq!(report.failed, 0, "父目录移动成功不得把子项计入失败: {:?}", report.entries);
    assert_eq!(report.partial, 0);
    assert_eq!(
        report.success + report.skipped + report.failed + report.partial,
        report.total,
        "统计必须覆盖全部条目"
    );
    let out = dir.join("移动嵌套");
    assert_eq!(std::fs::read(out.join("child.txt")).unwrap(), b"c");
    assert_eq!(std::fs::read(out.join("sub").join("deep.txt")).unwrap(), b"d");
    assert!(!folder.exists(), "移动模式清理源目录");
}

/// 父目录部分完成（源清理失败）时，子项不得被无条件声称为成功。
#[test]
fn drop_partial_parent_marks_children_partial_with_recovery_hint() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let folder = tmp.0.join("部分完成");
    std::fs::create_dir_all(&folder).unwrap();
    let child = write_source(&folder, "child.txt", b"c");
    let dir = tmp.0.join("partial-out");
    std::fs::create_dir_all(&dir).unwrap();
    let target = drop_targets::create(
        &db,
        &root,
        "移动目标",
        &dir.to_string_lossy(),
        true,
        "move",
        "rename",
    )
    .unwrap();

    // 跨卷分支 + 源清理只删掉一个文件 → 父目录 partial（源可能残留）
    fsops::test_support::set_always("force_cross_volume");
    fsops::test_support::set_always("source_remove_partial_first");
    let report = fsops::drop_paths(
        &db,
        &root,
        &target,
        &[child.to_string_lossy().into_owned(), folder.to_string_lossy().into_owned()],
        "b-partial",
    )
    .unwrap();
    fsops::test_support::clear();

    assert_eq!(report.partial, 2, "{:?}", report.entries);
    assert_eq!(report.success, 0, "部分完成不得计入成功: {:?}", report.entries);
    assert_eq!(report.failed, 0);
    let child_entry = report
        .entries
        .iter()
        .find(|e| e.display_name == "child.txt")
        .unwrap();
    assert_eq!(child_entry.status, "partial");
    assert!(child_entry.reason.as_deref().unwrap().contains("部分完成"));
    assert!(child_entry.recovery.is_some(), "必须给出人工处理建议");
    assert!(child_entry.residual_source.is_some(), "必须指出可能残留的源");
    // 目标完整可用，源目录可能残留
    assert!(dir.join("部分完成").join("child.txt").exists());
}

/// 父目录处理失败时，同批次里互不相关的文件仍应正常完成。
#[test]
fn drop_parent_failure_does_not_block_unrelated_file() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let folder = tmp.0.join("坏目录");
    std::fs::create_dir_all(&folder).unwrap();
    write_source(&folder, "inside.txt", b"i");
    let independent = write_source(&tmp.0, "independent.txt", b"solo");
    let target = add_target(&db, &root, &tmp.0, "归档", "out");

    // 第一个复制操作（父目录）注入校验失败
    fsops::test_support::set_once("copy_corrupt");
    let report = fsops::drop_paths(
        &db,
        &root,
        &target,
        &[folder.to_string_lossy().into_owned(), independent.to_string_lossy().into_owned()],
        "b-fail",
    )
    .unwrap();
    fsops::test_support::clear();

    assert_eq!(report.failed, 1, "{:?}", report.entries);
    assert_eq!(report.success, 1, "{:?}", report.entries);
    let failed = report.entries.iter().find(|e| e.status == "failed").unwrap();
    assert_eq!(failed.display_name, "坏目录");
    assert!(
        !tmp.0.join("out").join("坏目录").exists(),
        "校验失败的临时目录必须回收，不得留下半成品"
    );
    assert_eq!(
        std::fs::read(tmp.0.join("out").join("independent.txt")).unwrap(),
        b"solo"
    );
}

/// 同名目录 + 自动重命名：绝不覆盖已有目录。
#[test]
fn drop_folder_conflict_renames_without_overwriting_existing_directory() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let folder = tmp.0.join("项目");
    std::fs::create_dir_all(&folder).unwrap();
    write_source(&folder, "new.txt", b"new");
    let target = add_target(&db, &root, &tmp.0, "归档", "out");
    let existing = tmp.0.join("out").join("项目");
    std::fs::create_dir_all(&existing).unwrap();
    std::fs::write(existing.join("keep.txt"), b"keep").unwrap();

    let report =
        fsops::drop_paths(&db, &root, &target, &[folder.to_string_lossy().into_owned()], "b-dup")
            .unwrap();
    assert_eq!(report.success, 1, "{:?}", report.entries);
    assert_eq!(
        std::fs::read(existing.join("keep.txt")).unwrap(),
        b"keep",
        "已有同名目录不得被替换"
    );
    assert!(tmp.0.join("out").join("项目 (1)").join("new.txt").exists());
}

/// 同名策略为 skip 时，父目录整体跳过，子项不能被单独复制到目标根目录。
#[test]
fn drop_skipped_parent_does_not_copy_children_separately() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let folder = tmp.0.join("项目");
    std::fs::create_dir_all(&folder).unwrap();
    let child = write_source(&folder, "child.txt", b"c");
    std::fs::create_dir_all(tmp.0.join("out").join("项目")).unwrap();
    let target = drop_targets::create(
        &db,
        &root,
        "跳过",
        &tmp.0.join("out").to_string_lossy(),
        true,
        "copy",
        "skip",
    )
    .unwrap();

    let report = fsops::drop_paths(
        &db,
        &root,
        &target,
        &[child.to_string_lossy().into_owned(), folder.to_string_lossy().into_owned()],
        "b-skip-tree",
    )
    .unwrap();
    assert_eq!(report.skipped, 2, "{:?}", report.entries);
    assert_eq!(report.success, 0, "{:?}", report.entries);
    assert_eq!(report.failed, 0);
    assert!(
        !tmp.0.join("out").join("child.txt").exists(),
        "父目录整体跳过时，子项不得被单独复制"
    );
    assert!(child.exists(), "跳过不删除源");
}

#[test]
fn drop_rejects_unavailable_target_without_touching_any_file() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let src = write_source(&tmp.0, "a.txt", b"a");
    let target = add_target(&db, &root, &tmp.0, "归档", "out");
    // 目录在配置之后消失（外接盘拔出 / 网络盘断开）
    std::fs::remove_dir_all(tmp.0.join("out")).unwrap();

    let err = fsops::drop_paths(&db, &root, &target, &[src.to_string_lossy().into_owned()], "b1")
        .unwrap_err();
    assert!(err.to_string().contains("不可用"), "{err}");
    assert!(src.exists());
    assert!(!tmp.0.join("out").exists());
}

#[test]
fn drop_unknown_target_id_is_rejected_by_command_layer_path() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    assert!(drop_targets::get(&db, "no-such-id").is_err());
    assert!(drop_targets::resolve_dir(&db, &tmp.shelf(), "no-such-id").is_err());
}

// ── 排序边界（重复/不连续 sort_order） ──────────────────────

fn ids(list: &[drop_targets::DropTarget]) -> Vec<&str> {
    list.iter().map(|t| t.id.as_str()).collect()
}

/// 直接改库：模拟历史数据 / 备份导入后的 sort_order（create 永远分配 max+1）。
fn force_order(db: &Db, id: &str, sort: i64, created: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE shelf_drop_targets SET sort_order = ?1, created_at = ?2 WHERE id = ?3",
            params![sort, created, id],
        )?;
        Ok(())
    })
    .unwrap();
}

fn stored_orders(db: &Db) -> Vec<i64> {
    db.with_read(|conn| {
        let mut stmt =
            conn.prepare("SELECT sort_order FROM shelf_drop_targets ORDER BY sort_order ASC, created_at ASC, id ASC")?;
        let it = stmt.query_map([], |r| r.get::<_, i64>(0))?;
        it.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })
    .unwrap()
}

#[test]
fn drop_target_reorder_handles_duplicate_sort_orders_and_boundaries() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let a = add_target(&db, &root, &tmp.0, "A", "a");
    let b = add_target(&db, &root, &tmp.0, "B", "b");
    let c = add_target(&db, &root, &tmp.0, "C", "c");
    // 三行 sort_order 完全相同：旧实现交换相同值 = 空操作
    for (t, created) in [(&a, "2026-01-01T00:00:01Z"), (&b, "2026-01-01T00:00:02Z"), (&c, "2026-01-01T00:00:03Z")] {
        force_order(&db, &t.id, 5, created);
    }
    assert_eq!(
        ids(&drop_targets::list(&db).unwrap()),
        vec![a.id.as_str(), b.id.as_str(), c.id.as_str()]
    );

    let moved = drop_targets::reorder(&db, &c.id.as_str(), "up").unwrap();
    assert_eq!(ids(&moved), vec![a.id.as_str(), c.id.as_str(), b.id.as_str()], "重复排序值也必须真正上移");
    assert_eq!(stored_orders(&db), vec![0, 1, 2], "顺带规范化为连续序号");
    // 名称/路径/模式不受影响
    assert_eq!(moved[1].name, "C");
    assert_eq!(moved[1].path, c.path);
    assert_eq!(moved[1].op_mode, "copy");

    // 继续上移到首位，再点一次是幂等的
    let moved = drop_targets::reorder(&db, &c.id.as_str(), "up").unwrap();
    assert_eq!(ids(&moved), vec![c.id.as_str(), a.id.as_str(), b.id.as_str()]);
    let again = drop_targets::reorder(&db, &c.id.as_str(), "up").unwrap();
    assert_eq!(ids(&again), vec![c.id.as_str(), a.id.as_str(), b.id.as_str()], "首位继续上移不报错也不改变顺序");

    // 下移回中间，再到末位，末位继续下移幂等
    assert_eq!(ids(&drop_targets::reorder(&db, &c.id.as_str(), "down").unwrap()), vec![a.id.as_str(), c.id.as_str(), b.id.as_str()]);
    assert_eq!(ids(&drop_targets::reorder(&db, &c.id.as_str(), "down").unwrap()), vec![a.id.as_str(), b.id.as_str(), c.id.as_str()]);
    assert_eq!(ids(&drop_targets::reorder(&db, &c.id.as_str(), "down").unwrap()), vec![a.id.as_str(), b.id.as_str(), c.id.as_str()]);
}

#[test]
fn drop_target_reorder_normalizes_sparse_sort_orders() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let a = add_target(&db, &root, &tmp.0, "A", "a");
    let b = add_target(&db, &root, &tmp.0, "B", "b");
    let c = add_target(&db, &root, &tmp.0, "C", "c");
    force_order(&db, &a.id.as_str(), 10, "2026-01-01T00:00:01Z");
    force_order(&db, &b.id.as_str(), 20, "2026-01-01T00:00:02Z");
    force_order(&db, &c.id.as_str(), 30, "2026-01-01T00:00:03Z");

    let moved = drop_targets::reorder(&db, &b.id.as_str(), "up").unwrap();
    assert_eq!(ids(&moved), vec![b.id.as_str(), a.id.as_str(), c.id.as_str()]);
    assert_eq!(stored_orders(&db), vec![0, 1, 2]);
}

#[test]
fn drop_target_reorder_after_middle_delete_keeps_remaining_order() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    let a = add_target(&db, &root, &tmp.0, "A", "a");
    let b = add_target(&db, &root, &tmp.0, "B", "b");
    let c = add_target(&db, &root, &tmp.0, "C", "c");
    drop_targets::delete(&db, &b.id.as_str()).unwrap();

    assert_eq!(ids(&drop_targets::list(&db).unwrap()), vec![a.id.as_str(), c.id.as_str()]);
    // 剩余两行 sort_order 是 0/2（删除后不连续）：上移仍必须生效
    let moved = drop_targets::reorder(&db, &c.id.as_str(), "up").unwrap();
    assert_eq!(ids(&moved), vec![c.id.as_str(), a.id.as_str()]);
    assert_eq!(stored_orders(&db), vec![0, 1]);
}

#[test]
fn drop_target_reorder_is_safe_under_concurrent_clicks() {
    use std::sync::Arc;
    let tmp = TempRoot::new();
    let db = Arc::new(Db::open_in_memory().unwrap());
    let root = tmp.shelf();
    let a = add_target(&db, &root, &tmp.0, "A", "a");
    let b = add_target(&db, &root, &tmp.0, "B", "b");
    let c = add_target(&db, &root, &tmp.0, "C", "c");

    let handles: Vec<_> = [b.id.clone(), c.id.clone(), a.id.clone()]
        .into_iter()
        .map(|id| {
            let db = Arc::clone(&db);
            std::thread::spawn(move || {
                for i in 0..20 {
                    let dir = if i % 2 == 0 { "up" } else { "down" };
                    drop_targets::reorder(&db, &id, dir).unwrap();
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }

    // 并发点击后：三个目标一个不少、sort_order 仍是 0..n-1 的排列
    let list = drop_targets::list(&db).unwrap();
    let mut got: Vec<&str> = ids(&list);
    got.sort_unstable();
    let mut want = vec![a.id.as_str(), b.id.as_str(), c.id.as_str()];
    want.sort_unstable();
    assert_eq!(got, want);
    assert_eq!(stored_orders(&db), vec![0, 1, 2]);
}

#[test]
fn drop_limits_target_count() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let root = tmp.shelf();
    for i in 0..drop_targets::MAX_DROP_TARGETS {
        let dir = tmp.0.join(format!("t{i}"));
        std::fs::create_dir_all(&dir).unwrap();
        drop_targets::create(&db, &root, "", &dir.to_string_lossy(), true, "", "").unwrap();
    }
    let extra = tmp.0.join("extra");
    std::fs::create_dir_all(&extra).unwrap();
    let err = drop_targets::create(&db, &root, "", &extra.to_string_lossy(), true, "", "")
        .unwrap_err();
    assert!(err.to_string().contains("最多"));
}

#[test]
fn drop_journal_recovery_cleans_only_own_part_file() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let src = write_source(&tmp.0, "src.txt", b"payload");
    let dir = tmp.0.join("out");
    std::fs::create_dir_all(&dir).unwrap();
    let part = dir.join(".src.txt.deadbeef.shelf-part");
    std::fs::write(&part, b"partial").unwrap();

    // 构造「复制中断」现场：日志指向本次临时副本
    let journal_id = "j-drop-1";
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO shelf_file_ops (id, item_id, op, phase, source, target, created_at) \
             VALUES (?1, ?2, 'copy', 'intent', ?3, ?4, ?5)",
            params![
                journal_id,
                "drop:batch-x",
                src.to_string_lossy(),
                part.to_string_lossy(),
                "2026-01-01T00:00:00Z"
            ],
        )?;
        Ok(())
    })
    .unwrap();

    fsops::recover_pending_file_ops(&db);
    assert!(src.exists(), "恢复不得删除源文件");
    assert!(!part.exists(), "应清理本批次自己的临时副本");
    let left: i64 = db
        .with_read(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM shelf_file_ops", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(left, 0, "安全终态后应清掉日志");
}

#[test]
fn recent_sort_ignores_pinned_and_is_stable() {
    let tmp = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let pinned_at = "2020-01-01T00:00:00.000Z";

    let mut old = Vec::new();
    for i in 0..10 {
        let src = write_source(&tmp.0, &format!("old-{i}.txt"), b"old");
        old.push(add_ref(&db, &tmp.shelf(), &src));
    }
    // 10 条旧条目全部置顶，并把创建时间压到 2020：
    // 若最近查询仍带 pinned 优先，新条目会被挤出前 4。
    db.with_conn(|conn| {
        for item in &old {
            conn.execute(
                "UPDATE shelf_items SET pinned = 1, created_at = ?1 WHERE id = ?2",
                rusqlite::params![pinned_at, item.id],
            )?;
        }
        Ok(())
    })
    .unwrap();

    let newest = add_ref(
        &db,
        &tmp.shelf(),
        &write_source(&tmp.0, "newest.txt", b"new"),
    );

    let recent = list(
        &db,
        &ListFilter {
            sort: "recent".into(),
            limit: 4,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        recent.items[0].id, newest.id,
        "最近列表第一条必须是刚添加的普通条目"
    );
    assert!(!recent.items[0].pinned);
    assert_eq!(recent.items.len(), 4);

    // 默认排序保持原语义：置顶优先，不被 recent 参数改变。
    let normal = list(
        &db,
        &ListFilter {
            limit: 4,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(normal.items[0].pinned, "默认排序仍应置顶优先");
    assert_ne!(normal.items[0].id, newest.id);

    // 相同 created_at 时按 id DESC 稳定排列，重复查询结果一致。
    let all = list(
        &db,
        &ListFilter {
            sort: "recent".into(),
            limit: 100,
            ..Default::default()
        },
    )
    .unwrap();
    let same_time: Vec<&str> = all
        .items
        .iter()
        .filter(|i| i.created_at == pinned_at)
        .map(|i| i.id.as_str())
        .collect();
    let mut expected = same_time.clone();
    expected.sort_by(|a, b| b.cmp(a));
    assert_eq!(same_time, expected, "同时间条目必须按 id 倒序稳定排列");

    assert!(
        list(
            &db,
            &ListFilter {
                sort: "bogus".into(),
                ..Default::default()
            }
        )
        .is_err(),
        "未知排序参数必须明确报错，不能静默改变语义"
    );
}
