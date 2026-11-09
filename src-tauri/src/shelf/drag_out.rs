//! 文件暂存架：系统级拖出（Windows OLE）。
//!
//! 约束与边界：
//! - `DoDragDrop` 必须在左键仍按下时、在 **UI 线程**（tao 已 `OleInitialize`
//!   的主线程）进入：OLE 拖拽循环需要用调用线程的输入队列接管鼠标捕获，
//!   在自建后台线程上跑时目标窗口收不到 `DragEnter`，表现为“拖了没反应”。
//!   命令层用 `AppHandle::run_on_main_thread` 调度，这里不自己起线程。
//! - 数据对象由本模块自己实现 `IDataObject`，暴露 `CF_HDROP` 并接受
//!   `IDragSourceHelper` 写入的 `DragImageBits`：只实现前者时资源管理器
//!   不会显示跟随光标的文件“幽灵”图像。
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
    use std::sync::Mutex;

    use windows::core::{implement, HSTRING, BOOL, HRESULT, Ref};
    use windows::Win32::Foundation::{
        DATA_S_SAMEFORMATETC, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS,
        DV_E_FORMATETC, E_INVALIDARG, E_NOTIMPL, GlobalFree, S_OK, COLORREF, POINT, SIZE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, DATADIR_GET, DATADIR_SET, DVASPECT_CONTENT, FORMATETC, IAdviseSink,
        IBindCtx, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA, IStream,
        STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL, TYMED_ISTREAM, CLSCTX_INPROC_SERVER,
    };
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows::Win32::System::Ole::{
        DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize,
        ReleaseStgMedium, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_MOVE,
        DROPEFFECT_NONE,
    };
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
    use windows::Win32::UI::Shell::{
        IDragSourceHelper, IShellItemImageFactory, SHCreateItemFromParsingName,
        SHCreateMemStream, SHCreateStdEnumFmtEtc, SHDRAGIMAGE, CLSID_DragDropHelper,
        SIIGBF_BIGGERSIZEOK,
    };

    use super::{
        effect_label, query_decision, AppError, AppResult, DragDecision, DragOutOutcome,
    };

    #[implement(IDropSource)]
    struct ShelfDropSource;

    /// 全局左键状态：OLE 的回调参数在窗口失焦/输入被接管时不可靠。
    fn left_button_down() -> bool {
        unsafe {
            (windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(
                0x01, // VK_LBUTTON
            ) as u16
                & 0x8000)
                != 0
        }
    }

    impl IDropSource_Impl for ShelfDropSource_Impl {
        fn QueryContinueDrag(
            &self,
            fescapepressed: BOOL,
            _grfkeystate: MODIFIERKEYS_FLAGS,
        ) -> HRESULT {
            // 拖拽循环在主线程上运行，但 OLE 传入的 grfKeyState 在窗口失焦或
            // 输入被目标窗口接管时并不可靠；直接读全局按键状态，保证松开左键
            // 一定能结束拖拽（否则单飞守卫会永久占用）。
            match query_decision(fescapepressed.as_bool(), left_button_down()) {
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

    unsafe fn istream_medium(bytes: &[u8]) -> windows::core::Result<STGMEDIUM> {
        let stream = SHCreateMemStream(Some(bytes)).ok_or_else(windows::core::Error::from_thread)?;
        Ok(STGMEDIUM {
            tymed: TYMED_ISTREAM.0 as u32,
            u: STGMEDIUM_0 {
                pstm: std::mem::ManuallyDrop::new(Some(stream)),
            },
            pUnkForRelease: std::mem::ManuallyDrop::new(None),
        })
    }

    unsafe fn read_stream_bytes(stream: &IStream) -> Vec<u8> {
        let mut out = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let mut read = 0u32;
            if stream
                .Read(
                    buffer.as_mut_ptr() as *mut _,
                    buffer.len() as u32,
                    Some(&mut read),
                )
                .is_err()
            {
                break;
            }
            if read == 0 {
                break;
            }
            out.extend_from_slice(&buffer[..read as usize]);
            if (read as usize) < buffer.len() {
                break;
            }
        }
        out
    }

    /// `IDragSourceHelper` 通过 `SetData` 写入的额外格式（DragImageBits 等）。
    struct StoredFormat {
        cf_format: u16,
        bytes: Vec<u8>,
    }

    fn stored_bytes(extra: &Mutex<Vec<StoredFormat>>, cf_format: u16) -> Option<Vec<u8>> {
        extra
            .lock()
            .ok()?
            .iter()
            .find(|format| format.cf_format == cf_format)
            .map(|format| format.bytes.clone())
    }

    /// 文件拖出数据对象：暴露 CF_HDROP，并接受 `IDragSourceHelper` 写入的
    /// `DragImageBits`。只暴露 CF_HDROP 时资源管理器不会显示跟随光标的文件
    /// 幽灵图像（拖拽仍能落盘，但不像 Windows 原生拖文件）。
    #[implement(IDataObject)]
    struct ShelfDataObject {
        paths: Vec<PathBuf>,
        extra: Mutex<Vec<StoredFormat>>,
    }

    impl IDataObject_Impl for ShelfDataObject_Impl {
        fn GetData(&self, pformatetcin: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
            if pformatetcin.is_null() {
                return Err(E_INVALIDARG.into());
            }
            let format = unsafe { *pformatetcin };
            // 拖拽幽灵：helper 先用 SetData 写入，目标窗口再用 GetData 取走。
            if let Some(bytes) = stored_bytes(&self.extra, format.cfFormat) {
                let wants_stream = (format.tymed & TYMED_ISTREAM.0 as u32) != 0
                    && (format.tymed & TYMED_HGLOBAL.0 as u32) == 0;
                return unsafe {
                    if wants_stream {
                        istream_medium(&bytes)
                    } else {
                        hglobal_medium(&bytes)
                    }
                };
            }
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
            let format = unsafe { *pformatetc };
            if stored_bytes(&self.extra, format.cfFormat).is_some() || supports(&format) {
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
            pformatetc: *const FORMATETC,
            pmedium: *const STGMEDIUM,
            frelease: BOOL,
        ) -> windows::core::Result<()> {
            if pformatetc.is_null() || pmedium.is_null() {
                return Err(E_INVALIDARG.into());
            }
            let format = unsafe { *pformatetc };
            // 按值读取：STGMEDIUM 内部是 ManuallyDrop，复制句柄后按 fRelease
            // 决定由谁释放，避免对 `*pmedium` 做移动。
            let mut medium = unsafe { std::ptr::read(pmedium) };
            let release = |medium: &mut STGMEDIUM| unsafe {
                if frelease.as_bool() {
                    ReleaseStgMedium(medium);
                }
            };
            // helper 会用 IStream 写入 Preferred DropEffect；必须先接住，
            // 否则 InitializeFromBitmap 会把这里的 E_NOTIMPL 冒泡成失败。
            if (medium.tymed & TYMED_ISTREAM.0 as u32) != 0 {
                let bytes = unsafe { &*medium.u.pstm }
                    .as_ref()
                    .map(|stream| unsafe { read_stream_bytes(stream) })
                    .unwrap_or_default();
                release(&mut medium);
                if let Ok(mut extra) = self.extra.lock() {
                    extra.retain(|stored| stored.cf_format != format.cfFormat);
                    extra.push(StoredFormat {
                        cf_format: format.cfFormat,
                        bytes,
                    });
                }
                return Ok(());
            }
            if (medium.tymed & TYMED_HGLOBAL.0 as u32) == 0 {
                release(&mut medium);
                return Err(E_NOTIMPL.into());
            }
            let hglobal = unsafe { medium.u.hGlobal };
            let size = unsafe { GlobalSize(hglobal) };
            let ptr = unsafe { GlobalLock(hglobal) };
            if ptr.is_null() || size == 0 {
                if !ptr.is_null() {
                    let _ = unsafe { GlobalUnlock(hglobal) };
                }
                release(&mut medium);
                return Err(E_INVALIDARG.into());
            }
            let bytes = unsafe { std::slice::from_raw_parts(ptr as *const u8, size) }.to_vec();
            let _ = unsafe { GlobalUnlock(hglobal) };
            release(&mut medium);
            if let Ok(mut extra) = self.extra.lock() {
                extra.retain(|stored| stored.cf_format != format.cfFormat);
                extra.push(StoredFormat {
                    cf_format: format.cfFormat,
                    bytes,
                });
            }
            Ok(())
        }

        fn EnumFormatEtc(&self, dwdirection: u32) -> windows::core::Result<IEnumFORMATETC> {
            // `IDragSourceHelper` 初始化拖拽幽灵时会先枚举可写格式；返回空集
            // 而不是 E_NOTIMPL，否则 helper 会把 E_NOTIMPL 直接冒泡成失败。
            if dwdirection == DATADIR_SET.0 as u32 {
                return unsafe { SHCreateStdEnumFmtEtc(&[]) };
            }
            if dwdirection != DATADIR_GET.0 as u32 {
                return Err(E_NOTIMPL.into());
            }
            let mut formats = vec![format_etc()];
            if let Ok(extra) = self.extra.lock() {
                for stored in extra.iter() {
                    if formats.iter().any(|f| f.cfFormat == stored.cf_format) {
                        continue;
                    }
                    formats.push(FORMATETC {
                        cfFormat: stored.cf_format,
                        ptd: std::ptr::null_mut(),
                        dwAspect: DVASPECT_CONTENT.0,
                        lindex: -1,
                        tymed: TYMED_HGLOBAL.0 as u32,
                    });
                }
            }
            unsafe { SHCreateStdEnumFmtEtc(&formats) }
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
            extra: Mutex::new(Vec::new()),
        }
        .into()
    }

    /// 取第一个文件的 Shell 缩略图/图标，作为跟随光标的幽灵图像。
    unsafe fn shell_drag_bitmap(path: &PathBuf) -> Option<windows::Win32::Graphics::Gdi::HBITMAP> {
        let hs = HSTRING::from(path.to_string_lossy().to_string());
        let item: IShellItemImageFactory =
            SHCreateItemFromParsingName(&hs, None::<&IBindCtx>).ok()?;
        item.GetImage(SIZE { cx: 96, cy: 96 }, SIIGBF_BIGGERSIZEOK)
            .ok()
    }

    /// 把位图交给 `IDragSourceHelper`，由它通过 `SetData(DragImageBits)` 写进
    /// 数据对象；目标窗口的 `IDropTargetHelper` 据此绘制幽灵。失败只损失视觉
    /// 反馈，不阻断拖拽本身。
    unsafe fn attach_drag_image(data: &IDataObject, paths: &[PathBuf]) {
        let Some(hbmp) = shell_drag_bitmap(&paths[0]) else {
            return;
        };
        let raw = hbmp.0;
        let mut bm: windows_sys::Win32::Graphics::Gdi::BITMAP = std::mem::zeroed();
        let got = windows_sys::Win32::Graphics::Gdi::GetObjectW(
            raw,
            std::mem::size_of_val(&bm) as i32,
            &mut bm as *mut _ as *mut _,
        );
        if got != 0 {
            let shdi = SHDRAGIMAGE {
                sizeDragImage: SIZE {
                    cx: bm.bmWidth,
                    cy: bm.bmHeight,
                },
                // 光标落在幽灵中心，与资源管理器拖文件的手感一致。
                ptOffset: POINT {
                    x: bm.bmWidth / 2,
                    y: bm.bmHeight / 2,
                },
                hbmpDragImage: hbmp,
                crColorKey: COLORREF(0xFFFF_FFFF), // CLR_NONE：位图自带 alpha
            };
            if let Ok(helper) = CoCreateInstance::<_, IDragSourceHelper>(
                &CLSID_DragDropHelper,
                None,
                CLSCTX_INPROC_SERVER,
            ) {
                if let Err(error) = helper.InitializeFromBitmap(&shdi, data) {
                    tracing::warn!(%error, "暂存架拖出：初始化拖拽幽灵失败");
                }
            }
        }
        let _ = windows_sys::Win32::Graphics::Gdi::DeleteObject(raw);
    }

    /// 在调用线程上进入 OLE 拖拽循环；调用方必须保证是 UI 线程（tao 已初始化
    /// STA）且左键仍按下。
    pub fn run_drag(paths: &[PathBuf], allow_move: bool) -> AppResult<DragOutOutcome> {
        if paths.is_empty() {
            return Err(AppError::Validation("没有可拖出的文件".into()));
        }
        // 没有按下左键时不能进入 DoDragDrop：拖拽循环依赖鼠标捕获，拿不到
        // 任何输入消息会永久阻塞主线程（合成调用/迟到的 IPC 都可能触发）。
        if !left_button_down() {
            tracing::info!("暂存架拖出：左键已松开，跳过 OLE 拖拽循环");
            return Ok(DragOutOutcome {
                effect: "none".into(),
                count: paths.len(),
                missing_paths: Vec::new(),
            });
        }
        unsafe {
            OleInitialize(None)
                .map_err(|e| AppError::Unavailable(format!("初始化 OLE 失败: {e}")))?;
        }
        tracing::info!(
            count = paths.len(),
            allow_move,
            "暂存架拖出：进入 OLE 拖拽循环"
        );
        let result = (|| unsafe {
            let data = data_object_for(paths);
            attach_drag_image(&data, paths);
            let source: IDropSource = ShelfDropSource.into();
            let mut effect = DROPEFFECT_NONE;
            let ok_effects = if allow_move {
                DROPEFFECT_COPY | DROPEFFECT_MOVE
            } else {
                DROPEFFECT_COPY
            };
            let hr = DoDragDrop(&data, &source, ok_effects, &mut effect);
            tracing::info!(
                effect = effect_label(effect.0),
                hr_ok = hr.is_ok(),
                "暂存架拖出：OLE 拖拽循环结束"
            );
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

    use windows::Win32::Foundation::{COLORREF, POINT, SIZE};
    use windows::Win32::Graphics::Gdi::HBITMAP;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL,
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, IDataObject,
    };
    use windows::Win32::System::Ole::{CF_HDROP, ReleaseStgMedium};
    use windows::Win32::UI::Shell::{
        DROPFILES, IDragSourceHelper, SHDRAGIMAGE, CLSID_DragDropHelper,
    };
    use windows_sys::Win32::Graphics::Gdi::{
        CreateDIBSection, DeleteObject, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    };

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

    /// 拖拽幽灵的数据通路：helper 通过 SetData 写入 DragImageBits，目标窗口
    /// 再通过 GetData 取走。这里不启动真实 DoDragDrop（需要物理鼠标），只验证
    /// 数据对象确实能接收并回读 helper 生成的图像。
    #[test]
    fn drag_source_helper_attaches_drag_image() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        let data: IDataObject = data_object_for(&[PathBuf::from(r"C:\test.txt")]);

        // 96x96 32bpp 顶层 DIB：helper 只接受带 alpha 的位图。
        let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = 96;
        bmi.bmiHeader.biHeight = 96;
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB as u32;
        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let hbmp = unsafe {
            CreateDIBSection(
                std::ptr::null_mut(),
                &bmi,
                DIB_RGB_COLORS,
                &mut bits,
                std::ptr::null_mut(),
                0,
            )
        };
        assert!(!hbmp.is_null(), "CreateDIBSection");
        assert!(!bits.is_null());
        unsafe { std::ptr::write_bytes(bits as *mut u8, 0xFF, 96 * 96 * 4) };

        let shdi = SHDRAGIMAGE {
            sizeDragImage: SIZE { cx: 96, cy: 96 },
            ptOffset: POINT { x: 48, y: 48 },
            hbmpDragImage: HBITMAP(hbmp),
            crColorKey: COLORREF(0xFFFF_FFFF),
        };
        let helper: IDragSourceHelper =
            unsafe { CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER) }
                .expect("CoCreateInstance(DragDropHelper)");
        unsafe { helper.InitializeFromBitmap(&shdi, &data) }
            .expect("InitializeFromBitmap 应写入 DragImageBits");

        let name: Vec<u16> = "DragImageBits\0".encode_utf16().collect();
        let atom = unsafe {
            windows_sys::Win32::System::DataExchange::RegisterClipboardFormatW(name.as_ptr()) as u16
        };
        assert_ne!(atom, 0, "RegisterClipboardFormatW(DragImageBits)");
        let format = FORMATETC {
            cfFormat: atom,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let hr = unsafe { data.QueryGetData(&format) };
        assert!(hr.is_ok(), "QueryGetData(DragImageBits) hr={hr:?}");
        let mut medium = unsafe { data.GetData(&format) }.expect("GetData(DragImageBits)");
        assert!(
            !unsafe { medium.u.hGlobal }.0.is_null(),
            "DragImageBits 必须是非空 HGLOBAL"
        );
        unsafe {
            ReleaseStgMedium(&mut medium);
            DeleteObject(hbmp);
        }
    }
}
