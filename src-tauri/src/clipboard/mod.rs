//! 智能剪贴板（v0.5）。
//!
//! 分层：
//! - `engine`：纯逻辑（类型判定、去重哈希、敏感过滤、自动分组决策）；
//! - `export`：图片另存为的原子写入（排他创建 / 临时文件安全替换）；
//! - `image`：PNG 编解码 / 缩略图 / DIB 转换（不触碰剪贴板）；
//! - `store`：SQLite 持久化与文件资产引用（文字入库、图片落文件）；
//! - `platform`：Windows 剪贴板读写与监听（唯一触碰 Win32 剪贴板的模块）；
//! - `paste`：逐项粘贴队列、剪贴板保护与失败审计；
//! - `agent_bridge`：剪贴板 → Agent 的本地导入包（不自动上传）。
//!
//! 安全原则：日志只记录类型/大小/计数，绝不记录内容；剪贴板正文只存在于本地库。

pub mod agent_bridge;
pub mod engine;
pub mod export;
pub mod image;
pub mod ocr;
pub mod paste;
pub mod platform;
pub mod store;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::db::Db;

pub const KIND_TEXT: &str = "text";
pub const KIND_URL: &str = "url";
pub const KIND_HTML: &str = "html";
pub const KIND_IMAGE: &str = "image";
pub const KIND_FILES: &str = "files";

/// 来源识别方式（`source_kind`）。
///
/// `owner` 只是 `GetClipboardOwner()` 记录的系统所有者窗口（谁登记了这份剪贴板），
/// 不保证就是用户实际执行复制的程序：后台脚本、进程间转发、历史重放都可能写入。
/// 拿不到所有者才回退前台窗口并记为 `foreground`（推断）。两者都不是“真实写入方”，
/// 必须分开记录并如实展示，不能把推断值说成准确来源。
pub const SOURCE_OWNER: &str = "owner";
pub const SOURCE_FOREGROUND: &str = "foreground";
pub const SOURCE_UNKNOWN: &str = "unknown";

/// 单条正文上限：超过不记录（避免把超大网页/日志拖垮内存与数据库）。
pub const MAX_TEXT_BYTES: usize = 512 * 1024;
pub const MAX_HTML_BYTES: usize = 512 * 1024;
/// 单张图片上限（解码前字节）。
pub const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
/// 图片边长上限：解码后的 RGBA 是 `边长²×4` 字节，必须先卡住再分配。
pub const MAX_IMAGE_EDGE: u32 = 20_000;
/// 像素总数上限（≈400MB RGBA）。PNG 容器能压缩到几十 KB，
/// 只按压缩前字节判断会让一张超大纯色图吃掉整块内存。
///
/// 注意与 `CONTENT_QUEUE_MAX_BYTES`（128MB）的口径差异：队列预算是**驻留**
/// 上限，超过时 `queue_weight_for` 会先丢掉解码后的 RGBA 再入队；这里是
/// **单次解码**上限，覆盖 8K/多屏拼接截图（7680×4320≈33.2M 像素，用例
/// `png_decode_refuses_dimensions_beyond_the_cap` 明确要求放行）。两者不叠加，
/// 峰值由本上限约束。
pub const MAX_IMAGE_PIXELS: u64 = 100_000_000;
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
    /// 来源识别方式：owner / foreground / unknown（见 SOURCE_* 常量）。
    pub source_kind: String,
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
    /// 展示标题：自动生成（≤30 字符）或手动编辑（≤80）；空串时前端回退 preview。
    pub title: String,
    /// none（旧记录）/ auto（采集时生成）/ manual（用户编辑，不被自动生成覆盖）
    pub title_source: String,
    pub byte_size: i64,
    pub source_app: String,
    pub source_title: String,
    /// 来源识别方式：owner / foreground / unknown；旧记录为 ""（未记录）。
    #[serde(default)]
    pub source_kind: String,
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
    /// 组内各内容类型的数量（列表/详情接口都填充，用于卡片类型化预览）。
    #[serde(default)]
    pub kind_counts: GroupKindCounts,
    /// 代表性图片条目（按组内顺序最多 3 条，只含轻量元数据，不含原图/正文）。
    #[serde(default)]
    pub cover_items: Vec<ClipboardItem>,
    /// 仅详情接口填充；列表接口为空
    #[serde(default)]
    pub items: Vec<ClipboardItem>,
}

