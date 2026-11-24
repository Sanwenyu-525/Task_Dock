import { describe, expect, it } from "vitest";
import { revisionChanged, revisionKey, revisionOf } from "./previewRevision";

const ENTRY = { size: 120, modifiedMs: 1_700_000_000_000 };

describe("revisionOf / revisionKey", () => {
  it("由目录条目构造版本，缺失字段归一为 null", () => {
    expect(revisionOf("D:\\a\\a.ts", ENTRY)).toEqual({
      path: "D:\\a\\a.ts",
      size: 120,
      modifiedMs: 1_700_000_000_000,
    });
    expect(revisionOf("D:\\a\\a.ts", { size: null, modifiedMs: null })).toEqual({
      path: "D:\\a\\a.ts",
      size: null,
      modifiedMs: null,
    });
  });

  it("键按 Windows 规则小写归一，路径大小写不同但文件相同视为同一版本", () => {
    const upper = revisionOf("D:\\A\\a.ts", ENTRY);
    const lower = revisionOf("d:\\a\\A.TS", ENTRY);
    expect(revisionKey(upper)).toBe(revisionKey(lower));
  });

  it("null 与 0 不会混为一谈", () => {
    const zero = revisionOf("D:\\a\\a.ts", { size: 0, modifiedMs: 0 });
    const empty = revisionOf("D:\\a\\a.ts", { size: null, modifiedMs: null });
    expect(revisionKey(zero)).not.toBe(revisionKey(empty));
  });
});

describe("revisionChanged", () => {
  it("同路径内容未变 → false；size 变化 / 仅 mtime 变化 → true", () => {
    const base = revisionOf("D:\\a\\a.ts", ENTRY);
    expect(revisionChanged(base, { ...base })).toBe(false);
    expect(revisionChanged(base, { ...base, size: 121 })).toBe(true);
    expect(revisionChanged(base, { ...base, modifiedMs: 1_700_000_001_000 })).toBe(true);
  });

  it("路径变化（换文件）也算版本变化", () => {
    expect(revisionChanged(revisionOf("D:\\a\\a.ts", ENTRY), revisionOf("D:\\a\\b.ts", ENTRY))).toBe(true);
  });
});
