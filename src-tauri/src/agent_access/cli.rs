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
    sync as file_sync, workspace, ActorKind, Envelope, Identity, Meta, Page, Principal, Source,
};

pub const USAGE: &str = r#"Task Dock Agent CLI

用法:
  taskdock status [--json]
  taskdock info [--json]
  taskdock project list [--json] [--limit N] [--offset N] [--kind 项目类型]
  taskdock project get <project_id|plan_id>
  taskdock project current
  taskdock project create --name ... [--kind general] [--goal ...] [--template ID]
                          [--root <绝对目录>] [--dir-mode metadata_only|attach_existing|create_new]
                          [--request-id ID]
  taskdock project update <project_id|plan_id> [--name ...] [--description ...]
                          [--status active|archived] [--target-date YYYY-MM-DD]
                          [--base-revision N]
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
    ("project", "list|get|current|create|update", "项目列表/详情/当前/创建/更新"),
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
        ("project", "create", _) => ("project.create", "project"),
        ("project", "update", _) => ("project.update", "project"),
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
///
/// 提取复用 `operations::OperationResult::from_value`，与统一创建服务的返回形状对齐：
/// - 交接/报告：资源指针来自嵌套 `handoff`，顶层 revision 优先（HandoffCreated 形状）；
/// - 项目创建：统一创建形状（嵌套 `project.id` 是项目根），旧实现取不到顶层 `id`，
///   会丢掉资源指针导致 UI 无法定位；
/// - 其余（决策/任务/知识）：顶层 `id`，资源类型由写命令注册表（classify_cli_write）给出。
fn cli_operation_result(data: &Value, kind: &str) -> operations::OperationResult {
    if let Some(handoff) = data.get("handoff") {
        let mut result = operations::OperationResult::from_value("handoff", handoff);
        // 顶层 revision 优先：HandoffCreated 的 revision 在外层，不在 handoff 对象里。
        if let Some(revision) = data.get("revision").and_then(|v| v.as_i64()) {
            result.revision = Some(revision);
        }
        return result;
    }
    let mut result = if kind.is_empty() {
        operations::OperationResult::new()
    } else {
        operations::OperationResult::from_value(kind, data)
    };
    // 顶层 revision 优先（决策/任务/报告都带顶层 revision，既有语义）。
    if let Some(revision) = data.get("revision").and_then(|v| v.as_i64()) {
        result.revision = Some(revision);
    }
    result
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
    // 操作终态提取需要写命令的资源类型：项目创建返回嵌套形状（project.id），
    // 与任务/决策等顶层 id 形状的提取路径不同。
    let write_kind = write_action
        .as_ref()
        .map(|(_, kind, _)| *kind)
        .unwrap_or("");
    // 项目上下文提示（场景 I）：--project 值或 `task create <project_id>` 位置参数，
    // 解析为项目根后用于操作记录的 project_id（任务/决策/报告的返回 JSON 不含项目指针，
    // 只能来自命令参数；结果对象自带 projectId 时以真实值为准）。
    let write_project_hint = write_action.as_ref().and_then(|(action, kind, _)| {
        let raw = argv
            .iter()
            .position(|a| a == "--project")
            .and_then(|i| argv.get(i + 1))
            .cloned()
            .or_else(|| {
                if *action == "task.create" && *kind == "task" {
                    argv.iter().skip(2).find(|a| !a.starts_with("--")).cloned()
                } else {
                    None
                }
            })?;
        db.with_read(|conn| perms::resolve_project_root(conn, raw.trim()))
            .ok()
            .flatten()
    });
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
                project_id: write_project_hint.as_deref().unwrap_or(""),
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
                let mut result = cli_operation_result(&outcome.data, write_kind);
                // 项目上下文回填（场景 I）：命令参数声明的项目 ID 已解析为项目根；
                // 结果对象自带 projectId 时以真实值为准（from_value 已提取）。
                if result.project_id.is_none() {
                    if let Some(root) = write_project_hint.as_deref() {
                        result = result.project(root);
                    }
                }
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
            "create" => {
                // 创建是独立能力：project_rw 不等于可新建项目。
                perms::require(db, principal, Capability::ProjectsCreate, "")?;
                let name = take_flag(args, "--name")
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .ok_or_else(|| usage_err("project create 需要 --name"))?;
                let kind = take_flag(args, "--kind").unwrap_or_else(|| "general".into());
                let description = take_flag(args, "--description").unwrap_or_default();
                let goal = take_flag(args, "--goal").unwrap_or_default();
                let target_date = take_flag(args, "--target-date").filter(|v| !v.is_empty());
                let template_id = take_flag(args, "--template").filter(|v| !v.is_empty());
                let root_path = take_flag(args, "--root").filter(|v| !v.is_empty());
                let mode_raw = take_flag(args, "--dir-mode").unwrap_or_default();
                let mode = if mode_raw.trim().is_empty() {
                    crate::project_hub::creation::DirectoryMode::default_for(
                        root_path.as_deref().unwrap_or_default(),
                    )
                } else {
                    crate::project_hub::creation::DirectoryMode::parse(&mode_raw).ok_or_else(|| {
                        usage_err("--dir-mode 允许 metadata_only | attach_existing | create_new")
                    })?
                };
                // 统一创建门禁（与 MCP/REST 同规则）：目录创建是文件系统副作用，
                // 只能由人类在 UI 明确发起。判定依据是已解析的 principal.identity，
                // 绝不回读环境变量。scope=disabled / 只读 / 缺 projects.create
                // 已由上方 perms::require（统一授权三层）覆盖，不重复造轮子。
                if principal.identity == Identity::RegisteredAgent
                    && mode == crate::project_hub::creation::DirectoryMode::CreateNew
                {
                    return Err(AppError::Agent(
                        "CLI Agent 不能创建新目录；请改用 metadata_only / attach_existing，目录创建需由人类在 UI（工作台创建弹窗）完成".into(),
                    ));
                }
                let client_request_id = take_flag(args, "--request-id").unwrap_or_default();
                let request = crate::project_hub::creation::CreateProjectRequest {
                    client_request_id,
                    name,
                    kind,
                    description,
                    goal,
                    target_date,
                    template_id,
                    root_path,
                    directory_mode: mode,
                    dev_project_id: None,
                    note: None,
                    plan_name: None,
                    plan_description: None,
                    plan_status: None,
                    draft: Default::default(),
                    // 只授项目根（CreatorProject）：计划级授权已随 v91 外键迁移废弃。
                    agent_access_policy:
                        crate::project_hub::creation::AgentAccessPolicy::CreatorProject,
                    principal: match principal.identity {
                        Identity::RegisteredAgent => {
                            crate::project_hub::creation::RequestPrincipal::agent(
                                principal.agent_row_id.as_deref().unwrap_or_default(),
                            )
                        }
                        _ => crate::project_hub::creation::RequestPrincipal::local_human(),
                    },
                };
                // Agent 走统一创建用例（scope/能力/创建/自动授权单事务完成）；
                // 本机人类保持原路径（create_new 的目录初始化与失败补偿只在 db 版入口可用）。
                let created = match principal.identity {
                    Identity::RegisteredAgent => {
                        crate::agent_access::project_creation::create_for_agent(
                            db,
                            principal.agent_row_id.as_deref().unwrap_or_default(),
                            request,
                        )?
                    }
                    _ => crate::project_hub::creation::create(db, request)?,
                };
                let data = serde_json::to_value(&created)?;
                Ok(Outcome {
                    human: format!(
                        "已创建 {}（projectId={}, activePlanId={}, 目录={}）",
                        created.project.name,
                        created.project.id,
                        created.active_plan.id,
                        created.provisioning_status
                    ),
                    data,
                    page: None,
                })
            }
            "update" => {
                // 入参兼容计划 ID：先归一到项目根（解析不出 → NotFound）。
                let id = require_positional(args, "project_id")?;
                let root = db
                    .with_read(|conn| perms::resolve_project_root(conn, id.trim()))?
                    .ok_or_else(|| AppError::NotFound(format!("项目不存在: {id}")))?;
                let patch = crate::project_hub::service::ProjectPatch {
                    name: take_flag(args, "--name"),
                    description: take_flag(args, "--description"),
                    // 项目根生命周期状态只允许 active | archived（服务层同域校验）。
                    status: match take_flag(args, "--status") {
                        Some(raw) => {
                            let status = raw.trim().to_string();
                            if status != "active" && status != "archived" {
                                return Err(usage_err("--status 允许 active | archived"));
                            }
                            Some(status)
                        }
                        None => None,
                    },
                    // 传了 = 设置（空串按服务层语义清除）；不传 = 保持。
                    target_date: take_flag(args, "--target-date").map(Some),
                    // 传了才做乐观并发校验；不传不假设当前值。
                    expected_revision: match take_flag(args, "--base-revision") {
                        Some(raw) => Some(
                            raw.trim()
                                .parse::<i64>()
                                .map_err(|_| usage_err("--base-revision 需要整数"))?,
                        ),
                        None => None,
                    },
                    ..Default::default()
                };
                // 项目根元数据写：统一授权（身份 → scope → 能力 → grant）。
                perms::require(db, principal, Capability::ProjectsWrite, &root)?;
                // 统一服务内核（update_project_fields_tx 单事务读→比对→递增），
                // 不自行写 UPDATE SQL。
                let summary = db.with_transaction(|conn| {
                    crate::project_hub::service::update_project_fields_tx(conn, &root, patch)?;
                    crate::project_hub::service::load_summary(conn, &root)
                })?;
                Ok(Outcome {
                    human: format!(
                        "已更新 {}（projectId={}, revision={}）",
                        summary.name, summary.id, summary.revision
                    ),
                    data: serde_json::to_value(&summary)?,
                    page: None,
                })
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
        // 决策/任务：顶层 id + 顶层 revision（kind 来自写命令注册表）。
        let decision = serde_json::json!({ "id": "d1", "project_id": "p1", "revision": 3 });
        let result = cli_operation_result(&decision, "decision");
        assert_eq!(result.resource_kind.as_deref(), Some("decision"));
        assert_eq!(result.resource_id.as_deref(), Some("d1"));
        assert_eq!(result.project_id.as_deref(), Some("p1"));
        assert_eq!(result.revision, Some(3));

        // 交接：资源指针来自嵌套 handoff，顶层 revision 优先（HandoffCreated 形状）。
        let handoff = serde_json::json!({ "handoff": { "id": "h1" }, "revision": 7 });
        let result = cli_operation_result(&handoff, "handoff");
        assert_eq!(result.resource_kind.as_deref(), Some("handoff"));
        assert_eq!(result.resource_id.as_deref(), Some("h1"));
        assert_eq!(result.revision, Some(7));

        // 项目创建：统一创建返回形状（嵌套 project.id），旧实现取不到资源指针。
        let project = serde_json::json!({
            "created": true,
            "project": { "id": "proj-1", "name": "新项目" },
            "activePlan": { "id": "plan-1", "revision": 1 }
        });
        let result = cli_operation_result(&project, "project");
        assert_eq!(result.resource_kind.as_deref(), Some("project"));
        assert_eq!(result.resource_id.as_deref(), Some("proj-1"));
        assert_eq!(result.project_id.as_deref(), Some("proj-1"));
        assert_eq!(result.revision, Some(1), "回退到 activePlan.revision");

        // 无法识别时保持空目标，不猜测 ID。
        let unknown = serde_json::json!({ "message": "ok" });
        let result = cli_operation_result(&unknown, "task");
        assert!(result.resource_id.is_none());
        assert!(result.project_id.is_none());
    }
}

