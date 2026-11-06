//! 应用自身可回收内存的**可测量目录**与释放。
//!
//! 边界（产品硬约束）：
//! - 只释放本进程自己持有、且能按需重建的缓存：合成语音内存缓冲、应用图标内存缓存；
//! - 不调用 Windows 工作集裁剪（`EmptyWorkingSet` / `SetProcessWorkingSetSize`），
//!   不强制 GC、不清系统文件缓存、不结束任何进程；
//! - 释放前后都按同一口径统计，返回**实际**释放的字节数；无对象时返回 0 并由前端
//!   显示「当前没有可安全释放的应用缓存」，绝不显示无操作的「一键释放」。

use serde::Serialize;

use crate::audio::AudioService;
use crate::navigation::app_icons;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySource {
    /// 稳定 ID（前端按 ID 取文案）。
    pub id: String,
    pub entries: u64,
    pub bytes: u64,
    /// `available` | `empty`
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCatalog {
    pub sampled_at: String,
    pub sources: Vec<MemorySource>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReleaseSource {
    pub id: String,
    pub entries: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReleaseReport {
    pub sampled_at: String,
    pub released_bytes: u64,
    pub sources: Vec<MemoryReleaseSource>,
}

fn source(id: &str, entries: usize, bytes: usize) -> MemorySource {
    MemorySource {
        id: id.into(),
        entries: entries as u64,
        bytes: bytes as u64,
        status: if entries > 0 { "available" } else { "empty" }.into(),
    }
}

/// 只读统计当前可回收的应用缓存。不修改任何状态。
pub fn catalog(audio: &AudioService) -> MemoryCatalog {
    let (tts_entries, tts_bytes) = audio.mem_cache_stats();
    let (icon_entries, icon_bytes) = app_icons::icon_cache_stats();
    let sources = vec![
        source("tts_memory", tts_entries, tts_bytes),
        source("app_icons", icon_entries, icon_bytes),
    ];
    MemoryCatalog {
        sampled_at: chrono::Utc::now().to_rfc3339(),
        total_bytes: sources.iter().map(|s| s.bytes).sum(),
        sources,
    }
}

/// 释放可回收缓存，返回每项实际释放量。
///
/// 只清空缓存副本：磁盘上的 TTS 缓存走资源清理的预览/确认流程；图标按需重新提取；
/// 正在播放/返回中的语音缓冲由 `Arc` 单独持有，不会被中断。
pub fn release(audio: &AudioService) -> MemoryReleaseReport {
    let (tts_entries, tts_bytes) = audio.clear_mem_cache();
    let (icon_entries, icon_bytes) = app_icons::clear_icon_cache();
    let sources = vec![
        MemoryReleaseSource {
            id: "tts_memory".into(),
            entries: tts_entries as u64,
            bytes: tts_bytes as u64,
        },
        MemoryReleaseSource {
            id: "app_icons".into(),
            entries: icon_entries as u64,
            bytes: icon_bytes as u64,
        },
    ];
    MemoryReleaseReport {
        sampled_at: chrono::Utc::now().to_rfc3339(),
        released_bytes: sources.iter().map(|s| s.bytes).sum(),
        sources,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_service_reports_no_reclaimable_sources() {
        let audio = AudioService::new(None);
        let catalog = catalog(&audio);
        assert_eq!(catalog.sources.len(), 2);
        assert!(catalog.sources.iter().all(|s| s.status == "empty"));
        assert_eq!(catalog.total_bytes, 0);
    }

    #[test]
    fn release_on_empty_cache_is_a_no_op() {
        let audio = AudioService::new(None);
        let report = release(&audio);
        assert_eq!(report.released_bytes, 0);
        assert!(report.sources.iter().all(|s| s.entries == 0 && s.bytes == 0));
    }
}
