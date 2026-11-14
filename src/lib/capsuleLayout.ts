//! 分类胶囊几何（纯函数，可单测）。
//!
//! 架构前提（v0.7 分类胶囊重设计）：停靠期间**窗口不移动、不缩放**，
//! 只切换 Win32 区域（`apply_window_capsule` 的 `rail` / `panel`）。
//! 因此这里只需要回答两个问题：
//! 1. 停靠时窗口要多大（容器尺寸）——保证轨道与面板都能完整放下；
//! 2. 窗口应放在哪（贴边齐平 + 胶囊沿边居中）。
//!
//! 尺寸与 `src-tauri/src/window_shape.rs` 的 `CAPSULE_*` 常量是跨端契约
//! （两端各有单测锁定同一组数字）：厚 56、平直主体 300、单侧液态肩部 88
//! （外框 476×56）、面板默认 340×440（2026-11-09 起宽度可在 280–480 拖拽，
//! 窗口按最大 480 预留容器）、间隙 8。外形本身由 `lib/capsuleShape.ts`
//! 唯一定义，本文件只负责**摆放**（容器、贴边位置、区域矩形与轮廓）。
//!
//! 面板尺寸与间隙在 v0.7 方案 B（液态融合翼片）里按参考图重新标定：
//! 参考图中面板宽高比 ≈ 0.72、面板/翼片厚度比 ≈ 4.0、间隙 ≈ 面板宽的 2%（340 × 2.4% ≈ 8）。
//! 336×420 → 340×440 是「按真实桌面尺寸还原布局关系」的结果，不是逐像素抄图。
//!
//! 坐标口径：本文件同时提供 CSS 尺寸常量（供样式与布局引用）与**物理像素**
//! 计算（供 Tauri setPosition 使用），换算只发生在 `capsuleWindowRect` 内。

import type { SnapArea, SnapEdge } from "./edgeSnap";
import {
  WING_AA_INSET,
  WING_LENGTH_CSS,
  WING_SHOULDER_CSS,
  WING_THICKNESS_CSS,
  pointInPolygon,
  wingShape,
  type Point,
} from "./capsuleShape";

/** 轨道厚度（CSS px）：垂直停靠为宽，水平停靠为高。 */
export const RAIL_THICKNESS_CSS = WING_THICKNESS_CSS;
/** 轨道平直主体长度（CSS px，沿边方向）：不含两侧液态肩部。 */
export const RAIL_LENGTH_CSS = WING_LENGTH_CSS;
/** 单侧液态肩部沿边跨度（CSS px）：轨道外框 = 主体长度 + 2×肩宽 = 476。 */
export const RAIL_SHOULDER_CSS = WING_SHOULDER_CSS;
/** 轨道外框沿边尺寸（CSS px，含两侧肩部）：容器沿边方向至少要放下它。 */
export const RAIL_SPAN_CSS = RAIL_LENGTH_CSS + 2 * RAIL_SHOULDER_CSS; // 476

/**
 * 轨道内容组的尺寸契约（CSS px）——与 `styles.css` 的 `.cap-*` 规则同源。
 *
 * 为什么把数字放在这里：胶囊是 Win32 区域裁剪窗口，内容组超出「肩部仍足够厚」
 * 的区间时，端头按钮会被裁掉一部分（可见但点不到）。把控件尺寸/间距显式化，
 * `capsuleLayout.test.ts` 才能用 `wingThicknessAt` 断言「新增入口不会挤进肩部」。
 * 改这里必须同步 `styles.css` 的对应规则。
 */
export const RAIL_ORB_CSS = 36;
/** Agent 状态球与其后内容组的间距（垂直停靠为 margin-bottom）。 */
export const RAIL_ORB_GAP_CSS = 10;
export const RAIL_CATEGORY_CSS = 36;
export const RAIL_CATEGORY_GAP_CSS = 8;
/** 分隔线占位：1px 线 + 沿边两侧各 6px。 */
export const RAIL_SEPARATOR_CSS = 13;
/** 底部快捷区按钮（工作空间入口 / 完整面板 / 极简标签）边长。 */
export const RAIL_QUICK_CSS = 26;
/** 快捷区按钮间距。 */
export const RAIL_QUICK_GAP_CSS = 4;

/**
 * 轨道内容组沿边总长度（CSS px）。
 *
 * 内容组在轨道上居中排布，因此**两端各向外延伸 extent/2**；端点处的翼片厚度
 * 必须 ≥ 该端点控件边长，否则被原生区域裁切。`quick` 含底部快捷区全部按钮
 * （工作空间直接入口 + 完整面板 + 极简标签）。
 */
