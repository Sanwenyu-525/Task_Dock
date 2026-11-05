//! 微件布局持久化。
//!
//! 第一版使用 WebView 本地存储（键 taskdock.widgets.layout.v1），避免在共享的
//! 设置表 / 迁移文件里越权改动。集成会话分配正式设置键或迁移版本后，可通过
//! setWidgetStorageAdapter 换成 SQLite 设置读写，Store 与组件无需改动。
//! 持久化只保存布局（enabled / config / size / sort_order），不保存业务数据。

import { normalizeLayout, type WidgetItem } from "./model";
import {
  WIDGETS_STORAGE_KEY,
  onWidgetsLayoutApplied,
  schedulePreferencesMirror,
} from "../userPreferences";

// 存储键与镜像逻辑统一放在 userPreferences，避免语言/微件各维护一份常量。
export { WIDGETS_STORAGE_KEY };
/** 恢复流程替换 localStorage 布局后通知 Store 重新读取（同一事件只订阅一次）。 */
export const onLayoutReplaced = onWidgetsLayoutApplied;
/**
 * 布局版本保持 1：`desktop` 字段是对 v1 的**增量扩展**，旧版本读取时忽略未知字段、
 * 新版本读取旧数据时由 normalizeLayout 补齐安全默认，双向可读。只有破坏性字段
 * 变更（例如把 widgets 数组改成对象）才允许升版本并在此处加迁移分支。
 */
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

/**
 * 写回完整布局。返回是否真正写入：失败时 Store 会暴露 `persistError`，
 * 管理页明确提示「仅本次会话有效」，不静默假装已保存。
 */
export function persistLayout(widgets: WidgetItem[]): boolean {
  const active = adapter ?? createLocalAdapter();
  if (!active) return false;
  try {
    active.write(widgets);
    // 防抖镜像到数据目录 preferences.json，供备份/恢复使用。
    schedulePreferencesMirror();
    return true;
  } catch {
    return false;
  }
}
