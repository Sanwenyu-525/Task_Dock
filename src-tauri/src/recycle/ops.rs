//! 回收站原生操作：恢复 / 永久删除 / 清空。
//!
//! ## 为什么不用 `$I`/`$R` 直接搬运
//! 直接删除 `$R` 或移动 `$R` 会留下/破坏 `$I` 记录，造成「幽灵条目」或数据
//! 与元数据不一致；本项目明确规定删除、恢复、清空必须走 Windows 原生机制。
//!
//! ## 采用的原生路径
//! 1. 通过 `SHGetKnownFolderIDList(FOLDERID_RecycleBinFolder)` 绑定到回收站
//!    Shell 命名空间（`IShellFolder`）；
//! 2. 用 `IShellFolder::ParseDisplayName("X:\\$Recycle.Bin\\<SID>\\$Rxxx")`
//!    取得**回收站项目**（不是普通文件系统项），Shell 会返回原始显示名；
//! 3. 恢复用 `IFileOperation::MoveItem` 移动到原始目录（等同 Explorer 的
//!    「还原」，由 Shell 负责迁移数据并清理 `$I`）；
//!    永久删除用 `IFileOperation::DeleteItem`；
//! 4. 清空按卷绑定原生项目，以 Shell 条目数组分批永久删除。
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