/// 分组内容类型计数：卡片按类型渲染预览，不依赖加载全部条目。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct GroupKindCounts {
    #[serde(default)]
    pub image: i64,
    #[serde(default)]
    pub text: i64,
    #[serde(default)]
    pub html: i64,
    #[serde(default)]
    pub url: i64,
    #[serde(default)]
    pub files: i64,
}

impl GroupKindCounts {
    /// 按条目类型累加（详情接口从已加载条目直接统计）。
    pub fn add(&mut self, kind: &str) {
        match kind {
            KIND_IMAGE => self.image += 1,
            KIND_TEXT | "rich_text" => self.text += 1,
            KIND_HTML => self.html += 1,
            KIND_URL => self.url += 1,
            KIND_FILES => self.files += 1,
            _ => self.text += 1,
        }
    }

    pub fn total(&self) -> i64 {
        self.image + self.text + self.html + self.url + self.files
    }
}

/// 分组卡片展示的内容家族（由类型计数推导，前端与命名共用语义）。
impl GroupKindCounts {
    pub fn family(&self) -> &'static str {
        if self.image > 0 && self.total() > self.image {
            "mixed"
        } else if self.image > 0 {
            "image"
        } else if self.files > 0 && self.total() == self.files {
            "files"
        } else if self.files > 0 {
            "mixed"
        } else if self.url > 0 && self.total() == self.url {
            "link"
        } else if self.url > 0 {
            "mixed"
        } else {
            "text"
        }
    }
}

/// Lite 分组分页视图：只返回当页条目（不含完整正文与原图字节）。
///
/// 契约字段为 camelCase（`totalCount`/`imageCount`），与 `ClipboardItem`/`ClipboardGroup`
/// 既有的 snake_case 列表字段分开：前端只在该命令上使用 camelCase。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardGroupPage {
    /// 所属分组 id：并发切换分组时前端据此丢弃过期响应。
    pub group_id: String,
    pub items: Vec<ClipboardItem>,
    /// 组内全部条目数（不受 limit/imagesOnly 影响）。
    pub total_count: i64,
    /// 组内图片条目数（同样不受分页影响）。
    pub image_count: i64,
    /// 本次实际生效的 offset（负值归零）。
    pub offset: i64,
    /// 本次实际生效的 limit（超过上限时截断）。
    pub limit: i64,
    /// 组内容版本（计数 + 组更新时间 + 组内最近变更），供前端缓存键使用。
    pub revision: String,
}

/// 组内条目定位结果（`clipboard_group_item_position`）：Lite 原图预览在组内容变化后
/// 按图片 ID 恢复身份用，避免按旧序号回退成另一张图。
///
/// 字段风格与 `ClipboardGroupPage` 一致（camelCase）：
/// - 组不存在 → `AppError::NotFound`（前端据此退出预览），不返回本结构体；
/// - 条目不在组内或不是图片 → `found=false, index=null`，不报错。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardGroupItemPosition {
    /// 该条目是否仍是组内的图片条目。
    pub found: bool,
    /// 该条目在组内「图片条目」中的 0-based 序位；未找到时为 None。
    pub index: Option<i64>,
    /// 组内图片条目数（不受本次查询影响，与 `get_group_page` 同源）。
    pub image_count: i64,
    /// 组内全部条目数。
    pub total_count: i64,
    /// 组内容版本：与 `get_group_page` 完全相同的组合公式，供前端校验一致性。
    pub revision: String,
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
    /// 实际删除的分组数：`delete_group` 用它区分「分组不存在」与「删除成功」，
    /// 前端据此避免把不存在的分组当成成功删除来播放离场动画。
    pub groups_deleted: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CleanupReport {
    pub items_deleted: i64,
    pub groups_closed: i64,
    pub bytes_freed: i64,
    pub orphan_files_removed: i64,
}

