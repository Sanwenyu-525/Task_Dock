//! 剪贴板来源快照的数据库级验收（不依赖真实剪贴板，可在隔离 target 中运行）。
//!
//! 覆盖：同来源重复采集、Chrome→Snipaste（新标题为空）、Snipaste→Chrome、
//! 已知→unknown、**真正从 unknown 起步的升级路径**（→foreground / →owner）、
//! owner→foreground、foreground→owner、旧记录空 `source_kind` 补齐、
//! 同内容跨应用重复复制的次数/去重/排序语义、`last_seen_at` 行为，
//! 以及每次更新后三字段的一致性。

use std::path::PathBuf;

use chrono::DateTime;
use task_dock_lib::clipboard::store::{self, ClipboardFilter};
use task_dock_lib::clipboard::{ClipboardItem, CapturedContent};
use task_dock_lib::db::{Db, Settings};

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("td-source-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn text(app: &str, title: &str, kind: &str) -> CapturedContent {
    text_with("来源快照验收 · 跨应用同内容", app, title, kind)
}

fn text_with(body: &str, app: &str, title: &str, kind: &str) -> CapturedContent {
    CapturedContent {
        kind: "text".into(),
        text: body.into(),
        html: String::new(),
        preview: String::new(),
        file_paths: vec![],
        image: None,
        source_app: app.into(),
        source_title: title.into(),
        source_kind: kind.into(),
        byte_size: 0,
    }
}

fn known(app: &str) -> bool {
    let app = app.trim();
    !app.is_empty() && !app.eq_ignore_ascii_case("unknown")
}

fn assert_consistent(item: &ClipboardItem, label: &str) {
    if known(&item.source_app) {
        assert!(
            matches!(item.source_kind.as_str(), "owner" | "foreground"),
            "{label}：已知应用 {} 的识别方式无效：{:?}",
            item.source_app,
            item.source_kind
        );
    } else {
        assert!(
            item.source_title.is_empty(),
            "{label}：未知来源不得保留标题 {:?}",
            item.source_title
        );
        assert!(
            matches!(item.source_kind.as_str(), "" | "unknown"),
            "{label}：未知来源的识别方式只能是空串或 unknown，实际 {:?}",
            item.source_kind
        );
    }
}

