//! 需求与 Bug（统一 `collab_issues` 实体）。
//!
//! 设计要点：
//! - Bug 不是另一张表：`kind=bug` + 可选复现字段，避免需求/Bug 双套关联；
//! - 去重只提示，不自动删除；`dedupe_key` 不是唯一索引；
//! - 状态变更受控：`verified/closed` 只能由 UI 验证/关闭（Agent 无审批权）；
//! - 所有更新必须带 `expected_revision`，冲突返回当前 revision。

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension};

use crate::error::{AppError, AppResult};

use super::actor::{assert_project_scope, write_audit, Actor, Capability};
use super::model::{
    page_args, DuplicateCandidate, Evidence, Issue, IssueCreateResult, IssueDetail, IssueFilter,
    IssueInput, IssueLink, IssuePatch, Page, ISSUE_KINDS, ISSUE_LINK_RELATIONS, ISSUE_STATUSES,
    MAX_DESCRIPTION, MAX_FILES, MAX_STEPS, MAX_TITLE, PRIORITIES,
};
use super::util::{
    json_array, new_id, normalize_key, now_iso, parse_string_array, validate_enum,
    validate_string_list, validate_text,
};

const COLS: &str = "id, project_id, kind, title, description, impact, priority, status, \
acceptance, repro_steps, expected_result, actual_result, environment, related_files, \
resolution, assignee, dedupe_key, source_agent, source_session, source, revision, \
created_by, updated_by, created_at, updated_at";

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Issue> {
    Ok(Issue {
        id: r.get(0)?,
        project_id: r.get(1)?,
        kind: r.get(2)?,
        title: r.get(3)?,
        description: r.get(4)?,
        impact: r.get(5)?,
        priority: r.get(6)?,
        status: r.get(7)?,
        acceptance: r.get(8)?,
        repro_steps: parse_string_array(&r.get::<_, String>(9)?),
        expected_result: r.get(10)?,
        actual_result: r.get(11)?,
        environment: r.get(12)?,
        related_files: parse_string_array(&r.get::<_, String>(13)?),
        resolution: r.get(14)?,
        assignee: r.get(15)?,
        dedupe_key: r.get(16)?,
        source_agent: r.get(17)?,
        source_session: r.get(18)?,
        source: r.get(19)?,
        revision: r.get(20)?,
        created_by: r.get(21)?,
        updated_by: r.get(22)?,
        created_at: r.get(23)?,
        updated_at: r.get(24)?,
    })
}

pub fn load_issue(conn: &Connection, id: &str) -> AppResult<Issue> {
    conn.query_row(
        &format!("SELECT {COLS} FROM collab_issues WHERE id=?1"),
        rusqlite::params![id],
        map_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("需求/Bug 不存在".to_string()))
}

fn validate_input(input: &IssueInput) -> AppResult<(
    String,
    String,
    String,
    String,
    String,
    String,
    Vec<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Vec<String>,
)> {
    let kind = validate_enum(&input.kind, ISSUE_KINDS, "类型")?;
    let title = validate_text(&input.title, "标题", MAX_TITLE, true)?;
    let description = validate_text(&input.description, "描述", MAX_DESCRIPTION, false)?;
    let impact = validate_text(&input.impact, "影响范围", MAX_DESCRIPTION, false)?;
    let priority = validate_enum(
        input.priority.as_deref().unwrap_or("P2"),
        PRIORITIES,
        "优先级",
    )?;
    let acceptance = validate_text(&input.acceptance, "验收要求", MAX_DESCRIPTION, false)?;
    let steps = validate_string_list(&input.repro_steps, "复现步骤", MAX_STEPS, 500)?;
    let expected = normalize_opt(input.expected_result.as_deref(), "预期结果")?;
    let actual = normalize_opt(input.actual_result.as_deref(), "实际结果")?;
    let environment = normalize_opt(input.environment.as_deref(), "发生环境")?;
    let files = validate_string_list(&input.related_files, "相关文件", MAX_FILES, 500)?;
    Ok((
        kind,
        title,
        description,
        impact,
        priority,
        acceptance,
        steps,
        expected,
        actual,
        environment,
        files,
    ))
}

