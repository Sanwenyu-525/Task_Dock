/**
 * @vitest-environment jsdom
 */
//! 设置页快捷键区域交互：
//! 1. 编辑进入录制，修饰键/输入法/保留组合/内部冲突都有明确提示且不提交；
//! 2. 合法组合写入后端，成功后提示“已更新”；
//! 3. 后端失败时提示“未修改”，不伪装成功；
//! 4. Esc 取消录制；全部恢复默认需二次确认。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const ipc = vi.hoisted(() => ({
  invokeCommand: vi.fn(),
  errorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : String(error),
  ),
}));

vi.mock("../../../lib/errors", () => ipc);
vi.mock("../../../lib/bridge", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  applyWindowMaterial: vi.fn(),
  applyWindowRadius: vi.fn(),
}));

import HotkeysSection from "./HotkeysSection";
import { useHotkeysStore } from "../../../store/useHotkeysStore";
import { useUiStore } from "../../../store/useUiStore";
import { __resetLocaleForTests, useLocaleStore } from "../../../i18n";
import type { HotkeyBindingView } from "./types";

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

const BINDINGS: HotkeyBindingView[] = [
  binding({
    action: "toggle_main_window",
    label: "显示 / 隐藏主窗口",
    description: "系统级",
    scope: "system_global",
    accelerator: "Ctrl+Alt+T",
  }),
  binding({
    action: "quick_add_task",
    label: "快速添加任务",
    description: "应用内：窗口聚焦时打开快速添加输入",
    accelerator: "Ctrl+K",
  }),
  binding({
    action: "switch_tab_tasks",
    label: "切换到任务",
    accelerator: "Ctrl+1",
    default_accelerator: "Ctrl+1",
  }),
];

function press(
  code: string,
  modifiers: {
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    isComposing?: boolean;
  } = {},
) {
  fireEvent.keyDown(window, {
    code,
    ctrlKey: Boolean(modifiers.ctrlKey),
    shiftKey: Boolean(modifiers.shiftKey),
    altKey: Boolean(modifiers.altKey),
    isComposing: Boolean(modifiers.isComposing),
  });
}

function lastToast() {
  return useUiStore.getState().toasts.at(-1) ?? null;
}

beforeEach(() => {
  ipc.invokeCommand.mockReset();
  ipc.errorMessage.mockClear();
  useHotkeysStore.setState({
    bindings: BINDINGS,
    loadError: null,
    loading: false,
    error: null,
    recordingAction: null,
    applyingAction: null,
    rowErrors: {},
  });
  useUiStore.setState({ toasts: [], toast: null });
});

afterEach(() => {
  cleanup();
  useHotkeysStore.getState().cancelRecording();
  // 语言是全局状态：本文件内切换后必须复位，避免影响后续用例。
  __resetLocaleForTests();
});

describe("HotkeysSection 录制", () => {
  function startRecording(label = "快速添加任务") {
    render(<HotkeysSection />);
    fireEvent.click(screen.getByLabelText(`编辑「${label}」快捷键`));
    expect(useHotkeysStore.getState().recordingAction).toBe("quick_add_task");
  }

  it("单独修饰键给出继续按键提示且不提交", () => {
    startRecording();
    press("ControlLeft", { ctrlKey: true });
    expect(screen.getByText(/请继续按下一个主键/)).toBeTruthy();
    expect(ipc.invokeCommand).not.toHaveBeenCalled();
  });

  it("输入法组合期间不提交", () => {
    startRecording();
    press("KeyK", { ctrlKey: true, isComposing: true });
    expect(screen.getByText(/输入法正在组合按键/)).toBeTruthy();
    expect(ipc.invokeCommand).not.toHaveBeenCalled();
    expect(useHotkeysStore.getState().recordingAction).toBe("quick_add_task");
  });

  it("系统保留组合被拒绝并保持录制", () => {
    startRecording();
    press("F4", { altKey: true });
    expect(screen.getByText(/系统保留组合/)).toBeTruthy();
    expect(ipc.invokeCommand).not.toHaveBeenCalled();
  });

  it("应用内冲突被拒绝并指出占用的动作", () => {
    startRecording();
    press("Digit1", { ctrlKey: true });
    expect(screen.getByText(/已分配给「切换到任务」/)).toBeTruthy();
    expect(ipc.invokeCommand).not.toHaveBeenCalled();
  });

  it("Esc 取消录制", () => {
    startRecording();
    press("Escape");
    expect(useHotkeysStore.getState().recordingAction).toBeNull();
    expect(ipc.invokeCommand).not.toHaveBeenCalled();
  });

  it("合法组合提交并提示已更新", async () => {
    startRecording();
    ipc.invokeCommand.mockResolvedValue({
      ok: true,
      action: "quick_add_task",
      binding: binding({ action: "quick_add_task", accelerator: "Ctrl+Shift+K" }),
      previous_accelerator: "Ctrl+K",
      persisted: true,
      rolled_back: false,
      rollback_ok: null,
      error: null,
      error_kind: null,
    });
    press("KeyK", { ctrlKey: true, shiftKey: true });
    expect(useHotkeysStore.getState().recordingAction).toBeNull();
    await waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith(
        "hotkeys_change",
        { action: "quick_add_task", accelerator: "Ctrl+Shift+K", enabled: null },
        "修改快捷键",
      );
    });
    await waitFor(() => {
      expect(lastToast()?.message).toContain("已更新为 Ctrl+Shift+K");
      expect(lastToast()?.kind).toBe("success");
    });
  });

  it("注册失败时提示未修改并展示原因", async () => {
    startRecording();
    ipc.invokeCommand.mockResolvedValue({
      ok: false,
      action: "quick_add_task",
      binding: binding({ action: "quick_add_task", accelerator: "Ctrl+K" }),
      previous_accelerator: "Ctrl+K",
      persisted: false,
      rolled_back: false,
      rollback_ok: null,
      error: "注册失败，已保留原快捷键：该组合已被其他程序占用",
      error_kind: "occupied",
    });
    press("KeyK", { ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      const toast = lastToast();
      expect(toast?.message).toContain("未修改");
      expect(toast?.message).toContain("已保留原快捷键");
      expect(toast?.kind).toBe("warning");
    });
    // 列表仍显示旧组合，绝不显示成新组合。
    expect(
      useHotkeysStore.getState().bindings.find((b) => b.action === "quick_add_task")
        ?.accelerator,
    ).toBe("Ctrl+K");
  });
});

