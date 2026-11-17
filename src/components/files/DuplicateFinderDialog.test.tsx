/**
 * @vitest-environment jsdom
 */
//! P0：大小预筛只允许报告；未通过 SHA-256 确认前不得出现删除入口。
//! R6：扫描完整性结论如实呈现；关闭/卸载/停止必须中止在途扫描；旧请求不得覆盖新请求。

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { tMock } = vi.hoisted(() => ({
  tMock: vi.fn((key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  ),
}));

afterEach(() => cleanup());

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    locale: "zh-CN",
    preference: "zh-CN",
    setPreference: vi.fn(),
    t: tMock,
  }),
}));

vi.mock("../../lib/filesWorkspace/workspaceSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/filesWorkspace/workspaceSearch")>();
  return {
    ...actual,
    collectWorkspaceFiles: vi.fn(),
    hashDuplicateGroups: vi.fn(),
  };
});

import type { DuplicateGroup } from "../../lib/filesWorkspace/workspaceSearch";
import {
  collectWorkspaceFiles,
  hashDuplicateGroups,
} from "../../lib/filesWorkspace/workspaceSearch";
import DuplicateFinderDialog from "./DuplicateFinderDialog";

const collect = vi.mocked(collectWorkspaceFiles);
const hash = vi.mocked(hashDuplicateGroups);

type CollectResult = Awaited<ReturnType<typeof collectWorkspaceFiles>>;

const source = { paneId: "p1", label: "A", path: "D:\\a" };
const files = [
  { path: "D:\\a\\one.txt", dirPath: "D:\\a", paneId: "p1", paneLabel: "A", name: "one.txt", size: 10 },
  { path: "D:\\a\\two.txt", dirPath: "D:\\a", paneId: "p1", paneLabel: "A", name: "two.txt", size: 10 },
];
const sizeOnlyFiles = [
  { path: "D:\\a\\three.txt", dirPath: "D:\\a", paneId: "p1", paneLabel: "A", name: "three.txt", size: 20 },
  { path: "D:\\a\\four.txt", dirPath: "D:\\a", paneId: "p1", paneLabel: "A", name: "four.txt", size: 20 },
];
const hashValue = "a".repeat(64);
const verifiedGroup: DuplicateGroup = { size: 10, files, hash: hashValue };
const sizeOnlyGroup: DuplicateGroup = { size: 20, files: sizeOnlyFiles, hash: null };

function result(overrides: Partial<CollectResult> = {}): CollectResult {
  return {
    files,
    truncated: false,
    failedDirs: 0,
    cancelled: false,
    complete: true,
    ...overrides,
  };
}

function renderDialog(onDelete: ReturnType<typeof vi.fn> = vi.fn()) {
  return render(
    <DuplicateFinderDialog
      open
      sources={[source]}
      onClose={vi.fn()}
      onReveal={vi.fn()}
      onDelete={onDelete}
    />,
  );
}

beforeEach(() => {
  tMock.mockClear();
  collect.mockReset();
  hash.mockReset();
  collect.mockResolvedValue(result());
  hash.mockResolvedValue([verifiedGroup]);
});

describe("DuplicateFinderDialog P0 删除门禁", () => {
  it("仅大小相同：不显示勾选框和删除入口，必须先哈希确认", async () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.scan" }));
    await waitFor(() => expect(collect).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /fw.duplicates.deleteSelected/ })).toBeNull();
    expect(screen.getByRole("button", { name: "fw.duplicates.verify" })).toBeTruthy();
  });

  it("哈希确认后只把每组非保留项交给后端，保留项始终不进入删除集", async () => {
    const onDelete = vi.fn().mockResolvedValue({ ok: 1, failed: 0, failedPaths: [] });
    renderDialog(onDelete);

    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.scan" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "fw.duplicates.verify" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.verify" }));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /fw.duplicates.deleteSelected/ }));
    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.deletePermanent" }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    expect(onDelete.mock.calls[0][0]).toEqual([
      {
        keepPath: "D:\\a\\one.txt",
        deletePaths: ["D:\\a\\two.txt"],
        expectedSize: 10,
        expectedHash: hashValue,
      },
    ]);
  });
});

