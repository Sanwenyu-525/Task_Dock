//! 受控 OLE 数据对象测试源（仅 `cfg(test)` 编译）。
//!
//! 这不是对生产读取函数打桩：`TestDataObject` 是**真正的 COM 对象**，
//! 实现 `IDataObject` / `IEnumFORMATETC` / `IStream`。生产代码通过
//! `EnumFormatEtc` 枚举格式、通过 `GetData` 取 `STGMEDIUM`、通过
//! `ReleaseStgMedium` 释放，全部走真实 COM 调用路径。
//!
//! 这样可以在没有 Chrome / Edge / ChatGPT / Outlook 的会话里，构造出
//! `CF_UNICODETEXT`、`HTML Format`、`PNG`、`FileGroupDescriptorW` +
//! `FileContents`（`TYMED_ISTREAM`）等来源，验证分类与读取逻辑。
//!
//! 它**不能**替代真机验收：不覆盖 `RegisterDragDrop` 接管、WebView2 的
//! 窗口链、真实鼠标的 `DragEnter/DragOver/Drop` 时序。

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use windows::core::{implement, Ref, Result as WinResult, BOOL, HRESULT, PCWSTR};
use windows::Win32::Foundation::{DV_E_FORMATETC, HGLOBAL};
use windows::Win32::System::Com::{
    IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumFORMATETC_Impl,
    IEnumSTATDATA, ISequentialStream_Impl, IStream, IStream_Impl, STATFLAG, STATSTG, STGC,
    STGMEDIUM, STGMEDIUM_0, STGTY_STREAM, STREAM_SEEK, STREAM_SEEK_CUR, STREAM_SEEK_END,
    STREAM_SEEK_SET, DVASPECT_CONTENT, FORMATETC, LOCKTYPE, TYMED_HGLOBAL, TYMED_ISTREAM,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

const E_NOTIMPL: HRESULT = HRESULT(0x8000_4001u32 as i32);
const E_INVALIDARG: HRESULT = HRESULT(0x8007_0057u32 as i32);

/// `FD_FILESIZE`：`nFileSizeHigh/Low` 有效。
const FD_FILESIZE: u32 = 0x0000_0040;
/// `FD_ATTRIBUTES`：目录属性有效。
const FD_ATTRIBUTES: u32 = 0x0000_0004;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;

/// 取一个命名剪贴板格式 id（与生产代码 `format_id` 同源）。
pub fn registered_id(name: &str) -> u16 {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let id = unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) };
    // 注册表 id 一定小于 0xC000；超过 u16 的极端情况在真实系统上不存在。
    u16::try_from(id).expect("剪贴板格式 id 超出 u16")
}

/// 条目返回的数据形态。
#[derive(Clone)]
enum Payload {
    /// 正常 HGLOBAL。
    Bytes(Vec<u8>),
    /// 正常 IStream。
    Stream(Arc<Vec<u8>>),
    /// **故意**违反 TYMED 契约：内容其实是 HGLOBAL，却声明 `TYMED_ISTREAM`。
    /// 用于验证生产代码不会把句柄当接口指针解引用。
    BytesWithWrongTymed(Vec<u8>),
    /// **故意**违反 TYMED 契约：按 `TYMED_ISTREAM` 匹配请求，却返回 HGLOBAL。
    /// 用于验证 `obtain_content` 会核对 `medium.tymed`，并按实际类型读取字节。
    GlobalForStreamRequest(Vec<u8>),
    /// 合法的空 HGLOBAL（`GlobalSize == 0`）：验证空内容有明确失败码。
    EmptyGlobal,
    /// 第一次 `Read` 后把取消标记置位：验证「读到一半被取消」的清理路径。
    CancelAfterFirstRead(Arc<Vec<u8>>, Arc<AtomicBool>),
}

#[derive(Clone)]
struct Entry {
    cf: u16,
    lindex: i32,
    payload: Payload,
}

impl Entry {
    fn tymed(&self) -> u32 {
        // 这里表示「参与请求匹配的类型」，不是返回的 medium 声明类型：
        // 两个 Wrong 变体正是要在匹配通过后返回错误的 tymed，用来验证防御分支。
        match self.payload {
            Payload::Bytes(_) | Payload::BytesWithWrongTymed(_) | Payload::EmptyGlobal => {
                TYMED_HGLOBAL.0 as u32
            }
            Payload::Stream(_)
            | Payload::GlobalForStreamRequest(_)
            | Payload::CancelAfterFirstRead(..) => TYMED_ISTREAM.0 as u32,
        }
    }
}

