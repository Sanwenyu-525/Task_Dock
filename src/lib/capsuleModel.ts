//! 分类胶囊的信息聚合（纯函数，可测试）。
//!
//! 数据来源（不引入任何新轮询，仅订阅既有 store）：
//! - 待办/逾期：`useTasksStore.stats`（`TaskStats`，事件驱动刷新）；
//! - Agent 状态：`useAgentsStore.snapshot` + `liveSummary()`（既有实时聚合）。
//!
//! 原则：
//! 1. **真实数据**：未加载显示中性占位，绝不把未知伪装成 0 或「全部正常」；
//! 2. **只报需要处理的事**：Agent 徽标 = 等待确认 + 失败的数量（不是累计消息数，
//!    也不是历史运行总数），运行中用状态色而非数字表达，避免数字只增不减；
//! 3. 轨道常驻，不出现任务标题、Agent 名称、剪贴板正文、路径等敏感文本；
//! 4. 数量紧凑：≤99 原样，>99 显示 `99+`。

import type { AgentSnapshot, TaskStats } from "./bridge";
import { liveSummary, type LiveState } from "./agentTree";

export type RailCategory = "tasks" | "agents" | "clipboard" | "apps";

export const RAIL_CATEGORIES: readonly RailCategory[] = ["tasks", "agents", "clipboard", "apps"];

/** 轨道状态色调：中性 / 运行 / 等待 / 失败 / 失联。 */
export type RailTone = "idle" | "running" | "waiting" | "failed" | "disconnected";

export interface RailStatus {
  /** 顶部 Agent 总状态按钮的色调（worst of live runs） */
  agentTone: RailTone;
  /** 需要用户处理的数量：waiting + failed */
  agentAttention: number;
  /** 正在运行的数量（用于 aria 与提示，不做徽标） */
  agentRunning: number;
  /** Agent 快照是否已加载（false 时显示中性占位） */
  agentsLoaded: boolean;
  /** 待办徽标文本；0 或未加载时为 null（不显示无意义的 0） */
  taskBadge: string | null;
  pending: number | null;
  overdue: number;
  /** 任务统计是否已加载 */
  tasksLoaded: boolean;
}

/** 紧凑数量：≤99 原样，>99 显示 99+；非法值按 0。 */
export function compactCount(n: number | null): string | null {
  if (n === null || !Number.isFinite(n)) return null;
  const v = Math.max(0, Math.floor(n));
  if (v === 0) return null;
  return v > 99 ? "99+" : String(v);
}

/** 两位数补零格式（`–` 表示未加载）——保留给需要固定宽度的旧调用方。 */
export function formatCapsuleCount(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "–";
  const v = Math.max(0, Math.floor(n));
  return v > 99 ? "99+" : String(v).padStart(2, "0");
}

/** 轨道状态聚合。`stats`/`snapshot` 为 null 表示尚未加载（显示中性态）。 */
export function railStatus(
  stats: TaskStats | null,
  snapshot: AgentSnapshot | null,
  now: number = Date.now(),
): RailStatus {
  const s = liveSummary(snapshot, now);
  const tone: RailTone =
    s.worst === "failed" || s.worst === "waiting" || s.worst === "running" || s.worst === "disconnected"
      ? s.worst
      : "idle";
  return {
    agentTone: tone,
    agentAttention: s.waiting + s.failed,
    agentRunning: s.running,
    agentsLoaded: snapshot !== null,
    taskBadge: compactCount(stats?.pending ?? null),
    pending: typeof stats?.pending === "number" ? stats.pending : null,
    overdue: stats?.overdue ?? 0,
    tasksLoaded: stats !== null,
  };
}

/** 顶部 Agent 总状态按钮的 aria 文案（读屏可读的完整摘要）。 */
export function agentSummaryLabel(st: RailStatus): string {
  if (!st.agentsLoaded) return "Agent 状态未知";
  if (st.agentTone === "failed") return `有 ${st.agentAttention} 个 Agent 需要处理（含失败）`;
  if (st.agentTone === "waiting") return `${st.agentAttention} 个 Agent 等待确认`;
  if (st.agentTone === "running") return `${st.agentRunning} 个 Agent 正在运行`;
  if (st.agentTone === "disconnected") return "Agent 连接中断";
  return "Agent 空闲";
}

const EDGE_TEXT: Record<string, string> = {
  left: "左侧",
  right: "右侧",
  top: "顶部",
  bottom: "底部",
};

/** 轨道容器 aria 标签。 */
export function railAriaLabel(edge: string, st: RailStatus): string {
  const parts = [`Task Dock 分类胶囊（已吸附${EDGE_TEXT[edge] ?? "屏幕边缘"}）`];
  parts.push(st.tasksLoaded ? `待办 ${st.pending ?? 0}` : "待办未知");
  parts.push(agentSummaryLabel(st));
  return parts.join("，");
}

// ── 兼容：旧版隐藏态短胶囊的信息模型 ────────────────────────
//
// v0.7 分类胶囊取代了隐藏态短胶囊（32×120 的状态条）。`capsuleModel`
// 仍保留：它把「未加载 → 中性占位、异常 → alert」的判定口径集中在一处，
// 供 `railStatus` 之外的调用方（以及历史单测）复用，避免同一套规则写两遍。

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

/** 旧版胶囊 aria 标签（保留给历史调用方与单测）。 */
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
