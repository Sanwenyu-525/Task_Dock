// 工作台窗口级圆角/边框的运行时同步（唯一入口）。
//
// 背景：workspace 窗口 `decorations(false)` + `shadow(false)`，窗口外形由
// Win32 区域裁剪（Rust `window_shape`）+ `.wb-root` 的 CSS 弧共同定义。
// 两者必须使用**同一个逻辑半径与同一条角部曲线**，否则原生区域会切进 CSS
// 抗锯齿弧（硬边）或留下比可见弧更大的透明角（阴影/桌面从缝里透出）。
//
// 半径来源与主窗口一致：视觉预设的 `--radius-window`（styles-themes.css：
// 梦幻渐变 18px / 液态玻璃 20px），由前端读出后经 IPC 下发给 Rust
// （`set_workspace_window_radius`），与主窗 `apply_window_radius` 同一口径，
// 不新增第三套圆角规范。
//
// 第二轮：苹果式连续圆角（CSS `corner-shape: superellipse(K)`）。
// - `K` 是 CSS 规范参数，**数学指数是 n = 2^K**（Chromium 实测：K=1→n=2、
//   2→n=4、3→n=8、4→n=16、8→n=64，`squircle` 关键字等价于 K=2）。
//   因此苹果式 squircle 必须写 `superellipse(2)`，Rust 侧用 n=4；早期实现把
//   K 当成 n 直接写 `superellipse(4)`（= n=16，几乎方形），与原生 n=4 裁剪
//   不一致，原生会把 CSS 更方的角部切掉，表现为圆角阶梯与 1px 边框断裂。
// - WebView2 支持时：CSS 与 Rust 同时用 n=4，并把名义半径 +4px 补偿超椭圆
//   在同半径下"更方"的观感（18→22 / 20→24，与 CSS 用同一个计算值）；
// - 不支持时：指数回落 2、补偿回落 0，视觉与第一轮圆弧完全一致（不引入不一致）。
//
// 另外把「是否最大化」写到 <html data-window-maximized>：最大化按 Windows
// 原生直角铺满工作区，圆角会在屏幕边缘留缝隙。
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const RADIUS_TOKEN = "--radius-window";
const FALLBACK_RADIUS = 18;
/**
 * CSS `superellipse(K)` 的参数 K（规范语义）。K=2 = 苹果式 squircle（n=4）。
 * 注意：K **不是**数学指数，n = 2^K；两个概念分开命名，避免再次混用。
 */
export const CONTINUOUS_CORNER_CSS_K = 2;
/** 数学指数 n = 2^K = 4（Rust `window_shape` 与 CSS 渲染同一条曲线）。 */
export const CONTINUOUS_CORNER_EXPONENT = 2 ** CONTINUOUS_CORNER_CSS_K;
/** 超椭圆的名义半径补偿（CSS px）：同半径下超椭圆看起来更"方"，补回圆润度。 */
export const CONTINUOUS_CORNER_EXTRA = 4;

/** CSS 里实际书写的能力探测/声明值，保证检测与绘制用同一个 K。 */
export const CONTINUOUS_CORNER_CSS_VALUE = `superellipse(${CONTINUOUS_CORNER_CSS_K})`;

/** 读取当前预设的窗口圆角（CSS px）；取不到时用默认预设值。 */
export function readWindowRadiusCss(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(RADIUS_TOKEN)
    .trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value >= 0 ? value : FALLBACK_RADIUS;
}

/** 当前 WebView2 是否支持 `corner-shape: superellipse(K)`（能力检测，不猜版本号）。 */
export function supportsContinuousCorners(): boolean {
  try {
    const api = typeof CSS !== "undefined" ? CSS : undefined;
    return Boolean(api?.supports?.("corner-shape", CONTINUOUS_CORNER_CSS_VALUE));
  } catch {
    return false;
  }
}

/**
 * 圆角方案：CSS 的半径（含补偿）与 Rust 的指数/半径必须来自同一处计算。
 * - `cssK`：写进 CSS 的 `corner-shape: superellipse(K)` 参数；
 * - `exponent`：Rust 原生曲线数学指数（= 2^cssK）；
 * - `radius`：最终 CSS px；`extra` 只用于写 `--wb-corner-extra`。
 */
export function windowCornerPlan(
  baseRadius: number,
  squircleSupported: boolean,
): { radius: number; cssK: number; exponent: number; extra: number; squircle: boolean } {
  const base = Number.isFinite(baseRadius) && baseRadius >= 0 ? baseRadius : FALLBACK_RADIUS;
  const squircle = squircleSupported;
  const extra = squircle ? CONTINUOUS_CORNER_EXTRA : 0;
  return {
    radius: base + extra,
    cssK: squircle ? CONTINUOUS_CORNER_CSS_K : 1,
    exponent: squircle ? CONTINUOUS_CORNER_EXPONENT : 2,
    extra,
    squircle,
  };
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

function pushCorner(exponent: number): void {
  try {
    void invoke("set_workspace_window_corner", { corner: exponent }).catch(() => {
      // 同上：CSS 侧仍按已生效的 capability 结果渲染
    });
  } catch {
    // 同上
  }
}

/**
 * 把方案写到 DOM：`--wb-corner-extra` 让 CSS 的 `border-radius` 与下发给 Rust 的
 * 半径是同一个值；`data-window-corner` 只控制是否启用 `corner-shape`。
 */
function applyCornerPlan(plan: ReturnType<typeof windowCornerPlan>): void {
  const root = document.documentElement;
  root.style.setProperty("--wb-corner-extra", `${plan.extra}px`);
  root.dataset.windowCorner = plan.squircle ? "squircle" : "circle";
}

/**
 * 半径与曲线的同步顺序：先落曲线（此时半径可能还是默认值），再落半径。
 * 最后一次 IPC 一定同时携带最终半径与最终曲线，避免停在「旧半径 + 新曲线」的中间态。
 */
function pushWindowShape(): void {
  const plan = windowCornerPlan(readWindowRadiusCss(), supportsContinuousCorners());
  applyCornerPlan(plan);
  pushCorner(plan.exponent);
  pushRadius(plan.radius);
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

  // 1) 半径 + 曲线：初始一次 + 预设/主题变化后重算（预设切换会改 --radius-window）
  pushWindowShape();
  if (typeof MutationObserver === "function") {
    let lastKey = "";
    const observer = new MutationObserver(() => {
      const plan = windowCornerPlan(readWindowRadiusCss(), supportsContinuousCorners());
      const key = `${plan.radius}/${plan.exponent}`;
      if (key === lastKey) return;
      lastKey = key;
      applyCornerPlan(plan);
      pushCorner(plan.exponent);
      pushRadius(plan.radius);
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
