//! 投屏控制栏布局/能力 Hooks（任务十三）。
//!
//! - 事件订阅只挂一次、卸载即清理，绝不轮询后端；
//! - 布局模式由 Rust `update_projection_layout` 广播，前端只消费不重算；
//! - 会话能力从 `vd_session` 快照推导（与后端拒绝规则同源），不读全局状态。

import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  vdSession,
  type ProjectionToolbarState,
  type VdSession,
} from "../../../../lib/bridge";
import {
  capabilitiesForSession,
  type ProjectionCapabilities,
} from "./types-capabilities";

const STATE_EVENT = "vd-toolbar-state";

export interface ProjectionLayoutState {
  windowMode: "normal" | "maximized" | "fullscreen";
  layoutMode: "side" | "bottom" | "compact";
  dpiScale: number;
  /** WebView 视口（CSS px），Tooltip/菜单钳制与翻转用；resize 跟随。 */
  viewport: { width: number; height: number };
}

const DEFAULT_LAYOUT: ProjectionLayoutState = {
  windowMode: "normal",
  layoutMode: "side",
  dpiScale: 1,
  viewport: { width: 0, height: 0 },
};

/** 订阅后端布局广播 + 视口尺寸。Session 无关（控制栏窗口本身即绑定）。 */
export function useProjectionLayout(): ProjectionLayoutState {
  const [state, setState] = useState<ProjectionLayoutState>(DEFAULT_LAYOUT);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ProjectionToolbarState>(STATE_EVENT, (event: { payload?: ProjectionToolbarState }) => {
      const payload = event.payload;
      if (!payload) return;
      setState((previous) => ({
        ...previous,
        windowMode: payload.window_mode,
        layoutMode: payload.layout_mode,
        dpiScale: payload.dpi_scale,
      }));
    })
      .then((dispose: () => void) => {
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
  }, []);

  // 视口尺寸：resize 时更新（Tooltip 翻转/钳制依据），卸载清理。
  useEffect(() => {
    const update = () => {
      setState((previous) => ({
        ...previous,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
      }));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return state;
}

/** 会话能力：加载一次 + 会话状态变化时重算；组件卸载不关闭投屏会话。 */
export function useProjectionToolbarCapabilities(sessionId: string): {
  session: VdSession | null;
  capabilities: ProjectionCapabilities;
  loadError: string | null;
  reload(): void;
} {
  const [session, setSession] = useState<VdSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let disposed = false;
    if (!sessionId) {
      setLoadError("no-session");
      return;
    }
    void vdSession(sessionId)
      .then((next) => {
        if (!disposed) {
          setSession(next);
          setLoadError(null);
        }
      })
      .catch(() => {
        if (!disposed) setLoadError("load-failed");
      });
    return () => {
      disposed = true;
    };
  }, [sessionId, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const capabilities = useMemo(
    () =>
      session
        ? capabilitiesForSession(session)
        : { back: false, home: false, recents: false, screenshot: false, close: false },
    [session],
  );
  return { session, capabilities, loadError, reload };
}

/** 当前窗口 label（`vd-toolbar-<id>`）；浏览器预览回退查询参数。 */
export function useProjectionSessionId(): string {
  return useMemo(() => {
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
  }, []);
}
