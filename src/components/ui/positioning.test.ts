//! 弹层定位核心的纯函数测试（node 环境，不依赖 DOM）。
//!
//! 覆盖：窗口四角/中心、宽弹层、上下面都不足、左右都不足、窄/极窄窗口、
//! 不同 padding、不同 alignment/side、指针四边翻转、无锚点居中。

import { describe, expect, it } from "vitest";
import {
  calculatePopupAvailableSpace,
  centerPopupInViewport,
  constrainPopupSize,
  parsePlacement,
  resolvePointerMenuPosition,
  resolvePopupAlignment,
  resolvePopupPlacement,
  toFloatingPlacement,
} from "./positioning";

const VIEWPORT = { width: 1280, height: 800 };

describe("calculatePopupAvailableSpace", () => {
  it("按 side 扣掉 collisionPadding 与 offset，并保留四边净空间", () => {
    const space = calculatePopupAvailableSpace({
      anchor: { left: 10, top: 10, width: 40, height: 20 },
      viewport: VIEWPORT,
      side: "bottom",
      offset: 6,
      padding: 8,
    });
    expect(space.bottom).toBe(800 - 30 - 8 - 6);
    expect(space.top).toBe(0); // 负空间收敛为 0
    expect(space.left).toBe(0);
    expect(space.right).toBe(1280 - 50 - 8 - 6);
    expect(space.main).toBe(space.bottom);
    expect(space.cross).toBe(1280 - 16);
  });

  it("left/right 的主方向是左右空间，交叉轴是视口高度", () => {
    const space = calculatePopupAvailableSpace({
      anchor: { left: 200, top: 100, width: 80, height: 40 },
      viewport: VIEWPORT,
      side: "right",
      offset: 10,
      padding: 12,
    });
    expect(space.right).toBe(1280 - 280 - 12 - 10);
    expect(space.main).toBe(space.right);
    expect(space.cross).toBe(800 - 24);
  });

  it("padding 为 0 时贴边计算，不额外收缩", () => {
    const space = calculatePopupAvailableSpace({
      anchor: { left: 0, top: 0, width: 10, height: 10 },
      viewport: { width: 300, height: 200 },
      side: "bottom",
      offset: 0,
      padding: 0,
    });
    expect(space.bottom).toBe(190);
    expect(space.left).toBe(0);
  });
});

describe("resolvePopupAlignment", () => {
  it("start 左缘对齐；空间不足时平移但不改对齐", () => {
    const resolved = resolvePopupAlignment({
      anchorLeft: 0,
      anchorWidth: 40,
      popupWidth: 300,
      viewportWidth: 320,
      alignment: "start",
    });
    expect(resolved.alignment).toBe("start");
    expect(resolved.left).toBe(8);
    expect(resolved.shifted).toBe(true);
  });

  it("end 右缘对齐；窗口左侧放不下时夹到留白，对齐仍是 end", () => {
    const resolved = resolvePopupAlignment({
      anchorLeft: 0,
      anchorWidth: 40,
      popupWidth: 300,
      viewportWidth: 320,
      alignment: "end",
    });
    expect(resolved.alignment).toBe("end");
    expect(resolved.left).toBe(8);
    expect(resolved.shifted).toBe(true);
  });

  it("center 中心对齐", () => {
    const resolved = resolvePopupAlignment({
      anchorLeft: 400,
      anchorWidth: 100,
      popupWidth: 300,
      viewportWidth: 1280,
      alignment: "center",
    });
    expect(resolved.alignment).toBe("center");
    expect(resolved.left).toBe(400 + 50 - 150);
    expect(resolved.shifted).toBe(false);
  });

  it("auto：start 放得下就保持 start（即使 end 也放得下）", () => {
    const resolved = resolvePopupAlignment({
      anchorLeft: 200,
      anchorWidth: 80,
      popupWidth: 300,
      viewportWidth: 1280,
      alignment: "auto",
    });
    expect(resolved.alignment).toBe("start");
    expect(resolved.shifted).toBe(false);
  });

  it("auto：靠近右缘 start 放不下时切到 end", () => {
    const resolved = resolvePopupAlignment({
      anchorLeft: 1000,
      anchorWidth: 40,
      popupWidth: 300,
      viewportWidth: 1280,
      alignment: "auto",
    });
    expect(resolved.alignment).toBe("end");
    expect(resolved.left).toBe(740);
    expect(resolved.shifted).toBe(false);
  });

  it("auto：都放不下时选夹取最少的一侧并收敛", () => {
    const resolved = resolvePopupAlignment({
      anchorLeft: 100,
      anchorWidth: 50,
      popupWidth: 300,
      viewportWidth: 200,
      alignment: "auto",
    });
    expect(resolved.left).toBe(8);
    expect(resolved.left + 300).toBeGreaterThan(200 - 8); // 确实装不下
    expect(resolved.shifted).toBe(true);
  });

  it("弹层宽度未知时 auto 退回 start，不做猜测", () => {
    const resolved = resolvePopupAlignment({
      anchorLeft: 600,
      anchorWidth: 40,
      popupWidth: 0,
      viewportWidth: 1280,
      alignment: "auto",
    });
    expect(resolved.alignment).toBe("start");
    expect(resolved.left).toBe(600);
  });
});

