//! 通用跨应用拖入：统一载荷模型、Windows OLE 接收桥、内容暂存与提交。
//!
//! 为什么需要这一层（现状问题，不是「再加一个兜底」）：
//! - `tauri` 在 Windows 上的原生拖入由 wry 的 `IDropTarget` 承载
//!   （wry 0.57.1 `webview2/drag_drop.rs`）：它在窗口**及全部子窗口**上
//!   `RevokeDragDrop` + `RegisterDragDrop`，处理器只读 `CF_HDROP`；
//!   `DragEnter` 拿不到 `CF_HDROP` 时直接 `return Ok(())` 并给
//!   `DROPEFFECT_NONE`，`Drop` 也不会回调监听者。也就是说：网页图片、
//!   URL、文本、虚拟文件在**事件层就被吞掉**，前端既收不到回调，也没有任何诊断。
//! - wry 同时调用了 `SetAllowExternalDrop(false)`（WebView2 内部拖放被关闭），
//!   所以 HTML5 `drop` 事件也不会触发，两条路都断。
//!
//! 本模块的做法：**保留原生 OLE 路径，把它整体接管**。
//! 1. 在 WebView 创建完成后，于主窗口及其全部子窗口上安装自己的
//!    `IDropTarget`（`windows_ole`），替换 wry 那个只认路径的处理器；
//!    安装失败时**不撤销** wry 的注册，行为退化到「只能拖入本地路径」，
//!    与今天一致（fail-safe，绝不让拖入彻底失效）。
//! 2. `DragEnter/DragOver/Leave/Drop` 把 OLE 数据对象按类型分类
//!    （`classify`），并在**同一次 `Drop` 调用内**读取所有 `GetData`
//!    （OLE 契约：数据对象只在 Drop 返回前有效，延后读是不安全的）。
//! 3. 字节、虚拟文件流、图片落到**暂存区**（`stage`），前端只拿
//!    `operation_id` 与有界预览，不传大块 Base64、也不传后端路径。
//! 4. 提交时按落点语义分流（`commit`）：最近暂存 → 复用既有
//!    `shelf::add_*` / `add_managed*`；目录卡片 → 复用既有 `fsops::drop_paths`
//!    的复制/移动语义，暂存内容另走「流式复制 + 原子改名」。
//!
//! 边界（与既有架构的分工，不重复建设）：
//! - 不新建第二套暂存存储：条目仍由 `shelf` 模块入库；
//! - 不改拖入仲裁：谁能接收仍由前端 `lib/fileDrop` 单消费者决定；
//! - 不碰拖出：`shelf::drag_out` 的 `DoDragDrop` 数据源与这里无关；
//! - 不把 URL 当路径、不把临时路径当稳定存储：暂存内容一律落独立副本。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
pub mod commit;
pub mod classify;
pub mod codes;
pub mod names;
pub mod payload;
pub mod stage;
pub mod text;
pub mod virtual_files;
#[cfg(windows)]
pub mod windows_ole;
pub use classify::DragFacts;
pub use codes::*;
pub use payload::*;

// 平台无关的入口：`lib.rs` 不需要知道 Windows 细节，也不需要 `cfg` 分支。
#[cfg(windows)]
pub use windows_ole::{bridge_active, install as install_native_bridge, report_install_failure};

/// 非 Windows 平台没有 OLE 拖入桥：返回 false 让前端继续走 Tauri 内置事件。
#[cfg(not(windows))]
pub fn bridge_active() -> bool {
    false
}

#[cfg(not(windows))]
pub fn install_native_bridge(
    _app: &tauri::AppHandle,
    _label: &str,
    _hwnd: isize,
    _state: Arc<DragDropState>,
) -> Result<usize, String> {
    Err("仅 Windows 支持原生拖入接收桥".into())
}

#[cfg(not(windows))]
pub fn report_install_failure(_error: &str) {}

// ── 资源上限（一次拖入的硬边界，全部在这里集中定义） ──────────

