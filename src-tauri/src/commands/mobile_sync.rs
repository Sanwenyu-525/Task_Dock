//! 手机接入命令：设置页状态、配对会话与设备管理。
//!
//! 命令层不直接操作 SQLite 之外的状态；配对/令牌逻辑在 `mobile_sync` 模块，
//! HTTP 监听在 `mobile_sync::server`。所有返回值均为 snake_case，与既有设置命令一致。

use std::sync::Arc;

use tauri::State;

use crate::db::Db;
use crate::error::AppResult;
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
