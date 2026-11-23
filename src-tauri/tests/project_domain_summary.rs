//! 项目中枢专业领域摘要（漫剧 / 游戏）聚合接口集成测试：真实迁移 + 真实 SQLite。
//!
//! 覆盖：空项目零值、真实状态条件统计、跨项目隔离、状态更新后重算、归档只读、未知/错类型报错。
//! 放在 `tests/` 是因为它验证的是「跨表聚合 SQL + 项目作用域」这一数据契约，
//! 与 `tests/project_hub_service.rs` 同层级；不依赖 Tauri 运行时与任何外部素材目录。

use std::fs;
use std::path::{Path, PathBuf};

use task_dock_lib::commands::comic_workspace::{
    comic_character_save_impl, comic_episode_save_impl, comic_media_adopt_impl,
    comic_media_import_impl, comic_overview_stats_impl, comic_scene_save_impl, comic_shot_list_impl,
    comic_shot_save_impl, ComicShot,
};
use task_dock_lib::commands::game_workspace::{
    game_asset_save_impl, game_build_save_impl, game_overview_stats_impl, game_test_save_impl,
};
use task_dock_lib::commands::project_workspace::{
    workspace_project_save_impl, workspace_project_set_status_impl, WorkspaceProject,
};
use task_dock_lib::db::Db;
use task_dock_lib::error::AppError;

fn memdb() -> Db {
    Db::open_in_memory().expect("打开内存库")
}

fn project(db: &Db, name: &str, kind: &str) -> WorkspaceProject {
    workspace_project_save_impl(
        db,
        None,
        name.to_string(),
        kind.to_string(),
        None,
        None,
        None,
    )
    .expect("创建项目")
}

fn comic_project(db: &Db, name: &str) -> WorkspaceProject {
    project(db, name, "ai_comic")
}

