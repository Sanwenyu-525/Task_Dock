/**
 * @vitest-environment jsdom
 */
//! SectionTabs：tablist/tab/tabpanel 关联、roving tabindex、自动激活、disabled 跳过。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SectionTabItem } from "./SectionTabs";

import SectionTabs from "./SectionTabs";

afterEach(cleanup);

const ITEMS: SectionTabItem[] = [
  { id: "knowledge", label: "知识库" },
  { id: "skills", label: "Skill" },
  { id: "mcp", label: "MCP", disabled: true },
  { id: "context", label: "上下文" },
];

function renderTabs(overrides?: { activeId?: string; onChange?: (id: string) => void }) {
  const onChange = overrides?.onChange ?? vi.fn();
  const view = render(
    <div>
      <SectionTabs
        items={ITEMS}
        activeId={overrides?.activeId ?? "knowledge"}
        onChange={onChange}
        aria-label="能力中心"
        idPrefix="cap"
      />
      <div id="cap-panel-knowledge" role="tabpanel" aria-labelledby="cap-tab-knowledge" />
      <div id="cap-panel-skills" role="tabpanel" aria-labelledby="cap-tab-skills" />
      <div id="cap-panel-mcp" role="tabpanel" aria-labelledby="cap-tab-mcp" />
      <div id="cap-panel-context" role="tabpanel" aria-labelledby="cap-tab-context" />
    </div>,
  );
  return { onChange, ...view };
}

describe("SectionTabs", () => {
  it("渲染 tablist 与全部 tab，选中项带 aria-selected 与 roving tabIndex", () => {
    renderTabs();
    const list = screen.getByRole("tablist", { name: "能力中心" });
    expect(list.className).toContain("section-nav");
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].getAttribute("tabindex")).toBe("0");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    expect(tabs[1].getAttribute("tabindex")).toBe("-1");
  });

  it("tab 与 panel 通过 aria-controls / aria-labelledby 关联", () => {
    renderTabs();
    expect(screen.getByRole("tab", { name: "知识库" }).getAttribute("aria-controls")).toBe(
      "cap-panel-knowledge",
    );
    expect(
      screen.getByRole("tabpanel", { name: "知识库" }).getAttribute("aria-labelledby"),
    ).toBe("cap-tab-knowledge");
  });

  it("点击切换并回调 onChange", () => {
    const { onChange } = renderTabs();
    fireEvent.click(screen.getByRole("tab", { name: "Skill" }));
    expect(onChange).toHaveBeenCalledWith("skills");
  });

  it("方向键移动焦点并自动激活（跳过 disabled）", () => {
    const { onChange } = renderTabs();
    const first = screen.getByRole("tab", { name: "知识库" });
    first.focus();
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Skill" }));
    expect(onChange).toHaveBeenLastCalledWith("skills");
    // 从 Skill 再右移：MCP disabled，越过它落到「上下文」
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "上下文" }));
    expect(onChange).toHaveBeenLastCalledWith("context");
  });

  it("Home / End 移到首末项并激活", () => {
    // activeId 用 skills：Home/End 落点（knowledge/context）与当前 active 不同，
    // 才能验证自动激活回调；落点已选中时组件抑制重复 onChange（另测）。
    const { onChange } = renderTabs({ activeId: "skills" });
    screen.getByRole("tab", { name: "Skill" }).focus();
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "知识库" }));
    expect(onChange).toHaveBeenLastCalledWith("knowledge");
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "上下文" }));
    expect(onChange).toHaveBeenLastCalledWith("context");
  });

  it("方向键落到已选中项时不重复触发 onChange", () => {
    const { onChange } = renderTabs(); // activeId = knowledge
    screen.getByRole("tab", { name: "知识库" }).focus();
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "Home" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disabled 项不可点击激活、不接收焦点", () => {
    const { onChange } = renderTabs();
    const mcp = screen.getByRole("tab", { name: "MCP" }) as HTMLButtonElement;
    expect(mcp.disabled).toBe(true);
    expect(mcp.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(mcp);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "End" });
    // 即使焦点不在组内，End 也落在最后一个可用项，而不是 disabled 的 MCP
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "上下文" }));
  });

  it("activeId 变化时 roving tabIndex 跟随（重渲染不遗留状态）", () => {
    const { rerender } = renderTabs();
    rerender(
      <div>
        <SectionTabs
          items={ITEMS}
          activeId="context"
          onChange={vi.fn()}
          aria-label="能力中心"
          idPrefix="cap"
        />
      </div>,
    );
    expect(screen.getByRole("tab", { name: "上下文" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("tab", { name: "知识库" }).getAttribute("tabindex")).toBe("-1");
  });
});
