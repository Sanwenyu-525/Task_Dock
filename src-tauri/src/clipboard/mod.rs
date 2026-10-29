//! 智能剪贴板（v0.5）。
//!
//! 分层：
//! - `engine`：纯逻辑（类型判定、去重哈希、敏感过滤、自动分组决策）；
//! - `image`：PNG 编解码 / 缩略图 / DIB 转换（不触碰剪贴板）；
//! - `store`：SQLite 持久化与文件资产引用（文字入库、图片落文件）；
//! - `platform`：Windows 剪贴板读写与监听（唯一触碰 Win32 剪贴板的模块）；
//! - `paste`：逐项粘贴队列、剪贴板保护与失败审计；
//! - `agent_bridge`：剪贴板 → Agent 的本地导入包（不自动上传）。
//!
//! 安全原则：日志只记录类型/大小/计数，绝不记录内容；剪贴板正文只存在于本地库。

pub mod agent_bridge;
pub mod engine;
pub mod image;
pub mod paste;
pub mod platform;
pub mod store;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::db::Db;

pub const KIND_TEXT: &str = "text";
pub const KIND_URL: &str = "url";
pub const KIND_HTML: &str = "html";
pub const KIND_IMAGE: &str = "image";
pub const KIND_FILES: &str = "files";

/// 单条正文上限：超过不记录（避免把超大网页/日志拖垮内存与数据库）。
pub const MAX_TEXT_BYTES: usize = 512 * 1024;
pub const MAX_HTML_BYTES: usize = 512 * 1024;
/// 单张图片上限（解码前字节）。
pub const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
/// 单次复制的文件数上限。
pub const MAX_FILE_COUNT: usize = 200;
/// 缩略图最长边。
pub const THUMB_MAX_EDGE: u32 = 192;
/// 自动分组单组条数上限（防止一次长时间截图会话无限膨胀）。
pub const MAX_AUTO_GROUP_ITEMS: usize = 300;

/// 平台读取到的一份剪贴板内容（尚未落库）。
#[derive(Debug, Clone)]
pub struct CapturedContent {
    pub kind: String,
    pub text: String,
    pub html: String,
    pub preview: String,
    pub file_paths: Vec<String>,
    pub image: Option<CapturedImage>,
    pub source_app: String,
    pub source_title: String,
    pub byte_size: i64,
}

#[derive(Debug, Clone)]
pub struct CapturedImage {
    /// 原始 PNG 字节（落盘保留）
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// 解码后的 RGBA（用于生成缩略图与 DIB；避免二次解码）
    pub rgba: Vec<u8>,
}

