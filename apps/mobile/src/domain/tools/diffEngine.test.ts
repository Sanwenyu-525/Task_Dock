// 行级 diff 引擎单测：覆盖相同/新增/删除/修改/混合/空文本/空白归一化/行号/CRLF/尾随空行/
// 上限降级/complex 分支/不变式与性能基线。被测对象是纯函数，node 环境直接运行。
import { describe, expect, it } from "vitest";

import {
  diffLines,
  MAX_DIFF_CELLS,
  MAX_DIFF_LINES,
  type DiffResult,
} from "./diffEngine";

/** 每个 ok 用例都必须满足的统计不变式：ops.length === unchanged + added + removed + 2*changed。 */
function assertInvariant(result: DiffResult): void {
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const { ops, stats, truncated } = result;
  expect(truncated).toBe(false);
  expect(ops.length).toBe(
    stats.unchanged + stats.added + stats.removed + 2 * stats.changed,
  );
}

describe("diffLines 基础场景", () => {
  it("两边相同：全部 equal，除 unchanged 外统计全 0", () => {
    const text = "aaa\nbbb\nccc";
    const res = diffLines(text, text, { ignoreWhitespace: false });
    assertInvariant(res);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ops.every((op) => op.type === "equal")).toBe(true);
    expect(res.stats).toEqual({ added: 0, removed: 0, changed: 0, unchanged: 3 });
  });

  it("新增行：纯 insert，计入 added", () => {
    const res = diffLines("a\nb", "a\nx\nb", { ignoreWhitespace: false });
    assertInvariant(res);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ops.map((op) => op.type)).toEqual(["equal", "insert", "equal"]);
    expect(res.stats).toEqual({ added: 1, removed: 0, changed: 0, unchanged: 2 });
  });

  it("删除行：纯 delete，计入 removed", () => {
    const res = diffLines("a\nx\nb", "a\nb", { ignoreWhitespace: false });
    assertInvariant(res);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ops.map((op) => op.type)).toEqual(["equal", "delete", "equal"]);
    expect(res.stats).toEqual({ added: 0, removed: 1, changed: 0, unchanged: 2 });
  });

  it("修改行：delete+insert 配对为 changed，added/removed 不重复计", () => {
    const res = diffLines("old line", "new line", { ignoreWhitespace: false });
    assertInvariant(res);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ops.map((op) => op.type)).toEqual(["delete", "insert"]);
    expect(res.stats).toEqual({ added: 0, removed: 0, changed: 1, unchanged: 0 });
  });

  it("多行混合：一段删除配一段插入为修改，多余插入计入 added", () => {
    const a = "one\ntwo\nthree\nfour\nfive";
    const b = "one\ntwo\nTWO\nfour\nSIX\nfive";
    const res = diffLines(a, b, { ignoreWhitespace: false });
    assertInvariant(res);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.stats).toEqual({ added: 1, removed: 0, changed: 1, unchanged: 4 });
  });
});

describe("diffLines 空文本与行切分", () => {
  it("空文本 vs 空文本：0 行，ops 为空，统计全 0", () => {
    const res = diffLines("", "", { ignoreWhitespace: false });
    assertInvariant(res);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ops).toEqual([]);
    expect(res.stats).toEqual({ added: 0, removed: 0, changed: 0, unchanged: 0 });
  });

  it("空文本 vs 有内容：纯 insert", () => {
    const res = diffLines("", "x\ny", { ignoreWhitespace: false });
    assertInvariant(res);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ops.every((op) => op.type === "insert")).toBe(true);
    expect(res.stats).toEqual({ added: 2, removed: 0, changed: 0, unchanged: 0 });
  });

  it("CRLF 输入：剥掉行尾 \\r 后判 equal", () => {
    const res = diffLines("a\r\nb\r\n", "a\r\nb", { ignoreWhitespace: false });
    assertInvariant(res);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ops.map((op) => op.type)).toEqual(["equal", "equal"]);
    expect(res.ops.map((op) => op.text)).toEqual(["a", "b"]);
  });

  it("尾随空行：\"a\\n\" → 1 行，\"a\\n\\n\" → 2 行，多余空行按 delete 处理", () => {
    const res = diffLines("a\n\n", "a\n", { ignoreWhitespace: false });
    assertInvariant(res);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ops.map((op) => op.type)).toEqual(["equal", "delete"]);
    expect(res.ops[1].text).toBe("");
    expect(res.ops[1].aLine).toBe(2);
    expect(res.ops[1].bLine).toBeNull();
  });
});

