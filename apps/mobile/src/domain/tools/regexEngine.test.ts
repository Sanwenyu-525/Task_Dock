// regexEngine 纯函数单测：覆盖匹配语义、捕获组、flags、字符类、量词、锚点、
// 错误分类、替换展开与灾难性模式线性时间证明。被测对象不依赖 React / 原生模块。
import { describe, expect, it } from "vitest";

import {
  compileRegex,
  expandReplacement,
  MAX_INPUT_LENGTH,
  MAX_MATCHES,
  MAX_PATTERN_LENGTH,
  type RegexFlags,
  type RegexMatch,
} from "./regexEngine";

const NO_FLAGS: RegexFlags = { ignoreCase: false, multiline: false, dotAll: false };

function compile(pattern: string, flags: RegexFlags = NO_FLAGS) {
  const result = compileRegex(pattern, flags);
  if (!result.ok) throw new Error(`编译失败: ${result.message}`);
  return result.regex;
}

function compileFail(pattern: string, flags: RegexFlags = NO_FLAGS) {
  const result = compileRegex(pattern, flags);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("不应到达");
  return result;
}

describe("基础匹配", () => {
  it("普通字面量匹配，text 与 slice 一致", () => {
    const regex = compile("abc");
    const matches = regex.matchAll("xabc yabc", 10);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ start: 1, end: 4, text: "abc" });
    expect(matches[1]).toMatchObject({ start: 6, end: 9, text: "abc" });
    for (const m of matches) {
      expect(m.text).toBe("xabc yabc".slice(m.start, m.end));
    }
  });

  it("无匹配时返回空数组", () => {
    expect(compile("xyz").matchAll("abcdef", 10)).toEqual([]);
    expect(compile("xyz").test("abcdef")).toBe(false);
    expect(compile("abc").test("abcdef")).toBe(true);
  });

  it("leftmost-first：a|ab 对 ab 只匹配 a", () => {
    const matches = compile("a|ab").matchAll("ab", 10);
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe("a");
  });

  it("左分支失败时继续走右分支：(a|ab)c 匹配整个 abc", () => {
    const matches = compile("(a|ab)c").matchAll("abc", 10);
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe("abc");
    expect(matches[0].groups).toEqual(["ab"]);
  });
});

describe("多匹配与上限", () => {
  it("limit 收紧返回条数", () => {
    expect(compile("a").matchAll("aaa", 2)).toHaveLength(2);
    expect(compile("a").matchAll("aaa", 0)).toHaveLength(0);
    expect(compile("a").matchAll("aaa", -3)).toHaveLength(0);
  });

  it("实际返回条数不超过 MAX_MATCHES", () => {
    const text = "a".repeat(MAX_MATCHES + 100);
    const matches = compile("a").matchAll(text, Number.POSITIVE_INFINITY);
    expect(matches).toHaveLength(MAX_MATCHES);
  });
});

describe("捕获组", () => {
  it("嵌套分组 (a(b)c) 逐层取到子串", () => {
    const matches = compile("(a(b)c)").matchAll("abc", 10);
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe("abc");
    expect(matches[0].groups).toEqual(["abc", "b"]);
  });

  it("未参与匹配的组为 null", () => {
    const matches = compile("(a)|(b)").matchAll("b", 10);
    expect(matches).toHaveLength(1);
    expect(matches[0].groups).toEqual([null, "b"]);
  });

  it("交替分支中只记录命中分支的组", () => {
    const matches = compile("(cat)|(dog)").matchAll("dog", 10);
    expect(matches[0].groups).toEqual([null, "dog"]);
  });

  it("非捕获分组 (?:...) 不占组号", () => {
    const matches = compile("(?:ab)(c)").matchAll("abc", 10);
    expect(matches[0].text).toBe("abc");
    expect(matches[0].groups).toEqual(["c"]);
  });
});

describe("flags 生效", () => {
  it("ignoreCase 忽略大小写", () => {
    expect(compile("Ab", { ignoreCase: true, multiline: false, dotAll: false }).test("ab")).toBe(true);
    expect(compile("Ab", NO_FLAGS).test("ab")).toBe(false);
  });

  it("multiline 下 ^ 匹配行首，非 multiline 只匹配串首", () => {
    const m = compile("^b", { ignoreCase: false, multiline: true, dotAll: false });
    expect(m.matchAll("a\nb", 10)[0]).toMatchObject({ start: 2, text: "b" });
    const n = compile("^b", NO_FLAGS);
    expect(n.matchAll("a\nb", 10)).toEqual([]);
  });

  it("dotAll 下 . 匹配换行，默认不匹配", () => {
    const s = compile(".", { ignoreCase: false, multiline: false, dotAll: true });
    expect(s.matchAll("a\nb", 10).map((m) => m.text)).toEqual(["a", "\n", "b"]);
    const d = compile(".", NO_FLAGS);
    expect(d.matchAll("a\nb", 10).map((m) => m.text)).toEqual(["a", "b"]);
  });
});

