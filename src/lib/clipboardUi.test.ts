import { describe, expect, it } from "vitest";
import {
  RICH_EMBED_BUDGET,
  RICH_HTML_ITEM_LIMIT,
  copyPreflight,
  formatBytes,
  looksLikeCode,
  sourceLabel,
  urlDomain,
} from "./clipboardUi";

describe("sourceLabel", () => {
  it("空来源或 unknown 显示未知来源", () => {
    expect(sourceLabel("", "")).toBe("未知来源");
    expect(sourceLabel("unknown", "")).toBe("未知来源");
    expect(sourceLabel("UNKNOWN", "")).toBe("未知来源");
  });

  it("保留应用名与窗口标题", () => {
    expect(sourceLabel("C:\\Apps\\Code.exe", "main.rs")).toBe("Code.exe · main.rs");
    expect(sourceLabel("chrome.exe", "chrome.exe")).toBe("chrome.exe");
  });
});

describe("copyPreflight", () => {
  const MB = 1024 * 1024;

  it("没有图片时不产生内嵌警告", () => {
    const p = copyPreflight([{ kind: "text", byte_size: 12 }]);
    expect(p.images).toBe(0);
    expect(p.willEmbedAllImages).toBe(true);
    expect(p.warnings).toEqual([]);
    expect(p.totalBytes).toBe(12);
  });

  it("图片在 6 MB 内嵌预算内时说明 Base64 体积", () => {
    const p = copyPreflight([{ kind: "image", byte_size: 1 * MB }]);
    expect(p.willEmbedAllImages).toBe(true);
    expect(p.estimatedEmbedBytes).toBe(Math.ceil((1 * MB * 4) / 3));
    expect(p.warnings[0]).toContain("内嵌 1 张图片");
    expect(p.warnings[0]).toContain(formatBytes(p.estimatedEmbedBytes));
  });

  it("图片超过预算时明确降级为占位符并给出替代方案", () => {
    const p = copyPreflight([{ kind: "image", byte_size: RICH_EMBED_BUDGET }]);
    expect(p.willEmbedAllImages).toBe(false);
    expect(p.warnings.join("；")).toContain("占位符");
    expect(p.warnings.join("；")).toContain("逐项粘贴");
  });

  it("文件条目区分文件本体与富文本名称清单", () => {
    const p = copyPreflight([{ kind: "files", byte_size: 0 }]);
    expect(p.files).toBe(1);
    expect(p.warnings.join("；")).toContain("只保留名称清单");
  });

  it("超大富文本提示降级为纯文本", () => {
    const p = copyPreflight([{ kind: "html", byte_size: RICH_HTML_ITEM_LIMIT + 1 }]);
    expect(p.oversizedHtml).toBe(1);
    expect(p.warnings.join("；")).toContain("降级为纯文本");
  });

  it("混合分组同时统计图片与文件并累计总大小", () => {
    const p = copyPreflight([
      { kind: "text", byte_size: 10 },
      { kind: "image", byte_size: 2 * MB },
      { kind: "files", byte_size: 30 },
    ]);
    expect(p.images).toBe(1);
    expect(p.imageBytes).toBe(2 * MB);
    expect(p.files).toBe(1);
    expect(p.totalBytes).toBe(10 + 2 * MB + 30);
    expect(p.willEmbedAllImages).toBe(true);
  });

  it("非法大小按 0 处理，不产生 NaN", () => {
    const p = copyPreflight([{ kind: "text", byte_size: Number.NaN }]);
    expect(p.totalBytes).toBe(0);
    expect(Number.isNaN(p.estimatedEmbedBytes)).toBe(false);
  });
});

describe("urlDomain", () => {
  it("http/https 提取域名", () => {
    expect(urlDomain("https://example.com/a/b?x=1")).toBe("example.com");
    expect(urlDomain("http://127.0.0.1:8080/x")).toBe("127.0.0.1");
    // URL API 对国际化域名返回 punycode 形式（标准行为，且能防同形异义字符伪装）
    expect(urlDomain("  https://文档.example.cn/  ")).toBe("xn--7dvp7d.example.cn");
  });

  it("非 http/https 与解析失败返回空串，不产出假域名", () => {
    expect(urlDomain("javascript:alert(1)")).toBe("");
    expect(urlDomain("file:///C:/Windows")).toBe("");
    expect(urlDomain("not a url")).toBe("");
    expect(urlDomain("")).toBe("");
  });
});

describe("looksLikeCode", () => {
  it("缩进 + 关键字共现的代码判为 true", () => {
    const js = [
      "function add(a, b) {",
      "  const sum = a + b;",
      "  return sum;",
      "}",
    ].join("\n");
    expect(looksLikeCode(js)).toBe(true);

    const rust = [
      "fn main() {",
      "    let x = vec![1, 2, 3];",
      "    for v in &x {",
      "        println!(\"{}\", v);",
      "    }",
      "}",
    ].join("\n");
    expect(looksLikeCode(rust)).toBe(true);
  });

  it("普通中文/英文段落判为 false（自然语言反信号）", () => {
    const zh = [
      "task_dock 是一个 Windows 桌面任务启动器。",
      "这次升级把剪贴板变成轻量的多类型内容管理器。",
      "不同类型的内容提供专属的详情和操作，交互保持统一。",
    ].join("\n");
    expect(looksLikeCode(zh)).toBe(false);

    const en = [
      "The quick brown fox jumps over the lazy dog near the river bank.",
      "Then it ran across the field and disappeared into the woods.",
      "Nobody saw where it went, and the story ends there.",
    ].join("\n");
    expect(looksLikeCode(en)).toBe(false);
  });

  it("Markdown 列表与短文本不误判", () => {
    expect(looksLikeCode("- 第一项\n- 第二项\n- 第三项")).toBe(false);
    expect(looksLikeCode("单行内容")).toBe(false);
    expect(looksLikeCode("")).toBe(false);
  });

  it("两行以内不足置信度，按普通文本处理", () => {
    expect(looksLikeCode("npm install -g pnpm\nnpx tsc --noEmit")).toBe(false);
  });

  it("JSON 带缩进与符号判为 true（等宽阅读更合适）", () => {
    const json = [
      "{",
      '  "name": "task-dock",',
      '  "version": "0.7.0",',
      '  "deps": {',
      '    "react": "18.0.0"',
      "  }",
      "}",
    ].join("\n");
    expect(looksLikeCode(json)).toBe(true);
  });
});
