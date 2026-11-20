//! 回收站原生操作：恢复 / 永久删除 / 清空。
//!
//! ## 为什么不用 `$I`/`$R` 直接搬运
//! 直接删除 `$R` 或移动 `$R` 会留下/破坏 `$I` 记录，造成「幽灵条目」或数据
//! 与元数据不一致；本项目明确规定删除、恢复、清空必须走 Windows 原生机制。
//!
//! ## 采用的原生路径
//! 1. 通过 `SHGetKnownFolderIDList(FOLDERID_RecycleBinFolder)` 绑定到回收站
//!    Shell 命名空间（`IShellFolder`）；
//! 2. **快路径**：用 `IShellFolder::ParseDisplayName("X:\\$Recycle.Bin\\<SID>\\$Rxxx")`
//!    取得**回收站项目**（不是普通文件系统项）；**回退路径**：ParseDisplayName 失败时
//!    枚举一次回收站命名空间，用 `SIGDN_DESKTOPABSOLUTEPARSING` 建立 `$R` 全路径 →
//!    `IShellItem` 映射（只在本次批量调用内有效，不跨批次复用）；
//! 3. 恢复用 `IFileOperation::MoveItem` 移动到原始目录（等同 Explorer 的
//!    「还原」，由 Shell 负责迁移数据并清理 `$I`）；
//!    永久删除用 `IFileOperation::DeleteItem`；
//! 4. 清空按卷分批永久删除：每个批次构造一次 `IShellItemArray` 并调用 `DeleteItems`，
//!    以整批共享的进度 sink 回填逐项结果。
//!
//! ## COM 生命周期
//! 本模块只在 STA 下使用 Shell 接口，按**线程**初始化：每个线程首次调用时登记一次
//! `CoInitializeEx(COINIT_APARTMENTTHREADED)`，由 thread_local 守卫在线程退出时
//! 恰好 `CoUninitialize` 一次。`RPC_E_CHANGED_MODE`（线程已被 MTA 占用）作为明确
//! 失败上报（`RECYCLE_COM_UNAVAILABLE`），不会带着不兼容的套间继续调用 Shell。
//!
//! ## 逐项结果
//! 每个 Shell 操作项都带一个 `IFileOperationProgressSink`，用 `PostMoveItem` /
//! `PostDeleteItem` 的 HRESULT 作为系统结果；同时做文件系统复核（恢复要求目标路径
//! 出现，永久删除要求 `$R` 已消失）。两者同时成立才算 `ok`，否则如实失败
//! （系统报成功但复核不成立 → `RECYCLE_VERIFY_FAILED`）。
//!
//! 所有调用都在 `FOF_NO_UI | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI`
//! 下执行，绝不弹系统确认框；失败原因按稳定错误码返回，由调用方逐条记录。

use std::path::Path;

use crate::error::{AppError, AppResult};

/// 恢复结果码（稳定，前端用于分组与文案）。
pub const RECYCLE_OP_OK: &str = "OK";

#[cfg(windows)]
#[derive(Clone, Copy)]
pub(crate) struct PurgeBatchTiming {
    pub items: usize,
    pub prepare: std::time::Duration,
    pub perform: std::time::Duration,
}
pub const RECYCLE_OP_SOURCE_MISSING: &str = "RECYCLE_SOURCE_MISSING";
pub const RECYCLE_OP_METADATA_MISSING: &str = "RECYCLE_METADATA_MISSING";
pub const RECYCLE_OP_TARGET_EXISTS: &str = "RECYCLE_TARGET_EXISTS";
pub const RECYCLE_OP_PARENT_MISSING: &str = "RECYCLE_PARENT_MISSING";
pub const RECYCLE_OP_ACCESS_DENIED: &str = "RECYCLE_ACCESS_DENIED";
pub const RECYCLE_OP_SHELL_FAILED: &str = "RECYCLE_SHELL_FAILED";
pub const RECYCLE_OP_UNSUPPORTED: &str = "RECYCLE_UNSUPPORTED";
pub const RECYCLE_OP_TIMEOUT: &str = "RECYCLE_TIMEOUT";
pub const RECYCLE_OP_CANCELLED: &str = "RECYCLE_CANCELLED";
/// 当前线程的 COM 套间不可用（`RPC_E_CHANGED_MODE` 或初始化失败），
/// 整批目标全部失败，绝不降级到不兼容的套间继续调用 Shell。
pub const RECYCLE_OP_COM_UNAVAILABLE: &str = "RECYCLE_COM_UNAVAILABLE";
/// 系统报告成功，但文件系统复核不成立（结果不可信，按失败处理）。
pub const RECYCLE_OP_VERIFY_FAILED: &str = "RECYCLE_VERIFY_FAILED";

/// 一个待恢复/删除的原生目标。
#[derive(Debug, Clone)]
pub struct NativeTarget {
    /// 展示名（仅用于结果，不参与路径拼接）。
    pub name: String,
    /// 回收站根目录：`X:\$Recycle.Bin\<SID>`。
    pub bin_root: String,
    /// `$R` 数据文件名（扫描时实际观察到的名称，例如 `$RABCDEF.txt`），
    /// 不按 `record_key` 合成，避免大小写/命名规则假设。
    pub data_name: String,
    /// 原始路径（恢复目标）。永久删除时可为空。
    pub original_path: String,
}

