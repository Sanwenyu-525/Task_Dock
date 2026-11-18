//! 五类项目共用的笔记 / Agent 会话 / 产物弱关联；不复制内容，不操作外部文件。
use crate::{
    agents::now_iso,
    db::Db,
    error::{AppError, AppResult},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{path::Path, sync::Arc};
use tauri::State;

pub const MIGRATION_69: (i64, &str) = (
    69,
    r#"
CREATE TABLE workspace_resource_links (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('note','agent_session','artifact')),
    target TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, kind, target)
);
CREATE INDEX idx_workspace_resource_links_project
ON workspace_resource_links(project_id, updated_at DESC, id);
"#,
);

const MAX_LINKS: i64 = 2000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceResourceLink {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    /// note / agent_session 为本地 ID；artifact 为绝对路径，不托管文件内容。
    pub target: String,
    pub label: String,
    pub note: String,
    /// 只表达当前可读/可见性；离线与被删除都可能为 false，关联仍保留。
    pub target_exists: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceResourcePage {
    pub links: Vec<WorkspaceResourceLink>,
    pub total: i64,
    pub offset: usize,
    pub limit: usize,
    pub has_more: bool,
}

fn project_gate(conn: &Connection, project: &str, write: bool) -> AppResult<()> {
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM workspace_projects WHERE id=?1",
            [project],
            |row| row.get(0),
        )
        .optional()?;
    match status.as_deref() {
        None => Err(AppError::NotFound("项目不存在".into())),
        Some("archived") if write => Err(AppError::Validation("归档项目的资源关联为只读".into())),
        _ => Ok(()),
    }
}

fn normalize(kind: &str, target: &str) -> AppResult<String> {
    let target = target.trim();
    if kind == "artifact" {
        return Ok(crate::file_workspace::validate_abs_path(target)?
            .to_string_lossy()
            .into_owned());
    }
    if !matches!(kind, "note" | "agent_session")
        || target.is_empty()
        || target.len() > 128
        || target.chars().any(char::is_control)
    {
        return Err(AppError::Validation("资源类型或标识非法".into()));
    }
    Ok(target.to_string())
}

fn target_exists(conn: &Connection, kind: &str, target: &str) -> AppResult<bool> {
    let table = match kind {
        "note" => "notes",
        "agent_session" => "agent_sessions",
        "artifact" => return Ok(Path::new(target).exists()),
        _ => return Err(AppError::Validation("未知资源类型".into())),
    };
    // table 来自固定白名单，target 始终参数绑定。
    Ok(conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1)"),
        [target],
        |r| r.get(0),
    )?)
}