/// 一键清空历史的执行结果。
#[derive(Debug, Clone, Serialize)]
pub struct ClearReport {
    pub items: i64,
    pub groups: i64,
    pub freed_bytes: i64,
    /// 数据库已清空但缓存未能清理的项数（含整个缓存目录读取失败）；下次清理会重试。
    pub failed_files: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CopyReport {
    /// text | html | image | files
    pub mode: String,
    pub bytes: i64,
    pub warnings: Vec<String>,
    pub sequence: u32,
    pub item_count: i64,
    /// 使用次数是否已落库。
    ///
    /// `false` 表示剪贴板**写入已成功**，只是使用次数统计持久化失败：前端应显示
    /// 「部分成功」并跳过本地次数累加（没落库的次数不能显示）。批量复制不累加
    /// 单条使用次数，此字段恒为 `true`，仅表示没有统计失败需要报告。
    pub stats_recorded: bool,
}

/// 剪贴板运行时：持有监听、粘贴管理与共享的自我写入序列号。
pub struct ClipboardRuntime {
    pub db: Arc<Db>,
    pub root: PathBuf,
    pub app: AppHandle,
    /// 本进程最后一次写剪贴板后的序列号；监听线程跳过 <= 该值的事件，
    /// 避免把自己的复制/逐项粘贴当成用户复制。
    pub self_write: Arc<AtomicU32>,
    /// 历史清空代数：采集事件在产生时记录代数，清空之前的事件/排队内容
    /// 不允许在清空之后回写历史。
    pub capture_epoch: Arc<AtomicU64>,
    /// 清空历史时刻的剪贴板序列号（0 = 从未清空）。代数在消息派发时盖章，
    /// 清空前入队的事件会拿到新代数；采集侧用该水位拦住清空前的旧内容。
    pub clear_seq: Arc<AtomicU32>,
    /// 清空与入库的文件/事务临界区：清空期间禁止入库线程写资产。
    pub capture_gate: Arc<Mutex<()>>,
    pub paste: paste::PasteManager,
    /// 图片文字识别：按需创建引擎、单任务闸门、会话内结果缓存（不常驻、不预热）。
    pub ocr: ocr::OcrService,
    monitor: Mutex<Option<platform::ClipboardMonitor>>,
    /// 维护线程代数：停止/重启时递增，旧线程看到代数变化即退出
    maintenance_gen: AtomicU64,
    /// 维护线程停止信号（Condvar 让 300s 轮询可被立即打断）
    maintenance_stop: Arc<(Mutex<bool>, Condvar)>,
    /// 仍存活的维护线程数量。只作为生命周期探针使用，不参与控制：
    /// 暂停后必须等它真正退出才能对外报告 `paused`，不能把「已发停止信号」
    /// 当成「资源已释放」。用计数而不是布尔：暂停后立刻恢复时旧线程可能
    /// 仍在收尾、新线程已启动，布尔会被旧线程退出错误置回 false。
    maintenance_alive: Arc<AtomicUsize>,
    /// 正在异步回收的采集实例数量（暂停不阻塞 UI，但状态必须等归零才算 paused）。
    capture_draining: Arc<AtomicUsize>,
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
            capture_epoch: Arc::new(AtomicU64::new(0)),
            clear_seq: Arc::new(AtomicU32::new(0)),
            capture_gate: Arc::new(Mutex::new(())),
            paste,
            ocr: ocr::OcrService::new(),
            monitor: Mutex::new(None),
            maintenance_gen: AtomicU64::new(0),
            maintenance_stop: Arc::new((Mutex::new(false), Condvar::new())),
            maintenance_alive: Arc::new(AtomicUsize::new(0)),
            capture_draining: Arc::new(AtomicUsize::new(0)),
        })
    }

    /// 启动监听与后台维护。监听失败只降级为「不自动记录」，不阻塞应用启动。
    pub fn start(self: &Arc<Self>) {
        self.start_monitor();
        self.start_maintenance();
    }

    /// 显式启动（应用启动 / 模块重新开启）。顺带清掉已退出的旧实例，
    /// 否则 `EVENT_QUEUE` 仍被占着，重启只会得到「监听已在运行」。
    fn start_monitor(&self) {
        let dead = {
            let mut guard = self.monitor.lock().unwrap_or_else(|e| e.into_inner());
            match guard.as_ref() {
                Some(m) if m.is_alive() => return,
                Some(_) => guard.take(),
                None => None,
            }
        };
        if let Some(m) = dead {
            tracing::warn!("剪贴板监听线程已退出，正在重新启动");
            m.stop();
        }
        self.spawn_monitor();
    }

    /// 实际创建监听实例；不处理旧实例，也不做重复检查。
    fn spawn_monitor(&self) -> bool {
        // 启动持续到「存进 monitor」为止，期间用户可能关闭模块（stop/set_enabled）；
        // 存实例前必须在同一把锁下复核世代，否则会留下已关闭却仍在监听的线程。
        let generation = self.maintenance_gen.load(Ordering::SeqCst);
        let sink = Arc::new(platform::CaptureSink {
            db: self.db.clone(),
            root: self.root.clone(),
            app: self.app.clone(),
            self_write: self.self_write.clone(),
            capture_epoch: self.capture_epoch.clone(),
            clear_seq: self.clear_seq.clone(),
            capture_gate: self.capture_gate.clone(),
        });
        match platform::ClipboardMonitor::start(sink) {
            Ok(m) => {
                let mut guard = self.monitor.lock().unwrap_or_else(|e| e.into_inner());
                if self.maintenance_gen.load(Ordering::SeqCst) != generation {
                    drop(guard);
                    m.stop();
                    tracing::info!("剪贴板监听启动期间模块已关闭，已回收新实例");
                    return false;
                }
                *guard = Some(m);
                tracing::info!("剪贴板监听已启动");
                true
            }
            Err(e) => {
                tracing::warn!("剪贴板监听启动失败（自动记录不可用）: {}", e);
                false
            }
        }
    }

    /// 看门狗：实例还在但线程已退出时重启；实例不存在时重试启动
    /// （首次启动失败或重启失败后不再永久放弃）。
    fn ensure_monitor(&self, generation: u64) {
        let (dead, had_instance) = {
            let mut guard = self.monitor.lock().unwrap_or_else(|e| e.into_inner());
            match guard.as_ref() {
                Some(m) if m.is_alive() => return,
                Some(_) => {
                    // 与 stop()/set_enabled() 竞争：世代已变说明用户已关闭模块，
                    // 不能再把监听拉起来。
                    if self.maintenance_gen.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    (guard.take(), true)
                }
                // 没有实例：可能是首次启动就失败，也可能是重启失败；
                // 维护线程只在模块开启时存在，因此这里可以安全重试。
                None => {
                    if self.maintenance_gen.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    (None, false)
                }
            }
        };
        if let Some(dead) = dead {
            tracing::warn!("检测到剪贴板监听线程已退出，正在重启");
            dead.stop();
        }
        if self.spawn_monitor() && had_instance {
            platform::note_monitor_restart();
        }
    }

    fn start_maintenance(self: &Arc<Self>) {
        // 幂等：当前已有一个在跑（停止位为 false）时直接返回，重复恢复/重复写设置
        // 不会反复重启维护线程。停止位为 true 说明上一代已被暂停回收，即使计数
        // 尚未归零也必须启动新一代（旧线程会因世代变化退出）。
        {
            let (lock, _) = &*self.maintenance_stop;
            let stopping = *lock.lock().unwrap_or_else(|e| e.into_inner());
            if self.maintenance_running() && !stopping {
                return;
            }
        }
        // 先让上一代退出，再启动新一代：
        // - 置停止位并唤醒等待中的旧线程，避免它睡满 30 秒才看到世代变化；
        // - 世代自增后，正在执行清理的旧线程也会在下一轮循环顶部的世代检查处退出。
        // 旧线程可能短暂与新线程并存（正在清理时），但它不会再做第二轮工作，
        // 也不会把监听实例写回（spawn_monitor 只有持有最新世代才能存实例）。
        {
            let (lock, cv) = &*self.maintenance_stop;
            *lock.lock().unwrap_or_else(|e| e.into_inner()) = true;
            cv.notify_all();
        }
        let generation = self.maintenance_gen.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let (lock, cv) = &*self.maintenance_stop;
            *lock.lock().unwrap_or_else(|e| e.into_inner()) = false;
            cv.notify_all();
        }
        let stop = self.maintenance_stop.clone();
        let alive = self.maintenance_alive.clone();
        let thread_alive = alive.clone();
        let runtime = Arc::clone(self);
        // 线程启动失败时不能让探针一直显示“运行中”。
        self.maintenance_alive.fetch_add(1, Ordering::SeqCst);
        let spawned = std::thread::Builder::new()
            .name("clipboard-maintenance".into())
            .spawn(move || {
                // 所有退出路径（含 panic 展开）都必须把运行探针置回 false，
                // 否则暂停请求会永远停在 pausing。
                struct AliveGuard(Arc<AtomicUsize>);
                impl Drop for AliveGuard {
                    fn drop(&mut self) {
                        self.0.fetch_sub(1, Ordering::SeqCst);
                    }
                }
                let _alive = AliveGuard(thread_alive);
                if wait_or_stop_gen(
                    &stop,
                    &runtime.maintenance_gen,
                    generation,
                    Duration::from_secs(8),
                ) {
                    return;
                }
                // 首轮立即巡检一次（与原 8s 后清理的行为一致），之后每 5 分钟清理、
                // 每 30 秒做一次监听健康检查。健康检查必须比清理更频繁，
                // 否则监听线程异常退出后要等数分钟才恢复。
                let mut next_cleanup = std::time::Instant::now();
                loop {
                    if runtime.maintenance_gen.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    runtime.ensure_monitor(generation);
                    // 模块关闭/暂停期间不再执行清理与巡检；配置不可靠时也必须停手，
                    // 避免按错误的容量/保留参数删除历史数据。
                    let config = crate::db::Settings::load_clipboard(&runtime.db);
                    if config.error.is_none()
                        && config.settings.clipboard_enabled
                        && !config.settings.clipboard_paused
                        && std::time::Instant::now() >= next_cleanup
                    {
                        next_cleanup =
                            std::time::Instant::now() + Duration::from_secs(300);
                        // 粘贴进行中不做清理：删除条目/资产会让正在发送的素材
                        // 在下一项读取时消失，宁可推迟到下一轮。
                        if !runtime.paste.is_active() {
                            let _ = store::interrupt_stale_paste_jobs(&runtime.db);
                            // 与采集入库/清空互斥：入库线程先写资产文件再插库，
                            // 清理若在两步之间扫目录，会把新采集的图片当成孤儿删掉。
                            let _gate = runtime
                                .capture_gate
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            match store::cleanup(&runtime.db, &runtime.root, &config.settings) {
                                Ok(r) => {
                                    // 自动过期/超额清理后校正 OCR 缓存：已删除或内容变化的条目不再命中；
                                    // 实际删除了条目时即使缓存为空也推进代数，避免在跑的旧任务回写。
                                    runtime.ocr.retain_existing(&runtime.db, r.items_deleted > 0);
                                    if r.items_deleted > 0
                                        || r.groups_closed > 0
                                        || r.orphan_files_removed > 0
                                    {
                                        tracing::info!(
                                            "剪贴板清理：条目 {}，关闭分组 {}，释放 {} 字节，孤儿文件 {}",
                                            r.items_deleted,
                                            r.groups_closed,
                                            r.bytes_freed,
                                            r.orphan_files_removed
                                        );
                                        let _ = runtime.app.emit(
                                            "clipboard-changed",
                                            serde_json::json!({ "kind": "cleanup" }),
                                        );
                                    }
                                }
                                Err(e) => tracing::warn!("剪贴板清理失败: {}", e),
                            }
                        }
                    }
                    if wait_or_stop_gen(
                        &stop,
                        &runtime.maintenance_gen,
                        generation,
                        Duration::from_secs(30),
                    ) {
                        return;
                    }
                }
            });
        if let Err(e) = spawned {
            self.maintenance_alive.fetch_sub(1, Ordering::SeqCst);
            tracing::warn!("剪贴板维护线程启动失败: {}", e);
        }
    }

    /// 模块级启停：关闭时停止监听、维护线程与进行中的粘贴；重新开启后恢复。
    pub fn set_enabled(self: &Arc<Self>, enabled: bool) {
        if enabled {
            self.start_monitor();
            self.start_maintenance();
        } else {
            self.stop();
        }
    }

    /// 让运行时与已持久化的配置收敛（幂等）。
    ///
    /// 三个维度必须分开：
    /// - `enabled=false`：长期停用 —— 停止采集并取消进行中的逐项粘贴（既有语义）；
    /// - `enabled=true && paused=true`：暂时暂停 —— 只回收采集侧线程，**不打断**
    ///   用户已经发起的复制/粘贴；
    /// - `enabled=true && paused=false`：恢复采集（重复调用不会留下第二套线程）。
    ///
    /// 停用也走异步采集回收：设置命令是同步 IPC，不能因为采集线程正在解码大图
    /// 而 join 阻塞 UI；粘贴取消本身只置取消位，不等待线程结束。真正需要等待
    /// 线程收尾的只有应用退出（`shutdown`），那里仍走同步 `stop()`。
    pub fn apply_config(self: &Arc<Self>, enabled: bool, paused: bool) {
        if !enabled {
            self.stop_capture();
            self.paste.cancel_all();
        } else if paused {
            self.stop_capture();
        } else {
            self.start_monitor();
            self.start_maintenance();
        }
    }

    /// 仅停止采集侧（监听线程 + 维护线程），保留粘贴队列。
    ///
    /// 与 `stop()` 的边界：暂停/恢复不应取消用户显式发起的批量粘贴，也不应
    /// 清空粘贴任务；这里只回收采集与维护资源。删除历史、清空等只读/写入
    /// 历史的能力仍然可用。
    ///
    /// 实现为**异步回收**：`ClipboardMonitor::stop()` 会 join 采集/入库线程，
    /// 而采集线程可能正在解码一张大图（最长边 2 万像素）或写图片资产。同步
    /// join 会让暂停点击阻塞 UI 线程；这里把实例从槽位移除后交给独立线程收尾，
    /// 由 `capture_draining()` 计数如实报告 `pausing`。
    pub fn stop_capture(self: &Arc<Self>) {
        // 先置维护停止位：与并发恢复的 `start_maintenance()` 相比，这个顺序保证
        // 恢复方看到 stopping=true，一定会启动新一代维护线程（否则旧线程退出后
        // 会没有看门狗）。旧线程自身通过世代变化退出。
        self.signal_maintenance_stop();
        // 世代递增必须在 monitor 锁内：否则「取空实例 → 释放锁 → 递增世代」之间，
        // 正在启动的 spawn_monitor 会复核到旧世代并把新实例存进来，留下已关闭
        // 却仍在监听的线程。
        let taken = {
            let mut guard = self.monitor.lock().unwrap_or_else(|e| e.into_inner());
            self.maintenance_gen.fetch_add(1, Ordering::SeqCst);
            guard.take()
        };
        if let Some(mut m) = taken {
            // 先同步摘掉全局事件槽并通知消息循环退出：恢复请求可以立刻创建新实例，
            // 不会因为旧实例还占着 EVENT_QUEUE 而启动失败。join 留给回收线程。
            m.begin_stop();
            self.capture_draining.fetch_add(1, Ordering::SeqCst);
            let draining = self.capture_draining.clone();
            let spawned = std::thread::Builder::new()
                .name("clipboard-stop".into())
                .spawn(move || {
                    struct DrainGuard(Arc<AtomicUsize>);
                    impl Drop for DrainGuard {
                        fn drop(&mut self) {
                            self.0.fetch_sub(1, Ordering::SeqCst);
                        }
                    }
                    let _guard = DrainGuard(draining);
                    m.finish_stop();
                });
            if let Err(e) = spawned {
                // 创建回收线程失败：闭包（含 m）被丢弃时 ClipboardMonitor 的 Drop
                // 会同步完成收尾，绝不留下已摘槽却仍在监听的孤儿线程。
                tracing::warn!("剪贴板回收线程创建失败，Drop 兜底同步停止: {}", e);
                self.capture_draining.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }

    /// 置维护线程停止位并立即唤醒等待（30s 轮询不必睡满）。
    fn signal_maintenance_stop(&self) {
        let (lock, cv) = &*self.maintenance_stop;
        *lock.lock().unwrap_or_else(|e| e.into_inner()) = true;
        cv.notify_all();
    }

    /// 同步停止采集侧。仅用于应用退出/模块长期停用等必须确认线程已回收的路径；
    /// 暂停走 `stop_capture()` 的异步回收，避免阻塞 UI。
    fn stop_capture_sync(&self) {
        self.signal_maintenance_stop();
        let taken = {
            let mut guard = self.monitor.lock().unwrap_or_else(|e| e.into_inner());
            self.maintenance_gen.fetch_add(1, Ordering::SeqCst);
            guard.take()
        };
        if let Some(m) = taken {
            m.stop();
        }
    }

    /// 停止监听（应用退出、模块关闭或测试用）。会取消进行中的粘贴任务。
    pub fn stop(&self) {
        self.stop_capture_sync();
        self.paste.cancel_all();
    }

    /// 应用退出前的完整收尾：停止监听线程，并等待粘贴工作线程结束。
    ///
    /// 与 `stop()` 的区别是「等待」：退出时若还有粘贴线程在写剪贴板，
    /// 进程被杀会留下运行中的任务与被残留内容覆盖的用户剪贴板。
    /// 返回 true 表示粘贴线程已在时限内收尾。
    pub fn shutdown(&self, timeout: Duration) -> bool {
        self.stop();
        self.paste.stop(timeout)
    }

    /// 监听线程是否在运行（启动失败、线程退出但尚未被看门狗重启时均为 false）。
    pub fn monitoring(&self) -> bool {
        self.monitor
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|m| m.is_alive())
    }

    /// 维护线程是否仍在运行（暂停后据此如实报告 pausing；不代表监听可用）。
    pub fn maintenance_running(&self) -> bool {
        self.maintenance_alive.load(Ordering::SeqCst) > 0
    }

    /// 是否有采集实例正在异步回收（暂停不阻塞 UI，但状态必须等回收完成）。
    pub fn capture_draining(&self) -> bool {
        self.capture_draining.load(Ordering::SeqCst) > 0
    }

    /// 记录一次自写序列号（仅供无法使用 `write_payload_notifying` 的调用方；
    /// 常规复制/粘贴/恢复都应在访问锁内完成写入与登记）。
    pub fn note_self_write(&self, sequence: u32) {
        platform::note_self_write_watermark(&self.self_write, sequence);
    }

    pub fn emit_changed(&self, kind: &str) {
        let _ = self
            .app
            .emit("clipboard-changed", serde_json::json!({ "kind": kind }));
    }
}