fn formatetc(cf: u16, lindex: i32, tymed: u32) -> FORMATETC {
    FORMATETC {
        cfFormat: cf,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex,
        tymed,
    }
}

fn hglobal_medium(bytes: &[u8]) -> STGMEDIUM {
    unsafe {
        let h: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).expect("GlobalAlloc");
        if !bytes.is_empty() {
            let p = GlobalLock(h);
            assert!(!p.is_null(), "GlobalLock");
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p as *mut u8, bytes.len());
            let _ = GlobalUnlock(h);
        }
        STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: h },
            pUnkForRelease: std::mem::ManuallyDrop::new(None),
        }
    }
}

fn stream_medium(stream: IStream) -> STGMEDIUM {
    STGMEDIUM {
        tymed: TYMED_ISTREAM.0 as u32,
        u: STGMEDIUM_0 {
            pstm: std::mem::ManuallyDrop::new(Some(stream)),
        },
        pUnkForRelease: std::mem::ManuallyDrop::new(None),
    }
}

/// 合法的空 HGLOBAL：`GlobalSize` 为 0。
fn empty_global_medium() -> STGMEDIUM {
    unsafe {
        let h: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, 0).expect("GlobalAlloc(0)");
        STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: h },
            pUnkForRelease: std::mem::ManuallyDrop::new(None),
        }
    }
}

/// 内存流：`FileContents` 的最小实现。
#[implement(IStream)]
struct TestStream {
    data: Arc<Vec<u8>>,
    pos: AtomicUsize,
    /// 每读到数据就置位：模拟「读取过程中用户取消」。
    cancel_after: Option<Arc<AtomicBool>>,
}

impl ISequentialStream_Impl for TestStream_Impl {
    fn Read(
        &self,
        pv: *mut core::ffi::c_void,
        cb: u32,
        pcbread: *mut u32,
    ) -> HRESULT {
        let pos = self.pos.load(Ordering::SeqCst);
        let remaining = self.data.len().saturating_sub(pos);
        let n = remaining.min(cb as usize);
        unsafe {
            if n > 0 && !pv.is_null() {
                std::ptr::copy_nonoverlapping(self.data.as_ptr().add(pos), pv as *mut u8, n);
            }
            if !pcbread.is_null() {
                *pcbread = n as u32;
            }
        }
        self.pos.store(pos + n, Ordering::SeqCst);
        if n > 0 {
            if let Some(flag) = &self.cancel_after {
                flag.store(true, Ordering::SeqCst);
            }
        }
        HRESULT(0)
    }

    fn Write(
        &self,
        _pv: *const core::ffi::c_void,
        _cb: u32,
        _pcbwritten: *mut u32,
    ) -> HRESULT {
        E_NOTIMPL
    }
}

impl IStream_Impl for TestStream_Impl {
    fn Seek(
        &self,
        dlibmove: i64,
        dworigin: STREAM_SEEK,
        plibnewposition: *mut u64,
    ) -> WinResult<()> {
        let len = self.data.len() as i64;
        let base = if dworigin == STREAM_SEEK_SET {
            0
        } else if dworigin == STREAM_SEEK_CUR {
            self.pos.load(Ordering::SeqCst) as i64
        } else if dworigin == STREAM_SEEK_END {
            len
        } else {
            return Err(E_INVALIDARG.into());
        };
        let next = base + dlibmove;
        if next < 0 {
            return Err(E_INVALIDARG.into());
        }
        self.pos.store(next as usize, Ordering::SeqCst);
        if !plibnewposition.is_null() {
            unsafe { *plibnewposition = next as u64 };
        }
        Ok(())
    }

    fn SetSize(&self, _libnewsize: u64) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn CopyTo(
        &self,
        _pstm: Ref<IStream>,
        _cb: u64,
        _pcbread: *mut u64,
        _pcbwritten: *mut u64,
    ) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn Commit(&self, _grfcommitflags: &STGC) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn Revert(&self) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn LockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: &LOCKTYPE) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn UnlockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: u32) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn Stat(&self, pstatstg: *mut STATSTG, _grfstatflag: &STATFLAG) -> WinResult<()> {
        if pstatstg.is_null() {
            return Err(E_INVALIDARG.into());
        }
        let mut st: STATSTG = unsafe { std::mem::zeroed() };
        st.cbSize = self.data.len() as u64;
        st.r#type = STGTY_STREAM.0 as u32;
        unsafe { *pstatstg = st };
        Ok(())
    }

    fn Clone(&self) -> WinResult<IStream> {
        Err(E_NOTIMPL.into())
    }
}

