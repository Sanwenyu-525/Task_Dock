/**
 * 项目工作目录校验（前端唯一入口）。
 *
 * 规则与 Rust `workspace_path_check` / `clean_root_path` 保持一致：
 * 空 → empty；非 Windows 绝对路径（盘符 `X:\` 或 UNC `\\`）→ invalid/not-absolute；
 * 去盘符后含 `<>:"|?*` 或控制字符 → invalid/illegal-char；文件系统事实（不存在 /
 * 不是目录 / 不可访问 / 可用）由后端返回。
 *
 * 不依赖剪贴板的 `clipboardPathStatus`：那条通道服务于剪贴板条目（ok/missing/
 * inaccessible），语义不同，不能拿来校验用户新建项目的工作目录。
 */

import { workspacePathCheck } from "./bridge";

export type WorkspacePathStatus =
  | { status: "empty" }
  | { status: "invalid"; reason: "not-absolute" | "illegal-char" }
  | { status: "offline"; path: string }
  | { status: "not-directory"; path: string }
  | { status: "inaccessible"; path: string }
  | { status: "ok"; path: string };

/** 盘符绝对路径：`C:\...` 或 `C:/...`（不接受 `C:foo` 这类盘符相对路径）。 */
const DRIVE_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
/** 控制字符与 Windows 目录名非法字符（盘符后的 `:` 同样非法）。 */
const ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f]/;

export async function checkWorkspacePath(raw: string): Promise<WorkspacePathStatus> {
  const text = raw.trim();
  if (!text) return { status: "empty" };
  if (!DRIVE_ABSOLUTE.test(text) && !text.startsWith("\\\\")) {
    return { status: "invalid", reason: "not-absolute" };
  }
  // 去盘符后再查非法字符：盘符后的 `:` 属于非法字符，`C:` 本身的冒号不算。
  const rest = /^[a-zA-Z]:/.test(text) ? text.slice(2) : text;
  if (ILLEGAL_CHARS.test(rest)) {
    return { status: "invalid", reason: "illegal-char" };
  }
  const result = await workspacePathCheck(text);
  switch (result.status) {
    case "ok":
    case "offline":
    case "not-directory":
    case "inaccessible":
      return { status: result.status, path: result.path ?? text };
    case "invalid":
      return {
        status: "invalid",
        reason: result.reason === "illegal-char" ? "illegal-char" : "not-absolute",
      };
    default:
      return { status: "empty" };
  }
}
