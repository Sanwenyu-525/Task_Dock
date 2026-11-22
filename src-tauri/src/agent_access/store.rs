//! 新增实体的持久化：版本计数器、决策、交接、工作报告、活动、同步事件/冲突、
//! 上下文访问、REST 幂等缓存。
//!
//! 所有 SQL 都参数化；JSON 数组字段以文本存储，读出时容错为空数组（旧行/手改行不崩）。

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::{ActorKind, Page, Principal, Source};

// ── 通用工具 ─────────────────────────────────────────────────────

pub fn clamp_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(20).clamp(1, 200)
}

pub fn clamp_offset(offset: Option<u32>) -> u32 {
    offset.unwrap_or(0).min(10_000)
}

pub fn json_array<T: Serialize>(items: &[T]) -> String {
    serde_json::to_string(items).unwrap_or_else(|_| "[]".into())
}

pub fn parse_string_array(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

pub fn parse_value_array(raw: &str) -> Vec<Value> {
    serde_json::from_str::<Vec<Value>>(raw).unwrap_or_default()
}

/// 文本字段长度校验（字符数，不是字节数）。
pub fn check_text(field: &str, value: &str, max: usize) -> AppResult<()> {
    if value.chars().count() > max {
        return Err(AppError::Validation(format!(
            "{field} 超过 {max} 字符（当前 {}）",
            value.chars().count()
        )));
    }
    Ok(())
}

pub fn check_items(field: &str, items: &[String]) -> AppResult<()> {
    if items.len() > 50 {
        return Err(AppError::Validation(format!(
            "{field} 最多 50 项（当前 {}）",
            items.len()
        )));
    }
    for item in items {
        check_text(field, item, 500)?;
    }
    Ok(())
}

// ── 资源版本 ─────────────────────────────────────────────────────

/// 读取版本计数器（不存在返回 0/空）。
pub fn read_revision(
    conn: &Connection,
    kind: &str,
    id: &str,
) -> AppResult<(i64, String, String)> {
    let row = conn
        .query_row(
            "SELECT revision, updated_at, content_hash FROM agent_resource_revisions
             WHERE resource_kind = ?1 AND resource_id = ?2",
            rusqlite::params![kind, id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(AppError::from)?;
    Ok(row.unwrap_or((0, String::new(), String::new())))
}

/// 版本推进：计数器 +1，记录谁在什么入口写的（必须在业务写事务内调用）。
pub fn bump_revision(
    conn: &Connection,
    kind: &str,
    id: &str,
    principal: &Principal,
    updated_at: &str,
    content_hash: &str,
) -> AppResult<i64> {
    let prior = read_revision(conn, kind, id)?;
    let next = prior.0.saturating_add(1);
    conn.execute(
        "INSERT INTO agent_resource_revisions
           (id, resource_kind, resource_id, revision, updated_at, updated_by, actor_kind, source, content_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(resource_kind, resource_id) DO UPDATE SET
           revision = excluded.revision,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by,
           actor_kind = excluded.actor_kind,
           source = excluded.source,
           content_hash = excluded.content_hash",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            kind,
            id,
            next,
            updated_at,
            principal.label(),
            principal.actor_kind.as_str(),
            principal.source.as_str(),
            content_hash
        ],
    )
    .map_err(AppError::from)?;
    Ok(next)
}

/// 业务行被服务层之外的路径（UI）改过时，有效 revision = 计数器 + 1。
/// `counter_at` 是计数器认为的业务更新时间；与当前业务 `updated_at` 不一致即视为外部修改。
pub fn effective_revision(counter: i64, counter_at: &str, business_at: &str) -> i64 {
    if counter_at.is_empty() || counter_at == business_at {
        counter
    } else {
        counter.saturating_add(1)
    }
}

// ── 活动日志 ─────────────────────────────────────────────────────

/// 审计条目：只放可复核元数据，绝不放正文/Token/绝对用户路径。
pub struct ActivityEntry<'a> {
    pub principal: &'a Principal,
    pub action: &'a str,
    pub resource_kind: &'a str,
    pub resource_id: &'a str,
    pub project_id: &'a str,
    pub request_id: &'a str,
    pub success: bool,
    pub error_code: &'a str,
    pub detail: &'a str,
    pub revision: Option<i64>,
    pub duration_ms: i64,
}

/// 写活动日志（best-effort：失败只告警，绝不让审计拖垮业务请求）。
pub fn log_activity(db: &Db, entry: &ActivityEntry<'_>) {
    if let Err(err) = db.with_conn(|conn| write_activity(conn, entry)) {
        tracing::warn!("Agent 活动日志写入失败: {err}");
    }
}

pub fn write_activity(conn: &Connection, entry: &ActivityEntry<'_>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_activity_logs
           (id, agent_row_id, agent_id, actor_kind, interface, session_key, action,
            resource_kind, resource_id, project_id, request_id, success, error_code, detail,
            revision, duration_ms, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            entry.principal.agent_row_id,
            entry.principal.agent_id,
            // 表内 actor_kind 的取值域是 agent|local|system（v76 已发布 CHECK）：
            // 本机人类必须落为 `local`，否则整条审计会被 CHECK 拒绝并静默丢失。
            match entry.principal.actor_kind {
                ActorKind::Human => "local",
                ActorKind::Agent => "agent",
                ActorKind::System => "system",
            },
            entry.principal.source.as_str(),
            entry.principal.session_key,
            entry.action,
            entry.resource_kind,
            entry.resource_id,
            entry.project_id,
            entry.request_id,
            if entry.success { 1 } else { 0 },
            entry.error_code,
            truncate(entry.detail, 500),
            entry.revision,
            entry.duration_ms,
            crate::agents::now_iso(),
        ],
    )
    .map_err(AppError::from)?;
    Ok(())
}

fn truncate(raw: &str, max: usize) -> String {
    if raw.chars().count() <= max {
        return raw.to_string();
    }
    raw.chars().take(max).collect::<String>() + "…"
}

#[derive(Clone, Debug, Serialize)]
pub struct ActivityRecord {
    pub id: String,
    pub agent_id: String,
    pub actor_kind: String,
    pub interface: String,
    pub action: String,
    pub resource_kind: String,
    pub resource_id: String,
    pub project_id: String,
    pub request_id: String,
    pub success: bool,
    pub error_code: String,
    pub detail: String,
    pub revision: Option<i64>,
    pub duration_ms: i64,
    pub created_at: String,
}

pub struct ActivityQuery {
    pub agent_id: Option<String>,
    pub interface: Option<String>,
    pub since: Option<String>,
    pub limit: u32,
    pub offset: u32,
}

pub fn list_activity(db: &Db, query: &ActivityQuery) -> AppResult<(Vec<ActivityRecord>, Page)> {
    db.with_read(|conn| {
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_activity_logs
                 WHERE (?1 IS NULL OR agent_id = ?1)
                   AND (?2 IS NULL OR interface = ?2)
                   AND (?3 IS NULL OR created_at >= ?3)",
                rusqlite::params![query.agent_id, query.interface, query.since],
                |r| r.get(0),
            )
            .map_err(AppError::from)?;
        let mut stmt = conn
            .prepare(
                "SELECT id, agent_id, actor_kind, interface, action, resource_kind, resource_id,
                        project_id, request_id, success, error_code, detail, revision, duration_ms, created_at
                 FROM agent_activity_logs
                 WHERE (?1 IS NULL OR agent_id = ?1)
                   AND (?2 IS NULL OR interface = ?2)
                   AND (?3 IS NULL OR created_at >= ?3)
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?4 OFFSET ?5",
            )
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(
                rusqlite::params![
                    query.agent_id,
                    query.interface,
                    query.since,
                    query.limit as i64,
                    query.offset as i64
                ],
                |r| {
                    Ok(ActivityRecord {
                        id: r.get(0)?,
                        agent_id: r.get(1)?,
                        actor_kind: r.get(2)?,
                        interface: r.get(3)?,
                        action: r.get(4)?,
                        resource_kind: r.get(5)?,
                        resource_id: r.get(6)?,
                        project_id: r.get(7)?,
                        request_id: r.get(8)?,
                        success: r.get::<_, i64>(9)? == 1,
                        error_code: r.get(10)?,
                        detail: r.get(11)?,
                        revision: r.get(12)?,
                        duration_ms: r.get(13)?,
                        created_at: r.get(14)?,
                    })
                },
            )
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        let page = Page::new(query.limit, query.offset, total.max(0) as u32);
        Ok((out, page))
    })
}

// ── 活动可见范围（v82 授权过滤）──────────────────────────────────

/// 活动可见范围（服务端 SQL 过滤，绝不依赖前端）。
///
/// 每个集合里的 ID 既可能是资源 ID 也可是项目 ID：`tasks.read` / `knowledge.read`
/// 都允许按项目授权，因此两个集合在过滤时都同时比对 `project_id` 与 `resource_id`。
#[derive(Clone, Debug, Default)]
pub struct ActivityScope {
    /// 项目级授权（任何读能力）：该项目下全部活动可见。
    pub projects: Vec<String>,
    /// 任务级授权（任务 ID 或项目 ID）。
    pub tasks: Vec<String>,
    /// 知识库级授权（知识库 ID 或项目 ID）。
    pub knowledge: Vec<String>,
    /// 决策读授权的项目集合。
    pub decisions: Vec<String>,
    /// 交接读授权的项目集合。
    pub handoffs: Vec<String>,
    /// 规划读授权的项目集合。
    pub plans: Vec<String>,
    /// 全局读能力对应的资源类型（`task`/`knowledge`/`decision`/`handoff`/`report`/`plan`）。
    pub global_kinds: Vec<String>,
}