#[implement(IEnumFORMATETC)]
struct TestFormatEnum {
    formats: Vec<FORMATETC>,
    index: AtomicUsize,
}

impl IEnumFORMATETC_Impl for TestFormatEnum_Impl {
    fn Next(&self, celt: u32, rgelt: *mut FORMATETC, pceltfetched: *mut u32) -> HRESULT {
        let start = self.index.load(Ordering::SeqCst);
        let n = self.formats.len().saturating_sub(start).min(celt as usize);
        unsafe {
            for i in 0..n {
                if !rgelt.is_null() {
                    *rgelt.add(i) = self.formats[start + i];
                }
            }
            if !pceltfetched.is_null() {
                *pceltfetched = n as u32;
            }
        }
        self.index.store(start + n, Ordering::SeqCst);
        if n as u32 == celt {
            HRESULT(0)
        } else {
            // S_FALSE：还有剩余请求未满足。
            HRESULT(1)
        }
    }

    fn Skip(&self, celt: u32) -> WinResult<()> {
        let next = (self.index.load(Ordering::SeqCst) + celt as usize).min(self.formats.len());
        self.index.store(next, Ordering::SeqCst);
        Ok(())
    }

    fn Reset(&self) -> WinResult<()> {
        self.index.store(0, Ordering::SeqCst);
        Ok(())
    }

    fn Clone(&self) -> WinResult<IEnumFORMATETC> {
        Err(E_NOTIMPL.into())
    }
}

/// 可控 `IDataObject`：格式、TYMED、索引与内容都由测试指定。
#[implement(IDataObject)]
pub struct TestDataObject {
    entries: Vec<Entry>,
}

impl IDataObject_Impl for TestDataObject_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> WinResult<STGMEDIUM> {
        if pformatetcin.is_null() {
            return Err(DV_E_FORMATETC.into());
        }
        let fmt = unsafe { *pformatetcin };
        let Some(entry) = self.entries.iter().find(|e| {
            e.cf == fmt.cfFormat
                && e.lindex == fmt.lindex
                && fmt.dwAspect == DVASPECT_CONTENT.0
                && (fmt.tymed & e.tymed()) != 0
        }) else {
            return Err(DV_E_FORMATETC.into());
        };
        Ok(match &entry.payload {
            // 契约违规用例：内容仍是 HGLOBAL，但 medium 声称 ISTREAM。
            Payload::BytesWithWrongTymed(bytes) => {
                let mut medium = hglobal_medium(bytes);
                medium.tymed = TYMED_ISTREAM.0 as u32;
                medium
            }
            // 契约违规用例：请求 ISTREAM，却返回 HGLOBAL。
            Payload::GlobalForStreamRequest(bytes) => hglobal_medium(bytes),
            Payload::Bytes(bytes) => hglobal_medium(bytes),
            Payload::EmptyGlobal => empty_global_medium(),
            Payload::Stream(data) => stream_medium(
                TestStream {
                    data: data.clone(),
                    pos: AtomicUsize::new(0),
                    cancel_after: None,
                }
                .into(),
            ),
            Payload::CancelAfterFirstRead(data, flag) => stream_medium(
                TestStream {
                    data: data.clone(),
                    pos: AtomicUsize::new(0),
                    cancel_after: Some(flag.clone()),
                }
                .into(),
            ),
        })
    }

    fn GetDataHere(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *mut STGMEDIUM,
    ) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        if pformatetc.is_null() {
            return DV_E_FORMATETC;
        }
        let fmt = unsafe { *pformatetc };
        if self.entries.iter().any(|e| {
            e.cf == fmt.cfFormat && e.lindex == fmt.lindex && (fmt.tymed & e.tymed()) != 0
        }) {
            HRESULT(0)
        } else {
            DV_E_FORMATETC
        }
    }

    fn GetCanonicalFormatEtc(
        &self,
        _pformatectin: *const FORMATETC,
        _pformatetcout: *mut FORMATETC,
    ) -> HRESULT {
        // DATA_S_SAMEFORMATETC：没有「规范形式」差异。
        HRESULT(1)
    }

    fn SetData(
        &self,
        _pformatetc: *const FORMATETC,
        _pmedium: *const STGMEDIUM,
        _frelease: BOOL,
    ) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumFormatEtc(&self, dwdirection: u32) -> WinResult<IEnumFORMATETC> {
        // DATADIR_GET = 1；生产代码只枚举 GET。
        if dwdirection != 1 {
            return Err(E_NOTIMPL.into());
        }
        let formats = self
            .entries
            .iter()
            .map(|e| formatetc(e.cf, e.lindex, e.tymed()))
            .collect();
        Ok(TestFormatEnum {
            formats,
            index: AtomicUsize::new(0),
        }
        .into())
    }

    fn DAdvise(
        &self,
        _pformatetc: *const FORMATETC,
        _advf: u32,
        _padvsink: Ref<IAdviseSink>,
    ) -> WinResult<u32> {
        Err(E_NOTIMPL.into())
    }

    fn DUnadvise(&self, _dwconnection: u32) -> WinResult<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumDAdvise(&self) -> WinResult<IEnumSTATDATA> {
        Err(E_NOTIMPL.into())
    }
}

