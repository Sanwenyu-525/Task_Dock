// 工作台窗口级圆角/边框的运行时同步（唯一入口）。
//
// 背景：workspace 窗口 `decorations(false)` + `shadow(false)`，窗口外形由
// Win32 区域裁剪（Rust `window_shape`）+ `.wb-root` 的 CSS 弧共同定义。
// 两者必须使用**同一个逻辑半径**，否则原生区域会切进 CSS 抗锯齿弧（硬边）
// 或留下比可见弧更大的透明角（阴影/桌面从缝里透出）。
//
// 半径来源与主窗口一致：视觉预设的 `--radius-window`（styles-themes.css：
// 梦幻渐变 18px / 液态玻璃 20px），由前端读出后经 IPC 下发给 Rust
// （`set_workspace_window_radius`），与主窗 `apply_window_radius` 同一口径，
// 不新增第三套圆角规范。
//
// 另外把「是否最大化」写到 <html data-window-maximized>：最大化按 Windows
// 原生直角铺满工作区，圆角会在屏幕边缘留缝隙。
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const RADIUS_TOKEN = "--radius-window";
const FALLBACK_RADIUS = 18;

/** 读取当前预设的窗口圆角（CSS px）；取不到时用默认预设值。 */
export function readWindowRadiusCss(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(RADIUS_TOKEN)
    .trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 ? value : FALLBACK_RADIUS;
}

function currentWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    // 浏览器预览 / 单测：没有窗口 API，样式仍按默认半径渲染
    return null;
  }
}

function pushRadius(radius: number): void {
  try {
    void invoke("set_workspace_window_radius", { radius }).catch(() => {
      // 非 Tauri 环境或窗口尚未就绪：CSS 弧仍然正确，只是没有原生裁剪
    });
  } catch {
    // invoke 同步抛错（极端情况）：同上，降级为纯 CSS
  }
}

function markMaximized(win: ReturnType<typeof getCurrentWindow>): void {
  void win
    .isMaximized()
    .then((value) => {
      document.documentElement.dataset.windowMaximized = value ? "true" : "false";
    })
    .catch(() => {});
}

/**
 * 初始化工作台窗口外观同步，返回取消订阅函数（页面卸载时调用）。
 * 幂等：重复调用只会多一个监听，不会重复注册；调用方只调用一次。
 */
export function initWorkbenchWindowFrame(): () => void {
  const win = currentWindow();
  const disposers: Array<() => void> = [];

  // 1) 半径：初始一次 + 预设/主题变化后重算（预设切换会改 --radius-window）
  let lastRadius = readWindowRadiusCss();
  pushRadius(lastRadius);
  if (typeof MutationObserver === "function") {
    const observer = new MutationObserver(() => {
      const radius = readWindowRadiusCss();
      if (radius === lastRadius) return;
      lastRadius = radius;
      pushRadius(radius);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-preset", "data-theme", "data-material"],
    });
    disposers.push(() => observer.disconnect());
  }

  // 2) 最大化 → 窗口级圆角/边框开关（CSS 与 Rust 区域同源）
  if (win) {
    markMaximized(win);
    let stop: (() => void) | null = null;
    void win
      .onResized(() => markMaximized(win))
      .then((unlisten) => {
        stop = unlisten;
      })
      .catch(() => {});
    disposers.push(() => stop?.());
  }

  return () => {
    for (const dispose of disposers) dispose();
  };
}
