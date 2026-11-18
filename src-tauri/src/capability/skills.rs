//! Agent Skills（开放 SKILL.md 规范）发现、解析、导入与风险标记。
//!
//! 安全边界：
//! - 只读扫描，**永不执行** Skill 内的任何脚本/命令；
//! - 风险只做静态标记（脚本文件、网络请求、凭据关键词、破坏性命令），
//!   不把内容当作可执行指令；
//! - 导入只复制目录，拒绝符号链接；删除只允许受管目录内的 Skill。

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::{content_hash, now_iso, skills_root, truncate_chars};

const MAX_SKILL_BYTES: usize = 512 * 1024;
const MAX_SCAN_DIRS: usize = 200;
const MAX_FILES: usize = 500;
const MAX_IMPORT_FILES: usize = 500;
const MAX_IMPORT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EXTRA_ROOTS: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskNote {
    pub kind: String,
    pub detail: String,
    pub file: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source_kind: String,
    pub source_path: String,
    pub scope: String,
    pub project_id: Option<String>,
    pub workspace_id: Option<String>,
    /// 作用域为 agent 时复用 `mcp_agents.id`，不引入第二套 Agent 身份。
    pub agent_id: Option<String>,
    pub enabled: bool,
    pub risk_level: String,
    pub risk_notes: Vec<RiskNote>,
    pub version: String,
    pub format_ok: bool,
    pub missing: bool,
    /// 同名 Skill 出现在多个来源目录（需要用户决定启用哪一个）。
    pub name_conflict: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    pub path: String,
    pub is_dir: bool,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    #[serde(flatten)]
    pub summary: SkillSummary,
    pub content: String,
    pub files: Vec<SkillFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillScanReport {
    pub discovered: usize,
    pub updated: usize,
    pub missing: usize,
    pub roots: Vec<String>,
}

// ── SKILL.md 解析 ─────────────────────────────────────────────────

/// `---` frontmatter 的极简解析（YAML 子集：`key: value` 单行）。
/// 不引入 YAML 依赖；无法解析的字段按缺失处理，`format_ok=false`。
pub fn parse_skill_md(raw: &str) -> (String, String, String, String, bool) {
    let text = raw.strip_prefix('\u{FEFF}').unwrap_or(raw);
    let mut fields = std::collections::HashMap::new();
    let mut body = text;
    let mut format_ok = false;
    if let Some(rest) = text.strip_prefix("---") {
        let rest = rest.strip_prefix('\n').or_else(|| rest.strip_prefix("\r\n"));
        if let Some(rest) = rest {
            if let Some(end) = rest.find("\n---") {
                let header = &rest[..end];
                format_ok = true;
                for line in header.lines() {
                    let Some((key, value)) = line.split_once(':') else {
                        continue;
                    };
                    let key = key.trim().to_ascii_lowercase();
                    let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
                    if !key.is_empty() {
                        fields.insert(key, value);
                    }
                }
                body = &rest[end + 4..];
            }
        }
    }
    let name = fields.get("name").cloned().unwrap_or_default();
    let description = fields.get("description").cloned().unwrap_or_default();
    let version = fields
        .get("version")
        .cloned()
        .or_else(|| fields.get("metadata.version").cloned())
        .unwrap_or_default();
    (name, description, version, body.trim_start().to_string(), format_ok)
}

fn fallback_name(dir_name: &str, body: &str) -> String {
    for line in body.lines() {
        if let Some(title) = line.strip_prefix("# ") {
            let title = title.trim();
            if !title.is_empty() {
                return truncate_chars(title, 80);
            }
        }
    }
    dir_name.to_string()
}

fn fallback_description(body: &str) -> String {
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("---") {
            continue;
        }
        return truncate_chars(line, 300);
    }
    String::new()
}

// ── 风险扫描 ──────────────────────────────────────────────────────

