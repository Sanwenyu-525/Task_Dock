//! 预览类型判定纯函数：格式矩阵 / 上限 / 语言标签的唯一口径。
//! 新增格式时先改 previewKind.ts，再补这里的矩阵断言。

import { describe, expect, it } from "vitest";
import {
  PDF_MAX_BYTES,
  TEXT_PREVIEW_BYTES,
  SVG_MAX_BYTES,
  IMAGE_MAX_BYTES,
  extOf,
  getPreviewKind,
  getPreviewSizeLimit,
  isCodeLike,
  isPreviewSupported,
  previewLanguage,
  previewTypeLabel,
} from "./previewKind";

const file = (name: string, category = "other") =>
  ({ name, category, kind: "file" as const });

describe("getPreviewKind 格式矩阵", () => {
  it.each([
    "a.png",
    "a.jpg",
    "a.jpeg",
    "a.webp",
    "a.gif",
    "a.bmp",
    "a.svg",
    "a.avif",
    "a.ico",
    "a.tif",
    "a.tiff",
  ])("图片：%s", (name) => {
    expect(getPreviewKind(file(name))).toBe("image");
  });

  it.each(["a.txt", "a.md", "a.json", "a.csv", "a.log", "a.yaml", "a.yml", "a.toml", "a.xml", "a.html", "a.css", "a.js", "a.ts", "a.jsx", "a.tsx", "a.py", "a.rs", "a.sql", "a.ini", "a.cfg"])(
    "文本/代码：%s",
    (name) => {
      expect(getPreviewKind(file(name))).toBe("text");
    },
  );

  it.each(["a.mp4", "a.webm", "a.mov", "a.m4v", "a.mkv", "a.avi"])("视频：%s", (name) => {
    expect(getPreviewKind(file(name))).toBe("video");
  });

  it.each(["a.mp3", "a.wav", "a.flac", "a.m4a", "a.aac", "a.ogg", "a.oga"])("音频：%s", (name) => {
    expect(getPreviewKind(file(name))).toBe("audio");
  });

  it("PDF 走 pdf（后端 category=doc 也不能当成 Office 二进制）", () => {
    expect(getPreviewKind(file("manual.pdf", "doc"))).toBe("pdf");
    expect(getPreviewKind(file("manual.pdf", "other"))).toBe("pdf");
  });

  it.each(["a.docx", "a.xlsx", "a.pptx", "a.doc", "a.xls", "a.ppt", "a.zip", "a.7z", "a.exe", "a.dll"])(
    "二进制/未知格式不支持内嵌预览：%s",
    (name) => {
      expect(getPreviewKind(file(name, "doc"))).toBe("unsupported");
      expect(isPreviewSupported(file(name, "doc"))).toBe(false);
    },
  );

  it("扩展名未知时退回后端 category；目录永远不可预览", () => {
    expect(getPreviewKind(file("README", "text"))).toBe("text");
    expect(getPreviewKind(file("photo", "image"))).toBe("image");
    expect(getPreviewKind({ name: "sub", category: "folder", kind: "dir" })).toBe("unsupported");
    expect(getPreviewKind(null)).toBe("unsupported");
  });

  it("大小写扩展名归一", () => {
    expect(getPreviewKind(file("A.PNG"))).toBe("image");
    expect(getPreviewKind(file("B.Pdf"))).toBe("pdf");
  });
});

describe("getPreviewSizeLimit 上限口径", () => {
  it("图片：SVG 单独收紧，其余走原始字节上限", () => {
    expect(getPreviewSizeLimit("image", "svg")).toBe(SVG_MAX_BYTES);
    expect(getPreviewSizeLimit("image", "png")).toBe(IMAGE_MAX_BYTES);
  });

  it("PDF / 文本 / 流式媒体", () => {
    expect(getPreviewSizeLimit("pdf")).toBe(PDF_MAX_BYTES);
    expect(getPreviewSizeLimit("text")).toBe(TEXT_PREVIEW_BYTES);
    expect(getPreviewSizeLimit("video")).toBeNull();
    expect(getPreviewSizeLimit("audio")).toBeNull();
    expect(getPreviewSizeLimit("unsupported")).toBeNull();
  });
});

describe("语言标签与类型徽标", () => {
  it("常见语言有明确标签，未知扩展名回退大写", () => {
    expect(previewLanguage("ts")).toBe("TypeScript");
    expect(previewLanguage("rs")).toBe("Rust");
    expect(previewLanguage("md")).toBe("Markdown");
    expect(previewLanguage("foo")).toBe("FOO");
  });

  it("文本徽标显示语言，二进制显示扩展名", () => {
    expect(previewTypeLabel("text", "ts")).toBe("TypeScript");
    expect(previewTypeLabel("pdf", "pdf")).toBe("PDF");
    expect(previewTypeLabel("unsupported", "docx")).toBe("DOCX");
  });

  it("纯文本不做关键字染色，代码类做", () => {
    expect(isCodeLike("txt")).toBe(false);
    expect(isCodeLike("log")).toBe(false);
    expect(isCodeLike("ts")).toBe(true);
    expect(isCodeLike("")).toBe(false);
  });

  it("extOf 把隐藏文件名当扩展名处理，空扩展名不算", () => {
    expect(extOf(".gitignore")).toBe("gitignore");
    expect(extOf("a.")).toBe("");
    expect(extOf("a.tar.gz")).toBe("gz");
  });
});
