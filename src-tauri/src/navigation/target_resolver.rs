//! 导航目标持久化：navigation_targets / task_navigation_targets / navigation_log。
//!
//! 关键语义：
//! - 目标行是「用户确认过的可信配置」，保存时全部过安全校验；
//! - 同一身份（app_key / url / 路径 / source+session）只存一行，重复保存即更新；
//! - 执行时（router）还会再次校验（安装路径可能已变化）；
//! - 与 task_agent_links 并存：旧表只服务 Agent 会话关联，新表覆盖全部目标类型；
//! - 旧表同步有**所有权语义**（v5 迁移 origin 列）：nav 关联自动补写的兼容行
//!   `origin='auto'`，随其导航关联一同解除；用户手工关联 `origin='user'`，
//!   任何自动逻辑都不得删除。

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use super::window_manager::{MemoryOrigin, WindowInfo, WindowMemory};
use super::{
    validate_aumid, validate_exe_path, validate_launch_args, validate_local_path, validate_url,
};
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
    pub window_identity: Option<WindowMemory>,
    pub window_fallback: String,
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
///
/// `agent_session` 需要查库：会话必须在本地 `agent_sessions` 里真实存在，
/// 否则保存下来就是一个"点了必然失败"的坏目标（前端无从分辨）。
fn validate_input(db: &Db, input: &TargetInput) -> AppResult<(String, String)> {
    let mut name = input.display_name.trim().to_string();
    if !input.window_title_hint.trim().is_empty()
        && input.window_title_hint.trim().chars().count() > 64
    {
        return Err(AppError::Validation("窗口标题提示超过 64 字符".into()));
    }
    validate_launch_args(&input.launch_args)?;
    if !input.working_dir.trim().is_empty() && !std::path::Path::new(&input.working_dir).is_dir() {
        return Err(AppError::Validation(format!(
            "工作目录不存在: {}",
            input.working_dir
        )));
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
        "agent_session" => {
            let source = input.agent_source_id.trim();
            let session = input.agent_session_id.trim();
            if source.is_empty() || session.is_empty() {
                return Err(AppError::Validation(
                    "Agent 会话目标必须同时提供来源与会话 ID".into(),
                ));
            }
            // 会话 ID 白名单校验（防参数注入，与 router 执行期校验一致）
            crate::agents::validate_session_id(session)?;
            let (source_ok, title) = db.with_conn(|conn| {
                let source_ok: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM agent_sources WHERE id = ?1",
                    rusqlite::params![source],
                    |r| r.get(0),
                )?;
                let title: Option<String> = conn
                    .query_row(
                        "SELECT title FROM agent_sessions WHERE source_id = ?1 AND external_id = ?2",
                        rusqlite::params![source, session],
                        |r| r.get(0),
                    )
                    .optional()?;
                Ok::<_, AppError>((source_ok, title))
            })?;
            if source_ok == 0 {
                return Err(AppError::Validation(format!("未注册的来源: {}", source)));
            }
            let title = title.ok_or_else(|| {
                AppError::Validation(format!(
                    "本地不存在该 Agent 会话: {}:{}（不能保存指向未知会话的目标）",
                    source, session
                ))
            })?;
            if name.is_empty() {
                // 名称留空时用会话标题兜底，避免用户被迫手打
                name = if title.trim().is_empty() {
                    format!("{}:{}", source, session)
                } else {
                    title.trim().to_string()
                };
            }
            format!("{}:{}", source, session)
        }
        _ => {
            return Err(AppError::Validation(format!(
                "未知目标类型: {}",
                input.target_type
            )))
        }
    };
    if name.is_empty() {
        return Err(AppError::Validation("目标名称不能为空".into()));
    }
    if name.chars().count() > 120 {
        return Err(AppError::Validation("目标名称超过 120 字符".into()));
    }
    Ok((key, name))
}

