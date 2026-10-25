//! 导航目标持久化：navigation_targets / task_navigation_targets / navigation_log。
//!
//! 关键语义：
//! - 目标行是「用户确认过的可信配置」，保存时全部过安全校验；
//! - 同一身份（app_key / url / 路径 / source+session）只存一行，重复保存即更新；
//! - 执行时（router）还会再次校验（安装路径可能已变化）；
//! - 与 task_agent_links 并存：旧表只服务 Agent 会话关联，新表覆盖全部目标类型。

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use super::{validate_aumid, validate_exe_path, validate_launch_args, validate_local_path, validate_url};
use crate::agents::now_iso;
use crate::db::Db;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
pub struct NavTargetRow {
    pub id: String,
    pub display_name: String,
    pub target_type: String,
    pub app_key: String,
    pub exe_path: String,
    pub launch_args: String,
    pub working_dir: String,
    pub app_user_model_id: String,
    pub url: String,
    pub path: String,
    pub agent_source_id: String,
    pub agent_session_id: String,
    pub window_title_hint: String,
    pub icon: String,
    pub category: String,
    pub favorite: bool,
    pub hidden: bool,
    pub last_used_at: Option<String>,
    pub use_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 保存/更新目标的输入（target_type 决定校验哪些字段）。
#[derive(Debug, Clone, Deserialize, Default)]
pub struct TargetInput {
    pub target_type: String,
    pub display_name: String,
    #[serde(default)]
    pub exe_path: String,
    #[serde(default)]
    pub launch_args: String,
    #[serde(default)]
    pub working_dir: String,
    #[serde(default)]
    pub app_user_model_id: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub agent_source_id: String,
    #[serde(default)]
    pub agent_session_id: String,
    #[serde(default)]
    pub window_title_hint: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub category: String,
    /// 允许显示名覆盖（编辑模式）；false = 沿用已存名称
    #[serde(default)]
    pub overwrite_name: bool,
}

/// 任务 ↔ 目标关联（带目标明细与实时运行状态）。
#[derive(Debug, Clone, Serialize)]
pub struct TaskNavLinkRow {
    pub id: String,
    pub task_id: String,
    pub target_id: String,
    pub display_order: i64,
    pub is_default: bool,
    pub launch_behavior: String,
    pub created_at: String,
    pub target: NavTargetRow,
    /// not_running | process_only | has_window | unavailable（配置失效）
    pub running_state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct NavLogRow {
    pub id: String,
    pub target_id: String,
    pub target_name: String,
    pub requested_action: String,
    pub actual_action: Option<String>,
    pub success: bool,
    pub fallback_used: bool,
    pub reason: String,
    pub verification_level: String,
    pub created_at: String,
}

const TARGET_COLS: &str = "id, display_name, target_type, app_key, exe_path, launch_args, working_dir, app_user_model_id, url, path, agent_source_id, agent_session_id, window_title_hint, icon, category, favorite, hidden, last_used_at, use_count, created_at, updated_at";

fn row_to_target(r: &rusqlite::Row<'_>) -> rusqlite::Result<NavTargetRow> {
    Ok(NavTargetRow {
        id: r.get(0)?,
        display_name: r.get(1)?,
        target_type: r.get(2)?,
        app_key: r.get(3)?,
        exe_path: r.get(4)?,
        launch_args: r.get(5)?,
        working_dir: r.get(6)?,
        app_user_model_id: r.get(7)?,
        url: r.get(8)?,
        path: r.get(9)?,
        agent_source_id: r.get(10)?,
        agent_session_id: r.get(11)?,
        window_title_hint: r.get(12)?,
        icon: r.get(13)?,
        category: r.get(14)?,
        favorite: r.get::<_, i64>(15)? != 0,
        hidden: r.get::<_, i64>(16)? != 0,
        last_used_at: r.get(17)?,
        use_count: r.get(18)?,
        created_at: r.get(19)?,
        updated_at: r.get(20)?,
    })
}

/// 按类型完整校验并计算稳定 app_key。
fn validate_input(input: &TargetInput) -> AppResult<(String, String)> {
    let name = input.display_name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("目标名称不能为空".into()));
    }
    if name.chars().count() > 120 {
        return Err(AppError::Validation("目标名称超过 120 字符".into()));
    }
    if !input.window_title_hint.trim().is_empty()
        && input.window_title_hint.trim().chars().count() > 64
    {
        return Err(AppError::Validation("窗口标题提示超过 64 字符".into()));
    }
    validate_launch_args(&input.launch_args)?;
    if !input.working_dir.trim().is_empty() && !std::path::Path::new(&input.working_dir).is_dir() {
        return Err(AppError::Validation(format!("工作目录不存在: {}", input.working_dir)));
    }
    let key = match input.target_type.as_str() {
        "application" => {
            if !input.app_user_model_id.trim().is_empty() {
                validate_aumid(&input.app_user_model_id)?;
                input.app_user_model_id.trim().to_string()
            } else {
                let p = validate_exe_path(&input.exe_path)?;
                p.to_string_lossy().to_ascii_lowercase()
            }
        }
        "url" => {
            validate_url(&input.url)?;
            input.url.trim().to_string()
        }
        "file" => {
            let p = validate_local_path(&input.path)?;
            if !p.is_file() {
                return Err(AppError::Validation(format!("不是文件: {}", input.path)));
            }
            p.to_string_lossy().to_ascii_lowercase()
        }
        "directory" => {
            let p = validate_local_path(&input.path)?;
            if !p.is_dir() {
                return Err(AppError::Validation(format!("不是目录: {}", input.path)));
            }
            p.to_string_lossy().to_ascii_lowercase()
        }
        _ => {
            return Err(AppError::Validation(format!(
                "未知目标类型: {}",
                input.target_type
            )))
        }
    };
    Ok((key, name.to_string()))
}