impl ActivityScope {
    pub fn hides_everything(&self) -> bool {
        self.projects.is_empty()
            && self.tasks.is_empty()
            && self.knowledge.is_empty()
            && self.decisions.is_empty()
            && self.handoffs.is_empty()
            && self.plans.is_empty()
            && self.global_kinds.is_empty()
    }
}

/// 活动列表（可选授权范围）。`scope=None` 表示不限制（本机 / 系统身份）。
pub fn list_activity_scoped(
    db: &Db,
    query: &ActivityQuery,
    scope: Option<&ActivityScope>,
) -> AppResult<(Vec<ActivityRecord>, Page)> {
    let Some(scope) = scope else {
        return list_activity(db, query);
    };
    db.with_read(|conn| {
        let mut clauses: Vec<String> = Vec::new();
        let mut params: Vec<rusqlite::types::Value> = Vec::new();
        let mut push_ids = |clauses: &mut Vec<String>,
                            params: &mut Vec<rusqlite::types::Value>,
                            ids: &[String]|
         -> String {
            let start = params.len() + 1;
            let placeholders = (0..ids.len())
                .map(|i| format!("?{}", start + i))
                .collect::<Vec<_>>()
                .join(",");
            params.extend(ids.iter().map(|v| rusqlite::types::Value::Text(v.clone())));
            placeholders
        };
        if !scope.projects.is_empty() {
            let ph = push_ids(&mut clauses, &mut params, &scope.projects);
            clauses.push(format!("project_id IN ({ph})"));
        }
        if !scope.tasks.is_empty() {
            let ph = push_ids(&mut clauses, &mut params, &scope.tasks);
            clauses.push(format!(
                "(resource_kind = 'task' AND (resource_id IN ({ph}) OR project_id IN ({ph})))"
            ));
        }
        if !scope.knowledge.is_empty() {
            let ph = push_ids(&mut clauses, &mut params, &scope.knowledge);
            clauses.push(format!(
                "(resource_kind = 'knowledge' AND (resource_id IN ({ph}) OR project_id IN ({ph})))"
            ));
        }
        for (kinds, ids) in [
            (&["decision".to_string()][..], &scope.decisions),
            (&["handoff".to_string(), "report".to_string()][..], &scope.handoffs),
            (&["plan".to_string()][..], &scope.plans),
        ] {
            if ids.is_empty() {
                continue;
            }
            let ph = push_ids(&mut clauses, &mut params, ids);
            let kind_list = kinds
                .iter()
                .map(|k| format!("'{k}'"))
                .collect::<Vec<_>>()
                .join(",");
            clauses.push(format!(
                "(resource_kind IN ({kind_list}) AND project_id IN ({ph}))"
            ));
        }
        if !scope.global_kinds.is_empty() {
            let kind_list = scope
                .global_kinds
                .iter()
                .map(|k| format!("'{}'", k.replace('\'', "")))
                .collect::<Vec<_>>()
                .join(",");
            clauses.push(format!("resource_kind IN ({kind_list})"));
        }
        let visibility = if clauses.is_empty() {
            "0".to_string()
        } else {
            format!("({})", clauses.join(" OR "))
        };
        let base = params.len();
        let q_agent = base + 1;
        let q_interface = base + 2;
        let q_since = base + 3;
        let q_limit = base + 4;
        let q_offset = base + 5;
        let apply_common = |params: &mut Vec<rusqlite::types::Value>| {
            params.push(match &query.agent_id {
                Some(v) => rusqlite::types::Value::Text(v.clone()),
                None => rusqlite::types::Value::Null,
            });
            params.push(match &query.interface {
                Some(v) => rusqlite::types::Value::Text(v.clone()),
                None => rusqlite::types::Value::Null,
            });
            params.push(match &query.since {
                Some(v) => rusqlite::types::Value::Text(v.clone()),
                None => rusqlite::types::Value::Null,
            });
        };
        let mut count_params = params.clone();
        apply_common(&mut count_params);
        let total: i64 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM agent_activity_logs
                     WHERE {visibility}
                       AND (?{q_agent} IS NULL OR agent_id = ?{q_agent})
                       AND (?{q_interface} IS NULL OR interface = ?{q_interface})
                       AND (?{q_since} IS NULL OR created_at >= ?{q_since})"
                ),
                rusqlite::params_from_iter(count_params.iter()),
                |r| r.get(0),
            )
            .map_err(AppError::from)?;
        let mut list_params = params;
        apply_common(&mut list_params);
        list_params.push(rusqlite::types::Value::Integer(query.limit as i64));
        list_params.push(rusqlite::types::Value::Integer(query.offset as i64));
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, agent_id, actor_kind, interface, action, resource_kind, resource_id,
                        project_id, request_id, success, error_code, detail, revision, duration_ms, created_at
                 FROM agent_activity_logs
                 WHERE {visibility}
                   AND (?{q_agent} IS NULL OR agent_id = ?{q_agent})
                   AND (?{q_interface} IS NULL OR interface = ?{q_interface})
                   AND (?{q_since} IS NULL OR created_at >= ?{q_since})
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?{q_limit} OFFSET ?{q_offset}"
            ))
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(list_params.iter()), |r| {
                Ok(ActivityRecord {
                    id: r.get(0)?,
                    agent_id: r.get(1)?,
                    actor_kind: r.get(2)?,
                    interface: r.get(3)?,
                    action: r.get(4)?,
                    resource_kind: r.get(5)?,
                    resource_id: r.get(6)?,
                    project_id: r.get(7)?,
                    request_id: r.get(8)?,
                    success: r.get::<_, i64>(9)? == 1,
                    error_code: r.get(10)?,
                    detail: r.get(11)?,
                    revision: r.get(12)?,
                    duration_ms: r.get(13)?,
                    created_at: r.get(14)?,
                })
            })
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        let page = Page::new(query.limit, query.offset, total.max(0) as u32);
        Ok((out, page))
    })
}

// ── 决策 ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Decision {
    pub id: String,
    pub project_id: String,
    pub project_kind: String,
    pub title: String,
    pub status: String,
    pub context: String,
    pub decision: String,
    pub consequences: String,
    pub alternatives: String,
    pub tags: Vec<String>,
    pub revision: i64,
    pub superseded_by: Option<String>,
    pub created_by: String,
    pub actor_kind: String,
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DecisionInput {
    pub title: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub project_kind: Option<String>,
    #[serde(default)]
    pub context: String,
    #[serde(default)]
    pub decision: String,
    #[serde(default)]
    pub consequences: String,
    #[serde(default)]
    pub alternatives: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub status: Option<String>,
}

const DECISION_COLS: &str = "id, project_id, project_kind, title, status, context, decision, \
     consequences, alternatives, tags, revision, superseded_by, created_by, actor_kind, source, \
     created_at, updated_at";

fn decision_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Decision> {
    Ok(Decision {
        id: row.get(0)?,
        project_id: row.get(1)?,
        project_kind: row.get(2)?,
        title: row.get(3)?,
        status: row.get(4)?,
        context: row.get(5)?,
        decision: row.get(6)?,
        consequences: row.get(7)?,
        alternatives: row.get(8)?,
        tags: parse_string_array(&row.get::<_, String>(9)?),
        revision: row.get(10)?,
        superseded_by: row.get(11)?,
        created_by: row.get(12)?,
        actor_kind: row.get(13)?,
        source: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

pub fn create_decision(db: &Db, principal: &Principal, input: DecisionInput) -> AppResult<Decision> {
    create_decision_guarded(db, principal, input, &NoGuard)
}

/// 带**事务内守卫**的决策写入（v82 文件导入用）。
///
/// 决策落库与导入租约校验同处一个写事务：租约失效时整体回滚，
/// 不会留下「决策已写入但租约未完成」的重复导入窗口。
pub fn create_decision_guarded(
    db: &Db,
    principal: &Principal,
    input: DecisionInput,
    guard: &dyn WriteGuard,
) -> AppResult<Decision> {
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(AppError::Validation("决策标题不能为空".into()));
    }
    check_text("title", &title, 200)?;
    check_text("context", &input.context, 8000)?;
    check_text("decision", &input.decision, 8000)?;
    check_text("consequences", &input.consequences, 4000)?;
    check_text("alternatives", &input.alternatives, 4000)?;
    check_items("tags", &input.tags)?;
    let status = input.status.as_deref().unwrap_or("proposed");
    if !matches!(status, "proposed" | "accepted" | "superseded" | "rejected") {
        return Err(AppError::Validation(format!(
            "非法决策状态: {status}（允许 proposed|accepted|superseded|rejected）"
        )));
    }
    // 归属只认项目根：入参是计划 ID 时先解析（统一身份），project_kind 由真实归属推导，
    // 收敛为 none / project（旧枚举 planning / workspace 只保留在历史行，入参声明不参与判定）。
    let raw_project = input.project_id.unwrap_or_default().trim().to_string();
    let (project_id, project_kind) = if raw_project.is_empty() {
        (String::new(), "none")
    } else {
        let root = db.with_read(|conn| {
            crate::project_hub::service::resolve_project_root(conn, &raw_project)
        })?;
        match root {
            Some(root) => (root, "project"),
            None => return Err(AppError::NotFound(format!("项目不存在: {raw_project}"))),
        }
    };
    let _ = input.project_kind;
    let now = crate::agents::now_iso();
    let decision = db.with_transaction(|conn| {
        guard.check(conn)?;
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO agent_decisions
               (id, project_id, project_kind, title, status, context, decision, consequences,
                alternatives, tags, revision, superseded_by, created_by, actor_kind, source,
                created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,NULL,?11,?12,?13,?14,?14)",
            rusqlite::params![
                id,
                project_id,
                project_kind,
                title,
                status,
                input.context,
                input.decision,
                input.consequences,
                input.alternatives,
                json_array(&input.tags),
                principal.label(),
                principal.actor_kind.as_str(),
                principal.source.as_str(),
                now,
            ],
        )
        .map_err(AppError::from)?;
        bump_revision(conn, "decision", &id, principal, &now, &String::new())?;
        guard.record_operation(conn, "decision", &id)?;
        guard.complete(conn)?;
        conn.query_row(
            &format!("SELECT {DECISION_COLS} FROM agent_decisions WHERE id = ?1"),
            rusqlite::params![id],
            decision_from_row,
        )
        .map_err(AppError::from)
    })?;
    Ok(decision)
}

pub fn list_decisions(
    db: &Db,
    project_id: Option<&str>,
    status: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<Decision>, Page)> {
    db.with_read(|conn| {
        // 项目过滤按项目根匹配；历史行可能仍以计划 ID 归属（v92 之前写入），
        // 用 plans 反查一并纳入，保证按根过滤能看到旧决策。
        let project_filter = "(?1 IS NULL OR project_id = ?1 OR project_id IN \
             (SELECT id FROM planning_projects WHERE workspace_project_id = ?1))";
        let total: i64 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM agent_decisions
                     WHERE {project_filter} AND (?2 IS NULL OR status = ?2)"
                ),
                rusqlite::params![project_id, status],
                |r| r.get(0),
            )
            .map_err(AppError::from)?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {DECISION_COLS} FROM agent_decisions
                 WHERE {project_filter} AND (?2 IS NULL OR status = ?2)
                 ORDER BY created_at DESC, id DESC LIMIT ?3 OFFSET ?4"
            ))
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(
                rusqlite::params![project_id, status, limit as i64, offset as i64],
                decision_from_row,
            )
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok((out, Page::new(limit, offset, total.max(0) as u32)))
    })
}

