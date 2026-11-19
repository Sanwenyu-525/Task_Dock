//! Windows Hello / 设备凭据 **桌面路径可用性 PoC**（基线 §2 / 测试 A7 的前置验证）。
//!
//! ## 为什么需要手写 COM 接口
//!
//! 微软文档明确：`UserConsentVerifier::RequestVerificationAsync` 是 UWP API，
//! 桌面应用必须改用 `IUserConsentVerifierInterop::RequestVerificationForWindowAsync(hwnd, msg)`。
//! 而 **windows 0.62.2 并未绑定该 interop 接口**（`Security::Credentials::UI` 里只有
//! `IUserConsentVerifierStatics`，即 UWP 那个方法）。因此本 PoC 按 Windows SDK
//! `10.0.26100.0/um/UserConsentVerifierInterop.h` 的权威定义手写 vtable：
//!
//! ```text
//! MIDL_INTERFACE("39E050C3-4E74-441A-8DC0-B81104DF949C")
//! IUserConsentVerifierInterop : public IInspectable {
//!     HRESULT RequestVerificationForWindowAsync(HWND, HSTRING, REFIID, void**);
//! };
//! ```
//!
//! ## 验证内容
//! 1. 能否从 `UserConsentVerifier` 的 activation factory QI 到该 interop 接口
//!    （社区 issue 曾报 `Class not registered 0x80040154`）。
//! 2. `CheckAvailabilityAsync` 在本机的真实返回值。
//! 3. `RequestVerificationForWindowAsync` 能否真正调起系统凭据 UI（需要真实 top-level HWND）。
//!
//! ## 运行
//! ```text
//! cd src-tauri
//! cargo run --example windows_hello_poc
//! ```
//! 退出码：0 = 三阶段走通（用户完成或主动取消都算走通）；2 = 有阶段失败。
//!
//! ## 安全说明
//! 只读取系统返回的结果码，**不接收、不保存、不传输任何凭据内容**。

use core::ffi::c_void;

use windows::core::{factory, GUID, HSTRING, IUnknown, Interface};
use windows::Foundation::IAsyncOperation;
use windows::Security::Credentials::UI::{
    UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
};
use windows::Win32::Foundation::{HRESULT, HWND};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, ShowWindow, CW_USEDEFAULT, SW_SHOWNORMAL, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW,
    WS_VISIBLE,
};
use windows_future::Async;

/// 取自 Windows SDK `um/UserConsentVerifierInterop.h` 的 `MIDL_INTERFACE`。
const IID_USER_CONSENT_VERIFIER_INTEROP: GUID =
    GUID::from_u128(0x39E0_50C3_4E74_441A_8DC0_B811_04DF_949C);

/// `IUserConsentVerifierInterop` 的 vtable：IInspectable 六槽 + 一个方法。
#[repr(C)]
struct InteropVtbl {
    query_interface: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    get_iids: unsafe extern "system" fn(*mut c_void, *mut u32, *mut *mut GUID) -> HRESULT,
    get_runtime_class_name: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> HRESULT,
    get_trust_level: unsafe extern "system" fn(*mut c_void, *mut i32) -> HRESULT,
    request_verification_for_window_async:
        unsafe extern "system" fn(*mut c_void, HWND, *mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
}

fn main() {
    match run() {
        Ok(()) => println!("[PoC] VERDICT: desktop Windows Hello path is USABLE"),
        Err(err) => {
            eprintln!("[PoC] VERDICT: FAILED -> {err}");
            std::process::exit(2);
        }
    }
}

fn run() -> windows::core::Result<()> {
    // ---------- Phase 1：QI 到 interop 接口（最关键的一步）----------
    println!("[PoC] phase 1: acquiring IUserConsentVerifierInterop via QI ...");
    let factory_unknown: IUnknown = factory::<UserConsentVerifier, IUnknown>()?;
    println!("[PoC] phase 1a OK: activation factory acquired");

    let mut interop_raw: *mut c_void = core::ptr::null_mut();
    let hr = unsafe {
        (factory_unknown.vtable().QueryInterface)(
            factory_unknown.as_raw(),
            &IID_USER_CONSENT_VERIFIER_INTEROP,
            &mut interop_raw,
        )
    };
    if hr.is_err() || interop_raw.is_null() {
        return Err(windows::core::Error::from_hresult(hr));
    }
    println!("[PoC] phase 1b OK: QI for IUserConsentVerifierInterop succeeded");

    // ---------- Phase 2：可用性（无需用户交互）----------
    let availability: UserConsentVerifierAvailability =
        UserConsentVerifier::CheckAvailabilityAsync()?.join()?;
    println!("[PoC] phase 2: availability = {availability:?}");
    if availability != UserConsentVerifierAvailability::Available {
        println!(
            "[PoC] phase 2 note: verifier NOT available here; per baseline D11 this must fail \
             closed (no App-PIN fallback, no self-drawn password box)."
        );
    }

    // ---------- Phase 3：真实 HWND + 系统凭据 UI ----------
    // 用系统预注册的 STATIC 类创建 top-level owner 窗口；系统类要求 hInstance = NULL。
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            windows::core::w!("STATIC"),
            windows::core::w!("TaskDock Windows Hello PoC"),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            460,
            180,
            None,
            None,
            None,
            None,
        )?
    };
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNORMAL);
    }
    println!("[PoC] phase 3: owner HWND created ({hwnd:?}); requesting verification ...");
    println!("[PoC] >>> 请在系统窗口中使用 Windows Hello / 设备 PIN 验证，或点取消");

    let message = HSTRING::from("TaskDock PoC：请验证你的身份");
    // HSTRING 是 #[repr(transparent)] 的单指针，ABI 上等价于 *mut c_void。
    let message_abi: *mut c_void = unsafe { core::mem::transmute_copy(&message) };
    let mut operation_raw: *mut c_void = core::ptr::null_mut();

    let vtbl: &InteropVtbl = unsafe { &**(interop_raw as *const *const InteropVtbl) };
    let hr = unsafe {
        (vtbl.request_verification_for_window_async)(
            interop_raw,
            hwnd,
            message_abi,
            &IAsyncOperation::<UserConsentVerificationResult>::IID,
            &mut operation_raw,
        )
    };
    if hr.is_err() || operation_raw.is_null() {
        unsafe { (vtbl.release)(interop_raw) };
        return Err(windows::core::Error::from_hresult(hr));
    }

    let operation: IAsyncOperation<UserConsentVerificationResult> =
        unsafe { Interface::from_raw(core::ptr::NonNull::new_unchecked(operation_raw)) };
    let result = operation.join();
    unsafe { (vtbl.release)(interop_raw) };

    let result = result?;
    println!("[PoC] phase 3 result = {result:?}");
    match result {
        UserConsentVerificationResult::Verified => println!(
            "[PoC] verified locally — result code only; no credential was read, stored or sent"
        ),
        UserConsentVerificationResult::Canceled => {
            println!("[PoC] canceled -> per baseline D11 the session MUST be refused")
        }
        other => println!("[PoC] non-success {other:?} -> per baseline D11 the session MUST be refused"),
    }
    Ok(())
}
