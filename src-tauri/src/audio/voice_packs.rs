//! 用户托管的通知语音片段。
//!
//! TTS 合成缓存仍由 `cache.rs` 管理；本模块只管理用户导入的 MP3/WAV 及其包/事件绑定。

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::db::Db;
use crate::error::{AppError, AppResult};

const MAX_ASSET_BYTES: u64 = 15 * 1024 * 1024;
const MAX_ASSET_DURATION_MS: u64 = 60_000;
const LONG_ASSET_DURATION_MS: u64 = 15_000;
const MAX_PACK_ASSETS: u64 = 32;
const MAX_PACK_BYTES: u64 = 256 * 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 64 * 1024;
const VOICE_TABLES: &[&str] = &[
    "voice_packs",
    "voice_assets",
    "voice_pack_assets",
    "voice_bindings",
];
pub const EVENT_KINDS: &[&str] = &[
    "agent_started",
    "agent_done",
    "agent_done_multiple",
    "agent_waiting",
    "agent_failed",
    "agent_disconnected",
    "task_due",
    "reminder",
];

/// 语音包 CRUD、备份快照和资产文件提交共用门禁。
/// - 读取/备份持有读锁；
/// - 包/资产变更与恢复持有写锁。
static ASSET_GATE: RwLock<()> = RwLock::new(());

pub fn asset_gate_read() -> RwLockReadGuard<'static, ()> {
    ASSET_GATE.read().unwrap_or_else(|e| e.into_inner())
}

pub fn asset_gate_write() -> RwLockWriteGuard<'static, ()> {
    ASSET_GATE.write().unwrap_or_else(|e| e.into_inner())
}

pub fn is_voice_table(table: &str) -> bool {
    VOICE_TABLES.contains(&table)
}

