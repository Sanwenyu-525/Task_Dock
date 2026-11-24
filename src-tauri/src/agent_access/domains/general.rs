//! 通用项目领域：真实统计、里程碑与资料登记摘要。
//!
//! 业务读写复用 `commands::general_workspace` 的同连接核心；本模块只负责
//! 授权、归属、乐观版本与 Agent DTO，不打开资料、不读取关联资源正文。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::agent_access::store::WriteGuard;
use crate::agent_access::{Page, Principal};
use crate::commands::general_workspace::{
    general_material_summary_page_in_conn, general_milestone_list_page_in_conn,
    general_milestone_read_in_conn, general_milestone_save_in_conn, general_stats_summary_in_conn,
    GeneralMaterialSummary, GeneralMilestone, GeneralStatsSummary,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::policy::{page_window, resolve_authorized_project, resource_access_error};
use super::registry::{DomainKind, DomainOperationDef, Interface, OperationAccess};
use super::revision::{bump_revision_from, read_revision_snapshot};

pub const OPERATIONS: &[DomainOperationDef] = &[
    DomainOperationDef {
        id: "general.milestone.list",
        domain: DomainKind::General,
        access: OperationAccess::Read,
        resource_kind: "general.milestone",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "general.milestone.save",
        domain: DomainKind::General,
        access: OperationAccess::Write,
        resource_kind: "general.milestone",
        permission: Capability::ProjectsWrite,
        interfaces: &[
            Interface::Cli,
            Interface::Mcp,
            Interface::Rest,
            Interface::File,
        ],
        // 创建没有旧版本；已有 id 的更新由领域核心强制要求 expected_revision。
        revision_required: false,
        request_id_required: true,
        max_payload_bytes: Some(32 * 1024),
    },
    DomainOperationDef {
        id: "general.material.list",
        domain: DomainKind::General,
        access: OperationAccess::Read,
        resource_kind: "general.material",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "general.stats.read",
        domain: DomainKind::General,
        access: OperationAccess::Read,
        resource_kind: "general.stats",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
];

/// Agent 仅能编辑里程碑本身，关联事项/任务仍由桌面 UI 管理。
/// 更新时缺省字段保留原值；空 target_date/note 可明确清空对应内容。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveMilestoneInput {
    pub id: Option<String>,
    pub title: String,
    pub target_date: Option<String>,
    pub status: Option<String>,
    pub note: Option<String>,
    pub sort_order: Option<i64>,
    pub expected_revision: Option<i64>,
}

/// 不暴露弱引用目标的 ID/标题，项目读取授权不扩张为任务或笔记读取授权。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMilestone {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub target_date: Option<String>,
    pub status: String,
    pub note: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
}

/// 只有登记元数据，没有原始路径、URL、笔记 ID/标题或文件存在性。
pub type AgentMaterial = GeneralMaterialSummary;
/// 聚合计数没有文件可用性或外部资源活动明细。
pub type AgentGeneralStats = GeneralStatsSummary;

fn milestone_dto(conn: &Connection, row: GeneralMilestone) -> AppResult<AgentMilestone> {
    let snapshot = read_revision_snapshot(conn, "general.milestone", &row.id, &row.updated_at)?;
    Ok(AgentMilestone {
        id: row.id,
        project_id: row.project_id,
        title: row.title,
        target_date: row.target_date,
        status: row.status,
        note: row.note,
        sort_order: row.sort_order,
        created_at: row.created_at,
        updated_at: row.updated_at,
        revision: snapshot.revision,
    })
}

pub fn list_milestones(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<(Vec<AgentMilestone>, Page)> {
    let (limit, offset) = page_window(limit, offset);
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::General, false)?;
        let (rows, total) = general_milestone_list_page_in_conn(conn, &project, limit, offset)?;
        let rows = rows
            .into_iter()
            .map(|row| milestone_dto(conn, row))
            .collect::<AppResult<Vec<_>>>()?;
        Ok((rows, Page::new(limit, offset, total)))
    })
}

pub fn list_materials(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<(Vec<AgentMaterial>, Page)> {
    let (limit, offset) = page_window(limit, offset);
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::General, false)?;
        let (rows, total) = general_material_summary_page_in_conn(conn, &project, limit, offset)?;
        Ok((rows, Page::new(limit, offset, total)))
    })
}

pub fn read_stats(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
) -> AppResult<AgentGeneralStats> {
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::General, false)?;
        general_stats_summary_in_conn(conn, &project)
    })
}

fn owned_milestone(conn: &Connection, project: &str, id: &str) -> AppResult<GeneralMilestone> {
    let row = general_milestone_read_in_conn(conn, id).map_err(|err| match err {
        AppError::NotFound(_) => resource_access_error(),
        other => other,
    })?;
    if row.project_id != project {
        return Err(resource_access_error());
    }
    Ok(row)
}

