//! 小说领域业务用例（架构文档 §9.1 Phase 1 P0）。
//!
//! 只做「权限 + 归属 + 版本」编排，业务读写全部复用
//! `commands::project_workspace` / `commands::novel_workspace` 的既有实现，
//! 不复制 SQL、不改 UI 契约。
//!
//! 事务所有权：
//! - MCP：`run_tool_call` 持有事务，本模块只提供 `*_in_conn` 核心；
//! - REST / CLI：入口持有 `WriteGuard`，本模块用 `*_with_guard` 开启**唯一**业务事务；
//! - 文件导入：由导入租约守卫持有事务，直接调用 `*_in_conn`。

use rusqlite::Connection;
use serde::Serialize;

use crate::agent_access::store::WriteGuard;
use crate::agent_access::{Page, Principal};
use crate::commands::novel_workspace::{
    novel_character_list_impl, novel_entity_ref_list_impl, novel_worldview_list_impl,
    NovelCharacter, NovelEntityRef, NovelWorldviewEntry,
};
use crate::commands::project_workspace::{
    chapter_project_id, novel_chapter_list_page_in_conn, novel_chapter_save_content_in_conn,
    novel_chapter_updated_at, read_chapter, read_chapter_summary, NovelChapterSummary,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::policy::{
    page_window, resolve_authorized_project, resource_access_error,
};
use super::registry::{DomainKind, DomainOperationDef, Interface, OperationAccess};
use super::revision::{bump_revision_from, read_revision_snapshot};

const MAX_CHAPTER_BYTES: usize = 256 * 1024;

/// 小说领域已开放给 Agent 的操作（Phase 1 第一批）。
pub const OPERATIONS: &[DomainOperationDef] = &[
    DomainOperationDef {
        id: "novel.chapter.list",
        domain: DomainKind::Novel,
        access: OperationAccess::Read,
        resource_kind: "novel.chapter",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "novel.chapter.get",
        domain: DomainKind::Novel,
        access: OperationAccess::Read,
        resource_kind: "novel.chapter",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "novel.chapter.content.read",
        domain: DomainKind::Novel,
        access: OperationAccess::Read,
        resource_kind: "novel.chapter",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "novel.chapter.content.update",
        domain: DomainKind::Novel,
        access: OperationAccess::Write,
        resource_kind: "novel.chapter",
        permission: Capability::ProjectsWrite,
        interfaces: &[
            Interface::Cli,
            Interface::Mcp,
            Interface::Rest,
            Interface::File,
        ],
        revision_required: true,
        request_id_required: true,
        max_payload_bytes: Some(MAX_CHAPTER_BYTES),
    },
    DomainOperationDef {
        id: "novel.character.list",
        domain: DomainKind::Novel,
        access: OperationAccess::Read,
        resource_kind: "novel.character",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "novel.worldview.list",
        domain: DomainKind::Novel,
        access: OperationAccess::Read,
        resource_kind: "novel.worldview",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "novel.ref.list",
        domain: DomainKind::Novel,
        access: OperationAccess::Read,
        resource_kind: "novel.chapter",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
];

/// Agent 章节摘要：在原 IPC 摘要上增加 `revision`，不修改 Tauri IPC 契约。
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChapterSummary {
    #[serde(flatten)]
    pub chapter: NovelChapterSummary,
    pub revision: i64,
}

/// 章节正文读取响应：正文与版本一起返回，正文只来自目标章节。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChapterContent {
    pub chapter_id: String,
    pub content: String,
    pub revision: i64,
    pub updated_at: String,
}

fn chapter_dto(conn: &Connection, chapter: NovelChapterSummary) -> AppResult<AgentChapterSummary> {
    let snapshot =
        read_revision_snapshot(conn, "novel.chapter", &chapter.id, &chapter.updated_at)?;
    Ok(AgentChapterSummary {
        chapter,
        revision: snapshot.revision,
    })
}

fn paginate<T>(items: Vec<T>, limit: u32, offset: u32) -> (Vec<T>, Page) {
    let total = items.len() as u32;
    let page = Page::new(limit, offset, total);
    let out = items
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .collect();
    (out, page)
}

/// 列表只返回摘要（不返回正文），符合文档 §9.1「禁止一次性读取整本小说正文」。
pub fn list_chapters(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<(Vec<AgentChapterSummary>, Page)> {
    let (limit, offset) = page_window(limit, offset);
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Novel, false)?;
        let (rows, total) =
            novel_chapter_list_page_in_conn(conn, &project, limit, offset)?;
        let items = rows
            .into_iter()
            .map(|row| chapter_dto(conn, row))
            .collect::<AppResult<Vec<_>>>()?;
        Ok((items, Page::new(limit, offset, total)))
    })
}

