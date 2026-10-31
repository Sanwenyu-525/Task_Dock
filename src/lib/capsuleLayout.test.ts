//! 分类胶囊几何单测：与 Rust `capsule_regions` 同一组数字（跨端契约）。

import { describe, expect, it } from "vitest";
import {
  CAPSULE_GAP_CSS,
  PANEL_HEIGHT_CSS,
  PANEL_WIDTH_CSS,
  RAIL_LENGTH_CSS,
  RAIL_THICKNESS_CSS,
  alongCenterOf,
  capsuleContainerSize,
  capsuleRegionsPhysical,
  capsuleWindowRect,
  containerTarget,
  needsContainerResize,
  pointInCapsule,
  toPhysical,
} from "./capsuleLayout";

const MAIN = { x: 0, y: 0, w: 1920, h: 1032 };

describe("常量契约（与 window_shape.rs 同步）", () => {
  it("轨道 56×300 / 面板 336×420 / 间隙 8", () => {
    expect(RAIL_THICKNESS_CSS).toBe(56);
    expect(RAIL_LENGTH_CSS).toBe(300);
    expect(PANEL_WIDTH_CSS).toBe(336);
    expect(PANEL_HEIGHT_CSS).toBe(420);
    expect(CAPSULE_GAP_CSS).toBe(8);
  });

  it("容器尺寸：垂直 400×420，水平 400×484", () => {
    expect(capsuleContainerSize("left")).toEqual({ w: 400, h: 420 });
    expect(capsuleContainerSize("right")).toEqual({ w: 400, h: 420 });
    expect(capsuleContainerSize("top")).toEqual({ w: 400, h: 484 });
    expect(capsuleContainerSize("bottom")).toEqual({ w: 400, h: 484 });
  });
});

describe("停靠位置", () => {
  it("左/右停靠贴边齐平，沿边居中并钳制进工作区", () => {
    const l = capsuleWindowRect("left", MAIN, 500, { w: 400, h: 560 });
    expect(l.x).toBe(0);
    expect(l.y).toBe(500 - 280);

    const r = capsuleWindowRect("right", MAIN, 500, { w: 400, h: 560 });
    expect(r.x).toBe(1920 - 400);

    // 靠近顶部：钳制到工作区上边界，不把窗口推出屏幕
    const top = capsuleWindowRect("left", MAIN, 10, { w: 400, h: 560 });
    expect(top.y).toBe(0);
    // 靠近底部：钳制到下边界
    const bottom = capsuleWindowRect("left", MAIN, 5000, { w: 400, h: 560 });
    expect(bottom.y).toBe(1032 - 560);
  });

  it("上/下停靠贴边齐平，水平居中", () => {
    const t = capsuleWindowRect("top", MAIN, 960, { w: 400, h: 420 });
    expect(t.y).toBe(0);
    expect(t.x).toBe(960 - 200);

    const b = capsuleWindowRect("bottom", MAIN, 960, { w: 400, h: 420 });
    expect(b.y).toBe(1032 - 420);
  });

  it("负坐标多屏：钳制基于传入工作区，不做非负假设", () => {
    const left = { x: -1920, y: -200, w: 1920, h: 1080 };
    const p = capsuleWindowRect("left", left, -600, { w: 400, h: 560 });
    expect(p.x).toBe(-1920);
    // 中心 -600 会把窗口顶出工作区（上边界 -200），必须钳制回来
    expect(p.y).toBe(-200);
  });
});

describe("可见区域（物理像素，窗口局部）", () => {
  it("折叠态只有轨道，贴停靠边并居中", () => {
    const r = capsuleRegionsPhysical(400, 420, "left", false, 1);
    expect(r.rail).toEqual({ x: 0, y: 60, w: 56, h: 300 });
    expect(r.panel).toBeNull();

    const right = capsuleRegionsPhysical(400, 420, "right", false, 1);
    expect(right.rail.x).toBe(400 - 56);

    const top = capsuleRegionsPhysical(400, 484, "top", false, 1);
    expect(top.rail).toEqual({ x: 50, y: 0, w: 300, h: 56 });
  });

  it("展开态面板在轨道内侧，与 Rust 几何一致", () => {
    const l = capsuleRegionsPhysical(400, 420, "left", true, 1);
    expect(l.panel).toEqual({ x: 64, y: 0, w: 336, h: 420 });
    const r = capsuleRegionsPhysical(400, 420, "right", true, 1);
    expect(r.panel).toEqual({ x: 0, y: 0, w: 336, h: 420 });
    const t = capsuleRegionsPhysical(400, 484, "top", true, 1);
    expect(t.panel).toEqual({ x: 32, y: 64, w: 336, h: 420 });
  });

  it("DPI 缩放：56 → 70（125%）", () => {
    const r = capsuleRegionsPhysical(500, 525, "left", false, 1.25);
    expect(r.rail.w).toBe(toPhysical(56, 1.25));
    expect(r.rail.h).toBe(toPhysical(300, 1.25));
  });

  it("窗口放不下面板时不认定面板可见（与后端退化一致）", () => {
    const r = capsuleRegionsPhysical(120, 420, "left", true, 1);
    expect(r.panel).toBeNull();
  });
});

describe("命中判定", () => {
  it("轨道内命中、间隙不命中、面板内命中", () => {
    const regions = capsuleRegionsPhysical(400, 420, "left", true, 1);
    expect(pointInCapsule({ x: 28, y: 200 }, regions)).toBe(true);
    expect(pointInCapsule({ x: 60, y: 200 }, regions)).toBe(false); // 间隙中点
    expect(pointInCapsule({ x: 200, y: 200 }, regions)).toBe(true);
    expect(pointInCapsule({ x: 399, y: 419 }, regions)).toBe(true);
  });

  it("margin 覆盖间隙：鼠标从轨道移到面板不算离开", () => {
    const regions = capsuleRegionsPhysical(400, 420, "left", true, 1);
    expect(pointInCapsule({ x: 60, y: 200 }, regions, 6)).toBe(true);
  });

  it("折叠态：面板位置不算命中（自动收起必须按可见区域判定）", () => {
    const regions = capsuleRegionsPhysical(400, 420, "left", false, 1);
    expect(pointInCapsule({ x: 200, y: 200 }, regions)).toBe(false);
    expect(pointInCapsule({ x: 28, y: 200 }, regions)).toBe(true);
  });
});

describe("容器补足", () => {
  it("只在当前尺寸不足时调整", () => {
    const c = { w: 400, h: 420 };
    expect(needsContainerResize({ w: 400, h: 560 }, c)).toBe(false);
    expect(needsContainerResize({ w: 280, h: 140 }, c)).toBe(true);
    expect(containerTarget({ w: 280, h: 140 }, c)).toEqual({ w: 400, h: 420 });
    expect(containerTarget({ w: 400, h: 560 }, c)).toEqual({ w: 400, h: 560 });
  });

  it("沿边中心换算：垂直用 y、水平用 x", () => {
    expect(alongCenterOf("left", { x: 0, y: 300, w: 400, h: 560 })).toBe(580);
    expect(alongCenterOf("top", { x: 100, y: 0, w: 400, h: 420 })).toBe(300);
  });
});
