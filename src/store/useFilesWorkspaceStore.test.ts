//! 文件工作区 store 单测：hydrate、分栏、标签移动、导航历史、选择、
//! 持久化恢复（激活标签/模板映射/项目切换 flush/窗格上限）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LAYOUT_PRESETS, paneIds, pathToPane, type SplitNode } from "../lib/filesWorkspace/model";
import { setFwClipboard, getFwClipboard } from "../lib/filesWorkspace/interactions";
import {
  bindSettingsStore,
  FILE_WORKSPACE_SETTING_KEY,
  MAX_RECENT,
  MAX_TEMPLATES,
  __flushFilesWorkspaceWrites,
  type FilesWorkspacePersisted,
} from "../lib/filesWorkspace/persist";
import { tabTitle, useFilesWorkspaceStore } from "./useFilesWorkspaceStore";

/** 总是取最新状态（zustand getState 快照在动作后不自动更新）。 */
function state() {
  return useFilesWorkspaceStore.getState();
}

/** 内存设置存储（测试隔离；schedulePersist 的写入链落到这里）。 */
const memSettings: { settings: Record<string, unknown>; update: (patch: Record<string, unknown>) => Promise<void> } = {
  settings: {},
  async update(patch) {
    Object.assign(memSettings.settings, patch);
  },
};
bindSettingsStore(() => memSettings);

function persistedNow(): FilesWorkspacePersisted {
  return (memSettings.settings[FILE_WORKSPACE_SETTING_KEY] ?? {
    version: 1,
    states: {},
    templates: [],
    recentTemplates: [],
  }) as FilesWorkspacePersisted;
}

function reset(): void {
  memSettings.settings = {};
  const tree = LAYOUT_PRESETS.single.build();
  state().hydrate({ tree, panes: [], activePaneId: "" }, "global");
  setFwClipboard(null);
}

