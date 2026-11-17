/**
 * @vitest-environment jsdom
 */
//! 快速预览：媒体 token 生命周期 + 已验证能力回归（第六轮 P1）。
//!
//! 覆盖：
//! - 卸载 / 关闭释放活跃媒体 token；同一 token 多条清理路径只释放一次；
//! - 请求失败有可见反馈且不泄漏 token；图片 base64 不占媒体槽位；
//! - 连续切换 50 个媒体文件：注册数 == 释放数，每个 token 恰好释放一次，无未释放；
//! - 音频切换替换旧元素、不重复播放旧音频；
//! - 回归：代码/文本行号、截断提示、二进制拒绝文本预览、方向键切换、
//!   视频/音频元素渲染、图片缩放。

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FsEntry } from "../../lib/bridge";

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    locale: "zh-CN",
    preference: "zh-CN",
    setPreference: vi.fn(),
    t: (key: string) => key,
  }),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    fsOpen: vi.fn(),
    fsPreviewImage: vi.fn(),
    fsPreviewMediaUrl: vi.fn(),
    fsReadText: vi.fn(),
    fsReleasePreviewUrl: vi.fn(),
  };
});

import {
  fsPreviewImage,
  fsPreviewMediaUrl,
  fsReadText,
  fsReleasePreviewUrl,
} from "../../lib/bridge";
import QuickPreviewDialog, {
  createPreviewTokenTracker,
  type PreviewRequest,
} from "./QuickPreviewDialog";

const imageMock = vi.mocked(fsPreviewImage);
const mediaMock = vi.mocked(fsPreviewMediaUrl);
const textMock = vi.mocked(fsReadText);
const releaseMock = vi.mocked(fsReleasePreviewUrl);

afterEach(() => {
  cleanup();
  imageMock.mockReset();
  mediaMock.mockReset();
  textMock.mockReset();
  releaseMock.mockReset();
});

function entry(name: string, category: string, ext: string): FsEntry {
  return { name, kind: "file", ext, size: 1000, modifiedMs: 1, hidden: false, category };
}
const video = (name: string) => entry(name, "video", "mp4");
const audio = (name: string) => entry(name, "audio", "mp3");
const image = (name: string) => entry(name, "image", "png");
const code = (name: string) => entry(name, "code", "ts");
const binary = (name: string) => entry(name, "program", "exe");

