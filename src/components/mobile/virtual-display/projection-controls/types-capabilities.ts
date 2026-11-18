//! 能力推导（与后端 `resolve_nav_target` 拒绝规则保持一致；从 ProjectionToolbar 迁出）。

import type { ProjectionCapabilities, ProjectionLayoutModeUi } from "./types";

/** 会话状态 → 能力。虚拟屏的最近任务禁用（会切到实体屏），禁用时给出原因。 */
export function capabilitiesForSession(session: {
  status: string;
  mode: "mirror" | "virtual";
  display_id: number | null;
}): ProjectionCapabilities {
  const running = session.status === "running";
  const navReady =
    running && (session.mode === "mirror" || (session.display_id ?? 0) > 0);
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

export function defaultProjectionCapabilities(): ProjectionCapabilities {
  return {
    back: true,
    home: true,
    recents: true,
    screenshot: true,
    close: true,
  };
}

export type { ProjectionCapabilities, ProjectionLayoutModeUi };
