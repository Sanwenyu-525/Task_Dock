//! 原生目录选择（Windows 系统文件夹选择器）。
//!
//! 第三轮 P0：用户点「打开文件夹」必须能通过系统对话框浏览任意磁盘，而不是只能
//! 手输路径或点快捷位置。这里复用项目已接入的 `@tauri-apps/plugin-dialog`
//! （与 `DropTargetForm` / `ShelfWorkspace` 同一插件，不重复开发原生桥）。
//!
//! 失败与取消必须区分：
//! - 用户取消 → `cancelled`，**不得**改变当前标签或布局；
//! - 选中但目录已不存在/不是目录/无权限 → `invalid` + 明确原因，UI 提示且保持现状；
//! - 插件自身报错（非 Tauri 环境、IPC 失败）→ `invalid/error`，同样不改变现状。

import { open } from "@tauri-apps/plugin-dialog";

import { fsStat } from "../bridge";
import { normalizePath } from "./pathUtils";

export type PickFolderResult =
  | { status: "ok"; path: string }
  | { status: "cancelled" }
  | {
      status: "invalid";
      reason: "notFound" | "notDir" | "unreadable" | "error";
      path: string;
      message?: string;
    };

/** 打开系统文件夹选择器（`multiple:false`，只返回单个目录）。 */
export async function pickFolder(options: {
  title?: string;
  defaultPath?: string;
} = {}): Promise<PickFolderResult> {
  let selected: string | string[] | null;
  try {
    selected = await open({
      directory: true,
      multiple: false,
      title: options.title,
      defaultPath: options.defaultPath || undefined,
    });
  } catch (e) {
    return {
      status: "invalid",
      reason: "error",
      path: "",
      message: e instanceof Error ? e.message : String(e),
    };
  }
  const raw = Array.isArray(selected) ? selected[0] : selected;
  if (!raw) return { status: "cancelled" };
  return validateFolderPath(raw);
}

/** 校验用户选择/粘贴的目录是否可打开（存在、是目录、可读取）。 */
export async function validateFolderPath(rawPath: string): Promise<PickFolderResult> {
  const path = normalizePath(rawPath);
  if (!path) {
    return { status: "invalid", reason: "notFound", path: "" };
  }
  try {
    const [stat] = await fsStat([path]);
    if (!stat || !stat.exists || stat.kind === "missing") {
      return { status: "invalid", reason: "notFound", path };
    }
    if (stat.kind !== "dir") {
      return { status: "invalid", reason: "notDir", path };
    }
    return { status: "ok", path };
  } catch (e) {
    // 权限不足 / 网络盘不可达在 `fs_stat` 层以错误形式返回（不返回 exists:false），
    // 两者都要能被 UI 讲清楚，且都不能留下空白页面。
    return {
      status: "invalid",
      reason: "unreadable",
      path,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
