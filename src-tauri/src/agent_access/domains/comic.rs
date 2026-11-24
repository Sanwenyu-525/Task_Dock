//! 漫剧领域业务用例（架构文档 §9.2 Phase 1 P0）。
//!
//! 业务校验只在 `commands::comic_workspace::comic_media_save_in_conn` 一处实现，
//! 本模块只编排权限、归属、版本与数据最小化；不复制 SQL，不修改 IPC 数据契约。
//!
//! 事务所有权与小说一致：MCP 由 `run_tool_call` 持事务；REST/CLI 传入入口
//! `WriteGuard`；文件导入使用导入租约守卫。

use std::path::{Component, Path};

use rusqlite::Connection;
use serde::Serialize;

use crate::agent_access::store::WriteGuard;
use crate::agent_access::{Page, Principal};
use crate::commands::comic_workspace::{
    comic_character_list_impl, comic_episode_list_page_in_conn,
    comic_media_adopt_in_conn, comic_media_list_page_in_conn, comic_media_save_in_conn,
    comic_scene_list_impl, comic_shot_list_page_in_conn, read_media, ComicCharacter, ComicEpisode,
    ComicMediaVersion, ComicScene, ComicShot,
};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::policy::{page_window, resolve_authorized_project, resource_access_error};
use super::registry::{DomainKind, DomainOperationDef, Interface, OperationAccess};
use super::revision::{bump_revision_from, read_revision_snapshot};

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
        id: "comic.media.get",
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
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest, Interface::File],
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
        interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest, Interface::File],
        revision_required: true,
        request_id_required: true,
        max_payload_bytes: None,
    },
];

/// Agent 剧集摘要：**不含完整 `script`**（正文走后续独立剧本读取接口）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEpisodeSummary {
    pub id: String,
    pub project_id: String,
    pub episode_no: i64,
    pub title: String,
    pub synopsis: String,
    pub status: String,
    pub progress: i64,
    pub character_ids: Vec<String>,
    pub shot_count: i64,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
}

