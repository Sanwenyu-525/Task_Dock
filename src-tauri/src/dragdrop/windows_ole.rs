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
//!   OLE 每个窗口只允许一个 drop target，接管必须先 `RevokeDragDrop` 再
//!   `RegisterDragDrop`，因此**注册失败的窗口无法自动恢复 wry 的处理器**：
//!   这是平台限制（OLE 没有取回旧处理器的 API），不是 fail-safe。实现会重试一次、
//!   如实计数、写 `DRAG_NATIVE_BRIDGE_PARTIAL`/`DRAG_NATIVE_BRIDGE_FAILED` 诊断，
//!   并保留撤销失败的接口对象不释放；
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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget};
use windows::core::{implement, Interface, Ref, BOOL, GUID, PCWSTR};
use windows::Win32::Foundation::{DV_E_FORMATETC, DV_E_LINDEX, HWND, LPARAM, POINT, POINTL};
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
use crate::dragdrop::virtual_files::{
    parse_file_group_descriptor_w, DescError, FILEDESCRIPTORW_LEN,
};
use crate::dragdrop::{
    DragDropState, StagedItem, StagedKind, EVENT_ACCEPTED, EVENT_PAYLOAD, EVENT_PROBE,
    MAX_HTML_BYTES, MAX_IMAGE_BYTES, MAX_ITEMS, MAX_MEMORY_CONTENT_BYTES,
    MAX_MEMORY_TOTAL_BYTES, MAX_TEXT_BYTES, MAX_VIRTUAL_FILE_BYTES, MAX_VIRTUAL_TOTAL_BYTES,
    OVER_THROTTLE,
};

// ── 全局状态 ───────────────────────────────────────────────

/// 登记成功注册的窗口数（>0 表示原生桥生效）。
static INSTALLED: AtomicUsize = AtomicUsize::new(0);
/// 注册失败的窗口数（顶层与子窗口合计）。
///
/// 单独计数而不并入 `INSTALLED`：顶层成功、WebView 子窗口失败时桥仍然
/// `active`，但鼠标下命中的窗口可能仍由 wry 的路径处理器接管——必须让
/// 状态与诊断如实暴露「部分接管」。
static FAILED: AtomicUsize = AtomicUsize::new(0);

// 已注册的 `IDropTarget` 必须活到卸载/进程退出：COM 只持有裸接口指针。
// 用 thread_local 而不是 static：安装/卸载只发生在主线程，也避免把
// 非 Send 的 COM 指针放进全局表。
//
// 句柄与接口成对保存：撤销成功才释放接口；撤销失败（窗口已销毁/句柄异常）
// 时保留对象，绝不制造悬空指针。
thread_local! {
    static TARGETS: RefCell<Vec<(HWND, IDropTarget)>> = const { RefCell::new(Vec::new()) };
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

/// 注册失败的窗口数（`installed_windows() > 0 && failed_windows() > 0` 即部分接管）。
pub fn failed_windows() -> usize {
    FAILED.load(Ordering::SeqCst)
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

/// 安装结果：**分别**记录真实接管情况。
///
/// 只返回「装了几个窗口」不够：顶层成功、WebView 子窗口全失败时，鼠标下命中的
/// 仍是 wry 的路径专用处理器。失败数必须单独暴露，不能把「部分接管」说成成功。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct InstallReport {
    pub total: usize,
    pub installed: usize,
    pub failed: usize,
    /// 首次注册失败、重试后成功的窗口数。
    pub recovered: usize,
    /// 顶层窗口是否被本桥接管。
    pub top_level_ok: bool,
}

impl InstallReport {
    /// 部分接管：有窗口成功、也有窗口失败。
    pub fn partial(&self) -> bool {
        self.installed > 0 && self.failed > 0
    }
}

/// 一个待接管的窗口。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TargetSlot {
    hwnd: HWND,
    top_level: bool,
}

/// 顶层窗口 + 全部子窗口（顶层在首位）。
///
/// WebView2 会在导航/加载过程中创建子窗口，所以每次安装都重新枚举，
/// 不使用缓存。
fn collect_targets(hwnd: HWND) -> Vec<TargetSlot> {
    let mut slots = vec![TargetSlot {
        hwnd,
        top_level: true,
    }];
    let mut collected: Vec<HWND> = Vec::new();
    unsafe {
        let ptr = &mut collected as *mut Vec<HWND>;
        let _ = EnumChildWindows(Some(hwnd), Some(enum_child), LPARAM(ptr as isize));
    }
    for child in collected {
        if child == hwnd {
            continue;
        }
        slots.push(TargetSlot {
            hwnd: child,
            top_level: false,
        });
    }
    slots
}

/// 逐槽注册（纯逻辑，注册动作由调用方注入，便于测试失败分支）。
///
/// 失败后重试一次：真实环境里最常见的失败是「刚撤销/刚创建」的时序竞争。
/// 重试仍失败则如实计入 `failed`——绝不把失败窗口算进 `installed`。
/// OLE 没有「取回上一个处理器」的 API，因此撤销后无法恢复 wry 的对象；
/// 这一点是平台限制，只能在报告与诊断中如实说明，不能声称 fail-safe。
fn install_slots(
    slots: &[TargetSlot],
    mut register: impl FnMut(&TargetSlot) -> Result<(), String>,
) -> (InstallReport, Option<String>) {
    let mut report = InstallReport {
        total: slots.len(),
        ..Default::default()
    };
    let mut last_error: Option<String> = None;
    for slot in slots {
        match register(slot) {
            Ok(()) => {
                report.installed += 1;
                if slot.top_level {
                    report.top_level_ok = true;
                }
            }
            Err(_first) => match register(slot) {
                Ok(()) => {
                    report.installed += 1;
                    report.recovered += 1;
                    if slot.top_level {
                        report.top_level_ok = true;
                    }
                }
                Err(second) => {
                    report.failed += 1;
                    last_error = Some(second);
                }
            },
        }
    }
    (report, last_error)
}

