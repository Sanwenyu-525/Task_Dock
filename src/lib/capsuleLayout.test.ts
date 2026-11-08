//! 分类胶囊几何单测：与 Rust `capsule_regions` 同一组数字（跨端契约）。

import { describe, expect, it } from "vitest";
import {
  CAPSULE_GAP_CSS,
  PANEL_HEIGHT_CSS,
  PANEL_RADIUS_CSS,
  PANEL_WIDTH_CSS,
  RAIL_SHOULDER_CSS,
  RAIL_LENGTH_CSS,
  RAIL_THICKNESS_CSS,
  alongCenterOf,
  capsuleContainerSize,
  capsuleRegionsPhysical,
  capsuleWindowRect,
  isCapsuleContainerSize,
  needsContainerResize,
  pointInCapsule,
  pointInRoundedRect,
  toPhysical,
} from "./capsuleLayout";

const MAIN = { x: 0, y: 0, w: 1920, h: 1032 };

describe("常量契约（与 window_shape.rs 同步）", () => {
  it("轨道 56×446（主体 270 + 两侧肩部 88）/ 面板 340×440 / 间隙 8 / 圆角 24", () => {
    expect(RAIL_THICKNESS_CSS).toBe(56);
    expect(RAIL_LENGTH_CSS).toBe(270);
    expect(RAIL_SHOULDER_CSS).toBe(88);
    expect(PANEL_WIDTH_CSS).toBe(340);
    expect(PANEL_HEIGHT_CSS).toBe(440);
    expect(CAPSULE_GAP_CSS).toBe(8);
    expect(PANEL_RADIUS_CSS).toBe(24);
  });

  it("容器尺寸：垂直 404×446，水平 446×504", () => {
    expect(capsuleContainerSize("left")).toEqual({ w: 404, h: 446 });
    expect(capsuleContainerSize("right")).toEqual({ w: 404, h: 446 });
    expect(capsuleContainerSize("top")).toEqual({ w: 446, h: 504 });
    expect(capsuleContainerSize("bottom")).toEqual({ w: 446, h: 504 });
  });
});

describe("停靠位置", () => {
  it("左/右停靠贴边齐平，沿边居中并钳制进工作区", () => {
    const l = capsuleWindowRect("left", MAIN, 500, { w: 404, h: 560 });
    expect(l.x).toBe(0);
    expect(l.y).toBe(500 - 280);

    const r = capsuleWindowRect("right", MAIN, 500, { w: 404, h: 560 });
    expect(r.x).toBe(1920 - 404);

    // 靠近顶部：钳制到工作区上边界，不把窗口推出屏幕
    const top = capsuleWindowRect("left", MAIN, 10, { w: 404, h: 560 });
    expect(top.y).toBe(0);
    // 靠近底部：钳制到下边界
    const bottom = capsuleWindowRect("left", MAIN, 5000, { w: 404, h: 560 });
    expect(bottom.y).toBe(1032 - 560);
  });

  it("上/下停靠贴边齐平，水平居中", () => {
    const t = capsuleWindowRect("top", MAIN, 960, { w: 404, h: 440 });
    expect(t.y).toBe(0);
    expect(t.x).toBe(960 - 202);

    const b = capsuleWindowRect("bottom", MAIN, 960, { w: 404, h: 440 });
    expect(b.y).toBe(1032 - 440);
  });

  it("负坐标多屏：钳制基于传入工作区，不做非负假设", () => {
    const left = { x: -1920, y: -200, w: 1920, h: 1080 };
    const p = capsuleWindowRect("left", left, -600, { w: 404, h: 560 });
    expect(p.x).toBe(-1920);
    // 中心 -600 会把窗口顶出工作区（上边界 -200），必须钳制回来
    expect(p.y).toBe(-200);
  });
});

describe("可见区域（物理像素，窗口局部）", () => {
  it("折叠态只有轨道，贴停靠边并居中；外框含两侧液态肩部", () => {
    const r = capsuleRegionsPhysical(404, 446, "left", false, 1);
    expect(r.rail).toEqual({ x: 0, y: 0, w: 56, h: 446 });
    expect(r.panel).toBeNull();
    // 轮廓多边形：贴边一侧压在窗口边界上（无缝），另一侧是液态肩部曲线
    expect(r.railOutline.length).toBe(40); // 38 个轮廓点 + 两个贴边尖点的斜切补偿
    expect(Math.min(...r.railOutline.map((p) => p.x))).toBe(0);
    expect(Math.max(...r.railOutline.map((p) => p.y))).toBe(446);

    const right = capsuleRegionsPhysical(404, 446, "right", false, 1);
    expect(right.rail.x).toBe(404 - 56);
    expect(Math.max(...right.railOutline.map((p) => p.x))).toBe(404);

    const top = capsuleRegionsPhysical(446, 504, "top", false, 1);
    expect(top.rail).toEqual({ x: 0, y: 0, w: 446, h: 56 });
    expect(Math.min(...top.railOutline.map((p) => p.y))).toBe(0);

    const bottom = capsuleRegionsPhysical(446, 504, "bottom", false, 1);
    expect(bottom.rail).toEqual({ x: 0, y: 504 - 56, w: 446, h: 56 });
    expect(Math.max(...bottom.railOutline.map((p) => p.y))).toBe(504);
  });

  it("展开态面板在轨道内侧，与 Rust 几何一致；圆角为 CSS 24px 内收 2px", () => {
    const l = capsuleRegionsPhysical(404, 446, "left", true, 1);
    expect(l.panel).toEqual({ x: 64, y: 3, w: 340, h: 440 });
    expect(l.panelRadius).toBe(22);
    const r = capsuleRegionsPhysical(404, 446, "right", true, 1);
    expect(r.panel).toEqual({ x: 0, y: 3, w: 340, h: 440 });
    const t = capsuleRegionsPhysical(446, 504, "top", true, 1);
    expect(t.panel).toEqual({ x: 53, y: 64, w: 340, h: 440 });
  });

  it("DPI 缩放：56 → 70（125%），外框 446 → 558", () => {
    const r = capsuleRegionsPhysical(505, 558, "left", false, 1.25);
    expect(r.rail.w).toBe(toPhysical(56, 1.25));
    expect(r.rail.h).toBe(558);
  });

  it("窗口放不下面板时不认定面板可见（与后端退化一致）", () => {
    const r = capsuleRegionsPhysical(120, 446, "left", true, 1);
    expect(r.panel).toBeNull();
  });
});

