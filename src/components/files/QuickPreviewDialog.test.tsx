/**
 * @vitest-environment jsdom
 */
//! A12 快速预览：媒体 token 生命周期回归。
//! - 关闭对话框（request 置空，组件仍挂载）必须释放已注册媒体 token；
//! - 切换上一个/下一个文件必须释放旧媒体 token；
//! - 被取消的在途媒体请求（切换/关闭后才 resolve）必须释放后端已注册的 token。

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

import { fsPreviewMediaUrl, fsReleasePreviewUrl } from "../../lib/bridge";
import QuickPreviewDialog, { type PreviewRequest } from "./QuickPreviewDialog";

const mediaUrl = vi.mocked(fsPreviewMediaUrl);
const releaseUrl = vi.mocked(fsReleasePreviewUrl);

afterEach(() => {
  cleanup();
  mediaUrl.mockReset();
  releaseUrl.mockReset();
});

function video(name: string): FsEntry {
  return { name, kind: "file", ext: "mp4", size: 1000, modifiedMs: 1, hidden: false, category: "video" };
}

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

describe("QuickPreviewDialog 媒体 token 释放", () => {
  it("关闭预览（request 置空）时释放已注册的媒体 token", async () => {
    const pending = deferred<string>();
    mediaUrl.mockReturnValue(pending.promise);
    releaseUrl.mockResolvedValue(undefined);

    const { rerender } = render(
      <QuickPreviewDialog request={requestFor("a.mp4", [video("a.mp4")])} onClose={() => undefined} />,
    );
    await waitFor(() => expect(mediaUrl).toHaveBeenCalledTimes(1));
    await act(async () => pending.resolve("http://taskdock-preview.localhost/tok-close"));

    rerender(<QuickPreviewDialog request={null} onClose={() => undefined} />);

    await waitFor(() =>
      expect(releaseUrl).toHaveBeenCalledWith("http://taskdock-preview.localhost/tok-close"),
    );
  });

  it("切换到下一个文件时释放旧媒体 token", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    mediaUrl
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    releaseUrl.mockResolvedValue(undefined);

    render(
      <QuickPreviewDialog
        request={requestFor("a.mp4", [video("a.mp4"), video("b.mp4")])}
        onClose={() => undefined}
      />,
    );
    await act(async () => first.resolve("http://taskdock-preview.localhost/tok-a"));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("fw.preview.next"));
    await waitFor(() => expect(mediaUrl).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve("http://taskdock-preview.localhost/tok-b"));

    await waitFor(() =>
      expect(releaseUrl).toHaveBeenCalledWith("http://taskdock-preview.localhost/tok-a"),
    );
  });

  it("被取消的在途媒体请求 resolve 时释放其 token", async () => {
    const pending = deferred<string>();
    mediaUrl.mockReturnValue(pending.promise);
    releaseUrl.mockResolvedValue(undefined);

    const { rerender } = render(
      <QuickPreviewDialog request={requestFor("a.mp4", [video("a.mp4")])} onClose={() => undefined} />,
    );
    await waitFor(() => expect(mediaUrl).toHaveBeenCalledTimes(1));

    // 在 Promise resolve 前关闭对话框：加载 effect 被取消。
    rerender(<QuickPreviewDialog request={null} onClose={() => undefined} />);
    await act(async () => pending.resolve("http://taskdock-preview.localhost/tok-cancel"));

    await waitFor(() =>
      expect(releaseUrl).toHaveBeenCalledWith("http://taskdock-preview.localhost/tok-cancel"),
    );
  });
});
