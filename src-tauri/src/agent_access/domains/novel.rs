//! 小说领域业务用例（架构文档 §9.1 Phase 1 P0）。
//!
//! 只做「权限 + 归属 + 版本」编排，业务读写全部复用
//! `commands::project_workspace` / `commands::novel_workspace` 的既有实现，
//! 不复制 SQL、不改 UI 契约。

use rusqlite::Connection;

use crate::agent_access::store::WriteGuard;
use crate::agent_access::{permissions, Principal};
use crate::commands::novel_workspace::{
    novel_character_list_impl, novel_entity_ref_list_impl, novel_worldview_list_impl,
};
use crate::commands::project_workspace::{
    chapter_project_id, novel_chapter_get_impl, novel_chapter_list_impl,
    novel_chapter_save_content_in_conn, novel_chapter_updated_at, read_chapter_summary,
    NovelChapter, NovelChapterSummary,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::policy::{ensure_domain, ensure_domain_write};
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

/// 列表只返回摘要（不返回正文），符合文档 §9.1「禁止一次性读取整本小说正文」。
pub fn list_chapters(
    db: &Db,
    principal: &Principal,
    project_id: &str,
) -> AppResult<Vec<NovelChapterSummary>> {
    authorize_read(db, principal, project_id)?;
    novel_chapter_list_impl(db, project_id)
}

/// 单章元信息 + 正文（Agent 显式按 chapterId 读取）。
pub fn get_chapter(
    db: &Db,
    principal: &Principal,
    project_id: &str,
    chapter_id: &str,
) -> AppResult<NovelChapter> {
    authorize_read(db, principal, project_id)?;
    // 先校验真实归属，防止用本项目的授权读其他项目的章节。
    let owner = db.with_read(|conn| chapter_project_id(conn, chapter_id))?;
    if owner != project_id {
        return Err(super::policy::resource_access_error());
    }
    novel_chapter_get_impl(db, chapter_id)
}

/// 只读正文（不含列表批量拉取语义）。
pub fn read_chapter_content(
    db: &Db,
    principal: &Principal,
    project_id: &str,
    chapter_id: &str,
) -> AppResult<String> {
    Ok(get_chapter(db, principal, project_id, chapter_id)?.content)
}

pub fn list_characters(
    db: &Db,
    principal: &Principal,
    project_id: &str,
    query: Option<&str>,
) -> AppResult<Vec<crate::commands::novel_workspace::NovelCharacter>> {
    authorize_read(db, principal, project_id)?;
    novel_character_list_impl(db, project_id, query)
}

pub fn list_worldview(
    db: &Db,
    principal: &Principal,
    project_id: &str,
    kind: Option<&str>,
    query: Option<&str>,
) -> AppResult<Vec<crate::commands::novel_workspace::NovelWorldviewEntry>> {
    authorize_read(db, principal, project_id)?;
    novel_worldview_list_impl(db, project_id, kind, query)
}

pub fn list_refs(
    db: &Db,
    principal: &Principal,
    project_id: &str,
    entity_type: Option<&str>,
    entity_id: Option<&str>,
) -> AppResult<Vec<crate::commands::novel_workspace::NovelEntityRef>> {
    authorize_read(db, principal, project_id)?;
    // Agent 侧暂不按章节筛选，保持原有「按实体」语义（章节筛选只给桌面 UI 用）。
    novel_entity_ref_list_impl(db, project_id, entity_type, entity_id, None)
}

/// 正文更新：权限、归属、版本校验、业务写入、revision 推进同一事务（文档 §7.3）。
///
/// 返回 `(章节摘要, 新 revision)`。
pub fn update_chapter_content(
    db: &Db,
    principal: &Principal,
    project_id: &str,
    chapter_id: &str,
    content: String,
    expected_revision: i64,
    request_id: &str,
) -> AppResult<(NovelChapterSummary, i64)> {
    if content.len() > MAX_CHAPTER_BYTES {
        return Err(AppError::Validation(format!(
            "正文超过 {} 字节上限",
            MAX_CHAPTER_BYTES
        )));
    }
    let payload = serde_json::json!({
        "projectId": project_id,
        "chapterId": chapter_id,
        "content": content,
        "expectedRevision": expected_revision,
    });
    super::idempotency::execute(
        db,
        principal,
        "novel.chapter.content.update",
        project_id,
        request_id,
        &payload,
        |conn, guard| {
            update_chapter_content_in_conn(
                conn,
                principal,
                project_id,
                chapter_id,
                content,
                expected_revision,
                guard,
            )
        },
    )
}

/// 正文更新的事务内核心：领域入口与文件导入共用同一套权限/归属/版本语义。
///
/// 调用方负责 `guard.check` / `guard.complete` 与事务边界；本函数只做业务写入、
/// revision 推进与 `guard.record_operation`，不得再开嵌套事务。
pub(crate) fn update_chapter_content_in_conn(
    conn: &Connection,
    principal: &Principal,
    project_id: &str,
    chapter_id: &str,
    content: String,
    expected_revision: i64,
    guard: &dyn WriteGuard,
) -> AppResult<(NovelChapterSummary, i64)> {
    let owner = chapter_project_id(conn, chapter_id)?;
    ensure_domain_write(
        conn,
        principal,
        project_id,
        DomainKind::Novel,
        Capability::ProjectsWrite,
        Some(&owner),
    )?;
    let before = novel_chapter_updated_at(conn, chapter_id)?;
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
    Ok((summary, revision))
}

/// 领域读的统一门禁：真实项目 kind + 读权限（归档项目允许读）。
fn authorize_read(db: &Db, principal: &Principal, project_id: &str) -> AppResult<()> {
    db.with_read(|conn| authorize_read_in_conn(conn, principal, project_id))
}

fn authorize_read_in_conn(
    conn: &Connection,
    principal: &Principal,
    project_id: &str,
) -> AppResult<()> {
    ensure_domain(conn, project_id, DomainKind::Novel, false)?;
    permissions::require_in_conn(conn, principal, Capability::ProjectsRead, project_id)
}

/// 供读取响应附加版本信息（文档 §7.2）。
pub fn chapter_revision(
    db: &Db,
    project_id: &str,
    chapter_id: &str,
) -> AppResult<super::revision::RevisionSnapshot> {
    db.with_read(|conn| {
        let owner = chapter_project_id(conn, chapter_id)?;
        if owner != project_id {
            return Err(super::policy::resource_access_error());
        }
        let updated_at = novel_chapter_updated_at(conn, chapter_id)?;
        read_revision_snapshot(conn, "novel.chapter", chapter_id, &updated_at)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn seed_chapter(db: &Db, project_id: &str, id: &str) -> String {
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
        "2026-01-01T00:00:00Z".to_string()
    }

    #[test]
    fn chapter_list_and_content_read_workflow() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "novel", "active");
        seed_chapter(&db, &project, "ch1");

        let list = list_chapters(&db, &p, &project).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "第01章");

        let content = read_chapter_content(&db, &p, &project, "ch1").unwrap();
        assert_eq!(content, "初始正文");
    }

    #[test]
    fn update_content_advances_revision_and_rejects_stale() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "novel", "active");
        seed_chapter(&db, &project, "ch1");

        let (summary, revision) = update_chapter_content(
            &db, &p, &project, "ch1", "新正文内容".into(), 0, "req-1",
        )
        .unwrap();
        assert_eq!(summary.word_count, 5);
        assert_eq!(revision, 1);

        // 旧版本再提交必须冲突
        let err = update_chapter_content(
            &db, &p, &project, "ch1", "再次修改".into(), 0, "req-2",
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));

        // 用最新版本可以继续写
        let (_, next) = update_chapter_content(
            &db, &p, &project, "ch1", "第三次".into(), 1, "req-3",
        )
        .unwrap();
        assert_eq!(next, 2);
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
    }

    #[test]
    fn wrong_kind_and_archived_write_are_rejected() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let general = seed_project(&db, "general", "active");
        assert!(list_chapters(&db, &p, &general).is_err());

        let archived = seed_project(&db, "novel", "archived");
        seed_chapter(&db, &archived, "ch-arch");
        // 归档可读
        assert!(list_chapters(&db, &p, &archived).is_ok());
        // 归档不可写
        let err = update_chapter_content(
            &db, &p, &archived, "ch-arch", "x".into(), 0, "req-arch",
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Forbidden(_)));
    }

    #[test]
    fn empty_request_id_is_rejected() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "novel", "active");
        seed_chapter(&db, &project, "ch1");
        let err = update_chapter_content(&db, &p, &project, "ch1", "x".into(), 0, " ")
            .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }
}