fn normalize_opt(value: Option<&str>, field: &str) -> AppResult<Option<String>> {
    match value {
        Some(v) if !v.trim().is_empty() => Ok(Some(validate_text(v, field, MAX_DESCRIPTION, false)?)),
        _ => Ok(None),
    }
}

pub fn create_issue(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    input: &IssueInput,
) -> AppResult<IssueCreateResult> {
    actor.require(Capability::IssuesWrite)?;
    assert_project_scope(conn, actor, project_id)?;

    let request_id = input
        .client_request_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| validate_text(s, "幂等键", 128, true))
        .transpose()?
        .unwrap_or_default();
    if !request_id.is_empty() {
        let existing: Option<Issue> = conn
            .query_row(
                &format!(
                    "SELECT {COLS} FROM collab_issues WHERE project_id=?1 AND client_request_id=?2"
                ),
                rusqlite::params![project_id, request_id],
                map_row,
            )
            .optional()?;
        if let Some(issue) = existing {
            return Ok(IssueCreateResult {
                issue,
                duplicate_candidates: Vec::new(),
                idempotent_replay: true,
            });
        }
    }

    let (kind, title, description, impact, priority, acceptance, steps, expected, actual, env, files) =
        validate_input(input)?;
    let dedupe_key = normalize_key(&title);
    let candidates = detect_duplicates_conn(conn, project_id, &kind, &title, &description, 5)?;

    let now = now_iso();
    let issue = Issue {
        id: new_id("ci"),
        project_id: project_id.to_string(),
        kind,
        title,
        description,
        impact,
        priority,
        status: "open".to_string(),
        acceptance,
        repro_steps: steps,
        expected_result: expected,
        actual_result: actual,
        environment: env,
        related_files: files,
        resolution: String::new(),
        assignee: validate_text(&input.assignee, "指派对象", 120, false)?,
        dedupe_key,
        source_agent: if actor.kind == super::actor::ActorKind::Agent {
            actor.name.clone()
        } else {
            String::new()
        },
        source_session: input
            .source_session
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_default(),
        source: actor.source.clone(),
        revision: 1,
        created_by: actor.id.clone(),
        updated_by: actor.id.clone(),
        created_at: now.clone(),
        updated_at: now,
    };

    conn.execute(
        &format!(
            "INSERT INTO collab_issues ({COLS}, client_request_id) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26)"
        ),
        rusqlite::params![
            issue.id,
            issue.project_id,
            issue.kind,
            issue.title,
            issue.description,
            issue.impact,
            issue.priority,
            issue.status,
            issue.acceptance,
            json_array(&issue.repro_steps),
            issue.expected_result,
            issue.actual_result,
            issue.environment,
            json_array(&issue.related_files),
            issue.resolution,
            issue.assignee,
            issue.dedupe_key,
            issue.source_agent,
            issue.source_session,
            issue.source,
            issue.revision,
            issue.created_by,
            issue.updated_by,
            issue.created_at,
            issue.updated_at,
            request_id,
        ],
    )?;

    write_audit(
        conn,
        project_id,
        "issue",
        &issue.id,
        "create",
        actor,
        None,
        Some(1),
        serde_json::json!({"kind": issue.kind, "title": issue.title}),
    )?;

    Ok(IssueCreateResult {
        issue,
        duplicate_candidates: candidates,
        idempotent_replay: false,
    })
}

