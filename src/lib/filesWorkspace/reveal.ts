//! 跨模块「在文件工作区打开」的唯一入口。
//!
//! 为什么要有这一层：资源管理、工作篮、Agent 都希望「把这个路径交给文件工作区」，
//! 但各自实现会分裂成多套导航语义（有的只开目录、有的切页、有的写第二份选择状态）。
//! 这里只做三件事：在**活动窗格**新开标签、可选选中某个条目、切到文件页；
//! 目录内容、缓存与刷新仍全部由 `useFilesWorkspaceStore` / `dirCache` 负责。
//!
//! 不静态 import `FilesWorkspacePanel`：那个模块是重页（按需加载），从资源管理页
//! 直接 import 会把整页代码拉进首屏 chunk。

import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";import { useUiStore } from "../../store/useUiStore";
import { parentOf } from "./pathUtils";

export type RevealFailure = "open-failed" | "tab-pending" | "tab-blocked";

export interface RevealResult {
  ok: boolean;
  reason?: RevealFailure;
}

function activateFilesPage(): RevealResult {
  const result = useUiStore.getState().setTab("files");
  if (result === "switched") return { ok: true };
  // pending：已弹出未保存确认条，等用户确认；blocked：路由拒绝。
  return { ok: false, reason: result === "pending" ? "tab-pending" : "tab-blocked" };
}

/** 在活动窗格打开目录（新标签），并按需切到文件页。 */
export function openDirInFilesWorkspace(dirPath: string, activate = true): RevealResult {
  if (!dirPath) return { ok: false, reason: "open-failed" };
  const store = useFilesWorkspaceStore.getState();
  if (!store.openPathInActive(dirPath, "newTab")) {
    return { ok: false, reason: "open-failed" };
  }
  return activate ? activateFilesPage() : { ok: true };
}

/** 定位文件：打开其父目录并选中该条目（不读取文件内容）。 */
export function revealFileInFilesWorkspace(filePath: string, activate = true): RevealResult {
  if (!filePath) return { ok: false, reason: "open-failed" };
  const dirPath = parentOf(filePath);
  if (!dirPath) return { ok: false, reason: "open-failed" };
  const store = useFilesWorkspaceStore.getState();
  if (!store.openPathInActive(dirPath, "newTab")) {
    return { ok: false, reason: "open-failed" };
  }
  const active = useFilesWorkspaceStore.getState().activePaneId;
  useFilesWorkspaceStore.getState().setSelection(active, [filePath]);
  return activate ? activateFilesPage() : { ok: true };
}
