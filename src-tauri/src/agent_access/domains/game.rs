//! 游戏领域的登记数据能力；不执行引擎、构建、测试或读取登记文件。
//! 写核心复用 Game 命令层，在入口持有的同一事务内完成归属、版本和操作记录。

use std::path::{Component, Path};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::agent_access::store::WriteGuard;
use crate::agent_access::{Page, Principal};
use crate::commands::game_workspace::{
    game_asset_list_page_in_conn, game_build_get_in_conn, game_build_list_page_in_conn,
    game_build_save_in_conn, game_project_facts_get_in_conn, game_test_get_in_conn,
    game_test_list_page_in_conn, game_test_save_in_conn, GameAsset, GameBuild, GameTestRecord,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::policy::{page_window, resolve_authorized_project, resource_access_error};
use super::registry::{DomainKind, DomainOperationDef, Interface, OperationAccess};
use super::revision::{bump_revision_from, read_revision_snapshot};

pub const MAX_CREATE_PAYLOAD_BYTES: usize = 16 * 1024;

pub const OPERATIONS: &[DomainOperationDef] = &[
    DomainOperationDef {
        id: "game.facts.get",
        domain: DomainKind::Game,
        access: OperationAccess::Read,
        resource_kind: "game.facts",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "game.asset.list",
        domain: DomainKind::Game,
        access: OperationAccess::Read,
        resource_kind: "game.asset",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "game.build.list",
        domain: DomainKind::Game,
        access: OperationAccess::Read,
        resource_kind: "game.build",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "game.test.list",
        domain: DomainKind::Game,
        access: OperationAccess::Read,
        resource_kind: "game.test",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "game.build.create",
        domain: DomainKind::Game,
        access: OperationAccess::Write,
        resource_kind: "game.build",
        permission: Capability::ProjectsWrite,
        interfaces: &[
            Interface::Cli,
            Interface::Mcp,
            Interface::Rest,
            Interface::File,
        ],
        revision_required: false,
        request_id_required: true,
        max_payload_bytes: Some(MAX_CREATE_PAYLOAD_BYTES),
    },
    DomainOperationDef {
        id: "game.test.create",
        domain: DomainKind::Game,
        access: OperationAccess::Write,
        resource_kind: "game.test",
        permission: Capability::ProjectsWrite,
        interfaces: &[
            Interface::Cli,
            Interface::Mcp,
            Interface::Rest,
            Interface::File,
        ],
        revision_required: false,
        request_id_required: true,
        max_payload_bytes: Some(MAX_CREATE_PAYLOAD_BYTES),
    },
];

/// 只允许登记元数据：ID 与来源由服务端决定，不接收本机路径或执行参数。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateBuildInput {
    pub target: String,
    pub engine: Option<String>,
    pub config: Option<String>,
    pub status: String,
    pub built_at: Option<String>,
    pub log_summary: Option<String>,
    pub item_id: Option<String>,
    pub note: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateTestInput {
    pub build_id: Option<String>,
    pub title: String,
    pub scope: Option<String>,
    pub result: String,
    pub tested_at: Option<String>,
    pub summary: Option<String>,
    pub defect_count: Option<i64>,
    pub item_id: Option<String>,
    pub note: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGameFact {
    pub id: String,
    pub project_id: String,
    pub engine: String,
    pub detection_method: String,
    pub engine_version: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGameAsset {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub name: String,
    /// 仅供展示的词法相对引用；不代表文件存在，也不是文件读取授权。
    pub relative_path: Option<String>,
    pub size_bytes: i64,
    pub modified_at: String,
    pub item_id: Option<String>,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGameBuild {
    pub id: String,
    pub project_id: String,
    pub target: String,
    pub engine: String,
    pub config: String,
    /// 登记者报告的状态，不是 Task Dock 执行或验证的结果。
    pub status: String,
    pub built_at: String,
    pub log_summary: String,
    pub source: String,
    pub item_id: Option<String>,
    pub note: String,
    pub verification_status: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGameTest {
    pub id: String,
    pub project_id: String,
    pub build_id: Option<String>,
    pub title: String,
    pub scope: String,
    /// 登记者报告的结果，不是 Task Dock 执行或验证的结果。
    pub result: String,
    pub tested_at: String,
    pub summary: String,
    pub defect_count: i64,
    pub item_id: Option<String>,
    pub note: String,
    pub verification_status: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
}

fn safe_relative_path(root: &str, raw: &str) -> Option<String> {
    let root = Path::new(root);
    let file = Path::new(raw);
    if !root.is_absolute() || !file.is_absolute() {
        return None;
    }
    let root: Vec<_> = root.components().collect();
    let file: Vec<_> = file.components().collect();
    if file.len() <= root.len()
        || root
            .iter()
            .chain(file.iter())
            .any(|c| matches!(c, Component::ParentDir))
    {
        return None;
    }
    for (a, b) in root.iter().zip(file.iter()) {
        let equal = if cfg!(windows) {
            a.as_os_str().to_string_lossy().to_lowercase()
                == b.as_os_str().to_string_lossy().to_lowercase()
        } else {
            a == b
        };
        if !equal {
            return None;
        }
    }
    file[root.len()..]
        .iter()
        .map(|c| match c {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .map(|parts| parts.join("/"))
}

fn linked_item(conn: &Connection, project: &str, id: Option<String>) -> AppResult<Option<String>> {
    let Some(id) = id else {
        return Ok(None);
    };
    let visible: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspace_items WHERE id = ?1 AND project_id = ?2)",
        rusqlite::params![id, project],
        |r| r.get(0),
    )?;
    Ok(visible.then_some(id))
}

fn asset_dto(conn: &Connection, root: &str, row: GameAsset) -> AppResult<AgentGameAsset> {
    let revision = read_revision_snapshot(conn, "game.asset", &row.id, &row.updated_at)?.revision;
    Ok(AgentGameAsset {
        relative_path: safe_relative_path(root, &row.path),
        item_id: linked_item(conn, &row.project_id, row.item_id)?,
        id: row.id,
        project_id: row.project_id,
        kind: row.kind,
        name: row.name,
        size_bytes: row.size_bytes,
        modified_at: row.modified_at,
        note: row.note,
        created_at: row.created_at,
        updated_at: row.updated_at,
        revision,
    })
}

fn build_dto(conn: &Connection, row: GameBuild) -> AppResult<AgentGameBuild> {
    let revision = read_revision_snapshot(conn, "game.build", &row.id, &row.updated_at)?.revision;
    Ok(AgentGameBuild {
        item_id: linked_item(conn, &row.project_id, row.item_id)?,
        id: row.id,
        project_id: row.project_id,
        target: row.target,
        engine: row.engine,
        config: row.config,
        status: row.status,
        built_at: row.built_at,
        log_summary: row.log_summary,
        source: row.source,
        note: row.note,
        verification_status: "unverified".into(),
        created_at: row.created_at,
        updated_at: row.updated_at,
        revision,
    })
}

fn test_dto(conn: &Connection, row: GameTestRecord) -> AppResult<AgentGameTest> {
    let revision = read_revision_snapshot(conn, "game.test", &row.id, &row.updated_at)?.revision;
    let build_id = match row.build_id {
        Some(id) if game_build_get_in_conn(conn, &row.project_id, &id)?.is_some() => Some(id),
        _ => None,
    };
    Ok(AgentGameTest {
        item_id: linked_item(conn, &row.project_id, row.item_id)?,
        id: row.id,
        project_id: row.project_id,
        build_id,
        title: row.title,
        scope: row.scope,
        result: row.result,
        tested_at: row.tested_at,
        summary: row.summary,
        defect_count: row.defect_count,
        note: row.note,
        verification_status: "unverified".into(),
        created_at: row.created_at,
        updated_at: row.updated_at,
        revision,
    })
}

pub fn get_facts(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
) -> AppResult<Option<AgentGameFact>> {
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Game, false)?;
        game_project_facts_get_in_conn(conn, &project)?
            .map(|row| {
                let revision =
                    read_revision_snapshot(conn, "game.facts", &row.id, &row.updated_at)?.revision;
                Ok(AgentGameFact {
                    id: row.id,
                    project_id: row.project_id,
                    engine: row.engine,
                    detection_method: row.detection_method,
                    engine_version: row.engine_version,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                    revision,
                })
            })
            .transpose()
    })
}

pub fn list_assets(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<(Vec<AgentGameAsset>, Page)> {
    let (limit, offset) = page_window(limit, offset);
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Game, false)?;
        let root: String = conn.query_row(
            "SELECT root_path FROM workspace_projects WHERE id = ?1",
            [&project],
            |r| r.get(0),
        )?;
        let (rows, total) = game_asset_list_page_in_conn(conn, &project, limit, offset)?;
        let items = rows
            .into_iter()
            .map(|row| asset_dto(conn, &root, row))
            .collect::<AppResult<Vec<_>>>()?;
        Ok((items, Page::new(limit, offset, total)))
    })
}