export function railContentExtent(categories: number, quick: number, orb = true): number {
  const orbPart = orb ? RAIL_ORB_CSS + RAIL_ORB_GAP_CSS : 0;
  const categoryPart = categories > 0
    ? categories * RAIL_CATEGORY_CSS + (categories - 1) * RAIL_CATEGORY_GAP_CSS
    : 0;
  const quickPart = quick > 0 ? quick * RAIL_QUICK_CSS + (quick - 1) * RAIL_QUICK_GAP_CSS : 0;
  return orbPart + categoryPart + quickPart + RAIL_SEPARATOR_CSS;
}
/** 功能面板默认宽（CSS px）：设置里没有记录时的设计基准。 */
export const PANEL_WIDTH_CSS = 340;
/**
 * 功能面板宽的下限（CSS px）。
 *
 * 280 面板 → 内容盒 252：应用网格仍为 3 列（每列 80px，≥ 18px 删除热区所需的
 * 70px）；顶部标题、分段筛选与 30px 输入框都还能单行放下。
 */
export const PANEL_MIN_WIDTH_CSS = 280;
/**
 * 功能面板宽的上限（CSS px）。
 *
 * 480 面板 → 内容盒 452：应用网格 5 列（每列 85.6px）；再宽一档 6 列时每列
 * 只有 70.3px，会重新压到删除热区，因此 480 是同时保住 5 列与命中质量的边界。
 */
export const PANEL_MAX_WIDTH_CSS = 480;
/** 功能面板高（CSS px，不随宽度拖拽变化）。 */
export const PANEL_HEIGHT_CSS = 440;

/**
 * 面板宽度收敛：取整后钳制到 [PANEL_MIN_WIDTH_CSS, PANEL_MAX_WIDTH_CSS]。
 *
 * 必须取整：原生区域按 `round(css × scale)` 换算物理像素，CSS 盒宽带小数时
 * 两端会各取各的整（如 357.3 × 1.25 = 446.625 → 445 与 447 的差异），拖拽时
 * 面板右缘会与裁剪区域错开 1px。非法值（NaN/Infinity）回落到默认宽度。
 */
export function clampPanelWidth(css: number): number {
  if (!Number.isFinite(css)) return PANEL_WIDTH_CSS;
  return Math.max(PANEL_MIN_WIDTH_CSS, Math.min(PANEL_MAX_WIDTH_CSS, Math.round(css)));
}
/**
 * 轨道与面板之间的视觉间隙（CSS px）；区域上两块矩形不连通。
 *
 * 参考图的连接处是一道**真实的负空间**：翼片内侧高光 → 接触阴影 → 桌面 →
 * 面板外缘高光。把它改成实心桥接会在 12px 的跨距上必然形成「细脖子」，
 * 而用一条竖高光掩盖缝隙又正是本次明令禁止的做法。因此这里保留间隙，
 * 由「翼片肩部曲线 + 面板大圆角 + 双向柔和阴影」共同表达连接；
 * 间隙本身由 `pointInCapsule` 的 slop 纳入命中区，鼠标跨越不会触发收起。
 *
 * v0.7 间距收敛（12 → 8）：参考图的间隙约为面板宽的 2%~2.4%（340 × 0.024 ≈ 8），
 * 12 是早期标定的残留，视觉上面板会像一块独立浮卡。取 8 而非 7，是为了让
 * 容器沿边尺寸与面板居中换算都是偶数——面板在窗口内居中用 `(W - 面板宽) / 2`，
 * 前端 `Math.round` 与 Rust 整除因此得到同一个整数，不会出现跨端 1px 偏差。
 */
export const CAPSULE_GAP_CSS = 8;
/** 面板圆角（CSS px）；轨道为全圆角（厚度/2）。 */
export const PANEL_RADIUS_CSS = 24;

// ── Edge Tab（极简吸附标签）跨端契约 ─────────────────────────
/** 标签垂直于停靠边的厚度（CSS px）。 */
export const TAB_WIDTH_CSS = 10;
/** 标签沿边方向的长度（CSS px）。 */
export const TAB_HEIGHT_CSS = 46;
/** 标签靠屏幕内侧两角的圆角（CSS px）；贴屏一侧保持直角。 */
export const TAB_RADIUS_CSS = 8;
/** 收起/恢复动画总时长（CSS 与引擎共用的口径，ms）。 */
export const TAB_TRANSITION_MS = 300;
/** 功能面板离场时长（ms）：先自然收合，再开始胶囊侧滑。 */
export const PANEL_EXIT_MS = 160;
/** 点击与拖动的位移判定阈值（CSS px）。 */
export const TAB_CLICK_SLOP_CSS = 4;
/** 向屏幕内部拖动恢复胶囊的法向阈值（CSS px）。 */
export const TAB_RESTORE_DRAG_CSS = 28;

