// 系统文件选择器导入回归：content:// 必须走 SAF 流式复制，不能依赖 File.copy。
import { describe, expect, it, beforeEach } from "vitest";

import { __activeFiles, __resetFs, __seedFile } from "../src/test/mocks/expo-file-system";
import { File } from "expo-file-system";
import { importToLibrary } from "../src/features/capture/files";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x41]);

describe("importToLibrary", () => {
  beforeEach(() => {
    __resetFs();
  });

  it("content:// PDF 可复制进 library 并保留真实字节", async () => {
    const source = __seedFile("content://com.android.providers.media.documents/document", "报告.pdf", PDF_BYTES, "application/pdf");

    const result = await importToLibrary(source.uri, "pdf");

    expect(result.uri.startsWith("file://")).toBe(true);
    expect(result.size).toBe(PDF_BYTES.length);
    expect(new File(result.uri).exists).toBe(true);
    await expect(new File(result.uri).digest("SHA-256")).resolves.toBe(
      "986f6b5ad30795980fcb5d772809f55156b6a9b4000e8be6ad633f21c12a6b1e",
    );
  });

  it("content:// JPEG 未知大小也按流式复制", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const source = __seedFile("content://media/external/images/media", "照片 1.jpg", jpeg, "image/jpeg");

    const result = await importToLibrary(source.uri, "jpg");

    expect(result.size).toBe(jpeg.length);
    expect(new File(result.uri).size).toBe(jpeg.length);
  });

  it("file:// 常规文件仍可直接复制", async () => {
    const source = __seedFile(
      "file:///data/user/0/dev.taskdock.mobile/cache",
      "audio.m4a",
      new Uint8Array([0, 1, 2, 3, 4]),
      "audio/mp4",
    );

    const result = await importToLibrary(source.uri, "m4a");

    expect(result.size).toBe(5);
    expect(new File(result.uri).exists).toBe(true);
  });

  it("读取失败时清理目标半成品，不留下坏引用", async () => {
    const before = __activeFiles().filter((uri) => uri.includes("/library/"));

    await expect(importToLibrary("content://provider/missing.pdf", "pdf")).rejects.toThrow();

    const after = __activeFiles().filter((uri) => uri.includes("/library/"));
    expect(after).toEqual(before);
  });
});