describe("命中判定", () => {
  it("轨道内命中、间隙不命中、面板内命中", () => {
    const regions = capsuleRegionsPhysical(404, 446, "left", true, 1);
    expect(pointInCapsule({ x: 28, y: 223 }, regions)).toBe(true);
    expect(pointInCapsule({ x: 62, y: 223 }, regions)).toBe(false); // 间隙内（56~64）
    expect(pointInCapsule({ x: 200, y: 223 }, regions)).toBe(true);
    expect(pointInCapsule({ x: 300, y: 300 }, regions)).toBe(true);
  });

  it("面板圆角之外不命中：命中区与 CreateRoundRectRgn 语义一致", () => {
    const regions = capsuleRegionsPhysical(404, 446, "left", true, 1);
    // 面板右下角外：圆角半径 22 的弧外，属于桌面
    expect(pointInCapsule({ x: 402, y: 441 }, regions)).toBe(false);
    // 同一条边向内 24px 处命中（弧内）
    expect(pointInCapsule({ x: 380, y: 441 }, regions)).toBe(true);
    // 纯几何函数与 Rust 区域同口径
    const rect = { x: 0, y: 0, w: 100, h: 100 };
    expect(pointInRoundedRect(0, 0, rect, 20)).toBe(false);
    expect(pointInRoundedRect(20, 20, rect, 20)).toBe(true);
    expect(pointInRoundedRect(50, 50, rect, 20)).toBe(true);
    expect(pointInRoundedRect(101, 50, rect, 20)).toBe(false);
  });

  it("外框缺角（翼片轮廓之外、外框之内）不命中：命中区与原生区域一致", () => {
    const regions = capsuleRegionsPhysical(404, 446, "left", false, 1);
    // 外框内、主体区之外：桌面，不能算作胶囊
    expect(pointInCapsule({ x: 28, y: 408 }, regions)).toBe(false);
    expect(pointInCapsule({ x: 28, y: 32 }, regions)).toBe(false);
    // 贴边尖点附近仍属于胶囊（液态过渡区可命中）
    expect(pointInCapsule({ x: 4, y: 223 }, regions)).toBe(true);
  });

  it("margin 覆盖间隙：鼠标从轨道跨到面板不算离开", () => {
    const regions = capsuleRegionsPhysical(404, 446, "left", true, 1);
    expect(pointInCapsule({ x: 62, y: 223 }, regions, CAPSULE_GAP_CSS)).toBe(true);
  });

  it("折叠态：面板位置不算命中（自动收起必须按可见区域判定）", () => {
    const regions = capsuleRegionsPhysical(404, 446, "left", false, 1);
    expect(pointInCapsule({ x: 200, y: 223 }, regions)).toBe(false);
    expect(pointInCapsule({ x: 28, y: 223 }, regions)).toBe(true);
  });
});

describe("容器归一", () => {
  it("大于或小于容器都要调整（Aero Snap 的半屏尺寸也收拢）", () => {
    const c = { w: 404, h: 446 };
    expect(needsContainerResize({ w: 404, h: 446 }, c)).toBe(false);
    expect(needsContainerResize({ w: 280, h: 140 }, c)).toBe(true);
    expect(needsContainerResize({ w: 400, h: 560 }, c)).toBe(true);
    expect(needsContainerResize({ w: 1280, h: 690 }, c)).toBe(true);
  });

  it("能识别「解除后仍停在胶囊容器尺寸」（垂直 404×446 / 水平 446×504）", () => {
    // 125% DPI 的物理尺寸
    expect(isCapsuleContainerSize({ w: 505, h: 558 }, 1.25)).toBe(true);
    expect(isCapsuleContainerSize({ w: 558, h: 630 }, 1.25)).toBe(true);
    // 用户模式尺寸不是容器尺寸
    expect(isCapsuleContainerSize({ w: 500, h: 700 }, 1.25)).toBe(false); // full
    expect(isCapsuleContainerSize({ w: 500, h: 475 }, 1.25)).toBe(false); // compact
  });

  it("沿边中心换算：垂直用 y、水平用 x", () => {
    expect(alongCenterOf("left", { x: 0, y: 300, w: 404, h: 560 })).toBe(580);
    expect(alongCenterOf("top", { x: 100, y: 0, w: 404, h: 440 })).toBe(302);
  });
});
