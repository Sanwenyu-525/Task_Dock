//! TaskDock 投屏控制栏（独立窗口内容）。
//!
//! 只做 UI 与交互转发：所有动作都通过 props 回调交给 Session 层，
//! 组件本身**不直接调用 Rust**（避免工具栏绕过会话绑定）。
//!
//! - 普通窗口：竖向控制栏，贴在 scrcpy 窗口外侧；
//! - 最大化/全屏：横向控制栏，进入投屏窗口内部；
//! - 最近任务在虚拟屏不受支持时 disabled，并给出原因，不发送 IPC；
//! - 锁定后不参与全屏自动隐藏；「更多」展开当前 Session 的高级操作。

import type { ReactNode } from "react";
import {
  ArrowLeft,
  Camera,
  Home,
  List,
  Loader2,
  Lock,
  LockOpen,
  MoreHorizontal,
  X,
} from "lucide-react";

import { useLocale } from "../../../hooks/useLocale";
import type {
  ProjectionNavigationAction,
  ProjectionWindowMode,
} from "../../../lib/bridge";

export type { ProjectionNavigationAction, ProjectionWindowMode };

export interface ProjectionCapabilities {
  back: boolean;
  home: boolean;
  recents: boolean;
  screenshot: boolean;
  close: boolean;
}

export interface ProjectionToolbarProps {
  sessionId: string;
  deviceId: string;
  displayId?: number;
  capabilities: ProjectionCapabilities;
  mode: ProjectionWindowMode;
  visible: boolean;
  locked: boolean;
  /** 正在执行动作（截图/关闭等）：只禁用对应按钮，不整栏阻塞。 */
  busyAction?: ProjectionNavigationAction | "screenshot" | "close" | null;
  /** 「更多」面板是否展开。 */
  moreOpen?: boolean;
  /** 展开面板内容（会话信息/诊断）；由入口组件注入，保持本组件无业务依赖。 */
  details?: ReactNode;

  onNavigate(action: ProjectionNavigationAction): void;
  onScreenshot(): void;
  onClose(): void;
  onToggleLock(): void;
  onMore(): void;
}

