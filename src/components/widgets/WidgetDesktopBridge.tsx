//! 主窗口侧桌面微件协调器（唯一数据所有者与布局写入方）。
//!
//! 职责边界：
//! - 不重写业务：任务/Agent/提醒/专注/效率全部读取既有 Store / 数据源；
//! - 今天任务走独立后端筛选（今日到期 + 已逾期），不依赖任务页筛选/排序/分页；
//! - 不新增扫描器：Agent 只用已有快照，提醒只在「提醒微件窗口确实打开」时读取；
//! - 窗口按布局惰性创建，关闭即销毁；同一类型的窗口命令串行执行，避免快速切换产生
//!   幽灵窗口或旧异步覆盖新意图；
//! - 微件窗口上报的几何只在这里落盘（已由窗口侧 debounce），不会每帧写盘；
//! - Zustand 不跨 WebView：这里把快照带 revision 推给对应窗口，窗口只读。

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";

import {
  activeReminders,
  fetchTask,
  listTasks,
  onReminderFired,
  onReminderSnoozed,
  type ActiveReminder,
  type Task,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { useLocale } from "../../hooks/useLocale";
import { WIDGET_SOURCES } from "./liveSources";
import {
  classifyWidgetDismissal,
  type DesktopWidgetSnapshot,
  type TodayTasksSnapshot,
  type WidgetDismissReason,
} from "../../lib/widgets/desktop";
import {
  desktopFromWindowInfo,
  hideWidgetWindow,
  onWidgetAction,
  onWidgetBounds,
  onWidgetDismissed,
  onWidgetSnapshotRequest,
  publishWidgetSnapshot,
  resetWidgetPosition,
  showWidgetWindow,
} from "../../lib/widgets/desktopBridge";
import {
  resolveDesktopWindowSize,
  type WidgetDesktopState,
  type WidgetItem,
  type WidgetType,
} from "../../lib/widgets/model";
import { useAgentsStore } from "../../store/useAgentsStore";
import { useTasksStore } from "../../store/useTasksStore";
import { useUiStore, type Tab } from "../../store/useUiStore";
import { useWidgetsStore, type WidgetDesktopPhase } from "../../store/useWidgetsStore";
import { openFullApp } from "../capsule/actions";

const REMINDER_DEBOUNCE_MS = 800;
/** 任务 Store 一次操作可能连发多次通知；合并成一次后端查询。 */
const TASK_REFRESH_DEBOUNCE_MS = 300;
/** 主窗事件监听注册的有界重试：首次 + 2 次退避重试。 */
const BRIDGE_REGISTER_ATTEMPTS = 3;
const BRIDGE_REGISTER_RETRY_DELAYS_MS = [400, 1200];

interface TasksViewCache {
  items: Task[] | null;
  error: string | null;
  stale: boolean;
}

function itemOf(type: WidgetType): WidgetItem | undefined {
  return useWidgetsStore.getState().widgets.find((item) => item.type === type);
}

/** 影响桌面窗口的配置签名：用于跳过无变化的重复命令。 */
function windowKey(item: WidgetItem): string {
  const d = item.desktop;
  return [
    item.size,
    d.visible ? 1 : 0,
    d.topmost ? 1 : 0,
    d.width ?? "",
    d.height ?? "",
    d.nx ?? "",
    d.ny ?? "",
    d.monitor ?? "",
  ].join("|");
}

function setRuntime(item: WidgetItem, phase: WidgetDesktopPhase, error?: string) {
  useWidgetsStore.getState().setDesktopRuntime(item.widget_id, phase, error);
}

function buildAgentSnapshot(): DesktopWidgetSnapshot {
  const state = useAgentsStore.getState();
  return {
    widgetType: "agent-status",
    snapshot: state.snapshot,
    snapshotError: state.snapshotError,
    updatedAt: new Date().toISOString(),
  };
}

function buildReminderSnapshot(
  items: ActiveReminder[] | null,
  error: string | null,
): DesktopWidgetSnapshot {
  return {
    widgetType: "next-reminder",
    items,
    error,
    updatedAt: new Date().toISOString(),
  };
}

export default function WidgetDesktopBridge() {
  const hydrated = useWidgetsStore((s) => s.hydrated);
  const widgets = useWidgetsStore((s) => s.widgets);
  const desktopResetSeq = useWidgetsStore((s) => s.desktopResetSeq);
  const desktopRetrySeq = useWidgetsStore((s) => s.desktopRetrySeq);
  const showToast = useUiStore((s) => s.showToast);
  const { t } = useLocale();

  const [openTypes, setOpenTypes] = useState<ReadonlySet<WidgetType>>(new Set());
  /**
   * 主窗事件监听是否全部就绪。独立微件窗口必须等它为 true 才创建：
   * 否则窗口 WebView 发出的首帧 snapshot 请求可能早于监听注册而被丢弃。
   */
  const [bridgeReady, setBridgeReady] = useState(false);
  const bridgeReadyRef = useRef(false);
  /** 主窗 WebView 会话标识：重载后变化，接收端据此重置 revision 代。 */
  const epochRef = useRef(
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const openRef = useRef<Set<WidgetType>>(new Set());
  const revisionRef = useRef<Map<WidgetType, number>>(new Map());
  const latestRef = useRef<Map<WidgetType, DesktopWidgetSnapshot>>(new Map());
  /** 最近一次快照请求携带的代际；show 结果返回前也能把首帧发回正确实例。 */
  const requestGenerationRef = useRef<Map<WidgetType, number>>(new Map());
  const lastPersistErrorRef = useRef<string | null>(null);
  const resetSeqRef = useRef<Record<string, number>>({});
  const retrySeqRef = useRef<Record<string, number>>({});
  const appliedKeyRef = useRef<Map<WidgetType, string>>(new Map());
  const queuesRef = useRef<Map<WidgetType, Promise<unknown>>>(new Map());
  /** 当前窗口代际：Rust 每次创建自增，旧窗口的迟到关闭事件据此丢弃。 */
  const generationRef = useRef<Map<WidgetType, number>>(new Map());
  /** 正在为「新开启意图」创建窗口；期间的事件不得回写 visible=false。 */
  const pendingOpenRef = useRef<Set<WidgetType>>(new Set());
  /** 最近一次 false → true 的用户开启时间，用于判断关闭事件是否早于最新意图。 */
  const lastOpenIntentAtRef = useRef<Map<WidgetType, number>>(new Map());
  const prevVisibleRef = useRef<Map<WidgetType, boolean>>(new Map());
  /** show 命令返回前就收到的销毁事件，创建结果返回后再对账。 */
  const lastDismissedRef = useRef<
    Map<WidgetType, { generation: number; reason: WidgetDismissReason }>
  >(new Map());
  const reminderRef = useRef<{ items: ActiveReminder[] | null; error: string | null }>({
    items: null,
    error: null,
  });
  const reminderSeq = useRef(0);

  // —— 今日任务：独立后端筛选缓存（不读任务页的筛选/排序/分页状态）——
  const taskViewRef = useRef<TasksViewCache>({ items: null, error: null, stale: false });
  const taskSeqRef = useRef(0);
  const taskInFlightRef = useRef(false);
  const taskPendingRef = useRef(false);
  const taskDebounceRef = useRef<number | null>(null);
  const lastMaxItemsRef = useRef<number | null>(null);

  const markOpen = useCallback((type: WidgetType, open: boolean) => {
    if (open) openRef.current.add(type);
    else openRef.current.delete(type);
    setOpenTypes(new Set(openRef.current));
  }, []);

  // 0) 布局水合：微件页可能从未被打开过，桌面窗口仍必须能从 localStorage 恢复。
  //    必须等主窗监听就绪后再水合；窗口创建只发生在水合之后（见 Effect 1），
  //    这道屏障保证「主窗能应答首帧请求」早于「依赖它的独立窗口被创建」。
  useEffect(() => {
    if (!isTauri() || !bridgeReady) return;
    void useWidgetsStore.getState().hydrate();
  }, [bridgeReady]);

  const publish = useCallback((type: WidgetType, snapshot: DesktopWidgetSnapshot) => {
    latestRef.current.set(type, snapshot);
    if (!openRef.current.has(type)) return;
    const revision = (revisionRef.current.get(type) ?? 0) + 1;
    revisionRef.current.set(type, revision);
    const generation =
      generationRef.current.get(type) ?? requestGenerationRef.current.get(type);
    void publishWidgetSnapshot(type, revision, snapshot, {
      epoch: epochRef.current,
      generation,
    })
      // 发布失败不阻断其它微件；只记录分型与次数，不含业务数据。
      .then((ok) => {
        if (!ok) {
          console.warn("[widget-connect] snapshot publish rejected", { widgetType: type });
        }
      })
      .catch((error) => {
        console.warn("[widget-connect] snapshot publish failed", {
          widgetType: type,
          error: errorMessage(error),
        });
      });
  }, []);

  const buildTasksSnapshot = useCallback((): TodayTasksSnapshot => {
    const state = useTasksStore.getState();
    const view = taskViewRef.current;
    const config = itemOf("today-tasks")?.config.maxItems;
    return {
      widgetType: "today-tasks",
      tasks: view.items ?? [],
      stats: state.stats,
      statsError: state.statsError,
      error: view.error,
      stale: view.stale,
      loading: view.items === null && view.error === null,
      configMaxItems: typeof config === "number" ? config : 5,
      updatedAt: new Date().toISOString(),
    };
  }, []);

  /** 单飞 + 合并：刷新期间的新请求只标记 pending，不并发、不重复 IPC。 */
  const refreshTodayTasks = useCallback(async () => {
    if (!isTauri() || !openRef.current.has("today-tasks")) return;
    if (taskInFlightRef.current) {
      taskPendingRef.current = true;
      return;
    }
    taskInFlightRef.current = true;
    try {
      do {
        taskPendingRef.current = false;
        const seq = ++taskSeqRef.current;
        const maxItems = itemOf("today-tasks")?.config.maxItems;
        const limit = typeof maxItems === "number" ? maxItems : 5;
        try {
          // 后端只查「今日到期 + 已逾期且未完成」，排序后限量；不拉全量。
          const items = await listTasks({
            view: "due_today_or_overdue",
            status: "pending",
            sort: "due",
            limit,
          });
          if (seq !== taskSeqRef.current) continue;
          taskViewRef.current = { items, error: null, stale: false };
        } catch (error) {
          if (seq !== taskSeqRef.current) continue;
          const previous = taskViewRef.current;
          // 保留上一次成功数据，并明确标记可能过期。
          taskViewRef.current = {
            items: previous.items,
            error: errorMessage(error),
            stale: previous.items !== null,
          };
        }
        if (seq === taskSeqRef.current && openRef.current.has("today-tasks")) {
          publish("today-tasks", buildTasksSnapshot());
        }
      } while (taskPendingRef.current);
    } finally {
      taskInFlightRef.current = false;
    }
  }, [publish, buildTasksSnapshot]);

  const publishFresh = useCallback(
    (type: WidgetType) => {
      switch (type) {
        case "today-tasks":
          publish(type, buildTasksSnapshot());
          break;
        case "agent-status":
          publish(type, buildAgentSnapshot());
          break;
        case "next-reminder":
          publish(type, buildReminderSnapshot(reminderRef.current.items, reminderRef.current.error));
          break;
        case "quick-actions":
          publish(type, { widgetType: "quick-actions", updatedAt: new Date().toISOString() });
          break;
        case "focus-timer":
          publish(type, {
            widgetType: "focus-timer",
            snapshot: WIDGET_SOURCES.focus?.getSnapshot() ?? null,
            available: Boolean(WIDGET_SOURCES.focus),
          });
          break;
        case "efficiency":
          publish(type, {
            widgetType: "efficiency",
            snapshot: WIDGET_SOURCES.efficiency?.getSnapshot() ?? null,
            available: Boolean(WIDGET_SOURCES.efficiency),
          });
          break;
      }
    },
    [publish, buildTasksSnapshot],
  );

  const refreshReminders = useCallback(() => {
    const seq = ++reminderSeq.current;
    activeReminders()
      .then((items) => {
        if (seq !== reminderSeq.current) return;
        reminderRef.current = { items, error: null };
        publish("next-reminder", buildReminderSnapshot(items, null));
      })
      .catch((error: unknown) => {
        if (seq !== reminderSeq.current) return;
        // 保留上一次成功数据，错误单独呈现，不伪装成「没有提醒」。
        reminderRef.current = { ...reminderRef.current, error: errorMessage(error) };
        publish(
          "next-reminder",
          buildReminderSnapshot(reminderRef.current.items, reminderRef.current.error),
        );
      });
  }, [publish]);

  /** 同一类型的窗口命令串行执行：快速关/开不会并发 create + hide。 */
  const enqueue = useCallback(<T,>(type: WidgetType, task: () => Promise<T>): Promise<T> => {
    const previous = queuesRef.current.get(type) ?? Promise.resolve();
    const next = previous.then(task, task);
    queuesRef.current.set(
      type,
      next.catch(() => undefined),
    );
    return next;
  }, []);

  /** 把 Store 中最新几何同步进 appliedKey，避免自己写入的数据再触发一轮窗口命令。 */
  const syncAppliedKey = useCallback((type: WidgetType) => {
    const latest = itemOf(type);
    if (latest) appliedKeyRef.current.set(type, windowKey(latest));
  }, []);

  /**
   * 按当前配置创建/更新/销毁窗口。
   * 命令在队列中执行时重新读取 Store，保证快速开/关时以「最新意图」为准；
   * 创建完成后再次校验 desired，期间被关掉则立即销毁，避免幽灵窗口。
   */
  const ensureWindow = useCallback(
    (type: WidgetType) =>
      enqueue(type, async () => {
        const current = itemOf(type);
        if (!current) return;
        if (!current.desktop.visible) {
          if (openRef.current.has(type)) {
            try {
              await hideWidgetWindow(type);
            } catch (error) {
              // 销毁失败说明窗口仍在：不能显示为已关闭，保留 openRef 供重试。
              pendingOpenRef.current.delete(type);
              setRuntime(current, "failed", errorMessage(error));
              showToast(
                t("widgets.desktop.closeFailed", { message: errorMessage(error) }),
                { kind: "error" },
              );
              return;
            }
          }
          markOpen(type, false);
          pendingOpenRef.current.delete(type);
          setRuntime(current, "hidden");
          syncAppliedKey(type);
          return;
        }

        const wasOpen = openRef.current.has(type);
        if (!wasOpen) {
          // 乐观标记：窗口 WebView 可能先于 show 命令返回就请求快照。
          markOpen(type, true);
          setRuntime(current, "creating");
        }
        try {
          const { width, height } = resolveDesktopWindowSize(
            type,
            current.size,
            current.desktop,
          );
          const info = await showWidgetWindow({
            widgetType: type,
            width,
            height,
            nx: current.desktop.nx,
            ny: current.desktop.ny,
            monitor: current.desktop.monitor,
            topmost: current.desktop.topmost,
            // 首次创建由 Rust 放置默认层叠位；已有位置时才应用保存的锚点。
            place: !wasOpen && current.desktop.nx !== undefined && current.desktop.ny !== undefined,
          });
          generationRef.current.set(type, info.generation);

          // 极端竞态：新窗口的销毁事件先于 show 返回；以事件携带的代际对账，
          // 不能把已经消失的窗口标记为 shown。
          const early = lastDismissedRef.current.get(type);
          if (early && early.generation === info.generation) {
            lastDismissedRef.current.delete(type);
            pendingOpenRef.current.delete(type);
            markOpen(type, false);
            const latest = itemOf(type);
            if (latest) {
              if (early.reason === "user-close" && latest.desktop.visible) {
                useWidgetsStore.getState().setDesktop(latest.widget_id, { visible: false });
                setRuntime(latest, "hidden");
              } else if (early.reason === "destroyed" && latest.desktop.visible) {
                setRuntime(latest, "failed", t("widgets.desktop.destroyed"));
                showToast(t("widgets.desktop.destroyed"), { kind: "error" });
              } else {
                setRuntime(latest, "hidden");
              }
              syncAppliedKey(type);
            }
            return;
          }

          // 创建期间用户可能已关闭桌面显示：立即销毁，避免幽灵窗口。
          const latest = itemOf(type);
          if (!latest || !latest.desktop.visible) {
            try {
              await hideWidgetWindow(type);
            } catch (error) {
              if (latest) {
                setRuntime(latest, "failed", errorMessage(error));
                showToast(
                  t("widgets.desktop.closeFailed", { message: errorMessage(error) }),
                  { kind: "error" },
                );
              }
              return;
            }
            markOpen(type, false);
            pendingOpenRef.current.delete(type);
            if (latest) setRuntime(latest, "hidden");
            syncAppliedKey(type);
            return;
          }

          // 只有 Rust 窗口命令成功返回后才进入 shown；WebView 首帧数据由
          // snapshot-request 确认，两者不混为一谈。
          pendingOpenRef.current.delete(type);
          markOpen(type, true);
          setRuntime(latest, "shown");
          // 窗口复用场景（主窗 WebView 重载后）不会重新发 request，这里主动补发
          // 当前快照；新窗口 WebView 未就绪时事件自然丢弃，其加载后会自行请求。
          publishFresh(type);
          const requestedTopmost = latest.desktop.topmost;
          useWidgetsStore
            .getState()
            .setDesktop(type, desktopFromWindowInfo(info, latest.desktop));
          if (info.topmost !== requestedTopmost) {
            // 置顶未真实生效：配置回落到实际值，并明确提示，不把请求值当结果。
            showToast(t("widgets.desktop.topmostFailed"), { kind: "warning" });
          }
          syncAppliedKey(type);
        } catch (error) {
          markOpen(type, false);
          pendingOpenRef.current.delete(type);
          setRuntime(current, "failed", errorMessage(error));
          showToast(t("widgets.desktop.openFailed", { message: errorMessage(error) }), {
            kind: "error",
          });
        }
      }),
    [enqueue, markOpen, publishFresh, showToast, syncAppliedKey, t],
  );

  // 1) 视图与窗口同步：只在「桌面显示」开关/尺寸/置顶/位置变化时发命令。
  useEffect(() => {
    if (!isTauri() || !hydrated || !bridgeReady) return;
    for (const item of widgets) {
      const type = item.type;

      // 记录用户显式开启时间：关闭事件可能晚于「关闭后立即重开」的输入，
      // 用时间与代际双重校验替代延时忽略。
      const previousVisible = prevVisibleRef.current.get(type);
      if (previousVisible === undefined) {
        prevVisibleRef.current.set(type, item.desktop.visible);
      } else if (previousVisible !== item.desktop.visible) {
        prevVisibleRef.current.set(type, item.desktop.visible);
        if (item.desktop.visible) {
          lastOpenIntentAtRef.current.set(type, Date.now());
          pendingOpenRef.current.add(type);
        } else {
          pendingOpenRef.current.delete(type);
        }
      }

      // 管理页「重置位置」只清配置并递增内存计数；这里负责移动已打开的窗口。
      const seq = desktopResetSeq[item.widget_id] ?? 0;
      if (seq !== (resetSeqRef.current[item.widget_id] ?? 0)) {
        resetSeqRef.current[item.widget_id] = seq;
        if (openRef.current.has(type)) {
          void enqueue(type, async () => {
            try {
              await resetWidgetPosition(type);
              const latest = itemOf(type);
              if (latest?.desktop.visible) setRuntime(latest, "shown");
              syncAppliedKey(type);
            } catch (error) {
              // 复位失败必须显式可见，不能静默当作成功。
              showToast(t("widgets.desktop.resetFailed", { message: errorMessage(error) }), {
                kind: "error",
              });
            }
          });
        }
      }

      // 今日任务条目上限变化：只刷新数据，不重建窗口。
      if (type === "today-tasks") {
        const maxItems = item.config.maxItems ?? 5;
        if (lastMaxItemsRef.current !== maxItems) {
          lastMaxItemsRef.current = maxItems;
          void refreshTodayTasks();
        }
      }

      const key = windowKey(item);
      if (appliedKeyRef.current.get(type) === key) continue;
      appliedKeyRef.current.set(type, key);
      void ensureWindow(type);
    }
  }, [
    widgets,
    desktopResetSeq,
    hydrated,
    bridgeReady,
    enqueue,
    ensureWindow,
    refreshTodayTasks,
    showToast,
    syncAppliedKey,
    t,
  ]);

  // 1b) 失败后的手动重试：创建失败重建窗口；关闭失败则重试销毁。
  useEffect(() => {
    if (!isTauri() || !hydrated || !bridgeReady) return;
    for (const item of widgets) {
      const type = item.type;
      const seq = desktopRetrySeq[item.widget_id] ?? 0;
      if (seq === (retrySeqRef.current[item.widget_id] ?? 0)) continue;
      retrySeqRef.current[item.widget_id] = seq;
      const runtime = useWidgetsStore.getState().desktopRuntime[item.widget_id];
      if (runtime?.phase !== "failed") continue;
      appliedKeyRef.current.delete(type);
      if (item.desktop.visible) {
        pendingOpenRef.current.add(type);
        setRuntime(item, "creating");
      }
      void ensureWindow(type);
    }
  }, [widgets, desktopRetrySeq, hydrated, bridgeReady, ensureWindow]);

  // 2) 任务/Agent：全局 Store 已有事件驱动，这里只在对应窗口打开时发布。
  useEffect(() => {
    if (!isTauri()) return;
    const unsubTasks = useTasksStore.subscribe(() => {
      if (!openRef.current.has("today-tasks")) return;
      if (taskDebounceRef.current !== null) window.clearTimeout(taskDebounceRef.current);
      taskDebounceRef.current = window.setTimeout(() => {
        taskDebounceRef.current = null;
        void refreshTodayTasks();
      }, TASK_REFRESH_DEBOUNCE_MS);
    });
    const unsubAgents = useAgentsStore.subscribe(() => {
      if (openRef.current.has("agent-status")) publish("agent-status", buildAgentSnapshot());
    });
    return () => {
      unsubTasks();
      unsubAgents();
      if (taskDebounceRef.current !== null) {
        window.clearTimeout(taskDebounceRef.current);
        taskDebounceRef.current = null;
      }
    };
  }, [publish, refreshTodayTasks]);

  // 3) 专注 / 效率：只有窗口打开时才订阅数据源；关闭即退订，释放定时器。
  useEffect(() => {
    if (!isTauri()) return;
    const disposers: Array<() => void> = [];
    if (openTypes.has("today-tasks")) {
      publishFresh("today-tasks");
      void refreshTodayTasks();
    }
    if (openTypes.has("focus-timer")) {
      const source = WIDGET_SOURCES.focus;
      if (source) disposers.push(source.subscribe(() => publishFresh("focus-timer")));
      publishFresh("focus-timer");
    }
    if (openTypes.has("efficiency")) {
      const source = WIDGET_SOURCES.efficiency;
      if (source) disposers.push(source.subscribe(() => publishFresh("efficiency")));
      publishFresh("efficiency");
    }
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [openTypes, publishFresh, refreshTodayTasks]);

  // 4) 提醒：只在提醒微件窗口存在时读取 + 订阅；任务变化做 debounce 刷新。
  useEffect(() => {
    if (!isTauri() || !openTypes.has("next-reminder")) return;
    let disposed = false;
    const unsubscribeFns: Array<() => void> = [];
    const register = (pending: Promise<() => void>) => {
      void pending.then((un) => {
        if (disposed) un();
        else unsubscribeFns.push(un);
      });
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        refreshReminders();
      }, REMINDER_DEBOUNCE_MS);
    };
    refreshReminders();
    register(onReminderFired(schedule));
    register(onReminderSnoozed(schedule));
    const tasksUnsub = useTasksStore.subscribe(schedule);
    return () => {
      disposed = true;
      tasksUnsub();
      for (const un of unsubscribeFns) un();
      if (timer) clearTimeout(timer);
      reminderSeq.current += 1;
    };
  }, [openTypes, refreshReminders]);

  // 5) 微件窗口 → 主窗口事件（快照请求 / 点击动作 / 几何 / 关闭）。
  //    全部监听注册完成才置 `bridgeReady`；独立窗口创建依赖该信号，杜绝
  //    「窗口已创建、主窗还未注册请求监听」导致的首帧快照丢失。
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const unsubs: Array<() => void> = [];
    // 每轮（含依赖变化触发的重注册）都先关闭就绪信号，避免窗口在空窗期被创建。
    bridgeReadyRef.current = false;
    setBridgeReady(false);

    const disposeUnsubs = () => {
      for (const un of unsubs.splice(0)) {
        try {
          un();
        } catch {
          // 监听可能已随 WebView/事件总线销毁：重复释放不影响重新注册。
        }
      }
    };

    /** 注册单个监听；disposed 后立即退订，避免重试轮次留下重复订阅。 */
    const track = (pending: Promise<() => void>) =>
      pending.then((un) => {
        if (disposed) un();
        else unsubs.push(un);
      });

    const register = async () => {
      attempts += 1;
      try {
        // 快照请求监听必须最先完成：它是首帧快照的唯一入口。
        const unRequest = await onWidgetSnapshotRequest(({ widgetType, generation }) => {
          requestGenerationRef.current.set(widgetType, generation);
          if (!openRef.current.has(widgetType)) return;
          // snapshot 请求只说明 WebView 已挂载；窗口是否真正显示以 show 命令成功返回为准，
          // 因此不在此推进 creating → shown，避免「显示成功」提示早于 Rust 真实结果。
          publishFresh(widgetType);
          // 首帧请求顺带刷新一次今日任务，避免窗口重开时展示过期缓存。
          if (widgetType === "today-tasks") void refreshTodayTasks();
        });
        if (disposed) {
          unRequest();
          return;
        }
        unsubs.push(unRequest);

        // 其余监听并行注册；少一条都会让窗口行为不完整，全部成功才算就绪。
        await Promise.all([
          track(onWidgetAction((payload) => {
      const ui = useUiStore.getState();
      const tasks = useTasksStore.getState();
      switch (payload.action) {
        case "open-task": {
          const id = payload.taskId;
          if (!id) break;
          const local: Task | undefined =
            tasks.tasks.find((item) => item.id === id) ??
            tasks.lite?.find((item) => item.id === id);
          if (local) {
            ui.openEditor(local);
            break;
          }
          // 任务页当前筛选可能不包含该任务：按 ID 取回后打开正确详情，
          // 只把「任务页」当作最终失败兜底，不当作成功路径。
          void fetchTask(id)
            .then((task) => ui.openEditor(task))
            .catch((error: unknown) => {
              showToast(
                t("widgets.desktop.taskOpenFailed", { message: errorMessage(error) }),
                { kind: "error" },
              );
              ui.setTab("tasks");
            });
          break;
        }
        case "open-panel":
          openFullApp((payload.tab as Tab) ?? "tasks");
          break;
        case "open-agents":
          openFullApp("agents");
          break;
        case "new-task":
          ui.setTab("tasks");
          ui.bumpQuickAdd();
          break;
        case "capture":
          openFullApp("inbox");
          break;
        case "clipboard":
          openFullApp("clipboard");
          break;
        case "workflows":
          openFullApp("workflows");
          break;
        case "retry-efficiency":
          WIDGET_SOURCES.efficiency?.retry?.();
          break;
        case "refresh-reminder":
          refreshReminders();
          break;
        case "manage-reminders":
          openFullApp("tasks");
          break;
      }
          })),

          track(onWidgetBounds((payload) => {
      const store = useWidgetsStore.getState();
      const item = store.widgets.find((entry) => entry.type === payload.widgetType);
      if (!item) return;
      const patch: Partial<WidgetDesktopState> = {
        nx: payload.nx,
        ny: payload.ny,
        monitor: payload.monitor ?? undefined,
        topmost: payload.topmost,
      };
      // 只有用户手动缩放才保存自定义宽高；程序 set_size / DPI 换算不算。
      if (payload.customSize) {
        patch.width = Math.round(payload.width);
        patch.height = Math.round(payload.height);
      }
      store.setDesktop(item.widget_id, patch);
      syncAppliedKey(payload.widgetType);
      // 拖动结束才落盘；写失败必须显式提示（同一错误只提示一次，下次修改会重试）。
      const persistError = useWidgetsStore.getState().persistError;
      if (persistError && persistError !== lastPersistErrorRef.current) {
        lastPersistErrorRef.current = persistError;
        showToast(t("widgets.persistError", { message: persistError }), { kind: "error" });
      } else if (!persistError) {
        lastPersistErrorRef.current = null;
      }
          })),

          track(onWidgetDismissed((event) => {
      const { widgetType, generation, reason } = event;
      const item = itemOf(widgetType);
      if (!item) return;
      const action = classifyWidgetDismissal(event, {
        currentGeneration: generationRef.current.get(widgetType),
        pendingOpen: pendingOpenRef.current.has(widgetType),
        lastOpenIntentAt: lastOpenIntentAtRef.current.get(widgetType) ?? 0,
      });

      if (action.kind === "ignore") {
        // app-exit 或旧窗口的迟到销毁：不写配置。
        return;
      }
      if (action.kind === "defer") {
        // 新窗口的 show 结果尚未返回：先记账，创建返回后按代际对账。
        lastDismissedRef.current.set(widgetType, { generation, reason });
        return;
      }
      if (action.kind === "reopen") {
        // 用户在关闭后已经重新开启：关闭事件早于最新意图，保留 visible=true，
        // 若还没有创建任务则立即补一次，避免丢失用户意图。
        markOpen(widgetType, false);
        if (!pendingOpenRef.current.has(widgetType)) {
          pendingOpenRef.current.add(widgetType);
          appliedKeyRef.current.delete(widgetType);
          void ensureWindow(widgetType);
        }
        return;
      }

      markOpen(widgetType, false);
      if (action.kind === "pending") {
        // 有更新的创建意图在途：只对账物理状态，结果由创建流程确认。
        return;
      }
      if (action.kind === "management-hide") {
        // 管理页关闭桌面显示：配置已写入 false，这里只对账运行态，不重复持久化。
        pendingOpenRef.current.delete(widgetType);
        setRuntime(item, "hidden");
        syncAppliedKey(widgetType);
        return;
      }
      if (action.kind === "user-close") {
        // 用户主动关窗（Alt+F4 / 窗口按钮）：只把桌面显示关掉，微件配置保留。
        pendingOpenRef.current.delete(widgetType);
        if (item.desktop.visible) {
          useWidgetsStore.getState().setDesktop(item.widget_id, { visible: false });
        }
        setRuntime(item, "hidden");
        syncAppliedKey(widgetType);
        return;
      }
      // destroyed：WebView 崩溃或外部销毁，属于异常。保留配置供手动重试，
      // 不自动重建（避免崩溃循环），也不谎报为正常关闭。
      pendingOpenRef.current.delete(widgetType);
      if (item.desktop.visible) {
        setRuntime(item, "failed", t("widgets.desktop.destroyed"));
        showToast(t("widgets.desktop.destroyed"), { kind: "error" });
      } else {
        setRuntime(item, "hidden");
      }
      syncAppliedKey(widgetType);
          })),
        ]);
        if (disposed) return;
        bridgeReadyRef.current = true;
        setBridgeReady(true);
      } catch (error) {
        disposeUnsubs();
        if (disposed) return;
        if (attempts < BRIDGE_REGISTER_ATTEMPTS) {
          const delay = BRIDGE_REGISTER_RETRY_DELAYS_MS[attempts - 1] ?? 1200;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            void register();
          }, delay);
          return;
        }
        bridgeReadyRef.current = false;
        setBridgeReady(false);
        // 监听无法注册时创建窗口只会得到永久「未连接」：如实报错，不假装就绪。
        showToast(t("widgets.desktop.bridgeFailed", { message: errorMessage(error) }), {
          kind: "error",
        });
      }
    };

    void register();

    return () => {
      disposed = true;
      bridgeReadyRef.current = false;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      disposeUnsubs();
    };
  }, [
    markOpen,
    publishFresh,
    refreshReminders,
    refreshTodayTasks,
    showToast,
    syncAppliedKey,
    t,
  ]);

  // 6) 主窗口关闭/退出：Rust 会随进程销毁所有窗口；这里只释放事件订阅与缓存。
  useEffect(() => {
    return () => {
      openRef.current.clear();
      revisionRef.current.clear();
      latestRef.current.clear();
      requestGenerationRef.current.clear();
      appliedKeyRef.current.clear();
      queuesRef.current.clear();
      generationRef.current.clear();
      pendingOpenRef.current.clear();
      lastOpenIntentAtRef.current.clear();
      prevVisibleRef.current.clear();
      lastDismissedRef.current.clear();
      reminderSeq.current += 1;
      taskSeqRef.current += 1;
      taskInFlightRef.current = false;
      taskPendingRef.current = false;
      if (taskDebounceRef.current !== null) {
        window.clearTimeout(taskDebounceRef.current);
        taskDebounceRef.current = null;
      }
    };
  }, []);

  return null;
}
