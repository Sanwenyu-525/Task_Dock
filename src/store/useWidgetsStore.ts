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
  type WidgetDesktopState,
  type WidgetItem,
  type WidgetSize,
} from "../lib/widgets/model";
import { persistLayout, readStoredLayout, onLayoutReplaced } from "../lib/widgets/storage";

/**
 * 桌面窗口运行时状态（仅内存，不落盘）：配置期望与实际窗口必须分开呈现。
 *
 * - hidden：没有窗口（或已确认销毁）；
 * - creating：已发出创建命令，尚未确认成功；
 * - shown：**Rust `show_widget_window` 已返回成功，即系统窗口已创建并显示**。
 *   不承诺 WebView 页面首帧已渲染、业务数据已加载或内容无错误——这些由微件页面
 *   自身展示 loading / error；页面首个 snapshot 请求只说明 WebView 已挂载，
 *   不等于窗口已成功显示，不改变 phase。
 * - failed：创建/关闭/复位等窗口命令失败，错误信息在 `error`，可手动重试。
 */
export type WidgetDesktopPhase = "hidden" | "creating" | "shown" | "failed";

export interface WidgetDesktopRuntime {
  phase: WidgetDesktopPhase;
  error?: string;
}

export interface WidgetsState {
  widgets: WidgetItem[];
  /** 是否已从持久化读取；面板挂载时调用 hydrate。 */
  hydrated: boolean;
  /** 最近一次写盘失败的错误信息；成功后清空。 */
  persistError: string | null;
  /** 各微件桌面窗口的真实创建结果；`desktop.visible` 只是配置期望值。 */
  desktopRuntime: Record<string, WidgetDesktopRuntime>;
  setDesktopRuntime: (id: string, phase: WidgetDesktopPhase, error?: string) => void;
  hydrate: () => void;
  /**
   * 原子添加：启用看板卡片，可同时请求桌面显示，只落盘一次。
   * 返回是否成功写入存储；调用方必须据此决定是否提示成功。
   */
  addWidget: (id: string, options?: { desktop?: boolean }) => boolean;
  toggle: (id: string, enabled?: boolean) => void;
  setSize: (id: string, size: WidgetSize) => void;
  setConfig: (id: string, patch: WidgetConfig) => void;
  /** 合并桌面窗口配置（与 enabled 看板开关独立）。 */
  setDesktop: (id: string, patch: Partial<WidgetDesktopState>) => void;
  /** 清除已保存窗口位置（下次显示/重置时由后端按默认层叠位放置）。 */
  resetDesktopPosition: (id: string) => void;
  /**
   * 仅内存的位置重置计数（按 widget_id），不落盘。
   * `resetDesktopPosition` 只改配置、不移动窗口；主窗口桥接层据此调用 Rust 复位
   * 已打开的窗口，避免 UI 层直接发窗口命令。
   */
  desktopResetSeq: Record<string, number>;
  /** 仅内存的重试计数；创建失败后由管理页触发重新创建，不改变配置。 */
  desktopRetrySeq: Record<string, number>;
  retryDesktop: (id: string) => void;
  moveTo: (id: string, toIndex: number) => void;
  moveBy: (id: string, delta: -1 | 1) => void;
  /** 恢复默认并关闭桌面显示；返回是否成功写入存储。 */
  reset: () => boolean;
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

  function commit(next: WidgetItem[]): boolean {
    const ordered = withSequentialOrder(next);
    const ok = persistLayout(ordered);
    set({
      widgets: ordered,
      persistError: ok ? null : "布局保存失败，本次更改仅在当前会话有效",
    });
    return ok;
  }

  function updateItem(id: string, updater: (item: WidgetItem) => WidgetItem): boolean {
    ensureHydrated();
    return commit(get().widgets.map((item) => (item.widget_id === id ? updater(item) : item)));
  }

  return {
    widgets: defaultWidgetItems(),
    hydrated: false,
    persistError: null,
    desktopRuntime: {},
    desktopResetSeq: {},
    desktopRetrySeq: {},

    setDesktopRuntime: (id, phase, error) => {
      set((state) => ({
        desktopRuntime: {
          ...state.desktopRuntime,
          [id]: phase === "failed" && error ? { phase, error } : { phase },
        },
      }));
    },

    hydrate: () => {
      if (get().hydrated) return;
      set({
        widgets: readStoredLayout() ?? defaultWidgetItems(),
        hydrated: true,
      });
    },

    addWidget: (id, options) => {
      ensureHydrated();
      const target = get().widgets.find((item) => item.widget_id === id);
      if (!target) return false;
      // 已启用且无需打开桌面时没有状态变化，不重复写盘。
      if (target.enabled && !(options?.desktop && !target.desktop.visible)) return true;
      return commit(
        get().widgets.map((item) =>
          item.widget_id === id
            ? {
                ...item,
                enabled: true,
                desktop: options?.desktop
                  ? { ...item.desktop, visible: true }
                  : item.desktop,
              }
            : item,
        ),
      );
    },

    toggle: (id, enabled) => {
      updateItem(id, (item) => ({
        ...item,
        enabled: typeof enabled === "boolean" ? enabled : !item.enabled,
      }));
    },

    setSize: (id, size) => {
      // 选择预设即放弃手动缩放的自定义尺寸，保证切档立即生效。
      updateItem(id, (item) => ({
        ...item,
        size,
        desktop: { ...item.desktop, width: undefined, height: undefined },
      }));
    },

    setConfig: (id, patch) => {
      updateItem(id, (item) => ({
        ...item,
        config: normalizeConfig(item.type, { ...item.config, ...patch }),
      }));
    },

    setDesktop: (id, patch) => {
      updateItem(id, (item) => ({
        ...item,
        desktop: { ...item.desktop, ...patch },
      }));
    },

    resetDesktopPosition: (id) => {
      updateItem(id, (item) => ({
        ...item,
        desktop: {
          ...item.desktop,
          nx: undefined,
          ny: undefined,
          monitor: undefined,
        },
      }));
      set((state) => ({
        desktopResetSeq: {
          ...state.desktopResetSeq,
          [id]: (state.desktopResetSeq[id] ?? 0) + 1,
        },
      }));
    },

    retryDesktop: (id) => {
      set((state) => ({
        desktopRetrySeq: {
          ...state.desktopRetrySeq,
          [id]: (state.desktopRetrySeq[id] ?? 0) + 1,
        },
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
      // 恢复默认同时关闭桌面窗口并清除窗口位置/置顶偏好；管理页在按钮旁明确说明，
      // 避免用户以为只是重置看板顺序却被关掉桌面实例。
      const next = defaultWidgetItems();
      const ok = persistLayout(next);
      set({
        widgets: next,
        hydrated: true,
        persistError: ok ? null : "布局保存失败，本次更改仅在当前会话有效",
        desktopRuntime: {},
      });
      return ok;
    },
  };
});

// 恢复备份（或启动时从 preferences.json 补齐）会替换 localStorage 布局：
// 重新读取持久化结果，保证已挂载的面板立即展示恢复后的布局。
// 只订阅一次；不使用 persistLayout，避免把恢复值再触发一轮镜像回环。
onLayoutReplaced(() => {
  useWidgetsStore.setState({
    widgets: readStoredLayout() ?? defaultWidgetItems(),
    hydrated: true,
    persistError: null,
  });
});
