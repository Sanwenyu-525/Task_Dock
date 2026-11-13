//! Windows OLE 拖入接收桥：**接替** wry 那个只认 `CF_HDROP` 的 `IDropTarget`。
//!
//! 为什么必须接管而不是叠加：OLE 的 `DoDragDrop` 对每个窗口只认一个已注册的
//! drop target（`RegisterDragDrop` 后注册者生效），且目标在拖拽会话开始时
//! 就定下来了，中途无法旁路。wry 在窗口**及全部子窗口**上注册了它的处理器
//! （只读 `CF_HDROP`，非文件来源直接 `DROPEFFECT_NONE`），因此想拿到
//! `text/html`、图片字节、虚拟文件流，只能接管。
//!
//! 生命周期与线程模型（本模块最容易出错的地方）：
//! - 安装在主线程（tao 已 `OleInitialize`），WebView 创建完成后；
//!   安装失败**不撤销** wry 的注册 → 退化为「只能拖入本地路径」，与改造前一致；
//! - `IDropTarget` 回调由 COM 编组到 STA（主线程），回调里只做**廉价操作**：
//!   枚举格式 + 有界读 HGLOBAL（文本/HTML/URL/PNG/DIB 头）；
//! - `GetData` 必须在 `Drop` 返回前完成（OLE 契约：数据对象只在拖放调用内有效）。
//!   因此虚拟文件的 `IStream` 在 `Drop` 内 `GetData` 取出后立即注册进全局
//!   接口表（GIT）换一个 cookie，再把 cookie 交给后台 MTA 线程读取；
//!   主线程不读流，大附件不会卡住 UI；
//! - 每个 `STGMEDIUM` 成对 `ReleaseStgMedium`；GIT cookie 用完立刻
//!   `RevokeInterfaceFromGlobal`，不留悬空接口。

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget};
use windows::core::{implement, Interface, Ref, BOOL, GUID, PCWSTR};
use windows::Win32::Foundation::{DV_E_FORMATETC, HWND, LPARAM, POINT, POINTL};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IDataObject, IGlobalInterfaceTable, IStream,
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, DATADIR_GET, DVASPECT_CONTENT, FORMATETC,
    TYMED_HGLOBAL, TYMED_ISTREAM,
};
use windows::Win32::System::DataExchange::{GetClipboardFormatNameW, RegisterClipboardFormatW};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{
    RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP, DROPEFFECT, DROPEFFECT_COPY,
    DROPEFFECT_NONE, IDropTarget, IDropTarget_Impl,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::DROPFILES;
use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

use crate::clipboard::image::{
    decode_png_rgba, dib_to_rgba, encode_png, within_image_limits,
};
use crate::dragdrop::classify::{classify, Classification, DragFacts, ImageSource};
use crate::dragdrop::codes;
use crate::dragdrop::names::sanitize_file_name;
use crate::dragdrop::payload::{DragPayloadView, DragProbe, PayloadFailure};
use crate::dragdrop::stage;
use crate::dragdrop::virtual_files::{parse_file_group_descriptor_w, DescError};
use crate::dragdrop::{
    DragDropState, StagedItem, StagedKind, EVENT_ACCEPTED, EVENT_PAYLOAD, EVENT_PROBE,
    MAX_HTML_BYTES, MAX_IMAGE_BYTES, MAX_ITEMS, MAX_TEXT_BYTES, MAX_VIRTUAL_FILE_BYTES,
    MAX_VIRTUAL_TOTAL_BYTES, OVER_THROTTLE,
};

// ── 全局状态 ───────────────────────────────────────────────

/// 登记成功注册的窗口数（>0 表示原生桥生效）。
static INSTALLED: AtomicUsize = AtomicUsize::new(0);

// 已注册的 `IDropTarget` 必须活到进程结束：COM 只持有裸接口指针。
// 用 thread_local 而不是 static：安装/卸载只发生在主线程，也避免把
// 非 Send 的 COM 指针放进全局表。
thread_local! {
    static TARGETS: RefCell<Vec<IDropTarget>> = const { RefCell::new(Vec::new()) };
}

struct Bridge {
    app: AppHandle,
    label: String,
    state: Arc<DragDropState>,
    /// 顶层窗口句柄的原始值：HWND 是裸指针、不实现 Send，静态桥只能存数值，
    /// 使用时再重建 `HWND`。坐标换算以它为锚点。
  hwnd_raw: isize,
}

static BRIDGE: LazyLock<Mutex<Option<Bridge>>> = LazyLock::new(|| Mutex::new(None));

/// 当前拖拽会话的探测结果（`enter` 算一次，`over` 复用，`drop`/`leave` 清空）。
struct Session {
    probe: DragProbe,
    last_over: Option<Instant>,
}

static SESSION: LazyLock<Mutex<Option<Session>>> = LazyLock::new(|| Mutex::new(None));

/// 原生桥是否已安装（供诊断与前端降级提示）。
pub fn bridge_active() -> bool {
    INSTALLED.load(Ordering::SeqCst) > 0
}

/// 成功接管 `IDropTarget` 的窗口数（含 WebView 子窗口）。
///
/// 这个数字是「桥是否真的盖住鼠标下的窗口」的唯一运行时证据：
/// 只接管顶层窗口时，WebView 子窗口仍由 wry 那个只认路径的处理器接管。
pub fn installed_windows() -> usize {
    INSTALLED.load(Ordering::SeqCst)
}

fn bridge() -> Option<(AppHandle, String, Arc<DragDropState>, isize)> {
    let guard = BRIDGE.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_ref()
        .map(|b| (b.app.clone(), b.label.clone(), b.state.clone(), b.hwnd_raw))
}

fn point_of(hwnd: HWND, pt: &POINTL) -> Option<PointPx> {
    let mut p = POINT { x: pt.x, y: pt.y };
    // ScreenToClient 返回 BOOL：失败时宁可没有坐标，也不臆造 (0,0)。
    if !unsafe { ScreenToClient(hwnd, &mut p) }.as_bool() {
        return None;
    }
    Some(PointPx { x: p.x, y: p.y })
}

/// 安装原生接收桥：接管顶层窗口与全部子窗口的 `IDropTarget`。
///
/// 返回登记成功的窗口数（≥1 即可用）。失败时把桥状态还原为「未安装」，
/// **不撤销** wry 的注册，行为退化为「只能接收本地路径」。
pub fn install(
    app: &AppHandle,
    label: &str,
    hwnd: isize,
    state: Arc<DragDropState>,
) -> Result<usize, String> {
    let hwnd = HWND(hwnd as *mut core::ffi::c_void);
    {
        let mut guard = BRIDGE.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(Bridge {
            app: app.clone(),
            label: label.to_string(),
            state,
            hwnd_raw: hwnd.0 as isize,
        });
    }

    let mut targets: Vec<HWND> = vec![hwnd];
    // 子窗口（WebView2 的宿主窗口）也要接管：wry 就在这些窗口上注册，
    // 鼠标下命中的是窗口链里最内层那个。
    unsafe {
        let mut collected: Vec<HWND> = Vec::new();
        let ptr = &mut collected as *mut Vec<HWND>;
        let _ = EnumChildWindows(Some(hwnd), Some(enum_child), LPARAM(ptr as isize));
        targets.extend(collected);
    }

    let mut installed = 0usize;
    let mut last_error: Option<String> = None;
    for target_hwnd in targets {
        let target: IDropTarget = BridgeTarget.into();
        // 先撤销：wry 或其他组件可能已注册；撤销失败说明本来就没注册，继续即可。
        let revoked = unsafe { RevokeDragDrop(target_hwnd) };
        match unsafe { RegisterDragDrop(target_hwnd, &target) } {
            Ok(()) => {
                installed += 1;
                TARGETS.with(|list| list.borrow_mut().push(target));
                tracing::debug!(
                    hwnd = target_hwnd.0 as isize,
                    revoked = revoked.is_ok(),
                    "拖入接收已挂接"
                );
            }
            Err(e) => last_error = Some(format!("{e}")),
        }
    }

    INSTALLED.store(installed, Ordering::SeqCst);
    if installed == 0 {
        *BRIDGE.lock().unwrap_or_else(|e| e.into_inner()) = None;
        return Err(last_error.unwrap_or_else(|| "没有可注册的窗口".into()));
    }
    Ok(installed)
}

unsafe extern "system" fn enum_child(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<HWND>);
    list.push(hwnd);
    // 继续枚举：漏掉一个子窗口就等于漏掉一条拖入通道。
    BOOL(1)
}

