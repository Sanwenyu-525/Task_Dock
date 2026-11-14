//! 液态翼片几何单测：与 Rust `window_shape::wing_outline` 同一组金标准点位。

import { describe, expect, it } from "vitest";
import {
  WING_AA_INSET,
  WING_CREST_RATIO,
  WING_LENGTH_CSS,
  WING_SAMPLES,
  WING_SHOULDER_CSS,
  WING_TAIL_RATIO,
  WING_THICKNESS_CSS,
  offsetPolygon,
  pointInPolygon,
  polygonSignedArea,
  wingMetrics,
  wingPath,
  wingRimPath,
  wingShape,
} from "./capsuleShape";
import type { SnapEdge } from "./edgeSnap";

const EDGES: SnapEdge[] = ["left", "right", "top", "bottom"];
const round2 = (v: number) => Math.round(v * 100) / 100;

describe("参数契约（与 window_shape.rs 同步）", () => {
  it("厚 56 / 平直主体 300 / 单侧肩 88 / 比例 0.435·0.565 / 18 段", () => {
    expect(WING_THICKNESS_CSS).toBe(56);
    expect(WING_LENGTH_CSS).toBe(300);
    expect(WING_SHOULDER_CSS).toBe(88);
    expect(WING_CREST_RATIO).toBeCloseTo(0.435, 6);
    expect(WING_TAIL_RATIO).toBeCloseTo(0.565, 6);
    expect(WING_SAMPLES).toBe(18);
    expect(WING_AA_INSET).toBe(2);
  });

  it("DPI 缩放：外框沿边尺寸 = 主体 + 2×肩宽 = 476，不随取整漂移", () => {
    expect(wingShape("left", 1).box).toEqual({ w: 56, h: 476 });
    expect(wingShape("left", 1.25).box).toEqual({ w: 70, h: 595 });
    expect(wingShape("left", 1.5).box).toEqual({ w: 84, h: 714 });
    expect(wingShape("bottom", 1).box).toEqual({ w: 476, h: 56 });
  });

  it("非法 DPI 回退 1；极小缩放下肩宽仍 ≥1px（不退化成圆角矩形）", () => {
    expect(wingShape("left", Number.NaN).box).toEqual({ w: 56, h: 476 });
    const tiny = wingMetrics(0.1);
    expect(tiny.thickness).toBe(6);
    expect(tiny.length).toBe(30);
    expect(tiny.shoulder).toBeGreaterThanOrEqual(1);
  });
});

