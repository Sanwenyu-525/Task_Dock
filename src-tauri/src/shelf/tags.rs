//! 暂存条目标签：批量添加/移除、最近使用标签。
//!
//! 边界：
//! - 标签只存关系（`shelf_tags`），不复制内容、不触发文件操作；
//! - 条目删除由外键级联清理标签；
//! - 每项标签数与单次提交数都有上限，超限跳过并计数，不静默丢弃。

use std::collections::HashSet;

use rusqlite::params;
use serde::Serialize;

use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 单标签最大字符数（按 Unicode 字符计，不按字节）。
pub const MAX_TAG_CHARS: usize = 32;
/// 单次提交的标签种类上限。
pub const MAX_TAGS_PER_OP: usize = 10;
/// 单个条目最多保留的标签数。
pub const MAX_TAGS_PER_ITEM: usize = 20;
/// 「最近使用标签」默认返回上限。
pub const MAX_RECENT_TAGS: usize = 20;
/// 单次批量操作的条目上限。
pub const MAX_TAG_ITEMS: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TagFailure {
    pub item_id: String,
    pub code: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TagChangeReport {
    pub tags: Vec<String>,
    pub items: usize,
    pub changed: usize,
    pub skipped: usize,
    pub failed: Vec<TagFailure>,
    pub success: bool,
    pub partial: bool,
    pub code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RecentTag {
    pub tag: String,
    pub count: usize,
    pub last_used_at: String,
}

/// 规范化并校验标签：去 `#` 前缀、去空白、拒绝控制字符、按字符数限长、去重。
pub fn normalize_tags(raw: &[String]) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for tag in raw {
        let trimmed = tag.trim().trim_start_matches('#').trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().any(|c| c.is_control()) {
            return Err(AppError::Validation("标签不能包含控制字符".into()));
        }
        if trimmed.chars().count() > MAX_TAG_CHARS {
            return Err(AppError::Validation(format!(
                "标签最多 {MAX_TAG_CHARS} 个字符：{trimmed}"
            )));
        }
        let key = trimmed.to_lowercase();
        if seen.insert(key) {
            out.push(trimmed.to_string());
        }
    }
    if out.is_empty() {
        return Err(AppError::Validation("请至少填写一个标签".into()));
    }
    if out.len() > MAX_TAGS_PER_OP {
        return Err(AppError::Validation(format!(
            "单次最多添加 {MAX_TAGS_PER_OP} 个标签"
        )));
    }
    Ok(out)
}

fn enforce_ids(ids: &[String]) -> AppResult<Vec<String>> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        let id = id.trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        out.push(id.to_string());
    }
    if out.is_empty() {
        return Err(AppError::Validation("没有选中的条目".into()));
    }
    if out.len() > MAX_TAG_ITEMS {
        return Err(AppError::Validation(format!(
            "单次最多处理 {MAX_TAG_ITEMS} 个条目，请分批操作"
        )));
    }
    Ok(out)
}

fn existing_items(db: &Db, ids: &[String]) -> AppResult<HashSet<String>> {
    let placeholders = vec!["?"; ids.len()].join(",");
    db.with_read(|conn| {
        let sql = format!("SELECT id FROM shelf_items WHERE id IN ({placeholders})");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |r| r.get::<_, String>(0))?;
        let mut set = HashSet::new();
        for row in rows {
            set.insert(row?);
        }
        Ok(set)
    })
}

fn item_tag_count(db: &Db, item_id: &str) -> AppResult<usize> {
    let n: i64 = db.with_read(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM shelf_tags WHERE item_id = ?1",
            params![item_id],
            |r| r.get(0),
        )
        .map_err(AppError::from)
    })?;
    Ok(n as usize)
}

