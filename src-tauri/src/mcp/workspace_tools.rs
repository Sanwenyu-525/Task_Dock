//! 文件工作区只读 MCP 工具。
//!
//! 安全模型（三层，缺一不可）：
//! 1. 能力层：`workspace.read` 全局能力；
//! 2. 范围层：用户显式授予的工作区根目录（`mcp_workspace_roots`）；
//! 3. 路径层：词法规范化 → `canonicalize`（解析软链接/Junction）→ 组件级前缀
//!    比较，三者都必须在根目录内。任一失败即拒绝，不提供任意路径读取。
//!
//! 额外防线：拒绝 UNC/网络共享与设备路径；拒绝 `.git` / `.ssh` / `.gnupg`
//! 目录与常见凭据文件名；文本按 NUL 字节判二进制，单次最多 1 MiB；搜索有
//! 深度、条目与耗时上限，不跟随目录软链接。本轮不提供删除/写入类工具。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::mcp::permissions::{self, Capability};
use crate::mcp::tools::{arg_str, outcome, require_str, schema, CallOutcome, ToolCtx, ToolDef, ToolError};

const MAX_READ_BYTES: usize = 1024 * 1024;
const SEARCH_MAX_DEPTH: usize = 8;
const SEARCH_MAX_ENTRIES: usize = 5000;
const SEARCH_MAX_MILLIS: u64 = 3000;

pub(crate) fn defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "taskdock_list_workspace_roots",
            description: "列出用户已授权给本 Agent 的文件工作区根目录。未授权时返回空列表。",
            input_schema: schema(json!({}), &[]),
            write: false,
        },
        ToolDef {
            name: "taskdock_list_workspace_dir",
            description: "列出已授权工作区内某个目录的条目（只读，分页）。路径必须位于已授权根目录内。",
            input_schema: schema(
                json!({
                    "path": { "type": "string", "description": "绝对路径，必须位于已授权根目录内" },
                    "show_hidden": { "type": "boolean", "description": "默认 false" },
                    "offset": { "type": "integer", "minimum": 0 }
                }),
                &["path"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_stat_workspace_path",
            description: "读取已授权工作区内文件/目录的元信息（大小、时间、只读、隐藏）。",
            input_schema: schema(json!({ "path": { "type": "string" } }), &["path"]),
            write: false,
        },
        ToolDef {
            name: "taskdock_search_workspace_files",
            description: "在已授权工作区内按文件名搜索（有深度/条目/耗时上限，跳过 .git、node_modules 等）。",
            input_schema: schema(
                json!({
                    "query": { "type": "string", "maxLength": 200 },
                    "root_path": { "type": "string", "description": "可选：限定到某个已授权根目录" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
                }),
                &["query"],
            ),
            write: false,
        },
        ToolDef {
            name: "taskdock_read_workspace_text",
            description: "读取已授权工作区内文本文件内容（UTF-8；二进制拒绝；单次最多 1 MiB，超出截断）。",
            input_schema: schema(
                json!({
                    "path": { "type": "string" },
                    "max_bytes": { "type": "integer", "minimum": 16384, "maximum": 1048576 }
                }),
                &["path"],
            ),
            write: false,
        },
    ]
}

fn tool_err(error: AppError) -> ToolError {
    match error {
        AppError::PermissionRequired(message) => ToolError::Authz(message),
        other => ToolError::Failed(other),
    }
}

fn ensure_workspace_capability(ctx: &ToolCtx, conn: &Connection) -> AppResult<()> {
    let ok = permissions::has_global(conn, &ctx.agent.row_id, Capability::WorkspaceRead)?;
    if ok {
        Ok(())
    } else {
        Err(AppError::PermissionRequired(
            "未授权 workspace.read 能力（需要用户在 MCP 设置中启用文件工作区读取）".into(),
        ))
    }
}

fn reject_network_path(raw: &str) -> AppResult<()> {
    let trimmed = raw.trim();
    if trimmed.starts_with("\\\\") || trimmed.starts_with("//") {
        return Err(AppError::Validation(
            "不支持网络共享路径（UNC）".into(),
        ));
    }
    Ok(())
}

fn exists(path: &Path) -> AppResult<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// 解析并校验路径：必须存在、必须位于已授权根目录内（真实路径）。
fn resolve_authorized(
    conn: &Connection,
    agent_row_id: &str,
    raw: &str,
) -> AppResult<(PathBuf, PathBuf)> {
    reject_network_path(raw)?;
    let lexical = crate::file_workspace::validate_abs_path(raw)?;
    if !exists(&lexical)? {
        return Err(AppError::NotFound(format!(
            "路径不存在: {}",
            lexical.to_string_lossy()
        )));
    }
    let canonical = std::fs::canonicalize(&lexical).map_err(|e| {
        AppError::NotFound(format!(
            "路径不可访问: {}（{e}）",
            lexical.to_string_lossy()
        ))
    })?;
    let root = permissions::root_containing(conn, agent_row_id, &canonical)?.ok_or_else(|| {
        AppError::PermissionRequired(format!(
            "路径不在已授权工作区根目录内: {}",
            canonical.to_string_lossy()
        ))
    })?;
    if !canonical.starts_with(&root) {
        return Err(AppError::PermissionRequired(
            "路径经软链接/Junction 解析后越出授权根目录，已拒绝".into(),
        ));
    }
    Ok((canonical, root))
}

fn denied_component(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        ".git"
            | ".ssh"
            | ".gnupg"
            | ".aws"
            | ".azure"
            | ".kube"
            | "$recycle.bin"
            | "system volume information"
            | "node_modules"
            | "target"
            | ".next"
            | ".cache"
    )
}

