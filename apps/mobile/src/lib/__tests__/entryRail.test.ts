// 首页快捷入口横向轨道的几何契约（2026-11-16）。
//
// 这里守的是需求里最容易「看起来对、实际不对」的三件事：
// 1. 入口再多也不换行 → 几何只有一行，内容宽度只由数量与磁贴宽度决定；
// 2. 1~4 个不产生无意义滑动，大屏 5、6 个可以完整显示 → 溢出判定是算出来的，不是数量阈值；
// 3. 滚到末尾最后一个入口必须完整可见 → 最大偏移把最后一个磁贴排在右侧内边距里。
import { describe, expect, it } from "vitest";

import {
  RAIL_INSET,
  clampRailOffset,
  entryTileHeight,
  entryTileLineHeight,
  railMetrics,
  railMinTileWidth,
} from "../entryRail";

const PHONE_WIDTHS = [280, 320, 360, 393, 412, 420, 430, 600, 800, 1024];

describe("railMetrics 单行与溢出判定", () => {
  it("320dp 下 4 个入口仍然单行完整展示（改造前会退化成 2×2）", () => {
    const metrics = railMetrics(320, 4);
    expect(metrics.scrollable).toBe(false);
    expect(metrics.maxOffset).toBe(0);
    expect(metrics.visibleCount).toBe(4);
    expect(metrics.tileWidth).toBe(66);
    // 4 个磁贴 + 3 个间距正好铺满「可视宽度去掉左右内边距」的部分
    expect(metrics.contentSpan).toBe(288);
  });

  it("360dp 下 5 个入口溢出：可滚动，且第 5 个露出边缘作为提示", () => {
    const metrics = railMetrics(360, 5);
    expect(metrics.scrollable).toBe(true);
    expect(metrics.visibleCount).toBe(4);
    // 第 5 个磁贴的左边缘在可视区内（内容自然露出），不是完全切在屏幕外
    const fifthLeft = RAIL_INSET + 4 * metrics.step;
    expect(fifthLeft).toBeLessThan(360);
    expect(metrics.maxOffset).toBeGreaterThan(0);
  });

  it("393dp 下 8 个入口只需一次横向滚动就能看到最后一个", () => {
    const metrics = railMetrics(393, 8);
    expect(metrics.scrollable).toBe(true);
    const lastLeft = RAIL_INSET + 7 * metrics.step - metrics.maxOffset;
    expect(lastLeft + metrics.tileWidth).toBe(393 - RAIL_INSET);
  });

  it("大屏 800dp 下 6 个入口完整显示，不因「超过 4 个」就强行滚动", () => {
    const metrics = railMetrics(800, 6);
    expect(metrics.scrollable).toBe(false);
    expect(metrics.maxOffset).toBe(0);
    expect(metrics.visibleCount).toBe(6);
    expect(metrics.tileWidth).toBe(104);
  });

  it("1 个 / 2 个入口不会为了填满一行无限放大磁贴", () => {
    expect(railMetrics(430, 1).tileWidth).toBe(104);
    expect(railMetrics(430, 1).scrollable).toBe(false);
    expect(railMetrics(430, 2).tileWidth).toBe(104);
    expect(railMetrics(800, 2).tileWidth).toBe(104);
  });

  it("极窄屏 280dp 下 4 个入口压缩到最小宽度并允许滚动（不换行）", () => {
    const metrics = railMetrics(280, 4);
    expect(metrics.tileWidth).toBe(60);
    expect(metrics.scrollable).toBe(true);
    expect(metrics.visibleCount).toBeGreaterThanOrEqual(3);
  });

  it("任意宽度下：要么完整不滚，要么滚到末尾能看到最后一个入口", () => {
    for (const width of PHONE_WIDTHS) {
      for (const count of [1, 2, 3, 4, 5, 6, 8, 10, 16, 24]) {
        const metrics = railMetrics(width, count, 1);
        expect(metrics.tileWidth).toBeGreaterThanOrEqual(60);
        expect(metrics.tileWidth).toBeLessThanOrEqual(104);
        expect(metrics.visibleCount).toBeGreaterThanOrEqual(1);
        if (!metrics.scrollable) {
          // 不滚动时，内容必须真的放得下（含左右内边距）
          expect(metrics.contentSpan + RAIL_INSET * 2).toBeLessThanOrEqual(width + 1);
        } else {
          const lastLeft = RAIL_INSET + (count - 1) * metrics.step - metrics.maxOffset;
          expect(lastLeft + metrics.tileWidth).toBeLessThanOrEqual(width - RAIL_INSET + 0.5);
          expect(lastLeft).toBeGreaterThanOrEqual(RAIL_INSET - 0.5);
        }
      }
    }
  });

  it("空配置返回零尺寸，不产出异常滚动容器", () => {
    const metrics = railMetrics(360, 0);
    expect(metrics.tileWidth).toBe(0);
    expect(metrics.contentSpan).toBe(0);
    expect(metrics.scrollable).toBe(false);
    expect(metrics.visibleCount).toBe(0);
  });

  it("异常输入不会算出负宽度或 NaN", () => {
    const metrics = railMetrics(Number.NaN, Number.NaN, Number.NaN);
    expect(metrics.tileWidth).toBe(0);
    expect(metrics.contentSpan).toBe(0);
    expect(Number.isFinite(metrics.maxOffset)).toBe(true);
    expect(railMetrics(0, 5).tileWidth).toBe(0);
  });
});

describe("railMetrics 高度只跟字体缩放有关", () => {
  it("常规字号高度与改造前一致（78dp），入口数量不改变高度", () => {
    expect(entryTileHeight(1)).toBe(78);
    for (const count of [1, 4, 8, 20]) {
      expect(railMetrics(393, count, 1).tileHeight).toBe(78);
    }
  });

  it("字体放大后抬高磁贴高度与行高，避免两行标签被裁", () => {
    expect(entryTileLineHeight(1)).toBe(14);
    expect(entryTileLineHeight(1.3)).toBe(19);
    expect(entryTileHeight(1.3)).toBe(84);
    expect(entryTileHeight(2)).toBe(104);
    expect(railMetrics(393, 8, 1.3).tileHeight).toBe(84);
  });

  it("字体放大后最小宽度抬一档，名称不被压成省略号", () => {
    expect(railMinTileWidth(1)).toBe(60);
    expect(railMinTileWidth(1.25)).toBe(72);
    expect(railMetrics(320, 4, 1.25).tileWidth).toBeGreaterThanOrEqual(72);
  });
});

describe("clampRailOffset", () => {
  it("收敛到 [0, maxOffset]", () => {
    expect(clampRailOffset(120, 100)).toBe(100);
    expect(clampRailOffset(-20, 100)).toBe(0);
    expect(clampRailOffset(40, 100)).toBe(40);
  });

  it("异常输入安全：maxOffset 为 0 或 NaN 时归零", () => {
    expect(clampRailOffset(80, 0)).toBe(0);
    expect(clampRailOffset(Number.NaN, 40)).toBe(0);
    expect(clampRailOffset(30, Number.NaN)).toBe(0);
    expect(clampRailOffset(-1, -1)).toBe(0);
  });
});
