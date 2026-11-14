//! 导航拖拽排序的几何计算：落点、让位、边缘自动滚动。
//!
//! 这些函数只吃「拖拽开始时测量的行矩形」，因此可以在 Node 环境直接验证，
//! 不需要浏览器布局：组件里的每帧计算都应该是这里某个纯函数的组合。

import { describe, expect, it } from "vitest";
import {
  NAV_REORDER_DEFAULT_GAP,
  autoScrollStep,
  dropIndexForPoint,
  reorderShifts,
  slotGap,
  type NavReorderSlot,
} from "./navReorder";

const ROW = 32;
const GAP = 2;

/** 生成等高行快照：top = index * (ROW + GAP)。 */
function slots(ids: string[]): NavReorderSlot[] {
  return ids.map((id, index) => ({ id, top: index * (ROW + GAP), height: ROW }));
}

describe("导航拖拽几何", () => {
  it("行距用真实测量推导，测量缺失时回退默认值", () => {
    expect(slotGap(slots(["a", "b", "c"]))).toBe(GAP);
    expect(slotGap([])).toBe(NAV_REORDER_DEFAULT_GAP);
    expect(slotGap(slots(["a"]))).toBe(NAV_REORDER_DEFAULT_GAP);
  });

  it("落点按行中心线计算，跨过中心才排到该行之后", () => {
    const list = slots(["a", "b", "c"]);
    // 行中心：a=16, b=50, c=84
    expect(dropIndexForPoint(list, "a", 0)).toBe(0);
    expect(dropIndexForPoint(list, "a", 15)).toBe(0);
    expect(dropIndexForPoint(list, "a", 16)).toBe(0); // 尚未越过 b 的中心
    expect(dropIndexForPoint(list, "a", 49)).toBe(0);
    expect(dropIndexForPoint(list, "a", 50)).toBe(1); // 越过 b 中心 → 落在 b 之后
    expect(dropIndexForPoint(list, "a", 84)).toBe(2); // 越过 c 中心 → 落在末尾
    expect(dropIndexForPoint(list, "a", 999)).toBe(2); // 拖出下边界钳制在末尾
  });

  it("被拖行不参与落点计数（不会把自己算成目标）", () => {
    const list = slots(["a", "b", "c"]);
    expect(dropIndexForPoint(list, "b", 0)).toBe(0);
    expect(dropIndexForPoint(list, "b", 999)).toBe(2);
  });

  it("向下拖动时中间行整体上移一行，间距含行距", () => {
    const list = slots(["a", "b", "c", "d"]);
    const shifts = reorderShifts(list, "a", 2);
    expect(shifts.get("a")).toBeUndefined();
    expect(shifts.get("b")).toBe(-(ROW + GAP));
    expect(shifts.get("c")).toBe(-(ROW + GAP));
    expect(shifts.get("d")).toBeUndefined();
  });

  it("向上拖动时中间行整体下移一行", () => {
    const list = slots(["a", "b", "c", "d"]);
    const shifts = reorderShifts(list, "d", 1);
    expect(shifts.get("b")).toBe(ROW + GAP);
    expect(shifts.get("c")).toBe(ROW + GAP);
    expect(shifts.get("a")).toBeUndefined();
  });

  it("固定入口不参与让位（不暗示可移动）", () => {
    const list = slots(["a", "settings"]);
    const shifts = reorderShifts(list, "a", 0, (id) => id === "settings");
    expect(shifts.size).toBe(0);
  });

  it("位置没变时没有任何让位位移", () => {
    const list = slots(["a", "b", "c"]);
    expect(reorderShifts(list, "b", 1).size).toBe(0);
    expect(reorderShifts(slots(["a"]), "a", 0).size).toBe(0);
  });

  it("边缘自动滚动：中间为 0，越靠边越快，方向正确", () => {
    expect(autoScrollStep(200, 0, 400)).toBe(0);
    expect(autoScrollStep(180, 0, 400)).toBe(0); // 距上边 180 > 36，无滚动

    const nearTop = autoScrollStep(10, 0, 400);
    const closerTop = autoScrollStep(1, 0, 400);
    expect(nearTop).toBeLessThan(0);
    expect(closerTop).toBeLessThan(nearTop); // 更靠边速度更大（更负）

    const nearBottom = autoScrollStep(390, 0, 400);
    const outsideBottom = autoScrollStep(460, 0, 400);
    expect(nearBottom).toBeGreaterThan(0);
    expect(outsideBottom).toBeGreaterThan(nearBottom);
  });

  it("容器高度非法或参数为 0 时不滚动（不产生 NaN）", () => {
    expect(autoScrollStep(10, 100, 100)).toBe(0);
    expect(autoScrollStep(10, 200, 100)).toBe(0);
    expect(autoScrollStep(10, 0, 400, 0)).toBe(0);
    expect(autoScrollStep(10, 0, 400, 36, 0)).toBe(0);
  });

  it("自动滚动速度有上限，不会因为指针远在容器外而无限加速", () => {
    expect(autoScrollStep(-5000, 0, 400)).toBe(-14);
    expect(autoScrollStep(5000, 0, 400)).toBe(14);
  });
});
