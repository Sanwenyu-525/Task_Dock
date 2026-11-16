//! 文件工作区内部拖拽协调（指针式，单例）。
//!
//! 两条明确区分的拖拽通道（任务规范 §6.3）：
//! - `tabs`：文件夹标签/窗格拖拽 → 落点是分栏边缘（四方向创建分栏）或窗格中心（并入标签）；
//! - `files`：文件多选拖拽 → 落点是窗格中心/文件夹行（复制或移动）。
//!
//! 外部 OS 拖入不经过本模块（走 fileDrop.ts 仲裁 + data-drop-target 命中）；
//! 本模块只服务应用内拖拽，避免与 WebView2 原生拖放边界互相干扰。
//!
//! 广播纪律（P0：事件重入与无限递归缺陷）：
//! - 订阅回调不得直接/间接再次调用 `startFwDrag`/`moveFwDrag`/`updateFwHover`
//!   的**变更路径**——本模块用「签名变更检测 + 重入延迟一拍」把递归转成迭代；
//! - 只有状态真正变化（坐标/落点/效果/载荷）才通知订阅者；
//! - 订阅回调里允许调用 `updateFwHover`（命中计算），签名不变时它不会再次广播。
//!
//! 语义（Windows 习惯）：Ctrl=复制、Shift=移动；默认同卷移动、跨卷复制，
//! 释放前 UI 恒显示当前效果，不得因落点判断错误执行非预期移动。

import { samePath, isSubPath, normalizePath } from "./pathUtils";

export type FwDragPayload =
  | { kind: "tabs"; tabIds: string[]; fromPaneId: string; paths: string[] }
  /** 布局编辑模式：拖动整个区域（落点中心 = 与该区域交换位置，不复制文件）。 */
  | { kind: "pane"; fromPaneId: string }
  | { kind: "files"; paths: string[]; fromPaneId: string };

export type FwDropZone =
  | { type: "edge"; paneId: string; edge: "left" | "right" | "top" | "bottom" }
  /** 窗格中心：dir 是该窗格当前目录（效果计算与合法性校验需要）。 */
  | { type: "center"; paneId: string; dir: string }
  | { type: "folder"; paneId: string; path: string }
  | { type: "tabbar"; paneId: string; index: number }
  /** 布局编辑模式：另一区域中心 = 交换两个区域（只换叶节点位置，不动标签）。 */
  | { type: "pane-swap"; paneId: string };

export type FwEffect = "copy" | "move" | "tab";

interface FwDragState {
  payload: FwDragPayload | null;
  x: number;
  y: number;
  effect: FwEffect;
  hover: FwDropZone | null;
  modifiers: { ctrlKey: boolean; shiftKey: boolean };
}

type Listener = (state: FwDragState) => void;

const state: FwDragState = {
  payload: null,
  x: 0,
  y: 0,
  effect: "move",
  hover: null,
  modifiers: { ctrlKey: false, shiftKey: false },
};

const listeners = new Set<Listener>();
let lastSig = "";
let emitting = false;
let emitPending = false;

function zoneSig(zone: FwDropZone | null): string {
  if (!zone) return "-";
  switch (zone.type) {
    case "edge":
      return `e:${zone.paneId}:${zone.edge}`;
    case "center":
      return `c:${zone.paneId}:${zone.dir}`;
    case "folder":
      return `f:${zone.paneId}:${zone.path}`;
    case "tabbar":
      return `t:${zone.paneId}:${zone.index}`;
    case "pane-swap":
      return `s:${zone.paneId}`;
  }
}

function signature(): string {
  const p = state.payload;
  const pSig = p
    ? p.kind === "tabs"
      ? `tabs:${p.fromPaneId}:${p.tabIds.join(",")}`
      : p.kind === "pane"
        ? `pane:${p.fromPaneId}`
        : `files:${p.fromPaneId}:${p.paths.join(",")}`
    : "none";
  return `${pSig}|${state.x}|${state.y}|${state.effect}|${zoneSig(state.hover)}|${state.modifiers.ctrlKey ? "c" : ""}${state.modifiers.shiftKey ? "s" : ""}`;
}

function emit(): void {
  const sig = signature();
  if (sig === lastSig) return;
  if (emitting) {
    emitPending = true;
    return;
  }
  emitting = true;
  lastSig = sig;
  try {
    const snapshot: FwDragState = {
      ...state,
      payload: state.payload ? { ...state.payload } : null,
      modifiers: { ...state.modifiers },
    };
    for (const fn of listeners) fn(snapshot);
  } finally {
    emitting = false;
  }
  if (emitPending) {
    emitPending = false;
    emit();
  }
}