describe("轮廓形状", () => {
  it("金标准点位（bottom / 100%）：与 Rust 断言同一组数字", () => {
    const { box, outline } = wingShape("bottom", 1);
    expect(box).toEqual({ w: 476, h: 56 });
    // 两侧各 19 个贝塞尔采样点（含两个端点）
    expect(outline).toHaveLength(38);
    const at = (i: number) => [round2(outline[i].x), round2(outline[i].y)];
    // 贴边尖端：落在下缘（局部 y = 高度）
    expect(at(0)).toEqual([0, 56]);
    expect(at(37)).toEqual([476, 56]);
    // 左肩采样点：肩部中段（v = 厚度/2）
    expect(at(9)).toEqual([48.29, 28]);
    expect(at(13)).toEqual([63.07, 10.56]);
    // 平直主体两端：顶边完整 300px，中间没有斜弦
    expect(at(18)).toEqual([88, 0]);
    expect(at(19)).toEqual([388, 0]);
  });

  it("贴边切线连续：首段几乎平行于屏幕边缘（液态融合而非圆角靠近边缘）", () => {
    for (const edge of EDGES) {
      const vertical = edge === "left" || edge === "right";
      const { outline } = wingShape(edge, 1);
      const a = outline[0];
      const b = outline[1];
      const [along, across] = vertical ? [b.y - a.y, b.x - a.x] : [b.x - a.x, b.y - a.y];
      expect(Math.abs(across / along), `edge=${edge}`).toBeLessThan(0.12);
    }
  });

  it("主体平边相切：肩部离开顶边时是缓起（不是直壁接圆角的折点）", () => {
    const { outline } = wingShape("bottom", 1);
    // 主体端点 → 相邻采样点：厚度方向位移远小于沿边方向
    const a = outline[18];
    const b = outline[17];
    expect(Math.abs((b.y - a.y) / (b.x - a.x))).toBeLessThan(0.35);
  });

  it("肩部无直壁：最陡采样段 < 65°，不存在 90° 长直边（旧模型判据）", () => {
    for (const edge of EDGES) {
      const { outline } = wingShape(edge, 1);
      const vertical = edge === "left" || edge === "right";
      let steepest = 0;
      for (let i = 1; i < outline.length; i += 1) {
        const dx = Math.abs(outline[i].x - outline[i - 1].x);
        const dy = Math.abs(outline[i].y - outline[i - 1].y);
        // 斜率按「厚度方向 / 沿边方向」取，与停靠方向无关
        const [along, across] = vertical ? [dy, dx] : [dx, dy];
        if (along > 1e-9) steepest = Math.max(steepest, across / along);
      }
      // 旧模型两端是竖直直壁（斜率→∞）。新模型最陡段约 60°。
      expect(steepest, `edge=${edge}`).toBeLessThan(2.2);
    }
  });

  it("左右对称：整条轮廓关于沿边中线镜像", () => {
    for (const edge of EDGES) {
      const { box, outline } = wingShape(edge, 1);
      const vertical = edge === "left" || edge === "right";
      const axis = vertical ? box.h : box.w;
      for (const p of outline) {
        const mirrored = outline.some(
          (q) =>
            Math.abs((vertical ? q.y : q.x) - (axis - (vertical ? p.y : p.x))) < 1e-6 &&
            Math.abs((vertical ? q.x : q.y) - (vertical ? p.x : p.y)) < 1e-6,
        );
        expect(mirrored, `edge=${edge} 点 (${p.x},${p.y}) 无镜像对应点`).toBe(true);
      }
    }
  });

  it("四边外框一致、方向不同：同一套形状只换映射", () => {
    for (const edge of EDGES) {
      const { box, outline } = wingShape(edge, 1);
      const vertical = edge === "left" || edge === "right";
      expect(vertical ? box : { w: box.h, h: box.w }).toEqual({ w: 56, h: 476 });
      for (const p of outline) {
        expect(p.x).toBeGreaterThanOrEqual(-1e-9);
        expect(p.y).toBeGreaterThanOrEqual(-1e-9);
        expect(p.x).toBeLessThanOrEqual(box.w + 1e-9);
        expect(p.y).toBeLessThanOrEqual(box.h + 1e-9);
      }
    }
  });

  it("主体区实心：平直段四角与中心都在形状内", () => {
    for (const edge of EDGES) {
      const { box, outline } = wingShape(edge, 1);
      const vertical = edge === "left" || edge === "right";
      const samples = vertical
        ? [
            { x: box.w / 2, y: box.h / 2 },
            { x: box.w / 2, y: (box.h - 300) / 2 + 4 },
            { x: box.w / 2, y: (box.h + 300) / 2 - 4 },
          ]
        : [
            { x: box.w / 2, y: box.h / 2 },
            { x: (box.w - 300) / 2 + 4, y: box.h / 2 },
            { x: (box.w + 300) / 2 - 4, y: box.h / 2 },
          ];
      for (const p of samples) {
        expect(pointInPolygon(p, outline), `edge=${edge} (${p.x},${p.y})`).toBe(true);
      }
    }
  });

  it("外框缺角不属于形状（不能退化成矩形区域）", () => {
    const { box, outline } = wingShape("bottom", 1);
    for (const p of [
      { x: 1, y: 1 },
      { x: box.w - 1, y: 1 },
      { x: 1, y: box.h - 1 },
      { x: box.w - 1, y: box.h - 1 },
    ]) {
      expect(pointInPolygon(p, outline)).toBe(false);
    }
  });

  it("贴边段整体落在屏幕上（首尾两点 v=0），肩部尖端不进入屏幕内部", () => {
    for (const edge of EDGES) {
      const { box, outline } = wingShape(edge, 1);
      const vertical = edge === "left" || edge === "right";
      const first = outline[0];
      const last = outline[outline.length - 1];
      const acrossOf = (p: { x: number; y: number }) =>
        vertical ? (edge === "left" ? p.x : box.w - p.x) : edge === "top" ? p.y : box.h - p.y;
      expect(acrossOf(first)).toBeCloseTo(0, 6);
      expect(acrossOf(last)).toBeCloseTo(0, 6);
    }
  });

  it("轮廓为简单多边形（有向面积不为 0，与 Rust 同一判定方向）", () => {
    for (const edge of EDGES) {
      const { outline } = wingShape(edge, 1);
      expect(Math.abs(polygonSignedArea(outline))).toBeGreaterThan(1000);
    }
  });
});

