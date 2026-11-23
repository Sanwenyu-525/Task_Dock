import { describe, expect, it } from "vitest";
import {
  createHighlightCursor,
  highlightLanguageOf,
  highlightLanguageOfName,
  highlightSource,
  tokenizeLine,
  type HighlightLanguage,
} from "./codeHighlight";

function tokensOf(line: string, language: HighlightLanguage, cursor = createHighlightCursor()) {
  return tokenizeLine(line, language, cursor);
}

function classesOf(line: string, language: HighlightLanguage) {
  return tokensOf(line, language)
    .filter((token) => token.cls)
    .map((token) => `${token.cls}:${token.text}`);
}

/** 高亮只能着色，不能改变原文字符（含空白）。 */
function expectLossless(line: string, language: HighlightLanguage) {
  const joined = tokensOf(line, language)
    .map((token) => token.text)
    .join("");
  expect(joined).toBe(line);
}

describe("语言识别", () => {
  it("扩展名映射到高亮语言，未知扩展名归 plain", () => {
    expect(highlightLanguageOf("tsx")).toBe("ts");
    expect(highlightLanguageOf("RS")).toBe("rust");
    expect(highlightLanguageOf("ps1")).toBe("powershell");
    expect(highlightLanguageOf("md")).toBe("markdown");
    expect(highlightLanguageOf("docx")).toBe("plain");
  });

  it("代码块语言标识与扩展名共用同一套词表", () => {
    expect(highlightLanguageOfName("typescript")).toBe("ts");
    expect(highlightLanguageOfName("Python")).toBe("python");
    expect(highlightLanguageOfName("c++")).toBe("cpp");
    expect(highlightLanguageOfName("unknown-lang")).toBe("plain");
  });
});

describe("TypeScript / JavaScript", () => {
  it("关键字、字符串、注释分开着色", () => {
    const classes = classesOf('const foo = "bar"; // note', "ts");
    expect(classes).toContain("keyword:const");
    expect(classes).toContain("string:\"bar\"");
    expect(classes).toContain("comment:// note");
  });

  it("函数名与类型名有独立语义", () => {
    const classes = classesOf("function hello(name: string): void {", "ts");
    expect(classes).toContain("keyword:function");
    expect(classes).toContain("function:hello");
    expect(classes).toContain("type:string");
  });

  it("属性访问用属性色，大写标识符识别为类型", () => {
    expect(classesOf("user.name", "js")).toContain("property:name");
    expect(classesOf("new HttpClient()", "ts")).toContain("type:HttpClient");
  });

  it("布尔与 null 独立着色", () => {
    expect(classesOf("const ok = true ?? null", "ts")).toEqual(
      expect.arrayContaining(["boolean:true", "boolean:null"]),
    );
  });

  it("块注释跨行保持状态", () => {
    const cursor = createHighlightCursor();
    expect(tokensOf("/* start", "ts", cursor)).toEqual([{ text: "/* start", cls: "comment" }]);
    expect(cursor.inBlockComment).toBe(true);
    const second = tokensOf("end */ const a = 1", "ts", cursor);
    expect(second[0]).toEqual({ text: "end */", cls: "comment" });
    expect(cursor.inBlockComment).toBe(false);
    expect(second.some((token) => token.cls === "keyword" && token.text === "const")).toBe(true);
  });

  it("多字符运算符单独成 token，单字符保持正文", () => {
    const classes = classesOf("a => b === c", "ts");
    expect(classes).toContain("operator:=>");
    expect(classes).toContain("operator:===");
  });
});

describe("其它语言", () => {
  it("Rust：pub fn / 基本类型 / 数字", () => {
    const classes = classesOf("pub fn main() { let x: i32 = 1; }", "rust");
    expect(classes).toContain("keyword:pub");
    expect(classes).toContain("keyword:fn");
    expect(classes).toContain("function:main");
    expect(classes).toContain("type:i32");
    expect(classes).toContain("number:1");
  });

  it("Python：def / 函数名 / # 注释 / True", () => {
    const classes = classesOf("def run(x):  # note", "python");
    expect(classes).toContain("keyword:def");
    expect(classes).toContain("function:run");
    expect(classes).toContain("comment:# note");
    expect(classesOf("flag = True", "python")).toContain("boolean:True");
  });

  it("JSON：key 与 value 区分，数字与布尔独立", () => {
    const classes = classesOf('{"key": 1, "v": "text"}', "json");
    expect(classes).toContain('key:"key"');
    expect(classes).toContain('key:"v"');
    expect(classes).toContain('string:"text"');
    expect(classes).toContain("number:1");
    expect(classesOf('{"on": true}', "json")).toContain("boolean:true");
  });

  it("YAML：键、值类型与注释", () => {
    expect(classesOf('name: "demo"', "yaml")).toEqual(
      expect.arrayContaining(["key:name", "string:\"demo\""]),
    );
    expect(classesOf("enabled: true", "yaml")).toContain("boolean:true");
    expect(classesOf("count: 12 # n", "yaml")).toContain("number:12");
  });

  it("CSS：选择器 / 属性名 / 颜色值", () => {
    const classes = classesOf(".card { color: #fff; }", "css");
    expect(classes).toContain("selector:card");
    expect(classes).toContain("property:color");
    expect(classes).toContain("number:#fff");
  });

  it("HTML：标签 / 属性名 / 属性值", () => {
    const classes = classesOf('<div class="box">', "html");
    expect(classes).toContain("tag:div");
    expect(classes).toContain("attr:class");
    expect(classes).toContain('string:"box"');
  });

  it("SQL：大小写不敏感关键字", () => {
    const classes = classesOf("SELECT * FROM t WHERE n = 1", "sql");
    expect(classes).toContain("keyword:SELECT");
    expect(classes).toContain("keyword:FROM");
    expect(classes).toContain("number:1");
  });

  it("Shell / PowerShell：注释、变量与关键字", () => {
    expect(classesOf('if [ -f "$x" ]; then', "shell")).toEqual(
      expect.arrayContaining(["keyword:if", "string:\"$x\"", "keyword:then"]),
    );
    expect(classesOf("if ($true) { # c", "powershell")).toEqual(
      expect.arrayContaining(["keyword:if", "boolean:$true", "comment:# c"]),
    );
  });

  it("纯文本不做任何染色", () => {
    expect(tokensOf("const a = 1", "plain")).toEqual([{ text: "const a = 1", cls: null }]);
  });
});

describe("预算与无损", () => {
  it("超过字符预算时降级，不返回半份高亮", () => {
    const result = highlightSource("a".repeat(200), "ts", 100);
    expect(result.degraded).toBe(true);
    expect(result.lines).toEqual([]);
  });

  it("正常内容逐行返回且与原文一一对应", () => {
    const content = "const a = 1;\nconst b = 2;";
    const result = highlightSource(content, "ts", 10_000);
    expect(result.degraded).toBe(false);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].map((token) => token.text).join("")).toBe("const a = 1;");
  });

  it("高亮不改变任何原始字符（抽样）", () => {
    const samples: Array<[string, HighlightLanguage]> = [
      ['const url = "https://a.b/c"; // x', "ts"],
      ["fn f<'a>(x: &'a str) {}", "rust"],
      ["- name: demo", "yaml"],
      ["<a href='x'>t</a>", "html"],
      ["-- note", "sql"],
      ["echo $HOME # home", "shell"],
    ];
    for (const [line, language] of samples) expectLossless(line, language);
  });
});
