/**
 * @vitest-environment jsdom
 */
//! 磁盘清理分区：只验证「扫描 → 选择 → 预览 → 确认 → 执行」与失败/过期/去重。
//! 概览与进程诊断已迁到资源管理页面，由 ResourceManagementPanel.test.tsx 覆盖。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("../../lib/bridge", () => ({
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
  mocks.preview.mockReset().mockResolvedValue(PREVIEW);
  mocks.execute.mockReset().mockResolvedValue(REPORT);
});

afterEach(() => cleanup());

describe("ResourceCleanupSection", () => {
  it("扫描前不显示伪造统计，也不主动扫描", () => {
    render(<ResourceCleanupSection />);

    expect(screen.getByText("settings.resourceCleanup.notScanned")).toBeTruthy();
    expect(screen.queryByText(/0 B/)).toBeNull();
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("扫描、选择、确认并展示后端实际结果", async () => {
    const onPreviewChange = vi.fn();
    const onSnapshotInvalidated = vi.fn();
    render(
      <ResourceCleanupSection
        onPreviewChange={onPreviewChange}
        onSnapshotInvalidated={onSnapshotInvalidated}
      />,
    );
    // 未扫描时向页面回报明确状态，而不是 0
    expect(onPreviewChange).toHaveBeenLastCalledWith({ totalBytes: null, state: "unscanned" });

    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.scan" }));
    expect(await screen.findByText("settings.resourceCleanup.categoriesTitle")).toBeTruthy();
    await waitFor(() =>
      expect(onPreviewChange).toHaveBeenLastCalledWith({ totalBytes: 8704, state: "partial" }),
    );
    expect(screen.getByText("settings.resourceCleanup.error.temporarySourcesProtected")).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: "settings.resourceCleanup.category.temporary" }),
    ).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("checkbox", { name: "settings.resourceCleanup.category.tts" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "settings.resourceCleanup.category.orphanThumbnails" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /settings.resourceCleanup.clean/ }));

    expect(
      await screen.findByText('settings.resourceCleanup.confirmPrompt|{"bytes":"8.5 KB"}'),
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
      screen.getByText('settings.resourceCleanup.resultPartial|{"bytes":"4.0 KB","files":1}'),
    ).toBeTruthy();
    expect(screen.getAllByText(/settings.resourceCleanup.skipped\|\{"count":1\}/)).toHaveLength(1);
    // 执行完成后页面快照需要重采样（缓存与磁盘占用已变化）
    expect(onSnapshotInvalidated).toHaveBeenCalledTimes(1);
    // 预览已被消费：旧估算立即失效，概览必须提示重新扫描
    expect(onPreviewChange).toHaveBeenLastCalledWith({ totalBytes: null, state: "stale" });
  });

  it("预览 TTL 到期后上报失效，旧估算不再算作可清理量", async () => {
    vi.useFakeTimers();
    try {
      const onPreviewChange = vi.fn();
      mocks.preview.mockResolvedValueOnce({
        ...PREVIEW,
        expiresAt: new Date(Date.now() + 5_000).toISOString(),
      });
      render(<ResourceCleanupSection onPreviewChange={onPreviewChange} />);
      fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.scan" }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onPreviewChange).toHaveBeenLastCalledWith({
        totalBytes: 8704,
        state: "partial",
      });

      await act(async () => {
        vi.advanceTimersByTime(5_001);
      });
      expect(onPreviewChange).toHaveBeenLastCalledWith({ totalBytes: null, state: "stale" });
      expect(screen.getByText("settings.resourceCleanup.expired")).toBeTruthy();
      // 过期后不能执行清理
      expect(screen.getByRole("button", { name: /settings.resourceCleanup.clean/ })).toHaveProperty(
        "disabled",
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("扫描错误保持错误状态并可重新扫描", async () => {
    mocks.preview.mockRejectedValueOnce(new Error("数据库读取失败"));
    render(<ResourceCleanupSection />);
    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.scan" }));

    expect(await screen.findByText("数据库读取失败")).toBeTruthy();
    expect(mocks.execute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.scan" }));
    expect(
      await screen.findByRole("checkbox", { name: "settings.resourceCleanup.category.tts" }),
    ).toBeTruthy();
    expect(mocks.preview).toHaveBeenCalledTimes(2);
  });

  it("过期预览不能执行，必须重新扫描", async () => {
    mocks.preview.mockResolvedValueOnce({ ...PREVIEW, expiresAt: "2000-01-01T00:00:00.000Z" });
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
          ? { ...row, status: "partial", candidates: 1, estimatedBytes: 7, errorCode: "SCAN_LIMIT_REACHED" }
          : row,
      ),
    });
    render(<ResourceCleanupSection />);
    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.scan" }));

    expect(await screen.findByText("settings.resourceCleanup.error.scanLimitReached")).toBeTruthy();
  });

  it("扫描进行中重复点击不会启动第二个请求", async () => {
    let resolvePreview!: (value: unknown) => void;
    mocks.preview.mockImplementationOnce(
      () => new Promise((resolve) => (resolvePreview = resolve)),
    );
    render(<ResourceCleanupSection />);
    const scan = screen.getByRole("button", { name: "settings.resourceCleanup.scan" });
    fireEvent.click(scan);
    fireEvent.click(scan);
    expect(mocks.preview).toHaveBeenCalledTimes(1);

    resolvePreview(PREVIEW);
    expect(await screen.findByText("settings.resourceCleanup.categoriesTitle")).toBeTruthy();
  });

  it("卸载后忽略未完成的扫描响应", async () => {
    let resolvePreview!: (value: unknown) => void;
    mocks.preview.mockImplementationOnce(
      () => new Promise((resolve) => (resolvePreview = resolve)),
    );
    const view = render(<ResourceCleanupSection />);
    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.scan" }));
    view.unmount();
    resolvePreview(PREVIEW);

    await waitFor(() => expect(mocks.preview).toHaveBeenCalledTimes(1));
  });
});