describe("HotkeysSection 生命周期", () => {
  it("录制中卸载组件会取消录制，避免应用内快捷键残留失效", () => {
    const { unmount } = render(<HotkeysSection />);
    fireEvent.click(screen.getByLabelText("编辑「快速添加任务」快捷键"));
    expect(useHotkeysStore.getState().recordingAction).toBe("quick_add_task");

    unmount();
    expect(useHotkeysStore.getState().recordingAction).toBeNull();
  });
});

describe("HotkeysSection 重置", () => {
  it("冲突（已启用但未注册）时保留「重置」作为重新应用入口", async () => {
    useHotkeysStore.setState({
      bindings: [
        binding({
          action: "toggle_main_window",
          label: "显示 / 隐藏主窗口",
          scope: "system_global",
          accelerator: "Ctrl+Alt+T",
          default_accelerator: "Ctrl+Alt+T",
          state: "conflict",
          message: "系统级注册已失效（可能被其他程序抢占或注册被系统撤销）",
        }),
      ],
    });
    ipc.invokeCommand
      .mockResolvedValueOnce({ ok: true, results: [], error: null })
      .mockResolvedValueOnce({
        bindings: useHotkeysStore.getState().bindings,
        load_error: null,
      });

    render(<HotkeysSection />);
    const button = screen.getByLabelText(
      "恢复「显示 / 隐藏主窗口」默认快捷键",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenCalledWith(
        "hotkeys_reset",
        { action: "toggle_main_window" },
        "恢复默认快捷键",
      );
    });
  });

  it("全部恢复默认需要二次确认", async () => {
    ipc.invokeCommand
      .mockResolvedValueOnce({ ok: true, results: [], error: null })
      .mockResolvedValueOnce({ bindings: BINDINGS, load_error: null });

    render(<HotkeysSection />);
    fireEvent.click(screen.getByRole("button", { name: "全部恢复默认快捷键" }));
    expect(screen.getByText("恢复全部默认快捷键？")).toBeTruthy();
    expect(ipc.invokeCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    await waitFor(() => {
      expect(ipc.invokeCommand).toHaveBeenNthCalledWith(
        1,
        "hotkeys_reset",
        { action: null },
        "恢复默认快捷键",
      );
    });
  });
});

describe("HotkeysSection 三行结构", () => {
  it("名称/状态、组合/操作、说明分层，操作区成组右对齐", () => {
    render(<HotkeysSection />);
    const row = document.querySelector(
      '[data-hotkey-action="toggle_main_window"]',
    ) as HTMLElement;
    expect(row).toBeTruthy();

    const head = row.querySelector(".hotkey-row-head") as HTMLElement;
    expect(head.querySelector(".hotkey-name")?.textContent).toBe("显示 / 隐藏主窗口");
    const meta = head.querySelector(".hotkey-meta") as HTMLElement;
    expect(meta.querySelectorAll(".chip")).toHaveLength(2);
    expect(meta.textContent).toContain("系统级");
    expect(meta.textContent).toContain("已生效");

    const actionRow = row.querySelector(".hotkey-row-action") as HTMLElement;
    expect(actionRow.querySelector(".hotkey-combo")?.textContent).toBe("Ctrl+Alt+T");
    const actions = actionRow.querySelector(".hotkey-actions") as HTMLElement;
    expect(actions.querySelectorAll("button")).toHaveLength(2);
    expect(actions.textContent).toContain("编辑");
    expect(actions.textContent).toContain("重置");

    expect(row.querySelector(".hotkey-note")?.textContent).toContain("系统级");
  });
});

describe("HotkeysSection i18n", () => {
  it("切换语言后固定文案与动作名称按 action 映射到英文目录", () => {
    render(<HotkeysSection />);
    expect(screen.getByText("快捷键管理")).toBeTruthy();
    expect(screen.getByText("显示 / 隐藏主窗口")).toBeTruthy();

    act(() => {
      useLocaleStore.getState().setPreference("en-US");
    });

    expect(screen.getByText("Keyboard shortcuts")).toBeTruthy();
    // 动作名称来自 hotkeys.action.<action>.label，而不是后端中文 label。
    expect(screen.getByText("Show / hide main window")).toBeTruthy();
    expect(screen.getByText("Reset all")).toBeTruthy();
    expect(
      screen.getByLabelText('Edit the shortcut for "Show / hide main window"'),
    ).toBeTruthy();
    expect(screen.queryByText("显示 / 隐藏主窗口")).toBeNull();
  });
});
