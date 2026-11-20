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
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BLACKNESS, BLENDFUNCTION, COLORONCOLOR, CombineRgn,
        CreateCompatibleDC, CreateDIBSection, CreateRectRgn, CreateSolidBrush, DIB_RGB_COLORS,
        DeleteDC, DeleteObject, FillRgn, GetDC, GetRegionData, GetWindowRgn, OffsetRgn, PatBlt,
        RGN_COPY, ReleaseDC, SelectObject, SRCCOPY, SetStretchBltMode, StretchBlt, WHITENESS,
    };
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CS_HREDRAW, CS_VREDRAW, CallWindowProcW, CreateWindowExW, DefWindowProcW, DestroyWindow,
        GWL_EXSTYLE, GWLP_WNDPROC, GetWindowLongPtrW, GetWindowRect,
        IsIconic, IsWindow, IsWindowVisible, IsZoomed, RegisterClassW, SWP_HIDEWINDOW, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSENDCHANGING, SWP_NOSIZE, SWP_NOZORDER,
        SWP_SHOWWINDOW, SetWindowLongPtrW, SetWindowPos, ULW_ALPHA, UpdateLayeredWindow,
        WM_ACTIVATE, WM_CAPTURECHANGED, WM_DPICHANGED,
        WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_MOVE, WM_MOVING, WM_NCDESTROY, WM_SHOWWINDOW,
        WM_SIZING, WM_SIZE, WM_WINDOWPOSCHANGED, WNDCLASSW, WNDPROC, WS_EX_LAYERED,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
    };

    /// 阴影外扩（CSS px）：阴影窗口每边比宿主大这么多。
    ///
    /// 取值必须 ≥ 环境层模糊的 3σ，否则位图边界会把"还没衰减完"的 alpha 截断成
    /// 一条硬边。2026-11-20 克制化调整：旧版 margin 56 / ambient blur 28 / 两层
    /// 峰值 ≈0.34，白底右侧与底部出现明显灰带；收紧扩散半径与峰值后 margin 同步
    /// 下调到 40，仍覆盖环境层衰减范围，位图边缘不产生硬边。
    const MARGIN_CSS: f64 = 40.0;
    /// 环境层：大范围、低峰值，负责整体悬浮感。
    const AMBIENT_BLUR_CSS: f64 = 18.0;
    const AMBIENT_ALPHA: f32 = 0.14;
    /// 接触层：贴近边缘、模糊小，负责窗口与桌面的接触感（不是黑色描边）。
    const CONTACT_BLUR_CSS: f64 = 5.0;
    const CONTACT_ALPHA: f32 = 0.08;
    /// 阴影垂直偏移（CSS px）：光源在上，投影略向下。
    const OFFSET_Y_CSS: f64 = 3.0;
    /// 阴影颜色（冷灰蓝，与浅蓝主题协调）。
    const SHADOW_R: f32 = 17.0;
    const SHADOW_G: f32 = 26.0;
    const SHADOW_B: f32 = 44.0;

    const CLASS_NAME: &str = "TaskDockWindowShadow";

    /// 一组阴影参数（CSS px / 0–1 alpha）。默认即下方常量，验收时可在 **debug 构建**
    /// 用 `TASK_DOCK_SHADOW_*` 环境变量整体替换，避免为每个候选方案重新编译。
    /// release 构建永远使用常量，不接受环境变量。
    #[derive(Clone, Copy, Debug)]
    struct ShadowParams {
        margin: f64,
        ambient_blur: f64,
        ambient_alpha: f32,
        contact_blur: f64,
        contact_alpha: f32,
        offset_y: f64,
        color: (f32, f32, f32),
    }

    impl ShadowParams {
        const fn defaults() -> Self {
            Self {
                margin: MARGIN_CSS,
                ambient_blur: AMBIENT_BLUR_CSS,
                ambient_alpha: AMBIENT_ALPHA,
                contact_blur: CONTACT_BLUR_CSS,
                contact_alpha: CONTACT_ALPHA,
                offset_y: OFFSET_Y_CSS,
                color: (SHADOW_R, SHADOW_G, SHADOW_B),
            }
        }
    }

    /// 纯函数便于单测：`get` 返回环境变量值，缺失/非法时回退默认。
    fn parse_params(get: impl Fn(&str) -> Option<String>) -> ShadowParams {
        let d = ShadowParams::defaults();
        let num = |key: &str, fallback: f64| -> f64 {
            get(key)
                .and_then(|v| v.trim().parse::<f64>().ok())
                .filter(|v| v.is_finite() && *v >= 0.0)
                .unwrap_or(fallback)
        };
        ShadowParams {
            margin: num("TASK_DOCK_SHADOW_MARGIN", d.margin).clamp(16.0, 96.0),
            ambient_blur: num("TASK_DOCK_SHADOW_AMBIENT_BLUR", d.ambient_blur).clamp(2.0, 64.0),
            ambient_alpha: num("TASK_DOCK_SHADOW_AMBIENT_ALPHA", d.ambient_alpha as f64)
                .clamp(0.0, 0.6) as f32,
            contact_blur: num("TASK_DOCK_SHADOW_CONTACT_BLUR", d.contact_blur).clamp(2.0, 32.0),
            contact_alpha: num("TASK_DOCK_SHADOW_CONTACT_ALPHA", d.contact_alpha as f64)
                .clamp(0.0, 0.6) as f32,
            offset_y: num("TASK_DOCK_SHADOW_OFFSET_Y", d.offset_y).clamp(0.0, 24.0),
            color: d.color,
        }
    }

    fn params() -> ShadowParams {
        #[cfg(debug_assertions)]
        {
            static P: OnceLock<ShadowParams> = OnceLock::new();
            *P.get_or_init(|| parse_params(|k| std::env::var(k).ok()))
        }
        #[cfg(not(debug_assertions))]
        {
            ShadowParams::defaults()
        }
    }

    /// 已提交位图 / 定位的状态快照（与真实 HWND 解耦，便于单测）。
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct ShadowSnapshot {
        cached_w: i32,
        cached_h: i32,
        cached_x: i32,
        cached_y: i32,
        cached_margin: i32,
        cached_hash: u64,
        in_gesture: bool,
        gesture_start_w: i32,
        gesture_start_h: i32,
    }

    /// 宿主窗口当前几何 / 外形快照（由 Win32 读取后填入）。
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct WindowSnapshot {
        visible: bool,
        iconic: bool,
        zoomed: bool,
        x: i32,
        y: i32,
        win_w: i32,
        win_h: i32,
        margin: i32,
        hash: u64,
    }

    impl WindowSnapshot {
        fn bmp_w(&self) -> i32 {
            self.win_w + self.margin * 2
        }
        fn bmp_h(&self) -> i32 {
            self.win_h + self.margin * 2
        }
    }

    /// 一次同步请求的决策结果（纯决策，不触碰 HWND / GDI）。
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum Decision {
        /// 隐藏（不可见 / 最小化 / 最大化 / 尺寸非法）。
        Hide,
        /// 位置变化、尺寸与外形未变：只移动阴影窗口，不重提交位图、不重建。
        MoveOnly,
        /// 非手势期间尺寸 / 外形 / margin 变化：重建位图后再提交。
        RebuildAndSubmit,
        /// 手势期间尺寸已变：把最近一次完整质量的位图**缩放**成应急位图提交，
        /// 保持阴影全程可见；旧 DIB 本身绝不以新尺寸直接提交，松手后按最终尺寸重建。
        ScaleDuringGesture,
        /// 几何、外形、位置均无变化：不做任何 Win32 操作。
        NoChange,
    }

    /// 位图目标尺寸：窗口外扩两侧 margin。纯函数，一致性断言复用。
    fn bitmap_size(win_w: i32, win_h: i32, margin: i32) -> (i32, i32) {
        (win_w + margin * 2, win_h + margin * 2)
    }

    /// 纯决策：不触碰 HWND / GDI，单测直接覆盖移动 vs 缩放、旧位图禁提交等分支。
    fn decide(snap: &ShadowSnapshot, win: &WindowSnapshot) -> Decision {
        if !win.visible || win.iconic || win.zoomed || win.win_w <= 0 || win.win_h <= 0 {
            return Decision::Hide;
        }
        // 手势内以「起始外框宽高」为基准比较；手势外以已提交位图尺寸为基准。
        let size_or_shape_changed = if snap.in_gesture {
            snap.gesture_start_w != win.win_w
                || snap.gesture_start_h != win.win_h
                || snap.cached_hash != win.hash
                || snap.cached_margin != win.margin
        } else {
            snap.cached_w != win.bmp_w()
                || snap.cached_h != win.bmp_h()
                || snap.cached_hash != win.hash
                || snap.cached_margin != win.margin
        };
        let moved = snap.cached_x != win.x || snap.cached_y != win.y;

        if snap.in_gesture {
            if size_or_shape_changed {
                return Decision::ScaleDuringGesture;
            }
            return if moved { Decision::MoveOnly } else { Decision::NoChange };
        }
        if size_or_shape_changed {
            return Decision::RebuildAndSubmit;
        }
        if moved {
            Decision::MoveOnly
        } else {
            Decision::NoChange
        }
    }

    struct State {
        shadow: isize,
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
        /// 是否处于系统模态移动/缩放循环（WM_ENTERSIZEMOVE…WM_EXITSIZEMOVE）。
        defer_rebuild: bool,
        /// 手势起始外框宽高：手势内据此判断宽高是否真的变化。
        gesture_start_w: i32,
        gesture_start_h: i32,
        /// 手势内尺寸变化：阴影不再隐藏，而是把完整位图缩放成应急位图提交。
        suspended: bool,
        /// 应急位图（手势内缩放用）：与完整质量位图分开，避免连续缩放累积模糊。
        gesture_hdc: isize,
        gesture_dib: isize,
        gesture_bits: *mut u8,
        gesture_w: i32,
        gesture_h: i32,
        /// 阴影当前是否处于隐藏态（由同步决策维护）。
        hidden: bool,
        /// 上次定位的阴影窗口左上角（物理 px），用于纯移动判定。
        cached_x: i32,
        cached_y: i32,
        /// 上次位图使用的 margin（DPI / 参数变化时触发重建）。
        cached_margin: i32,
        mask: Vec<f32>,
        tmp: Vec<f32>,
        /// 环境层（大模糊）与接触层（小模糊）的模糊结果，合成时才乘峰值 alpha。
        ambient: Vec<f32>,
        contact: Vec<f32>,
    }

    // 句柄与位图指针只在 UI 线程内使用（attach/sync 均来自主线程与窗口过程）。
    unsafe impl Send for State {}

    struct Entry {
        old_proc: isize,
        shadow: isize,
        // 同步期间暂时取出状态；重入仍能找到原窗口过程，但不重复更新阴影。
        state: Option<State>,
    }

    fn registry() -> &'static Mutex<HashMap<isize, Entry>> {
        static REG: OnceLock<Mutex<HashMap<isize, Entry>>> = OnceLock::new();
        REG.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn with_state(owner: isize, update: impl FnOnce(&mut State)) {
        let state = {
            let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
            reg.get_mut(&owner).and_then(|entry| entry.state.take())
        };
        let Some(mut state) = state else { return };
        // SetWindowPos / UpdateLayeredWindow 会同步重入 owner_proc，绝不能持注册表锁。
        update(&mut state);
        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = reg.get_mut(&owner) {
            if entry.shadow == state.shadow {
                entry.state = Some(state);
                return;
            }
        }
        // 宿主在回调中销毁（或 HWND 已复用）：不把旧状态重新插回注册表。
        drop(reg);
        release_state(state);
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

    /// 新建一张与屏幕兼容的 32bpp 预乘 BGRA DIB（自上而下）+ 内存 DC。
    /// 返回 `(hdc, dib, bits)`；任一步失败返回 None 并自行回收已分配资源。
    unsafe fn create_surface(w: i32, h: i32) -> Option<(isize, isize, *mut u8)> {
        let hdc_screen = GetDC(std::ptr::null_mut());
        let hdc = CreateCompatibleDC(hdc_screen);
        ReleaseDC(std::ptr::null_mut(), hdc_screen);
        if hdc.is_null() {
            return None;
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
            return None;
        }
        SelectObject(hdc, dib);
        Some((hdc as isize, dib as isize, bits as *mut u8))
    }

    fn ensure_dib(state: &mut State, w: i32, h: i32) -> bool {
        if state.dib != 0 && state.bmp_w == w && state.bmp_h == h {
            return true;
        }
        unsafe {
            // 释放顺序必须是「先 DC、后 DIB」：位图仍被选入内存 DC 时 DeleteObject
            // 会被 GDI 拒绝，尺寸每变一次就漏一张位图（重复缩放最容易被放大）。
            if state.hdc_mem != 0 {
                DeleteDC(state.hdc_mem as _);
                state.hdc_mem = 0;
            }
            if state.dib != 0 {
                DeleteObject(state.dib as _);
                state.dib = 0;
                state.bits = std::ptr::null_mut();
            }
            let Some((hdc, dib, bits)) = create_surface(w, h) else {
                return false;
            };
            state.hdc_mem = hdc;
            state.dib = dib;
            state.bits = bits;
            state.bmp_w = w;
            state.bmp_h = h;
            true
        }
    }

    /// 应急位图的 DIB（手势内缩放提交用），与完整质量位图分开管理。
    fn ensure_gesture_dib(state: &mut State, w: i32, h: i32) -> bool {
        if state.gesture_dib != 0 && state.gesture_w == w && state.gesture_h == h {
            return true;
        }
        unsafe {
            if state.gesture_hdc != 0 {
                DeleteDC(state.gesture_hdc as _);
                state.gesture_hdc = 0;
            }
            if state.gesture_dib != 0 {
                DeleteObject(state.gesture_dib as _);
                state.gesture_dib = 0;
                state.gesture_bits = std::ptr::null_mut();
            }
            let Some((hdc, dib, bits)) = create_surface(w, h) else {
                return false;
            };
            state.gesture_hdc = hdc;
            state.gesture_dib = dib;
            state.gesture_bits = bits;
            state.gesture_w = w;
            state.gesture_h = h;
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

    /// 三次盒式模糊 ≈ 高斯（把 `src` 模糊到 `dst`，`tmp` 为中转）。
    fn blur3(src: &[f32], tmp: &mut [f32], dst: &mut [f32], w: usize, h: usize, pass: usize) {
        dst.copy_from_slice(src);
        for _ in 0..3 {
            blur_h(dst, tmp, w, h, pass);
            blur_v(tmp, dst, w, h, pass);
        }
    }

    /// 阴影诊断开关：`TASK_DOCK_SHADOW_DEBUG=1` 时把位图尺寸、峰值 alpha、
    /// 边缘衰减采样打到日志，用于回答"阴影为什么看不出来"（不开启时零开销）。
    fn debug_on() -> bool {
        static ON: OnceLock<bool> = OnceLock::new();
        *ON.get_or_init(|| {
            matches!(
                std::env::var("TASK_DOCK_SHADOW_DEBUG").as_deref(),
                Ok("1") | Ok("on")
            )
        })
    }


    /// 单像素合成 alpha：模糊值加权后乘 `1 - inside`，窗口轮廓内部强制为 0。
    ///
    /// 纯函数，单测直接覆盖「轮廓内必须为 0 / 轮廓外保持原衰减」。
    fn pixel_alpha(ambient: f32, contact: f32, inside: f32, pr: &ShadowParams) -> f32 {
        let a = ambient * pr.ambient_alpha + contact * pr.contact_alpha;
        (a * (1.0 - inside)).clamp(0.0, 1.0)
    }

    fn build_bitmap(state: &mut State, win_w: i32, win_h: i32, hrgn: Option<isize>) -> bool {
        let t0 = std::time::Instant::now();
        let pr = params();
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

        // 3) 两层模糊：环境层（大扩散，负责悬浮感）+ 接触层（小扩散，负责贴边层次）。
        //    分开模糊再合成，才能同时得到"远处的柔和衰减"和"近处的清晰轮廓"；
        //    单层大模糊会让近边缘被抹平（上一版峰值只有 0.20、边缘只剩 ~0.10，
        //    在亮桌面上几乎看不出投影）。
        state.ambient.clear();
        state.ambient.resize(total, 0.0);
        state.contact.clear();
        state.contact.resize(total, 0.0);
        let amb_pass = (((pr.ambient_blur * state.scale).round() as usize) / 2).max(1);
        let con_pass = (((pr.contact_blur * state.scale).round() as usize) / 2).max(1);
        blur3(
            &state.mask,
            &mut state.tmp,
            &mut state.ambient,
            w as usize,
            h as usize,
            amb_pass,
        );
        blur3(
            &state.mask,
            &mut state.tmp,
            &mut state.contact,
            w as usize,
            h as usize,
            con_pass,
        );

        // 4) 合成并写预乘 alpha 的 BGRA（垂直偏移在窗口定位时施加，见 sync_state）。
        //    窗口轮廓**内部**的 alpha 一律归零：位图里的掩码是整块窗口填充，
        //    模糊后内部也会保留峰值 alpha；一旦阴影窗口被抬到宿主之上（置顶切换、
        //    z-order 抖动），这层 alpha 会整片盖在窗口内容上——「置顶时阴影透出来」
        //    就是它的直接表现；玻璃材质下也会把背后的阴影透进窗口。
        let off = (pr.offset_y * state.scale).round() as usize;
        let wu = w as usize;
        let hu = h as usize;
        unsafe {
            let out = std::slice::from_raw_parts_mut(state.bits, total * 4);
            for y in 0..hu {
                // 位图定位时整体下移 offset，窗口在位图里的顶边是 margin-offset；
                // 取 mask[y+offset] 正好对齐窗口真实轮廓（窗口行 → 归零，窗口上方一行 → 保留）。
                let inside_row = (y + off).min(hu - 1) * wu;
                for x in 0..wu {
                    let i = y * wu + x;
                    let a = pixel_alpha(state.ambient[i], state.contact[i], state.mask[inside_row + x], &pr);
                    let p = i * 4;
                    out[p] = (pr.color.2 * a) as u8;
                    out[p + 1] = (pr.color.1 * a) as u8;
                    out[p + 2] = (pr.color.0 * a) as u8;
                    out[p + 3] = (a * 255.0) as u8;
                }
            }
        }

        if debug_on() {
            // 沿"窗口左边外 0/4/10/20/34 px"采一行，报告衰减曲线：这比"看起来有阴影"
            // 可复核，也能区分"位图边界截断"与"峰值太低"两种不同毛病。
            let cy = ((h / 2) as usize).min(h as usize - 1);
            let inside_x = (margin as usize).min(w as usize - 1);
            let mut samples = String::new();
            for d in [0usize, 4, 10, 20, 34] {
                let x = inside_x.saturating_sub(d);
                let a = state.ambient[cy * w as usize + x] * pr.ambient_alpha
                    + state.contact[cy * w as usize + x] * pr.contact_alpha;
                samples.push_str(&format!("{d}px:{:.3} ", a));
            }
            // 窗口中心点：合成阶段应被掩码归零，用来证明「阴影不再盖在窗口上」。
            let mid_x = (inside_x + (win_w as usize) / 2).min(w as usize - 1);
            let mid_y = ((margin as usize).saturating_sub(off) + (win_h as usize) / 2).min(h as usize - 1);
            let mid_row = (mid_y + off).min(h as usize - 1) * w as usize;
            let center = pixel_alpha(
                state.ambient[mid_y * w as usize + mid_x],
                state.contact[mid_y * w as usize + mid_x],
                state.mask[mid_row + mid_x],
                &pr,
            );
            eprintln!(
                "[shadow] bitmap {}x{} margin={}px amb_pass={} con_pass={} edge_alpha(outside) {} center_alpha(inside):{:.3} elapsed_ms={:.2}",
                w, h, margin, amb_pass, con_pass, samples, center, t0.elapsed().as_secs_f64() * 1000.0
            );
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

    /// 从宿主窗口读取当前几何 / 外形快照；同步更新 DPI、margin。读取失败返回 None。
    unsafe fn read_window_snapshot(state: &mut State, owner_hwnd: HWND) -> Option<WindowSnapshot> {
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(owner_hwnd, &mut rect) == 0 {
            return None;
        }
        let win_w = rect.right - rect.left;
        let win_h = rect.bottom - rect.top;

        let dpi = GetDpiForWindow(owner_hwnd);
        state.scale = if dpi > 0 { f64::from(dpi) / 96.0 } else { 1.0 };
        state.margin = (params().margin * state.scale).round() as i32;

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

        let x = rect.left - state.margin;
        // 光源在窗口上方：整张阴影位图整体下移 offset，上边缘因此更"贴身"、下边缘更"落空"。
        let y = rect.top - state.margin + (params().offset_y * state.scale).round() as i32;

        Some(WindowSnapshot {
            visible: IsWindowVisible(owner_hwnd) != 0,
            iconic: IsIconic(owner_hwnd) != 0,
            zoomed: IsZoomed(owner_hwnd) != 0,
            x,
            y,
            win_w,
            win_h,
            margin: state.margin,
            hash,
        })
    }

    /// 置顶状态跟随宿主，与几何同步解耦（不抢焦点、不拦输入）。
    ///
    /// 必须以宿主为 insert-after 把阴影钉在宿主**正下方**：旧实现用
    /// `HWND_TOPMOST` / `HWND_NOTOPMOST`，会把阴影抬到所在 z 带的最顶（即宿主之上），
    /// 位图在窗口轮廓内的 alpha 会整片盖在窗口内容上，表现为「置顶时整窗发灰、阴影透出来」。
    unsafe fn follow_topmost(state: &mut State, owner_hwnd: HWND) {
        let owner_ex = GetWindowLongPtrW(owner_hwnd, GWL_EXSTYLE) as u32;
        let want_topmost = (owner_ex & WS_EX_TOPMOST) != 0;
        if state.topmost != want_topmost {
            // 插入到宿主之后：宿主是 topmost 时阴影随之进入 topmost 带，但仍位于宿主之下；
            // 宿主退出 topmost 时阴影同样回到普通带，不会残留在最顶层遮住别的窗口。
            SetWindowPos(
                state.shadow as _,
                owner_hwnd,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
            state.topmost = want_topmost;
        }
    }

    /// 纯移动分支：只把阴影窗口跟随到新位置，不 ULW 重提交、不重建、不重模糊。
    unsafe fn move_shadow(state: &mut State, x: i32, y: i32) {
        SetWindowPos(
            state.shadow as _,
            std::ptr::null_mut(),
            x,
            y,
            0,
            0,
            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
        );
    }

    /// 重建成功后提交位图：ULW 写入内容，并把阴影置于宿主窗口下方。
    unsafe fn submit_layered(state: &mut State, owner_hwnd: HWND, win: &WindowSnapshot) {
        let blend = BLENDFUNCTION {
            BlendOp: 0, // AC_SRC_OVER
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: 1, // AC_SRC_ALPHA
        };
        let dst_pt = POINT { x: win.x, y: win.y };
        let src_pt = POINT { x: 0, y: 0 };
        let size = SIZE { cx: win.bmp_w(), cy: win.bmp_h() };
        let layered = UpdateLayeredWindow(
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
        if debug_on() {
            eprintln!(
                "[shadow] UpdateLayeredWindow={} pos={},{} size={}x{} host={}x{} margin={} topmost_owner={}",
                layered,
                win.x,
                win.y,
                win.bmp_w(),
                win.bmp_h(),
                win.win_w,
                win.win_h,
                win.margin,
                (GetWindowLongPtrW(owner_hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST) != 0
            );
        }
        SetWindowPos(
            state.shadow as _,
            owner_hwnd,
            win.x,
            win.y,
            win.bmp_w(),
            win.bmp_h(),
            SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING | SWP_SHOWWINDOW,
        );
    }

    /// 手势内尺寸变化的应急提交：把最近一次**完整质量**位图缩放成当前尺寸再 ULW。
    ///
    /// 不直接拿旧 DIB 按新尺寸提交（那会把边缘拉伸成灰块），也不隐藏阴影（那会让
    /// 缩放过程中阴影整个消失）。缩放源始终是最新的完整位图，连续缩放不会累积模糊；
    /// 手势结束后照常按最终尺寸重建，恢复原始柔和度。
    unsafe fn submit_scaled(state: &mut State, owner_hwnd: HWND, win: &WindowSnapshot) -> bool {
        let (src_w, src_h) = (state.bmp_w, state.bmp_h);
        if state.hdc_mem == 0 || state.dib == 0 || src_w <= 0 || src_h <= 0 {
            return false;
        }
        let (dst_w, dst_h) = (win.bmp_w(), win.bmp_h());
        if !ensure_gesture_dib(state, dst_w, dst_h) {
            return false;
        }
        // 应急位图只在一帧内使用，取最近邻缩放换取速度；渐变阴影看不出插值差异。
        SetStretchBltMode(state.gesture_hdc as _, COLORONCOLOR);
        let scaled = StretchBlt(
            state.gesture_hdc as _,
            0,
            0,
            dst_w,
            dst_h,
            state.hdc_mem as _,
            0,
            0,
            src_w,
            src_h,
            SRCCOPY,
        );
        if scaled == 0 {
            return false;
        }
        let blend = BLENDFUNCTION {
            BlendOp: 0,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: 1,
        };
        let dst_pt = POINT { x: win.x, y: win.y };
        let src_pt = POINT { x: 0, y: 0 };
        let size = SIZE { cx: dst_w, cy: dst_h };
        let layered = UpdateLayeredWindow(
            state.shadow as _,
            std::ptr::null_mut(),
            &dst_pt,
            &size,
            state.gesture_hdc as _,
            &src_pt,
            0,
            &blend,
            ULW_ALPHA,
        );
        if layered == 0 {
            return false;
        }
        SetWindowPos(
            state.shadow as _,
            owner_hwnd,
            win.x,
            win.y,
            dst_w,
            dst_h,
            SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING | SWP_SHOWWINDOW,
        );
        state.cached_x = win.x;
        state.cached_y = win.y;
        true
    }

    fn sync_state(state: &mut State, owner: isize) {
        unsafe {
            // 伴随窗口失效（被外部销毁）时不在死句柄上提交 ULW；下一次消息会先重建。
            if state.shadow == 0 || IsWindow(state.shadow as _) == 0 {
                state.hidden = true;
                return;
            }
            let owner_hwnd = owner as HWND;
            let Some(win) = read_window_snapshot(state, owner_hwnd) else {
                hide_shadow(state);
                state.hidden = true;
                return;
            };

            let snap = ShadowSnapshot {
                cached_w: state.bmp_w,
                cached_h: state.bmp_h,
                cached_x: state.cached_x,
                cached_y: state.cached_y,
                cached_margin: state.cached_margin,
                cached_hash: state.shape_hash,
                in_gesture: state.defer_rebuild,
                gesture_start_w: state.gesture_start_w,
                gesture_start_h: state.gesture_start_h,
            };

            match decide(&snap, &win) {
                Decision::Hide => {
                    hide_shadow(state);
                    state.hidden = true;
                }
                Decision::NoChange => {}
                Decision::MoveOnly => {
                    move_shadow(state, win.x, win.y);
                    state.cached_x = win.x;
                    state.cached_y = win.y;
                    state.hidden = false;
                }
                Decision::ScaleDuringGesture => {
                    // 尺寸已变：旧 DIB 不能按新尺寸直接提交；用完整位图缩放出的应急
                    // 位图提交，阴影在缩放全程可见。旧 DIB 保留，松手后按最终尺寸重建。
                    if submit_scaled(state, owner_hwnd, &win) {
                        state.suspended = true;
                        state.hidden = false;
                    } else {
                        hide_shadow(state);
                        state.suspended = true;
                        state.hidden = true;
                    }
                }
                Decision::RebuildAndSubmit => {
                    let rgn = CreateRectRgn(0, 0, 0, 0);
                    let applied = if rgn.is_null() {
                        build_bitmap(state, win.win_w, win.win_h, None)
                    } else {
                        let t = GetWindowRgn(owner_hwnd, rgn);
                        let ok = build_bitmap(
                            state,
                            win.win_w,
                            win.win_h,
                            if t > 0 { Some(rgn as isize) } else { None },
                        );
                        DeleteObject(rgn as _);
                        ok
                    };
                    let (exp_w, exp_h) = bitmap_size(win.win_w, win.win_h, win.margin);
                    // 重建后必须校验位图尺寸 == 窗口尺寸 + 2*margin；DIB 失败或尺寸不符
                    // 都不提交，避免留下整块纯色矩形或错位拉伸。
                    if applied
                        && state.hdc_mem != 0
                        && state.bmp_w == exp_w
                        && state.bmp_h == exp_h
                    {
                        state.shape_hash = win.hash;
                        state.cached_margin = win.margin;
                        submit_layered(state, owner_hwnd, &win);
                        state.suspended = false;
                        state.hidden = false;
                        state.cached_x = win.x;
                        state.cached_y = win.y;
                    } else {
                        hide_shadow(state);
                        state.hidden = true;
                    }
                }
            }

            follow_topmost(state, owner_hwnd);
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
            reg.get(&owner).map(|entry| entry.old_proc)
        };
        let Some(old) = old else {
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        };

        // 先让宿主自己的窗口过程（tao / 磁力拖拽子类）处理，再看阴影
        let prev: WNDPROC = std::mem::transmute(old);
        let result = CallWindowProcW(prev, hwnd, msg, wparam, lparam);

        // 阴影伴随窗口被外部销毁时先重建（不在同步取走状态的期间换句柄）。
        if msg != WM_NCDESTROY {
            recreate_shadow_if_invalid(owner);
        }

        match msg {
            WM_WINDOWPOSCHANGED | WM_SIZE | WM_MOVE | WM_SIZING | WM_MOVING
            | WM_SHOWWINDOW | WM_ACTIVATE | WM_DPICHANGED => {
                with_state(owner, |state| {
                    sync_state(state, owner);
                });
            }
            WM_ENTERSIZEMOVE => {
                // 进入系统模态移动 / 缩放循环：记录起始外框宽高；手势内是否真的改尺寸
                // 由 decide 对比。移动只跟随位置；缩放会把完整位图缩放成应急位图提交，
                // 保证手势全程有阴影，松手后再按最终尺寸重建恢复柔和度。
                with_state(owner, |state| {
                    state.defer_rebuild = true;
                    let mut rect: RECT = std::mem::zeroed();
                    if GetWindowRect(owner as _, &mut rect) != 0 {
                        state.gesture_start_w = rect.right - rect.left;
                        state.gesture_start_h = rect.bottom - rect.top;
                    }
                });
            }
            WM_EXITSIZEMOVE => {
                with_state(owner, |state| {
                    // 只有「手势内真的改过尺寸、用过应急缩放位图」才需要强制校准；
                    // 纯移动手势的几何未变，直接按现有位图继续跟随，避免松手瞬间重建闪烁。
                    let was_suspended = state.suspended;
                    state.defer_rebuild = false;
                    state.suspended = false;
                    if was_suspended {
                        state.shape_hash = u64::MAX;
                    }
                    sync_state(state, owner);
                });
            }
            WM_CAPTURECHANGED => {
                // 兜底：少数退出路径可能不投递 WM_EXITSIZEMOVE（取消手势、程序化改尺寸等）。
                // 捕获释放后若仍停留在手势态，按结束手势幂等复位并重新校准；
                // 真实重入与消息到达顺序需原生运行验证（见验收报告）。
                with_state(owner, |state| {
                    if state.defer_rebuild {
                        let was_suspended = state.suspended;
                        state.defer_rebuild = false;
                        state.suspended = false;
                        if was_suspended {
                            state.shape_hash = u64::MAX;
                        }
                        sync_state(state, owner);
                    }
                });
            }
            WM_NCDESTROY => destroy_now(owner),
            _ => {}
        }
        result
    }

    /// 从注册表摘除入口（仅簿记；GDI / 句柄释放见 `release_state`，需原生运行验证）。
    fn registry_take(owner: isize) -> Option<Entry> {
        registry().lock().unwrap_or_else(|e| e.into_inner()).remove(&owner)
    }

    fn destroy_now(owner: isize) {
        let Some(entry) = registry_take(owner) else { return };
        // 先还原宿主过程；正在同步的状态由 with_state 返回后统一释放。
        if entry.old_proc != 0 {
            unsafe { SetWindowLongPtrW(owner as _, GWLP_WNDPROC, entry.old_proc); }
        }
        if let Some(state) = entry.state {
            release_state(state);
        }
    }

    fn release_state(state: State) {
        unsafe {
            if state.shadow != 0 {
                DestroyWindow(state.shadow as _);
            }
            // 与 ensure_dib 同一顺序：DC 先于 DIB，避免删除仍被选中的位图。
            if state.hdc_mem != 0 {
                DeleteDC(state.hdc_mem as _);
            }
            if state.dib != 0 {
                DeleteObject(state.dib as _);
            }
            // 应急位图与完整位图同样按「先 DC、后 DIB」释放。
            if state.gesture_hdc != 0 {
                DeleteDC(state.gesture_hdc as _);
            }
            if state.gesture_dib != 0 {
                DeleteObject(state.gesture_dib as _);
            }
        }
    }

    /// 创建阴影伴随窗口（分层、点击穿透、不抢焦点）。失败返回 0。
    unsafe fn create_shadow_window() -> isize {
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
            0
        } else {
            shadow as isize
        }
    }

    /// 阴影窗口被外部销毁 / HWND 失效时重建，并把 Entry 与 State 的句柄保持一致。
    ///
    /// 只在「状态未被同步取出」时交换：同步期间（`state.is_none()`）直接放弃，
    /// 由下一次同步再补，避免 `with_state` 把新句柄当成「宿主已销毁」而误释放。
    fn recreate_shadow_if_invalid(owner: isize) {
        let invalid = {
            let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
            match reg.get(&owner) {
                Some(entry) => {
                    entry.shadow == 0 || unsafe { IsWindow(entry.shadow as _) } == 0
                }
                None => return,
            }
        };
        if !invalid {
            return;
        }
        let fresh = unsafe { create_shadow_window() };
        if fresh == 0 {
            return;
        }
        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = reg.get_mut(&owner) else {
            drop(reg);
            unsafe { DestroyWindow(fresh as _) };
            return;
        };
        let Some(state) = entry.state.as_mut() else {
            // 同步进行中：不在此处换句柄，下一次同步再重建。
            drop(reg);
            unsafe { DestroyWindow(fresh as _) };
            return;
        };
        if entry.shadow != 0 && unsafe { IsWindow(entry.shadow as _) } != 0 {
            // 竞态下别人已重建：保留现有，丢弃本次。
            drop(reg);
            unsafe { DestroyWindow(fresh as _) };
            return;
        }
        if entry.shadow != 0 {
            unsafe { DestroyWindow(entry.shadow as _) };
        }
        entry.shadow = fresh;
        state.shadow = fresh;
        // 新窗口没有位图内容：几何缓存全部作废，下一次同步按当前窗口重建。
        state.bmp_w = 0;
        state.bmp_h = 0;
        state.cached_x = 0;
        state.cached_y = 0;
        state.cached_margin = 0;
        state.shape_hash = u64::MAX;
        state.hidden = true;
        state.suspended = false;
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
            let shadow = create_shadow_window();
            if shadow == 0 {
                return;
            }
            let old = SetWindowLongPtrW(
                owner as _,
                GWLP_WNDPROC,
                owner_proc as *const () as isize,
            );
            if old == 0 {
                DestroyWindow(shadow as _);
                return;
            }
            let state = State {
                shadow,
                hdc_mem: 0,
                dib: 0,
                bits: std::ptr::null_mut(),
                bmp_w: 0,
                bmp_h: 0,
                margin: (params().margin * 1.25).round() as i32,
                scale: 1.0,
                shape_hash: u64::MAX,
                topmost: false,
                defer_rebuild: false,
                gesture_start_w: 0,
                gesture_start_h: 0,
                suspended: false,
                gesture_hdc: 0,
                gesture_dib: 0,
                gesture_bits: std::ptr::null_mut(),
                gesture_w: 0,
                gesture_h: 0,
                hidden: true,
                cached_x: 0,
                cached_y: 0,
                cached_margin: 0,
                mask: Vec::new(),
                tmp: Vec::new(),
                ambient: Vec::new(),
                contact: Vec::new(),
            };
            registry()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(owner, Entry { old_proc: old, shadow, state: Some(state) });
            with_state(owner, |state| sync_state(state, owner));
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
        with_state(hwnd, |state| {
            state.shape_hash = u64::MAX;
            sync_state(state, hwnd);
        });
    }

    pub fn detach(hwnd: isize) {
        destroy_now(hwnd);
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn insert_test_state(owner: isize) {
            let state = State {
                shadow: 0, hdc_mem: 0, dib: 0, bits: std::ptr::null_mut(),
                bmp_w: 0, bmp_h: 0, margin: 0, scale: 1.0, shape_hash: 0,
                topmost: false, defer_rebuild: false,
                gesture_start_w: 0, gesture_start_h: 0,
                suspended: false, hidden: true,
                gesture_hdc: 0, gesture_dib: 0, gesture_bits: std::ptr::null_mut(),
                gesture_w: 0, gesture_h: 0,
                cached_x: 0, cached_y: 0, cached_margin: 0,
                mask: Vec::new(), tmp: Vec::new(), ambient: Vec::new(), contact: Vec::new(),
            };
            registry().lock().unwrap().insert(owner, Entry {
                old_proc: 123, shadow: 0, state: Some(state),
            });
        }

        #[test]
        fn sync_reentry_keeps_window_proc_without_locking_or_double_update() {
            let owner = -101;
            insert_test_state(owner);
            with_state(owner, |state| {
                // 对应 SetWindowPos 同步回调：不能持锁，原过程必须仍可查询。
                let reg = registry().try_lock().expect("原生调用期间不能持注册表锁");
                assert_eq!(reg.get(&owner).unwrap().old_proc, 123);
                drop(reg);
                with_state(owner, |_| panic!("同一阴影的重入更新必须合并"));
                state.defer_rebuild = true;
            });
            let entry = registry().lock().unwrap().remove(&owner).unwrap();
            assert!(entry.state.unwrap().defer_rebuild);
        }

        #[test]
        fn destroy_during_sync_does_not_resurrect_shadow_state() {
            let owner = -102;
            insert_test_state(owner);
            with_state(owner, |_| {
                // WM_NCDESTROY 在同步回调中摘除入口；外层不得插回已销毁的状态。
                registry().lock().unwrap().remove(&owner);
            });
            assert!(!registry().lock().unwrap().contains_key(&owner));
        }

        #[test]
        fn interior_alpha_is_zero_and_exterior_keeps_decay() {
            let p = ShadowParams::defaults();
            // 窗口轮廓内（inside=1）：即使两层模糊都处于峰值，合成 alpha 也必须为 0，
            // 否则阴影窗口一旦被抬到宿主之上就会整片压暗窗口内容。
            assert_eq!(pixel_alpha(1.0, 1.0, 1.0, &p), 0.0);
            // 轮廓外（inside=0）：峰值仍是 0.14 + 0.08。
            assert!((pixel_alpha(1.0, 1.0, 0.0, &p) - 0.22).abs() < 1e-6);
            // 边界过渡（inside=0.5）：只保留一半，避免整窗归零后出现硬边。
            assert!((pixel_alpha(1.0, 1.0, 0.5, &p) - 0.11).abs() < 1e-6);
        }

        #[test]
        fn defaults_are_the_shipping_values() {
            let p = parse_params(|_| None);
            assert_eq!(p.margin, 40.0);
            assert_eq!(p.ambient_blur, 18.0);
            assert!((p.ambient_alpha - 0.14).abs() < 1e-6);
            assert_eq!(p.contact_blur, 5.0);
            assert!((p.contact_alpha - 0.08).abs() < 1e-6);
            assert_eq!(p.offset_y, 3.0);
            assert_eq!(p.color, (17.0, 26.0, 44.0));
        }

        #[test]
        fn env_override_parses_and_clamps() {
            let lookup = |k: &str| match k {
                "TASK_DOCK_SHADOW_MARGIN" => Some("52".into()),
                "TASK_DOCK_SHADOW_AMBIENT_BLUR" => Some("25".into()),
                "TASK_DOCK_SHADOW_AMBIENT_ALPHA" => Some("0.20".into()),
                "TASK_DOCK_SHADOW_CONTACT_ALPHA" => Some("9".into()), // 超界 → 0.6
                "TASK_DOCK_SHADOW_OFFSET_Y" => Some("bad".into()),    // 非法 → 默认 3
                _ => None,
            };
            let p = parse_params(lookup);
            assert_eq!(p.margin, 52.0);
            assert_eq!(p.ambient_blur, 25.0);
            assert!((p.ambient_alpha - 0.20).abs() < 1e-6);
            assert_eq!(p.contact_alpha, 0.6);
            assert_eq!(p.contact_blur, 5.0);
            assert_eq!(p.offset_y, 3.0);
        }

        fn visible_win(win_w: i32, win_h: i32, margin: i32, hash: u64, x: i32, y: i32) -> WindowSnapshot {
            WindowSnapshot {
                visible: true,
                iconic: false,
                zoomed: false,
                x,
                y,
                win_w,
                win_h,
                margin,
                hash,
            }
        }

        fn base_snap() -> ShadowSnapshot {
            ShadowSnapshot {
                cached_w: 480,
                cached_h: 640,
                cached_x: 100,
                cached_y: 120,
                cached_margin: 40,
                cached_hash: 7,
                in_gesture: false,
                gesture_start_w: 400,
                gesture_start_h: 560,
            }
        }

        #[test]
        fn bitmap_dimensions_match_window_size() {
            assert_eq!(bitmap_size(400, 560, 40), (480, 640));
            assert_eq!(bitmap_size(1, 1, 16), (33, 33));
            assert_eq!(bitmap_size(640, 360, 32), (704, 424));
        }

        #[test]
        fn pure_move_does_not_trigger_rebuild() {
            let snap = base_snap();
            let win = visible_win(400, 560, 40, 7, 140, 160);
            assert_eq!(decide(&snap, &win), Decision::MoveOnly);
            // 手势内纯移动同样不得重建 / 重提交。
            let mut snap_g = snap;
            snap_g.in_gesture = true;
            assert_eq!(decide(&snap_g, &win), Decision::MoveOnly);
        }

        #[test]
        fn unchanged_geometry_is_no_change() {
            let snap = base_snap();
            let win = visible_win(400, 560, 40, 7, 100, 120);
            assert_eq!(decide(&snap, &win), Decision::NoChange);
        }

        #[test]
        fn size_change_in_gesture_scales_instead_of_hiding() {
            let mut snap = base_snap();
            snap.in_gesture = true;
            // 拖宽到 460：新位图应为 540 宽，但旧完整位图仍是 480。
            let win = visible_win(460, 560, 40, 7, 100, 120);
            // 手势内尺寸变化 → 缩放应急位图，阴影全程可见（不再隐藏挂起）。
            assert_eq!(decide(&snap, &win), Decision::ScaleDuringGesture);
            // 该决策不得退化成「直接重建」或「只移动」，否则要么卡顿要么丢失阴影。
            assert!(!matches!(
                decide(&snap, &win),
                Decision::RebuildAndSubmit | Decision::MoveOnly | Decision::Hide
            ));
        }

        #[test]
        fn size_change_outside_gesture_rebuilds_and_submits() {
            let snap = base_snap();
            let win = visible_win(460, 560, 40, 7, 100, 120);
            assert_eq!(decide(&snap, &win), Decision::RebuildAndSubmit);
        }

        #[test]
        fn resize_end_can_restore_shadow() {
            // 手势结束后（in_gesture=false）、位图仍为旧尺寸：必须走重建提交。
            let snap = base_snap();
            let win = visible_win(460, 560, 40, 7, 100, 120);
            assert_eq!(decide(&snap, &win), Decision::RebuildAndSubmit);
        }

        #[test]
        fn consecutive_resizes_use_scale_then_rebuild() {
            // 手势 1：400→460 缩放应急位图；结束重建到 460（缓存 540x640）；手势 2：460→500 再缩放。
            let g1 = visible_win(460, 560, 40, 7, 0, 0);
            let snap1 = ShadowSnapshot { in_gesture: true, ..base_snap() };
            assert_eq!(decide(&snap1, &g1), Decision::ScaleDuringGesture);

            let after_rebuild = ShadowSnapshot {
                cached_w: 540,
                cached_h: 640,
                gesture_start_w: 460,
                gesture_start_h: 560,
                ..base_snap()
            };
            let g2 = visible_win(500, 560, 40, 7, 0, 0);
            let snap2 = ShadowSnapshot { in_gesture: true, ..after_rebuild };
            // 第二次手势的缩放源必须是刚重建的 540x640 完整位图，而不是第一次的应急位图。
            assert_eq!(decide(&snap2, &g2), Decision::ScaleDuringGesture);
        }

        #[test]
        fn hidden_minimized_zoomed_windows_hide_shadow() {
            let snap = base_snap();
            let mut win = visible_win(400, 560, 40, 7, 100, 120);
            win.iconic = true;
            assert_eq!(decide(&snap, &win), Decision::Hide);
            let mut win2 = visible_win(400, 560, 40, 7, 100, 120);
            win2.zoomed = true;
            assert_eq!(decide(&snap, &win2), Decision::Hide);
            let mut win3 = visible_win(400, 560, 40, 7, 100, 120);
            win3.visible = false;
            assert_eq!(decide(&snap, &win3), Decision::Hide);
        }

        #[test]
        fn detach_registry_bookkeeping_leaves_no_entry() {
            for owner in [-301isize, -302] {
                insert_test_state(owner);
                // 与 destroy_now 同一注册表摘除路径；GDI / 句柄释放需原生运行验证。
                assert!(registry_take(owner).is_some());
                assert!(!registry().lock().unwrap().contains_key(&owner));
            }
            assert!(registry().lock().unwrap().is_empty());
        }
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
