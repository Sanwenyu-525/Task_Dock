//! 微件布局持久化。
//!
//! 第一版使用 WebView 本地存储（键 taskdock.widgets.layout.v1），避免在共享的
//! 设置表 / 迁移文件里越权改动。集成会话分配正式设置键或迁移版本后，可通过
//! setWidgetStorageAdapter 换成 SQLite 设置读写，Store 与组件无需改动。
//! 持久化只保存布局（enabled / config / size / sort_order），不保存业务数据。

import { normalizeLayout, type WidgetItem } from "./model";

export const WIDGETS_STORAGE_KEY = "taskdock.widgets.layout.v1";
const LAYOUT_VERSION = 1;

export interface WidgetStorageAdapter {
  /** 返回已解析的 JSON（通常为 { version, widgets }），读取失败可抛出。 */
  read: () => unknown;
  /** 写入完整布局。 */
  write: (widgets: WidgetItem[]) => void;
}

function createLocalAdapter(): WidgetStorageAdapter | null {
  if (typeof window === "undefined") return null;
  try {
    const storage = window.localStorage;
    if (!storage) return null;
    return {
      read: () => {
        const raw = storage.getItem(WIDGETS_STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw) as unknown;
      },
      write: (widgets) => {
        storage.setItem(
          WIDGETS_STORAGE_KEY,
          JSON.stringify({ version: LAYOUT_VERSION, widgets }),
        );
      },
    };
  } catch {
    // 存储被禁用（隐私模式 / 权限异常）时退化为仅内存布局。
    return null;
  }
}

let adapter: WidgetStorageAdapter | null = null;

/** 集成会话可注入 SQLite 设置适配器；传 null 恢复默认本地存储。 */
export function setWidgetStorageAdapter(next: WidgetStorageAdapter | null): void {
  adapter = next;
}

export function readStoredLayout(): WidgetItem[] | null {
  const active = adapter ?? createLocalAdapter();
  if (!active) return null;
  try {
    const parsed = active.read();
    if (parsed === null || parsed === undefined) return null;
    const widgets =
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      (parsed as { version?: unknown }).version !== LAYOUT_VERSION
        ? null
        : parsed;
    if (!widgets) return null;
    if (typeof widgets === "object" && widgets !== null && "widgets" in widgets) {
      return normalizeLayout((widgets as { widgets: unknown }).widgets);
    }
    return normalizeLayout(widgets);
  } catch {
    // 损坏 JSON / 存储异常：回落到默认布局，不阻塞面板。
    return null;
  }
}

export function persistLayout(widgets: WidgetItem[]): void {
  const active = adapter ?? createLocalAdapter();
  if (!active) return;
  try {
    active.write(widgets);
  } catch {
    // 写入失败只影响持久化，不影响当前交互。
  }
}