fn read_link(conn: &Connection, id: &str) -> AppResult<WorkspaceResourceLink> {
    let mut link = conn
        .query_row(
            "SELECT id,project_id,kind,target,label,note,created_at,updated_at
        FROM workspace_resource_links WHERE id=?1",
            [id],
            |r| {
                Ok(WorkspaceResourceLink {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    kind: r.get(2)?,
                    target: r.get(3)?,
                    label: r.get(4)?,
                    note: r.get(5)?,
                    target_exists: false,
                    created_at: r.get(6)?,
                    updated_at: r.get(7)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound("资源关联不存在".into()))?;
    if link.kind != "artifact" {
        link.target_exists = target_exists(conn, &link.kind, &link.target)?;
    }
    Ok(link)
}

pub fn save_impl(
    db: &Db,
    project_id: &str,
    kind: &str,
    target: &str,
    label: &str,
    note: &str,
) -> AppResult<WorkspaceResourceLink> {
    let target = normalize(kind, target)?;
    if label.chars().count() > 240
        || label.chars().any(char::is_control)
        || note.chars().count() > 4000
        || note.contains('\0')
    {
        return Err(AppError::Validation("关联标题或备注超出范围".into()));
    }
    let mut result = db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        project_gate(&tx, project_id, true)?;
        let existing: Option<String> = tx.query_row("SELECT id FROM workspace_resource_links
            WHERE project_id=?1 AND kind=?2 AND target=?3", params![project_id, kind, target], |r| r.get(0)).optional()?;
        if existing.is_none() {
            let count: i64 = tx.query_row("SELECT COUNT(*) FROM workspace_resource_links WHERE project_id=?1", [project_id], |r| r.get(0))?;
            if count >= MAX_LINKS { return Err(AppError::Validation("项目资源关联已达 2000 条上限".into())); }
            if kind != "artifact" && !target_exists(&tx, kind, &target)? {
                return Err(AppError::NotFound("要关联的笔记或 Agent 会话不存在".into()));
            }
        }
        let id = existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let now = now_iso();
        tx.execute("INSERT INTO workspace_resource_links(id,project_id,kind,target,label,note,created_at,updated_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(project_id,kind,target) DO UPDATE SET
            label=excluded.label,note=excluded.note,updated_at=excluded.updated_at",
            params![id,project_id,kind,target,label.trim(),note,now])?;
        let result = read_link(&tx, &id)?;
        tx.commit()?;
        Ok(result)
    })?;
    if result.kind == "artifact" {
        result.target_exists = Path::new(&result.target).exists();
    }
    Ok(result)
}

pub fn list_impl(
    db: &Db,
    project_id: &str,
    kind: Option<&str>,
    offset: usize,
    limit: usize,
) -> AppResult<WorkspaceResourcePage> {
    let kind = kind.filter(|v| !v.is_empty());
    if kind.is_some_and(|v| !matches!(v, "note" | "agent_session" | "artifact")) || offset > 100_000
    {
        return Err(AppError::Validation("资源筛选或分页参数非法".into()));
    }
    let limit = limit.clamp(1, 200);
    let mut result = db.with_read(|conn| {
        let tx = conn.unchecked_transaction()?;
        project_gate(&tx, project_id, false)?;
        let total: i64 = tx.query_row(
            "SELECT COUNT(*) FROM workspace_resource_links
            WHERE project_id=?1 AND (?2 IS NULL OR kind=?2)",
            params![project_id, kind],
            |r| r.get(0),
        )?;
        let ids: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM workspace_resource_links
                WHERE project_id=?1 AND (?2 IS NULL OR kind=?2)
                ORDER BY updated_at DESC,id LIMIT ?3 OFFSET ?4",
            )?;
            let rows = stmt.query_map(
                params![project_id, kind, limit as i64, offset as i64],
                |r| r.get(0),
            )?;
            rows.collect::<Result<_, _>>()?
        };
        let links = ids
            .iter()
            .map(|id| read_link(&tx, id))
            .collect::<AppResult<Vec<_>>>()?;
        let has_more = offset.saturating_add(links.len()) < total as usize;
        Ok(WorkspaceResourcePage {
            links,
            total,
            offset,
            limit,
            has_more,
        })
    })?;
    for link in &mut result.links {
        if link.kind == "artifact" {
            link.target_exists = Path::new(&link.target).exists();
        }
    }
    Ok(result)
}

