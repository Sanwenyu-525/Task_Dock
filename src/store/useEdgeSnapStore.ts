//! 贴边吸附 UI 状态（zustand）。
//!
//! `useEdgeSnap` 引擎是唯一写入方；`CapsuleDock` / `SnapOverlay` 是读取方。
//! 解除吸附由引擎的拖离手势与胶囊收起按钮承担。
//! 引擎未启用（snap_enabled=false 或设置未加载）时保持初始值：
//! phase=free、无停靠边、无操作入口 —— UI 层自然全部隐藏。

import { create } from "zustand";
import type { SnapEdge, SnapPhase } from "../lib/edgeSnap";

let feedbackSeq = 0;

export interface EdgeSnapUiState {
  phase: SnapPhase;
  /** candidate 相位下的候选边（提示「松开吸附 X 侧」） */
  candidateEdge: SnapEdge | null;
  /** candidate 是否处于磁吸区（≤进入阈值；28–42 滞回带内为预览态） */
  magnetized: boolean;
  /** 停靠边（docked-* 相位下非空） */
  dockedEdge: SnapEdge | null;
  /** 「已吸附 X 侧」反馈；seq 递增使同一 edge 的重复停靠也能重新触发 */
  feedback: { edge: SnapEdge; seq: number } | null;
  /** 引擎注入：展开功能面板（折叠态点击分类 / 托盘唤回）。未启用为 null。 */
  reveal: (() => void) | null;
  /** 引擎注入：收起功能面板（Esc / 收起按钮 / 再次点击当前分类）。 */
  collapse: (() => void) | null;
  /** 引擎注入：解除吸附并恢复普通窗口；可选指定目标模式（跳转完整页时用）。 */
  undock: ((mode?: string) => void) | null;
  sync: (p: {
    phase: SnapPhase;
    candidateEdge: SnapEdge | null;
    magnetized: boolean;
    dockedEdge: SnapEdge | null;
  }) => void;
  notifyDocked: (edge: SnapEdge) => void;
  clearFeedback: () => void;
  setReveal: (fn: (() => void) | null) => void;
  setCollapse: (fn: (() => void) | null) => void;
  setUndock: (fn: ((mode?: string) => void) | null) => void;
  reset: () => void;
}

export const useEdgeSnapStore = create<EdgeSnapUiState>((set) => ({
  phase: "free",
  candidateEdge: null,
  magnetized: false,
  dockedEdge: null,
  feedback: null,
  reveal: null,
  collapse: null,
  undock: null,
  sync: (p) => set(p),
  notifyDocked: (edge) => set({ feedback: { edge, seq: ++feedbackSeq } }),
  clearFeedback: () => set({ feedback: null }),
  setReveal: (fn) => set({ reveal: fn }),
  setCollapse: (fn) => set({ collapse: fn }),
  setUndock: (fn) => set({ undock: fn }),
  reset: () =>
    set({
      phase: "free",
      candidateEdge: null,
      magnetized: false,
      dockedEdge: null,
      feedback: null,
      reveal: null,
      collapse: null,
      undock: null,
    }),
}));
