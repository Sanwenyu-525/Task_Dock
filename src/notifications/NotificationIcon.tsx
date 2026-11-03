//! 状态图标映射：六种状态 + 提醒/摘要复用 Lucide 图标体系。
//! 语义由 图标 + 标题 + 颜色 共同表达，不单靠颜色区分状态（无障碍要求）。

import {
  Bell,
  CircleCheck,
  CirclePause,
  CircleX,
  Info,
  Layers,
  Link2Off,
  LoaderCircle,
} from "lucide-react";
import type { NotificationKind } from "./notificationTypes";
import { normalizeKind } from "./notificationUtils";

const KIND_ICON = {
  agent_running: LoaderCircle,
  agent_waiting: CirclePause,
  agent_done: CircleCheck,
  agent_failed: CircleX,
  agent_disconnected: Link2Off,
  digest: Layers,
  reminder: Bell,
  generic: Info,
} as const;

export default function NotificationIcon({
  kind,
  size = 24,
}: {
  kind: string;
  size?: number;
}) {
  const normalized = normalizeKind(kind);
  const Icon = KIND_ICON[normalized] ?? Info;
  return (
    <span className={`ntf-status-icon tone-${normalized}`} aria-hidden="true">
      <Icon
        size={size}
        strokeWidth={2.5}
        className={`ntf-status-glyph${normalized === "agent_running" ? " ntf-spin" : ""}`}
      />
    </span>
  );
}

export function kindAriaLabel(kind: string): string {
  switch (normalizeKind(kind)) {
    case "agent_running":
      return "Agent 正在执行";
    case "agent_waiting":
      return "Agent 等待你的操作";
    case "agent_done":
      return "任务已完成";
    case "agent_failed":
      return "任务执行失败";
    case "agent_disconnected":
      return "Agent 连接中断";
    case "digest":
      return "多条通知已合并";
    case "reminder":
      return "任务提醒";
    default:
      return "通知";
  }
}

export type { NotificationKind };
