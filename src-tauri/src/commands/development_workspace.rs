//! 开发工作空间专业后端（D1，2026-11-16）：开发项目关联 / Agent 任务接续 /
//! 构建与验收追溯 / Git 与 Worktree 风险探测。
//!
//! ## 归属
//! 本文件由**开发线**独占编写；`commands/mod.rs`、`db/mod.rs`、`lib.rs`、`backup.rs`
//! 由集成负责人维护，本文件不得修改它们。**不得新建第二套开发工作台或构建队列**：
//! 一律复用 `dev_workbench.rs`（dev_projects / dev_handoff_packs /
//! dev_acceptance_records / Agent 关联链）与既有构建调度器 / 集成台账。
//!
//! ## 约定
//! - 新命令命名前缀 `dws_`（避免与既有 `dev_*` 命令冲突），形参见 `project_workspace.rs`：
//!   `*_impl(db, ...)` 纯业务实现 + 薄 `#[tauri::command]` 包装。
//! - 写入门禁：`kind = development` 且 `status = active`；读取允许归档（只读）。
//! - Git / Worktree 探测**只读**：只允许 `rev-parse` / `status --porcelain` /
//!   `worktree list` / `log` 之类读取调用，或复用既有 `devwork::git::probe`；
//!   **禁止** reset / stash / clean / checkout / merge / 强制推送。
//! - 风险提示只做「事实 + 明确提示 + 建议人工处理」，不得自动消除冲突。
//! - 验收结论只能来自 `dev_acceptance_records` 的真实记录；Agent 轮次 `completed`
//!   只是「Agent 自述完成」，绝不自动判定为验收通过。
//! - `tmp/integration/` 台账只读解析；显式关联（任务 ↔ buildId / 验收记录）落
//!   `dws_task_links`，是用户手工关联的真实数据。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use std::sync::Arc;
use tauri::State;

use crate::agents::now_iso;
use crate::commands::dev_workbench as dev;
use crate::db::Db;
use crate::devwork::git::{self, DevGitInfo, DevGitStatus};
use crate::error::{AppError, AppResult};