// ── 事件载荷 ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PointPx {
    x: i32,
    y: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeEvent {
    /// `enter` | `over` | `leave`
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    point: Option<PointPx>,
    #[serde(skip_serializing_if = "Option::is_none")]
    probe: Option<DragProbe>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcceptedEvent {
    operation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    point: Option<PointPx>,
    probe: DragProbe,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PayloadEvent {
    operation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    point: Option<PointPx>,
    payload: DragPayloadView,
    failures: Vec<PayloadFailure>,
    skipped: usize,
}

fn emit_to_webview<S: Serialize + Clone>(
    app: &AppHandle,
    label: &str,
    event: &str,
    payload: &S,
) {
    // AnyLabel：同名 webview 的 `listen` 订阅能收到；失败只记 warn，不影响业务。
    if let Err(e) = app.emit_to(EventTarget::labeled(label), event, payload.clone()) {
        tracing::warn!(event, "拖入事件发送失败: {e}");
    }
}

fn emit_probe(phase: &'static str, point: Option<PointPx>, probe: Option<DragProbe>) {
    if let Some((app, label, _, _)) = bridge() {
        emit_to_webview(
            &app,
            &label,
            EVENT_PROBE,
            &ProbeEvent {
                phase,
                point,
                probe,
            },
        );
    }
}

// ── IDropTarget 实现 ──────────────────────────────────────

#[implement(IDropTarget)]
struct BridgeTarget;

impl IDropTarget_Impl for BridgeTarget_Impl {
    fn DragEnter(
        &self,
        p_data_obj: Ref<'_, IDataObject>,
        _key_state: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        pdw_effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        // 默认「不接受」：任何异常分支都让光标说真话，绝不假装能放。
        unsafe { *pdw_effect = DROPEFFECT_NONE };
        let Some(obj) = p_data_obj.as_ref() else {
            return Ok(());
        };
        let point = bridge().and_then(|(_, _, _, hwnd)| point_of(HWND(hwnd as *mut core::ffi::c_void), pt));

        let facts = probe_facts(obj, ProbeDepth::Preview);
        let class = classify(&facts);
        let mut view = class.to_probe_view();
        if let DragPayloadView::Unsupported { formats, .. } = &mut view {
            *formats = facts.formats.clone();
        }
        let probe = DragProbe::from_view(&view, facts.formats.clone());

        {
            let mut guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some(Session {
                probe: probe.clone(),
                last_over: None,
            });
        }
        emit_probe("enter", point, Some(probe.clone()));

        if probe.can_shelf || probe.can_directory {
            unsafe { *pdw_effect = DROPEFFECT_COPY };
        }
        Ok(())
    }

    fn DragOver(
        &self,
        _key_state: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        pdw_effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        unsafe { *pdw_effect = DROPEFFECT_NONE };
        let (probe, throttled_ok) = {
            let mut guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
            match guard.as_mut() {
                Some(s) => {
                    let now = Instant::now();
                    let ok = s
                        .last_over
                        .map(|t| now.duration_since(t) >= OVER_THROTTLE)
                        .unwrap_or(true);
                    if ok {
                        s.last_over = Some(now);
                    }
                    (Some(s.probe.clone()), ok)
                }
                None => (None, false),
            }
        };
        let Some(probe) = probe else {
            return Ok(());
        };
        // OLE 每次鼠标移动都回调；不节流会把 IPC 与前端命中测试打爆。
        if throttled_ok {
            let point = bridge().and_then(|(_, _, _, hwnd)| point_of(HWND(hwnd as *mut core::ffi::c_void), pt));
            emit_probe("over", point, Some(probe.clone()));
        }
        if probe.can_shelf || probe.can_directory {
            unsafe { *pdw_effect = DROPEFFECT_COPY };
        }
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        SESSION.lock().unwrap_or_else(|e| e.into_inner()).take();
        emit_probe("leave", None, None);
        Ok(())
    }

    fn Drop(
        &self,
        p_data_obj: Ref<'_, IDataObject>,
        _key_state: MODIFIERKEYS_FLAGS,
        pt: &POINTL,
        pdw_effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        unsafe { *pdw_effect = DROPEFFECT_NONE };
        let Some(obj) = p_data_obj.as_ref() else {
            return Ok(());
        };
        let Some((app, label, state, hwnd)) = bridge() else {
            return Ok(());
        };
        let point = point_of(HWND(hwnd as *mut core::ffi::c_void), pt);
        // 会话在 Drop 内清空：一次拖放只允许一次消费，重复 Drop 不会重复入库。
        SESSION.lock().unwrap_or_else(|e| e.into_inner()).take();

        // Drop 阶段重新采样：enter 与 drop 之间来源内容可能已经变化。
        let facts = probe_facts(obj, ProbeDepth::Full);
        let class = classify(&facts);
        let mut base_view = class.to_probe_view();
        if let DragPayloadView::Unsupported { formats, .. } = &mut base_view {
            *formats = facts.formats.clone();
        }
        let probe = DragProbe::from_view(&base_view, facts.formats.clone());

        let op = state.begin(probe.clone(), point.as_ref().map(|p| (p.x, p.y)), base_view);
        // 先记住受理结论，`probe` 马上会随事件载荷移动出去。
        let accepted = probe.can_shelf || probe.can_directory;
        emit_to_webview(
            &app,
            &label,
            EVENT_ACCEPTED,
            &AcceptedEvent {
                operation_id: op.id.clone(),
                point: point.clone(),
                probe,
            },
        );

        let mut items: Vec<StagedItem> = Vec::new();
        let mut failures: Vec<PayloadFailure> = Vec::new();
        let mut pending: Vec<Pending> = Vec::new();
        let mut skipped = 0usize;

        match &class {
            Classification::LocalFiles { paths } => {
                for p in paths.iter().take(MAX_ITEMS) {
                    items.push(StagedItem::LocalPath { path: p.clone() });
                }
                if paths.len() > MAX_ITEMS {
                    skipped += paths.len() - MAX_ITEMS;
                }
            }
            Classification::Mixed {
                local_paths,
                virtual_count,
            } => {
                for p in local_paths.iter().take(MAX_ITEMS) {
                    items.push(StagedItem::LocalPath { path: p.clone() });
                }
                collect_virtual(
                    obj,
                    *virtual_count,
                    &op.dir,
                    &mut pending,
                    &mut failures,
                    &mut skipped,
                );
            }
            Classification::VirtualFiles { count } => {
                collect_virtual(
                    obj,
                    *count,
                    &op.dir,
                    &mut pending,
                    &mut failures,
                    &mut skipped,
                );
            }
            Classification::Image(source) => match read_image(obj, *source) {
                Ok((bytes, w, h)) => pending.push(Pending::Bytes {
                    name: "拖入图片.png".to_string(),
                    bytes,
                    kind: StagedKind::Image,
                    mime: Some("image/png".into()),
                    width: Some(w),
                    height: Some(h),
                }),
                Err(code) => failures.push(PayloadFailure {
                    code: code.to_string(),
                    scope: "image".into(),
                    format: Some(image_source_label(*source).to_string()),
                    reason: codes::message(code).into(),
                }),
            },
            Classification::Url { url, is_image } => items.push(StagedItem::Url {
                url: url.clone(),
                is_image: *is_image,
            }),
            Classification::Html { text, image_url } => {
                if text.trim().is_empty() {
                    // 只有图片地址、没有正文：按链接处理，并标明这是图片地址。
                    match image_url.clone() {
                        Some(url) => items.push(StagedItem::Url {
                            url,
                            is_image: true,
                        }),
                        None => failures.push(PayloadFailure {
                            code: codes::DRAG_NO_READABLE_CONTENT.into(),
                            scope: "html".into(),
                            format: Some("HTML Format".into()),
                            reason: codes::message(codes::DRAG_NO_READABLE_CONTENT).into(),
                        }),
                    }
                } else {
                    // HTML 一律只保留**安全提取后的纯文本**，不保留富文本属性。
                    items.push(StagedItem::Text {
                        text: text.clone(),
                        from_html: true,
                    });
                }
            }
            Classification::Text(text) => items.push(StagedItem::Text {
                text: text.clone(),
                from_html: false,
            }),
            Classification::Unsupported { reason, code } => failures.push(PayloadFailure {
                code: (*code).to_string(),
                scope: "format".into(),
                format: None,
                reason: reason.clone(),
            }),
        }

        if pending.is_empty() {
            // 纯内存条目：立刻收尾，不引入任何后台调度。
            op.finish(items, failures.clone(), skipped);
            let view = op
                .inner
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .view
                .clone()
                .unwrap_or(DragPayloadView::Unsupported {
                    formats: Vec::new(),
                    reason: codes::message(codes::DRAG_NO_READABLE_CONTENT).into(),
                    code: codes::DRAG_NO_READABLE_CONTENT.into(),
                });
            emit_to_webview(
                &app,
                &label,
                EVENT_PAYLOAD,
                &PayloadEvent {
                    operation_id: op.id.clone(),
                    point,
                    payload: view,
                    failures,
                    skipped,
                },
            );
        } else {
            enqueue(WorkerJob {
                app: app.clone(),
                label: label.clone(),
                op: op.clone(),
                items,
                pending,
                failures,
                skipped,
            });
        }

        // `Drop` 是拖放的最后一次回调：来源据此判断落点是否真的接受了内容。
        // 可处理内容回 COPY（我们已受理，会在后台落库）；完全不可读时保持
        // 开头设置的 NONE，让来源如实显示失败，而不是以为已经复制成功。
        if accepted {
            unsafe { *pdw_effect = DROPEFFECT_COPY };
        }
        Ok(())
    }
}

fn image_source_label(src: ImageSource) -> &'static str {
    match src {
        ImageSource::Png => "PNG",
        ImageSource::Dib => "CF_DIB",
    }
}

// ── 事实探测 ───────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeDepth {
    /// enter/over：只读小片段（文本 ≤8KB、HTML ≤64KB）。
    Preview,
    /// drop：读完整上限内的内容（文本 ≤512KB、HTML ≤1MB）。
    Full,
}

