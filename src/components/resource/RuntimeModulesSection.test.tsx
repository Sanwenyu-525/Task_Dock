/**
 * @vitest-environment jsdom
 */
//! 功能运行分区：只读状态展示、真实暂停写入、共享模块无按钮、过渡态如实显示。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  lifecycleStatus: vi.fn(),
  updateSettings: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...bridge };
});

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}|${JSON.stringify(vars)}` : key,
  }),
}));

import RuntimeModulesSection from "./RuntimeModulesSection";
import { useSettingsStore } from "../../store/useSettingsStore";
import { resetLifecycleStoreForTest, useLifecycleStore } from "../../store/useLifecycleStore";
import type { ModuleRuntimeStatus, Settings } from "../../lib/bridge";

function status(id: string, patch: Partial<ModuleRuntimeStatus> = {}): ModuleRuntimeStatus {
  return {
    id,
    category: "resident",
    state: "running",
    intent: "running",
    controllable: true,
    background: [],
    detail: {},
    error: null,
    ...patch,
  };
}

const SETTINGS = {
  clipboard_enabled: true,
  clipboard_paused: false,
  reminders_paused: false,
  shelf_auto_cleanup_enabled: true,
  actions_enabled: true,
  tts_enabled: false,
  audio_sound_enabled: true,
} as unknown as Settings;

beforeEach(() => {
  cleanup();
  resetLifecycleStoreForTest();
  bridge.lifecycleStatus.mockReset();
  bridge.updateSettings.mockReset();
  bridge.getSettings.mockReset();
  bridge.updateSettings.mockResolvedValue(SETTINGS);
  bridge.getSettings.mockResolvedValue(SETTINGS);
  useSettingsStore.setState({ settings: SETTINGS });
});

describe("RuntimeModulesSection", () => {
  it("展示实际状态与后台活动，且不轮询", async () => {
    bridge.lifecycleStatus.mockResolvedValue([
      status("clipboard", { background: ["clipboard-monitor"] }),
      status("agents", {
        category: "shared",
        controllable: false,
        background: ["agent-ingest-pipeline"],
      }),
      status("ocr", { category: "ondemand", state: "idle", controllable: false }),
    ]);
    render(<RuntimeModulesSection />);
    await screen.findByText("lifecycle.module.clipboard.label");
    expect(bridge.lifecycleStatus).toHaveBeenCalledTimes(1);
    const clipboard = document.querySelector('[data-module-id="clipboard"]') as HTMLElement;
    expect(within(clipboard).getByText("lifecycle.state.running")).toBeTruthy();
    expect(within(clipboard).getByText("lifecycle.background.clipboardMonitor")).toBeTruthy();
    // 共享基础设施明确说明不可单独暂停，且没有暂停按钮
    const shared = document.querySelector('[data-module-id="agents"]') as HTMLElement;
    expect(within(shared).getByText("resource.modules.sharedManaged")).toBeTruthy();
    expect(within(shared).queryByRole("button")).toBeNull();
    // 按需模块显示 idle，不造暂停按钮
    const ondemand = document.querySelector('[data-module-id="ocr"]') as HTMLElement;
    expect(within(ondemand).getByText("lifecycle.state.idle")).toBeTruthy();
    expect(within(ondemand).queryByRole("button")).toBeNull();
  });

  it("暂停写既有设置键，成功后按真实状态切换按钮", async () => {
    bridge.updateSettings.mockResolvedValue({
      ...SETTINGS,
      clipboard_paused: true,
    } as Settings);
    bridge.lifecycleStatus
      .mockResolvedValueOnce([status("clipboard")])
      .mockResolvedValue([
        status("clipboard", { state: "paused", intent: "paused" }),
      ]);
    render(<RuntimeModulesSection />);
    const row = (await screen.findByText("lifecycle.module.clipboard.label")).closest(
      "li",
    ) as HTMLElement;
    const button = within(row).getByRole("button", { name: /lifecycle\.pauseAria/ });
    fireEvent.click(button);
    await waitFor(() =>
      expect(bridge.updateSettings).toHaveBeenCalledWith({ clipboard_paused: true }),
    );
    await waitFor(() => {
      expect(
        within(row).getByRole("button", { name: /lifecycle\.resumeAria/ }),
      ).toBeTruthy();
    });
    expect(within(row).getByText("lifecycle.state.paused")).toBeTruthy();
  });

  it("线程仍在收尾时显示 pausing，不提前报告已暂停", async () => {
    bridge.lifecycleStatus.mockResolvedValue([
      status("clipboard", { state: "pausing", intent: "paused" }),
    ]);
    render(<RuntimeModulesSection />);
    await screen.findByText("lifecycle.module.clipboard.label");
    expect(screen.getByText("lifecycle.state.pausing")).toBeTruthy();
  });

  it("状态查询失败显示真实错误并保留刷新入口", async () => {
    bridge.lifecycleStatus.mockRejectedValue(new Error("IPC 失败"));
    render(<RuntimeModulesSection />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("resource.modules.error");
    expect(screen.getByRole("button", { name: "resource.modules.refresh" })).toBeTruthy();
    expect(useLifecycleStore.getState().statuses).toBeNull();
  });
});
