//! Task Dock CLI：`taskdock` 独立可执行入口。
//!
//! 设计要点：
//! - 直接打开同一 SQLite 数据库，走统一 service 层，不需要 UI 打开任何页面；
//! - 没有 `TASKDOCK_AGENT_TOKEN` 时等价本机用户（可读写，审计 actor_kind=local）；
//!   设置该环境变量则按 Agent scope/能力授权，`TASKDOCK_CLI_READONLY=1` 强制只读；
//! - `--json` 时 stdout 只有统一信封；诊断与提示写 stderr；
//! - 退出码由错误码映射（0 成功 / 2 用法 / 3 未找到 / 4 校验 / 5 冲突 / 6 权限 / 7 不可用 / 8 其他）。

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::auth as mcp_auth;
use crate::mcp::permissions::Capability;

use super::{
    context, error_code, handoff, permissions as perms, projection, service, store,
    sync as file_sync, workspace, ActorKind, Envelope, Meta, Page, Principal, Source,
};

const USAGE: &str = r#"Task Dock Agent CLI

用法:
  taskdock status [--json]
  taskdock info [--json]
  taskdock project list [--json] [--limit N] [--offset N]
  taskdock project get <project_id>
  taskdock project current
  taskdock task list [--status pending|completed|all] [--search KW] [--limit N]
  taskdock task get <task_id>
  taskdock task create --title <标题> [--description ...] [--priority 0-3] [--due ISO] [--tag x]
  taskdock task update <task_id> --base-revision N [--title ...] [--description ...]
  taskdock task complete <task_id> [--base-revision N]
  taskdock task search <关键词>
  taskdock plan list [--project ID] [--limit N]
  taskdock plan current
  taskdock plan get <project_id>
  taskdock knowledge bases
  taskdock knowledge search <关键词> [--kb ID] [--limit N]
  taskdock knowledge get <document_id>
  taskdock knowledge create --title ... (--content ... | --file path) [--kb-id ID | --kb-name NAME]
  taskdock knowledge update <document_id> [--title ...] [--content ...] --base-revision N
  taskdock decision list [--project ID] [--status ...]
  taskdock decision get <decision_id>
  taskdock decision create --title ... --decision ... [--context ...] [--project ID] [--status accepted]
  taskdock context get [--project ID] [--task-id ID] [--task 描述] [--budget N] [--format markdown|json]
  taskdock context search <关键词>
  taskdock context export [--project ID] [--format markdown|json]
  taskdock agent registry
  taskdock agent activity [--agent ID] [--interface cli|mcp|rest|file] [--limit N]
  taskdock agent handoff list [--status pending] [--project ID]
  taskdock agent handoff get <handoff_id>
  taskdock agent handoff create --to <agent_id> --summary ... [--project ID] [--task-id ID]
  taskdock agent handoff accept <handoff_id> --base-revision N
  taskdock agent handoff reject <handoff_id> --base-revision N --reason ...
  taskdock agent handoff complete <handoff_id> --base-revision N
  taskdock agent report create --summary ... [--result completed|partial|blocked|failed] [--handoff ID]
  taskdock agent report list [--agent ID] [--handoff ID]
  taskdock search <关键词> [--kind task|knowledge|decision|project]
  taskdock sync status
  taskdock sync init [--path <绝对目录>] [--name <名称>]
  taskdock sync export
  taskdock sync scan
  taskdock sync conflicts
  taskdock sync resolve <conflict_id> --resolution db|file|dismiss

全局:
  --json     stdout 输出统一 JSON 信封
  --fields   a,b,c 只返回指定字段
"#;

struct Cli {
    json: bool,
    limit: u32,
    offset: u32,
    fields: Vec<String>,
}

struct Outcome {
    data: Value,
    page: Option<Page>,
    human: String,
}

fn take_flag(args: &mut Vec<String>, name: &str) -> Option<String> {
    if let Some(pos) = args.iter().position(|a| a == name) {
        args.remove(pos);
        if pos < args.len() {
            let value = args.remove(pos);
            return Some(value);
        }
        return Some(String::new());
    }
    let prefix = format!("{name}=");
    if let Some(pos) = args.iter().position(|a| a.starts_with(&prefix)) {
        let value = args.remove(pos);
        return Some(value[prefix.len()..].to_string());
    }
    None
}

fn take_all(args: &mut Vec<String>, name: &str) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(v) = take_flag(args, name) {
        if !v.is_empty() {
            out.push(v);
        }
    }
    out
}

fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn usage_err(msg: &str) -> AppError {
    AppError::Validation(format!("用法: {msg}"))
}