pub fn list_builds(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<(Vec<AgentGameBuild>, Page)> {
    let (limit, offset) = page_window(limit, offset);
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Game, false)?;
        let (rows, total) = game_build_list_page_in_conn(conn, &project, limit, offset)?;
        let items = rows
            .into_iter()
            .map(|row| build_dto(conn, row))
            .collect::<AppResult<Vec<_>>>()?;
        Ok((items, Page::new(limit, offset, total)))
    })
}

pub fn list_tests(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<(Vec<AgentGameTest>, Page)> {
    let (limit, offset) = page_window(limit, offset);
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Game, false)?;
        let (rows, total) = game_test_list_page_in_conn(conn, &project, limit, offset)?;
        let items = rows
            .into_iter()
            .map(|row| test_dto(conn, row))
            .collect::<AppResult<Vec<_>>>()?;
        Ok((items, Page::new(limit, offset, total)))
    })
}

fn validate_payload<T: Serialize>(input: &T) -> AppResult<()> {
    let payload =
        serde_json::to_vec(input).map_err(|_| AppError::Validation("登记输入无效".into()))?;
    if payload.len() > MAX_CREATE_PAYLOAD_BYTES {
        return Err(AppError::Validation("登记输入超过 16384 字节上限".into()));
    }
    Ok(())
}