pub fn get_decision(db: &Db, id: &str) -> AppResult<Decision> {
    db.with_read(|conn| {
        conn.query_row(
            &format!("SELECT {DECISION_COLS} FROM agent_decisions WHERE id = ?1"),
            rusqlite::params![id],
            decision_from_row,
        )
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::NotFound(format!("决策不存在: {id}")))
    })
}

/// 按项目集合列决策（授权过滤后的服务端查询）。
///
/// `include_unscoped=false` 时排除无项目决策（`project_kind=none`）：
/// 那类决策只对**全局** `decisions.read` 可见，项目级授权不得看到。
pub fn list_decisions_in_projects(
    db: &Db,
    projects: &[String],
    include_unscoped: bool,
    status: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<Decision>, Page)> {
    db.with_read(|conn| {
        let mut where_sql = String::from("(?1 IS NULL OR status = ?1)");
        let mut params: Vec<rusqlite::types::Value> = vec![match status {
            Some(s) => rusqlite::types::Value::Text(s.to_string()),
            None => rusqlite::types::Value::Null,
        }];
        if !projects.is_empty() {
            let start = params.len() + 1;
            let placeholders = (0..projects.len())
                .map(|i| format!("?{}", start + i))
                .collect::<Vec<_>>()
                .join(",");
            params.extend(
                projects
                    .iter()
                    .map(|p| rusqlite::types::Value::Text(p.clone())),
            );
            // 授权范围按项目根表达；历史行可能仍以计划 ID 归属，用 plans 反查一并纳入。
            let project_match = format!(
                "(project_id IN ({placeholders}) OR project_id IN \
                 (SELECT id FROM planning_projects WHERE workspace_project_id IN ({placeholders})))"
            );
            if include_unscoped {
                where_sql.push_str(&format!(" AND ({project_match} OR project_id = '')"));
            } else {
                where_sql.push_str(&format!(" AND {project_match}"));
            }
        } else if include_unscoped {
            // 只有无项目决策可见。
            where_sql.push_str(" AND project_id = ''");
        } else {
            where_sql.push_str(" AND 0");
        }
        let total: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM agent_decisions WHERE {where_sql}"),
                rusqlite::params_from_iter(params.iter()),
                |r| r.get(0),
            )
            .map_err(AppError::from)?;
        let limit_at = params.len() + 1;
        let offset_at = params.len() + 2;
        params.push(rusqlite::types::Value::Integer(limit as i64));
        params.push(rusqlite::types::Value::Integer(offset as i64));
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {DECISION_COLS} FROM agent_decisions
                 WHERE {where_sql}
                 ORDER BY created_at DESC, id DESC LIMIT ?{limit_at} OFFSET ?{offset_at}"
            ))
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), decision_from_row)
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok((out, Page::new(limit, offset, total.max(0) as u32)))
    })
}

// ── 交接 ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Handoff {
    pub id: String,
    pub project_id: String,
    pub project_kind: String,
    pub task_id: Option<String>,
    pub from_agent_id: String,
    pub to_agent_id: String,
    pub status: String,
    pub summary: String,
    pub completed_items: Vec<String>,
    pub pending_items: Vec<String>,
    pub decisions: Vec<Value>,
    pub files_changed: Vec<String>,
    pub risks: Vec<String>,
    pub next_steps: Vec<String>,
    pub revision: i64,
    pub accepted_at: Option<String>,
    pub rejected_at: Option<String>,
    pub rejection_reason: String,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct HandoffInput {
    pub to_agent_id: String,
    pub summary: String,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub project_kind: Option<String>,
    #[serde(default)]
    pub completed_items: Vec<String>,
    #[serde(default)]
    pub pending_items: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<Value>,
    #[serde(default)]
    pub files_changed: Vec<String>,
    #[serde(default)]
    pub risks: Vec<String>,
    #[serde(default)]
    pub next_steps: Vec<String>,
}

const HANDOFF_COLS: &str = "id, project_id, project_kind, task_id, from_agent_id, to_agent_id, \
     status, summary, completed_items, pending_items, decisions, files_changed, risks, next_steps, \
     revision, accepted_at, rejected_at, rejection_reason, completed_at, created_at, updated_at";

fn handoff_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Handoff> {
    Ok(Handoff {
        id: row.get(0)?,
        project_id: row.get(1)?,
        project_kind: row.get(2)?,
        task_id: row.get(3)?,
        from_agent_id: row.get(4)?,
        to_agent_id: row.get(5)?,
        status: row.get(6)?,
        summary: row.get(7)?,
        completed_items: parse_string_array(&row.get::<_, String>(8)?),
        pending_items: parse_string_array(&row.get::<_, String>(9)?),
        decisions: parse_value_array(&row.get::<_, String>(10)?),
        files_changed: parse_string_array(&row.get::<_, String>(11)?),
        risks: parse_string_array(&row.get::<_, String>(12)?),
        next_steps: parse_string_array(&row.get::<_, String>(13)?),
        revision: row.get(14)?,
        accepted_at: row.get(15)?,
        rejected_at: row.get(16)?,
        rejection_reason: row.get(17)?,
        completed_at: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
    })
}

fn handoff_select(conn: &Connection, id: &str) -> AppResult<Handoff> {
    conn.query_row(
        &format!("SELECT {HANDOFF_COLS} FROM agent_handoffs WHERE id = ?1"),
        rusqlite::params![id],
        handoff_from_row,
    )
    .optional()
    .map_err(AppError::from)?
    .ok_or_else(|| AppError::NotFound(format!("交接不存在: {id}")))
}

pub fn list_handoffs(
    db: &Db,
    status: Option<&str>,
    project_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<Handoff>, Page)> {
    list_handoffs_filtered(db, status, project_id, None, limit, offset)
}

/// 项目范围在 SQL 中过滤，列表与 total 使用相同条件。
pub fn list_handoffs_in_projects(
    db: &Db,
    status: Option<&str>,
    project_id: Option<&str>,
    projects: &[String],
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<Handoff>, Page)> {
    list_handoffs_filtered(db, status, project_id, Some(projects), limit, offset)
}

fn list_handoffs_filtered(
    db: &Db,
    status: Option<&str>,
    project_id: Option<&str>,
    projects: Option<&[String]>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<Handoff>, Page)> {
    db.with_read(|conn| {
        // 项目过滤按项目根匹配；历史行可能仍以计划 ID 归属（v92 之前写入），
        // 用 plans 反查一并纳入，保证按根过滤能看到旧交接。
        let mut filter = String::from(
            "(?1 IS NULL OR status = ?1) AND (?2 IS NULL OR project_id = ?2 OR \
             project_id IN (SELECT id FROM planning_projects WHERE workspace_project_id = ?2))",
        );
        let mut params: Vec<rusqlite::types::Value> = vec![
            status.map(str::to_string).into(),
            project_id.map(str::to_string).into(),
        ];
        if let Some(projects) = projects {
            if projects.is_empty() {
                filter.push_str(" AND 0");
            } else {
                let placeholders = (3..3 + projects.len())
                    .map(|i| format!("?{i}"))
                    .collect::<Vec<_>>()
                    .join(",");
                filter.push_str(&format!(" AND project_id IN ({placeholders})"));
                params.extend(projects.iter().cloned().map(rusqlite::types::Value::Text));
            }
        }
        let total: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM agent_handoffs WHERE {filter}"),
                rusqlite::params_from_iter(params.iter()),
                |r| r.get(0),
            )
            .map_err(AppError::from)?;
        let limit_at = params.len() + 1;
        let offset_at = params.len() + 2;
        params.push(rusqlite::types::Value::Integer(limit as i64));
        params.push(rusqlite::types::Value::Integer(offset as i64));
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {HANDOFF_COLS} FROM agent_handoffs
                 WHERE {filter}
                 ORDER BY created_at DESC, id DESC LIMIT ?{limit_at} OFFSET ?{offset_at}"
            ))
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), handoff_from_row)
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok((out, Page::new(limit, offset, total.max(0) as u32)))
    })
}

pub fn get_handoff(db: &Db, id: &str) -> AppResult<Handoff> {
    db.with_read(|conn| handoff_select(conn, id))
}