/** 标签沿边方向在物理像素下的跨度（用于拖拽时把标签限制在可用区内）。 */
export function tabSpanPhysical(edge: SnapEdge, scale: number): number {
  return toPhysical(isVerticalEdge(edge) ? TAB_HEIGHT_CSS : TAB_WIDTH_CSS, scale);
}

/**
 * 把 Edge Tab 的沿边中心钳制在显示器可用区内（物理像素）。
 * 标签必须完整可见，不能出现贴到任务栏后面或屏幕外无法点击的情况。
 */
export function clampTabCenter(
  edge: SnapEdge,
  area: SnapArea,
  center: number,
  scale: number,
): number {
  const span = tabSpanPhysical(edge, scale);
  const origin = isVerticalEdge(edge) ? area.y : area.x;
  const extent = isVerticalEdge(edge) ? area.h : area.w;
  if (extent <= span) return origin + extent / 2;
  return Math.max(origin + span / 2, Math.min(origin + extent - span / 2, center));
}

/**
 * 胶囊容器：停靠时窗口至少要这么大，才能同时容纳轨道与面板。
 *
 * 2026-11-09 起按**面板最大宽度**预留，而不是默认宽度：面板宽度可在停靠期
 * 拖拽（280–480），窗口若按当前宽度收缩，拖宽就得在拖拽中途 `setSize`，
 * 破坏「停靠期窗口不移动、不缩放」的不变式（原生拖拽循环会吞尺寸、造成
 * 区域与内容错位）。因此停靠时一次性撑到最大容器，之后只改 Win32 区域。
 * 多出来的矩形被区域裁掉，不可见、不接收鼠标，默认宽度下的可见外形不变。
 */
export const CAPSULE_CONTAINER_W_CSS =
  RAIL_THICKNESS_CSS + CAPSULE_GAP_CSS + PANEL_MAX_WIDTH_CSS; // 544
export const CAPSULE_CONTAINER_H_CSS = PANEL_HEIGHT_CSS; // 440

export interface Size {
  w: number;
  h: number;
}

export const isVerticalEdge = (edge: SnapEdge): boolean => edge === "left" || edge === "right";

/**
 * 胶囊容器尺寸（CSS px）。厚度方向固定为「轨道 + 间隙 + 面板」；
 * 沿边方向必须同时放下轨道外框与面板，取两者较大值：
 * - 垂直停靠：宽 56+8+480 = 544，高 max(440, 476) = 476；
 * - 水平停靠：宽 max(476, 480) = 480，高 56+8+440 = 504。
 *
 * 轨道从 400 扩到 446 是为了容纳第 5 个分类（规划中心）；2026-11-13（P0-01）
 * 再扩到 476：新增「工作空间」26px 直接入口 + 4px 间距放在底部快捷区，
 * 平直主体 270→300，内容组两端进入肩部的深度保持 30.5px 不变。
 */
export function capsuleContainerSize(edge: SnapEdge): Size {
  return isVerticalEdge(edge)
    ? { w: CAPSULE_CONTAINER_W_CSS, h: Math.max(CAPSULE_CONTAINER_H_CSS, RAIL_SPAN_CSS) }
    : {
        w: Math.max(RAIL_SPAN_CSS, PANEL_MAX_WIDTH_CSS),
        h: RAIL_THICKNESS_CSS + CAPSULE_GAP_CSS + PANEL_HEIGHT_CSS,
      };
}

/** 物理像素换算（非法 scale 回退 1，最小 1px）。 */
export function toPhysical(css: number, scale: number): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.max(1, Math.round(css * s));
}

export interface CapsulePlacement {
  /** 窗口左上角（物理像素） */
  x: number;
  y: number;
  /** 窗口物理尺寸（与传入的当前尺寸一致，仅作回读对照） */
  w: number;
  h: number;
}

/**
 * 停靠位置：窗口贴边齐平，胶囊沿边方向以 `centerAlong` 为中心。
 *
 * `centerAlong` 是**物理像素**的沿边坐标（left/right 用 y，top/bottom 用 x）。
 * 窗口沿边方向居中放置（胶囊在窗口内居中），因此窗口中心 = 胶囊中心；
 * 越界时整体钳制进工作区，绝不把窗口推出屏幕。
 */