fn ensure_links(
    conn: &Connection,
    project: &str,
    item_id: Option<&str>,
    build_id: Option<&str>,
) -> AppResult<()> {
    if let Some(id) = item_id.map(str::trim).filter(|id| !id.is_empty()) {
        if linked_item(conn, project, Some(id.to_string()))?.is_none() {
            return Err(resource_access_error());
        }
    }
    if let Some(id) = build_id.map(str::trim).filter(|id| !id.is_empty()) {
        if game_build_get_in_conn(conn, project, id)?.is_none() {
            return Err(resource_access_error());
        }
    }
    Ok(())
}

pub(crate) fn create_build_in_conn(
    conn: &Connection,
    principal: &Principal,
    project_ref: &str,
    input: CreateBuildInput,
    guard: &dyn WriteGuard,
) -> AppResult<AgentGameBuild> {
    let project = resolve_authorized_project(conn, principal, project_ref, DomainKind::Game, true)?;
    validate_payload(&input)?;
    ensure_links(conn, &project, input.item_id.as_deref(), None)?;
    let saved = game_build_save_in_conn(
        conn,
        None,
        project,
        input.target,
        input.engine,
        input.config,
        input.status,
        input.built_at,
        None,
        input.log_summary,
        None,
        input.item_id,
        input.note,
        "imported",
    )?;
    bump_revision_from(
        conn,
        "game.build",
        &saved.id,
        None,
        principal,
        "",
        &saved.updated_at,
        "",
    )?;
    guard.record_operation(conn, "game.build", &saved.id)?;
    build_dto(conn, saved)
}

pub(crate) fn create_test_in_conn(
    conn: &Connection,
    principal: &Principal,
    project_ref: &str,
    input: CreateTestInput,
    guard: &dyn WriteGuard,
) -> AppResult<AgentGameTest> {
    let project = resolve_authorized_project(conn, principal, project_ref, DomainKind::Game, true)?;
    validate_payload(&input)?;
    ensure_links(
        conn,
        &project,
        input.item_id.as_deref(),
        input.build_id.as_deref(),
    )?;
    let saved = game_test_save_in_conn(
        conn,
        None,
        project,
        input.build_id,
        input.title,
        input.scope,
        input.result,
        input.tested_at,
        input.summary,
        input.defect_count,
        input.item_id,
        input.note,
    )?;
    bump_revision_from(
        conn,
        "game.test",
        &saved.id,
        None,
        principal,
        "",
        &saved.updated_at,
        "",
    )?;
    guard.record_operation(conn, "game.test", &saved.id)?;
    test_dto(conn, saved)
}

