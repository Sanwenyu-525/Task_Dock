//! 开发领域只读取库内快照与证据元信息。Agent 可关联已有证据，验收结论由验收记录提供。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent_access::permissions;
use crate::agent_access::store::WriteGuard;
use crate::agent_access::{Page, Principal};
use crate::commands::development_workspace::dws_task_link_save_in_conn;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::policy::{page_window, resolve_authorized_project, resource_access_error};
use super::registry::{DomainKind, DomainOperationDef, Interface, OperationAccess};

const INTERFACES: &[Interface] = &[Interface::Cli, Interface::Mcp, Interface::Rest];
const LINK: &str = "development.task_link";
const CREATE_LINK: &str = "development.task_link.create";

pub const OPERATIONS: &[DomainOperationDef] = &[
    read_def("development.summary.get", "development.summary"),
    read_def("development.git.snapshot.get", "development.git"),
    read_def(
        "development.task_evidence.list",
        "development.task_evidence",
    ),
    DomainOperationDef {
        id: CREATE_LINK,
        domain: DomainKind::Development,
        access: OperationAccess::Write,
        resource_kind: LINK,
        permission: Capability::ProjectsWrite,
        interfaces: &[
            Interface::Cli,
            Interface::Mcp,
            Interface::Rest,
            Interface::File,
        ],
        revision_required: false,
        request_id_required: true,
        max_payload_bytes: Some(4096),
    },
];

const fn read_def(id: &'static str, resource_kind: &'static str) -> DomainOperationDef {
    DomainOperationDef {
        id,
        domain: DomainKind::Development,
        access: OperationAccess::Read,
        resource_kind,
        permission: Capability::ProjectsRead,
        interfaces: INTERFACES,
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    }
}

pub fn get_summary(db: &Db, principal: &Principal, project_ref: &str) -> AppResult<Value> {
    db.with_read(|conn| {
        let project = resolve_authorized_project(
            conn,
            principal,
            project_ref,
            DomainKind::Development,
            false,
        )?;
        conn.query_row(
            "SELECT name, status, EXISTS(SELECT 1 FROM dws_workspace_probes WHERE project_id=p.id)
             FROM workspace_projects p WHERE p.id=?1",
            [&project],
            |row| {
                Ok(json!({
                    "projectId": project,
                    "name": row.get::<_, String>(0)?,
                    "status": row.get::<_, String>(1)?,
                    "hasGitSnapshot": row.get::<_, bool>(2)?,
                }))
            },
        )
        .map_err(AppError::from)
    })
}

pub fn get_git_snapshot(db: &Db, principal: &Principal, project_ref: &str) -> AppResult<Value> {
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Development, false)?;
        Ok(conn
            .query_row(
                "SELECT probed_at, git_status, branch, detached, head_sha, dirty_count, is_worktree
                 FROM dws_workspace_probes WHERE project_id=?1 ORDER BY probed_at DESC, id DESC LIMIT 1",
                [&project],
                |row| {
                    Ok(json!({
                        "projectId": project,
                        "probedAt": row.get::<_, String>(0)?,
                        "status": row.get::<_, String>(1)?,
                        "branch": row.get::<_, Option<String>>(2)?,
                        "detached": row.get::<_, bool>(3)?,
                        "headSha": row.get::<_, Option<String>>(4)?,
                        "dirtyCount": row.get::<_, Option<i64>>(5)?,
                        "isWorktree": row.get::<_, bool>(6)?,
                    }))
                },
            )
            .optional()?
            .unwrap_or(Value::Null))
    })
}

pub(crate) fn require_project_task(
    conn: &Connection,
    principal: &Principal,
    project: &str,
    task: &str,
) -> AppResult<()> {
    let linked: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM workspace_task_links l JOIN tasks t ON t.id=l.task_id
             WHERE l.project_id=?1 AND l.task_id=?2
         )",
        params![project, task],
        |row| row.get(0),
    )?;
    if !linked {
        return Err(resource_access_error());
    }
    if let Some(grant) = &principal.import {
        let agent = grant.agent_row_id.as_deref().ok_or_else(|| {
            AppError::Forbidden("开发证据导入需要绑定有任务读取权限的 Agent".into())
        })?;
        return permissions::require_agent_in_conn(conn, agent, Capability::TasksRead, task);
    }
    permissions::require_in_conn(conn, principal, Capability::TasksRead, task)
}