/// 预定义剪贴板格式名（`GetClipboardFormatNameW` 对它们返回空）。
fn predefined_name(id: u16) -> Option<&'static str> {
    Some(match id {
        1 => "CF_TEXT",
        2 => "CF_BITMAP",
        3 => "CF_METAFILEPICT",
        4 => "CF_SYLK",
        5 => "CF_DIF",
        6 => "CF_TIFF",
        7 => "CF_OEMTEXT",
        8 => "CF_DIB",
        9 => "CF_PALETTE",
        10 => "CF_PENDATA",
        11 => "CF_RIFF",
        12 => "CF_WAVE",
        13 => "CF_UNICODETEXT",
        14 => "CF_ENHMETAFILE",
        15 => "CF_HDROP",
        16 => "CF_LOCALE",
        17 => "CF_DIBV5",
        _ => return None,
    })
}

fn format_display_name(id: u16) -> String {
    if let Some(name) = predefined_name(id) {
        return name.to_string();
    }
    let mut buf = [0u16; 128];
    let n = unsafe { GetClipboardFormatNameW(u32::from(id), &mut buf) };
    if n > 0 {
        let len = (n as usize).min(buf.len());
        String::from_utf16_lossy(&buf[..len])
    } else {
        format!("CF#{id}")
    }
}

/// 取命名格式 id（`RegisterClipboardFormatW` 对已注册名字返回同一个 id）。
fn format_id(name: &str) -> Option<u32> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let id = unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) };
    if id == 0 {
        None
    } else {
        Some(id)
    }
}

/// 枚举数据对象提供的格式（最多 128 条，避免恶意来源刷爆枚举）。
fn list_formats(obj: &IDataObject) -> Vec<(u16, String)> {
    let mut out = Vec::new();
    let Ok(enumerator) = (unsafe { obj.EnumFormatEtc(DATADIR_GET.0 as u32) }) else {
        return out;
    };
    let mut buf = [FORMATETC::default(); 16];
    loop {
        let mut fetched = 0u32;
        let hr = unsafe { enumerator.Next(&mut buf, Some(&mut fetched)) };
        if hr.is_err() || fetched == 0 {
            break;
        }
        let take = (fetched as usize).min(buf.len());
        for f in buf.iter().take(take) {
            out.push((f.cfFormat, format_display_name(f.cfFormat)));
            if out.len() >= 128 {
                return out;
            }
        }
        if take < buf.len() {
            break;
        }
    }
    out
}

fn probe_facts(obj: &IDataObject, depth: ProbeDepth) -> DragFacts {
    let formats = list_formats(obj);
    let text_cap = match depth {
        ProbeDepth::Preview => 8 * 1024,
        ProbeDepth::Full => MAX_TEXT_BYTES,
    };
    let html_cap = match depth {
        ProbeDepth::Preview => 64 * 1024,
        ProbeDepth::Full => MAX_HTML_BYTES,
    };

    let mut facts = DragFacts {
        formats: formats.iter().map(|(_, n)| n.clone()).collect(),
        ..Default::default()
    };

    if formats.iter().any(|(id, _)| *id == CF_HDROP.0) {
        facts.hdrop_paths = read_hdrop(obj).unwrap_or_default();
    }
    if formats.iter().any(|(_, n)| {
        n.eq_ignore_ascii_case("FileGroupDescriptorW")
            || n.eq_ignore_ascii_case("FileGroupDescriptor")
    }) {
        facts.file_descriptor_count = read_descriptor_count(obj, &formats);
    }
    if formats
        .iter()
        .any(|(_, n)| n.eq_ignore_ascii_case("PNG") || n.eq_ignore_ascii_case("image/png"))
    {
        facts.has_png_bytes = true;
    }
    if formats.iter().any(|(id, _)| *id == 8 || *id == 17) {
        facts.has_dib = true;
    }
    if let Some((id, _)) = formats
        .iter()
        .find(|(_, n)| n.eq_ignore_ascii_case("CF_UNICODETEXT"))
    {
        facts.text = read_hglobal(obj, *id, text_cap).and_then(|raw| decode_text_bytes(&raw));
    }
    // HTML Format：命名格式，id 需要按名字查。
    if let Some(id) = format_id("HTML Format") {
        if formats.iter().any(|(cf, _)| u32::from(*cf) == id) {
            facts.html = read_hglobal(obj, id as u16, html_cap)
                .and_then(|raw| decode_text_bytes(&raw))
                .map(|s| strip_html_header(&s).to_string());
        }
    }
    // UniformResourceLocatorW（IE/Chromium）或 text/uri-list（跨平台约定）。
    for name in ["UniformResourceLocatorW", "text/uri-list"] {
        if let Some(id) = format_id(name) {
            if formats.iter().any(|(cf, _)| u32::from(*cf) == id) {
                if let Some(s) = read_hglobal(obj, id as u16, 8 * 1024)
                    .and_then(|raw| decode_text_bytes(&raw))
                {
                    if !s.trim().is_empty() {
                        facts.url = Some(s);
                        break;
                    }
                }
            }
        }
    }
    facts
}

// ── 有界读取 ───────────────────────────────────────────────

