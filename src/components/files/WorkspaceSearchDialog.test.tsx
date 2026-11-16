/**
 * @vitest-environment jsdom
 */
//! P1 搜索请求代际：停止 A 后立即开始 B，A 晚到不得覆盖 B 的结果或状态。

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../../lib/filesWorkspace/workspaceSearch";

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
  return { ...actual, searchWorkspace: vi.fn() };
});

import { searchWorkspace } from "../../lib/filesWorkspace/workspaceSearch";
import WorkspaceSearchDialog from "./WorkspaceSearchDialog";

const runSearch = vi.mocked(searchWorkspace);

afterEach(() => {
  cleanup();
  runSearch.mockReset();
});

function result(name: string): SearchResult {
  return {
    hits: [
      {
        paneId: "p1",
        paneLabel: "A",
        dirPath: "D:\\a",
        path: `D:\\a\\${name}`,
        entry: { name, kind: "file", ext: "txt", size: 1, modifiedMs: 1, hidden: false, category: "text" },
      },
    ],
    dirsVisited: 1,
    filesScanned: 1,
    truncated: false,
    failedDirs: 0,
    cancelled: false,
  };
}

describe("WorkspaceSearchDialog 请求代际", () => {
  it("旧请求 A 晚到时不覆盖新请求 B 的结果", async () => {
    let resolveA: (value: SearchResult) => void = () => {};
    let resolveB: (value: SearchResult) => void = () => {};
    runSearch
      .mockImplementationOnce(() => new Promise<SearchResult>((resolve) => { resolveA = resolve; }))
      .mockImplementationOnce(() => new Promise<SearchResult>((resolve) => { resolveB = resolve; }));

    render(
      <WorkspaceSearchDialog
        open
        sources={[{ paneId: "p1", label: "A", path: "D:\\a" }]}
        onClose={vi.fn()}
        onReveal={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /fw.search.start/ }));
    await waitFor(() => expect(runSearch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /fw.search.stop/ }));
    fireEvent.click(screen.getByRole("button", { name: /fw.search.start/ }));
    await waitFor(() => expect(runSearch).toHaveBeenCalledTimes(2));

    await act(async () => resolveB(result("new.txt")));
    await waitFor(() => expect(screen.getByText("new.txt")).toBeTruthy());

    await act(async () => resolveA(result("old.txt")));
    await waitFor(() => expect(screen.queryByText("old.txt")).toBeNull());
    expect(screen.getByText("new.txt")).toBeTruthy();
  });
});