/// 交接状态变更：只允许合法的下一步，并要求 `base_revision` 匹配。
pub fn set_handoff_status(
    db: &Db,
    principal: &Principal,
    id: &str,
    next: &str,
    base_revision: i64,
    reason: Option<&str>,
) -> AppResult<Handoff> {
    let allowed = matches!(next, "accepted" | "rejected" | "completed" | "cancelled");
    if !allowed {
        return Err(AppError::Validation(format!(
            "非法交接状态: {next}（允许 accepted|rejected|completed|cancelled）"
        )));
    }
    db.with_transaction(|conn| {
        let current = handoff_select(conn, id)?;
        if current.revision != base_revision {
            return Err(AppError::Conflict(format!(
                "交接版本已变化（当前 revision={}，提交 {}）",
                current.revision, base_revision
            )));
        }
        let legal = match (current.status.as_str(), next) {
            ("pending", "accepted") | ("pending", "rejected") | ("pending", "cancelled") => true,
            ("accepted", "completed") | ("accepted", "cancelled") => true,
            _ => false,
        };
        if !legal {
            return Err(AppError::Conflict(format!(
                "交接状态不允许从 {} 变为 {}",
                current.status, next
            )));
        }
        let now = crate::agents::now_iso();
        let next_revision = current.revision.saturating_add(1);
        conn.execute(
            "UPDATE agent_handoffs SET status = ?1, revision = ?2, updated_at = ?3,
               accepted_at = CASE WHEN ?1 = 'accepted' THEN ?3 ELSE accepted_at END,
               rejected_at = CASE WHEN ?1 = 'rejected' THEN ?3 ELSE rejected_at END,
               rejection_reason = CASE WHEN ?1 = 'rejected' THEN ?4 ELSE rejection_reason END,
               completed_at = CASE WHEN ?1 = 'completed' THEN ?3 ELSE completed_at END
             WHERE id = ?5",
            rusqlite::params![next, next_revision, now, reason.unwrap_or(""), id],
        )
        .map_err(AppError::from)?;
        bump_revision(conn, "handoff", id, principal, &now, &String::new())?;
        handoff_select(conn, id)
    })
}

// ── 工作报告 ─────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkReport {
    pub id: String,
    pub handoff_id: Option<String>,
    pub project_id: String,
    pub task_id: Option<String>,
    pub agent_id: String,
    pub summary: String,
    pub result: String,
    pub completed_items: Vec<String>,
    pub pending_items: Vec<String>,
    pub files_changed: Vec<String>,
    pub evidence: Vec<Value>,
    pub risks: Vec<String>,
    pub source: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ReportInput {
    pub summary: String,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub handoff_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub completed_items: Vec<String>,
    #[serde(default)]
    pub pending_items: Vec<String>,
    #[serde(default)]
    pub files_changed: Vec<String>,
    #[serde(default)]
    pub evidence: Vec<Value>,
    #[serde(default)]
    pub risks: Vec<String>,
}

const REPORT_COLS: &str = "id, handoff_id, project_id, task_id, agent_id, summary, result, \
     completed_items, pending_items, files_changed, evidence, risks, source, created_at";

fn report_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkReport> {
    Ok(WorkReport {
        id: row.get(0)?,
        handoff_id: row.get(1)?,
        project_id: row.get(2)?,
        task_id: row.get(3)?,
        agent_id: row.get(4)?,
        summary: row.get(5)?,
        result: row.get(6)?,
        completed_items: parse_string_array(&row.get::<_, String>(7)?),
        pending_items: parse_string_array(&row.get::<_, String>(8)?),
        files_changed: parse_string_array(&row.get::<_, String>(9)?),
        evidence: parse_value_array(&row.get::<_, String>(10)?),
        risks: parse_string_array(&row.get::<_, String>(11)?),
        source: row.get(12)?,
        created_at: row.get(13)?,
    })
}

pub fn list_reports(
    db: &Db,
    agent_id: Option<&str>,
    handoff_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<WorkReport>, Page)> {
    let agent = agent_id.unwrap_or("");
    let handoff = handoff_id.unwrap_or("");
    db.with_read(|conn| {
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_work_reports
                 WHERE (?1 = '' OR agent_id = ?1) AND (?2 = '' OR handoff_id = ?2)",
                rusqlite::params![agent, handoff],
                |r| r.get(0),
            )
            .map_err(AppError::from)?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {REPORT_COLS} FROM agent_work_reports
                 WHERE (?1 = '' OR agent_id = ?1) AND (?2 = '' OR handoff_id = ?2)
                 ORDER BY created_at DESC, id DESC LIMIT ?3 OFFSET ?4"
            ))
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(
                rusqlite::params![agent, handoff, limit as i64, offset as i64],
                report_from_row,
            )
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok((out, Page::new(limit, offset, total.max(0) as u32)))
    })
}

pub fn get_report(db: &Db, id: &str) -> AppResult<WorkReport> {
    db.with_read(|conn| {
        conn.query_row(
            &format!("SELECT {REPORT_COLS} FROM agent_work_reports WHERE id = ?1"),
            rusqlite::params![id],
            report_from_row,
        )
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::NotFound(format!("工作报告不存在: {id}")))
    })
}

/// 按项目集合列报告（**先过滤再分页**，项目级授权不返回其它项目）。
pub fn list_reports_in_projects(
    db: &Db,
    projects: &[String],
    agent_id: Option<&str>,
    handoff_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> AppResult<(Vec<WorkReport>, Page)> {
    let agent = agent_id.unwrap_or("");
    let handoff = handoff_id.unwrap_or("");
    db.with_read(|conn| {
        let mut where_sql = String::from("(?1 = '' OR agent_id = ?1) AND (?2 = '' OR handoff_id = ?2)");
        let mut params: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Text(agent.to_string()),
            rusqlite::types::Value::Text(handoff.to_string()),
        ];
        if projects.is_empty() {
            where_sql.push_str(" AND 0");
        } else {
            let start = params.len() + 1;
            let placeholders = (0..projects.len())
                .map(|i| format!("?{}", start + i))
                .collect::<Vec<_>>()
                .join(",");
            params.extend(
                projects
                    .iter()
                    .map(|p| rusqlite::types::Value::Text(p.clone())),
            );
            // 授权范围按项目根表达；报告归属由历史交接行推导，可能仍是计划 ID
            // （v92 之前写入），用 plans 反查一并纳入。
            where_sql.push_str(&format!(
                " AND (project_id IN ({placeholders}) OR project_id IN \
                 (SELECT id FROM planning_projects WHERE workspace_project_id IN ({placeholders})))"
            ));
        }
        let total: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM agent_work_reports WHERE {where_sql}"),
                rusqlite::params_from_iter(params.iter()),
                |r| r.get(0),
            )
            .map_err(AppError::from)?;
        let limit_at = params.len() + 1;
        let offset_at = params.len() + 2;
        params.push(rusqlite::types::Value::Integer(limit as i64));
        params.push(rusqlite::types::Value::Integer(offset as i64));
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {REPORT_COLS} FROM agent_work_reports
                 WHERE {where_sql}
                 ORDER BY created_at DESC, id DESC LIMIT ?{limit_at} OFFSET ?{offset_at}"
            ))
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), report_from_row)
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok((out, Page::new(limit, offset, total.max(0) as u32)))
    })
}

// ── 同步事件 / 冲突 ──────────────────────────────────────────────

pub struct SyncEvent<'a> {
    pub workspace_row_id: &'a str,
    pub direction: &'a str,
    pub event_kind: &'a str,
    pub rel_path: &'a str,
    pub resource_kind: &'a str,
    pub resource_id: &'a str,
    pub revision: Option<i64>,
    pub status: &'a str,
    pub message: &'a str,
    pub content_hash: &'a str,
    pub request_id: &'a str,
}

pub fn record_sync_event(conn: &Connection, event: &SyncEvent<'_>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_sync_events
           (id, workspace_row_id, direction, event_kind, rel_path, resource_kind, resource_id,
            revision, status, message, content_hash, request_id, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            event.workspace_row_id,
            event.direction,
            event.event_kind,
            event.rel_path,
            event.resource_kind,
            event.resource_id,
            event.revision,
            event.status,
            truncate(event.message, 500),
            event.content_hash,
            event.request_id,
            crate::agents::now_iso(),
        ],
    )
    .map_err(AppError::from)?;
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
pub struct SyncEventRecord {
    pub id: String,
    pub direction: String,
    pub event_kind: String,
    pub rel_path: String,
    pub resource_kind: String,
    pub resource_id: String,
    pub revision: Option<i64>,
    pub status: String,
    pub message: String,
    pub content_hash: String,
    pub created_at: String,
}