#[test]
fn source_snapshot_is_replaced_as_a_whole() {
    let tmp = TempRoot::new();
    let root = tmp.0.join("clipboard");
    let db = Db::open(&tmp.0.join("app.db")).expect("隔离数据库");
    let settings = Settings::default();

    let id = store::record_capture(
        &db,
        &root,
        &text("chrome.exe", "OpenCode Console", "owner"),
        &settings,
    )
    .expect("首采");
    assert!(id.created);
    assert_eq!(id.item.source_kind, "owner");
    let item_id = id.item.id.clone();

    // 同来源重复采集
    let same = store::record_capture(
        &db,
        &root,
        &text("chrome.exe", "OpenCode Console", "owner"),
        &settings,
    )
    .unwrap();
    assert!(!same.created);
    assert_eq!(same.item.copy_count, 2);
    assert_eq!(same.item.source_title, "OpenCode Console");

    // Chrome → Snipaste，标题为空：不得保留 Chrome 的旧标题
    let snip = store::record_capture(
        &db,
        &root,
        &text("snipaste.exe", "", "owner"),
        &settings,
    )
    .unwrap();
    assert_eq!(snip.item.source_app, "snipaste.exe");
    assert_eq!(snip.item.source_title, "");
    assert_consistent(&snip.item, "Chrome→Snipaste");

    // Snipaste → Chrome，且识别方式从 owner 变为 foreground
    let chrome = store::record_capture(
        &db,
        &root,
        &text("chrome.exe", "OpenCode Console", "foreground"),
        &settings,
    )
    .unwrap();
    assert_eq!(chrome.item.source_app, "chrome.exe");
    assert_eq!(chrome.item.source_title, "OpenCode Console");
    assert_eq!(chrome.item.source_kind, "foreground");

    // foreground → owner
    let owner = store::record_capture(
        &db,
        &root,
        &text("chrome.exe", "OpenCode Console", "owner"),
        &settings,
    )
    .unwrap();
    assert_eq!(owner.item.source_kind, "owner");

    // 已知 → unknown：保留可信旧来源
    let unknown = store::record_capture(
        &db,
        &root,
        &text("unknown", "", "unknown"),
        &settings,
    )
    .unwrap();
    assert_eq!(unknown.item.source_app, "chrome.exe");
    assert_eq!(unknown.item.source_title, "OpenCode Console");
    assert_eq!(unknown.item.source_kind, "owner");

    // 空串来源同样不得覆盖
    let blank = store::record_capture(&db, &root, &text("", "", ""), &settings).unwrap();
    assert_eq!(blank.item.source_app, "chrome.exe");

    // unknown → 已知
    let edge = store::record_capture(
        &db,
        &root,
        &text("msedge.exe", "Edge 窗口", "foreground"),
        &settings,
    )
    .unwrap();
    assert_eq!(edge.item.source_app, "msedge.exe");
    assert_eq!(edge.item.source_title, "Edge 窗口");
    assert_eq!(edge.item.source_kind, "foreground");

    // 应用已知但识别方式缺失的半快照不得替换旧快照
    let half = store::record_capture(
        &db,
        &root,
        &text("notepad.exe", "记事本", ""),
        &settings,
    )
    .unwrap();
    assert_eq!(half.item.source_app, "msedge.exe");
    assert_eq!(half.item.source_kind, "foreground");

    // 旧记录 source_kind="" 时，新可信采集必须补齐识别方式（历史数据升级路径）
    db.with_conn(|conn| {
        let sql = format!(
            "UPDATE clipboard_items SET source_app = 'legacy.exe', source_title = '旧标题',
             source_kind = '' WHERE id = '{}'",
            item_id
        );
        conn.execute(&sql, [])?;
        Ok(())
    })
    .unwrap();
    let legacy = store::record_capture(
        &db,
        &root,
        &text("code.exe", "VS Code", "owner"),
        &settings,
    )
    .unwrap();
    assert_eq!(legacy.item.source_app, "code.exe");
    assert_eq!(legacy.item.source_title, "VS Code");
    assert_eq!(legacy.item.source_kind, "owner");
    assert_consistent(&legacy.item, "旧记录补齐");

    // 10 次采集后：同内容仍只有一条、次数递增
    assert_eq!(legacy.item.copy_count, 10);
    let count = store::count_items(&db, &ClipboardFilter::default()).unwrap();
    assert_eq!(count, 1, "来源变化不得改变内容去重");
}

/// 独立场景：首采就是「未知来源」，随后同内容被识别为前台窗口。
/// 不能借用 Chrome→Edge 的已有路径，必须从 `source_app=unknown / source_title=""
/// / source_kind=unknown` 的真实数据库状态起步。
#[test]
fn unknown_record_is_upgraded_to_foreground_as_a_whole() {
    let tmp = TempRoot::new();
    let root = tmp.0.join("clipboard");
    let db = Db::open(&tmp.0.join("app.db")).expect("隔离数据库");
    let settings = Settings::default();
    let body = "独立场景 · unknown→foreground";

    let first = store::record_capture(
        &db,
        &root,
        &text_with(body, "unknown", "", "unknown"),
        &settings,
    )
    .expect("首采");
    assert!(first.created, "首采必须新建记录");
    assert_eq!(first.item.source_app, "unknown");
    assert_eq!(first.item.source_title, "");
    assert_eq!(first.item.source_kind, "unknown");
    assert_eq!(first.item.copy_count, 1);
    assert_consistent(&first.item, "首采 unknown");
    let created_at = first.item.created_at.clone();
    let first_seen_at = first.item.last_seen_at.clone();

    let second = store::record_capture(
        &db,
        &root,
        &text_with(body, "msedge.exe", "Edge 窗口", "foreground"),
        &settings,
    )
    .expect("同内容再采");
    assert!(!second.created, "同内容不得新建历史");
    assert_eq!(second.item.copy_count, 2);
    assert_eq!(second.item.source_app, "msedge.exe");
    assert_eq!(second.item.source_title, "Edge 窗口");
    assert_eq!(second.item.source_kind, "foreground");
    assert_consistent(&second.item, "unknown→foreground");
    assert_eq!(
        second.item.created_at, created_at,
        "来源升级不得改变首次采集时间"
    );
    let first_seen = DateTime::parse_from_rfc3339(&first_seen_at).expect("首采时间可解析");
    let second_seen =
        DateTime::parse_from_rfc3339(&second.item.last_seen_at).expect("再采时间可解析");
    assert!(
        second_seen >= first_seen,
        "last_seen_at 不得倒退：{first_seen_at} → {}",
        second.item.last_seen_at
    );
    assert_eq!(
        store::count_items(&db, &ClipboardFilter::default()).unwrap(),
        1,
        "去重后只能保留一条历史"
    );
}

