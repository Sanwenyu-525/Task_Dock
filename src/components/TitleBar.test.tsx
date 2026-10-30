/**
 * @vitest-environment jsdom
 */
//! 标题栏（v0.6）：
//! - 完整模式**没有**剪贴板按钮（入口在左侧导航）；
//! - 紧凑/极简模式没有左侧导航，标题栏保留剪贴板按钮作为临时入口；
//! - 该按钮开合剪贴板抽屉，并同步 aria-expanded。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize: vi.fn(), hide: vi.fn() }),
}));

import TitleBar from "./TitleBar";
import { useUiStore } from "../store/useUiStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { useAgentsStore } from "../store/useAgentsStore";

function setMode(mode: "full" | "compact" | "minimal") {
  useSettingsStore.setState({
    settings: { mode, theme: "light", visual_preset: "dream-gradient" } as never,
  });
}

describe("TitleBar 剪贴板入口", () => {
  beforeEach(() => {
    useUiStore.setState({ tab: "tasks", clipboardOpen: false, clipboardLinkTask: null });
    useAgentsStore.setState({ snapshot: null });
    setMode("full");
  });

  afterEach(() => cleanup());

  it("完整模式不显示剪贴板按钮（入口在左侧导航）", () => {
    render(<TitleBar />);
    expect(screen.queryByRole("button", { name: "打开智能剪贴板" })).toBeNull();
  });

  it("紧凑模式保留剪贴板按钮，点击后打开抽屉", async () => {
    const user = userEvent.setup();
    setMode("compact");
    render(<TitleBar />);

    const btn = screen.getByRole("button", { name: "打开智能剪贴板" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    await user.click(btn);
    expect(useUiStore.getState().clipboardOpen).toBe(true);
    expect(screen.getByRole("button", { name: "打开智能剪贴板" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("极简模式保留剪贴板按钮，再次点击关闭抽屉", async () => {
    const user = userEvent.setup();
    setMode("minimal");
    render(<TitleBar />);

    const btn = screen.getByRole("button", { name: "打开智能剪贴板" });
    await user.click(btn);
    expect(useUiStore.getState().clipboardOpen).toBe(true);

    await user.click(screen.getByRole("button", { name: "打开智能剪贴板" }));
    expect(useUiStore.getState().clipboardOpen).toBe(false);
  });
});
