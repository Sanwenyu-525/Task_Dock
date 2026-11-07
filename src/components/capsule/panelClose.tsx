//! 工具面板「关闭」意图的轻量上下文。
//!
//! ## 为什么用 Context 而不是 prop
//! 五个面板组件目前都不接收 props（`CapsuleDock` 用 `ComponentType` 映射直接
//! `<Panel />`）。为一个关闭按钮给五个面板加 prop、再逐层透传到 `PanelHead`，
//! 改动面会扩散到所有面板实现；而关闭动作本来就属于「面板外壳」而不是面板业务。
//! 这里的作用域只有面板子树：`CapsuleDock` 提供、`PanelHead` 消费；脱离胶囊渲染
//!（单测、未来复用）时值为 `null`，`PanelHead` 不渲染关闭按钮。
//!
//! ## 关闭语义
//! 只有一个：调用 `CapsuleDock.closePanel`（→ `useEdgeSnapStore.collapse`）。
//! 不新增窗口隐藏、相位推进或动画状态机；分类、排序、停靠设置都不动。

import { createContext, useContext, type ReactNode } from "react";

const PanelCloseContext = createContext<(() => void) | null>(null);

export function PanelCloseProvider({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  return <PanelCloseContext.Provider value={onClose}>{children}</PanelCloseContext.Provider>;
}

/** 当前面板的关闭动作；不在胶囊工具面板内时为 null。 */
export function usePanelClose(): (() => void) | null {
  return useContext(PanelCloseContext);
}