/// 可被停止信号或世代变化立即打断的等待；返回 true 表示必须退出。
///
/// 同时监听世代的原因是「暂停后立刻恢复」：停止位会被新一代重置为 false，
/// 只检查停止位的旧线程会继续睡满 30 秒；世代变化能保证它在唤醒后立即退出，
/// 不会与新线程长期并存。
fn wait_or_stop_gen(
    stop: &Arc<(Mutex<bool>, Condvar)>,
    generation_now: &AtomicU64,
    generation: u64,
    dur: Duration,
) -> bool {
    let (lock, cv) = &**stop;
    let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let (guard, _) = cv
        .wait_timeout_while(guard, dur, |stopped| {
            !*stopped && generation_now.load(Ordering::SeqCst) == generation
        })
        .unwrap_or_else(|e| e.into_inner());
    *guard || generation_now.load(Ordering::SeqCst) != generation
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn stop_signal_wakes_maintenance_wait_immediately() {
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let generation = Arc::new(AtomicU64::new(1));
        let waiter = stop.clone();
        let gen_waiter = generation.clone();
        let begin = Instant::now();
        let handle = std::thread::spawn(move || {
            wait_or_stop_gen(&waiter, &gen_waiter, 1, Duration::from_secs(30))
        });
        std::thread::sleep(Duration::from_millis(50));
        {
            let (lock, cv) = &*stop;
            *lock.lock().unwrap() = true;
            cv.notify_all();
        }
        assert!(handle.join().unwrap(), "停止后应返回 true");
        assert!(
            begin.elapsed() < Duration::from_secs(2),
            "维护线程必须被立即唤醒，而不是等满 30s"
        );
    }

    #[test]
    fn wait_times_out_without_stop_signal() {
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let generation = AtomicU64::new(1);
        let begin = Instant::now();
        assert!(!wait_or_stop_gen(
            &stop,
            &generation,
            1,
            Duration::from_millis(20)
        ));
        assert!(begin.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn generation_change_wakes_old_maintenance_thread_on_resume() {
        // 暂停后立刻恢复：停止位被新一代重置为 false，旧线程必须靠世代变化退出，
        // 不能继续睡满 30 秒后才发现自己已是上一代。
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let generation = Arc::new(AtomicU64::new(1));
        let waiter = stop.clone();
        let gen_waiter = generation.clone();
        let begin = Instant::now();
        let handle = std::thread::spawn(move || {
            wait_or_stop_gen(&waiter, &gen_waiter, 1, Duration::from_secs(30))
        });
        std::thread::sleep(Duration::from_millis(50));
        generation.store(2, Ordering::SeqCst);
        {
            let (lock, cv) = &*stop;
            *lock.lock().unwrap() = false;
            cv.notify_all();
        }
        assert!(handle.join().unwrap(), "世代变化后旧线程必须退出");
        assert!(begin.elapsed() < Duration::from_secs(2));
    }
}