/// 单章元信息（**不含正文**）；正文由 `read_chapter_content` 独立读取。
pub fn get_chapter(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    chapter_id: &str,
) -> AppResult<AgentChapterSummary> {
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Novel, false)?;
        // 权限与领域类型通过后，才反查真实归属，避免未授权探测。
        let owner = chapter_project_id(conn, chapter_id)?;
        if owner != project {
            return Err(resource_access_error());
        }
        chapter_dto(conn, read_chapter_summary(conn, chapter_id)?)
    })
}

/// 只读正文（不返回列表语境，只读取目标章节）。
pub fn read_chapter_content(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    chapter_id: &str,
) -> AppResult<AgentChapterContent> {
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Novel, false)?;
        let owner = chapter_project_id(conn, chapter_id)?;
        if owner != project {
            return Err(resource_access_error());
        }
        let chapter = read_chapter(conn, chapter_id)?;
        let snapshot = read_revision_snapshot(
            conn,
            "novel.chapter",
            chapter_id,
            &chapter.summary.updated_at,
        )?;
        Ok(AgentChapterContent {
            chapter_id: chapter_id.to_string(),
            content: chapter.content,
            revision: snapshot.revision,
            updated_at: snapshot.updated_at,
        })
    })
}

pub fn list_characters(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    query: Option<&str>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<(Vec<NovelCharacter>, Page)> {
    let (limit, offset) = page_window(limit, offset);
    let project = db.with_read(|conn| {
        resolve_authorized_project(conn, principal, project_ref, DomainKind::Novel, false)
    })?;
    Ok(paginate(novel_character_list_impl(db, &project, query)?, limit, offset))
}

pub fn list_worldview(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    kind: Option<&str>,
    query: Option<&str>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<(Vec<NovelWorldviewEntry>, Page)> {
    let (limit, offset) = page_window(limit, offset);
    let project = db.with_read(|conn| {
        resolve_authorized_project(conn, principal, project_ref, DomainKind::Novel, false)
    })?;
    Ok(paginate(novel_worldview_list_impl(db, &project, kind, query)?, limit, offset))
}

pub fn list_refs(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    entity_type: Option<&str>,
    entity_id: Option<&str>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<(Vec<NovelEntityRef>, Page)> {
    let (limit, offset) = page_window(limit, offset);
    let project = db.with_read(|conn| {
        resolve_authorized_project(conn, principal, project_ref, DomainKind::Novel, false)
    })?;
    // Agent 侧暂不按章节筛选，保持原有「按实体」语义（章节筛选只给桌面 UI 用）。
    Ok(paginate(novel_entity_ref_list_impl(db, &project, entity_type, entity_id, None)?, limit, offset))
}

/// 正文更新（REST / 独立调用）：入口已持有守卫，本函数负责唯一业务事务。
pub fn update_chapter_content_with_guard(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    chapter_id: &str,
    content: String,
    expected_revision: i64,
    guard: &dyn WriteGuard,
) -> AppResult<(AgentChapterSummary, i64)> {
    db.with_transaction(|conn| {
        guard.check(conn)?;
        let (summary, revision) = update_chapter_content_in_conn(
            conn,
            principal,
            project_ref,
            chapter_id,
            content,
            expected_revision,
            guard,
        )?;
        guard.complete(conn)?;
        Ok((summary, revision))
    })
}

/// CLI 入口：幂等占位 + 外层 OperationGuard 叠加在同一事务。
pub fn update_chapter_content_with_request(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    chapter_id: &str,
    content: String,
    expected_revision: i64,
    request_id: &str,
    guard: &dyn WriteGuard,
) -> AppResult<(AgentChapterSummary, i64)> {
    let payload = serde_json::json!({
        "projectId": project_ref,
        "chapterId": chapter_id,
        "content": content,
        "expectedRevision": expected_revision,
    });
    super::idempotency::execute(
        db,
        principal,
        "novel.chapter.content.update",
        project_ref,
        request_id,
        &payload,
        guard,
        |conn, _kind, id| recover_update(conn, principal, project_ref, id),
        |conn, stacked| {
            update_chapter_content_in_conn(
                conn,
                principal,
                project_ref,
                chapter_id,
                content,
                expected_revision,
                stacked,
            )
        },
    )
}

/// REST 幂等恢复：只读已提交章节，重建 `{ summary, revision }`。
pub fn rebuild_committed(
    db: &Db,
    principal: &Principal,
    chapter_id: &str,
) -> AppResult<serde_json::Value> {
    db.with_read(|conn| {
        let project = chapter_project_id(conn, chapter_id)?;
        let (summary, revision) = recover_update(conn, principal, &project, chapter_id)?;
        Ok(serde_json::json!({ "summary": summary, "revision": revision }))
    })
}

/// `Committed` 恢复：只读已提交章节，重建与首次成功相同的响应。
fn recover_update(
    conn: &Connection,
    principal: &Principal,
    project_ref: &str,
    chapter_id: &str,
) -> AppResult<(AgentChapterSummary, i64)> {
    let project =
        resolve_authorized_project(conn, principal, project_ref, DomainKind::Novel, false)?;
    let owner = chapter_project_id(conn, chapter_id)?;
    if owner != project {
        return Err(resource_access_error());
    }
    let summary = read_chapter_summary(conn, chapter_id)?;
    let snapshot = read_revision_snapshot(
        conn,
        "novel.chapter",
        chapter_id,
        &summary.updated_at,
    )?;
    Ok((
        AgentChapterSummary {
            chapter: summary,
            revision: snapshot.revision,
        },
        snapshot.revision,
    ))
}

/// 正文更新的事务内核心：MCP、REST、CLI、文件导入共用同一套权限/归属/版本语义。
///
/// 调用方负责事务边界与 `guard.check` / `guard.complete`；本函数只做业务写入、
/// revision 推进与 `guard.record_operation`，不得再开嵌套事务或 `db.with_read`。
pub(crate) fn update_chapter_content_in_conn(
    conn: &Connection,
    principal: &Principal,
    project_ref: &str,
    chapter_id: &str,
    content: String,
    expected_revision: i64,
    guard: &dyn WriteGuard,
) -> AppResult<(AgentChapterSummary, i64)> {
    if content.len() > MAX_CHAPTER_BYTES {
        return Err(AppError::Validation(format!(
            "正文超过 {} 字节上限",
            MAX_CHAPTER_BYTES
        )));
    }
    // 顺序固定：授权与领域类型通过后，才反查资源归属。
    let project =
        resolve_authorized_project(conn, principal, project_ref, DomainKind::Novel, true)?;
    let owner = chapter_project_id(conn, chapter_id)?;
    if owner != project {
        return Err(resource_access_error());
    }
    let before = novel_chapter_updated_at(conn, chapter_id)?;
    let snapshot = read_revision_snapshot(conn, "novel.chapter", chapter_id, &before)?;
    if snapshot.revision != expected_revision {
        return Err(AppError::Conflict(format!(
            "版本冲突：expectedRevision={expected_revision}，当前 revision={}",
            snapshot.revision
        )));
    }
    let (_owner, saved_at) = novel_chapter_save_content_in_conn(conn, chapter_id, content)?;
    let revision = bump_revision_from(
        conn,
        "novel.chapter",
        chapter_id,
        Some(expected_revision),
        principal,
        &before,
        &saved_at,
        "",
    )?;
    guard.record_operation(conn, "novel.chapter", chapter_id)?;
    let summary = read_chapter_summary(conn, chapter_id)?;
    let mut dto = chapter_dto(conn, summary)?;
    // `chapter_dto` 的 revision 来自版本快照；刚写入的版本必须采用本次返回值，
    // 避免同一秒内多次写入时快照口径与返回值不一致。
    dto.revision = revision;
    Ok((dto, revision))
}

/// 供读取响应附加版本信息（文档 §7.2）。
pub fn chapter_revision(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    chapter_id: &str,
) -> AppResult<super::revision::RevisionSnapshot> {
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Novel, false)?;
        let owner = chapter_project_id(conn, chapter_id)?;
        if owner != project {
            return Err(resource_access_error());
        }
        let updated_at = novel_chapter_updated_at(conn, chapter_id)?;
        read_revision_snapshot(conn, "novel.chapter", chapter_id, &updated_at)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_access::store::NoGuard;
    use crate::agent_access::Source;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_PROJECT: AtomicUsize = AtomicUsize::new(0);

    fn local() -> Principal {
        Principal::local(Source::Cli)
    }

    fn seed_project(db: &Db, kind: &str, status: &str) -> String {
        let id = format!(
            "p-{}-{}-{}",
            kind,
            status,
            NEXT_PROJECT.fetch_add(1, Ordering::Relaxed)
        );
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspace_projects
                   (id,name,kind,status,root_path,dev_project_id,note,created_at,updated_at)
                 VALUES (?1,'测试项目',?2,?3,'',NULL,'','2026-01-01','2026-01-01')",
                rusqlite::params![id, kind, status],
            )?;
            Ok(())
        })
        .unwrap();
        id
    }

    fn seed_chapter(db: &Db, project_id: &str, id: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO novel_volumes
                   (id, project_id, title, sort_order, created_at, updated_at)
                 VALUES ('v1', ?1, '第一卷', 0, '2026-01-01', '2026-01-01')",
                rusqlite::params![project_id],
            )
            .ok();
            conn.execute(
                "INSERT INTO novel_chapters
                   (id, project_id, volume_id, title, content, word_count, sort_order, created_at, updated_at)
                 VALUES (?2, ?1, 'v1', '第01章', '初始正文', 4, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                rusqlite::params![project_id, id],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn update(db: &Db, p: &Principal, project: &str, content: &str, expected: i64) -> AppResult<(AgentChapterSummary, i64)> {
        update_chapter_content_with_guard(
            db, p, project, "ch1", content.to_string(), expected, &NoGuard,
        )
    }

    #[test]
    fn chapter_list_and_content_read_workflow() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "novel", "active");
        seed_chapter(&db, &project, "ch1");

        let (list, page) = list_chapters(&db, &p, &project, None, None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].chapter.title, "第01章");
        assert_eq!(list[0].revision, 0);
        assert_eq!(page.total, 1);
        assert!(!page.has_more);

        let meta = get_chapter(&db, &p, &project, "ch1").unwrap();
        assert_eq!(meta.chapter.title, "第01章");

        let content = read_chapter_content(&db, &p, &project, "ch1").unwrap();
        assert_eq!(content.content, "初始正文");
        assert_eq!(content.revision, 0);
        assert_eq!(content.updated_at, "2026-01-01T00:00:00Z");
    }

    #[test]
    fn update_content_advances_revision_and_rejects_stale() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "novel", "active");
        seed_chapter(&db, &project, "ch1");

        let (summary, revision) = update(&db, &p, &project, "新正文内容", 0).unwrap();
        assert_eq!(summary.chapter.word_count, 5);
        assert_eq!(revision, 1);

        // 旧版本再提交必须冲突
        let err = update(&db, &p, &project, "再次修改", 0).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));

        // 用最新版本可以继续写
        let (_, next) = update(&db, &p, &project, "第三次", 1).unwrap();
        assert_eq!(next, 2);

        // 冲突后重新读取，版本必须是当前值且能继续写
        let meta = get_chapter(&db, &p, &project, "ch1").unwrap();
        assert_eq!(meta.revision, 2);
        let (_, next2) = update(&db, &p, &project, "第四次", meta.revision).unwrap();
        assert_eq!(next2, 3);
    }

    #[test]
    fn cross_project_chapter_is_rejected_without_leaking() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let a = seed_project(&db, "novel", "active");
        let b = seed_project(&db, "novel", "active");
        seed_chapter(&db, &a, "ch-a");

        let err = read_chapter_content(&db, &p, &b, "ch-a").unwrap_err();
        assert!(matches!(err, AppError::Forbidden(_)));
        assert!(!err.to_string().contains("存在"));
    }

    #[test]
    fn wrong_kind_and_archived_write_are_rejected() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let general = seed_project(&db, "general", "active");
        assert!(list_chapters(&db, &p, &general, None, None).is_err());

        let archived = seed_project(&db, "novel", "archived");
        seed_chapter(&db, &archived, "ch-arch");
        // 归档可读
        assert!(list_chapters(&db, &p, &archived, None, None).is_ok());
        // 归档不可写
        let err = update_chapter_content_with_guard(
            &db,
            &p,
            &archived,
            "ch-arch",
            "x".into(),
            0,
            &NoGuard,
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Forbidden(_)));
    }

    #[test]
    fn pagination_reports_total_and_next_offset() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "novel", "active");
        db.with_conn(|conn| {
            for i in 0..60 {
                conn.execute(
                    "INSERT INTO novel_chapters
                       (id, project_id, volume_id, title, content, word_count, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, NULL, ?3, '', 0, ?4, '2026-01-01', '2026-01-01')",
                    rusqlite::params![format!("ch-{i:02}"), project, format!("第{i:02}章"), i],
                )?;
            }
            Ok(())
        })
        .unwrap();
        let (first, page) = list_chapters(&db, &p, &project, Some(50), Some(0)).unwrap();
        assert_eq!(first.len(), 50);
        assert_eq!(page.total, 60);
        assert!(page.has_more);
        assert_eq!(page.next_offset, Some(50));
        let (second, page2) = list_chapters(&db, &p, &project, Some(50), Some(50)).unwrap();
        assert_eq!(second.len(), 10);
        assert!(!page2.has_more);
        assert_eq!(page2.next_offset, None);

        // 超过 200 被收敛到上限
        let (capped, cap_page) = list_chapters(&db, &p, &project, Some(500), Some(0)).unwrap();
        assert_eq!(capped.len(), 60);
        assert_eq!(cap_page.limit, 200);
    }

    #[test]
    fn content_read_returns_only_target_chapter_and_revision() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "novel", "active");
        seed_chapter(&db, &project, "ch1");
        seed_chapter(&db, &project, "ch2");
        update_chapter_content_with_guard(
            &db, &p, &project, "ch2", "第二章正文".into(), 0, &NoGuard,
        )
        .unwrap();
        let a = read_chapter_content(&db, &p, &project, "ch1").unwrap();
        let b = read_chapter_content(&db, &p, &project, "ch2").unwrap();
        assert_eq!(a.content, "初始正文");
        assert_eq!(a.revision, 0);
        assert_eq!(b.content, "第二章正文");
        assert_eq!(b.revision, 1);
    }

    #[test]
    fn ui_edit_is_visible_to_agent_revision() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "novel", "active");
        seed_chapter(&db, &project, "ch1");
        // 先由 Agent 写一次建立版本基线；UI 直接改业务行（无版本计数器）后，
        // effective revision 才能对比 counter_at 与业务 updated_at。
        update_chapter_content_with_guard(
            &db, &p, &project, "ch1", "Agent 基线".into(), 0, &NoGuard,
        )
        .unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE novel_chapters SET content='UI 修改', updated_at='2026-02-01T00:00:00Z'
                 WHERE id='ch1'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let meta = get_chapter(&db, &p, &project, "ch1").unwrap();
        assert_eq!(meta.revision, 2, "UI 外部修改必须体现为有效版本 +1");
        assert_eq!(meta.chapter.updated_at, "2026-02-01T00:00:00Z");
    }
}
