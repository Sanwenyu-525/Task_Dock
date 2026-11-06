//! 帮助教程注册中心：全部文章的唯一清单与只读查询/搜索。
//!
//! 边界：
//! - 只聚合 `src/help/content/` 下的内容文件并按分类索引；不做路由、不持有 UI 状态；
//! - `relatedFeatureIds` / `relatedRouteIds` 只保存 ID，渲染时由 UI 层对照
//!   featureCatalog / navigationRegistry 解析（契约测试锁定 ID 必须存在）；
//! - 搜索为纯函数（关键词匹配 title / keywords / 正文），无后台索引、无轮询；
//! - 最近浏览记录见 `recent.ts`（localStorage，容量上限，无常驻任务）。

import { HELP_ARTICLES } from "./content";
import type { HelpArticle, HelpLocale, HelpSection } from "./types";

export { HELP_ARTICLES };

/** 全部文章（content/index 聚合顺序）。 */
export function allHelpArticles(): readonly HelpArticle[] {
  return HELP_ARTICLES;
}

/** 按 ID 查文章；ID 不存在返回 undefined（调用方按未知 ID 处理，不猜测）。 */
export function getHelpArticle(id: string): HelpArticle | undefined {
  return HELP_ARTICLES.find((article) => article.id === id);
}

/** 按分类取文章（保持注册顺序）。 */
export function articlesByCategory(categoryId: string): HelpArticle[] {
  return HELP_ARTICLES.filter((article) => article.categoryId === categoryId);
}

/** 指定语言的正文；该语言缺失时回退 zh-CN（UI 负责展示「暂无英文版」徽标）。 */
export function helpContent(
  article: HelpArticle,
  locale: HelpLocale,
): HelpArticle["translations"]["zh-CN"] {
  return article.translations[locale] ?? article.translations["zh-CN"];
}

/** 该文章在指定语言下是否有原生翻译（zh-CN 恒有，由契约测试强制）。 */
export function hasNativeTranslation(article: HelpArticle, locale: HelpLocale): boolean {
  return locale === "zh-CN" ? true : article.translations["en-US"] !== undefined;
}

/** 拼接单语言的全部可搜索文本：标题 + 摘要 + 正文 + 关键词，统一小写。 */
export function articleSearchText(article: HelpArticle, locale: HelpLocale): string {
  const content = helpContent(article, locale);
  const keywords = article.keywords[locale] ?? article.keywords["zh-CN"] ?? [];
  const sections = content.sections
    .map((section) => sectionText(section))
    .join(" ");
  return [content.title, content.summary, sections, ...keywords]
    .join(" ")
    .toLowerCase();
}

function sectionText(section: HelpSection): string {
  return section.type === "steps" ? section.items.join(" ") : section.text;
}

/**
 * 关键词搜索：命中标题 / 关键词 / 正文（大小写不敏感，子串匹配）。
 * 空查询返回空数组（调用方应改为按分类浏览）。
 * 排序：标题命中 > 关键词命中 > 正文命中；同级保持注册顺序（稳定）。
 */
export function searchHelpArticles(query: string, locale: HelpLocale): HelpArticle[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const scored: { article: HelpArticle; rank: number }[] = [];
  for (const article of HELP_ARTICLES) {
    const content = helpContent(article, locale);
    const keywords = article.keywords[locale] ?? article.keywords["zh-CN"] ?? [];
    const title = content.title.toLowerCase();
    const summary = content.summary.toLowerCase();
    let rank: number;
    if (title.includes(needle)) rank = 3;
    else if (keywords.some((k) => k.toLowerCase().includes(needle))) rank = 2;
    else if (summary.includes(needle) || articleSearchText(article, locale).includes(needle))
      rank = 1;
    else continue;
    scored.push({ article, rank });
  }
  return scored.sort((a, b) => b.rank - a.rank).map((entry) => entry.article);
}

/** 文章的「复制操作步骤」纯文本：无 steps 段落时返回 null（按钮隐藏）。 */
export function articleStepsText(article: HelpArticle, locale: HelpLocale): string | null {
  const content = helpContent(article, locale);
  const steps = content.sections.filter((section) => section.type === "steps");
  if (steps.length === 0) return null;
  const lines: string[] = [`${content.title} — 操作步骤`];
  for (const section of steps) {
    if (section.type !== "steps") continue;
    section.items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`);
    });
  }
  return lines.join("\n");
}
