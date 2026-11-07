//! 功能生命周期 Store：批量状态快照 + 串行暂停/恢复操作。
//!
//! ## 单一事实源
//!
//! 用户意图不在这里保存一份：`setPaused` 通过 `useSettingsStore.update` 写入
//! 既有设置键（SQLite），操作完成后重新查询后端实际运行状态。这样完整页、
//! 胶囊、设置页与资源管理任意入口修改都会收敛到同一个值，不存在两套状态。
//!
//! ## 跨入口同步与代际保护
//!
//! - 设置 Store 中与生命周期相关的键一旦变化，快照立即标记 `stale` 并推进
//!   revision；不在这里自动发请求（由可见的消费者决定何时刷新，隐藏分区不查询）。
//! - `refresh()` 在响应返回时复核 revision：请求期间设置又变了，旧响应**不写入**，
//!   自动排一次新请求，避免「旧快照覆盖新意图」。
//! - 暂停/恢复按钮的意图永远从设置派生，不依赖可能过期的快照 `intent`。
//!
//! ## 并发与幂等
//!
//! - 同一模块的操作串行排队：快速连续点击只会按顺序执行，最后一次意图胜出；
//! - 不同模块互不阻塞（每个模块一条 Promise 链）；
//! - 状态查询单飞 + 排队合并；
//! - 写库成功但状态查询失败时返回 `unconfirmed`，不把「配置已更新」冒充成
//!   「资源已释放」；
//! - 没有轮询、没有全局定时器。

import { create } from "zustand";
import { lifecycleStatus, type ModuleRuntimeStatus, type Settings } from "../lib/bridge";
import { moduleControlPatch } from "../lib/lifecycle";
import { errorMessage } from "../lib/errors";
import { useSettingsStore } from "./useSettingsStore";

/** 暂停/恢复操作结果：ok=已确认；unconfirmed=配置已写入但运行状态未确认；failed=写入失败。 */
export type LifecycleActionResult = "ok" | "unconfirmed" | "failed";

export interface LifecycleSnapshot {
  statuses: ModuleRuntimeStatus[] | null;
  loading: boolean;
  error: string | null;
  /** 设置已变化、当前快照不再可信（消费者可见时应重查一次）。 */
  stale: boolean;
  /** 每模块操作中的忙碌标记（按钮 loading + disabled） */
  pending: Readonly<Record<string, boolean>>;
  /** 每模块最近一次操作失败原因；成功或开始新操作时清空 */
  errors: Readonly<Record<string, string | null>>;
  /** 配置已写入但运行状态查询失败；不得显示成暂停完成 */
  unconfirmed: Readonly<Record<string, boolean>>;
  /** 刷新快照；返回 true 表示这份结果已写入（未被更新的设置改写）。 */
  refresh: () => Promise<boolean>;
  /**
   * 请求暂停/恢复。未登记控制键的模块返回 failed，不伪造成功。
   */
  setPaused: (moduleId: string, paused: boolean) => Promise<LifecycleActionResult>;
}

/** 只有这些设置变化才影响生命周期快照。 */
const LIFECYCLE_SETTING_KEYS = [
  "clipboard_enabled",
  "clipboard_paused",
  "reminders_paused",
  "shelf_auto_cleanup_enabled",
  "actions_enabled",
  "actions_paused",
  "tts_enabled",
  "audio_sound_enabled",
] as const;

function lifecycleSettingsKey(settings: Settings | null): string {
  if (!settings) return "";
  return LIFECYCLE_SETTING_KEYS.map((key) => {
    const value = (settings as unknown as Record<string, unknown>)[key];
    return typeof value === "boolean" ? (value ? "1" : "0") : "";
  }).join("|");
}

let revision = 0;
let lastSettingsKey: string | null = null;
let inflight: Promise<boolean> | null = null;
let refreshQueued = false;
/** 每模块串行链：避免快速切换时旧操作覆盖新意图 */
const moduleChains = new Map<string, Promise<LifecycleActionResult>>();

/**
 * 设置变化 → 快照失效。
 *
 * 模块级订阅（全应用一条）：只比较生命周期相关键，主题/字号/窗口设置不会让
 * 快照失效。订阅本身不发 IPC；何时重查由可见消费者决定。
 */
useSettingsStore.subscribe((state) => {
  const key = lifecycleSettingsKey(state.settings);
  if (key === lastSettingsKey) return;
  lastSettingsKey = key;
  revision += 1;
  useLifecycleStore.setState({ stale: true });
});

export const useLifecycleStore = create<LifecycleSnapshot>((set, get) => ({
  statuses: null,
  loading: false,
  error: null,
  stale: true,
  pending: {},
  errors: {},
  unconfirmed: {},

  refresh: async () => {
    if (inflight) {
      refreshQueued = true;
      return inflight;
    }
    const startedAt = revision;
    set({ loading: true });
    inflight = (async () => {
      let applied = false;
      try {
        const statuses = await lifecycleStatus();
        // 空/非数组响应是契约破坏：保留旧快照并报错，不能显示成“全部模块已停止”。
        if (!Array.isArray(statuses)) throw new Error("生命周期状态响应无效");
        if (revision !== startedAt) {
          // 请求期间设置又变了：这份结果只代表旧意图，不能写入；排一次新请求。
          refreshQueued = true;
        } else {
          set({
            statuses,
            error: null,
            stale: false,
            // 新快照已经覆盖当前设置，之前“未确认”的模块重新有了事实依据。
            unconfirmed: {},
          });
          applied = true;
        }
      } catch (e) {
        set({ error: errorMessage(e), stale: true });
      } finally {
        set({ loading: false });
        inflight = null;
        if (refreshQueued) {
          refreshQueued = false;
          void get().refresh();
        }
      }
      return applied;
    })();
    return inflight;
  },

  setPaused: (moduleId, paused) => {
    const patch = moduleControlPatch(moduleId, paused);
    if (!patch) {
      set((s) => ({
        errors: { ...s.errors, [moduleId]: "该模块不支持独立暂停" },
      }));
      return Promise.resolve("failed");
    }
    const previous = moduleChains.get(moduleId) ?? Promise.resolve("ok");
    const task = previous
      .catch(() => "failed" as LifecycleActionResult)
      .then(async () => {
        set((s) => {
          const unconfirmed = { ...s.unconfirmed };
          delete unconfirmed[moduleId];
          return {
            pending: { ...s.pending, [moduleId]: true },
            errors: { ...s.errors, [moduleId]: null },
            unconfirmed,
          };
        });
        try {
          // 走设置写入队列：与设置页/胶囊的写入天然串行，意图不会被旧响应盖回。
          await useSettingsStore.getState().update(patch);
        } catch (e) {
          set((s) => {
            const pending = { ...s.pending };
            delete pending[moduleId];
            return {
              pending,
              errors: { ...s.errors, [moduleId]: errorMessage(e) },
            };
          });
          return "failed";
        }
        // 写库成功 ≠ 线程已退出：重新读取实际状态；旧响应由 revision 丢弃。
        const confirmed = await get().refresh();
        set((s) => {
          const pending = { ...s.pending };
          delete pending[moduleId];
          return {
            pending,
            unconfirmed: { ...s.unconfirmed, [moduleId]: !confirmed },
          };
        });
        return confirmed ? "ok" : "unconfirmed";
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
  revision = 0;
  lastSettingsKey = lifecycleSettingsKey(useSettingsStore.getState().settings);
  useLifecycleStore.setState({
    statuses: null,
    loading: false,
    error: null,
    stale: true,
    pending: {},
    errors: {},
    unconfirmed: {},
  });
}
