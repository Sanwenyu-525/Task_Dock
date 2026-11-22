//! 模式视图的延迟首次挂载容器。
//!
//! 三视图原本常驻挂载（CSS `display:none` 隐藏非当前项），以保留内容状态与滚动位置。
//! 该容器在既有语义之上加一条：**首次激活前不挂载**。
//! - 非当前模式在第一次激活前不渲染子树，启动只付当前模式的渲染与订阅成本；
//! - 一旦激活过就永久保留挂载（切回非当前模式也不卸载），
//!   因此滚动位置、输入框内容与局部组件状态与原常驻方案完全一致；
//! - 不改 CSS 结构（`.view-slot` / `active` 类仍由 App 控制），也不改变模式切换语义。
//!
//! 用「渲染期派生状态」而非 effect 置位：首次激活的那次渲染即同步挂载子树，
//! 避免切换模式后出现一帧空白。更新条件单调（active && !visited），只发生一次，不会循环。

import { useState, type ReactNode } from "react";

interface Props {
  active: boolean;
  children: ReactNode;
}

export default function DeferredView({ active, children }: Props) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  return visited ? <>{children}</> : null;
}
