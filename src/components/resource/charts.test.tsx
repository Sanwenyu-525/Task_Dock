/**
 * @vitest-environment jsdom
 */
//! 图表基元：数值 → 几何映射、状态类、未知值不伪造。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  ChartSwatch,
  MiniMeter,
  RING_CIRCUMFERENCE,
  StackedBar,
  UsageBar,
  UsageRing,
} from "./charts";
import { computeUsage } from "../../lib/resourceMetrics";

afterEach(cleanup);

function ringProps(percent: number | null) {
  const usage = computeUsage(1000, percent === null ? null : Math.round(1000 - (percent / 100) * 1000));
  return {
    usedPercent: usage.usedPercent,
    level: usage.level,
    title: "磁盘",
    valueText: usage.usedPercent === null ? null : `${usage.usedPercent.toFixed(1)}%`,
    statusText: "关注",
    ariaLabel: "测试环形",
  };
}

describe("UsageRing", () => {
  it("进度圆弧与百分比一致", () => {
    const { container } = render(<UsageRing {...ringProps(89.3)} />);
    const fill = container.querySelector(".resource-ring-fill") as SVGCircleElement;
    expect(fill).toBeTruthy();
    const offset = Number(fill.getAttribute("stroke-dashoffset"));
    // dashoffset = C * (1 - p/100)
    expect(offset).toBeCloseTo(RING_CIRCUMFERENCE * (1 - 0.893), 3);
    expect(fill.getAttribute("stroke-dasharray")).toBe(String(RING_CIRCUMFERENCE));
    expect(container.querySelector(".resource-ring-center strong")?.textContent).toBe("89.3%");
  });

  it("80–90 使用关注状态类，>=90 使用紧张状态类", () => {
    const attention = render(<UsageRing {...ringProps(85)} />);
    expect(attention.container.querySelector(".resource-ring.is-attention")).toBeTruthy();
    expect(attention.container.querySelector(".resource-ring.is-normal")).toBeNull();
    attention.unmount();

    const critical = render(<UsageRing {...ringProps(95)} />);
    expect(critical.container.querySelector(".resource-ring.is-critical")).toBeTruthy();
  });

  it("0% 不画进度圆，但显示真实 0.0%", () => {
    const { container } = render(<UsageRing {...ringProps(0)} />);
    expect(container.querySelector(".resource-ring-fill")).toBeNull();
    expect(container.querySelector(".resource-ring-center strong")?.textContent).toBe("0.0%");
    expect(container.querySelector(".resource-ring.is-normal")).toBeTruthy();
  });

  it("不可读时不显示假百分比，也不画进度", () => {
    const usage = computeUsage(null, null);
    const { container } = render(
      <UsageRing
        usedPercent={usage.usedPercent}
        level={usage.level}
        title="磁盘"
        valueText={null}
        statusText="暂不可用"
        ariaLabel="测试环形"
      />,
    );
    expect(container.querySelector(".resource-ring-fill")).toBeNull();
    expect(container.querySelector(".resource-ring.is-unknown")).toBeTruthy();
    expect(container.querySelector(".resource-ring-center strong")?.textContent).toBe("—");
    expect(container.querySelector(".resource-ring-center span")?.textContent).toBe("暂不可用");
  });
});

describe("UsageBar", () => {
  it("填充宽度等于百分比", () => {
    const { container } = render(
      <UsageBar usedPercent={89.6} level="attention" label="系统内存" value="89.6%" ariaLabel="x" />,
    );
    const fill = container.querySelector(".resource-bar-fill") as HTMLElement;
    expect(fill.style.width).toBe("89.6%");
    expect(container.querySelector(".resource-bar.is-attention")).toBeTruthy();
  });

  it("未知值没有填充，也不会出现 0% 宽度", () => {
    const { container } = render(
      <UsageBar usedPercent={null} level="unknown" label="磁盘" value="暂不可用" ariaLabel="x" />,
    );
    expect(container.querySelector(".resource-bar-fill")).toBeNull();
    expect(container.querySelector(".resource-bar.is-unknown")).toBeTruthy();
  });
});

describe("StackedBar / MiniMeter / ChartSwatch", () => {
  it("分段宽度之和等于 100（完整分母）", () => {
    const { container } = render(
      <StackedBar
        slices={[
          { id: "a", percent: 60, colorIndex: 1 },
          { id: "b", percent: 40, colorIndex: 2 },
        ]}
        ariaLabel="分布"
        emptyLabel="空"
      />,
    );
    const widths = [...container.querySelectorAll<HTMLElement>(".resource-stacked-seg")].map(
      (node) => Number.parseFloat(node.style.width),
    );
    expect(widths.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 6);
  });

  it("全零时显示说明文字而不是空条", () => {
    const { container } = render(
      <StackedBar
        slices={[
          { id: "a", percent: 0 },
          { id: "b", percent: null },
        ]}
        ariaLabel="分布"
        emptyLabel="暂无数据"
      />,
    );
    expect(container.querySelector(".resource-stacked")).toBeNull();
    expect(container.textContent).toContain("暂无数据");
  });

  it("MiniMeter 宽度与百分比一致，未知不画", () => {
    const { container } = render(<MiniMeter percent={12.5} tone="neutral" ariaLabel="cpu" />);
    const fill = container.querySelector(".resource-meter-fill") as HTMLElement;
    expect(fill.style.width).toBe("12.5%");
    cleanup();
    const unknown = render(<MiniMeter percent={null} tone="neutral" ariaLabel="cpu" />);
    expect(unknown.container.querySelector(".resource-meter-fill")).toBeNull();
  });

  it("图例色块与分段使用同一调色板序号", () => {
    const { container } = render(<ChartSwatch colorIndex={3} />);
    expect(container.querySelector(".resource-swatch.color-3")).toBeTruthy();
    cleanup();
    const palette = render(<ChartSwatch colorIndex={9} />);
    // 越界索引回绕到 1
    expect(palette.container.querySelector(".resource-swatch.color-1")).toBeTruthy();
  });
});
