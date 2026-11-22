/**
 * @vitest-environment jsdom
 */
//! 目标窗口图标：同 exe 复用缓存、失败统一回退、失败按窗口身份负缓存、
//! 不同 exe 各自请求；图标加载不阻塞卡片选择/跳转（由 PastePanel 用例覆盖）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  clipboardTargetIcon: vi.fn(),
}));
vi.mock("../../lib/bridge", () => bridge);

/** 每个用例重置模块级缓存，避免用例之间共享命中结果。 */
async function loadTargetIcon() {
  vi.resetModules();
  return (await import("./TargetIcon")).default;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("TargetIcon", () => {
  it("同一 exe 的多个窗口只请求一次图标并复用缓存", async () => {
    const TargetIcon = await loadTargetIcon();
    bridge.clipboardTargetIcon.mockResolvedValue("data:image/png;base64,AA");

    const view = render(
      <>
        <TargetIcon hwnd={1} pid={11} exePath="C:\\Apps\\Code.exe" />
        <TargetIcon hwnd={2} pid={22} exePath="c:\\apps\\code.exe" />
      </>,
    );

    await waitFor(() => expect(view.container.querySelectorAll("img").length).toBe(2));
    expect(bridge.clipboardTargetIcon).toHaveBeenCalledTimes(1);
    expect(bridge.clipboardTargetIcon).toHaveBeenCalledWith(1, 11);
  });

  it("提取失败回退统一通用图标，并按窗口身份负缓存避免重复请求", async () => {
    const TargetIcon = await loadTargetIcon();
    bridge.clipboardTargetIcon.mockRejectedValue("窗口已关闭");

    const view = render(<TargetIcon hwnd={7} pid={77} exePath="C:\\Apps\\Gone.exe" />);
    await waitFor(() => expect(bridge.clipboardTargetIcon).toHaveBeenCalledTimes(1));
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("svg")).toBeTruthy();

    view.unmount();
    const again = render(<TargetIcon hwnd={7} pid={77} exePath="C:\\Apps\\Gone.exe" />);
    await waitFor(() => expect(bridge.clipboardTargetIcon).toHaveBeenCalledTimes(1));
    expect(again.container.querySelector("img")).toBeNull();
  });

  it("不同 exe 各自请求，不复用别人的图标", async () => {
    const TargetIcon = await loadTargetIcon();
    bridge.clipboardTargetIcon
      .mockResolvedValueOnce("data:image/png;base64,AA")
      .mockResolvedValueOnce("data:image/png;base64,BB");

    const view = render(
      <>
        <TargetIcon hwnd={3} pid={33} exePath="C:\\Apps\\A.exe" />
        <TargetIcon hwnd={4} pid={44} exePath="C:\\Apps\\B.exe" />
      </>,
    );

    await waitFor(() => expect(view.container.querySelectorAll("img").length).toBe(2));
    expect(bridge.clipboardTargetIcon).toHaveBeenCalledTimes(2);
  });
});
