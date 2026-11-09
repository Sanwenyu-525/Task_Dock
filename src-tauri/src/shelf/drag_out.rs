//! 文件暂存架：系统级拖出（Windows OLE）。
//!
//! 约束与边界：
//! - `DoDragDrop` 必须在左键仍按下时、在 STA 线程上进入。命令线程属于 tokio
//!   线程池，可能已被其它模块以 MTA 初始化，不能复用；每次拖拽起独立线程并
//!   `OleInitialize` / `OleUninitialize` 成对调用。
//! - 数据对象由本模块自己实现 `IDataObject`，只暴露 `CF_HDROP`：shell 的
//!   `SHCreateDataObject` 在本机实测返回空格式集，无法保证资源管理器/编辑器
//!   都能拿到文件；自实现可精确控制格式与 `STGMEDIUM` 所有权。
//! - 路径只来自库内 `shelf::resolve_item_file`，前端传不了任意路径。
//! - 托管副本只允许复制（移动会把内部副本移出托管目录，直接弄坏暂存记录）；
//!   引用模式允许 Windows 默认的复制/移动语义。
//! - 同一时刻只允许一个拖拽会话；`DoDragDrop` 返回后统一释放数据对象与 COM。

#[cfg(not(windows))]
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// 一次拖拽的最终结果。`effect` 是目标应用实际接受的放置效果。
#[derive(Debug, Clone, Serialize)]
pub struct DragOutOutcome {
    /// copy | move | none
    pub effect: String,
    pub count: usize,
    /// 拖拽结束后已不存在的源路径（move 后由目标应用搬走）。
    pub missing_paths: Vec<String>,
}

/// 进程级单飞守卫：避免快速重复 pointerdown 触发多个 DoDragDrop。
pub struct DragInFlightGuard;

static DRAG_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

impl DragInFlightGuard {
    pub fn acquire() -> AppResult<Self> {
        if DRAG_IN_FLIGHT
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(AppError::Conflict(
                "已有文件拖拽正在进行，请先松开鼠标".into(),
            ));
        }
        Ok(Self)
    }
}

