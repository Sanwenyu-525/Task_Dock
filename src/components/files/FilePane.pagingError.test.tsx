/**
 * @vitest-environment jsdom
 */
//! 分页停滞（PAGING_STALLED）警示条回归（第六轮收口）。
//!
//! 契约（dirCache.ts）：后端声明 hasMore=true 但 nextOffset 未推进时，缓存置
//! `error = PAGING_STALLED`、停止翻页并保留已加载列表。组件层不得把它当阻断错误
//! 面板静默截断：无论是否已有 listing，都在列表上方显示非阻断警示条，列表与既有
//! 操作保持可用；无该错误时不出现警示条。
//!
//! 缓存侧停滞判定已由 `dirCache.test.ts` 覆盖；本文件只验证 FilePane 渲染分支。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const DIR = "D:\\paging-stalled";

const bridgeMocks = vi.hoisted(() => ({
  fsListDir: vi.fn(),
  fsDirSignature: vi.fn(),
  fsStat: vi.fn(),
  fsOpen: vi.fn(),
  fsReveal: vi.fn(),
  fsCreateDir: vi.fn(),
  fsCreateFile: vi.fn(),
  fsRename: vi.fn(),
  fsCopyPaths: vi.fn(),
  fsMovePaths: vi.fn(),
  fsDeletePaths: vi.fn(),
  shelfAddPaths: vi.fn(),
}));

// 缓存状态由测试注入；loadDir/loadMore/reloadIfChanged 在组件层仅触发入口，这里置空操作桩。
const dirCacheStub = vi.hoisted(() => ({
  state: null as unknown,
  loadDir: vi.fn(),
  loadMore: vi.fn(),
  reloadIfChanged: vi.fn(),
}));

vi.mock("../../lib/bridge", () => bridgeMocks);
vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key, locale: "zh-CN" }),
}));
vi.mock("../../lib/filesWorkspace/dirCache", () => ({
  getDirState: () => dirCacheStub.state,
  subscribeDir: () => () => undefined,
  loadDir: dirCacheStub.loadDir,
  loadMore: dirCacheStub.loadMore,
  reloadIfChanged: dirCacheStub.reloadIfChanged,
  PAGING_STALLED: "PAGING_STALLED",
}));

import FilePane from "./FilePane";
import { useFilesWorkspaceStore } from "../../store/useFilesWorkspaceStore";
import type { DirState } from "../../lib/filesWorkspace/dirCache";
import type { FsEntry } from "../../lib/bridge";

function makeEntry(name: string): FsEntry {
  return { name, kind: "file", ext: "txt", size: 3, modifiedMs: 1, hidden: false, category: "text" };
}

function stalledState(over: Partial<DirState>): DirState {
  return {
    path: DIR,
    showHidden: false,
    listing: null,
    truncated: false,
    hasMore: false,
    diskScanned: null,
    loading: false,
    error: "PAGING_STALLED",
    signatureModifiedMs: null,
    fetchedAt: 0,
    ...over,
  };
}

function hydratePane(): void {
  useFilesWorkspaceStore.getState().hydrate(
    {
      tree: { type: "pane", paneId: "pane-1" },
      panes: [{ paneId: "pane-1", tabs: [{ tabId: "t1", path: DIR }], activeTabId: "t1" }],
      activePaneId: "pane-1",
    },
    "global",
  );
}

beforeEach(() => {
  Object.values(bridgeMocks).forEach((fn) => vi.mocked(fn).mockReset());
  hydratePane();
});

afterEach(() => {
  cleanup();
});

function renderPane() {
  return render(
    <FilePane
      paneId="pane-1"
      active
      pageActive
      onHoverZone={() => undefined}
      dropHint={null}
      layoutEditMode={false}
      projectRoot={null}
    />,
  );
}

describe("PAGING_STALLED 警示条", () => {
  it("已有 listing + 停滞：警示条出现，已有列表仍可见，不进阻断错误面板", () => {
    dirCacheStub.state = stalledState({ listing: [makeEntry("a.txt")] });
    renderPane();

    expect(screen.getByText("fw.status.pagingStalled")).toBeTruthy();
    // 已加载条目未被警示条挤掉或阻断。
    expect(screen.getByText("a.txt")).toBeTruthy();
    // 不出现目录不可用类阻断错误面板。
    expect(document.querySelector(".fw-body-error")).toBeNull();
  });

  it("无 listing + 停滞：警示条出现，仍不进阻断错误面板", () => {
    dirCacheStub.state = stalledState({ listing: null });
    renderPane();

    expect(screen.getByText("fw.status.pagingStalled")).toBeTruthy();
    expect(document.querySelector(".fw-body-error")).toBeNull();
  });

  it("无停滞错误：不出现警示条，正常显示列表", () => {
    dirCacheStub.state = stalledState({ listing: [makeEntry("a.txt")], error: null });
    renderPane();

    expect(screen.queryByText("fw.status.pagingStalled")).toBeNull();
    expect(screen.getByText("a.txt")).toBeTruthy();
  });
});