fn game_project(db: &Db, name: &str) -> WorkspaceProject {
    project(db, name, "game")
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "td-domain-summary-{}-{}",
        tag,
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

fn comic_shot(
    db: &Db,
    project_id: &str,
    episode_id: &str,
    shot_no: i64,
    status: &str,
) -> ComicShot {
    comic_shot_save_impl(
        db,
        None,
        project_id.to_string(),
        episode_id.to_string(),
        Some(shot_no),
        format!("镜头 {shot_no}"),
        None,
        None,
        String::new(),
        String::new(),
        String::new(),
        None,
        status.to_string(),
        None,
        String::new(),
        None,
    )
    .expect("保存分镜")
}

#[test]
fn comic_overview_stats_aggregates_real_states_and_isolates_projects() {
    let db = memdb();
    let a = comic_project(&db, "摘要漫剧 A");
    let b = comic_project(&db, "摘要漫剧 B");

    let c1 = comic_character_save_impl(
        &db,
        None,
        a.id.clone(),
        "黑发少年".into(),
        "小前锋".into(),
        String::new(),
        None,
        None,
    )
    .unwrap();
    comic_character_save_impl(
        &db,
        None,
        a.id.clone(),
        "队友".into(),
        "后卫".into(),
        String::new(),
        None,
        None,
    )
    .unwrap();
    comic_scene_save_impl(
        &db,
        None,
        a.id.clone(),
        "篮球场".into(),
        String::new(),
        None,
        None,
    )
    .unwrap();

    let ep1 = comic_episode_save_impl(
        &db,
        None,
        a.id.clone(),
        Some(1),
        "第一集".into(),
        String::new(),
        String::new(),
        "done".to_string(),
        100,
        None,
        None,
    )
    .unwrap();
    let ep2 = comic_episode_save_impl(
        &db,
        None,
        a.id.clone(),
        Some(2),
        "第二集".into(),
        String::new(),
        String::new(),
        "storyboard".to_string(),
        40,
        None,
        None,
    )
    .unwrap();

    // 四个分镜覆盖 todo / doing / blocked / done 四种真实状态。
    let sh_done = comic_shot(&db, &a.id, &ep1.id, 1, "done");
    let sh_doing = comic_shot(&db, &a.id, &ep1.id, 2, "doing");
    let _sh_todo = comic_shot(&db, &a.id, &ep2.id, 1, "todo");
    let _sh_blocked = comic_shot(&db, &a.id, &ep2.id, 2, "blocked");

    let m1 = comic_media_import_impl(
        &db,
        None,
        a.id.clone(),
        Some(sh_done.id.clone()),
        None,
        None,
        "C:/fixtures/summary-a.png".into(),
        "image".into(),
        None,
        None,
    )
    .unwrap();
    let _m2 = comic_media_import_impl(
        &db,
        None,
        a.id.clone(),
        Some(sh_doing.id.clone()),
        None,
        None,
        "C:/fixtures/summary-b.png".into(),
        "image".into(),
        None,
        None,
    )
    .unwrap();
    // 边界：素材只关联角色（无镜头）时同样计入 mediaCount，且不影响分镜统计。
    let _m3 = comic_media_import_impl(
        &db,
        None,
        a.id.clone(),
        None,
        Some(c1.id.clone()),
        None,
        "C:/fixtures/summary-c.png".into(),
        "image".into(),
        None,
        None,
    )
    .unwrap();
    comic_media_adopt_impl(&db, &m1.id).unwrap();

    let stats = comic_overview_stats_impl(&db, &a.id).unwrap();
    assert_eq!(stats.project_id, a.id);
    assert_eq!(stats.episode_count, 2);
    assert_eq!(stats.completed_episode_count, 1);
    assert_eq!(stats.shot_count, 4);
    assert_eq!(stats.completed_shot_count, 1);
    assert_eq!(stats.doing_shot_count, 1);
    assert_eq!(stats.pending_shot_count, 1);
    assert_eq!(stats.blocked_shot_count, 1);
    assert_eq!(stats.character_count, 2);
    assert_eq!(stats.scene_count, 1);
    assert_eq!(stats.media_count, 3);
    assert_eq!(stats.adopted_media_count, 1);
    assert!(stats.updated_at.is_some(), "有数据时必须有真实更新时间");

    // 项目 B 从未写入：全部真实零值，且没有可冒充的「更新时间」。
    let empty = comic_overview_stats_impl(&db, &b.id).unwrap();
    assert_eq!(empty.project_id, b.id);
    assert_eq!(empty.episode_count, 0);
    assert_eq!(empty.completed_episode_count, 0);
    assert_eq!(empty.shot_count, 0);
    assert_eq!(empty.completed_shot_count, 0);
    assert_eq!(empty.pending_shot_count, 0);
    assert_eq!(empty.doing_shot_count, 0);
    assert_eq!(empty.blocked_shot_count, 0);
    assert_eq!(empty.character_count, 0);
    assert_eq!(empty.scene_count, 0);
    assert_eq!(empty.media_count, 0);
    assert_eq!(empty.adopted_media_count, 0);
    assert!(empty.updated_at.is_none(), "空项目不能伪造更新时间");

    // 隔离：给 B 写一条剧集后，A 的计数不能变化，B 只增加自己的。
    let ep_b = comic_episode_save_impl(
        &db,
        None,
        b.id.clone(),
        Some(1),
        "B 第一集".into(),
        String::new(),
        String::new(),
        "draft".to_string(),
        0,
        None,
        None,
    )
    .unwrap();
    let after = comic_overview_stats_impl(&db, &a.id).unwrap();
    assert_eq!(after.episode_count, 2, "B 的数据不能进入 A");
    assert_eq!(after.shot_count, 4);
    let b_after = comic_overview_stats_impl(&db, &b.id).unwrap();
    assert_eq!(b_after.episode_count, 1);
    assert_eq!(b_after.shot_count, 0);
    assert!(b_after.updated_at.is_some());
    let a_shots = comic_shot_list_impl(&db, &a.id, None).unwrap();
    assert!(!a_shots.iter().any(|shot| shot.episode_id == ep_b.id));
}

#[test]
fn comic_overview_stats_follow_status_updates_and_read_archived_projects() {
    let db = memdb();
    let project = comic_project(&db, "摘要漫剧 状态");
    let ep = comic_episode_save_impl(
        &db,
        None,
        project.id.clone(),
        Some(1),
        "第一集".into(),
        String::new(),
        String::new(),
        "draft".to_string(),
        0,
        None,
        None,
    )
    .unwrap();
    let shot = comic_shot(&db, &project.id, &ep.id, 1, "todo");

    let before = comic_overview_stats_impl(&db, &project.id).unwrap();
    assert_eq!(before.completed_episode_count, 0);
    assert_eq!(before.completed_shot_count, 0);
    assert_eq!(before.pending_shot_count, 1);

    // 真实改状态后统计必须跟着变（不是缓存的旧值）。
    comic_shot_save_impl(
        &db,
        Some(shot.id.clone()),
        project.id.clone(),
        ep.id.clone(),
        Some(1),
        "镜头 1".into(),
        None,
        None,
        String::new(),
        String::new(),
        String::new(),
        None,
        "done".to_string(),
        None,
        String::new(),
        None,
    )
    .unwrap();
    comic_episode_save_impl(
        &db,
        Some(ep.id.clone()),
        project.id.clone(),
        Some(1),
        "第一集".into(),
        String::new(),
        String::new(),
        "done".to_string(),
        100,
        None,
        None,
    )
    .unwrap();

    let after = comic_overview_stats_impl(&db, &project.id).unwrap();
    assert_eq!(after.completed_episode_count, 1);
    assert_eq!(after.completed_shot_count, 1);
    assert_eq!(after.pending_shot_count, 0);

    // 归档项目：概览仍可读（只读不等于不可见）。
    workspace_project_set_status_impl(&db, &project.id, "archived".into()).unwrap();
    let archived = comic_overview_stats_impl(&db, &project.id).unwrap();
    assert_eq!(archived.shot_count, 1);
    assert_eq!(archived.completed_shot_count, 1);
}

#[test]
fn comic_overview_stats_rejects_unknown_and_wrong_kind_projects() {
    let db = memdb();
    let comic = comic_project(&db, "摘要漫剧 校验");
    let novel = project(&db, "小说项目", "novel");

    assert!(comic_overview_stats_impl(&db, &comic.id).is_ok());
    assert!(matches!(
        comic_overview_stats_impl(&db, &novel.id),
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        comic_overview_stats_impl(&db, "missing-project"),
        Err(AppError::NotFound(_))
    ));
    assert!(comic_overview_stats_impl(&db, "   ").is_err());
}

fn asset(db: &Db, project_id: &str, kind: &str, name: &str, path: &Path) {
    game_asset_save_impl(
        db,
        None,
        project_id.to_string(),
        kind.to_string(),
        name.to_string(),
        path.to_string_lossy().into_owned(),
        None,
        None,
    )
    .expect("保存游戏资源");
}

fn build(db: &Db, project_id: &str, target: &str, status: &str, built_at: &str) {
    game_build_save_impl(
        db,
        None,
        project_id.to_string(),
        target.to_string(),
        None,
        None,
        status.to_string(),
        Some(built_at.to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .expect("保存构建记录");
}

fn test_run(db: &Db, project_id: &str, title: &str, result: &str) {
    game_test_save_impl(
        db,
        None,
        project_id.to_string(),
        None,
        title.to_string(),
        None,
        result.to_string(),
        None,
        None,
        None,
        None,
        None,
    )
    .expect("保存测试记录");
}

#[test]
fn game_overview_stats_aggregates_builds_tests_and_isolates_projects() {
    let db = memdb();
    let root = temp_dir("stats");
    let asset_file = root.join("cover.png");
    fs::write(&asset_file, b"fixture").unwrap();

    let a = game_project(&db, "摘要游戏 A");
    let b = game_project(&db, "摘要游戏 B");

    asset(&db, &a.id, "image", "封面", &asset_file);
    asset(&db, &a.id, "audio", "BGM", &asset_file);

    // 三条构建：成功 / 失败 / 计划中；最近一次按 built_at 真实排序（失败的最新）。
    build(&db, &a.id, "Windows", "success", "2026-11-01T10:00:00+08:00");
    build(&db, &a.id, "Windows", "planned", "2026-11-05T10:00:00+08:00");
    build(&db, &a.id, "Linux", "failed", "2026-11-10T10:00:00+08:00");

    test_run(&db, &a.id, "冒烟", "passed");
    test_run(&db, &a.id, "关卡回归", "failed");
    test_run(&db, &a.id, "性能", "blocked");

    let stats = game_overview_stats_impl(&db, &a.id).unwrap();
    assert_eq!(stats.project_id, a.id);
    assert_eq!(stats.asset_count, 2);
    assert_eq!(stats.build_count, 3);
    assert_eq!(stats.successful_build_count, 1);
    assert_eq!(stats.failed_build_count, 1);
    assert_eq!(stats.planned_build_count, 1);
    assert_eq!(stats.test_count, 3);
    assert_eq!(stats.passed_test_count, 1);
    assert_eq!(stats.failed_test_count, 1);
    assert_eq!(stats.blocked_test_count, 1);
    assert_eq!(
        stats.latest_build_at.as_deref(),
        Some("2026-11-10T10:00:00+08:00"),
        "最近一次构建必须按真实构建时间排序"
    );
    assert_eq!(stats.latest_build_status.as_deref(), Some("failed"));
    assert!(stats.updated_at.is_some());

    // 空项目：真实零值，最近构建与更新时间都是 None（不用 0 或默认状态掩盖）。
    let empty = game_overview_stats_impl(&db, &b.id).unwrap();
    assert_eq!(empty.asset_count, 0);
    assert_eq!(empty.build_count, 0);
    assert_eq!(empty.successful_build_count, 0);
    assert_eq!(empty.failed_build_count, 0);
    assert_eq!(empty.planned_build_count, 0);
    assert_eq!(empty.test_count, 0);
    assert_eq!(empty.passed_test_count, 0);
    assert_eq!(empty.failed_test_count, 0);
    assert_eq!(empty.blocked_test_count, 0);
    assert!(empty.latest_build_at.is_none());
    assert!(empty.latest_build_status.is_none());
    assert!(empty.updated_at.is_none());

    // 交叉隔离：给 B 写一条失败构建与一条通过测试，A 的计数不变。
    build(&db, &b.id, "Windows", "failed", "2026-11-20T10:00:00+08:00");
    test_run(&db, &b.id, "B 自带测试", "passed");
    let a_after = game_overview_stats_impl(&db, &a.id).unwrap();
    assert_eq!(a_after.build_count, 3, "B 的构建不能进入 A");
    assert_eq!(a_after.test_count, 3);
    assert_eq!(a_after.failed_build_count, 1);
    let b_after = game_overview_stats_impl(&db, &b.id).unwrap();
    assert_eq!(b_after.build_count, 1);
    assert_eq!(b_after.failed_build_count, 1);
    assert_eq!(b_after.passed_test_count, 1);
    assert!(b_after.latest_build_at.is_some());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn game_overview_stats_follow_updates_and_read_archived_projects() {
    let db = memdb();
    let project = game_project(&db, "摘要游戏 状态");
    build(&db, &project.id, "Windows", "planned", "2026-11-01T10:00:00+08:00");
    let test_id = game_test_save_impl(
        &db,
        None,
        project.id.clone(),
        None,
        "冒烟".into(),
        None,
        "unknown".into(),
        None,
        None,
        None,
        None,
        None,
    )
    .unwrap()
    .id;

    let before = game_overview_stats_impl(&db, &project.id).unwrap();
    assert_eq!(before.successful_build_count, 0);
    assert_eq!(before.planned_build_count, 1);
    assert_eq!(before.failed_test_count, 0);

    // 真实改状态后统计跟着变（不是列表接口拼出来的旧值）。
    let build_id: String = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT id FROM game_builds WHERE project_id = ?1 LIMIT 1",
                [&project.id],
                |r| r.get::<_, String>(0),
            )
            .map_err(AppError::from)
        })
        .unwrap();
    game_build_save_impl(
        &db,
        Some(build_id),
        project.id.clone(),
        "Windows".into(),
        None,
        None,
        "success".to_string(),
        Some("2026-11-02T10:00:00+08:00".to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .unwrap();
    game_test_save_impl(
        &db,
        Some(test_id),
        project.id.clone(),
        None,
        "冒烟".into(),
        None,
        "failed".to_string(),
        None,
        None,
        None,
        None,
        None,
    )
    .unwrap();

    let after = game_overview_stats_impl(&db, &project.id).unwrap();
    assert_eq!(after.successful_build_count, 1);
    assert_eq!(after.planned_build_count, 0);
    assert_eq!(after.failed_test_count, 1);
    assert_eq!(after.latest_build_status.as_deref(), Some("success"));

    // 归档项目仍可读概览（只读不等于不可见）。
    workspace_project_set_status_impl(&db, &project.id, "archived".into()).unwrap();
    let archived = game_overview_stats_impl(&db, &project.id).unwrap();
    assert_eq!(archived.build_count, 1);
    assert_eq!(archived.successful_build_count, 1);
    assert_eq!(archived.latest_build_status.as_deref(), Some("success"));
}

#[test]
fn game_overview_stats_rejects_unknown_and_wrong_kind_projects() {
    let db = memdb();
    let game = game_project(&db, "摘要游戏 校验");
    let comic = comic_project(&db, "漫剧项目");

    assert!(game_overview_stats_impl(&db, &game.id).is_ok());
    assert!(matches!(
        game_overview_stats_impl(&db, &comic.id),
        Err(AppError::Validation(_))
    ));
    assert!(matches!(
        game_overview_stats_impl(&db, "missing-project"),
        Err(AppError::NotFound(_))
    ));
    assert!(game_overview_stats_impl(&db, "   ").is_err());
}