/// 一个待恢复/删除的原生目标。
#[derive(Debug, Clone)]
pub struct NativeTarget {
    /// 展示名（仅用于结果，不参与路径拼接）。
    pub name: String,
    /// `$R` 数据路径（`X:\$Recycle.Bin\<SID>\$R...`）。
    pub data_path: String,
    /// 原始路径（恢复目标）。永久删除时可为空。
    pub original_path: String,
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

#[cfg(windows)]
mod platform {
    use super::*;
    use std::collections::HashSet;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PCWSTR;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, IBindCtx, CLSCTX_ALL,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOperation, IFileOperation, IFileOperationProgressSink, IShellFolder, IShellItem,
        ILCombine, SHCreateItemFromParsingName, SHCreateItemWithParent,
        SHCreateShellItemArrayFromIDLists, SHGetDesktopFolder,
        SHGetKnownFolderIDList, FOLDERID_RecycleBinFolder, FOF_NOCONFIRMATION,
        FOF_NOERRORUI, FOF_SILENT,
    };
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// 初始化 COM（STA）。已初始化时返回 `RPC_E_CHANGED_MODE` 也能继续使用。
    /// 工作线程由任务层新建，线程退出时 COM 自动反初始化，不做引用计数。
    pub fn init_com() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok();
        }
    }

    struct ShellPidl(*mut ITEMIDLIST);

    impl Drop for ShellPidl {
        fn drop(&mut self) {
            unsafe { CoTaskMemFree(Some(self.0.cast())) };
        }
    }

    fn bin_folder_with_id() -> AppResult<(IShellFolder, ShellPidl)> {
        unsafe {
            let pidl =
                SHGetKnownFolderIDList(&FOLDERID_RecycleBinFolder, 0, None).map_err(|e| {
                    AppError::Unavailable(format!("无法定位回收站命名空间: {e}"))
                })?;
            let pidl = ShellPidl(pidl);
            let folder: IShellFolder = SHGetDesktopFolder()
                .and_then(|desktop| {
                    let bind = windows::Win32::System::Com::CreateBindCtx(0)?;
                    desktop.BindToObject(pidl.0, &bind)
                })
                .map_err(|e| AppError::Unavailable(format!("绑定回收站失败: {e}")))?;
            Ok((folder, pidl))
        }
    }

    fn bin_folder() -> AppResult<IShellFolder> {
        bin_folder_with_id().map(|(folder, _)| folder)
    }

    /// `$R` 路径 → 回收站 Shell 项目。失败返回 `None`（条目可能已消失）。
    fn parse_pidl(folder: &IShellFolder, data_path: &str) -> Option<ShellPidl> {
        unsafe {
            let name = wide(data_path);
            let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
            folder
                .ParseDisplayName(
                    windows::Win32::Foundation::HWND(std::ptr::null_mut()),
                    None::<&IBindCtx>,
                    PCWSTR(name.as_ptr()),
                    None,
                    &mut pidl,
                    std::ptr::null_mut(),
                )
                .ok()?;
            (!pidl.is_null()).then_some(ShellPidl(pidl))
        }
    }

    fn parse_item(folder: &IShellFolder, data_path: &str) -> Option<IShellItem> {
        let pidl = parse_pidl(folder, data_path)?;
        unsafe { SHCreateItemWithParent(None, folder, pidl.0) }.ok()
    }

    /// 仅接收从当前用户已选回收站卷读取的配对项。批次复用 Shell 命名空间。
    pub(crate) fn purge_volume_batches(
        paths: &[std::path::PathBuf],
        batch_size: usize,
        mut on_batch_done: impl FnMut(PurgeBatchTiming),
    ) -> AppResult<()> {
        if paths.is_empty() {
            return Ok(());
        }
        init_com();
        let (folder, parent) = bin_folder_with_id()?;
        for paths in paths.chunks(batch_size) {
            let started = std::time::Instant::now();
            let ids: Vec<_> = paths.iter()
                .filter_map(|path| parse_pidl(&folder, &path.to_string_lossy()))
                .collect();
            if ids.is_empty() {
                continue;
            }
            unsafe {
                let absolute = ids.iter().map(|id| {
                    let full_id = ILCombine(Some(parent.0), Some(id.0));
                    if full_id.is_null() {
                        return Err(AppError::Unavailable("无法构造回收站条目标识".into()));
                    }
                    Ok(ShellPidl(full_id))
                }).collect::<AppResult<Vec<_>>>()?;
                let pointers: Vec<_> = absolute.iter().map(|id| id.0.cast_const()).collect();
                let items = SHCreateShellItemArrayFromIDLists(&pointers)
                    .map_err(|e| AppError::Unavailable(format!("无法构造回收站条目数组: {e}")))?;
                let operation = file_operation()?;
                operation.DeleteItems(&items)
                    .map_err(|e| AppError::Unavailable(format!("回收站批量排队失败: {e}")))?;
                let performing = std::time::Instant::now();
                operation.PerformOperations()
                    .map_err(|e| AppError::Unavailable(format!("回收站批量永久删除失败: {e}")))?;
                if operation.GetAnyOperationsAborted()
                    .map_err(|e| AppError::Unavailable(format!("无法确认回收站批量删除结果: {e}")))?
                    .as_bool()
                {
                    return Err(AppError::Unavailable("系统中止了回收站批量删除".into()));
                }
                on_batch_done(PurgeBatchTiming {
                    items: ids.len(),
                    prepare: performing.duration_since(started),
                    perform: performing.elapsed(),
                });
            }
        }
        Ok(())
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

    struct RestorePlan {
        target: NativeTarget,
        final_path: std::path::PathBuf,
        item: IShellItem,
        dest: IShellItem,
    }

    /// 批量恢复：整批只排队一次 `PerformOperations`，避免每项一次 Shell 操作。
    /// 返回逐条结果（成功以「原始路径已存在」为准，不轻信 HRESULT）。
    /// **契约：返回结果与输入同序、等长**，调用方按下标映射，不得按名称猜测。
    pub fn restore_batch(targets: &[NativeTarget], conflict: RestoreConflict) -> Vec<NativeOutcome> {
        init_com();
        let mut slots = OutcomeSlots::new(targets.len());
        let folder = match bin_folder() {
            Ok(folder) => folder,
            Err(e) => {
                let message = e.to_string();
                for (index, target) in targets.iter().enumerate() {
                    slots.set(
                        index,
                        NativeOutcome::failed(
                            &target.name,
                            RECYCLE_OP_SHELL_FAILED,
                            message.clone(),
                        ),
                    );
                }
                return slots.finish(targets);
            }
        };
        let operation = match file_operation() {
            Ok(op) => op,
            Err(e) => {
                let message = e.to_string();
                for (index, target) in targets.iter().enumerate() {
                    slots.set(
                        index,
                        NativeOutcome::failed(
                            &target.name,
                            RECYCLE_OP_SHELL_FAILED,
                            message.clone(),
                        ),
                    );
                }
                return slots.finish(targets);
            }
        };

        let mut reserved: HashSet<std::path::PathBuf> = HashSet::new();
        // (输入下标, 计划)：下标用于回填结果，绝不依赖 `Vec` 追加顺序。
        let mut plans: Vec<(usize, RestorePlan)> = Vec::with_capacity(targets.len());
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
                RestoreConflict::Rename => unique_name(&parent, &file_name, &reserved),
            };
            if !Path::new(&target.data_path).exists() {
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
            let item = parse_item(&folder, &target.data_path);
            let Some(item) = item else {
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
                Err(e) => {
                    slots.set(
                        index,
                        NativeOutcome::failed(
                            &target.name,
                            RECYCLE_OP_SHELL_FAILED,
                            e.to_string(),
                        ),
                    );
                    continue;
                }
            };
            let final_path = parent.join(&final_name);
            reserved.insert(final_path.clone());
            let name_wide = wide(&final_name);
            let new_name = PCWSTR(name_wide.as_ptr());
            if let Err(e) = unsafe {
                operation.MoveItem(
                    &item,
                    &dest,
                    new_name,
                    None::<&IFileOperationProgressSink>,
                )
            } {
                slots.set(
                    index,
                    NativeOutcome::failed(
                        &target.name,
                        RECYCLE_OP_SHELL_FAILED,
                        e.to_string(),
                    ),
                );
                continue;
            }
            plans.push((
                index,
                RestorePlan {
                    target: target.clone(),
                    final_path,
                    item,
                    dest,
                },
            ));
        }

        if plans.is_empty() {
            return slots.finish(targets);
        }
        // IFileOperation 是队列式的：整批只执行一次，大幅减少 Shell 往返。
        let performed = unsafe { operation.PerformOperations() };
        let aborted = unsafe { operation.GetAnyOperationsAborted() }
            .map(|value| value.as_bool())
            .unwrap_or(false);
        if performed.is_err() || aborted {
            let message = performed
                .err()
                .map(|e| e.to_string())
                .unwrap_or_else(|| "系统中止了恢复操作".to_string());
            for (index, plan) in plans {
                slots.set(
                    index,
                    NativeOutcome::failed(
                        &plan.target.name,
                        RECYCLE_OP_SHELL_FAILED,
                        message.clone(),
                    ),
                );
            }
            return slots.finish(targets);
        }
        for (index, plan) in plans {
            // 以真实文件系统结果为准：原始路径出现才算成功。
            if plan.final_path.exists() {
                slots.set(index, NativeOutcome::ok(&plan.target.name));
            } else {
                slots.set(
                    index,
                    NativeOutcome::failed(
                        &plan.target.name,
                        RECYCLE_OP_SHELL_FAILED,
                        "系统未完成恢复（目标位置未出现文件）",
                    ),
                );
            }
        }
        slots.finish(targets)
    }

    /// 批量永久删除（回收站内项目）：整批排队，一次 `PerformOperations`。
    /// **契约：返回结果与输入同序、等长**；入队失败项只产出一条失败结果。
    pub fn purge_batch(targets: &[NativeTarget]) -> Vec<NativeOutcome> {
        init_com();
        let mut slots = OutcomeSlots::new(targets.len());
        let folder = match bin_folder() {
            Ok(folder) => folder,
            Err(e) => {
                let message = e.to_string();
                for (index, target) in targets.iter().enumerate() {
                    slots.set(
                        index,
                        NativeOutcome::failed(
                            &target.name,
                            RECYCLE_OP_SHELL_FAILED,
                            message.clone(),
                        ),
                    );
                }
                return slots.finish(targets);
            }
        };
        // (输入下标, 目标, Shell 项目)
        let mut plans: Vec<(usize, NativeTarget, IShellItem)> = Vec::with_capacity(targets.len());
        for (index, target) in targets.iter().enumerate() {
            let Some(item) = parse_item(&folder, &target.data_path) else {
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
            plans.push((index, target.clone(), item));
        }
        if plans.is_empty() {
            return slots.finish(targets);
        }
        let operation = match file_operation() {
            Ok(op) => op,
            Err(e) => {
                let message = e.to_string();
                for (index, target, _) in plans {
                    slots.set(
                        index,
                        NativeOutcome::failed(
                            &target.name,
                            RECYCLE_OP_SHELL_FAILED,
                            message.clone(),
                        ),
                    );
                }
                return slots.finish(targets);
            }
        };
        let mut queued = vec![false; targets.len()];
        let mut queued_count = 0usize;
        for (target_index, target, item) in &plans {
            match unsafe { operation.DeleteItem(item, None::<&IFileOperationProgressSink>) } {
                Ok(()) => {
                    queued[*target_index] = true;
                    queued_count += 1;
                }
                Err(e) => {
                    // 入队失败只在这里记一次；不得在 PerformOperations 之后重复产出。
                    slots.set(
                        *target_index,
                        NativeOutcome::failed(
                            &target.name,
                            RECYCLE_OP_SHELL_FAILED,
                            e.to_string(),
                        ),
                    );
                }
            }
        }
        if queued_count == 0 {
            return slots.finish(targets);
        }
        let performed = unsafe { operation.PerformOperations() };
        let failed_all = performed.as_ref().err().map(|e| e.to_string());
        for (target_index, target, _) in &plans {
            if !queued[*target_index] {
                // 没进 Shell 队列：已有自己的失败结果，不覆盖、不重复。
                continue;
            }
            let outcome = if let Some(message) = &failed_all {
                NativeOutcome::failed(&target.name, RECYCLE_OP_SHELL_FAILED, message.clone())
            } else if Path::new(&target.data_path).exists() {
                NativeOutcome::failed(
                    &target.name,
                    RECYCLE_OP_SHELL_FAILED,
                    "系统未完成永久删除",
                )
            } else {
                NativeOutcome::ok(&target.name)
            };
            slots.set(*target_index, outcome);
        }
        slots.finish(targets)
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
            data_path: format!(r"D:\$Recycle.Bin\S-1\$R{name}"),
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
}
