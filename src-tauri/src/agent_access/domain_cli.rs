//! Agent 专业领域 CLI 命令映射（架构文档 §8.1）。
//!
//! CLI 只做参数解析与结果封装，全部业务调用走 `agent_access::domains`，
//! 不自行访问业务表。操作 ID 与注册中心一致。
//!
//! 事务所有权：CLI 外层已经创建唯一 Operation 并持有 `OperationGuard`；
//! 本模块把该守卫传入领域写事务，禁止再创建第二份 Operation 或随机 requestId。

use serde::Serialize;
use serde_json::{json, Value};

use crate::agent_access::store::WriteGuard;
use crate::agent_access::Page;
use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::cli::take_flag;
use super::domains::{comic, development, game, general, manifest, novel, registry};
use super::Principal;

fn to_value<T: Serialize>(value: T) -> AppResult<Value> {
    serde_json::to_value(value).map_err(|err| AppError::Validation(format!("结果序列化失败：{err}")))
}

fn usage(detail: &str) -> AppError {
    AppError::Validation(format!(
        "{detail}；用法：taskdock domain manifest|ops --project-id ID | taskdock novel <chapter|character|worldview|ref> <action> --project-id ID | taskdock comic <episode|shot|media|character|scene> <action> --project-id ID"
    ))
}

fn take_action(args: &mut Vec<String>) -> String {
    if args.first().is_some_and(|a| !a.starts_with("--")) {
        args.remove(0)
    } else {
        "list".to_string()
    }
}

fn required(args: &mut Vec<String>, flag: &str) -> AppResult<String> {
    take_flag(args, flag)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| usage(&format!("缺少参数 {flag}")))
}

fn required_project(args: &mut Vec<String>) -> AppResult<String> {
    take_flag(args, "--project-id")
        .or_else(|| take_flag(args, "--project"))
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| usage("缺少参数 --project-id"))
}

fn optional_i64(args: &mut Vec<String>, flag: &str) -> AppResult<i64> {
    let raw = required(args, flag)?;
    raw.trim()
        .parse::<i64>()
        .map_err(|_| usage(&format!("{flag} 必须是整数")))
}

fn content_from_args(args: &mut Vec<String>) -> AppResult<String> {
    if let Some(path) = take_flag(args, "--file") {
        return std::fs::read_to_string(&path)
            .map_err(|err| AppError::Validation(format!("读取正文文件 {path} 失败：{err}")));
    }
    required(args, "--content")
}