fn require_positional(args: &mut Vec<String>, what: &str) -> AppResult<String> {
    let pos = args.iter().position(|a| !a.starts_with("--"));
    match pos {
        Some(i) => Ok(args.remove(i)),
        None => Err(usage_err(&format!("缺少 {what}"))),
    }
}

fn resolve_principal(db: &Db) -> AppResult<Principal> {
    let token = std::env::var("TASKDOCK_AGENT_TOKEN").unwrap_or_default();
    let mut principal = if token.trim().is_empty() {
        Principal::local(Source::Cli)
    } else {
        let row = db.with_read(|conn| mcp_auth::find_agent_by_token(conn, token.trim()))?;
        let row = row.ok_or_else(|| {
            AppError::Agent("TASKDOCK_AGENT_TOKEN 无效或已撤销；请在 UI 中重新生成".into())
        })?;
        Principal::agent(row.row_id, row.agent_id, Source::Cli)
    };
    if std::env::var("TASKDOCK_CLI_READONLY").unwrap_or_default() == "1" {
        principal.read_only = true;
    }
    Ok(principal)
}

fn open_db() -> AppResult<Db> {
    let path: PathBuf = match std::env::var_os("TASKDOCK_DB_PATH") {
        Some(p) => PathBuf::from(p),
        None => service::data_dir().join("task-dock.db"),
    };
    if !path.exists() {
        return Err(AppError::Unavailable(format!(
            "未找到 Task Dock 数据库：{}。请先启动一次 Task Dock 桌面应用完成初始化。",
            path.display()
        )));
    }
    Db::open(&path)
}

pub fn main_entry(args: Vec<String>) -> i32 {
    let args: Vec<String> = if args.is_empty() {
        vec!["status".to_string()]
    } else {
        args
    };
    if has_flag(&args, "--help") || has_flag(&args, "-h") || args[0] == "help" {
        println!("{USAGE}");
        return 0;
    }
    let db = match open_db() {
        Ok(db) => db,
        Err(err) => {
            eprintln!("{}", err.user_message());
            return 7;
        }
    };
    let principal = match resolve_principal(&db) {
        Ok(p) => p,
        Err(err) => {
            eprintln!("{}", err.user_message());
            return 6;
        }
    };
    let cli = Cli {
        json: has_flag(&args, "--json"),
        limit: 0,
        offset: 0,
        fields: Vec::new(),
    };
    let mut argv = args.clone();
    argv.retain(|a| a != "--json");
    let limit = take_flag(&mut argv, "--limit")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(50);
    let offset = take_flag(&mut argv, "--offset")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    let fields = take_flag(&mut argv, "--fields")
        .map(|v| v.split(',').map(|s| s.trim().to_string()).collect())
        .unwrap_or_default();
    let cli = Cli {
        limit: limit.clamp(1, 200),
        offset,
        fields,
        ..cli
    };

    let request_id = format!("cli-{}", uuid::Uuid::new_v4().simple());
    match execute(&db, &principal, &cli, argv) {
        Ok(outcome) => {
            let mut meta = Meta::new(&principal, &request_id);
            if let Some(page) = &outcome.page {
                meta = meta.with_page(page.clone());
            }
            let data = filter_fields(outcome.data, &cli.fields);
            if cli.json {
                let envelope = Envelope::ok(data, meta);
                match serde_json::to_string_pretty(&envelope) {
                    Ok(text) => println!("{text}"),
                    Err(err) => {
                        eprintln!("序列化失败: {err}");
                        return 8;
                    }
                }
            } else {
                println!("{}", outcome.human);
            }
            log_read(&db, &principal, &request_id, "cli.read");
            0
        }
        Err(err) => {
            let meta = Meta::new(&principal, &request_id);
            if cli.json {
                let envelope = Envelope::fail(&err, meta);
                if let Ok(text) = serde_json::to_string_pretty(&envelope) {
                    println!("{text}");
                }
            }
            eprintln!("{}", err.user_message());
            let code = error_code(&err);
            if code == "VALIDATION" && err.user_message().starts_with("用法:") {
                2
            } else {
                super::exit_code(code)
            }
        }
    }
}

fn log_read(db: &Db, principal: &Principal, request_id: &str, action: &str) {
    store::log_activity(
        db,
        &store::ActivityEntry {
            principal,
            action,
            resource_kind: "",
            resource_id: "",
            project_id: "",
            request_id,
            success: true,
            error_code: "",
            detail: "CLI 查询",
            revision: None,
            duration_ms: 0,
        },
    );
}

