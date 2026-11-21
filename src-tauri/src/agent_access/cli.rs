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
    context, error_code, handoff, operations, permissions as perms, projection, service, store,
    sync as file_sync, workspace, ActorKind, Envelope, Meta, Page, Principal, Source,
};

pub const USAGE: &str = r#"Task Dock Agent CLI

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
  taskdock context get [--project ID] [--task-id ID] [--task 描述] [--budget N] [--format markdown|json|compact_json]
  taskdock context search <关键词>
  taskdock context export [--project ID] [--format markdown|json|compact_json]
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

/// CLI 命令注册表（真源）。帮助文本、文档契约测试与参数校验都从这里派生，
/// 避免「文档写一套、实现是另一套」。
pub const COMMANDS: &[(&str, &str, &str)] = &[
    ("status", "-", "接口/工作空间/数据库/版本总览"),
    ("info", "-", "版本、路径、协议、schema"),
    ("project", "list|get|current", "项目列表/详情/当前项目"),
    ("task", "list|get|create|update|complete|search", "任务读写"),
    ("plan", "list|current|get", "规划列表/当前/详情"),
    ("knowledge", "bases|search|get|create|update", "知识检索与写入"),
    ("decision", "list|get|create", "决策记录"),
    ("context", "get|search|export", "上下文装配与导出"),
    ("agent", "registry|activity|handoff|report", "Agent 身份、交接与报告"),
    ("search", "-", "跨类型搜索"),
    ("sync", "status|init|export|scan|conflicts|resolve", "文件同步与冲突"),
];

/// 供帮助输出与诊断使用的命令描述。
pub fn describe_cli_commands() -> Vec<String> {
    COMMANDS
        .iter()
        .map(|(group, sub, summary)| {
            if *sub == "-" {
                format!("taskdock {group} — {summary}")
            } else {
                format!("taskdock {group} {sub} — {summary}")
            }
        })
        .collect()
}

/// 文档契约：帮助文本必须覆盖注册表里的每个命令组与子命令。
/// 文档与实现漂移时（新增命令忘了写帮助）立刻失败。
pub fn check_cli_documentation_contract(usage: &str) -> Result<(), String> {
    let mut missing = Vec::new();
    for (group, sub, _) in COMMANDS {
        if !usage.contains(&format!("taskdock {group} ")) && !usage.contains(&format!("taskdock {group}\n")) {
            missing.push(format!("taskdock {group}"));
        }
        if *sub == "-" {
            continue;
        }
        for one in sub.split('|') {
            if !usage.contains(&format!("taskdock {group} {one}")) {
                missing.push(format!("taskdock {group} {one}"));
            }
        }
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("CLI 帮助缺少命令: {}", missing.join(", ")))
    }
}

