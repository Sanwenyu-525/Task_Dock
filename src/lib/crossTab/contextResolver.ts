//! 上下文识别：当前模块 / 项目 / 任务 / 目录。
//!
//! 上下文只用于「推荐目标」，**不决定写入位置**：发送前必须显式选择目标，
//! 由 `TransferTarget` 传给后端。切换 Tab 不会擅自改变文件的保存目录。

import { getContext, updateContext } from "./transferClient";
import type { TransferContext } from "./types";

const WINDOW_TAG = "workspace";

/** 页面进入时登记模块上下文；离开时可保留（用户切回仍能看到上次位置）。 */
export async function enterModule(module: string): Promise<TransferContext> {
  return updateContext({ module, window: WINDOW_TAG });
}

export async function setCurrentDirectory(directory: string | null): Promise<TransferContext> {
  return updateContext({ directory: directory ?? "" });
}

export async function setProject(projectId: string | null): Promise<TransferContext> {
  return updateContext({ projectId: projectId ?? "" });
}

export async function setTask(taskId: string | null): Promise<TransferContext> {
  return updateContext({ taskId: taskId ?? "" });
}

export async function getCurrentContext(): Promise<TransferContext> {
  return getContext();
}

export function contextLabel(
  context: TransferContext,
  names?: { project?: string; task?: string },
): string {
  if (names?.task) return names.task;
  if (names?.project) return names.project;
  if (context.projectId) return `项目 ${context.projectId.slice(0, 8)}`;
  if (context.taskId) return `任务 ${context.taskId.slice(0, 8)}`;
  if (context.directory) {
    const parts = context.directory.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? context.directory;
  }
  return "";
}
