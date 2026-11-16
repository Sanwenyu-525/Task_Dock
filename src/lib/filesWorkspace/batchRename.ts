//! 批量重命名的纯预览规则：前端预览与后端校验保持同一组硬约束（非法名、重复目标、已存在目标）。
//! 后端仍是权威：这里只决定预览状态，执行时 Rust 会再次校验并返回真实结果。

import { joinPath, parentOf } from "./pathUtils";

export type BatchRenameMode = "prefix" | "suffix" | "replace" | "delete" | "sequence" | "lower" | "upper";

export interface BatchRenameOptions {
  mode: BatchRenameMode;
  prefix: string;
  suffix: string;
  find: string;
  replace: string;
  start: number;
  digits: number;
  preserveExtension: boolean;
}

export type BatchRenameStatus = "ok" | "unchanged" | "invalid" | "conflict";

export interface BatchRenamePreviewItem {
  path: string;
  oldName: string;
  newName: string;
  target: string;
  status: BatchRenameStatus;
  reason?: string;
}

const RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

export function invalidRenameName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "名称不能为空";
  if (trimmed.length > 200) return "名称超过 200 字符";
  if (trimmed === "." || trimmed === "..") return "名称不能是 . 或 ..";
  if (/[\u0000-\u001f/\\:*?"<>|]/.test(name)) return "名称含非法字符";
  if (name.endsWith(".") || name.endsWith(" ")) return "名称不能以点或空格结尾";
  const stem = name.split(".")[0]?.toUpperCase() ?? "";
  if (RESERVED.has(stem)) return `名称是 Windows 保留名: ${stem}`;
  return null;
}

function applyMode(base: string, index: number, options: BatchRenameOptions): string {
  switch (options.mode) {
    case "prefix":
      return options.prefix + base;
    case "suffix":
      return base + options.suffix;
    case "replace":
      return options.find ? base.split(options.find).join(options.replace) : base;
    case "delete":
      return options.find ? base.split(options.find).join("") : base;
    case "sequence":
      return String(options.start + index).padStart(Math.max(1, options.digits), "0");
    case "lower":
      return base.toLocaleLowerCase();
    case "upper":
      return base.toLocaleUpperCase();
    default:
      return base;
  }
}

export function buildBatchRenamePreview(
  paths: string[],
  options: BatchRenameOptions,
  existingPaths: Iterable<string>,
): BatchRenamePreviewItem[] {
  const existing = new Map<string, string>();
  for (const path of existingPaths) existing.set(path.toLocaleLowerCase(), path);

  const initial = paths.map((path, index) => {
    const oldName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    const { stem, ext } = splitExtension(oldName);
    const source = options.preserveExtension ? stem : oldName;
    const renamed = applyMode(source, index, options);
    const newName = options.preserveExtension ? `${renamed}${ext}` : renamed;
    return {
      path,
      oldName,
      newName,
      target: joinPath(parentOf(path) ?? "", newName),
    };
  });

  const targetCounts = new Map<string, number>();
  for (const item of initial) {
    const key = item.target.toLocaleLowerCase();
    targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1);
  }

  return initial.map((item) => {
    const key = item.target.toLocaleLowerCase();
    const sourceKey = item.path.toLocaleLowerCase();
    const invalid = invalidRenameName(item.newName);
    if (invalid) return { ...item, status: "invalid", reason: invalid };
    if (key === sourceKey || item.newName === item.oldName) {
      return { ...item, status: "unchanged", reason: "名称未变化" };
    }
    if ((targetCounts.get(key) ?? 0) > 1) {
      return { ...item, status: "conflict", reason: "批量内目标名称重复" };
    }
    if (existing.has(key)) {
      return { ...item, status: "conflict", reason: "目标目录已存在同名条目" };
    }
    return { ...item, status: "ok" };
  });
}

export const DEFAULT_BATCH_RENAME_OPTIONS: BatchRenameOptions = {
  mode: "prefix",
  prefix: "Character_",
  suffix: "",
  find: "",
  replace: "",
  start: 1,
  digits: 3,
  preserveExtension: true,
};
