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
//!    OLE 每窗口只允许一个处理器，接管必须先撤销原处理器；**注册失败的窗口
//!    无法恢复 wry 的处理器**（平台没有取回 API），因此这不是 fail-safe，
//!    只能重试一次、如实计数并写诊断（见 `windows_ole` 顶部说明）。
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

/// 受控 OLE 数据对象测试源：只在测试编译，不进入发布产物。
#[cfg(all(test, windows))]
pub mod ole_test_source;
pub use classify::DragFacts;
pub use codes::*;
pub use payload::*;

// 平台无关的入口：`lib.rs` 不需要知道 Windows 细节，也不需要 `cfg` 分支。
#[cfg(windows)]
pub use windows_ole::{
    bridge_active, failed_windows, install as install_native_bridge, installed_windows,
    report_install_failure, uninstall as uninstall_native_bridge,
};

/// 非 Windows 平台没有 OLE 拖入桥：返回 false 让前端继续走 Tauri 内置事件。
#[cfg(not(windows))]
pub fn bridge_active() -> bool {
    false
}

#[cfg(not(windows))]
pub fn installed_windows() -> usize {
    0
}

#[cfg(not(windows))]
pub fn failed_windows() -> usize {
    0
}

#[cfg(not(windows))]
pub fn uninstall_native_bridge() {}

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
/// `FileContents` **只能**以内存块（`TYMED_HGLOBAL`）提供时的单条安全上限。
///
/// 内存块无法像 `IStream` 那样边读边写盘：必须在 `Drop` 回调内整块复制，
/// 大块复制会阻塞 UI 线程并让进程内存翻倍。因此这里显式设 64MB，
/// 超限返回 `DRAG_MEMORY_CONTENT_TOO_LARGE`，**不**假装支持到 2GB；
/// 想接收大文件必须由来源提供 `TYMED_ISTREAM`。
pub const MAX_MEMORY_CONTENT_BYTES: u64 = 64 * 1024 * 1024;
/// **一次拖入**里所有内存块条目的总量上限。
///
/// 单条 64MB × 32 条最坏会 2GB 常驻内存，且全部在 `Drop` 主线程回调里复制；
/// 这里再加一层总量预算，超过后剩余条目直接报 `DRAG_MEMORY_CONTENT_TOO_LARGE`，
/// 不再继续复制。
pub const MAX_MEMORY_TOTAL_BYTES: u64 = 128 * 1024 * 1024;
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
    ///
    /// 同时充当后台读取的**取消信号**：`discard` / TTL 回收 / 上限淘汰 / 提交
    /// 都会把它置位，后台线程据此停止继续写盘（否则 `ensure_dir` 会把刚被删掉的
    /// 暂存目录重新建出来，留下没人认领的副本）。
    pub(crate) consumed: AtomicBool,
}

impl StagedOp {
    /// 抢占消费权：false 表示已被提交/丢弃过，调用方必须拒绝而不是重复入库。
    fn take(&self) -> bool {
        !self.consumed.swap(true, Ordering::SeqCst)
    }

    /// 会话是否已被放弃/提交/淘汰。后台读取必须在每次写盘前核对。
    pub fn released(&self) -> bool {
        self.consumed.load(Ordering::SeqCst)
    }

    /// 当前阶段（克隆，避免调用方长时间持锁）。
    pub fn phase(&self) -> OpPhase {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .phase
            .clone()
    }