/// 项目内文件引用：只给相对路径/存在状态/类型，绝不暴露本机绝对目录。
#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFileRef {
    /// 项目根目录内相对路径；无法安全转换时为 None。
    pub relative_path: Option<String>,
    /// 只有路径位于项目根内时才计算存在性；越界时不窥探用户文件。
    pub exists: bool,
    pub file_type: Option<String>,
}

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMediaVersion {
    pub id: String,
    pub project_id: String,
    pub shot_id: Option<String>,
    pub character_id: Option<String>,
    pub scene_id: Option<String>,
    pub media_kind: String,
    pub version_label: String,
    pub status: String,
    pub review_note: String,
    pub source: String,
    pub generation_run_id: Option<String>,
    pub generation_label: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
    /// 原 `filePath` 的安全替代；不含绝对目录。
    pub file: AgentFileRef,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentComicCharacter {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub role: String,
    pub description: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    pub reference_image: AgentFileRef,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentComicScene {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub description: String,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    pub reference_image: AgentFileRef,
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

fn project_root(conn: &Connection, project_id: &str) -> AppResult<String> {
    Ok(conn
        .query_row(
            "SELECT root_path FROM workspace_projects WHERE id = ?1",
            [project_id],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_default())
}

/// 只有位于项目根内的路径才返回相对形式；越界路径一律不返回任何本机信息。
fn safe_file_ref(root_path: &str, raw_path: &str) -> AgentFileRef {
    let none = AgentFileRef {
        relative_path: None,
        exists: false,
        file_type: None,
    };
    if root_path.trim().is_empty() || raw_path.trim().is_empty() {
        return none;
    }
    let root = Path::new(root_path.trim());
    let file = Path::new(raw_path.trim());
    let Some(relative) = relative_within(root, file) else {
        return none;
    };
    let exists = file.is_file();
    let file_type = file
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    AgentFileRef {
        relative_path: Some(relative),
        exists,
        file_type,
    }
}

/// 跨平台比较路径组件；Windows 下大小写不敏感，其他平台保持敏感。
fn component_eq(a: &Component<'_>, b: &Component<'_>) -> bool {
    let a = a.as_os_str().to_string_lossy();
    let b = b.as_os_str().to_string_lossy();
    if cfg!(windows) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

fn relative_within(root: &Path, file: &Path) -> Option<String> {
    let root_components: Vec<Component<'_>> = root.components().collect();
    let file_components: Vec<Component<'_>> = file.components().collect();
    if file_components.len() <= root_components.len() {
        return None;
    }
    for (a, b) in root_components.iter().zip(file_components.iter()) {
        if !component_eq(a, b) {
            return None;
        }
    }
    let rest: Vec<String> = file_components[root_components.len()..]
        .iter()
        .filter_map(|c| match c {
            Component::Normal(v) => Some(v.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    if rest.is_empty() {
        None
    } else {
        Some(rest.join("/"))
    }
}

fn media_dto(
    conn: &Connection,
    root_path: &str,
    media: ComicMediaVersion,
) -> AppResult<AgentMediaVersion> {
    let snapshot =
        read_revision_snapshot(conn, "comic.media_version", &media.id, &media.updated_at)?;
    Ok(AgentMediaVersion {
        id: media.id,
        project_id: media.project_id,
        shot_id: media.shot_id,
        character_id: media.character_id,
        scene_id: media.scene_id,
        media_kind: media.media_kind,
        version_label: media.version_label,
        status: media.status,
        review_note: media.review_note,
        source: media.source,
        generation_run_id: media.generation_run_id,
        generation_label: media.generation_label,
        created_at: media.created_at,
        updated_at: media.updated_at,
        revision: snapshot.revision,
        file: safe_file_ref(root_path, &media.file_path),
    })
}

fn episode_dto(conn: &Connection, episode: ComicEpisode) -> AppResult<AgentEpisodeSummary> {
    let snapshot = read_revision_snapshot(
        conn,
        "comic.episode",
        &episode.id,
        &episode.updated_at,
    )?;
    Ok(AgentEpisodeSummary {
        id: episode.id,
        project_id: episode.project_id,
        episode_no: episode.episode_no,
        title: episode.title,
        synopsis: episode.synopsis,
        status: episode.status,
        progress: episode.progress,
        character_ids: episode.character_ids,
        shot_count: episode.shot_count,
        sort_order: episode.sort_order,
        created_at: episode.created_at,
        updated_at: episode.updated_at,
        revision: snapshot.revision,
    })
}

pub fn list_episodes(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<(Vec<AgentEpisodeSummary>, Page)> {
    let (limit, offset) = page_window(limit, offset);
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Comic, false)?;
        let (rows, total) = comic_episode_list_page_in_conn(conn, &project, limit, offset)?;
        let items = rows
            .into_iter()
            .map(|row| episode_dto(conn, row))
            .collect::<AppResult<Vec<_>>>()?;
        Ok((items, Page::new(limit, offset, total)))
    })
}

pub fn list_shots(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    episode_id: Option<&str>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<(Vec<ComicShot>, Page)> {
    let (limit, offset) = page_window(limit, offset);
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Comic, false)?;
        let (rows, total) =
            comic_shot_list_page_in_conn(conn, &project, episode_id, limit, offset)?;
        Ok((rows, Page::new(limit, offset, total)))
    })
}

pub fn list_media(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    shot_id: Option<&str>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<(Vec<AgentMediaVersion>, Page)> {
    let (limit, offset) = page_window(limit, offset);
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Comic, false)?;
        let root = project_root(conn, &project)?;
        let (rows, total) =
            comic_media_list_page_in_conn(conn, &project, shot_id, limit, offset)?;
        let items = rows
            .into_iter()
            .map(|row| media_dto(conn, &root, row))
            .collect::<AppResult<Vec<_>>>()?;
        Ok((items, Page::new(limit, offset, total)))
    })
}

pub fn get_media(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    media_id: &str,
) -> AppResult<AgentMediaVersion> {
    let id = media_id.trim();
    if id.is_empty() {
        return Err(AppError::Validation("素材 ID 不能为空".into()));
    }
    db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Comic, false)?;
        let root = project_root(conn, &project)?;
        let media = read_media(conn, id)?;
        if media.project_id != project {
            return Err(resource_access_error());
        }
        media_dto(conn, &root, media)
    })
}