impl Drop for DragInFlightGuard {
    fn drop(&mut self) {
        DRAG_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

/// DROPEFFECT 位 → 前端可读结果（纯函数，便于无 COM 环境验证）。
pub fn effect_label(effect_bits: u32) -> &'static str {
    match effect_bits {
        1 => "copy",
        2 => "move",
        _ => "none",
    }
}

/// 只有全部为引用模式的物理条目才允许移动；托管副本一律只复制。
pub fn allow_move_for(modes: &[&str]) -> bool {
    !modes.is_empty() && modes.iter().all(|mode| *mode == super::MODE_REFERENCE)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DragDecision {
    Continue,
    Drop,
    Cancel,
}

/// `IDropSource::QueryContinueDrag` 的决策：Esc 优先，其次看左键是否仍按下。
pub fn query_decision(escape_pressed: bool, left_button_down: bool) -> DragDecision {
    if escape_pressed {
        DragDecision::Cancel
    } else if !left_button_down {
        DragDecision::Drop
    } else {
        DragDecision::Continue
    }
}

#[cfg(windows)]
mod windows_impl {
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;

    use windows::core::{implement, BOOL, HRESULT, Ref};
    use windows::Win32::Foundation::{
        DATA_S_SAMEFORMATETC, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS,
        DV_E_FORMATETC, E_INVALIDARG, E_NOTIMPL, GlobalFree, S_OK,
    };
    use windows::Win32::System::Com::{
        DATADIR_GET, DVASPECT_CONTENT, FORMATETC, IAdviseSink, IDataObject, IDataObject_Impl,
        IEnumFORMATETC, IEnumSTATDATA, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::{
        DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize, CF_HDROP,
        DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE, DROPEFFECT_NONE,
    };
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
    use windows::Win32::UI::Shell::SHCreateStdEnumFmtEtc;

    use super::{
        effect_label, query_decision, AppError, AppResult, DragDecision, DragOutOutcome,
    };

    #[implement(IDropSource)]
    struct ShelfDropSource;

    impl IDropSource_Impl for ShelfDropSource_Impl {
        fn QueryContinueDrag(
            &self,
            fescapepressed: BOOL,
            _grfkeystate: MODIFIERKEYS_FLAGS,
        ) -> HRESULT {
            // 拖拽循环在专用线程上运行：OLE 传入的 grfKeyState 来自该线程的
            // GetKeyState，后台 STA 线程不一定会随全局鼠标更新，实测会永远
            // 认为左键仍按下、拖拽无法结束。这里直接读全局按键状态。
            let left_down = unsafe {
                (windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(
                    0x01, // VK_LBUTTON
                ) as u16
                    & 0x8000)
                    != 0
            };
            match query_decision(fescapepressed.as_bool(), left_down) {
                DragDecision::Cancel => DRAGDROP_S_CANCEL,
                DragDecision::Drop => DRAGDROP_S_DROP,
                DragDecision::Continue => S_OK,
            }
        }

        fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    /// CF_HDROP 的 DROPFILES 字节：20 字节头 + UTF-16 双零结尾路径列表。
    pub(super) fn hdrop_bytes(paths: &[PathBuf]) -> Vec<u8> {
        let mut wide: Vec<u16> = Vec::new();
        for path in paths {
            wide.extend(path.as_os_str().encode_wide());
            wide.push(0);
        }
        wide.push(0);
        let mut out = vec![0u8; 20];
        out[0..4].copy_from_slice(&20u32.to_le_bytes());
        out[16..20].copy_from_slice(&1u32.to_le_bytes()); // fWide
        for unit in wide {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out
    }

    fn format_etc() -> FORMATETC {
        FORMATETC {
            cfFormat: CF_HDROP.0,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        }
    }

    fn supports(format: &FORMATETC) -> bool {
        format.cfFormat == CF_HDROP.0
            && format.dwAspect == DVASPECT_CONTENT.0
            && (format.lindex == -1 || format.lindex == 0)
            && (format.tymed & TYMED_HGLOBAL.0 as u32) != 0
    }

    unsafe fn hglobal_medium(bytes: &[u8]) -> windows::core::Result<STGMEDIUM> {
        let handle = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1))?;
        let ptr = GlobalLock(handle);
        if ptr.is_null() {
            let _ = GlobalFree(Some(handle));
            return Err(windows::core::Error::from_thread());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
        let _ = GlobalUnlock(handle);
        Ok(STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: handle },
            pUnkForRelease: std::mem::ManuallyDrop::new(None),
        })
    }

    /// 文件拖出数据对象：只暴露 CF_HDROP，目标应用按文件接收。
    #[implement(IDataObject)]
    struct ShelfDataObject {
        paths: Vec<PathBuf>,
    }

    impl IDataObject_Impl for ShelfDataObject_Impl {
        fn GetData(&self, pformatetcin: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
            if pformatetcin.is_null() {
                return Err(E_INVALIDARG.into());
            }
            let format = unsafe { *pformatetcin };
            if !supports(&format) {
                return Err(DV_E_FORMATETC.into());
            }
            let bytes = hdrop_bytes(&self.paths);
            unsafe { hglobal_medium(&bytes) }
        }

        fn GetDataHere(
            &self,
            _pformatetc: *const FORMATETC,
            _pmedium: *mut STGMEDIUM,
        ) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
            if pformatetc.is_null() {
                return E_INVALIDARG;
            }
            if supports(&unsafe { *pformatetc }) {
                S_OK
            } else {
                DV_E_FORMATETC
            }
        }

        fn GetCanonicalFormatEtc(
            &self,
            pformatectin: *const FORMATETC,
            pformatetcout: *mut FORMATETC,
        ) -> HRESULT {
            if pformatectin.is_null() || pformatetcout.is_null() {
                return E_INVALIDARG;
            }
            unsafe {
                let mut copied = *pformatectin;
                copied.ptd = std::ptr::null_mut();
                *pformatetcout = copied;
            }
            DATA_S_SAMEFORMATETC
        }

        fn SetData(
            &self,
            _pformatetc: *const FORMATETC,
            _pmedium: *const STGMEDIUM,
            _frelease: BOOL,
        ) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn EnumFormatEtc(&self, dwdirection: u32) -> windows::core::Result<IEnumFORMATETC> {
            if dwdirection != DATADIR_GET.0 as u32 {
                return Err(E_NOTIMPL.into());
            }
            unsafe { SHCreateStdEnumFmtEtc(&[format_etc()]) }
        }

        fn DAdvise(
            &self,
            _pformatetc: *const FORMATETC,
            _advf: u32,
            _padvsink: Ref<IAdviseSink>,
        ) -> windows::core::Result<u32> {
            Err(E_NOTIMPL.into())
        }

        fn DUnadvise(&self, _dwconnection: u32) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
            Err(E_NOTIMPL.into())
        }
    }

    pub(super) fn data_object_for(paths: &[PathBuf]) -> IDataObject {
        ShelfDataObject {
            paths: paths.to_vec(),
        }
        .into()
    }