pub fn valid_event_kind(kind: &str) -> bool {
    EVENT_KINDS.contains(&kind)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAssetView {
    pub id: String,
    pub display_name: String,
    pub media_type: String,
    pub duration_ms: u64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceBindingView {
    pub event_kind: String,
    pub asset_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePackView {
    pub id: String,
    pub name: String,
    pub storage_bytes: u64,
    pub assets: Vec<VoiceAssetView>,
    pub bindings: Vec<VoiceBindingView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAssetImportResult {
    pub ok: bool,
    pub code: String,
    pub asset: Option<VoiceAssetView>,
    pub duration_warning: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceClip {
    pub asset_id: String,
    pub media_type: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceDeleteResult {
    pub deleted: bool,
    pub cleanup_pending: bool,
    pub cleanup_warning: Option<String>,
    pub removed_assets: u64,
    pub freed_bytes: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct CleanupReport {
    pub removed_files: u64,
    pub freed_bytes: u64,
    pub pending: bool,
}

#[derive(Debug)]
struct DecodedAudio {
    media_type: &'static str,
    duration_ms: u64,
}

fn media_type_for_extension(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() {
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        _ => None,
    }
}

fn extension_for_media_type(media_type: &str) -> Option<&'static str> {
    match media_type {
        "audio/mpeg" => Some("mp3"),
        "audio/wav" => Some("wav"),
        _ => None,
    }
}

pub fn voice_asset_rel(sha256: &str, media_type: &str) -> AppResult<String> {
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(AppError::Validation("语音资源 SHA-256 格式非法".into()));
    }
    let extension = extension_for_media_type(media_type)
        .ok_or_else(|| AppError::Validation("语音资源格式不受支持".into()))?;
    Ok(format!("voice/{sha256}.{extension}"))
}

fn file_path(root: &Path, sha256: &str, media_type: &str) -> AppResult<PathBuf> {
    let rel = voice_asset_rel(sha256, media_type)?;
    Ok(root.join(rel.strip_prefix("voice/").expect("固定前缀")))
}

pub(crate) fn ensure_root(root: &Path) -> AppResult<()> {
    // 检查完整路径解析结果，避免 audio 父级是 junction/symlink 并把托管内容
    // 重定向到 app_data_dir 之外。调用方传入约定的 app_data/audio/voice-packs。
    if root.file_name().and_then(|name| name.to_str()) != Some("voice-packs")
        || root
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some("audio")
    {
        return Err(AppError::Validation("语音资源目录层级非法".into()));
    }
    let app_data = root
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| AppError::Validation("语音资源目录层级非法".into()))?;
    let canonical_app_data = fs::canonicalize(app_data)?;
    let expected_audio = canonical_app_data.join("audio");
    let audio = app_data.join("audio");
    match fs::symlink_metadata(&audio) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink()
                || !metadata.is_dir()
                || fs::canonicalize(&audio)? != expected_audio
            {
                return Err(AppError::Validation("语音资源父目录不可用".into()));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(&audio)?,
        Err(error) => return Err(error.into()),
    }
    let expected = expected_audio.join("voice-packs");
    match fs::symlink_metadata(root) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(AppError::Validation("语音资源目录不可用".into()));
            }
            if fs::canonicalize(root)? != expected {
                return Err(AppError::Validation(
                    "语音资源目录解析后超出应用数据目录".into(),
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(root)?,
        Err(error) => return Err(error.into()),
    }
    if fs::canonicalize(root)? != expected {
        return Err(AppError::Validation(
            "语音资源目录解析后超出应用数据目录".into(),
        ));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn validate_pack_name(name: &str) -> AppResult<String> {
    let normalized = name.trim();
    if normalized.is_empty() {
        return Err(AppError::Validation("语音包名称不能为空".into()));
    }
    if normalized.chars().count() > 80 || normalized.chars().any(char::is_control) {
        return Err(AppError::Validation(
            "语音包名称无效或超过 80 个字符".into(),
        ));
    }
    Ok(normalized.to_string())
}

fn safe_display_name(path: &Path) -> String {
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("语音片段");
    let normalized: String = name.chars().filter(|c| !c.is_control()).take(120).collect();
    if normalized.is_empty() {
        "语音片段".into()
    } else {
        normalized
    }
}

pub fn pack_exists(db: &Db, pack_id: &str) -> AppResult<bool> {
    db.with_read(|conn| {
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM voice_packs WHERE id = ?1)",
            [pack_id],
            |row| row.get::<_, bool>(0),
        )?)
    })
}

pub fn list_voice_packs(db: &Db, root: &Path) -> AppResult<Vec<VoicePackView>> {
    let _gate = asset_gate_write();
    ensure_root(root)?;
    let _ = cleanup_orphaned_files_report(db, root);
    db.with_read(|conn| {
        let mut pack_stmt = conn.prepare("SELECT id, name FROM voice_packs ORDER BY name COLLATE NOCASE, id")?;
        let packs = pack_stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut output = Vec::with_capacity(packs.len());
        for (id, name) in packs {
            let mut assets_stmt = conn.prepare(
                "SELECT a.id, p.display_name, a.media_type, a.duration_ms, a.size_bytes
                 FROM voice_pack_assets p JOIN voice_assets a ON a.id = p.asset_id
                 WHERE p.pack_id = ?1 ORDER BY p.display_name COLLATE NOCASE, a.id",
            )?;
            let assets = assets_stmt
                .query_map([&id], |row| {
                    Ok(VoiceAssetView {
                        id: row.get(0)?,
                        display_name: row.get(1)?,
                        media_type: row.get(2)?,
                        duration_ms: row.get::<_, i64>(3)?.max(0) as u64,
                        size_bytes: row.get::<_, i64>(4)?.max(0) as u64,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let storage_bytes = assets.iter().map(|asset| asset.size_bytes).sum();
            let mut bindings_stmt = conn.prepare(
                "SELECT event_kind, asset_id FROM voice_bindings WHERE pack_id = ?1 ORDER BY event_kind",
            )?;
            let bindings = bindings_stmt
                .query_map([&id], |row| {
                    Ok(VoiceBindingView {
                        event_kind: row.get(0)?,
                        asset_id: row.get(1)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            output.push(VoicePackView {
                id,
                name,
                storage_bytes,
                assets,
                bindings,
            });
        }
        Ok(output)
    })
}

pub fn create_voice_pack(db: &Db, name: &str) -> AppResult<String> {
    let _gate = asset_gate_write();
    let name = validate_pack_name(name)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    db.with_transaction(|conn| {
        conn.execute(
            "INSERT INTO voice_packs (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![id, name, now],
        )?;
        Ok(())
    })?;
    Ok(id)
}

pub fn rename_voice_pack(db: &Db, pack_id: &str, name: &str) -> AppResult<()> {
    let _gate = asset_gate_write();
    let name = validate_pack_name(name)?;
    let now = chrono::Utc::now().to_rfc3339();
    db.with_transaction(|conn| {
        let updated = conn.execute(
            "UPDATE voice_packs SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![pack_id, name, now],
        )?;
        if updated == 0 {
            return Err(AppError::NotFound("语音包不存在".into()));
        }
        Ok(())
    })
}

pub fn delete_voice_pack(db: &Db, root: &Path, pack_id: &str) -> AppResult<VoiceDeleteResult> {
    delete_voice_pack_with_cleanup(db, root, pack_id, cleanup_orphaned_files_report)
}

pub(crate) fn delete_voice_pack_with_cleanup(
    db: &Db,
    root: &Path,
    pack_id: &str,
    cleanup: fn(&Db, &Path) -> CleanupReport,
) -> AppResult<VoiceDeleteResult> {
    let _gate = asset_gate_write();
    ensure_root(root)?;
    let asset_ids = db.with_read(|conn| {
        let mut stmt = conn.prepare("SELECT asset_id FROM voice_pack_assets WHERE pack_id = ?1")?;
        let rows = stmt.query_map([pack_id], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })?;
    let removed_assets = db.with_transaction(|conn| {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM voice_packs WHERE id = ?1)",
            [pack_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(AppError::NotFound("语音包不存在".into()));
        }
        conn.execute("DELETE FROM voice_packs WHERE id = ?1", [pack_id])?;
        let active_id = setting_string(conn, "tts_voice_pack_id");
        if active_id.as_deref() == Some(pack_id) {
            set_setting_tx(conn, "tts_voice_pack_id", &serde_json::json!(""))?;
            set_setting_tx(conn, "tts_voice_pack_enabled", &serde_json::json!(false))?;
            set_setting_tx(conn, "tts_voice_route", &serde_json::json!("auto"))?;
        }
        let mut removed: u64 = 0;
        for asset_id in &asset_ids {
            let n = conn.execute(
                "DELETE FROM voice_assets WHERE id = ?1
                 AND NOT EXISTS (SELECT 1 FROM voice_pack_assets WHERE asset_id = ?1)",
                [asset_id],
            )?;
            removed = removed.saturating_add(n as u64);
        }
        Ok::<u64, AppError>(removed)
    })?;
    let report = cleanup(db, root);
    Ok(VoiceDeleteResult {
        deleted: true,
        cleanup_pending: report.pending,
        cleanup_warning: if report.pending {
            Some("cleanup_pending".to_string())
        } else {
            None
        },
        removed_assets,
        freed_bytes: report.freed_bytes,
    })
}

pub fn remove_voice_asset(
    db: &Db,
    root: &Path,
    pack_id: &str,
    asset_id: &str,
) -> AppResult<VoiceDeleteResult> {
    remove_voice_asset_with_cleanup(db, root, pack_id, asset_id, cleanup_orphaned_files_report)
}

pub(crate) fn remove_voice_asset_with_cleanup(
    db: &Db,
    root: &Path,
    pack_id: &str,
    asset_id: &str,
    cleanup: fn(&Db, &Path) -> CleanupReport,
) -> AppResult<VoiceDeleteResult> {
    let _gate = asset_gate_write();
    ensure_root(root)?;
    let removed_assets = db.with_transaction(|conn| {
        let bound: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM voice_bindings WHERE pack_id = ?1 AND asset_id = ?2)",
            params![pack_id, asset_id],
            |row| row.get(0),
        )?;
        if bound {
            return Err(AppError::Conflict(
                "该音频仍绑定到通知事件，请先清除绑定".into(),
            ));
        }
        let removed = conn.execute(
            "DELETE FROM voice_pack_assets WHERE pack_id = ?1 AND asset_id = ?2",
            params![pack_id, asset_id],
        )?;
        if removed == 0 {
            return Err(AppError::NotFound("语音包中的音频不存在".into()));
        }
        let n = conn.execute(
            "DELETE FROM voice_assets WHERE id = ?1
             AND NOT EXISTS (SELECT 1 FROM voice_pack_assets WHERE asset_id = ?1)",
            [asset_id],
        )?;
        Ok::<u64, AppError>(n as u64)
    })?;
    let report = cleanup(db, root);
    Ok(VoiceDeleteResult {
        deleted: true,
        cleanup_pending: report.pending,
        cleanup_warning: if report.pending {
            Some("cleanup_pending".to_string())
        } else {
            None
        },
        removed_assets,
        freed_bytes: report.freed_bytes,
    })
}

pub fn set_voice_binding(
    db: &Db,
    pack_id: &str,
    event_kind: &str,
    asset_id: Option<&str>,
) -> AppResult<()> {
    let _gate = asset_gate_write();
    if !valid_event_kind(event_kind) {
        return Err(AppError::Validation("通知事件类型不受支持".into()));
    }
    db.with_transaction(|conn| {
        let pack_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM voice_packs WHERE id = ?1)",
            [pack_id],
            |row| row.get(0),
        )?;
        if !pack_exists {
            return Err(AppError::NotFound("语音包不存在".into()));
        }
        if let Some(asset_id) = asset_id {
            let associated: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM voice_pack_assets WHERE pack_id = ?1 AND asset_id = ?2)",
                params![pack_id, asset_id],
                |row| row.get(0),
            )?;
            if !associated {
                return Err(AppError::Validation("音频不属于该语音包".into()));
            }
            conn.execute(
                "INSERT INTO voice_bindings (pack_id, event_kind, asset_id) VALUES (?1, ?2, ?3)
                 ON CONFLICT(pack_id, event_kind) DO UPDATE SET asset_id = excluded.asset_id",
                params![pack_id, event_kind, asset_id],
            )?;
        } else {
            conn.execute(
                "DELETE FROM voice_bindings WHERE pack_id = ?1 AND event_kind = ?2",
                params![pack_id, event_kind],
            )?;
        }
        Ok(())
    })
}

pub fn resolve_voice_clip(db: &Db, root: &Path, event_kind: &str) -> AppResult<Option<VoiceClip>> {
    let _gate = asset_gate_read();
    if !valid_event_kind(event_kind) {
        return Err(AppError::Validation("通知事件类型不受支持".into()));
    }
    ensure_root(root)?;
    db.with_read(|conn| {
        let enabled = setting_bool(conn, "tts_voice_pack_enabled").unwrap_or(false);
        if !enabled {
            return Ok(None);
        }
        let Some(pack_id) = setting_string(conn, "tts_voice_pack_id").filter(|id| !id.is_empty())
        else {
            return Ok(None);
        };
        let mut events = vec![event_kind];
        if event_kind == "agent_done_multiple" {
            events.push("agent_done");
        }
        for kind in events {
            let result = conn.query_row(
                "SELECT a.id, a.sha256, a.media_type, a.duration_ms, a.size_bytes
                 FROM voice_bindings b
                 JOIN voice_pack_assets p ON p.pack_id = b.pack_id AND p.asset_id = b.asset_id
                 JOIN voice_assets a ON a.id = b.asset_id
                 WHERE b.pack_id = ?1 AND b.event_kind = ?2",
                params![pack_id, kind],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            );
            let (asset_id, sha256, media_type, duration_ms, size_bytes) = match result {
                Ok(row) => row,
                Err(rusqlite::Error::QueryReturnedNoRows) => continue,
                Err(error) => return Err(error.into()),
            };
            let path = file_path(root, &sha256, &media_type)?;
            let Ok(metadata) = fs::symlink_metadata(path) else {
                continue;
            };
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() != size_bytes.max(0) as u64
            {
                continue;
            }
            return Ok(Some(VoiceClip {
                asset_id,
                media_type,
                duration_ms: duration_ms.max(0) as u64,
            }));
        }
        Ok(None)
    })
}

pub fn voice_asset_path(db: &Db, root: &Path, asset_id: &str) -> AppResult<String> {
    let _gate = asset_gate_read();
    let (sha256, media_type) = db.with_read(|conn| {
        conn.query_row(
            "SELECT sha256, media_type FROM voice_assets WHERE id = ?1",
            [asset_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => AppError::NotFound("语音资源不存在".into()),
            other => AppError::Db(other),
        })
    })?;
    ensure_root(root)?;
    let root = fs::canonicalize(root)?;
    let path = file_path(&root, &sha256, &media_type)?;
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| AppError::NotFound("语音资源文件缺失".into()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::Validation("语音资源文件不可用".into()));
    }
    let canonical = fs::canonicalize(&path)?;
    if canonical.parent() != Some(root.as_path()) {
        return Err(AppError::Validation("语音资源路径越界".into()));
    }
    Ok(canonical.to_string_lossy().into_owned())
}

pub fn import_voice_asset(
    db: &Db,
    root: &Path,
    pack_id: &str,
    source: &Path,
) -> VoiceAssetImportResult {
    let _gate = asset_gate_write();
    match import_voice_asset_inner(db, root, pack_id, source) {
        Ok((asset, duration_warning)) => VoiceAssetImportResult {
            ok: true,
            code: "ok".into(),
            asset: Some(asset),
            duration_warning,
        },
        Err(code) => VoiceAssetImportResult {
            ok: false,
            code,
            asset: None,
            duration_warning: false,
        },
    }
}

fn import_voice_asset_inner(
    db: &Db,
    root: &Path,
    pack_id: &str,
    source: &Path,
) -> Result<(VoiceAssetView, bool), String> {
    ensure_root(root).map_err(|_| "storage_error".to_string())?;
    let source_meta = fs::symlink_metadata(source).map_err(|_| "source_unavailable".to_string())?;
    if source_meta.file_type().is_symlink() || !source_meta.is_file() {
        return Err("invalid_source".into());
    }
    if source_meta.len() == 0 || source_meta.len() > MAX_ASSET_BYTES {
        return Err("size_limit".into());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "unsupported_format".to_string())?;
    let expected_media_type =
        media_type_for_extension(extension).ok_or_else(|| "unsupported_format".to_string())?;
    let temp = root.join(format!(".import-{}.tmp", uuid::Uuid::new_v4()));
    let copied = copy_and_hash(source, &temp).map_err(|code| {
        let _ = fs::remove_file(&temp);
        code
    })?;
    if copied.0 == 0 || copied.0 > MAX_ASSET_BYTES {
        let _ = fs::remove_file(&temp);
        return Err("size_limit".into());
    }
    let decoded = match decode_audio(&temp, extension) {
        Ok(decoded) if decoded.media_type == expected_media_type => decoded,
        _ => {
            let _ = fs::remove_file(&temp);
            return Err("decode_failed".into());
        }
    };
    if decoded.duration_ms > MAX_ASSET_DURATION_MS {
        let _ = fs::remove_file(&temp);
        return Err("duration_limit".into());
    }
    let display_name = safe_display_name(source);
    let sha256 = copied.1;
    let target =
        file_path(root, &sha256, expected_media_type).map_err(|_| "storage_error".to_string())?;
    let duration_warning = decoded.duration_ms > LONG_ASSET_DURATION_MS;
    let mut installed_new_file = false;

    let result = db.with_transaction(|conn| {
        let pack_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM voice_packs WHERE id = ?1)",
            [pack_id],
            |row| row.get(0),
        )?;
        if !pack_exists {
            return Err(AppError::NotFound("语音包不存在".into()));
        }
        let existing_asset: Option<(String, String, i64, i64)> = conn
            .query_row(
                "SELECT id, media_type, duration_ms, size_bytes FROM voice_assets WHERE sha256 = ?1",
                [&sha256],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let asset_id = existing_asset
            .as_ref()
            .map(|asset| asset.0.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if let Some((_, media_type, duration_ms, size_bytes)) = existing_asset.as_ref() {
            if media_type != expected_media_type
                || *duration_ms != decoded.duration_ms as i64
                || *size_bytes != copied.0 as i64
            {
                return Err(AppError::Conflict("内容哈希与已保存的音频元数据不一致".into()));
            }
        }
        let already_in_pack: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM voice_pack_assets WHERE pack_id = ?1 AND asset_id = ?2)",
            params![pack_id, asset_id],
            |row| row.get(0),
        )?;
        if already_in_pack {
            let asset = asset_view_for_pack(conn, pack_id, &asset_id)?
                .ok_or_else(|| AppError::NotFound("语音资源不存在".into()))?;
            return Ok((asset, true));
        }
        let (asset_count, pack_bytes): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(a.size_bytes), 0)
             FROM voice_pack_assets p JOIN voice_assets a ON a.id = p.asset_id
             WHERE p.pack_id = ?1",
            [pack_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if asset_count >= MAX_PACK_ASSETS as i64 {
            return Err(AppError::Conflict("pack_asset_limit".into()));
        }
        if pack_bytes.max(0) as u64 + copied.0 > MAX_PACK_BYTES {
            return Err(AppError::Conflict("pack_storage_limit".into()));
        }

        if !target.exists() {
            fs::rename(&temp, &target).map_err(|_| AppError::Unavailable("asset_install_failed".into()))?;
            installed_new_file = true;
        } else {
            let metadata = fs::symlink_metadata(&target)
                .map_err(|_| AppError::Unavailable("asset_storage_unavailable".into()))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(AppError::Validation("asset_storage_unavailable".into()));
            }
            let (_, existing_sha) = hash_file(&target)
                .map_err(|_| AppError::Unavailable("asset_storage_unavailable".into()))?;
            if existing_sha != sha256 {
                return Err(AppError::Conflict("asset_storage_corrupt".into()));
            }
        }
        if existing_asset.is_none() {
            conn.execute(
                "INSERT INTO voice_assets (id, sha256, media_type, duration_ms, size_bytes, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![asset_id, sha256, expected_media_type, decoded.duration_ms as i64, copied.0 as i64, chrono::Utc::now().to_rfc3339()],
            )?;
        }
        conn.execute(
            "INSERT INTO voice_pack_assets (pack_id, asset_id, display_name, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![pack_id, asset_id, display_name, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok((
            VoiceAssetView {
                id: asset_id,
                display_name,
                media_type: expected_media_type.into(),
                duration_ms: decoded.duration_ms,
                size_bytes: copied.0,
            },
            false,
        ))
    });

    let _ = fs::remove_file(&temp);
    match result {
        Ok((asset, already_in_pack)) => Ok((asset, duration_warning && !already_in_pack)),
        Err(error) => {
            if installed_new_file {
                let _ = fs::remove_file(&target);
            }
            let code = match error {
                AppError::NotFound(_) => "pack_not_found",
                AppError::Conflict(message) if message.contains("pack_asset_limit") => {
                    "pack_asset_limit"
                }
                AppError::Conflict(message) if message.contains("pack_storage_limit") => {
                    "pack_storage_limit"
                }
                AppError::Conflict(message) if message.contains("asset_storage_corrupt") => {
                    "asset_storage_corrupt"
                }
                AppError::Unavailable(message) if message.contains("asset_install_failed") => {
                    "asset_install_failed"
                }
                AppError::Unavailable(message) if message.contains("asset_storage_unavailable") => {
                    "asset_storage_unavailable"
                }
                AppError::Validation(message) if message.contains("asset_storage_unavailable") => {
                    "asset_storage_unavailable"
                }
                _ => "storage_error",
            };
            Err(code.to_string())
        }
    }
}

fn asset_view_for_pack(
    conn: &Connection,
    pack_id: &str,
    asset_id: &str,
) -> AppResult<Option<VoiceAssetView>> {
    Ok(conn
        .query_row(
            "SELECT a.id, p.display_name, a.media_type, a.duration_ms, a.size_bytes
             FROM voice_pack_assets p JOIN voice_assets a ON a.id = p.asset_id
             WHERE p.pack_id = ?1 AND p.asset_id = ?2",
            params![pack_id, asset_id],
            |row| {
                Ok(VoiceAssetView {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    media_type: row.get(2)?,
                    duration_ms: row.get::<_, i64>(3)?.max(0) as u64,
                    size_bytes: row.get::<_, i64>(4)?.max(0) as u64,
                })
            },
        )
        .optional()?)
}

fn copy_and_hash(source: &Path, target: &Path) -> Result<(u64, String), String> {
    let mut input = File::open(source).map_err(|_| "source_unavailable".to_string())?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|_| "storage_error".to_string())?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = vec![0; COPY_BUFFER_BYTES];
    loop {
        let count = input
            .read(&mut buffer)
            .map_err(|_| "source_unavailable".to_string())?;
        if count == 0 {
            break;
        }
        total = total.saturating_add(count as u64);
        if total > MAX_ASSET_BYTES {
            return Err("size_limit".into());
        }
        hasher.update(&buffer[..count]);
        output
            .write_all(&buffer[..count])
            .map_err(|_| "storage_error".to_string())?;
    }
    output.sync_all().map_err(|_| "storage_error".to_string())?;
    let digest = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((total, digest))
}