/// 解析并执行领域 CLI 命令。返回 `(data, page)`；
/// `Err` 表示领域命令执行失败（调用方负责把错误落到唯一 Operation）。
#[allow(clippy::too_many_arguments)]
pub fn execute(
    db: &Db,
    principal: &Principal,
    group: &str,
    sub: &str,
    args: &mut Vec<String>,
    request_id: &str,
    limit: Option<i64>,
    offset: Option<i64>,
    guard: &dyn WriteGuard,
) -> AppResult<(Value, Option<Page>)> {
    match group {
        "domain" => execute_domain(db, principal, sub, args),
        "novel" => execute_novel(db, principal, sub, args, request_id, limit, offset, guard),
        "comic" => execute_comic(db, principal, sub, args, request_id, limit, offset, guard),
        "game" | "general" | "development" => {
            let action = take_action(args);
            let project = required_project(args)?;
            let page = |items, page| Ok((items, Some(page)));
            let unpaged = |data| Ok((data, None));
            match (group, sub, action.as_str()) {
                ("game", "facts", "get") =>
                    unpaged(to_value(game::get_facts(db, principal, &project)?)?),
                ("game", "asset", "list") => {
                    let (items, info) = game::list_assets(db, principal, &project, limit, offset)?;
                    page(to_value(items)?, info)
                }
                ("game", "build", "list") => {
                    let (items, info) = game::list_builds(db, principal, &project, limit, offset)?;
                    page(to_value(items)?, info)
                }
                ("game", "test", "list") => {
                    let (items, info) = game::list_tests(db, principal, &project, limit, offset)?;
                    page(to_value(items)?, info)
                }
                ("general", "milestone", "list") => {
                    let (items, info) = general::list_milestones(db, principal, &project, limit, offset)?;
                    page(to_value(items)?, info)
                }
                ("general", "material", "list") => {
                    let (items, info) = general::list_materials(db, principal, &project, limit, offset)?;
                    page(to_value(items)?, info)
                }
                ("general", "stats", "get") =>
                    unpaged(to_value(general::read_stats(db, principal, &project)?)?),
                ("development", "summary", "get") =>
                    unpaged(development::get_summary(db, principal, &project)?),
                ("development", "git-snapshot", "get") =>
                    unpaged(development::get_git_snapshot(db, principal, &project)?),
                ("development", "task-evidence", "list") => {
                    let task = required(args, "--task-id")?;
                    let (items, info) =
                        development::list_task_evidence(db, principal, &project, &task, limit, offset)?;
                    page(to_value(items)?, info)
                }
                ("game", "build", "create") => {
                    let input = parse_payload(args, "game.build.create")?;
                    unpaged(to_value(game::create_build_with_request(
                        db, principal, &project, input, request_id, guard,
                    )?)?)
                }
                ("game", "test", "create") => {
                    let input = parse_payload(args, "game.test.create")?;
                    unpaged(to_value(game::create_test_with_request(
                        db, principal, &project, input, request_id, guard,
                    )?)?)
                }
                ("general", "milestone", "save") => {
                    let input = parse_payload(args, "general.milestone.save")?;
                    unpaged(to_value(general::save_milestone_with_request(
                        db, principal, &project, input, request_id, guard,
                    )?)?)
                }
                ("development", "task-link", "create") => {
                    let input = parse_payload(args, "development.task_link.create")?;
                    unpaged(development::create_task_link_with_request(
                        db, principal, &project, input, request_id, guard,
                    )?)
                }
                _ => Err(usage("未知的领域命令，请用 taskdock help 查看")),
            }
        }
        _ => Err(usage("未知的命令组")),
    }
}

fn parse_payload<T: serde::de::DeserializeOwned>(
    args: &mut Vec<String>,
    operation: &str,
) -> AppResult<T> {
    let payload = required(args, "--payload")?;
    if !args.is_empty() {
        return Err(usage("写命令包含额外参数"));
    }
    registry::validate_payload_size(operation, payload.len())?;
    serde_json::from_str(&payload)
        .map_err(|_| AppError::Validation("--payload 不符合该操作的 JSON 参数契约".into()))
}

