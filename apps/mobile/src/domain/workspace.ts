// 工作区（Project Workspace）领域模型：与桌面端 workspace_projects 的字段语义对齐。
// 本轮移动端没有该表的同步链路，因此这里只定义「未来可填充」的纯类型与标签映射，
// 不包含任何演示数据；页面在缺少真实数据时只能渲染占位。
// 注意：Project Workspace ≠ Planning Project ≠ Scenario Workspace ≠ Dev Workbench。
import type { Capture, Note, Task } from "./types";

export type WorkspaceProjectKind = "development" | "game" | "ai_comic" | "general";
export type WorkspaceProjectStatus = "active" | "archived";

export const WORKSPACE_PROJECT_KIND_LABEL: Record<WorkspaceProjectKind, string> = {
  development: "开发",
  game: "游戏",
  ai_comic: "AI 漫剧",
  general: "通用",
};

export const WORKSPACE_PROJECT_STATUS_LABEL: Record<WorkspaceProjectStatus, string> = {
  active: "进行中",
  archived: "已归档",
};

/** 项目卡只消费真实字段；没有的字段保持 null/undefined，由 UI 如实省略。 */
export interface WorkspaceProjectSummary {
  id: string;
  name: string;
  kind: WorkspaceProjectKind;
  status: WorkspaceProjectStatus;
  /** 项目备注/简介，桌面端可空 */
  note?: string;
  /** 事项总数与已完成数（workspace_items 聚合）；缺省表示未提供，不推算百分比 */
  itemTotal?: number;
  itemDone?: number;
  updatedAt?: number;
}

/**
 * 进度只在「有事项且总数 > 0」时给出；否则返回 null，UI 必须显示数量或状态而不是编造的百分比。
 */
export function projectProgressPercent(project: WorkspaceProjectSummary): number | null {
  if (project.itemTotal == null || project.itemDone == null) return null;
  if (project.itemTotal <= 0) return null;
  const done = Math.max(0, Math.min(project.itemDone, project.itemTotal));
  return Math.round((done / project.itemTotal) * 100);
}

/** 今日专注的任务：逾期最先，其次今天到期，最后按优先级；没有未完成任务返回 null。 */
export function pickFocusTask(tasks: Task[], now: number): Task | null {
  const pending = tasks.filter((task) => task.status === "pending");
  if (pending.length === 0) return null;

  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const startOfDay = start.getTime();
  const endOfDay = startOfDay + 86_400_000;

  const scored = pending.map((task) => {
    const due = task.dueAt;
    let rank: number;
    if (due == null) rank = 2;
    else if (due < startOfDay) rank = 0; // 逾期
    else if (due < endOfDay) rank = 1; // 今天到期
    else rank = 2;
    return { task, rank };
  });

  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.task.priority !== b.task.priority) return b.task.priority - a.task.priority;
    const ad = a.task.dueAt ?? Number.POSITIVE_INFINITY;
    const bd = b.task.dueAt ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return b.task.createdAt - a.task.createdAt;
  });

  return scored[0]?.task ?? null;
}

export type RecentEntryKind = "note" | "capture";

export interface RecentEntry {
  id: string;
  kind: RecentEntryKind;
  title: string;
  snippet: string;
  at: number;
}

/**
 * 最近内容：只聚合手机端真实拥有的数据（笔记 + 收集箱），按时间倒序取前 N 条。
 * 不把文件互传/桌面项目文件混进来冒充同一类内容。
 */
export function buildRecentEntries(
  notes: Note[],
  captures: Capture[],
  limit = 3,
): RecentEntry[] {
  const noteEntries: RecentEntry[] = notes.map((note) => {
    const body = note.body.trim();
    return {
      id: `note-${note.id}`,
      kind: "note" as const,
      title: note.title.trim() || body.split("\n")[0]?.slice(0, 24) || "无标题笔记",
      snippet: body.replace(/\s+/g, " ").slice(0, 60),
      at: note.updatedAt,
    };
  });
  const captureEntries: RecentEntry[] = captures.map((capture) => ({
    id: `capture-${capture.id}`,
    kind: "capture" as const,
    title: capture.content.split("\n")[0]?.slice(0, 24) || "速记",
    snippet: capture.content.replace(/\s+/g, " ").slice(0, 60),
    at: capture.createdAt,
  }));

  return [...noteEntries, ...captureEntries].sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit));
}

/** 首页问候语按本地时间分时段；不拼 emoji，避免 ROM 字形差异。 */
export function homeGreeting(hour: number): string {
  if (hour < 6) return "夜深了，开发者";
  if (hour < 12) return "早上好，开发者";
  if (hour < 18) return "下午好，开发者";
  return "晚上好，开发者";
}

/**
 * 项目卡的可访问/交互语义：只有真正给了 onPress 才是按钮。
 * 无 onPress 的卡片必须明确只读，避免「声明按钮但没有点击行为」。
 */
export function describeProjectCardInteraction(name: string, hasOnPress: boolean) {
  return {
    interactive: hasOnPress,
    accessibilityRole: hasOnPress ? ("button" as const) : ("text" as const),
    accessibilityLabel: hasOnPress ? `项目：${name}` : `项目：${name}，只读`,
    accessibilityState: { disabled: !hasOnPress },
  };
}