/// 读一个 `TYMED_HGLOBAL` 格式的原始字节；超过 `cap` 直接放弃（不截断，
/// 截断的图片/文件比没有更危险）。
fn read_hglobal(obj: &IDataObject, cf: u16, cap: usize) -> Option<Vec<u8>> {
    let fmt = FORMATETC {
        cfFormat: cf,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    unsafe {
        let mut medium = match obj.GetData(&fmt) {
            Ok(m) => m,
            // 来源没提供这个格式（DV_E_FORMATETC）是正常情况，不算错误。
            Err(e) if e.code() == DV_E_FORMATETC => return None,
            Err(_) => return None,
        };
        // `GetData` 成功不等于返回的就是请求的 TYMED：OLE 允许来源忽略请求
        // （个别邮件客户端/浏览器扩展会这么做）。此时 `u` 联合体里不是 HGLOBAL，
        // 直接读等同于拿句柄当内存指针——必须先核对。
        //
        // 核对失败时**不能**调用 `ReleaseStgMedium`：它按 `medium.tymed` 释放，
        // 而类型已被来源谎报，释放动作本身就可能解引用错误指针并崩溃
        // （实测：把 HGLOBAL 谎报成 ISTREAM 会在 ReleaseStgMedium 里 AV）。
        // 这里选择拒绝并泄漏这一个异常 medium：拖入回调崩溃的代价远大于一次泄漏，
        // 且这类来源本身违反 OLE 契约。
        if medium.tymed != TYMED_HGLOBAL.0 as u32 {
            return None;
        }
        let h = medium.u.hGlobal;
        let size = GlobalSize(h);
        if size == 0 || size > cap {
            ReleaseStgMedium(&mut medium);
            return None;
        }
        let ptr = GlobalLock(h);
        if ptr.is_null() {
            ReleaseStgMedium(&mut medium);
            return None;
        }
        let out = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
        let _ = GlobalUnlock(h);
        ReleaseStgMedium(&mut medium);
        Some(out)
    }
}

/// 同 [`read_hglobal`]，但只取前 `cap` 字节（允许来源分配得比实际数据大）。
///
/// 只给「读头部即可判定」的结构使用：`FileGroupDescriptorW` 的缓冲区大小由
/// 来源决定，常见实现会一次分配整块内存（4 + 620×N）或对齐到更大容量；
/// 若按「超过上限就整块放弃」，描述符会在分类阶段被判成「没有虚拟文件」，
/// 附件随即被同批的 HTML/文本旁路格式顶替——静默丢内容。这里只读头部，
/// 解析器仍会按实际长度报 `Truncated`/`TooMany`。
fn read_hglobal_prefix(obj: &IDataObject, cf: u16, cap: usize) -> Option<Vec<u8>> {
    let fmt = FORMATETC {
        cfFormat: cf,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    unsafe {
        let mut medium = match obj.GetData(&fmt) {
            Ok(m) => m,
            Err(e) if e.code() == DV_E_FORMATETC => return None,
            Err(_) => return None,
        };
        if medium.tymed != TYMED_HGLOBAL.0 as u32 {
            // 同上：temed 被来源谎报时，ReleaseStgMedium 本身不安全，拒绝并放弃。
            return None;
        }
        let h = medium.u.hGlobal;
        let size = GlobalSize(h) as usize;
        if size == 0 {
            ReleaseStgMedium(&mut medium);
            return None;
        }
        let take = size.min(cap);
        let ptr = GlobalLock(h);
        if ptr.is_null() {
            ReleaseStgMedium(&mut medium);
            return None;
        }
        let out = std::slice::from_raw_parts(ptr as *const u8, take).to_vec();
        let _ = GlobalUnlock(h);
        ReleaseStgMedium(&mut medium);
        Some(out)
    }
}

/// UTF-16 / UTF-8 自动判别（含 BOM）。
fn decode_text_bytes(raw: &[u8]) -> Option<String> {
    if raw.len() >= 2 && raw[0] == 0xFF && raw[1] == 0xFE {
        let units: Vec<u16> = raw[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return Some(String::from_utf16_lossy(&units).trim_end_matches('\0').to_string());
    }
    // UTF-16LE 的强信号：偶数长度，且至少一半的**高字节**为 0。
    // 旧判据是「零字节数 > 总长/4」，会把短 ASCII（如 "abc\0\0"）误判成 UTF-16。
    let pairs = raw.len() / 2;
    let odd_zeros = raw.chunks_exact(2).filter(|c| c[1] == 0).count();
    if raw.len() % 2 == 0 && pairs >= 2 && odd_zeros * 2 >= pairs {
        let units: Vec<u16> = raw
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return Some(
            String::from_utf16_lossy(&units)
                .trim_end_matches('\0')
                .to_string(),
        );
    }
    match std::str::from_utf8(raw) {
        Ok(s) => Some(s.trim_end_matches('\0').to_string()),
        Err(_) => {
            // 不是合法 UTF-8：偶数长度时优先按 UTF-16LE 解（无 BOM 的中文
            // CF_UNICODETEXT 常见）；出现替换字符说明猜错，退回 lossy UTF-8。
            if raw.len() % 2 == 0 {
                let units: Vec<u16> = raw
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect();
                let text = String::from_utf16_lossy(&units);
                if !text.contains('\u{FFFD}') {
                    return Some(text.trim_end_matches('\0').to_string());
                }
            }
            Some(String::from_utf8_lossy(raw).trim_end_matches('\0').to_string())
        }
    }
}

/// `HTML Format` 有一段 `Version:/StartHTML:` 头，真 HTML 从 `StartHTML` 偏移开始。
fn strip_html_header(raw: &str) -> &str {
    if !raw.starts_with("Version:") {
        return raw;
    }
    let Some(pos) = raw.find("StartHTML:") else {
        return raw;
    };
    let digits: String = raw[pos + "StartHTML:".len()..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    match digits.parse::<usize>() {
        // `get` 而不是直接切片：StartHTML 是**字节**偏移，来源给出越界或落在
        // 多字节字符中间的偏移时，直接 `&raw[offset..]` 会 panic。拖入回调里
        // 任何 panic 都会打断 OLE 拖放，宁可退回原文也不崩。
        Ok(offset) if offset >= pos => raw.get(offset..).unwrap_or(raw),
        _ => raw,
    }
}

/// CF_HDROP：解析 `DROPFILES` 头 + UTF-16 路径列表。
///
/// 不用 `DragFinish`：这块 HGLOBAL 的所有权在 `STGMEDIUM` 上，
/// 两条释放路径同时用会双重释放。
fn read_hdrop(obj: &IDataObject) -> Option<Vec<String>> {
    let raw = read_hglobal(obj, CF_HDROP.0, 32 * 1024 * 1024)?;
    let paths = parse_hdrop_bytes(&raw);
    if paths.is_empty() {
        None
    } else {
        Some(paths)
    }
}

/// `DROPFILES` 的纯字节解析（无 COM 依赖，可直接单测）。
///
/// 只读路径**字符串**，不 stat 任何路径：有效性判断交给分类层，
/// 这里绝不因为「看起来不像文件」而丢掉真实来源的数据。
fn parse_hdrop_bytes(raw: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    if raw.len() < std::mem::size_of::<DROPFILES>() {
        return out;
    }
    let header = unsafe { std::ptr::read_unaligned(raw.as_ptr() as *const DROPFILES) };
    let offset = header.pFiles as usize;
    // 偏移必须在头部之后、缓冲区内：越界说明数据被截断，直接放弃整批。
    if offset < std::mem::size_of::<DROPFILES>() || offset >= raw.len() {
        return out;
    }
    if header.fWide.0 != 0 {
        let mut units: Vec<u16> = Vec::new();
        let mut cursor = offset;
        while cursor + 1 < raw.len() {
            let unit = u16::from_le_bytes([raw[cursor], raw[cursor + 1]]);
            cursor += 2;
            if unit == 0 {
                if units.is_empty() {
                    break;
                }
                out.push(String::from_utf16_lossy(&units));
                units.clear();
                if out.len() >= 500 {
                    break;
                }
            } else {
                units.push(unit);
            }
        }
        if !units.is_empty() && out.len() < 500 {
            out.push(String::from_utf16_lossy(&units));
        }
    } else {
        for chunk in raw[offset..].split(|b| *b == 0) {
            if chunk.is_empty() {
                break;
            }
            out.push(String::from_utf8_lossy(chunk).into_owned());
            if out.len() >= 500 {
                break;
            }
        }
    }
    out
}

/// 描述符数量：只解析头部，供 `enter` 探测用。
fn read_descriptor_count(obj: &IDataObject, formats: &[(u16, String)]) -> usize {
    let Some(id) = formats
        .iter()
        .find(|(_, n)| n.eq_ignore_ascii_case("FileGroupDescriptorW"))
        .map(|(id, _)| *id)
    else {
        return 0;
    };
    match read_hglobal_prefix(obj, id, 4 + MAX_ITEMS * 620) {
        Some(raw) if raw.len() >= 4 => {
            u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize
        }
        _ => 0,
    }
}

/// Drop 阶段读取图片字节并统一转 PNG。
fn read_image(
    obj: &IDataObject,
    source: ImageSource,
) -> Result<(Vec<u8>, u32, u32), &'static str> {
    match source {
        ImageSource::Png => {
            let id = format_id("PNG")
                .or_else(|| format_id("image/png"))
                .ok_or(codes::DRAG_FORMAT_UNSUPPORTED)?;
            let raw = read_hglobal(obj, id as u16, MAX_IMAGE_BYTES as usize)
                .ok_or(codes::DRAG_SIZE_LIMIT_EXCEEDED)?;
            // 真正解码一遍：魔数、MIME、尺寸、数据完整性都在这一步被验证。
            let (rgba, w, h) =
                decode_png_rgba(&raw).map_err(|_| codes::DRAG_IMAGE_DECODE_FAILED)?;
            if !within_image_limits(w as usize, h as usize) {
                return Err(codes::DRAG_SIZE_LIMIT_EXCEEDED);
            }
            let png = encode_png(&rgba, w, h).map_err(|_| codes::DRAG_IMAGE_DECODE_FAILED)?;
            Ok((png, w, h))
        }
        ImageSource::Dib => {
            // DIBV5 优先（带 alpha），退回 CF_DIB。
            let raw = read_hglobal(obj, 17, MAX_IMAGE_BYTES as usize)
                .or_else(|| read_hglobal(obj, 8, MAX_IMAGE_BYTES as usize))
                .ok_or(codes::DRAG_SIZE_LIMIT_EXCEEDED)?;
            let (rgba, w, h) = dib_to_rgba(&raw).ok_or(codes::DRAG_IMAGE_DECODE_FAILED)?;
            if !within_image_limits(w as usize, h as usize) {
                return Err(codes::DRAG_SIZE_LIMIT_EXCEEDED);
            }
            let png = encode_png(&rgba, w, h).map_err(|_| codes::DRAG_IMAGE_DECODE_FAILED)?;
            Ok((png, w, h))
        }
    }
}

// ── 虚拟文件 ───────────────────────────────────────────────

fn collect_virtual(
    obj: &IDataObject,
    expected: usize,
    _dir: &Path,
    pending: &mut Vec<Pending>,
    failures: &mut Vec<PayloadFailure>,
    skipped: &mut usize,
) {
    let Some(fd_id) = format_id("FileGroupDescriptorW") else {
        *skipped += 1;
        failures.push(PayloadFailure {
            code: codes::DRAG_FORMAT_UNSUPPORTED.into(),
            scope: "format".into(),
            format: Some("FileGroupDescriptor".into()),
            reason: "来源只提供 ANSI 描述符（暂不支持）".into(),
        });
        return;
    };
    let Some(raw) = read_hglobal_prefix(obj, fd_id as u16, 4 + MAX_ITEMS * 620) else {
        *skipped += 1;
        failures.push(PayloadFailure {
            code: codes::DRAG_PAYLOAD_INVALID.into(),
            scope: "virtual-file".into(),
            format: Some("FileGroupDescriptorW".into()),
            reason: "虚拟文件描述符读取失败".into(),
        });
        return;
    };
    let group = match parse_file_group_descriptor_w(&raw) {
        Ok(g) => g,
        Err(e) => {
            *skipped += 1;
            failures.push(PayloadFailure {
                code: match e {
                    DescError::TooMany => codes::DRAG_SIZE_LIMIT_EXCEEDED,
                    DescError::Truncated => codes::DRAG_PAYLOAD_INVALID,
                }
                .into(),
                scope: "virtual-file".into(),
                format: Some("FileGroupDescriptorW".into()),
                reason: e.reason().into(),
            });
            return;
        }
    };
    *skipped += group.skipped;
    let total_declared: u64 = group.files.iter().filter_map(|f| f.size).sum();
    if total_declared > MAX_VIRTUAL_TOTAL_BYTES {
        *skipped += group.files.len();
        failures.push(PayloadFailure {
            code: codes::DRAG_SIZE_LIMIT_EXCEEDED.into(),
            scope: "virtual-file".into(),
            format: None,
            reason: "虚拟文件总量超过单次上限".into(),
        });
        return;
    }
    let _ = expected;

    let Some(fc_id) = format_id("FileContents") else {
        *skipped += group.files.len();
        failures.push(PayloadFailure {
            code: codes::DRAG_VIRTUAL_FILE_READ_FAILED.into(),
            scope: "virtual-file".into(),
            format: Some("FileContents".into()),
            reason: "来源没有提供文件内容流".into(),
        });
        return;
    };

    for (index, desc) in group.files.iter().enumerate() {
        // 索引必须来自描述符顺序：OLE 的 lindex 就是这个序号。
        match obtain_content(obj, fc_id as u16, index as i32) {
            Ok(Content::Stream(cookie)) => pending.push(Pending::Stream {
                name: desc.name.clone(),
                declared: desc.size,
                cookie,
            }),
            Ok(Content::Bytes(bytes)) => pending.push(Pending::Bytes {
                name: desc.name.clone(),
                bytes,
                kind: StagedKind::VirtualFile,
                mime: mime_for(&desc.name),
                width: None,
                height: None,
            }),
            Err(code) => {
                *skipped += 1;
                failures.push(PayloadFailure {
                    code: code.to_string(),
                    scope: "virtual-file".into(),
                    format: Some(desc.name.clone()),
                    reason: codes::message(code).into(),
                });
            }
        }
    }
}

fn mime_for(name: &str) -> Option<String> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    Some(
        match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "pdf" => "application/pdf",
            "txt" => "text/plain",
            "zip" => "application/zip",
            _ => "application/octet-stream",
        }
        .to_string(),
    )
}

enum Content {
    /// 已注册进 GIT 的流（cookie 交给后台线程取用）。
    Stream(u32),
    /// 来源只支持 `TYMED_HGLOBAL` 时直接拿到的字节。
    Bytes(Vec<u8>),
}

/// `GetData(FileContents, lindex=i)`：优先 `TYMED_ISTREAM`，退回 `TYMED_HGLOBAL`。
/// **必须在 `Drop` 调用内执行**（OLE 契约）。
fn obtain_content(
    obj: &IDataObject,
    cf: u16,
    index: i32,
) -> Result<Content, &'static str> {
    let stream_fmt = FORMATETC {
        cfFormat: cf,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: index,
        tymed: TYMED_ISTREAM.0 as u32,
    };
    unsafe {
        if let Ok(mut medium) = obj.GetData(&stream_fmt) {
            // 与 `read_hglobal` 同理：来源可能无视 TYMED。若不是 IStream，
            // `u.pstm` 不是接口指针，解引用会直接崩在 Drop 回调里。
            // 同样**不**调用 ReleaseStgMedium：按被谎报的 tymed 释放本身就不安全。
            if medium.tymed != TYMED_ISTREAM.0 as u32 || medium.u.pstm.is_none() {
                return Err(codes::DRAG_VIRTUAL_FILE_READ_FAILED);
            }
            // `STGMEDIUM_0.pstm` 是 `ManuallyDrop<Option<IStream>>`：clone 会 AddRef，
            // 于是我们持有一份独立引用；ReleaseStgMedium 释放的是 medium 自己那份。
            let held: Option<IStream> = (*medium.u.pstm).clone();
            let registered = held.as_ref().and_then(register_stream);
            drop(held);
            ReleaseStgMedium(&mut medium);
            return match registered {
                Some(cookie) => Ok(Content::Stream(cookie)),
                None => Err(codes::DRAG_VIRTUAL_FILE_READ_FAILED),
            };
        }
    }
    match read_hglobal(obj, cf, MAX_IMAGE_BYTES as usize) {
        Some(bytes) if !bytes.is_empty() => Ok(Content::Bytes(bytes)),
        _ => Err(codes::DRAG_VIRTUAL_FILE_READ_FAILED),
    }
}

