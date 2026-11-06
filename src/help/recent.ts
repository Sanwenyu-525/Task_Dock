//! 最近浏览的教程（localStorage，容量上限 8 条）。
//!
//! 尊重「帮助中心不引入常驻后台」：只在用户打开教程时写入一次、进入帮助中心时
//! 读取一次，没有定时器、没有事件订阅；存储不可用（隐私模式/配额满）时静默降级
//! 为不记录，不影响功能。

import { HELP_ARTICLES } from "./content";
import type { HelpArticle } from "./types";

const RECENT_STORAGE_KEY = "taskdock.help.recent.v1";
const RECENT_MAX = 8;

/** 读取最近浏览的文章 ID（新→旧）；损坏数据视为空并清掉坏键。 */
export function readRecentArticleIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      localStorage.removeItem(RECENT_STORAGE_KEY);
      return [];
    }
    const ids = parsed
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .filter((id, index, arr) => arr.indexOf(id) === index)
      .slice(0, RECENT_MAX);
    return ids;
  } catch {
    return [];
  }
}

/** 记录一次浏览：置顶并去重，超限淘汰最旧。返回更新后的 ID 列表。 */
export function recordRecentArticle(articleId: string): string[] {
  try {
    const next = [articleId, ...readRecentArticleIds().filter((id) => id !== articleId)].slice(
      0,
      RECENT_MAX,
    );
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
    return next;
  } catch {
    return readRecentArticleIds();
  }
}

/** 清空浏览记录（帮助中心「清除浏览记录」按钮）。 */
export function clearRecentArticles(): void {
  try {
    localStorage.removeItem(RECENT_STORAGE_KEY);
  } catch {
    // 存储不可用：内存态已由调用方更新，无历史可清。
  }
}

/** 把最近 ID 解析回仍存在的文章（文章被删除/改名后自动消失，不报错）。 */
export function recentArticles(ids: readonly string[]): HelpArticle[] {
  return ids
    .map((id) => HELP_ARTICLES.find((article) => article.id === id))
    .filter((article): article is HelpArticle => article !== undefined);
}
