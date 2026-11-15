//! 顶层窗口的原生悬浮阴影（Win32 分层伴随窗口）。
//!
//! ## 为什么不用 DWM 自带投影
//!
//! 实测（`tmp/acceptance/window-appearance-20261115/probe`）：
//! - 有系统边框的窗口（`WS_CAPTION|WS_THICKFRAME`）由 DWM 绘制投影；
//! - 同一窗口调用 `SetWindowRgn` 后投影消失——DWM 只为"系统边框窗口"
//!   生成投影，自定义区域（圆角/胶囊轮廓）窗口没有系统投影；
//! - 本项目的无边框窗口全部依赖 `SetWindowRgn` 定义外形，因此拿不到 DWM
//!   投影，只能自建伴随阴影窗口。
//!
//! ## 做法
//!
//! 为每个窗口创建一个 **独立的原生分层窗口** 作为阴影：
//! - 阴影形状 = 模糊(该窗口当前区域)，胶囊、圆角矩形、任意轮廓都能得到
//!   正确外轮廓，且完全位于窗口之外、不会被窗口边界裁切；
//! - per-pixel alpha 由 DWM 合成，位于宿主窗口正下方，不接收输入
//!   （`WS_EX_LAYERED|WS_EX_TRANSPARENT|WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW`）；
//! - 事件驱动：子类化窗口过程跟随移动/缩放/显隐/激活/最大化，无轮询定时器；
//! - 最大化、最小化、隐藏时同步隐藏（与系统原生最大化一致，不留屏幕边缘缝隙）；
//! - 宿主销毁时销毁阴影并还原窗口过程，不留孤儿窗口。

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    use tauri::{Runtime, WebviewWindow};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BLACKNESS, BLENDFUNCTION, CombineRgn,
        CreateCompatibleDC, CreateDIBSection, CreateRectRgn, CreateSolidBrush, DIB_RGB_COLORS,
        DeleteDC, DeleteObject, FillRgn, GetDC, GetRegionData, GetWindowRgn, OffsetRgn, PatBlt,
        RGN_COPY, ReleaseDC, SelectObject, WHITENESS,
    };
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CS_HREDRAW, CS_VREDRAW, CallWindowProcW, CreateWindowExW, DefWindowProcW, DestroyWindow,
        GWL_EXSTYLE, GWLP_WNDPROC, GetWindowLongPtrW, GetWindowRect, HWND_NOTOPMOST, HWND_TOPMOST,
        IsIconic, IsWindowVisible, IsZoomed, RegisterClassW, SWP_HIDEWINDOW, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSENDCHANGING, SWP_NOSIZE, SWP_NOZORDER,
        SWP_SHOWWINDOW, SetWindowLongPtrW, SetWindowPos, ULW_ALPHA, UpdateLayeredWindow,
        WM_ACTIVATE, WM_DPICHANGED,
        WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_MOVE, WM_NCDESTROY, WM_SHOWWINDOW, WM_SIZE,
        WM_WINDOWPOSCHANGED, WNDCLASSW, WNDPROC, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
    };

    /// 阴影外扩（CSS px）：阴影窗口每边比宿主大这么多。
    const MARGIN_CSS: f64 = 22.0;
    /// 模糊半径（CSS px）。
    const BLUR_CSS: f64 = 15.0;
    /// 阴影峰值不透明度（0–1）：比系统投影略轻，避免"发光"。
    const PEAK_ALPHA: f32 = 0.20;
    /// 阴影垂直偏移（CSS px）：光源在上，投影略向下。
    const OFFSET_Y_CSS: f64 = 4.0;
    /// 阴影颜色（冷灰蓝，与浅蓝主题协调）。
    const SHADOW_R: f32 = 17.0;
    const SHADOW_G: f32 = 26.0;
    const SHADOW_B: f32 = 44.0;

    const CLASS_NAME: &str = "TaskDockWindowShadow";

    struct State {
        shadow: isize,
        old_proc: isize,
        hdc_mem: isize,
        dib: isize,
        bits: *mut u8,
        /// 位图尺寸（含外扩 margin）
        bmp_w: i32,
        bmp_h: i32,
        margin: i32,
        scale: f64,
        shape_hash: u64,
        topmost: bool,
        defer_rebuild: bool,
        mask: Vec<f32>,
        tmp: Vec<f32>,
    }

    // 句柄与位图指针只在 UI 线程内使用（attach/sync 均来自主线程与窗口过程）。
    unsafe impl Send for State {}

    fn registry() -> &'static Mutex<HashMap<isize, State>> {
        static REG: OnceLock<Mutex<HashMap<isize, State>>> = OnceLock::new();
        REG.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn enabled() -> bool {
        !matches!(
            std::env::var("TASK_DOCK_WINDOW_SHADOW").as_deref(),
            Ok("0") | Ok("off")
        )
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe extern "system" fn shadow_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    fn ensure_class() -> bool {
        static OK: OnceLock<bool> = OnceLock::new();
        *OK.get_or_init(|| unsafe {
            let name = wide(CLASS_NAME);
            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(shadow_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: std::ptr::null_mut(),
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: name.as_ptr(),
            };
            RegisterClassW(&wc) != 0
        })
    }

    /// 区域指纹：区域变化（胶囊展开、圆角半径切换）必须重建阴影位图。
    fn region_hash(hrgn: isize) -> u64 {
        let needed = unsafe { GetRegionData(hrgn as _, 0, std::ptr::null_mut()) };
        if needed == 0 {
            return 0;
        }
        let mut buf = vec![0u8; needed as usize];
        let written = unsafe { GetRegionData(hrgn as _, needed, buf.as_mut_ptr() as *mut _) };
        if written == 0 {
            return 0;
        }
        let mut hash = 0xcbf2_9ce4_8422_2325u64;
        for byte in &buf[..written as usize] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash
    }

    fn ensure_dib(state: &mut State, w: i32, h: i32) -> bool {
        if state.dib != 0 && state.bmp_w == w && state.bmp_h == h {
            return true;
        }
        unsafe {
            if state.dib != 0 {
                DeleteObject(state.dib as _);
                state.dib = 0;
                state.bits = std::ptr::null_mut();
            }
            if state.hdc_mem != 0 {
                DeleteDC(state.hdc_mem as _);
                state.hdc_mem = 0;
            }
            let hdc_screen = GetDC(std::ptr::null_mut());
            let hdc = CreateCompatibleDC(hdc_screen);
            ReleaseDC(std::ptr::null_mut(), hdc_screen);
            if hdc.is_null() {
                return false;
            }
            let mut bmi: BITMAPINFO = std::mem::zeroed();
            bmi.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // 自上而下
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            };
            let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let dib = CreateDIBSection(hdc, &bmi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
            if dib.is_null() || bits.is_null() {
                DeleteDC(hdc);
                return false;
            }
            SelectObject(hdc, dib);
            state.hdc_mem = hdc as isize;
            state.dib = dib as isize;
            state.bits = bits as *mut u8;
            state.bmp_w = w;
            state.bmp_h = h;
            true
        }
    }

    fn blur_h(src: &[f32], dst: &mut [f32], w: usize, h: usize, r: usize) {
        let denom = (2 * r + 1) as f32;
        for y in 0..h {
            let row = y * w;
            let mut acc = 0.0f32;
            for i in -(r as isize)..=(r as isize) {
                let x = i.clamp(0, w as isize - 1) as usize;
                acc += src[row + x];
            }
            for x in 0..w {
                dst[row + x] = acc / denom;
                let add = ((x + r + 1).min(w - 1)) as usize;
                let rem = x.saturating_sub(r);
                acc += src[row + add] - src[row + rem];
            }
        }
    }

    fn blur_v(src: &[f32], dst: &mut [f32], w: usize, h: usize, r: usize) {
        let denom = (2 * r + 1) as f32;
        for x in 0..w {
            let mut acc = 0.0f32;
            for i in -(r as isize)..=(r as isize) {
                let y = i.clamp(0, h as isize - 1) as usize;
                acc += src[y * w + x];
            }
            for y in 0..h {
                dst[y * w + x] = acc / denom;
                let add = (y + r + 1).min(h - 1);
                let rem = y.saturating_sub(r);
                acc += src[add * w + x] - src[rem * w + x];
            }
        }
    }

    fn build_bitmap(state: &mut State, win_w: i32, win_h: i32, hrgn: Option<isize>) -> bool {
        let margin = state.margin;
        let w = win_w + margin * 2;
        let h = win_h + margin * 2;
        if w <= 0 || h <= 0 || !ensure_dib(state, w, h) {
            return false;
        }
        let total = (w as usize) * (h as usize);

        // 1) 形状掩码：黑底 + 白色区域（区域外扩 margin）
        unsafe {
            PatBlt(state.hdc_mem as _, 0, 0, w, h, BLACKNESS);
            match hrgn {
                Some(rgn) => {
                    let copy = CreateRectRgn(0, 0, 1, 1);
                    if !copy.is_null() {
                        CombineRgn(copy, rgn as _, std::ptr::null_mut(), RGN_COPY);
                        OffsetRgn(copy, margin, margin);
                        let brush = CreateSolidBrush(0x00FF_FFFFu32);
                        if !brush.is_null() {
                            FillRgn(state.hdc_mem as _, copy, brush);
                            DeleteObject(brush as _);
                        }
                        DeleteObject(copy as _);
                    }
                }
                None => {
                    PatBlt(state.hdc_mem as _, 0, 0, w, h, WHITENESS);
                }
            }
        }

        // 2) 读红色通道为掩码（0–1）
        state.mask.clear();
        state.mask.resize(total, 0.0);
        state.tmp.clear();
        state.tmp.resize(total, 0.0);
        unsafe {
            let bits = std::slice::from_raw_parts(state.bits, total * 4);
            for i in 0..total {
                state.mask[i] = f32::from(bits[i * 4 + 2]) / 255.0;
            }
        }

        // 3) 三次盒式模糊 ≈ 高斯
        let blur_px = ((BLUR_CSS * state.scale).round() as usize).max(1);
        let pass = (blur_px / 2).max(1);
        for _ in 0..3 {
            blur_h(&state.mask, &mut state.tmp, w as usize, h as usize, pass);
            blur_v(&state.tmp, &mut state.mask, w as usize, h as usize, pass);
        }

        // 4) 写预乘 alpha 的 BGRA
        let offset_y = (OFFSET_Y_CSS * state.scale).round() as i32;
        unsafe {
            let out = std::slice::from_raw_parts_mut(state.bits, total * 4);
            for y in 0..h {
                let sy = y - offset_y;
                for x in 0..w {
                    let dst_idx = (y as usize) * (w as usize) + x as usize;
                    let a = if sy >= 0 && sy < h {
                        let src_idx = (sy as usize) * (w as usize) + x as usize;
                        (state.mask[src_idx] * PEAK_ALPHA).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    let p = dst_idx * 4;
                    out[p] = (SHADOW_B * a) as u8;
                    out[p + 1] = (SHADOW_G * a) as u8;
                    out[p + 2] = (SHADOW_R * a) as u8;
                    out[p + 3] = (a * 255.0) as u8;
                }
            }
        }
        true
    }

    fn hide_shadow(state: &mut State) {
        unsafe {
            SetWindowPos(
                state.shadow as _,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW,
            );
        }
    }

    fn sync_state(state: &mut State, owner: isize) {
        unsafe {
            let owner_hwnd = owner as HWND;
            // 隐藏 / 最小化 / 最大化：不绘制阴影（最大化与系统原生一致，不留缝隙）
            if IsWindowVisible(owner_hwnd) == 0
                || IsIconic(owner_hwnd) != 0
                || IsZoomed(owner_hwnd) != 0
            {
                hide_shadow(state);
                return;
            }

            let mut rect: RECT = std::mem::zeroed();
            if GetWindowRect(owner_hwnd, &mut rect) == 0 {
                hide_shadow(state);
                return;
            }
            let win_w = rect.right - rect.left;
            let win_h = rect.bottom - rect.top;
            if win_w <= 0 || win_h <= 0 {
                hide_shadow(state);
                return;
            }

            let dpi = GetDpiForWindow(owner_hwnd);
            state.scale = if dpi > 0 { f64::from(dpi) / 96.0 } else { 1.0 };
            state.margin = (MARGIN_CSS * state.scale).round() as i32;

            // 当前窗口区域；未设置区域（或读取失败）时按整窗矩形
            let probe = CreateRectRgn(0, 0, 0, 0);
            let rgn_type = if probe.is_null() {
                0
            } else {
                GetWindowRgn(owner_hwnd, probe)
            };
            let hash = if rgn_type > 0 { region_hash(probe as isize) } else { 0 };
            if !probe.is_null() {
                DeleteObject(probe as _);
            }

            let bmp_w = win_w + state.margin * 2;
            let bmp_h = win_h + state.margin * 2;
            let need_rebuild =
                state.shape_hash != hash || state.bmp_w != bmp_w || state.bmp_h != bmp_h;
            if need_rebuild && !state.defer_rebuild {
                let rgn = CreateRectRgn(0, 0, 0, 0);
                let applied = if rgn.is_null() {
                    build_bitmap(state, win_w, win_h, None)
                } else {
                    let t = GetWindowRgn(owner_hwnd, rgn);
                    let ok = build_bitmap(
                        state,
                        win_w,
                        win_h,
                        if t > 0 { Some(rgn as isize) } else { None },
                    );
                    DeleteObject(rgn as _);
                    ok
                };
                if applied {
                    state.shape_hash = hash;
                }
            }
            // 没有可用位图（DIB 创建失败）时不显示阴影，避免留下整块纯色矩形
            if state.hdc_mem == 0 {
                hide_shadow(state);
                return;
            }

            let x = rect.left - state.margin;
            let y = rect.top - state.margin - (OFFSET_Y_CSS * state.scale).round() as i32;
            let w = win_w + state.margin * 2;
            let h = win_h + state.margin * 2;

            let blend = BLENDFUNCTION {
                BlendOp: 0, // AC_SRC_OVER
                BlendFlags: 0,
                SourceConstantAlpha: 255,
                AlphaFormat: 1, // AC_SRC_ALPHA
            };
            let dst_pt = POINT { x, y };
            let src_pt = POINT { x: 0, y: 0 };
            let size = SIZE { cx: w, cy: h };
            UpdateLayeredWindow(
                state.shadow as _,
                std::ptr::null_mut(),
                &dst_pt,
                &size,
                state.hdc_mem as _,
                &src_pt,
                0,
                &blend,
                ULW_ALPHA,
            );

            // 置顶状态跟随宿主，并保证阴影紧贴宿主下方（不抢焦点、不拦输入）
            let owner_ex = GetWindowLongPtrW(owner_hwnd, GWL_EXSTYLE) as u32;
            let want_topmost = (owner_ex & WS_EX_TOPMOST) != 0;
            if state.topmost != want_topmost {
                SetWindowPos(
                    state.shadow as _,
                    if want_topmost {
                        HWND_TOPMOST
                    } else {
                        HWND_NOTOPMOST
                    },
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                state.topmost = want_topmost;
            }
            SetWindowPos(
                state.shadow as _,
                owner_hwnd,
                x,
                y,
                w,
                h,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING | SWP_SHOWWINDOW,
            );
        }
    }

    unsafe extern "system" fn owner_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let owner = hwnd as isize;
        let old = {
            let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
            reg.get(&owner).map(|s| s.old_proc)
        };
        let Some(old) = old else {
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        };

        // 先让宿主自己的窗口过程（tao / 磁力拖拽子类）处理，再看阴影
        let prev: WNDPROC = std::mem::transmute(old);
        let result = CallWindowProcW(prev, hwnd, msg, wparam, lparam);

        match msg {
            WM_WINDOWPOSCHANGED | WM_SIZE | WM_MOVE | WM_SHOWWINDOW | WM_ACTIVATE
            | WM_DPICHANGED => {
                let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(state) = reg.get_mut(&owner) {
                    sync_state(state, owner);
                }
            }
            WM_ENTERSIZEMOVE => {
                // 缩放中不重建位图（逐帧模糊会让拖动掉帧），松手后再校准
                let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(state) = reg.get_mut(&owner) {
                    state.defer_rebuild = true;
                }
            }
            WM_EXITSIZEMOVE => {
                let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
                if let Some(state) = reg.get_mut(&owner) {
                    state.defer_rebuild = false;
                    state.shape_hash = u64::MAX; // 强制按最终尺寸重建
                    sync_state(state, owner);
                }
            }
            WM_NCDESTROY => destroy_now(owner),
            _ => {}
        }
        result
    }

    fn destroy_now(owner: isize) {
        let state = {
            let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
            reg.remove(&owner)
        };
        if let Some(state) = state {
            unsafe {
                if state.shadow != 0 {
                    DestroyWindow(state.shadow as _);
                }
                if state.dib != 0 {
                    DeleteObject(state.dib as _);
                }
                if state.hdc_mem != 0 {
                    DeleteDC(state.hdc_mem as _);
                }
                // 还原窗口过程，避免句柄复用时把旧过程带过去
                if state.old_proc != 0 {
                    SetWindowLongPtrW(owner as _, GWLP_WNDPROC, state.old_proc);
                }
            }
        }
    }

    fn attach_now(owner: isize) {
        if owner == 0 || !enabled() || !ensure_class() {
            return;
        }
        {
            let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
            if reg.contains_key(&owner) {
                return;
            }
        }
        unsafe {
            let name = wide(CLASS_NAME);
            let shadow = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                name.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                -20000,
                -20000,
                1,
                1,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            if shadow.is_null() {
                return;
            }
            let old = SetWindowLongPtrW(
                owner as _,
                GWLP_WNDPROC,
                owner_proc as *const () as isize,
            );
            if old == 0 {
                DestroyWindow(shadow);
                return;
            }
            let mut state = State {
                shadow: shadow as isize,
                old_proc: old,
                hdc_mem: 0,
                dib: 0,
                bits: std::ptr::null_mut(),
                bmp_w: 0,
                bmp_h: 0,
                margin: (MARGIN_CSS * 1.25).round() as i32,
                scale: 1.0,
                shape_hash: u64::MAX,
                topmost: false,
                defer_rebuild: false,
                mask: Vec::new(),
                tmp: Vec::new(),
            };
            sync_state(&mut state, owner);
            registry()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(owner, state);
        }
    }

    pub fn attach<R: Runtime>(win: &WebviewWindow<R>) {
        let w = win.clone();
        let _ = win.run_on_main_thread(move || {
            if let Ok(h) = w.hwnd() {
                attach_now(h.0 as isize);
            }
        });
    }

    /// 形状变化后主动同步（区域/半径由 `window_shape` 写入时调用）。
    pub fn sync(hwnd: isize) {
        if hwnd == 0 {
            return;
        }
        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(state) = reg.get_mut(&hwnd) {
            state.shape_hash = u64::MAX;
            sync_state(state, hwnd);
        }
    }

    pub fn detach(hwnd: isize) {
        destroy_now(hwnd);
    }
}

#[cfg(windows)]
pub use imp::{attach, detach, sync};

#[cfg(not(windows))]
pub fn attach<R: tauri::Runtime>(_win: &tauri::WebviewWindow<R>) {}
#[cfg(not(windows))]
pub fn sync(_hwnd: isize) {}
#[cfg(not(windows))]
pub fn detach(_hwnd: isize) {}
