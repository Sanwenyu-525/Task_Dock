//! 可视化资产服务（v85）：图片导入、SHA-256 去重、受控读取、归档。
//!
//! 与 `collab_evidence` 分开：证据是「验收/复现材料」，资产是「可视化内容引用的图片」。
//! 只存元数据与受控路径，原图永不改写；标注层保存在文档 JSON 中。

use std::path::{Path, PathBuf};

use base64::Engine as _;
use rusqlite::{Connection, OptionalExtension};

use crate::error::{AppError, AppResult};

use super::actor::{assert_project_scope, write_audit, Actor, Capability};
use super::model::{
    AssetContent, VisualAsset, VisualAssetInput, MAX_VISUAL_ASSET_BYTES,
    MAX_VISUAL_ASSET_READ_BYTES, VISUAL_ASSET_EXTS,
};
use super::util::{
    assert_file_in_root, collab_assets_root, new_id, now_iso, sanitize_filename, sha256_file,
    validate_text,
};

const COLS: &str = "id, project_id, document_id, title, path, sha256, size_bytes, mime, ext, \
status, meta_json, created_by, source, created_at";

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<VisualAsset> {
    Ok(VisualAsset {
        id: r.get(0)?,
        project_id: r.get(1)?,
        document_id: r.get(2)?,
        title: r.get(3)?,
        path: r.get(4)?,
        sha256: r.get(5)?,
        size_bytes: r.get(6)?,
        mime: r.get(7)?,
        ext: r.get(8)?,
        status: r.get(9)?,
        meta_json: r.get(10)?,
        created_by: r.get(11)?,
        source: r.get(12)?,
        created_at: r.get(13)?,
    })
}

fn load_asset(conn: &Connection, id: &str) -> AppResult<VisualAsset> {
    conn.query_row(
        &format!("SELECT {COLS} FROM collab_visual_assets WHERE id=?1"),
        rusqlite::params![id],
        map_row,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound("可视化资产不存在".to_string()))
}

fn find_by_hash(conn: &Connection, project_id: &str, sha: &str) -> AppResult<Option<VisualAsset>> {
    let asset = conn
        .query_row(
            &format!(
                "SELECT {COLS} FROM collab_visual_assets WHERE project_id=?1 AND sha256=?2 LIMIT 1"
            ),
            rusqlite::params![project_id, sha],
            map_row,
        )
        .optional()?;
    Ok(asset)
}

fn dest_dir(project_id: &str) -> PathBuf {
    collab_assets_root().join(sanitize_filename(project_id))
}

fn assert_document_scope(
    conn: &Connection,
    document_id: Option<&str>,
    project_id: &str,
) -> AppResult<()> {
    let Some(document_id) = document_id else {
        return Ok(());
    };
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM collab_visual_docs WHERE id=?1",
            rusqlite::params![document_id],
            |r| r.get(0),
        )
        .optional()?;
    match owner.as_deref() {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => Err(AppError::Forbidden("可视化文档不属于该项目".to_string())),
        None => Err(AppError::NotFound("可视化文档不存在".to_string())),
    }
}