export function capsuleWindowRect(
  edge: SnapEdge,
  area: SnapArea,
  centerAlong: number,
  size: Size,
): CapsulePlacement {
  const w = Math.max(1, Math.round(size.w));
  const h = Math.max(1, Math.round(size.h));
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  if (isVerticalEdge(edge)) {
    const y = clamp(Math.round(centerAlong - h / 2), area.y, Math.max(area.y, area.y + area.h - h));
    const x = edge === "left" ? area.x : area.x + area.w - w;
    return { x, y, w, h };
  }
  const x = clamp(Math.round(centerAlong - w / 2), area.x, Math.max(area.x, area.x + area.w - w));
  const y = edge === "top" ? area.y : area.y + area.h - h;
  return { x, y, w, h };
}

/** 沿边中心坐标（物理像素）：由窗口矩形换算，用于停靠时记忆胶囊位置。 */
export function alongCenterOf(edge: SnapEdge, rect: { x: number; y: number; w: number; h: number }): number {
  return isVerticalEdge(edge) ? rect.y + rect.h / 2 : rect.x + rect.w / 2;
}

/**
 * 停靠后窗口是否需要调整到容器尺寸。
 * **两个方向都收拢**：窗口大于容器时同样缩小（例如 Windows Aero Snap 把窗口
 * 先吸成半屏 1280×690），否则停靠期会残留一个尺寸异常的大窗口，且解除吸附
 * 前后的几何不一致。容器是停靠期唯一合法的窗口尺寸（可见区域只由区域裁剪决定）。
 */
export function needsContainerResize(current: Size, container: Size): boolean {
  return Math.abs(current.w - container.w) > 1 || Math.abs(current.h - container.h) > 1;
}

/**
 * 物理矩形是否恰好是某个停靠方向的「胶囊容器」尺寸。
 *
 * 停靠期间窗口被归一为容器尺寸；解除吸附后如果 `apply_mode` 的 `set_size`
 * 被原生拖拽循环吞掉，窗口会停在这个尺寸。它**不是**任何模式尺寸
 * （minimal 280×140 / compact 400×380 / full 400×560），因此可以安全地
 * 用它识别「解除未真正恢复几何」，并阻止把容器尺寸写进 `window_rect`。
 */
export function isCapsuleContainerSize(rect: { w: number; h: number }, scale: number): boolean {
  for (const edge of ["left", "top"] as const) {
    const c = capsuleContainerSize(edge);
    if (
      Math.abs(rect.w - toPhysical(c.w, scale)) <= 2 &&
      Math.abs(rect.h - toPhysical(c.h, scale)) <= 2
    ) {
      return true;
    }
  }
  return false;
}

// ── 可见区域（物理像素，窗口局部坐标）────────────────────────
//
// 与 Rust `capsule_regions` 是同一套几何：窗口局部坐标、物理像素、同一组
// 常量、同一套采样规则。Rust 侧负责真正裁剪（绘制 + 命中），这里负责
// **命中判定**（自动收起判定不能按整窗矩形算——折叠态窗口有 544×446
// （水平停靠 480×504），但只有一块 56×446 的翼片可见）。

