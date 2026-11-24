//! 领域写操作的统一幂等封装（架构文档 §7.5 / §11.2）。
//!
//! 本模块只服务**没有外层幂等占位的独立执行入口**（目前是 CLI）：
//! 由它取得 `agent_request_cache` 占位，并与调用方传入的 `WriteGuard`
//! （CLI 的 `OperationGuard`）叠加成同一个事务守卫：
//!
//! ```text
//! cache_claim → 事务内 [缓存占位校验 + 外层守卫校验]
//!             → 业务写入（事务内领域核心）
//!             → guard.record_operation（缓存资源指针 + 外层操作终态）
//!             → guard.complete（缓存置 committed + 操作置 committed）
//!             → 提交 → cache_complete
//! ```
//!
//! 关键约束：
//! - **不创建 Operation**：Operation 由入口（CLI）在外层创建，一次请求只有一条；
//! - **不创建第二个幂等身份**：`request_id` 由入口传入，不在这里随机生成；
//! - `Committed` 状态必须利用 `operation_kind/operation_id` 重建响应（`recover`），
//!   禁止重新执行业务，也禁止只返回泛化错误。
//!
//! MCP 的幂等由 `run_tool_call` 的审计重放负责；REST 由 REST 外层
//! `RequestCacheGuard` 负责。二者都**不得**调用本模块，否则会重复占位。

use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::agent_access::store::{self, RequestCacheGuard, WriteGuard};
use crate::agent_access::Principal;
use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::registry::find_operation;

/// 生成请求指纹。操作 ID 与全部业务输入都参与，避免同一 requestId 复用不同内容。
pub fn fingerprint(operation_id: &str, payload: &serde_json::Value) -> String {
    let raw = serde_json::json!({
        "operation": operation_id,
        "input": payload,
    })
    .to_string();
    let digest = Sha256::digest(raw.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// 幂等占位 + 入口守卫的叠加守卫：业务写入前两者都校验，收尾时两者都提交。
struct StackedGuard<'a> {
    cache: &'a RequestCacheGuard,
    outer: &'a dyn WriteGuard,
}

impl WriteGuard for StackedGuard<'_> {
    fn check(&self, conn: &Connection) -> AppResult<()> {
        self.cache.check(conn)?;
        self.outer.check(conn)
    }

    fn record_operation(&self, conn: &Connection, kind: &str, id: &str) -> AppResult<()> {
        self.cache.record_operation(conn, kind, id)?;
        self.outer.record_operation(conn, kind, id)
    }

    fn complete(&self, conn: &Connection) -> AppResult<()> {
        self.cache.complete(conn)?;
        self.outer.complete(conn)
    }
}