describe("字符类", () => {
  it("正类 [abc] 与反类 [^abc]", () => {
    expect(compile("[abc]").matchAll("xaybzc", 10).map((m) => m.text)).toEqual(["a", "b", "c"]);
    expect(compile("[^abc]").matchAll("xay", 10).map((m) => m.text)).toEqual(["x", "y"]);
  });

  it("范围 [a-z] 与类内转义 [\\d\\]]", () => {
    expect(compile("[a-z]").test("k")).toBe(true);
    expect(compile("[a-z]").test("K")).toBe(false);
    expect(compile("[\\d\\]]").test("]")).toBe(true);
    expect(compile("[\\d\\]]").test("5")).toBe(true);
    expect(compile("[\\d\\]]").test("a")).toBe(false);
  });

  it("预定义类 \\d \\w \\s 及其反义", () => {
    expect(compile("\\d").test("7")).toBe(true);
    expect(compile("\\w").test("_")).toBe(true);
    expect(compile("\\s").test(" ")).toBe(true);
    expect(compile("\\D").test("a")).toBe(true);
    expect(compile("\\W").test("!")).toBe(true);
    expect(compile("\\S").test("x")).toBe(true);
  });
});

describe("量词", () => {
  it("{n} 精确重复", () => {
    expect(compile("a{2}").matchAll("aaa", 10).map((m) => m.text)).toEqual(["aa"]);
  });

  it("{n,} 至少重复，贪心取最长", () => {
    expect(compile("a{2,}").matchAll("aaaa", 10).map((m) => m.text)).toEqual(["aaaa"]);
  });

  it("{n,m} 边界内贪心", () => {
    expect(compile("a{2,3}").matchAll("aaaa", 10).map((m) => m.text)).toEqual(["aaa"]);
    expect(compile("a{2,3}").matchAll("a", 10)).toEqual([]);
  });

  it("{0} 产生零次匹配（含串尾一次零长度匹配，与 JS 口径一致）", () => {
    const matches = compile("a{0}").matchAll("b", 10);
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.start)).toEqual([0, 1]);
    expect(matches.map((m) => m.end)).toEqual([0, 1]);
    for (const m of matches) expect(m.text).toBe("");
  });

  it("* + ? 量词", () => {
    // 串尾会再产生一次零长度匹配，与 JS String.matchAll 口径一致
    expect(compile("a*").matchAll("aaa", 10).map((m) => m.text)).toEqual(["aaa", ""]);
    expect(compile("a+").matchAll("aa", 10).map((m) => m.text)).toEqual(["aa"]);
    expect(compile("a?").matchAll("ba", 10).map((m) => m.text)).toEqual(["", "a", ""]);
  });
});

describe("锚点", () => {
  it("非 multiline：^ 只在串首，$ 只在串尾", () => {
    expect(compile("^a").test("ab")).toBe(true);
    expect(compile("^a").test("ba")).toBe(false);
    expect(compile("b$").test("ab")).toBe(true);
    expect(compile("b$").test("ba")).toBe(false);
  });

  it("multiline：^ 匹配换行后，$ 匹配换行前", () => {
    const flags: RegexFlags = { ignoreCase: false, multiline: true, dotAll: false };
    expect(compile("^b", flags).test("a\nb")).toBe(true);
    expect(compile("a$", flags).test("a\nb")).toBe(true);
    expect(compile("a$", NO_FLAGS).test("a\nb")).toBe(false);
  });
});

describe("语法错误（syntax，带位置）", () => {
  const cases: Array<[string, string]> = [
    ["(a", "未闭合的分组"],
    ["[a", "未闭合的字符类"],
    ["a\\", "孤立的反斜杠"],
    ["a**", "量词"],
    ["*a", "孤立量词"],
    ["[z-a]", "非法字符类范围"],
    ["a{2,1}", "n 大于 m"],
  ];

  it.each(cases)("模式 %s 返回 syntax 且 message 点名问题", (pattern, keyword) => {
    const result = compileFail(pattern);
    expect(result.code).toBe("syntax");
    expect(result.message).toContain(keyword);
    expect(result.message).toContain("位置");
  });
});