fn denied_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower == ".env" || lower.starts_with(".env.") {
        return true;
    }
    let ext = lower.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    matches!(ext, "pem" | "key" | "pfx" | "p12" | "kdbx" | "jks" | "keystore" | "ovpn")
        || matches!(
            lower.as_str(),
            "id_rsa"
                | "id_dsa"
                | "id_ecdsa"
                | "id_ed25519"
                | "credentials"
                | ".npmrc"
                | ".netrc"
                | ".pgpass"
        )
}

fn modified_ms(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

pub(crate) fn call(
    ctx: &ToolCtx,
    name: &str,
    args: &Value,
    _write_conn: Option<&Connection>,
) -> Result<Option<CallOutcome>, ToolError> {
    match name {
        "taskdock_list_workspace_roots" => {
            let roots = ctx
                .db
                .with_read(|conn| {
                    if !permissions::has_global(
                        conn,
                        &ctx.agent.row_id,
                        Capability::WorkspaceRead,
                    )? {
                        return Ok(Vec::new());
                    }
                    permissions::list_roots_in_conn(conn, &ctx.agent.row_id)
                })
                .map_err(ToolError::Failed)?;
            let value = serde_json::to_value(roots).map_err(AppError::from)?;
            Ok(Some(outcome(value, "workspace_root", String::new(), None)))
        }
        "taskdock_list_workspace_dir" => {
            let raw = require_str(args, "path")?;
            let show_hidden = args
                .get("show_hidden")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let (path, _root) = ctx
                .db
                .with_read(|conn| {
                    ensure_workspace_capability(ctx, conn)?;
                    resolve_authorized(conn, &ctx.agent.row_id, &raw)
                })
                .map_err(tool_err)?;
            let listing = crate::file_workspace::list_dir(&path, show_hidden, offset)
                .map_err(ToolError::Failed)?;
            let value = serde_json::to_value(listing).map_err(AppError::from)?;
            Ok(Some(outcome(
                value,
                "workspace_path",
                path.to_string_lossy().to_string(),
                None,
            )))
        }
        "taskdock_stat_workspace_path" => {
            let raw = require_str(args, "path")?;
            let (path, _root) = ctx
                .db
                .with_read(|conn| {
                    ensure_workspace_capability(ctx, conn)?;
                    resolve_authorized(conn, &ctx.agent.row_id, &raw)
                })
                .map_err(tool_err)?;
            let stat = crate::file_workspace::stat_path(&path.to_string_lossy());
            let value = serde_json::to_value(stat).map_err(AppError::from)?;
            Ok(Some(outcome(
                value,
                "workspace_path",
                path.to_string_lossy().to_string(),
                None,
            )))
        }
        "taskdock_search_workspace_files" => {
            let query = require_str(args, "query")?;
            if query.chars().count() < 2 {
                return Err(ToolError::Failed(AppError::Validation(
                    "搜索关键词至少 2 个字符".into(),
                )));
            }
            let limit = args
                .get("limit")
                .and_then(|v| v.as_u64())
                .map(|v| v.clamp(1, 100) as usize)
                .unwrap_or(20);
            let root_path = arg_str(args, "root_path").map(str::to_string);
            let roots = ctx
                .db
                .with_read(|conn| {
                    ensure_workspace_capability(ctx, conn)?;
                    let all = permissions::list_roots_in_conn(conn, &ctx.agent.row_id)?;
                    match &root_path {
                        None => Ok(all),
                        Some(raw) => {
                            reject_network_path(raw)?;
                            let lexical = crate::file_workspace::validate_abs_path(raw)?;
                            let canonical = std::fs::canonicalize(&lexical).map_err(|_| {
                                AppError::NotFound(format!(
                                    "根目录不可访问: {}",
                                    lexical.to_string_lossy()
                                ))
                            })?;
                            let matched = all
                                .into_iter()
                                .filter(|r| Path::new(&r.root_path) == canonical.as_path())
                                .collect::<Vec<_>>();
                            if matched.is_empty() {
                                return Err(AppError::PermissionRequired(
                                    "指定目录不是已授权的工作区根目录".into(),
                                ));
                            }
                            Ok(matched)
                        }
                    }
                })
                .map_err(tool_err)?;
            let needle = query.to_lowercase();
            let started = Instant::now();
            let mut hits: Vec<Value> = Vec::new();
            let mut scanned = 0usize;
            let mut truncated = false;
            'roots: for root in roots {
                let root_path = PathBuf::from(&root.root_path);
                let mut stack = vec![(root_path.clone(), 0usize)];
                while let Some((dir, depth)) = stack.pop() {
                    if depth > SEARCH_MAX_DEPTH {
                        truncated = true;
                        continue;
                    }
                    let Ok(reader) = std::fs::read_dir(&dir) else {
                        continue;
                    };
                    for entry in reader.flatten() {
                        if scanned >= SEARCH_MAX_ENTRIES
                            || started.elapsed() > Duration::from_millis(SEARCH_MAX_MILLIS)
                        {
                            truncated = true;
                            break 'roots;
                        }
                        scanned += 1;
                        let file_name = entry.file_name().to_string_lossy().to_string();
                        if denied_component(&file_name) || denied_file_name(&file_name) {
                            continue;
                        }
                        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                            continue;
                        };
                        let is_symlink = meta.file_type().is_symlink();
                        if meta.is_dir() {
                            if !is_symlink {
                                stack.push((entry.path(), depth + 1));
                            }
                            if file_name.to_lowercase().contains(&needle) {
                                hits.push(json!({
                                    "path": entry.path().to_string_lossy(),
                                    "root": root.root_path,
                                    "kind": "dir",
                                }));
                            }
                        } else if file_name.to_lowercase().contains(&needle) {
                            hits.push(json!({
                                "path": entry.path().to_string_lossy(),
                                "root": root.root_path,
                                "kind": "file",
                                "size": meta.len(),
                                "modifiedMs": modified_ms(&meta),
                            }));
                        }
                        if hits.len() >= limit {
                            truncated = true;
                            break 'roots;
                        }
                    }
                }
            }
            let value = json!({
                "query": query,
                "hits": hits,
                "scannedEntries": scanned,
                "truncated": truncated,
                "limits": {
                    "maxDepth": SEARCH_MAX_DEPTH,
                    "maxEntries": SEARCH_MAX_ENTRIES,
                    "maxMillis": SEARCH_MAX_MILLIS,
                },
            });
            Ok(Some(outcome(value, "workspace_search", query, None)))
        }
        "taskdock_read_workspace_text" => {
            let raw = require_str(args, "path")?;
            let max_bytes = args
                .get("max_bytes")
                .and_then(|v| v.as_u64())
                .map(|v| (v as usize).clamp(16 * 1024, MAX_READ_BYTES))
                .unwrap_or(256 * 1024);
            let (path, _root) = ctx
                .db
                .with_read(|conn| {
                    ensure_workspace_capability(ctx, conn)?;
                    resolve_authorized(conn, &ctx.agent.row_id, &raw)
                })
                .map_err(tool_err)?;
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if denied_file_name(&name) {
                return Err(ToolError::Authz(format!("拒绝读取敏感文件: {name}")));
            }
            if path
                .components()
                .any(|c| denied_component(&c.as_os_str().to_string_lossy()))
            {
                return Err(ToolError::Authz("路径包含受保护目录，已拒绝读取".into()));
            }
            let meta = std::fs::metadata(&path)
                .map_err(|e| AppError::NotFound(format!("文件不可读: {e}")))?;
            if !meta.is_file() {
                return Err(ToolError::Failed(AppError::Validation(
                    "仅支持读取单个文件".into(),
                )));
            }
            if meta.len() as usize > MAX_READ_BYTES {
                return Err(ToolError::Failed(AppError::Validation(format!(
                    "文件超过 1 MiB 上限（{} 字节），请缩小范围或使用其他工具",
                    meta.len()
                ))));
            }
            let preview = crate::file_workspace::read_text_preview(&path, max_bytes)
                .map_err(ToolError::Failed)?;
            let value = json!({
                "path": path.to_string_lossy(),
                "size": preview.size,
                "truncated": preview.truncated,
                "content": preview.content,
            });
            Ok(Some(outcome(
                value,
                "workspace_file",
                path.to_string_lossy().to_string(),
                None,
            )))
        }
        _ => Ok(None),
    }
}