/// 安装原生接收桥：接管顶层窗口与全部子窗口的 `IDropTarget`。
///
/// 返回逐窗口的真实接管结果。全部失败时把桥状态还原为「未安装」并返回错误；
/// 部分失败时桥仍然可用，但会写一条 `DRAG_NATIVE_BRIDGE_PARTIAL` 诊断并暴露
/// 失败窗口数。
///
/// **平台限制**：接管必须先撤销原处理器，注册失败的窗口无法恢复 wry 的处理器
/// （OLE 没有取回 API）。因此这里不声称 fail-safe，只保证：重试一次、如实计数、
/// 不把失败窗口算作成功、不释放撤销失败的接口对象。
///
/// 重复安装是安全的：先撤销上一次的注册（OLE 每窗口只允许一个 drop target）。
pub fn install(
    app: &AppHandle,
    label: &str,
    hwnd: isize,
    state: Arc<DragDropState>,
) -> Result<InstallReport, String> {
    let hwnd = HWND(hwnd as *mut core::ffi::c_void);
    // 重复安装：先撤干净，否则 RegisterDragDrop 会因为已有处理器而全部失败。
    uninstall_registered();
    {
        let mut guard = BRIDGE.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(Bridge {
            app: app.clone(),
            label: label.to_string(),
            state,
            hwnd_raw: hwnd.0 as isize,
        });
    }

    let slots = collect_targets(hwnd);
    let mut registered: Vec<(HWND, IDropTarget)> = Vec::new();
    let (report, last_error) = install_slots(&slots, |slot| {
        let target: IDropTarget = BridgeTarget.into();
        // 撤销 wry 或其他组件的处理器；撤销失败说明本来就没注册，继续即可。
        let revoked = unsafe { RevokeDragDrop(slot.hwnd) };
        match unsafe { RegisterDragDrop(slot.hwnd, &target) } {
            Ok(()) => {
                registered.push((slot.hwnd, target));
                // 不记录 HWND：句柄属于运行时身份，匿名诊断只需层级与计数。
                tracing::debug!(
                    top_level = slot.top_level,
                    revoked = revoked.is_ok(),
                    "拖入接收已挂接"
                );
                Ok(())
            }
            Err(e) => Err(format!("{e}")),
        }
    });

    INSTALLED.store(report.installed, Ordering::SeqCst);
    FAILED.store(report.failed, Ordering::SeqCst);
    if report.installed == 0 {
        *BRIDGE.lock().unwrap_or_else(|e| e.into_inner()) = None;
        return Err(last_error.unwrap_or_else(|| "没有可注册的窗口".into()));
    }
    TARGETS.with(|list| list.borrow_mut().extend(registered));
    if report.partial() {
        report_install_partial(&report);
    }
    Ok(report)
}

/// 撤销本进程登记过的全部拖入接管（只在安装线程/主线程调用）。
///
/// 幂等：列表里的项撤销成功后即被移除；撤销失败的项保留，避免在可能仍被
/// COM 引用的窗口上释放接口。`uninstall_registered` 不会触碰 `BRIDGE`，
/// 供 `install` 的重复安装复用。
fn uninstall_registered() {
    TARGETS.with(|list| {
        let mut list = list.borrow_mut();
        // retain 的谓词返回 true 表示「保留」：只有撤销失败才保留。
        list.retain(|(hwnd, _)| unsafe { RevokeDragDrop(*hwnd) }.is_err());
    });
    INSTALLED.store(0, Ordering::SeqCst);
    FAILED.store(0, Ordering::SeqCst);
}