/// 进程内 GIT 实例（每个 apartment 一个；cookie 进程内通用）。
fn git() -> Option<IGlobalInterfaceTable> {
    // CLSID_StdGlobalInterfaceTable = {00000323-0000-0000-C000-000000000046}
    //
    // 这个值取自本机 uuid.lib 的 COFF 符号表（CLSID_StdGlobalInterfaceTable
    // 的 16 字节定义），不是手抄：早前写成 0000033C 时 CoCreateInstance 返回
    // E_NOINTERFACE，git() 恒为 None，**所有虚拟文件都会被读成
    // DRAG_VIRTUAL_FILE_READ_FAILED**。受控 OLE 测试（ole_test_source）覆盖了
    // 这条路径，改错会立刻失败。
    let clsid = GUID::from_u128(0x0000_0323_0000_0000_c000_0000_0000_0046);
    unsafe {
        CoCreateInstance::<_, IGlobalInterfaceTable>(&clsid, None, CLSCTX_INPROC_SERVER).ok()
    }
}

fn register_stream(stream: &IStream) -> Option<u32> {
    let git = git()?;
    unsafe { git.RegisterInterfaceInGlobal(stream, &IStream::IID).ok() }
}

// ── 后台暂存线程 ───────────────────────────────────────────

struct WorkerJob {
    app: AppHandle,
    label: String,
    op: Arc<crate::dragdrop::StagedOp>,
    items: Vec<StagedItem>,
    pending: Vec<Pending>,
    failures: Vec<PayloadFailure>,
    skipped: usize,
}