/// v63：开发任务关联 / 探测快照（开发 D1）。
///
/// - `dws_task_links`：开发项目（workspace_projects）↔ dev_projects / 任务 /
///   交接包 / 构建 buildId / 验收记录的显式关联；只对 workspace_projects 与
///   dev_projects 建外键，task_id / build_id 等为弱引用（目标删除后保留原 ID）。
/// - `dws_workspace_probes`：本机瞬时探测快照（分支 / dirty / 改动文件 / 风险），
///   仅作最近一次事实留痕，不参与跨机同步。
pub const MIGRATION_63: (i64, &'static str) = (
    63,
    r#"
-- v63（开发 D1）：开发任务关联表 + 本机探测快照表。
CREATE TABLE dws_task_links (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES workspace_projects(id) ON DELETE CASCADE,
  dev_project_id TEXT
    REFERENCES dev_projects(id) ON DELETE SET NULL,
  task_id TEXT NOT NULL DEFAULT '',
  handoff_pack_id TEXT NOT NULL DEFAULT '',
  build_id TEXT NOT NULL DEFAULT '',
  acceptance_record_id TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_dws_task_links_project ON dws_task_links(project_id);
CREATE INDEX idx_dws_task_links_task ON dws_task_links(project_id, task_id);

CREATE TABLE dws_workspace_probes (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL
    REFERENCES workspace_projects(id) ON DELETE CASCADE,
  probed_at TEXT NOT NULL,
  git_status TEXT NOT NULL DEFAULT '',
  branch TEXT,
  detached INTEGER NOT NULL DEFAULT 0,
  head_sha TEXT,
  dirty_count INTEGER,
  is_worktree INTEGER NOT NULL DEFAULT 0,
  main_repo_path TEXT,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_dws_workspace_probes_project
  ON dws_workspace_probes(project_id, probed_at DESC);
"#,
);

// ── 常量与校验上限 ─────────────────────────────────────────────────────

const MAX_NOTE_CHARS: usize = 500;
/// 单次探测返回的改动文件上限（超出截断并如实标记 truncated）。
const CHANGED_FILE_CAP: usize = 50;
/// 构建追溯一次合并的任务数上限。
const TRACE_TASK_CAP: usize = 20;
/// 每个项目保留的探测快照条数上限（超出按时间倒序回收旧快照，避免表无界增长）。
const PROBE_SNAPSHOT_KEEP: i64 = 20;
const STEP_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// 公共文件清单（对照 AGENTS.md §4 与 docs/INTEGRATION_BUILD.md）：
/// 改动落在这些路径上属于跨任务共享枢纽，必须串行协调，不能并行覆盖。
/// 路径按正斜杠、小写匹配。
const PUBLIC_FILE_PATHS: &[&str] = &[
    "src/lib/bridge.ts",
    "src/lib/navigation.ts",
    "src/lib/navigationregistry.ts",
    "src/lib/featurecatalog.ts",
    "src/store/useuistore.ts",
    "src-tauri/src/lib.rs",
    "src-tauri/src/commands/mod.rs",
    "src-tauri/src/db/mod.rs",
    "src-tauri/src/commands/backup.rs",
    "package.json",
    "src-tauri/cargo.toml",
    "src/styles-themes.css",
    "src/styles-ui.css",
];

// ── 返回模型 ─────────────────────────────────────────────────────────

/// 关联到本开发项目的一个开发仓库（dev_projects 弱引用 / 手工关联）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DwsDevProjectRef {
    pub dev_project_id: String,
    pub name: String,
    pub root_path: String,
    /// 读时计算：目录当前是否存在（不落库；false = 失效，前端如实降级）。
    pub exists: bool,
    pub note: String,
    /// weak_ref = workspace_projects.dev_project_id 既有弱引用；manual = 本表手工关联。
    pub link_origin: String,
    pub git: DevGitInfo,
}

/// 关联到本开发项目的一个既有任务（弱引用 tasks，不复制任务内容）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DwsTaskRef {
    pub task_id: String,
    pub title: String,
    pub status: String,
    pub priority: i64,
    pub due_at: Option<String>,
    /// workspace_link = workspace_task_links 既有关联；manual = 本表手工关联。
    pub link_origin: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DwsDevelopmentSummary {
    pub project_id: String,
    pub project_name: String,
    pub kind: String,
    pub archived: bool,
    /// workspace_projects.dev_project_id 原始弱引用 ID（目标删除后仍保留）。
    pub weak_dev_project_id: Option<String>,
    pub dev_projects: Vec<DwsDevProjectRef>,
    pub tasks: Vec<DwsTaskRef>,
}

/// 一条显式关联（开发项目 ↔ 仓库 / 任务 / 交接包 / 构建 / 验收记录）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DwsTaskLink {
    pub id: String,
    pub project_id: String,
    pub dev_project_id: Option<String>,
    pub dev_project_name: Option<String>,
    pub task_id: String,
    pub task_title: Option<String>,
    pub handoff_pack_id: String,
    pub handoff_title: Option<String>,
    pub build_id: String,
    pub acceptance_record_id: String,
    pub acceptance_verdict: Option<String>,
    pub note: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DwsTaskHandoff {
    pub task_id: String,
    pub task_title: Option<String>,
    pub task_status: Option<String>,
    pub packs: Vec<dev::DevHandoffPack>,
    pub agent_candidates: Vec<dev::DevAgentRunCandidate>,
    pub acceptance_records: Vec<dev::DevAcceptanceRecord>,
    pub links: Vec<DwsTaskLink>,
    /// 最新一条人工验收记录结论（无记录 = None）。**只有这里能代表验收结论**。
    pub latest_acceptance_verdict: Option<String>,
    pub acceptance_record_count: i64,
    /// 是否存在 Agent 自述完成的轮次（仅事实；不等于验收通过）。
    pub agent_self_reported_completed: bool,
}

// ── 构建追溯台账模型（只读解析 tmp/integration）─────────────────────────

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DwsLedgerCheck {
    pub cmd: String,
    pub exit_code: Option<i64>,
    pub at: String,
    pub log_path: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DwsLedgerTask {
    pub id: String,
    pub module: String,
    pub owner: String,
    pub status: String,
    pub paths: Vec<String>,
    pub snapshot: Option<String>,
    pub build_id: Option<String>,
    pub acceptance: Option<String>,
    pub notes: String,
    pub updated_at: String,
    pub checks: Vec<DwsLedgerCheck>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DwsLedgerArtifact {
    pub name: String,
    pub kind: String,
    pub files: Option<i64>,
    pub bytes: Option<i64>,
    pub sha256: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DwsLedgerBuild {
    pub id: String,
    pub snapshot: Option<String>,
    pub commit: Option<String>,
    pub short_commit: Option<String>,
    pub dirty: Option<bool>,
    pub platform: String,
    pub config: String,
    pub status: String,
    pub exit_code: Option<i64>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub tasks: Vec<String>,
    pub log_path: Option<String>,
    pub artifacts: Vec<DwsLedgerArtifact>,
    pub host: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DwsLedgerSnapshot {
    pub id: String,
    pub branch: Option<String>,
    pub base: Option<String>,
    pub commit: Option<String>,
    pub tasks: Vec<String>,
    pub note: String,
    pub created_at: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DwsBuildTrace {
    pub ledger_available: bool,
    pub ledger_root: Option<String>,
    pub ledger_reason: Option<String>,
    pub tasks: Vec<DwsLedgerTask>,
    pub snapshots: Vec<DwsLedgerSnapshot>,
    pub builds: Vec<DwsLedgerBuild>,
    pub links: Vec<DwsTaskLink>,
    pub acceptance_records: Vec<dev::DevAcceptanceRecord>,
}

// ── Git 风险探测模型 ────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DwsChangedFile {
    pub path: String,
    pub status: String,
    /// 按顶层目录聚合的分组名（根目录文件为 "/"）。
    pub group: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DwsRiskFlag {
    pub level: String,
    pub code: String,
    pub message: String,
    pub files: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DwsRepoRisk {
    pub dev_project_id: Option<String>,
    pub name: String,
    pub root_path: String,
    pub exists: bool,
    pub git: DevGitInfo,
    pub changed_files: Vec<DwsChangedFile>,
    pub truncated: bool,
    pub risks: Vec<DwsRiskFlag>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DwsGitRisk {
    pub repos: Vec<DwsRepoRisk>,
    pub risks: Vec<DwsRiskFlag>,
    pub advice: String,
    /// 本次结果是否写入了本机瞬时快照表（归档项目不落库）。
    pub persisted: bool,
}

// ── 命令响应包装 ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct DwsSummaryOut {
    pub summary: DwsDevelopmentSummary,
}

#[derive(Serialize)]
pub struct DwsLinkSaved {
    pub link: DwsTaskLink,
}

#[derive(Serialize)]
pub struct DwsLinkList {
    pub links: Vec<DwsTaskLink>,
}

#[derive(Serialize)]
pub struct DwsOk {
    pub ok: bool,
}

#[derive(Serialize)]
pub struct DwsHandoffOut {
    pub handoff: DwsTaskHandoff,
}

#[derive(Serialize)]
pub struct DwsTraceOut {
    pub trace: DwsBuildTrace,
}

#[derive(Serialize)]
pub struct DwsRiskOut {
    pub risk: DwsGitRisk,
}

// ── 门禁与公共读取 ────────────────────────────────────────────────────

/// 开发项目统一门禁：`kind = development`；`require_active=true`（写入）时还要求
/// `status = active`。读取允许归档项目。返回 (kind, status)。
fn ensure_development_project(
    conn: &Connection,
    project_id: &str,
    require_active: bool,
) -> AppResult<(String, String)> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT kind, status FROM workspace_projects WHERE id = ?1",
            params![project_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (kind, status) = row.ok_or_else(|| {
        AppError::NotFound(format!("工作空间项目不存在: {project_id}"))
    })?;
    if kind != "development" {
        return Err(AppError::Validation("该操作仅对开发项目开放".into()));
    }
    if require_active && status != "active" {
        return Err(AppError::Validation(
            "项目已归档，关联与探测只读；恢复为进行中后才能修改".into(),
        ));
    }
    Ok((kind, status))
}

fn trim_optional(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn normalize_path_key(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

/// 关联行原始列（先整行取出，再单独解析标题，避免在语句行回调里开第二条查询）。
struct RawLink {
    id: String,
    project_id: String,
    dev_project_id: Option<String>,
    task_id: String,
    handoff_pack_id: String,
    build_id: String,
    acceptance_record_id: String,
    note: String,
    created_at: String,
    updated_at: String,
}

fn lookup_title(conn: &Connection, table: &str, id: &str, column: &str) -> Option<String> {
    if id.is_empty() {
        return None;
    }
    let sql = format!("SELECT {column} FROM {table} WHERE id = ?1");
    conn.query_row(&sql, params![id], |r| r.get::<_, String>(0))
        .optional()
        .ok()
        .flatten()
}

fn raw_to_link(conn: &Connection, raw: RawLink) -> AppResult<DwsTaskLink> {
    let dev_project_name = raw
        .dev_project_id
        .as_deref()
        .and_then(|id| lookup_title(conn, "dev_projects", id, "name"));
    let task_title = lookup_title(conn, "tasks", &raw.task_id, "title");
    let handoff_title = lookup_title(conn, "dev_handoff_packs", &raw.handoff_pack_id, "title");
    let acceptance_verdict = lookup_title(
        conn,
        "dev_acceptance_records",
        &raw.acceptance_record_id,
        "verdict",
    );
    Ok(DwsTaskLink {
        id: raw.id,
        project_id: raw.project_id,
        dev_project_id: raw.dev_project_id,
        dev_project_name,
        task_id: raw.task_id,
        task_title,
        handoff_pack_id: raw.handoff_pack_id,
        handoff_title,
        build_id: raw.build_id,
        acceptance_record_id: raw.acceptance_record_id,
        acceptance_verdict,
        note: raw.note,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
    })
}

fn list_links_impl(
    conn: &Connection,
    project_id: &str,
    task_id: Option<&str>,
) -> AppResult<Vec<DwsTaskLink>> {
    let mut sql = "SELECT id, project_id, dev_project_id, task_id, handoff_pack_id,
            build_id, acceptance_record_id, note, created_at, updated_at
     FROM dws_task_links WHERE project_id = ?1"
        .to_string();
    if task_id.is_some() {
        sql.push_str(" AND task_id = ?2");
    }
    sql.push_str(" ORDER BY updated_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let raw_rows: Vec<RawLink> = match task_id {
        Some(tid) => stmt
            .query_map(params![project_id, tid], |r| {
                Ok(RawLink {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    dev_project_id: r.get(2)?,
                    task_id: r.get(3)?,
                    handoff_pack_id: r.get(4)?,
                    build_id: r.get(5)?,
                    acceptance_record_id: r.get(6)?,
                    note: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(AppError::from)?,
        None => stmt
            .query_map(params![project_id], |r| {
                Ok(RawLink {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    dev_project_id: r.get(2)?,
                    task_id: r.get(3)?,
                    handoff_pack_id: r.get(4)?,
                    build_id: r.get(5)?,
                    acceptance_record_id: r.get(6)?,
                    note: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(AppError::from)?,
    };
    let mut out = Vec::with_capacity(raw_rows.len());
    for raw in raw_rows {
        out.push(raw_to_link(conn, raw)?);
    }
    Ok(out)
}

// ── E1：开发项目关联摘要 ──────────────────────────────────────────────

fn dev_project_refs(
    conn: &Connection,
    project_id: &str,
    weak_dev_project_id: &Option<String>,
) -> AppResult<Vec<DwsDevProjectRef>> {
    // 收集 (dev_project_id, link_origin)，按 ID 去重，weak_ref 优先。
    let mut collected: Vec<(String, String)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(id) = weak_dev_project_id {
        if !id.is_empty() && seen.insert(id.clone()) {
            collected.push((id.clone(), "weak_ref".to_string()));
        }
    }
    let mut stmt = conn.prepare(
        "SELECT dev_project_id FROM dws_task_links
         WHERE project_id = ?1 AND dev_project_id IS NOT NULL",
    )?;
    let links = stmt.query_map(params![project_id], |r| r.get::<_, Option<String>>(0))?;
    for l in links {
        if let Some(id) = l.map_err(AppError::from)? {
            if seen.insert(id.clone()) {
                collected.push((id, "manual".to_string()));
            }
        }
    }

    let mut out = Vec::new();
    for (id, origin) in collected {
        let row: Option<(String, String, String)> = conn
            .query_row(
                "SELECT name, root_path, note FROM dev_projects WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let (name, root_path, note) = match row {
            Some((n, p, note)) => (n, p, note),
            // 弱引用目标已删除：保留占位行，exists=false，不伪造名称/路径。
            None => (id.clone(), String::new(), String::new()),
        };
        let exists = !root_path.is_empty() && Path::new(&root_path).is_dir();
        let git = if exists {
            git::probe(&root_path)
        } else {
            DevGitInfo {
                status: DevGitStatus::PathMissing,
                branch: None,
                detached: false,
                is_worktree: false,
                main_repo_path: None,
                head_sha: None,
                dirty_count: None,
                probed_at: now_iso(),
            }
        };
        out.push(DwsDevProjectRef {
            dev_project_id: id,
            name,
            root_path,
            exists,
            note,
            link_origin: origin,
            git,
        });
    }
    Ok(out)
}

fn task_refs(conn: &Connection, project_id: &str) -> AppResult<Vec<DwsTaskRef>> {
    let mut collected: Vec<(String, String)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut stmt = conn.prepare(
        "SELECT task_id FROM workspace_task_links WHERE project_id = ?1",
    )?;
    let ws = stmt.query_map(params![project_id], |r| r.get::<_, String>(0))?;
    for w in ws {
        let tid = w.map_err(AppError::from)?;
        if seen.insert(tid.clone()) {
            collected.push((tid, "workspace_link".to_string()));
        }
    }
    let mut stmt = conn.prepare(
        "SELECT task_id FROM dws_task_links
         WHERE project_id = ?1 AND task_id <> ''",
    )?;
    let ls = stmt.query_map(params![project_id], |r| r.get::<_, String>(0))?;
    for l in ls {
        let tid = l.map_err(AppError::from)?;
        if seen.insert(tid.clone()) {
            collected.push((tid, "manual".to_string()));
        }
    }

    let mut out = Vec::new();
    for (task_id, origin) in collected {
        let row: Option<(String, String, i64, Option<String>)> = conn
            .query_row(
                "SELECT title, status, priority, due_at FROM tasks WHERE id = ?1",
                params![task_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let (title, status, priority, due_at) = match row {
            Some(t) => t,
            None => (task_id.clone(), "missing".to_string(), 2, None),
        };
        out.push(DwsTaskRef {
            task_id,
            title,
            status,
            priority,
            due_at,
            link_origin: origin,
        });
    }
    Ok(out)
}

pub fn dws_development_summary_impl(db: &Db, project_id: &str) -> AppResult<DwsDevelopmentSummary> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err(AppError::Validation("project_id 不能为空".into()));
    }
    db.with_read(|conn| {
        let (_, status) = ensure_development_project(conn, project_id, false)?;
        let row: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT name, dev_project_id FROM workspace_projects WHERE id = ?1",
                params![project_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (name, weak_dev_project_id) =
            row.ok_or_else(|| AppError::NotFound(format!("工作空间项目不存在: {project_id}")))?;
        let dev_projects = dev_project_refs(conn, project_id, &weak_dev_project_id)?;
        let tasks = task_refs(conn, project_id)?;
        Ok(DwsDevelopmentSummary {
            project_id: project_id.to_string(),
            project_name: name,
            kind: "development".to_string(),
            archived: status != "active",
            weak_dev_project_id,
            dev_projects,
            tasks,
        })
    })
}

// ── E1/E2/E3：显式关联表读写 ──────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub fn dws_task_link_save_impl(
    db: &Db,
    project_id: &str,
    task_id: Option<String>,
    dev_project_id: Option<String>,
    handoff_pack_id: Option<String>,
    build_id: Option<String>,
    acceptance_record_id: Option<String>,
    note: Option<String>,
) -> AppResult<DwsTaskLink> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err(AppError::Validation("project_id 不能为空".into()));
    }
    let task_id = task_id.unwrap_or_default().trim().to_string();
    let dev_project_id = trim_optional(dev_project_id);
    let handoff_pack_id = handoff_pack_id.unwrap_or_default().trim().to_string();
    let build_id = build_id.unwrap_or_default().trim().to_string();
    let acceptance_record_id = acceptance_record_id
        .unwrap_or_default()
        .trim()
        .to_string();
    let note = note.unwrap_or_default().trim().to_string();
    if note.chars().count() > MAX_NOTE_CHARS {
        return Err(AppError::Validation("备注超过长度上限".into()));
    }
    if task_id.is_empty()
        && dev_project_id.is_none()
        && handoff_pack_id.is_empty()
        && build_id.is_empty()
        && acceptance_record_id.is_empty()
    {
        return Err(AppError::Validation(
            "至少需要关联一个仓库 / 任务 / 交接包 / 构建 / 验收记录".to_string(),
        ));
    }

    db.with_conn(|conn| {
        ensure_development_project(conn, &project_id, true)?;

        // 存在性校验：外键约束之外，弱引用目标缺失也要在写入前如实报错，不挂悬空引用。
        if let Some(ref dev_id) = dev_project_id {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM dev_projects WHERE id = ?1)",
                params![dev_id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(AppError::NotFound(format!("开发项目仓库不存在: {dev_id}")));
            }
        }
        if !handoff_pack_id.is_empty() {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM dev_handoff_packs WHERE id = ?1)",
                params![handoff_pack_id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(AppError::NotFound(format!("交接包不存在: {handoff_pack_id}")));
            }
        }
        if !acceptance_record_id.is_empty() {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM dev_acceptance_records WHERE id = ?1)",
                params![acceptance_record_id],
                |r| r.get(0),
            )?;
            if !exists {
                return Err(AppError::NotFound(format!(
                    "验收记录不存在: {acceptance_record_id}"
                )));
            }
        }

        // 同键幂等：已存在则更新备注与时间，不重复插入。
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM dws_task_links
                 WHERE project_id = ?1 AND COALESCE(dev_project_id, '') = COALESCE(?2, '')
                   AND task_id = ?3 AND handoff_pack_id = ?4
                   AND build_id = ?5 AND acceptance_record_id = ?6",
                params![
                    project_id,
                    dev_project_id,
                    task_id,
                    handoff_pack_id,
                    build_id,
                    acceptance_record_id
                ],
                |r| r.get(0),
            )
            .optional()?;

        let now = now_iso();
        let link_id = match existing {
            Some(id) => {
                conn.execute(
                    "UPDATE dws_task_links SET note = ?1, updated_at = ?2 WHERE id = ?3",
                    params![note, now, id],
                )?;
                id
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO dws_task_links
                     (id, project_id, dev_project_id, task_id, handoff_pack_id,
                      build_id, acceptance_record_id, note, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                    params![
                        id,
                        project_id,
                        dev_project_id,
                        task_id,
                        handoff_pack_id,
                        build_id,
                        acceptance_record_id,
                        note,
                        now
                    ],
                )?;
                id
            }
        };

        let raw = conn.query_row(
            "SELECT id, project_id, dev_project_id, task_id, handoff_pack_id,
              build_id, acceptance_record_id, note, created_at, updated_at
             FROM dws_task_links WHERE id = ?1",
            params![link_id],
            |r| {
                Ok(RawLink {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    dev_project_id: r.get(2)?,
                    task_id: r.get(3)?,
                    handoff_pack_id: r.get(4)?,
                    build_id: r.get(5)?,
                    acceptance_record_id: r.get(6)?,
                    note: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                })
            },
        )?;
        raw_to_link(conn, raw)
    })
}

pub fn dws_task_link_list_impl(
    db: &Db,
    project_id: &str,
    task_id: Option<String>,
) -> AppResult<Vec<DwsTaskLink>> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err(AppError::Validation("project_id 不能为空".into()));
    }
    let task_id = trim_optional(task_id);
    db.with_read(|conn| {
        ensure_development_project(conn, project_id, false)?;
        list_links_impl(conn, project_id, task_id.as_deref())
    })
}

pub fn dws_task_link_delete_impl(db: &Db, project_id: &str, link_id: &str) -> AppResult<()> {
    let project_id = project_id.trim();
    if project_id.is_empty() || link_id.trim().is_empty() {
        return Err(AppError::Validation("project_id 与 link_id 不能为空".into()));
    }
    db.with_conn(|conn| {
        ensure_development_project(conn, project_id, true)?;
        let deleted = conn.execute(
            "DELETE FROM dws_task_links WHERE id = ?1 AND project_id = ?2",
            params![link_id, project_id],
        )?;
        if deleted == 0 {
            return Err(AppError::NotFound(format!("关联不存在: {link_id}")));
        }
        Ok(())
    })
}

// ── E2：Agent 任务接续（交接包 / 轮次候选 / 验收记录）──────────────────

pub fn dws_task_handoff_impl(db: &Db, project_id: &str, task_id: &str) -> AppResult<DwsTaskHandoff> {
    let project_id = project_id.trim();
    let task_id = task_id.trim();
    if project_id.is_empty() {
        return Err(AppError::Validation("project_id 不能为空".into()));
    }
    if task_id.is_empty() {
        return Err(AppError::Validation("task_id 不能为空".into()));
    }
    // 门禁与任务标题先在自己的读连接上取；dev_workbench 实现内部另开读连接，
    // 不在本闭包内嵌套调用，避免内存库（无读池）重复锁写 mutex 自锁。
    let task_row: Option<(String, String)> = db.with_read(|conn| {
        ensure_development_project(conn, project_id, false)?;
        Ok(conn
            .query_row(
                "SELECT title, status FROM tasks WHERE id = ?1",
                params![task_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    })?;

    // 复用既有 dev_workbench 关联链：交接包、Agent 完成轮次候选、人工验收记录。
    let packs = dev::dev_handoff_list_impl(db, Some(task_id.to_string()), Some(50))?;
    let candidates = dev::dev_acceptance_agent_runs_impl(db, task_id.to_string(), Some(20))?;
    let records = dev::dev_acceptance_record_list_impl(
        db,
        Some("task".to_string()),
        Some(task_id.to_string()),
        Some(50),
    )?;
    let links = db.with_read(|conn| list_links_impl(conn, project_id, Some(task_id)))?;

    let latest_acceptance_verdict = records.first().map(|r| r.verdict.clone());
    let acceptance_record_count = records.len() as i64;
    let agent_self_reported_completed = !candidates.runs.is_empty();

    Ok(DwsTaskHandoff {
        task_id: task_id.to_string(),
        task_title: task_row.as_ref().map(|(t, _)| t.clone()),
        task_status: task_row.as_ref().map(|(_, s)| s.clone()),
        packs,
        agent_candidates: candidates.runs,
        acceptance_records: records,
        links,
        latest_acceptance_verdict,
        acceptance_record_count,
        agent_self_reported_completed,
    })
}

// ── E3：构建与验收追溯（只读解析集成台账）─────────────────────────────

fn resolve_ledger_dir(explicit: Option<String>) -> (Option<PathBuf>, Option<String>) {
    if let Some(dir) = trim_optional(explicit) {
        let p = PathBuf::from(&dir);
        if p.is_dir() {
            return (Some(p), None);
        }
        return (None, Some(format!("指定的台账目录不存在: {dir}")));
    }
    if let Some(dir) = std::env::var_os("TASK_DOCK_INTEGRATION_DIR") {
        let p = PathBuf::from(dir);
        if p.is_dir() {
            return (Some(p), None);
        }
    }
    let Ok(cwd) = std::env::current_dir() else {
        return (None, Some("无法确定当前工作目录".into()));
    };
    let mut cur: Option<&Path> = Some(&cwd);
    while let Some(dir) = cur {
        let candidate = dir.join("tmp").join("integration");
        if candidate.is_dir() {
            return (Some(candidate), None);
        }
        cur = dir.parent();
    }
    (None, Some("未找到集成台账目录（tmp/integration）".into()))
}

fn json_string(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

fn json_i64(v: &serde_json::Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64())
}

fn json_bool(v: &serde_json::Value, key: &str) -> Option<bool> {
    v.get(key).and_then(|x| x.as_bool())
}

fn read_json_file(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn parse_ledger_tasks(root: &Path) -> Vec<DwsLedgerTask> {
    let dir = root.join("tasks");
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Some(v) = read_json_file(&p) else { continue };
        let checks = v
            .get("checks")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|c| DwsLedgerCheck {
                        cmd: json_string(c, "cmd").unwrap_or_default(),
                        exit_code: json_i64(c, "exitCode"),
                        at: json_string(c, "at").unwrap_or_default(),
                        log_path: json_string(c, "logPath"),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let paths = v
            .get("paths")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        out.push(DwsLedgerTask {
            id: json_string(&v, "id").unwrap_or_default(),
            module: json_string(&v, "module").unwrap_or_default(),
            owner: json_string(&v, "owner").unwrap_or_default(),
            status: json_string(&v, "status").unwrap_or_default(),
            paths,
            snapshot: json_string(&v, "snapshot"),
            build_id: json_string(&v, "build"),
            acceptance: json_string(&v, "acceptance"),
            notes: json_string(&v, "notes").unwrap_or_default(),
            updated_at: json_string(&v, "updatedAt").unwrap_or_default(),
            checks,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

fn parse_ledger_snapshots(root: &Path) -> Vec<DwsLedgerSnapshot> {
    let dir = root.join("snapshots");
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Some(v) = read_json_file(&p) else { continue };
        let tasks = v
            .get("tasks")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        out.push(DwsLedgerSnapshot {
            id: json_string(&v, "id").unwrap_or_default(),
            branch: json_string(&v, "branch"),
            base: json_string(&v, "base"),
            commit: json_string(&v, "commit"),
            tasks,
            note: json_string(&v, "note").unwrap_or_default(),
            created_at: json_string(&v, "createdAt"),
        });
    }
    out
}

fn parse_ledger_builds(root: &Path) -> Vec<DwsLedgerBuild> {
    let dir = root.join("builds");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let d = e.path();
        if !d.is_dir() {
            continue;
        }
        let Some(v) = read_json_file(&d.join("build.json")) else { continue };
        let tasks = v
            .get("tasks")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let artifacts = v
            .get("artifacts")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|a| DwsLedgerArtifact {
                        name: json_string(a, "name").unwrap_or_default(),
                        kind: json_string(a, "kind").unwrap_or_default(),
                        files: json_i64(a, "files"),
                        bytes: json_i64(a, "bytes"),
                        sha256: json_string(a, "sha256"),
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.push(DwsLedgerBuild {
            id: json_string(&v, "id").unwrap_or_default(),
            snapshot: json_string(&v, "snapshot"),
            commit: json_string(&v, "commit"),
            short_commit: json_string(&v, "shortCommit"),
            dirty: json_bool(&v, "dirty"),
            platform: json_string(&v, "platform").unwrap_or_default(),
            config: json_string(&v, "config").unwrap_or_default(),
            status: json_string(&v, "status").unwrap_or_default(),
            exit_code: json_i64(&v, "exitCode"),
            started_at: json_string(&v, "startedAt"),
            finished_at: json_string(&v, "finishedAt"),
            duration_ms: json_i64(&v, "durationMs"),
            tasks,
            log_path: json_string(&v, "logPath"),
            artifacts,
            host: json_string(&v, "host").unwrap_or_default(),
        });
    }
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    out
}

pub fn dws_build_trace_impl(
    db: &Db,
    project_id: &str,
    ledger_dir: Option<String>,
) -> AppResult<DwsBuildTrace> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err(AppError::Validation("project_id 不能为空".into()));
    }
    let (ledger_root, ledger_reason) = resolve_ledger_dir(ledger_dir);

    let mut links: Vec<DwsTaskLink> = Vec::new();
    let mut trace_task_ids: Vec<String> = Vec::new();

    db.with_read(|conn| {
        ensure_development_project(conn, project_id, false)?;
        links = list_links_impl(conn, project_id, None)?;

        let mut stmt = conn.prepare(
            "SELECT task_id FROM workspace_task_links WHERE project_id = ?1",
        )?;
        let ws = stmt.query_map(params![project_id], |r| r.get::<_, String>(0))?;
        for w in ws {
            let tid = w.map_err(AppError::from)?;
            if !tid.is_empty() && !trace_task_ids.contains(&tid) {
                trace_task_ids.push(tid);
            }
        }
        for l in &links {
            if !l.task_id.is_empty() && !trace_task_ids.contains(&l.task_id) {
                trace_task_ids.push(l.task_id.clone());
            }
        }
        trace_task_ids.truncate(TRACE_TASK_CAP);
        Ok(())
    })?;

    let mut acceptance_records: Vec<dev::DevAcceptanceRecord> = Vec::new();
    for tid in &trace_task_ids {
        if let Ok(records) = dev::dev_acceptance_record_list_impl(
            db,
            Some("task".to_string()),
            Some(tid.clone()),
            Some(20),
        ) {
            acceptance_records.extend(records);
        }
    }
    acceptance_records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    acceptance_records.truncate(100);

    let (tasks, snapshots, builds) = match &ledger_root {
        Some(root) => (
            parse_ledger_tasks(root),
            parse_ledger_snapshots(root),
            parse_ledger_builds(root),
        ),
        None => (Vec::new(), Vec::new(), Vec::new()),
    };

    Ok(DwsBuildTrace {
        ledger_available: ledger_root.is_some(),
        ledger_root: ledger_root.map(|p| p.to_string_lossy().to_string()),
        ledger_reason,
        tasks,
        snapshots,
        builds,
        links,
        acceptance_records,
    })
}

// ── E4：Git / Worktree 风险探测（只读）─────────────────────────────────

/// 与 `DevGitStatus` 的 serde snake_case 序列化口径一致的状态码（落库留痕用）。
fn git_status_code(status: DevGitStatus) -> &'static str {
    match status {
        DevGitStatus::Ok => "ok",
        DevGitStatus::NotARepo => "not_a_repo",
        DevGitStatus::GitUnavailable => "git_unavailable",
        DevGitStatus::PathMissing => "path_missing",
    }
}

/// 有界只读执行 `git -C <root> <args>`；失败/超时返回 None，不 panic、不写仓库。
fn run_git_readonly(root: &str, args: &[&str]) -> Option<(bool, String)> {
    let mut cmd = crate::winproc::hidden("git");
    cmd.args(["-C", root]);
    cmd.args(args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let out = child.wait_with_output().ok()?;
                return Some((
                    out.status.success(),
                    String::from_utf8_lossy(&out.stdout).to_string(),
                ));
            }
            Ok(None) => {
                if started.elapsed() >= STEP_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// 剥离 git porcelain 对含特殊字符路径加的外层双引号（与 `devwork::git::unquote` 口径一致）。
fn unquote_git_path(raw: &str) -> String {
    let s = raw.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// 判定 porcelain XY 状态是否为未合并冲突：任一列为 `U`，或双方同改/同删（AA/DD）。
fn is_conflict_status(status: &str) -> bool {
    let mut chars = status.chars();
    let first = chars.next();
    let second = chars.next();
    matches!((first, second), (Some('U'), _) | (Some(_), Some('U')))
        || status == "AA"
        || status == "DD"
}

/// 解析 `git status --porcelain` 单行：XY 状态 + 路径（重命名取新路径）。
fn parse_porcelain_line(line: &str) -> Option<(String, String)> {
    let line = line.trim_end();
    if line.len() < 4 {
        return None;
    }
    let status = line[0..2].to_string();
    let path = line[3..].trim_start();
    // 重命名/复制：`old -> new`，只保留新路径。
    let path = match path.split_once(" -> ") {
        Some((_, new)) => unquote_git_path(new),
        None => unquote_git_path(path),
    };
    if path.is_empty() {
        return None;
    }
    Some((status, path))
}

fn top_group(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    match normalized.split('/').next() {
        Some(g) if !g.is_empty() => g.to_string(),
        _ => "/".to_string(),
    }
}

fn matches_public_file(path: &str) -> bool {
    let key = normalize_path_key(path);
    PUBLIC_FILE_PATHS.iter().any(|pub_path| {
        key == *pub_path || key.starts_with(&format!("{pub_path}/"))
    })
}

/// 台账任务声明路径与当前改动文件的重叠判定（双向前缀匹配）。
fn path_overlaps(declared: &str, changed: &str) -> bool {
    let d = normalize_path_key(declared);
    let c = normalize_path_key(changed);
    d == c || c.starts_with(&format!("{d}/")) || d.starts_with(&format!("{c}/"))
}

pub fn dws_git_risk_probe_impl(
    db: &Db,
    project_id: &str,
    ledger_dir: Option<String>,
) -> AppResult<DwsGitRisk> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err(AppError::Validation("project_id 不能为空".into()));
    }

    let summary = dws_development_summary_impl(db, project_id)?;
    let archived = summary.archived;

    // 台账任务声明路径（用于跨任务重叠提示；台账不可用时为空，不伪造重叠）。
    let ledger_tasks = match resolve_ledger_dir(ledger_dir) {
        (Some(root), _) => parse_ledger_tasks(&root),
        (None, _) => Vec::new(),
    };

    let mut repos: Vec<DwsRepoRisk> = Vec::new();
    let mut aggregated: Vec<DwsRiskFlag> = Vec::new();

    for repo in &summary.dev_projects {
        let mut risks: Vec<DwsRiskFlag> = Vec::new();
        let mut changed_files: Vec<DwsChangedFile> = Vec::new();
        let mut truncated = false;

        if !repo.exists {
            risks.push(DwsRiskFlag {
                level: "warn".into(),
                code: "path_missing".into(),
                message: "仓库目录已失效（被移动或删除），未读取到 Git 状态；请人工核对目录后再关联。".into(),
                files: vec![],
            });
        } else {
            let info = &repo.git;
            match info.status {
                DevGitStatus::NotARepo => {
                    risks.push(DwsRiskFlag {
                        level: "info".into(),
                        code: "not_a_repo".into(),
                        message: "该目录不是 Git 仓库，无分支 / 提交 / 改动可探测。".into(),
                        files: vec![],
                    });
                }
                DevGitStatus::GitUnavailable => {
                    risks.push(DwsRiskFlag {
                        level: "warn".into(),
                        code: "git_unavailable".into(),
                        message: "git 不可用或本次探测超时，未能判定仓库状态。".into(),
                        files: vec![],
                    });
                }
                DevGitStatus::PathMissing => {
                    risks.push(DwsRiskFlag {
                        level: "warn".into(),
                        code: "path_missing".into(),
                        message: "路径不可用，未能读取 Git 状态。".into(),
                        files: vec![],
                    });
                }
                DevGitStatus::Ok => {}
            }

            if info.detached {
                risks.push(DwsRiskFlag {
                    level: "warn".into(),
                    code: "detached_head".into(),
                    message: "当前处于 detached HEAD，提交不属于任何分支，人工合并前先确认落点。".into(),
                    files: vec![],
                });
            }
            if info.is_worktree {
                risks.push(DwsRiskFlag {
                    level: "info".into(),
                    code: "linked_worktree".into(),
                    message: format!(
                        "这是 linked worktree，主仓库：{}",
                        info.main_repo_path.as_deref().unwrap_or("未知")
                    ),
                    files: vec![],
                });
            }

            // 只读取改动文件清单（porcelain），限量聚合。
            if let Some((true, stdout)) =
                run_git_readonly(&repo.root_path, &["status", "--porcelain"])
            {
                for line in stdout.lines() {
                    if line.trim().is_empty() {
                        continue;
                    }
                    if changed_files.len() >= CHANGED_FILE_CAP {
                        truncated = true;
                        break;
                    }
                    if let Some((status, path)) = parse_porcelain_line(line) {
                        changed_files.push(DwsChangedFile {
                            path: path.clone(),
                            status,
                            group: top_group(&path),
                        });
                    }
                }
            }

            // 公共文件触碰风险。
            let public_touched: Vec<String> = changed_files
                .iter()
                .map(|f| f.path.clone())
                .filter(|p| matches_public_file(p))
                .collect();
            if !public_touched.is_empty() {
                risks.push(DwsRiskFlag {
                    level: "warn".into(),
                    code: "public_file_touch".into(),
                    message: "改动落在公共文件清单（bridge / 导航注册 / 全局样式 / 迁移与命令登记等），按 §3.2 必须串行协调，禁止并行覆盖。".into(),
                    files: public_touched,
                });
            }

            // 未解决的合并冲突（UU/AA/DD/AU/UA/DU/UD）：单独标记，文件清单随附。
            let conflict_files: Vec<String> = changed_files
                .iter()
                .filter(|f| is_conflict_status(&f.status))
                .map(|f| f.path.clone())
                .collect();
            if !conflict_files.is_empty() {
                risks.push(DwsRiskFlag {
                    level: "warn".into(),
                    code: "merge_conflict".into(),
                    message: "存在未解决的合并冲突，必须先人工解决冲突并确认文件所有权后再提交。".into(),
                    files: conflict_files,
                });
            }

            // 跨任务路径重叠（对照台账任务声明的写入范围）。
            let mut overlap_files: Vec<String> = Vec::new();
            let mut overlap_tasks: Vec<String> = Vec::new();
            for ledger_task in &ledger_tasks {
                let hit: Vec<String> = changed_files
                    .iter()
                    .map(|f| f.path.clone())
                    .filter(|p| {
                        ledger_task
                            .paths
                            .iter()
                            .any(|decl| path_overlaps(decl, p))
                    })
                    .collect();
                if !hit.is_empty() {
                    overlap_tasks.push(ledger_task.id.clone());
                    overlap_files.extend(hit);
                }
            }
            if !overlap_files.is_empty() {
                overlap_files.sort();
                overlap_files.dedup();
                risks.push(DwsRiskFlag {
                    level: "warn".into(),
                    code: "task_path_overlap".into(),
                    message: format!(
                        "当前改动与台账任务 [{}] 的声明写入范围重叠，存在并行改同一文件的冲突风险，请按唯一所有者串行处理。",
                        overlap_tasks.join(", ")
                    ),
                    files: overlap_files,
                });
            }

            let dirty = info.dirty_count.unwrap_or(0);
            if dirty > 0 {
                risks.push(DwsRiskFlag {
                    level: "info".into(),
                    code: "dirty_tree".into(),
                    message: format!("工作区有 {} 处未提交改动。", dirty),
                    files: vec![],
                });
            }
        }

        aggregated.extend(risks.iter().cloned());
        repos.push(DwsRepoRisk {
            dev_project_id: Some(repo.dev_project_id.clone()),
            name: repo.name.clone(),
            root_path: repo.root_path.clone(),
            exists: repo.exists,
            git: repo.git.clone(),
            changed_files,
            truncated,
            risks,
        });
    }

    let advice = "以上均为只读探测的事实提示；本工具不会自动执行 reset / stash / clean / checkout / merge / 强制推送。\n存在冲突或公共文件改动时，请人工确认文件所有权后再提交，多任务并行时按集成台账的声明路径串行叠加。"
        .to_string();

    // 本机瞬时快照：仅 active 项目落库；归档项目只当次返回，不写表。
    let persisted = if !archived {
        db.with_conn(|conn| {
            let id = uuid::Uuid::new_v4().to_string();
            let all_changed: Vec<&DwsChangedFile> =
                repos.iter().flat_map(|r| r.changed_files.iter()).collect();
            let changed_json =
                serde_json::to_string(&all_changed).unwrap_or_else(|_| "[]".into());
            let risks_json =
                serde_json::to_string(&aggregated).unwrap_or_else(|_| "{}".into());
            let first = repos.first();
            // 回收旧快照：每个项目只保留最近 PROBE_SNAPSHOT_KEEP 条，避免表无界增长。
            conn.execute(
                "DELETE FROM dws_workspace_probes
                 WHERE project_id = ?1
                   AND id NOT IN (
                     SELECT id FROM dws_workspace_probes
                     WHERE project_id = ?1
                     ORDER BY probed_at DESC, rowid DESC
                     LIMIT ?2
                 )",
                params![project_id, PROBE_SNAPSHOT_KEEP],
            )?;
            conn.execute(
                "INSERT INTO dws_workspace_probes
                 (id, project_id, probed_at, git_status, branch, detached, head_sha,
                  dirty_count, is_worktree, main_repo_path, changed_files_json, risks_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    id,
                    project_id,
                    now_iso(),
                    first
                        .map(|r| git_status_code(r.git.status).to_string())
                        .unwrap_or_default(),
                    first.and_then(|r| r.git.branch.clone()),
                    first.map(|r| r.git.detached as i64).unwrap_or(0),
                    first.and_then(|r| r.git.head_sha.clone()),
                    first.and_then(|r| r.git.dirty_count),
                    first.map(|r| r.git.is_worktree as i64).unwrap_or(0),
                    first.and_then(|r| r.git.main_repo_path.clone()),
                    changed_json,
                    risks_json
                ],
            )?;
            Ok::<_, AppError>(())
        })
        .is_ok()
    } else {
        false
    };

    Ok(DwsGitRisk {
        repos,
        risks: aggregated,
        advice,
        persisted,
    })
}

// ── Tauri 命令薄包装（参数名由前端 invoke 以 camelCase 传入）────────────

#[tauri::command]
pub fn dws_development_summary(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> AppResult<DwsSummaryOut> {
    Ok(DwsSummaryOut {
        summary: dws_development_summary_impl(&db, &project_id)?,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn dws_task_link_save(
    db: State<'_, Arc<Db>>,
    project_id: String,
    task_id: Option<String>,
    dev_project_id: Option<String>,
    handoff_pack_id: Option<String>,
    build_id: Option<String>,
    acceptance_record_id: Option<String>,
    note: Option<String>,
) -> AppResult<DwsLinkSaved> {
    Ok(DwsLinkSaved {
        link: dws_task_link_save_impl(
            &db,
            &project_id,
            task_id,
            dev_project_id,
            handoff_pack_id,
            build_id,
            acceptance_record_id,
            note,
        )?,
    })
}

#[tauri::command]
pub fn dws_task_link_list(
    db: State<'_, Arc<Db>>,
    project_id: String,
    task_id: Option<String>,
) -> AppResult<DwsLinkList> {
    Ok(DwsLinkList {
        links: dws_task_link_list_impl(&db, &project_id, task_id)?,
    })
}

#[tauri::command]
pub fn dws_task_link_delete(
    db: State<'_, Arc<Db>>,
    project_id: String,
    link_id: String,
) -> AppResult<DwsOk> {
    dws_task_link_delete_impl(&db, &project_id, &link_id)?;
    Ok(DwsOk { ok: true })
}

#[tauri::command]
pub fn dws_task_handoff(
    db: State<'_, Arc<Db>>,
    project_id: String,
    task_id: String,
) -> AppResult<DwsHandoffOut> {
    Ok(DwsHandoffOut {
        handoff: dws_task_handoff_impl(&db, &project_id, &task_id)?,
    })
}

#[tauri::command]
pub fn dws_build_trace(
    db: State<'_, Arc<Db>>,
    project_id: String,
    ledger_dir: Option<String>,
) -> AppResult<DwsTraceOut> {
    Ok(DwsTraceOut {
        trace: dws_build_trace_impl(&db, &project_id, ledger_dir)?,
    })
}

#[tauri::command]
pub fn dws_git_risk_probe(
    db: State<'_, Arc<Db>>,
    project_id: String,
    ledger_dir: Option<String>,
) -> AppResult<DwsRiskOut> {
    Ok(DwsRiskOut {
        risk: dws_git_risk_probe_impl(&db, &project_id, ledger_dir)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use std::process::Command;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "td-dws-{}-{}",
            name,
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn require_git() -> bool {
        match Command::new("git").arg("--version").output() {
            Ok(out) if out.status.success() => true,
            _ => {
                println!("SKIPPED: git 不可用，跳过真实 Git 夹具测试");
                false
            }
        }
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {:?} 失败: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// 种子：一个 active 开发项目 + 一个归档开发项目 + 一个非开发项目 + 任务 + 仓库。
    fn seed_projects(db: &Db, now: &str) -> (String, String, String, String) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspace_projects (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at)
                 VALUES ('proj-a', '开发 A', 'development', 'active', '', NULL, '', ?1, ?1)",
                [now],
            ).map_err(AppError::from)?;
            conn.execute(
                "INSERT INTO workspace_projects (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at)
                 VALUES ('proj-arch', '归档开发', 'development', 'archived', '', NULL, '', ?1, ?1)",
                [now],
            ).map_err(AppError::from)?;
            conn.execute(
                "INSERT INTO workspace_projects (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at)
                 VALUES ('proj-game', '游戏 B', 'game', 'active', '', NULL, '', ?1, ?1)",
                [now],
            ).map_err(AppError::from)?;
            conn.execute(
                "INSERT INTO dev_projects (id, name, root_path, note, created_at, updated_at)
                 VALUES ('dev-1', '主仓库', '', '', ?1, ?1)",
                [now],
            ).map_err(AppError::from)?;
            conn.execute(
                "INSERT INTO tasks (id, title, status, priority, created_at, updated_at)
                 VALUES ('task-1', '实现接续链路', 'pending', 2, ?1, ?1)",
                [now],
            ).map_err(AppError::from)?;
            conn.execute(
                "INSERT INTO workspace_task_links (project_id, task_id, created_at)
                 VALUES ('proj-a', 'task-1', ?1)",
                [now],
            ).map_err(AppError::from)?;
            Ok::<_, AppError>(())
        }).unwrap();
        (
            "proj-a".into(),
            "proj-arch".into(),
            "proj-game".into(),
            "dev-1".into(),
        )
    }

    #[test]
    fn summary_gates_kind_and_lists_links_without_cross_project_leak() {
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        let (pa, _parch, pg, _dev) = seed_projects(&db, &now);

        let summary = dws_development_summary_impl(&db, &pa).unwrap();
        assert_eq!(summary.project_name, "开发 A");
        assert!(!summary.archived);
        assert_eq!(summary.tasks.len(), 1);
        assert_eq!(summary.tasks[0].task_id, "task-1");
        assert_eq!(summary.tasks[0].link_origin, "workspace_link");

        // 非开发项目 → Validation
        let err = dws_development_summary_impl(&db, &pg).unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");
        // 不存在 → NotFound
        let err = dws_development_summary_impl(&db, "missing").unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");

        // 手工关联写入后任务已在既有关联中，不重复出两行
        dws_task_link_save_impl(
            &db,
            &pa,
            Some("task-1".into()),
            None,
            None,
            None,
            None,
            Some("备注".into()),
        )
        .unwrap();
        let again = dws_development_summary_impl(&db, &pa).unwrap();
        assert_eq!(again.tasks.len(), 1);

        // 归档项目可读
        let archived = dws_development_summary_impl(&db, "proj-arch").unwrap();
        assert!(archived.archived);
    }

    #[test]
    fn link_save_validates_refs_gates_archived_and_non_development() {
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        let (pa, parch, pg, dev) = seed_projects(&db, &now);

        // 空关联拒绝
        let err =
            dws_task_link_save_impl(&db, &pa, None, None, None, None, None, None).unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");

        // 不存在的 dev_project → NotFound
        let err = dws_task_link_save_impl(
            &db,
            &pa,
            None,
            Some("no-such-dev".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");

        // 合法手工关联（挂到真实 dev_project）
        let link = dws_task_link_save_impl(
            &db,
            &pa,
            Some("task-1".into()),
            Some(dev.clone()),
            None,
            None,
            None,
            Some("跟进".into()),
        )
        .unwrap();
        assert_eq!(link.task_id, "task-1");
        assert_eq!(link.dev_project_name.as_deref(), Some("主仓库"));
        assert_eq!(link.task_title.as_deref(), Some("实现接续链路"));

        // 幂等：同键再写不重复
        let again = dws_task_link_save_impl(
            &db,
            &pa,
            Some("task-1".into()),
            Some(dev.clone()),
            None,
            None,
            None,
            Some("更新".into()),
        )
        .unwrap();
        assert_eq!(again.id, link.id);
        assert_eq!(again.note, "更新");
        let list = dws_task_link_list_impl(&db, &pa, None).unwrap();
        assert_eq!(list.len(), 1);

        // 归档项目写入拒绝
        let err = dws_task_link_save_impl(
            &db,
            &parch,
            Some("task-1".into()),
            Some(dev.clone()),
            None,
            None,
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");
        // 非开发项目写入拒绝
        let err =
            dws_task_link_save_impl(&db, &pg, Some("task-1".into()), None, None, None, None, None)
                .unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");

        // 删除：归属校验
        dws_task_link_delete_impl(&db, &pa, &link.id).unwrap();
        let err = dws_task_link_delete_impl(&db, &pa, &link.id).unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn handoff_distinguishes_agent_self_report_from_acceptance_verdict() {
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        let (pa, _parch, _pg, _dev) = seed_projects(&db, &now);

        // 先无验收记录、无完成轮次：latest verdict 为 None，不得伪造通过。
        let view = dws_task_handoff_impl(&db, &pa, "task-1").unwrap();
        assert!(view.latest_acceptance_verdict.is_none());
        assert_eq!(view.acceptance_record_count, 0);
        assert!(!view.agent_self_reported_completed);

        // 人工登记一条 fail 验收记录（只追加）
        dev::dev_acceptance_record_create_impl(
            &db,
            "task".into(),
            "task-1".into(),
            "fail".into(),
            "返工".into(),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let after = dws_task_handoff_impl(&db, &pa, "task-1").unwrap();
        assert_eq!(after.latest_acceptance_verdict.as_deref(), Some("fail"));
        assert_eq!(after.acceptance_records.len(), 1);
        // Agent 自述完成标志仍只取决于真实轮次候选，与验收记录无关。
        assert!(!after.agent_self_reported_completed);

        // 非本类型项目拒绝
        let err = dws_task_handoff_impl(&db, "proj-game", "task-1").unwrap_err();
        assert_eq!(err.code(), "VALIDATION_ERROR");
    }

    #[test]
    fn build_trace_parses_ledger_and_reports_unavailable_when_missing() {
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        let (pa, _parch, _pg, _dev) = seed_projects(&db, &now);

        // 显式指向不存在目录 → unavailable，不报错崩溃。
        let missing = dws_build_trace_impl(&db, &pa, Some("Z:/no/such/ledger-xyz".into())).unwrap();
        assert!(!missing.ledger_available);
        assert!(missing.ledger_reason.is_some());
        assert!(missing.builds.is_empty());

        // 构造临时台账目录。
        let root = temp_dir("ledger");
        std::fs::create_dir_all(root.join("tasks")).unwrap();
        std::fs::create_dir_all(root.join("snapshots")).unwrap();
        std::fs::create_dir_all(root.join("builds").join("b-demo-r1")).unwrap();
        std::fs::write(
            root.join("tasks").join("task-demo.json"),
            r#"{"id":"task-demo","module":"src/x","owner":"agent","status":"ready",
               "paths":["src/x/a.ts"],"snapshot":"snap-1","build":"b-demo-r1",
               "acceptance":null,"notes":"n","updatedAt":"2026-11-16T00:00:00Z",
               "checks":[{"cmd":"npx tsc","exitCode":0,"at":"2026-11-16T00:01:00Z","logPath":null}]}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("snapshots").join("snap-1.json"),
            r#"{"id":"snap-1","branch":"integration","base":"aaa","commit":"bbb","tasks":["task-demo"],"note":"基线","createdAt":"2026-11-16T00:00:00Z"}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("builds").join("b-demo-r1").join("build.json"),
            r#"{"id":"b-demo-r1","snapshot":"snap-1","commit":"bbb","shortCommit":"bbb","dirty":false,
               "platform":"web","config":"frontend-dist","status":"succeeded","exitCode":0,
               "startedAt":"2026-11-16T00:00:00Z","finishedAt":"2026-11-05T00:05:00Z","durationMs":30000,
               "tasks":["task-demo"],"logPath":"tmp/integration/builds/b-demo-r1/build.log",
               "artifacts":[{"name":"dist","kind":"dir","files":10,"bytes":1234,"sha256":"abc"}],
               "host":"win32-x64"}"#,
        )
        .unwrap();

        let trace = dws_build_trace_impl(&db, &pa, Some(root.to_string_lossy().to_string())).unwrap();
        assert!(trace.ledger_available);
        assert_eq!(trace.tasks.len(), 1);
        assert_eq!(trace.tasks[0].checks[0].exit_code, Some(0));
        assert_eq!(trace.snapshots.len(), 1);
        assert_eq!(trace.builds.len(), 1);
        assert_eq!(trace.builds[0].status, "succeeded");
        assert_eq!(trace.builds[0].artifacts[0].sha256.as_deref(), Some("abc"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn git_risk_probe_reads_real_repo_files_flags_public_touch_and_degrades_non_repo() {
        if !require_git() {
            return;
        }
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        let (pa, _parch, _pg, _dev) = seed_projects(&db, &now);

        // 真实 Git 仓库夹具：init + 初始提交。
        let repo = temp_dir("repo");
        git_in(&repo, &["init", "-q"]);
        std::fs::write(repo.join("README.md"), "init\n").unwrap();
        git_in(&repo, &["add", "."]);
        git_in(&repo, &["commit", "-q", "-m", "init"]);
        // 改动：一个公共文件（未跟踪）+ 一个普通文件（修改）。
        std::fs::create_dir_all(repo.join("src").join("lib")).unwrap();
        std::fs::write(repo.join("src").join("lib").join("bridge.ts"), "// touched\n").unwrap();
        std::fs::write(repo.join("README.md"), "modified\n").unwrap();

        // dev_projects 指向真实仓库目录。
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE dev_projects SET root_path = ?1 WHERE id = 'dev-1'",
                [repo.to_string_lossy().to_string()],
            )
            .map_err(AppError::from)?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        dws_task_link_save_impl(
            &db,
            &pa,
            Some("task-1".into()),
            Some("dev-1".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let risk = dws_git_risk_probe_impl(&db, &pa, None).unwrap();
        assert_eq!(risk.repos.len(), 1);
        let repo_risk = &risk.repos[0];
        assert!(repo_risk.exists);
        assert_eq!(repo_risk.git.status, DevGitStatus::Ok);
        assert!(repo_risk.git.branch.is_some());
        assert!(repo_risk.changed_files.len() >= 2);
        let codes: Vec<&str> = repo_risk.risks.iter().map(|r| r.code.as_str()).collect();
        assert!(
            codes.contains(&"public_file_touch"),
            "公共文件改动必须被标记: {codes:?}"
        );
        assert!(risk.persisted, "active 项目应落瞬时快照");

        // 非 Git 目录：降级 not_a_repo，不崩溃。
        let plain = temp_dir("plain");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE dev_projects SET root_path = ?1 WHERE id = 'dev-1'",
                [plain.to_string_lossy().to_string()],
            )
            .map_err(AppError::from)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let degraded = dws_git_risk_probe_impl(&db, &pa, None).unwrap();
        assert_eq!(
            degraded.repos[0].git.status,
            DevGitStatus::NotARepo
        );
        assert!(degraded.repos[0].risks.iter().any(|r| r.code == "not_a_repo"));

        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&plain);
    }

    #[test]
    fn probe_overlap_detects_two_tasks_touching_same_file() {
        if !require_git() {
            return;
        }
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        let (pa, _parch, _pg, _dev) = seed_projects(&db, &now);

        let repo = temp_dir("overlap");
        git_in(&repo, &["init", "-q"]);
        std::fs::write(repo.join("shared.ts"), "v1\n").unwrap();
        git_in(&repo, &["add", "."]);
        git_in(&repo, &["commit", "-q", "-m", "init"]);
        std::fs::write(repo.join("shared.ts"), "v2\n").unwrap();

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE dev_projects SET root_path = ?1 WHERE id = 'dev-1'",
                [repo.to_string_lossy().to_string()],
            )
            .map_err(AppError::from)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        dws_task_link_save_impl(
            &db,
            &pa,
            Some("task-1".into()),
            Some("dev-1".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();

        // 台账里另一个任务声明写 shared.ts → 重叠风险。
        let ledger = temp_dir("ledger-overlap");
        std::fs::create_dir_all(ledger.join("tasks")).unwrap();
        std::fs::write(
            ledger.join("tasks").join("other.json"),
            r#"{"id":"task-other","module":"x","owner":"a","status":"developing",
               "paths":["shared.ts"],"updatedAt":"2026-11-16T00:00:00Z","checks":[]}"#,
        )
        .unwrap();

        let risk =
            dws_git_risk_probe_impl(&db, &pa, Some(ledger.to_string_lossy().to_string())).unwrap();
        let codes: Vec<&str> = risk.repos[0].risks.iter().map(|r| r.code.as_str()).collect();
        assert!(
            codes.contains(&"task_path_overlap"),
            "跨任务同文件必须报重叠: {codes:?}"
        );

        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&ledger);
    }

    #[test]
    fn probe_flags_detached_head_and_linked_worktree() {
        if !require_git() {
            return;
        }
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        let (pa, _parch, _pg, _dev) = seed_projects(&db, &now);

        let repo = temp_dir("detached");
        git_in(&repo, &["init", "-q"]);
        std::fs::write(repo.join("a.txt"), "v1\n").unwrap();
        git_in(&repo, &["add", "."]);
        git_in(&repo, &["commit", "-q", "-m", "c1"]);
        std::fs::write(repo.join("a.txt"), "v2\n").unwrap();
        git_in(&repo, &["add", "."]);
        git_in(&repo, &["commit", "-q", "-m", "c2"]);
        // detached 到前一个提交。
        git_in(&repo, &["checkout", "-q", "--detach", "HEAD~1"]);

        let linked = temp_dir("linked");
        let linked_path = linked.to_string_lossy().into_owned();
        git_in(&repo, &["worktree", "add", "-q", linked_path.as_str(), "-b", "feature"]);

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE dev_projects SET root_path = ?1 WHERE id = 'dev-1'",
                [repo.to_string_lossy().to_string()],
            )
            .map_err(AppError::from)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        dws_task_link_save_impl(
            &db,
            &pa,
            Some("task-1".into()),
            Some("dev-1".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let main_risk = dws_git_risk_probe_impl(&db, &pa, None).unwrap();
        let main = &main_risk.repos[0];
        assert!(main.git.detached, "detached HEAD 必须如实标记");
        assert!(main.git.branch.is_none());
        assert!(main.risks.iter().any(|r| r.code == "detached_head"));

        // linked worktree 视角：is_worktree=true，主仓库路径可追溯。
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE dev_projects SET root_path = ?1 WHERE id = 'dev-1'",
                [linked.to_string_lossy().to_string()],
            )
            .map_err(AppError::from)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let linked_risk = dws_git_risk_probe_impl(&db, &pa, None).unwrap();
        let linked_repo = &linked_risk.repos[0];
        assert!(linked_repo.git.is_worktree);
        assert!(linked_repo.git.main_repo_path.is_some());
        assert!(linked_repo.risks.iter().any(|r| r.code == "linked_worktree"));

        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(&linked);
    }

    #[test]
    fn probe_flags_unresolved_merge_conflict() {
        if !require_git() {
            return;
        }
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        let (pa, _parch, _pg, _dev) = seed_projects(&db, &now);

        let repo = temp_dir("conflict");
        git_in(&repo, &["init", "-q"]);
        std::fs::write(repo.join("a.txt"), "base\n").unwrap();
        git_in(&repo, &["add", "."]);
        git_in(&repo, &["commit", "-q", "-m", "c1"]);
        git_in(&repo, &["checkout", "-q", "-b", "side"]);
        std::fs::write(repo.join("a.txt"), "side version\n").unwrap();
        git_in(&repo, &["add", "."]);
        git_in(&repo, &["commit", "-q", "-m", "side"]);
        git_in(&repo, &["checkout", "-q", "master"]);
        std::fs::write(repo.join("a.txt"), "main version\n").unwrap();
        git_in(&repo, &["add", "."]);
        git_in(&repo, &["commit", "-q", "-m", "main"]);
        // 合并必然冲突（退出码 1），这是预期形态，不作为失败。
        let merge = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["merge", "-q", "side"])
            .output()
            .expect("spawn git merge");
        assert!(!merge.status.success(), "本夹具必须产生冲突");

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE dev_projects SET root_path = ?1 WHERE id = 'dev-1'",
                [repo.to_string_lossy().to_string()],
            )
            .map_err(AppError::from)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        dws_task_link_save_impl(
            &db,
            &pa,
            Some("task-1".into()),
            Some("dev-1".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let risk = dws_git_risk_probe_impl(&db, &pa, None).unwrap();
        let repo_risk = &risk.repos[0];
        let conflict = repo_risk
            .risks
            .iter()
            .find(|r| r.code == "merge_conflict")
            .expect("冲突文件必须报 merge_conflict");
        assert!(conflict.files.iter().any(|f| f == "a.txt"));
        assert!(repo_risk
            .changed_files
            .iter()
            .any(|f| f.status == "UU" && f.path == "a.txt"));

        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn probe_degrades_missing_path_without_panic() {
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        let (pa, _parch, _pg, _dev) = seed_projects(&db, &now);

        let gone = std::env::temp_dir().join(format!("td-dws-gone-{}", uuid::Uuid::new_v4().simple()));
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE dev_projects SET root_path = ?1 WHERE id = 'dev-1'",
                [gone.to_string_lossy().to_string()],
            )
            .map_err(AppError::from)?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let risk = dws_git_risk_probe_impl(&db, &pa, None).unwrap();
        let repo_risk = &risk.repos[0];
        assert!(!repo_risk.exists);
        assert_eq!(repo_risk.git.status, DevGitStatus::PathMissing);
        assert!(repo_risk.risks.iter().any(|r| r.code == "path_missing"));
    }
}