fn object(entries: Vec<Entry>) -> IDataObject {
    TestDataObject { entries }.into()
}

/// `CF_UNICODETEXT` 来源。
pub fn text(text: &str) -> IDataObject {
    let mut bytes: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    bytes.extend_from_slice(&0u16.to_le_bytes());
    object(vec![Entry {
        cf: 13,
        lindex: -1,
        payload: Payload::Bytes(bytes),
    }])
}

/// `HTML Format` 来源（带标准的 `Version:/StartHTML:` 头）。
pub fn html(fragment: &str) -> IDataObject {
    let body = format!("<html><body><!--StartFragment-->{fragment}<!--EndFragment--></body></html>");
    let header_len = "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n".len();
    let start_html = header_len;
    let end_html = header_len + body.len();
    let start_fragment = header_len + body.find("<!--StartFragment-->").unwrap_or(0) + "<!--StartFragment-->".len();
    let end_fragment = start_fragment + fragment.len();
    let header = format!(
        "Version:0.9\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_fragment:010}\r\nEndFragment:{end_fragment:010}\r\n"
    );
    let raw = format!("{header}{body}");
    object(vec![Entry {
        cf: registered_id("HTML Format"),
        lindex: -1,
        payload: Payload::Bytes(raw.into_bytes()),
    }])
}

/// 命名 `PNG` 格式来源（内容必须是真实 PNG 字节，由调用方生成）。
pub fn png(bytes: Vec<u8>) -> IDataObject {
    object(vec![Entry {
        cf: registered_id("PNG"),
        lindex: -1,
        payload: Payload::Bytes(bytes),
    }])
}

/// 命名 `PNG` 格式存在，但内容是合法空 HGLOBAL（验证错误码不是「超限」）。
pub fn png_empty() -> IDataObject {
    object(vec![Entry {
        cf: registered_id("PNG"),
        lindex: -1,
        payload: Payload::EmptyGlobal,
    }])
}

/// 与 `CF_UNICODETEXT` 同 id，但故意声明错误的 TYMED。
pub fn text_with_wrong_tymed(text: &str) -> IDataObject {
    let mut bytes: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    bytes.extend_from_slice(&0u16.to_le_bytes());
    object(vec![Entry {
        cf: 13,
        lindex: -1,
        payload: Payload::BytesWithWrongTymed(bytes),
    }])
}

/// 用 **Windows SDK 结构本身** 构造一条描述符。
///
/// 不复制生产常量、不手算 620/592：`FILEDESCRIPTORW` 的大小与偏移由
/// `windows` crate 的 `#[repr(C, packed(1))]` 绑定决定。若生产解析器再次
/// 写错长度，这里产出的仍是真实 ABI 数据，测试会直接失败。
fn descriptor(name: &str, size: Option<u64>, directory: bool) -> Vec<u8> {
    use windows::Win32::UI::Shell::FILEDESCRIPTORW;

    let mut fd = FILEDESCRIPTORW::default();
    fd.dwFlags = FD_ATTRIBUTES | if size.is_some() { FD_FILESIZE } else { 0 };
    if directory {
        fd.dwFileAttributes = FILE_ATTRIBUTE_DIRECTORY;
    }
    let (hi, lo) = match size {
        Some(v) => ((v >> 32) as u32, v as u32),
        None => (u32::MAX, u32::MAX),
    };
    fd.nFileSizeHigh = hi;
    fd.nFileSizeLow = lo;
    let mut name_units = [0u16; 260];
    for (slot, unit) in name_units
        .iter_mut()
        .zip(name.encode_utf16().take(259))
    {
        *slot = unit;
    }
    fd.cFileName = name_units;
    // `packed(1)` 的结构没有内部填充，按字节读出的就是磁盘上的 ABI 布局。
    let raw = unsafe {
        std::slice::from_raw_parts(
            &fd as *const FILEDESCRIPTORW as *const u8,
            std::mem::size_of::<FILEDESCRIPTORW>(),
        )
    };
    raw.to_vec()
}

