// 小组件数据快照：任务/收集箱变化后构建最小快照交给原生（SharedPreferences +
// AppWidgetManager 全量刷新）。快照契约见 docs/mobile/10-widget.md。
//
// 安全边界：快照只含标题（≤60 字）、勾选态、计数、时间戳——绝不写入配对令牌、
// 密钥、同步元数据或正文长文；原生侧也不落任何日志。
// 更新通道：无轮询、无常驻服务，只在应用内数据变化（任务/收集箱增删改）与
// 偏好变化时推送；开机/桌面重建由系统 onUpdate 读同一份快照兜底。
import {
  pushWidgetSnapshot as nativePushSnapshot,
} from "../../modules/taskdock-widget";
import { listCaptures } from "../db/captures";
import { getSetting } from "../db/kv";
import { listTasks } from "../db/tasks";
import { countTasks, selectTasks } from "../domain/taskQuery";
import type { Capture, Task } from "../domain/types";

export type WidgetSize = "2x2" | "4x2" | "4x4";
export type WidgetContent = "today" | "pending" | "captures";
export type WidgetAppearance = "system" | "light" | "dark";

export interface WidgetPrefs {
  size: WidgetSize;
  content: WidgetContent;
  appearance: WidgetAppearance;
}

export const WIDGET_PREFS_KEY = "widget_prefs";

export const DEFAULT_WIDGET_PREFS: WidgetPrefs = {
  size: "4x2",
  content: "today",
  appearance: "system",
};

const SIZE_VALUES: WidgetSize[] = ["2x2", "4x2", "4x4"];
const CONTENT_VALUES: WidgetContent[] = ["today", "pending", "captures"];
const APPEARANCE_VALUES: WidgetAppearance[] = ["system", "light", "dark"];

/** 解析 kv 里的 widget_prefs；损坏/缺省一律回默认值（配置项坏掉不能拖垮小组件） */
export function parseWidgetPrefs(raw: string | null): WidgetPrefs {
  if (!raw) return DEFAULT_WIDGET_PREFS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_WIDGET_PREFS;
    const record = parsed as Record<string, unknown>;
    const size = SIZE_VALUES.includes(record.size as WidgetSize)
      ? (record.size as WidgetSize)
      : DEFAULT_WIDGET_PREFS.size;
    const content = CONTENT_VALUES.includes(record.content as WidgetContent)
      ? (record.content as WidgetContent)
      : DEFAULT_WIDGET_PREFS.content;
    const appearance = APPEARANCE_VALUES.includes(record.appearance as WidgetAppearance)
      ? (record.appearance as WidgetAppearance)
      : DEFAULT_WIDGET_PREFS.appearance;
    return { size, content, appearance };
  } catch {
    return DEFAULT_WIDGET_PREFS;
  }
}

export interface WidgetSnapshotItem {
  /** 标题（首行，≤60 字，超长加省略号） */
  t: string;
  /** 勾选态（收集箱恒 false） */
  done: boolean;
}

/** 快照 JSON 契约（v1）：原生 WidgetRenderer 按此渲染，字段只增不改 */
export interface WidgetSnapshot {
  v: 1;
  updatedAt: number;
  content: WidgetContent;
  appearance: WidgetAppearance;
  /** 今天到期且未完成 */
  todayCount: number;
  /** 全部未完成任务 */
  pendingCount: number;
  /** 收集箱条数（未删除） */
  captureCount: number;
  /** 当前 content 的行，最多 4 条 */
  items: WidgetSnapshotItem[];
  /** 无数据空态文案 */
  empty: string;
}

const TITLE_MAX = 60;
const MAX_ROWS = 4;

function firstLineTruncated(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? text;
  const trimmed = firstLine.trim();
  return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX)}…` : trimmed;
}

function buildItems(content: WidgetContent, tasks: Task[], captures: Capture[], now: number): WidgetSnapshotItem[] {
  if (content === "captures") {
    // listCaptures 已按 created_at DESC 排序，取最新几条
    return captures.slice(0, MAX_ROWS).map((capture) => ({
      t: firstLineTruncated(capture.content),
      done: false,
    }));
  }
  const filter = content === "pending" ? "pending" : "today";
  return selectTasks(tasks, filter, now)
    .slice(0, MAX_ROWS)
    .map((task) => ({ t: firstLineTruncated(task.title), done: task.status === "completed" }));
}

export async function buildWidgetSnapshot(prefsOverride?: WidgetPrefs): Promise<WidgetSnapshot> {
  const now = Date.now();
  const [tasks, captures, rawPrefs] = await Promise.all([
    listTasks(),
    listCaptures(),
    getSetting(WIDGET_PREFS_KEY),
  ]);
  const prefs = prefsOverride ?? parseWidgetPrefs(rawPrefs);
  const counts = countTasks(tasks, now);
  const items = buildItems(prefs.content, tasks, captures, now);
  const empty =
    prefs.content === "captures"
      ? "收集箱是空的"
      : prefs.content === "pending"
        ? "没有待办任务"
        : "今天没有到期任务";

  return {
    v: 1,
    updatedAt: now,
    content: prefs.content,
    appearance: prefs.appearance,
    todayCount: counts.dueToday,
    pendingCount: counts.pending,
    captureCount: captures.length,
    items,
    empty,
  };
}

/**
 * 构建并推送快照（写 SharedPreferences + 刷新全部实例）。
 * 返回快照本身：WidgetScreen 的预览复用同一份数据（原生缺失时预览仍可用）。
 * 失败返回 null：小组件刷新是增强能力，不允许拖垮调用方。
 */
export async function refreshWidgetSnapshot(prefsOverride?: WidgetPrefs): Promise<WidgetSnapshot | null> {
  try {
    const snapshot = await buildWidgetSnapshot(prefsOverride);
    nativePushSnapshot(JSON.stringify(snapshot));
    return snapshot;
  } catch {
    return null;
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 预览实际展示的内容口径：以快照为准。
 *
 * 偏好与快照可能瞬时不同步（例如重新进入页面时偏好还没读回、快照已是上次构建的
 * 内容）。标题、计数与行必须来自同一份数据，否则会出现「待办 0」但下面列着待办行。
 */
export function resolvePreviewContent(
  prefsContent: WidgetContent,
  snapshot: WidgetSnapshot | null,
): WidgetContent {
  return snapshot?.content ?? prefsContent;
}

/** 预览头部计数：必须与 resolvePreviewContent 的内容同源。 */
export function previewCount(
  content: WidgetContent,
  snapshot: WidgetSnapshot | null,
): number {
  if (!snapshot) return 0;
  if (content === "captures") return snapshot.captureCount;
  if (content === "pending") return snapshot.pendingCount;
  return snapshot.todayCount;
}


/** 数据变化后刷新小组件：去抖 400ms，连续变更（勾选+列表刷新）只读库推送一次。 */
export function notifyWidgetDataChanged(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void refreshWidgetSnapshot();
  }, 400);
}