fn validate_source_file(path: &Path) -> AppResult<(u64, String)> {
    let meta = std::fs::metadata(path)
        .map_err(|_| AppError::Validation("图片文件不存在或不可访问".to_string()))?;
    if !meta.is_file() {
        return Err(AppError::Validation("图片必须是普通文件".to_string()));
    }
    if meta.len() == 0 {
        return Err(AppError::Validation("图片文件为空".to_string()));
    }
    if meta.len() > MAX_VISUAL_ASSET_BYTES {
        return Err(AppError::Validation("图片超过 32 MiB 上限".to_string()));
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !VISUAL_ASSET_EXTS.contains(&ext.as_str()) {
        return Err(AppError::Validation(format!(
            "不支持的图片类型：{ext}（允许 {}）",
            VISUAL_ASSET_EXTS.join("/")
        )));
    }
    Ok((meta.len(), ext))
}

pub fn import_asset(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    input: &VisualAssetInput,
) -> AppResult<VisualAsset> {
    actor.require(Capability::VisualWrite)?;
    assert_project_scope(conn, actor, project_id)?;
    assert_document_scope(conn, input.document_id.as_deref(), project_id)?;

    let source = input.path.trim();
    if source.is_empty() {
        return Err(AppError::Validation("图片路径不能为空".to_string()));
    }
    if source.contains("://") {
        return Err(AppError::Validation("只允许导入本机文件".to_string()));
    }
    let src = Path::new(source);
    let (size, ext) = validate_source_file(src)?;
    let sha = sha256_file(src)?;

    if let Some(existing) = find_by_hash(conn, project_id, &sha)? {
        // 去重：同一项目同一内容只保留一份；归档资产再次导入时恢复为 active。
        if existing.status == "archived" || (existing.document_id.is_none() && input.document_id.is_some())
        {
            conn.execute(
                "UPDATE collab_visual_assets SET status='active', document_id=COALESCE(document_id, ?2)
                 WHERE id=?1",
                rusqlite::params![existing.id, input.document_id],
            )?;
            return load_asset(conn, &existing.id);
        }
        return Ok(existing);
    }

    let dir = dest_dir(project_id);
    std::fs::create_dir_all(&dir)?;
    let base = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("asset");
    let dest = dir.join(format!("{}-{}", &sha[..12], sanitize_filename(base)));
    if !dest.exists() {
        std::fs::copy(src, &dest)?;
    }
    // 复制后再校验一次路径，防止符号链接/竞态把文件写到资产根之外。
    assert_file_in_root(&dest, &collab_assets_root(), "可视化资产")?;

    let title = validate_text(
        if input.title.trim().is_empty() {
            base
        } else {
            input.title.as_str()
        },
        "资产标题",
        200,
        false,
    )?;
    let row = VisualAsset {
        id: new_id("va"),
        project_id: project_id.to_string(),
        document_id: input.document_id.clone(),
        title,
        path: dest.to_string_lossy().to_string(),
        sha256: sha,
        size_bytes: size as i64,
        mime: mime_for(&ext).to_string(),
        ext,
        status: "active".to_string(),
        meta_json: "{}".to_string(),
        created_by: actor.id.clone(),
        source: actor.source.clone(),
        created_at: now_iso(),
    };
    conn.execute(
        &format!("INSERT INTO collab_visual_assets ({COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)"),
        rusqlite::params![
            row.id, row.project_id, row.document_id, row.title, row.path, row.sha256,
            row.size_bytes, row.mime, row.ext, row.status, row.meta_json, row.created_by,
            row.source, row.created_at
        ],
    )?;
    write_audit(
        conn,
        project_id,
        "visual_asset",
        &row.id,
        "import",
        actor,
        None,
        None,
        serde_json::json!({"sha256": row.sha256, "sizeBytes": row.size_bytes, "ext": row.ext}),
    )?;
    Ok(row)
}

pub fn list_assets(
    conn: &Connection,
    actor: &Actor,
    project_id: &str,
    document_id: Option<&str>,
) -> AppResult<Vec<VisualAsset>> {
    actor.require(Capability::VisualRead)?;
    assert_project_scope(conn, actor, project_id)?;
    assert_document_scope(conn, document_id, project_id)?;
    let mut out = Vec::new();
    if let Some(document_id) = document_id {
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLS} FROM collab_visual_assets WHERE project_id=?1 AND document_id=?2 \
             AND status='active' ORDER BY created_at DESC LIMIT 200"
        ))?;
        let rows = stmt.query_map(rusqlite::params![project_id, document_id], map_row)?;
        for row in rows {
            out.push(row?);
        }
    } else {
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLS} FROM collab_visual_assets WHERE project_id=?1 AND status='active' \
             ORDER BY created_at DESC LIMIT 200"
        ))?;
        let rows = stmt.query_map(rusqlite::params![project_id], map_row)?;
        for row in rows {
            out.push(row?);
        }
    }
    Ok(out)
}

/// 受控读取：校验项目归属 + 路径必须位于资产根目录，单次上限 8 MiB。
pub fn read_asset(conn: &Connection, actor: &Actor, asset_id: &str) -> AppResult<AssetContent> {
    actor.require(Capability::VisualRead)?;
    let asset = load_asset(conn, asset_id)?;
    assert_project_scope(conn, actor, &asset.project_id)?;
    let path = assert_file_in_root(
        Path::new(&asset.path),
        &collab_assets_root(),
        "可视化资产",
    )?;
    let meta = std::fs::metadata(&path)?;
    if meta.len() > MAX_VISUAL_ASSET_READ_BYTES {
        return Err(AppError::Validation(
            "图片超过 8 MiB 在线预览上限；请先压缩后再导入".to_string(),
        ));
    }
    let bytes = std::fs::read(&path)?;
    Ok(AssetContent {
        id: asset.id,
        mime: asset.mime.clone(),
        size_bytes: asset.size_bytes,
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

pub fn archive_asset(conn: &Connection, actor: &Actor, asset_id: &str) -> AppResult<VisualAsset> {
    actor.require(Capability::VisualWrite)?;
    let asset = load_asset(conn, asset_id)?;
    assert_project_scope(conn, actor, &asset.project_id)?;
    if asset.status == "archived" {
        return Ok(asset);
    }
    conn.execute(
        "UPDATE collab_visual_assets SET status='archived' WHERE id=?1",
        rusqlite::params![asset_id],
    )?;
    write_audit(
        conn,
        &asset.project_id,
        "visual_asset",
        asset_id,
        "archive",
        actor,
        None,
        None,
        serde_json::json!({}),
    )?;
    load_asset(conn, asset_id)
}

/// 资产路径解析（内部使用）：只允许资产根目录内的普通文件。
pub fn resolve_asset_path(conn: &Connection, asset_id: &str) -> AppResult<PathBuf> {
    let asset = load_asset(conn, asset_id)?;
    assert_file_in_root(Path::new(&asset.path), &collab_assets_root(), "可视化资产")
}
