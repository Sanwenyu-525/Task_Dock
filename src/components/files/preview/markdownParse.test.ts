import { describe, expect, it } from "vitest";
import {
  markdownToPlainText,
  parseInline,
  parseMarkdown,
  sanitizeLinkHref,
  type MdBlock,
} from "./markdownParse";

function blocks(source: string): MdBlock[] {
  return parseMarkdown(source).blocks;
}

function firstBlock(source: string): MdBlock {
  const [block] = blocks(source);
  expect(block).toBeTruthy();
  return block;
}

describe("标题与段落", () => {
  it("1-6 级标题与行内强调", () => {
    const heading = firstBlock("## 标题 **重点**");
    expect(heading.type).toBe("heading");
    if (heading.type !== "heading") return;
    expect(heading.level).toBe(2);
    expect(heading.children).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "strong" })]),
    );
  });

  it("段落保留软换行（本地文件阅读预期）", () => {
    const paragraph = firstBlock("第一行\n第二行");
    expect(paragraph.type).toBe("paragraph");
    if (paragraph.type !== "paragraph") return;
    expect(paragraph.children.some((node) => node.type === "break")).toBe(true);
  });

  it("空文档不产生块，也不抛错", () => {
    expect(blocks("")).toEqual([]);
    expect(blocks("\n\n  \n")).toEqual([]);
  });
});

describe("行内语法", () => {
  it("粗体 / 斜体 / 删除线 / 行内代码", () => {
    const nodes = parseInline("**b** *i* ~~s~~ `c`", 0);
    expect(nodes.map((node) => node.type)).toEqual(
      expect.arrayContaining(["strong", "em", "del", "code"]),
    );
    const code = nodes.find((node) => node.type === "code");
    expect(code && "value" in code ? code.value : "").toBe("c");
  });

  it("行内偏移与原文一致（用于搜索命中定位）", () => {
    const nodes = parseInline("ab **cd**", 10);
    const strong = nodes.find((node) => node.type === "strong");
    expect(strong && "start" in strong ? strong.start : -1).toBe(13);
    const first = nodes[0];
    expect(first.type === "text" ? first.start : -1).toBe(10);
  });

  it("转义字符按字面量处理", () => {
    const nodes = parseInline("\\*not em\\*", 0);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: "text", value: "*not em*" });
  });

  it("图片不渲染、不加载远程资源，只保留替代文本", () => {
    const nodes = parseInline("![图](https://a.b/c.png)", 0);
    expect(nodes[0]).toMatchObject({ type: "image", alt: "图" });
  });
});

describe("链接协议白名单", () => {
  it("http/https/mailto 放行", () => {
    expect(sanitizeLinkHref("https://example.com/a")).toEqual({ ok: true, href: "https://example.com/a" });
    expect(sanitizeLinkHref("mailto:a@b.c")).toEqual({ ok: true, href: "mailto:a@b.c" });
    expect(sanitizeLinkHref("<https://example.com>")).toEqual({ ok: true, href: "https://example.com" });
  });

  it("javascript/data/相对路径/控制字符全部拒绝", () => {
    expect(sanitizeLinkHref("javascript:alert(1)")).toMatchObject({ ok: false, reason: "protocol" });
    expect(sanitizeLinkHref("data:text/html,x")).toMatchObject({ ok: false, reason: "protocol" });
    expect(sanitizeLinkHref("./local.md")).toMatchObject({ ok: false, reason: "relative" });
    expect(sanitizeLinkHref("https://a.b/\u0000")).toMatchObject({ ok: false, reason: "protocol" });
    expect(sanitizeLinkHref("   ")).toMatchObject({ ok: false, reason: "empty" });
  });

  it("被拒绝的链接降级为 link-blocked，绝不生成可点击协议", () => {
    const nodes = parseInline("[点我](javascript:alert(1))", 0);
    expect(nodes[0]).toMatchObject({ type: "link-blocked", rawHref: "javascript:alert(1)" });
  });
});

describe("块级结构", () => {
  it("围栏代码块保留语言与原文", () => {
    const code = firstBlock("```ts\nconst a = 1;\n```");
    expect(code).toMatchObject({ type: "code", lang: "ts", text: "const a = 1;" });
  });

  it("无序 / 有序 / 任务列表", () => {
    const list = firstBlock("- a\n- b");
    expect(list.type).toBe("list");
    if (list.type !== "list") return;
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);

    const ordered = firstBlock("1. one\n2. two");
    expect(ordered.type === "list" && ordered.ordered).toBe(true);

    const task = firstBlock("- [x] done\n- [ ] todo");
    if (task.type !== "list") throw new Error("expected list");
    expect(task.items.map((item) => item.checked)).toEqual([true, false]);
  });

  it("引用块递归解析内部段落", () => {
    const quote = firstBlock("> 引用 **粗**\n> 第二行");
    expect(quote.type).toBe("quote");
    if (quote.type !== "quote") return;
    expect(quote.blocks[0]).toMatchObject({ type: "paragraph" });
  });

  it("表格：对齐与单元格行内解析", () => {
    const table = firstBlock("| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| a | **b** | c |");
    expect(table.type).toBe("table");
    if (table.type !== "table") return;
    expect(table.align).toEqual(["left", "center", "right"]);
    expect(table.header).toHaveLength(3);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0][1]).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "strong" })]),
    );
  });

  it("分隔线", () => {
    expect(firstBlock("---").type).toBe("hr");
    expect(firstBlock("* * *").type).toBe("hr");
  });

  it("原始 HTML 按源码块保留，不进入行内解析", () => {
    const html = firstBlock("<script>alert(1)</script>");
    expect(html.type).toBe("html");
    if (html.type !== "html") return;
    expect(html.text).toContain("alert(1)");
    expect(html).not.toHaveProperty("children");
  });

  it("HTML 注释同样不执行", () => {
    const html = firstBlock("<!-- 注释 -->");
    expect(html.type).toBe("html");
  });
});

describe("预算与安全兜底", () => {
  it("超过最大行数时截断并标记", () => {
    const source = Array.from({ length: 30 }, (_, index) => `- item ${index}`).join("\n");
    const doc = parseMarkdown(source, { maxLines: 5 });
    expect(doc.truncated).toBe(true);
    expect(doc.blocks.length).toBeGreaterThan(0);
  });

  it("节点预算耗尽后停止并标记，不抛错", () => {
    const source = Array.from({ length: 200 }, (_, index) => `段落 **${index}**`).join("\n\n");
    const doc = parseMarkdown(source, { maxNodes: 10 });
    expect(doc.truncated).toBe(true);
    expect(doc.blocks.length).toBeLessThan(200);
  });

  it("纯文本摘要不包含 HTML 标签执行结果", () => {
    const text = markdownToPlainText("# 标题\n\n**粗体** 与 `代码`");
    expect(text).toContain("标题");
    expect(text).toContain("粗体");
    expect(text).not.toContain("<h1");
  });
});