/// `FileGroupDescriptorW` + `FileContents`（每项一个 `TYMED_ISTREAM`）。
pub fn virtual_files(files: &[(String, Vec<u8>)]) -> IDataObject {
    virtual_files_padded(files, 0)
}

/// 同 [`virtual_files`]，但描述符缓冲区尾部额外填充 `extra` 字节。
///
/// 真实来源（尤其 Outlook）常把 HGLOBAL 分配得比 `4 + 592×N` 更大；
/// 生产代码必须只读头部而不是因为「缓冲区超上限」整块放弃。
pub fn virtual_files_padded(files: &[(String, Vec<u8>)], extra: usize) -> IDataObject {
    let mut group = vec![0u8; 4];
    group[0..4].copy_from_slice(&(files.len() as u32).to_le_bytes());
    for (name, bytes) in files {
        group.extend_from_slice(&descriptor(name, Some(bytes.len() as u64), false));
    }
    group.extend(std::iter::repeat(0u8).take(extra));
    let mut entries = vec![Entry {
        cf: registered_id("FileGroupDescriptorW"),
        lindex: -1,
        payload: Payload::Bytes(group),
    }];
    let contents = registered_id("FileContents");
    for (i, (_, bytes)) in files.iter().enumerate() {
        entries.push(Entry {
            cf: contents,
            lindex: i as i32,
            payload: Payload::Stream(Arc::new(bytes.clone())),
        });
    }
    object(entries)
}

/// 多虚拟文件，`FileContents` **全部**以 `TYMED_HGLOBAL` 提供。
///
/// 每个索引对应自己的内容：回退路径若丢掉 `lindex`（旧实现传 `-1`），
/// 读取会直接失败或串到别的文件，测试会立刻发现。
pub fn virtual_files_hglobal(files: &[(String, Vec<u8>)]) -> IDataObject {
    let mut entries = vec![Entry {
        cf: registered_id("FileGroupDescriptorW"),
        lindex: -1,
        payload: Payload::Bytes(group_descriptor(files)),
    }];
    let contents = registered_id("FileContents");
    for (i, (_, bytes)) in files.iter().enumerate() {
        entries.push(Entry {
            cf: contents,
            lindex: i as i32,
            payload: Payload::Bytes(bytes.clone()),
        });
    }
    object(entries)
}

/// 每个文件分别指定用流还是内存块提供（`streams[i] == true` 表示 IStream）。
///
/// 用于验证同一批拖入里「流优先、内存回退」可以共存，且索引一一对应。
pub fn virtual_files_mixed(files: &[(String, Vec<u8>)], streams: &[bool]) -> IDataObject {
    let mut entries = vec![Entry {
        cf: registered_id("FileGroupDescriptorW"),
        lindex: -1,
        payload: Payload::Bytes(group_descriptor(files)),
    }];
    let contents = registered_id("FileContents");
    for (i, (_, bytes)) in files.iter().enumerate() {
        let payload = if streams.get(i).copied().unwrap_or(false) {
            Payload::Stream(Arc::new(bytes.clone()))
        } else {
            Payload::Bytes(bytes.clone())
        };
        entries.push(Entry {
            cf: contents,
            lindex: i as i32,
            payload,
        });
    }
    object(entries)
}