    /// 是否仍在读取（供淘汰策略判断）。
    pub fn is_reading(&self) -> bool {
        self.phase() == OpPhase::Reading
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

    /// 拖入阶段被忽略的条目数（超量/无法读取/目录项），提交报告要如实带上。
    pub fn skipped(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .skipped
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

/// 淘汰优先级：数值越小越先被回收（见 `begin` 的注释）。
fn eviction_rank(op: &StagedOp) -> u8 {
    if op.released() || op.phase() == OpPhase::Failed {
        0
    } else if op.is_reading() {
        1
    } else {
        2
    }
}

/// 暂存会话注册表：进程级单例，随 `lib.rs` 的 setup 建立。
#[derive(Debug)]
pub struct DragDropState {
    /// 暂存根目录（app data 下，不进 shelf 托管目录，避免被孤儿清理误判）。
    pub incoming_root: PathBuf,
    ops: Mutex<HashMap<String, Arc<StagedOp>>>,
    /// 正在提交的会话 id：`take_for_commit` 会把会话移出 `ops`，但暂存目录
    /// 还要被复制/移动。若此时有新拖入触发 `sweep_orphans`，目录不在活跃集合里
    /// 就会被当成孤儿删掉——正在复制的文件会中途消失。提交完成前必须排除。
    committing: Mutex<std::collections::HashSet<String>>,
}

impl DragDropState {
    pub fn new(incoming_root: PathBuf) -> Self {
        Self {
            incoming_root,
            ops: Mutex::new(HashMap::new()),
            committing: Mutex::new(std::collections::HashSet::new()),
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
        // 硬上限的淘汰顺序（越小越先淘汰）：
        // 0. 已释放 / `Failed`（内容已不可用，删了不影响任何提交）；
        // 1. 仍在读取的**最老**会话——前端挂起表里也是同一批会话，前端按最老淘汰，
        //    两边选中同一个，用户只损失一次拖入；
        // 2. 最后才是 `Ready`（内容已发给前端、可能正在等待用户选择落点）。
        //    若优先删 Ready，前端根本不知道，提交时只会得到「已结束」。
        while guard.len() >= MAX_STAGE_OPS {
            let victim = guard
                .values()
                .min_by_key(|op| (eviction_rank(op), op.created_at))
                .map(|op| op.id.clone());
            match victim {
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
    ///
    /// 成功的会话会进入 `committing` 集合：目录仍在被复制/移动，孤儿清扫必须
    /// 排除它。提交方必须在完成后调用 [`finish_commit`]（`commit.rs` 用 RAII 守卫）。
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
        self.committing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string());
        Some(op)
    }

    /// 提交结束：允许后续孤儿清扫回收该会话目录。
    pub fn finish_commit(&self, id: &str) {
        self.committing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
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
        let mut ids: Vec<String> = self
            .ops
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        // 提交中的会话不在 `ops` 里，但目录正在被复制：同样算活跃。
        ids.extend(
            self.committing
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .cloned(),
        );
        ids
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
        // 提交中的目录由进程退出统一回收；这里只清标记，不删别人正在读的目录。
        self.committing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("taskdock-ops-{}", uuid::Uuid::new_v4()));
            Self(dir)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn begin(ds: &DragDropState) -> Arc<StagedOp> {
        let view = DragPayloadView::Text {
            text_preview: String::new(),
            chars: 0,
        };
        let probe = DragProbe::from_view(&view, Vec::new());
        ds.begin(probe, None, view)
    }

    fn begin_virtual(ds: &DragDropState) -> Arc<StagedOp> {
        let view = DragPayloadView::VirtualFiles {
            items: Vec::new(),
            count: 1,
        };
        let probe = DragProbe::from_view(&view, Vec::new());
        ds.begin(probe, None, view)
    }

    #[test]
    fn 上限淘汰优先选择失败会话() {
        let tmp = TempRoot::new();
        let ds = DragDropState::new(tmp.path().to_path_buf());
        let ops: Vec<Arc<StagedOp>> = (0..MAX_STAGE_OPS).map(|_| begin_virtual(&ds)).collect();
        // 一条都没落成 → Failed：删掉它不会影响任何提交。
        ops[2].finish(Vec::new(), Vec::new(), 0);
        assert_eq!(ops[2].phase(), OpPhase::Failed);

        let newest = begin(&ds);
        assert!(ds.get(&ops[2].id).is_none(), "失败会话应被优先淘汰");
        assert!(ds.get(&ops[0].id).is_some());
        assert!(ds.get(&newest.id).is_some());
        assert!(ops[2].released());
        assert!(!ops[0].released());
    }

    #[test]
    fn 淘汰选择最老读取中会话而不是等待提交的会话() {
        let tmp = TempRoot::new();
        let ds = DragDropState::new(tmp.path().to_path_buf());
        let ops: Vec<Arc<StagedOp>> = (0..MAX_STAGE_OPS).map(|_| begin(&ds)).collect();
        // 第 0 个已 Ready（payload 已发出，前端可能正在等落点）：不能优先删它。
        ops[0].finish(
            vec![StagedItem::Text {
                text: "x".into(),
                from_html: false,
            }],
            Vec::new(),
            0,
        );
        assert_eq!(ops[0].phase(), OpPhase::Ready);

        let _newest = begin(&ds);
        assert!(
            ds.get(&ops[1].id).is_none(),
            "与前端一致：淘汰最老的读取中会话"
        );
        assert!(
            ds.get(&ops[0].id).is_some(),
            "已 Ready、可能等待提交的会话不能被优先删除"
        );
    }

    #[test]
    fn 提交期间目录不会被孤儿清扫删除() {
        let tmp = TempRoot::new();
        let ds = DragDropState::new(tmp.path().join("incoming"));
        let op = begin(&ds);
        stage::write_bytes(&op.dir, "01-a.bin", b"payload").unwrap();
        op.finish(
            vec![StagedItem::Text {
                text: "x".into(),
                from_html: false,
            }],
            Vec::new(),
            0,
        );
        let taken = ds.take_for_commit(&op.id).expect("首次提交应成功");
        assert!(taken.dir.exists());

        // 模拟「另一个拖入在这时触发 sweep」：目录必须被当作活跃，不能被删。
        ds.sweep();
        assert!(taken.dir.exists(), "提交中的暂存目录不得被孤儿清扫删除");

        ds.finish_commit(&op.id);
        ds.sweep();
        assert!(!taken.dir.exists(), "提交结束后目录可被回收");
    }

    #[test]
    fn 放弃会话删除目录并标记释放() {
        let tmp = TempRoot::new();
        let ds = DragDropState::new(tmp.path().to_path_buf());
        let op = begin(&ds);
        stage::write_bytes(&op.dir, "01-a.txt", b"hello").unwrap();
        assert!(op.dir.exists());

        assert!(ds.discard(&op.id));
        assert!(!op.dir.exists(), "放弃后必须立刻删除暂存目录");
        assert!(op.released());
        // 重复放弃：返回 false，但仍然安全。
        assert!(!ds.discard(&op.id));
    }

    #[test]
    fn 退出清理释放全部会话并删除目录() {
        let tmp = TempRoot::new();
        let ds = DragDropState::new(tmp.path().to_path_buf());
        let ops: Vec<Arc<StagedOp>> = (0..3).map(|_| begin(&ds)).collect();
        for (i, op) in ops.iter().enumerate() {
            stage::write_bytes(&op.dir, &format!("{i:02}-x.bin"), b"x").unwrap();
        }
        ds.clear();
        for op in &ops {
            assert!(op.released());
            assert!(!op.dir.exists());
            assert!(ds.get(&op.id).is_none());
        }
    }

    #[test]
    fn 同一次拖放只能提交一次() {
        let tmp = TempRoot::new();
        let ds = DragDropState::new(tmp.path().to_path_buf());
        let op = begin(&ds);
        op.finish(Vec::new(), Vec::new(), 0);
        let first = ds.take_for_commit(&op.id).expect("首次提交应成功");
        assert!(first.released());
        assert!(
            ds.take_for_commit(&op.id).is_none(),
            "重复提交必须被拒绝，而不是静默当成功"
        );
        // 成功提交后会话已被移出注册表：第二次提交按「不存在」失败，
        // 不会再次入库，也不会拿到已清理的暂存目录。
        assert!(ds.get(&op.id).is_none());
    }
}