export default function ProjectionToolbar({
  sessionId,
  displayId,
  capabilities,
  mode,
  visible,
  locked,
  busyAction = null,
  moreOpen = false,
  details,
  onNavigate,
  onScreenshot,
  onClose,
  onToggleLock,
  onMore,
}: ProjectionToolbarProps) {
  const { t } = useLocale();

  const handleBack = () => {
    if (!capabilities.back || busyAction) return;
    onNavigate("back");
  };
  const handleHome = () => {
    if (!capabilities.home || busyAction) return;
    onNavigate("home");
  };
  const handleRecents = () => {
    // 能力不支持时绝不发送 IPC（虚拟屏会把最近任务切到实体屏）。
    if (!capabilities.recents || busyAction) return;
    onNavigate("recents");
  };
  const handleScreenshot = () => {
    if (!capabilities.screenshot || busyAction) return;
    onScreenshot();
  };
  const handleClose = () => {
    if (!capabilities.close || busyAction) return;
    onClose();
  };
  const handleToggleLock = () => {
    onToggleLock();
  };
  const handleMore = () => {
    onMore();
  };

  const recentsTip = capabilities.recents
    ? t("projectionToolbar.recents")
    : t("projectionToolbar.recentsUnsupported");

  return (
    <div
      className={`vd-toolbar is-${mode}${visible ? " is-visible" : " is-hidden"}${
        locked ? " is-locked" : ""
      }`}
      data-session={sessionId}
      data-display={displayId ?? undefined}
      role="toolbar"
      aria-label={t("projectionToolbar.label")}
      aria-orientation={mode === "normal" ? "vertical" : "horizontal"}
    >
      {moreOpen && details ? (
        <div className="vd-toolbar-details">{details}</div>
      ) : null}

      <div className="vd-toolbar-bar">
        <button
          type="button"
          className="vd-toolbar-btn"
          aria-label={t("projectionToolbar.back")}
          data-tip={t("projectionToolbar.back")}
          disabled={!capabilities.back || Boolean(busyAction)}
          onClick={handleBack}
        >
          {busyAction === "back" ? (
            <Loader2 size={16} className="spin" aria-hidden="true" />
          ) : (
            <ArrowLeft size={16} aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          className="vd-toolbar-btn"
          aria-label={t("projectionToolbar.home")}
          data-tip={t("projectionToolbar.home")}
          disabled={!capabilities.home || Boolean(busyAction)}
          onClick={handleHome}
        >
          {busyAction === "home" ? (
            <Loader2 size={16} className="spin" aria-hidden="true" />
          ) : (
            <Home size={16} aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          className="vd-toolbar-btn"
          aria-label={recentsTip}
          data-tip={recentsTip}
          disabled={!capabilities.recents || Boolean(busyAction)}
          onClick={handleRecents}
        >
          {busyAction === "recents" ? (
            <Loader2 size={16} className="spin" aria-hidden="true" />
          ) : (
            <List size={16} aria-hidden="true" />
          )}
        </button>

        <span className="vd-toolbar-sep" aria-hidden="true" />

        <button
          type="button"
          className={`vd-toolbar-btn${moreOpen ? " is-active" : ""}`}
          aria-label={t("projectionToolbar.more")}
          aria-expanded={moreOpen}
          data-tip={t("projectionToolbar.more")}
          onClick={handleMore}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>

        <button
          type="button"
          className="vd-toolbar-btn"
          aria-label={t("projectionToolbar.screenshot")}
          data-tip={t("projectionToolbar.screenshot")}
          disabled={!capabilities.screenshot || Boolean(busyAction)}
          onClick={handleScreenshot}
        >
          {busyAction === "screenshot" ? (
            <Loader2 size={16} className="spin" aria-hidden="true" />
          ) : (
            <Camera size={16} aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          className={`vd-toolbar-btn${locked ? " is-active" : ""}`}
          aria-label={
            locked ? t("projectionToolbar.unlock") : t("projectionToolbar.lock")
          }
          aria-pressed={locked}
          data-tip={
            locked ? t("projectionToolbar.unlock") : t("projectionToolbar.lock")
          }
          onClick={handleToggleLock}
        >
          {locked ? (
            <Lock size={16} aria-hidden="true" />
          ) : (
            <LockOpen size={16} aria-hidden="true" />
          )}
        </button>

        <span className="vd-toolbar-sep" aria-hidden="true" />

        <button
          type="button"
          className="vd-toolbar-btn is-danger"
          aria-label={t("projectionToolbar.close")}
          data-tip={t("projectionToolbar.close")}
          disabled={!capabilities.close || Boolean(busyAction)}
          onClick={handleClose}
        >
          {busyAction === "close" ? (
            <Loader2 size={16} className="spin" aria-hidden="true" />
          ) : (
            <X size={16} aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}

/** 控制栏默认能力（入口组件按 Session 状态覆盖）。 */
export function defaultProjectionCapabilities(): ProjectionCapabilities {
  return {
    back: true,
    home: true,
    recents: true,
    screenshot: true,
    close: true,
  };
}

/** 会话状态 → 能力：与后端 `resolve_nav_target` 的拒绝规则保持一致。 */
export function capabilitiesForSession(session: {
  status: string;
  mode: "mirror" | "virtual";
  display_id: number | null;
}): ProjectionCapabilities {
  const running = session.status === "running";
  const navReady =
    running &&
    (session.mode === "mirror" || (session.display_id ?? 0) > 0);
  return {
    back: navReady,
    home: navReady,
    // Android 16 / vivo：虚拟屏的最近任务由系统默认显示器处理，发送会切到实体屏。
    recents:
      navReady && !(session.mode === "virtual" && (session.display_id ?? 0) > 0),
    screenshot: running,
    close: running || session.status === "starting",
  };
}
