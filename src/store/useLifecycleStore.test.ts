/**
 * @vitest-environment jsdom
 */
//! 生命周期 Store：单飞查询、串行操作、幂等映射与真实错误。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  lifecycleStatus: vi.fn(),
  updateSettings: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bridge")>();
  return { ...actual, ...bridge };
});

import { resetLifecycleStoreForTest, useLifecycleStore } from "./useLifecycleStore";
import { useSettingsStore } from "./useSettingsStore";
import type { ModuleRuntimeStatus, Settings } from "../lib/bridge";

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

const BASE_SETTINGS = {
  clipboard_paused: false,
  clipboard_enabled: true,
  shelf_auto_cleanup_enabled: true,
  reminders_paused: false,
  actions_enabled: true,
  tts_enabled: false,
} as unknown as Settings;

beforeEach(() => {
  resetLifecycleStoreForTest();
  bridge.lifecycleStatus.mockReset();
  bridge.updateSettings.mockReset();
  bridge.getSettings.mockReset();
  bridge.updateSettings.mockResolvedValue(BASE_SETTINGS);
  bridge.getSettings.mockResolvedValue(BASE_SETTINGS);
  useSettingsStore.setState({ settings: BASE_SETTINGS });
});

describe("useLifecycleStore", () => {
  it("并发刷新只发一次查询（单飞 + 排队合并）", async () => {
    let resolve!: (value: ModuleRuntimeStatus[]) => void;
    bridge.lifecycleStatus.mockImplementation(
      () => new Promise<ModuleRuntimeStatus[]>((r) => (resolve = r)),
    );
    const first = useLifecycleStore.getState().refresh();
    const second = useLifecycleStore.getState().refresh();
    expect(bridge.lifecycleStatus).toHaveBeenCalledTimes(1);
    resolve([status("clipboard")]);
    await Promise.all([first, second]);
    expect(useLifecycleStore.getState().statuses).toHaveLength(1);
    expect(useLifecycleStore.getState().error).toBeNull();
  });

  it("暂停写入既有设置键，并在写库成功后重查实际状态", async () => {
    bridge.lifecycleStatus
      .mockResolvedValueOnce([status("clipboard")])
      .mockResolvedValueOnce([status("clipboard", { state: "paused", intent: "paused" })]);
    await useLifecycleStore.getState().refresh();
    const ok = await useLifecycleStore.getState().setPaused("clipboard", true);
    expect(ok).toBe(true);
    expect(bridge.updateSettings).toHaveBeenCalledWith({ clipboard_paused: true });
    expect(bridge.lifecycleStatus).toHaveBeenCalledTimes(2);
    expect(useLifecycleStore.getState().statuses?.[0].state).toBe("paused");
    expect(useLifecycleStore.getState().pending.clipboard).toBeUndefined();
  });

  it("开关型模块的暂停映射为关闭设置，不写反", async () => {
    bridge.lifecycleStatus.mockResolvedValue([status("shelf_cleanup")]);
    const ok = await useLifecycleStore.getState().setPaused("shelf_cleanup", true);
    expect(ok).toBe(true);
    expect(bridge.updateSettings).toHaveBeenCalledWith({
      shelf_auto_cleanup_enabled: false,
    });
  });

  it("快速连续暂停/恢复按顺序执行，最后一次意图胜出", async () => {
    let releaseFirst!: (value: Settings) => void;
    bridge.updateSettings
      .mockImplementationOnce(
        () => new Promise<Settings>((resolve) => (releaseFirst = resolve)),
      )
      .mockResolvedValueOnce(BASE_SETTINGS);
    bridge.lifecycleStatus.mockResolvedValue([status("clipboard")]);

    const pause = useLifecycleStore.getState().setPaused("clipboard", true);
    const resume = useLifecycleStore.getState().setPaused("clipboard", false);
    // 第二条操作必须等第一条完成，不能并发写同一键
    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledTimes(1));
    releaseFirst(BASE_SETTINGS);
    await Promise.all([pause, resume]);

    expect(bridge.updateSettings.mock.calls.map((call) => call[0])).toEqual([
      { clipboard_paused: true },
      { clipboard_paused: false },
    ]);
  });

  it("不支持暂停的模块直接失败，不发写请求", async () => {
    const ok = await useLifecycleStore.getState().setPaused("agents", true);
    expect(ok).toBe(false);
    expect(bridge.updateSettings).not.toHaveBeenCalled();
    expect(useLifecycleStore.getState().errors.agents).toBeTruthy();
  });

  it("写入失败保留旧快照并记录错误，不伪装成功", async () => {
    bridge.lifecycleStatus.mockResolvedValue([status("clipboard")]);
    await useLifecycleStore.getState().refresh();
    bridge.updateSettings.mockRejectedValue(new Error("数据库繁忙"));
    const ok = await useLifecycleStore.getState().setPaused("clipboard", true);
    expect(ok).toBe(false);
    expect(useLifecycleStore.getState().statuses?.[0].id).toBe("clipboard");
    expect(useLifecycleStore.getState().errors.clipboard).toBeTruthy();
  });

  it("查询失败保留旧快照并暴露错误", async () => {
    bridge.lifecycleStatus.mockResolvedValueOnce([status("clipboard")]);
    await useLifecycleStore.getState().refresh();
    bridge.lifecycleStatus.mockRejectedValueOnce(new Error("IPC 失败"));
    await useLifecycleStore.getState().refresh();
    expect(useLifecycleStore.getState().statuses?.[0].id).toBe("clipboard");
    expect(useLifecycleStore.getState().error).toBeTruthy();
  });
});
