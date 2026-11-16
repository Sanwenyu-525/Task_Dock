// 拖拽落点数学（P1）：真机上最容易出现「拖到最后一个没反应」「松手后跳到最前面」
// 这类错乱，全部源于位移到下标换算的边界。这里穷举边界，而不是上真机撞运气。
import { describe, expect, it } from "vitest";

import {
  clampIndex,
  isTapGesture,
  listDropIndex,
  railDropIndex,
  settleReorder,
} from "../entryReorder";

const STEP = 100;

describe("clampIndex", () => {
  it("收敛到合法范围", () => {
    expect(clampIndex(-3, 5)).toBe(0);
    expect(clampIndex(9, 5)).toBe(4);
    expect(clampIndex(2.4, 5)).toBe(2);
    expect(clampIndex(Number.NaN, 5)).toBe(0);
    expect(clampIndex(3, 0)).toBe(0);
  });
});

describe("railDropIndex", () => {
  it("原地不动就是原下标（纵向抖动不参与换位）", () => {
    expect(railDropIndex(3, 0, STEP, 8)).toBe(3);
  });

  it("横向一格按步进换算", () => {
    expect(railDropIndex(0, STEP, STEP, 8)).toBe(1);
    expect(railDropIndex(4, -STEP, STEP, 8)).toBe(3);
    expect(railDropIndex(0, 3 * STEP, STEP, 8)).toBe(3);
  });

  it("不足半格不换位，过半格才换位", () => {
    expect(railDropIndex(0, 49, STEP, 8)).toBe(0);
    expect(railDropIndex(0, 51, STEP, 8)).toBe(1);
  });

  it("首尾越界都收敛，不会算出负数或超出末端", () => {
    expect(railDropIndex(1, 4000, STEP, 8)).toBe(7);
    expect(railDropIndex(7, -4000, STEP, 8)).toBe(0);
    expect(railDropIndex(2, 50, STEP, 3)).toBe(3 - 1);
  });

  it("空列表与异常输入安全", () => {
    expect(railDropIndex(0, 100, STEP, 0)).toBe(0);
    expect(railDropIndex(0, Number.NaN, STEP, 5)).toBe(0);
    expect(railDropIndex(2, 100, 0, 5)).toBe(3);
    expect(railDropIndex(-1, 0, STEP, 5)).toBe(0);
  });
});

describe("listDropIndex", () => {
  it("按行步进换算并收敛", () => {
    expect(listDropIndex(1, 0, 60, 5)).toBe(1);
    expect(listDropIndex(1, 60, 60, 5)).toBe(2);
    expect(listDropIndex(1, 400, 60, 5)).toBe(4);
    expect(listDropIndex(4, -400, 60, 5)).toBe(0);
    expect(listDropIndex(0, Number.NaN, 60, 5)).toBe(0);
  });
});

describe("isTapGesture", () => {
  it("小位移算点按，大位移算拖动", () => {
    expect(isTapGesture(3, -2)).toBe(true);
    expect(isTapGesture(0, 6)).toBe(true);
    expect(isTapGesture(5, 7)).toBe(false);
    expect(isTapGesture(12, 0)).toBe(false);
  });
});

describe("settleReorder", () => {
  const ROW = 72;

  it("不足半行不换位", () => {
    expect(settleReorder(1, 20, 0, ROW, 4)).toEqual({ index: 1, swaps: 0, moved: false });
  });

  it("过半行向下换一位", () => {
    expect(settleReorder(1, 40, 0, ROW, 4)).toEqual({ index: 2, swaps: 1, moved: true });
  });

  it("过半行向上换一位", () => {
    expect(settleReorder(2, -40, 0, ROW, 4)).toEqual({ index: 1, swaps: -1, moved: true });
  });

  it("连续跨行一次到位，net swaps 供 translateY 抵消手指位移", () => {
    const settled = settleReorder(0, 3 * ROW + 10, 0, ROW, 5);
    expect(settled.index).toBe(3);
    expect(settled.swaps).toBe(3);
    expect(settled.moved).toBe(true);
  });

  it("到达两端后不再换位，且不会越过边界", () => {
    expect(settleReorder(3, 400, 0, ROW, 4)).toEqual({ index: 3, swaps: 0, moved: false });
    expect(settleReorder(0, -400, 0, ROW, 4)).toEqual({ index: 0, swaps: 0, moved: false });
  });

  it("回拖时 swaps 跟随回退", () => {
    // 已经换过一次位（swaps=1），手指回到原位附近 → 回到原下标
    expect(settleReorder(1, 0, 1, ROW, 4)).toEqual({ index: 0, swaps: 0, moved: true });
  });

  it("空列表与异常输入安全", () => {
    expect(settleReorder(0, 100, 0, ROW, 0)).toEqual({ index: 0, swaps: 0, moved: false });
    expect(settleReorder(0, Number.NaN, Number.NaN, ROW, 3)).toEqual({
      index: 0,
      swaps: 0,
      moved: false,
    });
  });
});