fn execute_domain(
    db: &Db,
    principal: &Principal,
    sub: &str,
    args: &mut Vec<String>,
) -> AppResult<(Value, Option<Page>)> {
    match sub {
        "manifest" => {
            let project = required_project(args)?;
            Ok((
                to_value(manifest::build_for_principal(db, principal, &project)?)?,
                None,
            ))
        }
        "ops" => {
            let ops = registry::all_operations()
                .iter()
                .map(|op| {
                    json!({
                        "id": op.id,
                        "domain": op.domain.as_str(),
                        "access": op.access.as_str(),
                        "resourceKind": op.resource_kind,
                        "permission": op.permission.as_str(),
                        "interfaces": op.interfaces.iter().map(|i| i.as_str()).collect::<Vec<_>>(),
                        "revisionRequired": op.revision_required,
                        "requestIdRequired": op.request_id_required,
                    })
                })
                .collect::<Vec<_>>();
            Ok((Value::Array(ops), None))
        }
        _ => Err(usage("domain 仅支持 manifest / ops")),
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_novel(
    db: &Db,
    principal: &Principal,
    sub: &str,
    args: &mut Vec<String>,
    request_id: &str,
    limit: Option<i64>,
    offset: Option<i64>,
    guard: &dyn WriteGuard,
) -> AppResult<(Value, Option<Page>)> {
    let action = take_action(args);
    let project = required_project(args)?;
    let mut page = None;
    let value = match (sub, action.as_str()) {
        ("chapter", "list") => {
            let (items, p) = novel::list_chapters(db, principal, &project, limit, offset)?;
            page = Some(p);
            to_value(items)?
        }
        ("chapter", "get") => {
            let id = required(args, "--chapter-id")?;
            to_value(novel::get_chapter(db, principal, &project, &id)?)?
        }
        ("chapter", "content") => {
            let id = required(args, "--chapter-id")?;
            to_value(novel::read_chapter_content(db, principal, &project, &id)?)?
        }
        ("chapter", "update-content") => {
            let id = required(args, "--chapter-id")?;
            let content = content_from_args(args)?;
            let expected = optional_i64(args, "--expected-revision")?;
            let (summary, revision) = novel::update_chapter_content_with_request(
                db,
                principal,
                &project,
                &id,
                content,
                expected,
                request_id,
                guard,
            )?;
            json!({ "summary": summary, "revision": revision })
        }
        ("character", "list") => {
            let (items, p) = novel::list_characters(
                db,
                principal,
                &project,
                take_flag(args, "--query").as_deref(),
                limit,
                offset,
            )?;
            page = Some(p);
            to_value(items)?
        }
        ("worldview", "list") => {
            let (items, p) = novel::list_worldview(
                db,
                principal,
                &project,
                take_flag(args, "--kind").as_deref(),
                take_flag(args, "--query").as_deref(),
                limit,
                offset,
            )?;
            page = Some(p);
            to_value(items)?
        }
        ("ref", "list") => {
            let (items, p) = novel::list_refs(
                db,
                principal,
                &project,
                take_flag(args, "--entity-type").as_deref(),
                take_flag(args, "--entity-id").as_deref(),
                limit,
                offset,
            )?;
            page = Some(p);
            to_value(items)?
        }
        _ => return Err(usage("不支持的小说领域命令")),
    };
    Ok((value, page))
}

#[allow(clippy::too_many_arguments)]
fn execute_comic(
    db: &Db,
    principal: &Principal,
    sub: &str,
    args: &mut Vec<String>,
    request_id: &str,
    limit: Option<i64>,
    offset: Option<i64>,
    guard: &dyn WriteGuard,
) -> AppResult<(Value, Option<Page>)> {
    let action = take_action(args);
    let project = required_project(args)?;
    let mut page = None;
    let value = match (sub, action.as_str()) {
        ("episode", "list") => {
            let (items, p) = comic::list_episodes(db, principal, &project, limit, offset)?;
            page = Some(p);
            to_value(items)?
        }
        ("shot", "list") => {
            let (items, p) = comic::list_shots(
                db,
                principal,
                &project,
                take_flag(args, "--episode-id").as_deref(),
                limit,
                offset,
            )?;
            page = Some(p);
            to_value(items)?
        }
        ("media", "list") => {
            let (items, p) = comic::list_media(
                db,
                principal,
                &project,
                take_flag(args, "--shot-id").as_deref(),
                limit,
                offset,
            )?;
            page = Some(p);
            to_value(items)?
        }
        ("media", "get") => {
            let id = required(args, "--media-id")?;
            to_value(comic::get_media(db, principal, &project, &id)?)?
        }
        ("media", "update") => {
            let id = required(args, "--media-id")?;
            let version_label = required(args, "--version-label")?;
            let status = take_flag(args, "--status");
            let review_note = take_flag(args, "--review-note").unwrap_or_default();
            let expected = optional_i64(args, "--expected-revision")?;
            let (media, revision) = comic::update_media_with_request(
                db,
                principal,
                &project,
                &id,
                version_label,
                status,
                review_note,
                expected,
                request_id,
                guard,
            )?;
            json!({ "media": media, "revision": revision })
        }
        ("media", "adopt") => {
            let id = required(args, "--media-id")?;
            let expected = optional_i64(args, "--expected-revision")?;
            let (media, revision) = comic::adopt_media_with_request(
                db,
                principal,
                &project,
                &id,
                expected,
                request_id,
                guard,
            )?;
            json!({ "media": media, "revision": revision })
        }
        ("character", "list") => {
            let (items, p) = comic::list_characters(db, principal, &project, limit, offset)?;
            page = Some(p);
            to_value(items)?
        }
        ("scene", "list") => {
            let (items, p) = comic::list_scenes(db, principal, &project, limit, offset)?;
            page = Some(p);
            to_value(items)?
        }
        _ => return Err(usage("不支持的漫剧领域命令")),
    };
    Ok((value, page))
}