/// 保存目标：同 app_key 幂等更新（返回已有行的 id），否则插入新行。
pub fn save_target(db: &Db, input: &TargetInput) -> AppResult<NavTargetRow> {
    let (app_key, name) = validate_input(input)?;
    let now = now_iso();
    db.with_conn(|conn| {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM navigation_targets WHERE app_key = ?1 AND target_type = ?2",
                rusqlite::params![app_key, input.target_type],
                |r| r.get(0),
            )
            .optional()?;
        let id = existing.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if existing.is_some() {
            conn.execute(
                "UPDATE navigation_targets SET
                   display_name = CASE WHEN ?3 THEN ?4 ELSE display_name END,
                   exe_path = ?5, launch_args = ?6, working_dir = ?7, app_user_model_id = ?8,
                   url = ?9, path = ?10, window_title_hint = ?11, icon = ?12, category = ?13,
                   updated_at = ?1
                 WHERE id = ?2",
                rusqlite::params![
                    now,
                    id,
                    input.overwrite_name,
                    name,
                    input.exe_path.trim(),
                    input.launch_args.trim(),
                    input.working_dir.trim(),
                    input.app_user_model_id.trim(),
                    input.url.trim(),
                    input.path.trim(),
                    input.window_title_hint.trim(),
                    input.icon.trim(),
                    input.category.trim(),
                ],
            )?;
        } else {
            conn.execute(
                "INSERT INTO navigation_targets
                   (id, display_name, target_type, app_key, exe_path, launch_args, working_dir,
                    app_user_model_id, url, path, agent_source_id, agent_session_id,
                    window_title_hint, icon, category, favorite, hidden, use_count, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '', '', ?11, ?12, ?13, 0, 0, 0, ?14, ?14)",
                rusqlite::params![
                    id,
                    name,
                    input.target_type,
                    app_key,
                    input.exe_path.trim(),
                    input.launch_args.trim(),
                    input.working_dir.trim(),
                    input.app_user_model_id.trim(),
                    input.url.trim(),
                    input.path.trim(),
                    input.window_title_hint.trim(),
                    input.icon.trim(),
                    input.category.trim(),
                    now,
                ],
            )?;
        }
        get_target_conn(conn, &id)?.ok_or_else(|| AppError::NotFound("目标保存后读取失败".into()))
    })
}

fn get_target_conn(conn: &rusqlite::Connection, id: &str) -> AppResult<Option<NavTargetRow>> {
    let row = conn
        .query_row(
            &format!("SELECT {} FROM navigation_targets WHERE id = ?1", TARGET_COLS),
            rusqlite::params![id],
            row_to_target,
        )
        .optional()?;
    Ok(row)
}

