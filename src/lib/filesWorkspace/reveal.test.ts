//! 跨模块「在文件工作区打开 / 定位」的唯一入口：只做导航，不改目录内容。

import { beforeEach, describe, expect, it, vi } from "vitest";

const filesStore = vi.hoisted(() => ({
  openPathInActive: vi.fn(),
  setSelection: vi.fn(),
  activePaneId: "pane-1",
}));

const uiStore = vi.hoisted(() => ({
  setTab: vi.fn(),
}));

vi.mock("../../store/useFilesWorkspaceStore", () => ({
  useFilesWorkspaceStore: { getState: () => filesStore },
}));
vi.mock("../../store/useUiStore", () => ({
  useUiStore: { getState: () => uiStore },
}));

import { openDirInFilesWorkspace, revealFileInFilesWorkspace } from "./reveal";

beforeEach(() => {
  filesStore.openPathInActive.mockReset();
  filesStore.openPathInActive.mockReturnValue(true);
  filesStore.setSelection.mockReset();
  uiStore.setTab.mockReset();
  uiStore.setTab.mockReturnValue("switched");
});

describe("reveal 导航入口", () => {
  it("打开目录：新标签 + 切到文件页", () => {
    const result = openDirInFilesWorkspace("D:\\Work\\Docs");
    expect(result.ok).toBe(true);
    expect(filesStore.openPathInActive).toHaveBeenCalledWith("D:\\Work\\Docs", "newTab");
    expect(uiStore.setTab).toHaveBeenCalledWith("files");
    expect(filesStore.setSelection).not.toHaveBeenCalled();
  });

  it("定位文件：打开父目录并选中该文件", () => {
    const result = revealFileInFilesWorkspace("D:\\Work\\Docs\\a.txt");
    expect(result.ok).toBe(true);
    expect(filesStore.openPathInActive).toHaveBeenCalledWith("D:\\Work\\Docs", "newTab");
    expect(filesStore.setSelection).toHaveBeenCalledWith("pane-1", ["D:\\Work\\Docs\\a.txt"]);
  });

  it("目录打不开时不切页（不假装已打开）", () => {
    filesStore.openPathInActive.mockReturnValue(false);
    const result = openDirInFilesWorkspace("D:\\Missing");
    expect(result).toEqual({ ok: false, reason: "open-failed" });
    expect(uiStore.setTab).not.toHaveBeenCalled();
  });

  it("有未保存草稿时如实返回 pending/blocked，供调用方提示", () => {
    uiStore.setTab.mockReturnValueOnce("pending");
    expect(openDirInFilesWorkspace("D:\\Work").reason).toBe("tab-pending");
    uiStore.setTab.mockReturnValueOnce("blocked");
    expect(openDirInFilesWorkspace("D:\\Work").reason).toBe("tab-blocked");
  });

  it("不切页模式（其他模块/Agent 调用）", () => {
    const result = openDirInFilesWorkspace("D:\\Work", false);
    expect(result.ok).toBe(true);
    expect(uiStore.setTab).not.toHaveBeenCalled();
  });
});