fn scan_risk(dir: &Path, skill_md: &str) -> (String, Vec<RiskNote>) {
    let mut notes: Vec<RiskNote> = Vec::new();
    let mut push = |kind: &str, detail: &str, file: &str| {
        if notes.len() >= 20 {
            return;
        }
        if notes
            .iter()
            .any(|n| n.kind == kind && n.detail == detail && n.file == file)
        {
            return;
        }
        notes.push(RiskNote {
            kind: kind.to_string(),
            detail: detail.to_string(),
            file: file.to_string(),
        });
    };

    let mut files = Vec::new();
    collect_skill_files(dir, 0, &mut files);
    for rel in &files {
        let lower = rel.to_ascii_lowercase();
        let ext = Path::new(&lower)
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default();
        if matches!(
            ext.as_str(),
            "ps1" | "bat" | "cmd" | "sh" | "py" | "js" | "mjs" | "vbs" | "exe" | "dll" | "com"
        ) {
            push("script", "Skill 包含可执行脚本或二进制文件，TaskDock 不会自动执行", rel);
        }
    }

    let network = regex::Regex::new(
        r"(?i)https?://|curl\s|wget\s|Invoke-WebRequest|Invoke-RestMethod|fetch\(",
    )
    .unwrap();
    let credential = regex::Regex::new(
        r"(?i)(password|passwd|api[_-]?key|secret|credential|access[_-]?token)",
    )
    .unwrap();
    let destructive = regex::Regex::new(
        r"(?i)(rm\s+-rf|Remove-Item|del\s+/[sfq]|format\s+[a-z]:|drop\s+table|shutil\.rmtree)",
    )
    .unwrap();
    let exec = regex::Regex::new(
        r"(?i)(powershell|cmd\.exe|bash\s+-c|subprocess|child_process|os\.system|eval\()",
    )
    .unwrap();

    let mut inspect = |content: &str, file: &str| {
        if network.is_match(content) {
            push("network", "包含网络请求指令，执行前需确认目标地址", file);
        }
        if credential.is_match(content) {
            push("credential", "包含凭据相关关键词，可能读取敏感信息", file);
        }
        if destructive.is_match(content) {
            push("destructive", "包含删除/破坏性命令，属于高风险操作", file);
        }
        if exec.is_match(content) {
            push("exec", "包含命令执行指令", file);
        }
    };

    inspect(skill_md, "SKILL.md");
    for rel in files.iter().take(40) {
        let path = dir.join(rel);
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.is_file() && meta.len() <= MAX_SKILL_BYTES as u64 {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    inspect(&text, rel);
                }
            }
        }
    }

    let level = if notes
        .iter()
        .any(|n| matches!(n.kind.as_str(), "script" | "destructive"))
    {
        "high"
    } else if notes.is_empty() {
        "low"
    } else {
        "medium"
    };
    (level.to_string(), notes)
}

fn collect_skill_files(dir: &Path, depth: usize, out: &mut Vec<String>) {
    if depth > 5 || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if ft.is_dir() {
            collect_skill_files(&path, depth + 1, out);
        } else if ft.is_file() {
            if let Ok(rel) = path.strip_prefix(dir) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

// ── 行读取 ────────────────────────────────────────────────────────

const SKILL_COLUMNS: &str = "id, name, description, source_kind, source_path, scope, project_id, \
    workspace_id, agent_id, enabled, risk_level, risk_notes, version, format_ok, missing, updated_at";

fn parse_notes(raw: &str) -> Vec<RiskNote> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn row_to_skill(row: &rusqlite::Row<'_>, name_conflict: bool) -> rusqlite::Result<SkillSummary> {
    Ok(SkillSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        source_kind: row.get(3)?,
        source_path: row.get(4)?,
        scope: row.get(5)?,
        project_id: row.get(6)?,
        workspace_id: row.get(7)?,
        agent_id: row.get(8)?,
        enabled: row.get::<_, i64>(9)? != 0,
        risk_level: row.get(10)?,
        risk_notes: parse_notes(&row.get::<_, String>(11)?),
        version: row.get(12)?,
        format_ok: row.get::<_, i64>(13)? != 0,
        missing: row.get::<_, i64>(14)? != 0,
        name_conflict,
        updated_at: row.get(15)?,
    })
}

fn read_skill(conn: &Connection, id: &str) -> AppResult<SkillSummary> {
    let mut skill = conn
        .query_row(
            &format!("SELECT {SKILL_COLUMNS} FROM capability_skills WHERE id=?1"),
            [id],
            |r| row_to_skill(r, false),
        )
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("Skill 不存在: {id}")))?;
    skill.name_conflict = has_same_name(conn, &skill.name, &skill.id)?;
    Ok(skill)
}