impl NativeTarget {
    /// `$R` 数据路径（`X:\$Recycle.Bin\<SID>\$R...`）。
    pub fn data_path(&self) -> std::path::PathBuf {
        Path::new(&self.bin_root).join(&self.data_name)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOutcome {
    pub target: String,
    /// ok | failed | skipped
    pub status: String,
    pub code: String,
    pub message: Option<String>,
}

/// 结果槽：按**输入下标**写入，保证返回结果与输入同序、等长。
///
/// 为什么必须按下标而不是追加：批量恢复中「目标已存在被跳过」「元数据缺失」
/// 等提前失败发生在入队之前，而成功结果在 `PerformOperations` 之后才产生。
/// 若两者都追加到同一个 `Vec`，调用方按位置 `zip` 就会把 A 的结果记到 B 头上，
/// 进而删错索引记录（P0）。槽位模型让「提前失败」和「执行结果」都落到自己的下标。
#[cfg_attr(not(windows), allow(dead_code))]
struct OutcomeSlots {
    slots: Vec<Option<NativeOutcome>>,
}

impl OutcomeSlots {
    fn new(len: usize) -> Self {
        Self {
            slots: (0..len).map(|_| None).collect(),
        }
    }

    fn set(&mut self, index: usize, outcome: NativeOutcome) {
        if let Some(slot) = self.slots.get_mut(index) {
            *slot = Some(outcome);
        }
    }

    /// 收尾：未写入的槽位一律记为失败（内部状态缺失，绝不伪造成成功）。
    fn finish(self, targets: &[NativeTarget]) -> Vec<NativeOutcome> {
        self.slots
            .into_iter()
            .enumerate()
            .map(|(index, slot)| {
                slot.unwrap_or_else(|| {
                    let name = targets
                        .get(index)
                        .map(|t| t.name.clone())
                        .unwrap_or_default();
                    NativeOutcome::failed(&name, RECYCLE_OP_SHELL_FAILED, "未执行（内部状态缺失）")
                })
            })
            .collect()
    }
}

impl NativeOutcome {
    fn ok(target: &str) -> Self {
        Self {
            target: target.to_string(),
            status: "ok".into(),
            code: RECYCLE_OP_OK.into(),
            message: None,
        }
    }
    fn failed(target: &str, code: &str, message: impl Into<String>) -> Self {
        Self {
            target: target.to_string(),
            status: "failed".into(),
            code: code.to_string(),
            message: Some(message.into()),
        }
    }
    fn skipped(target: &str, code: &str, message: impl Into<String>) -> Self {
        Self {
            target: target.to_string(),
            status: "skipped".into(),
            code: code.to_string(),
            message: Some(message.into()),
        }
    }
}

/// 恢复冲突策略：`skip` 保留原文件；`rename` 自动「name (2).ext」，绝不覆盖。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreConflict {
    Skip,
    Rename,
}

pub fn parse_restore_conflict(raw: &str) -> AppResult<RestoreConflict> {
    match raw.trim() {
        "" | "skip" => Ok(RestoreConflict::Skip),
        "rename" => Ok(RestoreConflict::Rename),
        other => Err(AppError::Validation(format!(
            "未知恢复冲突策略: {other}（允许 skip/rename）"
        ))),
    }
}

// ── 与平台无关的判定逻辑（可在无 COM/无回收站环境做单元测试） ─────────────

const COM_HR_S_OK: i32 = 0;
const COM_HR_S_FALSE: i32 = 1;
const COM_HR_RPC_E_CHANGED_MODE: i32 = 0x8001_0106u32 as i32;

/// `CoInitializeEx` 返回值处置（线程级生命周期）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ComInitStep {
    /// 本线程此前已初始化成功，本次无需再次调用。
    AlreadyInitialized,
    /// 本次调用成功（`S_OK` 或 `S_FALSE`）：必须配对一次 `CoUninitialize`。
    Acquired,
    /// `RPC_E_CHANGED_MODE`：线程已按其他套间模型初始化，不能使用 STA Shell 接口。
    ChangedMode,
    /// 其他 HRESULT 失败。
    Failed(i32),
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn classify_com_init(already_initialized: bool, hr: i32) -> ComInitStep {
    if already_initialized {
        return ComInitStep::AlreadyInitialized;
    }
    match hr {
        COM_HR_S_OK | COM_HR_S_FALSE => ComInitStep::Acquired,
        COM_HR_RPC_E_CHANGED_MODE => ComInitStep::ChangedMode,
        other => ComInitStep::Failed(other),
    }
}

/// 单个 Shell 操作项的判定结果（系统 HRESULT + 文件系统复核）。
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
enum ItemVerdict {
    Ok,
    /// 操作被中止且系统没有返回该项结果。
    Cancelled,
    ShellFailed(String),
    /// 系统报告成功，但复核不成立。
    VerifyFailed,
}

/// 逐项判定：必须「HRESULT 成功 **且** 文件系统复核成立」才算成功。
///
/// `hr` 为 `None` 表示系统没有回调该条目（被中止或未执行），此时按中止标记区分
/// `RECYCLE_CANCELLED` 与 `RECYCLE_SHELL_FAILED`；绝不凭路径存在与否单独判成功。
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn judge_item(hr: Option<i32>, aborted: bool, verified: bool) -> ItemVerdict {
    match hr {
        Some(hr) if hr >= 0 => {
            if verified {
                ItemVerdict::Ok
            } else {
                ItemVerdict::VerifyFailed
            }
        }
        Some(hr) => ItemVerdict::ShellFailed(format!("Windows 文件操作返回 0x{hr:08X}")),
        None if aborted => ItemVerdict::Cancelled,
        None => ItemVerdict::ShellFailed("系统未返回该条目的执行结果".to_string()),
    }
}

/// Shell 解析名归一化：统一分隔符、去掉 `\\?\` 前缀与尾部反斜杠、转小写。
/// 用于把枚举到的 `$R` 全路径与扫描结果做大小写无关匹配。
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn normalize_shell_path(raw: &str) -> String {
    let unified = raw.trim().replace('/', "\\");
    let mut text = unified
        .strip_prefix(r"\\?\")
        .unwrap_or(&unified)
        .to_string();
    while text.len() > 3 && text.ends_with('\\') {
        text.pop();
    }
    text.to_lowercase()
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::cell::Cell;
    use std::collections::{HashMap, HashSet};
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::sync::{Arc, Mutex};

    use windows::core::{implement, PCWSTR, PWSTR, Ref};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx, CLSCTX_ALL,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOperation, IEnumIDList, IFileOperation, IFileOperationProgressSink,
        IFileOperationProgressSink_Impl, IShellFolder, IShellItem, IShellItemArray, ILClone,
        ILCombine, SHCreateItemFromParsingName, SHCreateItemWithParent,
        SHCreateShellItemArrayFromIDLists, SHGetDesktopFolder, SHGetKnownFolderIDList,
        SHCONTF_FOLDERS, SHCONTF_INCLUDEHIDDEN, SHCONTF_NONFOLDERS,
        SIGDN_DESKTOPABSOLUTEPARSING, SIGDN_FILESYSPATH, FOLDERID_RecycleBinFolder,
        FOF_NOERRORUI, FOF_NOCONFIRMATION, FOF_SILENT,
    };
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    // ── COM 线程级生命周期 ────────────────────────────────────────────────

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum ComStatus {
        /// 本线程还没有尝试初始化。
        Unknown,
        /// 本线程已按 STA 初始化成功，且登记了一次释放。
        Ready,
        /// 本线程 COM 套间不兼容或初始化失败，本次线程生命周期内不再重试。
        Unavailable,
    }

    /// 线程退出时释放一次 `CoUninitialize`。
    ///
    /// 只有首次 `CoInitializeEx` 成功（`S_OK`/`S_FALSE`）后才访问本 thread_local，
    /// 因此「一次成功初始化 ↔ 一次释放」严格配对；初始化失败不会登记释放。
    struct ComThreadGuard;

    impl Drop for ComThreadGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    thread_local! {
        static COM_STATUS: Cell<ComStatus> = const { Cell::new(ComStatus::Unknown) };
        static COM_GUARD: ComThreadGuard = const { ComThreadGuard };
    }

    /// 确保当前线程已按 STA 初始化 COM。
    ///
    /// 生命周期边界：
    /// - `fsops` 的固定 worker 线程：首次执行回收站操作时初始化，此后该线程保持 STA，
    ///   直到线程退出（进程退出/线程池回收）由 `ComThreadGuard` 释放一次；
    /// - 清空子进程的 `thread::scope` 工作线程：作用域结束、线程退出时释放；
    /// - 同一线程上的其他 COM 代码各自使用独立线程，不与其共享套间。
    ///
    /// `RPC_E_CHANGED_MODE` 明确失败：调用方必须让整批目标失败，绝不能在 MTA 线程上
    /// 继续使用 STA Shell 接口。
    fn ensure_com() -> Result<(), String> {
        COM_STATUS.with(|status| match status.get() {
            ComStatus::Ready => Ok(()),
            ComStatus::Unavailable => Err(com_unavailable_message(None)),
            ComStatus::Unknown => {
                let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
                match classify_com_init(false, hr.0) {
                    ComInitStep::Acquired => {
                        // 首次成功才登记守卫：线程退出时恰好反初始化一次。
                        COM_GUARD.with(|_| {});
                        status.set(ComStatus::Ready);
                        Ok(())
                    }
                    ComInitStep::AlreadyInitialized => {
                        status.set(ComStatus::Ready);
                        Ok(())
                    }
                    ComInitStep::ChangedMode => {
                        status.set(ComStatus::Unavailable);
                        Err(com_unavailable_message(Some(COM_HR_RPC_E_CHANGED_MODE)))
                    }
                    ComInitStep::Failed(code) => {
                        status.set(ComStatus::Unavailable);
                        Err(com_unavailable_message(Some(code)))
                    }
                }
            }
        })
    }

    fn com_unavailable_message(code: Option<i32>) -> String {
        match code {
            Some(COM_HR_RPC_E_CHANGED_MODE) => {
                "当前线程已按其他套间模型初始化（RPC_E_CHANGED_MODE），无法使用 STA Shell 接口"
                    .to_string()
            }
            Some(code) => format!("当前线程 COM 初始化失败（HRESULT 0x{code:08X}）"),
            None => "当前线程 COM 套间不可用（此前初始化已失败）".to_string(),
        }
    }

    /// 兼容入口：初始化当前线程 COM（STA）。失败由后续批量操作各自按
    /// `RECYCLE_COM_UNAVAILABLE` 上报，绝不静默继续。
    pub fn init_com() {
        let _ = ensure_com();
    }

    // ── PIDL / Shell 项目定位 ─────────────────────────────────────────────

    /// `CoTaskMem` 分配的 PIDL，恰好释放一次。
    struct ShellPidl(*mut ITEMIDLIST);

    impl Drop for ShellPidl {
        fn drop(&mut self) {
            unsafe { CoTaskMemFree(Some(self.0.cast())) };
        }
    }

    /// 回收站命名空间：`folder` 负责解析/枚举，`root` 是它的绝对 PIDL。
    ///
    /// `SHGetKnownFolderIDList` 返回的 PIDL 由 `ShellPidl` 持有并在作用域结束时释放；
    /// `BindToObject` / `SHCreateItemWithParent` 都会复制所需数据，不借用该内存。
    struct BinNamespace {
        folder: IShellFolder,
        root: ShellPidl,
    }

    fn bin_namespace() -> AppResult<BinNamespace> {
        unsafe {
            let raw = SHGetKnownFolderIDList(&FOLDERID_RecycleBinFolder, 0, None)
                .map_err(|e| AppError::Unavailable(format!("无法定位回收站命名空间: {e}")))?;
            if raw.is_null() {
                return Err(AppError::Unavailable("回收站命名空间标识为空".into()));
            }
            let root = ShellPidl(raw);
            let folder: IShellFolder = SHGetDesktopFolder()
                .and_then(|desktop| {
                    let bind = windows::Win32::System::Com::CreateBindCtx(0)?;
                    desktop.BindToObject(root.0, &bind)
                })
                .map_err(|e| AppError::Unavailable(format!("绑定回收站失败: {e}")))?;
            Ok(BinNamespace { folder, root })
        }
    }

    /// `$R` 路径 → 回收站项目 PIDL（相对回收站命名空间）。所有权归 `ShellPidl`。
    fn parse_pidl(folder: &IShellFolder, data_path: &Path) -> Option<ShellPidl> {
        let text = data_path.to_string_lossy();
        let name = wide(&text);
        let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
        unsafe {
            folder
                .ParseDisplayName(
                    HWND(std::ptr::null_mut()),
                    None::<&IBindCtx>,
                    PCWSTR(name.as_ptr()),
                    None,
                    &mut pidl,
                    std::ptr::null_mut(),
                )
                .ok()?;
        }
        (!pidl.is_null()).then_some(ShellPidl(pidl))
    }

    /// 取 Shell 项目的解析全路径（`SIGDN_DESKTOPABSOLUTEPARSING`，必要时补 `FILESYSPATH`）。
    fn display_keys(item: &IShellItem) -> Vec<String> {
        let mut keys = Vec::with_capacity(2);
        for sigdn in [SIGDN_DESKTOPABSOLUTEPARSING, SIGDN_FILESYSPATH] {
            if let Ok(raw) = unsafe { item.GetDisplayName(sigdn) } {
                let text = take_co_pwstr(raw);
                if !text.is_empty() {
                    keys.push(normalize_shell_path(&text));
                }
            }
        }
        keys
    }

    /// 读取 `CoTaskMem` 分配的宽字符串并释放（`GetDisplayName` 的所有权契约）。
    fn take_co_pwstr(raw: PWSTR) -> String {
        if raw.is_null() {
            return String::new();
        }
        let text = unsafe { raw.to_string() }.unwrap_or_default();
        unsafe { CoTaskMemFree(Some(raw.0.cast())) };
        text
    }

    /// 枚举回收站命名空间，建立「`$R` 全路径 → 相对 PIDL」映射。
    ///
    /// 只在快路径 `ParseDisplayName` 失败时调用一次，且只服务本次批量调用；
    /// 不跨批次缓存，避免把已失效的 Shell 项目带进下一批。
    /// 每个映射值都是 `ILClone` 出来的独立 CoTaskMem PIDL，由 `ShellPidl` 恰好释放一次。
    fn enumerate_namespace(namespace: &BinNamespace) -> HashMap<String, ShellPidl> {
        let mut map = HashMap::new();
        unsafe {
            let mut list: Option<IEnumIDList> = None;
            let flags =
                (SHCONTF_FOLDERS.0 | SHCONTF_NONFOLDERS.0 | SHCONTF_INCLUDEHIDDEN.0) as u32;
            if namespace
                .folder
                .EnumObjects(HWND(std::ptr::null_mut()), flags, &mut list)
                .is_err()
            {
                return map;
            }
            let Some(list) = list else { return map };
            loop {
                let mut child: *mut ITEMIDLIST = std::ptr::null_mut();
                let hr = list.Next(std::slice::from_mut(&mut child), None);
                if hr.is_err() || child.is_null() {
                    break;
                }
                // 每个枚举出的子 PIDL 也是 CoTaskMem 分配，必须逐一释放。
                let child = ShellPidl(child);
                let item: windows::core::Result<IShellItem> =
                    SHCreateItemWithParent(Some(namespace.root.0), &namespace.folder, child.0);
                let Ok(item) = item else { continue };
                for key in display_keys(&item) {
                    // 每个 key 存一份独立副本：map 会跨批次存活到本次调用结束。
                    let cloned = ILClone(child.0);
                    if cloned.is_null() {
                        continue;
                    }
                    map.entry(key).or_insert(ShellPidl(cloned));
                }
            }
        }
        map
    }

    /// 本次批量调用的项目定位器（快路径 + 回退枚举）。
    struct Locator<'a> {
        namespace: &'a BinNamespace,
        /// 首次需要回退时才枚举；同一次批量调用内复用。
        by_path: Option<HashMap<String, ShellPidl>>,
    }