afterEach(async () => {
  // 清掉挂起的防抖定时器并落盘，防跨测试污染。
  await state().flushPending();
  await __flushFilesWorkspaceWrites();
});

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

  it("最近目录去重且有界；clearRecentDirs 清空", () => {
    state().clearRecentDirs();
    state().recordRecentDir("D:\\a");
    state().recordRecentDir("D:\\b");
    state().recordRecentDir("D:\\a");
    expect(state().recentDirs.slice(0, 2)).toEqual(["D:\\a", "D:\\b"]);
    state().clearRecentDirs();
    expect(state().recentDirs).toEqual([]);
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
    state().openInPane(a, "D:\\x1", "newTab");
    state().openInPane(a, "D:\\x2", "newTab");
    // splitPane 现在必须有活动标签才能分栏（复制该标签进新窗格）。
    const split = state().splitPane(a, "horizontal", null);
    expect(split).not.toBeNull();
    const moving = state().panes[a].tabs[0].tabId;
    state().moveTabToPane(moving, a, split!);
    const s = state();
    expect(s.panes[a].tabs).toHaveLength(1);
    expect(s.panes[split!].tabs.map((t) => t.tabId)).toContain(moving);
    expect(s.panes[split!].activeTabId).toBe(moving);
  });

  it("duplicateTabInPane 复制当前标签（深拷贝 history、插在源标签后并激活副本）", () => {
    const paneId = state().activePaneId;
    state().openInPane(paneId, "D:\\dup", "newTab");
    const source = state().panes[paneId].tabs[0];
    const before = state().panes[paneId].tabs.length;
    state().duplicateTabInPane(paneId, source.tabId);
    const s = state();
    expect(s.panes[paneId].tabs).toHaveLength(before + 1);
    const copy = s.panes[paneId].tabs[1];
    expect(copy.path).toBe("D:\\dup");
    expect(copy.tabId).not.toBe(source.tabId);
    expect(copy.history).toEqual(source.history);
    expect(copy.history).not.toBe(source.history);
    expect(s.panes[paneId].activeTabId).toBe(copy.tabId);
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
    state().openInPane(a, "D:\\seed", "newTab");
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
    state().openInPane(a, "D:\\seed", "newTab");
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

// ── P0 恢复语义（第二轮回归钉）──────────────────────────────────────────

describe("恢复：激活标签与 tabId 复用", () => {
  beforeEach(reset);

  it("hydrate 复用持久化 tabId，激活标签命中第二个标签（P0：重新生成 ID 后永不匹配）", () => {
    const tree = LAYOUT_PRESETS.leftRight.build();
    state().hydrate(
      {
        tree,
        panes: [
          {
            paneId: "pane-a",
            tabs: [
              { tabId: "tab-src", path: "D:\\source" },
              { tabId: "tab-art", path: "D:\\art" },
            ],
            activeTabId: "tab-art",
          },
          { paneId: "pane-b", tabs: [{ tabId: "tab-doc", path: "D:\\docs" }], activeTabId: "tab-doc" },
        ],
        activePaneId: "pane-a",
      },
      "global",
    );
    const s = state();
    const paneA = s.panes["pane-a"];
    expect(paneA.tabs.map((t) => t.tabId)).toEqual(["tab-src", "tab-art"]);
    expect(paneA.activeTabId).toBe("tab-art");
    expect(paneA.tabs.find((t) => t.tabId === "tab-art")!.path).toBe("D:\\art");
    expect(s.panes["pane-b"].activeTabId).toBe("tab-doc");
    // 顺序保持。
    expect(paneA.tabs[0].path).toBe("D:\\source");
  });

  it("持久化 activeTabId 无效时回退首个标签，不悬空", () => {
    const tree = LAYOUT_PRESETS.single.build();
    state().hydrate(
      { tree, panes: [{ paneId: "pane-1", tabs: [{ tabId: "t1", path: "C:\\" }], activeTabId: "ghost" }], activePaneId: "pane-1" },
      "global",
    );
    expect(state().panes["pane-1"].activeTabId).toBe("t1");
  });

  it("损坏树整体回退默认单窗格（不白屏）", () => {
    const garbage = { type: "split", id: "s", direction: "diagonal", ratio: 0.5, first: null, second: null } as unknown as SplitNode;
    state().hydrate({ tree: garbage, panes: [], activePaneId: "" }, "global");
    const s = state();
    expect(s.tree.type).toBe("pane");
    expect(Object.keys(s.panes)).toHaveLength(1);
  });
});

describe("恢复：自定义模板映射", () => {
  beforeEach(reset);

  it("applyTemplate 恢复全部目录与激活标签（P0：旧实现用新 ID 查旧数据标签全丢）", () => {
    // 四宫格模板：左上源码 / 右上美术 / 左下文档 / 右下构建输出。
    const tree = LAYOUT_PRESETS.quad.build();
    const result = state().applyTemplate("tpl-1", [
      {
        id: "tpl-1",
        tree,
        panes: [
          { paneId: "pane-a", tabs: [{ tabId: "ta", path: "D:\\game\\src" }], activeTabId: "ta" },
          { paneId: "pane-b", tabs: [{ tabId: "tb", path: "D:\\game\\art" }], activeTabId: "tb" },
          { paneId: "pane-c", tabs: [{ tabId: "tc", path: "D:\\game\\docs" }], activeTabId: "tc" },
          { paneId: "pane-d", tabs: [{ tabId: "td", path: "D:\\game\\build" }], activeTabId: "td" },
        ],
      },
    ]);
    void result;
    const s = state();
    const ids = Object.keys(s.panes);
    expect(ids).toHaveLength(4);
    const paths = ids.map((id) => s.panes[id].tabs[0]?.path).sort();
    expect(paths).toEqual(["D:\\game\\art", "D:\\game\\build", "D:\\game\\docs", "D:\\game\\src"]);
    // 每个窗格的激活标签就是其唯一标签（映射重映射后仍命中）。
    for (const id of ids) {
      const pane = s.panes[id];
      expect(pane.activeTabId).toBe(pane.tabs[0].tabId);
    }
    // 比例恢复（四宫格 0.5 / 0.5）。
    const root = s.tree as Extract<SplitNode, { type: "split" }>;
    expect(root.direction).toBe("horizontal");
    expect(root.ratio).toBeCloseTo(0.5);
  });

  it("splitPane side=before 新窗格在左且复制当前标签会话", () => {
    const a = state().activePaneId;
    state().openInPane(a, "D:\\main", "newTab");
    const newId = state().splitPane(a, "horizontal", null, "before");
    expect(newId).not.toBeNull();
    const s = state();
    const root = s.tree as Extract<SplitNode, { type: "split" }>;
    expect((root.first as { type: string }).type).toBe("pane");
    expect((root.first as { paneId?: string }).paneId).toBe(newId!);
    expect((root.second as { paneId?: string }).paneId).toBe(a);
    expect(s.panes[newId!].tabs[0].path).toBe("D:\\main");
    expect(s.panes[newId!].tabs[0].openedPath).toBe("D:\\main");
  });
});

describe("持久化：项目切换 flush 竞态", () => {
  beforeEach(reset);

  it("flushPending 把待写编辑按旧键落盘；切换后写入走新键", async () => {
    // 项目 A：编辑后立即切走（防抖 600ms 未到）。
    state().hydrate({ tree: LAYOUT_PRESETS.single.build(), panes: [], activePaneId: "" }, "project:A");
    state().openInPane(state().activePaneId, "D:\\A\\only", "newTab");
    await state().flushPending(); // 项目切换前由面板层调用
    await __flushFilesWorkspaceWrites();
    expect(persistedNow().states["project:A"]?.panes[0]?.tabs[0]?.path).toBe("D:\\A\\only");

    // 切到项目 B：hydrate + 编辑 + flush。
    state().hydrate({ tree: LAYOUT_PRESETS.single.build(), panes: [], activePaneId: "" }, "project:B");
    state().openInPane(state().activePaneId, "D:\\B\\only", "newTab");
    await state().flushPending();
    await __flushFilesWorkspaceWrites();
    const states = persistedNow().states;
    expect(states["project:B"]?.panes[0]?.tabs[0]?.path).toBe("D:\\B\\only");
    // A 的数据不被 B 覆盖（键隔离）。
    expect(states["project:A"]?.panes[0]?.tabs[0]?.path).toBe("D:\\A\\only");
  });

  it("hydrate 前自动落盘待写状态（不依赖调用方记得 flush）", async () => {
    state().hydrate({ tree: LAYOUT_PRESETS.single.build(), panes: [], activePaneId: "" }, "project:A");
    state().openInPane(state().activePaneId, "D:\\A\\edit", "newTab");
    // 直接 hydrate 到 B（模拟快速切换，未显式 flush）——hydrate 内部先落盘 A。
    state().hydrate({ tree: LAYOUT_PRESETS.single.build(), panes: [], activePaneId: "" }, "project:B");
    await __flushFilesWorkspaceWrites();
    expect(persistedNow().states["project:A"]?.panes[0]?.tabs[0]?.path).toBe("D:\\A\\edit");
    expect(state().stateKey).toBe("project:B");
  });

  it("连续比例修改后快照保留最终比例", async () => {
    const a = state().activePaneId;
    state().openInPane(a, "D:\\seed", "newTab");
    const b = state().splitPane(a, "horizontal", null)!;
    const root0 = state().tree as Extract<SplitNode, { type: "split" }>;
    state().updateRatio(root0.id, 0.3);
    const root1 = state().tree as Extract<SplitNode, { type: "split" }>;
    state().updateRatio(root1.id, 0.7);
    state().updateRatio(root1.id, 0.5);
    await state().flushPending();
    await __flushFilesWorkspaceWrites();
    const savedTree = persistedNow().states["global"]?.tree as Extract<SplitNode, { type: "split" }>;
    expect(savedTree.ratio).toBeCloseTo(0.5);
    void b;
  });

  it("12 窗格上限边界：恢复后窗格数一致", async () => {
    state().hydrate({ tree: LAYOUT_PRESETS.single.build(), panes: [], activePaneId: "" }, "global");
    // 每个新窗格都会复制源窗格的活动标签，因此先给首个窗格放一个标签即可保证后续都有可复制标签。
    state().openInPane(state().activePaneId, "D:\\seed", "newTab");
    // 始终分割最浅层的窗格（树深 ≤6 是真实上限；只分割第一个窗格会先撞深度上限）。
    const shallowest = (): string => {
      const tree = state().tree;
      const ids = paneIds(tree);
      let best = ids[0];
      let bestLen = Number.POSITIVE_INFINITY;
      for (const id of ids) {
        const len = pathToPane(tree, id)?.length ?? 0;
        if (len < bestLen) {
          bestLen = len;
          best = id;
        }
      }
      return best;
    };
    for (let i = 0; i < 11; i += 1) {
      const made = state().splitPane(shallowest(), "horizontal", `D:\\p${i}`);
      expect(made).not.toBeNull();
    }
    expect(Object.keys(state().panes)).toHaveLength(12);
    // 第 13 个窗格被拒绝。
    const made13 = state().splitPane(shallowest(), "horizontal", "D:\\x");
    expect(made13).toBeNull();
    // 快照 → 恢复 → 窗格数一致。
    await state().flushPending();
    await __flushFilesWorkspaceWrites();
    const saved = persistedNow().states["global"];
    state().hydrate(saved!, "global");
    expect(Object.keys(state().panes)).toHaveLength(12);
  });
});

// ── openedPath / 标签标题 ───────────────────────────────────────────────

describe("openedPath 与标签标题", () => {
  beforeEach(reset);

  it("makeTab 初始化两路径相同；导航进子目录/返回/上级只改 path 不改 openedPath", () => {
    const paneId = state().activePaneId;
    state().openInPane(paneId, "D:\\proj", "newTab");
    let tab = state().panes[paneId].tabs[0];
    expect(tab.openedPath).toBe("D:\\proj");
    expect(tab.path).toBe("D:\\proj");

    state().openInPane(paneId, "D:\\proj\\sub", "replace");
    tab = state().panes[paneId].tabs[0];
    expect(tab.path).toBe("D:\\proj\\sub");
    expect(tab.openedPath).toBe("D:\\proj");

    state().navigate(paneId, "back");
    tab = state().panes[paneId].tabs[0];
    expect(tab.path).toBe("D:\\proj");
    expect(tab.openedPath).toBe("D:\\proj");

    state().navigate(paneId, "up");
    tab = state().panes[paneId].tabs[0];
    expect(tab.path).toBe("D:\\");
    expect(tab.openedPath).toBe("D:\\proj");
  });

  it("tabTitle 恒取 openedPath 名称（进入子目录后标题不变）", () => {
    const paneId = state().activePaneId;
    state().openInPane(paneId, "D:\\project-x", "newTab");
    expect(tabTitle(state().panes[paneId].tabs[0])).toBe("project-x");
    state().openInPane(paneId, "D:\\project-x\\a\\b", "replace");
    expect(tabTitle(state().panes[paneId].tabs[0])).toBe("project-x");
    // 兜底：openedPath 为空时退回 path。
    expect(tabTitle({ ...state().panes[paneId].tabs[0], openedPath: "", path: "D:\\fallback" })).toBe("fallback");
  });
});

// ── splitPane 复制标签会话 ──────────────────────────────────────────────

describe("splitPane 复制当前标签会话", () => {
  beforeEach(reset);

  it("多标签：新窗格只含复制的当前标签，原窗格全保留，会话字段复制且 history 独立", () => {
    const a = state().activePaneId;
    state().openInPane(a, "D:\\p\\one", "newTab");
    state().openInPane(a, "D:\\p\\two", "newTab");
    state().openInPane(a, "D:\\p\\two\\sub", "replace"); // 当前标签历史增长，openedPath 不变
    const srcId = state().panes[a].activeTabId!;
    state().patchTab(a, srcId, {
      viewMode: "grid",
      sortField: "size",
      sortAsc: false,
      search: "abc",
      filter: "image",
      showHidden: true,
    });
    const src = state().panes[a].tabs.find((t) => t.tabId === srcId)!;
    const originalIds = state().panes[a].tabs.map((t) => t.tabId);

    const newPane = state().splitPane(a, "horizontal", null)!;
    const s = state();
    // 原窗格完全不变。
    expect(s.panes[a].tabs.map((t) => t.tabId)).toEqual(originalIds);
    expect(s.panes[newPane].tabs).toHaveLength(1);
    const copy = s.panes[newPane].tabs[0];
    expect(copy.tabId).not.toBe(srcId);
    expect(s.panes[newPane].tabs.every((t) => !originalIds.includes(t.tabId))).toBe(true);
    expect(copy.openedPath).toBe(src.openedPath);
    expect(copy.path).toBe(src.path);
    expect(copy.history).toEqual(src.history);
    expect(copy.history).not.toBe(src.history); // 不共享引用
    expect(copy.viewMode).toBe("grid");
    expect(copy.sortField).toBe("size");
    expect(copy.sortAsc).toBe(false);
    expect(copy.search).toBe("abc");
    expect(copy.filter).toBe("image");
    expect(copy.showHidden).toBe(true);
    // 改动副本的 history 不影响源。
    copy.history.push("D:\\p\\two\\deep");
    expect(state().panes[a].tabs.find((t) => t.tabId === srcId)!.history).toEqual(src.history);

    // 撤销分割：复制标签随新窗格一起消失。
    expect(state().undoLayout()).toBe(true);
    const allIds = [
      ...Object.values(state().panes).flatMap((p) => p.tabs.map((t) => t.tabId)),
      ...state().stashed.map((t) => t.tabId),
    ];
    expect(allIds).not.toContain(copy.tabId);
  });

  it("无有效激活标签时返回 null，且不产生新窗格/历史", () => {
    const a = state().activePaneId;
    const treeBefore = state().tree;
    const historyBefore = state().layoutHistory.length;
    expect(state().splitPane(a, "horizontal", "D:\\ignored")).toBeNull();
    expect(state().tree).toBe(treeBefore);
    expect(state().layoutHistory).toHaveLength(historyBefore);
    expect(Object.keys(state().panes)).toHaveLength(1);

    // activeTabId 指向不存在的标签同样拒绝（直接注入脏状态，绕过 hydrate 的归一化修正）。
    state().openInPane(a, "D:\\a", "newTab");
    useFilesWorkspaceStore.setState((s) => ({
      panes: { ...s.panes, [a]: { ...s.panes[a], activeTabId: "ghost" } },
    }));
    expect(state().splitPane(a, "horizontal", null)).toBeNull();
    expect(paneIds(state().tree)).toHaveLength(1);
  });
});

// ── 关闭空窗格 ──────────────────────────────────────────────────────────

describe("关闭空窗格", () => {
  beforeEach(reset);

  function seedQuadWithEmpties(): string[] {
    const tree = LAYOUT_PRESETS.quad.build();
    const ids = paneIds(tree);
    state().hydrate(
      {
        tree,
        panes: [
          { paneId: ids[0], tabs: [{ tabId: "t0", path: "D:\\a" }], activeTabId: "t0" },
          { paneId: ids[1], tabs: [], activeTabId: null },
          { paneId: ids[2], tabs: [], activeTabId: null },
          { paneId: ids[3], tabs: [], activeTabId: null },
        ],
        activePaneId: ids[0],
      },
      "global",
    );
    return ids;
  }

  it("closeEmptyPane 只关空窗格；最后窗格与有标签窗格受保护", () => {
    const ids = seedQuadWithEmpties();
    expect(state().closeEmptyPane(ids[1])).toBe(true);
    expect(paneIds(state().tree)).toEqual([ids[0], ids[2], ids[3]]);
    expect(state().closeEmptyPane(ids[1])).toBe(false); // 已不存在
    expect(state().closeEmptyPane(ids[0])).toBe(false); // 非空

    // 最后一个窗格（即便空）不可关闭。
    reset();
    expect(state().closeEmptyPane(state().activePaneId)).toBe(false);
    expect(paneIds(state().tree)).toHaveLength(1);
  });

  it("closeAllEmptyPanes 批量关闭全部空窗格、至少留一个且不影响有标签窗格", () => {
    const ids = seedQuadWithEmpties();
    expect(state().closeAllEmptyPanes()).toBe(3);
    expect(paneIds(state().tree)).toEqual([ids[0]]);
    expect(state().panes[ids[0]].tabs).toHaveLength(1);
    expect(state().activePaneId).toBe(ids[0]);
    // 再次调用：无可关闭窗格。
    expect(state().closeAllEmptyPanes()).toBe(0);
  });

  it("全部为空时至少保留 activePaneId 对应窗格", () => {
    const tree = LAYOUT_PRESETS.leftRight.build();
    const ids = paneIds(tree);
    state().hydrate(
      {
        tree,
        panes: [
          { paneId: ids[0], tabs: [], activeTabId: null },
          { paneId: ids[1], tabs: [], activeTabId: null },
        ],
        activePaneId: ids[1],
      },
      "global",
    );
    expect(state().closeAllEmptyPanes()).toBe(1);
    expect(paneIds(state().tree)).toEqual([ids[1]]);
    expect(state().activePaneId).toBe(ids[1]);
  });

  it("closeAllEmptyPanes 单次 setState + 单次持久化 + 单条撤销", async () => {
    seedQuadWithEmpties();
    const historyBefore = state().layoutHistory.length;
    const spy = vi.spyOn(memSettings, "update");
    expect(state().closeAllEmptyPanes()).toBe(3);
    expect(state().layoutHistory).toHaveLength(historyBefore + 1);
    await state().flushPending();
    await __flushFilesWorkspaceWrites();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

// ── 目录重命名路径映射 ──────────────────────────────────────────────────

describe("remapTabPaths 路径映射", () => {
  beforeEach(reset);

  function seedPaths(): void {
    state().hydrate(
      {
        tree: LAYOUT_PRESETS.leftRight.build(),
        panes: [
          {
            paneId: "pane-a",
            tabs: [
              { tabId: "t1", path: "D:\\Projects\\A", openedPath: "D:\\Projects\\A", history: ["D:\\Projects\\A"] },
              {
                tabId: "t2",
                path: "D:\\Projects\\A\\sub",
                openedPath: "D:\\Projects\\A",
                history: ["D:\\Projects\\A", "D:\\Projects\\A\\sub"],
              },
              { tabId: "t3", path: "D:\\Projects\\AB", openedPath: "D:\\Projects\\AB", history: ["D:\\Projects\\AB"] },
            ],
            activeTabId: "t1",
          },
          {
            paneId: "pane-b",
            tabs: [
              {
                tabId: "t4",
                path: "d:\\projects\\a\\Child",
                openedPath: "D:\\Projects\\A",
                history: ["d:\\projects\\a", "d:\\projects\\a\\Child"],
              },
            ],
            activeTabId: "t4",
          },
        ],
        activePaneId: "pane-a",
        stashed: [
          {
            tabId: "t5",
            path: "D:\\Projects\\A\\stash",
            openedPath: "D:\\Projects\\A",
            history: ["D:\\Projects\\A", "D:\\Projects\\A\\stash"],
          },
        ],
      },
      "global",
    );
  }

  function findTab(tabId: string) {
    const all = [
      ...Object.values(state().panes).flatMap((p) => p.tabs),
      ...state().stashed,
    ];
    return all.find((t) => t.tabId === tabId)!;
  }

  it("精确匹配/子路径/大小写/多标签同步；相似前缀不误匹配；stashed 一并处理", () => {
    seedPaths();
    expect(state().remapTabPaths("D:\\Projects\\A", "D:\\New")).toBe(4); // t1/t2/t4/t5

    expect(findTab("t1").path).toBe("D:\\New");
    expect(findTab("t1").openedPath).toBe("D:\\New");
    expect(findTab("t1").history).toEqual(["D:\\New"]);

    expect(findTab("t2").path).toBe("D:\\New\\sub");
    expect(findTab("t2").openedPath).toBe("D:\\New");
    expect(findTab("t2").history).toEqual(["D:\\New", "D:\\New\\sub"]);

    // 相似前缀 D:\Projects\AB 完全不动。
    expect(findTab("t3").path).toBe("D:\\Projects\\AB");
    expect(findTab("t3").history).toEqual(["D:\\Projects\\AB"]);

    // 大小写不敏感 + 子路径后缀沿用原大小写。
    expect(findTab("t4").path).toBe("D:\\New\\Child");
    expect(findTab("t4").openedPath).toBe("D:\\New");
    expect(findTab("t4").history).toEqual(["D:\\New", "D:\\New\\Child"]);

    // stashed 标签同步。
    expect(findTab("t5").path).toBe("D:\\New\\stash");
    expect(findTab("t5").openedPath).toBe("D:\\New");

    // 幂等：再映射一次已无匹配项。
    expect(state().remapTabPaths("D:\\Projects\\A", "D:\\New")).toBe(0);
    expect(state().remapTabPaths("", "D:\\x")).toBe(0);
  });

  it("remapTabPathsBatch：一次更新多项，父子同时移动时子项优先不被父级覆盖", () => {
    const pane = state().activePaneId;
    state().openInPane(pane, "D:\\Root\\Parent\\Child", "newTab");
    const before = state().snapshot().stateData.panes[0].tabs[0];

    const affected = state().remapTabPathsBatch([
      { from: "D:\\Root\\Parent", to: "D:\\Moved\\Parent" },
      { from: "D:\\Root\\Parent\\Child", to: "D:\\Moved\\Child" },
    ]);

    const tab = state().snapshot().stateData.panes[0].tabs[0];
    // 子项自己的映射优先（按 from 长度降序），不会被父级映射二次改写。
    expect(tab.path).toBe("D:\\Moved\\Child");
    expect(tab.openedPath).toBe("D:\\Moved\\Child");
    expect(affected).toBe(1);
    expect(tab.tabId).toBe(before.tabId);
    // 空映射/重复 from 不产生额外影响。
    expect(state().remapTabPathsBatch([])).toBe(0);
    expect(state().remapTabPathsBatch([{ from: "", to: "D:\\x" }])).toBe(0);
  });
});

// ── 会话字段持久化与迁移 ────────────────────────────────────────────────

describe("会话字段持久化与迁移", () => {
  beforeEach(reset);

  it("snapshot 写入 openedPath/全部会话字段；hydrate round-trip 稳定", async () => {
    const a = state().activePaneId;
    state().openInPane(a, "D:\\sess", "newTab");
    state().openInPane(a, "D:\\sess\\sub", "replace");
    const id = state().panes[a].activeTabId!;
    state().patchTab(a, id, {
      viewMode: "grid",
      sortField: "type",
      sortAsc: false,
      search: "q",
      filter: "doc",
      showHidden: true,
    });
    await state().persistNow();
    await __flushFilesWorkspaceWrites();

    const saved = persistedNow().states.global!;
    const persistedTab = saved.panes[0].tabs[0];
    expect(persistedTab.openedPath).toBe("D:\\sess");
    expect(persistedTab.path).toBe("D:\\sess\\sub");
    expect(persistedTab.history).toEqual(["D:\\sess", "D:\\sess\\sub"]);
    expect(persistedTab.historyIndex).toBe(1);
    expect(persistedTab.viewMode).toBe("grid");
    expect(persistedTab.sortField).toBe("type");
    expect(persistedTab.sortAsc).toBe(false);
    expect(persistedTab.search).toBe("q");
    expect(persistedTab.filter).toBe("doc");
    expect(persistedTab.showHidden).toBe(true);

    // 模拟重启：重新 hydrate 后所有字段保持（round-trip 稳定）。
    state().hydrate(saved, "global");
    const restored = state().panes[state().activePaneId].tabs[0];
    expect(restored.openedPath).toBe("D:\\sess");
    expect(restored.path).toBe("D:\\sess\\sub");
    expect(restored.history).toEqual(["D:\\sess", "D:\\sess\\sub"]);
    expect(restored.historyIndex).toBe(1);
    expect(restored.viewMode).toBe("grid");
    expect(restored.sortField).toBe("type");
    expect(restored.sortAsc).toBe(false);
    expect(restored.search).toBe("q");
    expect(restored.filter).toBe("doc");
    expect(restored.showHidden).toBe(true);
  });

  it("旧数据缺 openedPath 用 path 兜底，history 收敛单条", () => {
    state().hydrate(
      {
        tree: LAYOUT_PRESETS.single.build(),
        panes: [{ paneId: "pane-1", tabs: [{ tabId: "legacy", path: "D:\\old" }], activeTabId: "legacy" }],
        activePaneId: "pane-1",
      },
      "global",
    );
    const tab = state().panes["pane-1"].tabs[0];
    expect(tab.openedPath).toBe("D:\\old");
    expect(tab.path).toBe("D:\\old");
    expect(tab.history).toEqual(["D:\\old"]);
    expect(tab.historyIndex).toBe(0);
  });

  it("多窗格 + stashed + 模板恢复均保留会话字段与历史", () => {
    const tree = LAYOUT_PRESETS.leftRight.build();
    const sessionTab = {
      tabId: "ta",
      path: "D:\\t\\sub",
      openedPath: "D:\\t",
      history: ["D:\\t", "D:\\t\\sub"],
      historyIndex: 1,
      viewMode: "grid" as const,
      sortField: "size" as const,
      sortAsc: false,
      search: "s",
      filter: "code" as const,
      showHidden: true,
    };
    // hydrate：多窗格 + stashed（tabId 必须唯一，重复的会被去重丢弃）。
    const stashedTabSource = { ...sessionTab, tabId: "ts" };
    state().hydrate(
      {
        tree,
        panes: [
          { paneId: "pane-a", tabs: [sessionTab], activeTabId: "ta" },
          { paneId: "pane-b", tabs: [], activeTabId: null },
        ],
        activePaneId: "pane-a",
        stashed: [stashedTabSource],
      },
      "global",
    );
    const hydrated = Object.values(state().panes).flatMap((p) => p.tabs).find((t) => t.tabId === "ta")!;
    const stashedTab = state().stashed.find((t) => t.tabId === "ts")!;
    expect(hydrated.history).toEqual(["D:\\t", "D:\\t\\sub"]);
    expect(hydrated.openedPath).toBe("D:\\t");
    expect(stashedTab.viewMode).toBe("grid");
    expect(stashedTab.historyIndex).toBe(1);
    expect(stashedTab.history).toEqual(["D:\\t", "D:\\t\\sub"]);

    // applyTemplate：复用同一恢复逻辑，不丢会话。
    reset();
    state().applyTemplate("tpl-x", [
      {
        id: "tpl-x",
        tree,
        panes: [
          { paneId: "pane-a", tabs: [sessionTab], activeTabId: "ta" },
          { paneId: "pane-b", tabs: [], activeTabId: null },
        ],
      },
    ]);
    const fromTemplate = Object.values(state().panes).flatMap((p) => p.tabs)[0];
    expect(fromTemplate.openedPath).toBe("D:\\t");
    expect(fromTemplate.path).toBe("D:\\t\\sub");
    expect(fromTemplate.history).toEqual(["D:\\t", "D:\\t\\sub"]);
    expect(fromTemplate.historyIndex).toBe(1);
    expect(fromTemplate.viewMode).toBe("grid");
    expect(fromTemplate.sortField).toBe("size");
    expect(fromTemplate.search).toBe("s");
    expect(fromTemplate.filter).toBe("code");
    expect(fromTemplate.showHidden).toBe(true);
  });

  it("historyIndex 越界被钳制到界内", () => {
    state().hydrate(
      {
        tree: LAYOUT_PRESETS.single.build(),
        panes: [{
          paneId: "pane-1",
          tabs: [{ tabId: "t", path: "D:\\z", history: ["D:\\z", "D:\\z\\b"], historyIndex: 99 }],
          activeTabId: "t",
        }],
        activePaneId: "pane-1",
      },
      "global",
    );
    const tab = state().panes["pane-1"].tabs[0];
    expect(tab.historyIndex).toBe(1);
    expect(tab.path).toBe("D:\\z\\b");
  });
});

// ── applyTemplate 结果契约 / 最近模板 / 模板容量 ─────────────────────────

/** 左右双栏模板（pane-a / pane-b）；id 与 tabId 均按模板 id 派生，便于断言。 */
function makeTemplate(id: string) {
  return {
    id,
    tree: LAYOUT_PRESETS.leftRight.build(),
    panes: [
      {
        paneId: "pane-a",
        tabs: [{ tabId: `${id}-a`, path: `D:\\${id}\\a` }],
        activeTabId: `${id}-a`,
      },
      {
        paneId: "pane-b",
        tabs: [{ tabId: `${id}-b`, path: `D:\\${id}\\b` }],
        activeTabId: `${id}-b`,
      },
    ],
  };
}

/** 往设置里预置模板（经 normalizePersisted 校验必须合法）。 */
function seedTemplates(count: number): void {
  memSettings.settings[FILE_WORKSPACE_SETTING_KEY] = {
    version: 1,
    states: {},
    templates: Array.from({ length: count }, (_, i) => ({
      id: `old-${i}`,
      name: `Old ${i}`,
      tree: LAYOUT_PRESETS.single.build(),
      panes: [],
    })),
    recentTemplates: [],
  };
}

describe("applyTemplate 结果契约", () => {
  beforeEach(reset);

  it("模板缺失：返回 missing，不改状态、不记历史、不写设置", async () => {
    const beforeTree = state().tree;
    const result = await state().applyTemplate("ghost", []);
    expect(result).toEqual({ ok: false, reason: "missing" });
    expect(state().tree).toBe(beforeTree);
    expect(state().layoutHistory).toHaveLength(0);
    expect(memSettings.settings[FILE_WORKSPACE_SETTING_KEY]).toBeUndefined();
  });

  it("内存应用成功后显式落盘，返回 ok 并写入最近模板（置顶去重）", async () => {
    const resultA = await state().applyTemplate("tpl-a", [makeTemplate("tpl-a")]);
    expect(resultA).toEqual({ ok: true, templateId: "tpl-a" });
    // 应用结果已落盘（无需等待 600ms 防抖）。
    expect(persistedNow().states.global?.panes.flatMap((p) => p.tabs.map((t) => t.path)).sort()).toEqual([
      "D:\\tpl-a\\a",
      "D:\\tpl-a\\b",
    ]);
    expect(persistedNow().recentTemplates).toEqual(["tpl-a"]);

    await state().applyTemplate("tpl-b", [makeTemplate("tpl-a"), makeTemplate("tpl-b")]);
    expect(state().recentTemplates).toEqual(["tpl-b", "tpl-a"]);
    expect(persistedNow().recentTemplates).toEqual(["tpl-b", "tpl-a"]);

    // 重复应用：置顶而非重复（去重）。
    await state().applyTemplate("tpl-a", [makeTemplate("tpl-a"), makeTemplate("tpl-b")]);
    expect(state().recentTemplates).toEqual(["tpl-a", "tpl-b"]);
    expect(persistedNow().recentTemplates).toEqual(["tpl-a", "tpl-b"]);
  });

  it("最近模板截断到 MAX_RECENT（最旧被淘汰）", async () => {
    const templates = Array.from({ length: MAX_RECENT + 1 }, (_, i) => makeTemplate(`t-${i}`));
    for (const template of templates) {
      const result = await state().applyTemplate(template.id, templates);
      expect(result.ok).toBe(true);
    }
    expect(state().recentTemplates).toHaveLength(MAX_RECENT);
    expect(state().recentTemplates[0]).toBe(`t-${MAX_RECENT}`);
    expect(state().recentTemplates).not.toContain("t-0");
    expect(persistedNow().recentTemplates).toEqual(state().recentTemplates);
  });

  it("重启后 hydrate 从设置恢复最近模板顺序", async () => {
    await state().applyTemplate("tpl-a", [makeTemplate("tpl-a")]);
    await state().applyTemplate("tpl-b", [makeTemplate("tpl-b")]);
    const persisted = persistedNow();
    expect(persisted.recentTemplates).toEqual(["tpl-b", "tpl-a"]);
    // 模拟重启：设置尚未加载时不清空内存值之外的任何状态（此处为新会话，为空）。
    memSettings.settings = {};
    state().hydrate({ tree: LAYOUT_PRESETS.single.build(), panes: [], activePaneId: "" }, "global");
    expect(state().recentTemplates).toEqual([]);
    // 设置加载后再 hydrate：最近模板顺序从持久化恢复。
    memSettings.settings = { [FILE_WORKSPACE_SETTING_KEY]: persisted };
    state().hydrate(persisted.states.global!, "global");
    expect(state().recentTemplates).toEqual(["tpl-b", "tpl-a"]);
  });

  it("持久化失败：返回 persist-failed 且保留已应用的内存布局", async () => {
    const originalUpdate = memSettings.update;
    memSettings.update = async () => {
      throw new Error("disk-full");
    };
    try {
      const result = await state().applyTemplate("tpl-a", [makeTemplate("tpl-a")]);
      expect(result).toEqual({ ok: false, reason: "persist-failed", error: "disk-full" });
      // 不回滚：内存布局已应用，最近模板顺序也保留。
      const paths = Object.values(state().panes)
        .flatMap((p) => p.tabs.map((t) => t.path))
        .sort();
      expect(paths).toEqual(["D:\\tpl-a\\a", "D:\\tpl-a\\b"]);
      expect(state().recentTemplates).toEqual(["tpl-a"]);
      expect(state().persistError).toBe("disk-full");
    } finally {
      memSettings.update = originalUpdate;
    }
  });
});

describe("saveCurrentAsTemplate 容量上限", () => {
  beforeEach(reset);

  it("19 → 20：新模板追加在末尾，既有模板保留", async () => {
    state().openInPane(state().activePaneId, "D:\\saving", "newTab");
    seedTemplates(MAX_TEMPLATES - 1);
    const template = await state().saveCurrentAsTemplate(" 新模板 ");
    const saved = persistedNow().templates;
    expect(saved).toHaveLength(MAX_TEMPLATES);
    expect(saved[0].id).toBe("old-0");
    expect(saved[MAX_TEMPLATES - 1].id).toBe(template.id);
    expect(saved[MAX_TEMPLATES - 1].name).toBe("新模板");
  });

  it("20 → 20：移除最旧（数组头部），新模板仍在末尾", async () => {
    state().openInPane(state().activePaneId, "D:\\saving", "newTab");
    seedTemplates(MAX_TEMPLATES);
    const template = await state().saveCurrentAsTemplate("再存一个");
    const saved = persistedNow().templates;
    expect(saved).toHaveLength(MAX_TEMPLATES);
    expect(saved.map((t) => t.id)).not.toContain("old-0");
    expect(saved[0].id).toBe("old-1");
    expect(saved[MAX_TEMPLATES - 1].id).toBe(template.id);
    // 新模板内容是刚保存的当前布局（单窗格 + 标签）。
    expect(saved[MAX_TEMPLATES - 1].panes[0].tabs[0].path).toBe("D:\\saving");
  });
});