/// 四入口可共用的事务内核心；不创建事务或 requestId，不产生第二条 Operation。
pub fn save_milestone_in_conn(
    conn: &Connection,
    principal: &Principal,
    project_ref: &str,
    input: SaveMilestoneInput,
    guard: &dyn WriteGuard,
) -> AppResult<AgentMilestone> {
    let project =
        resolve_authorized_project(conn, principal, project_ref, DomainKind::General, true)?;
    let before = match input.id.as_deref() {
        Some(id) if id.trim().is_empty() => {
            return Err(AppError::Validation("里程碑 ID 不能为空".into()));
        }
        Some(id) => Some(owned_milestone(conn, &project, id.trim())?),
        None => None,
    };
    if let Some(row) = &before {
        let expected = input
            .expected_revision
            .ok_or_else(|| AppError::Validation("更新里程碑必须提供 expected_revision".into()))?;
        let current = read_revision_snapshot(conn, "general.milestone", &row.id, &row.updated_at)?;
        if current.revision != expected {
            return Err(AppError::Conflict(format!(
                "版本冲突：expected_revision={expected}，当前 revision={}",
                current.revision
            )));
        }
    } else if input.expected_revision.is_some() {
        return Err(AppError::Validation(
            "创建里程碑不接受 expected_revision".into(),
        ));
    }

    let target_date = input
        .target_date
        .or_else(|| before.as_ref().and_then(|row| row.target_date.clone()));
    let status = input
        .status
        .or_else(|| before.as_ref().map(|row| row.status.clone()));
    let note = input
        .note
        .or_else(|| before.as_ref().map(|row| row.note.clone()));
    let sort_order = input
        .sort_order
        .or_else(|| before.as_ref().map(|row| row.sort_order));
    let linked_item_id = before.as_ref().and_then(|row| row.linked_item_id.clone());
    let linked_task_id = before.as_ref().and_then(|row| row.linked_task_id.clone());
    guard.check(conn)?;
    let saved = general_milestone_save_in_conn(
        conn,
        input.id,
        project,
        input.title,
        target_date,
        status,
        note,
        linked_item_id,
        linked_task_id,
        sort_order,
    )?;
    let revision = bump_revision_from(
        conn,
        "general.milestone",
        &saved.id,
        input.expected_revision,
        principal,
        before.as_ref().map_or("", |row| row.updated_at.as_str()),
        &saved.updated_at,
        "",
    )?;
    guard.record_operation(conn, "general.milestone", &saved.id)?;
    let mut result = milestone_dto(conn, saved)?;
    result.revision = revision;
    Ok(result)
}

pub fn save_milestone_with_guard(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    input: SaveMilestoneInput,
    guard: &dyn WriteGuard,
) -> AppResult<AgentMilestone> {
    db.with_transaction(|conn| {
        guard.check(conn)?;
        let result = save_milestone_in_conn(conn, principal, project_ref, input, guard)?;
        guard.complete(conn)?;
        Ok(result)
    })
}

pub fn save_milestone_with_request(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    input: SaveMilestoneInput,
    request_id: &str,
    guard: &dyn WriteGuard,
) -> AppResult<AgentMilestone> {
    let payload = serde_json::json!({ "projectId": project_ref, "input": input });
    super::idempotency::execute(
        db,
        principal,
        "general.milestone.save",
        project_ref,
        request_id,
        &payload,
        guard,
        |conn, kind, id| {
            if kind != "general.milestone" {
                return Err(resource_access_error());
            }
            let project = resolve_authorized_project(
                conn,
                principal,
                project_ref,
                DomainKind::General,
                false,
            )?;
            milestone_dto(conn, owned_milestone(conn, &project, id)?)
        },
        |conn, stacked| save_milestone_in_conn(conn, principal, project_ref, input, stacked),
    )
}

