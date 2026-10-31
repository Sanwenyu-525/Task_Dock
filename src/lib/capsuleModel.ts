//! Smart Dock Capsule 信息聚合（纯函数，可测试）。
//!
//! 数据来源（不引入任何新轮询，仅订阅既有 store）：
//! - 待办数：`useTasksStore.stats.pending`（`TaskStats`，事件驱动刷新）；
//! - Agent 状态：`useAgentsStore.snapshot` + `liveSummary()`（既有实时聚合）。
//!
//! 优先级（需求 3.3）：
//! 1. 正常：待办数 > 运行中 Agent 数 > 展开入口；
//! 2. 异常：failed / waiting 提升视觉优先级（`alert`），克制的状态色，不闪烁；
//! 3. 数据未加载显示中性占位 `–`，**不得把未知伪装成 0 或全部正常**；
//! 4. 数字紧凑格式：≤99 两位补零（`05`），>99 显示 `99+`。
//! 胶囊内不出现任务标题、Agent 名称、剪贴板内容、路径等敏感文本。

import type { AgentSnapshot } from "./bridge";
import { liveSummary, type LiveState } from "./agentTree";

export interface CapsuleInfo {
  /** 待办标签：`–`（未加载）| `00`..`99` | `99+` */
  pendingLabel: string;
  pendingLoaded: boolean;
  /** Agent 标签：`–`（未加载）| 运行中数量 */
  agentLabel: string;
  agentsLoaded: boolean;
  running: number;
  worst: LiveState;
  /** 需要用户关注的状态（failed / waiting），正常为 null */
  alert: "failed" | "waiting" | null;
}

/** 紧凑数量格式：≤99 两位补零（05），>99 封顶 99+；负数/非法值按 0 处理。 */
export function formatCapsuleCount(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "–";
  const v = Math.max(0, Math.floor(n));
  return v > 99 ? "99+" : String(v).padStart(2, "0");
}

export function capsuleModel(
  pending: number | null,
  snapshot: AgentSnapshot | null,
  now: number = Date.now(),
): CapsuleInfo {
  const pendingLoaded = typeof pending === "number";
  const agentsLoaded = snapshot !== null;
  const s = liveSummary(snapshot, now);
  const alert = s.worst === "failed" || s.worst === "waiting" ? s.worst : null;
  return {
    pendingLabel: formatCapsuleCount(pendingLoaded ? pending : null),
    pendingLoaded,
    agentLabel: agentsLoaded ? String(s.running) : "–",
    agentsLoaded,
    running: s.running,
    worst: s.worst,
    alert,
  };
}

const ALERT_TEXT: Record<"failed" | "waiting", string> = {
  failed: "有失败任务需要关注",
  waiting: "有 Agent 等待确认",
};

/** 胶囊 aria 标签：读屏可读的完整状态摘要（含停靠边与异常提示）。 */
export function capsuleAriaLabel(edge: string, info: CapsuleInfo): string {
  const edgeText =
    edge === "left" ? "左侧" : edge === "right" ? "右侧" : edge === "top" ? "顶部" : "底部";
  const parts = [
    `展开 Task Dock（已吸附${edgeText}）`,
    info.pendingLoaded ? `待办 ${info.pendingLabel === "99+" ? "99 以上" : Number(info.pendingLabel)}` : "待办未知",
    info.agentsLoaded ? `运行中 Agent ${info.running}` : "Agent 状态未知",
  ];
  if (info.alert) parts.push(ALERT_TEXT[info.alert]);
  return parts.join("，");
}
