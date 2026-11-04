/**
 * @vitest-environment jsdom
 */
//! 快捷键前端状态与运行时回归：
//! 1. 快照加载、修改失败保留旧绑定并展示原因、IPC 异常归一化；
//! 2. 恢复默认后重新拉取快照；
//! 3. 应用内动作语义与原 `useGlobalShortcuts` 保持一致；
//! 4. 录制期间与输入框内不触发应用内动作，系统级按键不在前端重复处理。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  invokeCommand: vi.fn(),
  errorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error),
  ),
}));

vi.mock("../lib/errors", () => ipc);
vi.mock("../lib/bridge", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  applyWindowMaterial: vi.fn(),
  applyWindowRadius: vi.fn(),
}));

import { useSettingsStore } from "./useSettingsStore";
import { TAB_ORDER, useUiStore } from "./useUiStore";
import type { Tab } from "./useUiStore";
import {
  applyHotkeyAction,
  useHotkeysRuntime,
  useHotkeysStore,
} from "./useHotkeysStore";
import type { HotkeyBindingView, HotkeySnapshot } from "../components/settings/hotkeys/types";

function binding(
  overrides: Partial<HotkeyBindingView> & Pick<HotkeyBindingView, "action">,
): HotkeyBindingView {
  return {
    label: overrides.action,
    description: "",
    scope: "app_local",
    accelerator: "Ctrl+K",
    default_accelerator: "Ctrl+K",
    enabled: true,
    is_default: true,
    state: "active",
    message: null,
    ...overrides,
  };
}

function snapshot(bindings: HotkeyBindingView[]): HotkeySnapshot {
  return { bindings, load_error: null };
}

const DEFAULT_BINDINGS: HotkeyBindingView[] = [
  binding({ action: "toggle_main_window", label: "显示 / 隐藏主窗口", scope: "system_global", accelerator: "Ctrl+Alt+T" }),
  binding({ action: "open_quick_capture", label: "打开快速捕获", scope: "system_global", accelerator: "Ctrl+Shift+Space" }),
  binding({ action: "quick_add_task", label: "快速添加任务", accelerator: "Ctrl+K" }),
  binding({ action: "open_clipboard", label: "打开剪贴板", accelerator: "Ctrl+Shift+C" }),
  binding({ action: "switch_tab_tasks", label: "切换到任务", accelerator: "Ctrl+1" }),
  binding({ action: "switch_tab_settings", label: "切换到设置", accelerator: "Ctrl+0" }),
];

beforeEach(() => {
  ipc.invokeCommand.mockReset();
  ipc.errorMessage.mockClear();
  useHotkeysStore.setState({
    bindings: [],
    loadError: null,
    loading: false,
    error: null,
    recordingAction: null,
    applyingAction: null,
    rowErrors: {},
  });
  useUiStore.setState({
    tab: "tasks",
    quickAddToken: 0,
    clipboardOpen: false,
    clipboardLinkTask: null,
    toasts: [],
    toast: null,
  });
  useSettingsStore.setState({ settings: { mode: "full" } as never });
});

afterEach(() => {
  cleanup();
  useHotkeysStore.getState().cancelRecording();
});