    impl<'a> Locator<'a> {
        fn new(namespace: &'a BinNamespace) -> Self {
            Self {
                namespace,
                by_path: None,
            }
        }

        /// `$R` 路径 → 相对回收站命名空间的 PIDL（调用方负责释放）。
        fn locate_pidl(&mut self, data_path: &Path) -> Option<ShellPidl> {
            if let Some(pidl) = parse_pidl(&self.namespace.folder, data_path) {
                return Some(pidl);
            }
            if self.by_path.is_none() {
                self.by_path = Some(enumerate_namespace(self.namespace));
            }
            let cached = self
                .by_path
                .as_ref()?
                .get(&normalize_shell_path(&data_path.to_string_lossy()))?;
            // 缓存项归 map 所有，这里克隆一份交给调用方释放。
            let cloned = unsafe { ILClone(cached.0) };
            (!cloned.is_null()).then_some(ShellPidl(cloned))
        }

        fn locate(&mut self, data_path: &Path) -> Option<IShellItem> {
            let pidl = self.locate_pidl(data_path)?;
            // `psfparent` 必须是回收站根 PIDL：子 PIDL 相对该父项解析。
            // 传 `None` 会让 `SHCreateItemWithParent` 失败并触发整仓枚举回退
            // （实测 27 万项时数分钟），这也是快路径必须带父 PIDL 的原因。
            unsafe {
                SHCreateItemWithParent(
                    Some(self.namespace.root.0),
                    &self.namespace.folder,
                    pidl.0,
                )
            }
            .ok()
        }
    }

    // ── 逐项结果 sink ────────────────────────────────────────────────────

    /// 一个 Shell 操作项的系统结果槽。
    ///
    /// 两种用法共用同一结构：
    /// - **单项模式**（`restore_batch`/`purge_batch`，每项一个 sink）：只写 `hr`；
    /// - **批量模式**（`purge_volume_batches`，整批共享一个 sink）：`DeleteItems` 只给出
    ///   `PostDeleteItem(psiitem)`，用系统回传的项目身份（解析名）写入 `by_path`。
    #[derive(Default)]
    struct SinkSlot {
        /// 单项模式：最近一次回调的 HRESULT；`None` = 系统没有回调。
        hr: Mutex<Option<i32>>,
        /// 批量模式：归一化项目路径 → HRESULT（同一路径多次回调时后者覆盖）。
        by_path: Mutex<HashMap<String, i32>>,
    }