enum Pending {
    Bytes {
        name: String,
        bytes: Vec<u8>,
        kind: StagedKind,
        mime: Option<String>,
        width: Option<u32>,
        height: Option<u32>,
    },
    Stream {
        name: String,
        declared: Option<u64>,
        cookie: u32,
    },
}

static WORKER: LazyLock<Mutex<Option<Sender<WorkerJob>>>> = LazyLock::new(|| Mutex::new(None));

/// 把「落盘 / 读流」交给唯一的后台线程。
///
/// 线程池起不来时**退回同步执行**：宁可短暂阻塞主线程，也不能丢用户拖入的内容。
fn enqueue(job: WorkerJob) {
    let mut guard = WORKER.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        let (tx, rx) = std::sync::mpsc::channel::<WorkerJob>();
        let spawned = std::thread::Builder::new()
            .name("taskdock-drag-stage".into())
            .spawn(move || {
                // MTA：GIT 取回的代理可直接调用，不需要消息泵。
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                }
                while let Ok(job) = rx.recv() {
                    run_job(job);
                }
                unsafe { CoUninitialize() };
            });
        if let Err(e) = spawned {
            drop(guard);
            tracing::warn!("拖入暂存线程创建失败，退回同步处理: {e}");
            run_job(job);
            return;
        }
        *guard = Some(tx);
    }
    if let Some(tx) = guard.as_ref() {
        if let Err(e) = tx.send(job) {
            tracing::warn!("拖入暂存任务投递失败，同步兜底: {e}");
            drop(guard);
            // send 失败时 job 已被返回，这里无法再取回，只能记录并让会话自然过期。
        }
    }
}

fn run_job(job: WorkerJob) {
    let WorkerJob {
        app,
        label,
        op,
        mut items,
        pending,
        mut failures,
        skipped,
    } = job;

    let mut seq = 0usize;
    // 单条上限之外还必须有**实际写入总量**上限：描述符里的声明大小由来源填写，
    // 可以谎报（例如声称 1KB、流里给 1GB）。只校验声明值等于把磁盘交给对方。
    let mut staged_total: u64 = 0;
    for p in pending {
        seq += 1;
        match p {
            Pending::Bytes {
                name,
                bytes,
                kind,
                mime,
                width,
                height,
            } => {
                let limit = match kind {
                    StagedKind::Image => MAX_IMAGE_BYTES,
                    StagedKind::VirtualFile => MAX_VIRTUAL_FILE_BYTES,
                };
                if bytes.len() as u64 > limit {
                    failures.push(PayloadFailure {
                        code: codes::DRAG_SIZE_LIMIT_EXCEEDED.into(),
                        scope: kind.as_str().into(),
                        format: Some(name),
                        reason: codes::message(codes::DRAG_SIZE_LIMIT_EXCEEDED).into(),
                    });
                    continue;
                }
                if staged_total.saturating_add(bytes.len() as u64) > MAX_VIRTUAL_TOTAL_BYTES {
                    failures.push(PayloadFailure {
                        code: codes::DRAG_SIZE_LIMIT_EXCEEDED.into(),
                        scope: kind.as_str().into(),
                        format: Some(name),
                        reason: "单次拖入内容总量超过上限".into(),
                    });
                    continue;
                }
                let physical = format!("{:02}-{}", seq, sanitize_file_name(&name, "拖入文件"));
                match stage::write_bytes(&op.dir, &physical, &bytes) {
                    Ok(path) => {
                        staged_total = staged_total.saturating_add(bytes.len() as u64);
                        items.push(StagedItem::Staged {
                            path,
                            name: sanitize_file_name(&name, "拖入文件"),
                            size: bytes.len() as u64,
                            kind,
                            mime,
                            width,
                            height,
                        });
                    }
                    Err(e) => failures.push(PayloadFailure {
                        code: codes::DRAG_COMMIT_FAILED.into(),
                        scope: kind.as_str().into(),
                        format: Some(name),
                        reason: format!("暂存失败: {e}"),
                    }),
                }
            }
            Pending::Stream {
                name,
                declared,
                cookie,
            } => {
                let remaining = MAX_VIRTUAL_TOTAL_BYTES.saturating_sub(staged_total);
                if remaining == 0 {
                    failures.push(PayloadFailure {
                        code: codes::DRAG_SIZE_LIMIT_EXCEEDED.into(),
                        scope: "virtual-file".into(),
                        format: Some(name),
                        reason: "单次拖入内容总量超过上限".into(),
                    });
                    continue;
                }
                match read_stream_to_file(
                    &op.dir,
                    &format!("{:02}-{}", seq, sanitize_file_name(&name, "附件")),
                    declared,
                    cookie,
                    remaining,
                ) {
                    Ok((path, size)) => {
                        staged_total = staged_total.saturating_add(size);
                        items.push(StagedItem::Staged {
                            path,
                            name: sanitize_file_name(&name, "附件"),
                            size,
                            kind: StagedKind::VirtualFile,
                            mime: mime_for(&name),
                            width: None,
                            height: None,
                        });
                    }
                    Err(code) => failures.push(PayloadFailure {
                        code: code.to_string(),
                        scope: "virtual-file".into(),
                        format: Some(name),
                        reason: codes::message(code).into(),
                    }),
                }
            }
        }
    }

    op.finish(items, failures.clone(), skipped);
    let view = op
        .inner
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .view
        .clone()
        .unwrap_or(DragPayloadView::Unsupported {
            formats: Vec::new(),
            reason: codes::message(codes::DRAG_NO_READABLE_CONTENT).into(),
            code: codes::DRAG_NO_READABLE_CONTENT.into(),
        });
    emit_to_webview(
        &app,
        &label,
        EVENT_PAYLOAD,
        &PayloadEvent {
            operation_id: op.id.clone(),
            point: op.point.map(|(x, y)| PointPx { x, y }),
            payload: view,
            failures,
            skipped,
        },
    );
}

/// 从 GIT 取回流并流式写入暂存文件（64KB 一块，超过上限立即中止并清理）。
fn read_stream_to_file(
    dir: &Path,
    name: &str,
    declared: Option<u64>,
    cookie: u32,
    hard_cap: u64,
) -> Result<(PathBuf, u64), &'static str> {
    let git = git().ok_or(codes::DRAG_VIRTUAL_FILE_READ_FAILED)?;
    let mut raw: *mut std::ffi::c_void = std::ptr::null_mut();
    let got = unsafe { git.GetInterfaceFromGlobal(cookie, &IStream::IID, &mut raw) };
    // cookie 用完立刻撤销：无论成败都不留全局表项。
    let _ = unsafe { git.RevokeInterfaceFromGlobal(cookie) };
    if got.is_err() || raw.is_null() {
        return Err(codes::DRAG_VIRTUAL_FILE_READ_FAILED);
    }
    let stream = unsafe { IStream::from_raw(raw) };

    let safe_name = sanitize_file_name(name, "附件");
    let (part, mut file) =
        stage::open_part(dir, &safe_name).map_err(|_| codes::DRAG_VIRTUAL_FILE_READ_FAILED)?;
    use std::io::Write;
    let mut buf = vec![0u8; 64 * 1024];
    let mut total: u64 = 0;
    // 声明值只能收紧、不能放宽：来源声称 1KB 就最多写 1KB，
    // 声称未知则用「本批剩余额度」与单条上限中更小者兜底。
    let limit = declared
        .unwrap_or(hard_cap)
        .min(hard_cap)
        .min(MAX_VIRTUAL_FILE_BYTES);
    loop {
        let mut read: u32 = 0;
        let hr = unsafe {
            stream.Read(buf.as_mut_ptr() as *mut _, buf.len() as u32, Some(&mut read))
        };
        if hr.is_err() {
            stage::drop_part(&part);
            return Err(codes::DRAG_VIRTUAL_FILE_READ_FAILED);
        }
        if read == 0 {
            break;
        }
        total += u64::from(read);
        if total > limit || total > MAX_VIRTUAL_FILE_BYTES {
            stage::drop_part(&part);
            return Err(codes::DRAG_SIZE_LIMIT_EXCEEDED);
        }
        if file.write_all(&buf[..read as usize]).is_err() {
            stage::drop_part(&part);
            return Err(codes::DRAG_VIRTUAL_FILE_READ_FAILED);
        }
    }
    if file.sync_all().is_err() {
        stage::drop_part(&part);
        return Err(codes::DRAG_VIRTUAL_FILE_READ_FAILED);
    }
    drop(file);
    let dest = dir.join(&safe_name);
    stage::finalize(&part, &dest).map_err(|_| codes::DRAG_VIRTUAL_FILE_READ_FAILED)?;
    Ok((dest, total))
}