describe("useHotkeysStore", () => {
  it("加载快照并保留后端给出的加载提示", async () => {
    ipc.invokeCommand.mockResolvedValue({
      bindings: DEFAULT_BINDINGS,
      load_error: "旧动作已忽略",
    });
    await useHotkeysStore.getState().load();
    const state = useHotkeysStore.getState();
    expect(state.bindings).toHaveLength(DEFAULT_BINDINGS.length);
    expect(state.loadError).toBe("旧动作已忽略");
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      "hotkeys_snapshot",
      undefined,
      "读取快捷键配置",
    );
  });

  it("修改失败时保留旧绑定并在该行展示原因", async () => {
    useHotkeysStore.setState({ bindings: DEFAULT_BINDINGS });
    const old = DEFAULT_BINDINGS.find((b) => b.action === "quick_add_task")!;
    ipc.invokeCommand.mockResolvedValue({
      ok: false,
      action: "quick_add_task",
      binding: old,
      previous_accelerator: "Ctrl+K",
      persisted: false,
      rolled_back: true,
      rollback_ok: true,
      error: "注册失败，已保留原快捷键：该组合已被其他程序占用",
      error_kind: "occupied",
    });
    const outcome = await useHotkeysStore.getState().change("quick_add_task", {
      accelerator: "Ctrl+Shift+K",
    });
    expect(outcome?.ok).toBe(false);
    const state = useHotkeysStore.getState();
    expect(
      state.bindings.find((b) => b.action === "quick_add_task")?.accelerator,
    ).toBe("Ctrl+K");
    expect(state.rowErrors.quick_add_task).toContain("已保留原快捷键");
    expect(state.applyingAction).toBeNull();
  });

  it("IPC 异常归一化为可展示错误，不伪装成功", async () => {
    useHotkeysStore.setState({ bindings: DEFAULT_BINDINGS });
    ipc.invokeCommand.mockRejectedValue(new Error("后端不可用"));
    const outcome = await useHotkeysStore.getState().change("quick_add_task", {
      accelerator: "Ctrl+Shift+K",
    });
    expect(outcome).toBeNull();
    const state = useHotkeysStore.getState();
    expect(state.error).toContain("后端不可用");
    expect(state.rowErrors.quick_add_task).toContain("后端不可用");
    expect(
      state.bindings.find((b) => b.action === "quick_add_task")?.accelerator,
    ).toBe("Ctrl+K");
  });

  it("恢复默认后重新拉取快照并清除旧的逐行错误", async () => {
    useHotkeysStore.setState({
      rowErrors: { quick_add_task: "组合 Ctrl+1 已分配给「切换到任务」" },
    });
    ipc.invokeCommand
      .mockResolvedValueOnce({
        ok: true,
        results: [],
        error: null,
      })
      .mockResolvedValueOnce(snapshot(DEFAULT_BINDINGS));
    const outcome = await useHotkeysStore.getState().reset();
    expect(outcome?.ok).toBe(true);
    expect(ipc.invokeCommand).toHaveBeenNthCalledWith(
      1,
      "hotkeys_reset",
      { action: null },
      "恢复默认快捷键",
    );
    expect(useHotkeysStore.getState().bindings).toHaveLength(DEFAULT_BINDINGS.length);
    expect(useHotkeysStore.getState().rowErrors).toEqual({});
  });

  it("启用/禁用代理到 change", async () => {
    useHotkeysStore.setState({ bindings: DEFAULT_BINDINGS });
    ipc.invokeCommand.mockResolvedValue({
      ok: true,
      action: "toggle_main_window",
      binding: binding({
        action: "toggle_main_window",
        scope: "system_global",
        accelerator: "Ctrl+Alt+T",
        enabled: false,
        state: "disabled",
        is_default: false,
      }),
      previous_accelerator: "Ctrl+Alt+T",
      persisted: true,
      rolled_back: false,
      rollback_ok: null,
      error: null,
      error_kind: null,
    });
    await useHotkeysStore.getState().setEnabled("toggle_main_window", false);
    expect(ipc.invokeCommand).toHaveBeenCalledWith(
      "hotkeys_change",
      { action: "toggle_main_window", accelerator: null, enabled: false },
      "修改快捷键",
    );
    expect(
      useHotkeysStore.getState().bindings.find((b) => b.action === "toggle_main_window")
        ?.enabled,
    ).toBe(false);
  });
});

describe("applyHotkeyAction", () => {
  it("快速添加任务与剪贴板保持原语义", () => {
    applyHotkeyAction("quick_add_task");
    expect(useUiStore.getState().quickAddToken).toBe(1);

    applyHotkeyAction("open_clipboard");
    expect(useUiStore.getState().tab).toBe("clipboard");
    expect(useUiStore.getState().clipboardOpen).toBe(false);

    useUiStore.setState({ clipboardOpen: true });
    useSettingsStore.setState({ settings: { mode: "compact" } as never });
    applyHotkeyAction("open_clipboard");
    expect(useUiStore.getState().clipboardOpen).toBe(false);
  });

  it("数字键只在完整模式切换逻辑 Tab", () => {
    expect(applyHotkeyAction("switch_tab_tasks")).toBe(true);
    expect(useUiStore.getState().tab).toBe(TAB_ORDER[0]);

    useSettingsStore.setState({ settings: { mode: "compact" } as never });
    expect(applyHotkeyAction("switch_tab_settings")).toBe(false);
    expect(useUiStore.getState().tab).toBe(TAB_ORDER[0]);
  });

  it("Ctrl+1…9 / Ctrl+0 与已发布的逻辑 Tab 顺序完全一致", () => {
    // 冻结已发布语义：动作 ID、数字键与逻辑 Tab 的对应关系不得随导航入口增删而漂移。
    const expected: Array<[string, Tab]> = [
      ["switch_tab_tasks", "tasks"],
      ["switch_tab_agents", "agents"],
      ["switch_tab_actions", "actions"],
      ["switch_tab_clipboard", "clipboard"],
      ["switch_tab_inbox", "inbox"],
      ["switch_tab_shelf", "shelf"],
      ["switch_tab_workflows", "workflows"],
      ["switch_tab_history", "history"],
      ["switch_tab_roadmap", "roadmap"],
      ["switch_tab_settings", "settings"],
    ];
    expect(expected.map(([, tab]) => tab)).toEqual([...TAB_ORDER]);

    for (const [action, tab] of expected) {
      useUiStore.setState({ tab: "tasks" });
      expect(applyHotkeyAction(action)).toBe(true);
      expect(useUiStore.getState().tab).toBe(tab);
    }
  });

  it("未知动作不吞按键", () => {
    expect(applyHotkeyAction("open_global_search")).toBe(false);
    expect(applyHotkeyAction("toggle_main_window")).toBe(false);
  });
});

