//! 桌面微件独立窗口宿主。
//!
//! 设计约束：
//! - 本窗口**不**挂载主窗口 `App.tsx`，只负责「读快照 → 渲染 → 上报几何」；
//! - 数据所有者是主窗口 `WidgetDesktopBridge`；这里不直接查询 SQLite、不启动扫描器；
//! - 快照带单调递增 `revision`，旧快照一律丢弃（窗口重建/竞态兜底）；
//! - 拖动/缩放由 `onMoved`/`onResized` 去抖后上报一次，Rust 负责物理坐标与 DPI 换算；
//! - 关闭 = 销毁 WebView（不隐藏常驻），下次显示由主窗口重新创建。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertTriangle, Loader2, Pin, PinOff, RefreshCw, X } from "lucide-react";

import { getSettings } from "../lib/bridge";
import { errorMessage } from "../lib/errors";
import { useLocale } from "../hooks/useLocale";
import { createSubscriptionScope } from "../lib/subscriptions";
import { resolveSecondaryPreset, resolveTheme, resolveVisualPreset } from "../lib/theme";
import {
  advanceSnapshotGuard,
  createSnapshotGuard,
  shouldAcceptSnapshot,
  typeFromWindowLabel,
  type DesktopActionKind,
  type DesktopWidgetSnapshot,
  type WidgetSnapshotEnvelope,
} from "../lib/widgets/desktop";
import {
  dismissWidgetWindow,
  dispatchWidgetAction,
  getWidgetWindowInfo,
  onWidgetSnapshot,
  requestWidgetSnapshot,
  reportWidgetBounds,
  setWidgetTopmost,
} from "../lib/widgets/desktopBridge";
import { widgetDefinition, type WidgetType } from "../lib/widgets/model";
import type {
  EfficiencySnapshot,
  EfficiencySource,
  FocusSnapshot,
  WidgetSource,
} from "../lib/widgets/sources";
import { useAgentsStore } from "../store/useAgentsStore";
import { useTasksStore } from "../store/useTasksStore";
import AgentStatusWidget from "../components/widgets/AgentStatusWidget";
import { EfficiencyWidget, FocusTimerWidget } from "../components/widgets/DependencyWidgets";
import { ReminderBody } from "../components/widgets/NextReminderWidget";
import QuickActionsWidget from "../components/widgets/QuickActionsWidget";
import TodayTasksWidget from "../components/widgets/TodayTasksWidget";

/** 拖动/缩放停止后再上报，避免每帧调用 IPC 与写盘。 */
const BOUNDS_DEBOUNCE_MS = 350;
/** 首帧快照等待上限；超时只提示并可手动重试，不启动轮询。 */
const CONNECT_TIMEOUT_MS = 4000;
/** 首帧失败的有限次自动重连（含首次共 3 次），成功/销毁即停。 */
const CONNECT_ATTEMPTS = 3;
const CONNECT_RETRY_DELAYS_MS = [1200, 2400];

/** 连接失败分型：订阅失败 / IPC 请求失败 / 首帧超时。 */
type ConnectFailure = "listen" | "request" | "timeout";

function createRelay<T>(): { source: WidgetSource<T>; push: (value: T | null) => void } {
  let value: T | null = null;
  const listeners = new Set<() => void>();
  return {
    source: {
      getSnapshot: () => value,
      subscribe: (onChange) => {
        listeners.add(onChange);
        return () => listeners.delete(onChange);
      },
    },
    push: (next) => {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

// 专注/效率在本窗口没有独立 Store：主窗口把快照推进来，这里只做稳定引用转发。
const focusRelay = createRelay<FocusSnapshot>();
const efficiencyRelay = createRelay<EfficiencySnapshot>();
const efficiencySource: EfficiencySource = {
  ...efficiencyRelay.source,
  // 重试只刷新数据，不唤回主窗口（Rust 侧对数据类动作不显示主窗）。
  retry: () => {
    void dispatchWidgetAction("retry-efficiency").catch(() => {});
  },
};

/**
 * 微件窗口拖拽光标会话：标题条 `.wd-drag` 按下时表面加 `is-dragging`（grabbing），
 * 结束回到 grab。与主窗标题栏同一策略（Tauri 原生拖动进入 Win32 模态循环期间
 * WebView2 收不到 pointerup；结束信号取 pointerup / pointercancel /
 * visibilitychange，以及恢复后的「按键已松开」pointermove）。
 * `blur` 只在起始 120ms 之后结束（起始内为激活扰动）；会话序号隔离新旧会话。
 * 只认事件 target 自身的 data-tauri-drag-region（按钮永远不是手柄）。
 */
function useWidgetDragCursor() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let endSession: (() => void) | null = null;
    let sessionSeq = 0;

    const stop = () => {
      root.classList.remove("is-dragging");
      endSession?.();
      endSession = null;
    };

    const start = () => {
      stop(); // 上一条会话若因事件缺失没收尾，先清掉再开新的
      const mySeq = ++sessionSeq;
      const startedAt = Date.now();
      const isStale = () => mySeq !== sessionSeq;
      const inStartChurn = () => Date.now() - startedAt < 120;
      root.classList.add("is-dragging");
      const end = () => {
        if (isStale()) return;
        stop();
      };
      const endIfLate = () => {
        if (isStale() || inStartChurn()) return;
        stop();
      };
      const onMove = (event: PointerEvent) => {
        if (event.buttons === 0) endIfLate();
      };
      const onBlur = () => endIfLate();
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      window.addEventListener("blur", onBlur);
      document.addEventListener("visibilitychange", end);
      endSession = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        window.removeEventListener("blur", onBlur);
        document.removeEventListener("visibilitychange", end);
      };
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element) || !root.contains(target)) return;
      if (!target.hasAttribute("data-tauri-drag-region")) return;
      start();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      sessionSeq += 1;
      stop();
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);

  return rootRef;
}