fn has_same_name(conn: &Connection, name: &str, exclude_id: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM capability_skills WHERE lower(name)=lower(?1) AND id<>?2 AND missing=0",
        params![name, exclude_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

// ── 扫描 ─────────────────────────────────────────────────────────

fn default_skill_roots(data_dir: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let home = PathBuf::from(home);
        roots.push(home.join(".agents").join("skills"));
        roots.push(home.join(".claude").join("skills"));
    }
    roots.push(skills_root(data_dir));
    roots
}

fn normalize_extra_roots(raw: &[String]) -> AppResult<Vec<PathBuf>> {
    if raw.len() > MAX_EXTRA_ROOTS {
        return Err(AppError::Validation(format!(
            "附加扫描目录最多 {MAX_EXTRA_ROOTS} 个"
        )));
    }
    let mut roots = Vec::new();
    for item in raw {
        let path = crate::file_workspace::validate_abs_path(item)?;
        if path.is_dir() {
            roots.push(path);
        }
    }
    Ok(roots)
}

/// 扫描并 upsert；返回发现/更新/丢失计数。默认包含用户级与受管目录。
pub fn scan_impl(db: &Db, data_dir: &Path, extra_roots: &[String]) -> AppResult<SkillScanReport> {
    scan_with_roots(db, data_dir, extra_roots, true)
}

/// `include_defaults=false` 仅供测试隔离（不读取真实用户 Skill 目录）。
pub fn scan_with_roots(
    db: &Db,
    data_dir: &Path,
    extra_roots: &[String],
    include_defaults: bool,
) -> AppResult<SkillScanReport> {
    let mut roots = if include_defaults {
        default_skill_roots(data_dir)
    } else {
        vec![skills_root(data_dir)]
    };
    roots.extend(normalize_extra_roots(extra_roots)?);
    let managed = skills_root(data_dir);
    let mut seen: Vec<String> = Vec::new();
    let mut discovered = 0usize;
    let mut updated = 0usize;

    for root in &roots {
        if !root.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        let mut count = 0usize;
        for entry in entries.flatten() {
            if count >= MAX_SCAN_DIRS {
                break;
            }
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() || ft.is_symlink() {
                continue;
            }
            let dir = entry.path();
            let skill_md = dir.join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            count += 1;
            match upsert_skill(db, &managed, &dir) {
                Ok(created) => {
                    if created {
                        discovered += 1;
                    } else {
                        updated += 1;
                    }
                    seen.push(dir.to_string_lossy().to_string());
                }
                Err(_) => {
                    // 单个损坏 Skill 不影响整体扫描；不写伪成功记录。
                }
            }
        }
    }

    // 只在本次扫描的根目录范围内标记 missing，避免未扫描的项目 Skill 被误标。
    let root_strs: Vec<String> = roots.iter().map(|p| p.to_string_lossy().to_string()).collect();
    let mut missing = 0usize;
    let existing: Vec<(String, String)> = db.with_read(|conn| {
        let mut stmt = conn.prepare("SELECT id, source_path FROM capability_skills")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })?;
    for (id, path) in existing {
        if seen.contains(&path) {
            continue;
        }
        let in_scope = root_strs
            .iter()
            .any(|root| path == *root || path.starts_with(&format!("{root}\\")));
        if !in_scope {
            continue;
        }
        let changed = db.with_conn(|conn| {
            let n = conn.execute(
                "UPDATE capability_skills SET missing=1, updated_at=?2 WHERE id=?1 AND missing=0",
                params![id, now_iso()],
            )?;
            Ok::<_, AppError>(n)
        })?;
        if changed > 0 {
            missing += 1;
        }
    }

    Ok(SkillScanReport {
        discovered,
        updated,
        missing,
        roots: root_strs,
    })
}

/// upsert 单个 Skill 目录；返回是否新建。
fn upsert_skill(db: &Db, managed_root: &Path, dir: &Path) -> AppResult<bool> {
    let skill_md = dir.join("SKILL.md");
    let raw = std::fs::read_to_string(&skill_md).map_err(|e| {
        AppError::Validation(format!("读取 SKILL.md 失败: {}（{e}）", skill_md.display()))
    })?;
    if raw.len() > MAX_SKILL_BYTES {
        return Err(AppError::Validation("SKILL.md 超过 512 KiB".into()));
    }
    let (name, description, version, body, format_ok) = parse_skill_md(&raw);
    let dir_name = dir
        .file_name()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".into());
    let name = if name.trim().is_empty() {
        fallback_name(&dir_name, &body)
    } else {
        truncate_chars(name.trim(), 80)
    };
    let description = if description.trim().is_empty() {
        fallback_description(&body)
    } else {
        truncate_chars(description.trim(), 500)
    };
    let (risk_level, risk_notes) = scan_risk(dir, &raw);
    let risk_json = serde_json::to_string(&risk_notes)?;
    let content = truncate_chars(&body, 200_000);
    let hash = content_hash(raw.as_bytes());
    let source_path = dir.to_string_lossy().to_string();
    let source_kind = if dir.starts_with(managed_root) {
        "imported"
    } else {
        "discovered"
    };
    let now = now_iso();
    db.with_conn(|conn| {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM capability_skills WHERE source_path=?1",
                [&source_path],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = &existing {
            conn.execute(
                "UPDATE capability_skills SET name=?2, description=?3, source_kind=?4, \
                 risk_level=?5, risk_notes=?6, version=?7, format_ok=?8, content=?9, \
                 content_hash=?10, missing=0, last_seen_at=?11, updated_at=?11 WHERE id=?1",
                params![
                    id,
                    name,
                    description,
                    source_kind,
                    risk_level,
                    risk_json,
                    version,
                    i64::from(format_ok),
                    content,
                    hash,
                    now
                ],
            )?;
            Ok::<_, AppError>(false)
        } else {
            conn.execute(
                "INSERT INTO capability_skills(id,name,description,source_kind,source_path,scope,project_id,enabled,risk_level,risk_notes,version,format_ok,content,content_hash,missing,last_seen_at,created_at,updated_at)
                 VALUES (?1,?2,?3,?4,?5,'global',NULL,1,?6,?7,?8,?9,?10,?11,0,?12,?12,?12)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    name,
                    description,
                    source_kind,
                    source_path,
                    risk_level,
                    risk_json,
                    version,
                    i64::from(format_ok),
                    content,
                    hash,
                    now
                ],
            )?;
            Ok(true)
        }
    })
}