/// 同一索引同时提供 `TYMED_ISTREAM` 与 `TYMED_HGLOBAL`，内容故意不同。
///
/// 生产代码必须优先使用流（大文件可流式写盘），不能因为 HGLOBAL 先匹配就退回内存。
pub fn virtual_files_both(stream: &[u8], global: &[u8]) -> IDataObject {
    let name = "both.bin".to_string();
    let files = vec![(name, stream.to_vec())];
    let contents = registered_id("FileContents");
    object(vec![
        Entry {
            cf: registered_id("FileGroupDescriptorW"),
            lindex: -1,
            payload: Payload::Bytes(group_descriptor(&files)),
        },
        // 内存块排在前面：`GetData` 按条目顺序匹配，若实现没有优先请求 ISTREAM，
        // 就会拿到 global-content，测试据此区分。
        Entry {
            cf: contents,
            lindex: 0,
            payload: Payload::Bytes(global.to_vec()),
        },
        Entry {
            cf: contents,
            lindex: 0,
            payload: Payload::Stream(Arc::new(stream.to_vec())),
        },
    ])
}

/// 描述符声明全部文件，但 `FileContents` 只提供前 `provided` 项。
///
/// 真实来源（邮件客户端）在部分附件失效时会这样：能读的必须落盘，
/// 缺索引的那几项必须报 `DRAG_VIRTUAL_INDEX_INVALID`，不能整体失败。
pub fn virtual_files_partial(files: &[(String, Vec<u8>)], provided: usize) -> IDataObject {
    let mut entries = vec![Entry {
        cf: registered_id("FileGroupDescriptorW"),
        lindex: -1,
        payload: Payload::Bytes(group_descriptor(files)),
    }];
    let contents = registered_id("FileContents");
    for (i, (_, bytes)) in files.iter().take(provided).enumerate() {
        entries.push(Entry {
            cf: contents,
            lindex: i as i32,
            payload: Payload::Stream(Arc::new(bytes.clone())),
        });
    }
    object(entries)
}

/// 单个虚拟文件，内容是合法但为空的 HGLOBAL（`GlobalSize == 0`）。
pub fn virtual_files_empty(name: &str) -> IDataObject {
    let mut group = vec![0u8; 4];
    group[0..4].copy_from_slice(&1u32.to_le_bytes());
    group.extend_from_slice(&descriptor(name, Some(0), false));
    object(vec![
        Entry {
            cf: registered_id("FileGroupDescriptorW"),
            lindex: -1,
            payload: Payload::Bytes(group),
        },
        Entry {
            cf: registered_id("FileContents"),
            lindex: 0,
            payload: Payload::EmptyGlobal,
        },
    ])
}

/// 多虚拟文件，`FileContents` 全为 HGLOBAL，且实际块比描述符声明多 `extra` 字节。
///
/// 真实来源可能分配更大的缓冲区（对齐/复用）；落盘必须按声明长度截断，
/// 不能把尾部填充当成文件内容。
pub fn virtual_files_hglobal_padded(files: &[(String, Vec<u8>)], extra: usize) -> IDataObject {
    let mut entries = vec![Entry {
        cf: registered_id("FileGroupDescriptorW"),
        lindex: -1,
        payload: Payload::Bytes(group_descriptor(files)),
    }];
    let contents = registered_id("FileContents");
    for (i, (_, bytes)) in files.iter().enumerate() {
        let mut padded = bytes.clone();
        padded.extend(std::iter::repeat(0xA5u8).take(extra));
        entries.push(Entry {
            cf: contents,
            lindex: i as i32,
            payload: Payload::Bytes(padded),
        });
    }
    object(entries)
}

/// 单个虚拟文件，第一次 `Read` 后置位取消标记（模拟读取中途取消）。
pub fn virtual_files_cancel_on_first_read(
    name: &str,
    bytes: Vec<u8>,
) -> (IDataObject, Arc<AtomicBool>) {
    let flag = Arc::new(AtomicBool::new(false));
    let group = group_descriptor(&[(name.to_string(), bytes.clone())]);
    let obj = object(vec![
        Entry {
            cf: registered_id("FileGroupDescriptorW"),
            lindex: -1,
            payload: Payload::Bytes(group),
        },
        Entry {
            cf: registered_id("FileContents"),
            lindex: 0,
            payload: Payload::CancelAfterFirstRead(Arc::new(bytes), flag.clone()),
        },
    ]);
    (obj, flag)
}

/// 构造 `FileGroupDescriptorW` 缓冲区（只用于测试来源）。
fn group_descriptor(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut group = vec![0u8; 4];
    group[0..4].copy_from_slice(&(files.len() as u32).to_le_bytes());
    for (name, bytes) in files {
        group.extend_from_slice(&descriptor(name, Some(bytes.len() as u64), false));
    }
    group
}

