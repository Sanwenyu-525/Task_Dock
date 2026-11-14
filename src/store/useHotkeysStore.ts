/**
 * 自定义快捷键前端状态与运行时。
 *
 * - 设置页通过 `load/change/reset` 读写后端快照；
 * - `useHotkeysRuntime` 负责应用内（app_local）按键分发，并读取后端配置；
 * - 系统级（system_global）由 Rust 侧常驻注册，这里只展示状态，绝不重复监听。
 */

import { useEffect } from "react";
import { create } from "zustand";

import { errorMessage, invokeCommand } from "../lib/errors";
import { useSettingsStore } from "./useSettingsStore";
import { TAB_ORDER, useUiStore } from "./useUiStore";
import { resolveWindowMode } from "../lib/windowMode";
import { isWorkbenchHost } from "../lib/windowHost";
import type { Tab } from "./useUiStore";
import {
  acceleratorFromEvent,
} from "../components/settings/hotkeys/accelerator";
import type {
  HotkeyBindingView,
  HotkeyChangeOutcome,
  HotkeyResetOutcome,
  HotkeySnapshot,
} from "../components/settings/hotkeys/types";

export const HOTKEYS_CHANGED_EVENT = "hotkeys-changed";

export interface HotkeyChangeOptions {
  accelerator?: string;
  enabled?: boolean;
}

interface HotkeysState {
  bindings: HotkeyBindingView[];
  loadError: string | null;
  loading: boolean;
  error: string | null;
  recordingAction: string | null;
  applyingAction: string | null;
  rowErrors: Record<string, string | null>;
  load: () => Promise<void>;
  change: (
    action: string,
    options?: HotkeyChangeOptions,
  ) => Promise<HotkeyChangeOutcome | null>;
  reset: (action?: string) => Promise<HotkeyResetOutcome | null>;
  setEnabled: (
    action: string,
    enabled: boolean,
  ) => Promise<HotkeyChangeOutcome | null>;
  startRecording: (action: string) => void;
  cancelRecording: () => void;
}

/** IPC 封装；集成时可直接迁移到 `lib/bridge.ts`（命令名与参数保持不变）。 */
export const hotkeysApi = {
  snapshot: (): Promise<HotkeySnapshot> =>
    invokeCommand<HotkeySnapshot>("hotkeys_snapshot", undefined, "读取快捷键配置"),
  change: (
    action: string,
    options: HotkeyChangeOptions = {},
  ): Promise<HotkeyChangeOutcome> =>
    invokeCommand<HotkeyChangeOutcome>(
      "hotkeys_change",
      {
        action,
        accelerator: options.accelerator ?? null,
        enabled: options.enabled ?? null,
      },
      "修改快捷键",
    ),
  reset: (action?: string): Promise<HotkeyResetOutcome> =>
    invokeCommand<HotkeyResetOutcome>(
      "hotkeys_reset",
      { action: action ?? null },
      "恢复默认快捷键",
    ),
};

export const useHotkeysStore = create<HotkeysState>((set, get) => ({
  bindings: [],
  loadError: null,
  loading: false,
  error: null,
  recordingAction: null,
  applyingAction: null,
  rowErrors: {},

  load: async () => {
    set({ loading: true });
    try {
      const snapshot = await hotkeysApi.snapshot();
      set({
        bindings: snapshot.bindings,
        loadError: snapshot.load_error,
        loading: false,
        error: null,
      });
    } catch (error) {
      set({ loading: false, error: errorMessage(error) });
    }
  },

  change: async (action, options = {}) => {
    set({ applyingAction: action });
    try {
      const outcome = await hotkeysApi.change(action, options);
      set((state) => ({
        applyingAction: null,
        bindings: state.bindings.map((binding) =>
          binding.action === action ? outcome.binding : binding,
        ),
        rowErrors: {
          ...state.rowErrors,
          [action]: outcome.ok ? null : outcome.error,
        },
      }));
      return outcome;
    } catch (error) {
      const message = errorMessage(error);
      set((state) => ({
        applyingAction: null,
        error: message,
        rowErrors: { ...state.rowErrors, [action]: message },
      }));
      return null;
    }
  },

  reset: async (action) => {
    set({ applyingAction: action ?? "all" });
    try {
      const outcome = await hotkeysApi.reset(action);
      set({ applyingAction: null });
      await get().load();
      // 恢复成功后旧的逐行错误已失效，避免在已恢复的行下方继续显示冲突原因。
      if (outcome.ok) set({ rowErrors: {} });
      return outcome;
    } catch (error) {
      set({ applyingAction: null, error: errorMessage(error) });
      return null;
    }
  },

  setEnabled: async (action, enabled) => get().change(action, { enabled }),

  startRecording: (action) => set({ recordingAction: action }),
  cancelRecording: () => set({ recordingAction: null }),
}));

