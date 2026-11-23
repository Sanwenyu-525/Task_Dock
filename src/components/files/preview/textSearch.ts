//! 文件内搜索（纯前端，不触发任何文件读取 IPC）。
//!
//! 预算与边界：
//! - 查询串最多 `MAX_SEARCH_QUERY` 个字符，超出部分截断（输入框同步限制）；
//! - 命中最多 `MAX_SEARCH_MATCHES` 条，超出即停止扫描并标记 `truncated`；
//! - 内容超过 `MAX_SEARCH_CHARS` 时只扫描前缀并标记 `truncated`，不把整段
//!   内容复制多份（大小写不敏感只做一次小写化，正则自带 `i` 更省内存）；
//! - 索引与行号在同一遍扫描里算完，调用方不再二次遍历。

export interface TextMatch {
  /** 命中在原文中的起始偏移（含）。 */
  start: number;
  /** 结束偏移（不含）。 */
  end: number;
  /** 1 基行号。 */
  line: number;
}

export interface TextSearchOptions {
  caseSensitive?: boolean;
}

export interface TextSearchResult {
  /** 实际生效的查询串（可能被截断）。 */
  query: string;
  matches: TextMatch[];
  /** 达到命中/长度预算：数量与实际命中数不一致。 */
  truncated: boolean;
}

export const MAX_SEARCH_QUERY = 200;
export const MAX_SEARCH_MATCHES = 500;
export const MAX_SEARCH_CHARS = 2_000_000;

/**
 * 统一换行口径：展示、搜索、Markdown 解析都基于同一份 LF 文本，
 * 否则 CRLF 文件里搜索命中偏移与渲染行偏移会相差每行 1 个字符。
 * 复制内容仍使用原始读取结果（不改写用户文件）。
 */
export function normalizeNewlines(text: string): string {
  return text.indexOf("\r") < 0 ? text : text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 查找全部命中。空查询返回空结果（调用方据此清除高亮）。
 * 不抛错：非法正则字符全部转义，查询串只按字面量匹配。
 */
export function findTextMatches(
  content: string,
  query: string,
  options: TextSearchOptions = {},
): TextSearchResult {
  const trimmed = query.slice(0, MAX_SEARCH_QUERY);
  if (!content || !trimmed) return { query: trimmed, matches: [], truncated: false };

  const haystack = content.length > MAX_SEARCH_CHARS ? content.slice(0, MAX_SEARCH_CHARS) : content;
  const scanTruncated = haystack.length !== content.length;
  const pattern = new RegExp(escapeRegExp(trimmed), options.caseSensitive ? "g" : "gi");
  const matches: TextMatch[] = [];
  let line = 1;
  let lineCursor = 0;
  let match: RegExpExecArray | null;
  let truncated = scanTruncated;

  while ((match = pattern.exec(haystack))) {
    if (match[0].length === 0) {
      // 理论上不可达（查询串非空），仍保证循环前进。
      pattern.lastIndex += 1;
      continue;
    }
    // 行号：只统计上一命中之后到当前命中之间的换行，整体 O(n)。
    for (let i = lineCursor; i < match.index; i += 1) {
      if (haystack.charCodeAt(i) === 10) line += 1;
    }
    lineCursor = match.index;
    matches.push({ start: match.index, end: match.index + match[0].length, line });
    if (matches.length >= MAX_SEARCH_MATCHES) {
      truncated = true;
      break;
    }
  }

  return { query: trimmed, matches, truncated };
}

/**
 * 上一个/下一个命中索引（循环）。
 * `currentIndex < 0` 表示尚未定位：向下从 0 开始，向上从末条开始。
 * 无命中返回 -1（调用方不移动滚动位置）。
 */
export function getNextMatch(
  matches: readonly TextMatch[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (matches.length === 0) return -1;
  if (currentIndex < 0 || currentIndex >= matches.length) {
    return direction === 1 ? 0 : matches.length - 1;
  }
  return (currentIndex + direction + matches.length) % matches.length;
}

export interface VisibleOptions {
  scrollTop: number;
  viewportHeight: number;
  lineHeight: number;
  /** 命中行之前是否还有固定头部（如 Markdown 阅读模式的块间距）；默认 0。 */
  offset?: number;
}

/**
 * 当前视口覆盖的命中区间 `[start, end)`（用于「只渲染可见命中」的预算控制）。
 * 行高未知（<=0）时返回全部命中，让调用方自行处理。
 */
export function getVisibleMatchRange(
  matches: readonly TextMatch[],
  options: VisibleOptions,
): { start: number; end: number } {
  const { scrollTop, viewportHeight, lineHeight } = options;
  if (matches.length === 0) return { start: 0, end: 0 };
  if (lineHeight <= 0 || viewportHeight <= 0) return { start: 0, end: matches.length };

  const offset = options.offset ?? 0;
  const firstLine = Math.max(0, (scrollTop - offset) / lineHeight) + 1;
  const lastLine = (scrollTop + viewportHeight - offset) / lineHeight + 1;

  // 行号随 start 单调递增：二分定位首尾，避免长文件每次滚动线性扫描。
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (matches[mid].line < firstLine) low = mid + 1;
    else high = mid;
  }
  const start = low;
  low = start;
  high = matches.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (matches[mid].line <= lastLine) low = mid + 1;
    else high = mid;
  }
  return { start, end: low };
}