    #[implement(IFileOperationProgressSink)]
    struct ItemProgressSink {
        slot: Arc<SinkSlot>,
    }

    impl ItemProgressSink {
        fn record(&self, hr: windows::core::HRESULT) {
            *self.slot.hr.lock().unwrap_or_else(|e| e.into_inner()) = Some(hr.0);
        }

        /// 记录删除结果：单项模式写 `hr`，同时按项目解析名写入 `by_path`，
        /// 供整批 `DeleteItems` 的共享 sink 精确回填每个条目。
        fn record_delete(&self, item: Option<&IShellItem>, hr: windows::core::HRESULT) {
            self.record(hr);
            let Some(item) = item else { return };
            let keys = display_keys(item);
            if keys.is_empty() {
                return;
            }
            let mut map = self.slot.by_path.lock().unwrap_or_else(|e| e.into_inner());
            for key in keys {
                map.insert(key, hr.0);
            }
        }
    }

    impl IFileOperationProgressSink_Impl for ItemProgressSink_Impl {
        fn StartOperations(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn FinishOperations(&self, _hrresult: windows::core::HRESULT) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreRenameItem(
            &self,
            _dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostRenameItem(
            &self,
            _dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
            _hrrename: windows::core::HRESULT,
            _psinewlycreated: Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreMoveItem(
            &self,
            _dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
            _psidestinationfolder: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostMoveItem(
            &self,
            _dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
            _psidestinationfolder: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
            hrmove: windows::core::HRESULT,
            _psinewlycreated: Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            self.record(hrmove);
            Ok(())
        }
        fn PreCopyItem(
            &self,
            _dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
            _psidestinationfolder: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostCopyItem(
            &self,
            _dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
            _psidestinationfolder: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
            _hrcopy: windows::core::HRESULT,
            _psinewlycreated: Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PreDeleteItem(
            &self,
            _dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostDeleteItem(
            &self,
            _dwflags: u32,
            _psiitem: Ref<'_, IShellItem>,
            hrdelete: windows::core::HRESULT,
            _psinewlycreated: Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            // `psiitem` 是系统给出的真实项目身份（不是按名字猜测），批量模式据此回填。
            self.record_delete(_psiitem.as_ref(), hrdelete);
            Ok(())
        }
        fn PreNewItem(
            &self,
            _dwflags: u32,
            _psidestinationfolder: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn PostNewItem(
            &self,
            _dwflags: u32,
            _psidestinationfolder: Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
            _psztemplatename: &PCWSTR,
            _dwfileattributes: u32,
            _hrnew: windows::core::HRESULT,
            _psinewitem: Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            Ok(())
        }
        fn UpdateProgress(&self, _iworktotal: u32, _iworksofar: u32) -> windows::core::Result<()> {
            Ok(())
        }
        fn ResetTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn PauseTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn ResumeTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
    }

    /// 新建一个 sink，返回其接口与共享结果槽。
    ///
    /// 单项模式每次新建一个；批量清空每批只新建一个（整批共享）。
    fn new_sink() -> (IFileOperationProgressSink, Arc<SinkSlot>) {
        let slot = Arc::new(SinkSlot::default());
        let sink: IFileOperationProgressSink = ItemProgressSink { slot: slot.clone() }.into();
        (sink, slot)
    }

    fn take_sink_result(slot: &SinkSlot) -> Option<i32> {
        slot.hr.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    /// 批量模式：按归一化路径取该条目的系统 HRESULT。
    fn path_sink_result(slot: &SinkSlot, path: &Path) -> Option<i32> {
        slot.by_path
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&normalize_shell_path(&path.to_string_lossy()))
            .copied()
    }

    /// 把判定结果写进对应下标的槽位。
    fn apply_verdict(slots: &mut OutcomeSlots, index: usize, name: &str, verdict: ItemVerdict) {
        let outcome = match verdict {
            ItemVerdict::Ok => NativeOutcome::ok(name),
            ItemVerdict::Cancelled => NativeOutcome::failed(
                name,
                RECYCLE_OP_CANCELLED,
                "系统已中止操作，该项未执行",
            ),
            ItemVerdict::ShellFailed(message) => {
                NativeOutcome::failed(name, RECYCLE_OP_SHELL_FAILED, message)
            }
            ItemVerdict::VerifyFailed => NativeOutcome::failed(
                name,
                RECYCLE_OP_VERIFY_FAILED,
                "系统报告成功，但文件系统复核不成立（结果不可信）",
            ),
        };
        slots.set(index, outcome);
    }

    /// 整批失败时给所有下标写入同一个失败结果（保持同序、等长）。
    fn fail_all(slots: &mut OutcomeSlots, targets: &[NativeTarget], code: &str, message: &str) {
        for (index, target) in targets.iter().enumerate() {
            slots.set(index, NativeOutcome::failed(&target.name, code, message));
        }
    }

    fn file_operation() -> AppResult<IFileOperation> {
        unsafe {
            let op: IFileOperation =
                CoCreateInstance(&FileOperation, None::<&windows::core::IUnknown>, CLSCTX_ALL)
                    .map_err(|e| AppError::Unavailable(format!("IFileOperation 不可用: {e}")))?;
            let flags = FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT;
            op.SetOperationFlags(flags).map_err(|e| {
                AppError::Unavailable(format!("设置文件操作参数失败: {e}"))
            })?;
            Ok(op)
        }
    }


    /// 目标目录是否可用（存在且是目录）。
    fn parent_ready(path: &str) -> Result<std::path::PathBuf, NativeOutcome> {
        let target = Path::new(path);
        let Some(parent) = target.parent() else {
            return Err(NativeOutcome::failed(path, RECYCLE_OP_SOURCE_MISSING, "原始路径无效"));
        };
        if !parent.is_dir() {
            return Err(NativeOutcome::failed(
                path,
                RECYCLE_OP_PARENT_MISSING,
                "原始目录已不存在，请先重建目录再恢复",
            ));
        }
        Ok(parent.to_path_buf())
    }

    fn unique_name(parent: &Path, name: &str, reserved: &HashSet<std::path::PathBuf>) -> String {
        let candidate = parent.join(name);
        if !candidate.exists() && !reserved.contains(&candidate) {
            return name.to_string();
        }
        let stem_ext = Path::new(name)
            .extension()
            .map(|e| e.to_string_lossy().into_owned());
        let stem = match &stem_ext {
            Some(ext) => name
                .strip_suffix(&format!(".{ext}"))
                .unwrap_or(name)
                .to_string(),
            None => name.to_string(),
        };
        for n in 2..=1000u32 {
            let attempt = match &stem_ext {
                Some(ext) => format!("{stem} ({n}).{ext}"),
                None => format!("{stem} ({n})"),
            };
            let candidate = parent.join(&attempt);
            if !candidate.exists() && !reserved.contains(&candidate) {
                return attempt;
            }
        }
        format!("{stem} (dup)")
    }

    fn destination_folder(path: &Path) -> AppResult<IShellItem> {
        unsafe {
            let wide_path = wide(&path.to_string_lossy());
            SHCreateItemFromParsingName(PCWSTR(wide_path.as_ptr()), None::<&IBindCtx>)
                .map_err(|e| AppError::Unavailable(format!("目标目录不可解析: {e}")))
        }
    }

    /// 一次批量恢复中已排队（等待 `PerformOperations`）的条目。
    struct QueuedRestore {
        /// 输入下标：结果必须写回自己的槽位。
        index: usize,
        /// 展示名（只用于结果）。
        name: String,
        /// 恢复后的真实路径（复核依据）。
        final_path: std::path::PathBuf,
        /// 本项的系统结果槽（`PostMoveItem` 的 HRESULT）。
        slot: Arc<SinkSlot>,
        /// 保持 sink COM 对象存活到 `PerformOperations` 完成。
        _sink: IFileOperationProgressSink,
    }

    /// 批量恢复：整批只排队一次 `PerformOperations`，避免每项一次 Shell 操作。
    ///
    /// 逐项成功条件：`PostMoveItem` 的 HRESULT 成功 **且** 恢复后的目标路径存在；
    /// 任一不成立即如实失败（系统报成功但复核不成立 → `RECYCLE_VERIFY_FAILED`）。
    /// **契约：返回结果与输入同序、等长**，调用方按下标映射，不得按名称猜测。
    pub fn restore_batch(targets: &[NativeTarget], conflict: RestoreConflict) -> Vec<NativeOutcome> {
        let mut slots = OutcomeSlots::new(targets.len());
        if let Err(message) = ensure_com() {
            fail_all(&mut slots, targets, RECYCLE_OP_COM_UNAVAILABLE, &message);
            return slots.finish(targets);
        }
        let namespace = match bin_namespace() {
            Ok(namespace) => namespace,
            Err(error) => {
                fail_all(&mut slots, targets, RECYCLE_OP_SHELL_FAILED, &error.to_string());
                return slots.finish(targets);
            }
        };
        let operation = match file_operation() {
            Ok(op) => op,
            Err(error) => {
                fail_all(&mut slots, targets, RECYCLE_OP_SHELL_FAILED, &error.to_string());
                return slots.finish(targets);
            }
        };
        let mut locator = Locator::new(&namespace);

        let mut reserved: HashSet<std::path::PathBuf> = HashSet::new();
        // 下标用于回填结果，绝不依赖 `Vec` 追加顺序。
        let mut queued: Vec<QueuedRestore> = Vec::with_capacity(targets.len());
        for (index, target) in targets.iter().enumerate() {
            if target.original_path.is_empty() {
                slots.set(
                    index,
                    NativeOutcome::failed(
                        &target.name,
                        RECYCLE_OP_METADATA_MISSING,
                        "该条目缺少原始路径元数据，无法恢复",
                    ),
                );
                continue;
            }
            let parent = match parent_ready(&target.original_path) {
                Ok(parent) => parent,
                Err(outcome) => {
                    slots.set(index, outcome);
                    continue;
                }
            };
            let file_name = Path::new(&target.original_path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| target.name.clone());
            let final_name = match conflict {
                RestoreConflict::Skip => {
                    let candidate = parent.join(&file_name);
                    if candidate.exists() || reserved.contains(&candidate) {
                        slots.set(
                            index,
                            NativeOutcome::skipped(
                                &target.name,
                                RECYCLE_OP_TARGET_EXISTS,
                                "目标位置已存在同名文件，已跳过（不覆盖）",
                            ),
                        );
                        continue;
                    }
                    file_name
                }
                // rename 生成的名字同时避开磁盘现状与本批次已占用的目标名。
                RestoreConflict::Rename => unique_name(&parent, &file_name, &reserved),
            };
            let data_path = target.data_path();
            if !data_path.exists() {
                slots.set(
                    index,
                    NativeOutcome::failed(
                        &target.name,
                        RECYCLE_OP_SOURCE_MISSING,
                        "回收站数据文件已不存在",
                    ),
                );
                continue;
            }
            let Some(item) = locator.locate(&data_path) else {
                slots.set(
                    index,
                    NativeOutcome::failed(
                        &target.name,
                        RECYCLE_OP_SHELL_FAILED,
                        "系统无法识别该回收站项目（元数据可能损坏）",
                    ),
                );
                continue;
            };
            let dest = match destination_folder(&parent) {
                Ok(dest) => dest,
                Err(error) => {
                    slots.set(
                        index,
                        NativeOutcome::failed(
                            &target.name,
                            RECYCLE_OP_SHELL_FAILED,
                            error.to_string(),
                        ),
                    );
                    continue;
                }
            };
            let final_path = parent.join(&final_name);
            reserved.insert(final_path.clone());
            let (sink, slot) = new_sink();
            let name_wide = wide(&final_name);
            // 入队后 `IFileOperation` 自己持有 item/sink 的引用，局部变量释放不影响执行。
            if let Err(error) = unsafe {
                operation.MoveItem(
                    &item,
                    &dest,
                    PCWSTR(name_wide.as_ptr()),
                    Some(&sink),
                )
            } {
                slots.set(
                    index,
                    NativeOutcome::failed(
                        &target.name,
                        RECYCLE_OP_SHELL_FAILED,
                        error.to_string(),
                    ),
                );
                continue;
            }
            queued.push(QueuedRestore {
                index,
                name: target.name.clone(),
                final_path,
                slot,
                _sink: sink,
            });
        }

        if queued.is_empty() {
            return slots.finish(targets);
        }
        // IFileOperation 是队列式的：整批只执行一次，大幅减少 Shell 往返。
        let perform_error = unsafe { operation.PerformOperations() }
            .err()
            .map(|e| e.to_string());
        // 无法确认中止状态时按「已中止」处理：缺结果的条目绝不会被误判为成功。
        let aborted = unsafe { operation.GetAnyOperationsAborted() }
            .map(|value| value.as_bool())
            .unwrap_or(true);
        for item in &queued {
            let hr = take_sink_result(&item.slot);
            let verdict = match judge_item(hr, aborted, item.final_path.exists()) {
                ItemVerdict::ShellFailed(message) if hr.is_none() && !aborted => {
                    ItemVerdict::ShellFailed(perform_error.clone().unwrap_or(message))
                }
                other => other,
            };
            apply_verdict(&mut slots, item.index, &item.name, verdict);
        }
        slots.finish(targets)
    }

    /// 一次批量永久删除中已排队（等待 `PerformOperations`）的条目。
    struct QueuedPurge {
        index: usize,
        name: String,
        /// `$R` 数据路径（复核依据：删除后必须不存在）。
        data_path: std::path::PathBuf,
        slot: Arc<SinkSlot>,
        _sink: IFileOperationProgressSink,
    }

    /// 批量永久删除（回收站内项目）：整批排队，一次 `PerformOperations`。
    ///
    /// 逐项成功条件：`PostDeleteItem` 的 HRESULT 成功 **且** `$R` 已不存在；被中止且
    /// 没有系统结果的条目返回 `RECYCLE_CANCELLED`，其余按 sink 结果 + 复核判定。
    /// **契约：返回结果与输入同序、等长**；入队失败项只产出一条失败结果。
    pub fn purge_batch(targets: &[NativeTarget]) -> Vec<NativeOutcome> {
        let mut slots = OutcomeSlots::new(targets.len());
        if let Err(message) = ensure_com() {
            fail_all(&mut slots, targets, RECYCLE_OP_COM_UNAVAILABLE, &message);
            return slots.finish(targets);
        }
        let namespace = match bin_namespace() {
            Ok(namespace) => namespace,
            Err(error) => {
                fail_all(&mut slots, targets, RECYCLE_OP_SHELL_FAILED, &error.to_string());
                return slots.finish(targets);
            }
        };
        let operation = match file_operation() {
            Ok(op) => op,
            Err(error) => {
                fail_all(&mut slots, targets, RECYCLE_OP_SHELL_FAILED, &error.to_string());
                return slots.finish(targets);
            }
        };
        let mut locator = Locator::new(&namespace);

        let mut queued: Vec<QueuedPurge> = Vec::with_capacity(targets.len());
        for (index, target) in targets.iter().enumerate() {
            let data_path = target.data_path();
            if !data_path.exists() {
                slots.set(
                    index,
                    NativeOutcome::failed(
                        &target.name,
                        RECYCLE_OP_SOURCE_MISSING,
                        "回收站数据文件已不存在",
                    ),
                );
                continue;
            }
            let Some(item) = locator.locate(&data_path) else {
                slots.set(
                    index,
                    NativeOutcome::failed(
                        &target.name,
                        RECYCLE_OP_SOURCE_MISSING,
                        "回收站项目已不存在或无法识别",
                    ),
                );
                continue;
            };
            let (sink, slot) = new_sink();
            // 入队后 `IFileOperation` 自己持有 item/sink 的引用；入队失败只在这里记一次，
            // 不得在 PerformOperations 之后重复产出。
            if let Err(error) = unsafe { operation.DeleteItem(&item, Some(&sink)) } {
                slots.set(
                    index,
                    NativeOutcome::failed(
                        &target.name,
                        RECYCLE_OP_SHELL_FAILED,
                        error.to_string(),
                    ),
                );
                continue;
            }
            queued.push(QueuedPurge {
                index,
                name: target.name.clone(),
                data_path,
                slot,
                _sink: sink,
            });
        }
        if queued.is_empty() {
            return slots.finish(targets);
        }
        let perform_error = unsafe { operation.PerformOperations() }
            .err()
            .map(|e| e.to_string());
        // 无法确认中止状态时按「已中止」处理：缺结果的条目绝不会被误判为成功。
        let aborted = unsafe { operation.GetAnyOperationsAborted() }
            .map(|value| value.as_bool())
            .unwrap_or(true);
        for item in &queued {
            let hr = take_sink_result(&item.slot);
            let verified = !item.data_path.exists();
            let verdict = match judge_item(hr, aborted, verified) {
                ItemVerdict::ShellFailed(message) if hr.is_none() && !aborted => {
                    ItemVerdict::ShellFailed(perform_error.clone().unwrap_or(message))
                }
                other => other,
            };
            apply_verdict(&mut slots, item.index, &item.name, verdict);
        }
        slots.finish(targets)
    }

    /// 仅接收从当前用户已选回收站卷读取的配对项。批次复用 Shell 命名空间。
    ///
    /// 每个 chunk 只构造一次 Shell 条目数组、调用一次 `DeleteItems`，再用一个整批共享的
    /// `ItemProgressSink` 取回逐项结果：`DeleteItems` 不携带逐项 sink，但注册在
    /// `IFileOperation::Advise` 上的 sink 会在 `PostDeleteItem` 收到系统给出的 `psiitem`
    /// ——那是系统认定的真实项目身份，不是按名字猜测；用 `SIGDN_DESKTOPABSOLUTEPARSING`
    /// 归一化后即可精确映射回扫描路径。
    ///
    /// PIDL 所有权顺序：`locate_pidl` 返回相对 PIDL（`ShellPidl` 持有）→
    /// `ILCombine(root, relative)` 生成新的绝对 PIDL（同样由 `ShellPidl` 持有）→
    /// `SHCreateShellItemArrayFromIDLists` 自行复制数组内容 → 本地 PIDL 在批次结束时
    /// 各释放一次（`ShellPidl::drop`），不重复释放。
    ///
    /// 个别项失败只计失败数、继续处理后续批次；任一批次仍有失败项时返回 Err，
    /// 让清空子进程以非零码退出并保留真实状态。无法定位的路径同样计失败，
    /// 绝不静默丢弃。
    pub(crate) fn purge_volume_batches(
        paths: &[std::path::PathBuf],
        batch_size: usize,
        mut on_batch_done: impl FnMut(PurgeBatchTiming),
    ) -> AppResult<()> {
        if paths.is_empty() {
            return Ok(());
        }
        ensure_com()
            .map_err(|message| AppError::Unavailable(format!("{RECYCLE_OP_COM_UNAVAILABLE}: {message}")))?;
        let namespace = bin_namespace()?;
        let mut locator = Locator::new(&namespace);
        let batch_size = batch_size.max(1);
        let mut total = 0usize;
        let mut failed = 0usize;
        for chunk in paths.chunks(batch_size) {
            let started = std::time::Instant::now();
            // 绝对 PIDL 与 `queued_paths` 一一对应；批次结束时统一释放。
            let mut absolute: Vec<ShellPidl> = Vec::with_capacity(chunk.len());
            let mut queued_paths: Vec<&std::path::PathBuf> = Vec::with_capacity(chunk.len());
            for path in chunk {
                total += 1;
                if !path.exists() {
                    // 条目在扫描后消失/不可读：如实计失败，不静默丢弃。
                    failed += 1;
                    continue;
                }
                let Some(relative) = locator.locate_pidl(path) else {
                    failed += 1;
                    continue;
                };
                // relative 在本次迭代结束时释放；combined 是新分配的绝对 PIDL。
                let combined = unsafe { ILCombine(Some(namespace.root.0), Some(relative.0)) };
                if combined.is_null() {
                    failed += 1;
                    continue;
                }
                absolute.push(ShellPidl(combined));
                queued_paths.push(path);
            }

            let mut perform = std::time::Duration::ZERO;
            if absolute.is_empty() {
                on_batch_done(PurgeBatchTiming {
                    items: chunk.len(),
                    prepare: started.elapsed(),
                    perform,
                });
                continue;
            }

            let pointers: Vec<*const ITEMIDLIST> = absolute
                .iter()
                .map(|pidl| pidl.0 as *const ITEMIDLIST)
                .collect();
            let items: IShellItemArray =
                match unsafe { SHCreateShellItemArrayFromIDLists(&pointers) } {
                    Ok(items) => items,
                    Err(_) => {
                        failed += absolute.len();
                        on_batch_done(PurgeBatchTiming {
                            items: chunk.len(),
                            prepare: started.elapsed(),
                            perform,
                        });
                        continue;
                    }
                };
            let operation = match file_operation() {
                Ok(operation) => operation,
                Err(_) => {
                    failed += absolute.len();
                    on_batch_done(PurgeBatchTiming {
                        items: chunk.len(),
                        prepare: started.elapsed(),
                        perform,
                    });
                    continue;
                }
            };
            // 整批共享一个 sink：逐项结果由系统回调里的 `psiitem` 回填到 `by_path`。
            let (sink, slot) = new_sink();
            let cookie = match unsafe { operation.Advise(&sink) } {
                Ok(cookie) => cookie,
                Err(_) => {
                    failed += absolute.len();
                    on_batch_done(PurgeBatchTiming {
                        items: chunk.len(),
                        prepare: started.elapsed(),
                        perform,
                    });
                    continue;
                }
            };
            if unsafe { operation.DeleteItems(&items) }.is_err() {
                let _ = unsafe { operation.Unadvise(cookie) };
                failed += absolute.len();
                on_batch_done(PurgeBatchTiming {
                    items: chunk.len(),
                    prepare: started.elapsed(),
                    perform,
                });
                continue;
            }
            let prepare = started.elapsed();
            let performing = std::time::Instant::now();
            let performed = unsafe { operation.PerformOperations() };
            let _ = unsafe { operation.Unadvise(cookie) };
            // 无法确认中止状态时按「已中止」处理：缺结果的条目绝不会被误判为成功。
            let aborted = unsafe { operation.GetAnyOperationsAborted() }
                .map(|value| value.as_bool())
                .unwrap_or(true);
            for path in &queued_paths {
                let hr = path_sink_result(&slot, path.as_path());
                if judge_item(hr, aborted, !path.exists()) != ItemVerdict::Ok {
                    failed += 1;
                }
            }
            perform = performing.elapsed();
            if performed.is_err() {
                // 操作级失败：本批未执行项已计失败，剩余批次不再继续。
                return Err(AppError::Unavailable(format!(
                    "回收站批量删除失败（{failed}/{total} 项未完成）"
                )));
            }
            on_batch_done(PurgeBatchTiming {
                items: chunk.len(),
                prepare,
                perform,
            });
        }
        if failed > 0 {
            return Err(AppError::Unavailable(format!(
                "回收站批量删除有 {failed}/{total} 项未完成"
            )));
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::Win32::UI::Shell::FOF_ALLOWUNDO;

        /// rename 计划在批次内不得重复占用同一目标名。
        #[test]
        fn rename_plan_never_reuses_a_target_name_in_batch() {
            let parent = std::env::temp_dir();
            let name = format!(
                "taskdock-recycle-rename-{}.txt",
                uuid::Uuid::new_v4().simple()
            );
            let mut reserved = HashSet::new();
            let first = unique_name(&parent, &name, &reserved);
            reserved.insert(parent.join(&first));
            let second = unique_name(&parent, &name, &reserved);
            assert_ne!(first, second);
            assert!(second.ends_with(".txt"));
        }

        // ── 真实 Shell 测试（默认 #[ignore]，需显式开启） ──────────────────
        // 只创建唯一前缀的受控文件/目录；严禁清空回收站，也不触碰用户已有条目。
        // 结束后只删除本测试创建的文件，并对本测试产生的回收站条目走 purge 路径清理。

        fn native_enabled() -> bool {
            std::env::var("TD_RECYCLE_NATIVE_TESTS").ok().as_deref() == Some("1")
        }

        fn bin_root_of(path: &Path) -> std::path::PathBuf {
            let volume = crate::recycle::volume::volume_label_of_path(&path.to_string_lossy());
            let drive_root = crate::recycle::volume::drive_root_of(&volume);
            crate::recycle::volume::bin_root_for_drive(&drive_root)
                .unwrap_or_else(|| panic!("当前卷没有回收站目录: {drive_root}"))
        }

        /// 把本测试自己创建的文件/目录移入回收站（`FOF_ALLOWUNDO`）。
        fn recycle_owned(paths: &[std::path::PathBuf]) {
            unsafe {
                let operation: IFileOperation =
                    CoCreateInstance(&FileOperation, None::<&windows::core::IUnknown>, CLSCTX_ALL)
                        .expect("IFileOperation");
                operation
                    .SetOperationFlags(
                        FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT,
                    )
                    .expect("设置回收站操作参数");
                for path in paths {
                    let text = wide(&path.to_string_lossy());
                    let item: IShellItem =
                        SHCreateItemFromParsingName(PCWSTR(text.as_ptr()), None::<&IBindCtx>)
                            .expect("解析待回收项目");
                    operation
                        .DeleteItem(&item, None::<&IFileOperationProgressSink>)
                        .expect("排队回收");
                }
                operation.PerformOperations().expect("执行回收");
            }
        }

        /// 在回收站根中按 `$I` 原始路径匹配本测试条目，构造 `NativeTarget`。
        fn entry_for(bin_root: &Path, original: &Path) -> Option<NativeTarget> {
            let wanted = normalize_shell_path(&original.to_string_lossy());
            let entries: Vec<std::fs::DirEntry> =
                std::fs::read_dir(bin_root).ok()?.flatten().collect();
            for entry in &entries {
                let data_name = entry.file_name().to_string_lossy().into_owned();
                if !data_name.to_lowercase().starts_with("$r") {
                    continue;
                }
                let meta_name = format!("$i{}", &data_name[2..]).to_lowercase();
                let Some(meta) = entries
                    .iter()
                    .find(|e| e.file_name().to_string_lossy().to_lowercase() == meta_name)
                else {
                    continue;
                };
                let Ok(bytes) = std::fs::read(meta.path()) else {
                    continue;
                };
                let parsed = crate::recycle::meta::parse_meta(
                    &bytes,
                    chrono::Utc::now().timestamp_millis(),
                );
                if normalize_shell_path(&parsed.original_path) != wanted {
                    continue;
                }
                return Some(NativeTarget {
                    name: original
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    bin_root: bin_root.to_string_lossy().into_owned(),
                    data_name,
                    original_path: original.to_string_lossy().into_owned(),
                });
            }
            None
        }

        #[test]
        #[ignore = "真实回收站 Shell 测试；设置 TD_RECYCLE_NATIVE_TESTS=1 后手动执行"]
        fn native_restore_and_purge_roundtrip() {
            if !native_enabled() {
                eprintln!("跳过：未设置 TD_RECYCLE_NATIVE_TESTS=1");
                return;
            }
            // 测试线程同样必须走生产的 STA 初始化路径。
            ensure_com().expect("初始化测试线程 COM");
            let token = uuid::Uuid::new_v4().simple().to_string();
            let prefix = format!("taskdock-recycle-test-{token}");
            let root = std::env::temp_dir().join(&prefix);
            std::fs::create_dir_all(&root).expect("创建测试目录");
            let bin_root = bin_root_of(&root);

            // 1) 文件 / 中文文件名 / 文件夹：逐项恢复。
            let file = root.join(format!("{prefix}-file.txt"));
            let chinese = root.join(format!("{prefix}-中文.txt"));
            let directory = root.join(format!("{prefix}-dir"));
            std::fs::write(&file, b"file").unwrap();
            std::fs::write(&chinese, b"cn").unwrap();
            std::fs::create_dir(&directory).unwrap();
            std::fs::write(directory.join("inner.txt"), b"x").unwrap();
            recycle_owned(&[file.clone(), chinese.clone(), directory.clone()]);
            let targets: Vec<NativeTarget> = [&file, &chinese, &directory]
                .iter()
                .map(|path| entry_for(&bin_root, path).expect("回收站条目应可定位"))
                .collect();
            let restored = restore_batch(&targets, RestoreConflict::Skip);
            assert_eq!(restored.len(), targets.len());
            for (target, outcome) in targets.iter().zip(&restored) {
                assert_eq!(outcome.status, "ok", "{}: {}", target.name, outcome.code);
            }
            assert!(file.exists() && chinese.exists() && directory.join("inner.txt").exists());

            // 2) 同名冲突：先在原位置重建同名文件，再恢复。
            //    skip 不覆盖现有文件；rename 生成新名字，原文件保持不变。
            recycle_owned(&[file.clone()]);
            let conflicting = entry_for(&bin_root, &file).expect("冲突条目应可定位");
            std::fs::write(&file, b"keep").unwrap();
            let skipped = restore_batch(std::slice::from_ref(&conflicting), RestoreConflict::Skip);
            assert_eq!(skipped[0].status, "skipped");
            assert_eq!(std::fs::read(&file).unwrap(), b"keep".to_vec());
            let renamed = restore_batch(std::slice::from_ref(&conflicting), RestoreConflict::Rename);
            assert_eq!(renamed[0].status, "ok", "{}", renamed[0].code);
            assert_eq!(std::fs::read(&file).unwrap(), b"keep".to_vec());

            // 3) 目标目录缺失：恢复必须如实失败，随后只清理本测试条目。
            let nested_dir = root.join("nested");
            std::fs::create_dir(&nested_dir).unwrap();
            let nested = nested_dir.join(format!("{prefix}-nested.txt"));
            std::fs::write(&nested, b"nested").unwrap();
            recycle_owned(&[nested.clone()]);
            let nested_target = entry_for(&bin_root, &nested).expect("嵌套条目应可定位");
            std::fs::remove_dir(&nested_dir).unwrap();
            let missing = restore_batch(&[nested_target.clone()], RestoreConflict::Skip);
            assert_eq!(missing[0].status, "failed");
            assert_eq!(missing[0].code, RECYCLE_OP_PARENT_MISSING);
            let cleaned = purge_batch(&[nested_target]);
            assert_eq!(cleaned[0].status, "ok", "{}", cleaned[0].code);

            // 4) 永久删除：HRESULT 成功且 `$R` 消失才算成功。
            let doomed = root.join(format!("{prefix}-purge.txt"));
            std::fs::write(&doomed, b"bye").unwrap();
            recycle_owned(&[doomed.clone()]);
            let doomed_target = entry_for(&bin_root, &doomed).expect("待删除条目应可定位");
            let purged = purge_batch(&[doomed_target.clone()]);
            assert_eq!(purged[0].status, "ok", "{}", purged[0].code);
            assert!(!doomed_target.data_path().exists());

            // 只清理本测试自己创建的目录/文件。
            let _ = std::fs::remove_dir_all(&root);
            eprintln!("本次真实回收站测试使用前缀（若清理失败请手动确认）：{prefix}");
        }
    }
}

#[cfg(windows)]
pub use platform::{init_com, purge_batch, restore_batch};
#[cfg(windows)]
pub(crate) use platform::purge_volume_batches;

#[cfg(not(windows))]
pub fn restore_batch(_targets: &[NativeTarget], _conflict: RestoreConflict) -> Vec<NativeOutcome> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn purge_batch(_targets: &[NativeTarget]) -> Vec<NativeOutcome> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn init_com() {}

/// 平台能力判定（前端据此禁用不可用操作）。
pub fn supported() -> bool {
    cfg!(windows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_conflict_policy() {
        assert_eq!(parse_restore_conflict("skip").unwrap(), RestoreConflict::Skip);
        assert_eq!(parse_restore_conflict("").unwrap(), RestoreConflict::Skip);
        assert_eq!(
            parse_restore_conflict("rename").unwrap(),
            RestoreConflict::Rename
        );
        assert!(parse_restore_conflict("overwrite").is_err());
    }

    #[test]
    fn outcome_helpers_are_stable() {
        let ok = NativeOutcome::ok("a.txt");
        assert_eq!(ok.status, "ok");
        assert_eq!(ok.code, RECYCLE_OP_OK);
        let skipped = NativeOutcome::skipped("a.txt", RECYCLE_OP_TARGET_EXISTS, "exists");
        assert_eq!(skipped.status, "skipped");
    }

    fn target(name: &str) -> NativeTarget {
        NativeTarget {
            name: name.to_string(),
            bin_root: r"D:\$Recycle.Bin\S-1".to_string(),
            data_name: format!("$R{name}"),
            original_path: format!(r"D:\work\{name}"),
        }
    }

    /// P0 回归：提前跳过项（下标 1）先写入，成功项（下标 0/2）后写入，
    /// 输出必须仍按输入顺序，不能把跳过结果记到 0 号条目上。
    #[test]
    fn outcome_slots_preserve_input_order_for_skip_then_success() {
        let targets = vec![target("a.txt"), target("b.txt"), target("c.txt")];
        let mut slots = OutcomeSlots::new(targets.len());
        // 模拟真实执行顺序：1 号先因同名被跳过，0/2 号在 PerformOperations 后成功。
        slots.set(
            1,
            NativeOutcome::skipped("b.txt", RECYCLE_OP_TARGET_EXISTS, "exists"),
        );
        slots.set(0, NativeOutcome::ok("a.txt"));
        slots.set(2, NativeOutcome::ok("c.txt"));
        let out = slots.finish(&targets);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].target, "a.txt");
        assert_eq!(out[0].status, "ok");
        assert_eq!(out[1].target, "b.txt");
        assert_eq!(out[1].status, "skipped");
        assert_eq!(out[2].target, "c.txt");
        assert_eq!(out[2].status, "ok");
    }

    /// 契约：未写入的槽位记为失败，绝不以成功或空结果蒙混；条数必须等长。
    #[test]
    fn outcome_slots_are_always_length_aligned() {
        let targets = vec![target("a.txt"), target("b.txt")];
        let mut slots = OutcomeSlots::new(targets.len());
        slots.set(0, NativeOutcome::ok("a.txt"));
        let out = slots.finish(&targets);
        assert_eq!(out.len(), targets.len());
        assert_eq!(out[1].status, "failed");
        assert_eq!(out[1].target, "b.txt");
        assert_eq!(out[1].code, RECYCLE_OP_SHELL_FAILED);
    }

    /// 契约：只有一个条目时也必须等长（空输入不 panic）。
    #[test]
    fn outcome_slots_handle_empty_and_single() {
        let empty: Vec<NativeTarget> = Vec::new();
        let out = OutcomeSlots::new(0).finish(&empty);
        assert!(out.is_empty());

        let one = vec![target("only.txt")];
        let out = OutcomeSlots::new(1).finish(&one);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].target, "only.txt");
    }

    /// COM 状态机：S_OK 与 S_FALSE 都算本次初始化成功，`RPC_E_CHANGED_MODE`
    /// 必须归类为明确的不可用（调用方据此整批失败），其他 HRESULT 同样是失败。
    #[test]
    fn com_init_classification_is_strict() {
        assert_eq!(classify_com_init(false, 0), ComInitStep::Acquired);
        assert_eq!(classify_com_init(false, 1), ComInitStep::Acquired);
        assert_eq!(
            classify_com_init(false, 0x8001_0106u32 as i32),
            ComInitStep::ChangedMode
        );
        assert_eq!(
            classify_com_init(false, 0x8000_4005u32 as i32),
            ComInitStep::Failed(0x8000_4005u32 as i32)
        );
        // 本线程已就绪：不再调用 CoInitializeEx。
        assert_eq!(classify_com_init(true, 0), ComInitStep::AlreadyInitialized);
        assert_eq!(
            classify_com_init(true, 0x8001_0106u32 as i32),
            ComInitStep::AlreadyInitialized
        );
    }

    /// 逐项判定：只有「系统 HRESULT 成功 + 复核成立」才算 ok；
    /// 系统成功但复核不成立必须落到 `RECYCLE_VERIFY_FAILED`，不能凭任一侧单独成功。
    #[test]
    fn item_verdict_requires_system_result_and_verification() {
        assert_eq!(judge_item(Some(0), false, true), ItemVerdict::Ok);
        assert_eq!(judge_item(Some(1), true, true), ItemVerdict::Ok);
        assert_eq!(judge_item(Some(0), false, false), ItemVerdict::VerifyFailed);
        assert_eq!(judge_item(Some(0), true, false), ItemVerdict::VerifyFailed);
        assert!(matches!(
            judge_item(Some(0x8007_0005u32 as i32), false, true),
            ItemVerdict::ShellFailed(_)
        ));
        // 系统没有回调：被中止时是取消，否则如实失败（不因路径恰好存在而算成功）。
        assert_eq!(judge_item(None, true, true), ItemVerdict::Cancelled);
        assert!(matches!(
            judge_item(None, false, true),
            ItemVerdict::ShellFailed(_)
        ));
    }

    /// `$R` 全路径映射必须大小写无关，并忽略 `\\?\` 前缀与尾部反斜杠。
    #[test]
    fn shell_path_keys_match_case_insensitively() {
        let scanned = normalize_shell_path(r"D:\$Recycle.Bin\S-1-5-21\$RAbC.txt");
        let enumerated = normalize_shell_path(r"d:\$RECYCLE.BIN\s-1-5-21\$rabc.TXT");
        assert_eq!(scanned, enumerated);
        assert_eq!(
            normalize_shell_path(r"\\?\D:\$Recycle.Bin\S-1\"),
            normalize_shell_path(r"d:\$recycle.bin\S-1")
        );
        assert_ne!(
            normalize_shell_path(r"D:\$Recycle.Bin\S-1\$Ra.txt"),
            normalize_shell_path(r"D:\$Recycle.Bin\S-1\$Rb.txt")
        );
    }

    #[test]
    fn new_stable_codes_are_distinct() {
        assert_eq!(RECYCLE_OP_COM_UNAVAILABLE, "RECYCLE_COM_UNAVAILABLE");
        assert_eq!(RECYCLE_OP_VERIFY_FAILED, "RECYCLE_VERIFY_FAILED");
        assert_ne!(RECYCLE_OP_COM_UNAVAILABLE, RECYCLE_OP_SHELL_FAILED);
        assert_ne!(RECYCLE_OP_VERIFY_FAILED, RECYCLE_OP_SHELL_FAILED);
    }
}

