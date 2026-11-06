/**
 * @vitest-environment jsdom
 */
//! 资源管理页面：分区切换不重复采样、按需加载、内存释放反馈、清理量回填概览。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  processDiagnostics: vi.fn(),
  diskUsage: vi.fn(),
  memoryCatalog: vi.fn(),
  memoryRelease: vi.fn(),
  cleanupPreview: vi.fn(),
  cleanupExecute: vi.fn(),
}));

vi.mock("../../lib/bridge", () => ({
  resourceSnapshot: mocks.snapshot,
  resourceProcessDiagnostics: mocks.processDiagnostics,
  resourceDiskUsage: mocks.diskUsage,
  resourceMemoryCatalog: mocks.memoryCatalog,
  resourceMemoryRelease: mocks.memoryRelease,
  resourceCleanupPreview: mocks.cleanupPreview,
  resourceCleanupExecute: mocks.cleanupExecute,
}));

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}|${JSON.stringify(vars)}` : key,
  }),
}));

import ResourceManagementPanel from "./ResourceManagementPanel";

const SNAPSHOT = {
  sampledAt: "2026-11-06T00:00:00.000Z",
  application: { knownCacheBytes: 3072, knownCacheFiles: 4, status: "ready" },
  memory: { totalBytes: 16 * 1024 * 1024, availableBytes: 8 * 1024 * 1024 },
  disks: [{ volume: "C:", totalBytes: 128 * 1024 * 1024, availableBytes: 64 * 1024 * 1024 }],
  process: {
    pid: 4242,
    name: "task-dock.exe",
    cpuPercent: 1.5,
    cpuWindowMs: 200,
    workingSetBytes: 104857600,
    privateBytes: 52428800,
    uptimeSecs: 3725,
    status: "normal",
  },
};

const DISK_USAGE = {
  sampledAt: "2026-11-06T00:00:00.000Z",
  totalBytes: 4096,
  truncated: false,
  entries: [
    { id: "tts_cache", bytes: 2048, files: 2, kind: "regenerable", status: "ready" },
    { id: "clipboard_thumbs", bytes: 1024, files: 1, kind: "persistent", status: "ready" },
    { id: "backups", bytes: 0, files: 0, kind: "persistent", status: "missing" },
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
      category: "tts",
      status: "ready",
      candidates: 2,
      estimatedBytes: 8704,
      protectedFiles: 0,
      skippedFiles: 0,
    },
    {
      category: "temporary",
      status: "ready",
      candidates: 0,
      estimatedBytes: 0,
      protectedFiles: 0,
      skippedFiles: 0,
    },
    {
      category: "orphan_thumbnails",
      status: "ready",
      candidates: 0,
      estimatedBytes: 0,
      protectedFiles: 0,
      skippedFiles: 0,
    },
  ],
};

function tab(name: string) {
  return screen.getByRole("tab", { name });
}

beforeEach(() => {
  mocks.snapshot.mockReset().mockResolvedValue(SNAPSHOT);
  mocks.processDiagnostics.mockReset().mockResolvedValue({
    sampledAt: "2026-11-06T00:00:00.000Z",
    cpuWindowMs: 200,
    supported: true,
    truncated: false,
    omittedExternal: 0,
    omittedUnknown: 0,
    processes: [
      {
        pid: 4242,
        name: "task-dock.exe",
        association: "self",
        associationBasis: "self",
        cpuPercent: 1.5,
        workingSetBytes: 104857600,
        privateBytes: 52428800,
        uptimeSecs: 3725,
        status: "normal",
      },
      {
        pid: 5000,
        name: "msedgewebview2.exe",
        association: "managed_child",
        associationBasis: "parent_chain",
        cpuPercent: 0.4,
        workingSetBytes: 52428800,
        privateBytes: 20971520,
        uptimeSecs: 3700,
        status: "normal",
      },
    ],
  });
  mocks.diskUsage.mockReset().mockResolvedValue(DISK_USAGE);
  mocks.memoryCatalog.mockReset().mockResolvedValue({
    sampledAt: "2026-11-06T00:00:00.000Z",
    totalBytes: 1024,
    sources: [
      { id: "tts_memory", entries: 2, bytes: 1024, status: "available" },
      { id: "app_icons", entries: 0, bytes: 0, status: "empty" },
    ],
  });
  mocks.memoryRelease.mockReset().mockResolvedValue({
    sampledAt: "2026-11-06T00:00:01.000Z",
    releasedBytes: 1024,
    sources: [
      { id: "tts_memory", entries: 2, bytes: 1024 },
      { id: "app_icons", entries: 0, bytes: 0 },
    ],
  });
  mocks.cleanupPreview.mockReset().mockResolvedValue(PREVIEW);
});

afterEach(() => cleanup());

describe("ResourceManagementPanel", () => {
  it("默认进入概览，切换分区不重复请求资源快照", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    expect(tab("resource.segment.overview").getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText(/settings.resourceCleanup.cpuValue/)).toBeTruthy();

    fireEvent.click(tab("resource.segment.process"));
    fireEvent.click(tab("resource.segment.overview"));
    fireEvent.click(tab("resource.segment.memory"));
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
  });

  it("概览区分磁盘总量/应用缓存/可清理量，扫描前不显示 0", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));

    expect(screen.getByText("resource.overview.cleanableUnknown")).toBeTruthy();
    // 扫描前明确提示，而不是把 0 B 当成可清理量
    expect(screen.queryByText("0 B")).toBeNull();
  });

  it("磁盘分区首次进入才统计占用，来回切换不重复请求", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    expect(mocks.diskUsage).not.toHaveBeenCalled();

    fireEvent.click(tab("resource.segment.disk"));
    await waitFor(() => expect(mocks.diskUsage).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("resource.storage.title")).toBeTruthy();
    // 清理不会自动扫描
    expect(mocks.cleanupPreview).not.toHaveBeenCalled();

    fireEvent.click(tab("resource.segment.memory"));
    fireEvent.click(tab("resource.segment.disk"));
    expect(mocks.diskUsage).toHaveBeenCalledTimes(1);
  });

  it("磁盘扫描后的可清理量回填到概览", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.disk"));
    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.scan" }));
    await screen.findByText("settings.resourceCleanup.categoriesTitle");

    fireEvent.click(tab("resource.segment.overview"));
    await waitFor(() =>
      expect(screen.queryByText("resource.overview.cleanableUnknown")).toBeNull(),
    );
    expect(screen.getByText("8.5 KB")).toBeTruthy();
  });

  it("内存分区展示可回收缓存并执行真实释放后重新采样", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.memory"));

    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("resource.memory.source.tts")).toBeTruthy();
    expect(screen.queryByText("resource.memory.nothingToRelease")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "resource.memory.release" }),
    );
    await waitFor(() => expect(mocks.memoryRelease).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText('resource.memory.released|{"bytes":"1.0 KB"}'),
    ).toBeTruthy();
    // 释放后按同一口径重新采样：目录重读 + 页面快照刷新
    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));
  });

  it("没有可释放缓存时不显示释放按钮，只显示明确说明", async () => {
    mocks.memoryCatalog.mockResolvedValue({
      sampledAt: "2026-11-06T00:00:00.000Z",
      totalBytes: 0,
      sources: [
        { id: "tts_memory", entries: 0, bytes: 0, status: "empty" },
        { id: "app_icons", entries: 0, bytes: 0, status: "empty" },
      ],
    });
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.memory"));

    expect(await screen.findByText("resource.memory.nothingToRelease")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "resource.memory.release" })).toBeNull();
    expect(mocks.memoryRelease).not.toHaveBeenCalled();
  });

  it("进程分区按需加载一次，并复用同一份数据给内存分区", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    expect(mocks.processDiagnostics).not.toHaveBeenCalled();

    fireEvent.click(tab("resource.segment.process"));
    fireEvent.click(
      screen.getByRole("button", { name: /settings.resourceCleanup.processLoad/ }),
    );
    await waitFor(() => expect(mocks.processDiagnostics).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("settings.resourceCleanup.association.managedChild"),
    ).toBeTruthy();

    // 内存分区复用已加载的进程数据，不再请求
    fireEvent.click(tab("resource.segment.memory"));
    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(1));
    expect(mocks.processDiagnostics).toHaveBeenCalledTimes(1);
    const memoryPanel = document.getElementById("resource-panel-memory") as HTMLElement;
    expect(
      within(memoryPanel).getByText('resource.memory.webviewCount|{"count":1}'),
    ).toBeTruthy();
  });

  it("内存分区在进程数据未加载时按需请求一次", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.memory"));

    await waitFor(() => expect(mocks.processDiagnostics).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.process"));
    expect(mocks.processDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("卸载后忽略在途快照响应", async () => {
    let resolveSnapshot!: (value: unknown) => void;
    mocks.snapshot.mockImplementationOnce(
      () => new Promise((resolve) => (resolveSnapshot = resolve)),
    );
    const view = render(<ResourceManagementPanel />);
    view.unmount();
    resolveSnapshot(SNAPSHOT);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
  });
});