describe("useHotkeysRuntime", () => {
  function keydown(
    code: string,
    modifiers: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
    target?: EventTarget,
  ) {
    const event = new KeyboardEvent("keydown", {
      code,
      ctrlKey: Boolean(modifiers.ctrlKey),
      shiftKey: Boolean(modifiers.shiftKey),
      altKey: Boolean(modifiers.altKey),
      bubbles: true,
      cancelable: true,
    });
    (target ?? window).dispatchEvent(event);
    return event;
  }

  it("应用内组合触发动作，系统级组合不在前端重复执行", () => {
    ipc.invokeCommand.mockResolvedValue(snapshot(DEFAULT_BINDINGS));
    renderHook(() => useHotkeysRuntime());
    useHotkeysStore.setState({ bindings: DEFAULT_BINDINGS });

    const event = keydown("KeyK", { ctrlKey: true });
    expect(useUiStore.getState().quickAddToken).toBe(1);
    expect(event.defaultPrevented).toBe(true);

    // 系统级 Ctrl+Alt+T 由 Rust 注册处理，前端不应再切换页面。
    keydown("KeyT", { ctrlKey: true, altKey: true });
    expect(useUiStore.getState().tab).toBe("tasks");
  });

  it("录制期间不触发任何快捷键", () => {
    renderHook(() => useHotkeysRuntime());
    useHotkeysStore.setState({ bindings: DEFAULT_BINDINGS, recordingAction: "quick_add_task" });
    keydown("KeyK", { ctrlKey: true });
    expect(useUiStore.getState().quickAddToken).toBe(0);
    useHotkeysStore.getState().cancelRecording();
  });

  it("输入框内保留原生编辑，仅剪贴板组合例外", () => {
    renderHook(() => useHotkeysRuntime());
    useHotkeysStore.setState({ bindings: DEFAULT_BINDINGS });
    const input = document.createElement("input");
    document.body.appendChild(input);

    keydown("KeyK", { ctrlKey: true }, input);
    expect(useUiStore.getState().quickAddToken).toBe(0);

    keydown("KeyC", { ctrlKey: true, shiftKey: true }, input);
    expect(useUiStore.getState().tab).toBe("clipboard");
    input.remove();
  });

  it("已失效（state 非 active）的绑定不触发", () => {
    renderHook(() => useHotkeysRuntime());
    useHotkeysStore.setState({
      bindings: [
        binding({
          action: "quick_add_task",
          accelerator: "Ctrl+K",
          state: "conflict",
        }),
      ],
    });
    keydown("KeyK", { ctrlKey: true });
    expect(useUiStore.getState().quickAddToken).toBe(0);
  });

  it("重复挂载共享单一监听，全部卸载后才停止分发", () => {
    useHotkeysStore.setState({ bindings: DEFAULT_BINDINGS });
    const first = renderHook(() => useHotkeysRuntime());
    const second = renderHook(() => useHotkeysRuntime());

    first.unmount();
    keydown("KeyK", { ctrlKey: true });
    expect(useUiStore.getState().quickAddToken).toBe(1);

    second.unmount();
    keydown("KeyK", { ctrlKey: true });
    expect(useUiStore.getState().quickAddToken).toBe(1);
  });
});
