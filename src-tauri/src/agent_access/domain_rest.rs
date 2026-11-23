//! Agent 专业领域 REST 路由映射（架构文档 §8.3）。
//!
//! 只做路径/字段搬运与 JSON 封装，业务全部转发 `agent_access::domains`。
//! 安全策略（loopback / Bearer / Origin / 限流 / Idempotency-Key）由现有 REST 层负责。

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::domains::{comic, manifest, novel};
use super::{permissions as perms, Principal};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContentBody {
    content: String,
    expected_revision: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaUpdateBody {
    version_label: String,
    status: Option<String>,
    #[serde(default)]
    review_note: String,
    expected_revision: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdoptBody {
    expected_revision: i64,
}

fn parse<T: for<'de> Deserialize<'de>>(body: &[u8]) -> AppResult<T> {
    serde_json::from_slice(body).map_err(AppError::from)
}

fn q<'a>(query: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    query.get(key).map(String::as_str).filter(|v| !v.is_empty())
}

fn resolve_project(db: &Db, raw: &str) -> AppResult<String> {
    db.with_read(|conn| perms::resolve_project_root(conn, raw))?
        .ok_or_else(|| AppError::NotFound(format!("项目不存在：{raw}")))
}

/// 命中领域路由时返回 `Some`，其余路径交回公共 REST 分发。
pub(crate) fn handle(
    db: &Db,
    principal: &Principal,
    method: &str,
    rest: &[&str],
    query: &HashMap<String, String>,
    body: &[u8],
    request_id: &str,
) -> Option<AppResult<Value>> {
    let matched = matches!(
        (method, rest),
        ("GET", ["projects", _, "domain-manifest"])
            | ("GET", ["projects", _, "novel", "chapters"])
            | ("GET", ["projects", _, "novel", "chapters", _])
            | ("GET", ["projects", _, "novel", "chapters", _, "content"])
            | ("PUT", ["projects", _, "novel", "chapters", _, "content"])
            | ("GET", ["projects", _, "novel", "characters"])
            | ("GET", ["projects", _, "novel", "worldview"])
            | ("GET", ["projects", _, "novel", "refs"])
            | ("GET", ["projects", _, "comic", "episodes"])
            | ("GET", ["projects", _, "comic", "shots"])
            | ("GET", ["projects", _, "comic", "media-versions"])
            | ("GET", ["projects", _, "comic", "characters"])
            | ("GET", ["projects", _, "comic", "scenes"])
            | ("PUT", ["projects", _, "comic", "media-versions", _])
            | ("POST", ["projects", _, "comic", "media-versions", _, "adopt"])
    );
    if !matched {
        return None;
    }
    Some((|| {
        let raw_project = rest[1];
        let project = resolve_project(db, raw_project)?;
        let value = match (method, rest) {
            ("GET", ["projects", _, "domain-manifest"]) => {
                serde_json::to_value(manifest::build_for_project(db, &project)?)?
            }
            ("GET", ["projects", _, "novel", "chapters"]) => {
                serde_json::to_value(novel::list_chapters(db, principal, &project)?)?
            }
            ("GET", ["projects", _, "novel", "chapters", chapter]) => {
                serde_json::to_value(novel::get_chapter(db, principal, &project, chapter)?)?
            }
            ("GET", ["projects", _, "novel", "chapters", chapter, "content"]) => {
                let content = novel::read_chapter_content(db, principal, &project, chapter)?;
                json!({ "chapterId": chapter, "content": content })
            }
            ("PUT", ["projects", _, "novel", "chapters", chapter, "content"]) => {
                let input: ContentBody = parse(body)?;
                let (summary, revision) = novel::update_chapter_content(
                    db,
                    principal,
                    &project,
                    chapter,
                    input.content,
                    input.expected_revision,
                    request_id,
                )?;
                json!({ "summary": summary, "revision": revision })
            }
            ("GET", ["projects", _, "novel", "characters"]) => serde_json::to_value(
                novel::list_characters(db, principal, &project, q(query, "query"))?,
            )?,
            ("GET", ["projects", _, "novel", "worldview"]) => serde_json::to_value(
                novel::list_worldview(
                    db,
                    principal,
                    &project,
                    q(query, "kind"),
                    q(query, "query"),
                )?,
            )?,
            ("GET", ["projects", _, "novel", "refs"]) => serde_json::to_value(
                novel::list_refs(
                    db,
                    principal,
                    &project,
                    q(query, "entityType"),
                    q(query, "entityId"),
                )?,
            )?,
            ("GET", ["projects", _, "comic", "episodes"]) => {
                serde_json::to_value(comic::list_episodes(db, principal, &project)?)?
            }
            ("GET", ["projects", _, "comic", "shots"]) => serde_json::to_value(
                comic::list_shots(
                    db,
                    principal,
                    &project,
                    q(query, "episodeId").map(str::to_string),
                )?,
            )?,
            ("GET", ["projects", _, "comic", "media-versions"]) => serde_json::to_value(
                comic::list_media(
                    db,
                    principal,
                    &project,
                    q(query, "shotId").map(str::to_string),
                )?,
            )?,
            ("GET", ["projects", _, "comic", "characters"]) => {
                serde_json::to_value(comic::list_characters(db, principal, &project)?)?
            }
            ("GET", ["projects", _, "comic", "scenes"]) => {
                serde_json::to_value(comic::list_scenes(db, principal, &project)?)?
            }
            ("PUT", ["projects", _, "comic", "media-versions", media]) => {
                let input: MediaUpdateBody = parse(body)?;
                let (item, revision) = comic::update_media(
                    db,
                    principal,
                    &project,
                    media,
                    input.version_label,
                    input.status,
                    input.review_note,
                    input.expected_revision,
                    request_id,
                )?;
                json!({ "media": item, "revision": revision })
            }
            ("POST", ["projects", _, "comic", "media-versions", media, "adopt"]) => {
                let input: AdoptBody = parse(body)?;
                let (item, revision) = comic::adopt_media(
                    db,
                    principal,
                    &project,
                    media,
                    input.expected_revision,
                    request_id,
                )?;
                json!({ "media": item, "revision": revision })
            }
            _ => return Err(AppError::NotFound("未知领域路由".into())),
        };
        Ok(value)
    })())
}
