import { describe, expect, it } from "vitest";
import {
  RICH_EMBED_BUDGET,
  RICH_HTML_ITEM_LIMIT,
  copyPreflight,
  formatBytes,
  sourceLabel,
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