describe("扫描完整性结论如实呈现", () => {
  it("truncated=true：显示上限提示与扫描范围不完整，不得伪装完整", async () => {
    collect.mockResolvedValue(result({ truncated: true, complete: false }));
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.scan" }));
    await waitFor(() => expect(screen.getByText(/fw.duplicates.truncated/)).toBeTruthy());

    expect(screen.getByText("fw.duplicates.scanIncomplete")).toBeTruthy();
    expect(screen.queryByText("fw.duplicates.scanComplete")).toBeNull();
  });

  it("failedDirs=2 且 complete=false：显示失败目录数（count=2）与不完整提示", async () => {
    collect.mockResolvedValue(result({ failedDirs: 2, complete: false }));
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.scan" }));
    await waitFor(() =>
      expect(screen.getByText(/fw.duplicates.failedDirs/)).toBeTruthy(),
    );

    expect(tMock).toHaveBeenCalledWith("fw.duplicates.failedDirs", { count: 2 });
    expect(screen.getByText("fw.duplicates.scanIncomplete")).toBeTruthy();
    expect(screen.queryByText("fw.duplicates.scanComplete")).toBeNull();
  });

  it("cancelled=true：显示取消提示与不完整提示", async () => {
    collect.mockResolvedValue(result({ cancelled: true, complete: false }));
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.scan" }));
    await waitFor(() => expect(screen.getByText(/fw.duplicates.cancelled/)).toBeTruthy());

    expect(screen.getByText("fw.duplicates.scanIncomplete")).toBeTruthy();
    expect(screen.queryByText("fw.duplicates.scanComplete")).toBeNull();
  });

  it("complete=true：显示扫描完整，不出现不完整提示", async () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.scan" }));
    await waitFor(() => expect(screen.getByText("fw.duplicates.scanComplete")).toBeTruthy());

    expect(screen.queryByText("fw.duplicates.scanIncomplete")).toBeNull();
    expect(screen.queryByText("fw.duplicates.truncated")).toBeNull();
  });

  it("不完整扫描 + 哈希确认：只有带 hash 的组可勾选；未哈希组不产生删除项，确认框持续提示不完整", async () => {
    collect.mockResolvedValue(
      result({ files: [...files, ...sizeOnlyFiles], truncated: true, complete: false }),
    );
    hash.mockResolvedValue([verifiedGroup, sizeOnlyGroup]);
    const onDelete = vi.fn().mockResolvedValue({ ok: 1, failed: 0, failedPaths: [] });
    renderDialog(onDelete);

    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.scan" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "fw.duplicates.verify" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.verify" }));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());

    // 未哈希组（three/four）行内不出现勾选框。
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /fw.duplicates.deleteSelected/ }));

    // 进入确认框后仍持续显示扫描范围不完整（结果区 + 确认框各一处）。
    const incompleteHints = await screen.findAllByText("fw.duplicates.scanIncomplete");
    expect(incompleteHints.length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.deletePermanent" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));

    const request = onDelete.mock.calls[0][0];
    expect(request).toHaveLength(1);
    expect(request[0].deletePaths).toEqual(["D:\\a\\two.txt"]);
    expect(JSON.stringify(request)).not.toContain("three.txt");
    expect(JSON.stringify(request)).not.toContain("four.txt");
  });
});

describe("关闭、卸载与停止必须中止在途扫描", () => {
  it("扫描中点击关闭：AbortSignal 变为 aborted；晚到的 resolve 不报错、不覆盖状态", async () => {
    let resolveCollect: (value: CollectResult) => void = () => {};
    collect.mockImplementation(
      () =>
        new Promise<CollectResult>((resolve) => {
          resolveCollect = resolve;
        }),
    );
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.scan" }));
    await waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
    const signal = collect.mock.calls[0][3] as AbortSignal;

    fireEvent.click(screen.getByRole("button", { name: "common.close" }));
    expect(signal.aborted).toBe(true);

    await act(async () => resolveCollect(result()));
    expect(screen.queryByText("D:\\a\\one.txt")).toBeNull();
    expect(screen.queryByText("D:\\a\\two.txt")).toBeNull();
  });

  it("扫描中卸载组件：signal 已 aborted，无 React 告警、无未处理拒绝", async () => {
    collect.mockImplementation(() => new Promise<CollectResult>(() => {}));
    const { unmount } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.scan" }));
    await waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
    const signal = collect.mock.calls[0][3] as AbortSignal;

    act(() => unmount());
    expect(signal.aborted).toBe(true);
  });

  it("旧请求晚到不覆盖新请求：第二次先返回、第一次后返回，最终展示第二次结果", async () => {
    let resolveA: (value: CollectResult) => void = () => {};
    let resolveB: (value: CollectResult) => void = () => {};
    collect
      .mockImplementationOnce(
        () =>
          new Promise<CollectResult>((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<CollectResult>((resolve) => {
            resolveB = resolve;
          }),
      );
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.scan" }));
    await waitFor(() => expect(collect).toHaveBeenCalledTimes(1));

    // 切换来源触发 reset（递增代际 + 中止旧请求），再重新勾选并发起第二次扫描。
    const sourceButton = screen.getByTitle("D:\\a");
    fireEvent.click(sourceButton);
    fireEvent.click(sourceButton);
    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.scan" }));
    await waitFor(() => expect(collect).toHaveBeenCalledTimes(2));

    await act(async () => resolveB(result({ files: sizeOnlyFiles })));
    await waitFor(() => expect(screen.getByText("D:\\a\\three.txt")).toBeTruthy());

    await act(async () => resolveA(result({ files })));
    expect(screen.queryByText("D:\\a\\one.txt")).toBeNull();
    expect(screen.getByText("D:\\a\\three.txt")).toBeTruthy();
  });

  it("运行中点击“停止扫描”：中止 signal，并如实显示取消与不完整状态", async () => {
    collect.mockImplementation(() => new Promise<CollectResult>(() => {}));
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.scan" }));
    await waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
    const signal = collect.mock.calls[0][3] as AbortSignal;

    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.stop" }));
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(screen.getByText(/fw.duplicates.cancelled/)).toBeTruthy());
    expect(screen.getByText("fw.duplicates.scanIncomplete")).toBeTruthy();
  });
});
