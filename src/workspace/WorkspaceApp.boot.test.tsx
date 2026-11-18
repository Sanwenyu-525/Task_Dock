/**
 * @vitest-environment jsdom
 */
//! 工作台窗口启动占位交接（WorkspaceApp）：
//! 设置落定（成功或失败）后必须调用 bootReady，否则 workspace.html 的占位
//! 会一直挡在 React 界面前面（或在超时后停在恢复卡）。
//!
//! 与主窗口同一判据：不按「#root 有子元素」判定，避免把设置加载门误当就绪。

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../workbench/WorkbenchShell", () => ({
  default: () => <div data-testid="workbench-shell" />,
}));

vi.mock("../boot/bootProtocol", async () => {
  const actual = await vi.importActual<typeof import("../boot/bootProtocol")>(
    "../boot/bootProtocol",
  );
  return { ...actual, bootStage: vi.fn(), bootReady: vi.fn() };
});

import { bootReady, bootStage } from "../boot/bootProtocol";
import { useSettingsStore } from "../store/useSettingsStore";
import WorkspaceApp from "./WorkspaceApp";

describe("WorkspaceApp 启动占位交接", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: null, loadError: null });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useSettingsStore.setState({ settings: null, loadError: null });
  });

  it("设置尚未落定时不移除启动占位", () => {
    render(<WorkspaceApp />);
    expect(bootReady).not.toHaveBeenCalled();
  });

  it("设置读取成功（设置落定）后移除占位并记录 settings 阶段", () => {
    render(<WorkspaceApp />);
    act(() => {
      useSettingsStore.setState({ settings: { theme: "dark" } as never });
    });
    expect(bootReady).toHaveBeenCalledTimes(1);
    expect(bootStage).toHaveBeenCalledWith("settings");
  });

  it("设置读取失败（错误卡已接管）同样移除占位并记录 settings 阶段", () => {
    render(<WorkspaceApp />);
    act(() => {
      useSettingsStore.setState({ loadError: "读取设置失败" });
    });
    expect(bootReady).toHaveBeenCalledTimes(1);
    expect(bootStage).toHaveBeenCalledWith("settings");
  });
});
