//! 矩形框选纯几何/选择合并/自动滚动速度测试（不依赖 DOM 与真实文件系统）。

import { describe, expect, it } from "vitest";

import type { FsEntry } from "../../lib/bridge";
import {
  autoScrollVelocity,
  marqueeHitTest,
  mergeMarqueeSelection,
  moveFocusIndex,
  normalizeMarqueeRect,
  rectsIntersect,
  toMarqueeContentPoint,
  type MarqueeGeometry,
} from "./marqueeSelection";

const DIR = "D:\\marquee-lab";

const entries = (count: number): FsEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    name: `file-${String(index).padStart(5, "0")}.txt`,
    kind: "file" as const,
    ext: "txt",
    size: index,
    modifiedMs: 1,
    hidden: false,
    category: "text" as const,
  }));

const listGeometry = (bodyWidth = 600): MarqueeGeometry => ({
  viewMode: "list",
  rowHeight: 26,
  gridCols: 1,
  gridCellWidth: 104,
  gridCellHeight: 116,
  gridGap: 8,
  gridPaddingX: 4,
  bodyWidth,
});

const gridGeometry = (cols = 6): MarqueeGeometry => ({
  ...listGeometry(600),
  viewMode: "grid",
  gridCols: cols,
});

describe("矩形规格化与相交", () => {
  it("从任意方向拖拽都规格化为左上/右下", () => {
    expect(normalizeMarqueeRect(80, 70, 20, 10)).toEqual({
      left: 20,
      top: 10,
      right: 80,
      bottom: 70,
    });
  });

  it("只有贴边不算相交，零面积矩形不命中", () => {
    expect(rectsIntersect({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false);
    expect(rectsIntersect({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 5, top: 5, right: 20, bottom: 20 })).toBe(true);
  });
});

describe("列表虚拟几何命中", () => {
  it("矩形覆盖三行时只返回三行路径，不依赖 DOM", () => {
    const all = entries(60);
    const hits = marqueeHitTest(all, DIR, { left: 10, top: 28, right: 400, bottom: 96 }, listGeometry());
    expect(hits).toEqual([
      `${DIR}\\file-00001.txt`,
      `${DIR}\\file-00002.txt`,
      `${DIR}\\file-00003.txt`,
    ]);
  });

  it("25000 项目录中框住远端一行：只按虚拟行号命中，不遍历全部条目", () => {
    const all = entries(25_000);
    const hits = marqueeHitTest(
      all,
      DIR,
      { left: 20, top: 20_000 * 26 + 4, right: 300, bottom: 20_000 * 26 + 20 },
      listGeometry(),
    );
    expect(hits).toEqual([`${DIR}\\file-20000.txt`]);
  });

  it("空矩形与空目录返回空集合", () => {
    expect(marqueeHitTest([], DIR, { left: 0, top: 0, right: 10, bottom: 10 }, listGeometry())).toEqual([]);
    expect(marqueeHitTest(entries(5), DIR, { left: 0, top: 0, right: 0, bottom: 10 }, listGeometry())).toEqual([]);
  });
});

describe("网格虚拟几何命中", () => {
  it("6 列网格按实际行列命中，不沿用列表行高", () => {
    const all = entries(30);
    const hits = marqueeHitTest(
      all,
      DIR,
      { left: 4 + 2 * 112, top: 2 * 124, right: 4 + 5 * 112 - 1, bottom: 2 * 124 + 100 },
      gridGeometry(6),
    );
    expect(hits).toEqual([
      `${DIR}\\file-00014.txt`,
      `${DIR}\\file-00015.txt`,
      `${DIR}\\file-00016.txt`,
    ]);
  });

  it("容器宽度改变列数后，同一矩形命中集合按新列数重算", () => {
    const all = entries(30);
    const rect = { left: 4 + 112, top: 2 * 124, right: 4 + 2 * 112 - 1, bottom: 2 * 124 + 80 };
    expect(marqueeHitTest(all, DIR, rect, gridGeometry(6))).toEqual([`${DIR}\\file-00013.txt`]);
    expect(marqueeHitTest(all, DIR, rect, gridGeometry(4))).toEqual([`${DIR}\\file-00009.txt`]);
  });
});

describe("基准集合合并（一次拖拽语义稳定）", () => {
  const base = ["a", "b", "c"];
  const candidates = ["b", "c", "d"];

  it("普通框选替换", () => {
    expect(mergeMarqueeSelection(base, candidates, "replace")).toEqual(["b", "c", "d"]);
  });

  it("Shift 框选为并集且去重", () => {
    expect(mergeMarqueeSelection(base, candidates, "add")).toEqual(["a", "b", "c", "d"]);
  });

  it("Ctrl 框选以按下时基准集合对称差，不随帧翻转", () => {
    expect(mergeMarqueeSelection(base, candidates, "toggle")).toEqual(["a", "d"]);
    expect(mergeMarqueeSelection(base, ["b"], "toggle")).toEqual(["a", "c"]);
  });
});

describe("自动滚动速度", () => {
  it("边缘内加速、中心为零、超过上限封顶", () => {
    expect(autoScrollVelocity(50, 0, 400)).toBe(0);
    expect(autoScrollVelocity(10, 0, 400)).toBeLessThan(0);
    expect(autoScrollVelocity(0, 0, 400)).toBe(-14);
    expect(autoScrollVelocity(390, 0, 400)).toBeGreaterThan(0);
    expect(autoScrollVelocity(400, 0, 400)).toBe(14);
    expect(autoScrollVelocity(-50, 0, 400)).toBe(-14);
  });
});

describe("键盘焦点移动", () => {
  it("列表上下移动，网格上下跨列且钳制边界", () => {
    expect(moveFocusIndex(0, "ArrowDown", 10, "list", 1)).toBe(1);
    expect(moveFocusIndex(2, "ArrowDown", 10, "grid", 4)).toBe(6);
    expect(moveFocusIndex(6, "ArrowUp", 10, "grid", 4)).toBe(2);
    expect(moveFocusIndex(9, "ArrowRight", 10, "list", 1)).toBe(9);
    expect(moveFocusIndex(0, "Home", 10, "list", 1)).toBe(0);
    expect(moveFocusIndex(0, "End", 10, "list", 1)).toBe(9);
  });
});

describe("指针坐标换算", () => {
  it("列表减吸顶表头，网格不减", () => {
    const body = { left: 100, top: 50, width: 600, height: 400 };
    expect(toMarqueeContentPoint(200, 150, body, 20, 26)).toEqual({ x: 100, y: 94 });
    expect(toMarqueeContentPoint(200, 150, body, 20, 0)).toEqual({ x: 100, y: 120 });
  });
});
