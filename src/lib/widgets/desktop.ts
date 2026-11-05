//! 桌面微件窗口协议：主窗口（唯一数据所有者）与独立 WebView 宿主之间的契约。
//!
//! 为什么需要协议而不是共享 Zustand：Tauri 每个窗口是独立 WebView，Zustand 状态
//! 不跨窗口共享。因此：
//! - 主窗口持有任务 / Agent / 提醒 / 专注 / 效率的全部数据与订阅；
//! - 微件窗口只读「带 revision 的快照」，按 revision 丢弃旧消息；
//! - 微件窗口上报拖动/缩放结果，主窗口是布局配置的唯一写入方；
//! - 窗口创建/销毁由 Rust 宿主执行，前端不做窗口轮询。

import type { ActiveReminder, AgentSnapshot, Task, TaskStats } from "../bridge";
import type { EfficiencySnapshot, FocusSnapshot } from "./sources";
import { isWidgetType, resolveDesktopWindowSize, type WidgetSize, type WidgetType } from "./model";

export const WIDGET_EVENTS = {
  /** Rust → 指定微件窗口：业务快照 */
  snapshot: "widget-snapshot",
  /** Rust → 主窗口：微件窗口要求补发快照（启动竞态兜底） */
  request: "widget-snapshot-request",
  /** Rust → 主窗口：微件内点击动作（导航/重试） */
  action: "widget-action",
  /** Rust → 主窗口：窗口几何/置顶变化（已 debounce） */
  bounds: "widget-bounds-changed",
  /** Rust → 主窗口：桌面窗口被关闭（Alt+F4 或窗口内关闭按钮） */
  dismissed: "widget-window-dismissed",
} as const;

export interface TodayTasksSnapshot {
  widgetType: "today-tasks";
  /** 已由后端按「今日到期 + 已逾期且未完成」筛选并排序，不含页面筛选状态。 */
  tasks: Task[];
  stats: TaskStats | null;
  statsError: string | null;
  error: string | null;
  /** 刷新失败但保留了上一次成功数据：界面必须标明可能过期。 */
  stale?: boolean;
  /** 首次查询尚未返回；避免把「加载中」显示成「今天没有任务」。 */
  loading?: boolean;
  configMaxItems: number;
  updatedAt: string;
}

export interface AgentStatusSnapshot {
  widgetType: "agent-status";
  snapshot: AgentSnapshot | null;
  snapshotError: string | null;
  updatedAt: string;
}

export interface NextReminderSnapshot {
  widgetType: "next-reminder";
  items: ActiveReminder[] | null;
  error: string | null;
  updatedAt: string;
}

export interface QuickActionsSnapshot {
  widgetType: "quick-actions";
  updatedAt: string;
}

export interface FocusTimerSnapshot {
  widgetType: "focus-timer";
  /** 模块未接入或暂无数据时为 null；宿主显示「等待接入」，绝不伪造倒计时。 */
  snapshot: FocusSnapshot | null;
  available: boolean;
}

export interface EfficiencySnapshotMessage {
  widgetType: "efficiency";
  snapshot: EfficiencySnapshot | null;
  available: boolean;
}

export type DesktopWidgetSnapshot =
  | TodayTasksSnapshot
  | AgentStatusSnapshot
  | NextReminderSnapshot
  | QuickActionsSnapshot
  | FocusTimerSnapshot
  | EfficiencySnapshotMessage;

export interface WidgetSnapshotEnvelope {
  widgetType: WidgetType;
  revision: number;
  /**
   * 主窗口 WebView 会话标识。主窗重载后 revision 从 0 重新计数，
   * 接收端据 epoch 变化重置 revision 代，避免把新会话快照当旧消息丢弃。
   */
  epoch: string;
  /** 目标窗口实例代际；旧窗口/旧请求产生的快照带旧值，接收端必须丢弃。 */
  generation: number;
  snapshot: DesktopWidgetSnapshot;
}

/** 微件窗口 → 主窗口：请求首帧快照，携带调用窗口自身的代际。 */
export interface WidgetSnapshotRequestEvent {
  widgetType: WidgetType;
  generation: number;
}

/** 接收端已接受的快照水位。 */
export interface WidgetSnapshotGuard {
  epoch: string | null;
  revision: number;
  generation: number | null;
}

export function createSnapshotGuard(): WidgetSnapshotGuard {
  return { epoch: null, revision: -1, generation: null };
}

/**
 * 是否接受这份快照：
 * - 代际必须与接收窗口一致（旧窗口/旧请求被忽略）；
 * - 同一主窗会话内按 revision 去重，重复/迟到快照不重复更新；
 * - 主窗会话切换（重载）时接受并重置水位，不能拿上一会话的 revision 比较。
 */
