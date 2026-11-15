// @vitest-environment jsdom
//! 工作台顶栏「明暗主题」菜单（2026-11-15）。
//!
//! workspace 窗口没有原生标题栏，顶栏就是标题栏；本测试只验证这一入口的契约：
//! - 图标与无障碍名跟随当前设置（light / dark / system）；
//! - 展开后是三个 menuitemradio，当前值唯一勾选；
//! - 选中即写 `settings.theme`（与主窗口标题栏、右键菜单同一设置管道）；
//! - 写入失败不静默：Toast 报出真实原因。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import WorkbenchThemeMenu from "./WorkbenchThemeMenu";
import { useSettingsStore } from "../store/useSettingsStore";
import { useUiStore } from "../store/useUiStore";

const update = vi.fn();

function seed(theme: string) {
  useSettingsStore.setState({
    settings: { theme } as never,
    update: update as never,
  });
}

beforeEach(() => {
  update.mockReset();
  update.mockResolvedValue(undefined);
  useUiStore.setState({ toasts: [], toast: null } as never);
});

afterEach(cleanup);

describe("WorkbenchThemeMenu", () => {
  it("触发器显示当前明暗（浅色图标），展开后三选项只有当前值被勾选", async () => {
    const user = userEvent.setup();
    seed("light");
    render(<WorkbenchThemeMenu />);

    const trigger = screen.getByRole("button", { name: "明暗主题（当前：浅色）" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const menu = await screen.findByRole("menu", { name: "配色" });
    const options = within(menu).getAllByRole("menuitemradio");
    expect(options.map((item) => item.textContent)).toEqual(["浅色", "深色", "跟随系统"]);
    expect(within(menu).getByRole("menuitemradio", { name: "浅色" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(within(menu).getByRole("menuitemradio", { name: "深色" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("损坏取值落回跟随系统，不显示「无选中项」", () => {
    seed("");
    render(<WorkbenchThemeMenu />);
    expect(screen.getByRole("button", { name: "明暗主题（当前：跟随系统）" })).toBeTruthy();
  });

  it("选择深色即写入 settings.theme", async () => {
    const user = userEvent.setup();
    seed("light");
    render(<WorkbenchThemeMenu />);

    await user.click(screen.getByRole("button", { name: "明暗主题（当前：浅色）" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "深色" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith({ theme: "dark" }));
  });

  it("写入失败展示真实原因，不静默吞掉", async () => {
    const user = userEvent.setup();
    update.mockRejectedValue(new Error("数据库被占用"));
    seed("light");
    render(<WorkbenchThemeMenu />);

    await user.click(screen.getByRole("button", { name: "明暗主题（当前：浅色）" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "深色" }));

    await waitFor(() => {
      const toasts = useUiStore.getState().toasts;
      expect(toasts.some((item) => item.message.includes("数据库被占用"))).toBe(true);
    });
  });
});