/** 落点相等判断（组件层避免重复 setState 用）。 */
export function sameZone(a: FwDropZone | null, b: FwDropZone | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.type !== b.type || a.paneId !== b.paneId) return false;
  if (a.type === "edge" && b.type === "edge") return a.edge === b.edge;
  if (a.type === "center" && b.type === "center") return samePath(a.dir, b.dir);
  if (a.type === "folder" && b.type === "folder") return samePath(a.path, b.path);
  if (a.type === "tabbar" && b.type === "tabbar") return a.index === b.index;
  if (a.type === "pane-swap" && b.type === "pane-swap") return true;
  return false;
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

/** 效果解析（坐标/落点/修饰键由协调器持有，组件只读快照）。 */
export function resolveEffect(
  payload: FwDragPayload,
  targetDir: string | null,
  modifiers: { ctrlKey?: boolean; shiftKey?: boolean },
): FwEffect {
  // 标签与整区域拖拽都是「结构操作」，永远不产生复制/移动语义。
  if (payload.kind === "tabs" || payload.kind === "pane") return "tab";
  if (!targetDir) return defaultEffect(payload.paths, payload.paths[0] ?? "");
  if (modifiers.ctrlKey) return "copy";
  if (modifiers.shiftKey) return "move";
  return defaultEffect(payload.paths, targetDir);
}

function zoneTargetDir(zone: FwDropZone | null): string | null {
  if (zone?.type === "folder") return zone.path;
  if (zone?.type === "center") return zone.dir;
  return null;
}

/** 开始拖拽（pointerdown 后移动超过阈值时由组件调用）。 */
export function startFwDrag(
  payload: FwDragPayload,
  x: number,
  y: number,
  modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {},
): void {
  state.payload = payload;
  state.x = x;
  state.y = y;
  state.modifiers = { ctrlKey: Boolean(modifiers.ctrlKey), shiftKey: Boolean(modifiers.shiftKey) };
  state.hover = null;
  state.effect = payload.kind === "tabs" || payload.kind === "pane" ? "tab" : "move";
  emit();
}

/**
 * 拖拽中指针移动（组件 window pointermove 唯一入口）。
 * x/y 传 undefined 时保持原坐标（按键刷新修饰键用）。
 * P0 缺陷修复：旧实现坐标只在 startFwDrag 写入一次，hover 永远冻结在起点。
 */
export function moveFwDrag(
  x: number | undefined,
  y: number | undefined,
  modifiers: { ctrlKey?: boolean; shiftKey?: boolean } = {},
): void {
  if (!state.payload) return;
  if (x !== undefined) state.x = x;
  if (y !== undefined) state.y = y;
  state.modifiers = { ctrlKey: Boolean(modifiers.ctrlKey), shiftKey: Boolean(modifiers.shiftKey) };
  state.effect = resolveEffect(state.payload, zoneTargetDir(state.hover), state.modifiers);
  emit();
}

/** 更新悬停落点（窗格订阅回调按最新坐标计算后调用；签名不变不广播）。 */
export function updateFwHover(zone: FwDropZone | null): void {
  if (!state.payload) return;
  state.hover = zone;
  state.effect = resolveEffect(state.payload, zoneTargetDir(zone), state.modifiers);
  emit();
}

/** 结束拖拽（pointerup 落点已由组件取走后调用）。 */
export function finishFwDrag(): void {
  state.payload = null;
  state.hover = null;
  emit();
}

/** 取消拖拽（Escape / pointercancel / 窗口失焦 / 拖离窗口 / 组件卸载）。 */
export function cancelFwDrag(): void {
  if (!state.payload) return;
  finishFwDrag();
}

export function getFwDragState(): FwDragState {
  return {
    ...state,
    payload: state.payload ? { ...state.payload } : null,
    modifiers: { ...state.modifiers },
  };
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
  const target = normalizePath(targetDir);
  if (!target) return null;
  for (const p of paths) {
    const from = normalizePath(p);
    if (!from) return null;
    // 目标就是源自身 / 源位于目标内（拖进自己的子树）→ 拒绝。
    if (samePath(from, target) || isSubPath(from, target)) return null;
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