export interface PhysRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CapsuleRegions {
  /** 轨道外框（含两侧外扩）：布局与包围盒用，**不是**命中区 */
  rail: PhysRect;
  /** 轨道可见轮廓多边形（已含 AA 外扩、已钳制进窗口）：命中判定与原生区域共用 */
  railOutline: Point[];
  panel: PhysRect | null;
  /** 面板圆角（物理像素）：命中判定与原生区域用同一值 */
  panelRadius: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * 轨道外框在窗口内的位置。
 * 垂直停靠：贴左/右边、沿边居中；水平停靠：贴上/下边、沿边居中。
 * 与 `.capsule-dock` 的 flex 布局一致（`justify-content:flex-start` 贴停靠边、
 * `align-items:center` 沿边居中）。
 */
function railBoxRect(
  windowW: number,
  windowH: number,
  edge: SnapEdge,
  box: { w: number; h: number },
): PhysRect {
  const w = Math.min(box.w, windowW);
  const h = Math.min(box.h, windowH);
  const vertical = isVerticalEdge(edge);
  const x = vertical
    ? edge === "left"
      ? 0
      : Math.max(0, windowW - w)
    : Math.max(0, Math.round((windowW - w) / 2));
  const y = vertical
    ? Math.max(0, Math.round((windowH - h) / 2))
    : edge === "top"
      ? 0
      : Math.max(0, windowH - h);
  return { x, y, w, h };
}

/**
 * 可见区域（物理像素，窗口局部）。
 *
 * 轨道轮廓 = `wingShape` 采样点平移到外框位置后钳制进窗口：
 * 贴边侧的外扩会越过窗口边界，钳制后与 Rust `CreatePolygonRgn` 被系统
 * 裁剪的结果一致，两端命中判定因此仍逐点相同。
 *
 * `panelWidthCss` 是停靠期可拖拽的面板宽度（默认 340）；窗口仍按最大容器
 * 预留，越界判定沿用「窗口放不下就不认定面板可见」的失败语义。
 */
export function capsuleRegionsPhysical(
  windowW: number,
  windowH: number,
  edge: SnapEdge,
  expanded: boolean,
  scale: number,
  panelWidthCss: number = PANEL_WIDTH_CSS,
): CapsuleRegions {
  const shape = wingShape(edge, scale, WING_AA_INSET);
  const rail = railBoxRect(windowW, windowH, edge, shape.box);
  const railOutline = shape.outline.map((p) => ({
    x: clamp(Math.round(p.x + rail.x), 0, windowW),
    y: clamp(Math.round(p.y + rail.y), 0, windowH),
  }));
  // 与 Rust `capsule_regions` 同口径：圆角比 CSS 小 2px（AA 内收），硬边落在透明像素上
  const panelRadius = Math.max(1, Math.floor(PANEL_RADIUS_CSS * scale) - WING_AA_INSET);
  if (!expanded) return { rail, railOutline, panel: null, panelRadius };

  const pw = toPhysical(clampPanelWidth(panelWidthCss), scale);
  const ph = toPhysical(PANEL_HEIGHT_CSS, scale);
  const gap = toPhysical(CAPSULE_GAP_CSS, scale);
  const vertical = isVerticalEdge(edge);
  const panelW = Math.min(pw, windowW);
  const panelH = Math.min(ph, windowH);
  const px = vertical
    ? edge === "left"
      ? rail.x + rail.w + gap
      : rail.x - gap - panelW
    : Math.max(0, Math.round((windowW - panelW) / 2));
  const py = vertical
    ? Math.max(0, Math.round((windowH - panelH) / 2))
    : edge === "top"
      ? rail.y + rail.h + gap
      : rail.y - gap - panelH;
  // 越界（窗口过小）时不认定面板可见——与 Rust 侧「退化只保留轨道」一致
  const fits = px >= 0 && py >= 0 && px + panelW <= windowW && py + panelH <= windowH;
  return {
    rail,
    railOutline,
    panel: fits ? { x: px, y: py, w: panelW, h: panelH } : null,
    panelRadius,
  };
}

/**
 * 圆角矩形点内判定（与 `CreateRoundRectRgn` 的填充语义一致）。
 * 四角用「圆心到点」的欧氏距离判定，避免把面板圆角外的桌面算成面板。
 */
export function pointInRoundedRect(
  px: number,
  py: number,
  r: PhysRect,
  radius: number,
  m = 0,
): boolean {
  const x0 = r.x - m;
  const y0 = r.y - m;
  const x1 = r.x + r.w + m;
  const y1 = r.y + r.h + m;
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const rad = Math.max(0, Math.min(radius + m, Math.min(x1 - x0, y1 - y0) / 2));
  if (rad <= 0) return true;
  // 只在四角做距离判定：把点折叠到「圆角圆心构成的矩形」上
  const cx = Math.min(Math.max(px, x0 + rad), x1 - rad);
  const cy = Math.min(Math.max(py, y0 + rad), y1 - rad);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= rad * rad;
}

/**
 * 光标是否落在胶囊**可见区域**内（窗口局部坐标）。
 *
 * - 轨道用轮廓多边形判定：外框的四个「缺角」（外扩之外）是桌面，不能算在内；
 * - 面板用圆角矩形 + `margin`：`margin` 取间隙宽度，鼠标从轨道跨到面板不会被判成离开。
 */
export function pointInCapsule(
  cursorLocal: { x: number; y: number },
  regions: CapsuleRegions,
  margin: number = 0,
): boolean {
  if (pointInPolygon(cursorLocal, regions.railOutline)) return true;
  return regions.panel
    ? pointInRoundedRect(cursorLocal.x, cursorLocal.y, regions.panel, regions.panelRadius, margin)
    : false;
}
