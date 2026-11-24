//! 统一项目上下文（ADR-0010）：把 WorkbenchShell 已有的项目根状态与方法
//! 暴露给路由页面的轻量消费契约。
//!
//! - Shell 仍是唯一的项目选择协调者（离开守卫、latest-wins 写入队列都在它那里）；
//! - Context 只做透传，**不复制第二份 selectedProjectId**、不新建 Store、
//!   不直接写 `workspace_active_project`；
//! - `projectId` 只能是 `workspace_projects.id`（项目根）；计划 ID、开发仓库 ID
//!   不属于本上下文（计划语义见 usePlanningStore，开发登记见 devProjects）；
//! - 缺 Provider 时明确抛错：页面禁止静默落到「虚假的默认项目」。

import { createContext, useContext, type ReactNode } from "react";
import type { WorkspaceProject } from "../lib/bridge";

export interface ProjectContextValue {
  /** 全局项目根 ID（`workspace_projects.id`）；null = 未选择（空态由页面处理）。 */
  projectId: string | null;
  /** 当前选中的项目根记录；`selectedProject.id === projectId` 由 Shell 保证。 */
  selectedProject: WorkspaceProject | null;
  projects: WorkspaceProject[];
  projectsLoading: boolean;
  projectsError: string | null;
  /**
   * 直通 Shell 的项目切换（含离开守卫与持久化），不绕过 latest-wins 队列。
   * 返回 true = 本次选择已真实落库（applied）且未被更新选择取代；
   * false = 正文守卫拒绝/保存失败、`workspace_active_project` 落库失败
   * （仅最后一次意图会回滚 UI 并提示），或已被更新选择取代（UI 归新选择，
   * 调用方不得再基于本次目标继续导航）。
   */
  selectProject: (projectId: string | null) => Promise<boolean>;
  /** 直通 Shell 的项目列表刷新（其他窗口删除项目后校验当前选择）。 */
  refreshProjects: () => Promise<WorkspaceProject[]>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectContextProvider({
  value,
  children,
}: {
  value: ProjectContextValue;
  children: ReactNode;
}) {
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProjectContext(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error(
      "useProjectContext 必须在 WorkbenchShell 的 ProjectContextProvider 内使用（ADR-0010）",
    );
  }
  return ctx;
}

/**
 * 可选读取项目上下文：给「可能不在 ProjectContextProvider 内」的浮层（如剪贴板抽屉）用。
 *
 * 返回 null 表示确实没有 Provider，调用方必须隐藏项目相关 UI；
 * **不得**把 null 当成「全部项目」或伪造默认项目（ADR-0010 禁止静默兜底）。
 */
export function useOptionalProjectContext(): ProjectContextValue | null {
  return useContext(ProjectContext);
}