const TAB_ACTIONS: Record<string, Tab> = {
  switch_tab_tasks: TAB_ORDER[0],
  switch_tab_agents: TAB_ORDER[1],
  switch_tab_actions: TAB_ORDER[2],
  switch_tab_clipboard: TAB_ORDER[3],
  switch_tab_inbox: TAB_ORDER[4],
  switch_tab_shelf: TAB_ORDER[5],
  switch_tab_workflows: TAB_ORDER[6],
  switch_tab_history: TAB_ORDER[7],
  switch_tab_roadmap: TAB_ORDER[8],
  switch_tab_settings: TAB_ORDER[9],
};

/** 输入框内仍允许触发的动作（与原 Ctrl+Shift+C 行为一致）。 */
const ALLOW_IN_INPUT = new Set(["open_clipboard"]);

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    Boolean(element.isContentEditable)
  );
}

function isFullMode(): boolean {
  // 工作台窗口本身就是完整功能宿主：主窗口的 mode（minimal/compact/full）与它无关。
  // 不覆盖会让工作台里的 Ctrl+数字/Ctrl+Shift+C 永远被判定为「非完整模式」。
  if (isWorkbenchHost()) return true;
  return resolveWindowMode(useSettingsStore.getState().settings?.mode) === "full";
}

/** 执行应用内动作；返回 false 表示当前模式不适用，不应吞掉按键。 */
export function applyHotkeyAction(action: string): boolean {
  const ui = useUiStore.getState();
  if (action === "quick_add_task") {
    ui.bumpQuickAdd();
    return true;
  }
  if (action === "open_clipboard") {
    if (isFullMode()) {
      ui.setTab("clipboard");
      ui.closeClipboard();
    } else if (ui.clipboardOpen) {
      ui.closeClipboard();
    } else {
      ui.openClipboard();
    }
    return true;
  }
  if (action.startsWith("switch_tab_")) {
    if (!isFullMode()) return false;
    const tab = TAB_ACTIONS[action];
    if (!tab) return false;
    ui.setTab(tab);
    return true;
  }
  return false;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 运行时监听是应用级资源：多处挂载共享同一份，全部卸载后才释放，
 * 避免重复监听导致同一按键被处理多次或重复拉取快照。
 */
let runtimeRefs = 0;
let runtimeTeardown: (() => void) | null = null;

function installRuntime(): () => void {
  runtimeRefs += 1;
  if (runtimeRefs === 1) {
    runtimeTeardown = startRuntime();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    runtimeRefs = Math.max(0, runtimeRefs - 1);
    if (runtimeRefs === 0) {
      runtimeTeardown?.();
      runtimeTeardown = null;
    }
  };
}

function startRuntime(): () => void {
  void useHotkeysStore.getState().load();

  let disposed = false;
  let unlisten: (() => void) | undefined;
  if (isTauriRuntime()) {
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen(HOTKEYS_CHANGED_EVENT, () => {
          void useHotkeysStore.getState().load();
        }),
      )
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          unlisten = stop;
        }
      })
      .catch(() => {
        // 事件订阅失败不影响本地修改后的状态更新。
      });
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const state = useHotkeysStore.getState();
    if (state.recordingAction) return;
    if (event.defaultPrevented) return;
    const accelerator = acceleratorFromEvent(event);
    if (!accelerator) return;
    const binding = state.bindings.find(
      (item) =>
        item.scope === "app_local" &&
        item.enabled &&
        item.state === "active" &&
        item.accelerator === accelerator,
    );
    if (!binding) return;
    if (isTypingTarget(event.target) && !ALLOW_IN_INPUT.has(binding.action)) {
      return;
    }
    if (!applyHotkeyAction(binding.action)) return;
    event.preventDefault();
  };

  window.addEventListener("keydown", onKeyDown);
  return () => {
    disposed = true;
    unlisten?.();
    window.removeEventListener("keydown", onKeyDown);
  };
}

/**
 * 安装应用内快捷键运行时（App 根组件调用；重复挂载共享同一监听）。
 * 录制快捷键期间不触发任何动作；系统级按键由 Rust 侧处理。
 */
export function useHotkeysRuntime(): void {
  useEffect(() => installRuntime(), []);
}
