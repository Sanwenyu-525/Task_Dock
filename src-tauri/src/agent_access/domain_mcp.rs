//! Agent 专业领域 MCP 工具（架构文档 §8.2）。
//!
//! 工具静态注册；Manifest 按 projectId 动态返回。业务分发只按注册中心的操作 ID，
//! 不在本文件写 SQL，也不自行做权限判定。
//!
//! 事务所有权：MCP 写操作的事务、审计重放、Operation 完成都由 `run_tool_call`
//! 拥有。本模块只消费它传入的 `write_conn`，调用领域 `*_in_conn` 核心，
//! **禁止**再调用 `db.with_conn` / `db.with_read` / `db.with_transaction`，
//! 也**禁止**调用领域幂等包装（否则会二次申请幂等键/Operation）。

use serde_json::{json, Value};

use crate::agent_access::domains::{comic, manifest, novel, registry};
use crate::error::{AppError, AppResult};
use crate::mcp::tools::{
    arg_str, outcome, schema, CallOutcome, ToolCtx, ToolDef, ToolError,
};
use crate::mcp::PlanningChanged;

use super::{Principal, Source};

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
    (
        "comic.media.get",
        "taskdock_comic_get_media_version",
    ),
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

// ── 精确参数 Schema（每个操作只声明自己接受的字段） ─────────────────

fn str_prop(desc: &str, max_len: u32) -> Value {
    json!({ "type": "string", "maxLength": max_len, "description": desc })
}

fn int_prop(desc: &str, minimum: i64, maximum: Option<i64>) -> Value {
    match maximum {
        Some(max) => json!({ "type": "integer", "minimum": minimum, "maximum": max, "description": desc }),
        None => json!({ "type": "integer", "minimum": minimum, "description": desc }),
    }
}

fn enum_prop(desc: &str, values: &[&str]) -> Value {
    json!({ "type": "string", "enum": values, "description": desc })
}

fn request_id_prop() -> Value {
    json!({
        "type": "string",
        "maxLength": 128,
        "minLength": 1,
        "description": "必填：本次写请求的唯一幂等标识（camelCase requestId，与 run_tool_call 读取一致）"
    })
}

fn project_prop() -> Value {
    json!({ "type": "string", "maxLength": 128, "description": "项目根 ID（workspace_projects.id），可使用计划 ID 解析" })
}

fn limit_prop() -> Value {
    int_prop("分页大小，默认 50，最大 200", 1, Some(200))
}

fn offset_prop() -> Value {
    int_prop("分页起点，默认 0", 0, None)
}

fn list_props(extra: Value) -> Value {
    let mut props = json!({
        "project_id": project_prop(),
        "limit": limit_prop(),
        "offset": offset_prop(),
    });
    if let (Value::Object(map), Value::Object(base)) = (extra, props.clone()) {
        let mut merged = base;
        for (k, v) in map {
            merged.insert(k, v);
        }
        props = Value::Object(merged);
    }
    props
}