/// REST 提交响应丢失后的恢复只读已提交资源，不执行第二次写入。
pub fn rebuild_committed(db: &Db, principal: &Principal, id: &str) -> AppResult<serde_json::Value> {
    db.with_read(|conn| {
        let row = general_milestone_read_in_conn(conn, id)?;
        let project = resolve_authorized_project(
            conn,
            principal,
            &row.project_id,
            DomainKind::General,
            false,
        )?;
        let result = milestone_dto(conn, owned_milestone(conn, &project, id)?)?;
        Ok(serde_json::to_value(result)?)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_access::store::NoGuard;
    use crate::agent_access::Source;
    use crate::commands::general_workspace::general_milestone_save_impl;
    use crate::mcp::{auth, permissions};
    use rusqlite::params;
    use serde_json::json;

    fn seed_project(db: &Db, kind: &str, status: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspace_projects
                 (id, name, kind, status, root_path, note, created_at, updated_at)
                 VALUES (?1, '领域测试', ?2, ?3, '', '', '2026-11-24', '2026-11-24')",
                params![id, kind, status],
            )?;
            Ok(())
        })
        .unwrap();
        id
    }

    fn input(value: serde_json::Value) -> SaveMilestoneInput {
        serde_json::from_value(value).unwrap()
    }

    fn local() -> Principal {
        Principal::local(Source::Cli)
    }

    #[test]
    fn milestone_ui_agent_versions_and_omitted_fields_preserve_existing_data() {
        let db = Db::open_in_memory().unwrap();
        let project = seed_project(&db, "general", "active");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tasks (id, title, created_at, updated_at)
                 VALUES ('general-task', '外部任务标题', '2026-11-24', '2026-11-24')",
                [],
            )?;
            conn.execute(
                "INSERT INTO workspace_task_links (project_id, task_id, created_at)
                 VALUES (?1, 'general-task', '2026-11-24')",
                [&project],
            )?;
            Ok(())
        })
        .unwrap();
        let ui = general_milestone_save_impl(
            &db,
            None,
            project.clone(),
            "桌面里程碑".into(),
            Some("2026-12-01".into()),
            Some("done".into()),
            Some("保留备注".into()),
            None,
            Some("general-task".into()),
            Some(7),
        )
        .unwrap()
        .milestone;
        let (rows, _) = list_milestones(&db, &local(), &project, None, None).unwrap();
        assert_eq!(rows[0].revision, 1);
        assert!(!serde_json::to_string(&rows)
            .unwrap()
            .contains("外部任务标题"));
        let saved = save_milestone_with_guard(
            &db,
            &local(),
            &project,
            input(json!({"id": ui.id, "title": "Agent 改名", "expected_revision": 1})),
            &NoGuard,
        )
        .unwrap();
        assert_eq!(saved.revision, 2);
        assert_eq!(saved.target_date.as_deref(), Some("2026-12-01"));
        assert_eq!(saved.status, "done");
        assert_eq!(saved.note, "保留备注");
        assert_eq!(saved.sort_order, 7);
        let raw = db
            .with_read(|conn| general_milestone_read_in_conn(conn, &ui.id))
            .unwrap();
        assert_eq!(raw.linked_task_id.as_deref(), Some("general-task"));

        general_milestone_save_impl(
            &db,
            Some(ui.id.clone()),
            project.clone(),
            "UI 再改".into(),
            raw.target_date,
            Some(raw.status),
            Some(raw.note),
            raw.linked_item_id,
            raw.linked_task_id,
            Some(raw.sort_order),
        )
        .unwrap();
        let stale = save_milestone_with_guard(
            &db,
            &local(),
            &project,
            input(json!({"id": ui.id, "title": "过期覆盖", "expected_revision": 2})),
            &NoGuard,
        );
        assert!(matches!(stale, Err(AppError::Conflict(_))));
        let cleared = save_milestone_with_guard(
            &db,
            &local(),
            &project,
            input(
                json!({"id": ui.id, "title": "明确清空", "expected_revision": 3,
                "note": "", "target_date": ""}),
            ),
            &NoGuard,
        )
        .unwrap();
        assert_eq!(cleared.revision, 4);
        assert_eq!(cleared.target_date, None);
        assert_eq!(cleared.note, "");
    }

    #[test]
    fn general_queries_page_beyond_legacy_cap_and_never_return_material_targets() {
        let db = Db::open_in_memory().unwrap();
        let project = seed_project(&db, "general", "active");
        db.with_transaction(|conn| {
            for n in 0..205 {
                conn.execute(
                    "INSERT INTO general_milestones
                     (id, project_id, title, created_at, updated_at, sort_order)
                     VALUES (?1, ?2, '里程碑', '2026-11-24', '2026-11-24', ?3)",
                    params![format!("milestone-{n}"), project, n],
                )?;
                conn.execute(
                    "INSERT INTO general_materials
                     (id, project_id, kind, title, path, created_at, updated_at, sort_order)
                     VALUES (?1, ?2, 'file', '登记摘要', '\\\\private-host\\secret\\data.txt',
                     '2026-11-24', '2026-11-24', ?3)",
                    params![format!("material-{n}"), project, n],
                )?;
            }
            Ok(())
        })
        .unwrap();
        let (rows, page) = list_milestones(&db, &local(), &project, Some(999), Some(200)).unwrap();
        assert_eq!(rows.len(), 5);
        assert_eq!(page.total, 205);
        assert!(!page.has_more);
        let (materials, page) = list_materials(&db, &local(), &project, None, None).unwrap();
        assert_eq!(materials.len(), 50);
        assert_eq!(page.total, 205);
        assert_eq!(page.next_offset, Some(50));
        let json = serde_json::to_string(&materials).unwrap();
        assert!(!json.contains("private-host"));
        assert!(!json.contains("path"));
        assert!(!json.contains("alive"));
        let stats = read_stats(&db, &local(), &project).unwrap();
        assert_eq!(stats.milestones_total, 205);
        assert_eq!(stats.materials_total, 205);
        assert_eq!(stats.total_items, 0);
    }

    #[test]
    fn milestone_save_rejects_cross_project_archived_unknown_id_and_missing_revision() {
        let db = Db::open_in_memory().unwrap();
        let project = seed_project(&db, "general", "active");
        let other = seed_project(&db, "general", "active");
        let archived = seed_project(&db, "general", "archived");
        let novel = seed_project(&db, "novel", "active");
        let saved = save_milestone_with_guard(
            &db,
            &local(),
            &project,
            input(json!({"title": "创建"})),
            &NoGuard,
        )
        .unwrap();
        assert_eq!(saved.revision, 1);
        for value in [
            json!({"id": saved.id, "title": "缺少版本"}),
            json!({"id": "unknown", "title": "不得变相创建", "expected_revision": 0}),
            json!({"id": "", "title": "不得变相创建"}),
        ] {
            assert!(
                save_milestone_with_guard(&db, &local(), &project, input(value), &NoGuard).is_err()
            );
        }
        assert!(matches!(
            save_milestone_with_guard(
                &db,
                &local(),
                &other,
                input(json!({"id": saved.id, "title": "越权", "expected_revision": 1})),
                &NoGuard
            ),
            Err(AppError::Forbidden(_))
        ));
        assert!(read_stats(&db, &local(), &archived).is_ok());
        assert!(save_milestone_with_guard(
            &db,
            &local(),
            &archived,
            input(json!({"title": "归档只读"})),
            &NoGuard
        )
        .is_err());
        assert!(read_stats(&db, &local(), &novel).is_err());
        assert!(serde_json::from_value::<SaveMilestoneInput>(
            json!({"title": "拒绝旁路", "linked_task_id": "task"})
        )
        .is_err());
        assert_eq!(
            read_stats(&db, &local(), &project)
                .unwrap()
                .milestones_total,
            1
        );
    }

    #[test]
    fn registered_agent_grants_and_capabilities_are_rechecked() {
        let db = Db::open_in_memory().unwrap();
        let project = seed_project(&db, "general", "active");
        let created = auth::create_agent(&db, "general-domain-agent", "通用领域测试").unwrap();
        auth::set_agent_scope(&db, &created.info.id, "project_rw").unwrap();
        permissions::grant(&db, &created.info.id, "projects.read", "").unwrap();
        permissions::grant(&db, &created.info.id, "projects.write", "").unwrap();
        let principal =
            Principal::agent(created.info.id.clone(), created.info.agent_id, Source::Mcp);
        let err = read_stats(&db, &principal, &project).unwrap_err();
        assert_eq!(crate::agent_access::error_code(&err), "FORBIDDEN");
        auth::grant_project(&db, &created.info.id, &project).unwrap();
        let saved = save_milestone_with_guard(
            &db,
            &principal,
            &project,
            input(json!({"title": "授权创建"})),
            &NoGuard,
        )
        .unwrap();
        auth::revoke_project(&db, &created.info.id, &project).unwrap();
        let err = save_milestone_with_guard(
            &db,
            &principal,
            &project,
            input(json!({"id": saved.id, "title": "撤权后禁止", "expected_revision": 1})),
            &NoGuard,
        )
        .unwrap_err();
        assert_eq!(crate::agent_access::error_code(&err), "FORBIDDEN");
    }

    #[test]
    fn failed_commit_guard_rolls_back_business_and_revision() {
        struct RejectCommit;
        impl WriteGuard for RejectCommit {
            fn check(&self, _: &Connection) -> AppResult<()> {
                Ok(())
            }
            fn complete(&self, _: &Connection) -> AppResult<()> {
                Err(AppError::Conflict("操作租约已失效".into()))
            }
        }
        let db = Db::open_in_memory().unwrap();
        let project = seed_project(&db, "general", "active");
        assert!(save_milestone_with_guard(
            &db,
            &local(),
            &project,
            input(json!({"title": "不得提交"})),
            &RejectCommit,
        )
        .is_err());
        assert_eq!(
            read_stats(&db, &local(), &project)
                .unwrap()
                .milestones_total,
            0
        );
        let revisions: i64 = db.with_read(|conn| Ok(conn.query_row(
            "SELECT COUNT(*) FROM agent_resource_revisions WHERE resource_kind = 'general.milestone'",
            [], |row| row.get(0),
        )?)).unwrap();
        assert_eq!(revisions, 0);
    }
}
