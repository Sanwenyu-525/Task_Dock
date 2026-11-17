// 底部弹层拖拽关闭判定：验收表 11 的纯逻辑部分。
// 触摸范围由 BottomSheet 的 48dp 拖拽区保证；这里固定「哪些手势应关闭、哪些应回弹」。
import { describe, expect, it } from "vitest";

import {
  SHEET_DISMISS_DISTANCE,
  SHEET_DISMISS_VELOCITY,
  SHEET_DRAG_START_SLOP,
  shouldCaptureSheetDrag,
  shouldDismissSheet,
} from "../sheetDismiss";

describe("shouldCaptureSheetDrag", () => {
  it("短位移不接手势：拖拽条上的点按不会被当成拖动", () => {
    expect(shouldCaptureSheetDrag(0, 0)).toBe(false);
    expect(shouldCaptureSheetDrag(SHEET_DRAG_START_SLOP, 0)).toBe(false);
    expect(shouldCaptureSheetDrag(SHEET_DRAG_START_SLOP + 0.1, 0)).toBe(true);
  });

  it("只接纵向向下：向上拖或横向滑动交给内部 ScrollView", () => {
    expect(shouldCaptureSheetDrag(20, 150)).toBe(false);
    expect(shouldCaptureSheetDrag(-20, 0)).toBe(false);
    expect(shouldCaptureSheetDrag(40, 10)).toBe(true);
  });
});

describe("shouldDismissSheet", () => {
  it("位移不足且速度不快：回弹，不误关闭", () => {
    expect(shouldDismissSheet(10, 0)).toBe(false);
    expect(shouldDismissSheet(SHEET_DISMISS_DISTANCE, 0.2)).toBe(false);
  });

  it("超过距离阈值即关闭（从横线附近往下拖也能关）", () => {
    expect(shouldDismissSheet(SHEET_DISMISS_DISTANCE + 1, 0)).toBe(true);
  });

  it("快速下滑即使距离不够也关闭", () => {
    expect(shouldDismissSheet(20, SHEET_DISMISS_VELOCITY + 0.1)).toBe(true);
  });

  it("向上快速拖动不关闭", () => {
    expect(shouldDismissSheet(-60, -1.5)).toBe(false);
  });

  it("完全没动不关闭", () => {
    expect(shouldDismissSheet(0, 0)).toBe(false);
  });
});
