//! 真机验收工具：用**真实**的历史备份文件验证 v0.4 恢复链路。
//!
//! 默认 `#[ignore]`（不依赖本机数据，常规 `cargo test` 直接跳过）。
//! 真机验收时显式运行：
//!
//! ```bash
//! TD_REAL_BACKUP_PATH="%APPDATA%\com.taskdock.desktop\backups\backup-20261025-162633.json" \
//!   cargo test --test real_backup_restore -- --ignored --nocapture
//! ```
//!
//! 验证内容：真实 v1/v2 备份文件 → 结构校验 → 导入全新内存库 →
//! 行数与文件一致 + `PRAGMA foreign_key_check` 零违规。
//! 只读真实文件、内存库导入，绝不触碰本机应用数据库。

use task_dock_lib::commands::data::import_value;
use task_dock_lib::db::Db;

#[test]
#[ignore = "真机验收工具：需要 TD_REAL_BACKUP_PATH 指向真实备份文件"]
fn real_backup_file_imports_into_fresh_database() {
    let path = match std::env::var("TD_REAL_BACKUP_PATH") {
        Ok(p) if !p.trim().is_empty() => p,
        _ => {
            eprintln!("跳过：未设置 TD_REAL_BACKUP_PATH（常规 CI 无本机数据）");
            return;
        }
    };
    let raw = std::fs::read_to_string(&path).expect("真实备份文件必须可读");
    let data: serde_json::Value = serde_json::from_str(&raw).expect("真实备份必须是合法 JSON");
    let version = data.get("version").and_then(|v| v.as_i64()).unwrap_or(0);
    let expect_tasks = data
        .get("tasks")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    println!(
        "真实备份: version={} tasks={} path={}",
        version, expect_tasks, path
    );

    let db = Db::open_in_memory().expect("内存库创建失败");
    // import_value 内部先执行完整导入前校验（结构/版本/引用完整性），
    // 任一校验失败整体拒绝且原库不动——导入成功即证明真实备份通过全部校验
    import_value(&db, &data).expect("真实备份必须能恢复进全新数据库");
    let restored: i64 = db
        .with_conn(|c| {
            c.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
                .map_err(task_dock_lib::error::AppError::from)
        })
        .expect("恢复后必须可查询");
    assert_eq!(
        restored as usize, expect_tasks,
        "恢复的任务数必须与文件一致"
    );
    let violations: i64 = db
        .with_conn(|c| {
            c.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })
            .map_err(task_dock_lib::error::AppError::from)
        })
        .expect("外键检查必须可执行");
    assert_eq!(violations, 0, "恢复后全库外键必须零违规");
    println!("真实备份恢复验证通过（{} 个任务，外键零违规）", restored);
}
