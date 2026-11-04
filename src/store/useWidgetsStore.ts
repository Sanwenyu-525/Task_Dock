//! 桌面微件布局 Store（zustand）。
//!
//! 只保存布局与展示配置，不缓存任务 / Agent / 提醒等业务数据——那些仍由各自
//! Store 或既有查询提供。所有变更立即写回存储适配器；未启用微件不挂载组件，
//! 因而不会产生额外订阅或轮询。

import { create } from "zustand";

import {
  defaultWidgetItems,
  moveWidgetBy,
  moveWidgetTo,
  normalizeConfig,
  withSequentialOrder,
  type WidgetConfig,
  type WidgetItem,
  type WidgetSize,
} from "../lib/widgets/model";
import { persistLayout, readStoredLayout } from "../lib/widgets/storage";

export interface WidgetsState {
  widgets: WidgetItem[];
  /** 是否已从持久化读取；面板挂载时调用 hydrate。 */
  hydrated: boolean;
  hydrate: () => void;
  toggle: (id: string, enabled?: boolean) => void;
  setSize: (id: string, size: WidgetSize) => void;
  setConfig: (id: string, patch: WidgetConfig) => void;
  moveTo: (id: string, toIndex: number) => void;
  moveBy: (id: string, delta: -1 | 1) => void;
  reset: () => void;
}

export const useWidgetsStore = create<WidgetsState>((set, get) => {
  /** 动作可能在面板 hydrate 之前触发，先补齐持久化布局。 */
  function ensureHydrated() {
    if (get().hydrated) return;
    set({
      widgets: readStoredLayout() ?? defaultWidgetItems(),
      hydrated: true,
    });
  }

  function commit(next: WidgetItem[]) {
    const ordered = withSequentialOrder(next);
    set({ widgets: ordered });
    persistLayout(ordered);
  }

  function updateItem(id: string, updater: (item: WidgetItem) => WidgetItem) {
    ensureHydrated();
    commit(get().widgets.map((item) => (item.widget_id === id ? updater(item) : item)));
  }

  return {
    widgets: defaultWidgetItems(),
    hydrated: false,

    hydrate: () => {
      if (get().hydrated) return;
      set({
        widgets: readStoredLayout() ?? defaultWidgetItems(),
        hydrated: true,
      });
    },

    toggle: (id, enabled) => {
      updateItem(id, (item) => ({
        ...item,
        enabled: typeof enabled === "boolean" ? enabled : !item.enabled,
      }));
    },

    setSize: (id, size) => {
      updateItem(id, (item) => ({ ...item, size }));
    },

    setConfig: (id, patch) => {
      updateItem(id, (item) => ({
        ...item,
        config: normalizeConfig(item.type, { ...item.config, ...patch }),
      }));
    },

    moveTo: (id, toIndex) => {
      ensureHydrated();
      commit(moveWidgetTo(get().widgets, id, toIndex));
    },

    moveBy: (id, delta) => {
      ensureHydrated();
      commit(moveWidgetBy(get().widgets, id, delta));
    },

    reset: () => {
      const next = defaultWidgetItems();
      set({ widgets: next, hydrated: true });
      persistLayout(next);
    },
  };
});