describe("resolvePopupPlacement", () => {
  it("窗口中心：下方放得下，保持 bottom-start", () => {
    const result = resolvePopupPlacement({
      anchor: { left: 400, top: 400, width: 120, height: 32 },
      popup: { width: 320, height: 200 },
      viewport: VIEWPORT,
      config: { side: "bottom", alignment: "start" },
    });
    expect(result.side).toBe("bottom");
    expect(result.alignment).toBe("start");
    expect(result.top).toBe(400 + 32 + 6);
    expect(result.left).toBe(400);
    expect(result.flipped).toBe(false);
    expect(result.constrained).toBe(false);
  });

  it("窗口左下角：下方放不下，翻到上方", () => {
    const result = resolvePopupPlacement({
      anchor: { left: 8, top: 740, width: 120, height: 40 },
      popup: { width: 320, height: 180 },
      viewport: VIEWPORT,
      config: { side: "bottom", alignment: "start" },
    });
    expect(result.side).toBe("top");
    expect(result.flipped).toBe(true);
    expect(result.top).toBe(740 - 6 - 180);
    expect(result.left).toBe(8);
  });

  it("窗口右上角：下方放得下但 start 溢出，auto 切到 end", () => {
    const result = resolvePopupPlacement({
      anchor: { left: 1180, top: 80, width: 60, height: 30 },
      popup: { width: 320, height: 180 },
      viewport: VIEWPORT,
      config: { side: "bottom", alignment: "auto" },
    });
    expect(result.alignment).toBe("end");
    expect(result.left).toBe(1180 + 60 - 320);
    expect(result.flipped).toBe(false);
    expect(result.left + 320).toBeLessThanOrEqual(1280 - 8);
  });

  it("上下都放不下：留在空间更大的一侧并夹取，不越界", () => {
    const result = resolvePopupPlacement({
      anchor: { left: 60, top: 100, width: 100, height: 50 },
      popup: { width: 280, height: 200 },
      viewport: { width: 400, height: 300 },
      config: { side: "bottom", alignment: "start" },
    });
    expect(result.side).toBe("bottom");
    expect(result.constrained).toBe(true);
    expect(result.top).toBeGreaterThanOrEqual(8);
    expect(result.top + 200).toBeLessThanOrEqual(300 - 8);
    expect(result.shifted).toBe(true);
  });

  it("上下都不足且上方略大：翻到上方", () => {
    const result = resolvePopupPlacement({
      anchor: { left: 60, top: 180, width: 100, height: 20 },
      popup: { width: 200, height: 160 },
      viewport: { width: 400, height: 300 },
      config: { side: "bottom", alignment: "start" },
    });
    expect(result.side).toBe("top");
    expect(result.top).toBe(180 - 6 - 160);
  });

  it("极窄窗口：弹层比可用空间宽，宽度被约束且不越界", () => {
    const result = resolvePopupPlacement({
      anchor: { left: 20, top: 50, width: 260, height: 30 },
      popup: { width: 420, height: 160 },
      viewport: { width: 320, height: 640 },
      config: { side: "bottom", alignment: "start", maxWidth: 420 },
    });
    expect(result.constrained).toBe(true);
    expect(result.availableWidth).toBe(320 - 16);
    expect(result.left).toBe(8);
    expect(result.left + 420).toBeGreaterThan(320 - 8); // 需要调用方按 available 收缩
  });

  it("右侧弹层：右侧放不下时翻到左侧，并垂直居中", () => {
    const result = resolvePopupPlacement({
      anchor: { left: 1150, top: 300, width: 60, height: 40 },
      popup: { width: 240, height: 180 },
      viewport: VIEWPORT,
      config: { side: "right", alignment: "center" },
    });
    expect(result.side).toBe("left");
    expect(result.left).toBe(1150 - 6 - 240);
    expect(result.alignment).toBe("center");
    expect(result.top).toBe(300 + 20 - 90);
  });

  it("未知尺寸不做翻转，只按首选 side 输出锚定坐标", () => {
    const result = resolvePopupPlacement({
      anchor: { left: 100, top: 740, width: 100, height: 40 },
      popup: { width: 0, height: 0 },
      viewport: VIEWPORT,
      config: { side: "bottom", alignment: "start" },
    });
    expect(result.side).toBe("bottom");
    expect(result.flipped).toBe(false);
    expect(result.top).toBe(786);
  });

  it("allowFlip=false 时保持主方向，靠夹取避免越界", () => {
    const result = resolvePopupPlacement({
      anchor: { left: 8, top: 740, width: 120, height: 40 },
      popup: { width: 200, height: 180 },
      viewport: VIEWPORT,
      config: { side: "bottom", alignment: "start", allowFlip: false },
    });
    expect(result.side).toBe("bottom");
    expect(result.flipped).toBe(false);
    expect(result.top + 180).toBeLessThanOrEqual(800 - 8);
  });
});