/// 单次拖入最多处理的条目数（本地文件另有 `MAX_LOCAL_PATHS`，与暂存架单批上限一致）。
pub const MAX_ITEMS: usize = 32;
/// 单次拖入最多接受的本地路径数：与 `shelf_add_paths` 的 500 条上限保持一致，
/// 超过就不该在拖入通道里新编一个上限，交给既有命令报错。
pub const MAX_LOCAL_PATHS: usize = 500;
/// 纯文本上限：与 `shelf::MAX_TEXT_BYTES`（512KB）对齐，避免「收下了却存不进」。
pub const MAX_TEXT_BYTES: usize = 512 * 1024;
/// HTML Format 读取上限：只用于提取文本与首个图片地址，不保留富文本。
pub const MAX_HTML_BYTES: usize = 1024 * 1024;
/// 单张图片字节上限（PNG 或 DIB 原始字节）：超过直接拒绝并给出明确错误码。
pub const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
/// 虚拟文件单条上限：与 `shelf::MAX_MANAGED_FILE_BYTES`（2GB）一致。
pub const MAX_VIRTUAL_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 虚拟文件单次总量上限：避免 Outlook 多附件拖入时把磁盘写满。
pub const MAX_VIRTUAL_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// 暂存会话存活时间：超过即视为放弃（前端关闭面板 / 用户取消）。
pub const STAGE_TTL: Duration = Duration::from_secs(10 * 60);
/// 同时存在的暂存会话上限：防止反复拖入把临时目录堆积起来。
pub const MAX_STAGE_OPS: usize = 8;
/// 提交时等待虚拟文件读取完成的上限：超时按读取失败处理，不无限挂住 IPC。
pub const COMMIT_WAIT: Duration = Duration::from_secs(20);
/// `DragOver` 事件的最小间隔：OLE 每次鼠标移动都会回调，不节流会把 IPC 打满。
pub const OVER_THROTTLE: Duration = Duration::from_millis(50);

/// 事件名：与 Tauri 内置的 `tauri://drag-*` 并列，不改既有事件语义。
pub const EVENT_PROBE: &str = "taskdock://drag-probe";
/// 松手瞬间的受理回执（含 `operationId` 与落点），让 UI 立刻进入「读取中」。
pub const EVENT_ACCEPTED: &str = "taskdock://drag-accepted";
/// 暂存完成后的载荷（只含条数/预览/大小，不含字节）。
pub const EVENT_PAYLOAD: &str = "taskdock://drag-payload";

// ── 暂存区 ─────────────────────────────────────────────────

/// 一条已暂存（或仅引用）的载荷条目。**只允许后端读取**，前端拿不到路径。
#[derive(Debug, Clone)]
pub enum StagedItem {
    /// 真实本地文件/文件夹：不做复制，保持既有「引用 or 托管」语义。
    LocalPath { path: String },
    /// 已落到暂存区的独立副本（虚拟文件、图片字节）。
    Staged {
        path: PathBuf,
        name: String,
        size: u64,
        kind: StagedKind,
        mime: Option<String>,
        width: Option<u32>,
        height: Option<u32>,
    },
    Text { text: String, from_html: bool },
    Url { url: String, is_image: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StagedKind {
    VirtualFile,
    Image,
}

impl StagedKind {
    pub fn as_str(self) -> &'static str {
        match self {
            StagedKind::VirtualFile => "virtual-file",
            StagedKind::Image => "image",
        }
    }
}

/// 暂存会话阶段。
#[derive(Debug, Clone, PartialEq)]
pub enum OpPhase {
    /// 已受理，后台仍在读取（虚拟文件流）。
    Reading,
    Ready,
    Failed,
}

#[derive(Debug)]
pub struct OpInner {
    pub phase: OpPhase,
    pub items: Vec<StagedItem>,
    pub failures: Vec<PayloadFailure>,
    /// 分类阶段得到的视图（Drop 时确定）；暂存完成后用真实条目补全。
    pub base_view: Option<DragPayloadView>,
    /// 最终视图（`Ready`/`Failed` 时可读）。
    pub view: Option<DragPayloadView>,
    /// 被忽略的条目数（超量、无法读取），用于如实上报「部分成功」。
    pub skipped: usize,
    pub finished_at: Option<Instant>,
}

#[derive(Debug)]
pub struct StagedOp {
    pub id: String,
    pub created_at: Instant,
    pub point: Option<(i32, i32)>,
    pub probe: DragProbe,
    /// 暂存目录（只有 `Staged` 条目会用到；文本/本地路径不需要磁盘）。
    pub dir: PathBuf,
    pub inner: Mutex<OpInner>,
    /// 单次消费标记：一次拖放只能被提交一次。
    consumed: AtomicBool,
}

impl StagedOp {
    /// 抢占消费权：false 表示已被提交/丢弃过，调用方必须拒绝而不是重复入库。
    fn take(&self) -> bool {
        !self.consumed.swap(true, Ordering::SeqCst)
    }

    pub fn snapshot(&self) -> (OpPhase, Vec<StagedItem>, Vec<PayloadFailure>, Option<DragPayloadView>) {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        (
            guard.phase.clone(),
            guard.items.clone(),
            guard.failures.clone(),
            guard.view.clone(),
        )
    }

    /// 收尾：写入真实条目/失败并生成最终视图。
    ///
    /// 幂等保护：只允许从 `Reading` 迁移一次，避免后台线程与主线程重复收尾
    /// 造成「同一拖放两次入库」。
    pub fn finish(&self, items: Vec<StagedItem>, failures: Vec<PayloadFailure>, skipped: usize) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.phase != OpPhase::Reading {
            return;
        }
        let base = guard.base_view.clone().unwrap_or(DragPayloadView::Unsupported {
            formats: Vec::new(),
            reason: codes::message(codes::DRAG_NO_READABLE_CONTENT).into(),
            code: codes::DRAG_NO_READABLE_CONTENT.into(),
        });
        let view = payload::finalize_view(&base, &items, &failures);
        guard.phase = if matches!(view, DragPayloadView::Unsupported { .. })
            && items.is_empty()
        {
            OpPhase::Failed
        } else {
            OpPhase::Ready
        };
        guard.view = Some(view);
        guard.items = items;
        guard.failures = failures;
        guard.skipped = skipped;
        guard.finished_at = Some(Instant::now());
    }
}

