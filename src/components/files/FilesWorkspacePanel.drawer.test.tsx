/**
 * @vitest-environment jsdom
 *
 * A06 文件工作区：布局抽屉锚点退化与父容器响应式回归（第六轮）。
 * - 优先打开时的触发点；它被容器查询收纳后跟随另一可见按钮；
 * - 两个触发点都不可见时返回 null，由 positionOverride 退化为视口居中，不飞到左上角；
 * - 居中位置有 8px 安全边距且不超出视口；
 * - 窗口尺寸变化与**父容器**尺寸变化都会触发锚点可见性重算。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { drawerCenterOverride, resolveDrawerAnchor, watchAnchorResize } from "./FilesWorkspacePanel";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("抽屉锚点解析", () => {
  it("从工具栏打开：工具栏按钮可见时锚定工具栏", () => {
    expect(resolveDrawerAnchor("toolbar", true, true)).toBe("layout");
    expect(resolveDrawerAnchor("toolbar", true, false)).toBe("layout");
  });

  it("工具栏按钮被收纳（隐藏）后跟随更多按钮", () => {
    expect(resolveDrawerAnchor("toolbar", false, true)).toBe("more");
  });

  it("两个触发点都不可见时返回 null（退化为居中，而不是锚到视口原点）", () => {
    expect(resolveDrawerAnchor("toolbar", false, false)).toBeNull();
    expect(resolveDrawerAnchor("more", false, false)).toBeNull();
  });

  it("从更多菜单打开：更多按钮可见时锚定更多；更多被收纳后回到工具栏", () => {
    expect(resolveDrawerAnchor("more", true, true)).toBe("more");
    expect(resolveDrawerAnchor("more", true, false)).toBe("layout");
  });
});

describe("抽屉居中退化位置", () => {
  it("抽屉未打开或仍有可见锚点时不生成覆盖位置", () => {
    expect(drawerCenterOverride(false, null, { width: 1000, height: 700 })).toBeNull();
    expect(drawerCenterOverride(true, "layout", { width: 1000, height: 700 })).toBeNull();
    expect(drawerCenterOverride(true, "more", { width: 1000, height: 700 })).toBeNull();
  });

  it("锚点全失时按视口居中，并保留 8px 安全边距", () => {
    expect(drawerCenterOverride(true, null, { width: 1000, height: 700 })).toEqual({ left: 360, top: 190 });
  });

  it("小视口/大抽屉时钳制在屏幕内，不超出右/下边界", () => {
    const pos = drawerCenterOverride(true, null, { width: 320, height: 240 }, { width: 280, height: 320 });
    expect(pos).toEqual({ left: 20, top: 8 });

    const clamped = drawerCenterOverride(true, null, { width: 800, height: 400 }, { width: 500, height: 380 });
    // 居中 10px 本身已在 8px 安全边距内且不越下边界，无需强行推到 maxTop=12。
    expect(clamped).toEqual({ left: 150, top: 10 });
  });
});

describe("抽屉锚点尺寸监听", () => {
  it("父容器 ResizeObserver 与 window.resize 都触发重算，取消订阅后停止", () => {
    const callbacks: Array<() => void> = [];
    class FakeResizeObserver {
      private active = true;
      constructor(cb: () => void) {
        callbacks.push(() => {
          if (this.active) cb();
        });
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {
        this.active = false;
      }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    const el = document.createElement("div");
    let count = 0;
    const stop = watchAnchorResize(el, () => {
      count += 1;
    });

    callbacks.forEach((cb) => cb());
    expect(count).toBe(1);
    window.dispatchEvent(new Event("resize"));
    expect(count).toBe(2);

    stop();
    callbacks.forEach((cb) => cb());
    window.dispatchEvent(new Event("resize"));
    expect(count).toBe(2);
  });
});
