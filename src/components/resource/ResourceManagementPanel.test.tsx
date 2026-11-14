/**
 * @vitest-environment jsdom
 */
//! 资源管理页面：分区切换不重复采样、按需加载、内存释放反馈、清理量回填概览。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  processDiagnostics: vi.fn(),
  diskUsage: vi.fn(),
  memoryCatalog: vi.fn(),
  memoryRelease: vi.fn(),
  cleanupPreview: vi.fn(),
  cleanupExecute: vi.fn(),
  junkPreview: vi.fn(async () => ({
    previewId: "junk-1",
    createdAt: "2026-11-08T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    minimumAgeHours: 168,
    categories: [],
    totalCandidates: 0,
    totalEstimatedBytes: 0,
  })),
  junkExecute: vi.fn(),
  diskAnalyze: vi.fn(),
  lifecycleStatus: vi.fn(async () => []),
}));

vi.mock("../../lib/bridge", () => ({
  resourceSnapshot: mocks.snapshot,
  lifecycleStatus: mocks.lifecycleStatus,
  resourceProcessDiagnostics: mocks.processDiagnostics,
  resourceDiskUsage: mocks.diskUsage,
  resourceDiskAnalyze: mocks.diskAnalyze,
  resourceMemoryCatalog: mocks.memoryCatalog,
  resourceMemoryRelease: mocks.memoryRelease,
  resourceCleanupPreview: mocks.cleanupPreview,
  resourceCleanupExecute: mocks.cleanupExecute,
  resourceJunkPreview: mocks.junkPreview,
  resourceJunkExecute: mocks.junkExecute,
}));

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}|${JSON.stringify(vars)}` : key,
  }),
}));

import ResourceManagementPanel from "./ResourceManagementPanel";
import { useSettingsStore } from "../../store/useSettingsStore";
import type { Settings } from "../../lib/bridge";

const SNAPSHOT = {
  sampledAt: "2026-11-06T00:00:00.000Z",
  application: { knownCacheBytes: 3072, knownCacheFiles: 4, status: "ready" },
  memory: { totalBytes: 16 * 1024 * 1024, availableBytes: 8 * 1024 * 1024 },
  disks: [
    {
      volume: "C:",
      kind: "fixed",
      totalBytes: 128 * 1024 * 1024,
      availableBytes: 64 * 1024 * 1024,
    },
  ],
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
  mocks.lifecycleStatus.mockReset().mockResolvedValue([]);
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
  mocks.diskAnalyze.mockReset().mockResolvedValue({
    path: "C:\\",
    parent: null,
    sampledAt: "2026-11-06T00:00:00.000Z",
    totalBytes: 0,
    totalFiles: 0,
    totalDirs: 0,
    rootFilesBytes: 0,
    rootFiles: 0,
    skippedLinks: 0,
    skippedErrors: 0,
    truncated: false,
    elapsedMs: 1,
    folders: [],
    files: [],
  });
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

afterEach(() => {
  cleanup();
  // 这个测试会改全局设置 Store；还原避免影响后续用例。
  useSettingsStore.setState({ settings: null });
});

/** 两轮进程诊断只改 WebView2 工作集，用来证明内存页刷新真的重取了进程数据。 */
function diagnosticsWithWebview(workingSetBytes: number) {
  return {
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
        workingSetBytes,
        privateBytes: 20971520,
        uptimeSecs: 3700,
        status: "normal",
      },
    ],
  };
}

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

  it("概览趋势：可见时每周期采样一次，切到别的分区立即停止", async () => {
    // 只假造 interval：周期采样是唯一需要推进的计时器。
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const flush = async () => {
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
      };
      mocks.snapshot
        .mockResolvedValueOnce(SNAPSHOT)
        .mockResolvedValueOnce({ ...SNAPSHOT, sampledAt: "2026-11-06T00:00:10.000Z" });

      render(<ResourceManagementPanel />);
      await flush();

      const overview = document.getElementById("resource-panel-overview") as HTMLElement;
      expect(within(overview).getByText("resource.trend.title")).toBeTruthy();
      // 只有一个起点：不画假折线，显示采样占位
      expect(overview.querySelector("path.resource-trend-line")).toBeNull();
      expect(
        within(overview).getAllByText("resource.trend.sampling").length,
      ).toBeGreaterThan(0);
      expect(mocks.snapshot).toHaveBeenCalledTimes(1);

      // 一个周期后：第二个真实采样点 → 趋势线出现
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.snapshot).toHaveBeenCalledTimes(2);
      expect(overview.querySelector("path.resource-trend-line")).toBeTruthy();

      // 切到磁盘分区（概览失活）：再推进 3 个周期也不采样
      fireEvent.click(tab("resource.segment.disk"));
      await flush();
      await act(async () => {
        vi.advanceTimersByTime(30_000);
        await Promise.resolve();
      });
      expect(mocks.snapshot).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

  // ── StrictMode 竞态回归（2026-11-06）──────────────────────────────
  // 旧实现里 `busyRef` 在 Effect 清理后仍为 true，第二次挂载的加载被直接
  // return 掉，第一次请求又因序号失效不写状态 → 永久停在「读取中」。

  it("StrictMode 双挂载：合并为一次请求且 loading 必定收尾", async () => {
    let resolveSnapshot!: (value: unknown) => void;
    mocks.snapshot.mockImplementation(
      () => new Promise((resolve) => (resolveSnapshot = resolve)),
    );

    render(
      <StrictMode>
        <ResourceManagementPanel />
      </StrictMode>,
    );

    // 第二次挂载接的是第一次的在途请求：不重复扫描，也不会被「忙碌」拦死。
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    // 读取中：指标位置显示「读取中…」，不能把未加载说成真实数据。
    expect(screen.getAllByText("resource.reading").length).toBeGreaterThan(0);
    expect(screen.queryByText(/settings\.resourceCleanup\.cpuValue/)).toBeNull();

    await act(async () => {
      resolveSnapshot(SNAPSHOT);
    });

    expect(await screen.findByText(/settings.resourceCleanup.cpuValue/)).toBeTruthy();
    expect(screen.queryByText("resource.reading")).toBeNull();
  });

  it("StrictMode 下磁盘分区同样只统计一次", async () => {
    let resolveUsage!: (value: unknown) => void;
    mocks.diskUsage.mockImplementation(
      () => new Promise((resolve) => (resolveUsage = resolve)),
    );

    render(
      <StrictMode>
        <ResourceManagementPanel />
      </StrictMode>,
    );
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));

    fireEvent.click(tab("resource.segment.disk"));
    await waitFor(() => expect(mocks.diskUsage).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveUsage(DISK_USAGE);
    });
    expect(await screen.findByText("resource.storage.total")).toBeTruthy();
  });

  it("读取失败给出错误与重试入口，重试成功后恢复", async () => {
    let rejectSnapshot!: (reason: unknown) => void;
    mocks.snapshot.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectSnapshot = reject)),
    );

    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));

    await act(async () => {
      rejectSnapshot({ code: "UNKNOWN_ERROR" });
    });

    expect(await screen.findByRole("alert")).toBeTruthy();
    // 失败态不是「读取中」，也不该继续显示旧的 loading 文案
    expect(screen.queryByText("resource.reading")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/settings.resourceCleanup.cpuValue/)).toBeTruthy();
  });

  it("概览不再提供与页头重复的刷新入口", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));

    const page = document.querySelector(".resource-page") as HTMLElement;
    const head = page.querySelector(".resource-page-head") as HTMLElement;
    const refreshButtons = within(head).getAllByRole("button", { name: "resource.refresh" });
    expect(refreshButtons).toHaveLength(1);
    // 概览分区内部只剩「去磁盘页扫描」这类功能入口，没有第二个刷新按钮
    const overview = document.getElementById("resource-panel-overview") as HTMLElement;
    expect(
      within(overview).queryByRole("button", {
        name: /settings\.resourceCleanup\.refresh$/,
      }),
    ).toBeNull();
  });

  // ── 内存释放操作锁（2026-11-06 二次验收）────────────────────────
  // 释放事务 = IPC 释放 + 重新读目录。重新采样完成前 catalog 还是旧值
  // （可释放量 > 0），若只按 releasing 判定，用户在间隙里再点一次就会
  // 基于旧数据重复释放。

  async function openMemoryTab() {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.memory"));
    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(1));
    return (await screen.findByRole("button", {
      name: "resource.memory.release",
    })) as HTMLButtonElement;
  }

  it("释放进行中连续点击只执行一次", async () => {
    let releaseRelease!: (value: unknown) => void;
    mocks.memoryRelease.mockImplementationOnce(
      () => new Promise((resolve) => (releaseRelease = resolve)),
    );
    const button = await openMemoryTab();

    await act(async () => {
      button.click();
      button.click();
    });
    await waitFor(() => expect(mocks.memoryRelease).toHaveBeenCalledTimes(1));
    expect(button.disabled).toBe(true);

    releaseRelease({
      sampledAt: "2026-11-06T00:00:01.000Z",
      releasedBytes: 1024,
      sources: [{ id: "tts_memory", entries: 2, bytes: 1024 }],
    });
    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(2));
  });

  it("释放成功但目录重新采样未完成时，仍不能再次释放", async () => {
    let resolveRelease!: (value: unknown) => void;
    let resolveReload!: (value: unknown) => void;
    mocks.memoryRelease.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRelease = resolve)),
    );
    // 第二次目录读取（释放后的重新采样）保持挂起
    mocks.memoryCatalog
      .mockResolvedValueOnce({
        sampledAt: "2026-11-06T00:00:00.000Z",
        totalBytes: 1024,
        sources: [{ id: "tts_memory", entries: 2, bytes: 1024, status: "available" }],
      })
      .mockImplementationOnce(() => new Promise((resolve) => (resolveReload = resolve)));
    const button = await openMemoryTab();

    await act(async () => {
      button.click();
    });
    await waitFor(() => expect(mocks.memoryRelease).toHaveBeenCalledTimes(1));

    // 释放返回后才会重新读目录（重新采样挂起）
    await act(async () => {
      resolveRelease({
        sampledAt: "2026-11-06T00:00:01.000Z",
        releasedBytes: 1024,
        sources: [{ id: "tts_memory", entries: 2, bytes: 1024 }],
      });
    });
    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(2));
    await screen.findByText('resource.memory.released|{"bytes":"1.0 KB"}');
    expect(button.disabled).toBe(true);

    // 再点击（守卫层兜底，不依赖 disabled）也不会发第二次释放
    await act(async () => {
      button.click();
    });
    expect(mocks.memoryRelease).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveReload({
        sampledAt: "2026-11-06T00:00:02.000Z",
        totalBytes: 512,
        sources: [{ id: "tts_memory", entries: 1, bytes: 512, status: "available" }],
      });
    });
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it("释放后的目录重新读取失败给出独立错误与重试入口", async () => {
    let resolveRelease!: (value: unknown) => void;
    mocks.memoryRelease.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRelease = resolve)),
    );
    // 首次目录读取成功，释放后的重新采样失败
    mocks.memoryCatalog
      .mockResolvedValueOnce({
        sampledAt: "2026-11-06T00:00:00.000Z",
        totalBytes: 1024,
        sources: [{ id: "tts_memory", entries: 2, bytes: 1024, status: "available" }],
      })
      .mockRejectedValueOnce({ code: "UNKNOWN_ERROR" });
    const button = await openMemoryTab();

    await act(async () => {
      button.click();
    });
    await waitFor(() => expect(mocks.memoryRelease).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveRelease({
        sampledAt: "2026-11-06T00:00:01.000Z",
        releasedBytes: 1024,
        sources: [{ id: "tts_memory", entries: 2, bytes: 1024 }],
      });
    });

    // 读取失败（不是释放失败）：有错误与重试，且释放结果如实展示
    const memoryPanel = document.getElementById("resource-panel-memory") as HTMLElement;
    expect(
      await within(memoryPanel).findByText(/resource\.memory\.failed/),
    ).toBeTruthy();
    expect(
      within(memoryPanel).getByRole("button", { name: "common.retry" }),
    ).toBeTruthy();
    expect(await screen.findByText(/resource\.memory\.released/)).toBeTruthy();
    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(2));
  });

  it("目录重新采样完成后可以再次真实释放", async () => {
    const button = await openMemoryTab();

    await act(async () => {
      button.click();
    });
    await waitFor(() => expect(mocks.memoryRelease).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button.disabled).toBe(false));

    await act(async () => {
      button.click();
    });
    await waitFor(() => expect(mocks.memoryRelease).toHaveBeenCalledTimes(2));
    expect(mocks.memoryCatalog).toHaveBeenCalledTimes(3);
  });

  it("释放后目录为空：不再显示释放按钮，只显示说明", async () => {
    mocks.memoryCatalog
      .mockResolvedValueOnce({
        sampledAt: "2026-11-06T00:00:00.000Z",
        totalBytes: 1024,
        sources: [{ id: "tts_memory", entries: 2, bytes: 1024, status: "available" }],
      })
      .mockResolvedValueOnce({
        sampledAt: "2026-11-06T00:00:02.000Z",
        totalBytes: 0,
        sources: [
          { id: "tts_memory", entries: 0, bytes: 0, status: "empty" },
          { id: "app_icons", entries: 0, bytes: 0, status: "empty" },
        ],
      });
    const button = await openMemoryTab();

    await act(async () => {
      button.click();
    });
    await waitFor(() => expect(mocks.memoryRelease).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(2));

    expect(screen.queryByRole("button", { name: "resource.memory.release" })).toBeNull();
    expect(await screen.findByText("resource.memory.nothingToRelease")).toBeTruthy();
  });

  it("卸载后释放请求返回不写状态", async () => {
    let resolveRelease!: (value: unknown) => void;
    mocks.memoryRelease.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRelease = resolve)),
    );
    const view = render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.memory"));
    const button = await screen.findByRole("button", { name: "resource.memory.release" });

    await act(async () => {
      button.click();
    });
    await waitFor(() => expect(mocks.memoryRelease).toHaveBeenCalledTimes(1));
    view.unmount();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      resolveRelease({
        sampledAt: "2026-11-06T00:00:01.000Z",
        releasedBytes: 1024,
        sources: [],
      });
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("重采样期间触发新一轮目录读取：旧请求结算不会提前解锁", async () => {
    let resolveRelease!: (value: unknown) => void;
    let resolveRescan!: (value: unknown) => void;
    let resolveRefresh!: (value: unknown) => void;
    const catalog = (totalBytes: number) => ({
      sampledAt: "2026-11-06T00:00:00.000Z",
      totalBytes,
      sources: [{ id: "tts_memory", entries: 2, bytes: totalBytes, status: "available" }],
    });
    mocks.memoryRelease.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRelease = resolve)),
    );
    // 首次读取成功 → 释放后的重采样挂起 → 页头刷新发起的新请求也挂起
    mocks.memoryCatalog
      .mockResolvedValueOnce(catalog(1024))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRescan = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRefresh = resolve)));
    const button = await openMemoryTab();

    await act(async () => {
      button.click();
    });
    await waitFor(() => expect(mocks.memoryRelease).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveRelease({
        sampledAt: "2026-11-06T00:00:01.000Z",
        releasedBytes: 1024,
        sources: [{ id: "tts_memory", entries: 2, bytes: 1024 }],
      });
    });
    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(2));
    expect(button.disabled).toBe(true);

    // 页头刷新：新一轮读取开始（旧请求被顶替，但仍会正常结算）
    fireEvent.click(screen.getByRole("button", { name: "resource.refresh" }));
    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(3));

    // 释放事务等待的旧请求结算：新请求仍在途，锁不能放开
    await act(async () => {
      resolveRescan(catalog(512));
    });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.memoryRelease).toHaveBeenCalledTimes(1);

    // 最新请求结算后目录已更新，才允许下一次合法释放
    await act(async () => {
      resolveRefresh(catalog(512));
    });
    await waitFor(() => expect(button.disabled).toBe(false));
    await act(async () => {
      button.click();
    });
    await waitFor(() => expect(mocks.memoryRelease).toHaveBeenCalledTimes(2));
  });

  it("重采样期间卸载：迟到结果不写状态、不产生 React 警告", async () => {
    let resolveRelease!: (value: unknown) => void;
    let resolveRescan!: (value: unknown) => void;
    mocks.memoryRelease.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRelease = resolve)),
    );
    mocks.memoryCatalog
      .mockResolvedValueOnce({
        sampledAt: "2026-11-06T00:00:00.000Z",
        totalBytes: 1024,
        sources: [{ id: "tts_memory", entries: 2, bytes: 1024, status: "available" }],
      })
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRescan = resolve)));
    const view = render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.memory"));
    const button = await screen.findByRole("button", { name: "resource.memory.release" });

    await act(async () => {
      button.click();
    });
    await waitFor(() => expect(mocks.memoryRelease).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveRelease({
        sampledAt: "2026-11-06T00:00:01.000Z",
        releasedBytes: 1024,
        sources: [],
      });
    });
    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(2));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    view.unmount();
    await act(async () => {
      resolveRescan({
        sampledAt: "2026-11-06T00:00:02.000Z",
        totalBytes: 0,
        sources: [],
      });
    });
    // useAsyncResource 在卸载后跳过状态提交；finally 也只在挂载时 setState。
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("概览环形：百分比与数据一致，并按阈值给出状态", async () => {
    mocks.snapshot.mockResolvedValue({
      ...SNAPSHOT,
      // 1000 总量 / 107 可用 → 已用 89.3%（关注）
      disks: [{ volume: "C:", kind: "fixed", totalBytes: 1000, availableBytes: 107 }],
      // 16 / 8 → 50%（正常）
      memory: { totalBytes: 16, availableBytes: 8 },
    });
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    // 快照状态提交后再断言：读取中只能显示「读取中」，不能提前冒充数值。
    await waitFor(() =>
      expect(
        document.querySelectorAll(".resource-ring")[0]?.querySelector(".resource-ring-center strong")
          ?.textContent,
      ).toBe("89.3%"),
    );

    const rings = document.querySelectorAll(".resource-ring");
    expect(rings).toHaveLength(2);
    const diskRing = rings[0] as HTMLElement;
    const memoryRing = rings[1] as HTMLElement;
    expect(diskRing.querySelector(".resource-ring-center strong")?.textContent).toBe("89.3%");
    expect(diskRing.classList.contains("is-attention")).toBe(true);
    expect(diskRing.getAttribute("aria-label")).toContain("resource.level.attention");
    expect(memoryRing.querySelector(".resource-ring-center strong")?.textContent).toBe("50.0%");
    expect(memoryRing.classList.contains("is-normal")).toBe(true);

    // 圆弧几何与展示百分比一致（dashoffset = C * (1 - p/100)）
    const fill = diskRing.querySelector(".resource-ring-fill") as SVGCircleElement;
    const circumference = Number(fill.getAttribute("stroke-dasharray"));
    const offset = Number(fill.getAttribute("stroke-dashoffset"));
    expect((1 - offset / circumference) * 100).toBeCloseTo(89.3, 1);
  });

  it("概览：双主卡 + 紧凑关注摘要，明细按需展开", async () => {
    mocks.snapshot.mockResolvedValue({
      ...SNAPSHOT,
      disks: [
        { volume: "C:", kind: "fixed", totalBytes: 1000, availableBytes: 50 },
        { volume: "D:", kind: "fixed", totalBytes: 1000, availableBytes: 80 },
      ],
    });
    render(<ResourceManagementPanel />);
    await waitFor(() =>
      expect(document.querySelectorAll(".resource-hero-card")).toHaveLength(2),
    );

    const overview = document.getElementById("resource-panel-overview") as HTMLElement;
    const heroes = overview.querySelectorAll(".resource-hero-card");
    expect(within(heroes[0] as HTMLElement).getByText("resource.overview.diskRingTitle")).toBeTruthy();
    expect(
      within(heroes[1] as HTMLElement).getByText("resource.overview.memoryRingTitle"),
    ).toBeTruthy();
    // 每张主卡都有小环 + 已用/剩余/总量三行，数字不依赖脚注。
    expect(heroes[0].querySelectorAll(".resource-ring.is-compact")).toHaveLength(1);
    expect(heroes[0].querySelectorAll(".resource-hero-facts > div")).toHaveLength(3);
    expect(heroes[1].querySelectorAll(".resource-hero-facts > div")).toHaveLength(3);

    // 关注摘要默认只有一行，明细不占高度。
    const attention = overview.querySelector(".resource-attention") as HTMLElement;
    expect(attention).toBeTruthy();
    expect(attention.querySelector(".resource-attention-detail")).toBeNull();
    fireEvent.click(
      within(attention).getByRole("button", {
        name: "resource.overview.attentionDetailAria",
      }),
    );
    expect(attention.querySelectorAll(".resource-attention-detail li")).toHaveLength(2);
    expect(
      within(attention).getAllByText(/resource\.level\.critical/).length,
    ).toBeGreaterThan(0);
    expect(attention.textContent).toContain("C:");
    expect(attention.textContent).toContain("D:");

    // 页头不再常驻刷新范围与底部安全段落；安全说明收敛为可聚焦徽标。
    expect(document.querySelector(".resource-scope-line")).toBeNull();
    expect(document.querySelector(".resource-page-footnote")).toBeNull();
    expect(
      document.querySelector(".resource-safety-chip")?.getAttribute("aria-label"),
    ).toBe("resource.footer.safety");
    const refresh = screen.getByRole("button", { name: "resource.refresh" });
    expect(refresh.getAttribute("aria-describedby")).toBe("resource-refresh-scope");
    expect(document.getElementById("resource-refresh-scope")?.textContent).toBe(
      "resource.refreshScope.overview",
    );
  });

  it("进程排序：按内存重排，展开态跟随进程身份保留", async () => {
    mocks.processDiagnostics.mockResolvedValue({
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
          cpuPercent: 1,
          workingSetBytes: 1048576,
          privateBytes: 524288,
          uptimeSecs: 10,
          status: "normal",
        },
        {
          pid: 700,
          name: "cargo.exe",
          association: "project_dev",
          associationBasis: "image_path",
          cpuPercent: 50,
          workingSetBytes: 100 * 1024 * 1024,
          privateBytes: 1048576,
          uptimeSecs: 50,
          status: "normal",
        },
        {
          pid: 701,
          name: "node.exe",
          association: "external_tool",
          associationBasis: "name_and_path",
          cpuPercent: 10,
          workingSetBytes: 300 * 1024 * 1024,
          privateBytes: 1048576,
          uptimeSecs: 40,
          status: "normal",
        },
      ],
    });
    render(<ResourceManagementPanel />);
    fireEvent.click(tab("resource.segment.process"));
    fireEvent.click(
      screen.getByRole("button", { name: /settings\.resourceCleanup\.processLoad/ }),
    );
    await waitFor(() =>
      expect(document.querySelectorAll(".resource-process-row")).toHaveLength(2),
    );

    const rowNames = () =>
      [...document.querySelectorAll(".resource-process-row .resource-process-name")].map(
        (node) => node.textContent,
      );
    expect(rowNames()).toEqual(["cargo.exe", "node.exe"]);

    // 展开 node，再按内存排序：node 内存更大，应排到第一，展开态随行移动。
    const nodeRow = [...document.querySelectorAll(".resource-process-row")][1] as HTMLElement;
    fireEvent.click(nodeRow.querySelector(".resource-process-toggle") as HTMLElement);
    expect(nodeRow.classList.contains("is-open")).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "resource.process.sortMemoryShort" }),
    );
    expect(rowNames()).toEqual(["node.exe", "cargo.exe"]);
    const rows = [...document.querySelectorAll(".resource-process-row")];
    expect(rows[0].classList.contains("is-open")).toBe(true);
    expect(rows[1].classList.contains("is-open")).toBe(false);
    expect(
      screen
        .getByRole("button", { name: "resource.process.sortMemoryShort" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("概览：内存不可读时不显示假百分比", async () => {
    mocks.snapshot.mockResolvedValue({
      ...SNAPSHOT,
      memory: { totalBytes: null, availableBytes: null },
    });
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));

    const rings = document.querySelectorAll(".resource-ring");
    const memoryRing = rings[1] as HTMLElement;
    expect(memoryRing.querySelector(".resource-ring-center strong")?.textContent).toBe("—");
    expect(memoryRing.classList.contains("is-unknown")).toBe(true);
    expect(memoryRing.querySelector(".resource-ring-fill")).toBeNull();
  });

  it("磁盘分布按容量降序，百分比分母是已统计应用数据", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.disk"));
    await waitFor(() => expect(mocks.diskUsage).toHaveBeenCalledTimes(1));

    const rows = [...document.querySelectorAll(".resource-storage-row")].map((row) => ({
      name: row.querySelector(".resource-storage-name")?.textContent ?? "",
      share: row.querySelector(".resource-storage-share")?.textContent ?? "",
    }));
    // 2048 / 4096 = 50%，1024 / 4096 = 25%，0 字节显示 —
    expect(rows.map((row) => row.share)).toEqual(["50.0%", "25.0%", "—"]);
    expect(rows[0].name).toContain("resource.storage.ttsCache");
    expect(rows[1].name).toContain("resource.storage.clipboardThumbs");

    const widths = [...document.querySelectorAll<HTMLElement>(".resource-stacked-seg")].map(
      (node) => Number.parseFloat(node.style.width),
    );
    expect(widths).toEqual([50, 25]);
  });

  it("磁盘分布统计不完整时标注仅已扫描部分", async () => {
    mocks.diskUsage.mockResolvedValue({ ...DISK_USAGE, truncated: true });
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.disk"));
    await waitFor(() => expect(mocks.diskUsage).toHaveBeenCalledTimes(1));

    expect(await screen.findByText("resource.storage.sharePartial")).toBeTruthy();
    expect(screen.queryByText("resource.storage.shareNote")).toBeNull();
  });

  it("进程行：CPU 条等于真实百分比，内存条相对列表最大值", async () => {
    mocks.processDiagnostics.mockResolvedValue({
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
          cpuPercent: 0.5,
          workingSetBytes: 104857600,
          privateBytes: 52428800,
          uptimeSecs: 100,
          status: "normal",
        },
        {
          pid: 700,
          name: "node.exe",
          association: "external_tool",
          associationBasis: "name_and_path",
          cpuPercent: 10,
          workingSetBytes: 104857600,
          privateBytes: 1048576,
          uptimeSecs: 50,
          status: "normal",
        },
        {
          pid: 701,
          name: "cargo.exe",
          association: "project_dev",
          associationBasis: "image_path",
          cpuPercent: 50,
          workingSetBytes: 209715200,
          privateBytes: 1048576,
          uptimeSecs: 40,
          status: "normal",
        },
      ],
    });
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.process"));
    fireEvent.click(
      screen.getByRole("button", { name: /settings\.resourceCleanup\.processLoad/ }),
    );
    await waitFor(() => expect(mocks.processDiagnostics).toHaveBeenCalledTimes(1));

    const rows = [...document.querySelectorAll(".resource-process-row")];
    expect(rows).toHaveLength(2);
    // 默认行不渲染占用条；展开后才显示详情。
    expect(rows[0].querySelector(".resource-meter-fill")).toBeNull();
    fireEvent.click(rows[0].querySelector(".resource-process-toggle") as HTMLElement);
    fireEvent.click(rows[1].querySelector(".resource-process-toggle") as HTMLElement);
    const widthsOf = (row: Element) =>
      [...row.querySelectorAll<HTMLElement>(".resource-meter-fill")].map((node) =>
        Number.parseFloat(node.style.width),
      );
    // 默认按 CPU 降序：cargo（50%）在前，node（10%）在后
    expect(widthsOf(rows[0])).toEqual([50, 100]);
    // node: CPU 10%，内存 100/200 = 50%
    expect(widthsOf(rows[1])).toEqual([10, 50]);
    // 口径说明必须存在，避免被误读为系统内存占比
    expect(screen.getAllByText("resource.process.detailNote").length).toBeGreaterThan(0);
  });

  it("页头刷新只刷新当前分区的数据", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    const refresh = screen.getByRole("button", { name: "resource.refresh" });

    // 概览：只重读系统快照，不触发磁盘/内存/进程
    fireEvent.click(refresh);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));
    expect(mocks.diskUsage).not.toHaveBeenCalled();
    expect(mocks.memoryCatalog).not.toHaveBeenCalled();
    expect(mocks.processDiagnostics).not.toHaveBeenCalled();

    // 磁盘：页头刷新更新磁盘分布
    fireEvent.click(tab("resource.segment.disk"));
    await waitFor(() => expect(mocks.diskUsage).toHaveBeenCalledTimes(1));
    // 进入磁盘页会先统计一次占用；统计期间刷新按钮按忙碌态禁用，等结算后再点。
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(refresh);
    await waitFor(() => expect(mocks.diskUsage).toHaveBeenCalledTimes(2));
    expect(mocks.snapshot).toHaveBeenCalledTimes(3);

    // 内存：页头刷新只更新内存目录，不再重扫磁盘分布
    fireEvent.click(tab("resource.segment.memory"));
    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(1));
    fireEvent.click(refresh);
    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(2));
    expect(mocks.diskUsage).toHaveBeenCalledTimes(2);
  });

  it("概览缓存未扫描时说明「尚未扫描」，不写 0 B", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    expect(screen.getByText("resource.overview.cacheUnscanned")).toBeTruthy();
    expect(screen.getByText("resource.overview.cleanableUnknown")).toBeTruthy();
    expect(screen.queryByText("0 B")).toBeNull();
  });

  // ── 五个分区的刷新闭环与隐藏分区（2026-11-07）────────────────────

  it("功能运行分区：页头刷新重新查询生命周期状态", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.modules"));
    await waitFor(() => expect(mocks.lifecycleStatus).toHaveBeenCalledTimes(1));

    const refresh = screen.getByRole("button", { name: "resource.refresh" });
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(refresh);

    await waitFor(() => expect(mocks.lifecycleStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));
    // 分区内部不再放第二个常驻刷新按钮
    const modulesPanel = document.getElementById("resource-panel-modules") as HTMLElement;
    expect(within(modulesPanel).queryByRole("button", { name: "resource.modules.refresh" })).toBeNull();
  });

  it("隐藏的功能运行分区不因设置变化查询，返回时重新读取", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.modules"));
    await waitFor(() => expect(mocks.lifecycleStatus).toHaveBeenCalledTimes(1));

    // 离开分区但保持挂载
    fireEvent.click(tab("resource.segment.disk"));
    await waitFor(() => expect(mocks.diskUsage).toHaveBeenCalledTimes(1));

    await act(async () => {
      useSettingsStore.setState({
        settings: { clipboard_paused: true } as unknown as Settings,
      });
    });
    expect(mocks.lifecycleStatus).toHaveBeenCalledTimes(1);

    fireEvent.click(tab("resource.segment.modules"));
    await waitFor(() => expect(mocks.lifecycleStatus).toHaveBeenCalledTimes(2));
  });

  it("内存页刷新：重新读取进程数据并更新 WebView2 工作集", async () => {
    mocks.processDiagnostics
      .mockResolvedValueOnce(diagnosticsWithWebview(30 * 1024 * 1024))
      .mockResolvedValueOnce(diagnosticsWithWebview(40 * 1024 * 1024));
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.memory"));

    const memoryPanel = document.getElementById("resource-panel-memory") as HTMLElement;
    await waitFor(() => expect(mocks.processDiagnostics).toHaveBeenCalledTimes(1));
    const cards = memoryPanel.querySelectorAll(".resource-metric");
    expect(cards).toHaveLength(3);
    const webviewCard = cards[2] as HTMLElement;
    await waitFor(() => expect(within(webviewCard).getByText("30.0 MB")).toBeTruthy());
    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(1));

    const refresh = screen.getByRole("button", { name: "resource.refresh" });
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(refresh);

    await waitFor(() => expect(mocks.processDiagnostics).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(webviewCard).getByText("40.0 MB")).toBeTruthy());
    // 目录也按同一入口刷新；快照指标保持可用
    await waitFor(() => expect(mocks.memoryCatalog).toHaveBeenCalledTimes(2));
    expect(within(cards[0] as HTMLElement).getByText("100.0 MB")).toBeTruthy();
  });

  it("内存页刷新时进程读取失败：显示未知并可重试，不清空其他指标", async () => {
    mocks.processDiagnostics
      .mockResolvedValueOnce(diagnosticsWithWebview(30 * 1024 * 1024))
      .mockRejectedValueOnce({ code: "UNKNOWN_ERROR" });
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.memory"));

    const memoryPanel = document.getElementById("resource-panel-memory") as HTMLElement;
    await waitFor(() => expect(mocks.processDiagnostics).toHaveBeenCalledTimes(1));
    const cards = memoryPanel.querySelectorAll(".resource-metric");
    const webviewCard = cards[2] as HTMLElement;
    await waitFor(() => expect(within(webviewCard).getByText("30.0 MB")).toBeTruthy());

    const refresh = screen.getByRole("button", { name: "resource.refresh" });
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(refresh);
    await waitFor(() => expect(mocks.processDiagnostics).toHaveBeenCalledTimes(2));

    // 失败不保留旧值冒充新值；其他成功读取的指标不变
    await waitFor(() =>
      expect(within(webviewCard).getByText("resource.memory.webviewFailed")).toBeTruthy(),
    );
    expect(within(webviewCard).getByText("settings.resourceCleanup.unavailable")).toBeTruthy();
    expect(within(webviewCard).queryByText("30.0 MB")).toBeNull();
    expect(
      within(webviewCard).getByRole("button", { name: "common.retry" }),
    ).toBeTruthy();
    expect(within(cards[0] as HTMLElement).getByText("100.0 MB")).toBeTruthy();
  });

  it("空间分析进入磁盘页后不自动扫描，默认使用主盘根目录", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.disk"));
    await waitFor(() => expect(mocks.diskUsage).toHaveBeenCalledTimes(1));

    // 只读分析必须由用户显式触发，进入页面不产生扫描
    expect(mocks.diskAnalyze).not.toHaveBeenCalled();
    const diskPanel = document.getElementById("resource-panel-disk") as HTMLElement;
    expect(within(diskPanel).getByText("C:\\")).toBeTruthy();
    // 空间分析默认折叠：先展开（折叠只 hidden，不卸载，路径已就绪）
    fireEvent.click(
      within(diskPanel).getByRole("button", { name: /resource\.analysis\.title/ }),
    );
    fireEvent.click(
      within(diskPanel).getByRole("button", { name: "resource.analysis.scan" }),
    );
    await waitFor(() => expect(mocks.diskAnalyze).toHaveBeenCalledWith("C:\\"));
  });

  it("所有卷：磁盘页逐卷展示，概览卷条并列，读不到的卷显示暂不可用", async () => {
    mocks.snapshot.mockResolvedValue({
      ...SNAPSHOT,
      disks: [
        { volume: "C:", kind: "fixed", totalBytes: 1000, availableBytes: 500 },
        { volume: "D:", kind: "fixed", totalBytes: 1000, availableBytes: 80 },
        { volume: "Z:", kind: "remote", totalBytes: null, availableBytes: null },
      ],
    });
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));

    // 概览：主环仍是首卷（数据目录所在卷），其余卷以紧凑卷条并列
    const overview = document.getElementById("resource-panel-overview") as HTMLElement;
    const primaryRing = overview.querySelector(".resource-ring") as HTMLElement;
    expect(primaryRing.querySelector(".resource-ring-center strong")?.textContent).toBe("50.0%");
    const chips = [...overview.querySelectorAll(".resource-volume-chip")];
    expect(
      chips.map((chip) => chip.querySelector(".resource-volume-name")?.textContent),
    ).toEqual(["C:", "D:", "Z:"]);
    expect(chips[1].querySelector(".resource-volume-value")?.textContent).toBe(
      "92.0% · resource.level.critical",
    );
    expect(chips[2].querySelector(".resource-volume-value")?.textContent).toBe(
      "resource.level.unknown",
    );

    // 磁盘页：每个卷一条使用率条，网络卷不可读时不画填充
    fireEvent.click(tab("resource.segment.disk"));
    await waitFor(() => expect(mocks.diskUsage).toHaveBeenCalledTimes(1));
    const bars = [
      ...document.querySelectorAll<HTMLElement>(
        "#resource-panel-disk .resource-disk-volumes .resource-bar",
      ),
    ];
    expect(bars).toHaveLength(3);
    // 状态由卡片头部的文字状态标签表达；条形右侧只显示百分比，避免重复。
    expect(bars[0].querySelector(".resource-bar-value")?.textContent).toBe("50.0%");
    expect(bars[1].querySelector(".resource-bar-value")?.textContent).toBe("92.0%");
    // 等级文案走与环形一致的 resource.level.unknown（真实文案同为「暂不可用」）
    expect(bars[2].querySelector(".resource-bar-value")?.textContent).toBe(
      "resource.level.unknown",
    );
    expect(bars[2].querySelector(".resource-bar-fill")).toBeNull();
    // 卷类型现在位于卡片头部（与卷名、状态标签同一行），不再挤在条形右侧。
    expect(bars[2].closest(".resource-volume-card")?.textContent).toContain(
      "resource.volume.kind.remote",
    );
    const pills = [
      ...document.querySelectorAll<HTMLElement>(
        "#resource-panel-disk .resource-volume-card .resource-status-pill",
      ),
    ];
    expect(pills.map((pill) => pill.textContent)).toEqual([
      "resource.level.normal",
      "resource.level.critical",
      "resource.level.unknown",
    ]);
  });

  it("部分统计且 0 B：概览不把 0 B 当作确认无可清理", async () => {
    mocks.cleanupPreview.mockResolvedValue({
      ...PREVIEW,
      totalEstimatedBytes: 0,
      totalCandidates: 0,
      categories: [
        {
          category: "temporary",
          status: "partial",
          candidates: 0,
          estimatedBytes: 0,
          protectedFiles: 0,
          skippedFiles: 3,
          errorCode: "SCAN_UNAVAILABLE",
        },
        {
          category: "tts",
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
    });
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.disk"));
    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.scan" }));
    await screen.findByText("settings.resourceCleanup.categoriesTitle");
    fireEvent.click(tab("resource.segment.overview"));

    const overview = document.getElementById("resource-panel-overview") as HTMLElement;
    expect(within(overview).getByText("resource.overview.cleanableZeroPartial")).toBeTruthy();
    expect(within(overview).getByText("resource.overview.cleanablePartialNote")).toBeTruthy();
  });

  it("预览过期后概览提示重新扫描，重新扫描后显示新估算", async () => {
    vi.useFakeTimers();
    try {
      mocks.cleanupPreview
        .mockResolvedValueOnce({
          ...PREVIEW,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
        .mockResolvedValueOnce({
          ...PREVIEW,
          previewId: "preview-2",
          totalEstimatedBytes: 4096,
          // 重新扫描的预览必须仍然有效（时钟在用例中已推进过）
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
      const flush = async () => {
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
      };
      render(<ResourceManagementPanel />);
      await flush();

      fireEvent.click(tab("resource.segment.disk"));
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.scan" }));
      await flush();

      fireEvent.click(tab("resource.segment.overview"));
      await flush();
      const overview = document.getElementById("resource-panel-overview") as HTMLElement;
      expect(within(overview).getByText("8.5 KB")).toBeTruthy();

      // TTL 到点：概览不再显示旧估算
      await act(async () => {
        vi.advanceTimersByTime(60_001);
      });
      expect(within(overview).getByText("resource.overview.cleanableStale")).toBeTruthy();
      expect(within(overview).queryByText("8.5 KB")).toBeNull();

      fireEvent.click(tab("resource.segment.disk"));
      fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.rescan" }));
      await flush();
      fireEvent.click(tab("resource.segment.overview"));
      await flush();
      expect(within(overview).getByText("4.0 KB")).toBeTruthy();
      expect(within(overview).queryByText("resource.overview.cleanableStale")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("刷新失败：趋势旧读数只作历史展示，不伪装成当前", async () => {
    mocks.snapshot
      .mockResolvedValueOnce(SNAPSHOT)
      .mockRejectedValueOnce({ code: "UNKNOWN_ERROR" })
      .mockResolvedValueOnce({
        ...SNAPSHOT,
        sampledAt: "2026-11-06T00:01:00.000Z",
      });
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    const overview = document.getElementById("resource-panel-overview") as HTMLElement;
    expect(await within(overview).findByText("resource.freshness.live")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "resource.refresh" }));
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));

    // 刷新失败：仍能看到最后一次成功读数，但状态必须是「历史读数」。
    expect(
      await within(overview).findByText("resource.freshness.historical"),
    ).toBeTruthy();
    expect(within(overview).queryByText("resource.freshness.live")).toBeNull();
    expect(within(overview).getAllByText("50.0%").length).toBeGreaterThan(0);
    expect(within(overview).getByRole("alert").textContent).toContain(
      "settings.resourceCleanup.snapshotFailed",
    );

    // 重试成功：恢复为当前读数，历史标记消失。
    fireEvent.click(within(overview).getByRole("button", { name: "common.retry" }));
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(3));
    expect(await within(overview).findByText("resource.freshness.live")).toBeTruthy();
    expect(within(overview).queryByText("resource.freshness.historical")).toBeNull();
  });

  it("概览跳转精确定位到应用缓存清理区块并移动焦点", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    const overview = document.getElementById("resource-panel-overview") as HTMLElement;

    fireEvent.click(
      within(overview).getByRole("button", { name: "resource.overview.cleanableAria" }),
    );

    await waitFor(() =>
      expect(tab("resource.segment.disk").getAttribute("aria-selected")).toBe("true"),
    );
    const anchor = document.querySelector('[data-resource-anchor="app-cache"]');
    expect(anchor).toBeTruthy();
    expect(anchor?.querySelector("#resource-cleanup-title")).toBeTruthy();
    // 焦点落在目标区块标题上（tabIndex=-1），不依赖固定延时。
    await waitFor(() => expect(document.activeElement?.id).toBe("resource-cleanup-title"));
  });

  it("磁盘诊断区块默认折叠、展开不重复统计", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("resource.segment.disk"));
    await waitFor(() => expect(mocks.diskUsage).toHaveBeenCalledTimes(1));

    const diskPanel = document.getElementById("resource-panel-disk") as HTMLElement;
    const analysisToggle = within(diskPanel).getByRole("button", {
      name: /resource\.analysis\.title/,
    });
    expect(analysisToggle.getAttribute("aria-expanded")).toBe("false");
    // 折叠只 hidden，不卸载：默认路径已在 DOM 中，但不会自动扫描。
    expect(within(diskPanel).getByText("C:\\")).toBeTruthy();
    expect(mocks.diskAnalyze).not.toHaveBeenCalled();

    fireEvent.click(analysisToggle);
    expect(analysisToggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(diskPanel).getByRole("button", { name: "resource.analysis.scan" }),
    ).toBeTruthy();

    // 折叠/展开属于纯展示操作，不触发新的目录统计。
    fireEvent.click(analysisToggle);
    fireEvent.click(analysisToggle);
    expect(mocks.diskUsage).toHaveBeenCalledTimes(1);
  });

  it("页头刷新作用域：可见说明与提示随当前分区变化", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    const refresh = screen.getByRole("button", { name: "resource.refresh" });
    expect(screen.getByText("resource.refreshScope.overview")).toBeTruthy();
    expect(refresh.getAttribute("data-tip")).toContain("resource.refreshScope.overview");

    fireEvent.click(tab("resource.segment.disk"));
    expect(screen.getByText("resource.refreshScope.disk")).toBeTruthy();
    expect(refresh.getAttribute("data-tip")).toContain("resource.refreshScope.disk");

    fireEvent.click(tab("resource.segment.memory"));
    expect(screen.getByText("resource.refreshScope.memory")).toBeTruthy();
  });

  it("快照失败后切到其他分区：仍显示读取失败与重试，不把空数据当成无卷", async () => {
    mocks.snapshot.mockRejectedValueOnce({ code: "UNKNOWN_ERROR" });
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toBeTruthy();

    fireEvent.click(tab("resource.segment.disk"));
    await waitFor(() => expect(mocks.diskUsage).toHaveBeenCalledTimes(1));
    // 概览内的错误块随分区隐藏；跨分区失败提示仍可见。
    const alerts = screen.getAllByRole("alert");
    expect(alerts.length).toBeGreaterThan(0);
    expect(
      alerts.some((node) => node.textContent?.includes("settings.resourceCleanup.snapshotFailed")),
    ).toBe(true);
    const retry = alerts
      .flatMap((node) => within(node).queryAllByRole("button", { name: "common.retry" }))
      .at(0);
    expect(retry).toBeTruthy();

    mocks.snapshot.mockResolvedValueOnce(SNAPSHOT);
    fireEvent.click(retry as HTMLButtonElement);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen
          .queryAllByRole("alert")
          .some((node) => node.textContent?.includes("settings.resourceCleanup.snapshotFailed")),
      ).toBe(false),
    );
  });

  it("五个分区 Tab 全部渲染，并支持方向键 / Home / End", async () => {
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
    for (const id of ["overview", "modules", "disk", "memory", "process"]) {
      expect(document.querySelector(`[data-resource-segment="${id}"]`)).toBeTruthy();
    }

    fireEvent.keyDown(tab("resource.segment.overview"), { key: "ArrowRight" });
    expect(tab("resource.segment.modules").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("resource.segment.modules"));

    fireEvent.keyDown(tab("resource.segment.modules"), { key: "ArrowRight" });
    expect(tab("resource.segment.disk").getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tab("resource.segment.disk"), { key: "End" });
    expect(tab("resource.segment.process").getAttribute("aria-selected")).toBe("true");

    // 循环到首项
    fireEvent.keyDown(tab("resource.segment.process"), { key: "ArrowRight" });
    expect(tab("resource.segment.overview").getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tab("resource.segment.overview"), { key: "ArrowLeft" });
    expect(tab("resource.segment.process").getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tab("resource.segment.process"), { key: "Home" });
    expect(tab("resource.segment.overview").getAttribute("aria-selected")).toBe("true");
  });
});