pub fn list_characters(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<(Vec<AgentComicCharacter>, Page)> {
    let (limit, offset) = page_window(limit, offset);
    let (project, root) = db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Comic, false)?;
        let root = project_root(conn, &project)?;
        Ok((project, root))
    })?;
    let rows: Vec<ComicCharacter> = comic_character_list_impl(db, &project)?;
    let (rows, page) = paginate(rows, limit, offset);
    let items = rows
        .into_iter()
        .map(|c| AgentComicCharacter {
            id: c.id,
            project_id: c.project_id,
            name: c.name,
            role: c.role,
            description: c.description,
            sort_order: c.sort_order,
            created_at: c.created_at,
            updated_at: c.updated_at,
            reference_image: safe_file_ref(&root, &c.ref_image_path),
        })
        .collect();
    Ok((items, page))
}

pub fn list_scenes(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    limit: Option<i64>,
    offset: Option<i64>,
) -> AppResult<(Vec<AgentComicScene>, Page)> {
    let (limit, offset) = page_window(limit, offset);
    let (project, root) = db.with_read(|conn| {
        let project =
            resolve_authorized_project(conn, principal, project_ref, DomainKind::Comic, false)?;
        let root = project_root(conn, &project)?;
        Ok((project, root))
    })?;
    let rows: Vec<ComicScene> = comic_scene_list_impl(db, &project)?;
    let (rows, page) = paginate(rows, limit, offset);
    let items = rows
        .into_iter()
        .map(|s| AgentComicScene {
            id: s.id,
            project_id: s.project_id,
            name: s.name,
            description: s.description,
            sort_order: s.sort_order,
            created_at: s.created_at,
            updated_at: s.updated_at,
            reference_image: safe_file_ref(&root, &s.ref_image_path),
        })
        .collect();
    Ok((items, page))
}

/// 素材版本编辑（REST / 独立调用）：入口守卫 + 唯一业务事务。
#[allow(clippy::too_many_arguments)]
pub fn update_media_with_guard(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    media_id: &str,
    version_label: String,
    status: Option<String>,
    review_note: String,
    expected_revision: i64,
    guard: &dyn WriteGuard,
) -> AppResult<(AgentMediaVersion, i64)> {
    db.with_transaction(|conn| {
        guard.check(conn)?;
        let value = update_media_in_conn(
            conn,
            principal,
            project_ref,
            media_id,
            version_label,
            status,
            review_note,
            expected_revision,
            guard,
        )?;
        guard.complete(conn)?;
        Ok(value)
    })
}

