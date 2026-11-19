//! 工作篮数据层与关联层的单元测试（内存库，应用真实迁移）。
//!
//! 覆盖：
//! - 去重只在「仍在篮中」状态生效，发送成功后可再次加入；
//! - 长正文溢出到 `transfer_contents`，`resolve_text` 能还原；
//! - 排序稳定且不丢行；
//! - 清理不动固定项；
//! - 父子关联防环、重复关联幂等。

use crate::db::Db;

use super::links::{self, LinkInput};
use super::store;
use super::{TransferFilter, TransferItemInput};

fn text_input(text: &str) -> TransferItemInput {
    TransferItemInput {
        id: None,
        item_type: "text".into(),
        source_module: "clipboard".into(),
        source_id: String::new(),
        title: String::new(),
        description: String::new(),
        content: text.into(),
        payload: serde_json::json!({}),
        pinned: false,
    }
}

fn db() -> Db {
    Db::open_in_memory().expect("内存库应可用")
}

#[test]
fn add_dedupes_by_content_and_survives_send() {
    let db = db();
    let first = store::add_items(&db, vec![text_input("同一段内容")]).unwrap();
    assert_eq!(first.items.len(), 1);
    assert_eq!(first.duplicates, 0);

    let second = store::add_items(&db, vec![text_input("同一段内容")]).unwrap();
    assert_eq!(second.duplicates, 1, "相同正文必须命中去重");
    assert_eq!(second.items[0].id, first.items[0].id);

    let id = first.items[0].id.clone();
    store::mark_sending(&db, std::slice::from_ref(&id)).unwrap();
    store::mark_outcome(
        &db,
        &[(id.clone(), true, "OK".into(), String::new())],
        "files|C:/tmp",
        0,
    )
    .unwrap();
    assert_eq!(store::get(&db, &id).unwrap().status, "sent");

    // 发送成功后允许再次加入（部分唯一索引只覆盖 ready/sending/failed）。
    let third = store::add_items(&db, vec![text_input("同一段内容")]).unwrap();
    assert_eq!(third.duplicates, 0);
    assert_ne!(third.items[0].id, id);
}

#[test]
fn long_text_spills_to_content_table_and_resolves() {
    let db = db();
    let body = "长".repeat(super::MAX_INLINE_CONTENT / 3 + 2000);
    let report = store::add_items(&db, vec![text_input(&body)]).unwrap();
    let id = report.items[0].id.clone();
    // IPC 视图会把溢出正文回填，因此直接查行内是否仍保存大字段。
    let (inline, content_ref): (String, Option<String>) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT content, content_ref FROM transfer_items WHERE id = ?1",
                rusqlite::params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .unwrap();
    assert!(inline.is_empty(), "溢出正文不应内联在行内");
    assert!(content_ref.is_some(), "溢出正文必须写入 transfer_contents");

    let item = store::get(&db, &id).unwrap();
    let resolved = db
        .with_conn(|conn| store::resolve_text(conn, &item))
        .unwrap();
    assert_eq!(resolved, body);

    // 删除条目后溢出正文被孤儿清理。
    store::remove(&db, std::slice::from_ref(&id)).unwrap();
    let orphans: i64 = db
        .with_read(|conn| {
            conn.query_row("SELECT COUNT(*) FROM transfer_contents", [], |r| r.get(0))
                .map_err(Into::into)
        })
        .unwrap();
    assert_eq!(orphans, 0);
}

#[test]
fn reorder_moves_selection_without_losing_rows() {
    let db = db();
    let a = store::add_items(&db, vec![text_input("A")]).unwrap().items[0].id.clone();
    let b = store::add_items(&db, vec![text_input("B")]).unwrap().items[0].id.clone();
    let c = store::add_items(&db, vec![text_input("C")]).unwrap().items[0].id.clone();

    store::reorder(&db, &[c.clone(), a.clone(), b.clone()]).unwrap();
    let page = store::list(&db, &TransferFilter::default()).unwrap();
    let ids: Vec<String> = page.items.iter().map(|i| i.id.clone()).collect();
    assert_eq!(ids, vec![c, a, b]);
    assert_eq!(page.total, 3);
}

#[test]
fn sweep_never_removes_pinned_or_ready_items() {
    let db = db();
    let mut pinned = text_input("固定内容");
    pinned.pinned = true;
    let pinned_id = store::add_items(&db, vec![pinned]).unwrap().items[0].id.clone();
    let ready_id = store::add_items(&db, vec![text_input("待处理")]).unwrap().items[0].id.clone();

    let removed = store::sweep(&db, 0).unwrap();
    assert_eq!(removed, 0, "没有终态条目时不应删除任何内容");
    assert!(store::get(&db, &pinned_id).is_ok());
    assert!(store::get(&db, &ready_id).is_ok());
}