/// 暂存会话注册表：进程级单例，随 `lib.rs` 的 setup 建立。
#[derive(Debug)]
pub struct DragDropState {
    /// 暂存根目录（app data 下，不进 shelf 托管目录，避免被孤儿清理误判）。
    pub incoming_root: PathBuf,
    ops: Mutex<HashMap<String, Arc<StagedOp>>>,
}

impl DragDropState {
    pub fn new(incoming_root: PathBuf) -> Self {
        Self {
            incoming_root,
            ops: Mutex::new(HashMap::new()),
        }
    }

    /// 开启一个新会话，并顺带回收过期/超量的旧会话。
    ///
    /// 只在真实 `Drop` 时调用：`enter`/`over` 高频且不产生磁盘目录，
    /// 绝不能为每次鼠标移动建暂存目录。
    pub fn begin(
        &self,
        probe: DragProbe,
        point: Option<(i32, i32)>,
        base_view: DragPayloadView,
    ) -> Arc<StagedOp> {
        self.sweep();
        let id = uuid::Uuid::new_v4().to_string();
        let dir = self.incoming_root.join(&id);
        let op = Arc::new(StagedOp {
            id,
            created_at: Instant::now(),
            point,
            probe,
            dir,
            inner: Mutex::new(OpInner {
                phase: OpPhase::Reading,
                items: Vec::new(),
                failures: Vec::new(),
                base_view: Some(base_view),
                view: None,
                skipped: 0,
                finished_at: None,
            }),
            consumed: AtomicBool::new(false),
        });
        let mut guard = self.ops.lock().unwrap_or_else(|e| e.into_inner());
        // 硬上限：超过就淘汰最老的（已消费或已失败的优先）。
        while guard.len() >= MAX_STAGE_OPS {
            let oldest = guard
                .values()
                .min_by_key(|op| op.created_at)
                .map(|op| op.id.clone());
            match oldest {
                Some(id) => {
                    if let Some(old) = guard.remove(&id) {
                        old.consumed.store(true, Ordering::SeqCst);
                        stage::remove_dir(&old.dir);
                    }
                }
                None => break,
            }
        }
        guard.insert(op.id.clone(), op.clone());
        op
    }

    pub fn get(&self, id: &str) -> Option<Arc<StagedOp>> {
        self.ops
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    /// 取走并结束会话（提交 / 放弃）：返回 `None` 表示已被消费过。
    pub fn take_for_commit(&self, id: &str) -> Option<Arc<StagedOp>> {
        let op = {
            let mut guard = self.ops.lock().unwrap_or_else(|e| e.into_inner());
            guard.remove(id)
        }?;
        if !op.take() {
            // 已被消费（重复提交）：把它放回表里让下一次继续失败，而不是静默当成功。
            self.ops
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id.to_string(), op);
            return None;
        }
        Some(op)
    }

    /// 放弃一个会话（未命中任何落点 / 用户取消 / 读取失败）。
    pub fn discard(&self, id: &str) -> bool {
        let Some(op) = self
            .ops
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
        else {
            return false;
        };
        op.consumed.store(true, Ordering::SeqCst);
        stage::remove_dir(&op.dir);
        true
    }

    /// 回收过期会话与遗留目录。只在真实 drop 与退出时执行，不做常驻轮询。
    pub fn sweep(&self) {
        let expired: Vec<Arc<StagedOp>> = {
            let mut guard = self.ops.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            let ids: Vec<String> = guard
                .values()
                .filter(|op| now.duration_since(op.created_at) > STAGE_TTL)
                .map(|op| op.id.clone())
                .collect();
            ids.into_iter().filter_map(|id| guard.remove(&id)).collect()
        };
        for op in expired {
            op.consumed.store(true, Ordering::SeqCst);
            stage::remove_dir(&op.dir);
        }
        stage::sweep_orphans(&self.incoming_root, &self.active_ids());
    }

    fn active_ids(&self) -> Vec<String> {
        self.ops
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect()
    }

    /// 退出时清空：关闭进程不留下悬空临时文件。
    pub fn clear(&self) {
        let ops: Vec<Arc<StagedOp>> = {
            let mut guard = self.ops.lock().unwrap_or_else(|e| e.into_inner());
            guard.drain().map(|(_, op)| op).collect()
        };
        for op in ops {
            op.consumed.store(true, Ordering::SeqCst);
            stage::remove_dir(&op.dir);
        }
    }
}
