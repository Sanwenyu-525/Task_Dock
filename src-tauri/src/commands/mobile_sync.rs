//! 手机接入命令：设置页状态、配对会话、设备管理与文件互传。
//!
//! 命令层不直接操作 SQLite 之外的状态；配对/令牌逻辑在 `mobile_sync` 模块，
//! HTTP 监听在 `mobile_sync::server`。所有返回值均为 snake_case，与既有设置命令一致。

use std::sync::Arc;

use tauri::State;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mobile_sync::files::MobileFile;
use crate::mobile_sync::{
    self, MobileDevice, MobileSyncState, MobileSyncStatus, PairingOffer,
};

/// 状态快照：设置页打开时读取，配对弹层打开期间轮询（1s，组件卸载即停止）。
#[tauri::command]
pub fn mobile_sync_status(
    db: State<'_, Arc<Db>>,
    state: State<'_, MobileSyncState>,
) -> AppResult<MobileSyncStatus> {
    Ok(mobile_sync::status(&db, &state))
}

/// 生成一次性配对码与二维码内容。重复调用会作废旧码。
#[tauri::command]
pub fn mobile_sync_start_pairing(
    db: State<'_, Arc<Db>>,
    state: State<'_, MobileSyncState>,
) -> AppResult<PairingOffer> {
    mobile_sync::start_pairing(&db, &state)
}

/// 取消配对（关闭弹层、点击取消、切换设置分区时调用）。
#[tauri::command]
pub fn mobile_sync_cancel_pairing(state: State<'_, MobileSyncState>) -> AppResult<()> {
    mobile_sync::cancel_pairing(&state);
    Ok(())
}

/// 已配对设备列表（只返回未撤销记录）。
#[tauri::command]
pub fn mobile_sync_list_devices(db: State<'_, Arc<Db>>) -> AppResult<Vec<MobileDevice>> {
    mobile_sync::list_active_devices(&db)
}

/// 撤销设备令牌。记录保留（revoked_at）用于审计，令牌立即失效。
#[tauri::command]
pub fn mobile_sync_revoke_device(
    db: State<'_, Arc<Db>>,
    device_id: String,
) -> AppResult<bool> {
    mobile_sync::revoke_device(&db, &device_id)
}

/// 文件互传记录（最近 100 条，桌面端设置页展示）。
#[tauri::command]
pub fn mobile_file_list(db: State<'_, Arc<Db>>) -> AppResult<Vec<MobileFile>> {
    mobile_sync::files::list_all(&db)
}

/// 选择文件后复制到 outbox，供已配对手机下载。
/// 复制可能较慢（单文件上限 200MB），放后台线程，不阻塞 IPC。
#[tauri::command]
pub async fn mobile_file_offer(
    db: State<'_, Arc<Db>>,
    state: State<'_, MobileSyncState>,
    paths: Vec<String>,
) -> AppResult<Vec<MobileFile>> {
    let db = db.inner().clone();
    let root = state.files_root().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        mobile_sync::files::create_offers(&db, &root, &paths)
    })
    .await
    .map_err(|error| AppError::Unavailable(format!("发送文件任务失败: {error}")))?
}

/// 删除一条传输记录与对应磁盘副本（outbox/inbox/tmp 三处之一）。
#[tauri::command]
pub async fn mobile_file_delete(
    db: State<'_, Arc<Db>>,
    state: State<'_, MobileSyncState>,
    id: String,
) -> AppResult<bool> {
    let db = db.inner().clone();
    let root = state.files_root().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        mobile_sync::files::delete_file(&db, &root, None, &id)
    })
    .await
    .map_err(|error| AppError::Unavailable(format!("删除文件任务失败: {error}")))?
}

/// 在资源管理器中定位文件（不向前端暴露本机绝对路径）。
#[tauri::command]
pub fn mobile_file_reveal(
    db: State<'_, Arc<Db>>,
    state: State<'_, MobileSyncState>,
    id: String,
) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    let path = mobile_sync::files::resolve_stored_file(&db, state.files_root(), &id)?;
    let target = path.to_string_lossy().to_string();
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{target}\""))
        .spawn()
        .map_err(|error| AppError::Validation(format!("定位失败: {error}")))?;
    Ok(())
}

/// 打开手机上传的接收目录。
#[tauri::command]
pub fn mobile_file_open_inbox(state: State<'_, MobileSyncState>) -> AppResult<()> {
    let dir = mobile_sync::files::inbox_dir(state.files_root());
    std::fs::create_dir_all(&dir)?;
    std::process::Command::new("explorer.exe")
        .arg(dir.as_os_str())
        .spawn()
        .map_err(|error| AppError::Validation(format!("打开接收目录失败: {error}")))?;
    Ok(())
}
