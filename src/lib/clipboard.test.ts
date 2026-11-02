/**
 * @vitest-environment jsdom
 */
//! 剪贴板写入路径：原生窗口必须走受控写入，浏览器预览才允许 Web API。

import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ clipboardCopyText: vi.fn() }));
vi.mock("./bridge", () => bridge);

const tauri = vi.hoisted(() => ({ isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => tauri);

import { copyText } from "./clipboard";

beforeEach(() => {
  vi.clearAllMocks();
  bridge.clipboardCopyText.mockReset();
  tauri.isTauri.mockReset();
});

describe("copyText", () => {
  it("Tauri 内统一走受控命令并返回成功", async () => {
    tauri.isTauri.mockReturnValue(true);
    bridge.clipboardCopyText.mockResolvedValue(undefined);

    expect(await copyText("C:\\导出目录")).toBe(true);
    expect(bridge.clipboardCopyText).toHaveBeenCalledWith("C:\\导出目录");
  });

  it("Tauri 内受控写入失败时不回退 Web API", async () => {
    tauri.isTauri.mockReturnValue(true);
    bridge.clipboardCopyText.mockRejectedValue(new Error("剪贴板被占用"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    expect(await copyText("令牌")).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("浏览器预览（非 Tauri）仍使用 Web API", async () => {
    tauri.isTauri.mockReturnValue(false);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    expect(await copyText("预览文本")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("预览文本");
    expect(bridge.clipboardCopyText).not.toHaveBeenCalled();
  });
});