/// 带幂等的领域写事务（独立执行入口专用）。
///
/// - `request_id`：入口提供的唯一请求 ID；
/// - `guard`：入口已持有的操作守卫（CLI 为 `OperationGuard`）；
/// - `recover`：`Committed` 恢复回调，入参是缓存里记录的 `(operation_kind, operation_id)`，
///   只能读已提交的业务数据重建响应；
/// - `body`：事务内领域核心，不得再调用 `db.with_conn` / `db.with_transaction`。
pub fn execute<T>(
    db: &Db,
    principal: &Principal,
    operation_id: &'static str,
    project_id: &str,
    request_id: &str,
    payload: &serde_json::Value,
    guard: &dyn WriteGuard,
    recover: impl FnOnce(&Connection, &str, &str) -> AppResult<T>,
    body: impl FnOnce(&Connection, &dyn WriteGuard) -> AppResult<T>,
) -> AppResult<T>
where
    T: Serialize + DeserializeOwned,
{
    if request_id.trim().is_empty() {
        return Err(AppError::Validation("requestId 不能为空".into()));
    }
    let def = find_operation(operation_id)
        .ok_or_else(|| AppError::Validation(format!("未注册的领域操作：{operation_id}")))?;
    let fp = fingerprint(operation_id, payload);
    let Some(agent_row_id) = principal.agent_row_id.clone() else {
        // 本地人类身份没有 mcp_agents 行，`agent_request_cache.agent_row_id` 外键
        // 无法承载空串/伪造 ID。仍走同一事务模板与入口守卫，只是没有跨进程重放。
        return db.with_transaction(|conn| {
            guard.check(conn)?;
            let value = body(conn, guard)?;
            guard.complete(conn)?;
            Ok(value)
        });
    };
    let interface = principal.source.as_str();

    let claim = store::cache_claim(
        db,
        &agent_row_id,
        interface,
        request_id,
        &fp,
        "",
        operation_id,
        300,
        24,
    )?;

    let attempt = match claim {
        store::CacheClaim::Acquired { attempt } => attempt,
        store::CacheClaim::Done {
            fingerprint: cached_fp,
            response_json,
            status_code,
        } => {
            if cached_fp != fp {
                return Err(AppError::Conflict(
                    "IDEMPOTENCY_KEY_REUSED: 相同 requestId 不能提交不同内容".into(),
                ));
            }
            if status_code >= 400 {
                return Err(AppError::Conflict("缓存的幂等结果不是成功响应".into()));
            }
            db.with_read(|conn| {
                super::policy::authorize_write_replay(conn, principal, project_id, def, &payload["input"])
            })?;
            return serde_json::from_str::<T>(&response_json).map_err(|_| {
                AppError::Conflict(
                    "IDEMPOTENCY_RECOVERY_REQUIRED: 幂等响应无法解析，请使用新 requestId 重试".into(),
                )
            });
        }
        store::CacheClaim::Committed {
            fingerprint: cached_fp,
            attempt: committed_attempt,
            operation_kind,
            operation_id: committed_operation_id,
            committed_at,
        } => {
            if cached_fp != fp {
                return Err(AppError::Conflict(
                    "IDEMPOTENCY_KEY_REUSED: 相同 requestId 不能提交不同内容".into(),
                ));
            }
            // 业务已提交、响应未写：只重建，绝不重新执行。
            let recovered = db.with_read(|conn| {
                super::policy::authorize_write_replay(conn, principal, project_id, def, &payload["input"])?;
                recover(conn, &operation_kind, &committed_operation_id)
            });
            let value = recovered.map_err(|err| {
                AppError::Conflict(format!(
                    "IDEMPOTENCY_RECOVERY_REQUIRED: 该请求已提交（operation_kind={operation_kind} \
                     operation_id={committed_operation_id} committed_at={committed_at}），\
                     但响应无法重建：{}；请读取资源状态，不要重试写入",
                    err.user_message()
                ))
            })?;
            if let Ok(json) = serde_json::to_string(&value) {
                let _ = store::cache_complete(
                    db,
                    &agent_row_id,
                    interface,
                    request_id,
                    &fp,
                    committed_attempt,
                    &json,
                    200,
                );
            }
            return Ok(value);
        }
        store::CacheClaim::InProgress { .. } => {
            return Err(AppError::Conflict(
                "IDEMPOTENCY_IN_PROGRESS: 相同 requestId 的请求正在执行".into(),
            ));
        }
    };

    let claim_guard = RequestCacheGuard::new(
        &agent_row_id,
        interface,
        request_id,
        &fp,
        attempt,
    );
    let stacked = StackedGuard {
        cache: &claim_guard,
        outer: guard,
    };
    let outcome = db.with_transaction(|conn| {
        stacked.check(conn)?;
        let value = body(conn, &stacked)?;
        stacked.complete(conn)?;
        Ok(value)
    });

    match outcome {
        Ok(value) => {
            if let Ok(json) = serde_json::to_string(&value) {
                let _ = store::cache_complete(
                    db,
                    &agent_row_id,
                    interface,
                    request_id,
                    &fp,
                    attempt,
                    &json,
                    200,
                );
            }
            Ok(value)
        }
        Err(err) => {
            let _ = store::cache_fail(
                db,
                &agent_row_id,
                interface,
                request_id,
                &fp,
                attempt,
            );
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_access::Source;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn seed_agent(db: &Db) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO mcp_agents
                   (id,agent_id,token_hash,scope,created_at,updated_at)
                 VALUES ('ar1','agent-1','','project_rw','2026-01-01','2026-01-01')",
                [],
            )?;
            conn.execute(
                "INSERT INTO workspace_projects (id,name,kind,status,created_at,updated_at)
                 VALUES ('p1','小说测试','novel','active','2026-01-01','2026-01-01')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        crate::mcp::permissions::grant(db, "ar1", "projects.write", "").unwrap();
        crate::mcp::auth::grant_project(db, "ar1", "p1").unwrap();
    }

    #[test]
    fn registered_agent_replays_same_request_without_second_write() {
        let db = Db::open_in_memory().unwrap();
        seed_agent(&db);
        let p = Principal::agent("ar1".into(), "agent-1".into(), Source::Cli);
        let calls = Arc::new(AtomicUsize::new(0));

        let run = |request_id: &str, payload_value: i64, result_value: i64| {
            let calls = calls.clone();
            let payload = serde_json::json!({"value": payload_value});
            execute::<(String, i64)>(
                &db,
                &p,
                "novel.chapter.content.update",
                "p1",
                request_id,
                &payload,
                &store::NoGuard,
                |_conn, _kind, _id| {
                    Err(AppError::Conflict("no committed pointer in test".into()))
                },
                move |_conn, _guard| {
                    calls.fetch_add(1, Ordering::Relaxed);
                    Ok((format!("write-{result_value}"), result_value))
                },
            )
        };

        let first = run("idem-1", 1, 1).unwrap();
        let replay = run("idem-1", 1, 1).unwrap();
        assert_eq!(first, replay);
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert!(run("idem-1", 2, 2).is_err());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn committed_claim_recovers_from_operation_pointer_without_body() {
        let db = Db::open_in_memory().unwrap();
        seed_agent(&db);
        let p = Principal::agent("ar1".into(), "agent-1".into(), Source::Cli);
        let calls = Arc::new(AtomicUsize::new(0));
        let payload = serde_json::json!({"value": 7});
        let fp = fingerprint("novel.chapter.content.update", &payload);
        let first = execute::<(String, i64)>(
            &db,
            &p,
            "novel.chapter.content.update",
            "p1",
            "idem-recover",
            &payload,
            &store::NoGuard,
            |_conn, _kind, _id| Err(AppError::Conflict("unexpected".into())),
            {
                let calls = calls.clone();
                move |_conn, guard| {
                    calls.fetch_add(1, Ordering::Relaxed);
                    guard.record_operation(_conn, "novel.chapter", "ch-1")?;
                    Ok(("first".to_string(), 1))
                }
            },
        )
        .unwrap();
        assert_eq!(first, ("first".to_string(), 1));

        // 模拟「业务已提交、响应未落缓存」：保留 attempt/指纹，状态改 committed。
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE agent_request_cache
                 SET state='committed', response_json='', status_code=0, committed_at='2026-01-01T00:00:00Z'
                 WHERE agent_row_id='ar1' AND interface='cli' AND idempotency_key='idem-recover'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            db.with_read(|conn| store::read_revision(conn, "novel.chapter", "ch-1"))
                .unwrap()
                .0,
            0,
            "测试守卫 NoGuard 不写版本，只看恢复路径"
        );

        let recovered = execute::<(String, i64)>(
            &db,
            &p,
            "novel.chapter.content.update",
            "p1",
            "idem-recover",
            &payload,
            &store::NoGuard,
            |_conn, kind, id| {
                assert_eq!(kind, "novel.chapter");
                assert_eq!(id, "ch-1");
                Ok(("recovered".to_string(), 9))
            },
            {
                let calls = calls.clone();
                move |_conn, _guard| {
                    calls.fetch_add(1, Ordering::Relaxed);
                    Ok(("second".to_string(), 2))
                }
            },
        )
        .unwrap();
        assert_eq!(recovered, ("recovered".to_string(), 9));
        assert_eq!(calls.load(Ordering::Relaxed), 1, "恢复不得重新执行业务");
        let _ = fp;
    }
}
