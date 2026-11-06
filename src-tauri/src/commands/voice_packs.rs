//! 自定义语音包命令：只传递资源 ID 与必要元数据，不把音频字节交给前端状态。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::audio::voice_packs::{self, VoiceAssetImportResult, VoiceClip, VoiceDeleteResult, VoicePackView};
use crate::db::Db;
use crate::error::{AppError, AppResult};

fn voice_root(app: &AppHandle) -> PathBuf {
    crate::app_data_dir(app).join("audio").join("voice-packs")
}

#[tauri::command]
pub async fn voice_packs_list(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
) -> AppResult<Vec<VoicePackView>> {
    let db = Arc::clone(&db);
    let root = voice_root(&app);
    tauri::async_runtime::spawn_blocking(move || voice_packs::list_voice_packs(&db, &root))
        .await
        .map_err(|error| AppError::Unavailable(format!("语音包查询线程异常: {error}")))?
}

#[tauri::command]
pub fn voice_pack_create(db: State<'_, Arc<Db>>, name: String) -> AppResult<String> {
    voice_packs::create_voice_pack(&db, &name)
}

#[tauri::command]
pub fn voice_pack_rename(db: State<'_, Arc<Db>>, pack_id: String, name: String) -> AppResult<()> {
    voice_packs::rename_voice_pack(&db, &pack_id, &name)
}

#[tauri::command]
pub async fn voice_pack_delete(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    pack_id: String,
) -> AppResult<VoiceDeleteResult> {
    let db = Arc::clone(&db);
    let root = voice_root(&app);
    tauri::async_runtime::spawn_blocking(move || {
        voice_packs::delete_voice_pack(&db, &root, &pack_id)
    })
    .await
    .map_err(|error| AppError::Unavailable(format!("语音包删除线程异常: {error}")))?
}

#[tauri::command]
pub async fn voice_asset_import(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    pack_id: String,
    path: String,
) -> AppResult<VoiceAssetImportResult> {
    let db = Arc::clone(&db);
    let root = voice_root(&app);
    match tauri::async_runtime::spawn_blocking(move || {
        voice_packs::import_voice_asset(&db, &root, &pack_id, std::path::Path::new(&path))
    })
    .await
    {
        Ok(result) => Ok(result),
        Err(_) => Ok(VoiceAssetImportResult {
            ok: false,
            code: "storage_error".into(),
            asset: None,
            duration_warning: false,
        }),
    }
}

#[tauri::command]
pub async fn voice_asset_remove(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    pack_id: String,
    asset_id: String,
) -> AppResult<VoiceDeleteResult> {
    let db = Arc::clone(&db);
    let root = voice_root(&app);
    tauri::async_runtime::spawn_blocking(move || {
        voice_packs::remove_voice_asset(&db, &root, &pack_id, &asset_id)
    })
    .await
    .map_err(|error| AppError::Unavailable(format!("语音资源删除线程异常: {error}")))?
}

#[tauri::command]
pub fn voice_binding_set(
    db: State<'_, Arc<Db>>,
    pack_id: String,
    event_kind: String,
    asset_id: Option<String>,
) -> AppResult<()> {
    voice_packs::set_voice_binding(&db, &pack_id, &event_kind, asset_id.as_deref())
}

#[tauri::command]
pub fn voice_resolve_clip(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    event_kind: String,
) -> AppResult<Option<VoiceClip>> {
    voice_packs::resolve_voice_clip(&db, &voice_root(&app), &event_kind)
}

#[tauri::command]
pub fn voice_asset_path(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    asset_id: String,
) -> AppResult<String> {
    voice_packs::voice_asset_path(&db, &voice_root(&app), &asset_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_types_use_camel_case_and_import_result_has_no_source_path() {
        let import = VoiceAssetImportResult {
            ok: false,
            code: "decode_failed".into(),
            asset: None,
            duration_warning: false,
        };
        let value = serde_json::to_value(import).unwrap();
        assert_eq!(value["durationWarning"], false);
        assert!(value.get("duration_warning").is_none());
        assert!(value.get("path").is_none());

        let pack = VoicePackView {
            id: "p".into(),
            name: "Pack".into(),
            storage_bytes: 0,
            assets: Vec::new(),
            bindings: Vec::new(),
        };
        let value = serde_json::to_value(pack).unwrap();
        assert_eq!(value["storageBytes"], 0);
        assert!(value.get("storage_bytes").is_none());

        let deleted = VoiceDeleteResult {
            deleted: true,
            cleanup_pending: true,
            cleanup_warning: Some("cleanup_pending".into()),
            removed_assets: 1,
            freed_bytes: 10,
        };
        let value = serde_json::to_value(&deleted).unwrap();
        assert_eq!(value["deleted"], true);
        assert_eq!(value["cleanupPending"], true);
        assert_eq!(value["cleanupWarning"], "cleanup_pending");
        assert_eq!(value["removedAssets"], 1);
        assert_eq!(value["freedBytes"], 10);
    }
}
