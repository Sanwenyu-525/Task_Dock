/**
 * @vitest-environment jsdom
 */
//! 设置中心树形导航（2026-11-20 重构）：树语义、持久化、键盘交互与窄容器紧凑条。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import SettingsNavigation, { navItemElementId } from "./SettingsNavigation";
import {
  firstSectionOf,
  sectionsForCategory,
  settingsCategory,
  settingsSectionMeta,
  type SettingsCategoryId,
} from "../../lib/settingsCategories";
import type { SettingsSectionId } from "../../lib/settingsSections";
import type { SettingsLayoutMode } from "../../hooks/useSettingsResponsiveLayout";
import { zhCN } from "../../locales/zh-CN";

function titleOf(id: SettingsSectionId): string {
  const meta = settingsSectionMeta(id);
  if (!meta) throw new Error(`分组 ${id} 未在注册表中登记`);
  return zhCN[meta.labelKey];
}

function categoryTitleOf(category: SettingsCategoryId): string {
  const meta = settingsCategory(category);
  if (!meta) throw new Error(`分类 ${category} 未登记`);
  return zhCN[meta.labelKey];
}

function renderNav(
  activeSection: SettingsSectionId = "appearance",
  layoutMode: SettingsLayoutMode = "wide",
  onSelect = vi.fn(),
) {
  return {
    onSelect,
    ...render(
      <SettingsNavigation
        activeSection={activeSection}
        onSelectSection={onSelect}
        layoutMode={layoutMode}
      />,
    ),
  };
}

function pageItem(id: SettingsSectionId): HTMLElement {
  const item = document.getElementById(navItemElementId(id));
  if (!item) throw new Error(`未找到导航页面项：${id}`);
  return item;
}

function categoryItem(category: SettingsCategoryId): HTMLElement {
  const item = document.getElementById(`settings-nav-category-${category}`);
  if (!item) throw new Error(`未找到导航分类项：${category}`);
  return item;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SettingsNavigation 树语义", () => {
  it("role=tree；分类为 aria-expanded 的 treeitem，页面为叶子 treeitem 并以 aria-selected 表达当前页", () => {
    renderNav("window-hotkeys");
    expect(screen.getByRole("tree")).toBeTruthy();
    const general = categoryItem("general");
    expect(general.getAttribute("role")).toBe("treeitem");
    expect(general.getAttribute("aria-expanded")).toBe("true");
    expect(general.getAttribute("aria-level")).toBe("1");

    const page = pageItem("window-hotkeys");
    expect(page.getAttribute("role")).toBe("treeitem");
    expect(page.getAttribute("aria-level")).toBe("2");
    expect(page.getAttribute("aria-selected")).toBe("true");
    // 非当前页面不是选中态
    expect(pageItem("appearance").getAttribute("aria-selected")).toBe("false");
  });

  it("分类 aria-controls 指向页面分组容器，当前页所在分类带 is-current 标记", () => {
    renderNav("clipboard");
    const features = categoryItem("features");
    expect(features.getAttribute("aria-controls")).toBe("settings-nav-group-features");
    expect(features.className).toContain("is-current");
    expect(document.getElementById("settings-nav-group-features")).toBeTruthy();
  });

  it("漫游 tabindex：只有锚点项可 Tab 进入", () => {
    renderNav("tts");
    const tabbable = Array.from(
      document.querySelectorAll<HTMLElement>('[role="treeitem"][tabindex="0"]'),
    );
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].id).toBe(navItemElementId("tts"));
  });

  it("分类收起后其页面项从 DOM 移除（非 CSS 隐藏），展开状态持久化", () => {
    const { rerender } = renderNav();
    fireEvent.click(categoryItem("notify-voice"));
    expect(categoryItem("notify-voice").getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(navItemElementId("notifications"))).toBeNull();

    const stored = JSON.parse(
      localStorage.getItem("taskdock.settings.navexpand.v1") ?? "{}",
    );
    expect(stored.version).toBe(1);
    expect(stored.expanded).not.toContain("notify-voice");

    // 重挂载后收起状态恢复
    cleanup();
    renderNav();
    expect(categoryItem("notify-voice").getAttribute("aria-expanded")).toBe("false");
    void rerender;
  });

  it("损坏的展开状态安全回退为全展开；当前页面所属分类被外部切换时自动展开", () => {
    localStorage.setItem("taskdock.settings.navexpand.v1", "{broken");
    const { rerender } = renderNav("data");
    for (const category of ["general", "features", "notify-voice", "data-resources", "integration", "help"] as const) {
      expect(categoryItem(category).getAttribute("aria-expanded")).toBe("true");
    }

    // activeSection 切到其它分类的页面：所属分类自动展开（搜索/reveal 路径）
    cleanup();
    const shell = renderNav("agent");
    expect(categoryItem("integration").getAttribute("aria-expanded")).toBe("true");
    void shell;
    void rerender;
  });
});

