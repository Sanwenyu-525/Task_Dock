//! Agent 专业领域 MCP 工具（架构文档 §8.2）。
//!
//! 工具静态注册；Manifest 按 projectId 动态返回。业务分发只按注册中心的操作 ID，
//! 不在本文件写SQL，也不自行做权限判定。

use serde_json::{json, Value};

use crate::agent_access::domains::{comic, manifest, novel, registry};
use crate::error::{AppError, AppResult};
use crate::mcp::tools::{
    arg_str, outcome, schema, CallOutcome, ToolCtx, ToolDef, ToolError,
};

use super::{permissions as perms, Principal, Source};

const MANIFEST_TOOL: &str = "taskdock_get_project_domain_manifest";

/// 操作 ID → 静态工具名。新增操作必须同时登记，契约测试会校验一一对应。
pub const OP_TOOLS: &[(&str, &str)] = &[
    ("novel.chapter.list", "taskdock_novel_list_chapters"),
    ("novel.chapter.get", "taskdock_novel_get_chapter"),
    ("novel.chapter.content.read", "taskdock_novel_get_chapter_content"),
    (
        "novel.chapter.content.update",
        "taskdock_novel_update_chapter_content",
    ),
    ("novel.character.list", "taskdock_novel_list_characters"),
    ("novel.worldview.list", "taskdock_novel_list_worldview"),
    ("novel.ref.list", "taskdock_novel_list_entity_refs"),
    ("comic.episode.list", "taskdock_comic_list_episodes"),
    ("comic.shot.list", "taskdock_comic_list_shots"),
    ("comic.media.list", "taskdock_comic_list_media_versions"),
    ("comic.character.list", "taskdock_comic_list_characters"),
    ("comic.scene.list", "taskdock_comic_list_scenes"),
    ("comic.media.update", "taskdock_comic_save_media_version"),
    ("comic.media.adopt", "taskdock_comic_adopt_media_version"),
];

fn tool_name(op_id: &str) -> Option<&'static str> {
    OP_TOOLS
        .iter()
        .find(|(id, _)| *id == op_id)
        .map(|(_, name)| *name)
}

fn op_id_of(tool: &str) -> Option<&'static str> {
    OP_TOOLS
        .iter()
        .find(|(_, name)| *name == tool)
        .map(|(id, _)| *id)
}

fn props() -> Value {
    json!({
        "project_id": { "type": "string", "description": "项目根 ID（workspace_projects.id）" },
        "chapter_id": { "type": "string" },
        "episode_id": { "type": "string" },
        "shot_id": { "type": "string" },
        "media_id": { "type": "string" },
        "content": { "type": "string" },
        "version_label": { "type": "string" },
        "status": { "type": "string" },
        "review_note": { "type": "string" },
        "kind": { "type": "string" },
        "query": { "type": "string" },
        "entity_type": { "type": "string" },
        "entity_id": { "type": "string" },
        "expected_revision": { "type": "integer", "minimum": 0 },
        "request_id": { "type": "string", "description": "写操作幂等键" }
    })
}

pub fn definitions_for_registry() -> Vec<ToolDef> {
    let mut defs = vec![ToolDef {
        name: MANIFEST_TOOL,
        description: "按真实项目类型返回 Agent 领域能力 Manifest（能力发现，不是授权凭证）。",
        input_schema: schema(json!({
            "project_id": { "type": "string" }
        }), &["project_id"]),
        write: false,
    }];
    for op in registry::all_operations() {
        let Some(name) = tool_name(op.id) else { continue };
        let mut required = vec!["project_id"];
        if op.access == registry::OperationAccess::Write {
            required.extend(["expected_revision", "request_id"]);
        }
        defs.push(ToolDef {
            name,
            description: op.id,
            input_schema: schema(props(), &required),
            write: op.access == registry::OperationAccess::Write,
        });
    }
    defs
}

pub fn is_owned(name: &str) -> bool {
    name == MANIFEST_TOOL || op_id_of(name).is_some()
}

fn need(args: &Value, key: &str) -> AppResult<String> {
    arg_str(args, key)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::Validation(format!("缺少参数 {key}")))
}

fn need_i64(args: &Value, key: &str) -> AppResult<i64> {
    args.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::Validation(format!("参数 {key} 必须是整数")))
}

fn principal_of(ctx: &ToolCtx) -> Principal {
    Principal::agent(ctx.agent.row_id.clone(), ctx.agent.agent_id.clone(), Source::Mcp)
}

fn resolve_project(ctx: &ToolCtx, args: &Value) -> AppResult<String> {
    let raw = need(args, "project_id")?;
    ctx.db
        .with_read(|conn| perms::resolve_project_root(conn, &raw))?
        .ok_or_else(|| AppError::NotFound(format!("项目不存在：{raw}")))
}