/// 一个原始描述符槽位：用来构造「原始顺序里夹着无效项」的来源。
///
/// - `directory = true`：目录项，生产解析器应跳过；
/// - `name = ""`：空名，生产解析器应跳过；
/// - `declared`：描述符里声明的大小（可故意超过上限，而 `contents` 仍然提供，
///   证明生产代码不会去读被跳过项的流）；
/// - `contents = None`：`FileContents` 不提供该原始索引（部分成功场景）。
pub struct VirtualSlot {
    pub name: String,
    pub directory: bool,
    pub declared: Option<u64>,
    pub contents: Option<Vec<u8>>,
}

impl VirtualSlot {
    pub fn file(name: &str, bytes: &[u8]) -> Self {
        Self {
            name: name.to_string(),
            directory: false,
            declared: Some(bytes.len() as u64),
            contents: Some(bytes.to_vec()),
        }
    }

    pub fn directory(name: &str, decoy: &[u8]) -> Self {
        Self {
            name: name.to_string(),
            directory: true,
            declared: None,
            contents: Some(decoy.to_vec()),
        }
    }

    pub fn empty_name(decoy: &[u8]) -> Self {
        Self {
            name: String::new(),
            directory: false,
            declared: Some(decoy.len() as u64),
            contents: Some(decoy.to_vec()),
        }
    }

    pub fn missing(name: &str) -> Self {
        Self {
            name: name.to_string(),
            directory: false,
            declared: None,
            contents: None,
        }
    }

    pub fn oversize(name: &str, declared: u64, decoy: &[u8]) -> Self {
        Self {
            name: name.to_string(),
            directory: false,
            declared: Some(declared),
            contents: Some(decoy.to_vec()),
        }
    }
}

/// 按**原始位置**构造描述符与 `FileContents`。
///
/// `FileContents` 的 `lindex` 始终是槽位下标，且被跳过的槽位也可能提供
/// 内容（诱饵）。生产代码若用过滤后的下标读取，就会读到诱饵/串位。
pub fn virtual_files_slots(slots: &[VirtualSlot]) -> IDataObject {
    let mut group = vec![0u8; 4];
    group[0..4].copy_from_slice(&(slots.len() as u32).to_le_bytes());
    for slot in slots {
        let size = slot
            .declared
            .or_else(|| slot.contents.as_ref().map(|b| b.len() as u64));
        group.extend_from_slice(&descriptor(&slot.name, size, slot.directory));
    }
    let mut entries = vec![Entry {
        cf: registered_id("FileGroupDescriptorW"),
        lindex: -1,
        payload: Payload::Bytes(group),
    }];
    let contents = registered_id("FileContents");
    for (index, slot) in slots.iter().enumerate() {
        if let Some(bytes) = &slot.contents {
            entries.push(Entry {
                cf: contents,
                lindex: index as i32,
                payload: Payload::Stream(Arc::new(bytes.clone())),
            });
        }
    }
    object(entries)
}

/// 直接提供一个原始 `FileGroupDescriptorW` 缓冲区（用于构造损坏/截断样本）。
pub fn virtual_files_raw_group(group: Vec<u8>) -> IDataObject {
    object(vec![Entry {
        cf: registered_id("FileGroupDescriptorW"),
        lindex: -1,
        payload: Payload::Bytes(group),
    }])
}

/// 单个虚拟文件，但 `FileContents` 对 `TYMED_ISTREAM` 请求返回 HGLOBAL。
/// 真实世界里偶有实现无视 `FORMATETC.tymed`；生产代码必须核对实际类型后
/// 按内存块读取，而不是把 HGLOBAL 当 `IStream` 解引用。
pub fn virtual_files_wrong_tymed(name: &str) -> IDataObject {
    let mut group = vec![0u8; 4];
    group[0..4].copy_from_slice(&1u32.to_le_bytes());
    group.extend_from_slice(&descriptor(name, Some(4), false));
    let entries = vec![
        Entry {
            cf: registered_id("FileGroupDescriptorW"),
            lindex: -1,
            payload: Payload::Bytes(group),
        },
        Entry {
            cf: registered_id("FileContents"),
            lindex: 0,
            payload: Payload::GlobalForStreamRequest(b"data".to_vec()),
        },
    ];
    object(entries)
}
