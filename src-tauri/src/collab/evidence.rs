//! 证据：文件复制入库、sha256 去重、主体归属校验、受控读取。
//!
//! 只存元数据；文件落在 `<data>/collab-evidence/<project>/<subject>/`。
//! 不提供删除命令（归档项目仍保留证据）。

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};

use crate::error::{AppError, AppResult};

use super::actor::{assert_project_scope, Actor, Capability};
use super::model::{
    Evidence, EvidenceInput, Page, EVIDENCE_KINDS, MAX_EVIDENCE_BYTES,
    MAX_TEXT_EVIDENCE_BYTES, PAGE_MAX,
};
use super::util::{
    assert_file_in_root, collab_evidence_root, new_id, now_iso, sanitize_filename,
    sha256_bytes, sha256_file, validate_enum, validate_text,
};

const MAX_EVIDENCE_PER_SUBJECT: i64 = 50;
const EXT_WHITELIST: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "gif", "txt", "log", "json", "md", "mp4", "webm", "zip",
];

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "zip" => "application/zip",
        "json" => "application/json",
        "md" => "text/markdown",
        "txt" | "log" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn subject_owner_project(
    conn: &Connection,
    subject_kind: &str,
    subject_id: &str,
) -> AppResult<Option<String>> {
    let sql = match subject_kind {
        "issue" | "bug" => "SELECT project_id FROM collab_issues WHERE id=?1",
        "plan" => "SELECT project_id FROM collab_plans WHERE id=?1",
        "visual" => "SELECT project_id FROM collab_visual_docs WHERE id=?1",
        // 任务表没有 project_id：只校验存在，项目归属由方案关联决定。
        "task" => "SELECT '' FROM tasks WHERE id=?1",
        _ => return Err(AppError::Validation("证据主体类型非法".to_string())),
    };
    let project: Option<String> = conn
        .query_row(sql, rusqlite::params![subject_id], |r| r.get(0))
        .optional()?;
    Ok(project)
}

fn assert_subject(conn: &Connection, project_id: &str, kind: &str, id: &str) -> AppResult<()> {
    let project = subject_owner_project(conn, kind, id)?
        .ok_or_else(|| AppError::NotFound("证据主体不存在".to_string()))?;
    if kind != "task" && project != project_id {
        return Err(AppError::Forbidden("证据主体不属于该项目".to_string()));
    }
    Ok(())
}

fn count_for_subject(conn: &Connection, kind: &str, id: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM collab_evidence WHERE subject_kind=?1 AND subject_id=?2",
        rusqlite::params![kind, id],
        |r| r.get(0),
    )?)
}

fn dest_dir(project_id: &str, subject_kind: &str, subject_id: &str) -> PathBuf {
    collab_evidence_root()
        .join(sanitize_filename(project_id))
        .join(sanitize_filename(subject_kind))
        .join(sanitize_filename(subject_id))
}

fn insert_row(conn: &Connection, row: &Evidence) -> AppResult<()> {
    conn.execute(
        "INSERT INTO collab_evidence
         (id, project_id, subject_kind, subject_id, kind, title, path, sha256, size_bytes,
          mime, meta_json, created_by, source, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        rusqlite::params![
            row.id,
            row.project_id,
            row.subject_kind,
            row.subject_id,
            row.kind,
            row.title,
            row.path,
            row.sha256,
            row.size_bytes,
            row.mime,
            row.meta_json,
            row.created_by,
            row.source,
            row.created_at
        ],
    )?;
    Ok(())
}

fn find_existing(
    conn: &Connection,
    project_id: &str,
    sha: &str,
    subject_kind: &str,
    subject_id: &str,
) -> AppResult<Option<Evidence>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, subject_kind, subject_id, kind, title, path, sha256, size_bytes,
                mime, meta_json, created_by, source, created_at
         FROM collab_evidence WHERE project_id=?1 AND sha256=?2 AND subject_kind=?3
         AND subject_id=?4 LIMIT 1",
    )?;
    let mut rows = stmt.query(rusqlite::params![project_id, sha, subject_kind, subject_id])?;
    if let Some(r) = rows.next()? {
        return Ok(Some(map_row(r)?));
    }
    Ok(None)
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Evidence> {
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
}

