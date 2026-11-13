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

use std::sync::atomic::{AtomicUsize, Ordering};
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

/// `FILEDESCRIPTORW` 单条长度（与 `virtual_files::FILEDESCRIPTORW_LEN` 相同）。
const FILEDESCRIPTORW_LEN: usize = 620;
const FD_FILESIZE: u32 = 0x0000_0040;

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
    /// 用于验证 `obtain_content` 会核对 `medium.tymed` 而不是盲解 `pstm`。
    GlobalForStreamRequest(Vec<u8>),
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
            Payload::Bytes(_) | Payload::BytesWithWrongTymed(_) => TYMED_HGLOBAL.0 as u32,
            Payload::Stream(_) | Payload::GlobalForStreamRequest(_) => TYMED_ISTREAM.0 as u32,
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

/// 内存流：`FileContents` 的最小实现。
#[implement(IStream)]
struct TestStream {
    data: Arc<Vec<u8>>,
    pos: AtomicUsize,
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
            Payload::Stream(data) => {
                let stream: IStream = TestStream {
                    data: data.clone(),
                    pos: AtomicUsize::new(0),
                }
                .into();
                STGMEDIUM {
                    tymed: TYMED_ISTREAM.0 as u32,
                    u: STGMEDIUM_0 {
                        pstm: std::mem::ManuallyDrop::new(Some(stream)),
                    },
                    pUnkForRelease: std::mem::ManuallyDrop::new(None),
                }
            }
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

fn descriptor(name: &str, size: Option<u64>) -> Vec<u8> {
    let mut buf = vec![0u8; FILEDESCRIPTORW_LEN];
    let flags: u32 = 0x0000_0004 | if size.is_some() { FD_FILESIZE } else { 0 };
    buf[0..4].copy_from_slice(&flags.to_le_bytes());
    let (hi, lo) = match size {
        Some(v) => ((v >> 32) as u32, v as u32),
        None => (u32::MAX, u32::MAX),
    };
    buf[64..68].copy_from_slice(&hi.to_le_bytes());
    buf[68..72].copy_from_slice(&lo.to_le_bytes());
    // 文件名偏移 72，最多 260 个 WCHAR。
    for (i, unit) in name.encode_utf16().take(259).enumerate() {
        let at = 72 + i * 2;
        buf[at..at + 2].copy_from_slice(&unit.to_le_bytes());
    }
    buf
}

/// `FileGroupDescriptorW` + `FileContents`（每项一个 `TYMED_ISTREAM`）。
pub fn virtual_files(files: &[(String, Vec<u8>)]) -> IDataObject {
    virtual_files_padded(files, 0)
}

/// 同 [`virtual_files`]，但描述符缓冲区尾部额外填充 `extra` 字节。
///
/// 真实来源（尤其 Outlook）常把 HGLOBAL 分配得比 `4 + 620×N` 更大；
/// 生产代码必须只读头部而不是因为「缓冲区超上限」整块放弃。
pub fn virtual_files_padded(files: &[(String, Vec<u8>)], extra: usize) -> IDataObject {
    let mut group = vec![0u8; 4];
    group[0..4].copy_from_slice(&(files.len() as u32).to_le_bytes());
    for (name, bytes) in files {
        group.extend_from_slice(&descriptor(name, Some(bytes.len() as u64)));
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

/// 单个虚拟文件，但 `FileContents` 对 `TYMED_ISTREAM` 请求返回 HGLOBAL。
/// 真实世界里偶有实现无视 `FORMATETC.tymed`；生产代码必须核对后失败，
/// 而不是把 HGLOBAL 当 `IStream` 解引用。
pub fn virtual_files_wrong_tymed(name: &str) -> IDataObject {
    let mut group = vec![0u8; 4];
    group[0..4].copy_from_slice(&1u32.to_le_bytes());
    group.extend_from_slice(&descriptor(name, Some(4)));
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
