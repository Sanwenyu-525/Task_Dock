//! 领域写操作的统一幂等封装（架构文档 §7.5 / §11.2）。
//!
//! 复用现有 `agent_request_cache` + `WriteGuard` + `agent_operations`，
//! 不为五个领域新建幂等系统。所有领域写操作共用这里的事务顺序：
//!
//! ```text
//! cache_claim → 事务内 guard.check → 业务写入 → guard.record_operation
//!             → guard.complete → 提交 → cache_complete
//! ```
//!
//! 失败（含冲突）只释放本次占位，不缓存失败结果。

use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::agent_access::operations::{self, OperationInput};
use crate::agent_access::store::{self, WriteGuard};
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

/// 带幂等的领域写事务。
///
/// - `request_id`：调用方提供的唯一请求 ID（CLI/MCP/文件的 requestId，REST 的 Idempotency-Key）。
/// - `payload`：参与指纹的规范化业务输入，不含 requestId 本身。
/// - `body`：只做事务内的事情（权限、归属、版本、业务写入、revision 推进、
///   `guard.record_operation`），**不得**再调用 `db.with_conn` / `db.with_transaction`。
pub fn execute<T>(
    db: &Db,
    principal: &Principal,
    operation_id: &'static str,
    project_id: &str,
    request_id: &str,
    payload: &serde_json::Value,
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
        // 无法承载空串/伪造 ID。仍走同一事务模板与操作审计，只是没有跨进程重放缓存。
        return execute_uncached(db, principal, operation_id, project_id, payload, body);
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
            return serde_json::from_str::<T>(&response_json).map_err(|_| {
                AppError::Conflict(
                    "IDEMPOTENCY_RECOVERY_REQUIRED: 幂等响应无法解析，请使用新 requestId 重试".into(),
                )
            });
        }
        store::CacheClaim::Committed { .. } => {
            return Err(AppError::Conflict(
                "IDEMPOTENCY_RECOVERY_REQUIRED: 业务已提交但响应未写入，请使用新 requestId 重试".into(),
            ));
        }
        store::CacheClaim::InProgress { .. } => {
            return Err(AppError::Conflict(
                "IDEMPOTENCY_IN_PROGRESS: 相同 requestId 的请求正在执行".into(),
            ));
        }
    };

    let claim_guard = store::RequestCacheGuard::new(
        &agent_row_id,
        interface,
        request_id,
        &fp,
        attempt,
    );
    let operation = operations::try_start(
        db,
        principal,
        &OperationInput {
            action: operation_id,
            resource_kind: def.resource_kind,
            resource_id: "",
            project_id,
            request_id,
            detail: "",
        },
    );
    let op_guard = operations::OperationGuard::new(
        operation.as_ref().map(|op| op.id.clone()).unwrap_or_default(),
    );
    let guarded = operations::CompositeGuard::new(&claim_guard, &op_guard);

    let outcome = db.with_transaction(|conn| {
        guarded.check(conn)?;
        let value = body(conn, &guarded)?;
        guarded.complete(conn)?;
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
            if let Some(op) = operation.as_ref() {
                operations::notify(op);
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
            if let Some(op) = operation.as_ref() {
                let _ = operations::fail(db, &op.id, &err);
            }
            Err(err)
        }
    }
}

/// 本地人类身份的无缓存路径：保留 requestId、事务与操作审计，
/// 但不写入有外键约束的 `agent_request_cache`。
fn execute_uncached<T>(
    db: &Db,
    principal: &Principal,
    operation_id: &'static str,
    project_id: &str,
    payload: &serde_json::Value,
    body: impl FnOnce(&Connection, &dyn WriteGuard) -> AppResult<T>,
) -> AppResult<T>
where
    T: Serialize + DeserializeOwned,
{
    let def = find_operation(operation_id)
        .ok_or_else(|| AppError::Validation(format!("未注册的领域操作：{operation_id}")))?;
    // 指纹仍参与操作详情，便于审计定位同一逻辑请求，即使没有跨进程缓存。
    let _fp = fingerprint(operation_id, payload);
    let operation = operations::try_start(
        db,
        principal,
        &OperationInput {
            action: operation_id,
            resource_kind: def.resource_kind,
            resource_id: "",
            project_id,
            request_id: "",
            detail: "",
        },
    );
    let op_guard = operations::OperationGuard::new(
        operation.as_ref().map(|op| op.id.clone()).unwrap_or_default(),
    );
    let outcome = db.with_transaction(|conn| {
        op_guard.check(conn)?;
        let value = body(conn, &op_guard)?;
        op_guard.complete(conn)?;
        Ok(value)
    });
    match outcome {
        Ok(value) => {
            if let Some(op) = operation.as_ref() {
                operations::notify(op);
            }
            Ok(value)
        }
        Err(err) => {
            if let Some(op) = operation.as_ref() {
                let _ = operations::fail(db, &op.id, &err);
            }
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

    #[test]
    fn registered_agent_replays_same_request_without_second_write() {
        let db = Db::open_in_memory().unwrap();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO mcp_agents
                   (id,agent_id,token_hash,scope,created_at,updated_at)
                 VALUES ('ar1','agent-1','','project_rw','2026-01-01','2026-01-01')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
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
}