describe("不支持构造（unsupported，message 指名）", () => {
  const cases: Array<[string, string]> = [
    ["(?=a)", "前瞻"],
    ["(?!a)", "负向前瞻"],
    ["(?<=a)", "后顾"],
    ["(?<!a)", "负向后顾"],
    ["\\1", "反向引用"],
    ["(?<name>a)", "命名分组"],
    ["\\p{Letter}", "Unicode 属性类"],
    ["\\P{Letter}", "Unicode 属性类"],
    ["(?i)a", "内联 flag"],
    ["\\b", "词边界"],
    ["\\B", "词边界"],
  ];

  it.each(cases)("模式 %s 返回 unsupported", (pattern, keyword) => {
    const result = compileFail(pattern);
    expect(result.code).toBe("unsupported");
    expect(result.message).toContain(keyword);
  });
});

describe("编译期分类", () => {
  it("空模式返回 empty", () => {
    const result = compileRegex("", NO_FLAGS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("empty");
  });

  it("超长模式返回 too-long", () => {
    const result = compileRegex("a".repeat(MAX_PATTERN_LENGTH + 1), NO_FLAGS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("too-long");
      expect(result.message).toContain("模式长度");
    }
  });

  it("量词展开过大返回 too-long", () => {
    const result = compileRegex("a{100000}", NO_FLAGS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("too-long");
  });
});

describe("输入长度上限", () => {
  const longText = "a".repeat(MAX_INPUT_LENGTH + 1);

  it("matchAll 超限抛 RangeError", () => {
    const regex = compile("a");
    expect(() => regex.matchAll(longText, 10)).toThrow(RangeError);
    expect(() => regex.matchAll(longText, 10)).toThrow("输入超过安全上限");
  });

  it("test 超限抛 RangeError", () => {
    const regex = compile("a");
    expect(() => regex.test(longText)).toThrow(RangeError);
    expect(() => regex.test(longText)).toThrow("输入超过安全上限");
  });
});

describe("空匹配推进", () => {
  it("a* 对 bbb 在每个位置（含串尾）产生一次零长度匹配，不死循环", () => {
    const matches = compile("a*").matchAll("bbb", 10);
    // 与 JS 口径一致：位置 0、1、2、3 各一次零长度匹配
    expect(matches).toHaveLength(4);
    expect(matches.map((m) => m.start)).toEqual([0, 1, 2, 3]);
    expect(matches.map((m) => m.end)).toEqual([0, 1, 2, 3]);
    for (const m of matches) expect(m.text).toBe("");
  });
});

describe("expandReplacement", () => {
  const match: RegexMatch = {
    start: 0,
    end: 3,
    text: "abc",
    groups: ["b", null],
  };

  it("$& 与 $0 展开为整个匹配", () => {
    expect(expandReplacement("[$&]", match, "abc")).toBe("[abc]");
    expect(expandReplacement("[$0]", match, "abc")).toBe("[abc]");
  });

  it("$1..$9 展开对应组，未匹配组按空串", () => {
    expect(expandReplacement("($1)", match, "abc")).toBe("(b)");
    expect(expandReplacement("($2)", match, "abc")).toBe("()");
  });

  it("越界组号保留字面量；$12 按 $1 + 字面量 2", () => {
    // 只有 2 个组，$3 越界：原样保留 "$3"
    expect(expandReplacement("$3", match, "abc")).toBe("$3");
    // 只识别一位组号：$1 展开后接字面量 "2"
    expect(expandReplacement("$12", match, "abc")).toBe("b2");
  });

  it("其余 $ 原样保留", () => {
    expect(expandReplacement("a$b $$", match, "abc")).toBe("a$b $$");
  });
});

describe("与原生 RegExp 差分对比", () => {
  interface DiffCase {
    pattern: string;
    text: string;
    flags: RegexFlags;
  }

  const DIFF_CASES: DiffCase[] = [
    // 普通匹配
    { pattern: "abc", text: "xabc yabc", flags: NO_FLAGS },
    // leftmost-first 语义守恒
    { pattern: "a|ab", text: "ab", flags: NO_FLAGS },
    { pattern: "(a|ab)c", text: "abc", flags: NO_FLAGS },
    // 缺陷 1：交替分支 + 重复量词必须整体贪心匹配
    { pattern: "(a|b)+", text: "abab", flags: NO_FLAGS },
    { pattern: "(a|b)+", text: "ab", flags: NO_FLAGS },
    { pattern: "(a|b)+", text: "aba", flags: NO_FLAGS },
    // 缺陷 2：重复量词内的捕获组取内层贪婪结果
    { pattern: "(a+)+$", text: "aaaa", flags: NO_FLAGS },
    { pattern: "(a+)+", text: "aaaa", flags: NO_FLAGS },
    // 既有已核对通过的模式
    { pattern: "a(b)c", text: "abc", flags: NO_FLAGS },
    { pattern: "(a)(b)?c", text: "ac", flags: NO_FLAGS },
    { pattern: "(a)(b)?c", text: "abc", flags: NO_FLAGS },
    { pattern: "x*", text: "bbb", flags: NO_FLAGS },
    { pattern: "a*", text: "bbb", flags: NO_FLAGS },
    { pattern: "[a-c]+", text: "abxabc", flags: NO_FLAGS },
    { pattern: "[^a]+", text: "bacb", flags: NO_FLAGS },
    { pattern: "a{2,3}", text: "aaaa", flags: NO_FLAGS },
    { pattern: "a{2}", text: "aaa", flags: NO_FLAGS },
    { pattern: "^abc$", text: "abc", flags: NO_FLAGS },
    { pattern: "\\d+", text: "a12b34", flags: NO_FLAGS },
    { pattern: "\\w+", text: "a_1!", flags: NO_FLAGS },
    { pattern: "a.c", text: "axc", flags: NO_FLAGS },
    { pattern: "(?:ab)+", text: "abab", flags: NO_FLAGS },
    { pattern: "(a(b)c)", text: "abc", flags: NO_FLAGS },
    { pattern: "(a)(b)|(c)", text: "ac", flags: NO_FLAGS },
    { pattern: "a$", text: "ba", flags: NO_FLAGS },
    { pattern: "a{0,2}", text: "aaaa", flags: NO_FLAGS },
    { pattern: "\\s+", text: "a b  c", flags: NO_FLAGS },
    { pattern: "a+b*", text: "aaabbb", flags: NO_FLAGS },
    { pattern: "(a|b)*c", text: "ababc", flags: NO_FLAGS },
    { pattern: "(ab|a)+", text: "abab", flags: NO_FLAGS },
    { pattern: "((a)(b))", text: "ab", flags: NO_FLAGS },
    // 三个 flag 各自生效
    { pattern: "Ab", text: "ab", flags: { ignoreCase: true, multiline: false, dotAll: false } },
    { pattern: "^b", text: "a\nb", flags: { ignoreCase: false, multiline: true, dotAll: false } },
    { pattern: "a$", text: "a\nb", flags: { ignoreCase: false, multiline: true, dotAll: false } },
    { pattern: ".", text: "a\nb", flags: { ignoreCase: false, multiline: false, dotAll: true } },
    { pattern: ".", text: "a\nb", flags: NO_FLAGS },
  ];

  function nativeMatches(pattern: string, text: string, flags: RegexFlags): RegexMatch[] {
    const flagStr =
      (flags.ignoreCase ? "i" : "") + (flags.multiline ? "m" : "") + (flags.dotAll ? "s" : "");
    const re = new RegExp(pattern, `g${flagStr}`);
    const out: RegexMatch[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      out.push({
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        groups: m.slice(1).map((g) => (g === undefined ? null : g)),
      });
      // 零长度匹配手动推进，避免原生 g 模式死循环
      if (m[0].length === 0) re.lastIndex += 1;
    }
    return out;
  }

  it.each(DIFF_CASES)(
    "$pattern 对 $text 与原生 RegExp 一致",
    ({ pattern, text, flags }) => {
      const mine = compile(pattern, flags).matchAll(text, 600);
      expect(mine).toEqual(nativeMatches(pattern, text, flags));
    },
  );
});

describe("缺陷回归：贪婪量词与重复组捕获", () => {
  it("(a|b)+ 对 abab 整体匹配，组为最后一次迭代的 b", () => {
    const matches = compile("(a|b)+").matchAll("abab", 10);
    expect(matches).toEqual([
      { start: 0, end: 4, text: "abab", groups: ["b"] },
    ]);
  });

  it("(a+)+$ 对 aaaa 整体匹配，组为内层贪婪吃满的 aaaa", () => {
    const matches = compile("(a+)+$").matchAll("aaaa", 10);
    expect(matches).toEqual([
      { start: 0, end: 4, text: "aaaa", groups: ["aaaa"] },
    ]);
  });

  it("守恒：a|ab 仍只匹配 a，(a|ab)c 整体匹配且组为 ab", () => {
    expect(compile("a|ab").matchAll("ab", 10)).toEqual([
      { start: 0, end: 1, text: "a", groups: [] },
    ]);
    expect(compile("(a|ab)c").matchAll("abc", 10)).toEqual([
      { start: 0, end: 3, text: "abc", groups: ["ab"] },
    ]);
  });
});

describe("性能证明：灾难性模式线性时间", () => {
  it("(a+)+$ 对 4900 个 a 加感叹号不回溯爆炸", () => {
    const result = compileRegex("(a+)+$", NO_FLAGS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const text = "a".repeat(4900) + "!";
    const start = performance.now();
    const matches = result.regex.matchAll(text, 10);
    const ms = performance.now() - start;
    console.log(`灾难性模式 (a+)+$ 实测耗时 ${ms.toFixed(2)} ms（输入 ${text.length} 码元）`);

    expect(matches).toEqual([]);
    expect(ms).toBeLessThan(1000);
  });
});
