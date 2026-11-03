/**
 * @vitest-environment jsdom
 */
//! AgentIcon：Orbit Core 的几何、默认属性与可访问性约定。
//!
//! 守卫点：统一组件一旦被改动（换图形、改默认线宽、加固定颜色、丢掉 aria-hidden），
//! 全项目十几处 Agent 图标会一起变；这里把「契约」写死。

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import AgentIcon from "./AgentIcon";

function svgOf(ui: React.ReactElement): SVGSVGElement {
  const { container } = render(ui);
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("AgentIcon 没有渲染出 svg");
  return svg;
}

describe("AgentIcon（Orbit Core）", () => {
  it("固定 24 视窗、currentColor 描边，不写死颜色", () => {
    const svg = svgOf(<AgentIcon />);
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("fill")).toBe("none");
    // 不允许自带品牌色/底板：除中央节点外没有 fill，也没有任何 color 属性
    expect(svg.getAttribute("color")).toBeNull();
    expect(svg.querySelector("rect")).toBeNull();
    expect(svg.querySelector("linearGradient")).toBeNull();
  });

  it("默认 size=18、strokeWidth=1.75，且宽高同值等比", () => {
    const svg = svgOf(<AgentIcon />);
    expect(svg.getAttribute("width")).toBe("18");
    expect(svg.getAttribute("height")).toBe("18");
    expect(svg.getAttribute("stroke-width")).toBe("1.75");
  });

  it("size / strokeWidth / className 可覆盖", () => {
    const svg = svgOf(<AgentIcon size={10} strokeWidth={2} className="cap-agent" />);
    expect(svg.getAttribute("width")).toBe("10");
    expect(svg.getAttribute("height")).toBe("10");
    expect(svg.getAttribute("stroke-width")).toBe("2");
    expect(svg.getAttribute("class")).toBe("cap-agent");
  });

  it("默认 aria-hidden，不参与重复朗读", () => {
    const svg = svgOf(<AgentIcon />);
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
  });

  it("图形契约：三段轨道弧 + 三个外围节点 + 中央实心节点", () => {
    const svg = svgOf(<AgentIcon />);
    expect(svg.querySelectorAll("path")).toHaveLength(3);
    const circles = Array.from(svg.querySelectorAll("circle"));
    expect(circles).toHaveLength(4);
    // 外围三个节点是描边空心，中央节点是实心（fill=currentColor 且无描边）
    const center = circles.filter((c) => c.getAttribute("fill") === "currentColor");
    expect(center).toHaveLength(1);
    expect(center[0].getAttribute("cx")).toBe("12");
    expect(center[0].getAttribute("cy")).toBe("12");
    expect(center[0].getAttribute("stroke")).toBe("none");
    expect(circles.filter((c) => c.getAttribute("fill") === null)).toHaveLength(3);
  });
});
