/**
 * @vitest-environment jsdom
 */
//! StatusBadge：只做视觉，不内置业务映射；覆盖语义色、尺寸、图标与长文案。

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import StatusBadge from "./StatusBadge";

afterEach(cleanup);

describe("StatusBadge", () => {
  it("按语义输出对应 tone 类与文本", () => {
    render(<StatusBadge tone="success">已连接</StatusBadge>);
    const badge = screen.getByText("已连接");
    expect(badge.classList.contains("ui-status-badge")).toBe(true);
    expect(badge.classList.contains("tone-success")).toBe(true);
  });

  it("支持 sm / md 尺寸与图标", () => {
    render(
      <StatusBadge tone="warning" size="sm" icon={<span data-testid="icon">!</span>}>
        待真实事件
      </StatusBadge>,
    );
    const badge = screen.getByText("待真实事件");
    expect(badge.classList.contains("size-sm")).toBe(true);
    expect(screen.getByTestId("icon")).toBeTruthy();
  });

  it("长文案不写死 nowrap，允许在窄容器内换行", () => {
    const long = "等待接口或平台条件确认";
    render(<StatusBadge tone="neutral">{long}</StatusBadge>);
    const badge = screen.getByText(long);
    expect(badge.textContent).toBe(long);
    // 结构未引入 title / 固定宽度，响应式由 CSS 负责
    expect(badge.getAttribute("title")).toBeNull();
  });
});
