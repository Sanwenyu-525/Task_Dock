//! Agent 专业领域 REST 路由映射（架构文档 §8.3）。
//!
//! 只做路径/字段搬运与 JSON 封装，业务全部转发 `agent_access::domains`。
//! 安全策略（loopback / Bearer / Origin / 限流 / Idempotency-Key）由现有 REST 层负责。
//!
//! 事务所有权：REST 外层已经持有 `RequestCacheGuard + OperationGuard`；
//! 领域写操作必须接收并使用这个守卫，**不得**重新申请 requestId 或第二份 Operation。

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent_access::store::WriteGuard;
use crate::agent_access::Page;
use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::domains::{comic, manifest, novel};
use super::Principal;

#[derive(Deserialize)]
struct ContentBody {
    content: String,
    expected_revision: i64,
}

#[derive(Deserialize)]
struct MediaUpdateBody {
    version_label: String,
    status: Option<String>,
    #[serde(default)]
    review_note: String,
    expected_revision: i64,
}

#[derive(Deserialize)]
struct AdoptBody {
    expected_revision: i64,
}

fn parse<T: for<'de> Deserialize<'de>>(body: &[u8]) -> AppResult<T> {
    serde_json::from_slice(body).map_err(AppError::from)
}

fn q<'a>(query: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    query.get(key).map(String::as_str).filter(|v| !v.is_empty())
}

fn q_i64(query: &HashMap<String, String>, key: &str) -> Option<i64> {
    query.get(key).and_then(|v| v.parse::<i64>().ok())
}

/// 命中领域路由时返回 `Some((data, page))`，其余路径交回公共 REST 分发。
pub(crate) fn handle(
    db: &Db,
    principal: &Principal,
    method: &str,
    rest: &[&str],
    query: &HashMap<String, String>,
    body: &[u8],
    guard: &dyn WriteGuard,
) -> Option<AppResult<(Value, Option<Page>)>> {
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
            | ("GET", ["projects", _, "comic", "media-versions", _])
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
        let limit = q_i64(query, "limit");
        let offset = q_i64(query, "offset");
        let value = match (method, rest) {
            ("GET", ["projects", _, "domain-manifest"]) => {
                return Ok((
                    serde_json::to_value(manifest::build_for_principal(
                        db,
                        principal,
                        raw_project,
                    )?)?,
                    None,
                ));
            }
            ("GET", ["projects", _, "novel", "chapters"]) => {
                let (items, page) =
                    novel::list_chapters(db, principal, raw_project, limit, offset)?;
                (serde_json::to_value(items)?, Some(page))
            }
            ("GET", ["projects", _, "novel", "chapters", chapter]) => (
                serde_json::to_value(novel::get_chapter(
                    db,
                    principal,
                    raw_project,
                    chapter,
                )?)?,
                None,
            ),
            ("GET", ["projects", _, "novel", "chapters", chapter, "content"]) => (
                serde_json::to_value(novel::read_chapter_content(
                    db,
                    principal,
                    raw_project,
                    chapter,
                )?)?,
                None,
            ),
            ("PUT", ["projects", _, "novel", "chapters", chapter, "content"]) => {
                let input: ContentBody = parse(body)?;
                let (summary, revision) = novel::update_chapter_content_with_guard(
                    db,
                    principal,
                    raw_project,
                    chapter,
                    input.content,
                    input.expected_revision,
                    guard,
                )?;
                (json!({ "summary": summary, "revision": revision }), None)
            }
            ("GET", ["projects", _, "novel", "characters"]) => {
                let (items, page) = novel::list_characters(
                    db,
                    principal,
                    raw_project,
                    q(query, "query"),
                    limit,
                    offset,
                )?;
                (serde_json::to_value(items)?, Some(page))
            }
            ("GET", ["projects", _, "novel", "worldview"]) => {
                let (items, page) = novel::list_worldview(
                    db,
                    principal,
                    raw_project,
                    q(query, "kind"),
                    q(query, "query"),
                    limit,
                    offset,
                )?;
                (serde_json::to_value(items)?, Some(page))
            }
            ("GET", ["projects", _, "novel", "refs"]) => {
                let (items, page) = novel::list_refs(
                    db,
                    principal,
                    raw_project,
                    q(query, "entityType"),
                    q(query, "entityId"),
                    limit,
                    offset,
                )?;
                (serde_json::to_value(items)?, Some(page))
            }
            ("GET", ["projects", _, "comic", "episodes"]) => {
                let (items, page) =
                    comic::list_episodes(db, principal, raw_project, limit, offset)?;
                (serde_json::to_value(items)?, Some(page))
            }
            ("GET", ["projects", _, "comic", "shots"]) => {
                let (items, page) = comic::list_shots(
                    db,
                    principal,
                    raw_project,
                    q(query, "episodeId"),
                    limit,
                    offset,
                )?;
                (serde_json::to_value(items)?, Some(page))
            }
            ("GET", ["projects", _, "comic", "media-versions"]) => {
                let (items, page) = comic::list_media(
                    db,
                    principal,
                    raw_project,
                    q(query, "shotId"),
                    limit,
                    offset,
                )?;
                (serde_json::to_value(items)?, Some(page))
            }
            ("GET", ["projects", _, "comic", "media-versions", media]) => (
                serde_json::to_value(comic::get_media(
                    db,
                    principal,
                    raw_project,
                    media,
                )?)?,
                None,
            ),
            ("GET", ["projects", _, "comic", "characters"]) => {
                let (items, page) =
                    comic::list_characters(db, principal, raw_project, limit, offset)?;
                (serde_json::to_value(items)?, Some(page))
            }
            ("GET", ["projects", _, "comic", "scenes"]) => {
                let (items, page) =
                    comic::list_scenes(db, principal, raw_project, limit, offset)?;
                (serde_json::to_value(items)?, Some(page))
            }
            ("PUT", ["projects", _, "comic", "media-versions", media]) => {
                let input: MediaUpdateBody = parse(body)?;
                let (item, revision) = comic::update_media_with_guard(
                    db,
                    principal,
                    raw_project,
                    media,
                    input.version_label,
                    input.status,
                    input.review_note,
                    input.expected_revision,
                    guard,
                )?;
                (json!({ "media": item, "revision": revision }), None)
            }
            ("POST", ["projects", _, "comic", "media-versions", media, "adopt"]) => {
                let input: AdoptBody = parse(body)?;
                let (item, revision) = comic::adopt_media_with_guard(
                    db,
                    principal,
                    raw_project,
                    media,
                    input.expected_revision,
                    guard,
                )?;
                (json!({ "media": item, "revision": revision }), None)
            }
            _ => return Err(AppError::NotFound("未知领域路由".into())),
        };
        Ok(value)
    })())
}