// ── 列表 / 详情 / 操作 ───────────────────────────────────────────

pub fn list_impl(
    db: &Db,
    query: Option<&str>,
    scope: Option<&str>,
    risk: Option<&str>,
    project_id: Option<&str>,
) -> AppResult<Vec<SkillSummary>> {
    let q = query.map(str::trim).filter(|v| !v.is_empty());
    let scope = scope.map(str::trim).filter(|v| !v.is_empty());
    if let Some(s) = scope {
        if !matches!(s, "global" | "project" | "workspace" | "agent") {
            return Err(AppError::Validation("Skill 作用域筛选非法".into()));
        }
    }
    let risk = risk.map(str::trim).filter(|v| !v.is_empty());
    if let Some(r) = risk {
        if !matches!(r, "low" | "medium" | "high") {
            return Err(AppError::Validation("Skill 风险筛选非法".into()));
        }
    }
    let project = project_id.map(str::trim).filter(|v| !v.is_empty());
    db.with_read(|conn| {
        let pat = q.map(|v| format!("%{}%", v.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")));
        let mut stmt = conn.prepare(&format!(
            "SELECT {SKILL_COLUMNS} FROM capability_skills \
             WHERE (?1 IS NULL OR name LIKE ?1 ESCAPE '\\' OR description LIKE ?1 ESCAPE '\\') \
               AND (?2 IS NULL OR scope=?2) AND (?3 IS NULL OR risk_level=?3) \
               AND (?4 IS NULL OR project_id=?4) \
             ORDER BY missing, enabled DESC, name COLLATE NOCASE, updated_at DESC"
        ))?;
        let rows = stmt.query_map(params![pat, scope, risk, project], |r| row_to_skill(r, false))?;
        let mut skills = rows.collect::<Result<Vec<_>, _>>()?;
        // 同名冲突：一次查询分组，避免逐行 COUNT。
        let mut counts: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        {
            let mut group = conn.prepare(
                "SELECT lower(name), COUNT(*) FROM capability_skills WHERE missing=0 GROUP BY lower(name)",
            )?;
            let rows = group.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
            for row in rows {
                let (name, count) = row?;
                counts.insert(name, count);
            }
        }
        for skill in &mut skills {
            skill.name_conflict = counts.get(&skill.name.to_lowercase()).copied().unwrap_or(0) > 1;
        }
        Ok(skills)
    })
}

pub fn get_impl(db: &Db, id: &str) -> AppResult<SkillDetail> {
    let (summary, content) = db.with_read(|conn| {
        let summary = read_skill(conn, id)?;
        let content: String = conn.query_row(
            "SELECT content FROM capability_skills WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        Ok((summary, content))
    })?;
    let mut files = Vec::new();
    if !summary.missing {
        let dir = PathBuf::from(&summary.source_path);
        let mut rels = Vec::new();
        collect_skill_files(&dir, 0, &mut rels);
        for rel in rels {
            let path = dir.join(&rel);
            let size = std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0);
            let is_dir = path.is_dir();
            files.push(SkillFile {
                path: rel,
                is_dir,
                size_bytes: size,
            });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
    }
    Ok(SkillDetail {
        summary,
        content,
        files,
    })
}

pub fn set_enabled_impl(db: &Db, id: &str, enabled: bool) -> AppResult<SkillSummary> {
    db.with_conn(|conn| {
        let n = conn.execute(
            "UPDATE capability_skills SET enabled=?2, updated_at=?3 WHERE id=?1",
            params![id, i64::from(enabled), now_iso()],
        )?;
        if n == 0 {
            return Err(AppError::NotFound(format!("Skill 不存在: {id}")));
        }
        read_skill(conn, id)
    })
}

/// 作用域必须绑定真实对象：
/// - global：清除全部绑定；
/// - project：`project_id` 必须真实存在；
/// - workspace：`workspace_id` 必须真实存在（复用 `workspace_projects.id`）；
/// - agent：`agent_id` 必须是现有 `mcp_agents.id`。
pub fn set_scope_impl(
    db: &Db,
    id: &str,
    scope: &str,
    project_id: Option<&str>,
    workspace_id: Option<&str>,
    agent_id: Option<&str>,
) -> AppResult<SkillSummary> {
    if !matches!(scope, "global" | "project" | "workspace" | "agent") {
        return Err(AppError::Validation(format!("Skill 作用域非法: {scope}")));
    }
    db.with_conn(|conn| {
        read_skill(conn, id)?;
        let (project, workspace, agent) = match scope {
            "global" => (None, None, None),
            "project" => {
                let project = super::check_project(conn, project_id)?;
                if project.is_none() {
                    return Err(AppError::Validation("项目级 Skill 必须选择真实项目".into()));
                }
                (project, None, None)
            }
            "workspace" => {
                let workspace = super::check_workspace(conn, workspace_id)?;
                if workspace.is_none() {
                    return Err(AppError::Validation(
                        "工作区级 Skill 必须选择真实工作区".into(),
                    ));
                }
                (None, workspace, None)
            }
            "agent" => {
                let agent = agent_id.map(str::trim).filter(|v| !v.is_empty());
                let Some(agent) = agent else {
                    return Err(AppError::Validation("Agent 级 Skill 必须选择真实 Agent".into()));
                };
                let exists: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM mcp_agents WHERE id=?1 AND revoked_at IS NULL)",
                    [agent],
                    |r| r.get(0),
                )?;
                if !exists {
                    return Err(AppError::Validation(format!(
                        "Agent 不存在或已撤销: {agent}"
                    )));
                }
                (None, None, Some(agent.to_string()))
            }
            _ => unreachable!(),
        };
        conn.execute(
            "UPDATE capability_skills SET scope=?2, project_id=?3, workspace_id=?4, agent_id=?5, \
             updated_at=?6 WHERE id=?1",
            params![id, scope, project, workspace, agent, now_iso()],
        )?;
        read_skill(conn, id)
    })
}

/// 覆盖 SKILL.md 正文（frontmatter 由用户自行维护）；写入后重新解析与风险扫描。
pub fn save_content_impl(db: &Db, data_dir: &Path, id: &str, content: &str) -> AppResult<SkillSummary> {
    if content.len() > MAX_SKILL_BYTES {
        return Err(AppError::Validation("SKILL.md 超过 512 KiB".into()));
    }
    let source_path: String = db.with_read(|conn| {
        let skill = read_skill(conn, id)?;
        if skill.missing {
            return Err(AppError::Validation("Skill 目录已丢失，无法编辑".into()));
        }
        Ok(skill.source_path)
    })?;
    let dir = PathBuf::from(&source_path);
    let md = dir.join("SKILL.md");
    if !md.is_file() {
        return Err(AppError::NotFound("SKILL.md 不存在".into()));
    }
    let tmp = dir.join(format!(".SKILL.md.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, content)?;
    if std::fs::rename(&tmp, &md).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Io(std::io::Error::other(
            "SKILL.md 写入失败（可能是文件被占用）",
        )));
    }
    upsert_skill(db, &skills_root(data_dir), &dir)?;
    db.with_read(|conn| read_skill(conn, id))
}

fn copy_dir_bounded(src: &Path, dst: &Path) -> AppResult<(usize, u64)> {
    std::fs::create_dir_all(dst)?;
    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut stack = vec![(src.to_path_buf(), dst.to_path_buf())];
    while let Some((from, to)) = stack.pop() {
        for entry in std::fs::read_dir(&from)?.flatten() {
            let ft = entry.file_type()?;
            if ft.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let target = to.join(&name);
            if ft.is_dir() {
                std::fs::create_dir_all(&target)?;
                stack.push((entry.path(), target));
            } else if ft.is_file() {
                let size = entry.metadata()?.len();
                bytes = bytes.saturating_add(size);
                files += 1;
                if files > MAX_IMPORT_FILES || bytes > MAX_IMPORT_BYTES {
                    return Err(AppError::Validation(format!(
                        "Skill 目录超过导入上限（{MAX_IMPORT_FILES} 文件 / {} MiB）",
                        MAX_IMPORT_BYTES / 1024 / 1024
                    )));
                }
                std::fs::copy(entry.path(), &target)?;
            }
        }
    }
    Ok((files, bytes))
}

fn slugify(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if (ch == '-' || ch == '_' || ch.is_whitespace()) && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 40 {
            break;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "skill".to_string()
    } else {
        out
    }
}

/// 导入目录到受管目录；重复导入同一来源时更新既有记录（不产生双份）。
pub fn import_impl(
    db: &Db,
    data_dir: &Path,
    raw_path: &str,
    scope: Option<&str>,
    project_id: Option<&str>,
    workspace_id: Option<&str>,
    agent_id: Option<&str>,
) -> AppResult<SkillDetail> {
    let src = crate::file_workspace::validate_dir(&crate::file_workspace::validate_abs_path(raw_path)?)?;
    if !src.join("SKILL.md").is_file() {
        return Err(AppError::Validation(
            "所选目录不是 Skill：缺少 SKILL.md".into(),
        ));
    }
    let raw = std::fs::read_to_string(src.join("SKILL.md"))?;
    if raw.len() > MAX_SKILL_BYTES {
        return Err(AppError::Validation("SKILL.md 超过 512 KiB".into()));
    }
    let (name, _, _, body, _) = parse_skill_md(&raw);
    let dir_name = src
        .file_name()
        .map(|v| v.to_string_lossy().to_string())
        .unwrap_or_else(|| "skill".into());
    let name = if name.trim().is_empty() {
        fallback_name(&dir_name, &body)
    } else {
        name.trim().to_string()
    };
    let root = skills_root(data_dir);
    std::fs::create_dir_all(&root)?;

    // 同一来源已导入：更新副本而不是新建。
    let existing_path: Option<String> = db.with_read(|conn| {
        conn.query_row(
            "SELECT source_path FROM capability_skills WHERE source_kind='imported' AND name=?1 \
             AND source_path LIKE ?2 ESCAPE '\\' LIMIT 1",
            params![name, format!("%{}%", slugify(&name))],
            |r| r.get(0),
        )
        .optional()
        .map_err(AppError::from)
    })?;
    let target = existing_path
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(format!("{}-{}", slugify(&name), &uuid::Uuid::new_v4().to_string()[..8])));
    if target.exists() {
        std::fs::remove_dir_all(&target)?;
    }
    if let Err(e) = copy_dir_bounded(&src, &target) {
        let _ = std::fs::remove_dir_all(&target);
        return Err(e);
    }
    upsert_skill(db, &root, &target)?;
    let id: String = db.with_read(|conn| {
        conn.query_row(
            "SELECT id FROM capability_skills WHERE source_path=?1",
            [target.to_string_lossy().to_string()],
            |r| r.get(0),
        )
        .map_err(AppError::from)
    })?;
    let summary = set_scope_impl(
        db,
        &id,
        scope.filter(|v| !v.is_empty()).unwrap_or("global"),
        project_id,
        workspace_id,
        agent_id,
    )?;
    let _ = summary;
    get_impl(db, &id)
}