/// CLI 入口：幂等占位 + OperationGuard 叠加在同一事务。
#[allow(clippy::too_many_arguments)]
pub fn update_media_with_request(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    media_id: &str,
    version_label: String,
    status: Option<String>,
    review_note: String,
    expected_revision: i64,
    request_id: &str,
    guard: &dyn WriteGuard,
) -> AppResult<(AgentMediaVersion, i64)> {
    let payload = serde_json::json!({
        "projectId": project_ref,
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
        project_ref,
        request_id,
        &payload,
        guard,
        |conn, _kind, id| recover_media(conn, principal, project_ref, id),
        |conn, stacked| {
            update_media_in_conn(
                conn,
                principal,
                project_ref,
                media_id,
                version_label,
                status,
                review_note,
                expected_revision,
                stacked,
            )
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn update_media_in_conn(
    conn: &Connection,
    principal: &Principal,
    project_ref: &str,
    media_id: &str,
    version_label: String,
    status: Option<String>,
    review_note: String,
    expected_revision: i64,
    guard: &dyn WriteGuard,
) -> AppResult<(AgentMediaVersion, i64)> {
    let project =
        resolve_authorized_project(conn, principal, project_ref, DomainKind::Comic, true)?;
    let before = read_media(conn, media_id)?;
    if before.project_id != project {
        return Err(resource_access_error());
    }
    let snapshot = read_revision_snapshot(
        conn,
        "comic.media_version",
        media_id,
        &before.updated_at,
    )?;
    if snapshot.revision != expected_revision {
        return Err(AppError::Conflict(format!(
            "版本冲突：expectedRevision={expected_revision}，当前 revision={}",
            snapshot.revision
        )));
    }
    let (owner, saved_at) =
        comic_media_save_in_conn(conn, media_id, version_label, status, review_note)?;
    if owner != project {
        return Err(resource_access_error());
    }
    let revision = bump_revision_from(
        conn,
        "comic.media_version",
        media_id,
        Some(expected_revision),
        principal,
        &before.updated_at,
        &saved_at,
        "",
    )?;
    guard.record_operation(conn, "comic.media_version", media_id)?;
    let root = project_root(conn, &project)?;
    let media = read_media(conn, media_id)?;
    let mut dto = media_dto(conn, &root, media)?;
    dto.revision = revision;
    Ok((dto, revision))
}

#[allow(clippy::too_many_arguments)]
pub fn adopt_media_with_guard(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    media_id: &str,
    expected_revision: i64,
    guard: &dyn WriteGuard,
) -> AppResult<(AgentMediaVersion, i64)> {
    db.with_transaction(|conn| {
        guard.check(conn)?;
        let value = adopt_media_in_conn(
            conn,
            principal,
            project_ref,
            media_id,
            expected_revision,
            guard,
        )?;
        guard.complete(conn)?;
        Ok(value)
    })
}

pub fn adopt_media_with_request(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
    media_id: &str,
    expected_revision: i64,
    request_id: &str,
    guard: &dyn WriteGuard,
) -> AppResult<(AgentMediaVersion, i64)> {
    let payload = serde_json::json!({
        "projectId": project_ref,
        "mediaId": media_id,
        "expectedRevision": expected_revision,
    });
    super::idempotency::execute(
        db,
        principal,
        "comic.media.adopt",
        project_ref,
        request_id,
        &payload,
        guard,
        |conn, _kind, id| recover_media(conn, principal, project_ref, id),
        |conn, stacked| {
            adopt_media_in_conn(
                conn,
                principal,
                project_ref,
                media_id,
                expected_revision,
                stacked,
            )
        },
    )
}

pub(crate) fn adopt_media_in_conn(
    conn: &Connection,
    principal: &Principal,
    project_ref: &str,
    media_id: &str,
    expected_revision: i64,
    guard: &dyn WriteGuard,
) -> AppResult<(AgentMediaVersion, i64)> {
    let project =
        resolve_authorized_project(conn, principal, project_ref, DomainKind::Comic, true)?;
    let before = read_media(conn, media_id)?;
    if before.project_id != project {
        return Err(resource_access_error());
    }
    let snapshot = read_revision_snapshot(
        conn,
        "comic.media_version",
        media_id,
        &before.updated_at,
    )?;
    if snapshot.revision != expected_revision {
        return Err(AppError::Conflict(format!(
            "版本冲突：expectedRevision={expected_revision}，当前 revision={}",
            snapshot.revision
        )));
    }
    let (owner, _shot_id, saved_at, replaced) = comic_media_adopt_in_conn(conn, media_id)?;
    if owner != project {
        return Err(resource_access_error());
    }
    // 被替换的旧 adopted 版本一并推进版本（文档 §7.4）。
    for (old_id, old_before) in &replaced {
        let old_saved_at: String = conn.query_row(
            "SELECT updated_at FROM comic_media_versions WHERE id = ?1",
            [old_id],
            |r| r.get(0),
        )?;
        bump_revision_from(
            conn,
            "comic.media_version",
            old_id,
            None,
            principal,
            old_before,
            &old_saved_at,
            "",
        )?;
    }
    let revision = bump_revision_from(
        conn,
        "comic.media_version",
        media_id,
        Some(expected_revision),
        principal,
        &before.updated_at,
        &saved_at,
        "",
    )?;
    guard.record_operation(conn, "comic.media_version", media_id)?;
    let root = project_root(conn, &project)?;
    let media = read_media(conn, media_id)?;
    let mut dto = media_dto(conn, &root, media)?;
    dto.revision = revision;
    Ok((dto, revision))
}

/// REST 幂等恢复：只读已提交素材版本，重建 `{ media, revision }`。
pub fn rebuild_committed(
    db: &Db,
    principal: &Principal,
    media_id: &str,
) -> AppResult<serde_json::Value> {
    db.with_read(|conn| {
        let media = read_media(conn, media_id)?;
        let project = media.project_id.clone();
        let (dto, revision) = recover_media(conn, principal, &project, media_id)?;
        Ok(serde_json::json!({ "media": dto, "revision": revision }))
    })
}

fn recover_media(
    conn: &Connection,
    principal: &Principal,
    project_ref: &str,
    media_id: &str,
) -> AppResult<(AgentMediaVersion, i64)> {
    let project =
        resolve_authorized_project(conn, principal, project_ref, DomainKind::Comic, false)?;
    let media = read_media(conn, media_id)?;
    if media.project_id != project {
        return Err(resource_access_error());
    }
    let root = project_root(conn, &project)?;
    let dto = media_dto(conn, &root, media)?;
    Ok((dto.clone(), dto.revision))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_access::store::NoGuard;
    use crate::agent_access::Source;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn local() -> Principal {
        Principal::local(Source::Cli)
    }

    fn seed_project(db: &Db, kind: &str, status: &str, root: &str) -> String {
        let id = format!("c-{}-{}", kind, NEXT.fetch_add(1, Ordering::Relaxed));
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspace_projects
                   (id,name,kind,status,root_path,dev_project_id,note,created_at,updated_at)
                 VALUES (?1,'漫剧项目',?2,?3,?4,NULL,'','2026-01-01','2026-01-01')",
                rusqlite::params![id, kind, status, root],
            )?;
            Ok(())
        })
        .unwrap();
        id
    }

    fn seed_episode(db: &Db, project: &str, id: &str, script: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO comic_episodes
                   (id, project_id, episode_no, title, synopsis, script, status, progress,
                    character_ids_json, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, 1, '第1集', '梗概', ?3, 'draft', 0, '[]', 0,
                    '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                rusqlite::params![id, project, script],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn seed_shot(db: &Db, project: &str, episode: &str, id: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO comic_shots
                   (id, project_id, episode_id, shot_no, description, character_ids_json,
                    scene_id, dialogue, shot_size, camera_move, duration_sec, status,
                    asset_refs_json, note, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 1, '镜头', '[]', NULL, '', '', '', 0, 'todo',
                    '[]', '', 0, '2026-01-01', '2026-01-01')",
                rusqlite::params![id, project, episode],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn seed_media(db: &Db, project: &str, shot: &str, id: &str, path: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO comic_media_versions
                   (id, project_id, shot_id, character_id, scene_id, file_path, media_kind,
                    version_label, status, review_note, source, generation_run_id,
                    created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, NULL, ?4, 'image', 'v1', 'candidate', '',
                    'imported', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                rusqlite::params![id, project, shot, path],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn update(
        db: &Db,
        p: &Principal,
        project: &str,
        id: &str,
        label: &str,
        status: Option<&str>,
        note: &str,
        expected: i64,
    ) -> AppResult<(AgentMediaVersion, i64)> {
        update_media_with_guard(
            db,
            p,
            project,
            id,
            label.into(),
            status.map(|s| s.to_string()),
            note.into(),
            expected,
            &NoGuard,
        )
    }

    #[test]
    fn episode_list_hides_script_and_reports_revision() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "ai_comic", "active", "");
        seed_episode(&db, &project, "ep1", "完整剧本正文 SECRET");
        let (list, page) = list_episodes(&db, &p, &project, None, None).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(page.total, 1);
        let json = serde_json::to_value(&list[0]).unwrap();
        assert!(json.get("script").is_none(), "剧集列表不得返回完整剧本");
        assert_eq!(json["revision"], 0);
    }

    #[test]
    fn candidate_and_rejected_updates_work_but_adopted_is_rejected() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "ai_comic", "active", "");
        seed_episode(&db, &project, "ep1", "");
        seed_shot(&db, &project, "ep1", "shot1");
        seed_media(&db, &project, "shot1", "m1", "");

        let (m, rev) = update(&db, &p, &project, "m1", "候选版", Some("candidate"), "备注", 0)
            .unwrap();
        assert_eq!(m.status, "candidate");
        assert_eq!(rev, 1);
        let (m2, rev2) = update(&db, &p, &project, "m1", "拒收版", Some("rejected"), "不行", 1)
            .unwrap();
        assert_eq!(m2.status, "rejected");
        assert_eq!(rev2, 2);
        let err = update(&db, &p, &project, "m1", "采用版", Some("adopted"), "", 2).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn version_label_and_review_note_limits_are_enforced_in_core() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "ai_comic", "active", "");
        seed_episode(&db, &project, "ep1", "");
        seed_shot(&db, &project, "ep1", "shot1");
        seed_media(&db, &project, "shot1", "m1", "");

        let label_241 = "a".repeat(241);
        let err = update(&db, &p, &project, "m1", &label_241, None, "", 0).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        let label_240 = "a".repeat(240);
        assert!(update(&db, &p, &project, "m1", &label_240, None, "", 0).is_ok());

        let note_4001 = "b".repeat(4001);
        let err = update(&db, &p, &project, "m1", "v", None, &note_4001, 1).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        let note_4000 = "b".repeat(4000);
        assert!(update(&db, &p, &project, "m1", "v", None, &note_4000, 1).is_ok());

        let err = update(&db, &p, &project, "m1", "v\u{1}", None, "", 2).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
        // 失败事务不留下部分写入
        let (m, rev) = update(&db, &p, &project, "m1", "正常", None, "正常备注", 2).unwrap();
        assert_eq!(m.version_label, "正常");
        assert_eq!(rev, 3);
    }

    #[test]
    fn adopt_moves_revisions_on_both_old_and_new_versions() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "ai_comic", "active", "");
        seed_episode(&db, &project, "ep1", "");
        seed_shot(&db, &project, "ep1", "shot1");
        seed_media(&db, &project, "shot1", "m1", "");
        seed_media(&db, &project, "shot1", "m2", "");
        adopt_media_with_guard(&db, &p, &project, "m1", 0, &NoGuard).unwrap();
        let (_, r2) = adopt_media_with_guard(&db, &p, &project, "m2", 0, &NoGuard).unwrap();
        assert_eq!(r2, 1);
        let (media, page) = list_media(&db, &p, &project, Some("shot1"), None, None).unwrap();
        assert_eq!(page.total, 2);
        let m1 = media.iter().find(|m| m.id == "m1").unwrap();
        let m2 = media.iter().find(|m| m.id == "m2").unwrap();
        assert_eq!(m1.status, "candidate");
        assert!(m1.revision >= 1);
        assert_eq!(m2.status, "adopted");
        assert_eq!(m2.revision, 1);
        assert_eq!(
            media.iter().filter(|m| m.status == "adopted").count(),
            1,
            "同一镜头最多一个 adopted"
        );
    }

    #[test]
    fn stale_revision_does_not_overwrite_newer_content() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let project = seed_project(&db, "ai_comic", "active", "");
        seed_episode(&db, &project, "ep1", "");
        seed_shot(&db, &project, "ep1", "shot1");
        seed_media(&db, &project, "shot1", "m1", "");
        update(&db, &p, &project, "m1", "新版本", None, "", 0).unwrap();
        let err = update(&db, &p, &project, "m1", "旧客户端", None, "", 0).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));
        let (list, _) = list_media(&db, &p, &project, None, None, None).unwrap();
        assert_eq!(list[0].version_label, "新版本");
    }

    #[test]
    fn media_paths_are_relativized_and_never_leak_absolute_root() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let root = std::env::temp_dir().join("taskdock-domain-path-test");
        std::fs::create_dir_all(root.join("assets")).unwrap();
        let inside = root.join("assets").join("a.png");
        std::fs::write(&inside, b"x").unwrap();
        let outside = std::env::temp_dir().join("taskdock-outside-secret.png");
        std::fs::write(&outside, b"x").unwrap();

        let project = seed_project(&db, "ai_comic", "active", root.to_string_lossy().as_ref());
        seed_episode(&db, &project, "ep1", "");
        seed_shot(&db, &project, "ep1", "shot1");
        seed_media(&db, &project, "shot1", "in", inside.to_string_lossy().as_ref());
        seed_media(&db, &project, "shot1", "out", outside.to_string_lossy().as_ref());

        let (list, _) = list_media(&db, &p, &project, None, None, None).unwrap();
        let json = serde_json::to_value(&list).unwrap();
        let text = json.to_string();
        assert!(!text.contains(root.to_string_lossy().as_ref()), "不得泄露本机根目录");
        assert!(!text.contains("taskdock-outside-secret"), "不得泄露越界路径");
        let inside_dto = list.iter().find(|m| m.id == "in").unwrap();
        assert_eq!(inside_dto.file.relative_path.as_deref(), Some("assets/a.png"));
        assert!(inside_dto.file.exists);
        assert_eq!(inside_dto.file.file_type.as_deref(), Some("png"));
        let outside_dto = list.iter().find(|m| m.id == "out").unwrap();
        assert!(outside_dto.file.relative_path.is_none());
        assert!(!outside_dto.file.exists);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_file(outside);
    }

    #[test]
    fn comic_kind_is_enforced_for_all_operations() {
        let db = Db::open_in_memory().unwrap();
        let p = local();
        let novel = seed_project(&db, "novel", "active", "");
        assert!(list_episodes(&db, &p, &novel, None, None).is_err());
    }
}
