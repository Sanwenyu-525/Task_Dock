/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  preview: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("../../lib/bridge", () => ({
  resourceSnapshot: mocks.snapshot,
  resourceCleanupPreview: mocks.preview,
  resourceCleanupExecute: mocks.execute,
}));

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}|${JSON.stringify(vars)}` : key,
  }),
}));

import ResourceCleanupSection from "./ResourceCleanupSection";

const SNAPSHOT = {
  sampledAt: "2026-11-06T00:00:00.000Z",
  application: {
    knownCacheBytes: 3072,
    knownCacheFiles: 4,
    status: "ready",
  },
  memory: {
    totalBytes: 16 * 1024 * 1024,
    availableBytes: 8 * 1024 * 1024,
  },
  disks: [
    {
      volume: "C:",
      totalBytes: 128 * 1024 * 1024,
      availableBytes: 64 * 1024 * 1024,
    },
  ],
};

const PREVIEW = {
  previewId: "preview-1",
  createdAt: "2026-11-06T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  totalEstimatedBytes: 8704,
  totalCandidates: 2,
  categories: [
    {
      category: "temporary",
      status: "partial",
      candidates: 0,
      estimatedBytes: 0,
      protectedFiles: 0,
      skippedFiles: 0,
      errorCode: "TEMP_SOURCES_PROTECTED",
    },
    {
      category: "tts",
      status: "ready",
      candidates: 1,
      estimatedBytes: 8192,
      protectedFiles: 0,
      skippedFiles: 0,
    },
    {
      category: "orphan_thumbnails",
      status: "ready",
      candidates: 1,
      estimatedBytes: 512,
      protectedFiles: 0,
      skippedFiles: 0,
    },
  ],
};

const REPORT = {
  jobId: "job-1",
  startedAt: "2026-11-06T00:00:01.000Z",
  finishedAt: "2026-11-06T00:00:02.000Z",
  status: "partial",
  totalFreedBytes: 4096,
  totalDeletedFiles: 1,
  categories: [
    {
      category: "tts",
      status: "partial",
      estimatedBytes: 8192,
      freedBytes: 4096,
      candidates: 1,
      deletedFiles: 1,
      skippedFiles: 0,
      failedFiles: 0,
    },
    {
      category: "orphan_thumbnails",
      status: "skipped",
      estimatedBytes: 512,
      freedBytes: 0,
      candidates: 1,
      deletedFiles: 0,
      skippedFiles: 1,
      failedFiles: 0,
    },
  ],
};

beforeEach(() => {
  mocks.snapshot.mockReset().mockResolvedValue(SNAPSHOT);
  mocks.preview.mockReset().mockResolvedValue(PREVIEW);
  mocks.execute.mockReset().mockResolvedValue(REPORT);
});

afterEach(() => cleanup());

describe("ResourceCleanupSection", () => {
  it("显示真实快照且扫描前不会伪造清理统计", async () => {
    render(<ResourceCleanupSection />);

    expect(await screen.findByText('settings.resourceCleanup.usageValue|{"bytes":"3.0 KB","files":4}')).toBeTruthy();
    expect(screen.getByText("settings.resourceCleanup.applicationStatus.ready")).toBeTruthy();
    expect(screen.getByText("settings.resourceCleanup.notScanned")).toBeTruthy();
    expect(screen.queryByText(/0 B/)).toBeNull();
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("扫描、选择、确认并展示后端实际结果", async () => {
    mocks.snapshot
      .mockResolvedValueOnce(SNAPSHOT)
      .mockResolvedValueOnce({
        ...SNAPSHOT,
        application: { knownCacheBytes: 0, knownCacheFiles: 0, status: "ready" },
      });
    render(<ResourceCleanupSection />);
    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.scan" }));

    expect(await screen.findByText("settings.resourceCleanup.categoriesTitle")).toBeTruthy();
    expect(screen.getByText("settings.resourceCleanup.error.temporarySourcesProtected")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "settings.resourceCleanup.category.temporary" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: "settings.resourceCleanup.category.tts" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "settings.resourceCleanup.category.orphanThumbnails" }));
    fireEvent.click(screen.getByRole("button", { name: /settings.resourceCleanup.clean/ }));

    expect(
      await screen.findByText(
        'settings.resourceCleanup.confirmPrompt|{"bytes":"8.5 KB"}',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.confirm" }));

    await waitFor(() =>
      expect(mocks.execute).toHaveBeenCalledWith({
        previewId: "preview-1",
        categories: ["tts", "orphan_thumbnails"],
      }),
    );
    expect(await screen.findByText("settings.resourceCleanup.resultTitle")).toBeTruthy();
    expect(
      screen.getByText(
        'settings.resourceCleanup.resultPartial|{"bytes":"4.0 KB","files":1}',
      ),
    ).toBeTruthy();
    expect(await screen.findByText('settings.resourceCleanup.usageValue|{"bytes":"0 B","files":0}')).toBeTruthy();
    expect(screen.getAllByText(/settings.resourceCleanup.skipped\|\{"count":1\}/)).toHaveLength(1);
  });

  it("扫描错误保持错误状态并可重新扫描", async () => {
    mocks.preview.mockRejectedValueOnce(new Error("数据库读取失败"));
    render(<ResourceCleanupSection />);
    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.scan" }));

    expect(await screen.findByText("数据库读取失败")).toBeTruthy();
    expect(mocks.execute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.scan" }));
    expect(await screen.findByRole("checkbox", { name: "settings.resourceCleanup.category.tts" })).toBeTruthy();
    expect(mocks.preview).toHaveBeenCalledTimes(2);
  });

  it("过期预览不能执行，必须重新扫描", async () => {
    mocks.preview.mockResolvedValueOnce({
      ...PREVIEW,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    render(<ResourceCleanupSection />);
    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.scan" }));

    expect(await screen.findByText("settings.resourceCleanup.expired")).toBeTruthy();
    expect(screen.getByRole("button", { name: /settings.resourceCleanup.clean/ })).toHaveProperty(
      "disabled",
      true,
    );
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("后端拒绝已过期预览时显示重新扫描提示", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("PREVIEW_EXPIRED"));
    render(<ResourceCleanupSection />);
    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.scan" }));
    await screen.findByText("settings.resourceCleanup.categoriesTitle");
    fireEvent.click(screen.getByRole("checkbox", { name: "settings.resourceCleanup.category.tts" }));
    fireEvent.click(screen.getByRole("button", { name: /settings.resourceCleanup.clean/ }));
    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.confirm" }));

    expect(await screen.findByText("settings.resourceCleanup.error.previewExpired")).toBeTruthy();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("扫描达到上限时显示部分结果提示", async () => {
    mocks.preview.mockResolvedValueOnce({
      ...PREVIEW,
      categories: PREVIEW.categories.map((row) =>
        row.category === "tts"
          ? {
              ...row,
              status: "partial",
              candidates: 1,
              estimatedBytes: 7,
              errorCode: "SCAN_LIMIT_REACHED",
            }
          : row,
      ),
    });
    render(<ResourceCleanupSection />);
    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.scan" }));

    expect(await screen.findByText("settings.resourceCleanup.error.scanLimitReached")).toBeTruthy();
  });

  it("概览读取失败与空占用区分显示", async () => {
    mocks.snapshot.mockRejectedValueOnce(new Error("读取失败"));
    render(<ResourceCleanupSection />);

    expect(await screen.findByText("settings.resourceCleanup.snapshotFailed|{\"error\":\"读取失败\"}")).toBeTruthy();
    expect(screen.queryByText(/0 B/)).toBeNull();
  });

  it("快照不完整时明确标出部分来源已保守跳过", async () => {
    mocks.snapshot.mockResolvedValueOnce({
      ...SNAPSHOT,
      application: { ...SNAPSHOT.application, status: "partial" },
    });
    render(<ResourceCleanupSection />);

    expect(await screen.findByText("settings.resourceCleanup.applicationStatus.partial")).toBeTruthy();
  });

  it("页面卸载后忽略未完成的概览响应", async () => {
    let resolveSnapshot!: (value: typeof SNAPSHOT) => void;
    mocks.snapshot.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSnapshot = resolve)),
    );
    const view = render(<ResourceCleanupSection />);
    view.unmount();
    resolveSnapshot(SNAPSHOT);

    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
  });
});