pub fn remove_impl(db: &Db, project_id: &str, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        project_gate(conn, project_id, true)?;
        if conn.execute(
            "DELETE FROM workspace_resource_links WHERE id=?1 AND project_id=?2",
            params![id, project_id],
        )? == 0
        {
            return Err(AppError::NotFound("当前项目不存在该资源关联".into()));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn workspace_resource_save(
    db: State<'_, Arc<Db>>,
    project_id: String,
    kind: String,
    target: String,
    label: String,
    note: String,
) -> AppResult<WorkspaceResourceLink> {
    save_impl(&db, &project_id, &kind, &target, &label, &note)
}
#[tauri::command]
pub fn workspace_resource_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    kind: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> AppResult<WorkspaceResourcePage> {
    list_impl(
        &db,
        &project_id,
        kind.as_deref(),
        offset.unwrap_or(0),
        limit.unwrap_or(50),
    )
}
#[tauri::command]
pub fn workspace_resource_remove(
    db: State<'_, Arc<Db>>,
    project_id: String,
    id: String,
) -> AppResult<serde_json::Value> {
    remove_impl(&db, &project_id, &id)?;
    Ok(serde_json::json!({"ok": true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::project_workspace as projects;

    fn project(db: &Db, kind: &str) -> String {
        projects::workspace_project_save_impl(db, None, kind.into(), kind.into(), None, None, None)
            .unwrap()
            .id
    }

    #[test]
    fn backend_round2_resources_all_profiles_keep_weak_targets_and_delete_only_links() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|c| {
            c.execute("INSERT INTO notes(id,title,content,created_at,updated_at) VALUES('resource-note','note','original','now','now')", [])?;
            c.execute("INSERT INTO agent_sources(id,display_name,created_at,updated_at) VALUES('resource-source','test','now','now')", [])?;
            c.execute("INSERT INTO agent_sessions(id,source_id,external_id,title,first_seen_at,last_seen_at)
                VALUES('resource-session','resource-source','external','session','now','now')", [])?;
            Ok(())
        }).unwrap();
        let artifact =
            std::env::temp_dir().join(format!("td-resource-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&artifact, "original").unwrap();
        for kind in projects::PROJECT_KINDS {
            let pid = project(&db, kind);
            let note = save_impl(&db, &pid, "note", "resource-note", "first", "").unwrap();
            let updated = save_impl(&db, &pid, "note", "resource-note", "updated", "memo").unwrap();
            assert_eq!(note.id, updated.id);
            assert_eq!(updated.note, "memo");
            assert!(updated.target_exists);
            assert!(
                save_impl(
                    &db,
                    &pid,
                    "agent_session",
                    "resource-session",
                    "session",
                    ""
                )
                .unwrap()
                .target_exists
            );
            let file = save_impl(
                &db,
                &pid,
                "artifact",
                artifact.to_str().unwrap(),
                "output",
                "",
            )
            .unwrap();
            assert!(file.target_exists);
            assert_eq!(list_impl(&db, &pid, None, 0, 50).unwrap().total, 3);
            projects::workspace_project_delete_impl(&db, &pid).unwrap();
            db.with_read(|c| {
                assert!(read_link(c, &file.id).is_err());
                Ok(())
            })
            .unwrap();
            assert!(artifact.exists(), "删除项目不能删除外部产物");
        }
        let pid = project(&db, "general");
        save_impl(&db, &pid, "note", "resource-note", "keep reference", "").unwrap();
        db.with_conn(|c| {
            c.execute("DELETE FROM notes WHERE id='resource-note'", [])?;
            Ok(())
        })
        .unwrap();
        let page = list_impl(&db, &pid, None, 0, 50).unwrap();
        assert_eq!(page.total, 1);
        assert!(!page.links[0].target_exists);
        assert_eq!(std::fs::read(&artifact).unwrap(), b"original");
        std::fs::remove_file(artifact).unwrap();
    }

    #[test]
    fn backend_round2_resources_enforce_project_pagination_validation_and_archive() {
        let db = Db::open_in_memory().unwrap();
        let pid = project(&db, "general");
        let other = project(&db, "novel");
        for i in 0..3 {
            save_impl(
                &db,
                &pid,
                "artifact",
                &format!("C:\\resource-fixture\\{i}.txt"),
                "file",
                "",
            )
            .unwrap();
        }
        let first = list_impl(&db, &pid, Some("artifact"), 0, 2).unwrap();
        let second = list_impl(&db, &pid, None, 2, 2).unwrap();
        assert_eq!(first.total, 3);
        assert!(first.has_more);
        assert!(!second.has_more);
        assert_eq!(first.links.len(), 2);
        assert_eq!(second.links.len(), 1);
        assert!(!first.links.iter().any(|l| l.id == second.links[0].id));
        assert_eq!(list_impl(&db, &other, None, 0, 50).unwrap().total, 0);
        assert!(remove_impl(&db, &other, &first.links[0].id).is_err());
        assert!(save_impl(&db, &pid, "note", "missing", "", "").is_err());
        assert!(save_impl(&db, &pid, "artifact", "relative", "", "").is_err());
        assert!(save_impl(&db, &pid, "unknown", "x", "", "").is_err());
        projects::workspace_project_set_status_impl(&db, &pid, "archived".into()).unwrap();
        assert!(save_impl(&db, &pid, "artifact", "C:\\new.txt", "", "").is_err());
        assert!(remove_impl(&db, &pid, &first.links[0].id).is_err());
        assert_eq!(list_impl(&db, &pid, None, 0, 50).unwrap().total, 3);
    }

    #[test]
    fn backend_round2_resource_cap_allows_existing_link_updates() {
        let db = Db::open_in_memory().unwrap();
        let pid = project(&db, "general");
        db.with_conn(|c| {
            c.execute("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000)
                INSERT INTO workspace_resource_links(id,project_id,kind,target,label,note,created_at,updated_at)
                SELECT 'cap-'||x,?1,'artifact','C:\\resource-cap\\'||x||'.txt','','','now','now' FROM n", [&pid])?;
            Ok(())
        }).unwrap();
        assert!(save_impl(&db, &pid, "artifact", "C:\\over-cap.txt", "", "").is_err());
        let existing = list_impl(&db, &pid, None, 0, 1).unwrap().links.remove(0);
        assert!(save_impl(&db, &pid, "artifact", &existing.target, "updated", "").is_ok());
        assert_eq!(list_impl(&db, &pid, None, 0, 1).unwrap().total, MAX_LINKS);
    }
}
