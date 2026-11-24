/**
 * @vitest-environment jsdom
 *
 * R14.2 P2：快速预览文件版本一致性。
 *
 * 弹窗打开期间内容保持稳定；目录事件检测到同路径新版本时只提示，
 * 用户显式刷新后才换 revision、释放旧媒体 token 并重建播放器。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsEntry, FsStat } from "../../lib/bridge";

const bridgeMocks = vi.hoisted(() => ({
  fsOpen: vi.fn(async () => undefined),
  fsStat: vi.fn(),
  fsReadText: vi.fn(),
  fsReadBinary: vi.fn(),
  fsPreviewImage: vi.fn(),
  fsPreviewMediaUrl: vi.fn(),
  fsReleasePreviewUrl: vi.fn(),
}));

const dirMock = vi.hoisted(() => {
  const listeners = new Set<(state: unknown) => void>();
  return {
    listeners,
    subscribeDir: vi.fn((_path: string, _hidden: boolean, listener: (state: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    getDirState: vi.fn(() => ({
      path: "",
      showHidden: false,
      listing: null,
      truncated: false,
      hasMore: false,
      diskScanned: null,
      loading: false,
      error: null,
      signatureModifiedMs: null,
      fetchedAt: 0,
    })),
  };
});

vi.mock("../../lib/bridge", () => bridgeMocks);
vi.mock("../../lib/filesWorkspace/dirCache", () => dirMock);
vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    locale: "zh-CN",
    preference: "zh-CN",
    setPreference: vi.fn(),
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  }),
}));

import QuickPreviewDialog, { type PreviewRequest } from "./QuickPreviewDialog";

const mediaMock = bridgeMocks.fsPreviewMediaUrl;
const releaseMock = bridgeMocks.fsReleasePreviewUrl;
const statMock = bridgeMocks.fsStat;

function videoEntry(size = 10, modifiedMs = 1_700_000_000_000): FsEntry {
  return { name: "v.mp4", kind: "file", ext: "mp4", size, modifiedMs, hidden: false, category: "video" };
}

function requestFor(entry: FsEntry): PreviewRequest {
  return { paneId: "p1", dir: "D:\\a", path: "D:\\a\\v.mp4", entries: [entry] };
}

function emit(listing: FsEntry[]): void {
  const state = {
    path: "D:\\a",
    showHidden: false,
    listing,
    truncated: false,
    hasMore: false,
    diskScanned: null,
    loading: false,
    error: null,
    signatureModifiedMs: null,
    fetchedAt: Date.now(),
  };
  for (const listener of dirMock.listeners) listener(state);
}

const stat = (size: number, modifiedMs: number): FsStat => ({
  path: "D:\\a\\v.mp4",
  exists: true,
  kind: "file",
  size,
  createdMs: 1_600_000_000_000,
  modifiedMs,
  accessedMs: modifiedMs,
  attributes: [],
  readonly: false,
  hidden: false,
  childCount: null,
  childTruncated: false,
});

const stagePath = () => document.querySelector(".fw-preview-stage")?.getAttribute("data-preview-path") ?? null;

beforeEach(() => {
  dirMock.listeners.clear();
  mediaMock.mockReset().mockResolvedValueOnce("media://v1").mockResolvedValueOnce("media://v2");
  releaseMock.mockReset().mockResolvedValue(undefined);
  statMock.mockReset().mockResolvedValue([stat(20, 1_700_000_002_000)]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("弹窗打开期间的文件版本变化", () => {
  it("检测到新版本只提示，不自动换内容；显式刷新后释放旧 token 并重建一个播放器", async () => {
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const loadSpy = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    render(<QuickPreviewDialog request={requestFor(videoEntry())} onClose={() => undefined} />);

    await waitFor(() => expect(document.querySelector(".fw-preview-video")).toBeTruthy());
    expect(mediaMock).toHaveBeenCalledTimes(1);
    expect(stagePath()).toBe("D:\\a\\v.mp4");

    // 目录事件带来新版本：只显示提示，不重建内容。
    act(() => emit([videoEntry(20, 1_700_000_002_000)]));
    await screen.findByText("fw.preview.staleHint");
    expect(mediaMock).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("video")).toHaveLength(1);
    expect(releaseMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("fw.preview.refresh"));

    await waitFor(() => expect(mediaMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(releaseMock).toHaveBeenCalledWith("media://v1"));
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("video")).toHaveLength(1);
    expect(pauseSpy).toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("fw.preview.staleHint")).toBeNull());
  });

  it("刷新 IPC 失败：保留旧内容并给出可读错误，不出现第二个播放器", async () => {
    statMock.mockRejectedValueOnce(new Error("access denied"));
    render(<QuickPreviewDialog request={requestFor(videoEntry())} onClose={() => undefined} />);
    await waitFor(() => expect(document.querySelector(".fw-preview-video")).toBeTruthy());
    act(() => emit([videoEntry(20, 1_700_000_002_000)]));
    await screen.findByText("fw.preview.staleHint");

    fireEvent.click(screen.getByText("fw.preview.refresh"));
    await waitFor(() => expect(statMock).toHaveBeenCalledWith(["D:\\a\\v.mp4"]));

    // toast 交给全局 store，弹窗保持原内容与原播放器。
    expect(document.querySelectorAll("video")).toHaveLength(1);
    expect(mediaMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).not.toHaveBeenCalled();
  });
});