pub fn list_sync_events(
    db: &Db,
    workspace_row_id: &str,
    limit: u32,
) -> AppResult<Vec<SyncEventRecord>> {
    db.with_read(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, direction, event_kind, rel_path, resource_kind, resource_id,
                        revision, status, message, content_hash, created_at
                 FROM agent_sync_events WHERE workspace_row_id = ?1
                 ORDER BY created_at DESC, id DESC LIMIT ?2",
            )
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(rusqlite::params![workspace_row_id, limit as i64], |r| {
                Ok(SyncEventRecord {
                    id: r.get(0)?,
                    direction: r.get(1)?,
                    event_kind: r.get(2)?,
                    rel_path: r.get(3)?,
                    resource_kind: r.get(4)?,
                    resource_id: r.get(5)?,
                    revision: r.get(6)?,
                    status: r.get(7)?,
                    message: r.get(8)?,
                    content_hash: r.get(9)?,
                    created_at: r.get(10)?,
                })
            })
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

#[derive(Clone, Debug, Serialize)]
pub struct SyncConflict {
    pub id: String,
    pub rel_path: String,
    pub resource_kind: String,
    pub resource_id: String,
    pub db_revision: i64,
    pub file_revision: i64,
    pub db_hash: String,
    pub file_hash: String,
    pub status: String,
    pub resolution: String,
    pub detail_json: String,
    pub detected_at: String,
    pub resolved_at: Option<String>,
}

const CONFLICT_COLS: &str = "id, rel_path, resource_kind, resource_id, db_revision, file_revision, \
     db_hash, file_hash, status, resolution, detail_json, detected_at, resolved_at";

fn conflict_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SyncConflict> {
    Ok(SyncConflict {
        id: row.get(0)?,
        rel_path: row.get(1)?,
        resource_kind: row.get(2)?,
        resource_id: row.get(3)?,
        db_revision: row.get(4)?,
        file_revision: row.get(5)?,
        db_hash: row.get(6)?,
        file_hash: row.get(7)?,
        status: row.get(8)?,
        resolution: row.get(9)?,
        detail_json: row.get(10)?,
        detected_at: row.get(11)?,
        resolved_at: row.get(12)?,
    })
}

pub fn list_conflicts(db: &Db, workspace_row_id: &str) -> AppResult<Vec<SyncConflict>> {
    db.with_read(|conn| {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {CONFLICT_COLS} FROM agent_sync_conflicts
                 WHERE workspace_row_id = ?1 ORDER BY detected_at DESC"
            ))
            .map_err(AppError::from)?;
        let rows = stmt
            .query_map(rusqlite::params![workspace_row_id], conflict_from_row)
            .map_err(AppError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(AppError::from)?);
        }
        Ok(out)
    })
}

pub fn upsert_conflict(
    conn: &Connection,
    workspace_row_id: &str,
    conflict: &SyncConflict,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_sync_conflicts
           (id, workspace_row_id, rel_path, resource_kind, resource_id, db_revision, file_revision,
            db_hash, file_hash, status, resolution, detail_json, detected_at, resolved_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'open','',?10,?11,NULL)
         ON CONFLICT(workspace_row_id, rel_path) DO UPDATE SET
           resource_kind = excluded.resource_kind,
           resource_id = excluded.resource_id,
           db_revision = excluded.db_revision,
           file_revision = excluded.file_revision,
           db_hash = excluded.db_hash,
           file_hash = excluded.file_hash,
           status = 'open',
           resolution = '',
           detail_json = excluded.detail_json,
           detected_at = excluded.detected_at,
           resolved_at = NULL",
        rusqlite::params![
            conflict.id,
            workspace_row_id,
            conflict.rel_path,
            conflict.resource_kind,
            conflict.resource_id,
            conflict.db_revision,
            conflict.file_revision,
            conflict.db_hash,
            conflict.file_hash,
            conflict.detail_json,
            conflict.detected_at,
        ],
    )
    .map_err(AppError::from)?;
    Ok(())
}

pub fn get_conflict(db: &Db, id: &str) -> AppResult<SyncConflict> {
    db.with_read(|conn| {
        conn.query_row(
            &format!("SELECT {CONFLICT_COLS} FROM agent_sync_conflicts WHERE id = ?1"),
            rusqlite::params![id],
            conflict_from_row,
        )
        .optional()
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::NotFound(format!("冲突不存在: {id}")))
    })
}

// ── 上下文访问 ───────────────────────────────────────────────────

pub struct ContextAccess<'a> {
    pub principal: &'a Principal,
    pub purpose: &'a str,
    pub project_id: &'a str,
    pub task_id: &'a str,
    pub format: &'a str,
    pub budget_tokens: u32,
    pub item_count: u32,
    pub estimated_tokens: u32,
    pub request_id: &'a str,
}

pub fn record_context_access(conn: &Connection, entry: &ContextAccess<'_>) -> AppResult<()> {
    conn.execute(
        "INSERT INTO agent_context_access_logs
           (id, agent_row_id, agent_id, interface, purpose, project_id, task_id, format,
            budget_tokens, item_count, estimated_tokens, request_id, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            entry.principal.agent_row_id,
            entry.principal.agent_id,
            entry.principal.source.as_str(),
            entry.purpose,
            entry.project_id,
            entry.task_id,
            entry.format,
            entry.budget_tokens as i64,
            entry.item_count as i64,
            entry.estimated_tokens as i64,
            entry.request_id,
            crate::agents::now_iso(),
        ],
    )
    .map_err(AppError::from)?;
    Ok(())
}

// ── REST 幂等缓存 ────────────────────────────────────────────────

pub fn cache_lookup(
    db: &Db,
    agent_row_id: &str,
    interface: &str,
    key: &str,
) -> AppResult<Option<(String, u16)>> {
    db.with_read(|conn| {
        let row = conn
            .query_row(
                "SELECT response_json, status_code FROM agent_request_cache
                 WHERE agent_row_id = ?1 AND interface = ?2 AND idempotency_key = ?3
                   AND expires_at > strftime('%Y-%m-%dT%H:%M:%S','now')",
                rusqlite::params![agent_row_id, interface, key],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u16)),
            )
            .optional()
            .map_err(AppError::from)?;
        Ok(row)
    })
}

pub fn cache_store(
    db: &Db,
    agent_row_id: &str,
    interface: &str,
    key: &str,
    request_hash: &str,
    response_json: &str,
    status_code: u16,
) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT OR REPLACE INTO agent_request_cache
               (id, agent_row_id, interface, idempotency_key, request_hash, response_json,
                status_code, created_at, expires_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8, strftime('%Y-%m-%dT%H:%M:%S','now','+24 hours'))",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                agent_row_id,
                interface,
                key,
                request_hash,
                response_json,
                status_code as i64,
                crate::agents::now_iso(),
            ],
        )
        .map_err(AppError::from)?;
        Ok(())
    })
}

// ── 导入租约（v82）──────────────────────────────────────────────
//
// v81 的 `claim_import` 用 bool 表达「是否取得执行权」，把 `ok` 与 `inflight`
// 混成同一个 false，调用方无法区分「已导入」与「别人正在导入」，导致 scan 在
// 他人执行中途就把文件归档。这里改为租约：单一原子 UPSERT 抢租约，语义由
// `LeaseClaim` 三态表达；失败即释放，过期可抢占。

/// 一次导入租约的归属信息。
#[derive(Clone, Debug)]
pub struct ImportLease {
    /// 认领键（rel_path + kind + hash + actor 的 SHA-256）。
    pub claim_key: String,
    /// 本次执行者标识，用于「写入前复查仍是自己」。
    pub owner: String,
    /// 第几次尝试（1 起）。
    pub attempt: u32,
}

/// 认领结果。**禁止**再退化成 bool。
#[derive(Clone, Debug)]
pub enum LeaseClaim {
    /// 取得执行权。
    Acquired(ImportLease),
    /// 该请求此前已成功完成（同一 claim_key）。
    AlreadyImported { finished_at: String },
    /// 其他执行者持有未过期的租约。
    InProgress { owner: String, until: String },
}

