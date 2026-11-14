//! 文件工作区 store 单测：hydrate、分栏、标签移动、导航历史、选择。

import { beforeEach, describe, expect, it } from "vitest";

import { LAYOUT_PRESETS } from "../lib/filesWorkspace/model";
import { setFwClipboard, getFwClipboard } from "../lib/filesWorkspace/interactions";
import { useFilesWorkspaceStore } from "./useFilesWorkspaceStore";

/** 总是取最新状态（zustand getState 快照在动作后不自动更新）。 */
function state() {
  return useFilesWorkspaceStore.getState();
}

function reset(): void {
  const tree = LAYOUT_PRESETS.single.build();
  state().hydrate({ tree, panes: [], activePaneId: "" }, "global");
  setFwClipboard(null);
}

describe("store hydrate / 快照", () => {
  beforeEach(reset);

  it("空状态恢复为单空窗格", () => {
    expect(state().hydrated).toBe(true);
    const s = state();
    expect(s.panes[s.activePaneId].tabs).toHaveLength(0);
  });

  it("持久化快照包含树与标签路径", () => {
    state().openInPane(state().activePaneId, "D:\\work", "newTab");
    const snapshot = state().snapshot();
    expect(snapshot.stateKeyRef).toBe("global");
    expect(snapshot.stateData.panes[0].tabs[0].path).toBe("D:\\work");
  });

  it("hydrate 丢弃无效窗格数据并补齐缺窗格", () => {
    const tree = LAYOUT_PRESETS.quad.build();
    state().hydrate(
      {
        tree,
        panes: [
          { paneId: "ghost", tabs: [{ tabId: "t", path: "C:\\" }], activeTabId: "t" },
        ],
        activePaneId: "ghost",
      },
      "global",
    );
    const s = state();
    expect(s.activePaneId).not.toBe("ghost");
    for (const paneId of Object.keys(s.panes)) {
      expect(s.panes[paneId]).toBeDefined();
    }
  });
});

describe("标签与导航", () => {
  beforeEach(reset);

  it("openInPane newTab 建标签；replace 替换当前", () => {
    const paneId = state().activePaneId;
    state().openInPane(paneId, "D:\\a", "newTab");
    state().openInPane(paneId, "D:\\b", "newTab");
    let s = state();
    expect(s.panes[paneId].tabs).toHaveLength(2);
    const activeTab = s.panes[paneId].tabs.find((t) => t.tabId === s.panes[paneId].activeTabId)!;
    expect(activeTab.path).toBe("D:\\b");
    s.openInPane(paneId, "D:\\c", "replace");
    s = state();
    expect(s.panes[paneId].tabs).toHaveLength(2);
    expect(s.panes[paneId].tabs.find((t) => t.tabId === s.panes[paneId].activeTabId)!.path).toBe("D:\\c");
  });

  it("历史：back/forward/up", () => {
    const paneId = state().activePaneId;
    state().openInPane(paneId, "D:\\a", "newTab");
    state().openInPane(paneId, "D:\\a\\sub", "replace");
    const tabPath = () =>
      state().panes[paneId].tabs.find((t) => t.tabId === state().panes[paneId].activeTabId)!.path;
    state().navigate(paneId, "back");
    expect(tabPath()).toBe("D:\\a");
    state().navigate(paneId, "forward");
    expect(tabPath()).toBe("D:\\a\\sub");
    state().navigate(paneId, "up");
    expect(tabPath()).toBe("D:\\a");
  });

  it("closeTab 关闭激活标签时落到相邻标签", () => {
    const paneId = state().activePaneId;
    state().openInPane(paneId, "D:\\a", "newTab");
    state().openInPane(paneId, "D:\\b", "newTab");
    state().openInPane(paneId, "D:\\c", "newTab");
    const activeId = state().panes[paneId].activeTabId!;
    state().closeTab(paneId, activeId);
    const s = state();
    expect(s.panes[paneId].tabs).toHaveLength(2);
    expect(s.panes[paneId].activeTabId).not.toBeNull();
  });

  it("moveTabToPane 跨窗格移动且源窗格保留其余标签", () => {
    const a = state().activePaneId;
    const split = state().splitPane(a, "horizontal", null);
    expect(split).not.toBeNull();
    state().openInPane(a, "D:\\x1", "newTab");
    state().openInPane(a, "D:\\x2", "newTab");
    const moving = state().panes[a].tabs[0].tabId;
    state().moveTabToPane(moving, a, split!);
    const s = state();
    expect(s.panes[a].tabs).toHaveLength(1);
    expect(s.panes[split!].tabs.map((t) => t.tabId)).toContain(moving);
    expect(s.panes[split!].activeTabId).toBe(moving);
  });

  it("duplicateTab 复制当前标签", () => {
    const paneId = state().activePaneId;
    state().openInPane(paneId, "D:\\dup", "newTab");
    const before = state().panes[paneId].tabs.length;
    state().duplicateTab(paneId, state().panes[paneId].activeTabId!);
    const s = state();
    expect(s.panes[paneId].tabs).toHaveLength(before + 1);
    expect(s.panes[paneId].tabs[before].path).toBe("D:\\dup");
  });
});

describe("布局操作", () => {
  beforeEach(reset);

  it("splitPane 新窗格继承打开路径", () => {
    const a = state().activePaneId;
    state().openInPane(a, "D:\\shared", "newTab");
    const newId = state().splitPane(a, "horizontal", null);
    expect(newId).not.toBeNull();
    expect(state().panes[newId!].tabs[0].path).toBe("D:\\shared");
  });

  it("closePane 移除窗格并把 active 落回剩余窗格", () => {
    const a = state().activePaneId;
    const b = state().splitPane(a, "horizontal", null)!;
    state().closePane(b);
    const s = state();
    expect(Object.keys(s.panes)).not.toContain(b);
    expect(s.activePaneId).not.toBe(b);
  });

  it("applyPreset 四宫格并分配初始路径", () => {
    state().applyPreset("quad", ["D:\\one", "D:\\two"]);
    const s = state();
    expect(Object.keys(s.panes)).toHaveLength(4);
    expect(s.panes[s.activePaneId]).toBeDefined();
    const withTabs = Object.values(s.panes).filter((p) => p.tabs.length > 0);
    expect(withTabs).toHaveLength(2);
  });

  it("toggleMaximize 往复", () => {
    const a = state().activePaneId;
    state().toggleMaximize(a);
    expect(state().maximizedPaneId).toBe(a);
    state().toggleMaximize(a);
    expect(state().maximizedPaneId).toBeNull();
  });
});

describe("选择", () => {
  beforeEach(reset);

  it("setSelection / clearSelection 按窗格隔离", () => {
    const a = state().activePaneId;
    const b = state().splitPane(a, "horizontal", null)!;
    state().setSelection(a, ["D:\\1", "D:\\2"], "D:\\1");
    state().setSelection(b, ["D:\\3"], null);
    let s = state();
    expect(s.selection[a].paths).toEqual(["D:\\1", "D:\\2"]);
    expect(s.selection[b].paths).toEqual(["D:\\3"]);
    state().clearSelection(a);
    s = state();
    expect(s.selection[a]).toBeUndefined();
    expect(s.selection[b].paths).toEqual(["D:\\3"]);
  });
});

describe("内部剪贴板桥", () => {
  it("store 侧可直接使用共享实现", () => {
    setFwClipboard({ mode: "copy", paths: ["C:\\f"] });
    expect(getFwClipboard()?.paths).toEqual(["C:\\f"]);
    setFwClipboard(null);
  });
});
