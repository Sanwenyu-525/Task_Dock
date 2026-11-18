//! 投屏窗口一体化布局（纯函数，无 Win32 依赖，全部可单测）。
//!
//! 架构（方案 A，经真机 PoC 验证）：
//! - 顶层窗口仍是 scrcpy 原生窗口（标题/图标/AUMID 品牌化保持不变）；
//! - TaskDock 的导航 WebView 作为 `WS_CHILD` 挂进 scrcpy ClientRect，
//!   生命周期/遮挡/最小化跟随父窗口，不再有独立置顶顶层窗口；
//! - scrcpy 视频在其 ClientRect 内按纵横比居中渲染（letterbox 为纯黑），
//!   因此把 ClientRect 宽度扩为「视频宽 + 导航列 + Tooltip 余量」，导航列
//!   覆盖右侧 letterbox，Tooltip 可向左溢出到 letterbox 区，永不遮挡视频。
//!
//! 尺寸均为物理像素（Windows API 口径），逻辑值乘 DPI scale 换算；
//! 前端 CSS 侧直接使用同源逻辑常量（CSS px 随 DPR 自动缩放）。

/// 导航列逻辑常量（CSS px 口径，与 projection-controls.css 保持同源）。
pub const NAV_COLUMN_LOGICAL: f64 = 88.0;
/// 导航 WebView 里给 Tooltip 向左溢出预留的逻辑宽度（区域为 letterbox 黑边，不遮视频）。
pub const TOOLTIP_PAD_LOGICAL: f64 = 104.0;
/// 按钮点击区（逻辑 px）。
pub const NAV_BUTTON_LOGICAL: f64 = 52.0;
/// 按钮间距（逻辑 px）。
pub const NAV_GAP_LOGICAL: f64 = 8.0;
/// 导航条内边距（逻辑 px）。
pub const NAV_PADDING_LOGICAL: f64 = 12.0;
/// 视频区域最小逻辑尺寸：不允许视频被无限压缩。
pub const MIN_VIDEO_SIDE_LOGICAL: f64 = 260.0;
/// Side 布局模式切换的迟滞系数（避免 resize 抖动反复横跳）。
pub const MODE_HYSTERESIS: f64 = 0.96;
/// 窗口边框估算（逻辑 px）：GetWindowRect - GetClientRect 的典型值。
pub const FRAME_W_LOGICAL: f64 = 16.0;
pub const FRAME_H_LOGICAL: f64 = 40.0;
/// Bottom 模式导航条上方给 Tooltip 溢出预留的逻辑高度。
pub const BOTTOM_TOOLTIP_PAD_LOGICAL: f64 = 24.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayoutSize {
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayoutRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl LayoutRect {
    pub fn right(&self) -> f64 {
        self.x + self.w
    }
    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionLayoutMode {
    /// 视频居中 + 右侧导航列（默认）。
    Side,
    /// 窗口过窄时：视频占满宽度 + 底部导航条。
    Bottom,
    /// 极窄且高度受限：导航列悬浮在视频右缘之上。
    Compact,
}

impl ProjectionLayoutMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProjectionLayoutMode::Side => "side",
            ProjectionLayoutMode::Bottom => "bottom",
            ProjectionLayoutMode::Compact => "compact",
        }
    }
}