pub fn update_issue(
    conn: &Connection,
    actor: &Actor,
    id: &str,
    expected_revision: i64,
    patch: &IssuePatch,
) -> AppResult<Issue> {
    actor.require(Capability::IssuesWrite)?;
    let current = load_issue(conn, id)?;
    assert_project_scope(conn, actor, &current.project_id)?;

    let mut next = current.clone();
    if let Some(v) = &patch.title {
        next.title = validate_text(v, "标题", MAX_TITLE, true)?;
        next.dedupe_key = normalize_key(&next.title);
    }
    if let Some(v) = &patch.description {
        next.description = validate_text(v, "描述", MAX_DESCRIPTION, false)?;
    }
    if let Some(v) = &patch.impact {
        next.impact = validate_text(v, "影响范围", MAX_DESCRIPTION, false)?;
    }
    if let Some(v) = &patch.priority {
        next.priority = validate_enum(v, PRIORITIES, "优先级")?;
    }
    if let Some(v) = &patch.acceptance {
        next.acceptance = validate_text(v, "验收要求", MAX_DESCRIPTION, false)?;
    }
    if let Some(v) = &patch.repro_steps {
        next.repro_steps = validate_string_list(v, "复现步骤", MAX_STEPS, 500)?;
    }
    if let Some(v) = &patch.expected_result {
        next.expected_result = normalize_opt(Some(v.as_str()), "预期结果")?;
    }
    if let Some(v) = &patch.actual_result {
        next.actual_result = normalize_opt(Some(v.as_str()), "实际结果")?;
    }
    if let Some(v) = &patch.environment {
        next.environment = normalize_opt(Some(v.as_str()), "发生环境")?;
    }
    if let Some(v) = &patch.related_files {
        next.related_files = validate_string_list(v, "相关文件", MAX_FILES, 500)?;
    }
    if let Some(v) = &patch.assignee {
        next.assignee = validate_text(v, "指派对象", 120, false)?;
    }
    if let Some(v) = &patch.status {
        let status = validate_enum(v, ISSUE_STATUSES, "状态")?;
        // verified/closed 只能通过 verify_bug（UI）完成，不能由普通更新绕过。
        if matches!(status.as_str(), "verified" | "closed" | "archived") {
            return Err(AppError::Forbidden(
                "该状态只能由验收/归档动作完成".to_string(),
            ));
        }
        next.status = status;
    }

    let revision = current.revision + 1;
    let now = now_iso();
    let changed = conn.execute(
        "UPDATE collab_issues SET title=?2, description=?3, impact=?4, priority=?5, status=?6,
         acceptance=?7, repro_steps=?8, expected_result=?9, actual_result=?10, environment=?11,
         related_files=?12, assignee=?13, dedupe_key=?14, revision=?15, updated_by=?16, updated_at=?17
         WHERE id=?1 AND revision=?18",
        rusqlite::params![
            id,
            next.title,
            next.description,
            next.impact,
            next.priority,
            next.status,
            next.acceptance,
            json_array(&next.repro_steps),
            next.expected_result,
            next.actual_result,
            next.environment,
            json_array(&next.related_files),
            next.assignee,
            next.dedupe_key,
            revision,
            actor.id,
            now,
            expected_revision,
        ],
    )?;
    if changed == 0 {
        return Err(AppError::Conflict(format!(
            "版本冲突：需求已被其他操作修改（当前 revision={}）",
            current.revision
        )));
    }

    // 变更审计只记录字段名，不复制正文。
    let mut fields = Vec::new();
    if patch.title.is_some() {
        fields.push("title");
    }
    if patch.description.is_some() {
        fields.push("description");
    }
    if patch.priority.is_some() {
        fields.push("priority");
    }
    if patch.status.is_some() {
        fields.push("status");
    }
    if patch.assignee.is_some() {
        fields.push("assignee");
    }
    if fields.is_empty() {
        fields.push("meta");
    }
    write_audit(
        conn,
        &current.project_id,
        "issue",
        id,
        "update",
        actor,
        Some(current.revision),
        Some(revision),
        serde_json::json!({"fields": fields}),
    )?;

    next.revision = revision;
    next.updated_at = now;
    next.updated_by = actor.id.clone();
    Ok(next)
}

pub fn archive_issue(
    conn: &Connection,
    actor: &Actor,
    id: &str,
    expected_revision: i64,
) -> AppResult<Issue> {
    actor.require(Capability::IssuesWrite)?;
    let current = load_issue(conn, id)?;
    assert_project_scope(conn, actor, &current.project_id)?;
    if current.status == "archived" {
        return Ok(current);
    }
    if current.revision != expected_revision {
        return Err(AppError::Conflict(format!(
            "版本冲突：当前 revision={}",
            current.revision
        )));
    }
    let now = now_iso();
    let changed = conn.execute(
        "UPDATE collab_issues SET status='archived', revision=revision+1, updated_by=?2, updated_at=?3
         WHERE id=?1 AND revision=?4",
        rusqlite::params![id, actor.id, now, expected_revision],
    )?;
    if changed == 0 {
        return Err(AppError::Conflict("版本冲突".to_string()));
    }
    write_audit(
        conn,
        &current.project_id,
        "issue",
        id,
        "archive",
        actor,
        Some(current.revision),
        Some(current.revision + 1),
        serde_json::json!({}),
    )?;
    load_issue(conn, id)
}

