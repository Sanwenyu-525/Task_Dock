//! Agent 专业领域 CLI 命令映射（架构文档 §8.1）。
//!
//! CLI 只做参数解析与结果封装，全部业务调用走 `agent_access::domains`，
//! 不自行访问业务表。操作 ID 与注册中心一致。

use serde::Serialize;
use serde_json::{json, Value};

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::cli::take_flag;
use super::domains::{comic, manifest, novel, registry};
use super::{permissions as perms, Principal};

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

fn optional_i64(args: &mut Vec<String>, flag: &str) -> AppResult<i64> {
    let raw = required(args, flag)?;
    raw.trim()
        .parse::<i64>()
        .map_err(|_| usage(&format!("{flag} 必须是整数")))
}

fn resolve_project(db: &Db, args: &mut Vec<String>) -> AppResult<String> {
    let raw = take_flag(args, "--project-id")
        .or_else(|| take_flag(args, "--project"))
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| usage("缺少参数 --project-id"))?;
    db.with_read(|conn| perms::resolve_project_root(conn, raw.trim()))?
        .ok_or_else(|| AppError::NotFound(format!("项目不存在：{raw}")))
}

fn content_from_args(args: &mut Vec<String>) -> AppResult<String> {
    if let Some(path) = take_flag(args, "--file") {
        return std::fs::read_to_string(&path)
            .map_err(|err| AppError::Validation(format!("读取正文文件 {path} 失败：{err}")));
    }
    required(args, "--content")
}

/// 解析并执行领域 CLI 命令。返回 `None` 表示不是领域命令组。
pub fn execute(
    db: &Db,
    principal: &Principal,
    group: &str,
    sub: &str,
    args: &mut Vec<String>,
    request_id: &str,
) -> AppResult<Value> {
    match group {
        "domain" => execute_domain(db, sub, args),
        "novel" => execute_novel(db, principal, sub, args, request_id),
        "comic" => execute_comic(db, principal, sub, args, request_id),
        _ => Err(usage("未知的命令组")),
    }
}

fn execute_domain(db: &Db, sub: &str, args: &mut Vec<String>) -> AppResult<Value> {
    match sub {
        "manifest" => to_value(manifest::build_for_project(
            db,
            &resolve_project(db, args)?,
        )?),
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
            Ok(Value::Array(ops))
        }
        _ => Err(usage("domain 仅支持 manifest / ops")),
    }
}

fn execute_novel(
    db: &Db,
    principal: &Principal,
    sub: &str,
    args: &mut Vec<String>,
    request_id: &str,
) -> AppResult<Value> {
    let action = take_action(args);
    let project = resolve_project(db, args)?;
    match (sub, action.as_str()) {
        ("chapter", "list") => to_value(novel::list_chapters(db, principal, &project)?),
        ("chapter", "get") => {
            let id = required(args, "--chapter-id")?;
            to_value(novel::get_chapter(db, principal, &project, &id)?)
        }
        ("chapter", "content") => {
            let id = required(args, "--chapter-id")?;
            let content = novel::read_chapter_content(db, principal, &project, &id)?;
            Ok(json!({ "chapterId": id, "content": content }))
        }
        ("chapter", "update-content") => {
            let id = required(args, "--chapter-id")?;
            let content = content_from_args(args)?;
            let expected = optional_i64(args, "--expected-revision")?;
            let (summary, revision) = novel::update_chapter_content(
                db,
                principal,
                &project,
                &id,
                content,
                expected,
                request_id,
            )?;
            Ok(json!({ "summary": summary, "revision": revision }))
        }
        ("character", "list") => to_value(novel::list_characters(
            db,
            principal,
            &project,
            take_flag(args, "--query").as_deref(),
        )?),
        ("worldview", "list") => to_value(novel::list_worldview(
            db,
            principal,
            &project,
            take_flag(args, "--kind").as_deref(),
            take_flag(args, "--query").as_deref(),
        )?),
        ("ref", "list") => to_value(novel::list_refs(
            db,
            principal,
            &project,
            take_flag(args, "--entity-type").as_deref(),
            take_flag(args, "--entity-id").as_deref(),
        )?),
        _ => Err(usage("不支持的小说领域命令")),
    }
}

fn execute_comic(
    db: &Db,
    principal: &Principal,
    sub: &str,
    args: &mut Vec<String>,
    request_id: &str,
) -> AppResult<Value> {
    let action = take_action(args);
    let project = resolve_project(db, args)?;
    match (sub, action.as_str()) {
        ("episode", "list") => to_value(comic::list_episodes(db, principal, &project)?),
        ("shot", "list") => to_value(comic::list_shots(
            db,
            principal,
            &project,
            take_flag(args, "--episode-id"),
        )?),
        ("media", "list") => to_value(comic::list_media(
            db,
            principal,
            &project,
            take_flag(args, "--shot-id"),
        )?),
        ("media", "update") => {
            let id = required(args, "--media-id")?;
            let version_label = required(args, "--version-label")?;
            let status = take_flag(args, "--status");
            let review_note = take_flag(args, "--review-note").unwrap_or_default();
            let expected = optional_i64(args, "--expected-revision")?;
            let (media, revision) = comic::update_media(
                db,
                principal,
                &project,
                &id,
                version_label,
                status,
                review_note,
                expected,
                request_id,
            )?;
            Ok(json!({ "media": media, "revision": revision }))
        }
        ("media", "adopt") => {
            let id = required(args, "--media-id")?;
            let expected = optional_i64(args, "--expected-revision")?;
            let (media, revision) = comic::adopt_media(
                db,
                principal,
                &project,
                &id,
                expected,
                request_id,
            )?;
            Ok(json!({ "media": media, "revision": revision }))
        }
        ("character", "list") => to_value(comic::list_characters(db, principal, &project)?),
        ("scene", "list") => to_value(comic::list_scenes(db, principal, &project)?),
        _ => Err(usage("不支持的漫剧领域命令")),
    }
}
