//! 把「语义 token」与「搜索命中」合成为 React 节点。
//!
//! 单一渲染通道：文本/代码源、Markdown 阅读模式的行内文本都走这里，
//! 保证「高亮不改变原文字符」「命中与 token 边界交叉时仍精确标注」。
//! 只生成 React 文本节点与 `<span>/<mark>`，绝不使用 `dangerouslySetInnerHTML`。

import type { ReactNode } from "react";
import type { SourceToken } from "./codeHighlight";
import type { TextMatch } from "./textSearch";

/** 二分找到第一个可能与 `[start, end)` 相交的命中下标。 */
function lowerBound(matches: readonly TextMatch[], start: number): number {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (matches[mid].end <= start) low = mid + 1;
    else high = mid;
  }
  return low;
}

export interface IndexedMatch {
  index: number;
  match: TextMatch;
}

/** 与给定区间相交的命中（按 start 升序）。 */
export function findMatchesInRange(
  matches: readonly TextMatch[],
  start: number,
  end: number,
): IndexedMatch[] {
  if (matches.length === 0 || end <= start) return [];
  const result: IndexedMatch[] = [];
  for (let i = lowerBound(matches, start); i < matches.length; i += 1) {
    const match = matches[i];
    if (match.start >= end) break;
    result.push({ index: i, match });
  }
  return result;
}

/**
 * 渲染一段原文，命中处包 `<mark>`。
 * `textStart` 是这段文本在整份内容中的绝对偏移；`matches` 必须按 start 升序。
 */
export function renderTextWithMatches(
  text: string,
  textStart: number,
  matches: readonly TextMatch[],
  activeIndex: number,
): ReactNode {
  if (!text) return null;
  const hits = findMatchesInRange(matches, textStart, textStart + text.length);
  if (hits.length === 0) return text;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const hit of hits) {
    const from = Math.max(0, hit.match.start - textStart);
    const to = Math.min(text.length, hit.match.end - textStart);
    if (to <= cursor) continue;
    if (from > cursor) nodes.push(text.slice(cursor, from));
    nodes.push(
      <mark
        key={`m${textStart + from}`}
        className={`fw-preview-match${hit.index === activeIndex ? " is-active" : ""}`}
        data-match-index={hit.index}
      >
        {text.slice(from, to)}
      </mark>,
    );
    cursor = to;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/**
 * 渲染一行 token。`lineStart` 是该行首字符的绝对偏移。
 * 命中跨 token 时按交集切分，token 仍是外层 `<span>`（颜色与命中高亮互不覆盖）。
 */
export function renderTokens(
  tokens: readonly SourceToken[],
  lineStart: number,
  matches: readonly TextMatch[],
  activeIndex: number,
): ReactNode {
  if (tokens.length === 0) return null;
  const nodes: ReactNode[] = [];
  let offset = lineStart;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const content = matches.length
      ? renderTextWithMatches(token.text, offset, matches, activeIndex)
      : token.text;
    if (token.cls) {
      nodes.push(
        <span key={`t${i}`} className={`fw-preview-token fw-preview-token-${token.cls}`}>
          {content}
        </span>,
      );
    } else {
      nodes.push(content);
    }
    offset += token.text.length;
  }

  return nodes;
}
