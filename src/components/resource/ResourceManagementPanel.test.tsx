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
  lifecycleStatus: vi.fn(async () => []),
}));

vi.mock("../../lib/bridge", () => ({
  resourceSnapshot: mocks.snapshot,
  lifecycleStatus: mocks.lifecycleStatus,
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

  it("概览环形：百分比与数据一致，并按阈值给出状态", async () => {
    mocks.snapshot.mockResolvedValue({
      ...SNAPSHOT,
      // 1000 总量 / 107 可用 → 已用 89.3%（关注）
      disks: [{ volume: "C:", totalBytes: 1000, availableBytes: 107 }],
      // 16 / 8 → 50%（正常）
      memory: { totalBytes: 16, availableBytes: 8 },
    });
    render(<ResourceManagementPanel />);
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));

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
    const widthsOf = (row: Element) =>
      [...row.querySelectorAll<HTMLElement>(".resource-meter-fill")].map((node) =>
        Number.parseFloat(node.style.width),
      );
    // 默认按 CPU 降序：cargo（50%）在前，node（10%）在后
    expect(widthsOf(rows[0])).toEqual([50, 100]);
    // node: CPU 10%，内存 100/200 = 50%
    expect(widthsOf(rows[1])).toEqual([10, 50]);
    // 口径说明必须存在，避免被误读为系统内存占比
    expect(screen.getByText("resource.process.relativeNote")).toBeTruthy();
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
});
