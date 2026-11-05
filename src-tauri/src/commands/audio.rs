//! 统一音频通知服务的 IPC 入口。
//!
//! 命令只做参数边界校验与设置读取，重活交给 `AudioService`（WinRT 合成/文件缓存），
//! 并用 `spawn_blocking` 隔离，避免阻塞 Tauri 主线程与 UI。
//! 功能失败（无中文语音、无设备、缓存写失败等）通过结构化报告返回，不抛出全局错误，
//! 防止连续弹错误通知；只有设置读取失败等真正的调用错误才走 AppError。

use std::sync::Arc;

use tauri::State;

use crate::audio::{AudioService, CacheReport, ClearReport, SynthesisReport, VoicesReport};
use crate::db::{Db, Settings};
use crate::error::{AppError, AppResult};

const MAX_MB: u64 = 1024 * 1024;

fn max_bytes_of(settings: &Settings) -> u64 {
    (settings.tts_cache_max_mb as u64).saturating_mul(MAX_MB)
}

#[tauri::command]
pub async fn tts_list_voices(
    audio: State<'_, Arc<AudioService>>,
) -> AppResult<VoicesReport> {
    let service = Arc::clone(&audio);
    tauri::async_runtime::spawn_blocking(move || service.voices())
        .await
        .map_err(|e| AppError::Unavailable(format!("语音服务线程异常: {e}")))
}

/// `text` 由前端按事件组装；`persist` 只是「请求」，
/// 后端会再用固定短语白名单二次校验，动态文本绝不落盘。
#[tauri::command]
pub async fn tts_synthesize(
    audio: State<'_, Arc<AudioService>>,
    db: State<'_, Arc<Db>>,
    text: String,
    voice_id: Option<String>,
    gender: Option<String>,
    rate: Option<u32>,
    persist: Option<bool>,
    engine: Option<String>,
) -> AppResult<SynthesisReport> {
    let settings = Settings::load(&db)?;
    let service = Arc::clone(&audio);
    let cache_enabled = settings.tts_cache_enabled;
    let max_bytes = max_bytes_of(&settings);
    let gender = gender.unwrap_or_else(|| settings.tts_voice_gender.clone());
    let rate = rate.unwrap_or(settings.tts_rate);
    let persist = persist.unwrap_or(false);
    let voice_id = voice_id.filter(|v| !v.trim().is_empty());
    // 未指定时使用系统引擎；非法引擎由 AudioService 返回结构化 engine_unavailable。
    let engine = engine.unwrap_or_else(|| crate::audio::ENGINE_SYSTEM.to_string());

    tauri::async_runtime::spawn_blocking(move || {
        service.synthesize(
            &text,
            voice_id.as_deref(),
            &gender,
            rate,
            persist,
            cache_enabled,
            max_bytes,
            &engine,
        )
    })
    .await
    .map_err(|e| AppError::Unavailable(format!("语音合成线程异常: {e}")))
}

#[tauri::command]
pub fn tts_cache_stats(
    audio: State<'_, Arc<AudioService>>,
    db: State<'_, Arc<Db>>,
) -> AppResult<CacheReport> {
    let settings = Settings::load(&db)?;
    Ok(audio.cache_report(settings.tts_cache_enabled, settings.tts_cache_max_mb))
}

#[tauri::command]
pub async fn tts_cache_clear(
    audio: State<'_, Arc<AudioService>>,
) -> AppResult<ClearReport> {
    let service = Arc::clone(&audio);
    tauri::async_runtime::spawn_blocking(move || service.clear_cache())
        .await
        .map_err(|e| AppError::Unavailable(format!("缓存清理线程异常: {e}")))
}
