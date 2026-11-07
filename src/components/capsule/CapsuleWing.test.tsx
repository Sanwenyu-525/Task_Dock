/**
 * @vitest-environment jsdom
 */
//! 翼片表面层测试：尖端渐隐 mask 与几何契约。
//!
//! 覆盖：
//! - 尖端渐隐 mask 存在，且不透明度台阶与 `TIP_FADE_STOPS` 一致（锯齿修复的
//!   核心契约：贴边收尾段的台阶对比度必须随 alpha 衰减，见组件头注释）；
//! - mask 渐变沿**沿边轴**取向（四边各自从端点到端点），覆盖全视口；
//! - face 四层与 rim 描边全部包在挂 mask 的 `<g>` 里（漏包任何一层都会让
//!   该层在尖端重新变成不透明硬边）；
//! - 可见轮廓 path 与 `capsuleShape.ts` 的唯一参数化定义逐字一致——渐隐只改
//!   alpha，**不得**顺手改动几何（几何由 capsuleShape.test.ts 与 Rust 金标准
//!   点位双重锁定）。

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import CapsuleWing from "./CapsuleWing";
import { wingPath, wingRimPath, wingShape } from "../../lib/capsuleShape";
import type { SnapEdge } from "../../lib/edgeSnap";

const EDGES: SnapEdge[] = ["left", "right", "top", "bottom"];

/** 与 CapsuleWing.tsx 的 TIP_FADE_STOPS 同一组台阶（两端对称，手写在此锁定）。 */
const EXPECTED_STOPS: Array<[string, string]> = [
  ["0", "0"],
  ["0.015", "0.28"],
  ["0.045", "0.72"],
  ["0.08", "1"],
  ["0.92", "1"],
  ["0.955", "0.72"],
  ["0.985", "0.28"],
  ["1", "0"],
];

describe("CapsuleWing 尖端渐隐 mask", () => {
  it("mask 渐变台阶与 TIP_FADE_STOPS 一致", () => {
    const { container } = render(<CapsuleWing edge="left" />);
    const grad = container.querySelector("linearGradient[id$='-tip-fade']")!;
    expect(grad).not.toBeNull();
    const fadeStops = Array.from(grad.querySelectorAll("stop")).map(
      (s) => [s.getAttribute("offset") ?? "", s.getAttribute("stop-opacity") ?? ""] as const,
    );
    expect(fadeStops).toEqual(EXPECTED_STOPS);
  });

  it.each(EDGES)("mask 渐变沿沿边轴取向（edge=%s）", (edge) => {
    const { container } = render(<CapsuleWing edge={edge} />);
    const grad = container.querySelector("linearGradient[id$='-tip-fade']")!;
    const shape = wingShape(edge, 1);
    const vertical = edge === "left" || edge === "right";
    const expectCoords = vertical
      ? { x1: "0", y1: "0", x2: "0", y2: String(shape.box.h) }
      : { x1: "0", y1: "0", x2: String(shape.box.w), y2: "0" };
    for (const [key, value] of Object.entries(expectCoords)) {
      expect(grad.getAttribute(key)).toBe(value);
    }
  });

  it.each(EDGES)("face 四层与 rim 都挂在同一 mask 下（edge=%s）", (edge) => {
    const { container } = render(<CapsuleWing edge={edge} />);
    const group = container.querySelector("svg > g[mask]")!;
    expect(group).not.toBeNull();
    // face/shade/haze/spec 四层填充 + rim 描边 = 5 条 path，缺一不可
    const paths = group.querySelectorAll("path");
    expect(paths.length).toBe(5);
    const maskUrl = group.getAttribute("mask") ?? "";
    const maskId = maskUrl.replace(/^url\(#/, "").replace(/\)$/, "");
    const maskEl = container.querySelector(`mask[id='${maskId}']`);
    expect(maskEl).not.toBeNull();
    // mask 自身铺满整个视口，避免默认 objectBoundingBox 只盖到单位矩形
    expect(maskEl!.getAttribute("width")).toBe(String(wingShape(edge, 1).box.w));
    expect(maskEl!.getAttribute("height")).toBe(String(wingShape(edge, 1).box.h));
  });

  it.each(EDGES)("可见轮廓 path 与 capsuleShape 定义逐字一致（edge=%s）", (edge) => {
    const { container } = render(<CapsuleWing edge={edge} />);
    const shape = wingShape(edge, 1);
    const face = container.querySelector("path.cap-wing-face")!;
    expect(face.getAttribute("d")).toBe(wingPath(shape.outline));
    const rim = container.querySelector("path.cap-wing-rim")!;
    expect(rim.getAttribute("d")).toBe(wingRimPath(shape.outline));
  });
});