describe("diffLines 空白归一化", () => {
  it("ignoreWhitespace=true：行首/行中/行尾空白差异均判 equal，text 取 a 侧原文", () => {
    const cases: Array<[string, string]> = [
      ["  abc", "abc"], // 行首
      ["foo   bar", "foo bar"], // 行中连续空白
      ["abc  ", "abc"], // 行尾
    ];
    for (const [a, b] of cases) {
      const res = diffLines(a, b, { ignoreWhitespace: true });
      assertInvariant(res);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.ops).toHaveLength(1);
      expect(res.ops[0].type).toBe("equal");
      expect(res.ops[0].text).toBe(a);
      expect(res.stats.changed).toBe(0);
      expect(res.stats.added).toBe(0);
      expect(res.stats.removed).toBe(0);
    }
  });

  it("ignoreWhitespace=false：同样的空白差异产生 delete+insert，计为修改", () => {
    const res = diffLines("  abc", "abc", { ignoreWhitespace: false });
    assertInvariant(res);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ops.map((op) => op.type)).toEqual(["delete", "insert"]);
    expect(res.stats).toEqual({ added: 0, removed: 0, changed: 1, unchanged: 0 });
  });
});

describe("diffLines 行号", () => {
  it("插入行：insert 的 aLine 为 null，bLine 连续；后续 equal 行号跟随 b 侧", () => {
    const res = diffLines("aaa\nbbb\nccc", "aaa\nbbb\nddd\nccc", {
      ignoreWhitespace: false,
    });
    assertInvariant(res);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ops[0]).toMatchObject({ type: "equal", aLine: 1, bLine: 1 });
    expect(res.ops[1]).toMatchObject({ type: "equal", aLine: 2, bLine: 2 });
    expect(res.ops[2]).toMatchObject({
      type: "insert",
      text: "ddd",
      aLine: null,
      bLine: 3,
    });
    expect(res.ops[3]).toMatchObject({ type: "equal", aLine: 3, bLine: 4 });
  });

  it("删除行：delete 的 bLine 为 null，aLine 取 a 侧序号；后续 equal 行号跟随 a 侧", () => {
    const res = diffLines("aaa\nxxx\nbbb", "aaa\nbbb", { ignoreWhitespace: false });
    assertInvariant(res);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ops[1]).toMatchObject({
      type: "delete",
      text: "xxx",
      aLine: 2,
      bLine: null,
    });
    expect(res.ops[2]).toMatchObject({ type: "equal", aLine: 3, bLine: 2 });
  });
});

describe("diffLines 上限与降级", () => {
  it("行数超过 MAX_DIFF_LINES → too-large，message 带实测行数与上限", () => {
    const a = Array(MAX_DIFF_LINES + 1).fill("x").join("\n");
    const res = diffLines(a, "x", { ignoreWhitespace: false });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("too-large");
    expect(res.message).toContain(String(MAX_DIFF_LINES + 1));
    expect(res.message).toContain(String(MAX_DIFF_LINES));
  });

  it("行列积边界：2000×2000 恰好等于 MAX_DIFF_CELLS，不触发 cell 前置拒绝", () => {
    const a = Array(MAX_DIFF_LINES).fill("x").join("\n");
    const b = Array(MAX_DIFF_LINES).fill("x").join("\n");
    const res = diffLines(a, b, { ignoreWhitespace: false });
    assertInvariant(res);
    expect(res.ok).toBe(true);
    // 2000 × 2000 = 4,000,000，等于上限而非大于；cell 分支在当前常量下被行数上限遮挡，
    // 见报告「尚未覆盖的边界」。
    expect(MAX_DIFF_LINES * MAX_DIFF_LINES).toBe(MAX_DIFF_CELLS);
  });

  it("编辑距离超限（仍在行数/行列积上限内）→ complex", () => {
    // 1100 行全 "x" 对 1100 行全 "y"，无任何公共行，编辑距离 = 1100 + 1100 = 2200 > 2000；
    // 行列积 1,210,000 < 4,000,000，行数 1100 ≤ 2000，落到 complex 分支。
    const a = Array(1100).fill("x").join("\n");
    const b = Array(1100).fill("y").join("\n");
    const res = diffLines(a, b, { ignoreWhitespace: false });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("complex");
    expect(res.message.length).toBeGreaterThan(0);
  });
});

describe("diffLines 性能基线", () => {
  it("两个各约 1200 行、差异约 50 行的文本在 1000ms 内完成", () => {
    const base = Array.from({ length: 1200 }, (_, i) => `line ${String(i).padStart(4, "0")}`);
    const modified = base.slice();
    for (let i = 100; i < 150; i += 1) modified[i] = `changed ${i}`;
    const a = base.join("\n");
    const b = modified.join("\n");

    const t0 = performance.now();
    const res = diffLines(a, b, { ignoreWhitespace: false });
    const t1 = performance.now();
    const ms = t1 - t0;
    console.log(`1200 行用例（差异 50 行）实测 ${ms.toFixed(2)} ms`);

    assertInvariant(res);
    expect(res.ok).toBe(true);
    expect(ms).toBeLessThan(1000);
  });
});