pub fn list_task_evidence(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    task: &str,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<(Vec<Value>, Page)> {
    let (limit, offset) = page_window(limit, offset);
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Development, false)?;
        let task = task.trim();
        require_project_task(conn, principal, &project, task)?;
        let total: u32 = conn.query_row(
            "SELECT (SELECT COUNT(*) FROM dev_handoff_packs WHERE task_id=?1)
                  + (SELECT COUNT(*) FROM dev_acceptance_records WHERE subject_kind='task' AND subject_id=?1)",
            [task],
            |row| row.get(0),
        )?;
        let mut stmt = conn.prepare(
            "WITH evidence(id, kind, title, verdict, created_at) AS (
                 SELECT id, 'handoff', title, NULL, created_at FROM dev_handoff_packs WHERE task_id=?1
                 UNION ALL
                 SELECT id, 'acceptance', NULL, verdict, created_at
                 FROM dev_acceptance_records WHERE subject_kind='task' AND subject_id=?1
             )
             SELECT e.*, EXISTS (
                 SELECT 1 FROM dws_task_links l WHERE l.project_id=?2 AND l.task_id=?1
                 AND ((e.kind='handoff' AND l.handoff_pack_id=e.id)
                      OR (e.kind='acceptance' AND l.acceptance_record_id=e.id))
             )
             FROM evidence e ORDER BY created_at DESC, kind, id LIMIT ?3 OFFSET ?4",
        )?;
        let rows = stmt
            .query_map(params![task, project, limit, offset], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "kind": row.get::<_, String>(1)?,
                    "title": row.get::<_, Option<String>>(2)?,
                    "verdict": row.get::<_, Option<String>>(3)?,
                    "createdAt": row.get::<_, String>(4)?,
                    "linked": row.get::<_, bool>(5)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((rows, Page::new(limit, offset, total)))
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateTaskLinkInput {
    pub task_id: String,
    pub handoff_pack_id: Option<String>,
    pub acceptance_record_id: Option<String>,
    pub note: Option<String>,
}

pub fn create_task_link_in_conn(
    conn: &Connection,
    principal: &Principal,
    project_ref: &str,
    input: CreateTaskLinkInput,
    guard: &dyn WriteGuard,
) -> AppResult<Value> {
    let project =
        resolve_authorized_project(conn, principal, project_ref, DomainKind::Development, true)?;
    let task = input.task_id.trim();
    require_project_task(conn, principal, &project, task)?;
    let pack = input
        .handoff_pack_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let record = input
        .acceptance_record_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if pack.is_none() && record.is_none() {
        return Err(AppError::Validation(
            "需提供任务的交接包或验收记录 ID".into(),
        ));
    }
    if let Some(pack) = pack {
        let valid = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM dev_handoff_packs WHERE id=?1 AND task_id=?2)",
            params![pack, task],
            |row| row.get::<_, bool>(0),
        )?;
        if !valid {
            return Err(resource_access_error());
        }
    }
    if let Some(record) = record {
        let valid = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM dev_acceptance_records
             WHERE id=?1 AND subject_kind='task' AND subject_id=?2)",
            params![record, task],
            |row| row.get::<_, bool>(0),
        )?;
        if !valid {
            return Err(resource_access_error());
        }
    }
    let saved = dws_task_link_save_in_conn(
        conn,
        &project,
        Some(task.to_string()),
        None,
        pack.map(str::to_string),
        None,
        record.map(str::to_string),
        input.note,
        true,
    )?;
    guard.record_operation(conn, LINK, &saved.id)?;
    Ok(json!({
        "id": saved.id, "projectId": project, "taskId": task,
        "handoffPackId": saved.handoff_pack_id, "acceptanceRecordId": saved.acceptance_record_id,
        "note": saved.note, "updatedAt": saved.updated_at,
    }))
}

fn read_link(conn: &Connection, principal: &Principal, id: &str) -> AppResult<Value> {
    let (project, task, pack, record, note, updated): (
        String,
        String,
        String,
        String,
        String,
        String,
    ) = conn
        .query_row(
            "SELECT project_id, task_id, handoff_pack_id, acceptance_record_id, note, updated_at
             FROM dws_task_links WHERE id=?1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(resource_access_error)?;
    resolve_authorized_project(conn, principal, &project, DomainKind::Development, false)?;
    require_project_task(conn, principal, &project, &task)?;
    Ok(json!({
        "id": id, "projectId": project, "taskId": task,
        "handoffPackId": pack, "acceptanceRecordId": record, "note": note, "updatedAt": updated,
    }))
}

pub fn create_task_link_with_guard(
    db: &Db,
    principal: &Principal,
    project: &str,
    input: CreateTaskLinkInput,
    guard: &dyn WriteGuard,
) -> AppResult<Value> {
    db.with_transaction(|conn| {
        guard.check(conn)?;
        let value = create_task_link_in_conn(conn, principal, project, input, guard)?;
        guard.complete(conn)?;
        Ok(value)
    })
}

pub fn create_task_link_with_request(
    db: &Db,
    principal: &Principal,
    project: &str,
    input: CreateTaskLinkInput,
    request_id: &str,
    guard: &dyn WriteGuard,
) -> AppResult<Value> {
    let payload = json!({ "projectId": project, "input": input });
    super::idempotency::execute(
        db,
        principal,
        CREATE_LINK,
        project,
        request_id,
        &payload,
        guard,
        |conn, kind, id| {
            if kind != LINK {
                return Err(resource_access_error());
            }
            read_link(conn, principal, id)
        },
        |conn, guard| create_task_link_in_conn(conn, principal, project, input, guard),
    )
}

pub fn rebuild_committed(db: &Db, principal: &Principal, id: &str) -> AppResult<Value> {
    db.with_read(|conn| read_link(conn, principal, id))
}
