//! Edge Tab 手势判定纯函数测试。
//!
//! 重点：标签很小，松手时必须一次性区分「点击恢复 / 沿边拖动 / 向内拖动恢复」，
//! 且拖动结束不能再次触发点击恢复。

import { describe, expect, it } from "vitest";
import { TAB_CLICK_SLOP_CSS, TAB_RESTORE_DRAG_CSS } from "./capsuleLayout";
import { classifyTabGesture, tabAlongDelta, tabInwardDelta } from "./edgeTabGesture";

describe("Edge Tab · 法向/沿边位移换算", () => {
  it("法向位移指向屏幕内部：左停靠看 +dx，右停靠看 -dx", () => {
    expect(tabInwardDelta("left", 10, 0)).toBe(10);
    expect(tabInwardDelta("right", -10, 0)).toBe(10);
    expect(tabInwardDelta("left", -10, 0)).toBe(-10);
  });

  it("法向位移指向屏幕内部：上停靠看 +dy，下停靠看 -dy", () => {
    expect(tabInwardDelta("top", 0, 10)).toBe(10);
    expect(tabInwardDelta("bottom", 0, -10)).toBe(10);
  });

  it("沿边位移与窗口坐标同向（下/右为正）", () => {
    expect(tabAlongDelta("left", 0, 12)).toBe(12);
    expect(tabAlongDelta("right", 0, -12)).toBe(-12);
    expect(tabAlongDelta("top", 12, 0)).toBe(12);
    expect(tabAlongDelta("bottom", -12, 0)).toBe(-12);
    expect(tabAlongDelta("left", 40, 3)).toBe(3); // 法向分量不参与沿边拖动
  });
});

describe("Edge Tab · classifyTabGesture", () => {
  it("位移小于点击阈值 → click（四个边一致）", () => {
    for (const edge of ["left", "right", "top", "bottom"] as const) {
      expect(classifyTabGesture(edge, 1, 1)).toBe("click");
      expect(classifyTabGesture(edge, TAB_CLICK_SLOP_CSS - 1, 0)).toBe("click");
    }
  });

  it("明显向内拖动达到法向阈值 → restore（左右镜像）", () => {
    expect(classifyTabGesture("left", TAB_RESTORE_DRAG_CSS, 0)).toBe("restore");
    expect(classifyTabGesture("right", -TAB_RESTORE_DRAG_CSS, 0)).toBe("restore");
    expect(classifyTabGesture("top", 0, TAB_RESTORE_DRAG_CSS)).toBe("restore");
    expect(classifyTabGesture("bottom", 0, -TAB_RESTORE_DRAG_CSS)).toBe("restore");
  });

  it("向内位移不足 → drag（只沿边移动，不恢复）", () => {
    for (const edge of ["left", "right", "top", "bottom"] as const) {
      const inward = TAB_RESTORE_DRAG_CSS - 1;
      const dx = edge === "left" ? inward : edge === "right" ? -inward : 0;
      const dy = edge === "top" ? inward : edge === "bottom" ? -inward : 0;
      expect(classifyTabGesture(edge, dx, dy)).toBe("drag");
    }
  });

  it("沿边位移占优时不误判为恢复", () => {
    expect(classifyTabGesture("left", TAB_RESTORE_DRAG_CSS, 40)).toBe("drag");
    expect(classifyTabGesture("right", -TAB_RESTORE_DRAG_CSS, -40)).toBe("drag");
  });

  it("沿边拖动即使超过法向阈值也仍是 drag", () => {
    expect(classifyTabGesture("left", 0, 60)).toBe("drag");
    expect(classifyTabGesture("right", 0, -60)).toBe("drag");
  });

  it("向外拖动（远离屏幕内部）不恢复", () => {
    expect(classifyTabGesture("left", -TAB_RESTORE_DRAG_CSS * 2, 0)).toBe("drag");
    expect(classifyTabGesture("top", 0, -TAB_RESTORE_DRAG_CSS * 2)).toBe("drag");
  });
});