pub fn get_target(db: &Db, id: &str) -> AppResult<Option<NavTargetRow>> {
    db.with_conn(|conn| get_target_conn(conn, id))
}

pub fn list_targets(db: &Db, include_hidden: bool) -> AppResult<Vec<NavTargetRow>> {
    db.with_conn(|conn| {
        let sql = format!(
            "SELECT {} FROM navigation_targets {} ORDER BY favorite DESC, use_count DESC, display_name",
            TARGET_COLS,
            if include_hidden { "" } else { "WHERE hidden = 0" }
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], row_to_target)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })
}

/// 目标元信息补丁（名称/图标/收藏/隐藏/标题提示）。
#[derive(Debug, Clone, Deserialize, Default)]
pub struct TargetPatch {
    pub display_name: Option<String>,
    pub icon: Option<String>,
    pub favorite: Option<bool>,
    pub hidden: Option<bool>,
    pub window_title_hint: Option<String>,
    pub category: Option<String>,
}

pub fn update_target(db: &Db, id: &str, patch: &TargetPatch) -> AppResult<()> {
    let now = now_iso();
    if let Some(n) = &patch.display_name {
        if n.trim().is_empty() || n.trim().chars().count() > 120 {
            return Err(AppError::Validation("名称为空或超过 120 字符".into()));
        }
    }
    if let Some(h) = &patch.window_title_hint {
        if h.trim().chars().count() > 64 {
            return Err(AppError::Validation("窗口标题提示超过 64 字符".into()));
        }
    }
    db.with_conn(|conn| {
        let n = conn.execute(
            "UPDATE navigation_targets SET
               display_name = COALESCE(?1, display_name),
               icon = COALESCE(?2, icon),
               favorite = COALESCE(?3, favorite),
               hidden = COALESCE(?4, hidden),
               window_title_hint = COALESCE(?5, window_title_hint),
               category = COALESCE(?6, category),
               updated_at = ?7
             WHERE id = ?8",
            rusqlite::params![
                patch.display_name.as_deref().map(str::trim).filter(|s| !s.is_empty()),
                patch.icon.as_deref().map(str::trim),
                patch.favorite.map(|b| b as i64),
                patch.hidden.map(|b| b as i64),
                patch.window_title_hint.as_deref().map(str::trim),
                patch.category.as_deref().map(str::trim),
                now,
                id,
            ],
        )?;
        if n == 0 {
            return Err(AppError::NotFound(format!("目标不存在: {}", id)));
        }
        Ok(())
    })
}

pub fn delete_target(db: &Db, id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute("DELETE FROM navigation_targets WHERE id = ?1", rusqlite::params![id])?;
        Ok(())
    })
}

/// 记录一次使用（跳转成功后由 router 调用）。
pub fn bump_use(db: &Db, id: &str) -> AppResult<()> {
    let now = now_iso();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE navigation_targets SET use_count = use_count + 1, last_used_at = ?1 WHERE id = ?2",
            rusqlite::params![now, id],
        )?;
        Ok(())
    })
}

// ── 任务关联 ────────────────────────────────────────────────

const VALID_BEHAVIORS: &[&str] =
    &["default", "focus_or_launch", "launch", "resume_session", "open"];

pub fn link_task(
    db: &Db,
    task_id: &str,
    target_id: &str,
    is_default: bool,
    launch_behavior: &str,
) -> AppResult<String> {
    let behavior = if VALID_BEHAVIORS.contains(&launch_behavior) {
        launch_behavior
    } else {
        "default"
    };
    let now = now_iso();
    let link_id = uuid::Uuid::new_v4().to_string();
    db.with_conn(|conn| {
        // 目标必须存在（不信任前端凭空 target_id）
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM navigation_targets WHERE id = ?1",
            rusqlite::params![target_id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(AppError::NotFound(format!("目标不存在: {}", target_id)));
        }
        if is_default {
            conn.execute(
                "UPDATE task_navigation_targets SET is_default = 0 WHERE task_id = ?1",
                rusqlite::params![task_id],
            )?;
        }
        let next_order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(display_order), -1) + 1 FROM task_navigation_targets WHERE task_id = ?1",
            rusqlite::params![task_id],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO task_navigation_targets (id, task_id, target_id, display_order, is_default, launch_behavior, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(task_id, target_id) DO UPDATE SET
               is_default = excluded.is_default, launch_behavior = excluded.launch_behavior",
            rusqlite::params![link_id, task_id, target_id, next_order, is_default as i64, behavior, now],
        )?;
        // 关联行 id：冲突更新时保留原 id（前端持有旧 id 继续操作）
        let actual: String = conn.query_row(
            "SELECT id FROM task_navigation_targets WHERE task_id = ?1 AND target_id = ?2",
            rusqlite::params![task_id, target_id],
            |r| r.get(0),
        )?;
        Ok(actual)
    })
}