pub(crate) fn call(
    ctx: &ToolCtx,
    name: &str,
    args: &Value,
    _write_conn: Option<&rusqlite::Connection>,
) -> Option<Result<CallOutcome, ToolError>> {
    if !is_owned(name) {
        return None;
    }
    let db = ctx.db.as_ref();
    let principal = principal_of(ctx);
    let result = (|| -> AppResult<(Value, &'static str, String)> {
        if name == MANIFEST_TOOL {
            let project_id = resolve_project(ctx, args)?;
            let value = serde_json::to_value(manifest::build_for_project(db, &project_id)?)?;
            return Ok((value, "project", project_id));
        }
        let op = op_id_of(name).ok_or_else(|| AppError::Validation("未知领域操作".into()))?;
        let project = resolve_project(ctx, args)?;
        let (value, id) = match op {
            "novel.chapter.list" => (
                serde_json::to_value(novel::list_chapters(db, &principal, &project)?)?,
                project.clone(),
            ),
            "novel.chapter.get" => {
                let id = need(args, "chapter_id")?;
                (
                    serde_json::to_value(novel::get_chapter(db, &principal, &project, &id)?)?,
                    id,
                )
            }
            "novel.chapter.content.read" => {
                let id = need(args, "chapter_id")?;
                let content = novel::read_chapter_content(db, &principal, &project, &id)?;
                (json!({ "chapterId": id, "content": content }), id)
            }
            "novel.chapter.content.update" => {
                let id = need(args, "chapter_id")?;
                let content = need(args, "content")?;
                let revision = need_i64(args, "expected_revision")?;
                let request_id = need(args, "request_id")?;
                let (summary, new_revision) = novel::update_chapter_content(
                    db,
                    &principal,
                    &project,
                    &id,
                    content,
                    revision,
                    &request_id,
                )?;
                (
                    json!({ "summary": summary, "revision": new_revision }),
                    id,
                )
            }
            "novel.character.list" => {
                let query = arg_str(args, "query");
                (
                    serde_json::to_value(novel::list_characters(
                        db, &principal, &project, query,
                    )?)?,
                    project.clone(),
                )
            }
            "novel.worldview.list" => {
                let kind = arg_str(args, "kind");
                let query = arg_str(args, "query");
                (
                    serde_json::to_value(novel::list_worldview(
                        db, &principal, &project, kind, query,
                    )?)?,
                    project.clone(),
                )
            }
            "novel.ref.list" => {
                let kind = arg_str(args, "entity_type");
                let id = arg_str(args, "entity_id");
                (
                    serde_json::to_value(novel::list_refs(
                        db, &principal, &project, kind, id,
                    )?)?,
                    project.clone(),
                )
            }
            "comic.episode.list" => (
                serde_json::to_value(comic::list_episodes(db, &principal, &project)?)?,
                project.clone(),
            ),
            "comic.shot.list" => (
                serde_json::to_value(comic::list_shots(
                    db,
                    &principal,
                    &project,
                    args.get("episode_id").and_then(Value::as_str).map(str::to_string),
                )?)?,
                project.clone(),
            ),
            "comic.media.list" => (
                serde_json::to_value(comic::list_media(
                    db,
                    &principal,
                    &project,
                    args.get("shot_id").and_then(Value::as_str).map(str::to_string),
                )?)?,
                project.clone(),
            ),
            "comic.character.list" => (
                serde_json::to_value(comic::list_characters(db, &principal, &project)?)?,
                project.clone(),
            ),
            "comic.scene.list" => (
                serde_json::to_value(comic::list_scenes(db, &principal, &project)?)?,
                project.clone(),
            ),
            "comic.media.update" => {
                let id = need(args, "media_id")?;
                let label = need(args, "version_label")?;
                let status = arg_str(args, "status").map(str::to_string);
                let note = arg_str(args, "review_note").unwrap_or("").to_string();
                let revision = need_i64(args, "expected_revision")?;
                let request_id = need(args, "request_id")?;
                let (media, new_revision) = comic::update_media(
                    db,
                    &principal,
                    &project,
                    &id,
                    label,
                    status,
                    note,
                    revision,
                    &request_id,
                )?;
                (json!({ "media": media, "revision": new_revision }), id)
            }
            "comic.media.adopt" => {
                let id = need(args, "media_id")?;
                let revision = need_i64(args, "expected_revision")?;
                let request_id = need(args, "request_id")?;
                let (media, new_revision) = comic::adopt_media(
                    db,
                    &principal,
                    &project,
                    &id,
                    revision,
                    &request_id,
                )?;
                (json!({ "media": media, "revision": new_revision }), id)
            }
            _ => return Err(AppError::Validation(format!("领域操作未实现：{op}"))),
        };
        let def = registry::find_operation(op).ok_or_else(|| AppError::Validation("操作未注册".into()))?;
        Ok((value, def.resource_kind, id))
    })();

    Some(match result {
        Ok((value, kind, id)) => Ok(outcome(value, kind, id, None)),
        Err(err) => Err(ToolError::Failed(err)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_match_registered_operations() {
        let defs = definitions_for_registry();
        assert_eq!(defs.len(), registry::all_operations().len() + 1);
        for op in registry::all_operations() {
            assert!(tool_name(op.id).is_some(), "缺少工具映射：{}", op.id);
            assert!(defs.iter().any(|d| d.name == tool_name(op.id).unwrap()));
        }
        assert!(is_owned(MANIFEST_TOOL));
    }
}
