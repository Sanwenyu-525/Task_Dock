/**
 * @vitest-environment jsdom
 *
 * 文本 / Markdown 预览：阅读与源码双模式、单次读取、文件内搜索、换行与行号开关。
 * 断言落在真实 DOM 结构与 data-* 状态上，不只检查「有没有渲染」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridgeMocks = vi.hoisted(() => ({
  fsReadText: vi.fn(),
}));

vi.mock("../../../lib/bridge", () => bridgeMocks);
vi.mock("../../../lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));
vi.mock("../../../hooks/useLocale", () => ({
  useLocale: () => ({
    locale: "zh-CN",
    preference: "zh-CN",
    setPreference: vi.fn(),
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  }),
}));

import FileTextPreview from "./FileTextPreview";

const MARKDOWN = [
  "# 标题一",
  "",
  "段落 **粗体** 与 *斜体*、~~删除~~、`代码`",
  "",
  "- [x] 已完成",
  "- [ ] 待办",
  "",
  "> 引用",
  "",
  "| 列 | 值 |",
  "| :-- | --: |",
  "| a | 1 |",
  "",
  "```ts",
  "const a = 1;",
  "```",
  "",
  "[安全链接](https://example.com) 与 [危险链接](javascript:alert(1))",
  "",
  "<div onclick=\"alert(1)\">raw</div>",
].join("\n");

function mockText(name: string, content: string, truncated = false) {
  bridgeMocks.fsReadText.mockResolvedValue({
    path: `D:\\a\\${name}`,
    size: content.length,
    truncated,
    encoding: "UTF-8",
    content,
  });
}

function scroll(): HTMLElement {
  const el = document.querySelector(".fw-preview-text-scroll");
  if (!el) throw new Error("missing scroll container");
  return el as HTMLElement;
}

beforeEach(() => {
  bridgeMocks.fsReadText.mockReset();
});

afterEach(() => cleanup());

describe("Markdown 阅读模式", () => {
  it("默认阅读模式渲染标题/强调/任务列表/表格/代码块，链接只保留安全协议", async () => {
    mockText("README.md", MARKDOWN);
    render(<FileTextPreview path="D:\\a\\README.md" name="README.md" size={MARKDOWN.length} />);

    await waitFor(() => expect(document.querySelector(".fw-md-h1")?.textContent).toBe("标题一"));
    expect(document.querySelector(".fw-md-table th")?.textContent).toBe("列");
    expect(document.querySelectorAll(".fw-md-task")).toHaveLength(2);
    expect(document.querySelector(".fw-md-code-block")?.getAttribute("data-lang")).toBe("ts");

    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a.fw-md-link"));
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://example.com");
    // 被拒绝的链接不产生可点击协议入口。
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
    expect(document.querySelector(".fw-md-link.is-blocked")?.textContent).toContain("危险链接");

    // 原始 HTML 只按源码展示，不生成真实元素（div 的 onclick 不会出现在 DOM 里）。
    expect(document.querySelector(".fw-md-html pre")?.textContent).toContain("<div onclick=");
    expect(document.querySelector(".fw-md-html div[onclick]")).toBeNull();
  });

  it("切换源码再切回阅读：不重新读取文件", async () => {
    mockText("README.md", MARKDOWN);
    render(<FileTextPreview path="D:\\a\\README.md" name="README.md" size={MARKDOWN.length} />);
    await waitFor(() => expect(document.querySelector(".fw-md-h1")).toBeTruthy());
    expect(bridgeMocks.fsReadText).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("fw.preview.md.source"));
    await waitFor(() => expect(document.querySelector(".fw-preview-code")).toBeTruthy());
    expect(document.querySelector(".fw-md-body")).toBeNull();
    // 源码模式保留行号与 Markdown 语法着色。
    expect(document.querySelectorAll(".fw-preview-line-number").length).toBeGreaterThan(3);
    expect(document.querySelector(".fw-preview-token-markup")).toBeTruthy();

    fireEvent.click(screen.getByText("fw.preview.md.reading"));
    await waitFor(() => expect(document.querySelector(".fw-md-h1")).toBeTruthy());
    expect(bridgeMocks.fsReadText).toHaveBeenCalledTimes(1);
  });
});

describe("文件内搜索", () => {
  it("命中数、当前命中高亮与清空高亮", async () => {
    mockText("a.md", "# 标题\n\n正文 关键词 与 关键词");
    render(<FileTextPreview path="D:\\a\\a.md" name="a.md" size={20} />);
    await waitFor(() => expect(document.querySelector(".fw-md-h1")).toBeTruthy());

    const input = screen.getByLabelText("fw.preview.find") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "关键词" } });
    await waitFor(() => expect(document.querySelectorAll(".fw-preview-match")).toHaveLength(2));
    expect(document.querySelectorAll(".fw-preview-match.is-active")).toHaveLength(1);

    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(document.querySelectorAll(".fw-preview-match")).toHaveLength(0));
    expect(bridgeMocks.fsReadText).toHaveBeenCalledTimes(1);
  });

  it("源码模式同样标注命中（占位不改变原文）", async () => {
    mockText("a.ts", "const alpha = 1;\nconst beta = 2;");
    render(<FileTextPreview path="D:\\a\\a.ts" name="a.ts" size={40} />);
    await waitFor(() => expect(document.querySelector(".fw-preview-code")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("fw.preview.find"), { target: { value: "const" } });
    await waitFor(() => expect(document.querySelectorAll(".fw-preview-match")).toHaveLength(2));
    expect(scroll().textContent).toContain("const alpha = 1;");
  });
});

describe("换行 / 行号 / 字号", () => {
  it("默认自动换行并显示行号，可分别关闭", async () => {
    mockText("a.ts", "const a = 1;\nconst b = 2;");
    render(<FileTextPreview path="D:\\a\\a.ts" name="a.ts" size={40} />);
    await waitFor(() => expect(document.querySelector(".fw-preview-code")).toBeTruthy());

    expect(scroll().getAttribute("data-wrap")).toBe("true");
    expect(scroll().getAttribute("data-line-numbers")).toBe("true");

    fireEvent.click(screen.getByLabelText("fw.preview.wrap"));
    expect(scroll().getAttribute("data-wrap")).toBe("false");

    fireEvent.click(screen.getByLabelText("fw.preview.lineNumbers"));
    expect(scroll().getAttribute("data-line-numbers")).toBe("false");
  });

  it("字号只改变内容区变量，不改变文件内容", async () => {
    mockText("a.ts", "const a = 1;");
    render(<FileTextPreview path="D:\\a\\a.ts" name="a.ts" size={12} />);
    await waitFor(() => expect(document.querySelector(".fw-preview-code")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("fw.preview.fontLarger"));
    expect(scroll().style.getPropertyValue("--fw-preview-font-size")).toBe("13px");
    expect(scroll().textContent).toContain("const a = 1;");
  });
});

describe("CSV 表格视图", () => {
  it("默认表格模式：表头、行号列，且不再重复读盘", async () => {
    mockText("a.csv", "name,age\nAlice,30\nBob,25\n");
    render(<FileTextPreview path="D:\\a\\a.csv" name="a.csv" size={30} />);
    await waitFor(() => expect(document.querySelector(".fw-csv-table")).toBeTruthy());

    expect(document.querySelector(".fw-csv-table thead th:not(.fw-csv-index)")?.textContent).toBe("name");
    expect(document.querySelectorAll(".fw-csv-table tbody tr")).toHaveLength(2);
    expect(document.querySelector(".fw-csv-table tbody tr td")?.textContent).toBe("Alice");
    // 查找框只服务源码/文本视图：表格模式下不显示，避免「查找命中表格」的假能力。
    expect(screen.queryByLabelText("fw.preview.find")).toBeNull();
    expect(bridgeMocks.fsReadText).toHaveBeenCalledTimes(1);
  });

  it("表格与源码之间切换不重新读取文件", async () => {
    mockText("a.csv", "name,age\nAlice,30\n");
    render(<FileTextPreview path="D:\\a\\a.csv" name="a.csv" size={20} />);
    await waitFor(() => expect(document.querySelector(".fw-csv-table")).toBeTruthy());

    fireEvent.click(screen.getByText("fw.preview.sourceMode"));
    await waitFor(() => expect(document.querySelector(".fw-preview-code")).toBeTruthy());
    expect(document.querySelector(".fw-csv-table")).toBeNull();
    expect(screen.getByLabelText("fw.preview.find")).toBeTruthy();

    fireEvent.click(screen.getByText("fw.preview.csv.mode"));
    await waitFor(() => expect(document.querySelector(".fw-csv-table")).toBeTruthy());
    expect(bridgeMocks.fsReadText).toHaveBeenCalledTimes(1);
  });

  it("表头开关把首行变成数据行", async () => {
    mockText("a.csv", "name,age\nAlice,30\n");
    render(<FileTextPreview path="D:\\a\\a.csv" name="a.csv" size={20} />);
    await waitFor(() => expect(document.querySelector(".fw-csv-table thead")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("fw.preview.csv.headerToggle"));
    await waitFor(() => expect(document.querySelector(".fw-csv-table thead")).toBeNull());
    expect(document.querySelectorAll(".fw-csv-table tbody tr")).toHaveLength(2);
  });
});

describe("大小写敏感搜索", () => {
  it("Foo foo FOO：默认忽略大小写 3 条，开关后只 1 条，且不触发读取", async () => {
    mockText("case.txt", "Foo foo FOO");
    render(<FileTextPreview path="D:\\a\\case.txt" name="case.txt" size={11} />);
    await waitFor(() => expect(document.querySelector(".fw-preview-code")).toBeTruthy());

    const input = screen.getByLabelText("fw.preview.find") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Foo" } });
    await waitFor(() => expect(document.querySelectorAll(".fw-preview-match")).toHaveLength(3));

    const toggle = screen.getByLabelText("fw.preview.caseSensitive");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(document.querySelectorAll(".fw-preview-match")).toHaveLength(1));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".fw-preview-match.is-active")?.textContent).toBe("Foo");

    fireEvent.click(toggle);
    await waitFor(() => expect(document.querySelectorAll(".fw-preview-match")).toHaveLength(3));
    expect(bridgeMocks.fsReadText).toHaveBeenCalledTimes(1);
  });
});

describe("搜索范围与渲染范围一致（6000 行）", () => {
  const LINES = Array.from({ length: 6000 }, (_, index) =>
    index === 99 ? "unique-in-range" : index === 5499 ? "unique-out-of-range" : `line ${index + 1}`,
  );

  it("未渲染的尾部不参与搜索：无假命中、明确提示范围受限、DOM 有界", async () => {
    mockText("big.txt", LINES.join("\n"));
    render(<FileTextPreview path="D:\\a\\big.txt" name="big.txt" size={LINES.join("\n").length} />);
    await waitFor(() => expect(document.querySelector(".fw-preview-code")).toBeTruthy());

    // 渲染有上限：只有前 5000 行，行号不会出现 5500。
    expect(document.querySelectorAll(".fw-preview-code-line")).toHaveLength(5000);
    expect(scroll().textContent).not.toContain("unique-out-of-range");

    fireEvent.change(screen.getByLabelText("fw.preview.find"), { target: { value: "unique-out-of-range" } });
    await waitFor(() =>
      expect(document.querySelector(".fw-preview-text-meta")?.textContent).toContain(
        "fw.preview.searchScopeCapped",
      ),
    );
    // 不显示「命中 1 条」却没有可定位元素：计数必须为 0。
    expect(document.querySelectorAll(".fw-preview-match")).toHaveLength(0);
    expect(document.querySelector(".fw-preview-search-count")?.textContent).toBe("fw.preview.noMatch");
  });

  it("渲染范围内的命中可以真实定位到 DOM 元素", async () => {
    mockText("big.txt", LINES.join("\n"));
    render(<FileTextPreview path="D:\\a\\big.txt" name="big.txt" size={LINES.join("\n").length} />);
    await waitFor(() => expect(document.querySelector(".fw-preview-code")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("fw.preview.find"), { target: { value: "unique-in-range" } });
    await waitFor(() => expect(document.querySelectorAll(".fw-preview-match")).toHaveLength(1));
    const mark = document.querySelector(".fw-preview-match.is-active");
    expect(mark?.getAttribute("data-match-index")).toBe("0");
    expect(mark?.textContent).toBe("unique-in-range");
  });
});

describe("JSON 树形视图", () => {
  it("默认只展开根，可逐层与全部展开/收起", async () => {
    mockText("a.json", '{"a":{"b":1},"c":[7,8]}');
    render(<FileTextPreview path="D:\\a\\a.json" name="a.json" size={40} />);
    await waitFor(() => expect(document.querySelector(".fw-json-tree")).toBeTruthy());

    // 根 + a + c 三行可见，孙级 b 默认折叠。
    expect(document.querySelectorAll(".fw-json-row")).toHaveLength(3);
    expect(screen.getByText("c")).toBeTruthy();
    expect(screen.queryByText("b")).toBeNull();

    const [expandAll, collapseAll] = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".fw-json-toolbar button"),
    );
    fireEvent.click(expandAll);
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    expect(document.querySelectorAll(".fw-json-row")).toHaveLength(6);

    fireEvent.click(collapseAll);
    await waitFor(() => expect(document.querySelectorAll(".fw-json-row")).toHaveLength(1));
    // 展开/收起只改渲染，不触发文件读取。
    expect(bridgeMocks.fsReadText).toHaveBeenCalledTimes(1);
  });

  it("非法 JSON 自动回退源码并说明原因，树形按钮禁用", async () => {
    mockText("bad.json", '{"a":1,}');
    render(<FileTextPreview path="D:\\a\\bad.json" name="bad.json" size={10} />);
    await waitFor(() => expect(document.querySelector(".fw-preview-code")).toBeTruthy());

    expect(document.querySelector(".fw-json-tree")).toBeNull();
    expect(document.querySelector(".fw-preview-text-meta")?.textContent).toContain(
      "fw.preview.json.fallbackChip",
    );
    const treeButton = screen.getByText("fw.preview.json.mode").closest("button");
    expect(treeButton?.disabled).toBe(true);
    // 提示条带上解析器原因，不是静默回退。
    expect(document.querySelector(".fw-preview-encoding")?.textContent).toBeTruthy();
  });
});
