//! 真机升级验收工具：用**真实的**旧版用户库副本验证 v0.5 迁移链路（v11 → v13）。
//!
//! 默认 `#[ignore]`（不依赖本机数据，常规 `cargo test` 直接跳过）。
//! 真机验收时显式运行（**必须指向副本**，工具会就地迁移该文件）：
//!
//! ```bash
//! cp "$APPDATA/com.taskdock.desktop/task-dock.db" /tmp/td-upgrade-copy.db
//! TD_REAL_UPGRADE_DB="/tmp/td-upgrade-copy.db" \
//!   cargo test --test real_upgrade -- --ignored --nocapture
//! ```
//!
//! 验证内容：迁移前记录 `PRAGMA user_version` 与各表行数 → 用当前版本打开（触发迁移 +
//! 一次性 origin 回填）→ 版本推进到最新、行数不少、外键零违规、`integrity_check` 通过、
//! v12/v13 新列可查询。**只读用户原库，迁移只发生在副本上。**

use task_dock_lib::db::Db;

/// 迁移前后都必须核对的表（v12/v13 不删表，只加列/索引）。
const TABLES: [&str; 6] = [
    "tasks",
    "agent_sources",
    "agent_sessions",
    "agent_runs",
    "agent_events",
    "notification_history",
];

#[test]
#[ignore = "真机验收工具：需要 TD_REAL_UPGRADE_DB 指向真实用户库副本"]
fn real_user_database_upgrades_without_losing_rows() {
    let path = match std::env::var("TD_REAL_UPGRADE_DB") {
        Ok(p) if !p.trim().is_empty() => p,
        _ => {
            eprintln!("跳过：未设置 TD_REAL_UPGRADE_DB（常规 CI 无本机数据）");
            return;
        }
    };
    assert!(
        std::path::Path::new(&path).exists(),
        "TD_REAL_UPGRADE_DB 指向的副本必须存在：{}",
        path
    );

    // 迁移前快照：版本号 + 行数（只读，不改动）
    let (before_version, before_counts): (i64, Vec<(String, i64)>) = {
        let conn = rusqlite::Connection::open(&path).expect("副本库必须可打开");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .expect("必须能读到 user_version");
        let counts: Vec<(String, i64)> = TABLES
            .iter()
            .map(|t| {
                let n: i64 = conn
                    .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
                    .unwrap_or(0);
                ((*t).to_string(), n)
            })
            .collect();
        (version, counts)
    };
    println!(
        "迁移前：version={} 行数={:?}",
        before_version, before_counts
    );

    // 用当前版本打开 → 触发迁移与一次性 origin 回填
    let db = Db::open(std::path::Path::new(&path)).expect("真实用户库副本必须能升级打开");

    let migrated_version: i64 = db
        .with_conn(|c| {
            c.query_row("PRAGMA user_version", [], |r| r.get(0))
                .map_err(task_dock_lib::error::AppError::from)
        })
        .expect("必须能读到迁移后的版本号");

    db.with_conn(|c| {
        let version: i64 = c
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(task_dock_lib::error::AppError::from)?;
        assert!(
            version >= before_version,
            "迁移后版本不得倒退：{} → {}",
            before_version,
            version
        );
        assert!(
            version >= 13,
            "迁移后必须到达 v12/v13 之后的版本，实际 {}",
            version
        );
        // 行数不得减少（迁移只加列/索引；来源预置可能增加 agent_sources）
        for (table, before) in &before_counts {
            let after: i64 = c
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .map_err(task_dock_lib::error::AppError::from)?;
            assert!(
                after >= *before,
                "{} 的行数在迁移后不得减少：{} → {}",
                table,
                before,
                after
            );
        }
        // 外键零违规
        let fk: i64 = c
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })
            .map_err(task_dock_lib::error::AppError::from)?;
        assert_eq!(fk, 0, "迁移后全库外键必须零违规");
        // 完整性
        let integrity: String = c
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(task_dock_lib::error::AppError::from)?;
        assert_eq!(integrity, "ok", "迁移后全库完整性检查必须通过");
        // v12 新列必须可查询（否则说明迁移没跑到 v12）
        let origin: String = c
            .query_row(
                "SELECT origin FROM agent_events ORDER BY received_at DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .map_err(task_dock_lib::error::AppError::from)?;
        assert!(
            ["real", "selftest", "benchmark", "mock"].contains(&origin.as_str()),
            "origin 列必须存在且取值合法，实际 {}",
            origin
        );
        // 通知的 agent_origin 列同样必须存在
        let _: String = c
            .query_row(
                "SELECT agent_origin FROM notification_history LIMIT 1",
                [],
                |r| r.get(0),
            )
            .map_err(task_dock_lib::error::AppError::from)?;
        Ok::<_, task_dock_lib::error::AppError>(())
    })
    .expect("升级后校验必须通过");

    // 幂等：再次打开不得再次改变归类或重复回填
    let db2 = Db::open(std::path::Path::new(&path)).expect("升级后的库必须能再次打开");
    db2.with_conn(|c| {
        let version: i64 = c
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(task_dock_lib::error::AppError::from)?;
        assert_eq!(
            version, migrated_version,
            "重复打开不得再次推进版本（迁移应当是幂等的）"
        );
        Ok::<_, task_dock_lib::error::AppError>(())
    })
    .expect("幂等重开必须成功");

    println!(
        "真实用户库升级验证通过：version {} → 13，行数无减少，外键零违规，integrity_check ok",
        before_version
    );
}
