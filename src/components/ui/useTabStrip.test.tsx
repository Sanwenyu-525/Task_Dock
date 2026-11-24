/**
 * @vitest-environment jsdom
 */
//! 全局横向 tab 滑动指示条（useTabStrip + tab-strip.css）。
//!
//! jsdom 没有布局：`offsetLeft/offsetWidth` 恒为 0，所以这里用 defineProperty
//! 注入受控几何，验证「测量 → 写变量 → 挂 ready」的实际行为；像素观感不做断言。
//! 同时守卫渲染层的硬约束（不等宽也对齐、首帧不滑入、指示条不抢点击、reduced-motion）。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MutableRefObject } from "react";
import stripCss from "./tab-strip.css?raw";
import { useTabStrip } from "./useTabStrip";

afterEach(cleanup);

interface HarnessProps {
  active: number | null;
  enabled?: boolean;
  variant?: "raised" | "accent" | "seg";
}

/** 受控几何：第 i 项左边距 4 + i*60；宽度/高度按用例覆盖。 */
function stubGeometry(tab: HTMLElement, index: number, width = 56) {
  Object.defineProperty(tab, "offsetLeft", { configurable: true, value: 4 + index * 60 });
  Object.defineProperty(tab, "offsetTop", { configurable: true, value: 3 });
  Object.defineProperty(tab, "offsetWidth", { configurable: true, value: width });
  Object.defineProperty(tab, "offsetHeight", { configurable: true, value: 28 });
}

function Harness({ active, enabled = true, variant = "accent" }: HarnessProps) {
  const { stripRef, pillProps } = useTabStrip(active ?? -1, { variant, enabled });
  return (
    <div
      ref={stripRef as MutableRefObject<HTMLDivElement | null>}
      role="tablist"
      aria-label="测试轨道"
      data-testid="strip"
    >
      <span {...pillProps} data-testid="pill" />
      {[0, 1, 2].map((i) => (
        <button
          key={i}
          role="tab"
          aria-selected={active === i}
          className={active === i ? "active" : ""}
          type="button"
        >
          {`T${i}`}
        </button>
      ))}
    </div>
  );
}

function strip(): HTMLElement {
  return screen.getByTestId("strip");
}

function pill(): HTMLElement {
  return screen.getByTestId("pill");
}

describe("useTabStrip", () => {
  it("按选中项的几何写入变量并挂上 ready", async () => {
    const { rerender } = render(<Harness active={0} />);
    const tabs = screen.getAllByRole("tab");
    tabs.forEach((tab, i) => stubGeometry(tab, i));
    // 几何注入后切一次选中项：同一批 DOM 节点会重新测量
    rerender(<Harness active={1} />);

    await waitFor(() => expect(strip().getAttribute("data-tab-pill")).toBe("ready"));
    expect(strip().style.getPropertyValue("--ui-tab-pill-x")).toBe("64px");
    expect(strip().style.getPropertyValue("--ui-tab-pill-y")).toBe("3px");
    expect(strip().style.getPropertyValue("--ui-tab-pill-w")).toBe("56px");
    expect(strip().style.getPropertyValue("--ui-tab-pill-h")).toBe("28px");
  });

  it("适应不等宽项：位移取项的真实左边，宽度跟着项变，不靠索引算", async () => {
    const { rerender } = render(<Harness active={0} />);
    const tabs = screen.getAllByRole("tab");
    stubGeometry(tabs[0], 0, 40);
    stubGeometry(tabs[1], 1, 120);
    stubGeometry(tabs[2], 2, 60);

    rerender(<Harness active={2} />);
    await waitFor(() => expect(strip().style.getPropertyValue("--ui-tab-pill-w")).toBe("60px"));
    expect(strip().style.getPropertyValue("--ui-tab-pill-x")).toBe("124px");
  });

  it("没有选中项时摘掉标记，指示条不显示", async () => {
    render(<Harness active={null} />);
    await waitFor(() => expect(strip().getAttribute("data-tab-pill")).toBeNull());
    expect(pill().className).toContain("ui-tab-pill");
  });

  it("enabled=false 时不接管指示条", async () => {
    render(<Harness active={0} enabled={false} />);
    await waitFor(() => expect(strip().getAttribute("data-tab-pill")).toBeNull());
  });

  it("指示条不可交互，且按变体换外观", () => {
    render(<Harness active={0} variant="seg" />);
    expect(pill().getAttribute("data-variant")).toBe("seg");
    expect(pill().getAttribute("aria-hidden")).toBe("true");
  });
});

describe("tab-strip.css 结构守卫", () => {
  it("几何变量驱动位移与尺寸，过渡覆盖 transform 与宽高", () => {
    expect(stripCss).toMatch(/transform: translate3d\(/);
    expect(stripCss).toMatch(/var\(--ui-tab-pill-x/);
    expect(stripCss).toMatch(/var\(--ui-tab-pill-w/);
    expect(stripCss).toMatch(/transition:[\s\S]*?transform 180ms/);
    expect(stripCss).toMatch(/width 180ms/);
    expect(stripCss).toMatch(/height 180ms/);
  });

  it("首帧隐藏，测量完成后才可见", () => {
    expect(stripCss).toMatch(/\.ui-tab-pill \{[\s\S]*?visibility: hidden;/);
    expect(stripCss).toMatch(/\[data-tab-pill="ready"\] > \.ui-tab-pill \{[\s\S]*?visibility: visible;/);
  });

  it("指示条在项下层且不抢点击", () => {
    expect(stripCss).toMatch(/z-index: 0;/);
    expect(stripCss).toMatch(/pointer-events: none;/);
    expect(stripCss).toMatch(/\[data-tab-pill="ready"\] > :not\(\.ui-tab-pill\)/);
  });

  it("减少动效下关闭过渡", () => {
    expect(stripCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.ui-tab-pill \{\s*transition: none;/,
    );
  });
});
