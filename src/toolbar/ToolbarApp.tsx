//! 投屏控制栏窗口入口：只渲染当前 Session 的控制栏，不挂载主界面。
//!
//! 窗口由 Rust 侧 `projection_window` 创建并定位（外置/内置、DPI、多显示器、
//! 全屏自动隐藏都在原生层完成）；本组件只负责：
//! - 读取 URL 中的 sessionId 并订阅后端 `vd-toolbar-state`；
//! - 把按钮动作转发给 Session 层（controller / 已有 vd_* 命令）；
//! - 「更多」面板展示会话信息与诊断，所有结果都来自真实命令。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader2, ShieldAlert, Stethoscope } from "lucide-react";

import {
  getSettings,
  vdDiagnostics,
  vdSession,
  type ProjectionToolbarState,
  type ProjectionWindowMode,
  type VdDiagnostics,
  type VdSession,
} from "../lib/bridge";
import { localizedErrorMessage } from "../i18n/errors";
import { useLocale } from "../hooks/useLocale";
import { resolveTheme, resolveVisualPreset } from "../lib/theme";
import ProjectionToolbar, {
  capabilitiesForSession,
  type ProjectionCapabilities,
  type ProjectionNavigationAction,
} from "../components/mobile/virtual-display/ProjectionToolbar";
import {
  createToolbarVisibilityController,
  projectionWindowController,
} from "../components/mobile/virtual-display/projection-window-controller";
import {
  sessionStatusKey,
} from "../components/mobile/virtual-display/format";

const STATE_EVENT = "vd-toolbar-state";
const FEEDBACK_MS = 2200;

type BusyAction = ProjectionNavigationAction | "screenshot" | "close" | null;

function emptyCapabilities(): ProjectionCapabilities {
  return {
    back: false,
    home: false,
    recents: false,
    screenshot: false,
    close: false,
  };
}

/** 会话 ID 来自窗口 label（`vd-toolbar-<id>`）；浏览器预览时回退到查询参数。 */
function resolveSessionId(): string {
  try {
    const prefix = "vd-toolbar-";
    const label = getCurrentWindow().label;
    if (label.startsWith(prefix)) {
      return label.slice(prefix.length);
    }
  } catch {
    // 非 Tauri 环境没有窗口元数据。
  }
  return new URLSearchParams(window.location.search).get("session") ?? "";
}

