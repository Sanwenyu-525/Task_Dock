/**
 * @vitest-environment jsdom
 */
//! SectionNavigation：<nav> + aria-current、方向键只移焦点不激活、disabled 跳过、动态列表。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SectionNavItem } from "./SectionNavigation";

import SectionNavigation from "./SectionNavigation";

afterEach(cleanup);

const ITEMS: SectionNavItem[] = [
  { id: "overview", label: "概览" },
  { id: "items", label: "开发事项" },
  { id: "risks", label: "仓库与风险", disabled: true },
  { id: "settings", label: "设置" },
];

function renderNav(overrides?: {
  activeId?: string;
  onSelect?: (id: string) => void;
  items?: SectionNavItem[];
}) {
  const onSelect = overrides?.onSelect ?? vi.fn();
  const view = render(
    <SectionNavigation
      items={overrides?.items ?? ITEMS}
      activeId={overrides?.activeId ?? "overview"}
      onSelect={onSelect}
      aria-label="工作空间模块"
    />,
  );
  return { onSelect, ...view };
}

describe("SectionNavigation", () => {
  it("渲染 nav 与全部导航项，选中项带 aria-current=page", () => {
    renderNav();
    const nav = screen.getByRole("navigation", { name: "工作空间模块" });
    expect(nav.className).toContain("section-nav");
    const items = screen.getAllByRole("button");
    expect(items).toHaveLength(4);
    expect(items[0].getAttribute("aria-current")).toBe("page");
    expect(items[1].getAttribute("aria-current")).toBeNull();
    expect(items[0].getAttribute("data-nav-item")).toBe("true");
  });

  it("点击回调 onSelect", () => {
    const { onSelect } = renderNav();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(onSelect).toHaveBeenCalledWith("settings");
  });

  it("方向键只移动焦点，不触发 onSelect（激活交给 Enter/Space 原生行为）", () => {
    const { onSelect } = renderNav();
    screen.getByRole("button", { name: "概览" }).focus();
    fireEvent.keyDown(screen.getByRole("navigation"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "开发事项" }));
    // 再右移：仓库与风险 disabled，越过它落到「设置」
    fireEvent.keyDown(screen.getByRole("navigation"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "设置" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("Home / End 移动焦点且不激活", () => {
    const { onSelect } = renderNav();
    screen.getByRole("button", { name: "设置" }).focus();
    fireEvent.keyDown(screen.getByRole("navigation"), { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "概览" }));
    fireEvent.keyDown(screen.getByRole("navigation"), { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "设置" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("无焦点时方向键落入边界项", () => {
    renderNav();
    fireEvent.keyDown(screen.getByRole("navigation"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "设置" }));
    fireEvent.keyDown(screen.getByRole("navigation"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "概览" }));
  });

  it("动态列表变化后仍可用（新增项参与导航）", () => {
    const extended = [...ITEMS, { id: "tasks", label: "任务关联" }];
    renderNav({ items: extended });
    const items = screen.getAllByRole("button");
    expect(items).toHaveLength(5);
    fireEvent.click(items[4]);
    expect(items[4].textContent).toContain("任务关联");
  });

  it("未选中项不携带 roving tabindex（Tab 逐项停靠）", () => {
    renderNav();
    const buttons = screen.getAllByRole("button");
    for (const button of buttons) {
      expect(button.getAttribute("tabindex")).toBeNull();
    }
  });
});
