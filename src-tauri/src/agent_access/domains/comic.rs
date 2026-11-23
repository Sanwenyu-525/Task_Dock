//! 漫剧领域业务用例（架构文档 §9.2 Phase 1 P0）。
//!
//! 业务读写全部复用 `commands::comic_workspace` 的既有实现；
//! 采用素材版本时按文档 §7.4 处理多资源版本：新采用版本与被替换版本
//! 在同一事务内一起推进 revision。

use rusqlite::Connection;

use crate::agent_access::store::WriteGuard;
use crate::agent_access::{permissions, Principal};
use crate::commands::comic_workspace::{
    comic_character_list_impl, comic_episode_list_impl, comic_media_adopt_in_conn,
    comic_media_list_impl, comic_media_save_in_conn, comic_scene_list_impl, comic_shot_list_impl,
    owner_project_id, read_media, ComicEpisode, ComicMediaVersion, ComicScene, ComicShot,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::policy::{ensure_domain, ensure_domain_write};
use super::registry::{DomainKind, DomainOperationDef, Interface, OperationAccess};
use super::revision::bump_revision_from;

/// 漫剧领域已开放给 Agent 的操作（Phase 1 第一批）。
pub const OPERATIONS: &[DomainOperationDef] = &[
    DomainOperationDef {
        id: "comic.episode.list",
        domain: DomainKind::Comic,
        access: OperationAccess::Read,
        resource_kind: "comic.episode",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "comic.shot.list",
        domain: DomainKind::Comic,
        access: OperationAccess::Read,
        resource_kind: "comic.shot",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "comic.media.list",
        domain: DomainKind::Comic,
        access: OperationAccess::Read,
        resource_kind: "comic.media_version",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "comic.character.list",
        domain: DomainKind::Comic,
        access: OperationAccess::Read,
        resource_kind: "comic.character",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "comic.scene.list",
        domain: DomainKind::Comic,
        access: OperationAccess::Read,
        resource_kind: "comic.scene",
        permission: Capability::ProjectsRead,
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest],
        revision_required: false,
        request_id_required: false,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "comic.media.update",
        domain: DomainKind::Comic,
        access: OperationAccess::Write,
        resource_kind: "comic.media_version",
        permission: Capability::ProjectsWrite,
        interfaces: &[
            Interface::Cli,
            Interface::Mcp,
            Interface::Rest,
            Interface::File,
        ],
        revision_required: true,
        request_id_required: true,
        max_payload_bytes: None,
    },
    DomainOperationDef {
        id: "comic.media.adopt",
        domain: DomainKind::Comic,
        access: OperationAccess::Write,
        resource_kind: "comic.media_version",
        permission: Capability::ProjectsWrite,
        interfaces: &[
            Interface::Cli,
            Interface::Mcp,
            Interface::Rest,
            Interface::File,
        ],
        revision_required: true,
        request_id_required: true,
        max_payload_bytes: None,
    },
];

pub fn list_episodes(
    db: &Db,
    principal: &Principal,
    project_id: &str,
) -> AppResult<Vec<ComicEpisode>> {
    authorize_read(db, principal, project_id)?;
    comic_episode_list_impl(db, project_id)
}

pub fn list_shots(
    db: &Db,
    principal: &Principal,
    project_id: &str,
    episode_id: Option<String>,
) -> AppResult<Vec<ComicShot>> {
    authorize_read(db, principal, project_id)?;
    comic_shot_list_impl(db, project_id, episode_id)
}

pub fn list_media(
    db: &Db,
    principal: &Principal,
    project_id: &str,
    shot_id: Option<String>,
) -> AppResult<Vec<ComicMediaVersion>> {
    authorize_read(db, principal, project_id)?;
    // 镜头归属由业务实现校验；若给了 shot_id，先确认它属于本项目，避免跨项目探测。
    if let Some(shot) = shot_id.as_deref().filter(|s| !s.is_empty()) {
        let owner = db.with_read(|conn| owner_project_id(conn, "comic_shots", shot))?;
        if owner != project_id {
            return Err(super::policy::resource_access_error());
        }
    }
    comic_media_list_impl(db, project_id, shot_id)
}

pub fn list_characters(
    db: &Db,
    principal: &Principal,
    project_id: &str,
) -> AppResult<Vec<crate::commands::comic_workspace::ComicCharacter>> {
    authorize_read(db, principal, project_id)?;
    comic_character_list_impl(db, project_id)
}

pub fn list_scenes(
    db: &Db,
    principal: &Principal,
    project_id: &str,
) -> AppResult<Vec<ComicScene>> {
    authorize_read(db, principal, project_id)?;
    comic_scene_list_impl(db, project_id)
}