/// 未知参数校验：解析后仍残留 `--xxx` 说明用户传了不存在的参数。
fn validate_cli_arguments(args: &[String]) -> AppResult<()> {
    if let Some(unknown) = args.iter().find(|a| a.starts_with("--")) {
        return Err(usage_err(&format!("未知参数 {unknown}")));
    }
    Ok(())
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

/// CLI 写命令 → (action, resource_kind)。
///
/// 只有真正的写命令才创建操作：读命令不产生「正在修改」状态。
/// 同一次 CLI 调用只对应一条记录（内部无论调用多少服务函数，都不再新建）。
fn classify_cli_write(args: &[String]) -> Option<(&'static str, &'static str, String)> {
    let group = args.first()?.as_str();
    let has_subcommand = matches!(
        group,
        "project" | "task" | "plan" | "knowledge" | "decision" | "context" | "agent" | "sync"
    );
    let sub = if has_subcommand {
        args.iter().skip(1).find(|a| !a.starts_with("--"))?.as_str()
    } else {
        "list"
    };
    let third = args
        .iter()
        .skip(2)
        .find(|a| !a.starts_with("--"))
        .map(String::as_str);
    let (action, kind) = match (group, sub, third) {
        ("task", "create", _) => ("task.create", "task"),
        ("task", "update", _) => ("task.update", "task"),
        ("task", "complete", _) => ("task.complete", "task"),
        ("knowledge", "create", _) => ("knowledge.create", "knowledge"),
        ("knowledge", "update", _) => ("knowledge.update", "knowledge"),
        ("decision", "create", _) => ("decision.create", "decision"),
        ("agent", "handoff", Some("accept")) => ("handoff.accept", "handoff"),
        ("agent", "handoff", Some("reject")) => ("handoff.reject", "handoff"),
        ("agent", "handoff", Some("complete")) => ("handoff.complete", "handoff"),
        ("agent", "handoff", _) => ("handoff.create", "handoff"),
        ("agent", "report", _) => ("report.create", "report"),
        ("sync", "init", _) => ("sync.init", "sync"),
        ("sync", "export", _) => ("sync.export", "sync"),
        ("sync", "scan", _) => ("sync.scan", "sync"),
        ("sync", "resolve", _) => ("sync.resolve", "sync"),
        _ => return None,
    };
    // 失败也要能落到具体资源上：非创建类命令的位置参数就是目标 ID。
    let id_index = if group == "agent" { 3 } else { 2 };
    let target = if action.ends_with(".create")
        || matches!((group, sub), ("sync", "init") | ("sync", "export") | ("sync", "scan"))
    {
        String::new()
    } else {
        args.get(id_index)
            .filter(|a| !a.starts_with("--"))
            .cloned()
            .unwrap_or_default()
    };
    Some((action, kind, target))
}

/// 从 CLI 输出数据中提取真实资源指针（不猜：只认返回对象里明确存在的字段）。
fn cli_operation_result(data: &Value) -> operations::OperationResult {
    let mut result = operations::OperationResult::new();
    if let Some(id) = data.get("id").and_then(|v| v.as_str()) {
        result = result.resource("", id);
    } else if let Some(id) = data
        .get("handoff")
        .and_then(|h| h.get("id"))
        .and_then(|v| v.as_str())
    {
        result = result.resource("handoff", id);
    }
    result.revision(data.get("revision").and_then(|v| v.as_i64()))
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
        Ok(db) => std::sync::Arc::new(db),
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
    // 写命令才需要租约续租：CLI 是独立进程、执行时长未知（批量知识写入/同步扫描），
    // 超过 90 秒不续租会被桌面端判为 interrupted。进程级共享调度器只创建一个线程，
    // 短操作在首次 tick 前就结束，线程随进程退出。`sweep=false`：CLI 无权替别的进程判死。
    //
    // **必须在 start 之前启用**：`start` 只在运行期已启动时登记操作；
    // 顺序颠倒会让整个 CLI 进程的操作都不被续租。
    let write_action = classify_cli_write(&argv);
    if write_action.is_some() {
        operations::start_runtime(db.clone(), false);
    }
    // 认证已完成 → 开始记录操作（读命令不记录）。CLI 在 UI 关闭时照常运行，
    // 前端通过 SQLite 游标增量感知，不依赖任何桌面端进程。
    let operation = write_action.and_then(|(action, kind, target)| {
        operations::try_start(
            &db,
            &principal,
            &operations::OperationInput {
                action,
                resource_kind: kind,
                resource_id: &target,
                project_id: "",
                request_id: &request_id,
                detail: "",
            },
        )
    });
    let compact_context = argv.first().is_some_and(|group| group == "context")
        && take_flag(&mut argv.clone(), "--format").as_deref() == Some("compact_json");
    // v86.1：写命令的业务事务与操作终态同事务提交。
    // 业务成功但进程在写操作记录前退出时，不会再留下「已完成却显示运行中」的行。
    let operation_guard = operations::OperationGuard::new(
        operation
            .as_ref()
            .map(|op| op.id.clone())
            .unwrap_or_default(),
    );
    match execute(&db, &principal, &cli, argv, &operation_guard) {
        Ok(outcome) => {
            if let Some(op) = &operation {
                let result = cli_operation_result(&outcome.data);
                // 事务内已完成 → `complete` 返回 None（未广播），补发一次事件。
                match operations::complete(&db, &op.id, &result) {
                    Ok(Some(_)) => {}
                    _ => operations::notify_current(&db, &op.id),
                }
            }
            let mut meta = Meta::new(&principal, &request_id);
            if let Some(page) = &outcome.page {
                meta = meta.with_page(page.clone());
            }
            let data = filter_fields(outcome.data, &cli.fields);
            if cli.json {
                let envelope = Envelope::ok(data, meta);
                let output = if compact_context {
                    serde_json::to_string(&envelope)
                } else {
                    serde_json::to_string_pretty(&envelope)
                };
                match output {
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
            if let Some(op) = &operation {
                let _ = operations::fail(&db, &op.id, &err);
            }
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

fn execute(
    db: &Db,
    principal: &Principal,
    cli: &Cli,
    mut args: Vec<String>,
    guard: &dyn store::WriteGuard,
) -> AppResult<Outcome> {
    let outcome = execute_inner(db, principal, cli, &mut args, guard)?;
    validate_cli_arguments(&args)?;
    Ok(outcome)
}

fn execute_inner(
    db: &Db,
    principal: &Principal,
    cli: &Cli,
    args: &mut Vec<String>,
    guard: &dyn store::WriteGuard,
) -> AppResult<Outcome> {
    if args.is_empty() {
        return Err(usage_err("缺少命令组（status|info|project|task|plan|knowledge|decision|context|agent|search|sync）"));
    }
    let group = args.remove(0);
    // 只有带子命令的命令组才吞掉下一个位置参数；`search <关键词>` 等
    // 顶层命令必须把该 token 留给自己的位置参数解析，否则关键词会被
    // 误当成子命令（表现为 VALIDATION: 缺少关键词）。
    let has_subcommand = matches!(
        group.as_str(),
        "project" | "task" | "plan" | "knowledge" | "decision" | "context" | "agent" | "sync"
    );
    let sub = if has_subcommand {
        match args.iter().position(|a| !a.starts_with("--")) {
            Some(i) => args.remove(i),
            None => "list".to_string(),
        }
    } else {
        "list".to_string()
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
                let id = require_positional(args, "project_id")?;
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
                let filter = task_filter(args)?;
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
                let id = require_positional(args, "task_id")?;
                let task = service::fetch_task(db, principal, &id)?;
                Ok(Outcome {
                    human: serde_json::to_string_pretty(&task)?,
                    data: serde_json::to_value(&task)?,
                    page: None,
                })
            }
            "create" => {
                let title = take_flag(args, "--title")
                    .ok_or_else(|| usage_err("task create 需要 --title"))?;
                let input = service::TaskCreateInput {
                    title,
                    description: take_flag(args, "--description").unwrap_or_default(),
                    priority: take_flag(args, "--priority")
                        .and_then(|v| v.parse::<u8>().ok()),
                    category: take_flag(args, "--category"),
                    tags: {
                        let tags = take_all(args, "--tag");
                        if tags.is_empty() { None } else { Some(tags) }
                    },
                    due_at: take_flag(args, "--due"),
                    remind_at: take_flag(args, "--remind"),
                    advance_minutes: take_flag(args, "--advance-minutes")
                        .and_then(|v| v.parse::<i64>().ok()),
                };
                let task = service::create_task_guarded(db, principal, input, guard, "")?;
                Ok(Outcome {
                    human: format!("创建任务 {} {}", task.id, task.title),
                    data: serde_json::to_value(&task)?,
                    page: None,
                })
            }
            "update" => {
                let id = require_positional(args, "task_id")?;
                let patch = service::TaskPatch {
                    title: take_flag(args, "--title"),
                    description: take_flag(args, "--description"),
                    priority: take_flag(args, "--priority")
                        .and_then(|v| v.parse::<u8>().ok()),
                    category: take_flag(args, "--category"),
                    tags: {
                        let tags = take_all(args, "--tag");
                        if tags.is_empty() { None } else { Some(tags) }
                    },
                    due_at: take_flag(args, "--due"),
                    clear_due_at: take_flag(args, "--clear-due").is_some(),
                    remind_at: take_flag(args, "--remind"),
                    clear_remind_at: take_flag(args, "--clear-remind").is_some(),
                    advance_minutes: take_flag(args, "--advance-minutes")
                        .and_then(|v| v.parse::<i64>().ok()),
                };
                let base = take_flag(args, "--base-revision")
                    .and_then(|v| v.parse::<i64>().ok());
                let task = service::update_task_guarded(db, principal, &id, patch, base, guard)?;
                Ok(Outcome {
                    human: format!("更新任务 {} {}", task.id, task.title),
                    data: serde_json::to_value(&task)?,
                    page: None,
                })
            }
            "complete" => {
                let id = require_positional(args, "task_id")?;
                let base = take_flag(args, "--base-revision")
                    .and_then(|v| v.parse::<i64>().ok());
                let task = service::complete_task_guarded(db, principal, &id, base, guard)?;
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
                let project = take_flag(args, "--project");
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
                let id = require_positional(args, "project_id")?;
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
                let query = require_positional(args, "关键词")?;
                let kb_ids = take_all(args, "--kb");
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
                let id = require_positional(args, "document_id")?;
                let doc = service::get_knowledge(db, principal, &id)?;
                Ok(Outcome {
                    human: format!("# {}\n\n{}", doc.title, doc.content),
                    data: serde_json::to_value(&doc)?,
                    page: None,
                })
            }
            "create" => {
                let title = take_flag(args, "--title")
                    .ok_or_else(|| usage_err("knowledge create 需要 --title"))?;
                let content = match take_flag(args, "--content") {
                    Some(c) => c,
                    None => match take_flag(args, "--file") {
                        Some(path) => std::fs::read_to_string(&path).map_err(|e| {
                            AppError::Validation(format!("读取 --file 失败: {e}"))
                        })?,
                        None => return Err(usage_err("knowledge create 需要 --content 或 --file")),
                    },
                };
                let input = service::KnowledgeCreateInput {
                    title,
                    content,
                    kb_id: take_flag(args, "--kb-id").or_else(|| take_flag(args, "--kb")),
                    kb_name: take_flag(args, "--kb-name"),
                };
                let doc = service::create_knowledge_guarded(db, principal, input, guard)?;
                Ok(Outcome {
                    human: format!("写入知识 {} {}（{} 分块）", doc.id, doc.title, doc.chunk_count),
                    data: serde_json::to_value(&doc)?,
                    page: None,
                })
            }
            "update" => {
                let id = require_positional(args, "document_id")?;
                let base = take_flag(args, "--base-revision")
                    .and_then(|v| v.parse::<i64>().ok());
                let patch = service::KnowledgePatch {
                    title: take_flag(args, "--title"),
                    content: take_flag(args, "--content").or_else(|| {
                        take_flag(args, "--file")
                            .and_then(|p| std::fs::read_to_string(p).ok())
                    }),
                };
                let doc = service::update_knowledge_guarded(db, principal, &id, patch, base, guard)?;
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
                let project = take_flag(args, "--project");
                let status = take_flag(args, "--status");
                let (items, page) = service::list_decisions_authorized(
                    db,
                    principal,
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
                let id = require_positional(args, "decision_id")?;
                let decision = service::get_decision_authorized(db, principal, &id)?;
                Ok(Outcome {
                    human: serde_json::to_string_pretty(&decision)?,
                    data: serde_json::to_value(&decision)?,
                    page: None,
                })
            }
            "create" => {
                perms::require(db, principal, Capability::DecisionsWrite, "")?;
                let title = take_flag(args, "--title")
                    .ok_or_else(|| usage_err("decision create 需要 --title"))?;
                let decision = take_flag(args, "--decision")
                    .ok_or_else(|| usage_err("decision create 需要 --decision"))?;
                let input = store::DecisionInput {
                    title,
                    project_id: take_flag(args, "--project"),
                    project_kind: None,
                    context: take_flag(args, "--context").unwrap_or_default(),
                    decision,
                    consequences: take_flag(args, "--consequences").unwrap_or_default(),
                    alternatives: take_flag(args, "--alternatives").unwrap_or_default(),
                    tags: take_all(args, "--tag"),
                    status: take_flag(args, "--status"),
                };
                let created = store::create_decision_guarded(db, principal, input, guard)?;
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
                let format = take_flag(args, "--format").unwrap_or_else(|| "markdown".into());
                // --json 的历史响应同时包含条目和 Markdown，compact_json 为显式精简模式。
                let budget_format = if cli.json && format == "markdown" { "json" } else { &format };
                let req = context::ContextRequest {
                    task: take_flag(args, "--task"),
                    task_id: take_flag(args, "--task-id"),
                    project_id: take_flag(args, "--project"),
                    budget_tokens: take_flag(args, "--budget")
                        .and_then(|v| v.parse::<u32>().ok()),
                    format: Some(budget_format.to_string()),
                    ..Default::default()
                };
                let ctx = context::build(db, principal, req)?;
                let human = match format.as_str() {
                    "compact_json" => serde_json::to_string(&ctx)?,
                    "json" => serde_json::to_string_pretty(&ctx)?,
                    _ => ctx.markdown.clone(),
                };
                Ok(Outcome {
                    data: context::to_json(&ctx)?,
                    page: None,
                    human,
                })
            }
            "search" => {
                let query = require_positional(args, "关键词")?;
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
                let agent = take_flag(args, "--agent");
                let interface = take_flag(args, "--interface");
                let since = take_flag(args, "--since");
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
                        let status = take_flag(args, "--status");
                        let project = take_flag(args, "--project");
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
                        let id = require_positional(args, "handoff_id")?;
                        let item = handoff::get_handoff(db, principal, &id)?;
                        Ok(Outcome {
                            human: serde_json::to_string_pretty(&item)?,
                            data: serde_json::to_value(&item)?,
                            page: None,
                        })
                    }
                    "create" => {
                        let to = take_flag(args, "--to")
                            .ok_or_else(|| usage_err("handoff create 需要 --to <agent_id>"))?;
                        let summary = take_flag(args, "--summary")
                            .ok_or_else(|| usage_err("handoff create 需要 --summary"))?;
                        let input = store::HandoffInput {
                            to_agent_id: to,
                            summary,
                            task_id: take_flag(args, "--task-id"),
                            project_id: take_flag(args, "--project"),
                            project_kind: None,
                            completed_items: take_all(args, "--done"),
                            pending_items: take_all(args, "--pending"),
                            decisions: Vec::new(),
                            files_changed: take_all(args, "--file"),
                            risks: take_all(args, "--risk"),
                            next_steps: take_all(args, "--next"),
                        };
                        let created = handoff::create_handoff_guarded(db, principal, input, guard)?;
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
                        let id = require_positional(args, "handoff_id")?;
                        let base = take_flag(args, "--base-revision")
                            .and_then(|v| v.parse::<i64>().ok())
                            .ok_or_else(|| usage_err("状态变更需要 --base-revision"))?;
                        let result = match action.as_str() {
                            "accept" => handoff::accept_handoff(db, principal, &id, base)?,
                            "reject" => {
                                let reason = take_flag(args, "--reason").unwrap_or_default();
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
                        let agent = take_flag(args, "--agent");
                        let handoff_id = take_flag(args, "--handoff");
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
                        let id = require_positional(args, "report_id")?;
                        let item = handoff::get_report(db, principal, &id)?;
                        Ok(Outcome {
                            human: serde_json::to_string_pretty(&item)?,
                            data: serde_json::to_value(&item)?,
                            page: None,
                        })
                    }
                    "create" => {
                        let summary = take_flag(args, "--summary")
                            .ok_or_else(|| usage_err("report create 需要 --summary"))?;
                        let input = store::ReportInput {
                            summary,
                            result: take_flag(args, "--result"),
                            handoff_id: take_flag(args, "--handoff"),
                            project_id: take_flag(args, "--project"),
                            task_id: take_flag(args, "--task-id"),
                            completed_items: take_all(args, "--done"),
                            pending_items: take_all(args, "--pending"),
                            files_changed: take_all(args, "--file"),
                            evidence: Vec::new(),
                            risks: take_all(args, "--risk"),
                        };
                        let out = handoff::create_report_guarded(db, principal, input, guard)?;
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
            let query = require_positional(args, "关键词")?;
            let kinds = take_all(args, "--kind");
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
                let path = take_flag(args, "--path");
                let name = take_flag(args, "--name");
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
            "export" | "push" => {
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
            // 兼容别名：旧文档里的 pull/push 分别对应 scan/export。
            "scan" | "pull" => {
                let row = workspace::active(db)?
                    .ok_or_else(|| AppError::NotFound("工作空间尚未初始化".into()))?;
                // 扫描身份就是调用者：本机 CLI = 可信本机；带 token 的 Agent 会被拒绝
                // （文件导入不能由 Agent 触发，避免自授权循环）。
                let report = file_sync::scan(db, principal, &row)?;
                Ok(Outcome {
                    human: format!(
                        "扫描 {}，导入 {}，待批准 {}，跳过 {}，失败 {}，冲突 {}",
                        report.scanned,
                        report.imported,
                        report.pending_review,
                        report.skipped,
                        report.failed,
                        report.conflicts
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
                let id = require_positional(args, "conflict_id")?;
                // 新协议：--resolution db|file|dismiss；兼容旧写法 --action keep-db|keep-file|dismiss。
                let resolution = match take_flag(args, "--resolution") {
                    Some(value) if !value.trim().is_empty() => value,
                    _ => match take_flag(args, "--action") {
                        Some(value) => match value.trim() {
                            "keep-db" => "db".to_string(),
                            "keep-file" => "file".to_string(),
                            "dismiss" => "dismiss".to_string(),
                            other => {
                                return Err(usage_err(&format!(
                                    "resolution 必须是 db|file|dismiss（当前 {other}）"
                                )))
                            }
                        },
                        None => {
                            return Err(usage_err("sync resolve 需要 --resolution db|file|dismiss"))
                        }
                    },
                };
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

#[cfg(test)]
mod operation_tests {
    use super::*;

    fn args(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn write_commands_map_to_actions_and_reads_do_not() {
        // 同一次 CLI 调用只对应一条操作：读命令不产生「正在修改」。
        assert_eq!(
            classify_cli_write(&args(&["task", "create", "--title", "x"])),
            Some(("task.create", "task", String::new()))
        );
        assert_eq!(
            classify_cli_write(&args(&["task", "complete", "t1"])),
            Some(("task.complete", "task", "t1".to_string()))
        );
        assert_eq!(
            classify_cli_write(&args(&["agent", "handoff", "accept", "h1"])),
            Some(("handoff.accept", "handoff", "h1".to_string()))
        );
        assert_eq!(
            classify_cli_write(&args(&["agent", "report", "create", "--summary", "s"])),
            Some(("report.create", "report", String::new()))
        );
        assert_eq!(classify_cli_write(&args(&["task", "list"])), None);
        assert_eq!(classify_cli_write(&args(&["status"])), None);
        assert_eq!(classify_cli_write(&args(&["knowledge", "search", "kw"])), None);
    }

    #[test]
    fn operation_result_uses_only_returned_fields() {
        let data = serde_json::json!({ "id": "t1", "revision": 3 });
        let result = cli_operation_result(&data);
        assert_eq!(result.resource_id.as_deref(), Some("t1"));
        assert_eq!(result.revision, Some(3));

        let handoff = serde_json::json!({ "handoff": { "id": "h1" } });
        assert_eq!(
            cli_operation_result(&handoff).resource_id.as_deref(),
            Some("h1")
        );

        // 无法识别时保持空目标，不猜测 ID。
        let unknown = serde_json::json!({ "message": "ok" });
        assert!(cli_operation_result(&unknown).resource_id.is_none());
    }
}
