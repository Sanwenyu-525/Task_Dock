// 拖拽落点数学（P1）：真机上最容易出现「拖到右下角没反应」「松手后跳到第一格」
// 这类错乱，全部源于位移到下标换算的边界。这里穷举边界，而不是上真机撞运气。
import { describe, expect, it } from "vitest";

import {
  clampIndex,
  gridDropIndex,
  isTapGesture,
  listDropIndex,
  settleReorder,
} from "../entryReorder";

const METRICS = { columns: 4, columnStep: 100, rowStep: 100 };

describe("clampIndex", () => {
  it("收敛到合法范围", () => {
    expect(clampIndex(-3, 5)).toBe(0);
    expect(clampIndex(9, 5)).toBe(4);
    expect(clampIndex(2.4, 5)).toBe(2);
    expect(clampIndex(Number.NaN, 5)).toBe(0);
    expect(clampIndex(3, 0)).toBe(0);
  });
});

describe("gridDropIndex", () => {
  it("原地不动就是原下标", () => {
    expect(gridDropIndex(3, 0, 0, METRICS, 8)).toBe(3);
  });

  it("横向一格 / 纵向一行按步进换算", () => {
    expect(gridDropIndex(0, 100, 0, METRICS, 8)).toBe(1);
    expect(gridDropIndex(0, 0, 100, METRICS, 8)).toBe(4);
    expect(gridDropIndex(0, 100, 100, METRICS, 8)).toBe(5);
  });

  it("不足半格不换格，过半格才换", () => {
    expect(gridDropIndex(0, 49, 0, METRICS, 8)).toBe(0);
    expect(gridDropIndex(0, 51, 0, METRICS, 8)).toBe(1);
  });

  it("超出右边界被夹在行尾，不会跨到下一行", () => {
    expect(gridDropIndex(1, 400, 0, METRICS, 8)).toBe(3);
  });

  it("拖到右下空白处收敛到最后一个入口", () => {
    // 5 个入口、4 列：最后一行只有 1 个，拖到 (1,2) 的空格等于放到最后
    expect(gridDropIndex(0, 300, 200, METRICS, 5)).toBe(4);
  });

  it("向左/向上越界收敛到 0", () => {
    expect(gridDropIndex(2, -300, 0, METRICS, 8)).toBe(0);
    expect(gridDropIndex(5, 0, -200, METRICS, 8)).toBe(1);
  });

  it("窄屏两列仍然正确", () => {
    const narrow = { columns: 2, columnStep: 150, rowStep: 100 };
    expect(gridDropIndex(0, 150, 0, narrow, 6)).toBe(1);
    expect(gridDropIndex(0, 0, 100, narrow, 6)).toBe(2);
    expect(gridDropIndex(0, 150, 100, narrow, 6)).toBe(3);
  });

  it("异常输入不会算出负数或超界", () => {
    // 非有限位移按 0 处理（宁可不动，也不要跳到别处）
    expect(gridDropIndex(0, Number.NaN, Number.POSITIVE_INFINITY, METRICS, 5)).toBe(0);
    expect(gridDropIndex(0, Number.NaN, Number.NaN, METRICS, 5)).toBe(0);
    expect(gridDropIndex(0, 0, 0, { columns: 4, columnStep: 0, rowStep: 0 }, 5)).toBe(0);
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