    /// 在调用线程上进入 OLE 拖拽循环；调用方必须保证是专用 STA 线程且左键仍按下。
    pub fn run_drag(paths: &[PathBuf], allow_move: bool) -> AppResult<DragOutOutcome> {
        if paths.is_empty() {
            return Err(AppError::Validation("没有可拖出的文件".into()));
        }
        unsafe {
            OleInitialize(None)
                .map_err(|e| AppError::Unavailable(format!("初始化 OLE 失败: {e}")))?;
        }
        let result = (|| unsafe {
            let data = data_object_for(paths);
            let source: IDropSource = ShelfDropSource.into();
            let mut effect = DROPEFFECT_NONE;
            let ok_effects = if allow_move {
                DROPEFFECT_COPY | DROPEFFECT_MOVE
            } else {
                DROPEFFECT_COPY
            };
            let hr = DoDragDrop(&data, &source, ok_effects, &mut effect);
            if let Err(e) = hr.ok() {
                return Err(AppError::Unavailable(format!("系统拖拽失败: {e:?}")));
            }
            let missing_paths = paths
                .iter()
                .filter(|path| !path.exists())
                .map(|path| path.to_string_lossy().to_string())
                .collect();
            Ok(DragOutOutcome {
                effect: effect_label(effect.0).to_string(),
                count: paths.len(),
                missing_paths,
            })
        })();
        unsafe {
            OleUninitialize();
        }
        result
    }
}

#[cfg(windows)]
pub use windows_impl::run_drag;

#[cfg(not(windows))]
pub fn run_drag(_paths: &[PathBuf], _allow_move: bool) -> AppResult<DragOutOutcome> {
    Err(AppError::Unavailable("系统级拖出仅支持 Windows".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effect_label_maps_ole_effects() {
        assert_eq!(effect_label(1), "copy");
        assert_eq!(effect_label(2), "move");
        assert_eq!(effect_label(0), "none");
        assert_eq!(effect_label(5), "none");
    }

    #[test]
    fn query_decision_cancel_wins_over_release() {
        assert_eq!(query_decision(true, true), DragDecision::Cancel);
        assert_eq!(query_decision(true, false), DragDecision::Cancel);
        assert_eq!(query_decision(false, true), DragDecision::Continue);
        assert_eq!(query_decision(false, false), DragDecision::Drop);
    }

    #[test]
    fn allow_move_requires_all_reference() {
        assert!(allow_move_for(&["reference", "reference"]));
        assert!(!allow_move_for(&["reference", "managed"]));
        assert!(!allow_move_for(&["managed"]));
        assert!(!allow_move_for(&[]));
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use std::path::PathBuf;

    use windows::Win32::System::Com::{
        DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL, IDataObject,
    };
    use windows::Win32::System::Ole::{CF_HDROP, ReleaseStgMedium};
    use windows::Win32::UI::Shell::DROPFILES;

    use super::windows_impl::data_object_for;

    fn format_etc() -> FORMATETC {
        FORMATETC {
            cfFormat: CF_HDROP.0,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        }
    }

    #[test]
    fn custom_data_object_exposes_cf_hdrop_with_unicode_paths() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!(
            "taskdock-drag-out-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let file = dir.join("拖拽 测试.txt");
        std::fs::write(&file, b"taskdock").expect("write temp file");

        let data: IDataObject = data_object_for(&[PathBuf::from(&file)]);
        let format = format_etc();
        let mut medium = unsafe { data.GetData(&format) }.expect("GetData(CF_HDROP)");
        let hglobal = unsafe { medium.u.hGlobal };
        let raw = unsafe { windows_sys::Win32::System::Memory::GlobalLock(hglobal.0 as _) };
        assert!(!raw.is_null(), "CF_HDROP global memory must be lockable");
        let drop_files = unsafe { std::ptr::read_unaligned(raw as *const DROPFILES) };
        // DROPFILES 是 packed 结构：按值复制字段，不能对字段建引用。
        let files_offset = drop_files.pFiles;
        let wide = drop_files.fWide.0 != 0;
        assert_eq!(files_offset, 20);
        assert!(wide);

        let mut units = Vec::new();
        let mut cursor = unsafe { (raw as *const u8).add(files_offset as usize) as *const u16 };
        loop {
            let unit = unsafe { *cursor };
            if unit == 0 {
                break;
            }
            units.push(unit);
            cursor = unsafe { cursor.add(1) };
        }
        let parsed = String::from_utf16_lossy(&units);
        assert_eq!(parsed, file.to_string_lossy());

        unsafe {
            windows_sys::Win32::System::Memory::GlobalUnlock(hglobal.0 as _);
            ReleaseStgMedium(&mut medium);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn custom_data_object_enumerates_cf_hdrop_only() {
        let data: IDataObject = data_object_for(&[PathBuf::from(r"C:\test.txt")]);
        let enumerator = unsafe { data.EnumFormatEtc(1) }.expect("EnumFormatEtc");
        let mut formats = [FORMATETC::default(); 4];
        let mut fetched = 0u32;
        let hr = unsafe { enumerator.Next(&mut formats, Some(&mut fetched)) };
        assert!(hr.ok().is_ok());
        assert_eq!(fetched, 1);
        assert_eq!(formats[0].cfFormat, CF_HDROP.0);
    }
}
