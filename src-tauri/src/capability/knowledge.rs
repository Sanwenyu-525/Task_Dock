//! 知识库：文档导入、分块索引、检索、关联与删除语义。
//!
//! 原文边界：
//! - 引用模式（reference）只记录绝对路径与索引正文，删除文档不删除原文件；
//! - 导入模式（imported）复制到 `<data>/knowledge/<kb>/<uuid>.<ext>`，删除文档只删副本；
//! - 任何路径都不删除用户原文件。
//!
//! 检索 v1 使用分块 LIKE（与 `global_search` 同一转义口径），兼容中文；
//! FTS5 / Embedding 属于 P2，不在此处假设可用。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::{
    check_text, content_hash, knowledge_root, managed_file_name, now_iso, truncate_chars,
    MAX_DOCUMENTS_PER_KB, MAX_DOCUMENT_BYTES, MAX_SEARCH_LIMIT,
};

/// 分块大小（字符）与重叠（字符）。
const CHUNK_CHARS: usize = 1200;
const CHUNK_OVERLAP: usize = 200;
/// 文件夹导入上限。
const MAX_FOLDER_FILES: usize = 2000;
const MAX_FOLDER_DEPTH: usize = 8;
const MAX_FOLDER_BYTES: usize = 32 * 1024 * 1024;
/// 导入明细最多返回条数（计数仍完整）。
const MAX_REPORT_ITEMS: usize = 200;

