//! 贴边吸附 UI 状态（zustand）。
//!
//! `useEdgeSnap` 引擎是唯一写入方；`SnapOverlay`（候选提示 / 已吸附反馈 /
//! 隐藏触发条）与 `TitleBar`（停靠状态 + 解除吸附入口）是读取方。
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
  /** 引擎注入：明确操作解除吸附（标题栏按钮）。未启用为 null。 */
  undock: (() => void) | null;
  /** 引擎注入：从胶囊唤出（隐藏态点击）。未启用为 null。 */
  reveal: (() => void) | null;
  sync: (p: {
    phase: SnapPhase;
    candidateEdge: SnapEdge | null;
    magnetized: boolean;
    dockedEdge: SnapEdge | null;
  }) => void;
  notifyDocked: (edge: SnapEdge) => void;
  clearFeedback: () => void;
  setUndock: (fn: (() => void) | null) => void;
  setReveal: (fn: (() => void) | null) => void;
  reset: () => void;
}

export const useEdgeSnapStore = create<EdgeSnapUiState>((set) => ({
  phase: "free",
  candidateEdge: null,
  magnetized: false,
  dockedEdge: null,
  feedback: null,
  undock: null,
  reveal: null,
  sync: (p) => set(p),
  notifyDocked: (edge) => set({ feedback: { edge, seq: ++feedbackSeq } }),
  clearFeedback: () => set({ feedback: null }),
  setUndock: (fn) => set({ undock: fn }),
  setReveal: (fn) => set({ reveal: fn }),
  reset: () =>
    set({
      phase: "free",
      candidateEdge: null,
      magnetized: false,
      dockedEdge: null,
      feedback: null,
      undock: null,
      reveal: null,
    }),
}));