/// 认领一次导入。`lease_secs` 为租约时长（默认 300 秒）。
///
/// 原子性由单条 `INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING` 保证：
/// 只有「未成功」且「无未过期租约」时才会被更新，否则不返回行。
pub fn claim_import_lease(
    db: &Db,
    workspace_row_id: &str,
    claim_key: &str,
    rel_path: &str,
    kind: &str,
    content_hash: &str,
    actor: &str,
    owner: &str,
    lease_secs: i64,
) -> AppResult<LeaseClaim> {
    let now = crate::agents::now_iso();
    let lease = format!("+{lease_secs} seconds");
    db.with_conn(|conn| {
        let attempt: Option<i64> = conn
            .query_row(
                "INSERT INTO agent_import_claims
                   (id, workspace_row_id, claim_key, rel_path, kind, content_hash, actor,
                    status, owner, claimed_at, expires_at, attempt, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,'inflight',?8,?9,
                         strftime('%Y-%m-%dT%H:%M:%S','now',?10),1,?9,?9)
                 ON CONFLICT(workspace_row_id, claim_key) DO UPDATE SET
                   status='inflight',
                   owner=excluded.owner,
                   claimed_at=excluded.claimed_at,
                   expires_at=excluded.expires_at,
                   attempt=agent_import_claims.attempt+1,
                   rel_path=excluded.rel_path,
                   kind=excluded.kind,
                   content_hash=excluded.content_hash,
                   actor=excluded.actor,
                   updated_at=excluded.updated_at
                 WHERE agent_import_claims.status <> 'ok'
                   AND (agent_import_claims.expires_at IS NULL
                        OR agent_import_claims.expires_at
                           <= strftime('%Y-%m-%dT%H:%M:%S','now'))
                 RETURNING attempt",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    workspace_row_id,
                    claim_key,
                    rel_path,
                    kind,
                    content_hash,
                    actor,
                    owner,
                    now,
                    lease,
                ],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map_err(AppError::from)?;
        if let Some(attempt) = attempt {
            return Ok(LeaseClaim::Acquired(ImportLease {
                claim_key: claim_key.to_string(),
                owner: owner.to_string(),
                attempt: attempt.max(1) as u32,
            }));
        }
        // 没抢到：读现状给出可区分的原因（不参与竞态判定）。
        let existing: Option<(String, String, String, Option<String>)> = conn
            .query_row(
                "SELECT status, owner, updated_at, expires_at FROM agent_import_claims
                 WHERE workspace_row_id = ?1 AND claim_key = ?2",
                rusqlite::params![workspace_row_id, claim_key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(AppError::from)?;
        Ok(match existing {
            Some((status, _, updated_at, _)) if status == "ok" => {
                LeaseClaim::AlreadyImported {
                    finished_at: updated_at,
                }
            }
            Some((_, owner, _, until)) => LeaseClaim::InProgress {
                owner,
                until: until.unwrap_or_default(),
            },
            None => LeaseClaim::InProgress {
                owner: String::new(),
                until: String::new(),
            },
        })
    })
}

/// 写入业务数据前复查租约仍归自己所有（防止过期执行者继续写）。
pub fn holds_import_lease(
    db: &Db,
    workspace_row_id: &str,
    claim_key: &str,
    owner: &str,
) -> AppResult<bool> {
    db.with_read(|conn| {
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agent_import_claims
             WHERE workspace_row_id=?1 AND claim_key=?2 AND owner=?3 AND status='inflight'
               AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%S','now'))",
            rusqlite::params![workspace_row_id, claim_key, owner],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    })
}

/// 成功：标记 `ok`，清空租约（保留 attempt 与时间用于审计）。
pub fn finish_import_lease(db: &Db, workspace_row_id: &str, claim_key: &str, owner: &str) -> bool {
    db.with_conn(|conn| {
        let n = conn.execute(
            "UPDATE agent_import_claims
             SET status='ok', expires_at=NULL, owner='', updated_at=?4
             WHERE workspace_row_id=?1 AND claim_key=?2 AND owner=?3 AND status='inflight'",
            rusqlite::params![workspace_row_id, claim_key, owner, crate::agents::now_iso()],
        )?;
        Ok(n > 0)
    })
    .unwrap_or(false)
}

/// 失败：删除租约，允许后续重试（不得写成 imported/ok）。
pub fn release_import_lease(db: &Db, workspace_row_id: &str, claim_key: &str, owner: &str) -> bool {
    db.with_conn(|conn| {
        let n = conn.execute(
            "DELETE FROM agent_import_claims
             WHERE workspace_row_id=?1 AND claim_key=?2 AND owner=?3 AND status='inflight'",
            rusqlite::params![workspace_row_id, claim_key, owner],
        )?;
        Ok(n > 0)
    })
    .unwrap_or(false)
}

/// 清理过期租约（启动恢复用）。返回删除行数。
pub fn reclaim_expired_import_leases(db: &Db) -> AppResult<u32> {
    db.with_conn(|conn| {
        let n = conn.execute(
            "DELETE FROM agent_import_claims
             WHERE status='inflight' AND expires_at IS NOT NULL
               AND expires_at <= strftime('%Y-%m-%dT%H:%M:%S','now')",
            [],
        )?;
        Ok(n as u32)
    })
}

// ── 写入守卫（fencing）────────────────────────────────────────────
//
// 背景：v82 初版把「租约仍归我」当作**写业务数据之前**的一次独立检查
// （`holds_import_lease`）。检查与写入之间存在时间窗：租约过期 → 别人抢占 →
// 旧执行者恢复后继续写入，造成重复业务数据。
//
// v82 定稿方案：把「所有权校验」与「业务写入」放进**同一个写事务**
// （`BEGIN IMMEDIATE`）。校验条件包含单调递增的 `attempt`（fencing token），
// 因此：
// - 旧执行者的 `attempt` 已被抢占者递增 → 校验失败 → 整个事务回滚，业务数据零写入；
// - 校验与写入之间不可能被别人插入：`BEGIN IMMEDIATE` 持有 SQLite 写锁，
//   抢占租约所需的 UPDATE 会被挡在事务之外；
// - 业务数据与「租约置 ok」在**同一事务**提交：进程中途退出时两者都不生效，
//   下一轮可安全重试；不会出现「业务已写、租约未完成」导致的重复导入。

/// 写事务守卫：在事务内校验执行权，并在业务写入完成后收尾。
///
/// 实现方在事务开始时调用 [`WriteGuard::check`]，业务写入成功后调用
/// [`WriteGuard::complete`]。任一步失败都会让外层事务回滚。
pub trait WriteGuard {
    /// 事务开始时校验：执行权是否仍属于本次执行者。
    fn check(&self, conn: &Connection) -> AppResult<()>;

    /// 业务写入成功后收尾：把执行权标记为已用尽（与业务数据同事务提交）。
    fn complete(&self, conn: &Connection) -> AppResult<()>;

    /// 记录本次业务提交产生的资源指针（与业务数据同事务）。
    ///
    /// 只有需要「提交结果可恢复」的守卫（REST 幂等）实现它；其余守卫默认忽略。
    /// 实现方必须在事务内校验 fencing token，令牌失效即报错回滚。
    fn record_operation(&self, _conn: &Connection, _kind: &str, _id: &str) -> AppResult<()> {
        Ok(())
    }
}

/// 不做任何校验的守卫（普通业务写入用）。
pub struct NoGuard;

impl WriteGuard for NoGuard {
    fn check(&self, _conn: &Connection) -> AppResult<()> {
        Ok(())
    }

    fn complete(&self, _conn: &Connection) -> AppResult<()> {
        Ok(())
    }
}

/// 导入租约守卫：校验 `owner + attempt` 且租约未过期。
#[derive(Clone, Debug)]
pub struct ImportLeaseGuard {
    pub workspace_row_id: String,
    pub claim_key: String,
    pub owner: String,
    pub attempt: u32,
}

impl ImportLeaseGuard {
    pub fn new(
        workspace_row_id: &str,
        claim_key: &str,
        owner: &str,
        attempt: u32,
    ) -> Self {
        Self {
            workspace_row_id: workspace_row_id.to_string(),
            claim_key: claim_key.to_string(),
            owner: owner.to_string(),
            attempt,
        }
    }
}

impl WriteGuard for ImportLeaseGuard {
    fn check(&self, conn: &Connection) -> AppResult<()> {
        let matched: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agent_import_claims
             WHERE workspace_row_id=?1 AND claim_key=?2 AND owner=?3 AND attempt=?4
               AND status='inflight'
               AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%S','now'))",
            rusqlite::params![
                self.workspace_row_id,
                self.claim_key,
                self.owner,
                self.attempt as i64
            ],
            |r| r.get(0),
        )?;
        if matched == 0 {
            return Err(AppError::Conflict(format!(
                "导入租约已失效（claim_key={} attempt={}）：本次执行被 fencing 拒绝，未写入任何业务数据",
                &self.claim_key[..self.claim_key.len().min(12)],
                self.attempt
            )));
        }
        Ok(())
    }

    fn complete(&self, conn: &Connection) -> AppResult<()> {
        let n = conn.execute(
            "UPDATE agent_import_claims
             SET status='ok', expires_at=NULL, owner='', updated_at=?5
             WHERE workspace_row_id=?1 AND claim_key=?2 AND owner=?3 AND attempt=?4
               AND status='inflight'",
            rusqlite::params![
                self.workspace_row_id,
                self.claim_key,
                self.owner,
                self.attempt as i64,
                crate::agents::now_iso()
            ],
        )?;
        if n == 0 {
            // 理论上不可达：`check` 刚通过。若发生说明租约在事务内被外部改动，
            // 必须让事务回滚，否则会留下「业务已写、租约未完成」的重复导入窗口。
            return Err(AppError::Conflict(
                "导入租约在提交前失效，本次写入已回滚".into(),
            ));
        }
        Ok(())
    }
}

/// 在**同一个写事务**内完成「fencing 校验 → 业务写入 → 租约置 ok」。
///
/// 原子性依据：
/// - `db.with_transaction` 使用 `BEGIN IMMEDIATE`，事务全程持有 SQLite 写锁，
///   抢占租约所需的 `UPDATE` 无法插进「校验 → 写入」之间；
/// - 校验条件包含 `attempt`（单调递增 fencing token），旧执行者必然校验失败；
/// - 业务数据与「租约置 ok」同事务提交：中途崩溃则两者都不生效，可安全重试。
///
/// 闭包内**不得**再调用 `db.with_conn` / `db.with_transaction`（写连接互斥，会死锁）。
pub fn with_import_lease_transaction<T>(
    db: &Db,
    guard: &ImportLeaseGuard,
    body: impl FnOnce(&Connection) -> AppResult<T>,
) -> AppResult<T> {
    db.with_transaction(|conn| {
        guard.check(conn)?;
        let value = body(conn)?;
        guard.complete(conn)?;
        Ok(value)
    })
}

// ── REST 幂等占位（v82）──────────────────────────────────────────

/// 幂等占位结果。指纹不一致必须由调用方转成 409，不能重放。
#[derive(Clone, Debug)]
pub enum CacheClaim {
    /// 抢到占位，可以真正执行。`attempt` 是本次占位的 fencing token。
    Acquired { attempt: u32 },
    /// 已完成：返回缓存响应（调用方需自行比对指纹）。
    Done {
        fingerprint: String,
        response_json: String,
        status_code: u16,
    },
    /// 业务已提交，但响应尚未写入（进程在提交与缓存之间退出）。
    ///
    /// **禁止重新执行业务**：调用方必须按 `operation_kind/operation_id` 重建响应，
    /// 无法重建时返回明确的「需要恢复」错误。
    Committed {
        fingerprint: String,
        attempt: u32,
        operation_kind: String,
        operation_id: String,
        committed_at: String,
    },
    /// 其他请求正在执行同一 Key。
    InProgress { fingerprint: String },
}

/// 原子占位：`state` 从 `inflight` → `committed` → `done`；过期行可被抢占。
///
/// `lease_secs` 是 inflight 租约（默认 300 秒），`ttl_hours` 是完成后缓存寿命（默认 24 小时）。
///
/// 抢占过期行时 `attempt` 自增：**新占位者拿到更大的 fencing token**，
/// 旧占位者随后调用 `cache_complete` / `cache_fail` 会因 `attempt` 不匹配而
/// 落空（影响行数为 0），因此**旧请求无法完成或删除新请求的占位**。
///
/// `state='committed'` 的行**永不因租约过期被抢占**：它代表业务事务已经提交，
/// 重新执行会造成重复写入；调用方必须走 [`CacheClaim::Committed`] 恢复路径。
pub fn cache_claim(
    db: &Db,
    agent_row_id: &str,
    interface: &str,
    key: &str,
    fingerprint: &str,
    method: &str,
    path: &str,
    lease_secs: i64,
    ttl_hours: i64,
) -> AppResult<CacheClaim> {
    let now = crate::agents::now_iso();
    let lease = format!("+{lease_secs} seconds");
    let _ = ttl_hours; // 完成后由 cache_complete 写入真实 TTL
    db.with_conn(|conn| {
        let got: Option<i64> = conn
            .query_row(
                "INSERT INTO agent_request_cache
                   (id, agent_row_id, interface, idempotency_key, request_hash, request_method,
                    request_path, response_json, status_code, state, attempt, created_at, expires_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,'',0,'inflight',1,?8,
                         strftime('%Y-%m-%dT%H:%M:%S','now',?9))
                 ON CONFLICT(agent_row_id, interface, idempotency_key) DO UPDATE SET
                   request_hash=excluded.request_hash,
                   request_method=excluded.request_method,
                   request_path=excluded.request_path,
                   response_json='',
                   status_code=0,
                   state='inflight',
                   operation_kind='',
                   operation_id='',
                   committed_at=NULL,
                   attempt=agent_request_cache.attempt+1,
                   created_at=excluded.created_at,
                   expires_at=excluded.expires_at
                 WHERE agent_request_cache.state IN ('inflight','done')
                   AND agent_request_cache.expires_at
                       <= strftime('%Y-%m-%dT%H:%M:%S','now')
                 RETURNING attempt",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    agent_row_id,
                    interface,
                    key,
                    fingerprint,
                    method,
                    path,
                    now,
                    lease,
                ],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map_err(AppError::from)?;
        if let Some(attempt) = got {
            return Ok(CacheClaim::Acquired {
                attempt: attempt.max(1) as u32,
            });
        }
        let row: Option<(String, String, String, i64, i64, String, String, Option<String>)> = conn
            .query_row(
                "SELECT request_hash, response_json, state, status_code, attempt,
                        operation_kind, operation_id, committed_at
                 FROM agent_request_cache
                 WHERE agent_row_id=?1 AND interface=?2 AND idempotency_key=?3",
                rusqlite::params![agent_row_id, interface, key],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                },
            )
            .optional()
            .map_err(AppError::from)?;
        Ok(match row {
            Some((fp, text, state, code, _, kind, id, _)) if state == "done" => CacheClaim::Done {
                fingerprint: fp,
                response_json: text,
                status_code: code as u16,
            },
            Some((fp, _, state, _, attempt, kind, id, committed_at)) if state == "committed" => {
                CacheClaim::Committed {
                    fingerprint: fp,
                    attempt: attempt.max(1) as u32,
                    operation_kind: kind,
                    operation_id: id,
                    committed_at: committed_at.unwrap_or_default(),
                }
            }
            Some((fp, _, _, _, _, _, _, _)) => CacheClaim::InProgress { fingerprint: fp },
            // 行刚被并发删除（失败释放）：按「未完成」处理，调用方可重试。
            None => CacheClaim::InProgress {
                fingerprint: String::new(),
            },
        })
    })
}