/// 保存目标：同 app_key 幂等更新（返回已有行的 id），否则插入新行。
pub fn save_target(db: &Db, input: &TargetInput) -> AppResult<NavTargetRow> {
    let (app_key, name) = validate_input(db, input)?;
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
                   agent_source_id = ?14, agent_session_id = ?15,
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
                    input.agent_source_id.trim(),
                    input.agent_session_id.trim(),
                ],
            )?;
        } else {
            conn.execute(
                "INSERT INTO navigation_targets
                   (id, display_name, target_type, app_key, exe_path, launch_args, working_dir,
                    app_user_model_id, url, path, agent_source_id, agent_session_id,
                    window_title_hint, icon, category, favorite, hidden, use_count, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0, 0, 0, ?16, ?16)",
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
                    input.agent_source_id.trim(),
                    input.agent_session_id.trim(),
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
            &format!(
                "SELECT {} FROM navigation_targets WHERE id = ?1",
                TARGET_COLS
            ),
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
                patch
                    .display_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty()),
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
        let tx = conn.unchecked_transaction()?;
        let conn = &tx;
        // 目标删除会级联清掉 task_navigation_targets（FK ON DELETE CASCADE），
        // 但它自动补写的旧表影子记录（origin='auto'）没有外键，需在此同步清理，
        // 否则任务卡的 Agent 计数残留指向已删除目标的死链接。
        // 用户手工关联（origin='user'）保留为历史记录。
        let ident: Option<(String, String)> = conn
            .query_row(
                "SELECT agent_source_id, agent_session_id FROM navigation_targets
                 WHERE id = ?1 AND target_type = 'agent_session'
                   AND agent_source_id <> '' AND agent_session_id <> ''",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((source, session)) = ident {
            conn.execute(
                "DELETE FROM task_agent_links
                 WHERE source_id = ?1 AND session_external_id = ?2
                   AND run_external_id IS NULL AND origin = 'auto'
                   AND task_id IN (SELECT task_id FROM task_navigation_targets WHERE target_id = ?3)",
                rusqlite::params![source, session, id],
            )?;
        }
        conn.execute(
            "DELETE FROM navigation_targets WHERE id = ?1",
            rusqlite::params![id],
        )?;
        tx.commit()?;
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

const VALID_BEHAVIORS: &[&str] = &[
    "default",
    "focus_or_launch",
    "launch",
    "resume_session",
    "open",
];

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
        let tx = conn.unchecked_transaction()?;
        let conn = &tx;
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
        // 与旧 task_agent_links 兼容：Agent 会话目标额外补一条旧表记录。
        // 旧版本的「任务 ↔ Agent 会话」查询与徽标计数都只读这张表，
        // 不写就会表现为"新关联了会话，但任务卡上的 Agent 数还是 0"。
        // 影子记录必须带 origin='auto'（v5 所有权语义）：解除导航关联时只删
        // 自动补写的行；若用户已有同会话的手工关联（NOT EXISTS 命中），这里不写，
        // 手工行保持 origin='user'，永不自动删除。
        let agent_ident: Option<(String, String)> = conn
            .query_row(
                "SELECT agent_source_id, agent_session_id FROM navigation_targets
                 WHERE id = ?1 AND target_type = 'agent_session'
                   AND agent_source_id <> '' AND agent_session_id <> ''",
                rusqlite::params![target_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((source, session)) = agent_ident {
            conn.execute(
                "INSERT INTO task_agent_links (id, task_id, source_id, session_external_id, run_external_id, created_at, origin)
                 SELECT ?1, ?2, ?3, ?4, NULL, ?5, 'auto' WHERE NOT EXISTS (
                   SELECT 1 FROM task_agent_links
                   WHERE task_id = ?2 AND source_id = ?3 AND session_external_id = ?4
                     AND run_external_id IS NULL
                 )",
                rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    task_id,
                    source,
                    session,
                    now
                ],
            )?;
        }
        tx.commit()?;
        Ok(actual)
    })
}

