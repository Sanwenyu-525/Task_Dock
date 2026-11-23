import { describe, expect, it } from "vitest";
import {
  MAX_SEARCH_MATCHES,
  findTextMatches,
  getNextMatch,
  getVisibleMatchRange,
  normalizeNewlines,
} from "./textSearch";

describe("findTextMatches", () => {
  it("默认大小写不敏感，并按行统计", () => {
    const result = findTextMatches("Foo foo\nfoo", "foo");
    expect(result.matches).toHaveLength(3);
    expect(result.matches.map((match) => match.line)).toEqual([1, 1, 2]);
    expect(result.matches[0]).toMatchObject({ start: 0, end: 3 });
    expect(result.matches[2]).toMatchObject({ start: 8, end: 11 });
    expect(result.truncated).toBe(false);
  });

  it("开启大小写敏感后只匹配原样文本", () => {
    expect(findTextMatches("Foo foo", "Foo", { caseSensitive: true }).matches).toHaveLength(1);
    expect(findTextMatches("Foo foo", "foo", { caseSensitive: true }).matches).toHaveLength(1);
  });

  it("空查询不产生命中（调用方据此清除高亮）", () => {
    expect(findTextMatches("abc", "")).toEqual({ query: "", matches: [], truncated: false });
    expect(findTextMatches("", "a").matches).toEqual([]);
  });

  it("按字面量匹配，正则元字符不再是特殊语法", () => {
    const result = findTextMatches("a.b a.b", ".");
    expect(result.matches).toHaveLength(2);
    expect(findTextMatches("a*b", "*").matches).toHaveLength(1);
  });

  it("达到命中上限后停止并标记截断", () => {
    const content = "a".repeat(MAX_SEARCH_MATCHES + 40);
    const result = findTextMatches(content, "a");
    expect(result.matches).toHaveLength(MAX_SEARCH_MATCHES);
    expect(result.truncated).toBe(true);
  });

  it("查询串超长只取前 200 个字符", () => {
    const query = "x".repeat(260);
    const result = findTextMatches(query, query);
    expect(result.query).toHaveLength(200);
  });
});

describe("getNextMatch", () => {
  const matches = findTextMatches("a a a", "a").matches;

  it("未定位时向下从 0 开始、向上从末条开始", () => {
    expect(getNextMatch(matches, -1, 1)).toBe(0);
    expect(getNextMatch(matches, -1, -1)).toBe(2);
  });

  it("循环移动，不越界", () => {
    expect(getNextMatch(matches, 2, 1)).toBe(0);
    expect(getNextMatch(matches, 0, -1)).toBe(2);
    expect(getNextMatch(matches, 1, 1)).toBe(2);
  });

  it("无命中返回 -1", () => {
    expect(getNextMatch([], -1, 1)).toBe(-1);
    expect(getNextMatch([], 0, -1)).toBe(-1);
  });
});

describe("getVisibleMatchRange", () => {
  const matches = [
    { start: 0, end: 1, line: 1 },
    { start: 10, end: 11, line: 5 },
    { start: 20, end: 21, line: 12 },
    { start: 30, end: 31, line: 40 },
  ];

  it("按行高与滚动位置返回可见区间（左闭右开）", () => {
    // 行高 20：视口 200，滚动 0 → 第 1-11 行可见。
    expect(getVisibleMatchRange(matches, { scrollTop: 0, viewportHeight: 200, lineHeight: 20 })).toEqual({
      start: 0,
      end: 2,
    });
    expect(getVisibleMatchRange(matches, { scrollTop: 200, viewportHeight: 200, lineHeight: 20 })).toEqual({
      start: 2,
      end: 3,
    });
  });

  it("行高未知时返回全部命中", () => {
    expect(getVisibleMatchRange(matches, { scrollTop: 0, viewportHeight: 0, lineHeight: 0 })).toEqual({
      start: 0,
      end: 4,
    });
    expect(getVisibleMatchRange([], { scrollTop: 0, viewportHeight: 100, lineHeight: 20 })).toEqual({
      start: 0,
      end: 0,
    });
  });
});

describe("normalizeNewlines", () => {
  it("CRLF/CR 统一为 LF，且已规范化的文本原样返回", () => {
    expect(normalizeNewlines("a\r\nb\rc")).toBe("a\nb\nc");
    const same = "a\nb";
    expect(normalizeNewlines(same)).toBe(same);
  });
});
