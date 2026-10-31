//! 分类胶囊几何（纯函数，可单测）。
//!
//! 架构前提（v0.7 分类胶囊重设计）：停靠期间**窗口不移动、不缩放**，
//! 只切换 Win32 区域（`apply_window_capsule` 的 `rail` / `panel`）。
//! 因此这里只需要回答两个问题：
//! 1. 停靠时窗口要多大（容器尺寸）——保证轨道与面板都能完整放下；
//! 2. 窗口应放在哪（贴边齐平 + 胶囊沿边居中）。
//!
//! 尺寸与 `src-tauri/src/window_shape.rs` 的 `CAPSULE_*` 常量是跨端契约
//! （两端各有单测锁定同一组数字）：轨道 56×300、面板 336×420、间隙 8。
//!
//! 坐标口径：本文件同时提供 CSS 尺寸常量（供样式与布局引用）与**物理像素**
//! 计算（供 Tauri setPosition 使用），换算只发生在 `capsuleWindowRect` 内。

import type { SnapArea, SnapEdge } from "./edgeSnap";

/** 轨道厚度（CSS px）：垂直停靠为宽，水平停靠为高。 */
export const RAIL_THICKNESS_CSS = 56;
/** 轨道长度（CSS px，沿边方向）。 */
export const RAIL_LENGTH_CSS = 300;
/** 功能面板宽（CSS px）。 */
export const PANEL_WIDTH_CSS = 336;
/** 功能面板高（CSS px）。 */
export const PANEL_HEIGHT_CSS = 420;
/** 轨道与面板之间的视觉间隙（CSS px）；区域上两块矩形不连通。 */
export const CAPSULE_GAP_CSS = 8;
/** 面板圆角（CSS px）；轨道为全圆角（厚度/2）。 */
export const PANEL_RADIUS_CSS = 22;

/** 胶囊容器：停靠时窗口至少要这么大，才能同时容纳轨道与面板。 */
export const CAPSULE_CONTAINER_W_CSS = RAIL_THICKNESS_CSS + CAPSULE_GAP_CSS + PANEL_WIDTH_CSS; // 400
export const CAPSULE_CONTAINER_H_CSS = PANEL_HEIGHT_CSS; // 420

export interface Size {
  w: number;
  h: number;
}

export const isVerticalEdge = (edge: SnapEdge): boolean => edge === "left" || edge === "right";

/**
 * 胶囊容器尺寸（CSS px）。垂直停靠：宽 = 轨道 + 间隙 + 面板，高 = 面板高；
 * 水平停靠：宽 = 容器宽（面板宽 336 与轨道长 300 都要放下，取 400 与竖直一致），
 * 高 = 轨道 + 间隙 + 面板。
 */
export function capsuleContainerSize(edge: SnapEdge): Size {
  return isVerticalEdge(edge)
    ? { w: CAPSULE_CONTAINER_W_CSS, h: CAPSULE_CONTAINER_H_CSS }
    : { w: CAPSULE_CONTAINER_W_CSS, h: RAIL_THICKNESS_CSS + CAPSULE_GAP_CSS + PANEL_HEIGHT_CSS };
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

/** 停靠后窗口是否需要撑到容器尺寸（当前尺寸更小时才调整，避免无谓 IPC）。 */
export function needsContainerResize(current: Size, container: Size): boolean {
  return current.w + 1 < container.w || current.h + 1 < container.h;
}

/** 撑到容器尺寸的目标（保持当前更大的那一维，只补不足的维度）。 */
export function containerTarget(current: Size, container: Size): Size {
  return {
    w: Math.max(current.w, container.w),
    h: Math.max(current.h, container.h),
  };
}

// ── 可见区域（物理像素，窗口局部坐标）────────────────────────
//
// 与 Rust `capsule_regions` 是同一套几何：窗口局部坐标、物理像素、同一组
// 常量。Rust 侧负责真正裁剪（绘制 + 命中），这里负责**命中判定**（自动收起
// 判定不能按整窗矩形算——折叠态窗口有 400×420，但只有 56×300 的轨道可见）。

export interface PhysRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CapsuleRegions {
  rail: PhysRect;
  panel: PhysRect | null;
}

export function capsuleRegionsPhysical(
  windowW: number,
  windowH: number,
  edge: SnapEdge,
  expanded: boolean,
  scale: number,
): CapsuleRegions {
  const t = toPhysical(RAIL_THICKNESS_CSS, scale);
  const l = toPhysical(RAIL_LENGTH_CSS, scale);
  const pw = toPhysical(PANEL_WIDTH_CSS, scale);
  const ph = toPhysical(PANEL_HEIGHT_CSS, scale);
  const gap = toPhysical(CAPSULE_GAP_CSS, scale);
  const vertical = isVerticalEdge(edge);
  const rw = Math.min(vertical ? t : l, windowW);
  const rh = Math.min(vertical ? l : t, windowH);
  const rail: PhysRect = vertical
    ? {
        x: edge === "left" ? 0 : Math.max(0, windowW - rw),
        y: Math.max(0, Math.round((windowH - rh) / 2)),
        w: rw,
        h: rh,
      }
    : {
        x: Math.max(0, Math.round((windowW - rw) / 2)),
        y: edge === "top" ? 0 : Math.max(0, windowH - rh),
        w: rw,
        h: rh,
      };
  if (!expanded) return { rail, panel: null };
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
    panel: fits ? { x: px, y: py, w: panelW, h: panelH } : null,
  };
}

const inRect = (px: number, py: number, r: PhysRect, m: number): boolean =>
  px >= r.x - m && px <= r.x + r.w + m && py >= r.y - m && py <= r.y + r.h + m;

/**
 * 光标是否落在胶囊**可见区域**内（窗口局部坐标，margin 外扩）。
 * 间隙两侧都算「在内」由 margin 覆盖，鼠标从轨道移到面板不会被判成离开。
 */
export function pointInCapsule(
  cursorLocal: { x: number; y: number },
  regions: CapsuleRegions,
  margin: number = 0,
): boolean {
  if (inRect(cursorLocal.x, cursorLocal.y, regions.rail, margin)) return true;
  return regions.panel ? inRect(cursorLocal.x, cursorLocal.y, regions.panel, margin) : false;
}