export default function WidgetWindow() {
  const { t } = useLocale();
  const surfaceSessionRef = useWidgetDragCursor();

  // label 在 WebView 创建时即确定，不依赖 URL query。
  const type = useMemo<WidgetType | null>(() => {
    if (!isTauri()) return null;
    try {
      return typeFromWindowLabel(getCurrentWindow().label);
    } catch {
      return null;
    }
  }, []);

  const [snapshot, setSnapshot] = useState<DesktopWidgetSnapshot | null>(null);
  const [connectFailure, setConnectFailure] = useState<ConnectFailure | null>(null);
  const [connectAttempt, setConnectAttempt] = useState(0);
  const [topmost, setTopmost] = useState(false);
  /** 置顶/关闭等窗口命令失败：必须在窗口内给出可操作反馈，不能静默失败。 */
  const [actionError, setActionError] = useState<string | null>(null);
  /** 已接受快照的水位（会话 / revision / 窗口代际）。 */
  const guardRef = useRef(createSnapshotGuard());
  /** Rust 回报的当前窗口代际；旧代际快照必须丢弃。 */
  const windowGenerationRef = useRef<number | null>(null);
  /** 已失败次数：用于有界自动重连，成功即清零。 */
  const failedAttemptsRef = useRef(0);
  const connectStartedAtRef = useRef(Date.now());
  const timeoutRef = useRef<number | null>(null);

  const [themeSnap, setThemeSnap] = useState<{
    theme: string;
    visualPreset: string;
    material: string;
  } | null>(null);
  const [prefersDark, setPrefersDark] = useState(() => {
    try {
      return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    } catch {
      return false;
    }
  });

  const act = useCallback(
    (action: DesktopActionKind, options: { tab?: string; taskId?: string } = {}) => {
      void dispatchWidgetAction(action, options).catch(() => {});
    },
    [],
  );

  // —— 主题：与主窗口/通知窗口同一事实来源，打开中的微件随设置实时切换 ——
  /** 初始设置是否已成功读取；失败后主题事件会触发一次补取，不会永久停在 null。 */
  const themeReadyRef = useRef(false);
  const loadTheme = useCallback(() => {
    void getSettings()
      .then((settings) => {
        themeReadyRef.current = true;
        setThemeSnap({
          theme: settings.theme,
          visualPreset: settings.visual_preset ?? "",
          material: settings.material,
        });
      })
      .catch(() => {
        // 读取失败时保持系统明暗；下一次主题事件会再补取一次（而不是永久丢弃事件）。
        themeReadyRef.current = false;
      });
  }, []);

  useEffect(() => {
    loadTheme();
    const scope = createSubscriptionScope();
    /** 事件先增量应用；若初始快照缺失，同时补取一次完整设置。 */
    const applyThemePatch = (patch: Partial<NonNullable<typeof themeSnap>>) => {
      setThemeSnap((current) =>
        current
          ? { ...current, ...patch }
          : { theme: "system", visualPreset: "", material: "glass", ...patch },
      );
      if (!themeReadyRef.current) loadTheme();
    };
    scope.add(
      listen<string>("theme-changed", (event) => applyThemePatch({ theme: event.payload })),
    );
    scope.add(
      listen<string>("visual-preset-changed", (event) =>
        applyThemePatch({ visualPreset: event.payload }),
      ),
    );
    scope.add(
      listen<string>("material-changed", (event) =>
        applyThemePatch({ material: event.payload }),
      ),
    );
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onSystemTheme = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    media?.addEventListener("change", onSystemTheme);
    return () => {
      scope.dispose();
      media?.removeEventListener("change", onSystemTheme);
    };
  }, [loadTheme]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const resolvedTheme = resolveTheme(themeSnap?.theme ?? "system", { prefersDark });
    // 独立窗口需要可读底：清透预设映射到液态玻璃，不跟随主窗口全透明。
    root.dataset.preset = resolveSecondaryPreset(
      resolveVisualPreset(themeSnap?.visualPreset ?? ""),
    );
    root.dataset.theme = resolvedTheme;
    root.dataset.material = themeSnap?.material ?? "glass";
  }, [themeSnap, prefersDark]);

  // —— 快照订阅：会话 / 代际 / revision 三重守卫；有限次自动重连，不轮询 ——
  /** 手动重试：清零失败计数并重走「注册监听 → 请求首帧」。 */
  const retryConnect = useCallback(() => {
    failedAttemptsRef.current = 0;
    connectStartedAtRef.current = Date.now();
    setConnectFailure(null);
    setConnectAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    if (!type) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    let retryTimer: number | null = null;

    const failConnect = (reason: ConnectFailure) => {
      if (disposed) return;
      setConnectFailure(reason);
      const failed = failedAttemptsRef.current + 1;
      failedAttemptsRef.current = failed;
      if (failed < CONNECT_ATTEMPTS) {
        const delay = CONNECT_RETRY_DELAYS_MS[failed - 1] ?? CONNECT_RETRY_DELAYS_MS.at(-1)!;
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          // 重新走一轮效果：清理旧监听与定时器，不会累积重复订阅。
          setConnectAttempt((attempt) => attempt + 1);
        }, delay);
        return;
      }
      // 只记录分型、次数与耗时；不含任务/提醒正文等业务数据。
      console.warn("[widget-connect] first snapshot failed", {
        widgetType: type,
        reason,
        attempts: failed,
        elapsedMs: Date.now() - connectStartedAtRef.current,
      });
    };

    const armTimeout = () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => {
        timeoutRef.current = null;
        failConnect("timeout");
      }, CONNECT_TIMEOUT_MS);
    };

    const connect = async () => {
      let un: UnlistenFn;
      try {
        un = await onWidgetSnapshot((envelope: WidgetSnapshotEnvelope) => {
          if (disposed || envelope.widgetType !== type) return;
          if (!shouldAcceptSnapshot(guardRef.current, envelope, windowGenerationRef.current)) {
            return;
          }
          guardRef.current = advanceSnapshotGuard(envelope);
          failedAttemptsRef.current = 0;
          if (retryTimer !== null) {
            window.clearTimeout(retryTimer);
            retryTimer = null;
          }
          if (timeoutRef.current !== null) {
            window.clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
          setConnectFailure(null);
          setSnapshot(envelope.snapshot);
        });
      } catch {
        failConnect("listen");
        return;
      }
      if (disposed) {
        un();
        return;
      }
      unlisten = un;
      // 监听注册成功后才请求首帧：否则主窗口可能先把快照发在一个尚未订阅的窗口里。
      armTimeout();
      void requestWidgetSnapshot().catch(() => {
        if (!disposed) failConnect("request");
      });
    };

    void connect();
    return () => {
      disposed = true;
      unlisten?.();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [type, connectAttempt]);

  // —— 初始置顶状态：由 Rust 回报，避免界面与真实窗口不一致 ——
  useEffect(() => {
    if (!type) return;
    let disposed = false;
    void getWidgetWindowInfo()
      .then((info) => {
        if (disposed) return;
        windowGenerationRef.current = info.generation;
        if (guardRef.current.generation === null) {
          guardRef.current = { ...guardRef.current, generation: info.generation };
        }
        setTopmost(info.topmost);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [type]);

  // —— 拖动/缩放上报：仅停止后一次；物理坐标与显示器由 Rust 计算 ——
  useEffect(() => {
    if (!type || !isTauri()) return;
    let timer: number | null = null;
    let disposed = false;
    let unMove: UnlistenFn | null = null;
    let unResize: UnlistenFn | null = null;

    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void reportWidgetBounds().catch(() => {});
      }, BOUNDS_DEBOUNCE_MS);
    };

    const win = getCurrentWindow();
    void win.onMoved(schedule).then((un) => {
      if (disposed) un();
      else unMove = un;
    });
    void win.onResized(schedule).then((un) => {
      if (disposed) un();
      else unResize = un;
    });

    return () => {
      disposed = true;
      unMove?.();
      unResize?.();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [type]);

  // —— 快照落地：今日任务 / Agent 注入本窗口 Store 后复用现有组件 ——
  useEffect(() => {
    if (!snapshot) return;
    switch (snapshot.widgetType) {
      case "today-tasks":
        useTasksStore.setState({
          tasks: snapshot.tasks,
          stats: snapshot.stats,
          statsError: snapshot.statsError,
          error: snapshot.error,
          loading: snapshot.loading ?? false,
        });
        break;
      case "agent-status":
        useAgentsStore.setState({
          snapshot: snapshot.snapshot,
          snapshotError: snapshot.snapshotError,
        });
        break;
      case "focus-timer":
        focusRelay.push(snapshot.available ? snapshot.snapshot : null);
        break;
      case "efficiency":
        efficiencyRelay.push(snapshot.available ? snapshot.snapshot : null);
        break;
      default:
        break;
    }
  }, [snapshot]);

  const toggleTopmost = useCallback(() => {
    const next = !topmost;
    setActionError(null);
    setTopmost(next);
    void setWidgetTopmost(next).catch((error: unknown) => {
      // 真实置顶状态未改变：回退 UI，并提示失败原因。
      setTopmost(topmost);
      setActionError(t("widgetWindow.topmostFailed", { message: errorMessage(error) }));
    });
  }, [t, topmost]);

  const close = useCallback(() => {
    setActionError(null);
    void dismissWidgetWindow().catch((error: unknown) => {
      // 销毁失败时窗口仍在：不伪装成已关闭，给出重试入口（再次点击关闭）。
      setActionError(t("widgetWindow.closeFailed", { message: errorMessage(error) }));
    });
  }, [t]);

  if (!type) {
    return (
      <div className="wd-root">
        <div className="wd-surface wd-message">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>{t("widgetWindow.invalid")}</span>
        </div>
      </div>
    );
  }

  const title = t(widgetDefinition(type).titleKey);

  function renderBody() {
    if (!snapshot) {
      return (
        <div className="wd-state" role="status">
          {connectFailure ? (
            <>
              <AlertTriangle size={16} aria-hidden="true" />
              <span>
                {t(
                  connectFailure === "listen"
                    ? "widgetWindow.listenFailed"
                    : connectFailure === "request"
                      ? "widgetWindow.requestFailed"
                      : "widgetWindow.timeout",
                )}
              </span>
              <button type="button" className="wd-retry" onClick={retryConnect}>
                <RefreshCw size={11} aria-hidden="true" /> {t("widgetWindow.retry")}
              </button>
            </>
          ) : (
            <>
              <Loader2 size={16} className="spin" aria-hidden="true" />
              <span>{t("widgetWindow.waiting")}</span>
            </>
          )}
        </div>
      );
    }

    switch (snapshot.widgetType) {
      case "today-tasks":
        return (
          <TodayTasksWidget
            config={{ maxItems: snapshot.configMaxItems }}
            onOpenTask={(task) => act("open-task", { taskId: task.id })}
            onOpenPanel={() => act("open-panel", { tab: "tasks" })}
          />
        );
      case "next-reminder":
        return (
          <ReminderBody
            items={snapshot.items}
            error={snapshot.error}
            onRetry={() => act("refresh-reminder")}
            onManage={() => act("manage-reminders")}
          />
        );
      case "agent-status":
        return <AgentStatusWidget autoLoad={false} onOpenAgents={() => act("open-agents")} />;
      case "quick-actions":
        return <QuickActionsWidget onAction={(key) => act(key)} />;
      case "focus-timer":
        return <FocusTimerWidget source={focusRelay.source} />;
      case "efficiency":
        return <EfficiencyWidget source={efficiencySource} />;
      default:
        return null;
    }
  }

  return (
    <div className="wd-root">
      <div className="wd-surface wd-drag-session" ref={surfaceSessionRef} role="region" aria-label={title}>
        <header className="wd-header">
          <div className="wd-drag" data-tauri-drag-region>
            <span className="wd-title">{title}</span>
          </div>
          <div className="wd-tools">
            <button
              type="button"
              className={`wd-btn ${topmost ? "is-on" : ""}`}
              aria-label={t(
                topmost ? "widgetWindow.topmostOnAria" : "widgetWindow.topmostOffAria",
                { title },
              )}
              aria-pressed={topmost}
              onClick={toggleTopmost}
            >
              {topmost ? (
                <Pin size={12} aria-hidden="true" />
              ) : (
                <PinOff size={12} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="wd-btn wd-close"
              aria-label={t("widgetWindow.closeAria", { title })}
              onClick={close}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        </header>
        {actionError && (
          <div className="wd-action-error" role="alert">
            <AlertTriangle size={12} aria-hidden="true" />
            <span className="wd-action-error-text">{actionError}</span>
            <button
              type="button"
              className="wd-action-error-close"
              onClick={() => setActionError(null)}
            >
              {t("common.close")}
            </button>
          </div>
        )}
        <div className="wd-body">{renderBody()}</div>
      </div>
    </div>
  );
}