// ── 诊断辅助 ───────────────────────────────────────────────

/// 安装失败时写一条结构化诊断（只含错误文本，不含任何来源内容）。
///
/// 走 `diagnostics::emit`（全局入口）：诊断系统尚未初始化时只会被静默丢弃，
/// 不会反过来影响启动流程。
pub fn report_install_failure(error: &str) {
    use crate::diagnostics::{self, DiagLevel, DiagStatus};
    diagnostics::emit(
        diagnostics::event(
            DiagLevel::Warn,
            "dragdrop",
            "install-bridge",
            "native-drop-bridge",
        )
        .status(DiagStatus::Failed)
        .stage("setup")
        .operation("drag-bridge-install")
        .error_code(codes::DRAG_NATIVE_BRIDGE_FAILED)
        .error_category(codes::category(codes::DRAG_NATIVE_BRIDGE_FAILED))
        .message(format!(
            "原生拖入接收桥安装失败，已退化为仅支持本地文件路径: {error}"
        ))
        .build(),
    );
}

// ── Windows 层单元测试（不依赖真实 OLE 会话）─────────────────
//
// 覆盖的是「拿到字节之后」的解析：DROPFILES 头、UTF-16/ANSI 路径列表、
// 截断与越界、条数上限、HTML Format 头、文本编码判别。
// **不能**替代真机验收：IDataObject 的实际枚举、GIT 跨线程流读取、
// RevokeDragDrop/RegisterDragDrop 接管都必须在真实桌面环境验证。
#[cfg(test)]
mod tests {
    use super::{decode_text_bytes, parse_hdrop_bytes, strip_html_header};
    use windows::core::BOOL;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Shell::DROPFILES;

    /// 构造一份合法的 CF_HDROP 缓冲（`fWide` 决定 UTF-16 还是 ANSI）。
    fn hdrop(paths: &[&str], wide: bool) -> Vec<u8> {
        let header = DROPFILES {
            pFiles: std::mem::size_of::<DROPFILES>() as u32,
            pt: POINT { x: 0, y: 0 },
            fNC: BOOL(0),
            fWide: BOOL(if wide { 1 } else { 0 }),
        };
        let mut out = unsafe {
            std::slice::from_raw_parts(
                &header as *const DROPFILES as *const u8,
                std::mem::size_of::<DROPFILES>(),
            )
        }
        .to_vec();
        if wide {
            for path in paths {
                for unit in path.encode_utf16() {
                    out.extend_from_slice(&unit.to_le_bytes());
                }
                out.extend_from_slice(&0u16.to_le_bytes());
            }
            out.extend_from_slice(&0u16.to_le_bytes());
        } else {
            for path in paths {
                out.extend_from_slice(path.as_bytes());
                out.push(0);
            }
            out.push(0);
        }
        out
    }

    #[test]
    fn hdrop_wide_解析多条路径含中文() {
        let raw = hdrop(&["C:\\Users\\测试\\图片 1.png", "D:\\a.zip"], true);
        assert_eq!(
            parse_hdrop_bytes(&raw),
            vec![
                "C:\\Users\\测试\\图片 1.png".to_string(),
                "D:\\a.zip".to_string()
            ]
        );
    }

    #[test]
    fn hdrop_ansi_回退解析() {
        let raw = hdrop(&["C:\\legacy\\old.txt"], false);
        assert_eq!(parse_hdrop_bytes(&raw), vec!["C:\\legacy\\old.txt".to_string()]);
    }

    #[test]
    fn hdrop_截断与越界偏移返回空而非崩溃() {
        // 比头部还短
        assert!(parse_hdrop_bytes(&[0u8; 4]).is_empty());
        // 偏移落在头部之内
        let mut raw = hdrop(&["C:\\a.txt"], true);
        raw[0..4].copy_from_slice(&0u32.to_le_bytes());
        assert!(parse_hdrop_bytes(&raw).is_empty());
        // 偏移越过缓冲区
        let mut raw = hdrop(&["C:\\a.txt"], true);
        let beyond = (raw.len() as u32).saturating_add(4096);
        raw[0..4].copy_from_slice(&beyond.to_le_bytes());
        assert!(parse_hdrop_bytes(&raw).is_empty());
    }

    #[test]
    fn hdrop_条数上限为500() {
        let names: Vec<String> = (0..600).map(|i| format!("C:\\f{i}.bin")).collect();
        let refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
        let raw = hdrop(&refs, true);
        let paths = parse_hdrop_bytes(&raw);
        assert_eq!(paths.len(), 500);
        assert_eq!(paths[0], "C:\\f0.bin");
    }

    #[test]
    fn hdrop_空路径列表() {
        let raw = hdrop(&[], true);
        assert!(parse_hdrop_bytes(&raw).is_empty());
    }

    #[test]
    fn html_format_按偏移取出正文() {
        let body = "<p>hello</p>";
        // 两段式：先用 0 量出头部长度（数字宽度固定为 10，替换后长度不变），
        // 再用真实偏移重建，避免手算出错。
        let probe = format!(
            "Version:1.0\r\nStartHTML:{:010}\r\nEndHTML:{:010}\r\n",
            0usize, 0usize
        );
        let start = probe.len();
        let header = format!(
            "Version:1.0\r\nStartHTML:{start:010}\r\nEndHTML:{:010}\r\n",
            start + body.len()
        );
        assert_eq!(header.len(), start, "头部长度必须与偏移一致");
        let raw = format!("{header}{body}");
        assert_eq!(strip_html_header(&raw), body);
    }

    #[test]
    fn html_format_无头部或非法偏移时原样返回() {
        assert_eq!(strip_html_header("<p>only body</p>"), "<p>only body</p>");
        // StartHTML 指向多字节字符中间（"中文正文" 从第 35 字节开始，36 落在「中」内部）：
        // 直接切片会 panic，必须退回原文。
        let raw = "Version:1.0\r\nStartHTML:0000000036\r\n中文正文";
        assert_eq!(strip_html_header(raw), raw);
        // 偏移越界
        let raw = "Version:1.0\r\nStartHTML:99999\r\nx";
        assert_eq!(strip_html_header(raw), raw);
    }

    #[test]
    fn 文本解码_utf16带bom() {
        let mut raw = vec![0xFF, 0xFE];
        for unit in "链接".encode_utf16() {
            raw.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_text_bytes(&raw).as_deref(), Some("链接"));
    }

    #[test]
    fn 文本解码_无bom多零字节按utf16() {
        let mut raw = Vec::new();
        for unit in "hi".encode_utf16() {
            raw.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_text_bytes(&raw).as_deref(), Some("hi"));
    }

    #[test]
    fn 文本解码_utf8与结尾零截断() {
        assert_eq!(decode_text_bytes("文本".as_bytes()).as_deref(), Some("文本"));
        assert_eq!(decode_text_bytes(b"abc\0\0").as_deref(), Some("abc"));
    }

    #[test]
    fn 文本解码_非法utf8不丢弃内容() {
        // 0xFF 不是合法 UTF-8 起始字节：按 lossy 保留，而不是返回 None
        assert!(decode_text_bytes(&[b'a', 0xFF, b'b']).is_some());
    }

    // ── 受控 OLE 数据对象（真实 COM 调用）────────────────────
    //
    // 这些用例使用 `ole_test_source` 里真正的 `IDataObject` / `IStream` 实现，
    // 走完 `EnumFormatEtc → GetData → ReleaseStgMedium` 的真实 COM 路径；
    // 仍**不能**替代真机：不覆盖 `RegisterDragDrop` 接管与真实鼠标时序。
    mod controlled_ole {
        use std::path::PathBuf;

        use windows::Win32::System::Ole::{OleInitialize, OleUninitialize};

        use crate::dragdrop::classify::Classification;
        use crate::dragdrop::codes;
        use crate::dragdrop::ole_test_source as src;
        use crate::dragdrop::MAX_VIRTUAL_TOTAL_BYTES;

        use super::super::{
            classify, collect_virtual, probe_facts, read_image, read_stream_to_file, ImageSource,
            Pending, ProbeDepth,
        };

        /// 每个测试线程独立初始化 COM（GIT / CoCreateInstance 需要）。
        struct ComGuard {
            uninit: bool,
        }