pub fn create_build_with_guard(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    input: CreateBuildInput,
    guard: &dyn WriteGuard,
) -> AppResult<AgentGameBuild> {
    db.with_transaction(|conn| {
        guard.check(conn)?;
        let row = create_build_in_conn(conn, principal, project_ref, input, guard)?;
        guard.complete(conn)?;
        Ok(row)
    })
}

pub fn create_test_with_guard(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    input: CreateTestInput,
    guard: &dyn WriteGuard,
) -> AppResult<AgentGameTest> {
    db.with_transaction(|conn| {
        guard.check(conn)?;
        let row = create_test_in_conn(conn, principal, project_ref, input, guard)?;
        guard.complete(conn)?;
        Ok(row)
    })
}

fn recover_build(
    conn: &Connection,
    principal: &Principal,
    project_ref: &str,
    id: &str,
) -> AppResult<AgentGameBuild> {
    let project =
        resolve_authorized_project(conn, principal, project_ref, DomainKind::Game, false)?;
    build_dto(
        conn,
        game_build_get_in_conn(conn, &project, id)?.ok_or_else(resource_access_error)?,
    )
}

fn recover_test(
    conn: &Connection,
    principal: &Principal,
    project_ref: &str,
    id: &str,
) -> AppResult<AgentGameTest> {
    let project =
        resolve_authorized_project(conn, principal, project_ref, DomainKind::Game, false)?;
    test_dto(
        conn,
        game_test_get_in_conn(conn, &project, id)?.ok_or_else(resource_access_error)?,
    )
}

pub fn create_build_with_request(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    input: CreateBuildInput,
    request_id: &str,
    guard: &dyn WriteGuard,
) -> AppResult<AgentGameBuild> {
    let payload = serde_json::json!({ "projectId": project_ref, "input": input });
    super::idempotency::execute(
        db,
        principal,
        "game.build.create",
        project_ref,
        request_id,
        &payload,
        guard,
        |conn, _, id| recover_build(conn, principal, project_ref, id),
        |conn, stacked| create_build_in_conn(conn, principal, project_ref, input, stacked),
    )
}

pub fn create_test_with_request(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    input: CreateTestInput,
    request_id: &str,
    guard: &dyn WriteGuard,
) -> AppResult<AgentGameTest> {
    let payload = serde_json::json!({ "projectId": project_ref, "input": input });
    super::idempotency::execute(
        db,
        principal,
        "game.test.create",
        project_ref,
        request_id,
        &payload,
        guard,
        |conn, _, id| recover_test(conn, principal, project_ref, id),
        |conn, stacked| create_test_in_conn(conn, principal, project_ref, input, stacked),
    )
}

