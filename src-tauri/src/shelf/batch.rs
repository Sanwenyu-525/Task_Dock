//! 批量关联项目/任务：复用既有 `shelf_project_links` / `shelf_task_links`，
//! 不新建项目或任务体系，也不复制内容。
//!
//! 语义：
//! - 目标（项目/任务）不存在时整批失败，不隐式创建；
//! - 条目已删除等单条问题走 `failed` 部分失败，不阻塞其余条目；
//! - 重复关联幂等，计入 `duplicates`，不视为失败。

use std::collections::HashSet;

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 单次批量关联上限：与批量删除上限保持一致，避免超长 IPC 与长事务。
pub const MAX_BATCH_LINK: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BatchLinkFailure {
    pub item_id: String,
    pub code: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct BatchLinkReport {
    pub target: String,
    pub target_id: String,
    pub target_name: String,
    pub linked: usize,
    pub duplicates: usize,
    pub failed: Vec<BatchLinkFailure>,
    pub success: bool,
    pub partial: bool,
    pub code: Option<String>,
}

fn target_meta(target: &str) -> AppResult<(&'static str, &'static str, &'static str, &'static str)> {
    // (关联表, 目标列, 目标表, 目标名称列)
    match target {
        "project" => Ok((
            "shelf_project_links",
            "project_id",
            "workspace_projects",
            "name",
        )),
        "task" => Ok(("shelf_task_links", "task_id", "tasks", "title")),
        _ => Err(AppError::Validation(
            "关联目标必须是 project 或 task".into(),
        )),
    }
}

/// 批量关联。`item_ids` 允许重复与乱序；重复 id 只处理一次。
pub fn link_many(
    db: &Db,
    item_ids: &[String],
    target: &str,
    target_id: &str,
) -> AppResult<BatchLinkReport> {
    let (link_table, target_col, target_table, name_col) = target_meta(target)?;
    if target_id.trim().is_empty() {
        return Err(AppError::Validation("关联目标不能为空".into()));
    }
    if item_ids.is_empty() {
        return Err(AppError::Validation("没有可关联的条目".into()));
    }

    let mut seen = HashSet::new();
    let mut ids: Vec<String> = Vec::new();
    for id in item_ids {
        let id = id.trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        ids.push(id.to_string());
    }
    if ids.is_empty() {
        return Err(AppError::Validation("没有可关联的条目".into()));
    }
    if ids.len() > MAX_BATCH_LINK {
        return Err(AppError::Validation(format!(
            "单次最多关联 {MAX_BATCH_LINK} 个条目，请分批操作"
        )));
    }

    // 目标必须存在：查不到整体失败，避免写出一批悬挂关联。
    let target_name: Option<String> = db.with_read(|conn| {
        let sql = format!("SELECT {name_col} FROM {target_table} WHERE id = ?1");
        conn.query_row(&sql, params![target_id], |r| r.get(0))
            .optional()
            .map_err(AppError::from)
    })?;
    let Some(target_name) = target_name else {
        return Err(AppError::NotFound(format!(
            "{}不存在或已删除",
            if target == "project" { "项目" } else { "任务" }
        )));
    };

    // 一次查出确实存在的条目，避免逐条往返。
    let placeholders = vec!["?"; ids.len()].join(",");
    let existing: HashSet<String> = db.with_read(|conn| {
        let sql = format!("SELECT id FROM shelf_items WHERE id IN ({placeholders})");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |r| r.get::<_, String>(0))?;
        let mut set = HashSet::new();
        for row in rows {
            set.insert(row?);
        }
        Ok(set)
    })?;

    let mut report = BatchLinkReport {
        target: target.to_string(),
        target_id: target_id.to_string(),
        target_name,
        ..Default::default()
    };
    for id in &ids {
        if !existing.contains(id) {
            report.failed.push(BatchLinkFailure {
                item_id: id.clone(),
                code: "SHELF_ITEM_NOT_FOUND".into(),
                reason: "条目不存在，可能已被删除".into(),
            });
            continue;
        }
        let sql =
            format!("INSERT OR IGNORE INTO {link_table} ({target_col}, item_id, created_at) VALUES (?1, ?2, ?3)");
        match db.with_conn(|conn| {
            conn.execute(&sql, params![target_id, id, crate::shelf::now_iso()])
                .map_err(AppError::from)
        }) {
            Ok(0) => report.duplicates += 1,
            Ok(_) => report.linked += 1,
            Err(e) => report.failed.push(BatchLinkFailure {
                item_id: id.clone(),
                code: "SHELF_LINK_FAILED".into(),
                reason: e.to_string(),
            }),
        }
    }

    let touched = report.linked + report.duplicates;
    report.success = touched > 0;
    report.partial = report.success && !report.failed.is_empty();
    report.code = if report.success {
        None
    } else {
        Some("SHELF_BATCH_LINK_FAILED".into())
    };
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Db {
        Db::open_in_memory().expect("in-memory db")
    }

    fn seed_item(db: &Db, name: &str) -> String {
        let item = crate::shelf::add_text(db, name, "manual", None).expect("add text");
        item.id
    }

    fn seed_project(db: &Db, id: &str, name: &str) {
        let now = crate::shelf::now_iso();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspace_projects \
                 (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at) \
                 VALUES (?1, ?2, 'general', 'active', '', '', '', ?3, ?3)",
                params![id, name, now],
            )?;
            Ok(())
        })
        .expect("seed project");
    }

    fn seed_task(db: &Db, id: &str, title: &str) {
        let now = crate::shelf::now_iso();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tasks (id, title, status, created_at, updated_at) \
                 VALUES (?1, ?2, 'pending', ?3, ?3)",
                params![id, title, now],
            )?;
            Ok(())
        })
        .expect("seed task");
    }

    #[test]
    fn links_all_items_and_is_idempotent() {
        let db = test_db();
        seed_project(&db, "p1", "项目一");
        let a = seed_item(&db, "a");
        let b = seed_item(&db, "b");

        let r = link_many(&db, &[a.clone(), b.clone()], "project", "p1").expect("link");
        assert_eq!(r.linked, 2);
        assert_eq!(r.duplicates, 0);
        assert!(r.success && !r.partial);
        assert_eq!(r.target_name, "项目一");
        assert_eq!(r.code, None);

        // 重复执行不报错，计入 duplicates，不重复写行。
        let again = link_many(&db, &[a.clone(), b.clone()], "project", "p1").expect("relink");
        assert_eq!(again.linked, 0);
        assert_eq!(again.duplicates, 2);
        assert!(again.success);
        let count: i64 = db
            .with_read(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM shelf_project_links WHERE project_id = 'p1'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn missing_item_is_partial_failure() {
        let db = test_db();
        seed_project(&db, "p1", "项目一");
        let a = seed_item(&db, "a");

        let r = link_many(&db, &[a, "missing-id".into()], "project", "p1").expect("link");
        assert_eq!(r.linked, 1);
        assert_eq!(r.failed.len(), 1);
        assert_eq!(r.failed[0].code, "SHELF_ITEM_NOT_FOUND");
        assert!(r.success && r.partial);
    }

    #[test]
    fn missing_target_fails_without_writing() {
        let db = test_db();
        let a = seed_item(&db, "a");
        let err = link_many(&db, &[a], "project", "nope").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        let count: i64 = db
            .with_read(|c| Ok(c.query_row("SELECT COUNT(*) FROM shelf_project_links", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn links_tasks_and_dedupes_input_ids() {
        let db = test_db();
        seed_task(&db, "t1", "任务一");
        let a = seed_item(&db, "a");

        let r = link_many(&db, &[a.clone(), a.clone()], "task", "t1").expect("link");
        assert_eq!(r.linked, 1);
        assert_eq!(r.duplicates, 0);
        assert_eq!(r.target_name, "任务一");
        let count: i64 = db
            .with_read(|c| Ok(c.query_row("SELECT COUNT(*) FROM shelf_task_links", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn rejects_unknown_target_and_empty_selection() {
        let db = test_db();
        let a = seed_item(&db, "a");
        assert!(matches!(
            link_many(&db, &[a.clone()], "scene", "x").unwrap_err(),
            AppError::Validation(_)
        ));
        assert!(matches!(
            link_many(&db, &[], "project", "p1").unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn caps_batch_size() {
        let db = test_db();
        seed_project(&db, "p1", "项目一");
        let ids: Vec<String> = (0..=MAX_BATCH_LINK).map(|i| format!("id-{i}")).collect();
        let err = link_many(&db, &ids, "project", "p1").unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