pub fn unlink_task(db: &Db, link_id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM task_navigation_targets WHERE id = ?1",
            rusqlite::params![link_id],
        )?;
        Ok(())
    })
}

pub fn update_task_link(
    db: &Db,
    link_id: &str,
    display_order: Option<i64>,
    is_default: Option<bool>,
    launch_behavior: Option<&str>,
) -> AppResult<()> {
    let behavior = launch_behavior
        .filter(|b| VALID_BEHAVIORS.contains(b))
        .map(|b| b.to_string());
    db.with_conn(|conn| {
        if is_default == Some(true) {
            let task_id: String = conn
                .query_row(
                    "SELECT task_id FROM task_navigation_targets WHERE id = ?1",
                    rusqlite::params![link_id],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or_else(|| AppError::NotFound(format!("关联不存在: {}", link_id)))?;
            conn.execute(
                "UPDATE task_navigation_targets SET is_default = 0 WHERE task_id = ?1",
                rusqlite::params![task_id],
            )?;
        }
        let n = conn.execute(
            "UPDATE task_navigation_targets SET
               display_order = COALESCE(?1, display_order),
               is_default = COALESCE(?2, is_default),
               launch_behavior = COALESCE(?3, launch_behavior)
             WHERE id = ?4",
            rusqlite::params![
                display_order,
                is_default.map(|b| b as i64),
                behavior,
                link_id
            ],
        )?;
        if n == 0 {
            return Err(AppError::NotFound(format!("关联不存在: {}", link_id)));
        }
        Ok(())
    })
}

fn link_rows(db: &Db, where_clause: &str, params: &[&dyn rusqlite::ToSql]) -> AppResult<Vec<TaskNavLinkRow>> {
    let targets = list_targets(db, true)?;
    let by_id: std::collections::HashMap<String, NavTargetRow> =
        targets.into_iter().map(|t| (t.id.clone(), t)).collect();
    let keys: Vec<String> = by_id.values().map(|t| t.app_key.clone()).collect();
    let running = super::app_discovery::running_states(&keys);

    db.with_conn(|conn| {
        let sql = format!(
            "SELECT id, task_id, target_id, display_order, is_default, launch_behavior, created_at
             FROM task_navigation_targets {} ORDER BY display_order, created_at",
            where_clause
        );
        let mut stmt = conn.prepare(&sql)?;
        let raw: Vec<(String, String, String, i64, i64, String, String)> = stmt
            .query_map(params, |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(raw
            .into_iter()
            .filter_map(|(id, task_id, target_id, order, def, behavior, created)| {
                let target = by_id.get(&target_id)?.clone();
                // 运行状态 + 配置有效性
                let state = if target.target_type == "application" {
                    if target.exe_path.is_empty() && target.app_user_model_id.is_empty() {
                        "unavailable".to_string()
                    } else if !target.exe_path.is_empty()
                        && !std::path::Path::new(&target.exe_path).exists()
                    {
                        "unavailable".to_string()
                    } else {
                        running
                            .get(&target.app_key)
                            .map(|s| match s {
                                super::app_discovery::RunningState::HasWindow => "has_window",
                                super::app_discovery::RunningState::ProcessOnly => "process_only",
                                super::app_discovery::RunningState::NotRunning => "not_running",
                            })
                            .unwrap_or("not_running")
                            .to_string()
                    }
                } else {
                    // url/file/directory/agent_session 无进程态
                    match target.target_type.as_str() {
                        "url" => "always".to_string(),
                        "file" | "directory" => {
                            if std::path::Path::new(&target.path).exists() {
                                "always".to_string()
                            } else {
                                "unavailable".to_string()
                            }
                        }
                        "agent_session" => "agent".to_string(),
                        _ => "unknown".to_string(),
                    }
                };
                Some(TaskNavLinkRow {
                    id,
                    task_id,
                    target_id,
                    display_order: order,
                    is_default: def != 0,
                    launch_behavior: behavior,
                    created_at: created,
                    target,
                    running_state: state,
                })
            })
            .collect())
    })
}

/// 单个任务的关联目标（带运行状态）。
pub fn task_targets(db: &Db, task_id: &str) -> AppResult<Vec<TaskNavLinkRow>> {
    link_rows(db, "WHERE task_id = ?1", &[&task_id])
}

/// 全部任务关联（任务卡片批量渲染用；任务卡只展示前几个图标）。
pub fn all_task_links(db: &Db) -> AppResult<Vec<TaskNavLinkRow>> {
    link_rows(db, "", &[])
}

// ── 导航日志 ────────────────────────────────────────────────

pub fn write_log(db: &Db, r: &super::NavigationResult, target_name: &str) {
    let _ = db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO navigation_log (id, target_id, target_name, requested_action, actual_action, success, fallback_used, reason, verification_level, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                r.target_id,
                target_name,
                r.requested_action,
                r.actual_action,
                r.success as i64,
                r.fallback_used as i64,
                r.reason.clone().unwrap_or_default(),
                r.verification_level,
                now_iso(),
            ],
        )?;
        Ok::<_, AppError>(())
    });
}

