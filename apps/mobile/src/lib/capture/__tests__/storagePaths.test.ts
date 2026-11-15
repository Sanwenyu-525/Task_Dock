// 采集存储的纯函数测试：文件名清洗、扩展名映射、URI ↔ 路径互转。
//
// 这里 mock 掉 expo-file-system：本文件只验证纯函数，不触碰真实文件系统；
// 真机上的落盘/复制路径由 CaptureScreen 的端到端验证覆盖。
import { describe, expect, it, vi } from "vitest";

vi.mock("expo-file-system", () => ({
  Directory: class {},
  File: class {},
  FileMode: { ReadOnly: "r", WriteOnly: "w" },
  Paths: { document: "file:///data/user/0/dev.taskdock.mobile/files" },
}));

import {
  attachStorageName,
  extensionForMime,
  fileUriFromPath,
  pathFromFileUri,
  sanitizeFileName,
} from "../storage";

describe("sanitizeFileName", () => {
  it("只保留 basename，去掉路径段", () => {
    expect(sanitizeFileName("../../etc/passwd", "file")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\a\\report.pdf", "file")).toBe("report.pdf");
  });

  it("替换 Windows 保留字符与控制字符", () => {
    expect(sanitizeFileName("a:b|c?.txt", "file")).toBe("a_b_c_.txt");
    expect(sanitizeFileName("bad\u0000name.png", "file")).toBe("badname.png");
  });

  it("空名与纯点名回退到默认名", () => {
    expect(sanitizeFileName("", "file")).toBe("file");
    expect(sanitizeFileName("   ", "file")).toBe("file");
    expect(sanitizeFileName("..", "file")).toBe("file");
  });
});

describe("extensionForMime", () => {
  it("已知 MIME 取对应后缀", () => {
    expect(extensionForMime("image/png", "image")).toBe(".png");
    expect(extensionForMime("audio/mp4", "audio")).toBe(".m4a");
    expect(extensionForMime("application/pdf", "file")).toBe(".pdf");
  });

  it("未知 MIME 按类型回退", () => {
    expect(extensionForMime("application/x-unknown", "image")).toBe(".jpg");
    expect(extensionForMime("application/x-unknown", "audio")).toBe(".m4a");
    expect(extensionForMime("application/x-unknown", "file")).toBe(".bin");
  });
});

describe("attachStorageName", () => {
  it("文件名由本地生成，不沿用来源路径", () => {
    const name = attachStorageName("image", "image/jpeg", "/tmp/../x/photo.jpg");
    expect(name.startsWith("image-photo_")).toBe(true);
    expect(name.endsWith(".jpg")).toBe(true);
    expect(name.includes("/")).toBe(false);
    expect(name.includes("..")).toBe(false);
  });

  it("缺省名字按类型回退", () => {
    expect(attachStorageName("audio", "audio/mp4", "").startsWith("audio-voice_")).toBe(true);
    expect(attachStorageName("file", "application/octet-stream", null).startsWith("file-file_")).toBe(
      true,
    );
  });
});

describe("fileUriFromPath / pathFromFileUri", () => {
  it("绝对路径补 file:// 前缀", () => {
    expect(fileUriFromPath("/data/user/0/p/files/a.jpg")).toBe("file:///data/user/0/p/files/a.jpg");
  });

  it("已带 scheme 的 URI 原样返回", () => {
    expect(fileUriFromPath("file:///a/b.jpg")).toBe("file:///a/b.jpg");
    expect(fileUriFromPath("content://media/external/images/media/1")).toBe(
      "content://media/external/images/media/1",
    );
  });

  it("file:// URI 解码回绝对路径（中文与空格）", () => {
    expect(pathFromFileUri("file:///data/user/0/p/files/capture/audio-%E8%AF%AD%E9%9F%B3%200_05.m4a")).toBe(
      "/data/user/0/p/files/capture/audio-语音 0_05.m4a",
    );
  });

  it("解码失败时退回原文，不抛异常", () => {
    expect(pathFromFileUri("file:///data/bad%E0%A4%A.m4a")).toBe("/data/bad%E0%A4%A.m4a");
  });

  it("content:// 原样返回，不做百分号解码", () => {
    expect(pathFromFileUri("content://media/external/images/media/1")).toBe(
      "content://media/external/images/media/1",
    );
  });
});
