/**
 * @vitest-environment jsdom
 */
//! 图片粘贴的纯逻辑：从剪贴板挑图、尺寸/数量闸门、base64 与尺寸换算。
//! canvas 归一化不在单测里跑（jsdom 无排版/编码），由真实窗口验收覆盖。

import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_ATTACHMENTS,
  MAX_SOURCE_BYTES,
  bytesToBase64,
  extractClipboardImages,
  fitWithin,
  formatBytes,
  validatePastedImage,
} from "./captureImages";

function file(name: string, type: string, size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

/** 最小 DataTransfer 替身：只实现 extractClipboardImages 读取的字段。 */
function dataTransfer(items: Array<{ kind: string; file: File | null }>, files: File[] = []) {
  return {
    items: items.map(({ kind, file: f }) => ({
      kind,
      type: f?.type ?? "",
      getAsFile: () => f,
    })),
    files,
  } as unknown as DataTransfer;
}

describe("extractClipboardImages", () => {
  it("只挑 file 项，忽略字符串项", () => {
    const shot = file("shot.png", "image/png");
    const data = dataTransfer([
      { kind: "string", file: null },
      { kind: "file", file: shot },
      { kind: "file", file: null },
    ]);
    expect(extractClipboardImages(data)).toEqual([shot]);
  });

  it("items 为空时回退到 files 列表", () => {
    const shot = file("shot.png", "image/png");
    expect(extractClipboardImages(dataTransfer([], [shot]))).toEqual([shot]);
  });

  it("null / 纯文本返回空数组（调用方据此保持原生粘贴）", () => {
    expect(extractClipboardImages(null)).toEqual([]);
    expect(extractClipboardImages(dataTransfer([{ kind: "string", file: null }]))).toEqual([]);
  });

  it("支持一次粘贴多张", () => {
    const a = file("a.png", "image/png");
    const b = file("b.jpg", "image/jpeg");
    expect(
      extractClipboardImages(
        dataTransfer([
          { kind: "file", file: a },
          { kind: "file", file: b },
        ]),
      ),
    ).toHaveLength(2);
  });
});

describe("validatePastedImage", () => {
  it("接受 PNG / JPEG / WebP", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect(validatePastedImage(file("x", type), 0)).toBeNull();
    }
  });

  it("拒绝 GIF / SVG / 非图片类型", () => {
    for (const type of ["image/gif", "image/svg+xml", "text/plain", "application/pdf"]) {
      expect(validatePastedImage(file("x", type), 0)).toContain("PNG / JPEG / WebP");
    }
  });

  it("没有 type 时交给后端签名校验（不在这里误杀剪贴板截图）", () => {
    expect(validatePastedImage(file("clipboard", ""), 0)).toBeNull();
  });

  it("空文件与超大文件被拒绝", () => {
    expect(validatePastedImage(file("empty.png", "image/png", 0), 0)).toContain("为空");
    expect(
      validatePastedImage(file("huge.png", "image/png", MAX_SOURCE_BYTES + 1), 0),
    ).toContain("20 MB");
  });

  it("数量达到上限后拒绝", () => {
    const shot = file("x.png", "image/png");
    expect(validatePastedImage(shot, MAX_IMAGE_ATTACHMENTS - 1)).toBeNull();
    expect(validatePastedImage(shot, MAX_IMAGE_ATTACHMENTS)).toContain("最多添加");
  });
});

describe("fitWithin", () => {
  it("不放大，只按长边缩小", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600, scaled: false });
    const big = fitWithin(4800, 2700);
    expect(big?.width).toBe(2400);
    expect(big?.height).toBe(1350);
    expect(big?.scaled).toBe(true);
  });

  it("非法尺寸返回 null", () => {
    for (const [w, h] of [
      [0, 10],
      [10, 0],
      [Number.NaN, 10],
      [Number.POSITIVE_INFINITY, 10],
    ]) {
      expect(fitWithin(w, h)).toBeNull();
    }
  });
});

describe("bytesToBase64 / formatBytes", () => {
  it("按块编码，结果与 btoa 一致", () => {
    const bytes = new Uint8Array(70000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    const encoded = bytesToBase64(bytes);
    expect(encoded.length % 4).toBe(0);
    expect(atob(encoded).length).toBe(bytes.length);
    expect(bytesToBase64(new Uint8Array([0x50, 0x4e, 0x47]))).toBe("UE5H");
  });

  it("格式化大小不出现 0 MB / NaN", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(900)).toBe("1 KB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });
});
