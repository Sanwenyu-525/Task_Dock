/**
 * @vitest-environment jsdom
 */
//! P0：大小预筛只允许报告；未通过 SHA-256 确认前不得出现删除入口。

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

const source = { paneId: "p1", label: "A", path: "D:\\a" };
const files = [
  { path: "D:\\a\\one.txt", dirPath: "D:\\a", paneId: "p1", paneLabel: "A", name: "one.txt", size: 10 },
  { path: "D:\\a\\two.txt", dirPath: "D:\\a", paneId: "p1", paneLabel: "A", name: "two.txt", size: 10 },
];
const hashValue = "a".repeat(64);
const verifiedGroup: DuplicateGroup = { size: 10, files, hash: hashValue };

beforeEach(() => {
  collect.mockReset();
  hash.mockReset();
  collect.mockResolvedValue({ files, truncated: false, cancelled: false });
  hash.mockResolvedValue([verifiedGroup]);
});

describe("DuplicateFinderDialog P0 删除门禁", () => {
  it("仅大小相同：不显示勾选框和删除入口，必须先哈希确认", async () => {
    render(
      <DuplicateFinderDialog
        open
        sources={[source]}
        onClose={vi.fn()}
        onReveal={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "fw.duplicates.scan" }));
    await waitFor(() => expect(collect).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /fw.duplicates.deleteSelected/ })).toBeNull();
    expect(screen.getByRole("button", { name: "fw.duplicates.verify" })).toBeTruthy();
  });

  it("哈希确认后只把每组非保留项交给后端，保留项始终不进入删除集", async () => {
    const onDelete = vi.fn().mockResolvedValue({ ok: 1, failed: 0, failedPaths: [] });
    render(
      <DuplicateFinderDialog
        open
        sources={[source]}
        onClose={vi.fn()}
        onReveal={vi.fn()}
        onDelete={onDelete}
      />,
    );

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