pub fn delete_impl(db: &Db, data_dir: &Path, id: &str) -> AppResult<bool> {
    let root = skills_root(data_dir);
    let (source_kind, source_path): (String, String) = db.with_read(|conn| {
        let skill = read_skill(conn, id)?;
        Ok((skill.source_kind, skill.source_path))
    })?;
    if source_kind != "imported" || !Path::new(&source_path).starts_with(&root) {
        return Err(AppError::Validation(
            "发现型 Skill 不允许在 TaskDock 内删除；请从原目录移除后重新扫描".into(),
        ));
    }
    db.with_conn(|conn| {
        conn.execute("DELETE FROM capability_skills WHERE id=?1", [id])?;
        Ok::<_, AppError>(())
    })?;
    let _ = std::fs::remove_dir_all(&source_path);
    Ok(true)
}

// ── Agent 可见性（Skill ↔ Agent 唯一过滤口径）─────────────────────

/// 当前 Agent / 项目的可见性上下文。CLI 预览没有 Agent 身份时 `agent_row_id=None`，
/// agent 级 Skill 不进入预览（诚实反映「只对指定 Agent 可见」）。
#[derive(Debug, Clone, Copy, Default)]
pub struct SkillAccessContext<'a> {
    pub project_id: Option<&'a str>,
    pub workspace_id: Option<&'a str>,
    pub agent_row_id: Option<&'a str>,
}

