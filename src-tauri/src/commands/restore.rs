//! 恢复原子性状态机（P0-02）。
//!
//! 目标：一次恢复要么完整生效，要么数据库与磁盘文件都回到恢复前状态。
//! 关键设计：
//! - **恢复点**：正式改动前写一份完整分块备份（含当前剪贴板资产与事件归档），
//!   路径记录在恢复日志中，回滚直接复用它；
//! - **提交标记**：数据库替换与 `restore_commit_id` 标记在同一个 SQLite 事务里
//!   写入。进程在任意时刻死亡，启动时都能用标记判断数据库是否已提交；
//! - **文件先留底**：资产/归档逐个提交前，把会被覆盖的原文件复制到会话 vault；
//!   回滚时按计划逆序还原，提交过程中新建的文件则删除；
//! - **日志状态机**：
//!   `preparing → validated → ready_to_commit → committing → completed`；
//!   失败回滚：`rollback_required → rolling_back → rolled_back`；
//!   回滚本身失败：`failed_unrecovered`（保留 pre-backup、vault 与日志作为证据，
//!   启动时继续尝试回滚）；
//! - **幂等续跑**：文件提交可重复执行——已移动的暂存文件按目标 SHA-256 校验，
//!   未移动的继续提交，因此“数据库已提交、归档提交失败/进程死亡”都能收敛；
//! - **旧备份兼容**：不含扩展模块的旧 bundle/JSON 恢复时保留库内剪贴板、
//!   工作现场与行动中心数据（由 `data::import_value_with` 负责）。

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::agents::now_iso;
use crate::commands::backup::{
    self, BackupKind, BackupSources, ReadBackup, StagedArchive, StagedAsset,
};
use crate::commands::data::{self, ImportOptions};
use crate::db::Db;
use crate::error::{AppError, AppResult};

const JOURNAL_VERSION: i64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreState {
    Preparing,
    Validated,
    ReadyToCommit,
    Committing,
    Completed,
    RollbackRequired,
    RollingBack,
    RolledBack,
    FailedUnrecovered,
    /// 数据库尚未改动就中止（校验失败、用户拒绝部分备份等）。
    Aborted,
}

impl RestoreState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Validated => "validated",
            Self::ReadyToCommit => "ready_to_commit",
            Self::Committing => "committing",
            Self::Completed => "completed",
            Self::RollbackRequired => "rollback_required",
            Self::RollingBack => "rolling_back",
            Self::RolledBack => "rolled_back",
            Self::FailedUnrecovered => "failed_unrecovered",
            Self::Aborted => "aborted",
        }
    }
}

/// 一条待提交的磁盘文件（剪贴板资产或事件归档）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedFile {
    /// asset | archive
    pub kind: String,
    /// 资产为 `images/xxx.png`，归档为文件名
    pub rel: String,
    pub staged: String,
    pub dest: String,
    pub vault: String,
    pub existed: bool,
    pub size: u64,
    /// 恢复包内文件的 SHA-256（提交后目标必须与之一致）
    pub sha256: String,
    /// 恢复前原文件的 SHA-256（回滚后校验用；原文件不存在时为 None）
    #[serde(default)]
    pub vault_sha256: Option<String>,
    #[serde(default)]
    pub vault_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreJournal {
    pub version: i64,
    pub session_id: String,
    pub state: RestoreState,
    pub phase: String,
    pub source: String,
    /// bundle | legacy-json
    pub source_kind: String,
    pub backup_kind: String,
    pub partial: bool,
    pub created_at: String,
    pub updated_at: String,
    pub pre_backup: Option<String>,
    #[serde(default)]
    pub plan: Vec<PlannedFile>,
    pub error: Option<String>,
    /// 本次备份携带的用户配置（快捷键/语言/微件）；旧备份/旧日志为 None。
    #[serde(default)]
    pub config: Option<crate::user_preferences::BundleConfig>,
    /// 配置是否已应用。崩溃续跑时据此避免重复应用；应用本身是幂等的。
    #[serde(default)]
    pub config_applied: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RestoreConfigSummary {
    pub included: bool,
    pub locale: Option<String>,
    pub widgets: usize,
    pub hotkeys_applied: usize,
    pub hotkeys_disabled: usize,
    pub hotkeys_pending: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreOutcome {
    pub session_id: String,
    pub state: RestoreState,
    pub source_kind: String,
    pub backup_kind: String,
    pub partial: bool,
    pub assets: usize,
    pub archives: usize,
    pub pre_backup: Option<String>,
    /// 旧备份不携带扩展模块时为 true（库内剪贴板/工作现场/行动中心数据被保留）。
    pub extended_preserved: bool,
    pub recovered: bool,
    pub message: String,
    /// 本次恢复携带的用户配置摘要；None = 备份不含配置（本机配置保持不变）。
    pub config: Option<RestoreConfigSummary>,
    /// 配置归一化/快捷键注册/偏好写入等非致命问题，供 UI 逐条展示。
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecoveryOutcome {
    pub session_id: String,
    pub state: RestoreState,
    pub action: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IoFault {
    PermissionDenied,
    StorageFull,
    FileLocked,
}

impl IoFault {
    fn label(self) -> &'static str {
        match self {
            Self::PermissionDenied => "权限不足",
            Self::StorageFull => "磁盘空间不足",
            Self::FileLocked => "文件被其他进程占用",
        }
    }
}

/// 故障注入：只用于自动化验收，正常运行全部为默认 false/None。
#[derive(Debug, Clone, Default)]
pub struct RestoreFaults {
    pub fail_pre_backup: bool,
    pub fail_before_db_commit: bool,
    pub fail_after_db_commit: bool,
    /// 第 N 个剪贴板资产提交时注入 IO 错误（0 起）
    pub fail_asset_at: Option<usize>,
    /// 第 N 个归档提交时注入 IO 错误（0 起）
    pub fail_archive_at: Option<usize>,
    pub io_error: Option<IoFault>,
    /// 数据库提交后模拟进程死亡：不写后续状态、不回滚
    pub crash_after_db_commit: bool,
    /// 第 N 个磁盘文件提交后模拟进程死亡（全局序号，0 起）
    pub crash_after_file: Option<usize>,
    /// 恢复完成但提交标记清理失败（模拟首次启动前的崩溃）
    pub fail_marker_clear: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RestoreOptions {
    /// 快速/部分备份必须由用户显式确认后才允许恢复
    pub allow_partial: bool,
    pub faults: RestoreFaults,
}

fn restore_root(data_dir: &Path) -> PathBuf {
    data_dir.join("restore")
}

fn sessions_dir(data_dir: &Path) -> PathBuf {
    restore_root(data_dir).join("sessions")
}

fn journal_path(data_dir: &Path) -> PathBuf {
    restore_root(data_dir).join("journal.json")
}

fn session_dir(data_dir: &Path, session_id: &str) -> PathBuf {
    sessions_dir(data_dir).join(session_id)
}

fn read_journal(data_dir: &Path) -> AppResult<Option<RestoreJournal>> {
    let path = journal_path(data_dir);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    let journal: RestoreJournal = serde_json::from_str(&raw)
        .map_err(|e| AppError::Validation(format!("恢复日志损坏，无法判断上次恢复状态: {}", e)))?;
    if journal.version != JOURNAL_VERSION {
        return Err(AppError::Validation(format!(
            "不支持的恢复日志版本: {}",
            journal.version
        )));
    }
    Ok(Some(journal))
}

fn write_journal(data_dir: &Path, journal: &mut RestoreJournal) -> AppResult<()> {
    journal.updated_at = now_iso();
    let path = journal_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_file_name(format!(
        ".journal-{}.tmp",
        &uuid::Uuid::new_v4().to_string()[..8]
    ));
    let bytes = serde_json::to_vec_pretty(journal)?;
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

fn remove_journal(data_dir: &Path) {
    let _ = std::fs::remove_file(journal_path(data_dir));
    let _ = std::fs::remove_dir(sessions_dir(data_dir));
    let _ = std::fs::remove_dir(restore_root(data_dir));
}

fn cleanup_session(data_dir: &Path, session_id: &str) {
    let _ = std::fs::remove_dir_all(session_dir(data_dir, session_id));
}

fn read_marker(db: &Db) -> AppResult<Option<String>> {
    let Some(raw) = db.get_setting_raw(backup::RESTORE_COMMIT_KEY)? else {
        return Ok(None);
    };
    let value = serde_json::from_str::<serde_json::Value>(&raw)
        .unwrap_or(serde_json::Value::String(raw.clone()));
    Ok(value
        .as_str()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty()))
}

pub(crate) fn clear_marker(db: &Db) -> AppResult<()> {
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM application_settings WHERE key = ?1",
            rusqlite::params![backup::RESTORE_COMMIT_KEY],
        )?;
        Ok(())
    })
}

fn simulated_crash() -> AppError {
    AppError::Agent("模拟进程中断：恢复日志与提交标记已保留，重启后自动续跑".into())
}

fn abort(
    data_dir: &Path,
    mut journal: RestoreJournal,
    cause: AppError,
) -> AppResult<RestoreOutcome> {
    journal.state = RestoreState::Aborted;
    journal.phase = "aborted".into();
    journal.error = Some(cause.to_string());
    let _ = write_journal(data_dir, &mut journal);
    cleanup_session(data_dir, &journal.session_id);
    remove_journal(data_dir);
    Err(cause)
}

fn file_matches(path: &Path, size: u64, sha256: &str) -> AppResult<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let (actual_size, actual_sha) = backup::sha256_file(path)?;
    Ok(actual_size == size && actual_sha.eq_ignore_ascii_case(sha256))
}

