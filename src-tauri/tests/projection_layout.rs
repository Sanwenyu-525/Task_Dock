//! 投屏窗口布局纯函数测试。
//!
//! 放在集成测试目标而不是 `#[cfg(test)]`：lib 单测 exe 不会获得
//! `emit_test_manifest` 的 Common-Controls v6 清单（cargo 的
//! `rustc-link-arg-tests` 只覆盖集成测试目标），而 `tauri-plugin-dialog`
//! 会把 `comctl32!TaskDialogIndirect` 静态导入带进整个 lib——没有该清单时
//! lib 单测 exe 在加载阶段即 0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND。
//! 集成测试 exe 有清单，可以正常加载整个 lib（见 build.rs 注释）。

use task_dock_lib::commands::projection_layout::{
    bottom_bar_physical, bottom_client_height, calculate_min_projection_window_size,
    calculate_projection_layout, nav_webview_physical, should_use_side_layout,
    side_client_width, video_height_at_width, video_width_at_height, FRAME_H_LOGICAL,
    FRAME_W_LOGICAL, MIN_VIDEO_SIDE_LOGICAL, ProjectionLayoutConstraints, ProjectionLayoutMode,
    ProjectionLayoutCapabilities, LayoutSize,
};

/// 1080×2400 视频（竖屏手机）。
fn portrait() -> LayoutSize {
    LayoutSize { w: 1080.0, h: 2400.0 }
}
/// 2400×1080（横屏）。
fn landscape() -> LayoutSize {
    LayoutSize { w: 2400.0, h: 1080.0 }
}
fn caps() -> ProjectionLayoutCapabilities {
    ProjectionLayoutCapabilities {
        back: true,
        home: true,
        recents: true,
        screenshot: true,
        close: true,
    }
}

#[test]
fn test_projection_layout_side() {
    // 高度 1282（与真机测量一致）时 Side 需要的宽度 = 视频宽 + 2×导航 WebView。
    let client_h = 1282.0;
    let needed = side_client_width(portrait(), client_h, 120);
    let client = LayoutSize { w: needed, h: client_h };
    let layout = calculate_projection_layout(
        client,
        portrait(),
        120,
        caps(),
        ProjectionLayoutConstraints::default(),
    );
    assert_eq!(layout.layout_mode, ProjectionLayoutMode::Side);
    // 视频按纵横比缩放且垂直满高。
    assert!((layout.video_rect.w - video_width_at_height(portrait(), client_h)).abs() < 0.5);
    assert!((layout.video_rect.h - client_h).abs() < 0.5);
    // 视频居中：左右黑边相等。
    let left_gap = layout.video_rect.x;
    let right_gap = client.w - layout.video_rect.right();
    assert!((left_gap - right_gap).abs() < 1.0, "left={left_gap} right={right_gap}");
    // 导航列贴右缘、满高，且不与视频重叠。
    assert!((layout.navigation_rect.right() - client.w).abs() < 0.5);
    assert!(layout.navigation_rect.x >= layout.video_rect.right() - 0.5);
    assert!((layout.navigation_rect.h - client_h).abs() < 0.5);
}

#[test]
fn test_projection_layout_bottom() {
    // 宽度收窄到视频放不下 Side 需求 → Bottom。
    let client = LayoutSize { w: 620.0, h: 900.0 };
    let constraints = ProjectionLayoutConstraints {
        max_client_w: Some(700.0),
        max_client_h: Some(1800.0),
    };
    let layout = calculate_projection_layout(client, portrait(), 120, caps(), constraints);
    assert_eq!(layout.layout_mode, ProjectionLayoutMode::Bottom);
    // 过渡态（高度还没被 watcher 吸附）：视频 scale-to-fit 居中、不越界。
    assert!(layout.video_rect.right() <= client.w + 0.5);
    assert!(layout.video_rect.bottom() <= client.h + 0.5);
    assert!((layout.video_rect.w / layout.video_rect.h - 1080.0 / 2400.0).abs() < 0.01);
    // 导航条在底部、全宽。
    assert!((layout.navigation_rect.right() - client.w).abs() < 0.5);
    assert!((layout.navigation_rect.bottom() - client.h).abs() < 0.5);
    // Bottom 需要的窗口高度不超过约束（可成立）。
    let needed_h = bottom_client_height(portrait(), client.w, 120);
    assert!(needed_h <= 1800.0);
}

#[test]
fn test_projection_layout_bottom_settled_no_overlap() {
    // watcher 完成高度吸附后的稳定态：视频满宽 + 导航条在视频下方，互不重叠。
    let client_w = 620.0;
    let needed_h = bottom_client_height(portrait(), client_w, 120);
    let client = LayoutSize { w: client_w, h: needed_h };
    let layout = calculate_projection_layout(
        client,
        portrait(),
        120,
        caps(),
        ProjectionLayoutConstraints::default(),
    );
    assert_eq!(layout.layout_mode, ProjectionLayoutMode::Bottom);
    assert!((layout.video_rect.w - client_w).abs() < 0.5);
    assert!(layout.navigation_rect.y >= layout.video_rect.bottom() - 0.5);
    assert!(layout.navigation_rect.bottom() <= client.h + 0.5);
}

