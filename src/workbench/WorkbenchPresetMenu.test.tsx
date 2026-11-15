/** @vitest-environment jsdom */
//! 工作台顶栏「视觉主题」菜单（2026-11-15）。
//!
//! 与明暗菜单正交：本测试只锁定这一个入口的契约——
//! - 触发器显示当前 `visual_preset`（未知/缺失落回默认「柔光玻璃」）；
//! - 展开后是两个 menuitemradio，当前值唯一勾选，带同一份名称/说明；
//! - 选中即写 `settings.visual_preset`（与主窗口标题栏、设置页同一管道）；
//! - 写入失败不静默：Toast 报出真实原因。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import WorkbenchPresetMenu from "./WorkbenchPresetMenu";
import { useSettingsStore } from "../store/useSettingsStore";
import { useUiStore } from "../store/useUiStore";

const update = vi.fn();

function seed(preset: string | undefined) {
  useSettingsStore.setState({
    settings: { visual_preset: preset } as never,
    update: update as never,
  });
}

beforeEach(() => {
  update.mockReset();
  update.mockResolvedValue(undefined);
  useUiStore.setState({ toasts: [], toast: null } as never);
});

afterEach(cleanup);

describe("WorkbenchPresetMenu", () => {
  it("触发器显示当前预设，展开后两个预设只有当前值被勾选", async () => {
    const user = userEvent.setup();
    seed("frosted");
    render(<WorkbenchPresetMenu />);

    const trigger = screen.getByRole("button", { name: "视觉主题（当前：柔光玻璃）" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(trigger);
    const menu = await screen.findByRole("menu", { name: "视觉主题" });
    const options = within(menu).getAllByRole("menuitemradio");
    expect(options.map((item) => item.textContent)).toEqual([
      expect.stringContaining("柔光玻璃"),
      expect.stringContaining("梦幻渐变"),
    ]);
    expect(
      within(menu).getByRole("menuitemradio", { name: /柔光玻璃/ }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(menu).getByRole("menuitemradio", { name: /梦幻渐变/ }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("未知/缺失取值落回默认预设，不显示「无选中项」", () => {
    seed(undefined);
    render(<WorkbenchPresetMenu />);
    expect(screen.getByRole("button", { name: "视觉主题（当前：柔光玻璃）" })).toBeTruthy();
  });

  it("选择梦幻渐变即写入 settings.visual_preset", async () => {
    const user = userEvent.setup();
    seed("frosted");
    render(<WorkbenchPresetMenu />);

    await user.click(screen.getByRole("button", { name: "视觉主题（当前：柔光玻璃）" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /梦幻渐变/ }));

    await waitFor(() => expect(update).toHaveBeenCalledWith({ visual_preset: "dream-gradient" }));
  });

  it("写入失败展示真实原因，不静默吞掉", async () => {
    const user = userEvent.setup();
    update.mockRejectedValue(new Error("数据库被占用"));
    seed("frosted");
    render(<WorkbenchPresetMenu />);

    await user.click(screen.getByRole("button", { name: "视觉主题（当前：柔光玻璃）" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /梦幻渐变/ }));

    await waitFor(() => {
      const toasts = useUiStore.getState().toasts;
      expect(toasts.some((item) => item.message.includes("数据库被占用"))).toBe(true);
    });
  });
});