pub fn item_tags(db: &Db, item_id: &str) -> AppResult<Vec<String>> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT tag FROM shelf_tags WHERE item_id = ?1 ORDER BY created_at ASC, tag ASC",
        )?;
        let rows = stmt.query_map(params![item_id], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

pub fn add_tags(db: &Db, ids: &[String], raw_tags: &[String]) -> AppResult<TagChangeReport> {
    let ids = enforce_ids(ids)?;
    let tags = normalize_tags(raw_tags)?;
    let existing = existing_items(db, &ids)?;
    let mut report = TagChangeReport {
        tags: tags.clone(),
        items: ids.len(),
        ..Default::default()
    };
    for id in &ids {
        if !existing.contains(id) {
            report.failed.push(TagFailure {
                item_id: id.clone(),
                code: "SHELF_ITEM_NOT_FOUND".into(),
                reason: "条目不存在，可能已被删除".into(),
            });
            continue;
        }
        let mut count = item_tag_count(db, id)?;
        for tag in &tags {
            if count >= MAX_TAGS_PER_ITEM {
                report.skipped += 1;
                continue;
            }
            let changed = db.with_conn(|conn| {
                conn.execute(
                    "INSERT OR IGNORE INTO shelf_tags (item_id, tag, created_at) VALUES (?1, ?2, ?3)",
                    params![id, tag, crate::shelf::now_iso()],
                )
                .map_err(AppError::from)
            })?;
            if changed == 0 {
                report.skipped += 1;
            } else {
                report.changed += 1;
                count += 1;
            }
        }
    }
    report.success = report.changed > 0;
    report.partial = report.success && (!report.failed.is_empty() || report.skipped > 0);
    report.code = if report.success {
        None
    } else {
        Some("SHELF_TAG_NO_CHANGE".into())
    };
    Ok(report)
}

pub fn remove_tags(db: &Db, ids: &[String], raw_tags: &[String]) -> AppResult<TagChangeReport> {
    let ids = enforce_ids(ids)?;
    let tags = normalize_tags(raw_tags)?;
    let existing = existing_items(db, &ids)?;
    let mut report = TagChangeReport {
        tags: tags.clone(),
        items: ids.len(),
        ..Default::default()
    };
    for id in &ids {
        if !existing.contains(id) {
            report.failed.push(TagFailure {
                item_id: id.clone(),
                code: "SHELF_ITEM_NOT_FOUND".into(),
                reason: "条目不存在，可能已被删除".into(),
            });
            continue;
        }
        for tag in &tags {
            let changed = db.with_conn(|conn| {
                conn.execute(
                    "DELETE FROM shelf_tags WHERE item_id = ?1 AND tag = ?2",
                    params![id, tag],
                )
                .map_err(AppError::from)
            })?;
            if changed == 0 {
                report.skipped += 1;
            } else {
                report.changed += 1;
            }
        }
    }
    report.success = report.changed > 0;
    report.partial = report.success && (!report.failed.is_empty() || report.skipped > 0);
    report.code = if report.success {
        None
    } else {
        Some("SHELF_TAG_NO_CHANGE".into())
    };
    Ok(report)
}

pub fn recent_tags(db: &Db, limit: usize) -> AppResult<Vec<RecentTag>> {
    let limit = limit.clamp(1, MAX_RECENT_TAGS) as i64;
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT tag, COUNT(*), MAX(created_at) FROM shelf_tags \
             GROUP BY tag ORDER BY MAX(created_at) DESC, MAX(rowid) DESC, tag ASC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |r| {
            Ok(RecentTag {
                tag: r.get(0)?,
                count: r.get::<_, i64>(1)? as usize,
                last_used_at: r.get(2)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Db {
        Db::open_in_memory().expect("in-memory db")
    }

    fn seed(db: &Db, name: &str) -> String {
        crate::shelf::add_text(db, name, "manual", None)
            .expect("add text")
            .id
    }

    #[test]
    fn normalizes_tags_and_rejects_bad_input() {
        let tags = normalize_tags(&[
            "  素材 ".into(),
            "#AI".into(),
            "素材".into(),
            "".into(),
        ])
        .unwrap();
        assert_eq!(tags, vec!["素材", "AI"]);
        assert!(normalize_tags(&["".into(), "   ".into()]).is_err());
        assert!(normalize_tags(&["a".repeat(MAX_TAG_CHARS + 1)]).is_err());
        assert!(normalize_tags(&["坏\n标签".into()]).is_err());
        let too_many: Vec<String> = (0..=MAX_TAGS_PER_OP).map(|i| format!("t{i}")).collect();
        assert!(normalize_tags(&too_many).is_err());
    }

    #[test]
    fn add_and_remove_tags_are_idempotent_and_capped() {
        let db = test_db();
        let a = seed(&db, "a");
        let b = seed(&db, "b");

        let r = add_tags(&db, &[a.clone(), b.clone()], &["素材".into(), "AI".into()]).unwrap();
        assert_eq!(r.changed, 4);
        assert!(r.success && !r.partial);
        let tags_a = item_tags(&db, &a).unwrap();
        assert_eq!(tags_a.len(), 2);
        assert!(tags_a.contains(&"素材".to_string()) && tags_a.contains(&"AI".to_string()));

        let again = add_tags(&db, &[a.clone()], &["素材".into()]).unwrap();
        assert_eq!(again.changed, 0);
        assert_eq!(again.skipped, 1);
        assert!(!again.success);
        assert_eq!(again.code.as_deref(), Some("SHELF_TAG_NO_CHANGE"));

        let removed = remove_tags(&db, &[a.clone()], &["AI".into()]).unwrap();
        assert_eq!(removed.changed, 1);
        assert_eq!(item_tags(&db, &a).unwrap(), vec!["素材"]);
    }

    #[test]
    fn missing_item_is_reported_per_item() {
        let db = test_db();
        let a = seed(&db, "a");
        let r = add_tags(&db, &[a, "missing".into()], &["x".into()]).unwrap();
        assert_eq!(r.changed, 1);
        assert_eq!(r.failed.len(), 1);
        assert_eq!(r.failed[0].code, "SHELF_ITEM_NOT_FOUND");
        assert!(r.success && r.partial);
    }

    #[test]
    fn per_item_tag_cap_skips_extra_tags() {
        let db = test_db();
        let a = seed(&db, "a");
        let tags: Vec<String> = (0..MAX_TAGS_PER_ITEM).map(|i| format!("t{i}")).collect();
        // 单次最多 10 个，分两批写满。
        add_tags(&db, &[a.clone()], &tags[..10]).unwrap();
        add_tags(&db, &[a.clone()], &tags[10..]).unwrap();
        let r = add_tags(&db, &[a.clone()], &["overflow".into()]).unwrap();
        assert_eq!(r.changed, 0);
        assert_eq!(r.skipped, 1);
        assert_eq!(item_tags(&db, &a).unwrap().len(), MAX_TAGS_PER_ITEM);
    }

    #[test]
    fn deleting_item_cascades_tags_and_recent_tags_order_by_use() {
        let db = test_db();
        let a = seed(&db, "a");
        let b = seed(&db, "b");
        add_tags(&db, &[a.clone()], &["早".into()]).unwrap();
        add_tags(&db, &[b.clone()], &["晚".into()]).unwrap();
        let recent = recent_tags(&db, 10).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].tag, "晚");
        assert_eq!(recent[0].count, 1);

        crate::shelf::delete_items(&db, std::path::Path::new("unused"), &[b], true).unwrap();
        let after = recent_tags(&db, 10).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].tag, "早");
    }

    #[test]
    fn rejects_empty_selection_and_over_cap() {
        let db = test_db();
        assert!(add_tags(&db, &[], &["x".into()]).is_err());
        let ids: Vec<String> = (0..=MAX_TAG_ITEMS).map(|i| format!("id-{i}")).collect();
        assert!(add_tags(&db, &ids, &["x".into()]).is_err());
    }
}