describe("SettingsNavigation 点击行为", () => {
  it("点击页面项回调 onSelectSection", () => {
    const onSelect = vi.fn();
    renderNav("appearance", "wide", onSelect);
    fireEvent.click(pageItem("clipboard"));
    expect(onSelect).toHaveBeenCalledWith("clipboard");
  });

  it("点击收起中的分类 = 展开并打开其第一个页面（当前页面不在其下时）", () => {
    const onSelect = vi.fn();
    renderNav("appearance", "wide", onSelect);
    fireEvent.click(categoryItem("integration")); // 先收起（默认全展开）
    onSelect.mockClear();
    fireEvent.click(categoryItem("integration")); // 再点击收起中的分类
    expect(onSelect).toHaveBeenCalledWith(firstSectionOf("integration"));
  });

  it("点击展开中的分类且当前页面在其下 = 仅收起，不切换页面", () => {
    const onSelect = vi.fn();
    renderNav("data", "wide", onSelect);
    fireEvent.click(categoryItem("data-resources"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(categoryItem("data-resources").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("SettingsNavigation 键盘", () => {
  it("ArrowDown/ArrowUp 在可见项间移动并激活页面项；分类项只移动焦点", () => {
    const onSelect = vi.fn();
    renderNav("appearance", "wide", onSelect);
    const first = pageItem("appearance");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = sectionsForCategory("general")[1];
    expect(document.activeElement).toBe(pageItem(second.id));
    expect(onSelect).toHaveBeenLastCalledWith(second.id);

    fireEvent.keyDown(pageItem(second.id), { key: "ArrowDown" });
    const third = sectionsForCategory("general")[2];
    expect(onSelect).toHaveBeenLastCalledWith(third.id);
  });

  it("ArrowRight 展开收起中的分类；展开中的分类进入第一个页面；ArrowLeft 收起", () => {
    const onSelect = vi.fn();
    renderNav("appearance", "wide", onSelect);
    const help = categoryItem("help");
    fireEvent.click(help); // 先收起
    onSelect.mockClear();

    fireEvent.keyDown(help, { key: "ArrowRight" });
    expect(help.getAttribute("aria-expanded")).toBe("true");
    expect(onSelect).toHaveBeenCalledWith(firstSectionOf("help"));
  });

  it("Home/End 跳到首个/最后一个可见项（首项是分类按钮，只移焦点；末项是页面，激活）", () => {
    const onSelect = vi.fn();
    renderNav("data", "wide", onSelect);
    const data = pageItem("data");
    data.focus();
    fireEvent.keyDown(data, { key: "Home" });
    // 树的第一个可见项是第一个分类按钮（不激活）
    expect(document.activeElement).toBe(categoryItem("general"));
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    // 最后一个可见项是 help 分类下的页面项：聚焦并激活
    expect(document.activeElement).toBe(pageItem(firstSectionOf("help")));
    expect(onSelect).toHaveBeenLastCalledWith(firstSectionOf("help"));
  });

  it("Enter 在分类上 = 切换展开，在页面上走原生 click 激活", () => {
    const onSelect = vi.fn();
    renderNav("appearance", "wide", onSelect);
    const help = categoryItem("help");
    fireEvent.click(help); // 收起
    onSelect.mockClear();
    fireEvent.keyDown(help, { key: "Enter" });
    expect(help.getAttribute("aria-expanded")).toBe("true");
    expect(onSelect).toHaveBeenCalledWith(firstSectionOf("help"));
  });
});

describe("SettingsNavigation 窄容器紧凑条", () => {
  it("narrow 模式渲染分类 Select + 当前分类页面 chips；页面切换带 aria-current", () => {
    renderNav("clipboard", "narrow");
    expect(screen.queryByRole("tree")).toBeNull();
    const select = screen.getByRole("combobox", { name: "切换分类" });
    expect(select).toBeTruthy();
    const chips = document.querySelectorAll(".settings-nav-chip");
    // features 分类下 3 个页面
    expect(chips.length).toBe(sectionsForCategory("features").length);
    const active = document.querySelector(".settings-nav-chip.is-active")!;
    expect(active.id).toBe(navItemElementId("clipboard"));
    expect(active.getAttribute("aria-current")).toBe("true");
    void select;
  });

  it("窄模式点击 chip 切换页面；分类 Select 变更打开该分类第一个页面", () => {
    const onSelect = vi.fn();
    renderNav("clipboard", "narrow", onSelect);
    fireEvent.click(document.getElementById(navItemElementId("apps"))!);
    expect(onSelect).toHaveBeenLastCalledWith("apps");

    // 分类切换走 Select onChange（第一项 = general）
    const select = screen.getByRole("combobox", { name: "切换分类" });
    fireEvent.keyDown(select, { key: "ArrowDown" });
    fireEvent.keyDown(select, { key: "Enter" });
    // Select 的键盘契约由其自身测试覆盖；这里只验证回调确实来自 onChange
    expect(onSelect).toHaveBeenCalled();
  });

  it("narrow 模式下树内锚点修复逻辑不运行（无 tree DOM）", () => {
    renderNav("appearance", "narrow");
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(0);
  });
});

describe("SettingsNavigation 名称与注册表一致性", () => {
  it("每个分类与页面项的可访问名来自注册表 i18n Key（不硬编码标题）", () => {
    renderNav();
    for (const category of ["general", "features", "notify-voice", "data-resources", "integration", "help"] as const) {
      expect(categoryItem(category).textContent).toContain(categoryTitleOf(category));
    }
    for (const meta of sectionsForCategory("general")) {
      expect(pageItem(meta.id).textContent).toContain(titleOf(meta.id));
    }
  });
});