describe("constrainPopupSize", () => {
  it("minWidth 被收到 maxWidth 以内：不越界优先于「和触发器一样宽」", () => {
    const limits = constrainPopupSize({
      anchorWidth: 260,
      availableWidth: 180,
      availableHeight: 500,
      config: { matchAnchorWidth: true, minWidth: 240, maxWidth: 560 },
    });
    expect(limits.maxWidth).toBe(180);
    expect(limits.minWidth).toBe(180);
  });

  it("内容上限小于可用空间时用内容上限", () => {
    const limits = constrainPopupSize({
      anchorWidth: 100,
      availableWidth: 600,
      availableHeight: 700,
      config: { maxHeight: 320, maxWidth: 420 },
    });
    expect(limits.maxWidth).toBe(420);
    expect(limits.maxHeight).toBe(320);
    expect(limits.minWidth).toBe(0);
  });

  it("matchAnchorWidth 在没有显式下限时以触发器宽度为下限", () => {
    const limits = constrainPopupSize({
      anchorWidth: 240,
      availableWidth: 500,
      availableHeight: 400,
      config: { matchAnchorWidth: true },
    });
    expect(limits.minWidth).toBe(240);
  });
});

describe("resolvePointerMenuPosition", () => {
  it("默认从指针右下展开", () => {
    const pos = resolvePointerMenuPosition({ x: 100, y: 100 }, { width: 200, height: 150 }, VIEWPORT);
    expect(pos).toEqual({ left: 100, top: 100, flippedX: false, flippedY: false });
  });

  it("右下角空间不足：向左、向上翻转", () => {
    const pos = resolvePointerMenuPosition({ x: 1200, y: 740 }, { width: 220, height: 180 }, VIEWPORT);
    expect(pos.left).toBe(1200 - 220);
    expect(pos.top).toBe(740 - 180);
    expect(pos.flippedX).toBe(true);
    expect(pos.flippedY).toBe(true);
  });

  it("只差一边：只翻转那一边", () => {
    const pos = resolvePointerMenuPosition({ x: 1200, y: 100 }, { width: 220, height: 180 }, VIEWPORT);
    expect(pos.flippedX).toBe(true);
    expect(pos.flippedY).toBe(false);
    expect(pos.top).toBe(100);
  });

  it("菜单大于窗口：坐标收敛到留白，不出现负值", () => {
    const pos = resolvePointerMenuPosition(
      { x: 100, y: 100 },
      { width: 1300, height: 900 },
      { width: 320, height: 240 },
    );
    expect(pos.left).toBe(8);
    expect(pos.top).toBe(8);
    expect(pos.flippedX).toBe(true);
    expect(pos.flippedY).toBe(true);
  });

  it("尺寸未知时只夹指针坐标，不做翻转", () => {
    const pos = resolvePointerMenuPosition({ x: -20, y: 900 }, { width: 0, height: 0 }, VIEWPORT);
    expect(pos.left).toBe(8);
    expect(pos.top).toBe(792);
    expect(pos.flippedX).toBe(false);
    expect(pos.flippedY).toBe(false);
  });
});

describe("centerPopupInViewport", () => {
  it("居中且在窗口内", () => {
    expect(centerPopupInViewport({ width: 320, height: 200 }, VIEWPORT)).toEqual({
      left: 480,
      top: 300,
    });
  });

  it("大于窗口时贴住留白，不产生负坐标", () => {
    expect(centerPopupInViewport({ width: 1400, height: 900 }, VIEWPORT)).toEqual({
      left: 8,
      top: 8,
    });
  });
});

describe("placement 解析", () => {
  it("裸 side 是居中对齐，side-align 是显式对齐", () => {
    expect(parsePlacement("bottom")).toEqual({ side: "bottom", alignment: "center" });
    expect(parsePlacement("bottom-start")).toEqual({ side: "bottom", alignment: "start" });
    expect(parsePlacement("right-end")).toEqual({ side: "right", alignment: "end" });
  });

  it("toFloatingPlacement 与 parsePlacement 互逆（center 用裸 side）", () => {
    expect(toFloatingPlacement("top", "center")).toBe("top");
    expect(toFloatingPlacement("top", "start")).toBe("top-start");
    expect(parsePlacement(toFloatingPlacement("left", "end"))).toEqual({
      side: "left",
      alignment: "end",
    });
  });
});