fn hash_file(path: &Path) -> AppResult<(u64, String)> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = vec![0; COPY_BUFFER_BYTES];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        total = total.saturating_add(count as u64);
    }
    let digest = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((total, digest))
}

fn has_expected_magic(path: &Path, extension: &str) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut head = vec![0; 64 * 1024];
    let Ok(count) = file.read(&mut head) else {
        return false;
    };
    head.truncate(count);
    match extension.to_ascii_lowercase().as_str() {
        "wav" => head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WAVE",
        "mp3" => {
            head.starts_with(b"ID3")
                || head
                    .windows(2)
                    .any(|bytes| bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0)
        }
        _ => false,
    }
}

fn decode_audio(path: &Path, extension: &str) -> Result<DecodedAudio, ()> {
    if !has_expected_magic(path, extension) {
        return Err(());
    }
    let file = File::open(path).map_err(|_| ())?;
    let source = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    hint.with_extension(&extension.to_ascii_lowercase());
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|_| ())?;
    let (track_id, codec_params) = {
        let track = format.default_track(TrackType::Audio).ok_or(())?;
        let codec_params = track
            .codec_params
            .as_ref()
            .and_then(|params| params.audio())
            .ok_or(())?;
        (track.id, codec_params.clone())
    };
    let sample_rate = codec_params.sample_rate.ok_or(())? as u64;
    if sample_rate == 0 {
        return Err(());
    }
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&codec_params, &AudioDecoderOptions::default())
        .map_err(|_| ())?;
    let mut frames = 0u64;
    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(_) => return Err(()),
        };
        if packet.track_id != track_id {
            continue;
        }
        let decoded = decoder.decode(&packet).map_err(|_| ())?;
        frames = frames.saturating_add(decoded.frames() as u64);
        let duration_ms = frames.saturating_mul(1000) / sample_rate;
        if duration_ms > MAX_ASSET_DURATION_MS {
            return Ok(DecodedAudio {
                media_type: media_type_for_extension(extension).ok_or(())?,
                duration_ms,
            });
        }
    }
    let duration_ms = frames.saturating_mul(1000) / sample_rate;
    if duration_ms == 0 {
        return Err(());
    }
    Ok(DecodedAudio {
        media_type: media_type_for_extension(extension).ok_or(())?,
        duration_ms,
    })
}