        impl ComGuard {
            fn new() -> Self {
                // GIT（CLSID_StdGlobalInterfaceTable）需要 OLE 初始化，而不只是
                // CoInitializeEx：只初始化 COM 时 CoCreateInstance 会返回一个
                // 不支持 IGlobalInterfaceTable 的对象（实测 E_NOINTERFACE）。
                // 生产进程由 tao 在主线程调用 OleInitialize，所以真实环境可用。
                let hr = unsafe { OleInitialize(None) };
                Self { uninit: hr.is_ok() }
            }
        }

        impl Drop for ComGuard {
            fn drop(&mut self) {
                if self.uninit {
                    unsafe { OleUninitialize() };
                }
            }
        }

        struct TempDir(PathBuf);

        impl TempDir {
            fn new() -> Self {
                let dir =
                    std::env::temp_dir().join(format!("taskdock-ole-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&dir).unwrap();
                Self(dir)
            }

            fn path(&self) -> &std::path::Path {
                &self.0
            }
        }

        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn 受控_ole_git_可创建() {
            let _com = ComGuard::new();
            // 这一条直接钉住 CLSID_StdGlobalInterfaceTable。写成错误值
            // （例如 0000033C）时 CoCreateInstance 返回 E_NOINTERFACE，
            // git() 恒为 None，所有虚拟文件都会读失败且没有明确诊断。
            assert!(
                super::super::git().is_some(),
                "GIT 创建失败：虚拟文件流无法跨线程读取"
            );
        }

        #[test]
        fn 受控_ole_纯文本被识别为文本() {
            let _com = ComGuard::new();
            let obj = src::text("来自网页的一段文本");
            let facts = probe_facts(&obj, ProbeDepth::Full);
            assert_eq!(facts.text.as_deref(), Some("来自网页的一段文本"));
            match classify(&facts) {
                Classification::Text(text) => assert_eq!(text, "来自网页的一段文本"),
                other => panic!("分类错误: {other:?}"),
            }
        }

        #[test]
        fn 受控_ole_html_提取纯文本与图片地址() {
            let _com = ComGuard::new();
            let obj = src::html(r#"<b>你好</b><img src="https://example.com/a.png">"#);
            let facts = probe_facts(&obj, ProbeDepth::Full);
            match classify(&facts) {
                Classification::Html { text, image_url } => {
                    assert!(text.contains("你好"), "{text}");
                    assert_eq!(image_url.as_deref(), Some("https://example.com/a.png"));
                }
                other => panic!("分类错误: {other:?}"),
            }
        }

        #[test]
        fn 受控_ole_png_字节被解码并重新编码() {
            let _com = ComGuard::new();
            let rgba = vec![
                255u8, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
            ];
            let png = crate::clipboard::image::encode_png(&rgba, 2, 2).expect("encode png");
            let obj = src::png(png);
            let facts = probe_facts(&obj, ProbeDepth::Full);
            assert!(facts.has_png_bytes);
            assert!(matches!(
                classify(&facts),
                Classification::Image(ImageSource::Png)
            ));
            let (bytes, w, h) = read_image(&obj, ImageSource::Png).expect("read png");
            assert_eq!((w, h), (2, 2));
            assert!(bytes.starts_with(&[0x89, b'P', b'N', b'G']));
        }

        #[test]
        fn 受控_ole_虚拟文件流写盘并清洗路径() {
            let _com = ComGuard::new();
            let obj = src::virtual_files(&[
                ("..\\..\\evil.txt".to_string(), b"evil-content".to_vec()),
                ("normal.pdf".to_string(), b"%PDF-1.4".to_vec()),
            ]);
            let facts = probe_facts(&obj, ProbeDepth::Full);
            assert_eq!(facts.file_descriptor_count, 2);
            assert!(matches!(
                classify(&facts),
                Classification::VirtualFiles { count: 2 }
            ));

            let dir = TempDir::new();
            let mut pending = Vec::new();
            let mut failures = Vec::new();
            let mut skipped = 0usize;
            collect_virtual(
                &obj,
                2,
                dir.path(),
                &mut pending,
                &mut failures,
                &mut skipped,
            );
            assert_eq!(pending.len(), 2, "failures={failures:?}");

            let mut staged: Vec<(String, u64, Vec<u8>)> = Vec::new();
            for (i, p) in pending.into_iter().enumerate() {
                match p {
                    Pending::Stream {
                        name,
                        declared,
                        cookie,
                    } => {
                        let (path, size) = read_stream_to_file(
                            dir.path(),
                            &format!("{:02}-{name}", i + 1),
                            declared,
                            cookie,
                            MAX_VIRTUAL_TOTAL_BYTES,
                        )
                        .expect("流的真实读取");
                        let content = std::fs::read(&path).unwrap();
                        assert_eq!(content.len() as u64, size);
                        staged.push((name, size, content));
                    }
                    _ => panic!("虚拟文件必须是流"),
                }
            }
            assert_eq!(staged[0].0, "evil.txt", "路径分隔与上跳必须被清洗");
            assert_eq!(staged[0].2, b"evil-content");
            assert_eq!(staged[1].0, "normal.pdf");
            assert_eq!(staged[1].2, b"%PDF-1.4");
            assert!(staged
                .iter()
                .all(|(n, ..)| !n.contains("..") && !n.contains('\\') && !n.contains('/')));
        }

        #[test]
        fn 受控_ole_描述符缓冲区大于上限时只读头部() {
            let _com = ComGuard::new();
            // 真实来源常把 HGLOBAL 分配得比 4 + 620×N 更大（尾部填充）。
            let obj = src::virtual_files_padded(
                &[("padded.bin".to_string(), vec![1, 2, 3])],
                8192,
            );
            let facts = probe_facts(&obj, ProbeDepth::Full);
            assert_eq!(facts.file_descriptor_count, 1, "必须只读头部而不是整块放弃");
            assert!(matches!(
                classify(&facts),
                Classification::VirtualFiles { count: 1 }
            ));
        }

        #[test]
        fn 受控_ole_错误_tymed_不被当作内容() {
            let _com = ComGuard::new();
            let obj = src::text_with_wrong_tymed("不应被读取");
            let facts = probe_facts(&obj, ProbeDepth::Full);
            // 关键结论是「没有崩溃」：返回的 medium 声称 ISTREAM，
            // 生产代码若直接读 u.hGlobal 会解引用无效指针。
            assert!(facts.text.is_none(), "错误 TYMED 不得被当成 HGLOBAL");
        }

        #[test]
        fn 受控_ole_filecontents_返回_hglobal_时失败而非崩溃() {
            let _com = ComGuard::new();
            let obj = src::virtual_files_wrong_tymed("a.txt");
            let dir = TempDir::new();
            let mut pending = Vec::new();
            let mut failures = Vec::new();
            let mut skipped = 0usize;
            collect_virtual(
                &obj,
                1,
                dir.path(),
                &mut pending,
                &mut failures,
                &mut skipped,
            );
            assert!(pending.is_empty(), "错误 TYMED 不能进入流读取");
            assert_eq!(failures.len(), 1);
            assert_eq!(
                failures[0].code,
                codes::DRAG_VIRTUAL_FILE_READ_FAILED,
                "失败必须有稳定错误码"
            );
        }

        #[test]
        fn 受控_ole_流读取超过本批额度时中止并清理() {
            let _com = ComGuard::new();
            let obj = src::virtual_files(&[("big.bin".to_string(), vec![7u8; 10])]);
            let dir = TempDir::new();
            let mut pending = Vec::new();
            let mut failures = Vec::new();
            let mut skipped = 0usize;
            collect_virtual(
                &obj,
                1,
                dir.path(),
                &mut pending,
                &mut failures,
                &mut skipped,
            );
            let Pending::Stream {
                declared, cookie, ..
            } = pending.remove(0)
            else {
                panic!("期望流");
            };
            let err = read_stream_to_file(dir.path(), "01-big.bin", declared, cookie, 4)
                .expect_err("超过本批额度必须失败");
            assert_eq!(err, codes::DRAG_SIZE_LIMIT_EXCEEDED);
            assert!(!dir.path().join("01-big.bin").exists(), "不得留下半成品");
            let leftovers: Vec<_> = std::fs::read_dir(dir.path())
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().contains("taskdock-part"))
                .collect();
            assert!(leftovers.is_empty(), "不得残留 .part");
        }
    }
}