fn commit_planned(file: &PlannedFile) -> AppResult<()> {
    let staged = Path::new(&file.staged);
    let dest = Path::new(&file.dest);
    if !staged.exists() {
        // 已经提交过（崩溃续跑）：目标必须与恢复包内容一致
        if file_matches(dest, file.size, &file.sha256)? {
            return Ok(());
        }
        return Err(AppError::Validation(format!(
            "暂存文件缺失且目标校验失败: {}",
            file.rel
        )));
    }
    let (size, sha) = backup::sha256_file(staged)?;
    if size != file.size || !sha.eq_ignore_ascii_case(&file.sha256) {
        return Err(AppError::Validation(format!(
            "暂存文件校验失败（大小或 SHA-256 不一致）: {}",
            file.rel
        )));
    }
    if file.kind == "asset" {
        backup::safe_asset_rel(&file.rel)?;
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    backup::commit_file(staged, dest)
}

fn complete_planned_files(journal: &RestoreJournal) -> AppResult<()> {
    for file in &journal.plan {
        commit_planned(file)?;
    }
    Ok(())
}

fn rollback_file(file: &PlannedFile) -> AppResult<()> {
    let dest = Path::new(&file.dest);
    if file.existed {
        let vault = Path::new(&file.vault);
        if !vault.exists() {
            return Err(AppError::Validation(format!(
                "恢复前副本缺失，无法还原: {}",
                file.rel
            )));
        }
        backup::preserve_file(vault, dest)?;
        if let Some(expect) = file.vault_sha256.as_deref() {
            let size = file.vault_size.unwrap_or(file.size);
            if !file_matches(dest, size, expect)? {
                return Err(AppError::Validation(format!(
                    "还原后校验失败: {}",
                    file.rel
                )));
            }
        }
    } else if dest.exists() {
        std::fs::remove_file(dest)?;
    }
    Ok(())
}

fn build_plan(
    read: &ReadBackup,
    clipboard_dir: &Path,
    shelf_dir: &Path,
    voice_pack_dir: &Path,
    archive_dir: &Path,
    vault_root: &Path,
) -> AppResult<Vec<PlannedFile>> {
    let mut plan = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for asset in &read.assets {
        let rel = asset.rel.clone();
        backup::safe_asset_rel(&rel)?;
        // 暂存架托管文件带 `shelf/` 前缀，落盘时剥离为相对 shelf 根目录的路径
        if let Some(sub) = rel.strip_prefix("shelf/") {
            let sub = backup::safe_shelf_rel(sub)?;
            push_planned(
                &mut plan,
                &mut seen,
                "asset",
                &rel,
                asset,
                shelf_dir.join(sub),
                vault_root.join("assets").join(&rel),
            )?;
        } else if let Some(filename) = rel.strip_prefix("voice/") {
            crate::audio::voice_packs::ensure_root(voice_pack_dir)?;
            push_planned(
                &mut plan,
                &mut seen,
                "asset",
                &rel,
                asset,
                voice_pack_dir.join(filename),
                vault_root.join("assets").join(&rel),
            )?;
        } else {
            push_planned(
                &mut plan,
                &mut seen,
                "asset",
                &rel,
                asset,
                clipboard_dir.join(&rel),
                vault_root.join("assets").join(&rel),
            )?;
        }
    }
    for archive in &read.archives {
        let name = archive.name.clone();
        push_planned(
            &mut plan,
            &mut seen,
            "archive",
            &name,
            archive,
            archive_dir.join(&name),
            vault_root.join("archives").join(&name),
        )?;
    }
    Ok(plan)
}

fn push_planned(
    plan: &mut Vec<PlannedFile>,
    seen: &mut HashSet<String>,
    kind: &str,
    rel: &str,
    staged: &dyn StagedAssetLike,
    dest: PathBuf,
    vault: PathBuf,
) -> AppResult<()> {
    let key = format!("{}/{}", kind, rel);
    if !seen.insert(key) {
        return Err(AppError::Validation(format!(
            "恢复计划存在重复目标文件: {}",
            rel
        )));
    }
    let existed = dest.exists();
    let mut vault_sha256 = None;
    let mut vault_size = None;
    if existed {
        let (size, sha) = backup::sha256_file(&dest)?;
        vault_sha256 = Some(sha);
        vault_size = Some(size);
        backup::preserve_file(&dest, &vault)?;
    }
    plan.push(PlannedFile {
        kind: kind.to_string(),
        rel: rel.to_string(),
        staged: staged.staged_path().to_string_lossy().to_string(),
        dest: dest.to_string_lossy().to_string(),
        vault: vault.to_string_lossy().to_string(),
        existed,
        size: staged.staged_size(),
        sha256: staged.staged_sha().to_string(),
        vault_sha256,
        vault_size,
    });
    Ok(())
}

/// 让 `StagedAsset` / `StagedArchive` 共用建计划逻辑。
trait StagedAssetLike {
    fn staged_path(&self) -> &Path;
    fn staged_size(&self) -> u64;
    fn staged_sha(&self) -> &str;
}

impl StagedAssetLike for StagedAsset {
    fn staged_path(&self) -> &Path {
        &self.path
    }
    fn staged_size(&self) -> u64 {
        self.size
    }
    fn staged_sha(&self) -> &str {
        &self.sha256
    }
}

impl StagedAssetLike for StagedArchive {
    fn staged_path(&self) -> &Path {
        &self.path
    }
    fn staged_size(&self) -> u64 {
        self.size
    }
    fn staged_sha(&self) -> &str {
        &self.sha256
    }
}

fn rollback_db(db: &Db, pre_backup: &Path, rows_dir: &Path) -> AppResult<()> {
    // 只解析/校验，不落盘资产与归档：回滚数据库不需要第二份文件副本。
    // 表行写入会话内的临时目录（随会话清理删除），内存占用与行数解耦。
    let read = backup::read_bundle_data_only(pre_backup, rows_dir)?;
    let parsed = data::validate_bundle(db, &read.data, &read.rows_dir)?;
    data::import_parsed_with(
        db,
        parsed,
        &ImportOptions {
            allow_extended: true,
            commit_marker: None,
        },
    )?;
    clear_marker(db)
}

/// 回滚到恢复前状态。成功返回 Ok（日志置为 `rolled_back`），失败置为
/// `failed_unrecovered` 并保留 pre-backup、vault 与日志供重启重试。
fn do_rollback(
    data_dir: &Path,
    db: &Db,
    journal: &mut RestoreJournal,
    cause: &str,
) -> AppResult<()> {
    journal.state = RestoreState::RollbackRequired;
    journal.phase = "rollback_required".into();
    journal.error = Some(cause.to_string());
    write_journal(data_dir, journal).map_err(|e| {
        AppError::Agent(format!(
            "{}；无法写入回滚日志（{}），重启后将尝试完成恢复提交",
            cause, e
        ))
    })?;
    journal.state = RestoreState::RollingBack;
    journal.phase = "rollback_db".into();
    let _ = write_journal(data_dir, journal);

    let mut errors: Vec<String> = Vec::new();
    match journal.pre_backup.as_deref() {
        Some(pre) => {
            let rows_dir = session_dir(data_dir, &journal.session_id).join("rollback-rows");
            if let Err(e) = rollback_db(db, Path::new(pre), &rows_dir) {
                errors.push(format!("恢复数据库失败: {}", e));
            }
        }
        None => errors.push("缺少恢复前完整备份，无法回滚数据库".into()),
    }

    journal.phase = "rollback_files".into();
    let _ = write_journal(data_dir, journal);
    for file in journal.plan.iter().rev() {
        if let Err(e) = rollback_file(file) {
            errors.push(format!("还原 {} 失败: {}", file.rel, e));
        }
    }
    if let Err(e) = clear_marker(db) {
        errors.push(format!("清理恢复标记失败: {}", e));
    }

    if errors.is_empty() {
        journal.state = RestoreState::RolledBack;
        journal.phase = "rollback_done".into();
        journal.error = Some(cause.to_string());
        let _ = write_journal(data_dir, journal);
        cleanup_session(data_dir, &journal.session_id);
        Ok(())
    } else {
        journal.state = RestoreState::FailedUnrecovered;
        journal.phase = "rollback_failed".into();
        let detail = format!("{}；{}", cause, errors.join("；"));
        journal.error = Some(detail.clone());
        let _ = write_journal(data_dir, journal);
        Err(AppError::Agent(format!(
            "恢复失败且自动回滚未完成：{}。恢复前完整备份与回滚副本已保留（{}），请重启应用重试回滚。",
            detail,
            journal
                .pre_backup
                .clone()
                .unwrap_or_else(|| "未生成".into())
        )))
    }
}

fn pre_backup_path(data_dir: &Path, session_id: &str) -> PathBuf {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    data_dir.join("backups").join(format!(
        "restore-pre-{}-{}.json",
        stamp,
        &session_id[..8.min(session_id.len())]
    ))
}

fn write_pre_backup(
    data_dir: &Path,
    db: &Db,
    session_id: &str,
    faults: &RestoreFaults,
) -> AppResult<PathBuf> {
    if faults.fail_pre_backup {
        return Err(AppError::Agent(
            "模拟故障：恢复前完整备份写入失败（已中止，原数据未改动）".into(),
        ));
    }
    let path = pre_backup_path(data_dir, session_id);
    let archive = crate::agents::retention::archive_dir(data_dir);
    let clipboard = data_dir.join("clipboard");
    let shelf = data_dir.join("shelf");
    let sources = BackupSources {
        archive_dir: Some(archive.as_path()),
        clipboard_dir: Some(clipboard.as_path()),
        shelf_dir: Some(shelf.as_path()),
        // 恢复点也包含当前用户配置：配置恢复失败/回滚时可用它找回原快捷键/偏好。
        data_dir: Some(data_dir),
    };
    backup::write_bundle_without_voice_gate(db, sources, &path, BackupKind::Full)?;
    Ok(path)
}

fn cleanup_after_success(data_dir: &Path, journal: &RestoreJournal) {
    cleanup_session(data_dir, &journal.session_id);
    remove_journal(data_dir);
}

/// 应用备份中的用户配置（语言/微件/快捷键）。
///
/// 调用时机：数据库与资产/归档全部提交成功之后。配置属于次要数据：
/// - 偏好文件写入失败 → 只产生警告，不回滚数据库，也不会清空本机原配置；
/// - 快捷键无法重新注册 → 降级默认或禁用并写 warning，原配置另存为待解决项；
/// - 该函数永不返回 Err，避免把「配置失败」伪装成数据恢复失败或反之。
fn apply_restored_config(
    data_dir: &Path,
    config: &crate::user_preferences::BundleConfig,
    restore_id: &str,
) -> (Vec<String>, RestoreConfigSummary) {
    let mut warnings = Vec::new();
    let mut summary = RestoreConfigSummary {
        included: true,
        locale: None,
        widgets: 0,
        hotkeys_applied: 0,
        hotkeys_disabled: 0,
        hotkeys_pending: false,
    };

    if config.locale.is_some() || config.widgets.is_some() || config.app_grid_order.is_some() {
        // 旧备份可能只带部分字段：缺省字段保留本机值，避免恢复语言/微件时
        // 把已有的应用网格排序（或反之）从 preferences.json 里整段抹掉。
        let existing = crate::user_preferences::load_preferences(data_dir);
        let next_locale = config.locale.clone().or(existing.locale);
        let next_widgets = config.widgets.clone().or(existing.widgets);
        let next_order = config.app_grid_order.clone().or(existing.app_grid_order);
        match crate::user_preferences::write_preferences(
            data_dir,
            next_locale.as_deref(),
            next_widgets.as_deref(),
            next_order.as_deref(),
        ) {
            Ok(()) => {
                summary.locale = config.locale.clone();
                summary.widgets = config.widgets.as_ref().map(|w| w.len()).unwrap_or(0);
                // 让前端在下一次启动/收到事件时以文件为准覆盖旧 localStorage，
                // 否则「localStorage 优先」的对账规则会把刚恢复的偏好顶掉。
                if let Err(error) =
                    crate::user_preferences::mark_restore_pending(data_dir, restore_id)
                {
                    warnings.push(format!(
                        "用户偏好已写入，但恢复标记保存失败（{error}）；重启后可能仍显示本机旧偏好"
                    ));
                }
            }
            Err(error) => warnings.push(format!(
                "用户偏好写入失败（{error}），语言与微件保持本机当前设置"
            )),
        }
    }

    if let Some(hotkeys) = config.hotkeys.as_ref() {
        let report = crate::hotkeys::restore_from_bundle(data_dir, hotkeys);
        summary.hotkeys_applied = report.applied;
        summary.hotkeys_disabled = report.disabled;
        summary.hotkeys_pending = report.pending_saved;
        warnings.extend(report.warnings);
    }

    (warnings, summary)
}

/// 恢复流程与崩溃续跑的统一切入点：每个恢复会话只应用一次配置。
/// 应用后立即写日志；日志写失败只会导致下次启动重复应用（幂等），不会丢数据。
fn apply_config_if_needed(
    data_dir: &Path,
    journal: &mut RestoreJournal,
) -> (Vec<String>, Option<RestoreConfigSummary>) {
    if journal.config_applied {
        return (Vec::new(), None);
    }
    let Some(config) = journal.config.clone() else {
        journal.config_applied = true;
        if let Err(error) = write_journal(data_dir, journal) {
            tracing::warn!("写入恢复日志（无配置）失败: {}", error);
        }
        return (Vec::new(), None);
    };
    let (warnings, summary) = apply_restored_config(data_dir, &config, &journal.session_id);
    journal.config_applied = true;
    if let Err(error) = write_journal(data_dir, journal) {
        tracing::warn!("写入恢复日志（配置已应用）失败: {}", error);
    }
    (warnings, Some(summary))
}

fn success_outcome(
    journal: &RestoreJournal,
    assets: usize,
    archives: usize,
    extended_preserved: bool,
    recovered: bool,
    config: Option<RestoreConfigSummary>,
    warnings: Vec<String>,
) -> RestoreOutcome {
    RestoreOutcome {
        session_id: journal.session_id.clone(),
        state: journal.state,
        source_kind: journal.source_kind.clone(),
        backup_kind: journal.backup_kind.clone(),
        partial: journal.partial,
        assets,
        archives,
        pre_backup: journal.pre_backup.clone(),
        extended_preserved,
        recovered,
        message: if recovered {
            "上次中断的恢复已自动续跑完成".into()
        } else {
            "恢复完成".into()
        },
        config,
        warnings,
    }
}

/// 恢复分块备份（含资产/归档的原子提交）。
pub fn restore_bundle(
    data_dir: &Path,
    db: &Db,
    source: &Path,
    options: &RestoreOptions,
) -> AppResult<RestoreOutcome> {
    let _asset_gate = crate::audio::voice_packs::asset_gate_write();
    if let Some(previous) = recover_pending_inner(data_dir, db)? {
        if previous.state == RestoreState::FailedUnrecovered {
            return Err(AppError::Conflict(
                "上一次恢复尚未回滚完成，请先处理恢复日志后重试".into(),
            ));
        }
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let session = session_dir(data_dir, &session_id);
    let staging = session.join("staging");
    let vault_root = session.join("vault");
    std::fs::create_dir_all(&staging)?;
    std::fs::create_dir_all(&vault_root)?;

    let mut journal = RestoreJournal {
        version: JOURNAL_VERSION,
        session_id: session_id.clone(),
        state: RestoreState::Preparing,
        phase: "staging".into(),
        source: source.to_string_lossy().to_string(),
        source_kind: "bundle".into(),
        backup_kind: "unknown".into(),
        partial: true,
        created_at: now_iso(),
        updated_at: now_iso(),
        pre_backup: None,
        plan: Vec::new(),
        error: None,
        config: None,
        config_applied: false,
    };
    write_journal(data_dir, &mut journal)?;

    let t0 = std::time::Instant::now();
    // 1. 读取并做完整性/结构校验（资产、归档与表行写入会话暂存目录）。
    let read = match backup::read_bundle(source, &staging) {
        Ok(read) => read,
        Err(e) => return abort(data_dir, journal, e),
    };
    tracing::info!(
        phase = "read_bundle",
        ms = t0.elapsed().as_millis(),
        "恢复阶段完成"
    );
    if read.partial && !options.allow_partial {
        return abort(
            data_dir,
            journal,
            AppError::Validation(
                "该备份是快速/部分备份：事件、通知、导航流水与剪贴板历史按上限截断，且不含事件归档。\
                 确认要恢复部分数据后，请显式勾选确认再重试。"
                    .into(),
            ),
        );
    }
    // 预检直接读暂存的行文件：事件表全程不整体进内存。
    let parsed = match data::validate_bundle(db, &read.data, &read.rows_dir) {
        Ok(parsed) => parsed,
        Err(e) => return abort(data_dir, journal, e),
    };
    tracing::info!(
        phase = "validate_bundle",
        ms = t0.elapsed().as_millis(),
        "恢复阶段完成"
    );
    journal.backup_kind = read.kind.clone();
    journal.partial = read.partial;
    // 用户配置随日志持久化：崩溃续跑时无需重新读取备份，也能继续应用。
    journal.config = read.config.clone();
    journal.phase = "validated".into();
    journal.state = RestoreState::Validated;
    if let Err(e) = write_journal(data_dir, &mut journal) {
        return abort(data_dir, journal, e);
    }

    // 2. 恢复点：完整备份当前库 + 当前资产/归档。
    let pre = match write_pre_backup(data_dir, db, &session_id, &options.faults) {
        Ok(path) => path,
        Err(e) => return abort(data_dir, journal, e),
    };
    tracing::info!(
        phase = "pre_backup",
        ms = t0.elapsed().as_millis(),
        "恢复阶段完成"
    );
    journal.pre_backup = Some(pre.to_string_lossy().to_string());

    // 3. 计划 + 原文件留底。
    let clipboard_dir = data_dir.join("clipboard");
    let shelf_dir = data_dir.join("shelf");
    let voice_pack_dir = data_dir.join("audio").join("voice-packs");
    let archive_dir = crate::agents::retention::archive_dir(data_dir);
    let plan = match build_plan(
        &read,
        &clipboard_dir,
        &shelf_dir,
        &voice_pack_dir,
        &archive_dir,
        &vault_root,
    ) {
        Ok(plan) => plan,
        Err(e) => return abort(data_dir, journal, e),
    };
    journal.plan = plan;
    journal.phase = "ready".into();
    journal.state = RestoreState::ReadyToCommit;
    if let Err(e) = write_journal(data_dir, &mut journal) {
        return abort(data_dir, journal, e);
    }

    if options.faults.fail_before_db_commit {
        return abort(
            data_dir,
            journal,
            AppError::Agent("模拟故障：SQLite 导入前中止（原数据未改动）".into()),
        );
    }

    // 4. 数据库替换：标记与数据同事务提交。
    journal.state = RestoreState::Committing;
    journal.phase = "db".into();
    if let Err(e) = write_journal(data_dir, &mut journal) {
        return abort(data_dir, journal, e);
    }
    let import = data::import_parsed_with(
        db,
        parsed,
        &ImportOptions {
            allow_extended: true,
            commit_marker: Some(session_id.clone()),
        },
    );
    if let Err(e) = import {
        // 单事务失败，数据库未改动；文件尚未提交。
        return abort(data_dir, journal, e);
    }
    tracing::info!(
        phase = "import",
        ms = t0.elapsed().as_millis(),
        "恢复阶段完成"
    );
    journal.phase = "db_committed".into();
    let _ = write_journal(data_dir, &mut journal);
    if options.faults.crash_after_db_commit {
        return Err(simulated_crash());
    }
    if options.faults.fail_after_db_commit {
        let cause = AppError::Agent("模拟故障：数据库已提交，磁盘文件提交前失败".into());
        return rollback_outcome(data_dir, db, journal, &cause);
    }

    // 5. 文件提交（逐个原子替换；每步都可幂等重跑）。
    journal.phase = "files".into();
    let _ = write_journal(data_dir, &mut journal);
    let mut file_index = 0usize;
    for (index, asset) in read.assets.iter().enumerate() {
        let planned = &journal.plan[index];
        debug_assert_eq!(planned.rel, asset.rel);
        if options.faults.fail_asset_at == Some(index) {
            let cause = match options.faults.io_error {
                Some(kind) => AppError::Agent(format!(
                    "模拟故障：剪贴板资产提交时{}（{}）",
                    kind.label(),
                    asset.rel
                )),
                None => AppError::Agent(format!("模拟故障：第 {} 个剪贴板资产提交失败", index)),
            };
            return rollback_outcome(data_dir, db, journal, &cause);
        }
        if let Err(e) = commit_planned(planned) {
            return rollback_outcome(data_dir, db, journal, &e);
        }
        if options.faults.crash_after_file == Some(file_index) {
            return Err(simulated_crash());
        }
        file_index += 1;
    }
    let archive_offset = journal.plan.len() - read.archives.len();
    for (index, archive) in read.archives.iter().enumerate() {
        let planned = &journal.plan[archive_offset + index];
        debug_assert_eq!(planned.rel, archive.name);
        if options.faults.fail_archive_at == Some(index) {
            let cause = match options.faults.io_error {
                Some(kind) => AppError::Agent(format!(
                    "模拟故障：事件归档提交时{}（{}）",
                    kind.label(),
                    archive.name
                )),
                None => AppError::Agent(format!("模拟故障：第 {} 个事件归档提交失败", index)),
            };
            return rollback_outcome(data_dir, db, journal, &cause);
        }
        if let Err(e) = commit_planned(planned) {
            return rollback_outcome(data_dir, db, journal, &e);
        }
        if options.faults.crash_after_file == Some(file_index) {
            return Err(simulated_crash());
        }
        file_index += 1;
    }

    // 6. 用户配置在数据与文件全部提交后应用：配置失败只产生 warning，
    //    不回滚已成功恢复的任务数据（回滚点里也包含恢复前配置，可按需找回）。
    journal.phase = "files_committed".into();
    let _ = write_journal(data_dir, &mut journal);
    let mut warnings = read.warnings.clone();
    let (config_warnings, config_summary) = apply_config_if_needed(data_dir, &mut journal);
    warnings.extend(config_warnings);

    // 7. 先落盘完成状态，再清理提交标记：任一时刻崩溃都能判断“数据库已提交”。
    journal.state = RestoreState::Completed;
    journal.phase = "marker_pending".into();
    if let Err(e) = write_journal(data_dir, &mut journal) {
        return Err(AppError::Agent(format!(
            "恢复已完成，但完成状态写入失败（{}）；重启后将自动收尾",
            e
        )));
    }
    if options.faults.fail_marker_clear {
        return Err(AppError::Agent(
            "模拟故障：恢复已完成但提交标记清理失败（重启后自动收尾）".into(),
        ));
    }
    if let Err(e) = clear_marker(db) {
        return Err(AppError::Agent(format!(
            "恢复已完成，但提交标记清理失败（{}）；重启后将自动收尾",
            e
        )));
    }
    if let Err(error) = crate::audio::voice_packs::cleanup_orphaned_files(
        db,
        &data_dir.join("audio").join("voice-packs"),
    ) {
        tracing::warn!("恢复后清理未引用语音资源失败: {}", error);
    }
    journal.phase = "done".into();
    let _ = write_journal(data_dir, &mut journal);
    cleanup_after_success(data_dir, &journal);
    Ok(success_outcome(
        &journal,
        read.assets.len(),
        read.archives.len(),
        !read.extended,
        false,
        config_summary,
        warnings,
    ))
}

fn rollback_outcome(
    data_dir: &Path,
    db: &Db,
    mut journal: RestoreJournal,
    cause: &AppError,
) -> AppResult<RestoreOutcome> {
    let message = cause.to_string();
    match do_rollback(data_dir, db, &mut journal, &message) {
        Ok(()) => Err(AppError::Agent(format!(
            "{}（已自动回滚到恢复前状态，原数据库与磁盘文件均未改变；恢复点：{}）",
            message,
            journal
                .pre_backup
                .clone()
                .unwrap_or_else(|| "未生成".into())
        ))),
        Err(e) => Err(e),
    }
}

/// 旧版 JSON 导出文件恢复：无磁盘资产，但同样生成完整恢复点并写入提交标记。
pub fn restore_legacy_json(
    data_dir: &Path,
    db: &Db,
    source: &Path,
    data: &serde_json::Value,
) -> AppResult<RestoreOutcome> {
    let _asset_gate = crate::audio::voice_packs::asset_gate_write();
    if let Some(previous) = recover_pending_inner(data_dir, db)? {
        if previous.state == RestoreState::FailedUnrecovered {
            return Err(AppError::Conflict(
                "上一次恢复尚未回滚完成，请先处理恢复日志后重试".into(),
            ));
        }
    }
    let session_id = uuid::Uuid::new_v4().to_string();
    std::fs::create_dir_all(session_dir(data_dir, &session_id))?;
    let mut journal = RestoreJournal {
        version: JOURNAL_VERSION,
        session_id: session_id.clone(),
        state: RestoreState::Preparing,
        phase: "validate".into(),
        source: source.to_string_lossy().to_string(),
        source_kind: "legacy-json".into(),
        backup_kind: "legacy-json".into(),
        partial: false,
        created_at: now_iso(),
        updated_at: now_iso(),
        pre_backup: None,
        plan: Vec::new(),
        error: None,
        config: None,
        config_applied: false,
    };
    write_journal(data_dir, &mut journal)?;
    let parsed = match data::validate_import(db, data) {
        Ok(parsed) => parsed,
        Err(e) => return abort(data_dir, journal, e),
    };
    journal.state = RestoreState::Validated;
    journal.phase = "validated".into();
    if let Err(e) = write_journal(data_dir, &mut journal) {
        return abort(data_dir, journal, e);
    }
    let pre = match write_pre_backup(data_dir, db, &session_id, &RestoreFaults::default()) {
        Ok(path) => path,
        Err(e) => return abort(data_dir, journal, e),
    };
    journal.pre_backup = Some(pre.to_string_lossy().to_string());
    journal.state = RestoreState::ReadyToCommit;
    journal.phase = "ready".into();
    if let Err(e) = write_journal(data_dir, &mut journal) {
        return abort(data_dir, journal, e);
    }

    journal.state = RestoreState::Committing;
    journal.phase = "db".into();
    if let Err(e) = write_journal(data_dir, &mut journal) {
        return abort(data_dir, journal, e);
    }
    // 旧 JSON 不含扩展模块：allow_extended=false，库内剪贴板/工作现场/行动中心保留。
    let import = data::import_parsed_with(
        db,
        parsed,
        &ImportOptions {
            allow_extended: false,
            commit_marker: Some(session_id.clone()),
        },
    );
    if let Err(e) = import {
        return abort(data_dir, journal, e);
    }
    journal.phase = "db_committed".into();
    let _ = write_journal(data_dir, &mut journal);

    journal.state = RestoreState::Completed;
    journal.phase = "marker_pending".into();
    if let Err(e) = write_journal(data_dir, &mut journal) {
        return Err(AppError::Agent(format!(
            "导入已完成，但完成状态写入失败（{}）；重启后将自动收尾",
            e
        )));
    }
    if let Err(e) = clear_marker(db) {
        return Err(AppError::Agent(format!(
            "导入已完成，但提交标记清理失败（{}）；重启后将自动收尾",
            e
        )));
    }
    journal.phase = "done".into();
    let _ = write_journal(data_dir, &mut journal);
    cleanup_after_success(data_dir, &journal);
    Ok(success_outcome(
        &journal,
        0,
        0,
        true,
        false,
        None,
        Vec::new(),
    ))
}

/// 启动时/恢复前调用：处理上次中断的恢复。
/// - 数据库已提交（标记匹配）→ 幂等续跑文件提交并收尾；
/// - 数据库未提交 → 丢弃暂存并清理；
/// - 处于回滚中 → 继续回滚（失败保留证据并返回错误）。
pub fn recover_pending(data_dir: &Path, db: &Db) -> AppResult<Option<RecoveryOutcome>> {
    let _asset_gate = crate::audio::voice_packs::asset_gate_write();
    recover_pending_inner(data_dir, db)
}

fn recover_pending_inner(data_dir: &Path, db: &Db) -> AppResult<Option<RecoveryOutcome>> {
    let Some(mut journal) = read_journal(data_dir)? else {
        if let Some(marker) = read_marker(db)? {
            clear_marker(db)?;
            return Ok(Some(RecoveryOutcome {
                session_id: marker,
                state: RestoreState::Completed,
                action: "orphan_marker_cleared".into(),
                message:
                    "数据库恢复已完成但恢复日志缺失，已清理提交标记；请检查剪贴板图片与归档完整性"
                        .into(),
            }));
        }
        return Ok(None);
    };
    let marker = read_marker(db)?;
    let marker_matches = marker.as_deref() == Some(journal.session_id.as_str());

    match journal.state {
        RestoreState::Aborted | RestoreState::RolledBack => {
            if marker_matches {
                clear_marker(db)?;
            }
            cleanup_session(data_dir, &journal.session_id);
            remove_journal(data_dir);
            Ok(Some(RecoveryOutcome {
                session_id: journal.session_id,
                state: journal.state,
                action: "cleaned".into(),
                message: "已清理上次中止/已回滚的恢复记录".into(),
            }))
        }
        RestoreState::Completed => {
            if marker_matches {
                if let Err(e) = complete_planned_files(&journal) {
                    let cause = AppError::Agent(format!("恢复完成收尾时文件校验失败: {}", e));
                    return rollback_recovery(data_dir, db, journal, &cause);
                }
                let (warnings, _) = apply_config_if_needed(data_dir, &mut journal);
                for warning in warnings {
                    tracing::warn!("恢复完成收尾时应用用户配置: {}", warning);
                }
                clear_marker(db)?;
            }
            if let Err(error) = crate::audio::voice_packs::cleanup_orphaned_files(
                db,
                &data_dir.join("audio").join("voice-packs"),
            ) {
                tracing::warn!("恢复收尾时清理未引用语音资源失败: {}", error);
            }
            cleanup_session(data_dir, &journal.session_id);
            remove_journal(data_dir);
            Ok(Some(RecoveryOutcome {
                session_id: journal.session_id,
                state: RestoreState::Completed,
                action: "completed_cleanup".into(),
                message: "上次恢复已完成，已清理恢复标记与临时文件".into(),
            }))
        }
        RestoreState::Preparing
        | RestoreState::Validated
        | RestoreState::ReadyToCommit
        | RestoreState::Committing => {
            if marker_matches {
                journal.state = RestoreState::Committing;
                journal.phase = "recovery_files".into();
                let _ = write_journal(data_dir, &mut journal);
                if let Err(e) = complete_planned_files(&journal) {
                    let cause = AppError::Agent(format!("恢复续跑失败: {}", e));
                    return rollback_recovery(data_dir, db, journal, &cause);
                }
                let (warnings, _) = apply_config_if_needed(data_dir, &mut journal);
                for warning in warnings {
                    tracing::warn!("恢复续跑时应用用户配置: {}", warning);
                }
                journal.state = RestoreState::Completed;
                journal.phase = "recovery_done".into();
                let _ = write_journal(data_dir, &mut journal);
                clear_marker(db)?;
                cleanup_session(data_dir, &journal.session_id);
                remove_journal(data_dir);
                Ok(Some(RecoveryOutcome {
                    session_id: journal.session_id,
                    state: RestoreState::Completed,
                    action: "forward_completed".into(),
                    message: "检测到数据库已提交的中断恢复，已续跑完成磁盘文件提交".into(),
                }))
            } else {
                // 数据库未提交（标记与数据同事务），文件提交尚未开始。
                journal.state = RestoreState::RolledBack;
                journal.phase = "no_db_commit".into();
                journal.error = Some("上次恢复在数据库提交前中断".into());
                let _ = write_journal(data_dir, &mut journal);
                cleanup_session(data_dir, &journal.session_id);
                remove_journal(data_dir);
                Ok(Some(RecoveryOutcome {
                    session_id: journal.session_id,
                    state: RestoreState::RolledBack,
                    action: "discarded_before_commit".into(),
                    message: "上次恢复未提交数据库，已丢弃暂存文件（原数据未改动）".into(),
                }))
            }
        }
        RestoreState::RollbackRequired
        | RestoreState::RollingBack
        | RestoreState::FailedUnrecovered => {
            let cause = journal
                .error
                .clone()
                .unwrap_or_else(|| "上次恢复中断，需要回滚".into());
            do_rollback(data_dir, db, &mut journal, &cause)?;
            cleanup_session(data_dir, &journal.session_id);
            remove_journal(data_dir);
            Ok(Some(RecoveryOutcome {
                session_id: journal.session_id,
                state: RestoreState::RolledBack,
                action: "rolled_back".into(),
                message: "上次中断的恢复已回滚到恢复前状态".into(),
            }))
        }
    }
}

fn rollback_recovery(
    data_dir: &Path,
    db: &Db,
    mut journal: RestoreJournal,
    cause: &AppError,
) -> AppResult<Option<RecoveryOutcome>> {
    let message = cause.to_string();
    do_rollback(data_dir, db, &mut journal, &message)?;
    cleanup_session(data_dir, &journal.session_id);
    remove_journal(data_dir);
    Ok(Some(RecoveryOutcome {
        session_id: journal.session_id,
        state: RestoreState::RolledBack,
        action: "rolled_back".into(),
        message: "续跑校验失败，已回滚到恢复前状态".into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::now_iso;
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};

    fn memdb() -> Db {
        Db::open_in_memory().unwrap()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("td-restore-{}-{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed_task(db: &Db, id: &str, title: &str) {
        let now = now_iso();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO tasks (id,title,description,priority,status,category,tags,advance_minutes,created_at,updated_at)
                 VALUES (?1,?2,'',2,'pending','','[]',0,?3,?3)",
                rusqlite::params![id, title, now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
    }

    fn task_title(db: &Db, id: &str) -> Option<String> {
        db.with_conn(|c| {
            Ok(
                c.query_row("SELECT title FROM tasks WHERE id = ?1", [id], |r| r.get(0))
                    .ok(),
            )
        })
        .unwrap()
    }

    fn marker(db: &Db) -> Option<String> {
        read_marker(db).unwrap()
    }

    struct BundleSource {
        bundle: PathBuf,
    }

    /// 构造带 2 个剪贴板资产、2 个归档的源库与完整备份。
    fn make_source_bundle(tag: &str, partial: bool) -> (Db, BundleSource) {
        let root = temp_dir(tag);
        let archive_dir = root.join("archive");
        let clipboard_dir = root.join("clipboard");
        std::fs::create_dir_all(archive_dir.join("nested")).unwrap();
        std::fs::create_dir_all(clipboard_dir.join("images")).unwrap();
        std::fs::create_dir_all(clipboard_dir.join("thumbs")).unwrap();
        std::fs::write(archive_dir.join("a1.jsonl"), b"{\"event\":1}\n").unwrap();
        std::fs::write(archive_dir.join("a2.jsonl"), b"{\"event\":2}\n").unwrap();
        std::fs::write(clipboard_dir.join("images/i1.png"), b"PNG-IMAGE-1").unwrap();
        std::fs::write(clipboard_dir.join("thumbs/i1.png"), b"PNG-THUMB-1").unwrap();
        // 去掉未使用的嵌套目录，保持归档目录只有两个文件
        let _ = std::fs::remove_dir_all(archive_dir.join("nested"));

        let db = memdb();
        seed_task(&db, "src-task", "来源任务");
        let now = now_iso();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO clipboard_items (id,kind,text,html,preview,content_hash,byte_size,source_app,source_title,image_width,image_height,file_paths,favorite,pinned,copy_count,created_at,last_seen_at)
                 VALUES ('ci1','image','','','预览','hash1',12,'','',10,10,'[]',0,0,1,?1,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO clipboard_assets (id,item_id,role,path,byte_size,width,height,created_at)
                 VALUES ('ca1','ci1','image','images/i1.png',11,10,10,?1)",
                rusqlite::params![now],
            )?;
            c.execute(
                "INSERT INTO clipboard_assets (id,item_id,role,path,byte_size,width,height,created_at)
                 VALUES ('ca2','ci1','thumb','thumbs/i1.png',11,10,10,?1)",
                rusqlite::params![now],
            )?;
            // 与来源任务关联，验证旧备份/回滚时的关联保护
            c.execute(
                "INSERT INTO clipboard_task_links (id,task_id,target_type,target_id,created_at)
                 VALUES ('ctl1','src-task','item','ci1',?1)",
                rusqlite::params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let bundle = root.join("src-bundle.json");
        let sources = BackupSources {
            archive_dir: Some(&archive_dir),
            clipboard_dir: Some(&clipboard_dir),
            shelf_dir: None,
            data_dir: None,
        };
        backup::write_bundle(
            &db,
            sources,
            &bundle,
            if partial {
                BackupKind::Quick
            } else {
                BackupKind::Full
            },
        )
        .unwrap();
        (db, BundleSource { bundle })
    }

    /// 目标库：一个原任务 + 一个原有剪贴板项，用于验证回滚/保留。
    fn make_target_db() -> Db {
        let db = memdb();
        seed_task(&db, "orig-task", "原任务");
        let now = now_iso();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO clipboard_items (id,kind,text,html,preview,content_hash,byte_size,source_app,source_title,image_width,image_height,file_paths,favorite,pinned,copy_count,created_at,last_seen_at)
                 VALUES ('keep-item','text','内容','','保留项','hash-keep',2,'','',NULL,NULL,'[]',0,0,1,?1,?1)",
                rusqlite::params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        db
    }

    fn restore_opts(faults: RestoreFaults) -> RestoreOptions {
        RestoreOptions {
            allow_partial: true,
            faults,
        }
    }

    fn read_journal_state(data_dir: &Path) -> Option<RestoreState> {
        read_journal(data_dir).unwrap().map(|j| j.state)
    }

    fn bundle_lines(path: &Path) -> Vec<String> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|s| s.to_string())
            .collect()
    }

    fn write_bundle_lines(path: &Path, lines: &[String]) {
        std::fs::write(path, format!("{}\n", lines.join("\n"))).unwrap();
    }

    /// 重写 bundle：可选修改各行并重算完整性行（模拟恶意/损坏但哈希自洽的文件）。
    fn rewrite_bundle<F>(path: &Path, mut edit: F)
    where
        F: FnMut(&mut Vec<Value>),
    {
        let lines = bundle_lines(path);
        let mut values: Vec<Value> = lines
            .iter()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .collect();
        let integrity = values.pop().expect("integrity");
        assert_eq!(integrity["record"], "integrity");
        edit(&mut values);
        let mut hasher = Sha256::new();
        let mut out: Vec<String> = Vec::new();
        for value in &values {
            let mut line = serde_json::to_string(value).unwrap();
            line.push('\n');
            hasher.update(line.as_bytes());
            out.push(line.trim_end().to_string());
        }
        let mut footer = integrity;
        footer["sha256"] = Value::String(
            hasher
                .finalize()
                .iter()
                .map(|b| format!("{:02x}", b))
                .collect(),
        );
        out.push(serde_json::to_string(&footer).unwrap());
        write_bundle_lines(path, &out);
    }

    fn make_pre_voice_bundle(path: &Path) {
        rewrite_bundle(path, |values| {
            let voice_tables = [
                "voice_packs",
                "voice_assets",
                "voice_pack_assets",
                "voice_bindings",
            ];
            let header = values
                .iter_mut()
                .find(|value| value["record"] == "header")
                .unwrap();
            header["registry"].as_array_mut().unwrap().retain(|entry| {
                !entry
                    .get("table")
                    .and_then(Value::as_str)
                    .is_some_and(|table| voice_tables.contains(&table))
            });
            values.retain_mut(|value| {
                if value["record"] == "section" {
                    let table = value["table"].as_str().unwrap_or_default();
                    if voice_tables.contains(&table) {
                        return false;
                    }
                    if table == "settings" {
                        if let Some(settings) = value["value"].as_object_mut() {
                            settings.remove("tts_voice_pack_enabled");
                            settings.remove("tts_voice_pack_id");
                            settings.remove("tts_voice_route");
                        }
                    }
                }
                if value["record"] == "asset"
                    && value["path"]
                        .as_str()
                        .unwrap_or_default()
                        .starts_with("voice/")
                {
                    return false;
                }
                true
            });
        });
        // Old manifest did not advertise voice table counts. Footer counts are outside the payload hash.
        let mut lines = bundle_lines(path);
        let mut footer: Value = serde_json::from_str(lines.last().unwrap()).unwrap();
        let counts = footer["counts"].as_object_mut().unwrap();
        for table in [
            "voice_packs",
            "voice_assets",
            "voice_pack_assets",
            "voice_bindings",
            "voice_asset_bytes",
        ] {
            counts.remove(table);
        }
        *lines.last_mut().unwrap() = serde_json::to_string(&footer).unwrap();
        write_bundle_lines(path, &lines);
    }

    fn seed_target_voice(db: &Db, data_dir: &Path) -> (String, PathBuf, Vec<u8>) {
        let root = data_dir.join("audio").join("voice-packs");
        std::fs::create_dir_all(&root).unwrap();
        let bytes = b"pre-existing managed voice file".to_vec();
        let sha = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        std::fs::write(root.join(format!("{sha}.wav")), &bytes).unwrap();
        let now = now_iso();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO voice_packs (id,name,created_at,updated_at) VALUES ('00000000-0000-0000-0000-000000000002','Keep voice',?1,?1)",
                [&now],
            )?;
            conn.execute(
                "INSERT INTO voice_assets (id,sha256,media_type,duration_ms,size_bytes,created_at) VALUES ('keep-asset',?1,'audio/wav',1000,?2,?3)",
                rusqlite::params![sha, bytes.len() as i64, now],
            )?;
            conn.execute(
                "INSERT INTO voice_pack_assets (pack_id,asset_id,display_name,created_at) VALUES ('00000000-0000-0000-0000-000000000002','keep-asset','keep.wav',?1)",
                [&now],
            )?;
            conn.execute(
                "INSERT INTO voice_bindings (pack_id,event_kind,asset_id) VALUES ('00000000-0000-0000-0000-000000000002','agent_done','keep-asset')",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        db.set_setting(
            "tts_voice_pack_id",
            json!("00000000-0000-0000-0000-000000000002"),
        )
        .unwrap();
        db.set_setting("tts_voice_pack_enabled", json!(true))
            .unwrap();
        db.set_setting("tts_voice_route", json!("custom")).unwrap();
        (sha, root, bytes)
    }

    fn rebuild_bundle_with_voice(db: &Db, original_bundle: &Path) -> (PathBuf, String, Vec<u8>) {
        let source_root = original_bundle.parent().unwrap();
        let data_dir = source_root.join("appdata");
        let voice_root = data_dir.join("audio").join("voice-packs");
        std::fs::create_dir_all(&voice_root).unwrap();
        let bytes = b"restored custom voice bytes".to_vec();
        let sha = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        std::fs::write(voice_root.join(format!("{sha}.wav")), &bytes).unwrap();
        let now = now_iso();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO voice_packs (id,name,created_at,updated_at) VALUES ('00000000-0000-0000-0000-000000000001','Source voice',?1,?1)",
                [&now],
            )?;
            conn.execute(
                "INSERT INTO voice_assets (id,sha256,media_type,duration_ms,size_bytes,created_at) VALUES ('source-asset',?1,'audio/wav',1000,?2,?3)",
                rusqlite::params![sha, bytes.len() as i64, now],
            )?;
            conn.execute(
                "INSERT INTO voice_pack_assets (pack_id,asset_id,display_name,created_at) VALUES ('00000000-0000-0000-0000-000000000001','source-asset','source.wav',?1)",
                [&now],
            )?;
            conn.execute(
                "INSERT INTO voice_bindings (pack_id,event_kind,asset_id) VALUES ('00000000-0000-0000-0000-000000000001','agent_done','source-asset')",
                [],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        db.set_setting(
            "tts_voice_pack_id",
            json!("00000000-0000-0000-0000-000000000001"),
        )
        .unwrap();
        db.set_setting("tts_voice_pack_enabled", json!(true))
            .unwrap();
        db.set_setting("tts_voice_route", json!("custom")).unwrap();

        let bundle = source_root.join("with-voice.jsonl");
        let archive_dir = source_root.join("archive");
        let clipboard_dir = source_root.join("clipboard");
        backup::write_bundle(
            db,
            BackupSources {
                archive_dir: Some(&archive_dir),
                clipboard_dir: Some(&clipboard_dir),
                shelf_dir: None,
                data_dir: Some(&data_dir),
            },
            &bundle,
            BackupKind::Full,
        )
        .unwrap();
        (bundle, sha, bytes)
    }

    #[test]
    fn full_restore_commits_db_assets_archives_and_cleans() {
        let (_, source) = make_source_bundle("full-ok", false);
        let target_root = temp_dir("full-target");
        let target_clip = target_root.join("clipboard");
        std::fs::create_dir_all(&target_clip).unwrap();
        let target_archive = crate::agents::retention::archive_dir(&target_root);
        let db = make_target_db();

        let outcome = restore_bundle(
            &target_root,
            &db,
            &source.bundle,
            &restore_opts(RestoreFaults::default()),
        )
        .unwrap();
        assert_eq!(outcome.state, RestoreState::Completed);
        assert_eq!(outcome.assets, 2);
        assert_eq!(outcome.archives, 2);
        assert_eq!(task_title(&db, "src-task").as_deref(), Some("来源任务"));
        assert!(task_title(&db, "orig-task").is_none());
        assert_eq!(
            std::fs::read(target_clip.join("images/i1.png")).unwrap(),
            b"PNG-IMAGE-1"
        );
        assert_eq!(
            std::fs::read(target_clip.join("thumbs/i1.png")).unwrap(),
            b"PNG-THUMB-1"
        );
        assert_eq!(
            std::fs::read(target_archive.join("a1.jsonl")).unwrap(),
            b"{\"event\":1}\n"
        );
        assert!(marker(&db).is_none(), "完成后必须清理提交标记");
        assert!(
            !restore_root(&target_root).exists(),
            "完成后必须清理恢复日志与会话目录"
        );
        assert!(
            outcome
                .pre_backup
                .as_deref()
                .map(Path::new)
                .map(|p| p.exists())
                .unwrap_or(false),
            "恢复前完整备份必须保留"
        );
    }

    #[test]
    fn pre_voice_bundle_preserves_current_voice_tables_settings_and_files() {
        let (_, source) = make_source_bundle("pre-voice-source", false);
        make_pre_voice_bundle(&source.bundle);

        let target_root = temp_dir("pre-voice-target");
        let db = make_target_db();
        let (sha, voice_root, bytes) = seed_target_voice(&db, &target_root);
        let original_id = db.get_setting("tts_voice_pack_id").unwrap();
        let original_enabled = db.get_setting("tts_voice_pack_enabled").unwrap();
        let original_route = db.get_setting("tts_voice_route").unwrap();

        let outcome = restore_bundle(
            &target_root,
            &db,
            &source.bundle,
            &restore_opts(RestoreFaults::default()),
        )
        .unwrap();
        assert_eq!(outcome.state, RestoreState::Completed);
        for table in [
            "voice_packs",
            "voice_assets",
            "voice_pack_assets",
            "voice_bindings",
        ] {
            let count: i64 = db
                .with_conn(|conn| {
                    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                    .map_err(AppError::from)
                })
                .unwrap();
            assert_eq!(count, 1, "旧 bundle 未提供的 {table} 应保留");
        }
        assert_eq!(db.get_setting("tts_voice_pack_id").unwrap(), original_id);
        assert_eq!(
            db.get_setting("tts_voice_pack_enabled").unwrap(),
            original_enabled
        );
        assert_eq!(db.get_setting("tts_voice_route").unwrap(), original_route);
        assert_eq!(
            std::fs::read(voice_root.join(format!("{sha}.wav"))).unwrap(),
            bytes
        );
        assert!(
            crate::audio::voice_packs::voice_asset_path(&db, &voice_root, "keep-asset").is_ok()
        );
        let violations: i64 = db
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get(0)
                })
                .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(violations, 0, "旧 bundle 恢复后语音表不得产生悬挂引用");
    }

    #[test]
    fn voice_asset_restore_commits_managed_audio_file() {
        let (source_db, source) = make_source_bundle("voice-restore-source", false);
        let (bundle, sha, bytes) = rebuild_bundle_with_voice(&source_db, &source.bundle);
        let target_root = temp_dir("voice-restore-target");
        let target_db = make_target_db();

        let outcome = restore_bundle(
            &target_root,
            &target_db,
            &bundle,
            &restore_opts(RestoreFaults::default()),
        )
        .unwrap();
        assert_eq!(outcome.state, RestoreState::Completed);
        assert_eq!(outcome.assets, 3, "应恢复两个图片资产与一个语音资产");
        let voice_root = target_root.join("audio").join("voice-packs");
        assert_eq!(
            std::fs::read(voice_root.join(format!("{sha}.wav"))).unwrap(),
            bytes
        );
        assert!(crate::audio::voice_packs::voice_asset_path(
            &target_db,
            &voice_root,
            "source-asset"
        )
        .is_ok());
    }

    #[test]
    fn archive_failure_rolls_back_voice_asset_and_database() {
        let (source_db, source) = make_source_bundle("voice-rollback-source", false);
        let (bundle, sha, _bytes) = rebuild_bundle_with_voice(&source_db, &source.bundle);
        let target_root = temp_dir("voice-rollback-target");
        let target_db = make_target_db();
        let (old_sha, voice_root, old_bytes) = seed_target_voice(&target_db, &target_root);

        let err = restore_bundle(
            &target_root,
            &target_db,
            &bundle,
            &restore_opts(RestoreFaults {
                fail_archive_at: Some(0),
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert!(err.to_string().contains("已自动回滚"), "实际错误: {err}");
        assert!(std::fs::read(voice_root.join(format!("{old_sha}.wav"))).unwrap() == old_bytes);
        assert!(
            !voice_root.join(format!("{sha}.wav")).exists(),
            "失败恢复写入的新语音文件必须删除"
        );
        let pack_count: i64 = target_db
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM voice_packs WHERE id = '00000000-0000-0000-0000-000000000002'", [], |row| row.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(pack_count, 1);
        let source_pack_count: i64 = target_db
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM voice_packs WHERE id = '00000000-0000-0000-0000-000000000001'", [], |row| row.get(0))
                    .map_err(AppError::from)
            })
            .unwrap();
        assert_eq!(source_pack_count, 0);
        assert!(
            crate::audio::voice_packs::voice_asset_path(&target_db, &voice_root, "keep-asset")
                .is_ok()
        );
    }

    /// 构造带用户配置的完整 bundle；返回 (源库, bundle 路径, 源数据目录)。
    fn bundle_with_user_config(tag: &str) -> (Db, PathBuf, PathBuf) {
        use crate::hotkeys::model::{find_def, HotkeyBinding, HotkeyConfigFile, CONFIG_VERSION};
        let root = temp_dir(tag);
        let db = memdb();
        seed_task(&db, "cfg-task", "配置来源任务");
        let widgets = crate::user_preferences::normalize_widgets(&serde_json::json!([
            {"type":"today-tasks","enabled":true,"config":{"maxItems":8}},
            {"type":"unknown-widget","enabled":true}
        ]))
        .0;
        crate::user_preferences::write_preferences(
            &root,
            Some("en-US"),
            Some(&widgets),
            Some(&["__taskdock_app_add__".to_string(), "app-b".to_string()]),
        )
        .unwrap();
        let hotkeys = HotkeyConfigFile {
            version: CONFIG_VERSION,
            bindings: vec![HotkeyBinding {
                action: "quick_add_task".into(),
                scope: find_def("quick_add_task").unwrap().scope,
                accelerator: "Ctrl+Shift+K".into(),
                enabled: true,
            }],
        };
        crate::hotkeys::store::save_config_atomic(&root.join("hotkeys.json"), &hotkeys).unwrap();
        let bundle = root.join("with-config.json");
        let sources = BackupSources {
            archive_dir: None,
            clipboard_dir: None,
            shelf_dir: None,
            data_dir: Some(&root),
        };
        backup::write_bundle(&db, sources, &bundle, BackupKind::Full).unwrap();
        (db, bundle, root)
    }

    #[test]
    fn restore_applies_user_config_and_marks_pending_for_next_start() {
        let (_src_db, bundle, src_root) = bundle_with_user_config("cfg-apply");
        let target_root = temp_dir("cfg-target");
        let db = make_target_db();

        let outcome = restore_bundle(
            &target_root,
            &db,
            &bundle,
            &restore_opts(RestoreFaults::default()),
        )
        .unwrap();
        assert_eq!(outcome.state, RestoreState::Completed);
        let summary = outcome.config.expect("恢复结果必须报告配置摘要");
        assert_eq!(summary.locale.as_deref(), Some("en-US"));
        assert_eq!(summary.widgets, 6);
        // 测试进程没有初始化快捷键管理器：不能在摘要里声称已注册。
        assert_eq!(summary.hotkeys_applied, 0);
        assert!(!summary.hotkeys_pending);
        // 测试进程没有初始化快捷键管理器：必须明确提示“下次启动注册”，不能伪装成功。
        assert!(outcome
            .warnings
            .iter()
            .any(|w| w.contains("将在下次启动时注册")));

        // preferences.json / hotkeys.json 落盘；pending 标记供前端下次启动覆盖 localStorage。
        let loaded = crate::user_preferences::load_preferences(&target_root);
        assert_eq!(loaded.locale.as_deref(), Some("en-US"));
        assert_eq!(loaded.widgets.unwrap().len(), 6);
        assert_eq!(
            loaded.app_grid_order.as_deref(),
            Some(&["__taskdock_app_add__".to_string(), "app-b".to_string()][..])
        );
        let (restore_id, warning) = crate::user_preferences::pending_restore(&target_root);
        assert!(warning.is_none());
        assert_eq!(restore_id.as_deref(), Some(outcome.session_id.as_str()));
        let hotkeys_raw = std::fs::read_to_string(target_root.join("hotkeys.json")).unwrap();
        assert!(hotkeys_raw.contains("Ctrl+Shift+K"));
        // 任务数据同时被恢复（配置失败/成功都不影响数据事务）。
        assert!(task_title(&db, "cfg-task").is_some());
        std::fs::remove_dir_all(src_root).ok();
        std::fs::remove_dir_all(target_root).ok();
    }

    #[test]
    fn restore_old_bundle_without_config_keeps_local_preferences() {
        let src_root = temp_dir("cfg-old-src");
        let db = memdb();
        seed_task(&db, "old-task", "旧备份任务");
        let bundle = src_root.join("old.json");
        backup::write_bundle(&db, BackupSources::default(), &bundle, BackupKind::Full).unwrap();

        let target_root = temp_dir("cfg-old-target");
        let target_db = memdb();
        let widgets = crate::user_preferences::normalize_widgets(&serde_json::json!([])).0;
        crate::user_preferences::write_preferences(
            &target_root,
            Some("zh-CN"),
            Some(&widgets),
            Some(&["app-local".to_string()]),
        )
        .unwrap();
        let local_hotkeys = crate::hotkeys::model::HotkeyConfigFile {
            version: crate::hotkeys::model::CONFIG_VERSION,
            bindings: vec![crate::hotkeys::model::HotkeyBinding {
                action: "quick_add_task".into(),
                scope: crate::hotkeys::model::HotkeyScope::AppLocal,
                accelerator: "Ctrl+Shift+L".into(),
                enabled: true,
            }],
        };
        crate::hotkeys::store::save_config_atomic(
            &target_root.join("hotkeys.json"),
            &local_hotkeys,
        )
        .unwrap();

        let outcome = restore_bundle(
            &target_root,
            &target_db,
            &bundle,
            &restore_opts(RestoreFaults::default()),
        )
        .unwrap();
        assert_eq!(outcome.state, RestoreState::Completed);
        assert!(outcome.config.is_none());
        assert!(outcome.warnings.is_empty());
        let loaded = crate::user_preferences::load_preferences(&target_root);
        assert_eq!(loaded.locale.as_deref(), Some("zh-CN"));
        // 旧备份没有排序字段：本机已有排序必须保留。
        assert_eq!(
            loaded.app_grid_order.as_deref(),
            Some(&["app-local".to_string()][..])
        );
        let hotkeys_raw = std::fs::read_to_string(target_root.join("hotkeys.json")).unwrap();
        assert!(hotkeys_raw.contains("Ctrl+Shift+L"));
        assert!(!target_root
            .join(crate::user_preferences::PREFERENCES_PENDING_FILE)
            .exists());
        std::fs::remove_dir_all(src_root).ok();
        std::fs::remove_dir_all(target_root).ok();
    }

    #[test]
    fn restore_failure_before_commit_leaves_config_files_untouched() {
        let (_src_db, bundle, src_root) = bundle_with_user_config("cfg-fail-src");
        let target_root = temp_dir("cfg-fail-target");
        let db = make_target_db();
        let widgets = crate::user_preferences::normalize_widgets(&serde_json::json!([])).0;
        crate::user_preferences::write_preferences(
            &target_root,
            Some("zh-CN"),
            Some(&widgets),
            None,
        )
        .unwrap();
        let before = std::fs::read_to_string(target_root.join("preferences.json")).unwrap();

        let error = restore_bundle(
            &target_root,
            &db,
            &bundle,
            &restore_opts(RestoreFaults {
                fail_before_db_commit: true,
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert!(error.to_string().contains("模拟故障"));
        let after = std::fs::read_to_string(target_root.join("preferences.json")).unwrap();
        assert_eq!(before, after, "数据库提交前失败不得改动本机偏好");
        assert!(!target_root
            .join(crate::user_preferences::PREFERENCES_PENDING_FILE)
            .exists());
        std::fs::remove_dir_all(src_root).ok();
        std::fs::remove_dir_all(target_root).ok();
    }

    #[test]
    fn partial_bundle_requires_explicit_confirmation() {
        let (_, source) = make_source_bundle("partial-flag", true);
        let root = temp_dir("partial-target");
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &RestoreOptions {
                allow_partial: false,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("部分备份"), "{}", err);
        assert_eq!(task_title(&db, "orig-task").as_deref(), Some("原任务"));
        assert!(marker(&db).is_none());
        assert!(read_journal_state(&root).is_none(), "中止后必须清理日志");

        // 显式确认后可以恢复
        let outcome = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &RestoreOptions {
                allow_partial: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(outcome.state, RestoreState::Completed);
        assert!(task_title(&db, "orig-task").is_none());
    }

    #[test]
    fn corrupt_bundle_is_rejected_without_touching_db() {
        let (_, source) = make_source_bundle("corrupt", false);
        // 翻转正文中一个字节，使完整性校验失败
        let mut bytes = std::fs::read(&source.bundle).unwrap();
        let pos = bytes.len() / 2;
        bytes[pos] = if bytes[pos] == b'a' { b'b' } else { b'a' };
        std::fs::write(&source.bundle, &bytes).unwrap();
        let root = temp_dir("corrupt-target");
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(Default::default()),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("完整性") || err.to_string().contains("JSON"),
            "{}",
            err
        );
        assert_eq!(task_title(&db, "orig-task").as_deref(), Some("原任务"));
        assert!(marker(&db).is_none());
        assert!(read_journal_state(&root).is_none());
    }

    #[test]
    fn failure_before_db_commit_leaves_original_data() {
        let (_, source) = make_source_bundle("before-db", false);
        let root = temp_dir("before-db-target");
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(RestoreFaults {
                fail_before_db_commit: true,
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert!(err.to_string().contains("模拟故障"), "{}", err);
        assert_eq!(task_title(&db, "orig-task").as_deref(), Some("原任务"));
        assert!(task_title(&db, "src-task").is_none());
        assert!(marker(&db).is_none());
        assert!(read_journal_state(&root).is_none());
    }

    #[test]
    fn mid_transaction_failure_rolls_back_all_tables() {
        let (_, source) = make_source_bundle("mid-tx", false);
        let root = temp_dir("mid-tx-target");
        let db = make_target_db();
        // SQLite 触发器让导入在写完部分表后失败，验证单事务整体回滚
        db.with_conn(|c| {
            c.execute_batch(
                "CREATE TRIGGER fail_clip AFTER INSERT ON clipboard_items
                 BEGIN SELECT RAISE(ABORT, 'injected'); END;",
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(Default::default()),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("失败") || err.to_string().contains("injected"),
            "{}",
            err
        );
        assert_eq!(task_title(&db, "orig-task").as_deref(), Some("原任务"));
        assert!(task_title(&db, "src-task").is_none());
        assert!(marker(&db).is_none());
        let keep: i64 = db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM clipboard_items WHERE id='keep-item'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(keep, 1);
    }

    #[test]
    fn db_committed_but_archive_commit_fails_rolls_back_db_and_files() {
        let (_, source) = make_source_bundle("archive-fail", false);
        let root = temp_dir("archive-fail-target");
        std::fs::create_dir_all(root.join("clipboard")).unwrap();
        let archive_dir = crate::agents::retention::archive_dir(&root);
        std::fs::create_dir_all(&archive_dir).unwrap();
        // 目标已有同名归档，回滚必须还原原内容
        std::fs::write(archive_dir.join("a1.jsonl"), b"OLD-A1\n").unwrap();
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(RestoreFaults {
                fail_archive_at: Some(0),
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert!(err.to_string().contains("归档"), "{}", err);
        assert_eq!(task_title(&db, "orig-task").as_deref(), Some("原任务"));
        assert!(task_title(&db, "src-task").is_none());
        assert_eq!(
            std::fs::read(archive_dir.join("a1.jsonl")).unwrap(),
            b"OLD-A1\n",
            "被覆盖的归档必须回滚"
        );
        assert!(!archive_dir.join("a2.jsonl").exists(), "新建归档必须删除");
        assert!(marker(&db).is_none());
        assert_eq!(read_journal_state(&root), Some(RestoreState::RolledBack));
        // 回滚后可以立即重试
        let outcome = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(Default::default()),
        )
        .unwrap();
        assert_eq!(outcome.state, RestoreState::Completed);
        assert_eq!(task_title(&db, "src-task").as_deref(), Some("来源任务"));
        assert_eq!(
            std::fs::read(archive_dir.join("a1.jsonl")).unwrap(),
            b"{\"event\":1}\n"
        );
    }

    #[test]
    fn mid_copy_archive_failure_restores_first_archive() {
        let (_, source) = make_source_bundle("mid-archive", false);
        let root = temp_dir("mid-archive-target");
        std::fs::create_dir_all(root.join("clipboard")).unwrap();
        let archive_dir = crate::agents::retention::archive_dir(&root);
        std::fs::create_dir_all(&archive_dir).unwrap();
        std::fs::write(archive_dir.join("a1.jsonl"), b"OLD-A1\n").unwrap();
        std::fs::write(archive_dir.join("a2.jsonl"), b"OLD-A2\n").unwrap();
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(RestoreFaults {
                fail_archive_at: Some(1),
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert!(err.to_string().contains("归档"), "{}", err);
        assert_eq!(
            std::fs::read(archive_dir.join("a1.jsonl")).unwrap(),
            b"OLD-A1\n"
        );
        assert_eq!(
            std::fs::read(archive_dir.join("a2.jsonl")).unwrap(),
            b"OLD-A2\n"
        );
        assert_eq!(task_title(&db, "orig-task").as_deref(), Some("原任务"));
    }

    #[test]
    fn missing_asset_is_rejected() {
        let (_, source) = make_source_bundle("missing-asset", false);
        rewrite_bundle(&source.bundle, |values| {
            values.retain(|v| v.get("record").and_then(|r| r.as_str()) != Some("asset"));
        });
        let root = temp_dir("missing-asset-target");
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(Default::default()),
        )
        .unwrap_err();
        assert!(err.to_string().contains("缺少剪贴板资产"), "{}", err);
        assert_eq!(task_title(&db, "orig-task").as_deref(), Some("原任务"));
        assert!(marker(&db).is_none());
    }

    #[test]
    fn wrong_asset_hash_is_rejected() {
        let (_, source) = make_source_bundle("wrong-asset", false);
        rewrite_bundle(&source.bundle, |values| {
            for value in values.iter_mut() {
                if value.get("record").and_then(|r| r.as_str()) == Some("asset") {
                    value["data"] = Value::String("AAAA".into());
                    value["size"] = Value::from(3);
                    break;
                }
            }
        });
        let root = temp_dir("wrong-asset-target");
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(Default::default()),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("校验失败") || err.to_string().contains("大小"),
            "{}",
            err
        );
        assert_eq!(task_title(&db, "orig-task").as_deref(), Some("原任务"));
    }

    #[test]
    fn permission_denied_during_asset_commit_rolls_back() {
        let (_, source) = make_source_bundle("permission", false);
        let root = temp_dir("permission-target");
        std::fs::create_dir_all(root.join("clipboard")).unwrap();
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(RestoreFaults {
                fail_asset_at: Some(0),
                io_error: Some(IoFault::PermissionDenied),
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("权限不足") || err.to_string().contains("回滚"),
            "{}",
            err
        );
        assert_eq!(task_title(&db, "orig-task").as_deref(), Some("原任务"));
        assert!(marker(&db).is_none());
        assert!(!root.join("clipboard/images/i1.png").exists());
    }

    #[test]
    fn disk_full_during_archive_commit_rolls_back() {
        let (_, source) = make_source_bundle("diskfull", false);
        let root = temp_dir("diskfull-target");
        std::fs::create_dir_all(root.join("clipboard")).unwrap();
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(RestoreFaults {
                fail_archive_at: Some(0),
                io_error: Some(IoFault::StorageFull),
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("磁盘空间不足") || err.to_string().contains("回滚"),
            "{}",
            err
        );
        assert_eq!(task_title(&db, "orig-task").as_deref(), Some("原任务"));
        assert!(!crate::agents::retention::archive_dir(&root)
            .join("a1.jsonl")
            .exists());
    }

    #[test]
    fn file_locked_during_asset_commit_rolls_back() {
        let (_, source) = make_source_bundle("locked", false);
        let root = temp_dir("locked-target");
        std::fs::create_dir_all(root.join("clipboard")).unwrap();
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(RestoreFaults {
                fail_asset_at: Some(1),
                io_error: Some(IoFault::FileLocked),
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("占用") || err.to_string().contains("回滚"),
            "{}",
            err
        );
        assert_eq!(task_title(&db, "orig-task").as_deref(), Some("原任务"));
        assert!(!root.join("clipboard/images/i1.png").exists());
    }

    #[test]
    fn crash_after_db_commit_is_completed_on_restart() {
        let (_, source) = make_source_bundle("crash-db", false);
        let root = temp_dir("crash-db-target");
        std::fs::create_dir_all(root.join("clipboard")).unwrap();
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(RestoreFaults {
                crash_after_db_commit: true,
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert!(err.to_string().contains("模拟进程中断"), "{}", err);
        // 数据库已提交、标记存在、文件尚未提交
        assert_eq!(task_title(&db, "src-task").as_deref(), Some("来源任务"));
        assert!(marker(&db).is_some());
        assert!(!root.join("clipboard/images/i1.png").exists());

        let recovered = recover_pending(&root, &db).unwrap().expect("应恢复");
        assert_eq!(recovered.action, "forward_completed");
        assert_eq!(task_title(&db, "src-task").as_deref(), Some("来源任务"));
        assert_eq!(
            std::fs::read(root.join("clipboard/images/i1.png")).unwrap(),
            b"PNG-IMAGE-1"
        );
        assert!(marker(&db).is_none());
        assert!(read_journal_state(&root).is_none());
    }

    #[test]
    fn crash_mid_file_commit_resumes_without_duplicates() {
        let (_, source) = make_source_bundle("crash-file", false);
        let root = temp_dir("crash-file-target");
        std::fs::create_dir_all(root.join("clipboard")).unwrap();
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(RestoreFaults {
                crash_after_file: Some(0),
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert!(err.to_string().contains("模拟进程中断"), "{}", err);
        assert!(root.join("clipboard/images/i1.png").exists());
        assert!(marker(&db).is_some());
        let recovered = recover_pending(&root, &db).unwrap().expect("应恢复");
        assert_eq!(recovered.action, "forward_completed");
        assert_eq!(
            std::fs::read(root.join("clipboard/thumbs/i1.png")).unwrap(),
            b"PNG-THUMB-1"
        );
        assert_eq!(
            std::fs::read(crate::agents::retention::archive_dir(&root).join("a2.jsonl")).unwrap(),
            b"{\"event\":2}\n"
        );
        let links: i64 = db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM clipboard_task_links WHERE id='ctl1'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(links, 1);
        assert!(marker(&db).is_none());
    }

    #[test]
    fn first_start_after_completed_restore_clears_marker() {
        let (_, source) = make_source_bundle("marker-pending", false);
        let root = temp_dir("marker-pending-target");
        std::fs::create_dir_all(root.join("clipboard")).unwrap();
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(RestoreFaults {
                fail_marker_clear: true,
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert!(err.to_string().contains("提交标记清理失败"), "{}", err);
        assert_eq!(task_title(&db, "src-task").as_deref(), Some("来源任务"));
        assert!(marker(&db).is_some());
        assert_eq!(read_journal_state(&root), Some(RestoreState::Completed));

        let recovered = recover_pending(&root, &db).unwrap().expect("应恢复");
        assert_eq!(recovered.action, "completed_cleanup");
        assert!(marker(&db).is_none());
        assert!(read_journal_state(&root).is_none());
        assert_eq!(
            std::fs::read(root.join("clipboard/images/i1.png")).unwrap(),
            b"PNG-IMAGE-1"
        );
    }

    #[test]
    fn old_bundle_preserves_clipboard_and_links() {
        let (_, source) = make_source_bundle("legacy-bundle", false);
        // 构造旧格式：去掉扩展表 section 与资产，头标记 extended_modules=false
        rewrite_bundle(&source.bundle, |values| {
            for value in values.iter_mut() {
                if value.get("record").and_then(|r| r.as_str()) == Some("header") {
                    value["extended_modules"] = Value::Bool(false);
                    value["manifest_version"] = Value::from(1);
                }
            }
            values.retain(|v| {
                let record = v.get("record").and_then(|r| r.as_str()).unwrap_or("");
                if record == "asset" {
                    return false;
                }
                if record == "section" {
                    let table = v.get("table").and_then(|t| t.as_str()).unwrap_or("");
                    if backup::is_extended_table(table) {
                        return false;
                    }
                }
                true
            });
        });
        let root = temp_dir("legacy-bundle-target");
        let db = make_target_db();
        let now = now_iso();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO workspace_snapshots (id,task_id,name,note,source,item_count,created_at,updated_at)
                 VALUES ('ws1','orig-task','现场','','manual',0,?1,?1)",
                rusqlite::params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let outcome = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(Default::default()),
        )
        .unwrap();
        assert!(outcome.extended_preserved, "旧备份必须标记为保留扩展模块");
        assert_eq!(task_title(&db, "src-task").as_deref(), Some("来源任务"));
        let keep: i64 = db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM clipboard_items WHERE id='keep-item'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(keep, 1, "旧备份不得删除剪贴板历史");
        let ws: Option<String> = db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT task_id FROM workspace_snapshots WHERE id='ws1'",
                    [],
                    |r| r.get(0),
                )
                .ok())
            })
            .unwrap();
        assert!(ws.is_none(), "被删除任务的现场关联按原语义置空");
        // 旧备份没有资产，不应因缺少 clipboard 目录而失败
        assert!(!root.join("clipboard/images/i1.png").exists());
    }

    /// 旧备份没有剪贴板设置键：恢复后必须保留本机的关闭/暂停偏好，
    /// 绝不能因为“缺失即默认”把自动记录重新打开。
    #[test]
    fn old_bundle_without_clipboard_settings_keeps_disabled_and_paused() {
        let (_, source) = make_source_bundle("legacy-settings", false);
        rewrite_bundle(&source.bundle, |values| {
            for value in values.iter_mut() {
                if value.get("record").and_then(|r| r.as_str()) == Some("section")
                    && value.get("table").and_then(|t| t.as_str()) == Some("settings")
                {
                    if let Some(map) = value.get_mut("value").and_then(|v| v.as_object_mut()) {
                        map.retain(|key, _| !key.starts_with("clipboard_"));
                    }
                }
            }
        });
        // 删除设置键后同步完整性行中的 settings 计数（SHA 只覆盖其前面的行）。
        {
            let mut lines = bundle_lines(&source.bundle);
            let footer_index = lines.len() - 1;
            let settings_count = lines[..footer_index]
                .iter()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .find(|value| {
                    value.get("record").and_then(|r| r.as_str()) == Some("section")
                        && value.get("table").and_then(|t| t.as_str()) == Some("settings")
                })
                .and_then(|value| {
                    value
                        .get("value")
                        .and_then(|v| v.as_object())
                        .map(|m| m.len())
                })
                .unwrap();
            let mut footer: Value = serde_json::from_str(&lines[footer_index]).unwrap();
            footer["counts"]["application_settings"] = json!(settings_count);
            lines[footer_index] = serde_json::to_string(&footer).unwrap();
            write_bundle_lines(&source.bundle, &lines);
        }
        let root = temp_dir("legacy-settings-target");
        let db = make_target_db();
        db.set_setting("clipboard_enabled", json!(false)).unwrap();
        db.set_setting("clipboard_paused", json!(true)).unwrap();

        let outcome = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(RestoreFaults::default()),
        )
        .unwrap();
        assert_eq!(outcome.state, RestoreState::Completed);
        let config = crate::db::Settings::load_clipboard(&db);
        assert!(config.error.is_none());
        assert!(
            !config.settings.clipboard_enabled,
            "旧备份缺失剪贴板设置不得把记录重新打开"
        );
        assert!(
            config.settings.clipboard_paused,
            "旧备份恢复必须保留暂停偏好"
        );
        assert!(!config.capture_allowed());
    }

    /// 备份里带着「备份那一刻」的剪贴板开关（enabled=true/paused=false），
    /// 而用户此刻已经关闭并暂停了记录：恢复必须保留本机当前偏好，
    /// 绝不能因为旧备份里的开关值把剪贴板采集重新打开。
    #[test]
    fn bundle_with_stale_clipboard_switches_keeps_local_preference() {
        let (_, source) = make_source_bundle("stale-settings", false);
        // 先确认这份备份确实带着会「打开记录」的旧开关值，否则本用例是空转。
        let bundle_settings = bundle_lines(&source.bundle)
            .iter()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find(|value| {
                value.get("record").and_then(|r| r.as_str()) == Some("section")
                    && value.get("table").and_then(|t| t.as_str()) == Some("settings")
            })
            .and_then(|value| value.get("value").and_then(|v| v.as_object()).cloned())
            .expect("备份必须带设置段");
        assert_eq!(
            bundle_settings
                .get("clipboard_enabled")
                .and_then(|v| v.as_bool()),
            Some(true),
            "备份里必须含开启状态的旧开关值，本用例才有意义"
        );

        let root = temp_dir("stale-settings-target");
        let db = make_target_db();
        db.set_setting("clipboard_enabled", json!(false)).unwrap();
        db.set_setting("clipboard_paused", json!(true)).unwrap();

        let outcome = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(RestoreFaults::default()),
        )
        .unwrap();
        assert_eq!(outcome.state, RestoreState::Completed);
        let config = crate::db::Settings::load_clipboard(&db);
        assert!(config.error.is_none());
        assert!(
            !config.settings.clipboard_enabled,
            "旧备份里的开关值不得把用户已关闭的剪贴板记录重新打开"
        );
        assert!(
            config.settings.clipboard_paused,
            "旧备份里的开关值不得覆盖用户当前的暂停偏好"
        );
        assert!(!config.capture_allowed());
    }

    #[test]
    fn duplicate_archive_name_is_rejected() {
        let (_, source) = make_source_bundle("dup-archive", false);
        rewrite_bundle(&source.bundle, |values| {
            let first = values
                .iter()
                .find(|v| {
                    v.get("record").and_then(|r| r.as_str()) == Some("archive")
                        && v.get("chunk").and_then(|c| c.as_u64()) == Some(0)
                })
                .cloned()
                .unwrap();
            values.push(first);
        });
        let root = temp_dir("dup-archive-target");
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(Default::default()),
        )
        .unwrap_err();
        assert!(err.to_string().contains("重复"), "{}", err);
        assert_eq!(task_title(&db, "orig-task").as_deref(), Some("原任务"));
    }

    #[test]
    fn malicious_asset_path_is_rejected() {
        let (_, source) = make_source_bundle("evil-path", false);
        rewrite_bundle(&source.bundle, |values| {
            for value in values.iter_mut() {
                if value.get("record").and_then(|r| r.as_str()) == Some("asset") {
                    value["path"] = Value::String("../evil.png".into());
                    break;
                }
            }
        });
        let root = temp_dir("evil-path-target");
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(Default::default()),
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("非法") || err.to_string().contains("资产"),
            "{}",
            err
        );
        assert!(!root.join("evil.png").exists());
        assert!(!root.parent().unwrap().join("evil.png").exists());
    }

    #[test]
    fn pre_backup_failure_blocks_restore() {
        let (_, source) = make_source_bundle("pre-fail", false);
        let root = temp_dir("pre-fail-target");
        let db = make_target_db();
        let err = restore_bundle(
            &root,
            &db,
            &source.bundle,
            &restore_opts(RestoreFaults {
                fail_pre_backup: true,
                ..Default::default()
            }),
        )
        .unwrap_err();
        assert!(err.to_string().contains("备份"), "{}", err);
        assert_eq!(task_title(&db, "orig-task").as_deref(), Some("原任务"));
        assert!(marker(&db).is_none());
        assert!(read_journal_state(&root).is_none());
    }

    #[test]
    fn legacy_json_import_creates_recovery_point_and_preserves_modules() {
        let root = temp_dir("legacy-json");
        let db = make_target_db();
        let now = now_iso();
        db.with_conn(|c| {
            c.execute(
                "INSERT INTO workspace_snapshots (id,task_id,name,note,source,item_count,created_at,updated_at)
                 VALUES ('ws-keep',NULL,'现场','','manual',0,?1,?1)",
                rusqlite::params![now],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let data = json!({
            "app": "task-dock",
            "version": 2,
            "exported_at": now,
            "tasks": [{
                "id": "json-task", "title": "JSON 任务", "description": "", "priority": 2,
                "status": "pending", "category": "", "tags": "[]", "due_at": null,
                "remind_at": null, "advance_minutes": 0, "recurrence_rule_id": null,
                "created_at": now, "updated_at": now, "completed_at": null
            }],
            "recurrence_rules": [], "task_reminders": [], "task_agent_links": [],
            "task_categories": [], "agent_sources": [], "agent_instances": [],
            "agent_sessions": [], "agent_runs": [], "agent_events": [],
            "notification_history": [], "navigation_targets": [],
            "task_navigation_targets": [], "navigation_log": [],
            "settings": {}
        });
        let source = root.join("legacy.json");
        std::fs::write(&source, serde_json::to_vec(&data).unwrap()).unwrap();
        let outcome = restore_legacy_json(&root, &db, &source, &data).unwrap();
        assert_eq!(outcome.state, RestoreState::Completed);
        assert!(outcome.extended_preserved);
        assert_eq!(task_title(&db, "json-task").as_deref(), Some("JSON 任务"));
        let keep: i64 = db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM clipboard_items WHERE id='keep-item'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(keep, 1, "旧 JSON 不得删除剪贴板数据");
        let ws: i64 = db
            .with_conn(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM workspace_snapshots WHERE id='ws-keep'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(ws, 1, "旧 JSON 不得删除工作现场");
        assert!(outcome
            .pre_backup
            .as_deref()
            .map(Path::new)
            .map(|p| p.exists())
            .unwrap_or(false));
        assert!(marker(&db).is_none());
        assert!(read_journal_state(&root).is_none());
    }

    #[test]
    fn data_only_read_does_not_materialize_files() {
        let (_, source) = make_source_bundle("data-only", false);
        let rows_dir = temp_dir("data-only-rows");
        let read = backup::read_bundle_data_only(&source.bundle, &rows_dir).unwrap();
        assert_eq!(read.assets.len(), 2);
        assert!(read.assets.iter().all(|a| a.path.as_os_str().is_empty()));
        assert_eq!(read.archives.len(), 2);
        assert!(read.archives.iter().all(|a| a.path.as_os_str().is_empty()));
        // 表行落到 rows_dir，内存 data 只保留元信息。
        assert!(read.data.get("tasks").is_none());
        let mut tasks = 0usize;
        backup::for_each_spilled_row(&read.rows_dir, "tasks", |_, row| {
            assert_eq!(row["id"], "src-task");
            tasks += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!(tasks, 1);
        let _ = std::fs::remove_dir_all(&rows_dir);
    }
}
