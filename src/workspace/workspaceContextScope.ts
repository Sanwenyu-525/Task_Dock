//! 项目上下文渲染门控（P1-A，2026-11-13）。
//!
//! `useWorkspaceProjectContext` 用代次丢弃过期响应，但 React 的项目切换有**一帧**
//! 是「父组件已经拿到新的 selectedId，hook 的 state 还是上一个项目」——这一帧里
//! `context.items` / `context.links` 仍然属于 A。如果直接渲染，用户会看到 B 的标题
//! 配 A 的事项/任务，甚至能把 A 的按钮作用到 B 上。
//!
//! 因此渲染层只认「上下文项目 === 当前选中项目」的数据；不一致时按加载中处理，
//! 返回空集合与默认布局。写操作仍然由数据层按点击时的项目 ID 校验归属，
//! 本函数只负责「不展示旧项目的数据」，不替代后端权限校验。

import type { WorkspaceProjectContext } from "./useWorkspaceProjectContext";
import { defaultLayout, type WorkspaceProfile } from "./workspaceProfiles";

export function scopeWorkspaceContext(
  context: WorkspaceProjectContext,
  selectedId: string | null,
  profile: WorkspaceProfile,
): WorkspaceProjectContext {
  if (selectedId && context.projectId === selectedId) return context;
  return {
    ...context,
    // 对外声明「当前上下文就是选中项目」，但没有任何项目数据：渲染层不需要
    // 额外分支就能得到「加载中 / 空」的正确表现。
    projectId: selectedId,
    status: selectedId ? "loading" : "idle",
    error: null,
    items: [],
    links: [],
    instance: null,
    layout: defaultLayout(profile),
    layoutRepaired: false,
  };
}