/// 窗口销毁/程序退出时解除接管。
///
/// 关闭程序本身会由系统回收注册；这里显式撤销是为了「窗口销毁后在进程内
/// 重建」的场景不留下指向已销毁窗口的注册。对已销毁句柄调用只会返回
/// `DRAGDROP_E_INVALIDHWND`，不会崩溃。
pub fn uninstall() {
    uninstall_registered();
    *BRIDGE.lock().unwrap_or_else(|e| e.into_inner()) = None;
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
    let has_w_descriptor = formats
        .iter()
        .any(|(_, n)| n.eq_ignore_ascii_case("FileGroupDescriptorW"));
    let has_ansi_descriptor = formats
        .iter()
        .any(|(_, n)| n.eq_ignore_ascii_case("FileGroupDescriptor"));
    if has_w_descriptor || has_ansi_descriptor {
        facts.file_descriptor_count = read_descriptor_count(obj, &formats);
        facts.has_ansi_file_descriptor = has_ansi_descriptor && !has_w_descriptor;
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

/// `TYMED_HGLOBAL` 读取失败的分类。
///
/// 调用方要据此给出**准确**的错误码：拿不到索引（`Unavailable`）与
/// 内容超限（`TooLarge`）对用户是两件不同的事。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HgError {
    /// 来源没有提供该格式/索引（`DV_E_FORMATETC`）。
    Unavailable,
    /// 来源返回的 TYMED 与请求不符；不能安全释放，直接拒绝。
    WrongTymed,
    /// 数据超过调用方给定的内存上限。
    TooLarge,
    /// 内容为空或无法锁定。
    Empty,
    /// `GetData` 失败于「格式/索引之外」的原因（OOM、存储错误等）。
    Failed,
}

/// `GetData` 是否在说「没有这个格式/索引」。
///
/// `DV_E_LINDEX` 也是同一语义：来源有该格式但没有这个序号。其它错误
/// （如 `E_OUTOFMEMORY`）必须按读取失败处理，不能误报成「来源缺索引」。
fn is_missing_format(code: windows::core::HRESULT) -> bool {
    code == DV_E_FORMATETC || code == DV_E_LINDEX
}

/// 读一个 `TYMED_HGLOBAL` 格式的原始字节；超过 `cap` 直接放弃（不截断，
/// 截断的图片/文件比没有更危险）。
fn read_hglobal(obj: &IDataObject, cf: u16, cap: usize) -> Option<Vec<u8>> {
    // 普通格式（文本/HTML/图片）的 `lindex` 固定为 -1：它不是多条目格式。
    unsafe { read_hglobal_index(obj, cf, -1, cap).ok() }
}

/// 带索引的 `TYMED_HGLOBAL` 读取。
///
/// `FileContents` 是**多条目格式**：`FORMATETC.lindex` 就是虚拟文件在
/// `FileGroupDescriptorW` 里的序号。用 `-1` 去要第 N 个文件会拿到
/// `DV_E_FORMATETC`（或来源的「全部内容」），因此回退路径必须与流路径使用
/// **同一个** `index`。
unsafe fn read_hglobal_index(
    obj: &IDataObject,
    cf: u16,
    index: i32,
    cap: usize,
) -> Result<Vec<u8>, HgError> {
    let fmt = FORMATETC {
        cfFormat: cf,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: index,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let mut medium = match obj.GetData(&fmt) {
        Ok(m) => m,
        // 来源没提供这个格式/索引是正常情况；其它错误是真正的读取失败。
        Err(e) if is_missing_format(e.code()) => return Err(HgError::Unavailable),
        Err(_) => return Err(HgError::Failed),
    };
    // `GetData` 成功不等于返回的就是请求的 TYMED：OLE 允许来源忽略请求
    // （个别邮件客户端/浏览器扩展会这么做）。此时 `u` 联合体里不是 HGLOBAL，
    // 直接读等同于拿句柄当内存指针——必须先核对。
    //
    // 核对失败时**不能**调用 `ReleaseStgMedium`：它按 `medium.tymed` 释放，
    // 而类型可能被来源谎报，释放动作本身就可能解引用错误指针并崩溃
    // （实测：把 HGLOBAL 谎报成 ISTREAM 会在 ReleaseStgMedium 里 AV）。
    // 这里选择拒绝并泄漏这一个异常 medium：拖入回调崩溃的代价远大于一次泄漏，
    // 且这类来源本身违反 OLE 契约。
    if medium.tymed != TYMED_HGLOBAL.0 as u32 {
        return Err(HgError::WrongTymed);
    }
    let h = medium.u.hGlobal;
    let size = GlobalSize(h);
    if size == 0 {
        ReleaseStgMedium(&mut medium);
        return Err(HgError::Empty);
    }
    if size > cap {
        ReleaseStgMedium(&mut medium);
        return Err(HgError::TooLarge);
    }
    let ptr = GlobalLock(h);
    if ptr.is_null() {
        ReleaseStgMedium(&mut medium);
        return Err(HgError::Empty);
    }
    let out = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
    let _ = GlobalUnlock(h);
    ReleaseStgMedium(&mut medium);
    if out.is_empty() {
        Err(HgError::Empty)
    } else {
        Ok(out)
    }
}

/// 同 [`read_hglobal`]，但只取前 `cap` 字节（允许来源分配得比实际数据大）。
///
/// 只给「读头部即可判定」的结构使用：`FileGroupDescriptorW` 的缓冲区大小由
/// 来源决定，常见实现会一次分配整块内存（4 + 592×N）或对齐到更大容量；
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
///
/// 只读 4 字节数量头：`DragOver` 每次都会走到这里，没必要为计数复制整组描述符
/// （完整缓冲区由 `collect_virtual` 在 Drop 阶段按 `4 + 592×N` 读取）。
fn read_descriptor_count(obj: &IDataObject, formats: &[(u16, String)]) -> usize {
    let Some(id) = formats
        .iter()
        .find(|(_, n)| n.eq_ignore_ascii_case("FileGroupDescriptorW"))
        .map(|(id, _)| *id)
    else {
        return 0;
    };
    match read_hglobal_prefix(obj, id, 4) {
        Some(raw) if raw.len() >= 4 => {
            // 只用于提示的计数：恶意/损坏头可能给出 u32::MAX，先按项目上限收敛，
            // 避免进入/悬停时界面出现荒谬数字；Drop 阶段仍会按 TooMany 明确拒绝。
            (u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize).min(MAX_ITEMS)
        }
        _ => 0,
    }
}

/// 图片 HGLOBAL 读取失败 → 稳定码。
///
/// 旧实现把所有失败都映射成 `DRAG_SIZE_LIMIT_EXCEEDED`：来源返回空块/TYMED
/// 违约时，用户会看到「超过大小上限」这种错误解释。现在按原因区分。
fn image_read_error(error: HgError) -> &'static str {
    match error {
        HgError::TooLarge => codes::DRAG_SIZE_LIMIT_EXCEEDED,
        HgError::WrongTymed => codes::DRAG_PAYLOAD_INVALID,
        HgError::Unavailable | HgError::Empty | HgError::Failed => {
            codes::DRAG_NO_READABLE_CONTENT
        }
    }
}

/// 读图片格式（`lindex=-1`）并保留失败原因。
fn read_image_hglobal(obj: &IDataObject, cf: u16, cap: usize) -> Result<Vec<u8>, HgError> {
    unsafe { read_hglobal_index(obj, cf, -1, cap) }
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
            let raw = read_image_hglobal(obj, id as u16, MAX_IMAGE_BYTES as usize)
                .map_err(image_read_error)?;
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
            // DIBV5 优先（带 alpha），退回 CF_DIB。第一个格式不可用时才尝试第二个；
            // 两个都失败时保留第二个（更通用）的准确原因。
            let raw = match read_image_hglobal(obj, 17, MAX_IMAGE_BYTES as usize) {
                Ok(raw) => raw,
                Err(_) => read_image_hglobal(obj, 8, MAX_IMAGE_BYTES as usize)
                    .map_err(image_read_error)?,
            };
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
    let Some(raw) = read_hglobal_prefix(obj, fd_id as u16, 4 + MAX_ITEMS * FILEDESCRIPTORW_LEN)
    else {
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
            // 整组都不可用：按数量头计入 skipped（不是只算 1 项），部分成功报告才准确。
            *skipped += expected.max(1);
            failures.push(PayloadFailure {
                code: match e {
                    DescError::TooMany => codes::DRAG_TOO_MANY_ITEMS,
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

    // 内存块不能流式写盘，必须在 `Drop` 回调里整块复制：除单条上限外还要有
    // 本批总量预算，否则 32 条 × 64MB 会让主线程一次持有 2GB。
    let mut memory_total: u64 = 0;
    for desc in &group.files {
        // 索引必须来自**原始描述符序号**：空名/目录/超限条目被跳过后，
        // `group.files` 的下标会前移，用过滤后下标会读错文件内容。
        match obtain_content(obj, fc_id as u16, desc.original_index as i32) {
            Ok(Content::Stream(cookie)) => pending.push(Pending::Stream {
                name: desc.name.clone(),
                declared: desc.size,
                cookie,
            }),
            Ok(Content::Bytes(mut bytes)) => {
                // 描述符声明的长度是上界：HGLOBAL 的块大小可能带尾部填充。
                if let Some(declared) = desc.size {
                    if bytes.len() as u64 > declared {
                        bytes.truncate(declared as usize);
                    }
                }
                if exceeds_memory_budget(memory_total, bytes.len() as u64) {
                    *skipped += 1;
                    failures.push(PayloadFailure {
                        code: codes::DRAG_MEMORY_CONTENT_TOO_LARGE.into(),
                        scope: "virtual-file".into(),
                        format: Some(desc.name.clone()),
                        reason: format!(
                            "{}（单次内存数据总量上限 {} MB）",
                            codes::message(codes::DRAG_MEMORY_CONTENT_TOO_LARGE),
                            MAX_MEMORY_TOTAL_BYTES / (1024 * 1024)
                        ),
                    });
                    continue;
                }
                memory_total = memory_total.saturating_add(bytes.len() as u64);
                pending.push(Pending::Bytes {
                    name: desc.name.clone(),
                    bytes,
                    kind: StagedKind::VirtualFile,
                    mime: mime_for(&desc.name),
                    width: None,
                    height: None,
                });
            }
            Err(e) => {
                *skipped += 1;
                let code = e.code();
                let reason = match e {
                    ContentError::IndexUnavailable => {
                        // 序号只是计数，不是内容，可以安全写进诊断。
                        // 用**原始**序号，用户/日志才能对应来源里的第几项。
                        format!(
                            "{}（第 {} 项）",
                            codes::message(code),
                            desc.original_index + 1
                        )
                    }
                    ContentError::TooLargeForMemory => format!(
                        "{}（{} MB）",
                        codes::message(code),
                        MAX_MEMORY_CONTENT_BYTES / (1024 * 1024)
                    ),
                    ContentError::ReadFailed => codes::message(code).into(),
                };
                failures.push(PayloadFailure {
                    code: code.to_string(),
                    scope: "virtual-file".into(),
                    format: Some(desc.name.clone()),
                    reason,
                });
            }
        }
    }
}

/// 单次拖入的内存数据总量预算（纯函数，便于单测）。
fn exceeds_memory_budget(total: u64, next: u64) -> bool {
    total.saturating_add(next) > MAX_MEMORY_TOTAL_BYTES
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

/// 内容获取失败的原因（映射到稳定错误码，便于诊断与用户反馈）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContentError {
    /// 描述符声明了这一项，但 `FileContents` 给不出该索引（lindex 不匹配/缺失）。
    IndexUnavailable,
    /// 来源只提供内存块，且超过安全读取上限。
    TooLargeForMemory,
    /// 读取失败（空内容、GIT 注册失败、TYMED 违约等）。
    ReadFailed,
}

impl ContentError {
    fn code(self) -> &'static str {
        match self {
            ContentError::IndexUnavailable => codes::DRAG_VIRTUAL_INDEX_INVALID,
            ContentError::TooLargeForMemory => codes::DRAG_MEMORY_CONTENT_TOO_LARGE,
            ContentError::ReadFailed => codes::DRAG_VIRTUAL_FILE_READ_FAILED,
        }
    }
}

/// `GetData(FileContents, lindex=i)`：优先 `TYMED_ISTREAM`，退回 `TYMED_HGLOBAL`。
/// **必须在 `Drop` 调用内执行**（OLE 契约）。
///
/// 两条路径都用**同一个 `index`**：`lindex` 是虚拟文件的序号，`-1`（旧实现
/// 的回退值）在多文件来源里拿不到第 i 个文件。
fn obtain_content(obj: &IDataObject, cf: u16, index: i32) -> Result<Content, ContentError> {
    let stream_fmt = FORMATETC {
        cfFormat: cf,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: index,
        tymed: TYMED_ISTREAM.0 as u32,
    };
    unsafe {
        match obj.GetData(&stream_fmt) {
            Ok(mut medium) => {
                let tymed = medium.tymed;
                if tymed == TYMED_ISTREAM.0 as u32 && medium.u.pstm.is_some() {
                    // `STGMEDIUM_0.pstm` 是 `ManuallyDrop<Option<IStream>>`：clone 会 AddRef，
                    // 于是我们持有一份独立引用；ReleaseStgMedium 释放的是 medium 自己那份。
                    let held: Option<IStream> = (*medium.u.pstm).clone();
                    let registered = held.as_ref().and_then(register_stream);
                    drop(held);
                    ReleaseStgMedium(&mut medium);
                    return match registered {
                        Some(cookie) => Ok(Content::Stream(cookie)),
                        None => Err(ContentError::ReadFailed),
                    };
                }
                if tymed == TYMED_HGLOBAL.0 as u32 {
                    // 来源无视了 TYMED 请求，但**如实**返回了 HGLOBAL：
                    // 内容确实在内存块里，按同一个索引读出来即可（不是错误）。
                    let bytes = take_hglobal_bytes(medium, MAX_MEMORY_CONTENT_BYTES as usize)?;
                    return Ok(Content::Bytes(bytes));
                }
                // 谎报/其它类型：**不**调用 ReleaseStgMedium（见 read_hglobal_index 注释），
                // 拒绝并放弃这一个 medium。
                //
                // 已知残余风险：如果来源把 HGLOBAL 谎报成 TYMED_ISTREAM 并给出非空
                // `pstm`，这里无法安全识别——校验 `pstm` 是否为真接口指针只能靠
                // 调用它（AddRef），而对假指针调用就已经 AV。OLE 没有可靠的
                // 「这个指针是不是接口」API，因此 ISTREAM 分支**依赖来源遵守契约**；
                // 只支持内存块的正常来源会返回 `tymed=HGLOBAL`（已正确处理）。
                // 见 report.md「D. 剩余风险」。
                return Err(ContentError::ReadFailed);
            }
            // 流不可用：退回内存块。只有「流」与「内存块」都说格式/索引不存在，
            // 才能确定是 lindex 不匹配（而不是读取失败）。
            Err(e) => fallback_to_hglobal(obj, cf, index, is_missing_format(e.code())),
        }
    }
}

/// 流路径不可用时的内存块回退：**必须沿用同一个 `lindex`**。
fn fallback_to_hglobal(
    obj: &IDataObject,
    cf: u16,
    index: i32,
    stream_unavailable: bool,
) -> Result<Content, ContentError> {
    match unsafe { read_hglobal_index(obj, cf, index, MAX_MEMORY_CONTENT_BYTES as usize) } {
        Ok(bytes) => Ok(Content::Bytes(bytes)),
        Err(HgError::TooLarge) => Err(ContentError::TooLargeForMemory),
        Err(HgError::Unavailable) if stream_unavailable => Err(ContentError::IndexUnavailable),
        Err(_) => Err(ContentError::ReadFailed),
    }
}

/// 从一个**已核对**为 `TYMED_HGLOBAL` 的 medium 里复制字节并释放它。
///
/// 调用方保证 `medium.tymed == TYMED_HGLOBAL`：只有这种情形下
/// `ReleaseStgMedium` 才是安全的。
unsafe fn take_hglobal_bytes(
    mut medium: windows::Win32::System::Com::STGMEDIUM,
    cap: usize,
) -> Result<Vec<u8>, ContentError> {
    let h = medium.u.hGlobal;
    let size = GlobalSize(h);
    if size == 0 {
        ReleaseStgMedium(&mut medium);
        return Err(ContentError::ReadFailed);
    }
    if size > cap {
        ReleaseStgMedium(&mut medium);
        return Err(ContentError::TooLargeForMemory);
    }
    let ptr = GlobalLock(h);
    if ptr.is_null() {
        ReleaseStgMedium(&mut medium);
        return Err(ContentError::ReadFailed);
    }
    let out = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
    let _ = GlobalUnlock(h);
    ReleaseStgMedium(&mut medium);
    if out.is_empty() {
        Err(ContentError::ReadFailed)
    } else {
        Ok(out)
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

/// 撤销一个未消费的 GIT cookie（取消 / 会话被放弃时必须调用）。
fn revoke_cookie(cookie: u32) {
    if let Some(git) = git() {
        let _ = unsafe { git.RevokeInterfaceFromGlobal(cookie) };
    }
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
            // `SendError` 会把 job 原样退回：同步执行，绝不丢掉用户拖入的内容，
            // 也避免流 cookie 无人消费而泄漏在 GIT 里。
            tracing::warn!("拖入暂存任务投递失败，同步兜底: {e}");
            drop(guard);
            run_job(e.0);
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

    stage_pending(&op, &mut items, pending, &mut failures);

    // 会话在读取期间被放弃/淘汰/提交：不再收尾、不再发事件。
    // 还要再删一次目录：`open_part` / `write_bytes` 都会 `ensure_dir`，
    // 若取消发生在写盘中途，目录可能已经被重新建出来。
    if op.released() {
        stage::remove_dir(&op.dir);
        return;
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

/// 把内存条目/流写入暂存目录，返回**实际写入总量**。
///
/// 每次写盘前核对会话是否已被释放：`discard` / TTL 回收 / 上限淘汰 / 提交
/// 都会置位取消标记。旧实现不核对，`ensure_dir` 会把刚被删掉的暂存目录
/// 重新建出来，留下永远没人认领的副本。
fn stage_pending(
    op: &crate::dragdrop::StagedOp,
    items: &mut Vec<StagedItem>,
    pending: Vec<Pending>,
    failures: &mut Vec<PayloadFailure>,
) -> u64 {
    let mut seq = 0usize;
    // 单条上限之外还必须有**实际写入总量**上限：描述符里的声明大小由来源填写，
    // 可以谎报（例如声称 1KB、流里给 1GB）。只校验声明值等于把磁盘交给对方。
    let mut staged_total: u64 = 0;
    for p in pending {
        if op.released() {
            // 已登记进 GIT 的流必须撤销，否则接口会一直挂在全局表里。
            // 用 `continue` 而不是 `break`：同一批里可能还有多个 cookie 要回收。
            if let Pending::Stream { cookie, .. } = p {
                revoke_cookie(cookie);
            }
            continue;
        }
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
                    // 不读取也必须撤销 cookie，否则这一条流会一直挂在 GIT 里。
                    revoke_cookie(cookie);
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
                    &op.consumed,
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
    staged_total
}

/// 从 GIT 取回流并流式写入暂存文件（64KB 一块，超过上限立即中止并清理）。
fn read_stream_to_file(
    dir: &Path,
    name: &str,
    declared: Option<u64>,
    cookie: u32,
    hard_cap: u64,
    // 会话取消标记：`discard`/TTL/淘汰/提交会置位，读到一半也要立即停下并删 `.part`。
    cancel: &AtomicBool,
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
    // cookie 已撤销、stream 即将释放；已经取消就直接返回，不创建任何临时文件。
    if cancel.load(Ordering::SeqCst) {
        return Err(codes::DRAG_OPERATION_EXPIRED);
    }

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
        // 每块都核对：一个 2GB 的流读几分钟，用户随时可能关闭面板/放弃。
        if cancel.load(Ordering::SeqCst) {
            stage::drop_part(&part);
            return Err(codes::DRAG_OPERATION_EXPIRED);
        }
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
/// 部分接管时写一条结构化诊断：只含窗口计数，不含句柄与内容。
fn report_install_partial(report: &InstallReport) {
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
        .error_code(codes::DRAG_NATIVE_BRIDGE_PARTIAL)
        .error_category(codes::category(codes::DRAG_NATIVE_BRIDGE_PARTIAL))
        .message("部分窗口未能接管原生拖入接收")
        .metadata("total", serde_json::json!(report.total))
        .metadata("installed", serde_json::json!(report.installed))
        .metadata("failed", serde_json::json!(report.failed))
        .metadata("recovered", serde_json::json!(report.recovered))
        .metadata("topLevelOk", serde_json::json!(report.top_level_ok))
        .build(),
    );
}

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
        use std::sync::Arc;

        use windows::Win32::System::Ole::{OleInitialize, OleUninitialize};

        use crate::dragdrop::classify::Classification;
        use crate::dragdrop::codes;
        use crate::dragdrop::ole_test_source as src;
        use crate::dragdrop::MAX_VIRTUAL_TOTAL_BYTES;
        use crate::dragdrop::MAX_VIRTUAL_FILE_BYTES;
        use crate::dragdrop::MAX_ITEMS;

        use super::super::{
            classify, collect_virtual, probe_facts, read_image, read_stream_to_file, ImageSource,
            PayloadFailure, Pending, ProbeDepth,
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
                            &std::sync::atomic::AtomicBool::new(false),
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
            // 真实来源常把 HGLOBAL 分配得比 4 + 592×N 更大（尾部填充）。
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
        fn 受控_ole_流请求遇到_hglobal_时按内存块回退() {
            let _com = ComGuard::new();
            // 来源无视 TYMED：请求 ISTREAM 却返回 HGLOBAL（medium.tymed 如实为 HGLOBAL）。
            // 这是合法的「只支持内存块」来源，必须按字节读取，不能崩、也不能假装失败。
            let obj = src::virtual_files_wrong_tymed("a.txt");
            let dir = TempDir::new();
            let (staged, failures, _op) = run_staging(&obj, 1, dir.path());
            assert!(failures.is_empty(), "failures={failures:?}");
            assert_eq!(staged.len(), 1);
            assert_eq!(staged[0].0, "a.txt");
            assert_eq!(staged[0].1, b"data");
        }

        #[test]
        fn 受控_ole_空_png_报无内容而不是超限() {
            let _com = ComGuard::new();
            let obj = src::png_empty();
            let err = read_image(&obj, ImageSource::Png).expect_err("空 PNG 不得成功");
            assert_eq!(
                err,
                codes::DRAG_NO_READABLE_CONTENT,
                "空块不是大小超限，错误码必须准确"
            );
        }

        #[test]
        fn 图片读取错误码按原因区分() {
            use super::super::{image_read_error, HgError};
            assert_eq!(
                image_read_error(HgError::TooLarge),
                codes::DRAG_SIZE_LIMIT_EXCEEDED
            );
            assert_eq!(
                image_read_error(HgError::WrongTymed),
                codes::DRAG_PAYLOAD_INVALID
            );
            for error in [HgError::Unavailable, HgError::Empty, HgError::Failed] {
                assert_eq!(image_read_error(error), codes::DRAG_NO_READABLE_CONTENT);
            }
        }

        /// 跑完整链路：`collect_virtual` → `stage_pending`（含 GIT 流读取与清洗）。
        /// 返回 (名字, 落盘内容) 与失败清单。
        fn run_staging(
            obj: &windows::Win32::System::Com::IDataObject,
            expected: usize,
            dir: &std::path::Path,
        ) -> (Vec<(String, Vec<u8>)>, Vec<PayloadFailure>, Arc<crate::dragdrop::StagedOp>) {
            let (staged, failures, op, _) = run_staging_full(obj, expected, dir);
            (staged, failures, op)
        }

        /// 同 [`run_staging`]，额外返回 `skipped`（目录/空名/超限/读失败计数）。
        fn run_staging_full(
            obj: &windows::Win32::System::Com::IDataObject,
            expected: usize,
            dir: &std::path::Path,
        ) -> (
            Vec<(String, Vec<u8>)>,
            Vec<PayloadFailure>,
            Arc<crate::dragdrop::StagedOp>,
            usize,
        ) {
            let view = crate::dragdrop::DragPayloadView::VirtualFiles {
                items: Vec::new(),
                count: expected,
            };
            let probe = crate::dragdrop::DragProbe::from_view(&view, Vec::new());
            let ds = crate::dragdrop::DragDropState::new(dir.to_path_buf());
            let op = ds.begin(probe, None, view);
            let mut pending = Vec::new();
            let mut failures = Vec::new();
            let mut skipped = 0usize;
            collect_virtual(
                obj,
                expected,
                &op.dir,
                &mut pending,
                &mut failures,
                &mut skipped,
            );
            let mut items = Vec::new();
            super::super::stage_pending(&op, &mut items, pending, &mut failures);
            let staged = items
                .iter()
                .filter_map(|item| match item {
                    crate::dragdrop::StagedItem::Staged { path, name, .. } => {
                        Some((name.clone(), std::fs::read(path).expect("落盘内容可读")))
                    }
                    _ => None,
                })
                .collect();
            (staged, failures, op, skipped)
        }

        #[test]
        fn 受控_ole_单虚拟文件_hglobal_回退() {
            let _com = ComGuard::new();
            let obj = src::virtual_files_hglobal(&[("a.bin".to_string(), b"alpha".to_vec())]);
            let dir = TempDir::new();
            let (staged, failures, _op) = run_staging(&obj, 1, dir.path());
            assert!(failures.is_empty(), "failures={failures:?}");
            assert_eq!(staged.len(), 1);
            assert_eq!(staged[0].0, "a.bin");
            assert_eq!(staged[0].1, b"alpha");
        }

        #[test]
        fn 受控_ole_多虚拟文件_hglobal_按索引取对内容() {
            let _com = ComGuard::new();
            let obj = src::virtual_files_hglobal(&[
                ("one.txt".to_string(), b"AAA".to_vec()),
                ("two.txt".to_string(), b"BBBB".to_vec()),
                ("three.txt".to_string(), b"CCCCC".to_vec()),
            ]);
            let dir = TempDir::new();
            let (staged, failures, _op) = run_staging(&obj, 3, dir.path());
            assert!(failures.is_empty(), "failures={failures:?}");
            assert_eq!(staged.len(), 3);
            // 内容与索引必须一一对应：回退时丢掉 lindex 会串内容或直接失败。
            assert_eq!(staged[0], ("one.txt".to_string(), b"AAA".to_vec()));
            assert_eq!(staged[1], ("two.txt".to_string(), b"BBBB".to_vec()));
            assert_eq!(staged[2], ("three.txt".to_string(), b"CCCCC".to_vec()));
        }

        #[test]
        fn 受控_ole_流与内存混合来源各自读取() {
            let _com = ComGuard::new();
            let files = [
                ("stream.txt".to_string(), b"from-stream".to_vec()),
                ("memory.txt".to_string(), b"from-memory".to_vec()),
            ];
            for streams in [[true, false], [false, true]] {
                let obj = src::virtual_files_mixed(&files, &streams);
                let dir = TempDir::new();
                let (staged, failures, _op) = run_staging(&obj, 2, dir.path());
                assert!(failures.is_empty(), "{streams:?} failures={failures:?}");
                assert_eq!(staged[0], ("stream.txt".to_string(), b"from-stream".to_vec()));
                assert_eq!(staged[1], ("memory.txt".to_string(), b"from-memory".to_vec()));
            }
        }

        #[test]
        fn 受控_ole_同时提供流与内存时优先使用流() {
            let _com = ComGuard::new();
            let obj = src::virtual_files_both(b"stream-content", b"global-content");
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
            assert!(failures.is_empty());
            match pending.remove(0) {
                Pending::Stream { cookie, .. } => super::super::revoke_cookie(cookie),
                _ => panic!("必须优先走 IStream，不能退回内存块"),
            }
            // 再跑一次完整链路，确认落盘的是流里的内容。
            let (staged, failures, _op) = run_staging(&obj, 1, dir.path());
            assert!(failures.is_empty());
            assert_eq!(staged[0].1, b"stream-content");
        }

        #[test]
        fn 受控_ole_跳过目录后仍按原始索引读取() {
            let _com = ComGuard::new();
            // 原始第 0 项是目录，但仍给它一份**诱饵内容**；第 1/2 项才是文件。
            // 若实现用过滤后的下标，a.txt 会读到第 0 项的诱饵内容。
            let slots = [
                src::VirtualSlot::directory("folder", b"DIR-DECOY"),
                src::VirtualSlot::file("a.txt", b"A-CONTENT"),
                src::VirtualSlot::file("b.png", b"B-CONTENT"),
            ];
            let obj = src::virtual_files_slots(&slots);
            let dir = TempDir::new();
            let (staged, failures, _op, skipped) = run_staging_full(&obj, 3, dir.path());
            assert!(failures.is_empty(), "failures={failures:?}");
            assert_eq!(skipped, 1, "目录项必须计入 skipped");
            assert_eq!(
                staged,
                vec![
                    ("a.txt".to_string(), b"A-CONTENT".to_vec()),
                    ("b.png".to_string(), b"B-CONTENT".to_vec()),
                ],
                "目录的 FileContents 不得被读成 a.txt"
            );
            assert!(!staged.iter().any(|(_, bytes)| bytes.as_slice() == b"DIR-DECOY"));
        }

        #[test]
        fn 受控_ole_中间超限文件被跳过后后续仍按原始索引() {
            let _com = ComGuard::new();
            let slots = [
                src::VirtualSlot::file("first.txt", b"FIRST"),
                src::VirtualSlot::oversize(
                    "huge.bin",
                    MAX_VIRTUAL_FILE_BYTES + 1,
                    b"OVERSIZE-DECOY",
                ),
                src::VirtualSlot::file("last.txt", b"LAST"),
            ];
            let obj = src::virtual_files_slots(&slots);
            let dir = TempDir::new();
            let (staged, failures, _op, skipped) = run_staging_full(&obj, 3, dir.path());
            assert!(failures.is_empty(), "failures={failures:?}");
            assert_eq!(skipped, 1, "超限项必须计入 skipped");
            assert_eq!(
                staged,
                vec![
                    ("first.txt".to_string(), b"FIRST".to_vec()),
                    ("last.txt".to_string(), b"LAST".to_vec()),
                ],
                "超限项不能串到后续文件，也不能读取它的内容"
            );
            assert!(!staged.iter().any(|(_, bytes)| bytes.as_slice() == b"OVERSIZE-DECOY"));
        }

        #[test]
        fn 受控_ole_连续无效条目后第一个有效项用原始索引() {
            let _com = ComGuard::new();
            let slots = [
                src::VirtualSlot::empty_name(b"EMPTY-DECOY"),
                src::VirtualSlot::directory("folder", b"DIR-DECOY"),
                src::VirtualSlot::file("only.txt", b"ONLY"),
            ];
            let obj = src::virtual_files_slots(&slots);
            let dir = TempDir::new();
            let (staged, failures, _op, skipped) = run_staging_full(&obj, 3, dir.path());
            assert!(failures.is_empty(), "failures={failures:?}");
            assert_eq!(skipped, 2);
            assert_eq!(
                staged,
                vec![("only.txt".to_string(), b"ONLY".to_vec())],
                "第 2 项必须用 lindex=2 读取"
            );
            assert!(!staged
                .iter()
                .any(|(_, bytes)| bytes.as_slice() == b"EMPTY-DECOY"
                    || bytes.as_slice() == b"DIR-DECOY"));
        }

        #[test]
        fn 受控_ole_首个有效项位于原始列表最后() {
            let _com = ComGuard::new();
            let slots = [
                src::VirtualSlot::directory("d0", b"X0"),
                src::VirtualSlot::directory("d1", b"X1"),
                src::VirtualSlot::directory("d2", b"X2"),
                src::VirtualSlot::file("tail.txt", b"TAIL"),
            ];
            let obj = src::virtual_files_slots(&slots);
            let dir = TempDir::new();
            let (staged, failures, _op, skipped) = run_staging_full(&obj, 4, dir.path());
            assert!(failures.is_empty(), "failures={failures:?}");
            assert_eq!(skipped, 3);
            assert_eq!(
                staged,
                vec![("tail.txt".to_string(), b"TAIL".to_vec())],
                "最后一个描述符必须用 lindex=3 读取"
            );
        }

        #[test]
        fn 受控_ole_缺失索引按原始序号报告() {
            let _com = ComGuard::new();
            let slots = [
                src::VirtualSlot::file("ok.txt", b"OK"),
                src::VirtualSlot::missing("missing-1.txt"),
                src::VirtualSlot::missing("missing-2.txt"),
            ];
            let obj = src::virtual_files_slots(&slots);
            let dir = TempDir::new();
            let (staged, failures, _op, skipped) = run_staging_full(&obj, 3, dir.path());
            assert_eq!(staged, vec![("ok.txt".to_string(), b"OK".to_vec())]);
            assert_eq!(skipped, 2);
            assert_eq!(failures.len(), 2);
            assert!(failures
                .iter()
                .all(|f| f.code == codes::DRAG_VIRTUAL_INDEX_INVALID));
            assert!(failures[0].reason.contains("第 2 项"), "{}", failures[0].reason);
            assert!(failures[1].reason.contains("第 3 项"), "{}", failures[1].reason);
        }

        #[test]
        fn 受控_ole_描述符截断不静默丢弃且报准确码() {
            let _com = ComGuard::new();
            // 头部声明 2 项，但只给 1 条 596 字节描述符（真实截断）。
            let mut group = Vec::new();
            group.extend_from_slice(&2u32.to_le_bytes());
            let one = {
                // 用 SDK 结构构造，长度不依赖生产常量。
                let mut fd = windows::Win32::UI::Shell::FILEDESCRIPTORW::default();
                fd.dwFlags = 0x44;
                fd.nFileSizeLow = 3;
                let mut name_units = [0u16; 260];
                for (slot, unit) in name_units
                    .iter_mut()
                    .zip("a.txt".encode_utf16())
                {
                    *slot = unit;
                }
                fd.cFileName = name_units;
                let raw = unsafe {
                    std::slice::from_raw_parts(
                        &fd as *const _ as *const u8,
                        std::mem::size_of::<windows::Win32::UI::Shell::FILEDESCRIPTORW>(),
                    )
                };
                raw.to_vec()
            };
            group.extend_from_slice(&one);
            assert_eq!(one.len(), 592);
            assert_eq!(group.len(), 596);

            let obj = src::virtual_files_raw_group(group);
            let facts = probe_facts(&obj, ProbeDepth::Full);
            // 分类阶段只读数量头：不能因为正文损坏就静默变成「没有虚拟文件」。
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
            assert!(pending.is_empty());
            assert_eq!(skipped, 2, "整组 2 项都不可用，skipped 不能只算 1");
            assert_eq!(failures.len(), 1);
            assert_eq!(failures[0].code, codes::DRAG_PAYLOAD_INVALID);
            assert!(failures[0].reason.contains("不完整"), "{}", failures[0].reason);
        }

        #[test]
        fn 受控_ole_恶意数量在提示层收敛且报条数超限() {
            let _com = ComGuard::new();
            let obj = src::virtual_files_raw_group(u32::MAX.to_le_bytes().to_vec());
            let facts = probe_facts(&obj, ProbeDepth::Full);
            // 提示层不能显示 4294967295，先收敛到项目上限；Drop 阶段再明确拒绝。
            assert_eq!(facts.file_descriptor_count, MAX_ITEMS);

            let dir = TempDir::new();
            let mut pending = Vec::new();
            let mut failures = Vec::new();
            let mut skipped = 0usize;
            collect_virtual(
                &obj,
                facts.file_descriptor_count,
                dir.path(),
                &mut pending,
                &mut failures,
                &mut skipped,
            );
            assert!(pending.is_empty());
            assert_eq!(skipped, MAX_ITEMS);
            assert_eq!(failures.len(), 1);
            assert_eq!(failures[0].code, codes::DRAG_TOO_MANY_ITEMS);
        }

        #[test]
        fn 受控_ole_部分索引缺失时如实报告() {
            let _com = ComGuard::new();
            let files = [
                ("ok.txt".to_string(), b"OK".to_vec()),
                ("missing.txt".to_string(), b"".to_vec()),
            ];
            let obj = src::virtual_files_partial(&files, 1);
            let dir = TempDir::new();
            let (staged, failures, _op) = run_staging(&obj, 2, dir.path());
            assert_eq!(staged.len(), 1, "能读的必须落盘");
            assert_eq!(staged[0], ("ok.txt".to_string(), b"OK".to_vec()));
            assert_eq!(failures.len(), 1, "缺索引的必须如实报告");
            assert_eq!(failures[0].code, codes::DRAG_VIRTUAL_INDEX_INVALID);
            assert_eq!(failures[0].format.as_deref(), Some("missing.txt"));
            assert!(failures[0].reason.contains("第 2 项"), "{}", failures[0].reason);
        }

        #[test]
        fn 受控_ole_空内容明确失败且不残留() {
            let _com = ComGuard::new();
            let obj = src::virtual_files_empty("empty.bin");
            let dir = TempDir::new();
            let (staged, failures, op) = run_staging(&obj, 1, dir.path());
            assert!(staged.is_empty(), "空内容不得被当成成功");
            assert_eq!(failures.len(), 1);
            assert_eq!(failures[0].code, codes::DRAG_VIRTUAL_FILE_READ_FAILED);
            let leftovers = std::fs::read_dir(&op.dir)
                .map(|rd| rd.flatten().count())
                .unwrap_or(0);
            assert_eq!(leftovers, 0, "失败后不得残留正式文件或 .part");
        }

        #[test]
        fn 受控_ole_内存内容超过安全上限被拒绝() {
            let _com = ComGuard::new();
            let obj = src::virtual_files_hglobal(&[("big.bin".to_string(), vec![7u8; 32])]);
            let contents = src::registered_id("FileContents");
            // 用小 cap 验证上限策略，避免真的分配 64MB。
            assert_eq!(
                unsafe { super::super::read_hglobal_index(&obj, contents, 0, 16) },
                Err(super::super::HgError::TooLarge)
            );
            assert_eq!(
                unsafe { super::super::read_hglobal_index(&obj, contents, 0, 64) }
                    .expect("足够上限可读")
                    .len(),
                32
            );
            // 旧实现的回退索引是 -1：多文件来源在这个索引上拿不到内容。
            // 这条断言直接钉住「回退必须带 lindex」。
            assert_eq!(
                unsafe { super::super::read_hglobal_index(&obj, contents, -1, 64) },
                Err(super::super::HgError::Unavailable)
            );
        }

        #[test]
        fn 受控_ole_流读取中途取消也会清理分片() {
            let _com = ComGuard::new();
            // 128KB > 64KB 一块：第一次 Read 后把取消标记置位，第二次循环必须中止。
            let (obj, cancel) =
                src::virtual_files_cancel_on_first_read("big.bin", vec![9u8; 128 * 1024]);
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
            let err = read_stream_to_file(
                dir.path(),
                "01-big.bin",
                declared,
                cookie,
                MAX_VIRTUAL_TOTAL_BYTES,
                &cancel,
            )
            .expect_err("中途取消必须中止");
            assert_eq!(err, codes::DRAG_OPERATION_EXPIRED);
            assert_eq!(
                std::fs::read_dir(dir.path())
                    .map(|rd| rd.flatten().count())
                    .unwrap_or(0),
                0,
                "中途取消不得残留 .part"
            );
        }

        #[test]
        fn 受控_ole_hglobal_块大于声明大小时按声明截断() {
            let _com = ComGuard::new();
            let obj = src::virtual_files_hglobal_padded(
                &[("a.bin".to_string(), b"abc".to_vec())],
                16,
            );
            let dir = TempDir::new();
            let (staged, failures, _op) = run_staging(&obj, 1, dir.path());
            assert!(failures.is_empty(), "failures={failures:?}");
            assert_eq!(staged[0].1, b"abc", "不得把 HGLOBAL 尾部填充写进文件");
        }

        #[test]
        fn 受控_ole_流读取可被取消且不残留分片() {
            let _com = ComGuard::new();
            let obj = src::virtual_files(&[("big.bin".to_string(), vec![1u8; 64 * 1024])]);
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
            let cancel = std::sync::atomic::AtomicBool::new(true);
            let err = read_stream_to_file(
                dir.path(),
                "01-big.bin",
                declared,
                cookie,
                MAX_VIRTUAL_TOTAL_BYTES,
                &cancel,
            )
            .expect_err("取消后必须中止");
            assert_eq!(err, codes::DRAG_OPERATION_EXPIRED);
            let leftovers = std::fs::read_dir(dir.path())
                .map(|rd| rd.flatten().count())
                .unwrap_or(0);
            assert_eq!(leftovers, 0, "取消后不得留下半成品或 .part");
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
            let err = read_stream_to_file(
                dir.path(),
                "01-big.bin",
                declared,
                cookie,
                4,
                &std::sync::atomic::AtomicBool::new(false),
            )
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

    // ── 安装账目（纯逻辑，不需要真实窗口）──────────────────────
    //
    // `RegisterDragDrop` 的冲突难以自动构造，因此把「逐窗口注册 + 失败/重试
    // 记账」抽成 `install_slots`，用注入的注册动作覆盖全部失败分支；
    // 真实接管仍由隔离实例冒烟与真机验收覆盖。
    mod install_accounting {
        use windows::Win32::Foundation::HWND;

        use super::super::{install_slots, InstallReport, TargetSlot};

        fn slot(id: usize, top_level: bool) -> TargetSlot {
            TargetSlot {
                hwnd: HWND(id as *mut core::ffi::c_void),
                top_level,
            }
        }

        #[test]
        fn 全部注册成功() {
            let slots = [slot(1, true), slot(2, false), slot(3, false)];
            let (report, err) = install_slots(&slots, |_| Ok(()));
            assert_eq!(report, InstallReport {
                total: 3,
                installed: 3,
                failed: 0,
                recovered: 0,
                top_level_ok: true,
            });
            assert!(!report.partial());
            assert!(err.is_none());
        }

        #[test]
        fn 顶层成功子窗口失败时如实计失败() {
            let slots = [slot(1, true), slot(2, false), slot(3, false)];
            let (report, err) = install_slots(&slots, |s| {
                if s.top_level {
                    Ok(())
                } else {
                    Err("child failed".into())
                }
            });
            assert_eq!(report.installed, 1);
            assert_eq!(report.failed, 2);
            assert_eq!(report.recovered, 0, "失败重试各一次，仍未成功");
            assert!(report.top_level_ok);
            assert!(report.partial());
            assert_eq!(err.as_deref(), Some("child failed"));
        }

        #[test]
        fn 顶层失败子窗口成功时标记部分接管() {
            let slots = [slot(1, true), slot(2, false)];
            let (report, _) = install_slots(&slots, |s| {
                if s.top_level {
                    Err("top failed".into())
                } else {
                    Ok(())
                }
            });
            assert_eq!(report.installed, 1, "子窗口接管仍然可用");
            assert_eq!(report.failed, 1);
            assert!(!report.top_level_ok);
            assert!(report.partial(), "顶层失败必须暴露为部分接管，不能报全部成功");
        }

        #[test]
        fn 全部失败返回最后的错误() {
            let slots = [slot(1, true), slot(2, false)];
            let (report, err) = install_slots(&slots, |_| Err("no ole".into()));
            assert_eq!(report.installed, 0);
            assert_eq!(report.failed, 2);
            assert!(!report.top_level_ok);
            assert!(!report.partial(), "全失败不是部分接管");
            assert_eq!(err.as_deref(), Some("no ole"));
        }

        #[test]
        fn 首次失败重试成功计入_recovered() {
            let slots = [slot(1, true), slot(2, false)];
            let mut attempts = std::collections::HashMap::new();
            let (report, err) = install_slots(&slots, |s| {
                let n = attempts.entry(s.hwnd.0 as usize).or_insert(0);
                *n += 1;
                if *n == 1 {
                    Err("transient".into())
                } else {
                    Ok(())
                }
            });
            assert_eq!(report.installed, 2);
            assert_eq!(report.recovered, 2);
            assert_eq!(report.failed, 0);
            assert!(err.is_none());
        }

        #[test]
        fn 重复安装账目一致且不累加() {
            let slots = [slot(1, true), slot(2, false)];
            let (first, _) = install_slots(&slots, |_| Ok(()));
            let (second, _) = install_slots(&slots, |_| Ok(()));
            assert_eq!(first, second);
            assert_eq!(second.installed, 2, "重复安装按本次结果计数，不累加上一次");
        }
    }

    #[test]
    fn 已放弃会话的后台暂存不再写盘() {
        use crate::dragdrop::{
            DragDropState, DragPayloadView, DragProbe, StagedKind,
        };

        let root = std::env::temp_dir().join(format!("taskdock-cancel-{}", uuid::Uuid::new_v4()));
        let ds = DragDropState::new(root.join("incoming"));
        let view = DragPayloadView::Text {
            text_preview: String::new(),
            chars: 0,
        };
        let probe = DragProbe::from_view(&view, Vec::new());
        let op = ds.begin(probe, None, view);
        // 模拟：用户在后台读取/写盘前关闭了面板（前端 discard）。
        assert!(ds.discard(&op.id));

        let mut items = Vec::new();
        let mut failures = Vec::new();
        let total = super::stage_pending(
            &op,
            &mut items,
            vec![super::Pending::Bytes {
                name: "a.txt".into(),
                bytes: b"hello".to_vec(),
                kind: StagedKind::VirtualFile,
                mime: None,
                width: None,
                height: None,
            }],
            &mut failures,
        );
        assert_eq!(total, 0, "已放弃会话不得再写入任何字节");
        assert!(items.is_empty());
        assert!(failures.is_empty());
        assert!(!op.dir.exists(), "取消后不得把暂存目录重新建出来");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn 内存数据总量预算按字节累计() {
        use crate::dragdrop::MAX_MEMORY_TOTAL_BYTES;
        assert!(!super::exceeds_memory_budget(0, MAX_MEMORY_TOTAL_BYTES));
        assert!(super::exceeds_memory_budget(MAX_MEMORY_TOTAL_BYTES, 1));
        assert!(
            super::exceeds_memory_budget(u64::MAX, 1),
            "饱和运算不得回绕成「预算充足」"
        );
    }

    #[test]
    fn 卸载在未安装时是安全的幂等操作() {
        // 不触碰真实窗口：句柄表为空时只重置计数，重复调用不 panic。
        super::uninstall();
        super::uninstall();
        assert_eq!(super::installed_windows(), 0);
        assert_eq!(super::failed_windows(), 0);
    }
}