pub fn attach_path(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    input: &EvidenceInput,
) -> AppResult<Evidence> {
    actor.require(Capability::EvidenceWrite)?;
    assert_project_scope(conn, actor, project_id)?;
    assert_subject(conn, project_id, &input.subject_kind, &input.subject_id)?;
    let kind = validate_enum(&input.kind, EVIDENCE_KINDS, "证据类型")?;

    let source = input
        .path
        .as_deref()
        .ok_or_else(|| AppError::Validation("缺少证据文件路径".to_string()))?;
    let src = Path::new(source);
    let meta = std::fs::metadata(src)
        .map_err(|_| AppError::Validation("证据文件不存在或不可访问".to_string()))?;
    if !meta.is_file() {
        return Err(AppError::Validation("证据必须是普通文件".to_string()));
    }
    if meta.len() > MAX_EVIDENCE_BYTES {
        return Err(AppError::Validation("证据文件超过 32 MiB 上限".to_string()));
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !EXT_WHITELIST.contains(&ext.as_str()) {
        return Err(AppError::Validation(format!(
            "不支持的文件类型：{ext}（允许 {}）",
            EXT_WHITELIST.join("/")
        )));
    }

    if count_for_subject(conn, &input.subject_kind, &input.subject_id)? >= MAX_EVIDENCE_PER_SUBJECT
    {
        return Err(AppError::Validation(format!(
            "单个主体最多 {MAX_EVIDENCE_PER_SUBJECT} 份证据"
        )));
    }

    let sha = sha256_file(src)?;
    if let Some(existing) = find_existing(
        conn,
        project_id,
        &sha,
        &input.subject_kind,
        &input.subject_id,
    )? {
        return Ok(existing);
    }

    let dir = dest_dir(project_id, &input.subject_kind, &input.subject_id);
    std::fs::create_dir_all(&dir)?;
    let base = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("evidence");
    let name = format!("{}-{}", &sha[..12], sanitize_filename(base));
    let dest = dir.join(name);
    std::fs::copy(src, &dest)?;

    let title = validate_text(
        if input.title.trim().is_empty() {
            base
        } else {
            input.title.as_str()
        },
        "证据标题",
        200,
        false,
    )?;
    let row = Evidence {
        id: new_id("ev"),
        project_id: project_id.to_string(),
        subject_kind: input.subject_kind.clone(),
        subject_id: input.subject_id.clone(),
        kind,
        title,
        path: dest.to_string_lossy().to_string(),
        sha256: sha,
        size_bytes: meta.len() as i64,
        mime: mime_for(&ext).to_string(),
        meta_json: input
            .meta
            .as_ref()
            .map(|v| v.to_string())
            .unwrap_or_else(|| "{}".to_string()),
        created_by: actor.id.clone(),
        source: actor.source.clone(),
        created_at: now_iso(),
    };
    insert_row(conn, &row)?;
    Ok(row)
}

pub fn attach_text(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    input: &EvidenceInput,
) -> AppResult<Evidence> {
    actor.require(Capability::EvidenceWrite)?;
    assert_project_scope(conn, actor, project_id)?;
    assert_subject(conn, project_id, &input.subject_kind, &input.subject_id)?;
    let kind = validate_enum(&input.kind, EVIDENCE_KINDS, "证据类型")?;
    let text = input
        .text
        .as_deref()
        .ok_or_else(|| AppError::Validation("缺少证据文本".to_string()))?;
    if text.len() > MAX_TEXT_EVIDENCE_BYTES {
        return Err(AppError::Validation("文本证据超过 1 MiB 上限".to_string()));
    }
    if text.trim().is_empty() {
        return Err(AppError::Validation("证据文本不能为空".to_string()));
    }
    if count_for_subject(conn, &input.subject_kind, &input.subject_id)? >= MAX_EVIDENCE_PER_SUBJECT
    {
        return Err(AppError::Validation(format!(
            "单个主体最多 {MAX_EVIDENCE_PER_SUBJECT} 份证据"
        )));
    }

    let sha = sha256_bytes(text.as_bytes());
    if let Some(existing) = find_existing(
        conn,
        project_id,
        &sha,
        &input.subject_kind,
        &input.subject_id,
    )? {
        return Ok(existing);
    }

    let dir = dest_dir(project_id, &input.subject_kind, &input.subject_id);
    std::fs::create_dir_all(&dir)?;
    let ext = if kind == "log" { "log" } else { "txt" };
    let name = format!("{}-evidence.{ext}", &sha[..12]);
    let dest = dir.join(&name);
    std::fs::write(&dest, text)?;

    let row = Evidence {
        id: new_id("ev"),
        project_id: project_id.to_string(),
        subject_kind: input.subject_kind.clone(),
        subject_id: input.subject_id.clone(),
        kind,
        title: validate_text(
            if input.title.trim().is_empty() {
                "文本证据"
            } else {
                input.title.as_str()
            },
            "证据标题",
            200,
            false,
        )?,
        path: dest.to_string_lossy().to_string(),
        sha256: sha,
        size_bytes: text.len() as i64,
        mime: "text/plain".to_string(),
        meta_json: input
            .meta
            .as_ref()
            .map(|v| v.to_string())
            .unwrap_or_else(|| "{}".to_string()),
        created_by: actor.id.clone(),
        source: actor.source.clone(),
        created_at: now_iso(),
    };
    insert_row(conn, &row)?;
    Ok(row)
}

pub fn list_evidence(
    conn: &Connection,
    actor: &Actor,
    subject_kind: &str,
    subject_id: &str,
) -> AppResult<Vec<Evidence>> {
    actor.require(Capability::VisualRead)?;
    let project = subject_owner_project(conn, subject_kind, subject_id)?
        .ok_or_else(|| AppError::NotFound("证据主体不存在".to_string()))?;
    if subject_kind != "task" {
        assert_project_scope(conn, actor, &project)?;
    }
    let mut stmt = conn.prepare(
        "SELECT id, project_id, subject_kind, subject_id, kind, title, path, sha256, size_bytes,
                mime, meta_json, created_by, source, created_at
         FROM collab_evidence WHERE subject_kind=?1 AND subject_id=?2
         ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![subject_kind, subject_id], map_row)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn list_for_project(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    page: Option<i64>,
    page_size: Option<i64>,
) -> AppResult<Page<Evidence>> {
    actor.require(Capability::VisualRead)?;
    assert_project_scope(conn, actor, project_id)?;
    let (page, size, offset) = super::util::page_bounds(page, page_size, PAGE_MAX);
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM collab_evidence WHERE project_id=?1",
        rusqlite::params![project_id],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT id, project_id, subject_kind, subject_id, kind, title, path, sha256, size_bytes,
                mime, meta_json, created_by, source, created_at
         FROM collab_evidence WHERE project_id=?1
         ORDER BY created_at DESC LIMIT ?2 OFFSET ?3",
    )?;
    let items = stmt
        .query_map(rusqlite::params![project_id, size, offset], map_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Page::new(items, total, page, size))
}

/// 校验证据文件仍存在且位于证据根目录内（读取前调用，防路径被替换）。
pub fn assert_evidence_readable(evidence: &Evidence) -> AppResult<()> {
    let root = collab_evidence_root();
    assert_file_in_root(Path::new(&evidence.path), &root, "证据文件")
        .map(|_| ())
}

/// 供 MCP/前端展示证据时使用的安全路径（只返回文件名，不暴露绝对目录）。
pub fn display_path(evidence: &Evidence) -> String {
    Path::new(&evidence.path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "evidence".to_string())
}
