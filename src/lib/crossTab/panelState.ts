//! 工作篮面板状态（可见 / 固定 / 宽度 / 推荐开关）。
//!
//! 持久化落在 `localStorage`：工作台与主窗口同源，两个窗口读同一份状态，
//! 跨窗口用 `storage` 事件同步；不把面板的临时开合写进设置表，避免一次拖动
//! 就产生数据库写入。宽度范围与后端设置校验保持一致（240–900）。

import type { PanelMode, PanelState } from "./types";

const KEY = "taskdock.transfer.panel.v1";
export const PANEL_WIDTH_MIN = 240;
export const PANEL_WIDTH_MAX = 900;
export const PANEL_WIDTH_DEFAULT = 320;

export const DEFAULT_PANEL_STATE: PanelState = {
  visible: false,
  pinned: true,
  width: PANEL_WIDTH_DEFAULT,
  suggestionsEnabled: true,
};

function clampWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return PANEL_WIDTH_DEFAULT;
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, Math.round(value)));
}

function read(): PanelState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PANEL_STATE;
    const parsed = JSON.parse(raw) as Partial<PanelState>;
    return {
      visible: parsed.visible === true,
      pinned: parsed.pinned !== false,
      width: clampWidth(parsed.width),
      suggestionsEnabled: parsed.suggestionsEnabled !== false,
    };
  } catch {
    return DEFAULT_PANEL_STATE;
  }
}

let state: PanelState = typeof localStorage === "undefined" ? DEFAULT_PANEL_STATE : read();

/** 本窗口内的状态订阅（跨窗口另有 storage 事件）。 */
const listeners = new Set<(next: PanelState) => void>();

function emit(): void {
  for (const listener of listeners) listener(state);
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // 隐私模式 / 存储被禁用时只保留内存状态；不阻断操作。
  }
}

export function getPanelState(): PanelState {
  return state;
}

export function setPanelState(patch: Partial<PanelState>): PanelState {
  const next: PanelState = {
    visible: patch.visible ?? state.visible,
    pinned: patch.pinned ?? state.pinned,
    width: clampWidth(patch.width ?? state.width),
    suggestionsEnabled: patch.suggestionsEnabled ?? state.suggestionsEnabled,
  };
  if (
    next.visible === state.visible &&
    next.pinned === state.pinned &&
    next.width === state.width &&
    next.suggestionsEnabled === state.suggestionsEnabled
  ) {
    return state;
  }
  state = next;
  persist();
  emit();
  return state;
}

export function setPanelVisible(visible: boolean): PanelState {
  return setPanelState({ visible });
}

export function setPanelPinned(pinned: boolean): PanelState {
  return setPanelState({ pinned });
}

export function setPanelWidth(width: number): PanelState {
  return setPanelState({ width });
}

export function restorePanelState(): PanelState {
  state = read();
  emit();
  return state;
}

/**
 * 形态只由可用宽度决定：固定列需要主内容 + 两侧栏都放得下；
 * 窄窗一律抽屉，绝不把主内容挤到不可用。
 */
export function resolvePanelMode(availableWidth: number): PanelMode {
  return availableWidth >= 1080 ? "dock" : "drawer";
}

export function subscribePanelState(listener: (next: PanelState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    state = read();
    emit();
  });
}
