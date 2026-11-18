//! 投屏控制栏窗口入口：渲染当前 Session 的导航控制（一体化子窗口 WebView）。
//!
//! 本 WebView 是 scrcpy 投屏窗口的 WS_CHILD（见 projection_window.rs）：
//! 生命周期/遮挡/最小化跟随父窗口，窗口不再有独立置顶或外置定位逻辑。
//! 本组件只负责：
//! - 读取窗口 label 中的 sessionId 并订阅 `vd-toolbar-state` 布局广播；
//! - 把按钮动作经 projectionWindowController 转发（navigate 走统一派发入口）；
//! - 「更多」面板展示会话信息、真实诊断与结束投屏。

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";

import { localizedErrorMessage } from "../i18n/errors";
import { useLocale } from "../hooks/useLocale";
import { resolveTheme, resolveVisualPreset } from "../lib/theme";
import { getSettings, vdDiagnostics, type VdDiagnostics } from "../lib/bridge";
import { projectionWindowController } from "../components/mobile/virtual-display/projection-window-controller";
import {
  ProjectionMoreMenu,
  ProjectionTooltipLayer,
  ProjectionToolbar,
  useProjectionLayout,
  useProjectionSessionId,
  useProjectionToolbarCapabilities,
} from "../components/mobile/virtual-display/projection-controls";

const FEEDBACK_MS = 2200;
type BusyAction = string | null;

export default function ToolbarApp() {
  const { t } = useLocale();
  const sessionId = useProjectionSessionId();
  const layout = useProjectionLayout();
  const { session, capabilities, loadError, reload } =
    useProjectionToolbarCapabilities(sessionId);

  const [busy, setBusy] = useState<BusyAction>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [diag, setDiag] = useState<VdDiagnostics | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((message: string) => {
    setFeedback(message);
    if (feedbackTimer.current !== null) {
      clearTimeout(feedbackTimer.current);
    }
    feedbackTimer.current = setTimeout(() => {
      feedbackTimer.current = null;
      setFeedback(null);
    }, FEEDBACK_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimer.current !== null) {
        clearTimeout(feedbackTimer.current);
      }
    };
  }, []);

  // 主题：与通知窗口同一套解析，落 html[data-theme][data-preset]。
  const [themeSetting, setThemeSetting] = useState("system");
  const [visualPreset, setVisualPreset] = useState<string | null>(null);
  const [prefersDark, setPrefersDark] = useState(
    () =>
      typeof window !== "undefined" &&
      Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches),
  );
  useEffect(() => {
    let disposed = false;
    void getSettings()
      .then((settings) => {
        if (!disposed) {
          setThemeSetting(settings.theme);
          setVisualPreset(settings.visual_preset);
        }
      })
      .catch(() => {
        // 设置读取失败沿用默认主题，不影响控制栏动作。
      });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    media?.addEventListener("change", onChange);
    return () => {
      disposed = true;
      media?.removeEventListener("change", onChange);
    };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolveTheme(themeSetting, { prefersDark });
    root.dataset.preset = resolveVisualPreset(visualPreset);
  }, [prefersDark, themeSetting, visualPreset]);

  const handleNavigate = useCallback(
    async (action: "back" | "home" | "recents") => {
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
    },
    [busy, flash, session, t],
  );

  const handleScreenshot = useCallback(async () => {
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
  }, [busy, flash, session, t]);

  const handleEnd = useCallback(async () => {
    if (!session || busy) return;
    setBusy("end");
    try {
      await projectionWindowController.close(session.id);
      // 后端会销毁控制栏子窗口；这里不主动关窗，避免关闭请求与收尾竞争。
    } catch (error) {
      flash(localizedErrorMessage(error));
      setBusy(null);
    }
  }, [busy, flash, session, t]);

  const handleDiagnostics = useCallback(async () => {
    if (!session || diagBusy) return;
    setDiagBusy(true);
    try {
      setDiag(await vdDiagnostics(session.serial));
    } catch (error) {
      setDiag({
        owned_sessions: 0,
        stale_displays: [],
        note: localizedErrorMessage(error),
      });
    } finally {
      setDiagBusy(false);
    }
  }, [diagBusy, session]);

  const handleToggleMore = useCallback((open: boolean) => {
    setMoreOpen(open);
    if (!open) {
      setDiag(null);
    }
  }, []);

  if (loadError) {
    return (
      <div className="projection-error" role="alert">
        <ShieldAlert size={16} aria-hidden="true" />
        <span>
          {loadError === "no-session"
            ? t("projectionToolbar.noSession")
            : t("projectionToolbar.retry")}
        </span>
        <button
          type="button"
          className="projection-control-button"
          aria-label={t("projectionToolbar.retry")}
          onClick={reload}
        >
          <Loader2 size={16} aria-hidden="true" />
        </button>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="projection-loading" role="status">
        <Loader2 size={16} className="spin" aria-hidden="true" />
      </div>
    );
  }

  return (
    <ProjectionTooltipLayer
      viewportWidth={layout.viewport.width}
      viewportHeight={layout.viewport.height}
      layoutMode={layout.layoutMode}
    >
      <ProjectionToolbar
        sessionId={session.id}
        session={{
          mode: session.mode,
          status: session.status,
          size: session.size,
          package: session.package,
          app_label: session.app_label,
          display_id: session.display_id,
        }}
        capabilities={capabilities}
        layoutMode={layout.layoutMode}
        busyAction={busy}
        moreOpen={moreOpen}
        onNavigate={(action: "back" | "home" | "recents") => void handleNavigate(action)}
        onScreenshot={() => void handleScreenshot()}
        onToggleMore={handleToggleMore}
        moreMenu={
          <ProjectionMoreMenu
            capabilities={capabilities}
            busyAction={busy}
            session={session}
            diagBusy={diagBusy}
            diagNote={diag?.note ?? null}
            onRunDiagnostics={() => void handleDiagnostics()}
            onEnd={() => void handleEnd()}
          />
        }
      />
      {feedback ? (
        <div className="projection-toast" role="status">
          {feedback}
        </div>
      ) : null}
    </ProjectionTooltipLayer>
  );
}