pub fn unlink_task(db: &Db, link_id: &str) -> AppResult<()> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let conn = &tx;
        // 先取出被删关联的目标身份：若是 Agent 会话目标，同步清理**本关联自动补写**的
        // 旧表影子记录（origin='auto'）。用户手工创建的关联（origin='user'）保留——
        // 它属于用户自己建立的任务↔Agent 绑定，导航解除不得误删。
        let ident: Option<(String, String, String)> = conn
            .query_row(
                "SELECT l.task_id, t.agent_source_id, t.agent_session_id
                 FROM task_navigation_targets l
                 JOIN navigation_targets t ON t.id = l.target_id
                 WHERE l.id = ?1 AND t.target_type = 'agent_session'",
                rusqlite::params![link_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        conn.execute(
            "DELETE FROM task_navigation_targets WHERE id = ?1",
            rusqlite::params![link_id],
        )?;
        if let Some((task_id, source, session)) = ident {
            conn.execute(
                "DELETE FROM task_agent_links
                 WHERE task_id = ?1 AND source_id = ?2 AND session_external_id = ?3
                   AND run_external_id IS NULL AND origin = 'auto'",
                rusqlite::params![task_id, source, session],
            )?;
        }
        tx.commit()?;
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

/// 只根据数据库中具体的关联读取窗口配置，拒绝关联与目标不匹配的请求。
pub fn task_window_config(
    db: &Db,
    link_id: &str,
    target_id: &str,
) -> AppResult<(Option<WindowMemory>, String)> {
    db.with_conn(|conn| {
        let row: Option<(Option<String>, String)> = conn.query_row(
            "SELECT window_identity, window_fallback FROM task_navigation_targets WHERE id = ?1 AND target_id = ?2",
            rusqlite::params![link_id, target_id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        let (raw, fallback) = row.ok_or_else(|| AppError::NotFound("任务关联不存在或目标不匹配".into()))?;
        let memory = raw.map(|s| serde_json::from_str(&s)).transpose()?;
        Ok((memory, fallback))
    })
}

/// 保存当前窗口的稳定身份；窗口所属程序必须与该关联的目标一致。
pub fn set_task_window(db: &Db, link_id: &str, window: Option<&WindowInfo>) -> AppResult<()> {
    db.with_conn(|conn| {
        let target: Option<(String, String)> = conn.query_row(
            "SELECT t.target_type, t.exe_path FROM task_navigation_targets l JOIN navigation_targets t ON t.id = l.target_id WHERE l.id = ?1",
            [link_id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        let (kind, exe) = target.ok_or_else(|| AppError::NotFound("任务关联不存在".into()))?;
        if kind != "application" { return Err(AppError::Validation("只有应用目标可以选择窗口".into())); }
        let identity = if let Some(w) = window {
            if w.class_name.is_empty() || w.title.is_empty() || exe.is_empty()
                || !w.exe_path.as_deref().is_some_and(|p| p.eq_ignore_ascii_case(&exe)) {
                return Err(AppError::Validation("窗口所属程序与任务关联的应用不一致".into()));
            }
            Some(serde_json::to_string(&WindowMemory::from_window_with_origin(w, MemoryOrigin::User))?)
        } else { None };
        conn.execute("UPDATE task_navigation_targets SET window_identity = ?1 WHERE id = ?2", rusqlite::params![identity, link_id])?;
        Ok(())
    })
}

/// 新关联与用户所选窗口在同一事务写入，失败时不留下无身份的关联。
pub fn link_task_window(
    db: &Db,
    task_id: &str,
    target_id: &str,
    w: &WindowInfo,
) -> AppResult<String> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let target: Option<(String, String)> = tx.query_row(
            "SELECT target_type, exe_path FROM navigation_targets WHERE id = ?1", [target_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional()?;
        let (kind, exe) = target.ok_or_else(|| AppError::NotFound("目标不存在".into()))?;
        if kind != "application" || exe.is_empty() || w.title.is_empty() || w.class_name.is_empty()
            || !w.exe_path.as_deref().is_some_and(|p| p.eq_ignore_ascii_case(&exe)) {
            return Err(AppError::Validation("窗口所属程序与任务关联的应用不一致".into()));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let identity = serde_json::to_string(&WindowMemory::from_window_with_origin(w, MemoryOrigin::User))?;
        tx.execute(
            "INSERT INTO task_navigation_targets (id, task_id, target_id, display_order, is_default, launch_behavior, created_at, window_identity)
             VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(display_order), -1) + 1 FROM task_navigation_targets WHERE task_id = ?2), 0, 'default', ?4, ?5)
             ON CONFLICT(task_id, target_id) DO UPDATE SET window_identity = excluded.window_identity",
            rusqlite::params![id, task_id, target_id, now_iso(), identity],
        )?;
        let actual = tx.query_row("SELECT id FROM task_navigation_targets WHERE task_id = ?1 AND target_id = ?2",
            rusqlite::params![task_id, target_id], |r| r.get(0))?;
        tx.commit()?;
        Ok(actual)
    })
}

pub fn set_task_window_fallback(db: &Db, link_id: &str, fallback: &str) -> AppResult<()> {
    if !["reselect", "focus_app", "launch"].contains(&fallback) {
        return Err(AppError::Validation("未知窗口降级策略".into()));
    }
    db.with_conn(|conn| {
        let n = conn.execute(
            "UPDATE task_navigation_targets SET window_fallback = ?1 WHERE id = ?2",
            rusqlite::params![fallback, link_id],
        )?;
        if n == 0 {
            return Err(AppError::NotFound("任务关联不存在".into()));
        }
        Ok(())
    })
}

fn link_rows(
    db: &Db,
    where_clause: &str,
    params: &[&dyn rusqlite::ToSql],
) -> AppResult<Vec<TaskNavLinkRow>> {
    let targets = list_targets(db, true)?;
    let by_id: std::collections::HashMap<String, NavTargetRow> =
        targets.into_iter().map(|t| (t.id.clone(), t)).collect();
    let keys: Vec<String> = by_id.values().map(|t| t.app_key.clone()).collect();
    let running = super::app_discovery::running_states(&keys);
    // Agent 会话目标的"存活"判定：宿主清理掉会话后，关联就变成失效链接，
    // 前端需要如实显示"已失效"而不是继续显示"Agent"。
    let known_sessions: std::collections::HashSet<(String, String)> = db
        .with_conn(|conn| -> AppResult<Vec<(String, String)>> {
            let mut stmt = conn.prepare("SELECT source_id, external_id FROM agent_sessions")?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
        })?
        .into_iter()
        .collect();

    db.with_conn(|conn| {
        let sql = format!(
            "SELECT id, task_id, target_id, display_order, is_default, launch_behavior, created_at, window_identity, window_fallback
             FROM task_navigation_targets {} ORDER BY display_order, created_at",
            where_clause
        );
        let mut stmt = conn.prepare(&sql)?;
        #[allow(clippy::type_complexity)]
        let raw: Vec<(String, String, String, i64, i64, String, String, Option<String>, String)> = stmt
            .query_map(params, |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(raw
            .into_iter()
            .filter_map(|(id, task_id, target_id, order, def, behavior, created, identity, fallback)| {
                let target = by_id.get(&target_id)?.clone();
                // 运行状态 + 配置有效性
                let state = if target.target_type == "application" {
                    // 配置本身失效：既没有 exe 身份也没有 AUMID，或 exe 已被卸载/迁移
                    let no_identity =
                        target.exe_path.is_empty() && target.app_user_model_id.is_empty();
                    let exe_gone = !target.exe_path.is_empty()
                        && !std::path::Path::new(&target.exe_path).exists();
                    if no_identity || exe_gone {
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
                        "agent_session" => {
                            if known_sessions.contains(&(
                                target.agent_source_id.clone(),
                                target.agent_session_id.clone(),
                            )) {
                                "agent".to_string()
                            } else {
                                "unavailable".to_string()
                            }
                        }
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
                    window_identity: identity.and_then(|s| serde_json::from_str(&s).ok()),
                    window_fallback: fallback,
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

    // ── 问题 2 回归：Agent 会话可信目标链路 ────────────────────

    fn seed_session(db: &Db, source: &str, external: &str, title: &str) {
        let now = now_iso();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO agent_sessions (id, source_id, external_id, title, status, first_seen_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?5)",
                rusqlite::params![
                    format!("{}-{}", source, external),
                    source,
                    external,
                    title,
                    now
                ],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    fn agent_input(source: &str, session: &str, name: &str) -> TargetInput {
        TargetInput {
            target_type: "agent_session".into(),
            display_name: name.into(),
            agent_source_id: source.into(),
            agent_session_id: session.into(),
            ..Default::default()
        }
    }

    #[test]
    fn agent_session_target_requires_existing_session() {
        let db = Db::open_in_memory().unwrap();
        // 会话不存在 → 拒绝（不能保存指向未知会话的坏目标）
        let err = save_target(&db, &agent_input("codex", "no-such-session", "X")).unwrap_err();
        assert!(
            err.to_string().contains("不存在该 Agent 会话"),
            "实际: {}",
            err
        );
        // 来源不存在 → 拒绝
        seed_session(&db, "codex", "sess-1", "联调会话");
        let err = save_target(&db, &agent_input("ghost", "sess-1", "X")).unwrap_err();
        assert!(err.to_string().contains("未注册的来源"), "实际: {}", err);
        // 非法会话 ID → 拒绝
        let err = save_target(&db, &agent_input("codex", "bad id;rm -rf", "X")).unwrap_err();
        assert!(err.to_string().contains("非法字符"), "实际: {}", err);
    }

    #[test]
    fn agent_session_target_saves_identity_and_dedupes() {
        let db = Db::open_in_memory().unwrap();
        seed_session(&db, "codex", "sess-1", "联调会话");
        // 名称留空 → 用会话标题兜底
        let a = save_target(&db, &agent_input("codex", "sess-1", "")).unwrap();
        assert_eq!(a.display_name, "联调会话");
        assert_eq!(a.agent_source_id, "codex");
        assert_eq!(a.agent_session_id, "sess-1", "会话身份必须落库，否则点不动");
        assert_eq!(a.app_key, "codex:sess-1");
        assert_eq!(a.target_type, "agent_session");
        // 同一会话重复保存 = 更新同一行
        let b = save_target(&db, &agent_input("codex", "sess-1", "自定义名")).unwrap();
        assert_eq!(a.id, b.id, "同一会话只允许一行目标");
        assert_eq!(list_targets(&db, true).unwrap().len(), 1);
    }

    #[test]
    fn linking_agent_session_target_keeps_legacy_table_in_sync() {
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
        seed_session(&db, "codex", "sess-1", "联调会话");
        let t = save_target(&db, &agent_input("codex", "sess-1", "")).unwrap();
        let link_id = link_task(&db, "t1", &t.id, true, "resume_session").unwrap();

        // 旧表必须同步写入（旧版 UI 只读 task_agent_links）
        let legacy: i64 = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM task_agent_links WHERE task_id = 't1' AND source_id = 'codex' AND session_external_id = 'sess-1'",
                    [],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(legacy, 1, "关联 Agent 会话目标必须同步旧表");
        // 自动补写的影子记录必须带 origin='auto'（所有权语义）
        let origin: String = db
            .with_conn(|c| {
                c.query_row("SELECT origin FROM task_agent_links", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(origin, "auto");
        // 重复关联不得产生重复旧记录
        link_task(&db, "t1", &t.id, false, "default").unwrap();
        let legacy2: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM task_agent_links", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(legacy2, 1, "幂等关联不得重复写旧表");
        // 取消关联 → 本关联自动补写的影子记录同步清理
        unlink_task(&db, &link_id).unwrap();
        let legacy3: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM task_agent_links", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(legacy3, 0, "取消关联后自动影子记录不得残留");
        // 重复解除：幂等，不报错
        unlink_task(&db, &link_id).unwrap();
    }

    // ── 关联所有权（v5 origin 语义）回归 ─────────────────────

    fn insert_manual_link(db: &Db, id: &str, task: &str, source: &str, session: &str) {
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO task_agent_links (id, task_id, source_id, session_external_id, run_external_id, created_at, origin)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, 'user')",
                rusqlite::params![id, task, source, session, now_iso()],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    fn legacy_count(db: &Db) -> i64 {
        db.with_conn(|c| {
            c.query_row("SELECT COUNT(*) FROM task_agent_links", [], |r| r.get(0))
                .map_err(AppError::from)
        })
        .unwrap()
    }

    fn task_row(db: &Db, id: &str) {
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id, title, description, priority, status, category, tags, advance_minutes, created_at, updated_at)
                 VALUES (?1, 'T', '', 2, 'pending', '', '[]', 0, ?2, ?2)",
                rusqlite::params![id, now_iso()],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn task_window_identities_are_isolated_and_have_no_hwnd() {
        let db = Db::open_in_memory().unwrap();
        task_row(&db, "a");
        task_row(&db, "b");
        db.with_conn(|c| {
            c.execute("INSERT INTO navigation_targets (id, display_name, target_type, app_key, exe_path, created_at, updated_at) VALUES ('app', 'Chrome', 'application', 'c:\\app\\app.exe', 'C:\\App\\App.exe', 'now', 'now')", [])?;
            Ok(())
        }).unwrap();
        let a = link_task(&db, "a", "app", false, "default").unwrap();
        let b = link_task(&db, "b", "app", false, "default").unwrap();
        let win = |hwnd, title: &str| WindowInfo {
            hwnd,
            pid: 42,
            title: title.into(),
            class_name: "Chrome_WidgetWin_1".into(),
            is_minimized: false,
            exe_path: Some("c:\\app\\app.exe".into()),
        };
        set_task_window(&db, &a, Some(&win(987654, "项目 A"))).unwrap();
        set_task_window(&db, &b, Some(&win(123456, "项目 B"))).unwrap();
        set_task_window_fallback(&db, &b, "focus_app").unwrap();
        assert_eq!(
            task_window_config(&db, &a, "app").unwrap().0.unwrap().title,
            "项目 A"
        );
        let (other, fallback) = task_window_config(&db, &b, "app").unwrap();
        assert_eq!(other.unwrap().title, "项目 B");
        assert_eq!(fallback, "focus_app");
        assert!(task_window_config(&db, &a, "wrong-target").is_err());
        let raw: String = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT window_identity FROM task_navigation_targets WHERE id = ?1",
                    [&a],
                    |r| r.get(0),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert!(!raw.contains("987654"));
        assert!(set_task_window(
            &db,
            &a,
            Some(&WindowInfo {
                exe_path: Some("c:\\other.exe".into()),
                ..win(1, "伪造")
            })
        )
        .is_err());
        set_task_window(&db, &a, None).unwrap();
        assert!(task_window_config(&db, &a, "app").unwrap().0.is_none());
        assert_eq!(
            task_window_config(&db, &b, "app").unwrap().0.unwrap().title,
            "项目 B"
        );
        let c = link_task_window(&db, "a", "app", &win(44, "项目 C")).unwrap();
        assert_eq!(c, a);
        assert_eq!(
            task_window_config(&db, &a, "app").unwrap().0.unwrap().title,
            "项目 C"
        );
        let wrong = WindowInfo {
            exe_path: Some("c:\\other.exe".into()),
            ..win(55, "错误")
        };
        assert!(link_task_window(&db, "a", "app", &wrong).is_err());
        assert_eq!(
            task_window_config(&db, &a, "app").unwrap().0.unwrap().title,
            "项目 C"
        );
    }

    /// 同一会话同时存在新旧关联：导航关联解除只删自己的影子记录，
    /// 用户手工创建的关联（origin='user'）必须原样保留。
    #[test]
    fn unlink_nav_link_never_deletes_user_manual_link() {
        let db = Db::open_in_memory().unwrap();
        task_row(&db, "t1");
        seed_session(&db, "codex", "sess-1", "联调会话");
        // 用户先在旧 UI 手工关联该会话
        insert_manual_link(&db, "l-user", "t1", "codex", "sess-1");
        // 再通过统一导航关联同一会话：影子记录被 NOT EXISTS 跳过（已有手工行）
        let t = save_target(&db, &agent_input("codex", "sess-1", "")).unwrap();
        let link_id = link_task(&db, "t1", &t.id, false, "default").unwrap();
        assert_eq!(legacy_count(&db), 1, "已有手工关联时不得重复补影子记录");
        // 解除导航关联：手工关联必须幸存
        unlink_task(&db, &link_id).unwrap();
        assert_eq!(legacy_count(&db), 1, "解除导航关联不得误删用户手工关联");
        let left: (String, String) = db
            .with_conn(|c| {
                c.query_row(
                    "SELECT origin, session_external_id FROM task_agent_links",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(left, ("user".into(), "sess-1".into()));
        // 只有旧版关联（无导航关联）的场景：一切自动逻辑都不应触碰它
        // （重复解除已不存在 link_id，上面幂等调用已覆盖）
    }

    /// 只有旧版关联：删除另一个任务的导航关联不得波及本任务的手工关联。
    #[test]
    fn unlink_nav_link_on_other_task_keeps_manual_link_intact() {
        let db = Db::open_in_memory().unwrap();
        task_row(&db, "t1");
        task_row(&db, "t2");
        seed_session(&db, "codex", "sess-1", "联调会话");
        seed_session(&db, "codex", "sess-2", "另一个会话");
        // t1 手工关联 sess-1；t2 导航关联 sess-2（不同会话）
        insert_manual_link(&db, "l-user", "t1", "codex", "sess-1");
        let t2 = save_target(&db, &agent_input("codex", "sess-2", "")).unwrap();
        let link2 = link_task(&db, "t2", &t2.id, false, "default").unwrap();
        assert_eq!(legacy_count(&db), 2);
        unlink_task(&db, &link2).unwrap();
        assert_eq!(legacy_count(&db), 1, "只能删本关联的影子记录");
        let left: String = db
            .with_conn(|c| {
                c.query_row("SELECT id FROM task_agent_links", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(left, "l-user");
    }

    /// 删除导航目标：级联清导航关联 + 本目标的自动影子记录；手工关联保留。
    #[test]
    fn delete_target_cleans_auto_compat_and_keeps_user_links() {
        let db = Db::open_in_memory().unwrap();
        task_row(&db, "t1");
        task_row(&db, "t2");
        seed_session(&db, "codex", "sess-1", "联调会话");
        // t1 手工关联；t2 经导航关联同一会话目标
        insert_manual_link(&db, "l-user", "t1", "codex", "sess-1");
        let t = save_target(&db, &agent_input("codex", "sess-1", "")).unwrap();
        link_task(&db, "t2", &t.id, false, "default").unwrap();
        assert_eq!(legacy_count(&db), 2);
        delete_target(&db, &t.id).unwrap();
        // t2 的导航关联被级联删除；其影子记录同步清理；t1 手工关联保留
        let nav: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM task_navigation_targets", [], |r| {
                    r.get(0)
                })
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(nav, 0, "删除目标应级联清掉导航关联");
        assert_eq!(legacy_count(&db), 1, "只清 auto 影子记录，手工关联保留");
        let left: String = db
            .with_conn(|c| {
                c.query_row("SELECT id FROM task_agent_links", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(left, "l-user");
    }

    /// 删除 Agent 来源：任务与两种关联记录都保留（历史引用，不做静默删除）。
    #[test]
    fn delete_agent_source_keeps_tasks_and_links() {
        let db = Db::open_in_memory().unwrap();
        task_row(&db, "t1");
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO agent_sources (id, display_name, kind, enabled, verified, homepage, note, config, created_at, updated_at)
                 VALUES ('myagent','自定义来源','manual',1,0,'','','{}',?1,?1)",
                rusqlite::params![now_iso()],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        seed_session(&db, "myagent", "sess-1", "自定义来源会话");
        let t = save_target(&db, &agent_input("myagent", "sess-1", "")).unwrap();
        link_task(&db, "t1", &t.id, false, "default").unwrap();
        // 模拟 commands::agents::delete_source 的数据生命周期：
        // sessions/runs/instances 随来源删除（FK 约束），来源行删除，
        // 任务、关联、导航目标保留为历史引用
        db.with_conn(|c| {
            c.execute("DELETE FROM agent_runs WHERE source_id = 'myagent'", [])?;
            c.execute("DELETE FROM agent_sessions WHERE source_id = 'myagent'", [])?;
            c.execute(
                "DELETE FROM agent_instances WHERE source_id = 'myagent'",
                [],
            )?;
            c.execute("DELETE FROM agent_sources WHERE id = 'myagent'", [])?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let tasks: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(tasks, 1, "删除来源不得删除用户任务");
        assert_eq!(legacy_count(&db), 1, "关联记录保留为历史");
        // 导航目标仍在，但会话已不存在 → 关联如实显示失效
        let state = task_targets(&db, "t1").unwrap();
        assert_eq!(state.len(), 1);
        assert_eq!(
            state[0].running_state, "unavailable",
            "会话消失后必须显示失效"
        );
    }

    #[test]
    fn agent_session_link_marks_unavailable_after_session_gone() {
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
        seed_session(&db, "codex", "sess-1", "联调会话");
        let t = save_target(&db, &agent_input("codex", "sess-1", "")).unwrap();
        link_task(&db, "t1", &t.id, false, "default").unwrap();
        assert_eq!(task_targets(&db, "t1").unwrap()[0].running_state, "agent");
        // 宿主清理会话后：关联必须如实变为失效
        db.with_conn(|c| {
            c.execute("DELETE FROM agent_sessions", [])?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        assert_eq!(
            task_targets(&db, "t1").unwrap()[0].running_state,
            "unavailable",
            "会话消失后不得继续显示为可用"
        );
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
