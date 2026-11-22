/**
 * @vitest-environment jsdom
 */
//! 图表基元：数值 → 几何映射、状态类、未知值不伪造。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  buildTrendGeometry,
  ChartSwatch,
  MiniMeter,
  RING_CIRCUMFERENCE,
  StackedBar,
  TrendSparkline,
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

describe("buildTrendGeometry", () => {
  it("少于两个有效点不画线，但保留真实最小/最大值", () => {
    const one = buildTrendGeometry([{ at: 0, percent: 92 }]);
    expect(one.line).toBeNull();
    expect(one.min).toBe(92);
    expect(one.max).toBe(92);
    expect(one.validCount).toBe(1);

    const none = buildTrendGeometry([{ at: 0, percent: null }]);
    expect(none.line).toBeNull();
    expect(none.min).toBeNull();
    expect(none.max).toBeNull();
  });

  it("缺失点断线：null 不参与连线，也不替换成 0", () => {
    const geometry = buildTrendGeometry([
      { at: 0, percent: 90 },
      { at: 10, percent: null },
      { at: 20, percent: 92 },
    ]);
    expect(geometry.line).toBeTruthy();
    // 两段独立折线（两个 M），中间不跨越 null
    expect((geometry.line as string).match(/M/g)).toHaveLength(2);
    expect(geometry.min).toBe(90);
    expect(geometry.max).toBe(92);
    expect(geometry.validCount).toBe(2);
  });

  it("横轴按真实采样时刻：间隔不均时位置也不均", () => {
    const geometry = buildTrendGeometry([
      { at: 0, percent: 90 },
      { at: 10, percent: 91 },
      { at: 60, percent: 92 },
    ]);
    expect(geometry.line).toBeTruthy();
    const xs = [...(geometry.line as string).matchAll(/[ML]([\d.]+)/g)].map((match) =>
      Number(match[1]),
    );
    // 10 秒在 60 秒窗口里应是 1/6 处，而不是等距 1/2
    expect(xs[1]).toBeCloseTo(100 / 6, 1);
    expect(xs[2]).toBeCloseTo(100, 1);
  });
});

describe("TrendSparkline", () => {
  const base = {
    level: "critical" as const,
    title: "磁盘",
    valueText: "92.4%",
    statusText: "紧张",
    emptyText: "正在采样",
    ariaLabel: "磁盘趋势",
  };

  it("有有效数据时绘制折线并展示真实区间", () => {
    const { container } = render(
      <TrendSparkline
        {...base}
        points={[
          { at: 0, percent: 92 },
          { at: 10, percent: 93.4 },
        ]}
        rangeText="区间 92.0% – 93.4%"
      />,
    );
    expect(container.querySelector("path.resource-trend-line")).toBeTruthy();
    expect(container.querySelector(".resource-trend-card.is-critical")).toBeTruthy();
    expect(container.querySelector(".resource-trend-range")?.textContent).toContain("92.0%");
    expect(container.querySelector(".resource-trend-empty")).toBeNull();
  });

  it("点不足时显示采样占位，不画假折线", () => {
    const { container } = render(
      <TrendSparkline {...base} points={[{ at: 0, percent: 92 }]} rangeText={null} />,
    );
    expect(container.querySelector("path.resource-trend-line")).toBeNull();
    expect(container.querySelector(".resource-trend-empty")?.textContent).toBe("正在采样");
  });
});
