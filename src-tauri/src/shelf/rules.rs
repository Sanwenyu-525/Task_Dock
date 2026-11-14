//! 暂存架可选收集规则（P3）：默认全部关闭，只提供可逆动作。
//!
//! 安全边界：
//! - 动作只有「加标签」与「归组」；不移动/删除原文件、不下载远程内容、不改托管副本；
//! - 未启用规则不参与预览与应用；空匹配条件直接判为无效，避免误匹配全部条目；
//! - 同一动作类型多个规则命中时按「优先级高 → 规则顺序」取第一条，冲突单独报告；
//! - 应用是显式用户操作，不会在粘贴/拖入后自动执行。

use std::collections::{HashMap, HashSet};

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::{Db, Settings};
use crate::error::{AppError, AppResult};

pub const MAX_RULES: usize = 50;
pub const MAX_PREVIEW_ITEMS: usize = 300;
pub const PREVIEW_MATCH_LIMIT: usize = 100;
pub const MAX_APPLY_ENTRIES: usize = 100;

pub const ACTION_ADD_TAG: &str = "add_tag";
pub const ACTION_ASSIGN_GROUP: &str = "assign_group";

fn default_priority() -> u32 {
    100
}
fn default_version() -> u32 {
    1
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleMatch {
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub exts: Vec<String>,
    #[serde(default)]
    pub name_contains: String,
    #[serde(default)]
    pub source_kinds: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleAction {
    #[serde(rename = "type")]
    pub action_type: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Rule {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// 默认关闭：新建规则必须由用户显式启用。
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_priority")]
    pub priority: u32,
    #[serde(default, rename = "match")]
    pub match_rule: RuleMatch,
    #[serde(default)]
    pub action: RuleAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleSet {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub rules: Vec<Rule>,
}

impl Default for RuleSet {
    fn default() -> Self {
        Self {
            version: default_version(),
            rules: Vec::new(),
        }
    }
}

fn check_text(value: &str, field: &str, max_chars: usize) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(format!("{field}不能为空")));
    }
    if trimmed.chars().count() > max_chars {
        return Err(AppError::Validation(format!(
            "{field}最多 {max_chars} 个字符"
        )));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(AppError::Validation(format!("{field}包含控制字符")));
    }
    Ok(trimmed.to_string())
}

/// 校验并解析规则 JSON（设置写入与预览共用）。
pub fn validate_json(value: &Value) -> AppResult<RuleSet> {
    if value.is_null() {
        return Ok(RuleSet::default());
    }
    let set: RuleSet =
        serde_json::from_value(value.clone()).map_err(|e| AppError::Validation(format!("收集规则格式无效: {e}")))?;
    if set.version == 0 || set.version > 100 {
        return Err(AppError::Validation("收集规则版本非法".into()));
    }
    if set.rules.len() > MAX_RULES {
        return Err(AppError::Validation(format!(
            "最多 {MAX_RULES} 条收集规则"
        )));
    }
    let mut ids = HashSet::new();
    for (i, rule) in set.rules.iter().enumerate() {
        let label = format!("第 {} 条规则", i + 1);
        let id = check_text(&rule.id, &format!("{label} ID"), 64)?;
        if !ids.insert(id) {
            return Err(AppError::Validation(format!("{label} ID 重复")));
        }
        check_text(&rule.name, &format!("{label}名称"), 80)?;
        if rule.priority > 1000 {
            return Err(AppError::Validation(format!("{label}优先级超出范围")));
        }
        let m = &rule.match_rule;
        let criteria_empty = m.kinds.is_empty()
            && m.exts.is_empty()
            && m.name_contains.trim().is_empty()
            && m.source_kinds.is_empty();
        if criteria_empty {
            return Err(AppError::Validation(format!(
                "{label}至少需要一个匹配条件"
            )));
        }
        if m.kinds.len() > 6 {
            return Err(AppError::Validation(format!("{label}类型条件过多")));
        }
        for kind in &m.kinds {
            if !["file", "folder", "image", "link", "text"].contains(&kind.as_str()) {
                return Err(AppError::Validation(format!("{label}包含未知类型")));
            }
        }
        if m.exts.len() > 10 {
            return Err(AppError::Validation(format!("{label}后缀条件过多")));
        }
        for ext in &m.exts {
            let norm = ext.trim().trim_start_matches('.').to_lowercase();
            if norm.is_empty()
                || norm.chars().count() > 16
                || !norm.chars().all(|c| c.is_ascii_alphanumeric())
            {
                return Err(AppError::Validation(format!("{label}后缀非法")));
            }
        }
        if m.name_contains.chars().count() > 60 {
            return Err(AppError::Validation(format!("{label}名称关键词过长")));
        }
        if frame_has_control(&m.name_contains) {
            return Err(AppError::Validation(format!("{label}名称关键词包含控制字符")));
        }
        if m.source_kinds.len() > 6 {
            return Err(AppError::Validation(format!("{label}来源条件过多")));
        }
        for source in &m.source_kinds {
            if !["manual", "picker", "drag", "clipboard", "url"].contains(&source.as_str()) {
                return Err(AppError::Validation(format!("{label}包含未知来源")));
            }
        }
        match rule.action.action_type.as_str() {
            ACTION_ADD_TAG => {
                check_text(&rule.action.value, &format!("{label}标签"), 32)?;
            }
            ACTION_ASSIGN_GROUP => {
                check_text(&rule.action.value, &format!("{label}分组 ID"), 64)?;
            }
            other => {
                return Err(AppError::Validation(format!(
                    "{label}动作不受支持: {other}（仅支持加标签/归组）"
                )))
            }
        }
    }
    Ok(set)
}

fn frame_has_control(s: &str) -> bool {
    s.chars().any(char::is_control)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleItem {
    pub id: String,
    pub kind: String,
    pub ext: Option<String>,
    pub name: String,
    pub source_kind: String,
}

fn rule_matches(rule: &Rule, item: &RuleItem) -> bool {
    let m = &rule.match_rule;
    if !m.kinds.is_empty() && !m.kinds.iter().any(|k| k == &item.kind) {
        return false;
    }
    if !m.exts.is_empty() {
        let ext = item.ext.as_deref().unwrap_or("").to_lowercase();
        if !m
            .exts
            .iter()
            .any(|e| e.trim().trim_start_matches('.').to_lowercase() == ext)
        {
            return false;
        }
    }
    let keyword = m.name_contains.trim().to_lowercase();
    if !keyword.is_empty() && !item.name.to_lowercase().contains(&keyword) {
        return false;
    }
    if !m.source_kinds.is_empty() && !m.source_kinds.iter().any(|s| s == &item.source_kind) {
        return false;
    }
    true
}

fn load_items(db: &Db, ids: Option<&[String]>) -> AppResult<Vec<RuleItem>> {
    db.with_read(|conn| {
        let map = |r: &rusqlite::Row<'_>| -> rusqlite::Result<RuleItem> {
            Ok(RuleItem {
                id: r.get(0)?,
                kind: r.get(1)?,
                ext: r.get(2)?,
                name: r.get(3)?,
                source_kind: r.get(4)?,
            })
        };
        let mut out = Vec::new();
        if let Some(ids) = ids {
            if ids.is_empty() {
                return Ok(out);
            }
            let placeholders = vec!["?"; ids.len()].join(",");
            let sql = format!(
                "SELECT id, kind, file_ext, display_name, source_kind FROM shelf_items \
                 WHERE id IN ({placeholders})"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), map)?;
            for row in rows {
                out.push(row?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, kind, file_ext, display_name, source_kind FROM shelf_items \
                 ORDER BY created_at DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![MAX_PREVIEW_ITEMS as i64], map)?;
            for row in rows {
                out.push(row?);
            }
        }
        Ok(out)
    })
}

fn enabled_rules(set: &RuleSet) -> Vec<&Rule> {
    let mut rules: Vec<&Rule> = set.rules.iter().filter(|r| r.enabled).collect();
    // 数值越小优先级越高（与设置对话框提示一致）；同一动作类型只取首个真正生效的规则。
    rules.sort_by(|a, b| a.priority.cmp(&b.priority));
    rules
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PreviewMatch {
    pub rule_id: String,
    pub rule_name: String,
    pub item_id: String,
    pub item_name: String,
    pub action_type: String,
    pub action_value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PreviewConflict {
    pub item_id: String,
    pub item_name: String,
    pub rule_ids: Vec<String>,
    pub rule_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RuleCount {
    pub rule_id: String,
    pub rule_name: String,
    pub matched: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RulePreview {
    pub evaluated_items: usize,
    pub matched_items: usize,
    pub matches: Vec<PreviewMatch>,
    pub conflicts: Vec<PreviewConflict>,
    pub per_rule: Vec<RuleCount>,
    pub truncated: bool,
}

/// 预览规则匹配。`override_rules` 用于「未保存先预览」；None 时读已保存设置。
pub fn preview(db: &Db, override_rules: Option<&Value>) -> AppResult<RulePreview> {
    let set = match override_rules {
        Some(value) => validate_json(value)?,
        None => validate_json(&Settings::load(db).unwrap_or_default().shelf_collect_rules)?,
    };
    let rules = enabled_rules(&set);
    let items = load_items(db, None)?;
    let mut report = RulePreview {
        evaluated_items: items.len(),
        ..Default::default()
    };
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut matched_ids: HashSet<String> = HashSet::new();
    for item in &items {
        let hits: Vec<&Rule> = rules.iter().copied().filter(|r| rule_matches(r, item)).collect();
        if hits.is_empty() {
            continue;
        }
        matched_ids.insert(item.id.clone());
        for rule in &hits {
            *counts.entry(rule.id.clone()).or_default() += 1;
        }
        if hits.len() > 1 {
            report.conflicts.push(PreviewConflict {
                item_id: item.id.clone(),
                item_name: item.name.clone(),
                rule_ids: hits.iter().map(|r| r.id.clone()).collect(),
                rule_names: hits.iter().map(|r| r.name.clone()).collect(),
            });
        }
        if report.matches.len() < PREVIEW_MATCH_LIMIT {
            let rule = hits[0];
            report.matches.push(PreviewMatch {
                rule_id: rule.id.clone(),
                rule_name: rule.name.clone(),
                item_id: item.id.clone(),
                item_name: item.name.clone(),
                action_type: rule.action.action_type.clone(),
                action_value: rule.action.value.clone(),
            });
        } else {
            report.truncated = true;
        }
    }
    report.matched_items = matched_ids.len();
    report.per_rule = rules
        .iter()
        .map(|r| RuleCount {
            rule_id: r.id.clone(),
            rule_name: r.name.clone(),
            matched: *counts.get(&r.id).unwrap_or(&0),
        })
        .collect();
    Ok(report)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApplyEntry {
    pub item_id: String,
    pub item_name: String,
    pub rule_id: String,
    pub action_type: String,
    pub action_value: String,
    pub applied: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RuleApplyReport {
    pub evaluated_items: usize,
    pub applied: usize,
    pub tagged: usize,
    pub grouped: usize,
    pub skipped: usize,
    pub entries: Vec<ApplyEntry>,
    pub truncated: bool,
}

/// 应用已启用规则。`ids=None` 时作用于最近 [`MAX_PREVIEW_ITEMS`] 条。
pub fn apply(db: &Db, ids: Option<&[String]>) -> AppResult<RuleApplyReport> {
    if let Some(ids) = ids {
        if ids.len() > MAX_PREVIEW_ITEMS {
            return Err(AppError::Validation(format!(
                "单次最多应用 {MAX_PREVIEW_ITEMS} 个条目"
            )));
        }
    }
    let set = validate_json(&Settings::load(db).unwrap_or_default().shelf_collect_rules)?;
    let rules = enabled_rules(&set);
    let items = load_items(db, ids)?;
    let mut report = RuleApplyReport {
        evaluated_items: items.len(),
        ..Default::default()
    };
    for item in &items {
        let hits: Vec<&Rule> = rules.iter().copied().filter(|r| rule_matches(r, item)).collect();
        if hits.is_empty() {
            continue;
        }
        // 同一动作类型取优先级最高且**真正生效**的一条；高优先规则因目标分组
        // 不存在等原因未生效时，允许下一优先规则补位，不能被无效规则永久占用槽位。
        let mut handled: HashSet<String> = HashSet::new();
        for rule in hits {
            let action = rule.action.action_type.as_str();
            if handled.contains(action) {
                report.skipped += 1;
                continue;
            }
            let result = match action {
                ACTION_ADD_TAG => crate::shelf::tags::add_tags(
                    db,
                    std::slice::from_ref(&item.id),
                    std::slice::from_ref(&rule.action.value),
                )
                .map(|r| {
                    if r.changed > 0 {
                        (true, None)
                    } else {
                        (false, Some("标签已存在".to_string()))
                    }
                }),
                ACTION_ASSIGN_GROUP => assign_group(db, &item.id, &rule.action.value),
                _ => Ok((false, Some("未知动作".to_string()))),
            };
            let (applied, reason) = match result {
                Ok(v) => v,
                Err(e) => (false, Some(e.to_string())),
            };
            if applied {
                report.applied += 1;
                handled.insert(action.to_string());
                if action == ACTION_ADD_TAG {
                    report.tagged += 1;
                } else {
                    report.grouped += 1;
                }
            } else {
                report.skipped += 1;
            }
            if report.entries.len() < MAX_APPLY_ENTRIES {
                report.entries.push(ApplyEntry {
                    item_id: item.id.clone(),
                    item_name: item.name.clone(),
                    rule_id: rule.id.clone(),
                    action_type: action.to_string(),
                    action_value: rule.action.value.clone(),
                    applied,
                    reason,
                });
            } else {
                report.truncated = true;
            }
        }
    }
    // 只记录计数与规则 id，不记录内容/路径。
    tracing::info!(
        rules = rules.len(),
        evaluated = report.evaluated_items,
        applied = report.applied,
        tagged = report.tagged,
        grouped = report.grouped,
        skipped = report.skipped,
        "暂存架收集规则已应用"
    );
    Ok(report)
}

fn assign_group(db: &Db, item_id: &str, group_id: &str) -> AppResult<(bool, Option<String>)> {
    let exists: i64 = db.with_read(|conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM shelf_groups WHERE id = ?1",
            params![group_id],
            |r| r.get(0),
        )
        .map_err(AppError::from)
    })?;
    if exists == 0 {
        return Ok((false, Some("目标分组不存在".into())));
    }
    let changed = db.with_conn(|conn| {
        conn.execute(
            "UPDATE shelf_items SET group_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![item_id, group_id, crate::shelf::now_iso()],
        )
        .map_err(AppError::from)
    })?;
    Ok((changed > 0, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_db() -> Db {
        Db::open_in_memory().expect("in-memory db")
    }

    fn seed(db: &Db, name: &str, ext: Option<&str>, kind: &str) -> String {
        let item = crate::shelf::add_text(db, name, "manual", None).expect("add text");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE shelf_items SET display_name = ?2, file_ext = ?3, kind = ?4 WHERE id = ?1",
                params![item.id, name, ext, kind],
            )?;
            Ok(())
        })
        .unwrap();
        item.id
    }

    fn save_rules(db: &Db, rules: Value) {
        db.set_setting("shelf_collect_rules", rules)
            .expect("save settings");
    }

    fn rule_json(enabled: bool, ext: &str, action: &str, value: &str) -> Value {
        json!({
            "version": 1,
            "rules": [{
                "id": "r1",
                "name": "PDF 归组",
                "enabled": enabled,
                "priority": 100,
                "match": { "exts": [ext] },
                "action": { "type": action, "value": value }
            }]
        })
    }

    #[test]
    fn validate_rejects_empty_match_and_unknown_action() {
        let empty = json!({"version":1,"rules":[{"id":"r","name":"n","action":{"type":"add_tag","value":"x"}}]});
        assert!(validate_json(&empty).is_err());
        let bad = json!({"version":1,"rules":[{"id":"r","name":"n","match":{"exts":["pdf"]},"action":{"type":"delete_file","value":"x"}}]});
        assert!(validate_json(&bad).is_err());
        let ok = rule_json(false, "pdf", ACTION_ADD_TAG, "文档");
        assert_eq!(validate_json(&ok).unwrap().rules.len(), 1);
    }

    #[test]
    fn matching_is_case_insensitive_and_requires_all_fields() {
        let rule = serde_json::from_value::<Rule>(json!({
            "id":"r","name":"n","enabled":true,
            "match":{"exts":["PDF"],"name_contains":"合同","kinds":["file"]},
            "action":{"type":"add_tag","value":"合同"}
        }))
        .unwrap();
        let hit = RuleItem {
            id: "a".into(),
            kind: "file".into(),
            ext: Some("pdf".into()),
            name: "2026 合同.pdf".into(),
            source_kind: "manual".into(),
        };
        assert!(rule_matches(&rule, &hit));
        let miss_kind = RuleItem { kind: "image".into(), ..hit.clone() };
        assert!(!rule_matches(&rule, &miss_kind));
        let miss_name = RuleItem { name: "发票.pdf".into(), ..hit };
        assert!(!rule_matches(&rule, &miss_name));
    }

    #[test]
    fn preview_ignores_disabled_and_reports_conflicts() {
        let db = test_db();
        seed(&db, "合同.pdf", Some("pdf"), "file");
        save_rules(&db, rule_json(false, "pdf", ACTION_ADD_TAG, "文档"));
        let disabled = preview(&db, None).unwrap();
        assert_eq!(disabled.matched_items, 0);

        save_rules(
            &db,
            json!({"version":1,"rules":[
                {"id":"a","name":"A","enabled":true,"priority":10,"match":{"exts":["pdf"]},"action":{"type":"add_tag","value":"文档"}},
                {"id":"b","name":"B","enabled":true,"priority":20,"match":{"kinds":["file"]},"action":{"type":"assign_group","value":"shelf-work"}}
            ]}),
        );
        let r = preview(&db, None).unwrap();
        assert_eq!(r.matched_items, 1);
        assert_eq!(r.conflicts.len(), 1);
        assert_eq!(r.conflicts[0].rule_ids.len(), 2);
        assert_eq!(r.per_rule.len(), 2);
        // 预览不写入：标签与分组保持不变。
        let tags = crate::shelf::tags::item_tags(&db, &r.matches[0].item_id).unwrap();
        assert!(tags.is_empty());
    }

    #[test]
    fn apply_tags_and_groups_with_priority_and_safety() {
        let db = test_db();
        let item = seed(&db, "合同.pdf", Some("pdf"), "file");
        save_rules(
            &db,
            json!({"version":1,"rules":[
                {"id":"a","name":"A","enabled":true,"priority":10,"match":{"exts":["pdf"]},"action":{"type":"add_tag","value":"文档"}},
                {"id":"b","name":"B","enabled":true,"priority":20,"match":{"kinds":["file"]},"action":{"type":"add_tag","value":"低优先"}},
                {"id":"c","name":"C","enabled":true,"priority":5,"match":{"exts":["pdf"]},"action":{"type":"assign_group","value":"shelf-work"}},
                {"id":"d","name":"D","enabled":true,"priority":99,"match":{"exts":["pdf"]},"action":{"type":"assign_group","value":"no-such-group"}}
            ]}),
        );
        let r = apply(&db, Some(&[item.clone()])).unwrap();
        // 两种动作各生效一次：加标签（高优先那条）+ 归组（唯一的合法组）。
        assert_eq!(r.applied, 2);
        assert_eq!(r.tagged, 1);
        assert_eq!(r.grouped, 1);
        assert!(r.skipped >= 2);
        let tags = crate::shelf::tags::item_tags(&db, &item).unwrap();
        assert_eq!(tags, vec!["文档"]);
        let group: Option<String> = db
            .with_read(|c| {
                Ok(c.query_row(
                    "SELECT group_id FROM shelf_items WHERE id = ?1",
                    params![item],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(group.as_deref(), Some("shelf-work"));
    }

    #[test]
    fn apply_default_is_noop_and_never_deletes() {
        let db = test_db();
        let item = seed(&db, "a.txt", Some("txt"), "file");
        let r = apply(&db, Some(&[item.clone()])).unwrap();
        assert_eq!(r.applied, 0);
        assert!(crate::shelf::get_item(&db, &item).is_ok());
    }
}
