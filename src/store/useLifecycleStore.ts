//! 功能生命周期 Store：批量状态快照 + 串行暂停/恢复操作。
//!
//! ## 单一事实源
//!
//! 用户意图不在这里保存一份：`setPaused` 通过 `useSettingsStore.update` 写入
//! 既有设置键（SQLite），操作完成后重新查询后端实际运行状态。这样完整页、
//! 胶囊、设置页与资源管理任意入口修改都会收敛到同一个值，不存在两套状态。
//!
//! ## 并发与幂等
//!
//! - 同一模块的操作串行排队：快速连续点击只会按顺序执行，最后一次意图胜出；
//! - 不同模块互不阻塞（每个模块一条 Promise 链）；
//! - 状态查询单飞 + 排队合并：多个组件同时刷新只发一次 IPC；
//! - 请求失败保留上一份快照并记录错误，不把失败伪装成成功；
//! - 没有轮询、没有全局定时器；`pausing` 由后端探针如实返回。

import { create } from "zustand";
import { lifecycleStatus, type ModuleRuntimeStatus } from "../lib/bridge";
import { moduleControlPatch } from "../lib/lifecycle";
import { errorMessage } from "../lib/errors";
import { useSettingsStore } from "./useSettingsStore";

export interface LifecycleSnapshot {
  statuses: ModuleRuntimeStatus[] | null;
  loading: boolean;
  error: string | null;
  /** 每模块操作中的忙碌标记（按钮 loading + disabled） */
  pending: Readonly<Record<string, boolean>>;
  /** 每模块最近一次操作失败原因；成功或开始新操作时清空 */
  errors: Readonly<Record<string, string | null>>;
  refresh: () => Promise<void>;
  /**
   * 请求暂停/恢复。返回 false 表示操作失败（错误已写入 `errors[id]`）。
   * 未登记控制键的模块返回 false，不伪造成功。
   */
  setPaused: (moduleId: string, paused: boolean) => Promise<boolean>;
}

let inflight: Promise<void> | null = null;
let refreshQueued = false;
/** 每模块串行链：避免快速切换时旧操作覆盖新意图 */
const moduleChains = new Map<string, Promise<boolean>>();

export const useLifecycleStore = create<LifecycleSnapshot>((set, get) => ({
  statuses: null,
  loading: false,
  error: null,
  pending: {},
  errors: {},

  refresh: async () => {
    if (inflight) {
      refreshQueued = true;
      return inflight;
    }
    set({ loading: true });
    inflight = (async () => {
      try {
        const statuses = await lifecycleStatus();
        // 空/非数组响应是契约破坏：保留旧快照并报错，不能显示成“全部模块已停止”。
        if (!Array.isArray(statuses)) throw new Error("生命周期状态响应无效");
        set({ statuses, error: null });
      } catch (e) {
        set({ error: errorMessage(e) });
      } finally {
        set({ loading: false });
        inflight = null;
        if (refreshQueued) {
          refreshQueued = false;
          void get().refresh();
        }
      }
    })();
    return inflight;
  },

  setPaused: (moduleId, paused) => {
    const patch = moduleControlPatch(moduleId, paused);
    if (!patch) {
      set((s) => ({
        errors: { ...s.errors, [moduleId]: "该模块不支持独立暂停" },
      }));
      return Promise.resolve(false);
    }
    const previous = moduleChains.get(moduleId) ?? Promise.resolve(true);
    const task = previous
      .catch(() => false)
      .then(async () => {
        set((s) => ({
          pending: { ...s.pending, [moduleId]: true },
          errors: { ...s.errors, [moduleId]: null },
        }));
        try {
          // 走设置写入队列：与设置页/胶囊的写入天然串行，意图不会被旧响应盖回。
          await useSettingsStore.getState().update(patch);
          set((s) => {
            const pending = { ...s.pending };
            delete pending[moduleId];
            return { pending };
          });
          // 写库成功不等于线程已退出：重新读取实际状态，pausing 会如实保留。
          await get().refresh();
          return true;
        } catch (e) {
          set((s) => {
            const pending = { ...s.pending };
            delete pending[moduleId];
            return {
              pending,
              errors: { ...s.errors, [moduleId]: errorMessage(e) },
            };
          });
          return false;
        }
      });
    moduleChains.set(moduleId, task);
    return task;
  },
}));

/** 测试辅助：清空模块级串行链与在途状态（不影响设置 Store）。 */
export function resetLifecycleStoreForTest(): void {
  moduleChains.clear();
  inflight = null;
  refreshQueued = false;
  useLifecycleStore.setState({
    statuses: null,
    loading: false,
    error: null,
    pending: {},
    errors: {},
  });
}