/// 历史条目（前端 DTO）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardItem {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub html: String,
    pub preview: String,
    pub byte_size: i64,
    pub source_app: String,
    pub source_title: String,
    pub image_width: Option<u32>,
    pub image_height: Option<u32>,
    pub file_paths: Vec<String>,
    pub favorite: bool,
    pub pinned: bool,
    pub copy_count: i64,
    pub created_at: String,
    pub last_seen_at: String,
    pub has_image: bool,
    pub has_thumb: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClipboardGroup {
    pub id: String,
    pub name: String,
    /// auto | manual
    pub mode: String,
    /// collecting | closed
    pub status: String,
    pub favorite: bool,
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
    pub item_count: i64,
    pub image_count: i64,
    pub preview: String,
    /// 仅详情接口填充；列表接口为空
    #[serde(default)]
    pub items: Vec<ClipboardItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClipboardStats {
    pub items: i64,
    pub groups: i64,
    pub images: i64,
    pub files: i64,
    pub favorites: i64,
    pub bytes: i64,
    pub asset_bytes: i64,
    pub max_items: i64,
    pub max_storage_bytes: i64,
    pub enabled: bool,
    pub paused: bool,
    pub auto_group: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClipboardView {
    pub items: Vec<ClipboardItem>,
    pub groups: Vec<ClipboardGroup>,
    pub stats: ClipboardStats,
    pub total_items: i64,
}

/// 写入结果：`created=false` 表示命中去重，只更新了使用次数。
#[derive(Debug, Clone, Serialize)]
pub struct CaptureOutcome {
    pub item: ClipboardItem,
    pub created: bool,
    pub group_id: Option<String>,
    pub skipped_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeleteReport {
    pub deleted: i64,
    pub freed_bytes: i64,
    /// 因仍被其他分组/任务引用而保留的条目数
    pub retained_shared: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CleanupReport {
    pub items_deleted: i64,
    pub groups_closed: i64,
    pub bytes_freed: i64,
    pub orphan_files_removed: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CopyReport {
    /// text | html | image | files
    pub mode: String,
    pub bytes: i64,
    pub warnings: Vec<String>,
    pub sequence: u32,
    pub item_count: i64,
}

/// 剪贴板运行时：持有监听、粘贴管理与共享的自我写入序列号。
pub struct ClipboardRuntime {
    pub db: Arc<Db>,
    pub root: PathBuf,
    pub app: AppHandle,
    /// 本进程最后一次写剪贴板后的序列号；监听线程跳过 <= 该值的事件，
    /// 避免把自己的复制/逐项粘贴当成用户复制。
    pub self_write: Arc<AtomicU32>,
    pub paste: paste::PasteManager,
    monitor: Mutex<Option<platform::ClipboardMonitor>>,
}

impl ClipboardRuntime {
    pub fn new(db: Arc<Db>, root: PathBuf, app: AppHandle) -> Arc<Self> {
        let _ = std::fs::create_dir_all(root.join("images"));
        let _ = std::fs::create_dir_all(root.join("thumbs"));
        let self_write = Arc::new(AtomicU32::new(platform::current_sequence()));
        let paste =
            paste::PasteManager::new(db.clone(), root.clone(), app.clone(), self_write.clone());
        Arc::new(Self {
            db,
            root,
            app,
            self_write,
            paste,
            monitor: Mutex::new(None),
        })
    }

    /// 启动监听与后台维护。监听失败只降级为「不自动记录」，不阻塞应用启动。
    pub fn start(self: &Arc<Self>) {
        let sink = Arc::new(platform::CaptureSink {
            db: self.db.clone(),
            root: self.root.clone(),
            app: self.app.clone(),
            self_write: self.self_write.clone(),
        });
        match platform::ClipboardMonitor::start(sink) {
            Ok(m) => {
                tracing::info!("剪贴板监听已启动");
                *self.monitor.lock().unwrap_or_else(|e| e.into_inner()) = Some(m);
            }
            Err(e) => {
                tracing::warn!("剪贴板监听启动失败（自动记录不可用）: {}", e);
            }
        }
        // 启动维护：关闭残留的收集会话、标记中断的粘贴任务、清理过期内容
        let db = self.db.clone();
        let root = self.root.clone();
        let app = self.app.clone();
        let runtime = Arc::clone(self);
        std::thread::Builder::new()
            .name("clipboard-maintenance".into())
            .spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(8));
                loop {
                    let settings = crate::db::Settings::load(&db).unwrap_or_default();
                    // 本进程正在逐项粘贴时不判定为「陈旧任务」
                    if !runtime.paste.is_active() {
                        let _ = store::interrupt_stale_paste_jobs(&db);
                    }
                    match store::cleanup(&db, &root, &settings) {
                        Ok(r)
                            if r.items_deleted > 0
                                || r.groups_closed > 0
                                || r.orphan_files_removed > 0 =>
                        {
                            tracing::info!(
                                "剪贴板清理：条目 {}，关闭分组 {}，释放 {} 字节，孤儿文件 {}",
                                r.items_deleted,
                                r.groups_closed,
                                r.bytes_freed,
                                r.orphan_files_removed
                            );
                            let _ = app.emit(
                                "clipboard-changed",
                                serde_json::json!({ "kind": "cleanup" }),
                            );
                        }
                        Ok(_) => {}
                        Err(e) => tracing::warn!("剪贴板清理失败: {}", e),
                    }
                    std::thread::sleep(std::time::Duration::from_secs(300));
                }
            })
            .ok();
    }

    /// 停止监听（应用退出或测试用）。
    pub fn stop(&self) {
        if let Some(m) = self
            .monitor
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            m.stop();
        }
        self.paste.cancel_all();
    }

    /// 监听线程是否在运行（启动失败时降级为 false）。
    pub fn monitoring(&self) -> bool {
        self.monitor
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    /// 记录一次用户复制（供命令层在写入后同步序列号，避免自录）。
    pub fn note_self_write(&self, sequence: u32) {
        self.self_write.fetch_max(sequence, Ordering::SeqCst);
    }

    pub fn emit_changed(&self, kind: &str) {
        let _ = self
            .app
            .emit("clipboard-changed", serde_json::json!({ "kind": kind }));
    }
}