pub fn assign_issue(
    conn: &Connection,
    actor: &Actor,
    id: &str,
    expected_revision: i64,
    assignee: &str,
) -> AppResult<Issue> {
    update_issue(
        conn,
        actor,
        id,
        expected_revision,
        &IssuePatch {
            assignee: Some(assignee.to_string()),
            ..Default::default()
        },
    )
}

pub fn get_issue(conn: &Connection, actor: &Actor, id: &str) -> AppResult<IssueDetail> {
    actor.require(Capability::IssuesRead)?;
    let issue = load_issue(conn, id)?;
    assert_project_scope(conn, actor, &issue.project_id)?;

    let mut stmt = conn.prepare(
        "SELECT id, issue_id, target_kind, target_id, relation, created_by, created_at
         FROM collab_issue_links WHERE issue_id=?1 ORDER BY created_at DESC",
    )?;
    let links = stmt
        .query_map(rusqlite::params![id], |r| {
            Ok(IssueLink {
                id: r.get(0)?,
                issue_id: r.get(1)?,
                target_kind: r.get(2)?,
                target_id: r.get(3)?,
                relation: r.get(4)?,
                created_by: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let evidence = super::evidence::list_evidence(conn, actor, "issue", id).unwrap_or_default();
    let evidence_count = evidence.len() as i64;

    let plan_ids: Vec<String> = conn
        .prepare("SELECT id FROM collab_plans WHERE issue_id=?1 ORDER BY created_at DESC")?
        .query_map(rusqlite::params![id], |r| r.get(0))?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(IssueDetail {
        issue,
        links,
        evidence,
        plans: plan_ids,
        evidence_count,
    })
}

pub fn list_issues(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    filter: &IssueFilter,
) -> AppResult<Page<Issue>> {
    actor.require(Capability::IssuesRead)?;
    assert_project_scope(conn, actor, project_id)?;

    let (page, size, offset) = page_args(filter.page, filter.page_size);
    let mut where_sql = String::from("project_id=?1");
    let mut values: Vec<rusqlite::types::Value> = vec![project_id.to_string().into()];
    let include_archived = filter.include_archived.unwrap_or(false);
    if !include_archived && filter.status.as_deref() != Some("archived") {
        where_sql.push_str(" AND status<>'archived'");
    }
    if let Some(status) = &filter.status {
        validate_enum(status, ISSUE_STATUSES, "状态")?;
        values.push(status.clone().into());
        where_sql.push_str(&format!(" AND status=?{}", values.len()));
    }
    if let Some(kind) = &filter.kind {
        validate_enum(kind, ISSUE_KINDS, "类型")?;
        values.push(kind.clone().into());
        where_sql.push_str(&format!(" AND kind=?{}", values.len()));
    }
    if let Some(priority) = &filter.priority {
        validate_enum(priority, PRIORITIES, "优先级")?;
        values.push(priority.clone().into());
        where_sql.push_str(&format!(" AND priority=?{}", values.len()));
    }
    if let Some(search) = filter.search.as_deref().filter(|s| !s.trim().is_empty()) {
        let pattern = format!("%{}%", search.trim());
        values.push(pattern.clone().into());
        let idx = values.len();
        where_sql.push_str(&format!(
            " AND (title LIKE ?{idx} OR description LIKE ?{idx} OR acceptance LIKE ?{idx})"
        ));
    }

    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM collab_issues WHERE {where_sql}"),
        rusqlite::params_from_iter(values.iter()),
        |r| r.get(0),
    )?;

    values.push(size.into());
    let limit_idx = values.len();
    values.push(offset.into());
    let offset_idx = values.len();
    let sql = format!(
        "SELECT {COLS} FROM collab_issues WHERE {where_sql} \
         ORDER BY updated_at DESC LIMIT ?{limit_idx} OFFSET ?{offset_idx}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt
        .query_map(rusqlite::params_from_iter(values.iter()), map_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Page::new(items, total, page, size))
}

pub fn link_issue(
    conn: &Connection,
    actor: &Actor,
    id: &str,
    target_kind: &str,
    target_id: &str,
    relation: &str,
) -> AppResult<IssueDetail> {
    actor.require(Capability::IssuesWrite)?;
    let issue = load_issue(conn, id)?;
    assert_project_scope(conn, actor, &issue.project_id)?;
    let target_kind = validate_enum(target_kind, &["issue", "plan"], "关联目标类型")?;
    let relation = validate_enum(relation, ISSUE_LINK_RELATIONS, "关联关系")?;
    if target_kind == "issue" && target_id == id {
        return Err(AppError::Validation("不能关联自身".to_string()));
    }

    let target_project: Option<String> = match target_kind.as_str() {
        "issue" => conn
            .query_row(
                "SELECT project_id FROM collab_issues WHERE id=?1",
                rusqlite::params![target_id],
                |r| r.get(0),
            )
            .optional()?,
        "plan" => conn
            .query_row(
                "SELECT project_id FROM collab_plans WHERE id=?1",
                rusqlite::params![target_id],
                |r| r.get(0),
            )
            .optional()?,
        _ => None,
    };
    let target_project =
        target_project.ok_or_else(|| AppError::NotFound("关联目标不存在".to_string()))?;
    if target_project != issue.project_id {
        return Err(AppError::Forbidden("不能关联其他项目的数据".to_string()));
    }

    let inserted = conn.execute(
        "INSERT OR IGNORE INTO collab_issue_links
         (id, issue_id, target_kind, target_id, relation, created_by, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        rusqlite::params![
            new_id("il"),
            id,
            target_kind,
            target_id,
            relation,
            actor.id,
            now_iso()
        ],
    )?;
    if inserted > 0 {
        write_audit(
            conn,
            &issue.project_id,
            "issue",
            id,
            "link",
            actor,
            Some(issue.revision),
            Some(issue.revision),
            serde_json::json!({"targetKind": target_kind, "targetId": target_id, "relation": relation}),
        )?;
    }
    get_issue(conn, actor, id)
}

pub fn resolve_bug(
    conn: &Connection,
    actor: &Actor,
    id: &str,
    expected_revision: i64,
    resolution: &str,
) -> AppResult<Issue> {
    actor.require(Capability::IssuesWrite)?;
    let current = load_issue(conn, id)?;
    assert_project_scope(conn, actor, &current.project_id)?;
    if current.kind != "bug" {
        return Err(AppError::Validation("只有 Bug 可以执行解决动作".to_string()));
    }
    if current.revision != expected_revision {
        return Err(AppError::Conflict(format!(
            "版本冲突：当前 revision={}",
            current.revision
        )));
    }
    let resolution = validate_text(resolution, "解决说明", MAX_DESCRIPTION, true)?;
    let now = now_iso();
    let changed = conn.execute(
        "UPDATE collab_issues SET status='resolved', resolution=?2, revision=revision+1,
         updated_by=?3, updated_at=?4 WHERE id=?1 AND revision=?5",
        rusqlite::params![id, resolution, actor.id, now, expected_revision],
    )?;
    if changed == 0 {
        return Err(AppError::Conflict("版本冲突".to_string()));
    }
    write_audit(
        conn,
        &current.project_id,
        "issue",
        id,
        "resolve",
        actor,
        Some(current.revision),
        Some(current.revision + 1),
        serde_json::json!({"status": "resolved"}),
    )?;
    load_issue(conn, id)
}

pub fn verify_bug(
    conn: &Connection,
    actor: &Actor,
    id: &str,
    expected_revision: i64,
    evidence_id: &str,
) -> AppResult<Issue> {
    actor.require_review()?;
    let current = load_issue(conn, id)?;
    assert_project_scope(conn, actor, &current.project_id)?;
    if current.kind != "bug" {
        return Err(AppError::Validation("只有 Bug 可以被验收".to_string()));
    }
    if current.status != "resolved" && current.status != "verified" {
        return Err(AppError::Validation(
            "只有已解决的 Bug 可以验收".to_string(),
        ));
    }
    let evidence: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM collab_evidence WHERE id=?1 AND subject_id=?2",
            rusqlite::params![evidence_id, id],
            |r| r.get(0),
        )
        .optional()?;
    if evidence.is_none() {
        return Err(AppError::Validation(
            "验收必须关联该 Bug 的修复证据".to_string(),
        ));
    }
    if current.status == "verified" {
        return Ok(current);
    }
    if current.revision != expected_revision {
        return Err(AppError::Conflict(format!(
            "版本冲突：当前 revision={}",
            current.revision
        )));
    }
    let now = now_iso();
    let changed = conn.execute(
        "UPDATE collab_issues SET status='verified', revision=revision+1,
         updated_by=?2, updated_at=?3 WHERE id=?1 AND revision=?4",
        rusqlite::params![id, actor.id, now, expected_revision],
    )?;
    if changed == 0 {
        return Err(AppError::Conflict("版本冲突".to_string()));
    }
    write_audit(
        conn,
        &current.project_id,
        "issue",
        id,
        "verify",
        actor,
        Some(current.revision),
        Some(current.revision + 1),
        serde_json::json!({"evidenceId": evidence_id}),
    )?;
    load_issue(conn, id)
}

// ── 去重 ────────────────────────────────────────────────────────────────

fn ngrams(text: &str) -> BTreeSet<String> {
    let normalized = normalize_key(text);
    let chars: Vec<char> = normalized.chars().collect();
    if chars.len() <= 2 {
        return std::iter::once(normalized).collect();
    }
    chars
        .windows(2)
        .map(|w| w.iter().collect::<String>())
        .filter(|s| !s.trim().is_empty())
        .collect()
}

fn similarity(a: &str, b: &str) -> f64 {
    let left = ngrams(a);
    let right = ngrams(b);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let overlap = left.intersection(&right).count() as f64;
    let union = left.union(&right).count() as f64;
    if union == 0.0 {
        0.0
    } else {
        overlap / union
    }
}

pub fn detect_duplicates_conn(
    conn: &Connection,
    project_id: &str,
    kind: &str,
    title: &str,
    description: &str,
    limit: usize,
) -> AppResult<Vec<DuplicateCandidate>> {
    if title.trim().chars().count() < 2 {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT id, title, status, kind, description FROM collab_issues
         WHERE project_id=?1 AND kind=?2 AND status<>'archived'
         ORDER BY updated_at DESC LIMIT 40",
    )?;
    let rows = stmt.query_map(rusqlite::params![project_id, kind], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;
    let mut candidates = Vec::new();
    for row in rows {
        let (id, other_title, status, other_kind, other_desc) = row?;
        let score = similarity(&format!("{title} {description}"), &format!("{other_title} {other_desc}"));
        if score >= 0.25 {
            let reason = if score >= 0.6 {
                "标题/描述高度相似"
            } else {
                "标题/描述部分重合"
            };
            candidates.push(DuplicateCandidate {
                id,
                title: other_title,
                status,
                kind: other_kind,
                score: (score * 100.0).round() / 100.0,
                reason: reason.to_string(),
            });
        }
    }
    candidates.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    candidates.truncate(limit);
    Ok(candidates)
}

pub fn detect_duplicates(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    title: &str,
    description: &str,
) -> AppResult<Vec<DuplicateCandidate>> {
    actor.require(Capability::IssuesRead)?;
    assert_project_scope(conn, actor, project_id)?;
    let kind = "bug";
    detect_duplicates_conn(conn, project_id, kind, title, description, 8)
}

/// 读取某实体的全部证据（内部用，不重复鉴权）。
pub fn evidence_for(conn: &Connection, subject_kind: &str, subject_id: &str) -> AppResult<Vec<Evidence>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, subject_kind, subject_id, kind, title, path, sha256, size_bytes,
                mime, meta_json, created_by, source, created_at
         FROM collab_evidence WHERE subject_kind=?1 AND subject_id=?2 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![subject_kind, subject_id], |r| {
        Ok(Evidence {
            id: r.get(0)?,
            project_id: r.get(1)?,
            subject_kind: r.get(2)?,
            subject_id: r.get(3)?,
            kind: r.get(4)?,
            title: r.get(5)?,
            path: r.get(6)?,
            sha256: r.get(7)?,
            size_bytes: r.get(8)?,
            mime: r.get(9)?,
            meta_json: r.get(10)?,
            created_by: r.get(11)?,
            source: r.get(12)?,
            created_at: r.get(13)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

#[allow(dead_code)]
fn unused_statuses() -> &'static [&'static str] {
    ISSUE_STATUSES
}