/// 完成占位：写入响应并延长到 24 小时。
///
/// **fencing**：只有 `attempt` 仍等于本次占位令牌时才允许写入。
/// 返回 `false` 表示占位已被他人抢占（本次结果作废，不得覆盖对方的响应）。
///
/// 允许从 `inflight`（正常提交）或 `committed`（崩溃恢复后重建响应）进入 `done`。
pub fn cache_complete(
    db: &Db,
    agent_row_id: &str,
    interface: &str,
    key: &str,
    fingerprint: &str,
    attempt: u32,
    response_json: &str,
    status_code: u16,
) -> AppResult<bool> {
    let now = crate::agents::now_iso();
    db.with_conn(|conn| {
        let n = conn.execute(
            "UPDATE agent_request_cache
             SET state='done', response_json=?6, status_code=?7, created_at=?8,
                 expires_at=strftime('%Y-%m-%dT%H:%M:%S','now','+24 hours')
             WHERE agent_row_id=?1 AND interface=?2 AND idempotency_key=?3
               AND request_hash=?4 AND attempt=?5 AND state IN ('inflight','committed')",
            rusqlite::params![
                agent_row_id,
                interface,
                key,
                fingerprint,
                attempt as i64,
                response_json,
                status_code as i64,
                now,
            ],
        )?;
        Ok(n > 0)
    })
}

/// 失败：删除占位，绝不把失败缓存成成功结果。
///
/// **fencing**：只允许删除**自己持有的**占位（`attempt` 必须匹配），
/// 否则旧请求失败时会误删新请求正在使用的占位，导致业务写入被执行两次。
pub fn cache_fail(
    db: &Db,
    agent_row_id: &str,
    interface: &str,
    key: &str,
    fingerprint: &str,
    attempt: u32,
) -> AppResult<bool> {
    db.with_conn(|conn| {
        let n = conn.execute(
            "DELETE FROM agent_request_cache
             WHERE agent_row_id=?1 AND interface=?2 AND idempotency_key=?3
               AND request_hash=?4 AND attempt=?5 AND state='inflight'",
            rusqlite::params![agent_row_id, interface, key, fingerprint, attempt as i64],
        )?;
        Ok(n > 0)
    })
}

/// REST 幂等守卫：把「业务事务」与「已提交标记 + operation 指针」绑定在同一事务。
///
/// 事务内顺序固定为：`check` → 业务写入 → `record_operation` → `complete`。
/// 任何一步失败都整体回滚，因此不存在「业务已创建但没有提交标记」的窗口。
#[derive(Debug)]
pub struct RequestCacheGuard {
    pub agent_row_id: String,
    pub interface: String,
    pub key: String,
    pub fingerprint: String,
    pub attempt: u32,
    operation: std::sync::Mutex<Option<(String, String)>>,
}

impl RequestCacheGuard {
    pub fn new(
        agent_row_id: &str,
        interface: &str,
        key: &str,
        fingerprint: &str,
        attempt: u32,
    ) -> Self {
        Self {
            agent_row_id: agent_row_id.to_string(),
            interface: interface.to_string(),
            key: key.to_string(),
            fingerprint: fingerprint.to_string(),
            attempt,
            operation: std::sync::Mutex::new(None),
        }
    }

    /// 本次业务提交产生的资源指针（若业务函数已记录）。
    pub fn operation(&self) -> Option<(String, String)> {
        self.operation.lock().ok().and_then(|v| v.clone())
    }
}

impl WriteGuard for RequestCacheGuard {
    fn check(&self, conn: &Connection) -> AppResult<()> {
        let matched: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agent_request_cache
             WHERE agent_row_id=?1 AND interface=?2 AND idempotency_key=?3
               AND request_hash=?4 AND attempt=?5 AND state='inflight'
               AND expires_at > strftime('%Y-%m-%dT%H:%M:%S','now')",
            rusqlite::params![
                self.agent_row_id,
                self.interface,
                self.key,
                self.fingerprint,
                self.attempt as i64
            ],
            |r| r.get(0),
        )?;
        if matched == 0 {
            return Err(AppError::Conflict(
                "IDEMPOTENCY_FENCED: 幂等占位已失效（被抢占或已提交），本次执行被拒绝".into(),
            ));
        }
        Ok(())
    }

    fn record_operation(&self, conn: &Connection, kind: &str, id: &str) -> AppResult<()> {
        let n = conn.execute(
            "UPDATE agent_request_cache
             SET operation_kind=?6, operation_id=?7
             WHERE agent_row_id=?1 AND interface=?2 AND idempotency_key=?3
               AND request_hash=?4 AND attempt=?5 AND state='inflight'",
            rusqlite::params![
                self.agent_row_id,
                self.interface,
                self.key,
                self.fingerprint,
                self.attempt as i64,
                kind,
                id
            ],
        )?;
        if n == 0 {
            return Err(AppError::Conflict(
                "IDEMPOTENCY_FENCED: 提交前幂等占位已失效，本次写入已回滚".into(),
            ));
        }
        if let Ok(mut slot) = self.operation.lock() {
            *slot = Some((kind.to_string(), id.to_string()));
        }
        Ok(())
    }

    fn complete(&self, conn: &Connection) -> AppResult<()> {
        let n = conn.execute(
            "UPDATE agent_request_cache
             SET state='committed', committed_at=?6
             WHERE agent_row_id=?1 AND interface=?2 AND idempotency_key=?3
               AND request_hash=?4 AND attempt=?5 AND state='inflight'",
            rusqlite::params![
                self.agent_row_id,
                self.interface,
                self.key,
                self.fingerprint,
                self.attempt as i64,
                crate::agents::now_iso(),
            ],
        )?;
        if n == 0 {
            return Err(AppError::Conflict(
                "IDEMPOTENCY_FENCED: 提交前幂等占位已失效，本次写入已回滚".into(),
            ));
        }
        Ok(())
    }
}

/// 按时间裁剪运维日志（活动/同步事件/幂等缓存）。单次最多 5000 行，失败不影响启动。
pub fn prune(db: &Db) -> AppResult<u32> {
    let mut removed = 0u32;
    db.with_conn(|conn| {
        removed += conn
            .execute(
                "DELETE FROM agent_request_cache
                 WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%S','now')",
                [],
            )
            .unwrap_or(0) as u32;
        removed += conn
            .execute(
                "DELETE FROM agent_activity_logs WHERE id IN (
                   SELECT id FROM agent_activity_logs
                   WHERE created_at < strftime('%Y-%m-%dT%H:%M:%S','now','-90 days')
                   ORDER BY created_at LIMIT 5000)",
                [],
            )
            .unwrap_or(0) as u32;
        removed += conn
            .execute(
                "DELETE FROM agent_sync_events WHERE id IN (
                   SELECT id FROM agent_sync_events
                   WHERE created_at < strftime('%Y-%m-%dT%H:%M:%S','now','-90 days')
                   ORDER BY created_at LIMIT 5000)",
                [],
            )
            .unwrap_or(0) as u32;
        Ok(())
    })?;
    Ok(removed)
}