#[cfg(test)]
mod create_gate_tests {
    use super::*;

    fn args(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|s| s.to_string()).collect()
    }

    fn cli() -> Cli {
        Cli {
            json: false,
            limit: 50,
            offset: 0,
            fields: Vec::new(),
        }
    }

    /// 创建 project_rw Agent（可再授权能力），返回 (principal, row_id)。
    fn agent_principal(
        db: &Db,
        suffix: &str,
        capabilities: &[(&str, &str)],
    ) -> (Principal, String) {
        let created =
            crate::mcp::auth::create_agent(db, &format!("cli-gate-{suffix}"), "CLI 门禁测试 Agent")
                .expect("创建 Agent");
        crate::mcp::auth::set_agent_scope(db, &created.info.id, "project_rw").expect("设置 scope");
        for (capability, resource) in capabilities {
            crate::mcp::permissions::grant(db, &created.info.id, capability, resource)
                .expect("授予能力");
        }
        (
            Principal::agent(
                created.info.id.clone(),
                created.info.agent_id.clone(),
                Source::Cli,
            ),
            created.info.id,
        )
    }

    #[test]
    fn local_human_can_create_new_directory() {
        let db = Db::open_in_memory().expect("内存库");
        let parent = std::env::temp_dir().join(format!(
            "td-cli-create-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&parent).expect("建立父目录");
        let target = parent.join("新目录");

        let outcome = execute(
            &db,
            &Principal::local(Source::Cli),
            &cli(),
            args(&[
                "project",
                "create",
                "--name",
                "本地创建",
                "--root",
                target.to_str().expect("utf8 路径"),
                "--dir-mode",
                "create_new",
            ]),
            &store::NoGuard,
        )
        .expect("本机用户允许 create_new");

        assert_eq!(outcome.data["created"], serde_json::json!(true));
        assert_eq!(outcome.data["project"]["name"], serde_json::json!("本地创建"));
        assert_eq!(
            outcome.data["provisioningStatus"],
            serde_json::json!("created"),
            "目录应真实创建"
        );
        assert!(target.is_dir(), "create_new 必须落目录");
        std::fs::remove_dir_all(&parent).ok();
    }

    #[test]
    fn registered_agent_cannot_create_new_directory() {
        let db = Db::open_in_memory().expect("内存库");
        let (principal, _) = agent_principal(&db, "gate", &[("projects.create", "")]);
        let parent = std::env::temp_dir().join(format!(
            "td-cli-agent-gate-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&parent).expect("建立父目录");
        let target = parent.join("不得创建");

        let err = match execute(
            &db,
            &principal,
            &cli(),
            args(&[
                "project",
                "create",
                "--name",
                "越权创建",
                "--root",
                target.to_str().expect("utf8 路径"),
                "--dir-mode",
                "create_new",
            ]),
            &store::NoGuard,
        ) {
            Err(err) => err,
            Ok(_) => panic!("RegisteredAgent 的 create_new 必须被拒绝"),
        };

        assert!(matches!(err, AppError::Agent(_)), "{err:?}");
        assert!(
            err.user_message().contains("CLI Agent 不能创建新目录"),
            "错误文案必须明确指引: {}",
            err.user_message()
        );
        assert!(err.user_message().contains("metadata_only"));
        assert!(!target.exists(), "拒绝后不得创建目录");
        std::fs::remove_dir_all(&parent).ok();
    }

    #[test]
    fn registered_agent_can_attach_existing_with_capability_and_grant() {
        let db = Db::open_in_memory().expect("内存库");
        let (principal, row_id) =
            agent_principal(&db, "attach", &[("projects.create", "")]);
        // attach_existing 允许离线目录：路径不存在不是失败，而是 attached_offline。
        let missing = std::env::temp_dir()
            .join(format!("td-cli-offline-{}", uuid::Uuid::new_v4().simple()))
            .join("不存在");

        let outcome = execute(
            &db,
            &principal,
            &cli(),
            args(&[
                "project",
                "create",
                "--name",
                "离线关联",
                "--root",
                missing.to_str().expect("utf8 路径"),
                "--dir-mode",
                "attach_existing",
            ]),
            &store::NoGuard,
        )
        .expect("有 projects.create 能力的 Agent 允许 attach_existing");

        let project_id = outcome.data["project"]["id"].as_str().expect("项目根 ID");
        assert_eq!(
            outcome.data["provisioningStatus"],
            serde_json::json!("attached_offline"),
            "目录不存在不能被当成创建成功，而是离线关联"
        );
        // 创建后自动授予该项目根（capability 决定能不能建，grant 落到具体项目）。
        let granted: i64 = db
            .with_read(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM mcp_agent_grants WHERE agent_row_id = ?1 AND project_id = ?2",
                    rusqlite::params![row_id, project_id],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .expect("查询授权");
        assert_eq!(granted, 1, "创建者应自动获得该项目根授权");
    }

    #[test]
    fn registered_agent_metadata_only_passes() {
        let db = Db::open_in_memory().expect("内存库");
        let (principal, _) = agent_principal(&db, "meta", &[("projects.create", "")]);

        let outcome = execute(
            &db,
            &principal,
            &cli(),
            args(&[
                "project",
                "create",
                "--name",
                "仅元数据",
                "--dir-mode",
                "metadata_only",
            ]),
            &store::NoGuard,
        )
        .expect("有 projects.create 能力的 Agent 允许 metadata_only");

        assert_eq!(outcome.data["project"]["name"], serde_json::json!("仅元数据"));
        let status = outcome.data["provisioningStatus"].as_str().expect("状态");
        assert!(
            status == "metadata_only" || status == "none",
            "仅元数据不落目录: {status}"
        );
    }

    #[test]
    fn registered_agent_without_create_capability_is_rejected() {
        let db = Db::open_in_memory().expect("内存库");
        // scope=project_rw 但未授予 projects.create：统一授权第二/三层必须拒绝。
        let (principal, _) = agent_principal(&db, "nocap", &[]);

        let err = match execute(
            &db,
            &principal,
            &cli(),
            args(&[
                "project",
                "create",
                "--name",
                "无能力创建",
                "--dir-mode",
                "metadata_only",
            ]),
            &store::NoGuard,
        ) {
            Err(err) => err,
            Ok(_) => panic!("缺 projects.create 必须拒绝"),
        };

        assert!(matches!(err, AppError::Agent(_)), "{err:?}");
        assert!(
            err.user_message().contains("projects.create"),
            "错误必须指明缺失的能力: {}",
            err.user_message()
        );
    }
}

#[cfg(test)]
mod project_update_tests {
    use super::*;

    fn args(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|s| s.to_string()).collect()
    }

    fn cli() -> Cli {
        Cli {
            json: false,
            limit: 50,
            offset: 0,
            fields: Vec::new(),
        }
    }

    /// 本机人类创建一个 metadata_only 项目，返回 (根 ID, 计划 ID)。
    fn create_human_project(db: &Db, name: &str) -> (String, String) {
        let outcome = execute(
            db,
            &Principal::local(Source::Cli),
            &cli(),
            args(&["project", "create", "--name", name]),
            &store::NoGuard,
        )
        .expect("本机用户创建项目");
        let root = outcome.data["project"]["id"].as_str().expect("项目根 ID");
        let plan = outcome.data["activePlan"]["id"].as_str().expect("计划 ID");
        (root.to_string(), plan.to_string())
    }

    #[test]
    fn local_human_updates_project_and_revision_bumps() {
        let db = Db::open_in_memory().expect("内存库");
        let (root, _) = create_human_project(&db, "更新前");

        let outcome = execute(
            &db,
            &Principal::local(Source::Cli),
            &cli(),
            args(&["project", "update", &root, "--name", "更新后"]),
            &store::NoGuard,
        )
        .expect("本机用户更新项目");

        assert_eq!(outcome.data["id"].as_str(), Some(root.as_str()), "data.id 是项目根");
        assert_eq!(outcome.data["name"], serde_json::json!("更新后"));
        assert_eq!(outcome.data["revision"], serde_json::json!(2), "更新后 revision 递增");
    }

    #[test]
    fn stale_base_revision_conflicts() {
        let db = Db::open_in_memory().expect("内存库");
        let (root, _) = create_human_project(&db, "并发项目");

        let err = match execute(
            &db,
            &Principal::local(Source::Cli),
            &cli(),
            args(&["project", "update", &root, "--name", "过期提交", "--base-revision", "99"]),
            &store::NoGuard,
        ) {
            Err(err) => err,
            Ok(_) => panic!("过期 revision 必须冲突"),
        };

        assert!(matches!(err, AppError::Conflict(_)), "{err:?}");
    }

    #[test]
    fn agent_without_project_grant_is_forbidden() {
        let db = Db::open_in_memory().expect("内存库");
        let (root, _) = create_human_project(&db, "他人项目");
        // project_rw + 全局 projects.write 能力，但没有该项目根的 grant（v92 第三层）。
        let created =
            crate::mcp::auth::create_agent(&db, "upd-no-grant", "无授权 Agent").expect("创建 Agent");
        crate::mcp::auth::set_agent_scope(&db, &created.info.id, "project_rw").expect("设置 scope");
        crate::mcp::permissions::grant(&db, &created.info.id, "projects.write", "")
            .expect("授予能力");
        let principal = Principal::agent(
            created.info.id.clone(),
            created.info.agent_id.clone(),
            Source::Cli,
        );

        let err = match execute(
            &db,
            &principal,
            &cli(),
            args(&["project", "update", &root, "--name", "越权更新"]),
            &store::NoGuard,
        ) {
            Err(err) => err,
            Ok(_) => panic!("无 grant 必须拒绝"),
        };

        assert_eq!(super::super::error_code(&err), "FORBIDDEN", "{err:?}");
        assert!(err.user_message().contains("未授权项目"), "{err:?}");
    }

    #[test]
    fn plan_id_resolves_to_root_and_mirrors_name() {
        let db = Db::open_in_memory().expect("内存库");
        let (root, plan) = create_human_project(&db, "归一根前");

        let outcome = execute(
            &db,
            &Principal::local(Source::Cli),
            &cli(),
            args(&["project", "update", &plan, "--name", "归一根后"]),
            &store::NoGuard,
        )
        .expect("计划 ID 入参必须归一到项目根");

        assert_eq!(
            outcome.data["id"].as_str(),
            Some(root.as_str()),
            "更新落在项目根上"
        );
        assert_eq!(outcome.data["revision"], serde_json::json!(2));
        // 计划容器镜像列同步更新。
        let mirrored: Vec<String> = db
            .with_read(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT name FROM planning_projects WHERE workspace_project_id = ?1",
                )?;
                let rows = stmt.query_map(rusqlite::params![root], |r| r.get(0))?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(AppError::from)
            })
            .expect("查询计划镜像");
        assert_eq!(mirrored, vec!["归一根后".to_string()], "计划镜像名同步");
    }

    #[test]
    fn operation_record_points_to_root() {
        let db = Db::open_in_memory().expect("内存库");
        let (_, plan) = create_human_project(&db, "操作记录项目");
        let principal = Principal::local(Source::Cli);
        // 仿 main_entry：写命令先登记操作，业务成功后写终态。
        let operation = operations::try_start(
            &db,
            &principal,
            &operations::OperationInput {
                action: "project.update",
                resource_kind: "project",
                resource_id: &plan,
                project_id: "",
                request_id: "req-update-test",
                detail: "",
            },
        )
        .expect("登记操作");

        let outcome = execute(
            &db,
            &principal,
            &cli(),
            args(&["project", "update", &plan, "--name", "操作记录后"]),
            &store::NoGuard,
        )
        .expect("更新成功");
        // 终态提取：ProjectSummary（顶层 id）形状 → resource_id 与 project 指针都是根。
        let result = cli_operation_result(&outcome.data, "project");
        operations::complete(&db, &operation.id, &result).expect("写操作终态");

        let (status, resource_kind, resource_id, project_id, revision): (
            String,
            String,
            String,
            String,
            i64,
        ) = db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT status, resource_kind, resource_id, project_id, revision
                     FROM agent_operations WHERE id = ?1",
                    rusqlite::params![operation.id],
                    |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                        ))
                    },
                )?)
            })
            .expect("查询操作记录");
        assert_eq!(status, "committed");
        assert_eq!(resource_kind, "project");
        assert_eq!(resource_id, root_of(&db, &plan), "resource_id 归一到项目根");
        assert_eq!(project_id, root_of(&db, &plan), "project_id 是项目根");
        assert_eq!(revision, 2, "操作记录携带更新后的项目根 revision");
    }

    fn root_of(db: &Db, plan_id: &str) -> String {
        db.with_read(|conn| perms::resolve_project_root(conn, plan_id))
            .expect("解析项目根")
            .expect("计划 ID 必须能归一根")
    }
}