export function shouldAcceptSnapshot(
  guard: WidgetSnapshotGuard,
  envelope: WidgetSnapshotEnvelope,
  windowGeneration: number | null,
): boolean {
  if (windowGeneration !== null && envelope.generation !== windowGeneration) return false;
  if (guard.generation !== null && envelope.generation !== guard.generation) return false;
  if (guard.epoch !== envelope.epoch) return true;
  return isNewerRevision(guard.revision, envelope.revision);
}

export interface WidgetBoundsReport {
  widgetType: WidgetType;
  width: number;
  height: number;
  nx: number;
  ny: number;
  monitor: string | null;
  topmost: boolean;
  scale: number;
  /**
   * 本次几何变化是否来自用户手动缩放。
   * 程序 set_size / DPI 换算后尺寸与记录一致时为 false，主窗口不得写回自定义尺寸。
   */
  customSize: boolean;
}

export interface WidgetWindowInfo {
  widgetType: WidgetType;
  /** 窗口实例代际：每次重建自增，用于丢弃旧窗口的迟到关闭事件。 */
  generation: number;
  width: number;
  height: number;
  nx: number;
  ny: number;
  monitor: string | null;
  topmost: boolean;
  scale: number;
}

/** 关闭原因：用户关窗 / 管理页关闭桌面显示 / 应用退出 / 异常销毁。 */
export type WidgetDismissReason =
  | "user-close"
  | "management-hide"
  | "app-exit"
  | "destroyed";

export interface WidgetDismissedEvent {
  widgetType: WidgetType;
  generation: number;
  reason: WidgetDismissReason;
  /** 事件发生时间（毫秒），用于判断关闭是否早于用户重新开启的意图。 */
  closedAt: number;
}

export interface WidgetDismissalContext {
  /** 当前已知窗口代际；undefined 表示尚未收到任何 show 结果。 */
  currentGeneration?: number;
  /** 是否有为「新开启意图」创建窗口的任务在途。 */
  pendingOpen: boolean;
  /** 最近一次 false → true 的开启时间（毫秒），0 表示未记录。 */
  lastOpenIntentAt: number;
}

export type WidgetDismissalAction =
  | { kind: "ignore" }
  | { kind: "defer" }
  | { kind: "reopen" }
  | { kind: "pending" }
  | { kind: "management-hide" }
  | { kind: "user-close" }
  | { kind: "destroyed" };

/**
 * 关闭事件分类：只接受当前窗口代际，且用户重新开启意图晚于关闭时间时保留意图。
 * 纯函数便于覆盖「旧窗口销毁晚于新窗口创建」「重复 dismissed」等竞态。
 */
export function classifyWidgetDismissal(
  event: WidgetDismissedEvent,
  context: WidgetDismissalContext,
): WidgetDismissalAction {
  if (event.reason === "app-exit") return { kind: "ignore" };
  const current = context.currentGeneration;
  if (typeof current === "number") {
    if (event.generation < current) return { kind: "ignore" };
    if (event.generation > current) return { kind: "defer" };
  }
  const reopenedAfterClose =
    context.lastOpenIntentAt > 0 &&
    event.closedAt > 0 &&
    context.lastOpenIntentAt >= event.closedAt;
  if (reopenedAfterClose) return { kind: "reopen" };
  if (context.pendingOpen && event.reason !== "management-hide") {
    return { kind: "pending" };
  }
  if (event.reason === "management-hide") return { kind: "management-hide" };
  if (event.reason === "user-close") return { kind: "user-close" };
  return { kind: "destroyed" };
}

export type DesktopActionKind =
  | "open-task"
  | "open-panel"
  | "open-agents"
  | "new-task"
  | "capture"
  | "clipboard"
  | "workflows"
  | "retry-efficiency"
  | "refresh-reminder"
  | "manage-reminders";

export interface WidgetActionEvent {
  widgetType: WidgetType;
  action: DesktopActionKind;
  tab?: string | null;
  taskId?: string | null;
}

export function desktopWindowLabel(type: WidgetType): string {
  return `widget-${type}`;
}

/** 从窗口 label 解析类型：微件宿主不依赖 URL query，避免 WebViewUrl 编码差异。 */
export function typeFromWindowLabel(label: string): WidgetType | null {
  const prefix = "widget-";
  if (!label.startsWith(prefix)) return null;
  const candidate = label.slice(prefix.length);
  return isWidgetType(candidate) ? candidate : null;
}

export function desktopWindowSize(type: WidgetType, size: WidgetSize, desktop?: Parameters<typeof resolveDesktopWindowSize>[2]) {
  return resolveDesktopWindowSize(type, size, desktop);
}

/** revision 只增不减；窗口收到更旧的快照直接忽略（多窗口/重建竞态兜底）。 */
export function isNewerRevision(previous: number, next: number): boolean {
  return Number.isFinite(next) && next > previous;
}

/** 接受后推进水位；同一快照被忽略时水位保持不变。 */
export function advanceSnapshotGuard(envelope: WidgetSnapshotEnvelope): WidgetSnapshotGuard {
  return {
    epoch: envelope.epoch,
    revision: envelope.revision,
    generation: envelope.generation,
  };
}