// ── 类型 ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBase {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: String,
    pub project_id: Option<String>,
    /// 工作区类型知识库的真实绑定；复用 `workspace_projects.id`。
    pub workspace_id: Option<String>,
    pub favorite: bool,
    pub doc_count: i64,
    pub indexed_count: i64,
    pub failed_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBaseDetail {
    #[serde(flatten)]
    pub base: KnowledgeBase,
    pub recent_documents: Vec<KnowledgeDocument>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDocument {
    pub id: String,
    pub kb_id: String,
    pub title: String,
    pub source_kind: String,
    pub source_mode: String,
    pub source_path: Option<String>,
    pub mime: String,
    pub size_bytes: i64,
    pub content_hash: String,
    pub status: String,
    pub error: String,
    pub chunk_count: i64,
    pub indexed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDocumentDetail {
    #[serde(flatten)]
    pub document: KnowledgeDocument,
    pub content: String,
    pub truncated: bool,
    pub links: Vec<KnowledgeLink>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeLink {
    pub id: String,
    pub doc_id: String,
    pub target_kind: String,
    pub target_id: String,
    pub label: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBacklink {
    pub link_id: String,
    pub doc_id: String,
    pub title: String,
    pub kb_id: String,
    pub kb_name: String,
    pub target_kind: String,
    pub target_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPage {
    pub documents: Vec<KnowledgeDocument>,
    pub total: i64,
    pub offset: usize,
    pub limit: usize,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    pub path: String,
    pub status: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: usize,
    pub skipped: usize,
    pub duplicates: usize,
    pub failed: usize,
    pub items: Vec<ImportItem>,
    pub documents: Vec<KnowledgeDocument>,
}

impl ImportReport {
    fn new() -> Self {
        Self {
            imported: 0,
            skipped: 0,
            duplicates: 0,
            failed: 0,
            items: Vec::new(),
            documents: Vec::new(),
        }
    }

    fn push(&mut self, path: &str, status: &str, reason: &str) {
        match status {
            "imported" => self.imported += 1,
            "duplicate" => self.duplicates += 1,
            "skipped" => self.skipped += 1,
            _ => self.failed += 1,
        }
        if self.items.len() < MAX_REPORT_ITEMS {
            self.items.push(ImportItem {
                path: path.to_string(),
                status: status.to_string(),
                reason: reason.to_string(),
            });
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteKbReport {
    pub deleted_docs: usize,
    pub deleted_copies: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteDocReport {
    pub deleted_copy: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeStats {
    pub kb_count: i64,
    pub doc_count: i64,
    pub indexed_count: i64,
    pub failed_count: i64,
    pub chunk_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildReport {
    pub indexed: usize,
    pub failed: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchHit {
    pub doc_id: String,
    pub kb_id: String,
    pub kb_name: String,
    pub title: String,
    pub source_kind: String,
    pub source_path: Option<String>,
    pub snippet: String,
    pub chunk_offset: i64,
    /// 0=标题精确 1=标题前缀 2=标题包含 3=正文命中
    pub rank: u8,
    pub status: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchPage {
    pub query: String,
    pub hits: Vec<KnowledgeSearchHit>,
    pub total: i64,
    pub limit: usize,
    pub offset: usize,
    pub has_more: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBaseInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBasePatch {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
}

// ── 工具函数 ───────────────────────────────────────────────────────

fn like_pattern(q: &str) -> String {
    format!(
        "%{}%",
        q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    )
}

fn normalize_kind(raw: &str) -> AppResult<&'static str> {
    match raw.trim() {
        "" | "personal" => Ok("personal"),
        "project" => Ok("project"),
        "workspace" => Ok("workspace"),
        other => Err(AppError::Validation(format!(
            "知识库类型非法: {other}（允许 personal|project|workspace）"
        ))),
    }
}

fn normalize_source_kind(raw: &str) -> AppResult<&'static str> {
    match raw.trim() {
        "file" => Ok("file"),
        "folder" => Ok("folder"),
        "note" => Ok("note"),
        "capture" => Ok("capture"),
        "text" => Ok("text"),
        other => Err(AppError::Validation(format!(
            "来源类型非法: {other}（允许 file|folder|note|capture|text）"
        ))),
    }
}

fn normalize_mode(raw: &str) -> AppResult<&'static str> {
    match raw.trim() {
        "reference" => Ok("reference"),
        "imported" | "import" => Ok("imported"),
        other => Err(AppError::Validation(format!(
            "导入模式非法: {other}（允许 reference|imported）"
        ))),
    }
}

/// 允许作为文本索引的扩展名（大小写不敏感）。
pub fn supported_extension(ext: &str) -> bool {
    matches!(
        ext,
        "md" | "markdown"
            | "txt"
            | "text"
            | "log"
            | "csv"
            | "tsv"
            | "json"
            | "jsonl"
            | "xml"
            | "yaml"
            | "yml"
            | "toml"
            | "ini"
            | "cfg"
            | "conf"
            | "rst"
            | "adoc"
            | "html"
            | "htm"
            | "css"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "py"
            | "rs"
            | "go"
            | "java"
            | "kt"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "cs"
            | "sh"
            | "ps1"
            | "bat"
            | "sql"
            | "vue"
            | "svelte"
    )
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "md" | "markdown" => "text/markdown",
        "html" | "htm" => "text/html",
        "json" | "jsonl" => "application/json",
        "csv" | "tsv" => "text/csv",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        _ => "text/plain",
    }
}

fn strip_html(input: &str) -> String {
    // 只做保守的标签剥离：不是 HTML 渲染器，脚本内容也必须保留为纯文本/被移除。
    let script = regex::Regex::new(r"(?is)<(script|style)[^>]*>.*?</(script|style)>").unwrap();
    let tags = regex::Regex::new(r"(?s)<[^>]+>").unwrap();
    let text = script.replace_all(input, " ");
    let text = tags.replace_all(&text, " ");
    text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

/// 读取来源失败的诊断码。状态枚举保持 `pending|indexed|failed` 不变，
/// 具体原因写入 `knowledge_documents.error` 前缀，兼容旧数据。
#[derive(Debug, Clone)]
struct SourceReadFailure {
    code: &'static str,
    message: String,
}

impl SourceReadFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn tagged(&self) -> String {
        format!("[{}] {}", self.code, self.message)
    }
}

fn classify_io(path: &Path, action: &str, error: std::io::Error) -> SourceReadFailure {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "source_missing",
        std::io::ErrorKind::PermissionDenied => "source_unreadable",
        _ => "source_unreadable",
    };
    SourceReadFailure::new(code, format!("{action}失败: {}（{error}）", path.display()))
}

/// 读取文本文件（≤2 MiB）。支持 UTF-8 与带 BOM 的 UTF-16；其它编码明确拒绝。
fn read_text_file_detailed(path: &Path) -> Result<(String, String), SourceReadFailure> {
    let meta = std::fs::metadata(path)
        .map_err(|e| classify_io(path, "读取文件信息", e))?;
    if !meta.is_file() {
        return Err(SourceReadFailure::new(
            "source_invalid",
            format!("不是普通文件: {}", path.display()),
        ));
    }
    if meta.len() as usize > MAX_DOCUMENT_BYTES {
        return Err(SourceReadFailure::new(
            "source_too_large",
            format!(
                "文件超过 {} MiB，未索引: {}",
                MAX_DOCUMENT_BYTES / 1024 / 1024,
                path.display()
            ),
        ));
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !supported_extension(&ext) {
        return Err(SourceReadFailure::new(
            "source_unsupported",
            format!(
                "暂不支持解析 .{ext} 文件；支持 Markdown/TXT/HTML/JSON/代码等纯文本格式，PDF/DOCX 请先转为文本"
            ),
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| classify_io(path, "读取文件", e))?;
    let text = if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&units).map_err(|_| {
            SourceReadFailure::new("source_unreadable", "UTF-16 LE 文件解码失败".to_string())
        })?
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&units).map_err(|_| {
            SourceReadFailure::new("source_unreadable", "UTF-16 BE 文件解码失败".to_string())
        })?
    } else {
        match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => {
                return Err(SourceReadFailure::new(
                    "source_unreadable",
                    "文件不是 UTF-8/UTF-16 文本，未索引（可先转为 UTF-8）",
                ))
            }
        }
    };
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(&text).to_string();
    let text = if matches!(ext.as_str(), "html" | "htm") {
        strip_html(&text)
    } else {
        text
    };
    Ok((cap_content(text), mime_for(&ext).to_string()))
}

fn read_text_file(path: &Path) -> AppResult<(String, String)> {
    read_text_file_detailed(path).map_err(|failure| AppError::Validation(failure.tagged()))
}

/// 按字节上限截断，保证字符边界。
fn cap_content(mut text: String) -> String {
    if text.len() <= MAX_DOCUMENT_BYTES {
        return text;
    }
    let mut end = MAX_DOCUMENT_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text
}

/// 按字符切块；返回 (起始字符偏移, 分块文本)。
fn chunk_text(content: &str) -> Vec<(usize, String)> {
    let chars: Vec<char> = content.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut start = 0usize;
    let step = CHUNK_CHARS.saturating_sub(CHUNK_OVERLAP).max(1);
    while start < chars.len() {
        let end = (start + CHUNK_CHARS).min(chars.len());
        let chunk: String = chars[start..end].iter().collect();
        out.push((start, chunk));
        if end == chars.len() {
            break;
        }
        start += step;
    }
    out
}

fn row_to_base(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeBase> {
    Ok(KnowledgeBase {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        kind: row.get(3)?,
        project_id: row.get(4)?,
        workspace_id: row.get(5)?,
        favorite: row.get::<_, i64>(6)? != 0,
        doc_count: row.get(7)?,
        indexed_count: row.get(8)?,
        failed_count: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

const BASE_COLUMNS: &str = "kb.id, kb.name, kb.description, kb.kind, kb.project_id, kb.workspace_id, \
    kb.favorite, \
    (SELECT COUNT(*) FROM knowledge_documents d WHERE d.kb_id = kb.id), \
    (SELECT COUNT(*) FROM knowledge_documents d WHERE d.kb_id = kb.id AND d.status = 'indexed'), \
    (SELECT COUNT(*) FROM knowledge_documents d WHERE d.kb_id = kb.id AND d.status = 'failed'), \
    kb.created_at, kb.updated_at";

fn row_to_doc(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeDocument> {
    Ok(KnowledgeDocument {
        id: row.get(0)?,
        kb_id: row.get(1)?,
        title: row.get(2)?,
        source_kind: row.get(3)?,
        source_mode: row.get(4)?,
        source_path: row.get(5)?,
        mime: row.get(6)?,
        size_bytes: row.get(7)?,
        content_hash: row.get(8)?,
        status: row.get(9)?,
        error: row.get(10)?,
        chunk_count: row.get(11)?,
        indexed_at: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

const DOC_COLUMNS: &str = "id, kb_id, title, source_kind, source_mode, source_path, mime, \
    size_bytes, content_hash, status, error, chunk_count, indexed_at, created_at, updated_at";

fn read_base(conn: &Connection, id: &str) -> AppResult<KnowledgeBase> {
    conn.query_row(
        &format!("SELECT {BASE_COLUMNS} FROM knowledge_bases kb WHERE kb.id = ?1"),
        [id],
        row_to_base,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("知识库不存在: {id}")))
}

fn read_doc(conn: &Connection, id: &str) -> AppResult<KnowledgeDocument> {
    conn.query_row(
        &format!("SELECT {DOC_COLUMNS} FROM knowledge_documents WHERE id = ?1"),
        [id],
        row_to_doc,
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("知识文档不存在: {id}")))
}

fn ensure_kb(conn: &Connection, kb_id: &str) -> AppResult<()> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM knowledge_bases WHERE id = ?1)",
            [kb_id],
            |r| r.get(0),
        )
        .map_err(AppError::from)?;
    if !exists {
        return Err(AppError::NotFound(format!("知识库不存在: {kb_id}")));
    }
    Ok(())
}

// ── 知识库 CRUD ────────────────────────────────────────────────────

pub fn list_bases_impl(db: &Db, query: Option<&str>, kind: Option<&str>) -> AppResult<Vec<KnowledgeBase>> {
    let q = query.map(str::trim).filter(|v| !v.is_empty());
    let kind = kind.map(str::trim).filter(|v| !v.is_empty());
    if let Some(k) = kind {
        normalize_kind(k)?;
    }
    db.with_read(|conn| {
        let sql = format!(
            "SELECT {BASE_COLUMNS} FROM knowledge_bases kb \
             WHERE (?1 IS NULL OR kb.name LIKE ?1 ESCAPE '\\' OR kb.description LIKE ?1 ESCAPE '\\') \
               AND (?2 IS NULL OR kb.kind = ?2) \
             ORDER BY kb.favorite DESC, kb.updated_at DESC, kb.id"
        );
        let pat = q.map(like_pattern);
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![pat, kind], row_to_base)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })
}

pub fn get_base_impl(db: &Db, id: &str) -> AppResult<KnowledgeBaseDetail> {
    db.with_read(|conn| {
        let base = read_base(conn, id)?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {DOC_COLUMNS} FROM knowledge_documents WHERE kb_id = ?1 \
             ORDER BY updated_at DESC, id LIMIT 20"
        ))?;
        let rows = stmt.query_map([id], row_to_doc)?;
        let docs = rows.collect::<Result<Vec<_>, _>>()?;
        Ok(KnowledgeBaseDetail {
            base,
            recent_documents: docs,
        })
    })
}

pub fn create_base_impl(db: &Db, input: KnowledgeBaseInput) -> AppResult<KnowledgeBase> {
    let name = check_text(&input.name, "知识库名称", 80)?;
    if input.description.chars().count() > 500 {
        return Err(AppError::Validation("知识库描述超过 500 字符".into()));
    }
    let kind = normalize_kind(&input.kind)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    db.with_conn(|conn| {
        let (project_id, workspace_id) =
            super::normalize_kb_binding(conn, kind, input.project_id.as_deref(), input.workspace_id.as_deref())?;
        conn.execute(
            "INSERT INTO knowledge_bases(id,name,description,kind,project_id,workspace_id,favorite,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,0,?7,?7)",
            params![id, name, input.description.trim(), kind, project_id, workspace_id, now],
        )?;
        read_base(conn, &id)
    })
}

pub fn update_base_impl(db: &Db, id: &str, input: KnowledgeBasePatch) -> AppResult<KnowledgeBase> {
    let name = check_text(&input.name, "知识库名称", 80)?;
    if input.description.chars().count() > 500 {
        return Err(AppError::Validation("知识库描述超过 500 字符".into()));
    }
    let kind = normalize_kind(&input.kind)?;
    let now = now_iso();
    db.with_conn(|conn| {
        ensure_kb(conn, id)?;
        let (project_id, workspace_id) =
            super::normalize_kb_binding(conn, kind, input.project_id.as_deref(), input.workspace_id.as_deref())?;
        conn.execute(
            "UPDATE knowledge_bases SET name=?2, description=?3, kind=?4, project_id=?5, \
             workspace_id=?6, updated_at=?7 WHERE id=?1",
            params![id, name, input.description.trim(), kind, project_id, workspace_id, now],
        )?;
        read_base(conn, id)
    })
}

pub fn set_favorite_impl(db: &Db, id: &str, favorite: bool) -> AppResult<KnowledgeBase> {
    db.with_conn(|conn| {
        ensure_kb(conn, id)?;
        conn.execute(
            "UPDATE knowledge_bases SET favorite=?2, updated_at=?3 WHERE id=?1",
            params![id, i64::from(favorite), now_iso()],
        )?;
        read_base(conn, id)
    })
}

/// 删除知识库：级联删除文档/分块/关联；导入模式的受管副本一并删除，原文件永不删除。
pub fn delete_base_impl(db: &Db, data_dir: &Path, id: &str) -> AppResult<DeleteKbReport> {
    let managed: Vec<String> = db.with_read(|conn| {
        ensure_kb(conn, id)?;
        let mut stmt = conn.prepare(
            "SELECT managed_rel_path FROM knowledge_documents \
             WHERE kb_id = ?1 AND managed_rel_path IS NOT NULL AND managed_rel_path <> ''",
        )?;
        let rows = stmt.query_map([id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;
    let deleted_docs = db.with_conn(|conn| {
        ensure_kb(conn, id)?;
        let n = conn.execute("DELETE FROM knowledge_bases WHERE id = ?1", [id])?;
        Ok::<_, AppError>(n)
    })?;
    let mut deleted_copies = 0usize;
    let root = knowledge_root(data_dir);
    for rel in managed {
        if let Some(path) = safe_managed_path(&root, &rel) {
            if std::fs::remove_file(&path).is_ok() {
                deleted_copies += 1;
            }
        }
    }
    let _ = std::fs::remove_dir(root.join(id));
    Ok(DeleteKbReport {
        deleted_docs,
        deleted_copies,
    })
}

fn safe_managed_path(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() || rel.split(['/', '\\']).any(|p| p == ".." || p.is_empty()) {
        return None;
    }
    let path = root.join(rel);
    // 词法上必须仍在受管根内（rel 由后端生成，此处是防御性检查）。
    if !path.starts_with(root) {
        return None;
    }
    Some(path)
}

// ── 文档列表与详情 ────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub fn list_documents_impl(
    db: &Db,
    kb_id: &str,
    query: Option<&str>,
    status: Option<&str>,
    source_kind: Option<&str>,
    offset: usize,
    limit: usize,
) -> AppResult<DocumentPage> {
    let limit = limit.clamp(1, 200);
    let q = query.map(str::trim).filter(|v| !v.is_empty());
    if let Some(s) = status.map(str::trim).filter(|v| !v.is_empty()) {
        if !matches!(s, "pending" | "indexed" | "failed") {
            return Err(AppError::Validation("文档状态筛选非法".into()));
        }
    }
    if let Some(k) = source_kind.map(str::trim).filter(|v| !v.is_empty()) {
        normalize_source_kind(k)?;
    }
    db.with_read(|conn| {
        ensure_kb(conn, kb_id)?;
        let pat = q.map(like_pattern);
        let status = status.map(str::trim).filter(|v| !v.is_empty());
        let source_kind = source_kind.map(str::trim).filter(|v| !v.is_empty());
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM knowledge_documents WHERE kb_id=?1 \
             AND (?2 IS NULL OR title LIKE ?2 ESCAPE '\\') \
             AND (?3 IS NULL OR status=?3) AND (?4 IS NULL OR source_kind=?4)",
            params![kb_id, pat, status, source_kind],
            |r| r.get(0),
        )?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {DOC_COLUMNS} FROM knowledge_documents WHERE kb_id=?1 \
             AND (?2 IS NULL OR title LIKE ?2 ESCAPE '\\') \
             AND (?3 IS NULL OR status=?3) AND (?4 IS NULL OR source_kind=?4) \
             ORDER BY updated_at DESC, id LIMIT ?5 OFFSET ?6"
        ))?;
        let rows = stmt.query_map(
            params![kb_id, pat, status, source_kind, limit as i64, offset as i64],
            row_to_doc,
        )?;
        let documents = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = offset.saturating_add(documents.len()) < total as usize;
        Ok(DocumentPage {
            documents,
            total,
            offset,
            limit,
            has_more,
        })
    })
}

pub fn get_document_impl(db: &Db, id: &str) -> AppResult<KnowledgeDocumentDetail> {
    db.with_read(|conn| {
        let (doc, content): (KnowledgeDocument, String) = conn
            .query_row(
                &format!("SELECT {DOC_COLUMNS}, content FROM knowledge_documents WHERE id=?1"),
                [id],
                |row| Ok((row_to_doc(row)?, row.get::<_, String>(15)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("知识文档不存在: {id}")))?;
        let links = read_links(conn, id)?;
        let truncated = content.len() > 1024 * 1024;
        let content = if truncated {
            cap_at_bytes(content, 1024 * 1024)
        } else {
            content
        };
        Ok(KnowledgeDocumentDetail {
            document: doc,
            content,
            truncated,
            links,
        })
    })
}

fn cap_at_bytes(mut text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text
}

// ── 导入 ───────────────────────────────────────────────────────────

fn count_docs(conn: &Connection, kb_id: &str) -> AppResult<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM knowledge_documents WHERE kb_id = ?1",
        [kb_id],
        |r| r.get(0),
    )
    .map_err(AppError::from)
}

/// 按内容哈希查重（同库）。
fn find_duplicate(conn: &Connection, kb_id: &str, hash: &str, exclude: Option<&str>) -> AppResult<Option<String>> {
    conn.query_row(
        "SELECT id FROM knowledge_documents WHERE kb_id=?1 AND content_hash=?2 \
         AND (?3 IS NULL OR id <> ?3) LIMIT 1",
        params![kb_id, hash, exclude],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(AppError::from)
}

/// 写文档并建立索引（调用方负责事务）。
#[allow(clippy::too_many_arguments)]
fn upsert_and_index(
    conn: &Connection,
    doc_id: &str,
    kb_id: &str,
    title: &str,
    source_kind: &str,
    source_mode: &str,
    source_path: Option<&str>,
    managed_rel: Option<&str>,
    mime: &str,
    content: &str,
    hash: &str,
    now: &str,
    existing: Option<&str>,
) -> AppResult<()> {
    let size = content.len() as i64;
    if let Some(id) = existing {
        conn.execute(
            "UPDATE knowledge_documents SET title=?2, source_kind=?3, source_mode=?4, source_path=?5, \
             managed_rel_path=?6, mime=?7, size_bytes=?8, content=?9, content_hash=?10, status='pending', \
             error='', updated_at=?11 WHERE id=?1",
            params![
                id, title, source_kind, source_mode, source_path, managed_rel, mime, size, content,
                hash, now
            ],
        )?;
    } else {
        conn.execute(
            "INSERT INTO knowledge_documents(id,kb_id,title,source_kind,source_mode,source_path,managed_rel_path,mime,size_bytes,content,content_hash,status,error,chunk_count,indexed_at,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'pending','',0,NULL,?12,?12)",
            params![
                doc_id, kb_id, title, source_kind, source_mode, source_path, managed_rel, mime, size,
                content, hash, now
            ],
        )?;
    }
    let id = existing.unwrap_or(doc_id);
    index_doc_conn(conn, id, now)?;
    conn.execute(
        "UPDATE knowledge_bases SET updated_at=?2 WHERE id=?1",
        params![kb_id, now],
    )?;
    Ok(())
}

/// 重建单个文档的分块索引。
fn index_doc_conn(conn: &Connection, doc_id: &str, now: &str) -> AppResult<()> {
    let (kb_id, content): (String, String) = conn
        .query_row(
            "SELECT kb_id, content FROM knowledge_documents WHERE id=?1",
            [doc_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("知识文档不存在: {doc_id}")))?;
    conn.execute("DELETE FROM knowledge_chunks WHERE doc_id=?1", [doc_id])?;
    let chunks = chunk_text(&content);
    for (ordinal, (offset, text)) in chunks.iter().enumerate() {
        conn.execute(
            "INSERT INTO knowledge_chunks(doc_id,kb_id,ordinal,start_offset,content) \
             VALUES (?1,?2,?3,?4,?5)",
            params![doc_id, kb_id, ordinal as i64, *offset as i64, text],
        )?;
    }
    conn.execute(
        "UPDATE knowledge_documents SET status='indexed', error='', chunk_count=?2, indexed_at=?3 \
         WHERE id=?1",
        params![doc_id, chunks.len() as i64, now],
    )?;
    Ok(())
}

/// 读笔记正文（只读，不修改笔记）。
fn read_note(conn: &Connection, note_id: &str) -> AppResult<(String, String)> {
    conn.query_row(
        "SELECT title, content FROM notes WHERE id=?1",
        [note_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("笔记不存在: {note_id}")))
}

/// 读收集箱条目正文（只读）。
fn read_capture(conn: &Connection, capture_id: &str) -> AppResult<(String, String)> {
    conn.query_row(
        "SELECT kind, content FROM quick_capture_items WHERE id=?1",
        [capture_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()?
    .ok_or_else(|| AppError::NotFound(format!("收集箱条目不存在: {capture_id}")))
}

/// 导入单个文件。返回 (report, imported document id)。
pub fn import_file_impl(
    db: &Db,
    data_dir: &Path,
    kb_id: &str,
    raw_path: &str,
    mode: &str,
    title: Option<&str>,
) -> AppResult<(ImportReport, Option<String>)> {
    let mode = normalize_mode(mode)?;
    let path = crate::file_workspace::validate_abs_path(raw_path)?;
    let mut report = ImportReport::new();
    let display = path.to_string_lossy().to_string();

    let (content, mime) = match read_text_file(&path) {
        Ok(v) => v,
        Err(e) => {
            report.push(&display, "failed", &e.to_string());
            return Ok((report, None));
        }
    };
    let hash = content_hash(content.as_bytes());
    let file_name = path
        .file_name()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_else(|| display.clone());
    let title = match title.map(str::trim).filter(|v| !v.is_empty()) {
        Some(t) => check_text(t, "文档标题", 200)?,
        None => truncate_chars(&file_name, 200),
    };

    let mut managed_rel = None;
    if mode == "imported" {
        let root = knowledge_root(data_dir);
        let dir = root.join(kb_id);
        std::fs::create_dir_all(&dir).map_err(|e| {
            AppError::Validation(format!("创建知识库目录失败: {}（{e}）", dir.display()))
        })?;
        let name = managed_file_name(&path);
        let target = dir.join(&name);
        std::fs::copy(&path, &target).map_err(|e| {
            AppError::Validation(format!("复制文件到知识库失败: {}（{e}）", target.display()))
        })?;
        managed_rel = Some(format!("{kb_id}/{name}"));
    }

    // 两种模式都记录来源路径：引用模式指向原文件，导入模式保留来源以便追溯。
    let source_path = Some(display.clone());

    let result = db.with_conn(|conn| {
        ensure_kb(conn, kb_id)?;
        if count_docs(conn, kb_id)? >= MAX_DOCUMENTS_PER_KB {
            return Err(AppError::Validation(format!(
                "知识库文档数已达上限 {MAX_DOCUMENTS_PER_KB}"
            )));
        }
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM knowledge_documents WHERE kb_id=?1 AND source_path=?2",
                params![kb_id, source_path],
                |r| r.get(0),
            )
            .optional()?;
        let duplicate = find_duplicate(conn, kb_id, &hash, existing.as_deref())?;
        if duplicate.is_some() {
            return Ok::<_, AppError>((None, true));
        }
        let doc_id = existing.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let now = now_iso();
        upsert_and_index(
            conn,
            &doc_id,
            kb_id,
            &title,
            "file",
            mode,
            source_path.as_deref(),
            managed_rel.as_deref(),
            &mime,
            &content,
            &hash,
            &now,
            existing.as_deref(),
        )?;
        Ok((Some(doc_id), false))
    });

    match result {
        Ok((Some(doc_id), false)) => {
            report.push(&display, "imported", "");
            let doc = db.with_read(|conn| read_doc(conn, &doc_id))?;
            report.documents.push(doc);
            Ok((report, Some(doc_id)))
        }
        Ok((_, true)) => {
            report.push(&display, "duplicate", "库内已存在相同内容");
            // 重复时删除刚复制的副本，避免孤儿文件。
            cleanup_managed(data_dir, managed_rel.as_deref());
            Ok((report, None))
        }
        Ok(_) => Ok((report, None)),
        Err(e) => {
            cleanup_managed(data_dir, managed_rel.as_deref());
            report.push(&display, "failed", &e.to_string());
            Ok((report, None))
        }
    }
}

fn cleanup_managed(data_dir: &Path, rel: Option<&str>) {
    let Some(rel) = rel else { return };
    if let Some(path) = safe_managed_path(&knowledge_root(data_dir), rel) {
        let _ = std::fs::remove_file(path);
    }
}

/// 递归收集受支持文本文件（有界；跳过隐藏项与符号链接）。
fn collect_files(dir: &Path, depth: usize, files: &mut Vec<PathBuf>, too_many: &mut bool) {
    if *too_many {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *too_many {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        if ft.is_dir() {
            if depth >= MAX_FOLDER_DEPTH {
                continue;
            }
            collect_files(&path, depth + 1, files, too_many);
        } else if ft.is_file() {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if supported_extension(&ext) {
                files.push(path);
                if files.len() >= MAX_FOLDER_FILES {
                    *too_many = true;
                    return;
                }
            }
        }
    }
}

/// 文件夹导入（递归、有界）。符号链接与隐藏项跳过。
pub fn import_folder_impl(
    db: &Db,
    data_dir: &Path,
    kb_id: &str,
    raw_path: &str,
    mode: &str,
) -> AppResult<ImportReport> {
    let mode = normalize_mode(mode)?;
    let root = crate::file_workspace::validate_dir(&crate::file_workspace::validate_abs_path(raw_path)?)?;
    let mut files: Vec<PathBuf> = Vec::new();
    let mut too_many = false;
    collect_files(&root, 0, &mut files, &mut too_many);

    let mut report = ImportReport::new();
    let mut total_bytes = 0usize;
    for path in files {
        let size = std::fs::metadata(&path).map(|m| m.len() as usize).unwrap_or(0);
        if total_bytes.saturating_add(size) > MAX_FOLDER_BYTES {
            report.push(
                &path.to_string_lossy(),
                "skipped",
                &format!("超过文件夹导入总量上限 {} MiB", MAX_FOLDER_BYTES / 1024 / 1024),
            );
            continue;
        }
        total_bytes = total_bytes.saturating_add(size);
        let (mut item_report, _) =
            import_file_impl(db, data_dir, kb_id, &path.to_string_lossy(), mode, None)?;
        report.imported += item_report.imported;
        report.skipped += item_report.skipped;
        report.duplicates += item_report.duplicates;
        report.failed += item_report.failed;
        report.documents.append(&mut item_report.documents);
        for item in item_report.items {
            if report.items.len() < MAX_REPORT_ITEMS {
                report.items.push(item);
            }
        }
    }
    if too_many {
        report.push(
            &root.to_string_lossy(),
            "skipped",
            &format!("文件数超过上限 {MAX_FOLDER_FILES}，只处理了前 {MAX_FOLDER_FILES} 个"),
        );
    }
    Ok(report)
}

pub fn import_note_impl(db: &Db, kb_id: &str, note_id: &str) -> AppResult<(ImportReport, Option<String>)> {
    let mut report = ImportReport::new();
    let (title, content) = db.with_read(|conn| read_note(conn, note_id))?;
    if content.trim().is_empty() {
        report.push(note_id, "skipped", "笔记正文为空");
        return Ok((report, None));
    }
    let hash = content_hash(content.as_bytes());
    let doc_id = db.with_conn(|conn| {
        ensure_kb(conn, kb_id)?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM knowledge_documents WHERE kb_id=?1 AND source_kind='note' AND source_path=?2",
                params![kb_id, note_id],
                |r| r.get(0),
            )
            .optional()?;
        if find_duplicate(conn, kb_id, &hash, existing.as_deref())?.is_some() {
            return Ok::<_, AppError>(None);
        }
        let id = existing.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let now = now_iso();
        let title = if title.trim().is_empty() {
            format!("笔记 {note_id}")
        } else {
            truncate_chars(title.trim(), 200)
        };
        upsert_and_index(
            conn,
            &id,
            kb_id,
            &title,
            "note",
            "reference",
            Some(note_id),
            None,
            "text/markdown",
            &content,
            &hash,
            &now,
            existing.as_deref(),
        )?;
        Ok(Some(id))
    })?;
    match doc_id {
        Some(id) => {
            report.push(note_id, "imported", "");
            let doc = db.with_read(|conn| read_doc(conn, &id))?;
            report.documents.push(doc);
            Ok((report, Some(id)))
        }
        None => {
            report.push(note_id, "duplicate", "库内已存在相同内容");
            Ok((report, None))
        }
    }
}

pub fn import_capture_impl(
    db: &Db,
    kb_id: &str,
    capture_id: &str,
) -> AppResult<(ImportReport, Option<String>)> {
    let mut report = ImportReport::new();
    let (kind, content) = db.with_read(|conn| read_capture(conn, capture_id))?;
    if content.trim().is_empty() {
        report.push(capture_id, "skipped", "收集箱条目正文为空");
        return Ok((report, None));
    }
    let hash = content_hash(content.as_bytes());
    let doc_id = db.with_conn(|conn| {
        ensure_kb(conn, kb_id)?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM knowledge_documents WHERE kb_id=?1 AND source_kind='capture' AND source_path=?2",
                params![kb_id, capture_id],
                |r| r.get(0),
            )
            .optional()?;
        if find_duplicate(conn, kb_id, &hash, existing.as_deref())?.is_some() {
            return Ok::<_, AppError>(None);
        }
        let id = existing.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let now = now_iso();
        let title = truncate_chars(&format!("收集箱 {kind}: {}", content.lines().next().unwrap_or("")), 200);
        upsert_and_index(
            conn,
            &id,
            kb_id,
            &title,
            "capture",
            "reference",
            Some(capture_id),
            None,
            "text/plain",
            &content,
            &hash,
            &now,
            existing.as_deref(),
        )?;
        Ok(Some(id))
    })?;
    match doc_id {
        Some(id) => {
            report.push(capture_id, "imported", "");
            let doc = db.with_read(|conn| read_doc(conn, &id))?;
            report.documents.push(doc);
            Ok((report, Some(id)))
        }
        None => {
            report.push(capture_id, "duplicate", "库内已存在相同内容");
            Ok((report, None))
        }
    }
}

pub fn create_text_impl(
    db: &Db,
    kb_id: &str,
    title: &str,
    content: &str,
) -> AppResult<(ImportReport, Option<String>)> {
    let title = check_text(title, "文档标题", 200)?;
    let content = cap_content(content.trim().to_string());
    if content.is_empty() {
        return Err(AppError::Validation("正文不能为空".into()));
    }
    let hash = content_hash(content.as_bytes());
    let doc_id = db.with_conn(|conn| {
        ensure_kb(conn, kb_id)?;
        if find_duplicate(conn, kb_id, &hash, None)?.is_some() {
            return Ok::<_, AppError>(None);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_iso();
        upsert_and_index(
            conn,
            &id,
            kb_id,
            &title,
            "text",
            "imported",
            None,
            None,
            "text/markdown",
            &content,
            &hash,
            &now,
            None,
        )?;
        Ok(Some(id))
    })?;
    let mut report = ImportReport::new();
    match doc_id {
        Some(id) => {
            report.push(&title, "imported", "");
            let doc = db.with_read(|conn| read_doc(conn, &id))?;
            report.documents.push(doc);
            Ok((report, Some(id)))
        }
        None => {
            report.push(&title, "duplicate", "库内已存在相同内容");
            Ok((report, None))
        }
    }
}

/// 单文档的来源元数据（重新索引前读取）。
struct DocSourceMeta {
    source_kind: String,
    source_mode: String,
    source_path: Option<String>,
    managed_rel_path: Option<String>,
}

/// 标记来源失败：状态改为 failed、清空旧分块，避免继续用过期内容命中。
fn mark_source_failed(conn: &Connection, id: &str, message: &str, now: &str) -> AppResult<()> {
    conn.execute("DELETE FROM knowledge_chunks WHERE doc_id=?1", [id])?;
    conn.execute(
        "UPDATE knowledge_documents SET status='failed', error=?2, chunk_count=0, \
         indexed_at=NULL, updated_at=?3 WHERE id=?1",
        params![id, message, now],
    )?;
    Ok(())
}

/// 重新从真实来源读取正文并建立索引。
///
/// - `reference`：重新读取 `source_path`（原文件），而不是数据库快照；
/// - `imported`：重新读取受管副本 `managed_rel_path`；
/// - `note` / `capture` / `text`：没有可重读的外部文件，继续使用数据库正文。
///
/// 读取失败时写入 `[source_missing|source_unreadable|...]` 诊断并返回错误，
/// 不会静默保留旧的 `indexed` 状态。
fn refresh_document_conn(
    conn: &Connection,
    data_dir: &Path,
    id: &str,
    now: &str,
) -> AppResult<()> {
    let meta: DocSourceMeta = conn
        .query_row(
            "SELECT source_kind, source_mode, source_path, managed_rel_path \
             FROM knowledge_documents WHERE id=?1",
            [id],
            |r| {
                Ok(DocSourceMeta {
                    source_kind: r.get(0)?,
                    source_mode: r.get(1)?,
                    source_path: r.get(2)?,
                    managed_rel_path: r.get(3)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("知识文档不存在: {id}")))?;

    if meta.source_kind == "file" {
        let (path, label) = match meta.source_mode.as_str() {
            "reference" => {
                let raw = meta
                    .source_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| {
                        AppError::Validation("[source_missing] 引用模式缺少原始文件路径".into())
                    })?;
                (PathBuf::from(raw), "原始文件")
            }
            "imported" => {
                let rel = meta
                    .managed_rel_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| {
                        AppError::Validation("[source_missing] 导入模式缺少受管副本路径".into())
                    })?;
                match safe_managed_path(&knowledge_root(data_dir), rel) {
                    Some(path) => (path, "受管副本"),
                    None => {
                        return Err(AppError::Validation(
                            "[source_unreadable] 受管副本路径非法".into(),
                        ))
                    }
                }
            }
            other => {
                return Err(AppError::Validation(format!(
                    "[source_unreadable] 未知存储模式: {other}"
                )))
            }
        };

        match read_text_file_detailed(&path) {
            Ok((content, mime)) => {
                let hash = content_hash(content.as_bytes());
                let size = content.len() as i64;
                conn.execute(
                    "UPDATE knowledge_documents SET content=?2, mime=?3, size_bytes=?4, \
                     content_hash=?5, status='pending', error='', updated_at=?6 WHERE id=?1",
                    params![id, content, mime, size, hash, now],
                )?;
                index_doc_conn(conn, id, now)?;
            }
            Err(failure) => {
                let message = format!("[{label}] {}", failure.tagged());
                mark_source_failed(conn, id, &message, now)?;
                return Err(AppError::Validation(message));
            }
        }
        return Ok(());
    }

    // 笔记 / 收集箱 / 纯文本：数据库正文就是唯一来源，重新分块即可。
    index_doc_conn(conn, id, now)
}

pub fn reindex_document_impl(db: &Db, data_dir: &Path, id: &str) -> AppResult<KnowledgeDocument> {
    db.with_conn(|conn| {
        read_doc(conn, id)?;
        refresh_document_conn(conn, data_dir, id, &now_iso())?;
        read_doc(conn, id)
    })
}

pub fn rebuild_kb_impl(db: &Db, data_dir: &Path, kb_id: &str) -> AppResult<RebuildReport> {
    let ids: Vec<String> = db.with_read(|conn| {
        ensure_kb(conn, kb_id)?;
        let mut stmt = conn.prepare("SELECT id FROM knowledge_documents WHERE kb_id=?1")?;
        let rows = stmt.query_map([kb_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;
    let mut report = RebuildReport {
        indexed: 0,
        failed: 0,
        skipped: 0,
    };
    for id in ids {
        match db.with_conn(|conn| refresh_document_conn(conn, data_dir, &id, &now_iso())) {
            Ok(()) => report.indexed += 1,
            Err(_) => report.failed += 1,
        }
    }
    Ok(report)
}

/// 删除文档：引用模式只删记录；导入模式同时删除受管副本；原文件永不删除。
pub fn delete_document_impl(db: &Db, data_dir: &Path, id: &str) -> AppResult<DeleteDocReport> {
    let (managed, source_mode): (Option<String>, String) = db.with_read(|conn| {
        let doc = read_doc(conn, id)?;
        let managed: Option<String> = conn
            .query_row(
                "SELECT managed_rel_path FROM knowledge_documents WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        Ok((managed, doc.source_mode))
    })?;
    db.with_conn(|conn| {
        let n = conn.execute("DELETE FROM knowledge_documents WHERE id=?1", [id])?;
        if n == 0 {
            return Err(AppError::NotFound(format!("知识文档不存在: {id}")));
        }
        Ok::<_, AppError>(())
    })?;
    let mut deleted_copy = false;
    if source_mode == "imported" {
        if let Some(rel) = managed {
            if let Some(path) = safe_managed_path(&knowledge_root(data_dir), &rel) {
                if std::fs::remove_file(path).is_ok() {
                    deleted_copy = true;
                }
            }
        }
    }
    Ok(DeleteDocReport { deleted_copy })
}

// ── 检索 ───────────────────────────────────────────────────────────

fn snippet_of(content: &str, query: &str) -> String {
    let lower = content.to_lowercase();
    let q = query.to_lowercase();
    let mut byte_pos = lower.find(&q).unwrap_or(0).min(content.len());
    while byte_pos > 0 && !content.is_char_boundary(byte_pos) {
        byte_pos -= 1;
    }
    let char_pos = content[..byte_pos].chars().count();
    let chars: Vec<char> = content.chars().collect();
    let start = char_pos.saturating_sub(80);
    let end = (char_pos + query.chars().count() + 140).min(chars.len());
    let mut text: String = chars[start..end].iter().collect();
    if start > 0 {
        text.insert(0, '…');
    }
    if end < chars.len() {
        text.push('…');
    }
    text.replace('\n', " ")
}

#[allow(clippy::too_many_arguments)]
pub fn search_impl(
    db: &Db,
    query: &str,
    kb_ids: &[String],
    source_kind: Option<&str>,
    project_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<KnowledgeSearchPage> {
    db.with_read(|conn| {
        search_in_conn(conn, query, kb_ids, source_kind, project_id, limit, offset)
    })
}

/// 在已持有的连接内检索（供上下文装配等同一只读事务复用，避免嵌套取连接）。
pub fn search_in_conn(
    conn: &Connection,
    query: &str,
    kb_ids: &[String],
    source_kind: Option<&str>,
    project_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<KnowledgeSearchPage> {
    let q = query.trim();
    if q.is_empty() {
        return Err(AppError::Validation("搜索关键词不能为空".into()));
    }
    let q = truncate_chars(q, 100);
    if let Some(k) = source_kind.map(str::trim).filter(|v| !v.is_empty()) {
        normalize_source_kind(k)?;
    }
    let project = project_id.map(str::trim).filter(|v| !v.is_empty());
    let limit = limit.clamp(1, MAX_SEARCH_LIMIT) as usize;
    let offset = offset.min(10_000) as usize;
    let pat = like_pattern(&q);
    let prefix = format!("{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));

    let mut kb_filter = String::new();
    if !kb_ids.is_empty() {
        // 显式编号必须接在 ?1..?7 之后：匿名 ? 会与后面的 ?6/?7 复用编号，
        // 造成参数个数与绑定值不一致（SQLite InvalidParameterCount）。
        let placeholders = (8..8 + kb_ids.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(",");
        kb_filter = format!(" AND d.kb_id IN ({placeholders})");
    }

    {
        let sql = format!(
            "SELECT c.doc_id, c.kb_id, kb.name, d.title, d.source_kind, d.source_path, c.content, \
                    c.start_offset, d.status, d.updated_at, \
                    CASE WHEN d.title = ?1 THEN 0 WHEN d.title LIKE ?2 ESCAPE '\\' THEN 1 \
                         WHEN d.title LIKE ?3 ESCAPE '\\' THEN 2 ELSE 3 END AS rank \
             FROM knowledge_chunks c \
             JOIN knowledge_documents d ON d.id = c.doc_id \
             JOIN knowledge_bases kb ON kb.id = d.kb_id \
             WHERE d.status = 'indexed' \
               AND (?4 IS NULL OR d.source_kind = ?4) \
               AND (?5 IS NULL OR kb.project_id = ?5 OR kb.workspace_id = ?5 OR EXISTS( \
                     SELECT 1 FROM knowledge_links l WHERE l.doc_id = d.id \
                     AND l.target_kind = 'project' AND l.target_id = ?5)) \
               AND (c.content LIKE ?3 ESCAPE '\\' OR d.title LIKE ?3 ESCAPE '\\'){kb_filter} \
             ORDER BY rank, d.updated_at DESC, c.ordinal \
             LIMIT ?6 OFFSET ?7"
        );
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![
            Box::new(q.clone()),
            Box::new(prefix.clone()),
            Box::new(pat.clone()),
            Box::new(source_kind.map(str::to_string)),
            Box::new(project.map(str::to_string)),
            Box::new((limit * 4) as i64),
            Box::new(offset as i64),
        ];
        for id in kb_ids {
            values.push(Box::new(id.clone()));
        }
        let refs: Vec<&dyn rusqlite::ToSql> = values.iter().map(|v| v.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(refs.as_slice(), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, String>(9)?,
                r.get::<_, i64>(10)?,
            ))
        })?;
        let mut hits: Vec<KnowledgeSearchHit> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for row in rows {
            let (doc_id, kb_id, kb_name, title, source_kind, source_path, chunk, offset_chars, status, updated_at, rank) = row?;
            if !seen.insert(doc_id.clone()) {
                continue;
            }
            hits.push(KnowledgeSearchHit {
                doc_id,
                kb_id,
                kb_name,
                title: title.clone(),
                source_kind,
                source_path,
                snippet: snippet_of(&chunk, &q),
                chunk_offset: offset_chars,
                rank: rank.clamp(0, 3) as u8,
                status,
                updated_at,
            });
            if hits.len() >= limit {
                break;
            }
        }
        // 同一过滤条件下的文档总数（去重）。
        let mut count_sql = String::from(
            "SELECT COUNT(DISTINCT d.id) FROM knowledge_chunks c \
             JOIN knowledge_documents d ON d.id = c.doc_id \
             JOIN knowledge_bases kb ON kb.id = d.kb_id \
             WHERE d.status='indexed' \
               AND (?1 IS NULL OR d.source_kind = ?1) \
               AND (?2 IS NULL OR kb.project_id = ?2 OR kb.workspace_id = ?2 OR EXISTS( \
                     SELECT 1 FROM knowledge_links l WHERE l.doc_id = d.id \
                     AND l.target_kind = 'project' AND l.target_id = ?2)) \
               AND (c.content LIKE ?3 ESCAPE '\\' OR d.title LIKE ?3 ESCAPE '\\')",
        );
        if !kb_ids.is_empty() {
            count_sql.push_str(&format!(
                " AND d.kb_id IN ({})",
                vec!["?"; kb_ids.len()].join(",")
            ));
        }
        let mut count_values: Vec<Box<dyn rusqlite::ToSql>> = vec![
            Box::new(source_kind.map(str::to_string)),
            Box::new(project.map(str::to_string)),
            Box::new(pat.clone()),
        ];
        for id in kb_ids {
            count_values.push(Box::new(id.clone()));
        }
        let count_refs: Vec<&dyn rusqlite::ToSql> =
            count_values.iter().map(|v| v.as_ref()).collect();
        let total: i64 = conn.query_row(&count_sql, count_refs.as_slice(), |r| r.get(0))?;
        Ok(KnowledgeSearchPage {
            query: q.clone(),
            total,
            has_more: offset.saturating_add(hits.len()) < total as usize,
            hits,
            limit,
            offset,
        })
    }
}

// ── 关联 ───────────────────────────────────────────────────────────

fn read_links(conn: &Connection, doc_id: &str) -> AppResult<Vec<KnowledgeLink>> {
    let mut stmt = conn.prepare(
        "SELECT id, doc_id, target_kind, target_id, label, created_at FROM knowledge_links \
         WHERE doc_id=?1 ORDER BY created_at, id",
    )?;
    let rows = stmt.query_map([doc_id], |r| {
        Ok(KnowledgeLink {
            id: r.get(0)?,
            doc_id: r.get(1)?,
            target_kind: r.get(2)?,
            target_id: r.get(3)?,
            label: r.get(4)?,
            created_at: r.get(5)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn target_exists(conn: &Connection, kind: &str, id: &str) -> AppResult<bool> {
    let sql = match kind {
        "task" => "SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1)",
        "project" => "SELECT EXISTS(SELECT 1 FROM workspace_projects WHERE id=?1)",
        "note" => "SELECT EXISTS(SELECT 1 FROM notes WHERE id=?1)",
        "agent_session" => "SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE id=?1)",
        "workflow" => "SELECT EXISTS(SELECT 1 FROM workflows WHERE id=?1)",
        "file" => {
            let path = crate::file_workspace::validate_abs_path(id)?;
            return Ok(path.exists());
        }
        _ => {
            return Err(AppError::Validation(format!(
                "关联目标类型非法: {kind}"
            )))
        }
    };
    conn.query_row(sql, [id], |r| r.get(0))
        .map_err(AppError::from)
}

pub fn add_link_impl(
    db: &Db,
    doc_id: &str,
    target_kind: &str,
    target_id: &str,
    label: &str,
) -> AppResult<Vec<KnowledgeLink>> {
    let target_id = target_id.trim();
    if target_id.is_empty() || target_id.chars().count() > 4096 {
        return Err(AppError::Validation("关联目标标识非法".into()));
    }
    if label.chars().count() > 120 || label.chars().any(char::is_control) {
        return Err(AppError::Validation("关联标签超过 120 字符或含控制字符".into()));
    }
    db.with_conn(|conn| {
        read_doc(conn, doc_id)?;
        if !target_exists(conn, target_kind, target_id)? {
            return Err(AppError::NotFound(format!(
                "关联目标不存在: {target_kind}/{target_id}"
            )));
        }
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT OR IGNORE INTO knowledge_links(id,doc_id,target_kind,target_id,label,created_at) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![id, doc_id, target_kind, target_id, label.trim(), now_iso()],
        )?;
        read_links(conn, doc_id)
    })
}

pub fn remove_link_impl(db: &Db, doc_id: &str, link_id: &str) -> AppResult<Vec<KnowledgeLink>> {
    db.with_conn(|conn| {
        read_doc(conn, doc_id)?;
        let n = conn.execute("DELETE FROM knowledge_links WHERE id=?1 AND doc_id=?2", params![link_id, doc_id])?;
        if n == 0 {
            return Err(AppError::NotFound("知识关联不存在".into()));
        }
        read_links(conn, doc_id)
    })
}

pub fn list_links_impl(db: &Db, doc_id: &str) -> AppResult<Vec<KnowledgeLink>> {
    db.with_read(|conn| {
        read_doc(conn, doc_id)?;
        read_links(conn, doc_id)
    })
}

pub fn backlinks_impl(db: &Db, target_kind: &str, target_id: &str) -> AppResult<Vec<KnowledgeBacklink>> {
    db.with_read(|conn| {
        let mut stmt = conn.prepare(
            "SELECT l.id, d.id, d.title, d.kb_id, kb.name, l.target_kind, l.target_id \
             FROM knowledge_links l JOIN knowledge_documents d ON d.id = l.doc_id \
             JOIN knowledge_bases kb ON kb.id = d.kb_id \
             WHERE l.target_kind=?1 AND l.target_id=?2 ORDER BY d.updated_at DESC",
        )?;
        let rows = stmt.query_map(params![target_kind, target_id], |r| {
            Ok(KnowledgeBacklink {
                link_id: r.get(0)?,
                doc_id: r.get(1)?,
                title: r.get(2)?,
                kb_id: r.get(3)?,
                kb_name: r.get(4)?,
                target_kind: r.get(5)?,
                target_id: r.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })
}

pub fn stats_impl(db: &Db) -> AppResult<KnowledgeStats> {
    db.with_read(|conn| {
        Ok(KnowledgeStats {
            kb_count: conn.query_row("SELECT COUNT(*) FROM knowledge_bases", [], |r| r.get(0))?,
            doc_count: conn.query_row("SELECT COUNT(*) FROM knowledge_documents", [], |r| r.get(0))?,
            indexed_count: conn.query_row(
                "SELECT COUNT(*) FROM knowledge_documents WHERE status='indexed'",
                [],
                |r| r.get(0),
            )?,
            failed_count: conn.query_row(
                "SELECT COUNT(*) FROM knowledge_documents WHERE status='failed'",
                [],
                |r| r.get(0),
            )?,
            chunk_count: conn.query_row("SELECT COUNT(*) FROM knowledge_chunks", [], |r| r.get(0))?,
        })
    })
}

/// MCP 工具复用：按知识库授权范围检索。`allowed: None` 表示全局授权。
pub fn search_for_agent(
    db: &Db,
    query: &str,
    allowed_kb_ids: Option<&[String]>,
    limit: u32,
) -> AppResult<KnowledgeSearchPage> {
    let ids = allowed_kb_ids.unwrap_or(&[]);
    if allowed_kb_ids.is_some() && ids.is_empty() {
        return Err(AppError::Validation("没有可访问的知识库".into()));
    }
    search_impl(db, query, ids, None, None, limit, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("td-cap-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn kb(db: &Db, name: &str) -> String {
        create_base_impl(
            db,
            KnowledgeBaseInput {
                name: name.into(),
                description: String::new(),
                kind: "personal".into(),
                project_id: None,
                workspace_id: None,
            },
        )
        .unwrap()
        .id
    }

    #[test]
    fn reference_import_search_and_delete_never_touches_original() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("ref");
        let file = data.join("note.md");
        std::fs::write(&file, "# 人物\n林深在雨夜抵达旧城。").unwrap();
        let kb_id = kb(&db, "小说资料");
        let (report, doc_id) = import_file_impl(
            &db,
            &data,
            &kb_id,
            file.to_str().unwrap(),
            "reference",
            None,
        )
        .unwrap();
        assert_eq!(report.imported, 1);
        let doc_id = doc_id.unwrap();
        let page = search_impl(&db, "雨夜", &[], None, None, 10, 0).unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.hits[0].doc_id, doc_id);
        assert!(page.hits[0].snippet.contains("雨夜"));
        delete_document_impl(&db, &data, &doc_id).unwrap();
        assert!(file.exists(), "引用模式删除不得删除原文件");
        assert_eq!(stats_impl(&db).unwrap().doc_count, 0);
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn imported_copy_is_removed_but_original_kept() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("copy");
        let file = data.join("doc.txt");
        std::fs::write(&file, "任务拆解与验收标准").unwrap();
        let kb_id = kb(&db, "项目资料");
        let (_, doc_id) = import_file_impl(
            &db,
            &data,
            &kb_id,
            file.to_str().unwrap(),
            "imported",
            None,
        )
        .unwrap();
        let doc_id = doc_id.unwrap();
        let managed: String = db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT managed_rel_path FROM knowledge_documents WHERE id=?1",
                    [&doc_id],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        let managed_path = knowledge_root(&data).join(managed);
        assert!(managed_path.exists());
        let report = delete_document_impl(&db, &data, &doc_id).unwrap();
        assert!(report.deleted_copy);
        assert!(file.exists());
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn duplicate_content_is_not_inserted_twice() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("dup");
        let a = data.join("a.txt");
        let b = data.join("b.txt");
        std::fs::write(&a, "相同内容").unwrap();
        std::fs::write(&b, "相同内容").unwrap();
        let kb_id = kb(&db, "资料");
        let (first, _) = import_file_impl(&db, &data, &kb_id, a.to_str().unwrap(), "reference", None).unwrap();
        assert_eq!(first.imported, 1);
        let (second, _) = import_file_impl(&db, &data, &kb_id, b.to_str().unwrap(), "reference", None).unwrap();
        assert_eq!(second.duplicates, 1);
        assert_eq!(stats_impl(&db).unwrap().doc_count, 1);
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn unsupported_format_is_rejected_without_fake_success() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("pdf");
        let pdf = data.join("manual.pdf");
        std::fs::write(&pdf, b"%PDF-1.4").unwrap();
        let kb_id = kb(&db, "资料");
        let (report, doc_id) =
            import_file_impl(&db, &data, &kb_id, pdf.to_str().unwrap(), "reference", None).unwrap();
        assert_eq!(report.failed, 1);
        assert!(doc_id.is_none());
        assert_eq!(stats_impl(&db).unwrap().doc_count, 0);
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn folder_import_skips_binary_and_counts_supported() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("folder");
        std::fs::write(data.join("a.md"), "第一章").unwrap();
        std::fs::write(data.join("b.txt"), "第二章").unwrap();
        std::fs::write(data.join("c.bin"), b"\x00\x01").unwrap();
        let kb_id = kb(&db, "资料");
        let report =
            import_folder_impl(&db, &data, &kb_id, data.to_str().unwrap(), "reference").unwrap();
        assert_eq!(report.imported, 2);
        assert_eq!(stats_impl(&db).unwrap().doc_count, 2);
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn note_import_reads_note_without_modifying_it() {
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO notes(id,title,content,created_at,updated_at) VALUES('n1','设定','旧城在北方',?1,?1)",
                [&now],
            )?;
            Ok(())
        })
        .unwrap();
        let kb_id = kb(&db, "小说");
        let (report, _) = import_note_impl(&db, &kb_id, "n1").unwrap();
        assert_eq!(report.imported, 1);
        let content: String = db
            .with_read(|conn| Ok(conn.query_row("SELECT content FROM notes WHERE id='n1'", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(content, "旧城在北方");
    }

    #[test]
    fn links_require_existing_targets_and_are_bidirectional() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("links");
        let file = data.join("x.md");
        std::fs::write(&file, "关联测试").unwrap();
        let kb_id = kb(&db, "资料");
        let (_, doc_id) = import_file_impl(&db, &data, &kb_id, file.to_str().unwrap(), "reference", None).unwrap();
        let doc_id = doc_id.unwrap();
        assert!(add_link_impl(&db, &doc_id, "task", "missing", "").is_err());
        let now = now_iso();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tasks(id,title,description,priority,status,category,tags,advance_minutes,created_at,updated_at) \
                 VALUES('t1','任务','',2,'pending','','[]',0,?1,?1)",
                [&now],
            )?;
            Ok(())
        })
        .unwrap();
        let links = add_link_impl(&db, &doc_id, "task", "t1", "关联任务").unwrap();
        assert_eq!(links.len(), 1);
        let back = backlinks_impl(&db, "task", "t1").unwrap();
        assert_eq!(back[0].doc_id, doc_id);
        let remaining = remove_link_impl(&db, &doc_id, &links[0].id).unwrap();
        assert!(remaining.is_empty());
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn search_filters_by_kb_and_project() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("filter");
        let f1 = data.join("a.md");
        let f2 = data.join("b.md");
        std::fs::write(&f1, "Alpha 项目约定").unwrap();
        std::fs::write(&f2, "Beta 项目约定").unwrap();
        let now = now_iso();
        let project_id = db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO workspace_projects(id,name,kind,root_path,dev_project_id,note,status,created_at,updated_at) \
                     VALUES('p1','项目','general','',NULL,'','active',?1,?1)",
                    [&now],
                )?;
                Ok::<_, AppError>("p1".to_string())
            })
            .unwrap();
        let k1 = create_base_impl(
            &db,
            KnowledgeBaseInput {
                name: "A".into(),
                description: String::new(),
                kind: "project".into(),
                project_id: Some(project_id.clone()),
                workspace_id: None,
            },
        )
        .unwrap()
        .id;
        let k2 = kb(&db, "B");
        import_file_impl(&db, &data, &k1, f1.to_str().unwrap(), "reference", None).unwrap();
        import_file_impl(&db, &data, &k2, f2.to_str().unwrap(), "reference", None).unwrap();
        let by_kb = search_impl(&db, "约定", &[k1.clone()], None, None, 10, 0).unwrap();
        assert_eq!(by_kb.total, 1);
        assert_eq!(by_kb.hits[0].kb_id, k1);
        let by_project = search_impl(&db, "约定", &[], None, Some("p1"), 10, 0).unwrap();
        assert_eq!(by_project.total, 1);
        assert_eq!(by_project.hits[0].title, "a.md");
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn reference_reindex_reads_latest_source() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("reindex-ref");
        let file = data.join("a.md");
        std::fs::write(&file, "Alpha").unwrap();
        let kb_id = kb(&db, "资料");
        let (_, doc_id) = import_file_impl(
            &db,
            &data,
            &kb_id,
            file.to_str().unwrap(),
            "reference",
            None,
        )
        .unwrap();
        let doc_id = doc_id.unwrap();
        assert_eq!(search_impl(&db, "Alpha", &[], None, None, 10, 0).unwrap().total, 1);

        std::fs::write(&file, "Beta").unwrap();
        let doc = reindex_document_impl(&db, &data, &doc_id).unwrap();
        assert_eq!(doc.status, "indexed");
        assert_eq!(search_impl(&db, "Beta", &[], None, None, 10, 0).unwrap().total, 1);
        assert_eq!(
            search_impl(&db, "Alpha", &[], None, None, 10, 0).unwrap().total,
            0,
            "重新索引后旧内容不应继续命中"
        );

        delete_document_impl(&db, &data, &doc_id).unwrap();
        assert!(file.exists(), "删除知识文档不得删除原文件");
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn rebuild_kb_reads_reference_sources() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("rebuild-ref");
        let a = data.join("a.md");
        let b = data.join("b.md");
        std::fs::write(&a, "FirstAlpha").unwrap();
        std::fs::write(&b, "FirstBeta").unwrap();
        let kb_id = kb(&db, "资料");
        import_file_impl(&db, &data, &kb_id, a.to_str().unwrap(), "reference", None).unwrap();
        import_file_impl(&db, &data, &kb_id, b.to_str().unwrap(), "reference", None).unwrap();
        std::fs::write(&a, "SecondGamma").unwrap();
        std::fs::write(&b, "SecondDelta").unwrap();

        let report = rebuild_kb_impl(&db, &data, &kb_id).unwrap();
        assert_eq!(report.indexed, 2);
        assert_eq!(report.failed, 0);
        assert_eq!(search_impl(&db, "Gamma", &[], None, None, 10, 0).unwrap().total, 1);
        assert_eq!(search_impl(&db, "Delta", &[], None, None, 10, 0).unwrap().total, 1);
        assert_eq!(
            search_impl(&db, "FirstAlpha", &[], None, None, 10, 0).unwrap().total,
            0
        );
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn reference_reindex_marks_missing_source_as_failed() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("reindex-missing");
        let file = data.join("gone.md");
        std::fs::write(&file, "BeforeDelete").unwrap();
        let kb_id = kb(&db, "资料");
        let (_, doc_id) = import_file_impl(
            &db,
            &data,
            &kb_id,
            file.to_str().unwrap(),
            "reference",
            None,
        )
        .unwrap();
        let doc_id = doc_id.unwrap();
        std::fs::remove_file(&file).unwrap();

        let error = reindex_document_impl(&db, &data, &doc_id).unwrap_err();
        assert!(error.to_string().contains("source_missing"), "{error}");
        let doc = get_document_impl(&db, &doc_id).unwrap();
        assert_eq!(doc.document.status, "failed");
        assert!(doc.document.error.contains("source_missing"));
        assert_eq!(doc.document.chunk_count, 0);
        assert_eq!(
            search_impl(&db, "BeforeDelete", &[], None, None, 10, 0).unwrap().total,
            0,
            "来源丢失后不得继续命中旧分块"
        );
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn imported_reindex_reads_managed_copy_not_original() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("reindex-copy");
        let file = data.join("source.md");
        std::fs::write(&file, "OriginalText").unwrap();
        let kb_id = kb(&db, "资料");
        let (_, doc_id) = import_file_impl(
            &db,
            &data,
            &kb_id,
            file.to_str().unwrap(),
            "imported",
            None,
        )
        .unwrap();
        let doc_id = doc_id.unwrap();
        let managed: String = db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT managed_rel_path FROM knowledge_documents WHERE id=?1",
                    [&doc_id],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        let managed_path = knowledge_root(&data).join(&managed);
        std::fs::write(&managed_path, "ManagedGamma").unwrap();
        std::fs::write(&file, "SourceDelta").unwrap();

        reindex_document_impl(&db, &data, &doc_id).unwrap();
        assert_eq!(search_impl(&db, "ManagedGamma", &[], None, None, 10, 0).unwrap().total, 1);
        assert_eq!(search_impl(&db, "SourceDelta", &[], None, None, 10, 0).unwrap().total, 0);
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn knowledge_base_binding_is_real_or_rejected() {
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspace_projects(id,name,kind,root_path,dev_project_id,note,status,created_at,updated_at) \
                 VALUES('ws1','真实工作空间','general','',NULL,'','active',?1,?1)",
                [&now],
            )?;
            Ok(())
        })
        .unwrap();

        // 项目/工作区必须绑定真实对象，禁止伪绑定。
        assert!(create_base_impl(
            &db,
            KnowledgeBaseInput {
                name: "伪项目".into(),
                description: String::new(),
                kind: "project".into(),
                project_id: None,
                workspace_id: None,
            }
        )
        .is_err());
        assert!(create_base_impl(
            &db,
            KnowledgeBaseInput {
                name: "伪工作区".into(),
                description: String::new(),
                kind: "workspace".into(),
                project_id: None,
                workspace_id: Some("missing".into()),
            }
        )
        .is_err());

        let project = create_base_impl(
            &db,
            KnowledgeBaseInput {
                name: "项目库".into(),
                description: String::new(),
                kind: "project".into(),
                project_id: Some("ws1".into()),
                workspace_id: None,
            },
        )
        .unwrap();
        assert_eq!(project.project_id.as_deref(), Some("ws1"));
        assert!(project.workspace_id.is_none());

        let workspace = create_base_impl(
            &db,
            KnowledgeBaseInput {
                name: "工作区库".into(),
                description: String::new(),
                kind: "workspace".into(),
                project_id: Some("ws1".into()),
                workspace_id: Some("ws1".into()),
            },
        )
        .unwrap();
        assert!(workspace.project_id.is_none());
        assert_eq!(workspace.workspace_id.as_deref(), Some("ws1"));

        // 改成 personal 必须清除绑定；改成 project 必须重新选择真实项目。
        let personal = update_base_impl(
            &db,
            &workspace.id,
            KnowledgeBasePatch {
                name: "工作区库".into(),
                description: String::new(),
                kind: "personal".into(),
                project_id: Some("ws1".into()),
                workspace_id: Some("ws1".into()),
            },
        )
        .unwrap();
        assert!(personal.project_id.is_none() && personal.workspace_id.is_none());
        assert!(update_base_impl(
            &db,
            &personal.id,
            KnowledgeBasePatch {
                name: "工作区库".into(),
                description: String::new(),
                kind: "project".into(),
                project_id: None,
                workspace_id: None,
            }
        )
        .is_err());
    }
}