/// 修改素材版本元信息（版本标注 / 状态 / 修改意见），带版本校验。
pub fn update_media(
    db: &Db,
    principal: &Principal,
    project_id: &str,
    media_id: &str,
    version_label: String,
    status: Option<String>,
    review_note: String,
    expected_revision: i64,
    request_id: &str,
) -> AppResult<(ComicMediaVersion, i64)> {
    let payload = serde_json::json!({
        "projectId": project_id,
        "mediaId": media_id,
        "versionLabel": version_label,
        "status": status,
        "reviewNote": review_note,
        "expectedRevision": expected_revision,
    });
    super::idempotency::execute(
        db,
        principal,
        "comic.media.update",
        project_id,
        request_id,
        &payload,
        |conn, guard| {
            update_media_in_conn(
                conn,
                principal,
                project_id,
                media_id,
                version_label,
                status,
                review_note,
                expected_revision,
                guard,
            )
        },
    )
}

/// 素材元信息更新的事务内核心（领域入口与文件导入共用）。
pub(crate) fn update_media_in_conn(
    conn: &Connection,
    principal: &Principal,
    project_id: &str,
    media_id: &str,
    version_label: String,
    status: Option<String>,
    review_note: String,
    expected_revision: i64,
    guard: &dyn WriteGuard,
) -> AppResult<(ComicMediaVersion, i64)> {
    let owner = owner_project_id(conn, "comic_media_versions", media_id)?;
    ensure_domain_write(
        conn,
        principal,
        project_id,
        DomainKind::Comic,
        Capability::ProjectsWrite,
        Some(&owner),
    )?;
    let before = read_media(conn, media_id)?.updated_at;
    let (_owner, saved_at) =
        comic_media_save_in_conn(conn, media_id, version_label, status, review_note)?;
    let revision = bump_revision_from(
        conn,
        "comic.media_version",
        media_id,
        Some(expected_revision),
        principal,
        &before,
        &saved_at,
        "",
    )?;
    guard.record_operation(conn, "comic.media_version", media_id)?;
    Ok((read_media(conn, media_id)?, revision))
}

/// 采用素材版本：同一镜头最多一个 adopted（数据库唯一索引保证）。
///
/// 多资源版本（文档 §7.4）：被替换的旧 adopted 版本也必须在同一事务内推进 revision。
pub fn adopt_media(
    db: &Db,
    principal: &Principal,
    project_id: &str,
    media_id: &str,
    expected_revision: i64,
    request_id: &str,
) -> AppResult<(ComicMediaVersion, i64)> {
    let payload = serde_json::json!({
        "projectId": project_id,
        "mediaId": media_id,
        "expectedRevision": expected_revision,
    });
    super::idempotency::execute(
        db,
        principal,
        "comic.media.adopt",
        project_id,
        request_id,
        &payload,
        |conn, guard| adopt_media_in_conn(conn, principal, project_id, media_id, expected_revision, guard),
    )
}

/// 采用素材版本的事务内核心（领域入口与文件导入共用）。
///
/// 被替换的旧 adopted 版本也在同一事务内推进 revision（文档 §7.4）。
pub(crate) fn adopt_media_in_conn(
    conn: &Connection,
    principal: &Principal,
    project_id: &str,
    media_id: &str,
    expected_revision: i64,
    guard: &dyn WriteGuard,
) -> AppResult<(ComicMediaVersion, i64)> {
    let owner = owner_project_id(conn, "comic_media_versions", media_id)?;
    ensure_domain_write(
        conn,
        principal,
        project_id,
        DomainKind::Comic,
        Capability::ProjectsWrite,
        Some(&owner),
    )?;
    let target_before = read_media(conn, media_id)?.updated_at;
    let (_owner, _shot, saved_at, replaced) = comic_media_adopt_in_conn(conn, media_id)?;
    let revision = bump_revision_from(
        conn,
        "comic.media_version",
        media_id,
        Some(expected_revision),
        principal,
        &target_before,
        &saved_at,
        "",
    )?;
    // 被替换版本：业务行已更新为 candidate，同步推进其 revision，
    // 使后续读取能感知「它不再是 adopted」。
    for (old_id, old_before) in replaced {
        bump_revision_from(
            conn,
            "comic.media_version",
            &old_id,
            None,
            principal,
            &old_before,
            &saved_at,
            "",
        )?;
    }
    guard.record_operation(conn, "comic.media_version", media_id)?;
    Ok((read_media(conn, media_id)?, revision))
}

fn authorize_read(db: &Db, principal: &Principal, project_id: &str) -> AppResult<()> {
    db.with_read(|conn| authorize_read_in_conn(conn, principal, project_id))
}