/// 任意来源的 `Source` 标签（供 UI 展示/导出）。
pub fn source_label(source: Source) -> &'static str {
    source.as_str()
}

/// 角色标签（供 UI 展示）。
pub fn actor_label(kind: ActorKind) -> &'static str {
    kind.as_str()
}

#[cfg(test)]
mod tests {
    //! 项目身份统一（v92）的归属落库测试：决策 / 交接 / 报告一律锚定项目根，
    //! 计划 ID 只作为入参兼容，`project_kind` 收敛为 none / project。

    use super::{create_decision, DecisionInput, HandoffInput, ReportInput};
    use crate::agent_access::handoff::{self};
    use crate::agent_access::{Principal, Source};
    use crate::db::Db;
    use crate::mcp::auth as mcp_auth;
    use crate::mcp::permissions as mcp_perm;

    /// 建一个真实存在的项目根（`workspace_projects`）。
    fn project(db: &Db, id: &str) {
        let now = crate::agents::now_iso();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO workspace_projects
                   (id, name, kind, status, root_path, dev_project_id, note, created_at, updated_at)
                 VALUES (?1, ?1, 'general', 'active', '', NULL, '', ?2, ?2)",
                rusqlite::params![id, now],
            )?;
            Ok(())
        })
        .expect("创建项目根");
    }

    /// 建一个挂在项目根下的计划（计划 ID 入参兼容的数据前提）。
    fn plan(db: &Db, id: &str, workspace_project_id: &str) {
        let now = crate::agents::now_iso();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO planning_projects
                   (id, name, workspace_project_id, is_active, created_at, updated_at)
                 VALUES (?1, ?1, ?2, 1, ?3, ?3)",
                rusqlite::params![id, workspace_project_id, now],
            )?;
            Ok(())
        })
        .expect("创建计划");
    }

    /// 注册一个 project_rw Agent，返回 (行 ID, agent_id)。
    fn agent(db: &Db, agent_id: &str) -> (String, String) {
        let created = mcp_auth::create_agent(db, agent_id, agent_id).expect("创建 Agent");
        mcp_auth::set_agent_scope(db, &created.info.id, "project_rw").expect("设置 scope");
        (created.info.id, created.info.agent_id)
    }

    /// 授予能力（项目型能力的资源范围统一解析为项目根）。
    fn grant_capability(db: &Db, row_id: &str, capability: &str, resource: &str) {
        mcp_perm::grant(db, row_id, capability, resource).expect("授予能力");
    }

    /// 授予项目根授权（v92 统一授权第三层：`mcp_agent_grants`）。
    fn grant_project(db: &Db, row_id: &str, project: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO mcp_agent_grants (id, agent_row_id, project_id, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    row_id,
                    project,
                    crate::agents::now_iso()
                ],
            )?;
            Ok(())
        })
        .expect("授予项目授权");
    }

    fn local() -> Principal {
        Principal::local(Source::Ui)
    }

    /// 读取决策的落库归属 (project_id, project_kind)。
    fn decision_owner(db: &Db, id: &str) -> (String, String) {
        db.with_read(|conn| {
            Ok(conn.query_row(
                "SELECT project_id, project_kind FROM agent_decisions WHERE id = ?1",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .expect("读取决策归属")
    }

    /// 读取交接的落库归属 (project_id, project_kind)。
    fn handoff_owner(db: &Db, id: &str) -> (String, String) {
        db.with_read(|conn| {
            Ok(conn.query_row(
                "SELECT project_id, project_kind FROM agent_handoffs WHERE id = ?1",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .expect("读取交接归属")
    }

    fn decision_input(title: &str, project_id: Option<&str>) -> DecisionInput {
        DecisionInput {
            title: title.into(),
            project_id: project_id.map(str::to_string),
            project_kind: None,
            context: String::new(),
            decision: "采用方案 A".into(),
            consequences: String::new(),
            alternatives: String::new(),
            tags: Vec::new(),
            status: None,
        }
    }

    /// 新项目根下创建 Decision：落库 project_id = 根、project_kind = 'project'。
    #[test]
    fn decision_persists_project_root_and_kind() {
        let db = Db::open_in_memory().expect("内存库");
        project(&db, "root-decision");
        let decision = create_decision(
            &db,
            &local(),
            decision_input("根项目决策", Some("root-decision")),
        )
        .expect("创建决策");
        assert_eq!(decision.project_id, "root-decision");
        assert_eq!(decision.project_kind, "project");
        assert_eq!(
            decision_owner(&db, &decision.id),
            ("root-decision".into(), "project".into())
        );
    }

    /// 用计划 ID 创建 Decision：入参兼容解析，落库归属是项目根。
    #[test]
    fn decision_via_plan_id_persists_root() {
        let db = Db::open_in_memory().expect("内存库");
        project(&db, "root-plan-decision");
        plan(&db, "plan-decision", "root-plan-decision");
        let decision = create_decision(
            &db,
            &local(),
            decision_input("计划入参决策", Some("plan-decision")),
        )
        .expect("创建决策");
        assert_eq!(decision.project_id, "root-plan-decision");
        assert_eq!(decision.project_kind, "project");
        assert_eq!(
            decision_owner(&db, &decision.id),
            ("root-plan-decision".into(), "project".into())
        );
    }

    /// 新项目下创建交接：成功且 project_kind = 'project'
    /// （v92 之前的 CHECK 只允许 none|planning|workspace，会拒绝该写入——回归守护）。
    #[test]
    fn handoff_persists_project_root_and_kind() {
        let db = Db::open_in_memory().expect("内存库");
        project(&db, "root-handoff");
        let (_, target) = agent(&db, "ho-root-target");
        let created = handoff::create_handoff(
            &db,
            &local(),
            handoff_input("根项目交接", Some("root-handoff"), &target),
        )
        .expect("创建交接");
        assert_eq!(created.handoff.project_id, "root-handoff");
        assert_eq!(created.handoff.project_kind, "project");
        assert_eq!(
            handoff_owner(&db, &created.handoff.id),
            ("root-handoff".into(), "project".into())
        );
    }

    /// 用计划 ID 创建交接：入参兼容解析，落库归属是项目根。
    #[test]
    fn handoff_via_plan_id_persists_root() {
        let db = Db::open_in_memory().expect("内存库");
        project(&db, "root-plan-handoff");
        plan(&db, "plan-handoff", "root-plan-handoff");
        let (_, target) = agent(&db, "ho-plan-target");
        let created = handoff::create_handoff(
            &db,
            &local(),
            handoff_input("计划入参交接", Some("plan-handoff"), &target),
        )
        .expect("创建交接");
        assert_eq!(created.handoff.project_id, "root-plan-handoff");
        assert_eq!(created.handoff.project_kind, "project");
        assert_eq!(
            handoff_owner(&db, &created.handoff.id),
            ("root-plan-handoff".into(), "project".into())
        );
    }

    fn handoff_input(summary: &str, project_id: Option<&str>, target: &str) -> HandoffInput {
        HandoffInput {
            to_agent_id: target.to_string(),
            summary: summary.into(),
            task_id: None,
            project_id: project_id.map(str::to_string),
            project_kind: None,
            completed_items: Vec::new(),
            pending_items: Vec::new(),
            decisions: Vec::new(),
            files_changed: Vec::new(),
            risks: Vec::new(),
            next_steps: Vec::new(),
        }
    }

    /// 完整链路：Agent A 创建交接给 Agent B → B 接受 → A 提交工作报告，
    /// 报告归属由交接推导并锚定同一项目根。
    #[test]
    fn handoff_accept_and_report_stay_on_project_root() {
        let db = Db::open_in_memory().expect("内存库");
        project(&db, "root-flow");
        let (a_row, a_id) = agent(&db, "ho-flow-a");
        let (b_row, b_id) = agent(&db, "ho-flow-b");
        for row in [&a_row, &b_row] {
            grant_capability(&db, row, "handoffs.write", "root-flow");
            grant_project(&db, row, "root-flow");
        }
        let creator = Principal::agent(a_row, a_id.clone(), Source::Mcp);
        let target = Principal::agent(b_row, b_id.clone(), Source::Mcp);

        let created = handoff::create_handoff(
            &db,
            &creator,
            handoff_input("A → B 的交接", Some("root-flow"), &b_id),
        )
        .expect("创建交接");
        assert_eq!(created.handoff.project_id, "root-flow");

        let accepted = handoff::accept_handoff(&db, &target, &created.handoff.id, created.revision)
            .expect("目标 Agent 接收");
        assert_eq!(accepted.status, "accepted");

        let report = handoff::create_report(
            &db,
            &creator,
            ReportInput {
                summary: "A 的完工报告".into(),
                result: Some("completed".into()),
                handoff_id: Some(created.handoff.id.clone()),
                project_id: None,
                task_id: None,
                completed_items: Vec::new(),
                pending_items: Vec::new(),
                files_changed: Vec::new(),
                evidence: Vec::new(),
                risks: Vec::new(),
            },
        )
        .expect("提交工作报告");
        assert_eq!(report.report.project_id, "root-flow", "报告归属 = 交接项目根");
        let report_project: String = db
            .with_read(|conn| {
                Ok(conn.query_row(
                    "SELECT project_id FROM agent_work_reports WHERE id = ?1",
                    rusqlite::params![report.report.id],
                    |r| r.get(0),
                )?)
            })
            .expect("读取报告归属");
        assert_eq!(report_project, "root-flow");
    }
}