pub fn rebuild_committed(
    db: &Db,
    principal: &Principal,
    operation_id: &str,
    resource_id: &str,
) -> AppResult<serde_json::Value> {
    db.with_read(|conn| {
        let table = match operation_id {
            "game.build.create" => "game_builds",
            "game.test.create" => "game_tests",
            _ => return Err(AppError::Validation("不支持的游戏登记操作".into())),
        };
        let project: String = conn
            .query_row(
                &format!("SELECT project_id FROM {table} WHERE id = ?1"),
                [resource_id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(resource_access_error)?;
        match operation_id {
            "game.build.create" => Ok(serde_json::json!(recover_build(
                conn,
                principal,
                &project,
                resource_id
            )?)),
            "game.test.create" => Ok(serde_json::json!(recover_test(
                conn,
                principal,
                &project,
                resource_id
            )?)),
            _ => unreachable!(),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_access::store::NoGuard;
    use crate::agent_access::Source;

    fn setup() -> (Db, Principal) {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            for (id, kind, status) in [
                ("game-a", "game", "active"),
                ("game-b", "game", "active"),
                ("archived", "game", "archived"),
                ("other-kind", "general", "active"),
            ] {
                conn.execute(
                    "INSERT INTO workspace_projects
                       (id,name,kind,status,root_path,note,created_at,updated_at)
                     VALUES (?1,'领域测试',?2,?3,'','','2026-01-01','2026-01-01')",
                    rusqlite::params![id, kind, status],
                )?;
            }
            Ok(())
        })
        .unwrap();
        (db, Principal::local(Source::Cli))
    }

    fn build_input() -> CreateBuildInput {
        serde_json::from_value(serde_json::json!({
            "target": "Windows", "status": "success", "note": "原始备注"
        }))
        .unwrap()
    }

    fn test_input(build_id: Option<String>) -> CreateTestInput {
        serde_json::from_value(serde_json::json!({
            "build_id": build_id, "title": "首章回归", "result": "passed"
        }))
        .unwrap()
    }

    #[test]
    fn reported_build_and_test_round_trip_without_claiming_verification() {
        let (db, principal) = setup();
        let build =
            create_build_with_guard(&db, &principal, "game-a", build_input(), &NoGuard).unwrap();
        assert_eq!(build.revision, 1);
        assert_eq!(build.source, "imported");
        assert_eq!(build.note, "原始备注");
        assert_eq!(build.verification_status, "unverified");
        let test = create_test_with_guard(
            &db,
            &principal,
            "game-a",
            test_input(Some(build.id.clone())),
            &NoGuard,
        )
        .unwrap();
        assert_eq!(test.revision, 1);
        assert_eq!(test.result, "passed");
        assert_eq!(test.verification_status, "unverified");
        let (builds, page) = list_builds(&db, &principal, "game-a", None, None).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(builds[0].id, build.id);
        let (tests, _) = list_tests(&db, &principal, "game-a", None, None).unwrap();
        assert_eq!(tests[0].build_id.as_deref(), Some(build.id.as_str()));
        let recovered = rebuild_committed(&db, &principal, "game.test.create", &test.id).unwrap();
        assert_eq!(recovered["id"], test.id);
        db.with_read(|conn| {
            let paths: (String, String) = conn.query_row(
                "SELECT log_path, artifact_path FROM game_builds WHERE id = ?1", [&build.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert_eq!(paths, (String::new(), String::new()));
            let source: String = conn.query_row(
                "SELECT source FROM agent_resource_revisions WHERE resource_kind = 'game.test' AND resource_id = ?1",
                [&test.id], |r| r.get(0),
            )?;
            assert_eq!(source, "cli");
            Ok(())
        }).unwrap();
    }

    #[test]
    fn transaction_core_uses_existing_connection_and_rolls_back_with_outer_transaction() {
        let (db, principal) = setup();
        let result: AppResult<()> = db.with_transaction(|conn| {
            create_build_in_conn(conn, &principal, "game-a", build_input(), &NoGuard)?;
            Err(AppError::Validation("模拟外层失败".into()))
        });
        assert!(result.is_err());
        db.with_read(|conn| {
            let builds: i64 =
                conn.query_row("SELECT COUNT(*) FROM game_builds", [], |r| r.get(0))?;
            let revisions: i64 = conn.query_row(
                "SELECT COUNT(*) FROM agent_resource_revisions WHERE resource_kind = 'game.build'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!((builds, revisions), (0, 0));
            Ok(())
        })
        .unwrap();
    }

    struct RejectCompletion;
    impl WriteGuard for RejectCompletion {
        fn check(&self, _: &Connection) -> AppResult<()> {
            Ok(())
        }
        fn complete(&self, _: &Connection) -> AppResult<()> {
            Err(resource_access_error())
        }
    }

    #[test]
    fn failed_entry_guard_rolls_back_record_and_revision() {
        let (db, principal) = setup();
        assert!(create_test_with_guard(
            &db,
            &principal,
            "game-a",
            test_input(None),
            &RejectCompletion
        )
        .is_err());
        assert_eq!(
            list_tests(&db, &principal, "game-a", None, None)
                .unwrap()
                .1
                .total,
            0
        );
        db.with_read(|conn| {
            let revisions: i64 = conn.query_row(
                "SELECT COUNT(*) FROM agent_resource_revisions WHERE resource_kind = 'game.test'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(revisions, 0);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn project_type_archive_readonly_and_unapproved_file_import_are_enforced() {
        let (db, principal) = setup();
        assert!(list_assets(&db, &principal, "other-kind", None, None).is_err());
        assert!(list_builds(&db, &principal, "archived", None, None).is_ok());
        assert!(
            create_build_with_guard(&db, &principal, "archived", build_input(), &NoGuard).is_err()
        );
        let mut read_only = principal.clone();
        read_only.read_only = true;
        assert!(
            create_test_with_guard(&db, &read_only, "game-a", test_input(None), &NoGuard).is_err()
        );
        let import = Principal::file_import("claimed-agent");
        assert!(create_build_with_guard(&db, &import, "game-a", build_input(), &NoGuard).is_err());
    }

    #[test]
    fn foreign_or_missing_builds_have_same_error_and_cannot_be_linked() {
        let (db, principal) = setup();
        let foreign =
            create_build_with_guard(&db, &principal, "game-b", build_input(), &NoGuard).unwrap();
        let denied = create_test_with_guard(
            &db,
            &principal,
            "game-a",
            test_input(Some(foreign.id)),
            &NoGuard,
        )
        .unwrap_err();
        let missing = create_test_with_guard(
            &db,
            &principal,
            "game-a",
            test_input(Some("missing".into())),
            &NoGuard,
        )
        .unwrap_err();
        assert_eq!(denied.to_string(), missing.to_string());
        let mut input = build_input();
        input.item_id = Some("missing-item".into());
        assert!(create_build_with_guard(&db, &principal, "game-a", input, &NoGuard).is_err());
        assert_eq!(
            list_tests(&db, &principal, "game-a", None, None)
                .unwrap()
                .1
                .total,
            0
        );
    }

    #[test]
    fn asset_pagination_reads_beyond_native_list_limit_and_hides_paths() {
        let (db, principal) = setup();
        let root = std::env::temp_dir().join("taskdock-game-agent-path-fixture");
        let inside = root.join("Assets").join("tree.glb");
        let outside = root.parent().unwrap().join("private-resource.glb");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE workspace_projects SET root_path = ?1 WHERE id = 'game-a'",
                [root.to_string_lossy().as_ref()],
            )?;
            for i in 0..505 {
                let path = if i == 503 { &inside } else { &outside };
                conn.execute(
                    "INSERT INTO game_assets
                       (id,project_id,kind,name,path,created_at,updated_at)
                     VALUES (?1,'game-a','model','资源',?2,'2026-01-01','2026-01-01')",
                    rusqlite::params![format!("asset-{i:03}"), path.to_string_lossy()],
                )?;
            }
            Ok(())
        })
        .unwrap();
        let (items, page) = list_assets(&db, &principal, "game-a", Some(50), Some(500)).unwrap();
        assert_eq!(page.total, 505);
        assert_eq!(items.len(), 5);
        assert_eq!(items[3].relative_path.as_deref(), Some("Assets/tree.glb"));
        assert!(items[0].relative_path.is_none());
        let json = serde_json::to_string(&items).unwrap();
        assert!(!json.contains("private-resource"));
        assert!(!json.contains("pathExists"));
        assert!(!json.contains("rootPath"));
        assert!(!json.contains(&root.to_string_lossy().replace('\\', "\\\\")));
        assert!(!page.has_more);
    }

    #[test]
    fn safe_relative_path_rejects_traversal_and_prefix_siblings() {
        let root = std::env::temp_dir().join("game-root");
        let child = root.join("Assets/tree.glb");
        let traversal = root.join("..").join("private.glb");
        let sibling = root.with_file_name("game-root-other").join("private.glb");
        let root_str = root.to_string_lossy();
        assert_eq!(
            safe_relative_path(&root_str, &child.to_string_lossy()).as_deref(),
            Some("Assets/tree.glb")
        );
        assert!(safe_relative_path(&root_str, &traversal.to_string_lossy()).is_none());
        assert!(safe_relative_path(&root_str, &sibling.to_string_lossy()).is_none());
    }

    #[test]
    fn creation_rejects_execution_and_path_fields_and_oversized_metadata() {
        for extra in [
            "id",
            "source",
            "log_path",
            "artifact_path",
            "command",
            "script",
        ] {
            let mut value = serde_json::json!({"target":"Windows","status":"success"});
            value[extra] = serde_json::json!("unexpected");
            assert!(
                serde_json::from_value::<CreateBuildInput>(value).is_err(),
                "{extra}"
            );
        }
        assert!(
            serde_json::from_value::<CreateTestInput>(serde_json::json!({
                "title":"测试","result":"passed","command":"execute"
            }))
            .is_err()
        );
        let (db, principal) = setup();
        let mut invalid = build_input();
        invalid.status = "running".into();
        assert!(create_build_with_guard(&db, &principal, "game-a", invalid, &NoGuard).is_err());
        let mut oversized = build_input();
        oversized.note = Some("x".repeat(MAX_CREATE_PAYLOAD_BYTES));
        assert!(create_build_with_guard(&db, &principal, "game-a", oversized, &NoGuard).is_err());
        assert_eq!(
            list_builds(&db, &principal, "game-a", None, None)
                .unwrap()
                .1
                .total,
            0
        );
    }
}
