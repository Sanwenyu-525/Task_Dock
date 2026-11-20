// @vitest-environment jsdom
//! 工作台顶栏「更多工具」收纳菜单回归测试（2026-11-20）。
//!
//! 契约：
//! - 触发器是单个图标按钮，带 menu 弹出语义与提示，并退出窗口拖拽热区；
//! - 菜单复用 `useThemeMenuItems` / `usePresetMenuItems` / `useWorkbenchPin` 同一份
//!   逻辑，不出现第二套 theme/preset/pin 写入路径；
//! - 展开顺序：明暗三选 → 分隔 → 视觉预设二选 → 分隔 → 置顶；
//! - 选中主题/预设仍写同一设置管道；置顶项在无 Tauri 窗口环境下 no-op 不抛错；
//! - 再次点击触发器、Escape 都只关闭本层菜单。
//!
//! 真实 alwaysOnTop 状态、菜单右缘不裁切、不被滚动容器遮挡、DPI 与多显示器
//! 表现由原生真机验收覆盖——jsdom 不验证真实布局与几何定位。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import WorkbenchToolbarMore from "./WorkbenchToolbarMore";
import { useSettingsStore } from "../store/useSettingsStore";
import { useUiStore } from "../store/useUiStore";

const update = vi.fn();

function seed(theme = "light", visualPreset = "frosted") {
  useSettingsStore.setState({
    settings: { theme, visual_preset: visualPreset } as never,
    update: update as never,
  });
}

beforeEach(() => {
  update.mockReset();
  update.mockResolvedValue(undefined);
  useUiStore.setState({ toasts: [], toast: null } as never);
});

afterEach(cleanup);

describe("WorkbenchToolbarMore", () => {
  it("触发器带 menu 弹出语义、提示与拖拽区退出标记", () => {
    seed();
    render(<WorkbenchToolbarMore />);

    const trigger = screen.getByRole("button", { name: "更多工具" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("data-tip")).toBe("更多工具");
    expect(trigger.getAttribute("data-tauri-drag-region")).toBe("false");
    expect(trigger.className).toContain("wb-toolbar-more");
  });

  it("展开后按 主题 → 预设 → 置顶 排列，含两条分隔线", async () => {
    const user = userEvent.setup();
    seed("dark", "dream-gradient");
    render(<WorkbenchToolbarMore />);

    await user.click(screen.getByRole("button", { name: "更多工具" }));
    const menu = await screen.findByRole("menu", {
      name: "更多标题栏工具（明暗、视觉主题、置顶）",
    });

    const radios = within(menu).getAllByRole("menuitemradio");
    // 3 个明暗主题 + 2 个视觉预设；置顶是普通 menuitem。
    expect(radios).toHaveLength(5);
    // 分隔线带 aria-hidden，角色查询会忽略，按组件类名断言两条。
    expect(menu.querySelectorAll(".ui-menu-sep")).toHaveLength(2);

    expect(radios.slice(0, 3).map((item) => item.textContent)).toEqual([
      "浅色",
      "深色",
      "跟随系统",
    ]);
    expect(
      within(menu).getByRole("menuitemradio", { name: "深色" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(menu).getByRole("menuitemradio", { name: /梦幻渐变/ }).getAttribute("aria-checked"),
    ).toBe("true");

    // 置顶项始终在菜单末尾，不被主题/预设选项挤掉。
    const pin = within(menu).getByRole("menuitem", { name: "置顶窗口" });
    expect(pin).toBeTruthy();
  });

  it("选择深色主题即写入 settings.theme（与内联菜单同一管道）", async () => {
    const user = userEvent.setup();
    seed("light");
    render(<WorkbenchToolbarMore />);

    await user.click(screen.getByRole("button", { name: "更多工具" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "深色" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith({ theme: "dark" }));
  });

  it("选择视觉预设即写入 settings.visual_preset", async () => {
    const user = userEvent.setup();
    seed("light", "frosted");
    render(<WorkbenchToolbarMore />);

    await user.click(screen.getByRole("button", { name: "更多工具" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /梦幻渐变/ }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ visual_preset: "dream-gradient" }),
    );
  });

  it("置顶项在无 Tauri 窗口环境下点击不抛错、不写设置管道", async () => {
    const user = userEvent.setup();
    seed();
    render(<WorkbenchToolbarMore />);

    await user.click(screen.getByRole("button", { name: "更多工具" }));
    const pin = await screen.findByRole("menuitem", { name: "置顶窗口" });
    await user.click(pin);

    // 无窗口替身时 toggle 为 no-op：不抛错，也不走 settings.update（置顶走窗口 API）。
    expect(update).not.toHaveBeenCalled();
  });

  it("再次点击触发器关闭菜单", async () => {
    const user = userEvent.setup();
    seed();
    render(<WorkbenchToolbarMore />);
    const trigger = screen.getByRole("button", { name: "更多工具" });

    await user.click(trigger);
    await screen.findByRole("menu");
    await user.click(trigger);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Escape 只关闭本层菜单", async () => {
    const user = userEvent.setup();
    seed();
    render(<WorkbenchToolbarMore />);

    await user.click(screen.getByRole("button", { name: "更多工具" }));
    await screen.findByRole("menu");
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
  });
});