fn filter_fields(data: Value, fields: &[String]) -> Value {
    if fields.is_empty() {
        return data;
    }
    let pick = |value: &Value| -> Value {
        match value {
            Value::Object(map) => {
                let mut out = serde_json::Map::new();
                for field in fields {
                    if let Some(v) = map.get(field) {
                        out.insert(field.clone(), v.clone());
                    }
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    };
    match data {
        Value::Array(items) => Value::Array(items.iter().map(pick).collect()),
        other => pick(&other),
    }
}

fn execute(db: &Db, principal: &Principal, cli: &Cli, mut args: Vec<String>) -> AppResult<Outcome> {
    if args.is_empty() {
        return Err(usage_err("缺少命令组（status|info|project|task|plan|knowledge|decision|context|agent|search|sync）"));
    }
    let group = args.remove(0);
    let sub = match args.iter().position(|a| !a.starts_with("--")) {
        Some(i) => args.remove(i),
        None => "list".to_string(),
    };
    match group.as_str() {
        "status" => {
            let data = service::status_snapshot(db, principal)?;
            Ok(Outcome {
                human: serde_json::to_string_pretty(&data)?,
                data,
                page: None,
            })
        }
        "info" => {
            let manifest = workspace::manifest(db)?;
            let status = workspace::status(db)?;
            let data = json!({
                "version": env!("CARGO_PKG_VERSION"),
                "protocol": super::PROTOCOL,
                "protocol_version": super::PROTOCOL_VERSION,
                "database": service::data_dir().join("task-dock.db").to_string_lossy(),
                "manifest": manifest,
                "workspace": status,
                "cli": { "json": cli.json, "readonly": principal.read_only },
            });
            Ok(Outcome {
                human: serde_json::to_string_pretty(&data)?,
                data,
                page: None,
            })
        }
        "project" => match sub.as_str() {
            "list" => {
                let (projects, page) =
                    service::list_projects(db, principal, None, None, cli.limit, cli.offset)?;
                let human = projects
                    .iter()
                    .map(|p| {
                        format!(
                            "{}\t{}\t{}\t{}\t{}",
                            p.id, p.kind, p.status, p.name, p.updated_at
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(Outcome {
                    data: serde_json::to_value(&projects)?,
                    page: Some(page),
                    human,
                })
            }
            "get" => {
                let id = require_positional(&mut args, "project_id")?;
                let detail = service::get_project(db, principal, &id)?;
                Ok(Outcome {
                    human: serde_json::to_string_pretty(&detail)?,
                    data: serde_json::to_value(&detail)?,
                    page: None,
                })
            }
            "current" => {
                let (projects, _) =
                    service::list_projects(db, principal, Some("planning"), None, 50, 0)?;
                let pick = projects
                    .iter()
                    .find(|p| p.status == "in_progress")
                    .or_else(|| projects.first());
                match pick {
                    Some(p) => {
                        let data = serde_json::to_value(p)?;
                        Ok(Outcome {
                            human: format!("{} ({}, {})", p.name, p.id, p.status),
                            data,
                            page: None,
                        })
                    }
                    None => Err(AppError::NotFound("没有进行中的规划项目".into())),
                }
            }
            other => Err(usage_err(&format!("未知子命令 project {other}"))),
        },
        "task" => match sub.as_str() {
            "list" | "search" => {
                if sub == "search" {
                    if let Some(pos) = args.iter().position(|a| !a.starts_with("--")) {
                        let kw = args.remove(pos);
                        args.push("--search".into());
                        args.push(kw);
                    }
                }
                let filter = task_filter(&mut args)?;
                let (tasks, page) =
                    service::list_tasks(db, principal, filter, cli.limit, cli.offset)?;
                let human = tasks
                    .iter()
                    .map(|t| format!("{}\t{}\t{}", t.id, t.status, t.title))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(Outcome {
                    data: serde_json::to_value(&tasks)?,
                    page: Some(page),
                    human,
                })
            }
            "get" => {
                let id = require_positional(&mut args, "task_id")?;
                let task = service::fetch_task(db, principal, &id)?;
                Ok(Outcome {
                    human: serde_json::to_string_pretty(&task)?,
                    data: serde_json::to_value(&task)?,
                    page: None,
                })
            }
            "create" => {
                let title = take_flag(&mut args, "--title")
                    .ok_or_else(|| usage_err("task create 需要 --title"))?;
                let input = service::TaskCreateInput {
                    title,
                    description: take_flag(&mut args, "--description").unwrap_or_default(),
                    priority: take_flag(&mut args, "--priority")
                        .and_then(|v| v.parse::<u8>().ok()),
                    category: take_flag(&mut args, "--category"),
                    tags: {
                        let tags = take_all(&mut args, "--tag");
                        if tags.is_empty() { None } else { Some(tags) }
                    },
                    due_at: take_flag(&mut args, "--due"),
                    remind_at: take_flag(&mut args, "--remind"),
                    advance_minutes: take_flag(&mut args, "--advance-minutes")
                        .and_then(|v| v.parse::<i64>().ok()),
                };
                let task = service::create_task(db, principal, input)?;
                Ok(Outcome {
                    human: format!("创建任务 {} {}", task.id, task.title),
                    data: serde_json::to_value(&task)?,
                    page: None,
                })
            }
            "update" => {
                let id = require_positional(&mut args, "task_id")?;
                let patch = service::TaskPatch {
                    title: take_flag(&mut args, "--title"),
                    description: take_flag(&mut args, "--description"),
                    priority: take_flag(&mut args, "--priority")
                        .and_then(|v| v.parse::<u8>().ok()),
                    category: take_flag(&mut args, "--category"),
                    tags: {
                        let tags = take_all(&mut args, "--tag");
                        if tags.is_empty() { None } else { Some(tags) }
                    },
                    due_at: take_flag(&mut args, "--due"),
                    clear_due_at: take_flag(&mut args, "--clear-due").is_some(),
                    remind_at: take_flag(&mut args, "--remind"),
                    clear_remind_at: take_flag(&mut args, "--clear-remind").is_some(),
                    advance_minutes: take_flag(&mut args, "--advance-minutes")
                        .and_then(|v| v.parse::<i64>().ok()),
                };
                let base = take_flag(&mut args, "--base-revision")
                    .and_then(|v| v.parse::<i64>().ok());
                let task = service::update_task(db, principal, &id, patch, base)?;
                Ok(Outcome {
                    human: format!("更新任务 {} {}", task.id, task.title),
                    data: serde_json::to_value(&task)?,
                    page: None,
                })
            }
            "complete" => {
                let id = require_positional(&mut args, "task_id")?;
                let base = take_flag(&mut args, "--base-revision")
                    .and_then(|v| v.parse::<i64>().ok());
                let task = service::complete_task(db, principal, &id, base)?;
                Ok(Outcome {
                    human: format!("完成任务 {} 当前状态 {}", task.id, task.status),
                    data: serde_json::to_value(&task)?,
                    page: None,
                })
            }
            other => Err(usage_err(&format!("未知子命令 task {other}"))),
        },
        "plan" => match sub.as_str() {
            "list" => {
                let project = take_flag(&mut args, "--project");
                let (plans, page) = service::list_plans(
                    db,
                    principal,
                    project.as_deref(),
                    cli.limit,
                    cli.offset,
                )?;
                let human = plans
                    .iter()
                    .map(|p| {
                        format!(
                            "{}\t{}\t{}%\t{}",
                            p.project_id, p.status, p.progress_percent, p.name
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(Outcome {
                    data: serde_json::to_value(&plans)?,
                    page: Some(page),
                    human,
                })
            }
            "current" => match service::current_plan(db, principal)? {
                Some(plan) => {
                    let data = serde_json::to_value(&plan)?;
                    Ok(Outcome {
                        human: format!(
                            "{} ({}, {}%)",
                            plan.name, plan.status, plan.progress_percent
                        ),
                        data,
                        page: None,
                    })
                }
                None => Err(AppError::NotFound("没有进行中的规划".into())),
            },
            "get" => {
                let id = require_positional(&mut args, "project_id")?;
                let plan = service::get_plan(db, principal, &id)?;
                Ok(Outcome {
                    human: serde_json::to_string_pretty(&plan)?,
                    data: serde_json::to_value(&plan)?,
                    page: None,
                })
            }
            other => Err(usage_err(&format!("未知子命令 plan {other}"))),
        },
        "knowledge" => match sub.as_str() {
            "bases" | "list" => {
                let bases = service::list_knowledge_bases(db, principal)?;
                let human = bases
                    .iter()
                    .map(|b| format!("{}\t{}\t{} 篇", b.id, b.name, b.document_count))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(Outcome {
                    data: serde_json::to_value(&bases)?,
                    page: None,
                    human,
                })
            }
            "search" => {
                let query = require_positional(&mut args, "关键词")?;
                let kb_ids = take_all(&mut args, "--kb");
                let (hits, page) =
                    service::search_knowledge(db, principal, &query, &kb_ids, cli.limit, cli.offset)?;
                let human = hits
                    .iter()
                    .map(|h| format!("{}\t{}\t{}", h.doc_id, h.title, h.snippet))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(Outcome {
                    data: serde_json::to_value(&hits)?,
                    page: Some(page),
                    human,
                })
            }
            "get" => {
                let id = require_positional(&mut args, "document_id")?;
                let doc = service::get_knowledge(db, principal, &id)?;
                Ok(Outcome {
                    human: format!("# {}\n\n{}", doc.title, doc.content),
                    data: serde_json::to_value(&doc)?,
                    page: None,
                })
            }
            "create" => {
                let title = take_flag(&mut args, "--title")
                    .ok_or_else(|| usage_err("knowledge create 需要 --title"))?;
                let content = match take_flag(&mut args, "--content") {
                    Some(c) => c,
                    None => match take_flag(&mut args, "--file") {
                        Some(path) => std::fs::read_to_string(&path).map_err(|e| {
                            AppError::Validation(format!("读取 --file 失败: {e}"))
                        })?,
                        None => return Err(usage_err("knowledge create 需要 --content 或 --file")),
                    },
                };
                let input = service::KnowledgeCreateInput {
                    title,
                    content,
                    kb_id: take_flag(&mut args, "--kb-id").or_else(|| take_flag(&mut args, "--kb")),
                    kb_name: take_flag(&mut args, "--kb-name"),
                };
                let doc = service::create_knowledge(db, principal, input)?;
                Ok(Outcome {
                    human: format!("写入知识 {} {}（{} 分块）", doc.id, doc.title, doc.chunk_count),
                    data: serde_json::to_value(&doc)?,
                    page: None,
                })
            }
            "update" => {
                let id = require_positional(&mut args, "document_id")?;
                let base = take_flag(&mut args, "--base-revision")
                    .and_then(|v| v.parse::<i64>().ok());
                let patch = service::KnowledgePatch {
                    title: take_flag(&mut args, "--title"),
                    content: take_flag(&mut args, "--content").or_else(|| {
                        take_flag(&mut args, "--file")
                            .and_then(|p| std::fs::read_to_string(p).ok())
                    }),
                };
                let doc = service::update_knowledge(db, principal, &id, patch, base)?;
                Ok(Outcome {
                    human: format!("更新知识 {} {}", doc.id, doc.title),
                    data: serde_json::to_value(&doc)?,
                    page: None,
                })
            }
            other => Err(usage_err(&format!("未知子命令 knowledge {other}"))),
        },
        "decision" => match sub.as_str() {
            "list" => {
                let project = take_flag(&mut args, "--project");
                let status = take_flag(&mut args, "--status");
                let (items, page) = store::list_decisions(
                    db,
                    project.as_deref(),
                    status.as_deref(),
                    cli.limit,
                    cli.offset,
                )?;
                let human = items
                    .iter()
                    .map(|d| format!("{}\t{}\t{}", d.id, d.status, d.title))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(Outcome {
                    data: serde_json::to_value(&items)?,
                    page: Some(page),
                    human,
                })
            }
            "get" => {
                let id = require_positional(&mut args, "decision_id")?;
                let decision = store::get_decision(db, &id)?;
                Ok(Outcome {
                    human: serde_json::to_string_pretty(&decision)?,
                    data: serde_json::to_value(&decision)?,
                    page: None,
                })
            }
            "create" => {
                perms::require(db, principal, Capability::DecisionsWrite, "")?;
                let title = take_flag(&mut args, "--title")
                    .ok_or_else(|| usage_err("decision create 需要 --title"))?;
                let decision = take_flag(&mut args, "--decision")
                    .ok_or_else(|| usage_err("decision create 需要 --decision"))?;
                let input = store::DecisionInput {
                    title,
                    project_id: take_flag(&mut args, "--project"),
                    project_kind: None,
                    context: take_flag(&mut args, "--context").unwrap_or_default(),
                    decision,
                    consequences: take_flag(&mut args, "--consequences").unwrap_or_default(),
                    alternatives: take_flag(&mut args, "--alternatives").unwrap_or_default(),
                    tags: take_all(&mut args, "--tag"),
                    status: take_flag(&mut args, "--status"),
                };
                let created = store::create_decision(db, principal, input)?;
                Ok(Outcome {
                    human: format!("记录决策 {} {}", created.id, created.title),
                    data: serde_json::to_value(&created)?,
                    page: None,
                })
            }
            other => Err(usage_err(&format!("未知子命令 decision {other}"))),
        },
        "context" => match sub.as_str() {
            "get" | "export" => {
                let format = take_flag(&mut args, "--format").unwrap_or_else(|| "markdown".into());
                let req = context::ContextRequest {
                    task: take_flag(&mut args, "--task"),
                    task_id: take_flag(&mut args, "--task-id"),
                    project_id: take_flag(&mut args, "--project"),
                    budget_tokens: take_flag(&mut args, "--budget")
                        .and_then(|v| v.parse::<u32>().ok()),
                    format: Some(format.clone()),
                    ..Default::default()
                };
                let ctx = context::build(db, principal, req)?;
                let human = if format == "json" {
                    serde_json::to_string_pretty(&ctx)?
                } else {
                    ctx.markdown.clone()
                };
                Ok(Outcome {
                    data: context::to_json(&ctx)?,
                    page: None,
                    human,
                })
            }
            "search" => {
                let query = require_positional(&mut args, "关键词")?;
                let keywords = query
                    .split_whitespace()
                    .map(str::to_string)
                    .collect::<Vec<_>>();
                let items = context::recent(db, principal, 20)?;
                let filtered: Vec<_> = items
                    .into_iter()
                    .filter(|i| {
                        let hay = format!("{} {}", i.title, i.summary).to_lowercase();
                        keywords.iter().any(|k| hay.contains(&k.to_lowercase()))
                    })
                    .collect();
                let human = filtered
                    .iter()
                    .map(|i| format!("{}\t{}", i.kind, i.title))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(Outcome {
                    data: serde_json::to_value(&filtered)?,
                    page: None,
                    human,
                })
            }
            other => Err(usage_err(&format!("未知子命令 context {other}"))),
        },
        "agent" => match sub.as_str() {
            "registry" | "list" => {
                let agents = handoff::list_agents(db, principal)?;
                let human = agents
                    .iter()
                    .map(|a| format!("{}\t{}\t{}\t{}", a.agent_id, a.scope, a.display_name, a.vendor))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(Outcome {
                    data: serde_json::to_value(&agents)?,
                    page: None,
                    human,
                })
            }
            "activity" => {
                let agent = take_flag(&mut args, "--agent");
                let interface = take_flag(&mut args, "--interface");
                let since = take_flag(&mut args, "--since");
                let (items, page) = handoff::activity(
                    db,
                    principal,
                    agent.as_deref(),
                    interface.as_deref(),
                    since.as_deref(),
                    cli.limit,
                    cli.offset,
                )?;
                let human = items
                    .iter()
                    .map(|a| {
                        format!(
                            "{}\t{}\t{}\t{}{}",
                            a.created_at,
                            a.agent_id,
                            a.action,
                            a.resource_kind,
                            if a.success { "" } else { "\tFAILED" }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(Outcome {
                    data: serde_json::to_value(&items)?,
                    page: Some(page),
                    human,
                })
            }
            "handoff" => {
                let action = match args.iter().position(|a| !a.starts_with("--")) {
                    Some(i) => args.remove(i),
                    None => "list".to_string(),
                };
                match action.as_str() {
                    "list" => {
                        let status = take_flag(&mut args, "--status");
                        let project = take_flag(&mut args, "--project");
                        let (items, page) = handoff::list_handoffs(
                            db,
                            principal,
                            status.as_deref(),
                            project.as_deref(),
                            cli.limit,
                            cli.offset,
                        )?;
                        let human = items
                            .iter()
                            .map(|h| {
                                format!(
                                    "{}\t{}\t{} → {}\t{}",
                                    h.id, h.status, h.from_agent_id, h.to_agent_id, h.summary
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        Ok(Outcome {
                            data: serde_json::to_value(&items)?,
                            page: Some(page),
                            human,
                        })
                    }
                    "get" => {
                        let id = require_positional(&mut args, "handoff_id")?;
                        let item = handoff::get_handoff(db, principal, &id)?;
                        Ok(Outcome {
                            human: serde_json::to_string_pretty(&item)?,
                            data: serde_json::to_value(&item)?,
                            page: None,
                        })
                    }
                    "create" => {
                        let to = take_flag(&mut args, "--to")
                            .ok_or_else(|| usage_err("handoff create 需要 --to <agent_id>"))?;
                        let summary = take_flag(&mut args, "--summary")
                            .ok_or_else(|| usage_err("handoff create 需要 --summary"))?;
                        let input = store::HandoffInput {
                            to_agent_id: to,
                            summary,
                            task_id: take_flag(&mut args, "--task-id"),
                            project_id: take_flag(&mut args, "--project"),
                            project_kind: None,
                            completed_items: take_all(&mut args, "--done"),
                            pending_items: take_all(&mut args, "--pending"),
                            decisions: Vec::new(),
                            files_changed: take_all(&mut args, "--file"),
                            risks: take_all(&mut args, "--risk"),
                            next_steps: take_all(&mut args, "--next"),
                        };
                        let created = handoff::create_handoff(db, principal, input)?;
                        Ok(Outcome {
                            human: format!(
                                "创建交接 {} {} → {}",
                                created.handoff.id, created.handoff.from_agent_id,
                                created.handoff.to_agent_id
                            ),
                            data: serde_json::to_value(&created)?,
                            page: None,
                        })
                    }
                    "accept" | "reject" | "complete" => {
                        let id = require_positional(&mut args, "handoff_id")?;
                        let base = take_flag(&mut args, "--base-revision")
                            .and_then(|v| v.parse::<i64>().ok())
                            .ok_or_else(|| usage_err("状态变更需要 --base-revision"))?;
                        let result = match action.as_str() {
                            "accept" => handoff::accept_handoff(db, principal, &id, base)?,
                            "reject" => {
                                let reason = take_flag(&mut args, "--reason").unwrap_or_default();
                                handoff::reject_handoff(db, principal, &id, base, &reason)?
                            }
                            _ => handoff::complete_handoff(db, principal, &id, base)?,
                        };
                        Ok(Outcome {
                            human: format!("交接 {} → {}", result.id, result.status),
                            data: serde_json::to_value(&result)?,
                            page: None,
                        })
                    }
                    other => Err(usage_err(&format!("未知子命令 agent handoff {other}"))),
                }
            }
            "report" => {
                let action = match args.iter().position(|a| !a.starts_with("--")) {
                    Some(i) => args.remove(i),
                    None => "list".to_string(),
                };
                match action.as_str() {
                    "list" => {
                        let agent = take_flag(&mut args, "--agent");
                        let handoff_id = take_flag(&mut args, "--handoff");
                        let (items, page) = handoff::list_reports(
                            db,
                            principal,
                            agent.as_deref(),
                            handoff_id.as_deref(),
                            cli.limit,
                            cli.offset,
                        )?;
                        let human = items
                            .iter()
                            .map(|r| format!("{}\t{}\t{}", r.id, r.result, r.summary))
                            .collect::<Vec<_>>()
                            .join("\n");
                        Ok(Outcome {
                            data: serde_json::to_value(&items)?,
                            page: Some(page),
                            human,
                        })
                    }
                    "get" => {
                        let id = require_positional(&mut args, "report_id")?;
                        let item = handoff::get_report(db, principal, &id)?;
                        Ok(Outcome {
                            human: serde_json::to_string_pretty(&item)?,
                            data: serde_json::to_value(&item)?,
                            page: None,
                        })
                    }
                    "create" => {
                        let summary = take_flag(&mut args, "--summary")
                            .ok_or_else(|| usage_err("report create 需要 --summary"))?;
                        let input = store::ReportInput {
                            summary,
                            result: take_flag(&mut args, "--result"),
                            handoff_id: take_flag(&mut args, "--handoff"),
                            project_id: take_flag(&mut args, "--project"),
                            task_id: take_flag(&mut args, "--task-id"),
                            completed_items: take_all(&mut args, "--done"),
                            pending_items: take_all(&mut args, "--pending"),
                            files_changed: take_all(&mut args, "--file"),
                            evidence: Vec::new(),
                            risks: take_all(&mut args, "--risk"),
                        };
                        let out = handoff::create_report(db, principal, input)?;
                        Ok(Outcome {
                            human: format!("提交报告 {} {}", out.report.id, out.report.result),
                            data: serde_json::to_value(&out)?,
                            page: None,
                        })
                    }
                    other => Err(usage_err(&format!("未知子命令 agent report {other}"))),
                }
            }
            other => Err(usage_err(&format!("未知子命令 agent {other}"))),
        },
        "search" => {
            let query = require_positional(&mut args, "关键词")?;
            let kinds = take_all(&mut args, "--kind");
            let items = service::search_all(db, principal, &query, &kinds, cli.limit)?;
            let human = items
                .iter()
                .map(|h| format!("{}\t{}\t{}", h.kind, h.id, h.title))
                .collect::<Vec<_>>()
                .join("\n");
            Ok(Outcome {
                data: serde_json::to_value(&items)?,
                page: None,
                human,
            })
        }
        "sync" => match sub.as_str() {
            "status" => {
                let status = file_sync::status(db)?;
                let human = match &status.workspace {
                    Some(ws) => format!(
                        "{}\t{} 个文件\t{} 待导入\t{} 冲突",
                        ws.root_path, ws.file_count, status.pending_imports, status.conflicts
                    ),
                    None => "工作空间尚未初始化（taskdock sync init）".to_string(),
                };
                Ok(Outcome {
                    data: serde_json::to_value(&status)?,
                    page: None,
                    human,
                })
            }
            "init" => {
                let path = take_flag(&mut args, "--path");
                let name = take_flag(&mut args, "--name");
                let row = workspace::init(db, path.as_deref(), name.as_deref())?;
                let report = projection::export_all(db, &row)?;
                let data = json!({
                    "workspace": row,
                    "export": report,
                });
                Ok(Outcome {
                    human: format!(
                        "初始化完成：{}\n写入 {}，跳过 {}，失败 {}",
                        row.root_path, report.written, report.skipped, report.failed
                    ),
                    data,
                    page: None,
                })
            }
            "export" => {
                let row = workspace::active(db)?
                    .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
                let report = projection::export_all(db, &row)?;
                Ok(Outcome {
                    human: format!(
                        "导出完成：写入 {}，跳过 {}，失败 {}，文件 {}",
                        report.written,
                        report.skipped,
                        report.failed,
                        report.files.len()
                    ),
                    data: serde_json::to_value(&report)?,
                    page: None,
                })
            }
            "scan" => {
                let row = workspace::active(db)?
                    .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
                let scan_principal = if principal.is_agent() {
                    principal.clone()
                } else {
                    Principal {
                        source: Source::File,
                        ..principal.clone()
                    }
                };
                let report = file_sync::scan(db, &scan_principal, &row)?;
                Ok(Outcome {
                    human: format!(
                        "扫描 {}，导入 {}，跳过 {}，失败 {}，冲突 {}",
                        report.scanned, report.imported, report.skipped, report.failed, report.conflicts
                    ),
                    data: serde_json::to_value(&report)?,
                    page: None,
                })
            }
            "conflicts" => {
                let items = file_sync::list_conflicts(db)?;
                let human = items
                    .iter()
                    .map(|c| format!("{}\t{}\t{}", c.id, c.status, c.rel_path))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(Outcome {
                    data: serde_json::to_value(&items)?,
                    page: None,
                    human,
                })
            }
            "resolve" => {
                let id = require_positional(&mut args, "conflict_id")?;
                let resolution = take_flag(&mut args, "--resolution")
                    .ok_or_else(|| usage_err("sync resolve 需要 --resolution db|file|dismiss"))?;
                let item = file_sync::resolve_conflict(db, principal, &id, &resolution)?;
                Ok(Outcome {
                    human: format!("冲突 {} → {}", item.id, item.status),
                    data: serde_json::to_value(&item)?,
                    page: None,
                })
            }
            other => Err(usage_err(&format!("未知子命令 sync {other}"))),
        },
        other => Err(usage_err(&format!("未知命令组 {other}"))),
    }
}

fn task_filter(args: &mut Vec<String>) -> AppResult<crate::commands::tasks::TaskFilter> {
    use crate::commands::tasks::TaskFilter;
    let view = take_flag(args, "--view");
    if let Some(view) = &view {
        if !["today", "tomorrow", "week", "all", "overdue", "due_today", "scheduled"]
            .contains(&view.as_str())
        {
            return Err(usage_err(&format!("非法 --view {view}")));
        }
    }
    let status = take_flag(args, "--status");
    if let Some(status) = &status {
        if !["pending", "completed", "all"].contains(&status.as_str()) {
            return Err(usage_err(&format!("非法 --status {status}")));
        }
    }
    let sort = take_flag(args, "--sort");
    if let Some(sort) = &sort {
        if !["due", "priority", "created", "completed", "scheduled"].contains(&sort.as_str()) {
            return Err(usage_err(&format!("非法 --sort {sort}")));
        }
    }
    Ok(TaskFilter {
        view,
        status,
        category: take_flag(args, "--category"),
        tag: take_flag(args, "--tag"),
        priority: take_flag(args, "--priority").and_then(|v| v.parse::<u8>().ok()),
        search: take_flag(args, "--search"),
        sort,
        limit: None,
    })
}

/// `taskdock --json status` 的兼容入口（供主程序 `--cli` 复用）。
pub fn run_with(args: Vec<String>) -> i32 {
    main_entry(args)
}

/// 记录一次 CLI 调用（便于 UI 活动中心看到 `interface=cli`）。
pub fn record_cli_activity(db: &Db, principal: &Principal, action: &str, detail: &str) {
    let _ = db.with_conn(|conn| {
        store::write_activity(
            conn,
            &store::ActivityEntry {
                principal,
                action,
                resource_kind: "",
                resource_id: "",
                project_id: "",
                request_id: "",
                success: true,
                error_code: "",
                detail,
                revision: None,
                duration_ms: 0,
            },
        )
    });
}

/// 便捷构造只读本机主体（UI 导出等内部调用）。
pub fn local_readonly(source: Source) -> Principal {
    Principal {
        actor_kind: ActorKind::Human,
        read_only: true,
        ..Principal::local(source)
    }
}