/// 布局所需的真实能力（与前端 `ProjectionCapabilities` 对齐的子集）。
///
/// 导航按钮**禁用时仍然显示**（给出原因），因此只有「是否显示分隔线」等
/// 排版差异才依赖能力；当前排版对能力不敏感，保留参数以满足后续扩展。
#[derive(Debug, Clone, Copy, Default)]
pub struct ProjectionLayoutCapabilities {
    pub back: bool,
    pub home: bool,
    pub recents: bool,
    pub screenshot: bool,
    pub close: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProjectionLayout {
    /// 视频实际渲染矩形（scrcpy 居中 letterbox 口径，ClientRect 坐标，物理 px）。
    pub video_rect: LayoutRect,
    /// 导航 WebView 子窗口矩形（含 Tooltip 溢出区，ClientRect 坐标，物理 px）。
    pub navigation_rect: LayoutRect,
    pub layout_mode: ProjectionLayoutMode,
}

pub fn dpi_scale(dpi: u32) -> f64 {
    if dpi == 0 {
        1.0
    } else {
        dpi as f64 / 96.0
    }
}

/// 导航列物理宽（不含 Tooltip 溢出区）。
pub fn nav_column_physical(dpi: u32) -> f64 {
    NAV_COLUMN_LOGICAL * dpi_scale(dpi)
}

/// 导航 WebView 物理宽 = 导航列 + Tooltip 溢出区。
pub fn nav_webview_physical(dpi: u32) -> f64 {
    (NAV_COLUMN_LOGICAL + TOOLTIP_PAD_LOGICAL) * dpi_scale(dpi)
}

/// Side 模式需要的 ClientRect 宽度：视频宽 + 2 × (导航列 + Tooltip 溢出区)。
///
/// 对称留空的左右 letterbox 使 scrcpy 居中视频两侧黑边等宽，
/// 导航列与 Tooltip 溢出区都落在右侧 letterbox 内，绝不遮挡视频。
pub fn side_client_width(video: LayoutSize, client_h: f64, dpi: u32) -> f64 {
    let video_w = video_width_at_height(video, client_h);
    video_w + 2.0 * nav_webview_physical(dpi)
}

/// 给定高度下按纵横比缩放的视频宽。
pub fn video_width_at_height(video: LayoutSize, height: f64) -> f64 {
    if video.h <= 0.0 {
        return height;
    }
    height * (video.w / video.h)
}

/// 给定宽度下按纵横比缩放的视频高。
pub fn video_height_at_width(video: LayoutSize, width: f64) -> f64 {
    if video.w <= 0.0 {
        return width;
    }
    width * (video.h / video.w)
}

/// Side 是否适用于当前 ClientRect：宽度足够容纳视频（按当前高度缩放）
/// 加两侧导航留空，且视频宽不低于最小值。
pub fn should_use_side_layout(
    client: LayoutSize,
    video: LayoutSize,
    dpi: u32,
    max_client_w: Option<f64>,
) -> bool {
    let needed = side_client_width(video, client.h, dpi);
    let fits_window = client.w + f64::MAX * 0.0 >= needed * MODE_HYSTERESIS;
    let fits_monitor = max_client_w.map(|max| needed <= max).unwrap_or(true);
    fits_window && fits_monitor && video_width_at_height(video, client.h) >= MIN_VIDEO_SIDE_LOGICAL * dpi_scale(dpi)
}

/// Bottom 是否适用：宽度不足以走 Side，但高度还有增长空间
/// （视频改为占满宽度，导航条落到视频下方）。
pub fn should_use_bottom_layout(
    client: LayoutSize,
    video: LayoutSize,
    dpi: u32,
    max_client_h: Option<f64>,
) -> bool {
    if should_use_side_layout(client, video, dpi, None) {
        return false;
    }
    let needed_h = bottom_client_height(video, client.w, dpi);
    max_client_h.map(|max| needed_h <= max).unwrap_or(true)
}

/// Bottom 模式导航条物理高（横向单行）。
pub fn bottom_bar_physical(dpi: u32) -> f64 {
    (NAV_BUTTON_LOGICAL + 2.0 * NAV_PADDING_LOGICAL) * dpi_scale(dpi)
}

/// Bottom 模式导航条上方的 Tooltip 余量物理高。
pub fn bottom_tooltip_pad_physical(dpi: u32) -> f64 {
    BOTTOM_TOOLTIP_PAD_LOGICAL * dpi_scale(dpi)
}

/// Bottom 模式导航条带（条 + Tooltip 余量）物理高。
pub fn bottom_strip_physical(dpi: u32) -> f64 {
    bottom_bar_physical(dpi) + bottom_tooltip_pad_physical(dpi)
}

/// Bottom 模式需要的 ClientRect 高度。
///
/// scrcpy 把视频在 ClientRect 内**居中**渲染：给足 `2 × 条带` 的纵向余量后，
/// 居中视频恰好「上边贴条带顶、下边贴条带底」，导航条与视频互不重叠。
pub fn bottom_client_height(video: LayoutSize, client_w: f64, dpi: u32) -> f64 {
    video_height_at_width(video, client_w) + 2.0 * bottom_strip_physical(dpi)
}

/// Side 模式窗口目标尺寸（含边框估算）：宽度吸附为精确值，高度保留用户值。
pub fn calculate_side_window_size(
    client: LayoutSize,
    video: LayoutSize,
    dpi: u32,
) -> LayoutSize {
    let scale = dpi_scale(dpi);
    LayoutSize {
        w: side_client_width(video, client.h, dpi) + FRAME_W_LOGICAL * scale,
        h: client.h + FRAME_H_LOGICAL * scale,
    }
}

/// Bottom 模式窗口目标尺寸：高度吸附为精确值，宽度保留用户值。
pub fn calculate_bottom_window_size(
    client: LayoutSize,
    video: LayoutSize,
    dpi: u32,
) -> LayoutSize {
    let scale = dpi_scale(dpi);
    LayoutSize {
        w: client.w + FRAME_W_LOGICAL * scale,
        h: bottom_client_height(video, client.w, dpi) + FRAME_H_LOGICAL * scale,
    }
}

/// 投屏窗口最小尺寸（外窗，物理 px）。
///
/// Side：视频最小宽 + 2 × 导航留空 + 边框；高度至少容纳最小视频高。
/// Bottom 需要的横向最小与 Side 一致（宽度决定模式），不再单独放宽。
pub fn calculate_min_projection_window_size(video: LayoutSize, dpi: u32) -> LayoutSize {
    let scale = dpi_scale(dpi);
    let min_video_w = MIN_VIDEO_SIDE_LOGICAL * scale;
    let min_video_h = video_height_at_width(video, min_video_w).max(MIN_VIDEO_SIDE_LOGICAL * scale);
    LayoutSize {
        w: min_video_w + 2.0 * nav_webview_physical(dpi) + FRAME_W_LOGICAL * scale,
        h: min_video_h.max(bottom_strip_physical(dpi) * 2.0) + FRAME_H_LOGICAL * scale,
    }
}

/// 核心布局：给定窗口 ClientRect、视频真实尺寸、DPI 与能力，输出两个子区域矩形。
///
/// 模式判定顺序：Side → Bottom → Compact（见 should_use_* 函数）。
/// 所有矩形都在 ClientRect 内，不横向溢出；视频区域不会低于最小值
/// （Compact 用悬浮导航代替继续压缩视频）。
pub fn calculate_projection_layout(
    window_size: LayoutSize,
    video: LayoutSize,
    dpi: u32,
    capabilities: ProjectionLayoutCapabilities,
    constraints: ProjectionLayoutConstraints,
) -> ProjectionLayout {
    let scale = dpi_scale(dpi);
    let nav_w = nav_column_physical(dpi);
    let webview_w = nav_webview_physical(dpi);
    let _ = capabilities; // 当前排版与按钮能力无关（禁用仍显示）；保留扩展点。

    if should_use_side_layout(window_size, video, dpi, constraints.max_client_w) {
        let video_w = video_width_at_height(video, window_size.h);
        let video_rect = LayoutRect {
            x: ((window_size.w - video_w) / 2.0).max(0.0),
            y: 0.0,
            w: video_w,
            h: window_size.h,
        };
        let navigation_rect = LayoutRect {
            x: (window_size.w - webview_w).max(0.0),
            y: 0.0,
            w: webview_w.min(window_size.w),
            h: window_size.h,
        };
        ProjectionLayout {
            video_rect,
            navigation_rect,
            layout_mode: ProjectionLayoutMode::Side,
        }
    } else if should_use_bottom_layout(window_size, video, dpi, constraints.max_client_h) {
        // Bottom：视频按 scrcpy 实际口径 scale-to-fit 整个 ClientRect 后居中
        // （watcher 随后会把窗口高度吸到 bottom_client_height，让视频占满宽度）；
        // 过渡态（高度还没长出来）时导航条可能暂时压住视频下缘，属已知过渡。
        let video_rect = fit_centered(video, window_size);
        let strip_h = bottom_strip_physical(dpi);
        let navigation_rect = LayoutRect {
            x: 0.0,
            y: (window_size.h - strip_h).max(0.0),
            w: window_size.w,
            h: strip_h.min(window_size.h),
        };
        ProjectionLayout {
            video_rect,
            navigation_rect,
            layout_mode: ProjectionLayoutMode::Bottom,
        }
    } else {
        // Compact：窗口不再扩大，导航列悬浮在视频右缘（玻璃底）。
        // 视频保持 scrcpy 的 scale-to-fit 居中口径，纵横比不破坏。
        let video_rect = fit_centered(video, window_size);
        let navigation_rect = LayoutRect {
            x: (window_size.w - nav_w).max(0.0),
            y: 0.0,
            w: nav_w,
            h: window_size.h,
        };
        ProjectionLayout {
            video_rect,
            navigation_rect,
            layout_mode: ProjectionLayoutMode::Compact,
        }
    }
}

/// scrcpy 的实际渲染口径：视频在 ClientRect 内等比缩放到「恰好放下」后居中。
/// Side 模式宽度由布局吸附保证视频满高，这里用于 Bottom/Compact 的任意过渡态。
fn fit_centered(video: LayoutSize, client: LayoutSize) -> LayoutRect {
    if video.w <= 0.0 || video.h <= 0.0 || client.w <= 0.0 || client.h <= 0.0 {
        return LayoutRect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 };
    }
    let scale = (client.w / video.w).min(client.h / video.h);
    let w = video.w * scale;
    let h = video.h * scale;
    LayoutRect {
        x: (client.w - w) / 2.0,
        y: (client.h - h) / 2.0,
        w,
        h,
    }
}

/// 布局外约束（来自显示器工作区/最大化状态），由调用方按真实 monitor 提供。
#[derive(Debug, Clone, Copy, Default)]
pub struct ProjectionLayoutConstraints {
    pub max_client_w: Option<f64>,
    pub max_client_h: Option<f64>,
}

