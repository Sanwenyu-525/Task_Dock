//! 文件工作区内部拖拽协调（指针式，单例）。
//!
//! 两条明确区分的拖拽通道（任务规范 §6.3）：
//! - `tabs`：文件夹标签/窗格拖拽 → 落点是分栏边缘（创建分栏）或窗格中心（并入标签）；
//! - `files`：文件多选拖拽 → 落点是窗格中心/文件夹行（复制或移动）。
//!
//! 外部 OS 拖入不经过本模块（走 fileDrop.ts 仲裁 + data-drop-target 命中）；
//! 本模块只服务应用内拖拽，避免与 WebView2 原生拖放边界互相干扰。
//!
//! 语义（Windows 习惯）：Ctrl=复制、Shift=移动；默认同卷移动、跨卷复制，
//! 释放前 UI 恒显示当前效果，不得因落点判断错误执行非预期移动。

import { samePath, isSubPath, normalizePath } from "./pathUtils";

export type FwDragPayload =
  | { kind: "tabs"; tabIds: string[]; fromPaneId: string; paths: string[]; /** 整窗格拖拽（把手）：落点中心=并入标签并关闭源窗格 */ paneMove?: boolean }
  | { kind: "files"; paths: string[]; fromPaneId: string };

export type FwDropZone =
  | { type: "edge"; paneId: string; edge: "left" | "right" | "top" | "bottom" }
  | { type: "center"; paneId: string }
  | { type: "folder"; paneId: string; path: string }
  | { type: "tabbar"; paneId: string; index: number };

export type FwEffect = "copy" | "move" | "tab";

interface FwDragState {
  payload: FwDragPayload | null;
  x: number;
  y: number;
  effect: FwEffect;
  hover: FwDropZone | null;
}

type Listener = (state: FwDragState) => void;

const state: FwDragState = {
  payload: null,
  x: 0,
  y: 0,
  effect: "move",
  hover: null,
};

const listeners = new Set<Listener>();
let rafId = 0;

function emit(): void {
  const snapshot = { ...state, payload: state.payload ? { ...state.payload } : null };
  for (const fn of listeners) fn(snapshot);
}

/** 默认效果：同卷 → 移动，跨卷 → 复制（Windows 习惯）。 */
export function defaultEffect(paths: string[], targetDir: string): "copy" | "move" {
  const first = normalizePath(paths[0] ?? "");
  const driveOf = (p: string): string => {
    const m = /^([a-zA-Z]):/.exec(p);
    if (m) return m[1].toLowerCase();
    if (p.startsWith("\\\\")) {
      // UNC：server/share 前缀
      const parts = p.split("\\").filter(Boolean);
      return `unc:${parts[0] ?? ""}/${parts[1] ?? ""}`.toLowerCase();
    }
    return "?";
  };
  return driveOf(first) === driveOf(normalizePath(targetDir)) ? "move" : "copy";
}

/** 解析当前拖拽效果（Ctrl=复制、Shift=移动优先于默认）。 */
export function resolveEffect(
  payload: FwDragPayload,
  targetDir: string | null,
  modifiers: { ctrlKey?: boolean; shiftKey?: boolean },
): FwEffect {
  if (payload.kind === "tabs") return "tab";
  if (!targetDir) return defaultEffect(payload.paths, payload.paths[0] ?? "");
  if (modifiers.ctrlKey) return "copy";
  if (modifiers.shiftKey) return "move";
  return defaultEffect(payload.paths, targetDir);
}

/** 开始拖拽（pointerdown 后移动超过阈值时由组件调用）。 */
export function startFwDrag(payload: FwDragPayload, x: number, y: number): void {
  state.payload = payload;
  state.x = x;
  state.y = y;
  state.effect = payload.kind === "tabs" ? "tab" : "move";
  state.hover = null;
  emit();
}

/** 更新悬停落点（由窗格命中层调用）。 */
export function updateFwHover(zone: FwDropZone | null, modifiers: { ctrlKey?: boolean; shiftKey?: boolean }): void {
  if (!state.payload) return;
  state.hover = zone;
  const targetDir =
    zone?.type === "folder"
      ? zone.path
      : zone?.type === "center"
        ? null /* 由窗格当前目录判定，组件层传 */
        : null;
  state.effect = resolveEffect(state.payload, targetDir, modifiers);
  emit();
}

/** 结束拖拽并返回落点（组件在 pointerup 时取走 hover，再调用 finish）。 */
export function consumeFwHover(): FwDropZone | null {
  const hover = state.hover;
  return hover;
}

export function finishFwDrag(): void {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  state.payload = null;
  state.hover = null;
  emit();
}

export function getFwDragState(): FwDragState {
  return { ...state, payload: state.payload ? { ...state.payload } : null };
}

export function isFwDragging(): boolean {
  return state.payload !== null;
}

export function subscribeFwDrag(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 文件拖拽合法性：不能把目录拖进它自己的子树（后端还会兜底拒绝）。
 * 返回 null 表示不合法（目标应显示禁止）。
 */
export function validateFileDrop(
  paths: string[],
  targetDir: string,
): string | null {
  for (const p of paths) {
    const from = normalizePath(p);
    if (samePath(from, targetDir) || isSubPath(from, targetDir)) return null;
  }
  return targetDir;
}

/**
 * 应用内复制/剪切暂存（Ctrl+X/C/V）。
 * 刻意不触碰系统剪贴板：文件工作区的内部复制绝不覆盖用户已经复制的新内容
 * （任务规范 §9.2）；跨应用文件交换走暂存架与系统剪贴板既有链路。
 */
let fwClipboardValue: { mode: "copy" | "cut"; paths: string[] } | null = null;

export function getFwClipboard(): { mode: "copy" | "cut"; paths: string[] } | null {
  return fwClipboardValue;
}

export function setFwClipboard(value: { mode: "copy" | "cut"; paths: string[] } | null): void {
  fwClipboardValue = value;
}