fn authorize_read_in_conn(
    conn: &Connection,
    principal: &Principal,
    project_id: &str,
) -> AppResult<()> {
    ensure_domain(conn, project_id, DomainKind::Comic, false)?;
    permissions::require_in_conn(conn, principal, Capability::ProjectsRead, project_id)
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

    fn seed_shot_and_media(db: &Db, project_id: &str) -> (String, String, String) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO comic_episodes
                   (id,project_id,episode_no,title,synopsis,script,status,progress,
                    character_ids_json,sort_order,created_at,updated_at)
                 VALUES ('ep1',?1,1,'第一集','','','draft',0,'[]',0,'2026-01-01','2026-01-01')",
                rusqlite::params![project_id],
            )?;
            conn.execute(
                "INSERT INTO comic_shots
                   (id,project_id,episode_id,shot_no,description,character_ids_json,scene_id,
                    dialogue,shot_size,camera_move,duration_sec,status,asset_refs_json,note,
                    sort_order,created_at,updated_at)
                 VALUES ('shot1',?1,'ep1',1,'镜头一','[]',NULL,'','','',0,'todo','[]','',0,
                         '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                rusqlite::params![project_id],
            )?;
            for (id, status) in [("m1", "adopted"), ("m2", "candidate")] {
                conn.execute(
                    "INSERT INTO comic_media_versions
                       (id,project_id,shot_id,character_id,scene_id,file_path,media_kind,
                        version_label,status,review_note,source,created_at,updated_at)
                     VALUES (?1,?2,'shot1',NULL,NULL,?3,'image','v1',?4,'','imported',
                             '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                    rusqlite::params![id, project_id, format!("C:/tmp/{id}.png"), status],
                )?;
            }
            Ok(())
        })
        .unwrap();
        ("ep1".into(), "shot1".into(), "m1".into())
    }

    #[test]
    fn list_workflow_and_adopt_switches_unique_version() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "ai_comic", "active");
        let (_ep, shot, _m1) = seed_shot_and_media(&db, &project);

        assert_eq!(list_episodes(&db, &p, &project).unwrap().len(), 1);
        assert_eq!(list_shots(&db, &p, &project, Some("ep1".into())).unwrap().len(), 1);
        let media = list_media(&db, &p, &project, Some(shot.clone())).unwrap();
        assert_eq!(media.len(), 2);

        // 采用 m2：m1 自动降回 candidate，并且两个版本都推进 revision
        let (adopted, rev) = adopt_media(&db, &p, &project, "m2", 0, "req-adopt").unwrap();
        assert_eq!(adopted.status, "adopted");
        assert_eq!(rev, 1);

        let after = list_media(&db, &p, &project, Some(shot)).unwrap();
        let m1 = after.iter().find(|m| m.id == "m1").unwrap();
        let m2 = after.iter().find(|m| m.id == "m2").unwrap();
        assert_eq!(m1.status, "candidate");
        assert_eq!(m2.status, "adopted");
        assert_eq!(after.iter().filter(|m| m.status == "adopted").count(), 1);

        // 被替换版本 m1 的 revision 也必须从 0 推进到 1
        let m1_rev = db
            .with_read(|conn| {
                super::super::revision::read_revision_snapshot(
                    conn,
                    "comic.media_version",
                    "m1",
                    &m1.updated_at,
                )
            })
            .unwrap();
        assert_eq!(m1_rev.revision, 1);
    }

    #[test]
    fn stale_adopt_is_rejected() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "ai_comic", "active");
        seed_shot_and_media(&db, &project);

        adopt_media(&db, &p, &project, "m2", 0, "req-1").unwrap();
        let err = adopt_media(&db, &p, &project, "m2", 0, "req-2").unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));
    }

    #[test]
    fn update_media_advances_revision() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "ai_comic", "active");
        seed_shot_and_media(&db, &project);

        let (media, rev) = update_media(
            &db,
            &p,
            &project,
            "m2",
            "v2".into(),
            Some("rejected".into()),
            "构图不合格".into(),
            0,
            "req-m",
        )
        .unwrap();
        assert_eq!(media.version_label, "v2");
        assert_eq!(media.status, "rejected");
        assert_eq!(rev, 1);
    }

    #[test]
    fn cross_project_media_and_wrong_kind_are_rejected() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let a = seed_project(&db, "ai_comic", "active");
        let b = seed_project(&db, "ai_comic", "active");
        seed_shot_and_media(&db, &a);

        let err = adopt_media(&db, &p, &b, "m2", 0, "req-x").unwrap_err();
        assert!(matches!(err, AppError::Forbidden(_)));

        let novel = seed_project(&db, "novel", "active");
        assert!(list_episodes(&db, &p, &novel).is_err());
    }

    #[test]
    fn archived_comic_is_read_only() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "ai_comic", "archived");
        seed_shot_and_media(&db, &project);
        assert!(list_episodes(&db, &p, &project).is_ok());
        let err = adopt_media(&db, &p, &project, "m2", 0, "req-a").unwrap_err();
        assert!(matches!(err, AppError::Forbidden(_)));
    }
}
