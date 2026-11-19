//! 工作篮面板状态（可见 / 固定 / 宽度 / 推荐开关 / 当前形态）。
//!
//! 唯一事实源：**面板状态只存 `localStorage`**（`taskdock.transfer.panel.v1`）。
//! 后端 `Settings` 没有、也不应该再有第二份面板宽度/开合记录，否则两个窗口
//! 各写一份就会出现互相覆盖。条目数据仍由 SQLite 负责，与面板状态正交。
//!
//! 形态（dock / drawer）是**运行时推导**结果，不持久化：
//! - 主窗口没有工作台内容容器 → 永远抽屉；
//! - 完整工作台里只有「用户固定 + 容器够宽」才是固定列，其余一律抽屉；
//! - 容器宽度由 `WorkbenchShell` 用 `ResizeObserver` 实测，不读 `window.innerWidth`。

import type { PanelMode, PanelState } from "./types";

const KEY = "taskdock.transfer.panel.v1";
export const PANEL_WIDTH_MIN = 240;
export const PANEL_WIDTH_MAX = 900;
export const PANEL_WIDTH_DEFAULT = 320;

/**
 * 固定列所需的最小内容容器宽度。
 *
 * 导航 200 + 固定列 320 + 主内容可用宽度 → 1080 以下主内容会被挤到不可用，
 * 此时宁可抽屉覆盖，也不挤压主内容（与 `WINDOW_TIERS.compact` 同一档位）。
 */
export const PANEL_DOCK_MIN_WIDTH = 1080;

/** 面板宿主：主窗口只有抽屉；完整工作台才有固定列。 */
export type PanelHost = "main" | "workbench";

export interface PanelModeInput {
  host: PanelHost;
  pinned: boolean;
  /** 工作台内容容器实测宽度（CSS px）。 */
  availableWidth: number;
}

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
/** 形态订阅：形态是运行时推导值，不进 PanelState、不落盘。 */
const modeListeners = new Set<(mode: PanelMode) => void>();
let mode: PanelMode = "drawer";

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

export function getPanelMode(): PanelMode {
  return mode;
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

/** 记录当前窗口实际使用的形态（`WorkbenchShell` 实测后写入）。 */
export function setPanelMode(next: PanelMode): PanelMode {
  if (mode === next) return mode;
  mode = next;
  for (const listener of modeListeners) listener(mode);
  return mode;
}

export function restorePanelState(): PanelState {
  state = read();
  emit();
  return state;
}

/**
 * 形态判定（唯一实现，禁止各组件自行用窗口宽度判断）。
 *
 * - 主窗口：抽屉（没有工作台内容容器，固定列无处安放）。
 * - 工作台 + 取消固定：抽屉。
 * - 工作台 + 固定 + 容器宽度不足：抽屉。
 * - 工作台 + 固定 + 容器够宽：固定列。
 *
 * 兼容旧调用：只传宽度时按「工作台 + 固定」处理。
 */
export function resolvePanelMode(input: PanelModeInput | number, pinned = true): PanelMode {
  if (typeof input === "number") {
    return resolvePanelMode({ host: "workbench", pinned, availableWidth: input });
  }
  if (input.host !== "workbench") return "drawer";
  if (!input.pinned) return "drawer";
  return input.availableWidth >= PANEL_DOCK_MIN_WIDTH ? "dock" : "drawer";
}

export function subscribePanelState(listener: (next: PanelState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribePanelMode(listener: (next: PanelMode) => void): () => void {
  modeListeners.add(listener);
  return () => {
    modeListeners.delete(listener);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    state = read();
    emit();
  });
}