fn schema_for(op_id: &str) -> Option<Value> {
    let (props, required): (Value, &[&str]) = match op_id {
        "novel.chapter.list" => (list_props(json!({})), &["project_id"]),
        "novel.chapter.get" => (
            json!({
                "project_id": project_prop(),
                "chapter_id": str_prop("章节 ID", 128),
            }),
            &["project_id", "chapter_id"],
        ),
        "novel.chapter.content.read" => (
            json!({
                "project_id": project_prop(),
                "chapter_id": str_prop("章节 ID", 128),
            }),
            &["project_id", "chapter_id"],
        ),
        "novel.chapter.content.update" => (
            json!({
                "project_id": project_prop(),
                "chapter_id": str_prop("章节 ID", 128),
                "content": str_prop("章节正文；≤ 256KiB", 262144),
                "expected_revision": int_prop("必填：读取结果中的 revision；不匹配返回冲突", 0, None),
                "requestId": request_id_prop(),
            }),
            &[
                "project_id",
                "chapter_id",
                "content",
                "expected_revision",
                "requestId",
            ],
        ),
        "novel.character.list" => (
            list_props(json!({"query": str_prop("按名称/别名模糊搜索", 200)})),
            &["project_id"],
        ),
        "novel.worldview.list" => (
            list_props(json!({
                "kind": enum_prop("设定类型", crate::commands::novel_workspace::WORLDVIEW_KINDS),
                "query": str_prop("按名称/描述模糊搜索", 200),
            })),
            &["project_id"],
        ),
        "novel.ref.list" => (
            list_props(json!({
                "entity_type": enum_prop("引用实体类型", crate::commands::novel_workspace::ENTITY_TYPES),
                "entity_id": str_prop("实体 ID", 128),
            })),
            &["project_id"],
        ),
        "comic.episode.list" => (list_props(json!({})), &["project_id"]),
        "comic.shot.list" => (
            list_props(json!({"episode_id": str_prop("只返回指定剧集的分镜", 128)})),
            &["project_id"],
        ),
        "comic.media.list" => (
            list_props(json!({"shot_id": str_prop("只返回指定镜头的素材版本", 128)})),
            &["project_id"],
        ),
        "comic.media.get" => (
            json!({
                "project_id": project_prop(),
                "media_id": str_prop("素材版本 ID", 128),
            }),
            &["project_id", "media_id"],
        ),
        "comic.character.list" | "comic.scene.list" => {
            (list_props(json!({})), &["project_id"])
        }
        "comic.media.update" => (
            json!({
                "project_id": project_prop(),
                "media_id": str_prop("素材版本 ID", 128),
                "version_label": str_prop("版本标注，≤ 240 字符", 240),
                "status": enum_prop("候选/拒收；adopted 必须走 adopt", &["candidate", "rejected"]),
                "review_note": str_prop("修改意见，≤ 4000 字符", 4000),
                "expected_revision": int_prop("必填：读取结果中的 revision；不匹配返回冲突", 0, None),
                "requestId": request_id_prop(),
            }),
            &[
                "project_id",
                "media_id",
                "version_label",
                "expected_revision",
                "requestId",
            ],
        ),
        "comic.media.adopt" => (
            json!({
                "project_id": project_prop(),
                "media_id": str_prop("素材版本 ID", 128),
                "expected_revision": int_prop("必填：读取结果中的 revision；不匹配返回冲突", 0, None),
                "requestId": request_id_prop(),
            }),
            &[
                "project_id",
                "media_id",
                "expected_revision",
                "requestId",
            ],
        ),
        _ => return None,
    };
    Some(schema(props, required))
}