describe("区域外扩（AA 补偿）", () => {
  it("外扩后是超集：原轮廓内部的点在区域轮廓内也全部命中", () => {
    const inner = wingShape("bottom", 1, 0).outline;
    const outer = wingShape("bottom", 1, WING_AA_INSET).outline;
    // 尖点斜切补偿：每个尖点多出一个点
    expect(outer).toHaveLength(inner.length + 2);
    let hit = 0;
    for (let x = 1; x < 476; x += 3) {
      for (let y = 1; y < 56; y += 3) {
        const p = { x, y };
        if (!pointInPolygon(p, inner)) continue;
        hit += 1;
        expect(pointInPolygon(p, outer), `(${x},${y})`).toBe(true);
      }
    }
    expect(hit).toBeGreaterThan(1000);
  });

  it("外扩量单调：直边与贴边侧各外扩 delta，尖端斜切不会把区域横向顶出去", () => {
    const a = wingShape("bottom", 1, 0).outline;
    const b = wingShape("bottom", 1, 2).outline;
    const y0 = (pts: { y: number }[]) => Math.min(...pts.map((p) => p.y));
    const y1 = (pts: { y: number }[]) => Math.max(...pts.map((p) => p.y));
    const x0 = (pts: { x: number }[]) => Math.min(...pts.map((p) => p.x));
    // 平直主体顶边：法线唯一，外扩量精确等于 delta
    expect(y0(a) - y0(b)).toBeCloseTo(2, 5);
    // 贴边一侧同样外扩 2px（落在窗口之外，被系统裁掉，不影响可见轮廓）
    expect(y1(b) - y1(a)).toBeCloseTo(2, 5);
    // 贴边尖端是极小的尖点：斜切后横向只多出不到 1px
    expect(x0(a) - x0(b)).toBeLessThan(1);
  });

  it("offsetPolygon 对外扩 0 是恒等变换", () => {
    const pts = wingShape("top", 1, 0).outline;
    expect(offsetPolygon(pts, 0)).toBe(pts);
  });
});

describe("SVG 路径", () => {
  it("填充路径闭合、描边路径不闭合（贴边段不描线，避免边缘亮缝）", () => {
    const { outline } = wingShape("bottom", 1);
    expect(wingPath(outline).startsWith("M")).toBe(true);
    expect(wingPath(outline).endsWith("Z")).toBe(true);
    expect(wingRimPath(outline).startsWith("M")).toBe(true);
    expect(wingRimPath(outline).endsWith("Z")).toBe(false);
    expect(wingRimPath(outline).split("L")).toHaveLength(outline.length);
    expect(wingPath(outline).split("L")).toHaveLength(outline.length);
  });

  it("空轮廓不产生非法路径", () => {
    expect(wingPath([])).toBe("");
    expect(wingRimPath([])).toBe("");
  });
});