/// 独立场景：unknown → owner 升级后，后续 unknown / 空来源绝不能把可信来源降级。
#[test]
fn unknown_record_is_upgraded_to_owner_and_not_downgraded() {
    let tmp = TempRoot::new();
    let root = tmp.0.join("clipboard");
    let db = Db::open(&tmp.0.join("app.db")).expect("隔离数据库");
    let settings = Settings::default();
    let body = "独立场景 · unknown→owner";

    let first = store::record_capture(
        &db,
        &root,
        &text_with(body, "unknown", "", "unknown"),
        &settings,
    )
    .expect("首采");
    assert!(first.created);
    assert_eq!(first.item.source_kind, "unknown");

    let second = store::record_capture(
        &db,
        &root,
        &text_with(body, "chrome.exe", "OpenCode Console", "owner"),
        &settings,
    )
    .expect("unknown→owner");
    assert!(!second.created);
    assert_eq!(second.item.source_app, "chrome.exe");
    assert_eq!(second.item.source_title, "OpenCode Console");
    assert_eq!(second.item.source_kind, "owner");
    assert_eq!(second.item.copy_count, 2);
    assert_consistent(&second.item, "unknown→owner");

    // 已知 → unknown：保留可信旧来源，三字段整体保持一致
    let third = store::record_capture(
        &db,
        &root,
        &text_with(body, "unknown", "", "unknown"),
        &settings,
    )
    .expect("已知→unknown");
    assert_eq!(third.item.source_app, "chrome.exe");
    assert_eq!(third.item.source_title, "OpenCode Console");
    assert_eq!(third.item.source_kind, "owner");
    assert_eq!(third.item.copy_count, 3);
    assert_consistent(&third.item, "已知→unknown");

    // 空串来源同样不得形成空标题混搭
    let fourth = store::record_capture(&db, &root, &text_with(body, "", "", ""), &settings)
        .expect("空来源再采");
    assert_eq!(fourth.item.source_app, "chrome.exe");
    assert_eq!(fourth.item.source_title, "OpenCode Console");
    assert_eq!(fourth.item.source_kind, "owner");
    assert_eq!(fourth.item.copy_count, 4);
    assert_consistent(&fourth.item, "空来源");

    // 新应用 + 有标题 + 有效识别方式：三字段一起替换
    let fifth = store::record_capture(
        &db,
        &root,
        &text_with(body, "code.exe", "VS Code", "foreground"),
        &settings,
    )
    .expect("跨应用");
    assert_eq!(fifth.item.source_app, "code.exe");
    assert_eq!(fifth.item.source_title, "VS Code");
    assert_eq!(fifth.item.source_kind, "foreground");
    assert_eq!(fifth.item.copy_count, 5);
    assert_consistent(&fifth.item, "跨应用");
    assert_eq!(
        store::count_items(&db, &ClipboardFilter::default()).unwrap(),
        1,
        "同内容跨应用只保留一条历史"
    );
}