pub fn recent_logs(db: &Db, limit: i64) -> AppResult<Vec<NavLogRow>> {
    let limit = limit.clamp(1, 200);
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, target_id, target_name, requested_action, actual_action, success, fallback_used, reason, verification_level, created_at
             FROM navigation_log ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![limit], |r| {
            Ok(NavLogRow {
                id: r.get(0)?,
                target_id: r.get(1)?,
                target_name: r.get(2)?,
                requested_action: r.get(3)?,
                actual_action: r.get(4)?,
                success: r.get::<_, i64>(5)? != 0,
                fallback_used: r.get::<_, i64>(6)? != 0,
                reason: r.get(7)?,
                verification_level: r.get(8)?,
                created_at: r.get(9)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    })
}

/// 清理日志（保留最近 N 条）。
pub fn prune_logs(db: &Db, keep: i64) -> AppResult<usize> {
    db.with_conn(|conn| {
        let n = conn.execute(
            "DELETE FROM navigation_log WHERE id NOT IN
               (SELECT id FROM navigation_log ORDER BY created_at DESC LIMIT ?1)",
            rusqlite::params![keep.max(0)],
        )?;
        Ok(n)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_input(exe: &str, name: &str) -> TargetInput {
        TargetInput {
            target_type: "application".into(),
            display_name: name.into(),
            exe_path: exe.into(),
            ..Default::default()
        }
    }

    fn url_input(url: &str, name: &str) -> TargetInput {
        TargetInput {
            target_type: "url".into(),
            display_name: name.into(),
            url: url.into(),
            ..Default::default()
        }
    }

    #[test]
    fn save_dedupes_by_app_key() {
        let db = Db::open_in_memory().unwrap();
        let a = save_target(&db, &app_input("C:\\Windows\\notepad.exe", "记事本")).unwrap();
        let b = save_target(&db, &app_input("C:\\Windows\\notepad.exe", "记事本 2")).unwrap();
        assert_eq!(a.id, b.id, "同一 exe 只允许一行");
        let row = get_target(&db, &a.id).unwrap().unwrap();
        assert_eq!(row.display_name, "记事本", "非覆盖模式沿用旧名");
        let c = save_target(
            &db,
            &TargetInput {
                overwrite_name: true,
                ..app_input("C:\\Windows\\notepad.exe", "新名字")
            },
        )
        .unwrap();
        assert_eq!(c.display_name, "新名字", "覆盖模式改名");
    }

    #[test]
    fn dangerous_targets_rejected() {
        let db = Db::open_in_memory().unwrap();
        // 相对路径
        assert!(save_target(&db, &app_input("notepad.exe", "x")).is_err());
        // 解释器黑名单
        assert!(save_target(&db, &app_input("C:\\Windows\\System32\\cmd.exe", "cmd")).is_err());
        // 非 http 协议
        assert!(save_target(&db, &url_input("ftp://x.com", "x")).is_err());
        assert!(save_target(&db, &url_input("javascript:1", "x")).is_err());
        // 不存在的文件
        assert!(save_target(
            &db,
            &TargetInput {
                target_type: "file".into(),
                display_name: "x".into(),
                path: "C:\\no\\such\\file.txt".into(),
                ..Default::default()
            }
        )
        .is_err());
        // 未知类型
        assert!(save_target(
            &db,
            &TargetInput {
                target_type: "script".into(),
                display_name: "x".into(),
                ..Default::default()
            }
        )
        .is_err());
    }

    #[test]
    fn task_link_crud_and_default_uniqueness() {
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags, advance_minutes, created_at, updated_at)
                 VALUES ('t1', 'T', '', 2, 'pending', '', '[]', 0, ?1, ?1)",
                rusqlite::params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let a = save_target(&db, &url_input("https://github.com", "GitHub")).unwrap();
        let b = save_target(&db, &url_input("https://example.com", "Example")).unwrap();

        let la = link_task(&db, "t1", &a.id, true, "open").unwrap();
        let lb = link_task(&db, "t1", &b.id, true, "default").unwrap();
        let links = task_targets(&db, "t1").unwrap();
        assert_eq!(links.len(), 2);
        let defaults: Vec<_> = links.iter().filter(|l| l.is_default).collect();
        assert_eq!(defaults.len(), 1, "每任务仅一个默认目标");
        assert_eq!(defaults[0].target_id, b.id, "后设默认顶替先设");

        // 重复关联 = 更新而非报错
        link_task(&db, "t1", &a.id, false, "launch").unwrap();
        assert_eq!(task_targets(&db, "t1").unwrap().len(), 2);

        // 顺序调整 + 单独设默认
        update_task_link(&db, &la, Some(5), Some(true), None).unwrap();
        let links = task_targets(&db, "t1").unwrap();
        assert_eq!(links.iter().filter(|l| l.is_default).count(), 1);

        unlink_task(&db, &lb).unwrap();
        assert_eq!(task_targets(&db, "t1").unwrap().len(), 1);
    }

    #[test]
    fn link_to_unknown_target_rejected() {
        let db = Db::open_in_memory().unwrap();
        let now = now_iso();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags, advance_minutes, created_at, updated_at)
                 VALUES ('t1', 'T', '', 2, 'pending', '', '[]', 0, ?1, ?1)",
                rusqlite::params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let err = link_task(&db, "t1", "no-such-target", false, "default").unwrap_err();
        assert!(err.to_string().contains("不存在"));
    }

    #[test]
    fn missing_exe_marks_unavailable() {
        let db = Db::open_in_memory().unwrap();
        // 直接插入一个 exe 已失效的目标（模拟卸载后残留），task_targets 应标 unavailable
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO navigation_targets (id, display_name, target_type, app_key, exe_path, launch_args, working_dir, app_user_model_id, url, path, agent_source_id, agent_session_id, window_title_hint, icon, category, favorite, hidden, use_count, created_at, updated_at)
                 VALUES ('x1', '旧应用', 'application', 'c:\\gone\\app.exe', 'C:\\Gone\\App.exe', '', '', '', '', '', '', '', '', '', '', 0, 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let now = now_iso();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags, advance_minutes, created_at, updated_at)
                 VALUES ('t1', 'T', '', 2, 'pending', '', '[]', 0, ?1, ?1)",
                rusqlite::params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        link_task(&db, "t1", "x1", false, "default").unwrap();
        let links = task_targets(&db, "t1").unwrap();
        assert_eq!(links[0].running_state, "unavailable");
    }

    #[test]
    fn log_roundtrip_and_prune() {
        let db = Db::open_in_memory().unwrap();
        let r = super::super::NavigationResult {
            success: false,
            requested_action: "focus_window".into(),
            actual_action: None,
            fallback_used: false,
            target_id: "x".into(),
            reason: Some("测试".into()),
            verification_level: "none".into(),
        };
        write_log(&db, &r, "目标A");
        write_log(&db, &r, "目标B");
        let logs = recent_logs(&db, 10).unwrap();
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].target_name, "目标B", "最新在前");
        prune_logs(&db, 1).unwrap();
        assert_eq!(recent_logs(&db, 10).unwrap().len(), 1);
    }
}