function requestFor(path: string, entries: FsEntry[]): PreviewRequest {
  return { paneId: "p1", dir: "D:\\a", path, entries };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("QuickPreviewDialog 卸载/关闭释放", () => {
  it("组件卸载时释放仍在使用的媒体 token", async () => {
    const pending = deferred<string>();
    mediaMock.mockReturnValue(pending.promise);
    releaseMock.mockResolvedValue(undefined);

    const { unmount } = render(
      <QuickPreviewDialog request={requestFor("a.mp4", [video("a.mp4")])} onClose={() => undefined} />,
    );
    await act(async () => pending.resolve("http://taskdock-preview.localhost/tok-unmount"));

    unmount();

    await waitFor(() =>
      expect(releaseMock).toHaveBeenCalledWith("http://taskdock-preview.localhost/tok-unmount"),
    );
  });

  it("关闭对话框后不残留旧图片/文本内存态（图片是 base64，不走媒体 token）", async () => {
    imageMock.mockResolvedValue("data:image/png;base64,OLD");
    textMock.mockResolvedValue({ path: "D:\\a\\b.ts", size: 9, truncated: false, content: "old text" });

    const { rerender } = render(
      <QuickPreviewDialog
        request={requestFor("b.ts", [code("b.ts")])}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(textMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText("old text")).toBeTruthy();

    rerender(<QuickPreviewDialog request={null} onClose={() => undefined} />);

    // 关闭后旧文本不再渲染；图片路径从未注册媒体 token，释放调用保持 0。
    await waitFor(() => expect(screen.queryByText("old text")).toBeNull());
    expect(document.querySelector("img")).toBeNull();
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("同一 token 被多条清理路径命中时只释放一次（前端去重；后端幂等兜底）", async () => {
    const pending = deferred<string>();
    mediaMock.mockReturnValue(pending.promise);
    releaseMock.mockResolvedValue(undefined);

    const { rerender } = render(
      <QuickPreviewDialog request={requestFor("a.mp4", [video("a.mp4")])} onClose={() => undefined} />,
    );
    await act(async () => pending.resolve("http://taskdock-preview.localhost/tok-double"));

    rerender(<QuickPreviewDialog request={null} onClose={() => undefined} />);
    await waitFor(() =>
      expect(releaseMock).toHaveBeenCalledWith("http://taskdock-preview.localhost/tok-double"),
    );
    // 关闭 effect 与 mediaUrl effect 清理都会命中同一 URL：守卫保证只发一次 IPC。
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});

describe("QuickPreviewDialog 失败反馈", () => {
  it("媒体请求失败：显示可见错误，不调用释放，不残留媒体元素", async () => {
    mediaMock.mockRejectedValue(new Error("boom"));
    render(
      <QuickPreviewDialog request={requestFor("a.mp4", [video("a.mp4")])} onClose={() => undefined} />,
    );
    await waitFor(() => {
      const state = document.querySelector(".fw-preview-state.is-error");
      expect(state).toBeTruthy();
      // t 桩不插值 {error} 参数；可见反馈以错误态渲染为准，原始错误经参数传入。
      expect(state?.textContent).toBe("fw.preview.error");
    });
    expect(releaseMock).not.toHaveBeenCalled();
    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("audio")).toBeNull();
  });

  it("图片解码返回 null 时提示不可用，不调用媒体释放", async () => {
    imageMock.mockResolvedValue(null);
    render(
      <QuickPreviewDialog request={requestFor("a.png", [image("a.png")])} onClose={() => undefined} />,
    );
    await waitFor(() => expect(imageMock).toHaveBeenCalledTimes(1));
    // 解码失败进入可见错误态；无图片元素、不占媒体 token。具体不可用消息经 error
    // 参数传入（真实 locale 由 fw.preview.error 模板插值），t 桩不渲染参数。
    await waitFor(() =>
      expect(document.querySelector(".fw-preview-state.is-error")).toBeTruthy(),
    );
    expect(document.querySelector("img")).toBeNull();
    expect(releaseMock).not.toHaveBeenCalled();
  });
});

describe("QuickPreviewDialog 连续切换资源", () => {
  it("连续切换 50 个视频：每个 token 恰好释放一次，无未释放、无重复释放", async () => {
    const COUNT = 50;
    const entries = Array.from({ length: COUNT }, (_, i) => video(`v${i}.mp4`));
    let seq = 0;
    mediaMock.mockImplementation(() =>
      Promise.resolve(`http://taskdock-preview.localhost/tok-${seq++}`),
    );
    releaseMock.mockResolvedValue(undefined);

    const { rerender } = render(
      <QuickPreviewDialog request={requestFor("v0.mp4", entries)} onClose={() => undefined} />,
    );
    await waitFor(() => expect(mediaMock).toHaveBeenCalledTimes(1));

    for (let i = 1; i < COUNT; i += 1) {
      fireEvent.click(screen.getByLabelText("fw.preview.next"));
      await waitFor(() => expect(mediaMock).toHaveBeenCalledTimes(i + 1));
    }

    // 关闭对话框：释放最后一个 token。
    rerender(<QuickPreviewDialog request={null} onClose={() => undefined} />);

    await waitFor(() => expect(releaseMock).toHaveBeenCalledTimes(COUNT));
    const released = releaseMock.mock.calls.map(([url]) => url);
    // 无重复释放：释放参数去重后数量仍等于注册数。
    expect(new Set(released).size).toBe(COUNT);
    // 无未释放：每个注册过的 token 都出现在释放清单里。
    for (let i = 0; i < COUNT; i += 1) {
      expect(released).toContain(`http://taskdock-preview.localhost/tok-${i}`);
    }
  });

  it("音频切换：旧音频元素被新 src 替换，旧 URL 已释放（不重复播放旧音频）", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    mediaMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    releaseMock.mockResolvedValue(undefined);

    render(
      <QuickPreviewDialog
        request={requestFor("a.mp3", [audio("a.mp3"), audio("b.mp3")])}
        onClose={() => undefined}
      />,
    );
    await act(async () => first.resolve("http://taskdock-preview.localhost/tok-a"));
    const before = document.querySelector("audio");
    expect(before?.getAttribute("src")).toBe("http://taskdock-preview.localhost/tok-a");

    fireEvent.click(screen.getByLabelText("fw.preview.next"));
    await waitFor(() => expect(mediaMock).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve("http://taskdock-preview.localhost/tok-b"));

    await waitFor(() =>
      expect(releaseMock).toHaveBeenCalledWith("http://taskdock-preview.localhost/tok-a"),
    );
    const audios = document.querySelectorAll("audio");
    expect(audios).toHaveLength(1);
    expect(audios[0].getAttribute("src")).toBe("http://taskdock-preview.localhost/tok-b");
  });
});

describe("媒体 token 有界跟踪器", () => {
  it("同一 token 只释放一次；释放后活跃集清空", () => {
    const tracker = createPreviewTokenTracker(4);
    tracker.register("tok-a");
    expect(tracker.activeCount).toBe(1);
    expect(tracker.release("tok-a")).toBe(true);
    expect(tracker.release("tok-a")).toBe(false);
    expect(tracker.activeCount).toBe(0);
    expect(tracker.historySize).toBe(1);
  });

  it("超过历史容量后淘汰最旧，内存有界且不再重复释放旧 token", () => {
    const tracker = createPreviewTokenTracker(4);
    for (let i = 0; i < 10; i += 1) {
      tracker.register(`tok-${i}`);
      expect(tracker.release(`tok-${i}`)).toBe(true);
    }
    expect(tracker.historySize).toBe(4);
    expect(tracker.activeCount).toBe(0);
    // 已释放并淘汰的 token 不在活跃集：旧清理路径再次命中也不会产生第二次 IPC。
    expect(tracker.release("tok-0")).toBe(false);
    expect(tracker.release("tok-9")).toBe(false);
  });
});

describe("QuickPreviewDialog 晚到响应", () => {
  it("关闭后才返回的媒体 URL 立即释放一次，且不渲染媒体元素", async () => {
    const pending = deferred<string>();
    mediaMock.mockReturnValue(pending.promise);
    releaseMock.mockResolvedValue(undefined);

    const { rerender } = render(
      <QuickPreviewDialog request={requestFor("a.mp4", [video("a.mp4")])} onClose={() => undefined} />,
    );
    rerender(<QuickPreviewDialog request={null} onClose={() => undefined} />);

    await act(async () => pending.resolve("http://taskdock-preview.localhost/tok-late-close"));

    await waitFor(() =>
      expect(releaseMock).toHaveBeenCalledWith("http://taskdock-preview.localhost/tok-late-close"),
    );
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector("video")).toBeNull();
  });

  it("卸载后才返回的媒体 URL 立即释放一次，不产生迟到状态更新", async () => {
    const pending = deferred<string>();
    mediaMock.mockReturnValue(pending.promise);
    releaseMock.mockResolvedValue(undefined);

    const { unmount } = render(
      <QuickPreviewDialog request={requestFor("a.mp4", [video("a.mp4")])} onClose={() => undefined} />,
    );
    unmount();

    await act(async () => pending.resolve("http://taskdock-preview.localhost/tok-late-unmount"));

    await waitFor(() =>
      expect(releaseMock).toHaveBeenCalledWith("http://taskdock-preview.localhost/tok-late-unmount"),
    );
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});

describe("QuickPreviewDialog 已验证能力回归", () => {
  it("代码/文本预览：渲染行号并显示截断提示", async () => {
    textMock.mockResolvedValue({
      path: "D:\\a\\b.ts",
      size: 12,
      truncated: true,
      content: "line one\nline two",
    });
    render(
      <QuickPreviewDialog request={requestFor("b.ts", [code("b.ts")])} onClose={() => undefined} />,
    );
    await waitFor(() => expect(screen.getByText("line one")).toBeTruthy());
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("fw.preview.truncated")).toBeTruthy();
  });

  it("二进制/程序文件拒绝文本预览：不调用 fsReadText，显示 unsupported", async () => {
    render(
      <QuickPreviewDialog request={requestFor("x.exe", [binary("x.exe")])} onClose={() => undefined} />,
    );
    await waitFor(() => expect(screen.getByText("fw.preview.unsupported")).toBeTruthy());
    expect(textMock).not.toHaveBeenCalled();
  });

  it("左右方向键在文件间切换，并按顺序读取预览", async () => {
    textMock.mockResolvedValue({ path: "D:\\a\\x.ts", size: 1, truncated: false, content: "first" });
    render(
      <QuickPreviewDialog
        request={requestFor("x.ts", [code("x.ts"), code("y.ts")])}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(textMock).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(textMock).toHaveBeenCalledTimes(2));
    expect(textMock.mock.calls[1][0]).toBe("D:\\a\\y.ts");

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() => expect(textMock).toHaveBeenCalledTimes(3));
    expect(textMock.mock.calls[2][0]).toBe("D:\\a\\x.ts");
  });

  it("视频/音频元素带 controls 渲染", async () => {
    const v = deferred<string>();
    const a = deferred<string>();
    mediaMock.mockReturnValueOnce(v.promise).mockReturnValueOnce(a.promise);
    releaseMock.mockResolvedValue(undefined);
    render(
      <QuickPreviewDialog
        request={requestFor("a.mp4", [video("a.mp4"), audio("b.mp3")])}
        onClose={() => undefined}
      />,
    );
    await act(async () => v.resolve("http://taskdock-preview.localhost/tok-v"));
    const videoEl = document.querySelector("video");
    expect(videoEl).toBeTruthy();
    expect(videoEl?.hasAttribute("controls")).toBe(true);

    fireEvent.click(screen.getByLabelText("fw.preview.next"));
    await waitFor(() => expect(mediaMock).toHaveBeenCalledTimes(2));
    await act(async () => a.resolve("http://taskdock-preview.localhost/tok-aud"));
    await waitFor(() => expect(document.querySelector("audio")).toBeTruthy());
  });

  it("图片缩放：放大按钮退出适配并按百分比显示", async () => {
    imageMock.mockResolvedValue("data:image/png;base64,IMG");
    render(
      <QuickPreviewDialog request={requestFor("a.png", [image("a.png")])} onClose={() => undefined} />,
    );
    await waitFor(() => expect(document.querySelector("img")).toBeTruthy());
    // 初始为适配模式。
    expect(screen.getByText("fw.preview.fit")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("fw.preview.zoomIn"));
    expect(screen.queryByText("fw.preview.fit")).toBeNull();
    expect(screen.getByText(/125%/)).toBeTruthy();
  });
});