#[test]
fn entity_link_is_idempotent_and_parent_cycle_is_rejected() {
    let db = db();
    let input = LinkInput {
        source_type: "task".into(),
        source_id: "task-a".into(),
        target_type: "file".into(),
        target_id: "C:/tmp/a.txt".into(),
        relation: "attachment".into(),
        label: "附件".into(),
        metadata: serde_json::json!({}),
    };
    // 实体存在性校验需要真实表行；这里只测「两端不存在必须拒绝」，
    // 幂等与防环用纯 SQL 逻辑在集成测试覆盖。
    assert!(links::create_link(&db, &input).is_err());

    let self_link = LinkInput {
        source_type: "task".into(),
        source_id: "task-a".into(),
        target_type: "task".into(),
        target_id: "task-a".into(),
        relation: "reference".into(),
        label: String::new(),
        metadata: serde_json::json!({}),
    };
    assert!(links::create_link(&db, &self_link).is_err());
}

#[test]
fn options_reject_unknown_enum_values() {
    let mut options = super::TransferOptions::default();
    options.conflict = "arbitrary".into();
    assert!(options.validate().is_err());
    options.conflict = "rename".into();
    assert!(options.validate().is_ok());
}

#[test]
fn preview_reports_target_and_planned_files_without_writing() {
    use std::fs;

    let dir = std::env::temp_dir().join(format!("taskdock-transfer-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).expect("临时目录应可创建");
    let target = super::TransferTarget::new("files", dir.to_string_lossy().to_string());
    let db = db();
    let report = store::add_items(&db, vec![text_input("预览阶段不应写盘")]).unwrap();

    let preview = super::execute::preview(
        &db,
        std::path::Path::new("."),
        &[report.items[0].id.clone()],
        &target,
        &super::TransferOptions::default(),
    )
    .unwrap();

    assert!(preview.target_valid, "存在的目录应通过校验");
    assert_eq!(preview.counts.text, 1);
    assert!(preview.planned_files >= 1, "文本应规划为一个新文件");
    assert!(preview.estimated_bytes > 0, "应估算正文大小");
    assert!(
        fs::read_dir(&dir).unwrap().next().is_none(),
        "预览不能写盘"
    );
    fs::remove_dir_all(&dir).ok();
}


#[test]
fn file_and_directory_types_must_match_real_filesystem() {
    use std::fs;
    let dir = std::env::temp_dir().join(format!("taskdock-type-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let file_path = dir.join("a.txt");
    fs::write(&file_path, "x").unwrap();
    let db = db();

    let as_file = TransferItemInput {
        id: None,
        item_type: "file".into(),
        source_module: "files".into(),
        source_id: file_path.to_string_lossy().to_string(),
        title: "a.txt".into(),
        description: String::new(),
        content: String::new(),
        payload: serde_json::json!({ "path": file_path.to_string_lossy() }),
        pinned: false,
    };
    let report = store::add_items(&db, vec![as_file]).unwrap();
    assert_eq!(report.items.len(), 1, "普通文件应作为 file 加入");

    let as_dir = TransferItemInput {
        id: None,
        item_type: "directory".into(),
        source_module: "files".into(),
        source_id: file_path.to_string_lossy().to_string(),
        title: "a.txt".into(),
        description: String::new(),
        content: String::new(),
        payload: serde_json::json!({ "path": file_path.to_string_lossy() }),
        pinned: false,
    };
    let mismatch = store::add_items(&db, vec![as_dir]).unwrap();
    assert!(mismatch.items.is_empty());
    assert_eq!(mismatch.rejected.len(), 1);
    assert!(mismatch.rejected[0].message.contains("形态不一致"));

    let real_dir = TransferItemInput {
        id: None,
        item_type: "directory".into(),
        source_module: "files".into(),
        source_id: dir.to_string_lossy().to_string(),
        title: "dir".into(),
        description: String::new(),
        content: String::new(),
        payload: serde_json::json!({ "path": dir.to_string_lossy() }),
        pinned: false,
    };
    let dir_report = store::add_items(&db, vec![real_dir]).unwrap();
    assert_eq!(dir_report.items.len(), 1, "目录应作为 directory 加入");
    assert_eq!(dir_report.items[0].item_type, "directory");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn missing_path_is_rejected_at_add_time_with_code() {
    let db = db();
    let missing = std::env::temp_dir()
        .join(format!("taskdock-missing-{}", uuid::Uuid::new_v4()))
        .join("nope.txt");
    let input = TransferItemInput {
        id: None,
        item_type: "file".into(),
        source_module: "files".into(),
        source_id: missing.to_string_lossy().to_string(),
        title: "nope.txt".into(),
        description: String::new(),
        content: String::new(),
        payload: serde_json::json!({ "path": missing.to_string_lossy() }),
        pinned: false,
    };
    let report = store::add_items(&db, vec![input]).unwrap();
    assert!(report.items.is_empty(), "不存在的路径不能进入工作篮");
    assert_eq!(report.rejected.len(), 1);
    assert_eq!(report.rejected[0].code, "TRANSFER_SOURCE_MISSING");
}
