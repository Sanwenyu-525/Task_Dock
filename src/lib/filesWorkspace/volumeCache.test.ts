//! 卷缓存安全默认：未知不回退盘符，多源必须全部同卷才允许 move。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  fsVolumeKeys: vi.fn(),
}));

import { fsVolumeKeys } from "../bridge";
import { invalidateVolumeCache, primeVolumeKeys, volumeDecision } from "./volumeCache";

const keys = vi.mocked(fsVolumeKeys);

beforeEach(() => {
  invalidateVolumeCache();
  keys.mockReset();
});

describe("volumeDecision", () => {
  it("缓存未命中返回 null，调用方必须按复制处理", () => {
    expect(volumeDecision(["D:\\a\\f.txt"], "D:\\b")).toBeNull();
  });

  it("明确同卷才 move", async () => {
    keys.mockResolvedValue(["\\\\?\\volume{c}\\", "\\\\?\\volume{c}\\"]);
    await primeVolumeKeys(["D:\\a\\f.txt", "D:\\b"]);
    expect(volumeDecision(["D:\\a\\f.txt"], "D:\\b")).toBe("move");
  });

  it("同盘符但卷键不同 → copy", async () => {
    keys.mockResolvedValue(["\\\\?\\volume{c1}\\", "\\\\?\\volume{c2}\\"]);
    await primeVolumeKeys(["D:\\mount-a\\f.txt", "D:\\mount-b"]);
    expect(volumeDecision(["D:\\mount-a\\f.txt"], "D:\\mount-b")).toBe("copy");
  });

  it("多源中任一源卷未知 → null，不静默按已知源移动", async () => {
    keys.mockResolvedValue(["\\\\?\\volume{c}\\", null, "\\\\?\\volume{c}\\"]);
    await primeVolumeKeys(["D:\\a\\one.txt", "D:\\a\\unknown.txt", "D:\\b"]);
    expect(volumeDecision(["D:\\a\\one.txt", "D:\\a\\unknown.txt"], "D:\\b")).toBeNull();
  });

  it("多源跨卷 → copy", async () => {
    keys.mockResolvedValue(["\\\\?\\volume{c1}\\", "\\\\?\\volume{c2}\\", "\\\\?\\volume{c1}\\"]);
    await primeVolumeKeys(["D:\\a\\one.txt", "D:\\b\\two.txt", "D:\\b"]);
    expect(volumeDecision(["D:\\a\\one.txt", "D:\\b\\two.txt"], "D:\\b")).toBe("copy");
  });

  it("缓存失效后重新变为未知", async () => {
    keys.mockResolvedValue(["k1", "k1"]);
    await primeVolumeKeys(["D:\\a\\f.txt", "D:\\b"]);
    expect(volumeDecision(["D:\\a\\f.txt"], "D:\\b")).toBe("move");
    invalidateVolumeCache(["D:\\a\\f.txt"]);
    expect(volumeDecision(["D:\\a\\f.txt"], "D:\\b")).toBeNull();
  });

  it("UNC 明确同卷才 move，共享路径无法解析时保持 null", async () => {
    keys.mockResolvedValue(["\\\\srv\\share", "\\\\srv\\share"]);
    await primeVolumeKeys(["\\\\srv\\share\\a\\f.txt", "\\\\srv\\share\\b"]);
    expect(volumeDecision(["\\\\srv\\share\\a\\f.txt"], "\\\\srv\\share\\b")).toBe("move");

    invalidateVolumeCache();
    keys.mockResolvedValue([null, "\\\\srv\\share"]);
    await primeVolumeKeys(["\\\\srv\\share\\a\\f.txt", "\\\\srv\\share\\b"]);
    expect(volumeDecision(["\\\\srv\\share\\a\\f.txt"], "\\\\srv\\share\\b")).toBeNull();
  });

  it("符号链接/junction 解析到不同卷键时按 copy（模拟真机未验证）", async () => {
    keys.mockResolvedValue(["\\\\?\\volume{target-d}\\", "\\\\?\\volume{target-c}\\"]);
    await primeVolumeKeys(["D:\\link-to-c\\f.txt", "C:\\real\\b"]);
    expect(volumeDecision(["D:\\link-to-c\\f.txt"], "C:\\real\\b")).toBe("copy");
  });

  it("查询失败不缓存 null，允许下一次重试", async () => {
    keys.mockRejectedValueOnce(new Error("volume query failed"));
    await primeVolumeKeys(["D:\\a\\f.txt", "D:\\b"]);
    expect(volumeDecision(["D:\\a\\f.txt"], "D:\\b")).toBeNull();

    keys.mockResolvedValue(["k1", "k1"]);
    await primeVolumeKeys(["D:\\a\\f.txt", "D:\\b"]);
    expect(volumeDecision(["D:\\a\\f.txt"], "D:\\b")).toBe("move");
  });
});
