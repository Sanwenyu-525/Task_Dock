//! 游戏线共享纯函数（G1，2026-11-16）。

import type { WorkspaceItem, WorkspaceItemStatus } from "../../../lib/bridge";
import { categoryLabel, type GameItemCategory } from "./types";

const ITEM_STATUS_LABELS: Record<WorkspaceItemStatus, string> = {
  todo: "待办",
  doing: "进行中",
  blocked: "阻塞",
  done: "完成",
  archived: "已归档",
};

export function itemStatusLabel(status: string): string {
  return ITEM_STATUS_LABELS[status as WorkspaceItemStatus] ?? status;
}

/** 从事项 metadataJson 解析分类；损坏/缺失时归为未分类。 */
export function itemCategory(item: WorkspaceItem): GameItemCategory | "unknown" {
  if (!item.metadataJson) return "unknown";
  try {
    const parsed: unknown = JSON.parse(item.metadataJson);
    if (parsed && typeof parsed === "object" && "category" in parsed) {
      const value = (parsed as { category: unknown }).category;
      if (typeof value === "string") return value as GameItemCategory;
    }
  } catch {
    // 元数据损坏不阻断事项展示。
  }
  return "unknown";
}

export function itemCategoryLabel(item: WorkspaceItem): string {
  return categoryLabel(itemCategory(item));
}

export function formatSize(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