pub fn definitions_for_registry() -> Vec<ToolDef> {
    let mut defs = vec![ToolDef {
        name: MANIFEST_TOOL,
        description: "按真实项目类型返回 Agent 领域能力 Manifest（能力发现，不是授权凭证；仍需项目读取授权）。",
        input_schema: schema(json!({ "project_id": project_prop() }), &["project_id"]),
        write: false,
    }];
    for op in registry::all_operations() {
        let Some(name) = tool_name(op.id) else { continue };
        defs.push(ToolDef {
            name,
            description: op.id,
            input_schema: schema_for(op.id).unwrap_or_else(|| {
                panic!("领域操作 {} 缺少精确 MCP 参数 Schema", op.id)
            }),
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

/// 正文/备注等原样字段：只要求存在，不 trim（正文首尾空白属于内容）。
fn raw_text(args: &Value, key: &str) -> AppResult<String> {
    arg_str(args, key)
        .map(str::to_string)
        .ok_or_else(|| AppError::Validation(format!("缺少参数 {key}")))
}

fn need_i64(args: &Value, key: &str) -> AppResult<i64> {
    args.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::Validation(format!("参数 {key} 必须是整数")))
}

fn opt_i64(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(Value::as_i64)
}

fn need_request_id(args: &Value) -> AppResult<String> {
    need(args, "requestId")
}

fn principal_of(ctx: &ToolCtx) -> Principal {
    Principal::agent(ctx.agent.row_id.clone(), ctx.agent.agent_id.clone(), Source::Mcp)
}

fn page_list<T: serde::Serialize>(
    items: Vec<T>,
    page: crate::agent_access::Page,
) -> AppResult<Value> {
    Ok(json!({ "items": items, "page": page }))
}

pub(crate) fn call(
    ctx: &ToolCtx,
    name: &str,
    args: &Value,
    write_conn: Option<&rusqlite::Connection>,
) -> Option<Result<CallOutcome, ToolError>> {
    if !is_owned(name) {
        return None;
    }
    let db = ctx.db.as_ref();
    let principal = principal_of(ctx);
    let result = (|| -> AppResult<(Value, &'static str, String, Option<PlanningChanged>)> {
        if name == MANIFEST_TOOL {
            let raw = need(args, "project_id")?;
            let value =
                serde_json::to_value(manifest::build_for_principal(db, &principal, &raw)?)?;
            return Ok((value, "project", raw, None));
        }
        let op = op_id_of(name).ok_or_else(|| AppError::Validation("未知领域操作".into()))?;
        let def = registry::find_operation(op)
            .ok_or_else(|| AppError::Validation("操作未注册".into()))?;
        let raw_project = need(args, "project_id")?;
        let is_write = def.access == registry::OperationAccess::Write;
        let conn = if is_write {
            Some(write_conn.ok_or_else(|| {
                AppError::Unavailable("MCP 写操作缺少 run_tool_call 事务连接".into())
            })?)
        } else {
            None
        };
        let mut changed = None;

        let (value, id) = match op {
            "novel.chapter.list" => {
                let (items, page) =
                    novel::list_chapters(db, &principal, &raw_project, opt_i64(args, "limit"), opt_i64(args, "offset"))?;
                (page_list(items, page)?, raw_project.clone())
            }
            "novel.chapter.get" => {
                let id = need(args, "chapter_id")?;
                (
                    serde_json::to_value(novel::get_chapter(
                        db,
                        &principal,
                        &raw_project,
                        &id,
                    )?)?,
                    id,
                )
            }
            "novel.chapter.content.read" => {
                let id = need(args, "chapter_id")?;
                (
                    serde_json::to_value(novel::read_chapter_content(
                        db,
                        &principal,
                        &raw_project,
                        &id,
                    )?)?,
                    id,
                )
            }
            "novel.chapter.content.update" => {
                let conn = conn.ok_or_else(|| {
                    AppError::Unavailable("领域写操作缺少事务连接".into())
                })?;
                let id = need(args, "chapter_id")?;
                let content = raw_text(args, "content")?;
                let revision = need_i64(args, "expected_revision")?;
                let _request_id = need_request_id(args)?;
                let (summary, new_revision) = novel::update_chapter_content_in_conn(
                    conn,
                    &principal,
                    &raw_project,
                    &id,
                    content,
                    revision,
                    &crate::agent_access::store::NoGuard,
                )?;
                changed = Some(PlanningChanged {
                    kind: "novel.chapter",
                    project_id: Some(summary.chapter.project_id.clone()),
                    plan_id: None,
                    feature_id: None,
                    revision: Some(new_revision),
                });
                (json!({ "summary": summary, "revision": new_revision }), id)
            }
            "novel.character.list" => {
                let (items, page) = novel::list_characters(
                    db,
                    &principal,
                    &raw_project,
                    arg_str(args, "query"),
                    opt_i64(args, "limit"),
                    opt_i64(args, "offset"),
                )?;
                (page_list(items, page)?, raw_project.clone())
            }
            "novel.worldview.list" => {
                let (items, page) = novel::list_worldview(
                    db,
                    &principal,
                    &raw_project,
                    arg_str(args, "kind"),
                    arg_str(args, "query"),
                    opt_i64(args, "limit"),
                    opt_i64(args, "offset"),
                )?;
                (page_list(items, page)?, raw_project.clone())
            }
            "novel.ref.list" => {
                let (items, page) = novel::list_refs(
                    db,
                    &principal,
                    &raw_project,
                    arg_str(args, "entity_type"),
                    arg_str(args, "entity_id"),
                    opt_i64(args, "limit"),
                    opt_i64(args, "offset"),
                )?;
                (page_list(items, page)?, raw_project.clone())
            }
            "comic.episode.list" => {
                let (items, page) = comic::list_episodes(
                    db,
                    &principal,
                    &raw_project,
                    opt_i64(args, "limit"),
                    opt_i64(args, "offset"),
                )?;
                (page_list(items, page)?, raw_project.clone())
            }
            "comic.shot.list" => {
                let (items, page) = comic::list_shots(
                    db,
                    &principal,
                    &raw_project,
                    arg_str(args, "episode_id"),
                    opt_i64(args, "limit"),
                    opt_i64(args, "offset"),
                )?;
                (page_list(items, page)?, raw_project.clone())
            }
            "comic.media.list" => {
                let (items, page) = comic::list_media(
                    db,
                    &principal,
                    &raw_project,
                    arg_str(args, "shot_id"),
                    opt_i64(args, "limit"),
                    opt_i64(args, "offset"),
                )?;
                (page_list(items, page)?, raw_project.clone())
            }
            "comic.media.get" => {
                let id = need(args, "media_id")?;
                (
                    serde_json::to_value(comic::get_media(
                        db,
                        &principal,
                        &raw_project,
                        &id,
                    )?)?,
                    id,
                )
            }
            "comic.character.list" => {
                let (items, page) = comic::list_characters(
                    db,
                    &principal,
                    &raw_project,
                    opt_i64(args, "limit"),
                    opt_i64(args, "offset"),
                )?;
                (page_list(items, page)?, raw_project.clone())
            }
            "comic.scene.list" => {
                let (items, page) = comic::list_scenes(
                    db,
                    &principal,
                    &raw_project,
                    opt_i64(args, "limit"),
                    opt_i64(args, "offset"),
                )?;
                (page_list(items, page)?, raw_project.clone())
            }
            "comic.media.update" => {
                let conn = conn.ok_or_else(|| {
                    AppError::Unavailable("领域写操作缺少事务连接".into())
                })?;
                let id = need(args, "media_id")?;
                let label = need(args, "version_label")?;
                let status = arg_str(args, "status").map(str::to_string);
                let note = arg_str(args, "review_note").unwrap_or("").to_string();
                let revision = need_i64(args, "expected_revision")?;
                let _request_id = need_request_id(args)?;
                let (media, new_revision) = comic::update_media_in_conn(
                    conn,
                    &principal,
                    &raw_project,
                    &id,
                    label,
                    status,
                    note,
                    revision,
                    &crate::agent_access::store::NoGuard,
                )?;
                changed = Some(PlanningChanged {
                    kind: "comic.media_version",
                    project_id: Some(media.project_id.clone()),
                    plan_id: None,
                    feature_id: None,
                    revision: Some(new_revision),
                });
                (json!({ "media": media, "revision": new_revision }), id)
            }
            "comic.media.adopt" => {
                let conn = conn.ok_or_else(|| {
                    AppError::Unavailable("领域写操作缺少事务连接".into())
                })?;
                let id = need(args, "media_id")?;
                let revision = need_i64(args, "expected_revision")?;
                let _request_id = need_request_id(args)?;
                let (media, new_revision) = comic::adopt_media_in_conn(
                    conn,
                    &principal,
                    &raw_project,
                    &id,
                    revision,
                    &crate::agent_access::store::NoGuard,
                )?;
                changed = Some(PlanningChanged {
                    kind: "comic.media_version",
                    project_id: Some(media.project_id.clone()),
                    plan_id: None,
                    feature_id: None,
                    revision: Some(new_revision),
                });
                (json!({ "media": media, "revision": new_revision }), id)
            }
            _ => return Err(AppError::Validation(format!("领域操作未实现：{op}"))),
        };
        Ok((value, def.resource_kind, id, changed))
    })();

    Some(match result {
        Ok((value, kind, id, changed)) => Ok(outcome(value, kind, id, changed)),
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
            assert!(schema_for(op.id).is_some(), "缺少参数 Schema：{}", op.id);
        }
        assert!(is_owned(MANIFEST_TOOL));
    }

    fn def(name: &str) -> ToolDef {
        definitions_for_registry()
            .into_iter()
            .find(|d| d.name == name)
            .unwrap()
    }

    #[test]
    fn write_schemas_require_revision_and_camel_case_request_id() {
        for op in ["novel.chapter.content.update", "comic.media.update", "comic.media.adopt"] {
            let d = def(tool_name(op).unwrap());
            let required = d.input_schema["required"].as_array().unwrap();
            let names: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
            assert!(names.contains(&"expected_revision"), "{op}");
            assert!(names.contains(&"requestId"), "{op} 必须使用 camelCase requestId");
            assert!(!names.contains(&"request_id"), "{op} 不得混用 snake_case");
            assert!(!d.input_schema["properties"]["request_id"].is_object());
        }
    }

    #[test]
    fn schemas_have_exact_required_fields_and_enums() {
        let update = def("taskdock_novel_update_chapter_content");
        let mut required: Vec<&str> = update.input_schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        required.sort_unstable();
        assert_eq!(
            required,
            vec![
                "chapter_id",
                "content",
                "expected_revision",
                "project_id",
                "requestId"
            ]
        );
        assert_eq!(
            update.input_schema["properties"]["content"]["maxLength"],
            262144
        );

        let media = def("taskdock_comic_save_media_version");
        assert_eq!(
            media.input_schema["properties"]["version_label"]["maxLength"],
            240
        );
        assert_eq!(
            media.input_schema["properties"]["review_note"]["maxLength"],
            4000
        );
        assert_eq!(
            media.input_schema["properties"]["status"]["enum"],
            json!(["candidate", "rejected"])
        );

        let adopt = def("taskdock_comic_adopt_media_version");
        assert!(adopt.input_schema["properties"]["status"].is_null());
        assert!(adopt.input_schema["properties"]["version_label"].is_null());

        // 未知字段一律拒绝（additionalProperties=false）
        assert_eq!(update.input_schema["additionalProperties"], false);
        // 参数类型
        assert_eq!(
            media.input_schema["properties"]["expected_revision"]["type"],
            "integer"
        );
    }

    #[test]
    fn list_schemas_advertise_default_limit_window() {
        for name in [
            "taskdock_novel_list_chapters",
            "taskdock_comic_list_episodes",
            "taskdock_comic_list_media_versions",
        ] {
            let d = def(name);
            assert_eq!(d.input_schema["properties"]["limit"]["maximum"], 200);
            assert_eq!(d.input_schema["properties"]["limit"]["minimum"], 1);
            assert_eq!(d.input_schema["properties"]["offset"]["minimum"], 0);
        }
    }
}
