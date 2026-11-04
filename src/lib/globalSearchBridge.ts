//! 全局搜索前端桥接：类型镜像、invoke 封装与最近搜索本地持久化。
//!
//! - 类型与 Rust `global_search::GlobalSearchResponse` 逐字段一致（serde 默认 snake_case）。
//! - 最近搜索只存本地（localStorage，≤10 条，去重、最新在前），不发网络、不进运行日志。

import { invokeCommand as invoke } from "./errors";

// ── 类型（与后端 serde 结构一致）─────────────────────────────

export interface GlobalSearchResult {
  id: string;
  category: string;
  kind: string;
  title: string;
  subtitle: string;
  snippet: string;
  occurred_at: string | null;
  status: string | null;
  priority: number | null;
  target_id: string | null;
  parent_id: string | null;
}

export interface GlobalSearchGroup {
  category: string;
  items: GlobalSearchResult[];
  has_more: boolean;
}

export interface GlobalSearchResponse {
  query: string;
  groups: GlobalSearchGroup[];
  total_returned: number;
}

/** 与后端 `global_search::CATEGORIES` 一致；`all` 仅用于前端筛选 UI。 */
export const GLOBAL_SEARCH_CATEGORIES = [
  "tasks",
  "clipboard",
  "capture",
  "shelf",
  "apps",
  "agents",
  "workspace",
  "planning",
  "notes",
] as const;
export type GlobalSearchCategory = (typeof GLOBAL_SEARCH_CATEGORIES)[number];
export type GlobalSearchCategoryFilter = GlobalSearchCategory | "all";

export const GLOBAL_SEARCH_CATEGORY_LABELS: Record<GlobalSearchCategoryFilter, string> = {
  all: "全部",
  tasks: "任务",
  clipboard: "剪贴板",
  capture: "收集箱",
  shelf: "文件暂存",
  apps: "应用",
  agents: "Agent",
  workspace: "工作现场",
  planning: "规划中心",
  notes: "笔记",
};

/** 分类内子类型的中文展示（未列出的 kind 原样显示）。 */
export const GLOBAL_SEARCH_KIND_LABELS: Record<string, string> = {
  task: "任务",
  session: "会话",
  run: "轮次",
  snapshot: "现场",
  project: "项目",
  feature: "功能",
  milestone: "里程碑",
  note: "笔记",
  text: "文本",
  url: "链接",
  html: "网页",
  image: "图片",
  files: "文件",
  idea: "想法",
  todo: "待办",
  link: "链接",
  file: "文件",
  folder: "文件夹",
  application: "应用",
  agent_session: "Agent 会话",
  directory: "目录",
};

// ── 命令封装 ────────────────────────────────────────────────

export function globalSearch(
  query: string,
  categories?: string[] | null,
  limitPerCategory?: number | null,
): Promise<GlobalSearchResponse> {
  return invoke<GlobalSearchResponse>("global_search", {
    query,
    categories: categories ?? null,
    limitPerCategory: limitPerCategory ?? null,
  });
}

// ── 最近搜索（仅本地）────────────────────────────────────────

export const RECENT_SEARCH_KEY = "taskdock.global_search.recent";
export const RECENT_SEARCH_MAX = 10;

export function loadRecentSearches(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCH_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  } catch {
    return [];
  }
}

/** 记录一次搜索：去重（不区分大小写）、最新在前、截断到上限。 */
export function saveRecentSearch(query: string, existing: string[]): string[] {
  const q = query.trim();
  if (!q) return existing;
  const rest = existing.filter((x) => x.toLowerCase() !== q.toLowerCase());
  return [q, ...rest].slice(0, RECENT_SEARCH_MAX);
}

export function persistRecentSearches(list: string[]): void {
  try {
    window.localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(list.slice(0, RECENT_SEARCH_MAX)));
  } catch {
    // 持久化失败不影响搜索功能（隐私与可用性优先于历史记录）。
  }
}

export function clearRecentSearches(): void {
  try {
    window.localStorage.removeItem(RECENT_SEARCH_KEY);
  } catch {
    // 忽略。
  }
}
