/**
 * @vitest-environment jsdom
 */
//! 用户级垃圾清理：不自动扫描、默认不勾选、二次确认、TTL 失效、失败提示。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("../../lib/bridge", () => ({
  resourceJunkPreview: mocks.preview,
  resourceJunkExecute: mocks.execute,
}));

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}|${JSON.stringify(vars)}` : key,
  }),
}));

import UserJunkSection from "./UserJunkSection";

const PREVIEW = {
  previewId: "junk-preview-1",
  createdAt: "2026-11-08T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  minimumAgeHours: 168,
  totalCandidates: 6,
  totalEstimatedBytes: 3584,
  categories: [
    {
      category: "recycle_bin",
      status: "ready",
      candidates: 3,
      estimatedBytes: 2048,
      protectedFiles: 0,
      skippedFiles: 0,
    },
    {
      category: "user_temp",
      status: "ready",
      candidates: 2,
      estimatedBytes: 1024,
      protectedFiles: 5,
      skippedFiles: 0,
    },
    {
      category: "system_temp",
      status: "partial",
      candidates: 1,
      estimatedBytes: 512,
      protectedFiles: 0,
      skippedFiles: 2,
      errorCode: "SCAN_UNAVAILABLE",
    },
    {
      category: "crash_dumps",
      status: "ready",
      candidates: 0,
      estimatedBytes: 0,
      protectedFiles: 0,
      skippedFiles: 0,
    },
  ],
};

const REPORT = {
  jobId: "junk-job-1",
  startedAt: "2026-11-08T00:00:01.000Z",
  finishedAt: "2026-11-08T00:00:02.000Z",
  status: "success",
  totalFreedBytes: 3072,
  totalDeletedFiles: 5,
  categories: [
    {
      category: "recycle_bin",
      status: "success",
      candidates: 3,
      estimatedBytes: 2048,
      freedBytes: 2048,
      deletedFiles: 3,
      skippedFiles: 0,
      failedFiles: 0,
    },
    {
      category: "user_temp",
      status: "success",
      candidates: 2,
      estimatedBytes: 1024,
      freedBytes: 1024,
      deletedFiles: 2,
      skippedFiles: 0,
      failedFiles: 0,
    },
  ],
};

beforeEach(() => {
  mocks.preview.mockReset().mockResolvedValue(PREVIEW);
  mocks.execute.mockReset().mockResolvedValue(REPORT);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function cleanButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "resource.junk.clean" }) as HTMLButtonElement;
}

describe("UserJunkSection", () => {
  it("初始不扫描也不勾选；扫描后展示四类、计数与保护数量", async () => {
    render(<UserJunkSection />);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(screen.getByText("resource.junk.notScanned")).toBeTruthy();
    expect(cleanButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "resource.junk.scan" }));
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledWith([
      "recycle_bin",
      "user_temp",
      "system_temp",
      "crash_dumps",
    ]));

    expect(await screen.findByText('resource.junk.items|{"count":3}')).toBeTruthy();
    expect(screen.getByText('resource.junk.files|{"count":2}')).toBeTruthy();
    expect(screen.getByText(/resource\.junk\.protected\|\{"count":5\}/)).toBeTruthy();
    expect(screen.getByText(/resource\.junk\.status\.partial/)).toBeTruthy();
    // 扫描本身不勾选任何类别
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes).toHaveLength(4);
    expect(checkboxes.every((box) => !box.checked)).toBe(true);
    expect(cleanButton().disabled).toBe(true);
  });

  it("零候选与不可用类别不可勾选", async () => {
    mocks.preview.mockResolvedValue({
      ...PREVIEW,
      categories: [
        ...PREVIEW.categories.slice(0, 3),
        {
          category: "crash_dumps",
          status: "unavailable",
          candidates: 0,
          estimatedBytes: 0,
          protectedFiles: 0,
          skippedFiles: 1,
          errorCode: "SCAN_UNAVAILABLE",
        },
      ],
    });
    render(<UserJunkSection />);
    fireEvent.click(screen.getByRole("button", { name: "resource.junk.scan" }));
    const crash = (await screen.findByRole("checkbox", {
      name: "resource.junk.category.crashDumps",
    })) as HTMLInputElement;
    expect(crash.disabled).toBe(true);
    const recycle = screen.getByRole("checkbox", {
      name: "resource.junk.category.recycleBin",
    }) as HTMLInputElement;
    expect(recycle.disabled).toBe(false);
  });

  it("勾选后显示预计释放，确认面板需要二次确认才执行", async () => {
    render(<UserJunkSection />);
    fireEvent.click(screen.getByRole("button", { name: "resource.junk.scan" }));
    const recycle = await screen.findByRole("checkbox", {
      name: "resource.junk.category.recycleBin",
    });
    fireEvent.click(recycle);
    expect(cleanButton().disabled).toBe(false);
    expect(
      screen.getByText(/resource\.junk\.selected\|\{"count":1\}/),
    ).toBeTruthy();

    // 只打开确认面板，不立即执行
    fireEvent.click(cleanButton());
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(
      await screen.findByText('resource.junk.confirmTitle|{"bytes":"2.0 KB"}'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "resource.junk.confirm" }));
    await waitFor(() =>
      expect(mocks.execute).toHaveBeenCalledWith({
        previewId: "junk-preview-1",
        categories: ["recycle_bin"],
      }),
    );
    expect(
      await screen.findByText(
        'resource.junk.resultSuccess|{"bytes":"3.0 KB","files":5}',
      ),
    ).toBeTruthy();
    // 预览已被服务端消费：不允许再次执行
    expect(cleanButton().disabled).toBe(true);
  });

  it("取消确认不会执行清理", async () => {
    render(<UserJunkSection />);
    fireEvent.click(screen.getByRole("button", { name: "resource.junk.scan" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "resource.junk.category.userTemp" }),
    );
    fireEvent.click(cleanButton());
    fireEvent.click(screen.getByRole("button", { name: "settings.resourceCleanup.cancel" }));
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(screen.queryByText(/confirmTitle/)).toBeNull();
  });

  it("扫描失败显示错误，不伪造 0 B", async () => {
    mocks.preview.mockRejectedValueOnce(new Error("CLEANUP_BUSY"));
    render(<UserJunkSection />);
    fireEvent.click(screen.getByRole("button", { name: "resource.junk.scan" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("settings.resourceCleanup.error.cleanupBusy");
    expect(screen.queryByText("0 B")).toBeNull();
  });

  it("执行失败提示错误并作废预览", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("PREVIEW_EXPIRED"));
    render(<UserJunkSection />);
    fireEvent.click(screen.getByRole("button", { name: "resource.junk.scan" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "resource.junk.category.userTemp" }),
    );
    fireEvent.click(cleanButton());
    fireEvent.click(screen.getByRole("button", { name: "resource.junk.confirm" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "settings.resourceCleanup.error.previewExpired",
      ),
    );
    // 预览已作废：清空按钮保持禁用，必须重新扫描
    expect(cleanButton().disabled).toBe(true);
  });

  it("预览 TTL 到期后禁用清理并要求重新扫描", async () => {
    vi.useFakeTimers();
    try {
      mocks.preview.mockResolvedValueOnce({
        ...PREVIEW,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const flush = async () => {
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
      };
      render(<UserJunkSection />);
      fireEvent.click(screen.getByRole("button", { name: "resource.junk.scan" }));
      await flush();
      fireEvent.click(
        screen.getByRole("checkbox", { name: "resource.junk.category.recycleBin" }),
      );
      expect(cleanButton().disabled).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(61_000);
      });
      expect(cleanButton().disabled).toBe(true);
      expect(screen.getByText("resource.junk.expired")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
