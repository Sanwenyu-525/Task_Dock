//! 上下文识别：当前模块 / 项目 / 任务 / 目录 / 规划 / 知识条目。
//!
//! 上下文只用于「推荐目标」，**不决定写入位置**：发送前必须显式选择目标，
//! 由 `TransferTarget` 传给后端。切换 Tab 不会擅自改变文件的保存目录。
//!
//! 窗口隔离：后端按窗口 label 各存一份（`transfer::context::ContextState`），
//! 本模块只做「当前窗口是谁」的登记与字段便捷写入口，不做第二份状态。

import { getCurrentWindow } from "@tauri-apps/api/window";
import { getContext, updateContext } from "./transferClient";
import type { TransferContext } from "./types";

/** 非 Tauri 环境（测试 / 浏览器预览）的窗口标识。 */
const FALLBACK_WINDOW = "workspace";

let cachedLabel: string | null = null;

/** 当前窗口 label（`main` / `workspace` / …）；读取失败退回固定标识。 */
export async function currentWindowLabel(): Promise<string> {
  if (cachedLabel) return cachedLabel;
  try {
    cachedLabel = getCurrentWindow().label || FALLBACK_WINDOW;
  } catch {
    cachedLabel = FALLBACK_WINDOW;
  }
  return cachedLabel;
}

/** 仅供测试重置缓存的窗口 label。 */
export function resetWindowLabelForTests(): void {
  cachedLabel = null;
}

async function patch(fields: Partial<TransferContext>): Promise<TransferContext> {
  const window = await currentWindowLabel();
  return updateContext({ ...fields, window });
}

/** 页面进入时登记模块上下文；离开时可保留（用户切回仍能看到上次位置）。 */
export async function enterModule(module: string): Promise<TransferContext> {
  return patch({ module });
}

export async function setCurrentDirectory(directory: string | null): Promise<TransferContext> {
  return patch({ directory: directory ?? "" });
}

export async function setProject(projectId: string | null): Promise<TransferContext> {
  return patch({ projectId: projectId ?? "" });
}

export async function setTask(taskId: string | null): Promise<TransferContext> {
  return patch({ taskId: taskId ?? "" });
}

export async function setPlanning(planningId: string | null): Promise<TransferContext> {
  return patch({ planningId: planningId ?? "" });
}

export async function setKnowledge(knowledgeId: string | null): Promise<TransferContext> {
  return patch({ knowledgeId: knowledgeId ?? "" });
}

export async function setCapture(captureId: string | null): Promise<TransferContext> {
  return patch({ captureId: captureId ?? "" });
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