/// 作用域过滤：global 对所有 Agent 可见；project/workspace/agent 必须精确匹配
/// 当前上下文；任何未知 scope 一律不可见（fail-closed）。
pub fn is_applicable(
    scope: &str,
    skill_project_id: Option<&str>,
    skill_workspace_id: Option<&str>,
    skill_agent_id: Option<&str>,
    access: &SkillAccessContext<'_>,
) -> bool {
    match scope {
        "global" => true,
        "project" => {
            access.project_id.is_some() && skill_project_id == access.project_id
        }
        "workspace" => {
            access.workspace_id.is_some() && skill_workspace_id == access.workspace_id
        }
        "agent" => {
            access.agent_row_id.is_some() && skill_agent_id == access.agent_row_id
        }
        _ => false,
    }
}

/// 读取当前上下文中可用的 Skill（启用、未丢失、作用域匹配）。
pub fn list_applicable_conn(
    conn: &Connection,
    access: &SkillAccessContext<'_>,
) -> AppResult<Vec<SkillSummary>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SKILL_COLUMNS} FROM capability_skills \
         WHERE enabled=1 AND missing=0 \
         ORDER BY risk_level DESC, name COLLATE NOCASE, updated_at DESC"
    ))?;
    let rows = stmt.query_map([], |r| row_to_skill(r, false))?;
    let mut out = Vec::new();
    for row in rows {
        let skill = row?;
        if is_applicable(
            &skill.scope,
            skill.project_id.as_deref(),
            skill.workspace_id.as_deref(),
            skill.agent_id.as_deref(),
            access,
        ) {
            out.push(skill);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("td-skill-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_skill(root: &Path, dir: &str, name: &str, body: &str) -> PathBuf {
        let path = root.join(dir);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(
            path.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: 用于测试\nversion: 1.0.0\n---\n\n{body}"),
        )
        .unwrap();
        path
    }

    #[test]
    fn parses_frontmatter_and_fallback() {
        let (name, desc, version, body, ok) =
            parse_skill_md("---\nname: 小说检查\ndescription: 检查连续性\nversion: 2\n---\n正文");
        assert_eq!(name, "小说检查");
        assert_eq!(desc, "检查连续性");
        assert_eq!(version, "2");
        assert!(ok);
        assert_eq!(body, "正文");

        let (name, _, _, body, ok) = parse_skill_md("# 章节检查\n\n用于检查章节");
        assert!(!ok);
        assert_eq!(name, "");
        assert!(body.contains("章节检查"));
    }

    #[test]
    fn scan_marks_high_risk_scripts_without_executing() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("data");
        let root = temp_dir("root");
        let skill = write_skill(&root, "risky", "风险技能", "运行脚本");
        std::fs::write(skill.join("run.ps1"), "Remove-Item C:\\tmp\\x").unwrap();
        let report = scan_with_roots(&db, &data, &[root.to_string_lossy().to_string()], false).unwrap();
        assert_eq!(report.discovered, 1);
        let skills = list_impl(&db, None, None, None, None).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].risk_level, "high");
        assert!(skills[0].risk_notes.iter().any(|n| n.kind == "script"));
        // 文件仍在，说明只扫描未执行/未删除。
        assert!(skill.join("run.ps1").exists());
        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn scan_marks_missing_when_directory_disappears() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("data2");
        let root = temp_dir("root2");
        write_skill(&root, "a", "A", "内容");
        scan_with_roots(&db, &data, &[root.to_string_lossy().to_string()], false).unwrap();
        std::fs::remove_dir_all(root.join("a")).unwrap();
        let report = scan_with_roots(&db, &data, &[root.to_string_lossy().to_string()], false).unwrap();
        assert_eq!(report.missing, 1);
        let skills = list_impl(&db, None, None, None, None).unwrap();
        assert!(skills[0].missing);
        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn import_copies_folder_and_supports_scope_and_delete() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("data3");
        let root = temp_dir("root3");
        let src = write_skill(&root, "b", "B 技能", "正文");
        std::fs::write(src.join("extra.md"), "资源").unwrap();
        let detail = import_impl(&db, &data, src.to_str().unwrap(), Some("global"), None, None, None).unwrap();
        assert_eq!(detail.summary.name, "B 技能");
        assert_eq!(detail.summary.source_kind, "imported");
        assert!(detail.files.iter().any(|f| f.path == "SKILL.md"));
        assert!(detail.files.iter().any(|f| f.path == "extra.md"));
        // 再次导入不产生重复记录
        import_impl(&db, &data, src.to_str().unwrap(), Some("global"), None, None, None).unwrap();
        assert_eq!(list_impl(&db, None, None, None, None).unwrap().len(), 1);
        delete_impl(&db, &data, &detail.summary.id).unwrap();
        assert!(list_impl(&db, None, None, None, None).unwrap().is_empty());
        assert!(src.join("SKILL.md").exists(), "删除受管副本不得删除来源目录");
        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn discovered_skill_cannot_be_deleted() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("data4");
        let root = temp_dir("root4");
        write_skill(&root, "c", "C", "正文");
        scan_with_roots(&db, &data, &[root.to_string_lossy().to_string()], false).unwrap();
        let skills = list_impl(&db, None, None, None, None).unwrap();
        assert!(delete_impl(&db, &data, &skills[0].id).is_err());
        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn project_scope_requires_existing_project() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("data5");
        let root = temp_dir("root5");
        write_skill(&root, "d", "D", "正文");
        scan_with_roots(&db, &data, &[root.to_string_lossy().to_string()], false).unwrap();
        let id = list_impl(&db, None, None, None, None).unwrap()[0].id.clone();
        assert!(set_scope_impl(&db, &id, "project", None, None, None).is_err());
        assert!(set_scope_impl(&db, &id, "project", Some("missing"), None, None).is_err());
        assert!(set_scope_impl(&db, &id, "workspace", None, None, None).is_err());
        assert!(set_scope_impl(&db, &id, "agent", None, None, None).is_err());
        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn name_conflict_is_flagged() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("data6");
        let root = temp_dir("root6");
        write_skill(&root, "a", "同名", "A");
        write_skill(&root, "b", "同名", "B");
        scan_with_roots(&db, &data, &[root.to_string_lossy().to_string()], false).unwrap();
        let skills = list_impl(&db, None, None, None, None).unwrap();
        assert_eq!(skills.len(), 2);
        assert!(skills.iter().all(|s| s.name_conflict));
        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(data).ok();
    }

    // ── Agent 可见性（需求 7）────────────────────────────────────
    fn seed_project_and_agents(db: &Db) -> (String, String, String) {
        let now = now_iso();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspace_projects(id,name,kind,root_path,dev_project_id,note,status,created_at,updated_at) \
                 VALUES('p-a','项目 A','general','',NULL,'','active',?1,?1)",
                [&now],
            )?;
            conn.execute(
                "INSERT INTO workspace_projects(id,name,kind,root_path,dev_project_id,note,status,created_at,updated_at) \
                 VALUES('p-b','项目 B','general','',NULL,'','active',?1,?1)",
                [&now],
            )?;
            for (id, agent) in [("row-a", "agent-a"), ("row-b", "agent-b")] {
                conn.execute(
                    "INSERT INTO mcp_agents(id,agent_id,display_name,token_hash,scope,created_at,updated_at) \
                     VALUES(?1,?2,?2,'hash','readonly',?3,?3)",
                    params![id, agent, now],
                )?;
            }
            Ok::<_, AppError>(())
        })
        .unwrap();
        ("p-a".into(), "p-b".into(), "row-a".into())
    }

    fn seed_skill(db: &Db, root: &Path, dir: &str, name: &str, scope: &str, target: Option<&str>) -> String {
        let path = write_skill(root, dir, name, "正文");
        scan_with_roots(db, &temp_dir("data-scope"), &[root.to_string_lossy().to_string()], false).unwrap();
        let id: String = db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT id FROM capability_skills WHERE source_path=?1",
                    [path.to_string_lossy().to_string()],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        match scope {
            "project" => set_scope_impl(db, &id, scope, target, None, None).unwrap(),
            "workspace" => set_scope_impl(db, &id, scope, None, target, None).unwrap(),
            "agent" => set_scope_impl(db, &id, scope, None, None, target).unwrap(),
            _ => set_scope_impl(db, &id, "global", None, None, None).unwrap(),
        };
        id
    }

    #[test]
    fn skill_visibility_respects_scope_and_state() {
        let db = Db::open_in_memory().unwrap();
        let data = temp_dir("data-scope-shared");
        let root = temp_dir("root-scope");
        let (project_a, project_b, agent_a) = seed_project_and_agents(&db);

        let global = seed_skill(&db, &root, "g", "全局", "global", None);
        let project_skill = seed_skill(&db, &root, "p", "项目 A", "project", Some(&project_a));
        let project_b_skill = seed_skill(&db, &root, "pb", "项目 B", "project", Some(&project_b));
        let agent_skill = seed_skill(&db, &root, "a", "Agent A", "agent", Some(&agent_a));
        let disabled = seed_skill(&db, &root, "d", "禁用", "global", None);
        set_enabled_impl(&db, &disabled, false).unwrap();
        let missing = seed_skill(&db, &root, "m", "丢失", "global", None);
        std::fs::remove_dir_all(root.join("m")).unwrap();
        scan_with_roots(&db, &data, &[root.to_string_lossy().to_string()], false).unwrap();

        let access = SkillAccessContext {
            project_id: Some(&project_a),
            workspace_id: Some(&project_a),
            agent_row_id: Some(&agent_a),
        };
        let ids: Vec<String> = db
            .with_read(|conn| list_applicable_conn(conn, &access))
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert!(ids.contains(&global), "global_skill_visible");
        assert!(ids.contains(&project_skill), "project_skill_visible_in_own_project");
        assert!(ids.contains(&agent_skill), "agent_skill_visible_to_own_agent");
        assert!(!ids.contains(&project_b_skill), "project_skill_only_visible_in_project");
        assert!(!ids.contains(&disabled), "disabled_skill_not_loaded");
        assert!(!ids.contains(&missing), "missing_skill_not_loaded");

        // 换到项目 B / 另一个 Agent：不得看到项目 A 与 Agent A 的 Skill。
        let other = SkillAccessContext {
            project_id: Some(&project_b),
            workspace_id: Some(&project_b),
            agent_row_id: Some("row-b"),
        };
        let other_ids: Vec<String> = db
            .with_read(|conn| list_applicable_conn(conn, &other))
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert!(other_ids.contains(&global));
        assert!(!other_ids.contains(&project_skill));
        assert!(!other_ids.contains(&agent_skill));
        assert!(other_ids.contains(&project_b_skill));

        std::fs::remove_dir_all(data).ok();
        std::fs::remove_dir_all(root).ok();
    }
}
