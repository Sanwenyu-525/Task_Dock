//! 贴边吸附 UI 状态（zustand）。
//!
//! `useEdgeSnap` 引擎是唯一写入方；`CapsuleDock` / `SnapOverlay` 是读取方。
//! 解除吸附由引擎的拖离手势与胶囊收起按钮承担。
//! 引擎未启用（snap_enabled=false 或设置未加载）时保持初始值：
//! phase=free、无停靠边、无操作入口 —— UI 层自然全部隐藏。

import { create } from "zustand";
import type { DockForm, SnapEdge, SnapPhase } from "../lib/edgeSnap";

let feedbackSeq = 0;

export interface EdgeSnapUiState {
  phase: SnapPhase;
  /** candidate 相位下的候选边（提示「松开吸附 X 侧」） */
  candidateEdge: SnapEdge | null;
  /** candidate 是否处于磁吸区（≤进入阈值；28–42 滞回带内为预览态） */
  magnetized: boolean;
  /** 停靠边（docked-* 相位下非空） */
  dockedEdge: SnapEdge | null;
  /**
   * 原生区域是否与 UI 相位失准（写入/回读失败且校准也失败）。
   * 为 true 时引擎不会推进相位、不进入 free，按有界退避重试校准；
   * 这是一条诊断/兜底状态，正常情况下恒为 false。
   */
  regionUnsynced: boolean;
  /** 「已吸附 X 侧」反馈；seq 递增使同一 edge 的重复停靠也能重新触发 */
  feedback: { edge: SnapEdge; seq: number } | null;
  /** 引擎注入：展开功能面板（折叠态点击分类 / 托盘唤回）。未启用为 null。 */
  reveal: (() => void) | null;
  /** 引擎注入：收起功能面板（Esc / 收起按钮 / 再次点击当前分类）。 */
  collapse: (() => void) | null;
  /** 引擎注入：解除吸附并恢复普通窗口；可选指定目标模式（跳转完整页时用）。 */
  undock: ((mode?: string) => void) | null;
  /**
   * 引擎注入：**本次停靠会话**的临时形态切换（不改写持久化 `snap_display_mode`；
   * 解除停靠后失效，下次吸附按设置里的默认吸附方式）。供胶囊轨道与完整面板上的
   * 轻量入口复用。长期偏好仍由设置页 / 右键菜单更新。未启用为 null。
   */
  formSwitch: ((form: DockForm) => void) | null;
  /** 引擎注入：胶囊收起为 Edge Tab（带侧滑收纳动画）。未启用为 null。 */
  collapseToTab: (() => void) | null;
  /**
   * 引擎注入：Edge Tab 恢复为胶囊轨道（复用同一套过渡）。未启用为 null。
   * `reveal: true` 时在同一串行事务内继续展开功能面板（先恢复、后展开），
   * 不靠固定延迟拼接两段状态机。
   */
  restoreTab: ((opts?: { reveal?: boolean }) => void) | null;
  // Edge Tab 拖动：只改沿边位置，不切形态；向屏幕内部拖动由组件在松手时判定恢复。
  beginTabDrag: (() => void) | null;
  dragTabBy: ((deltaCss: number) => void) | null;
  endTabDrag: (() => void) | null;
  /** 动画中的过渡态（仅 UI 用；稳定形态仍以 phase 为准）。 */
  tabTransition: "to-tab" | "from-tab" | null;
  /**
   * 功能面板离场（仅 UI 用）：收起为标签时，面板先自然收合再切区域。
   * 为 true 期间即使相位已不在 `docked-revealed`，面板仍保持挂载并播放离场。
   */
  panelExiting: boolean;
  sync: (p: {
    phase: SnapPhase;
    candidateEdge: SnapEdge | null;
    magnetized: boolean;
    dockedEdge: SnapEdge | null;
  }) => void;
  notifyDocked: (edge: SnapEdge) => void;
  setRegionUnsynced: (v: boolean) => void;
  clearFeedback: () => void;
  setReveal: (fn: (() => void) | null) => void;
  setCollapse: (fn: (() => void) | null) => void;
  setUndock: (fn: ((mode?: string) => void) | null) => void;
  setFormSwitch: (fn: ((form: DockForm) => void) | null) => void;
  setTabActions: (p: {
    collapse: (() => void) | null;
    restore: ((opts?: { reveal?: boolean }) => void) | null;
    beginDrag: (() => void) | null;
    dragBy: ((deltaCss: number) => void) | null;
    endDrag: (() => void) | null;
  }) => void;
  setTabTransition: (v: "to-tab" | "from-tab" | null) => void;
  setPanelExiting: (v: boolean) => void;
  reset: () => void;
}

export const useEdgeSnapStore = create<EdgeSnapUiState>((set) => ({
  phase: "free",
  candidateEdge: null,
  magnetized: false,
  dockedEdge: null,
  regionUnsynced: false,
  feedback: null,
  reveal: null,
  collapse: null,
  undock: null,
  formSwitch: null,
  collapseToTab: null,
  restoreTab: null,
  beginTabDrag: null,
  dragTabBy: null,
  endTabDrag: null,
  tabTransition: null,
  panelExiting: false,
  sync: (p) => set(p),
  notifyDocked: (edge) => set({ feedback: { edge, seq: ++feedbackSeq } }),
  setRegionUnsynced: (v) => set({ regionUnsynced: v }),
  clearFeedback: () => set({ feedback: null }),
  setReveal: (fn) => set({ reveal: fn }),
  setCollapse: (fn) => set({ collapse: fn }),
  setUndock: (fn) => set({ undock: fn }),
  setFormSwitch: (fn) => set({ formSwitch: fn }),
  setTabActions: (p) =>
    set({
      collapseToTab: p.collapse,
      restoreTab: p.restore,
      beginTabDrag: p.beginDrag,
      dragTabBy: p.dragBy,
      endTabDrag: p.endDrag,
    }),
  setTabTransition: (v) => set({ tabTransition: v }),
  setPanelExiting: (v) => set({ panelExiting: v }),
  reset: () =>
    set({
      phase: "free",
      candidateEdge: null,
      magnetized: false,
      dockedEdge: null,
      regionUnsynced: false,
      feedback: null,
      reveal: null,
      collapse: null,
      undock: null,
      formSwitch: null,
      collapseToTab: null,
      restoreTab: null,
      beginTabDrag: null,
      dragTabBy: null,
      endTabDrag: null,
      tabTransition: null,
      panelExiting: false,
    }),
}));
