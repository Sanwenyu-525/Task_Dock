/**
 * @vitest-environment jsdom
 */
//! P1：文件夹对比复制失败/部分成功时，必须保留确认区与勾选项，不能整体清空。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(() => cleanup());

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
  return { ...actual, fsListDir: vi.fn() };
});

import { fsListDir, type FsEntry, type FsOpReport } from "../../lib/bridge";
import FolderCompareDialog, { type CompareRequest } from "./FolderCompareDialog";

const listDir = vi.mocked(fsListDir);

const entry = (name: string, size: number): FsEntry => ({
  name,
  kind: "file",
  ext: "txt",
  size,
  modifiedMs: 1,
  hidden: false,
  category: "text",
});

const request: CompareRequest = {
  sourceDir: "D:\\a",
  sourceLabel: "A",
  targets: [{ paneId: "p2", label: "B", dir: "D:\\b" }],
};

const failedReport: FsOpReport = {
  operationId: "op-1",
  attempted: 1,
  ok: 0,
  failed: 1,
  skipped: 0,
  partial: 0,
  entries: [
    {
      source: "D:\\a\\left.txt",
      target: "D:\\b\\left.txt",
      status: "failed",
      reason: "denied",
      code: "FS_OP_ACCESS_DENIED",
      stage: "transfer",
    },
  ],
};

beforeEach(() => {
  listDir.mockReset();
  listDir.mockImplementation(async (path: string) => ({
    path,
    entries: path === request.sourceDir ? [entry("left.txt", 10)] : [entry("right.txt", 20)],
    scanned: 1,
    nextOffset: 1,
    hasMore: false,
  }));
});

describe("FolderCompareDialog P1 复制结果门禁", () => {
  it("复制失败时保留确认区与失败项勾选，而不是无条件清空", async () => {
    const onCopy = vi.fn().mockResolvedValue(failedReport);
    render(
      <FolderCompareDialog
        request={request}
        onClose={vi.fn()}
        onCopy={onCopy}
      />,
    );

    await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /fw.compare.copySelected/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "fw.compare.confirmCopy" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "fw.compare.confirmCopy" }));

    await waitFor(() => expect(onCopy).toHaveBeenCalledTimes(1));
    expect(onCopy).toHaveBeenCalledWith(["D:\\a\\left.txt"], "D:\\b");
    expect(screen.getByRole("button", { name: "fw.compare.confirmCopy" })).toBeTruthy();
    expect((screen.getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(true);
  });
});