fn setting_string(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM application_settings WHERE key = ?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn setting_bool(conn: &Connection, key: &str) -> Option<bool> {
    conn.query_row(
        "SELECT value FROM application_settings WHERE key = ?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn set_setting_tx(conn: &Connection, key: &str, value: &serde_json::Value) -> AppResult<()> {
    conn.execute(
        "INSERT INTO application_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![
            key,
            serde_json::to_string(value)?,
            chrono::Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

pub(crate) fn cleanup_orphaned_files_report(db: &Db, root: &Path) -> CleanupReport {
    if ensure_root(root).is_err() {
        return CleanupReport {
            removed_files: 0,
            freed_bytes: 0,
            pending: true,
        };
    }
    let referenced = match db.with_read(|conn| {
        let mut stmt = conn.prepare("SELECT sha256, media_type FROM voice_assets")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut names = HashSet::new();
        for row in rows {
            let (sha256, media_type) = row?;
            if is_sha256(&sha256) {
                if let Some(extension) = extension_for_media_type(&media_type) {
                    names.insert(format!("{sha256}.{extension}"));
                }
            }
        }
        Ok::<HashSet<String>, AppError>(names)
    }) {
        Ok(names) => names,
        Err(_) => {
            return CleanupReport {
                removed_files: 0,
                freed_bytes: 0,
                pending: true,
            };
        }
    };
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => {
            return CleanupReport {
                removed_files: 0,
                freed_bytes: 0,
                pending: true,
            };
        }
    };
    let mut removed_files: u64 = 0;
    let mut freed_bytes: u64 = 0;
    let mut pending = false;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                pending = true;
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => {
                pending = true;
                continue;
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        let should_remove = (name.starts_with(".import-") && name.ends_with(".tmp"))
            || (is_managed_filename(&name) && !referenced.contains(&name));
        if !should_remove {
            continue;
        }
        let size = metadata.len();
        match fs::remove_file(&path) {
            Ok(()) => {
                removed_files = removed_files.saturating_add(1);
                freed_bytes = freed_bytes.saturating_add(size);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                removed_files = removed_files.saturating_add(1);
            }
            Err(_) => {
                pending = true;
            }
        }
    }
    CleanupReport {
        removed_files,
        freed_bytes,
        pending,
    }
}

pub(crate) fn cleanup_orphaned_files(db: &Db, root: &Path) -> AppResult<()> {
    let report = cleanup_orphaned_files_report(db, root);
    if report.pending {
        return Err(AppError::Unavailable("cleanup_pending".into()));
    }
    Ok(())
}

fn is_managed_filename(name: &str) -> bool {
    let Some((sha, extension)) = name.rsplit_once('.') else {
        return false;
    };
    is_sha256(sha) && matches!(extension, "mp3" | "wav")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root() -> PathBuf {
        let root = std::env::temp_dir()
            .join(format!("task-dock-voice-test-{}", uuid::Uuid::new_v4()))
            .join("appdata")
            .join("audio")
            .join("voice-packs");
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn cleanup_root(root: &Path) {
        if let Some(app_data) = root.parent().and_then(Path::parent) {
            let _ = fs::remove_dir_all(app_data);
        }
    }

    fn write_wav(path: &Path, seconds: u32) {
        write_wav_sample(path, seconds, 128);
    }

    fn write_wav_sample(path: &Path, seconds: u32, sample: u8) {
        let sample_rate = 8_000u32;
        let data_bytes = sample_rate * seconds;
        let mut bytes = Vec::with_capacity(44 + data_bytes as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&8u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_bytes.to_le_bytes());
        bytes.resize(44 + data_bytes as usize, sample);
        fs::write(path, bytes).unwrap();
    }

    fn write_silent_mp3_frames(path: &Path, frame_count: usize) {
        // MPEG-1 Layer III, 128 kbps / 44.1 kHz / joint stereo. Zero side/main data
        // encodes silent granules; the decoder below validates this generated fixture.
        let mut frame = vec![0u8; 417];
        frame[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x64]);
        let mut bytes = Vec::with_capacity(frame.len() * frame_count);
        for _ in 0..frame_count {
            bytes.extend_from_slice(&frame);
        }
        fs::write(path, bytes).unwrap();
    }

    fn db_and_pack() -> (Db, String, PathBuf) {
        let db = Db::open_in_memory().unwrap();
        let root = test_root();
        let id = create_voice_pack(&db, "测试语音").unwrap();
        (db, id, root)
    }

    #[test]
    fn creates_and_renames_packs_with_name_validation() {
        let (db, id, _) = db_and_pack();
        assert!(create_voice_pack(&db, "  ").is_err());
        assert!(rename_voice_pack(&db, &id, "改名").is_ok());
        assert!(rename_voice_pack(&db, &id, "改名").is_ok());
        assert!(create_voice_pack(&db, "改名").is_err());
        assert!(rename_voice_pack(&db, "missing", "不存在").is_err());
    }

    #[test]
    fn decodes_wav_and_enforces_duration_and_format_limits() {
        let root = test_root();
        let valid = root.join("有效.wav");
        write_wav(&valid, 1);
        let decoded = decode_audio(&valid, "wav").unwrap();
        assert_eq!(decoded.media_type, "audio/wav");
        assert_eq!(decoded.duration_ms, 1000);
        assert!(decode_audio(&valid, "mp3").is_err());

        let long = root.join("超时.wav");
        write_wav(&long, 61);
        assert!(decode_audio(&long, "wav").unwrap().duration_ms > MAX_ASSET_DURATION_MS);
        cleanup_root(&root);
    }

    #[test]
    fn fully_decodes_generated_mp3_frames_and_reports_duration_warning() {
        let root = test_root();
        let mp3 = root.join("generated-silent.mp3");
        write_silent_mp3_frames(&mp3, 20);
        let decoded = decode_audio(&mp3, "mp3").expect("自生成 MP3 帧必须可完整解码");
        assert_eq!(decoded.media_type, "audio/mpeg");
        assert!(decoded.duration_ms >= 500);

        let (db, pack, store) = db_and_pack();
        let long = root.join("long.wav");
        write_wav(&long, 16);
        let result = import_voice_asset(&db, &store, &pack, &long);
        assert!(result.ok, "{}", result.code);
        assert!(result.duration_warning, "15 秒以上应返回 durationWarning");
        cleanup_root(&root);
        cleanup_root(&store);
    }

    #[test]
    fn imports_deduplicates_binds_and_cleans_only_unreferenced_assets() {
        let (db, pack, root) = db_and_pack();
        let source = root.join("任务完成.wav");
        write_wav(&source, 1);
        let store = root.clone();
        let imported = import_voice_asset(&db, &store, &pack, &source);
        assert!(imported.ok, "{:?}", imported.code);
        let asset = imported.asset.unwrap();
        assert_eq!(asset.media_type, "audio/wav");
        assert_eq!(asset.duration_ms, 1000);
        assert!(source.exists(), "导入应复制，不移动源文件");
        assert!(voice_asset_path(&db, &store, &asset.id).is_ok());

        let duplicate = import_voice_asset(&db, &store, &pack, &source);
        assert!(duplicate.ok);
        assert_eq!(list_voice_packs(&db, &store).unwrap()[0].assets.len(), 1);
        assert!(set_voice_binding(&db, &pack, "agent_done_multiple", Some(&asset.id)).is_ok());
        assert!(set_voice_binding(&db, &pack, "untrusted", Some(&asset.id)).is_err());
        assert!(remove_voice_asset(&db, &store, &pack, &asset.id).is_err());
        assert!(set_voice_binding(&db, &pack, "agent_done_multiple", None).is_ok());
        remove_voice_asset(&db, &store, &pack, &asset.id).unwrap();
        assert!(!voice_asset_path(&db, &store, &asset.id).is_ok());
        cleanup_root(&root);
    }

    #[test]
    fn resolve_multiple_done_falls_back_to_regular_done_and_honors_enable_setting() {
        let (db, pack, root) = db_and_pack();
        let source = root.join("done.wav");
        write_wav(&source, 1);
        let store = root.clone();
        let imported = import_voice_asset(&db, &store, &pack, &source);
        let asset = imported.asset.unwrap();
        set_voice_binding(&db, &pack, "agent_done", Some(&asset.id)).unwrap();
        db.set_setting("tts_voice_pack_id", serde_json::json!(pack))
            .unwrap();
        db.set_setting("tts_voice_pack_enabled", serde_json::json!(true))
            .unwrap();
        assert_eq!(
            resolve_voice_clip(&db, &store, "agent_done_multiple")
                .unwrap()
                .unwrap()
                .asset_id,
            asset.id
        );
        db.set_setting("tts_voice_pack_enabled", serde_json::json!(false))
            .unwrap();
        assert!(resolve_voice_clip(&db, &store, "agent_done")
            .unwrap()
            .is_none());
        cleanup_root(&root);
    }

    #[test]
    fn shared_asset_survives_first_pack_removal_and_active_pack_delete_falls_back() {
        let (db, first_pack, root) = db_and_pack();
        let second_pack = create_voice_pack(&db, "第二包").unwrap();
        let source = root.join("共享.wav");
        write_wav(&source, 1);
        let imported_first = import_voice_asset(&db, &root, &first_pack, &source);
        assert!(imported_first.ok, "{}", imported_first.code);
        let asset_id = imported_first.asset.unwrap().id;
        let imported_second = import_voice_asset(&db, &root, &second_pack, &source);
        assert!(imported_second.ok, "{}", imported_second.code);
        assert_eq!(
            imported_second.asset.unwrap().id,
            asset_id,
            "同内容跨包应去重"
        );

        remove_voice_asset(&db, &root, &first_pack, &asset_id).unwrap();
        assert!(voice_asset_path(&db, &root, &asset_id).is_ok());
        set_voice_binding(&db, &second_pack, "agent_done", Some(&asset_id)).unwrap();
        db.set_setting("tts_voice_pack_id", serde_json::json!(second_pack))
            .unwrap();
        db.set_setting("tts_voice_pack_enabled", serde_json::json!(true))
            .unwrap();
        db.set_setting("tts_voice_route", serde_json::json!("custom"))
            .unwrap();
        delete_voice_pack(&db, &root, &second_pack).unwrap();
        assert_eq!(
            db.get_setting("tts_voice_pack_id").unwrap(),
            Some(serde_json::json!(""))
        );
        assert_eq!(
            db.get_setting("tts_voice_pack_enabled").unwrap(),
            Some(serde_json::json!(false))
        );
        assert_eq!(
            db.get_setting("tts_voice_route").unwrap(),
            Some(serde_json::json!("auto"))
        );
        assert!(!root.join(format!("{}.wav", sha_for(&source))).exists());
        cleanup_root(&root);
    }

    fn sha_for(path: &Path) -> String {
        let (_, sha) = hash_file(path).unwrap();
        sha
    }

    #[test]
    fn import_enforces_pack_asset_and_storage_limits() {
        let (db, pack, root) = db_and_pack();
        let source = root.join("incoming.wav");
        write_wav_sample(&source, 1, 127);
        for index in 0..MAX_PACK_ASSETS {
            let sha = format!("{:064x}", index + 100);
            let asset_id = format!("seed-{index}");
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO voice_assets (id,sha256,media_type,duration_ms,size_bytes,created_at) VALUES (?1,?2,'audio/wav',1000,1,'now')",
                    params![asset_id, sha],
                )?;
                conn.execute(
                    "INSERT INTO voice_pack_assets (pack_id,asset_id,display_name,created_at) VALUES (?1,?2,?2,'now')",
                    params![pack, asset_id],
                )?;
                Ok::<_, AppError>(())
            })
            .unwrap();
        }
        let over_count = import_voice_asset(&db, &root, &pack, &source);
        assert!(!over_count.ok);
        assert_eq!(over_count.code, "pack_asset_limit");

        let capacity_db = Db::open_in_memory().unwrap();
        let capacity_pack = create_voice_pack(&capacity_db, "容量包").unwrap();
        for index in 0..18 {
            let sha = format!("{:064x}", index + 1000);
            let asset_id = format!("capacity-{index}");
            capacity_db
                .with_conn(|conn| {
                    conn.execute(
                        "INSERT INTO voice_assets (id,sha256,media_type,duration_ms,size_bytes,created_at) VALUES (?1,?2,'audio/wav',1000,15728640,'now')",
                        params![asset_id, sha],
                    )?;
                    conn.execute(
                        "INSERT INTO voice_pack_assets (pack_id,asset_id,display_name,created_at) VALUES (?1,?2,?2,'now')",
                        params![capacity_pack, asset_id],
                    )?;
                    Ok::<_, AppError>(())
                })
                .unwrap();
        }
        let over_storage = import_voice_asset(&capacity_db, &root, &capacity_pack, &source);
        assert!(!over_storage.ok);
        assert_eq!(over_storage.code, "pack_storage_limit");
        cleanup_root(&root);
    }

    #[test]
    fn resolver_propagates_database_errors_instead_of_treating_them_as_unbound() {
        let (db, pack, root) = db_and_pack();
        db.set_setting("tts_voice_pack_id", serde_json::json!(pack))
            .unwrap();
        db.set_setting("tts_voice_pack_enabled", serde_json::json!(true))
            .unwrap();
        db.with_conn(|conn| {
            conn.execute_batch("DROP TABLE voice_bindings")?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        assert!(resolve_voice_clip(&db, &root, "agent_done").is_err());
        cleanup_root(&root);
    }

    #[test]
    fn asset_path_maps_missing_rows_to_not_found_and_propagates_database_errors() {
        let (db, _pack, root) = db_and_pack();
        let missing = voice_asset_path(&db, &root, "missing").unwrap_err();
        assert!(matches!(missing, AppError::NotFound(_)));

        db.with_conn(|conn| {
            conn.execute_batch("DROP TABLE voice_assets")?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let db_error = voice_asset_path(&db, &root, "missing").unwrap_err();
        assert!(matches!(db_error, AppError::Db(_)));
        cleanup_root(&root);
    }

    #[test]
    fn rejects_symlink_sources_and_oversize_before_import() {
        let (db, pack, root) = db_and_pack();
        let source = root.join("source.wav");
        write_wav(&source, 1);
        let store = root.clone();
        let mut invalid = root.join("bad.mp3");
        fs::copy(&source, &invalid).unwrap();
        let report = import_voice_asset(&db, &store, &pack, &invalid);
        assert!(!report.ok);
        assert_eq!(report.code, "decode_failed");
        invalid.set_extension("wav");
        fs::copy(&source, &invalid).unwrap();
        let report = import_voice_asset(&db, &store, &pack, &invalid);
        assert!(report.ok, "{}", report.code);
        let oversized = root.join("too-large.wav");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&oversized)
            .unwrap();
        file.set_len(MAX_ASSET_BYTES + 1).unwrap();
        drop(file);
        let report = import_voice_asset(&db, &store, &pack, &oversized);
        assert!(!report.ok);
        assert_eq!(report.code, "size_limit");
        cleanup_root(&root);
    }

    fn pending_cleanup(_db: &Db, _root: &Path) -> CleanupReport {
        CleanupReport {
            removed_files: 0,
            freed_bytes: 0,
            pending: true,
        }
    }

    #[test]
    fn delete_reports_cleanup_pending_and_retry_cleans_file() {
        let (db, pack, root) = db_and_pack();
        let source = root.join("pending.wav");
        write_wav(&source, 1);
        let imported = import_voice_asset(&db, &root, &pack, &source);
        assert!(imported.ok, "{}", imported.code);
        let sha = sha_for(&source);
        let managed = root.join(format!("{sha}.wav"));
        assert!(managed.exists());
        let result =
            delete_voice_pack_with_cleanup(&db, &root, &pack, pending_cleanup).unwrap();
        assert!(result.deleted);
        assert!(result.cleanup_pending);
        assert_eq!(result.cleanup_warning.as_deref(), Some("cleanup_pending"));
        assert_eq!(result.removed_assets, 1);
        assert!(!pack_exists(&db, &pack).unwrap());
        assert!(
            managed.exists(),
            "pending cleanup must keep the orphan file until retry"
        );
        assert!(source.exists(), "user source file must never be removed");
        let retry = cleanup_orphaned_files_report(&db, &root);
        assert!(!retry.pending);
        assert!(retry.freed_bytes > 0);
        assert!(!managed.exists());
        // Repeat delete keeps DB stable and returns NotFound without resurrecting data.
        assert!(delete_voice_pack(&db, &root, &pack).is_err());
        assert!(!pack_exists(&db, &pack).unwrap());
        cleanup_root(&root);
    }

    #[test]
    fn remove_asset_reports_result_and_preserves_shared_file() {
        let (db, first, root) = db_and_pack();
        let second = create_voice_pack(&db, "Second").unwrap();
        let source = root.join("shared.wav");
        write_wav(&source, 1);
        let a = import_voice_asset(&db, &root, &first, &source).asset.unwrap();
        import_voice_asset(&db, &root, &second, &source);
        let result = remove_voice_asset(&db, &root, &first, &a.id).unwrap();
        assert!(result.deleted);
        assert!(!result.cleanup_pending);
        assert_eq!(result.removed_assets, 0, "shared asset row must remain");
        assert!(voice_asset_path(&db, &root, &a.id).is_ok());
        cleanup_root(&root);
    }
}