#[test]
fn test_projection_layout_compact() {
    // 高度也受限（needed_h 超过 max_client_h）→ Compact：导航悬浮在视频右缘。
    let client = LayoutSize { w: 620.0, h: 900.0 };
    let needed_h = bottom_client_height(portrait(), client.w, 120);
    let constraints = ProjectionLayoutConstraints {
        max_client_w: Some(700.0),
        max_client_h: Some(needed_h - 1.0),
    };
    let layout = calculate_projection_layout(client, portrait(), 120, caps(), constraints);
    assert_eq!(layout.layout_mode, ProjectionLayoutMode::Compact);
    // 视频保持完整纵横比（scale-to-fit 居中），导航列贴右缘、不横向溢出。
    assert!((layout.video_rect.w / layout.video_rect.h - 1080.0 / 2400.0).abs() < 0.01);
    assert!(layout.video_rect.right() <= client.w + 0.5);
    assert!(layout.video_rect.bottom() <= client.h + 0.5);
    assert!((layout.navigation_rect.right() - client.w).abs() < 0.5);
}

#[test]
fn test_projection_video_aspect_ratio() {
    let layout = calculate_projection_layout(
        LayoutSize { w: 700.0, h: 1500.0 },
        portrait(),
        96,
        caps(),
        ProjectionLayoutConstraints::default(),
    );
    let rendered = layout.video_rect.w / layout.video_rect.h;
    assert!((rendered - 0.45).abs() < 0.005, "rendered={rendered}");
    let land = calculate_projection_layout(
        LayoutSize { w: 1600.0, h: 900.0 },
        landscape(),
        96,
        caps(),
        ProjectionLayoutConstraints::default(),
    );
    let rendered_land = land.video_rect.w / land.video_rect.h;
    assert!((rendered_land - 2400.0 / 1080.0).abs() < 0.01, "rendered={rendered_land}");
}

#[test]
fn test_projection_navigation_bounds() {
    // 任意输入下：导航矩形必须完整落在 ClientRect 内（无横向/纵向溢出）。
    for client_w in [420.0f64, 700.0, 1160.0, 2400.0] {
        for client_h in [500.0, 1282.0, 2200.0] {
            let client = LayoutSize { w: client_w, h: client_h };
            for dpi in [96u32, 120, 144, 192] {
                let layout = calculate_projection_layout(
                    client,
                    portrait(),
                    dpi,
                    caps(),
                    ProjectionLayoutConstraints::default(),
                );
                assert!(layout.navigation_rect.x >= 0.0);
                assert!(layout.navigation_rect.right() <= client.w + 0.5);
                assert!(layout.navigation_rect.y >= 0.0);
                assert!(layout.navigation_rect.bottom() <= client.h + 0.5);
                assert!(layout.video_rect.right() <= client.w + 0.5);
                assert!(layout.video_rect.bottom() <= client.h + 0.5);
            }
        }
    }
}

#[test]
fn test_projection_dpi_scaling() {
    // 物理尺寸随 DPI 线性缩放。
    let nav_96 = nav_webview_physical(96);
    let nav_144 = nav_webview_physical(144);
    assert!((nav_144 / nav_96 - 1.5).abs() < 0.01);
    let min_96 = calculate_min_projection_window_size(portrait(), 96);
    let min_144 = calculate_min_projection_window_size(portrait(), 144);
    assert!(min_144.w > min_96.w && min_144.h > min_96.h);
    // 最小尺寸下 Side 布局依然成立且视频不低于最小宽度。
    let min_client = LayoutSize {
        w: min_96.w - FRAME_W_LOGICAL,
        h: min_96.h - FRAME_H_LOGICAL,
    };
    let layout = calculate_projection_layout(
        min_client,
        portrait(),
        96,
        caps(),
        ProjectionLayoutConstraints::default(),
    );
    assert_eq!(layout.layout_mode, ProjectionLayoutMode::Side);
    assert!(layout.video_rect.w >= MIN_VIDEO_SIDE_LOGICAL - 1.0);
}

#[test]
fn test_projection_min_window_size_not_fixed_per_device() {
    // 不同纵横比设备的最小高度不同（不是固定值）。
    let portrait_min = calculate_min_projection_window_size(portrait(), 120);
    let square_min = calculate_min_projection_window_size(
        LayoutSize { w: 1600.0, h: 1600.0 },
        120,
    );
    assert!(square_min.h < portrait_min.h, "square={:?} portrait={:?}", square_min, portrait_min);
}

#[test]
fn test_projection_side_requires_enough_width() {
    // 略窄于需求 → 不再是 Side（迟滞系数下）。
    let client_h = 1282.0;
    let needed = side_client_width(portrait(), client_h, 120);
    let narrow = LayoutSize { w: needed * 0.9, h: client_h };
    assert!(!should_use_side_layout(narrow, portrait(), 120, None));
}

#[test]
fn test_projection_video_height_at_width() {
    assert!((video_height_at_width(portrait(), 540.0) - 1200.0).abs() < 0.01);
}