export default function ToolbarApp() {
  const { t } = useLocale();
  const sessionId = useMemo(() => resolveSessionId(), []);

  const [session, setSession] = useState<VdSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<ProjectionWindowMode>("normal");
  const [locked, setLocked] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [diag, setDiag] = useState<VdDiagnostics | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);

  const feedbackTimer = useRef<number | null>(null);
  const panelOpenRef = useRef(false);
  const panelVisibility = useMemo(
    () => createToolbarVisibilityController(9000),
    [],
  );

  const flash = useCallback((message: string) => {
    setFeedback(message);
    if (feedbackTimer.current !== null) {
      window.clearTimeout(feedbackTimer.current);
    }
    feedbackTimer.current = window.setTimeout(() => {
      feedbackTimer.current = null;
      setFeedback(null);
    }, FEEDBACK_MS);
  }, []);

  const loadSession = useCallback(async () => {
    if (!sessionId) {
      setLoadError(t("projectionToolbar.noSession"));
      return;
    }
    try {
      const next = await vdSession(sessionId);
      setSession(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(localizedErrorMessage(error));
    }
  }, [sessionId, t]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // 后端窗口状态（模式/锁定/展开）与原生 watcher 保持同步。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ProjectionToolbarState>(STATE_EVENT, (event) => {
      const payload = event.payload;
      if (!payload) return;
      setMode(payload.mode);
      setLocked(payload.locked);
      if (!payload.expanded) {
        setPanelOpen(false);
        panelVisibility.cancelToolbarHide();
      }
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // 非 Tauri 环境（单测/预览）没有事件通道。
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [panelVisibility]);

  // 主题：与通知窗口同一套解析，落 html[data-theme][data-preset]。
  const [themeSetting, setThemeSetting] = useState("system");
  const [visualPreset, setVisualPreset] = useState<string | null>(null);
  const [prefersDark, setPrefersDark] = useState(
    () =>
      typeof window !== "undefined" &&
      Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches),
  );
  useEffect(() => {
    void getSettings()
      .then((settings) => {
        setThemeSetting(settings.theme);
        setVisualPreset(settings.visual_preset);
      })
      .catch(() => {
        // 设置读取失败沿用默认主题，不影响控制栏动作。
      });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    media?.addEventListener("change", onChange);
    return () => media?.removeEventListener("change", onChange);
  }, []);
  // 主窗切换主题/视觉预设时同步（与通知窗口同一事件协议）。
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void listen<string>("theme-changed", (event) => setThemeSetting(event.payload))
      .then((dispose) => {
        if (disposed) dispose();
        else unlisteners.push(dispose);
      })
      .catch(() => {});
    void listen<string>("visual-preset-changed", (event) =>
      setVisualPreset(event.payload),
    )
      .then((dispose) => {
        if (disposed) dispose();
        else unlisteners.push(dispose);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      for (const dispose of unlisteners) dispose();
    };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolveTheme(themeSetting, { prefersDark });
    root.dataset.preset = resolveVisualPreset(visualPreset);
  }, [prefersDark, themeSetting, visualPreset]);

  // 「更多」面板自动收起：只用一个状态机定时器，避免多 setTimeout 相互覆盖。
  useEffect(() => {
    panelOpenRef.current = panelOpen;
  }, [panelOpen]);
  useEffect(() => {
    const unsubscribe = panelVisibility.subscribe((state) => {
      if (state === "hidden" && panelOpenRef.current) {
        setPanelOpen(false);
        void projectionWindowController.setExpanded(sessionId, false);
      }
    });
    return () => {
      unsubscribe();
      panelVisibility.dispose();
    };
  }, [panelVisibility, sessionId]);

  useEffect(() => {
    return () => {
      if (feedbackTimer.current !== null) {
        window.clearTimeout(feedbackTimer.current);
      }
    };
  }, []);

  const capabilities = session
    ? capabilitiesForSession(session)
    : emptyCapabilities();

  const handleNavigate = async (action: ProjectionNavigationAction) => {
    if (!session || busy) return;
    setBusy(action);
    try {
      const display = await projectionWindowController.navigate(session.id, action);
      flash(
        t("projectionToolbar.navSent", {
          action: t(
            action === "back"
              ? "projectionToolbar.back"
              : action === "home"
                ? "projectionToolbar.home"
                : "projectionToolbar.recents",
          ),
          display,
        }),
      );
    } catch (error) {
      flash(localizedErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const handleScreenshot = async () => {
    if (!session || busy) return;
    setBusy("screenshot");
    try {
      await projectionWindowController.screenshot(session.id);
      flash(t("projectionToolbar.screenshotDone"));
    } catch (error) {
      flash(localizedErrorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const handleClose = async () => {
    if (!session || busy) return;
    setBusy("close");
    try {
      await projectionWindowController.close(session.id);
      // 后端会销毁控制栏窗口；这里不主动关窗，避免关闭请求与收尾竞争。
    } catch (error) {
      flash(localizedErrorMessage(error));
      setBusy(null);
    }
  };

  const handleToggleLock = () => {
    if (!session) return;
    const next = !locked;
    setLocked(next);
    void projectionWindowController.setLocked(session.id, next);
  };

  const handleMore = () => {
    if (!session) return;
    const next = !panelOpen;
    setPanelOpen(next);
    void projectionWindowController.setExpanded(session.id, next);
    if (next) {
      panelVisibility.showToolbar();
      panelVisibility.scheduleToolbarHide();
    } else {
      panelVisibility.cancelToolbarHide();
    }
  };

  const runDiagnostics = async () => {
    if (!session || diagBusy) return;
    setDiagBusy(true);
    try {
      setDiag(await vdDiagnostics(session.serial));
    } catch (error) {
      flash(localizedErrorMessage(error));
    } finally {
      setDiagBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="vd-toolbar is-normal is-visible">
        <div className="vd-toolbar-error" role="alert">
          <ShieldAlert size={16} aria-hidden="true" />
          <span>{loadError}</span>
          <button
            type="button"
            className="vd-toolbar-btn"
            aria-label={t("projectionToolbar.retry")}
            data-tip={t("projectionToolbar.retry")}
            onClick={() => void loadSession()}
          >
            <Loader2 size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="vd-toolbar is-normal is-visible">
        <div className="vd-toolbar-loading" role="status">
          <Loader2 size={16} className="spin" aria-hidden="true" />
        </div>
      </div>
    );
  }

  const deviceId = session.device_uid;
  const displayId = session.display_id ?? undefined;

  return (
    <>
      <ProjectionToolbar
        sessionId={session.id}
        deviceId={deviceId}
        displayId={displayId}
        capabilities={capabilities}
        mode={mode}
        visible
        locked={locked}
        busyAction={busy}
        moreOpen={panelOpen}
        details={
          <div className="vd-toolbar-details-body">
            <div className="vd-toolbar-details-head">
              <strong>{t("projectionToolbar.sessionInfo")}</strong>
            </div>
            <dl className="vd-toolbar-facts">
              <dt>{t("projectionToolbar.mode")}</dt>
              <dd>
                {t(
                  session.mode === "mirror"
                    ? "virtualDisplay.mode.mirror"
                    : "virtualDisplay.mode.virtual",
                )}
              </dd>
              <dt>{t("projectionToolbar.status")}</dt>
              <dd>{t(sessionStatusKey(session.status))}</dd>
              {session.size ? (
                <>
                  <dt>{t("projectionToolbar.resolution")}</dt>
                  <dd>{session.size}</dd>
                </>
              ) : null}
              {session.package ? (
                <>
                  <dt>{t("projectionToolbar.app")}</dt>
                  <dd className="is-wrap">
                    {session.app_label ?? session.package}
                  </dd>
                </>
              ) : null}
              {displayId !== undefined ? (
                <>
                  <dt>{t("projectionToolbar.display")}</dt>
                  <dd>{displayId}</dd>
                </>
              ) : null}
            </dl>
            {diag ? (
              <div className="vd-toolbar-diag" role="status">
                <span>{diag.note}</span>
                {diag.stale_displays.length > 0 ? (
                  <ul>
                    {diag.stale_displays.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <div className="vd-toolbar-details-actions">
              <button
                type="button"
                className="vd-toolbar-action"
                onClick={() => void handleScreenshot()}
                disabled={!capabilities.screenshot || Boolean(busy)}
              >
                {t("projectionToolbar.screenshot")}
              </button>
              <button
                type="button"
                className="vd-toolbar-action"
                onClick={() => void runDiagnostics()}
                disabled={diagBusy}
              >
                {diagBusy ? (
                  <Loader2 size={12} className="spin" aria-hidden="true" />
                ) : (
                  <Stethoscope size={12} aria-hidden="true" />
                )}
                {t("projectionToolbar.diagnostics")}
              </button>
              <button
                type="button"
                className="vd-toolbar-action is-danger"
                onClick={() => void handleClose()}
                disabled={!capabilities.close || Boolean(busy)}
              >
                {t("projectionToolbar.close")}
              </button>
            </div>
          </div>
        }
        onNavigate={(action) => void handleNavigate(action)}
        onScreenshot={() => void handleScreenshot()}
        onClose={() => void handleClose()}
        onToggleLock={handleToggleLock}
        onMore={handleMore}
      />
      {feedback ? (
        <div className="vd-toolbar-toast" role="status">
          {feedback}
        </div>
      ) : null}
    </>
  );
}
