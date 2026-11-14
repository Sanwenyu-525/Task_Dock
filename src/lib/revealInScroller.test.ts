/**
 * @vitest-environment jsdom
 */
//! 调整条的最小必要滚动（2026-11-14）：只补差额、只滚最近的可滚动祖先、不横向滚动。

import { afterEach, describe, expect, it } from "vitest";
import { revealInScroller } from "./revealInScroller";

function box(top: number, height: number, width = 300, left = 0): DOMRect {
  return {
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function makeScroller(scrollTop: number, viewport: { top: number; height: number }) {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
  scroller.scrollTop = scrollTop;
  scroller.getBoundingClientRect = () => box(viewport.top, viewport.height);
  document.body.appendChild(scroller);
  return scroller;
}

function append(parent: HTMLElement, rect: DOMRect) {
  const child = document.createElement("div");
  child.getBoundingClientRect = () => rect;
  parent.appendChild(child);
  return child;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("revealInScroller", () => {
  it("元素已可见：不滚动", () => {
    const scroller = makeScroller(0, { top: 0, height: 400 });
    const el = append(scroller, box(300, 35)); // 底部 335 < 400-8
    expect(revealInScroller(el)).toBe(0);
    expect(scroller.scrollTop).toBe(0);
  });

  it("元素越出下边缘：只补最小差额", () => {
    const scroller = makeScroller(0, { top: 0, height: 400 });
    const el = append(scroller, box(380, 35)); // 底部 415，需补 415-(400-8)=23
    expect(revealInScroller(el)).toBe(23);
    expect(scroller.scrollTop).toBe(23);
  });

  it("元素越出上边缘：向上补差额", () => {
    const scroller = makeScroller(120, { top: 0, height: 400 });
    const el = append(scroller, box(-20, 35)); // 视口顶部 -20 < 0+8
    expect(revealInScroller(el)).toBe(-28);
    expect(scroller.scrollTop).toBe(92);
  });

  it("不横向滚动，也不改动 scrollLeft", () => {
    const scroller = makeScroller(0, { top: 0, height: 400 });
    const el = append(scroller, box(380, 35, 900));
    scroller.scrollLeft = 7;
    revealInScroller(el);
    expect(scroller.scrollLeft).toBe(7);
  });

  it("折叠 / 隐藏的元素（尺寸 0）不触发滚动", () => {
    const scroller = makeScroller(0, { top: 0, height: 400 });
    const el = append(scroller, box(500, 0, 0));
    expect(revealInScroller(el)).toBe(0);
    expect(scroller.scrollTop).toBe(0);
  });

  it("没有可滚动祖先且元素在视口内：不滚动", () => {
    const el = append(document.body, box(10, 35));
    expect(revealInScroller(el)).toBe(0);
  });

  it("没有可滚动祖先且元素越出视口：只补最小差额", () => {
    const el = append(document.body, box(window.innerHeight + 20, 35));
    // 底部 = innerHeight + 55，留 8px 边距 → 只补 63px（不居中、不整屏滚动）
    expect(revealInScroller(el)).toBe(63);
  });

  it("容器内容不足以滚动时不被当作滚动容器", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    scroller.getBoundingClientRect = () => box(0, 400);
    document.body.appendChild(scroller);
    const el = append(scroller, box(380, 35));
    expect(revealInScroller(el)).toBe(0);
    expect(scroller.scrollTop).toBe(0);
  });
});
