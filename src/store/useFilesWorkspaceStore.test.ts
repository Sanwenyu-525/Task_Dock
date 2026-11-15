//! 文件工作区 store 单测：hydrate、分栏、标签移动、导航历史、选择、
//! 持久化恢复（激活标签/模板映射/项目切换 flush/窗格上限）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LAYOUT_PRESETS, paneIds, pathToPane, type SplitNode } from "../lib/filesWorkspace/model";
import { setFwClipboard, getFwClipboard } from "../lib/filesWorkspace/interactions";
import {
  bindSettingsStore,
  FILE_WORKSPACE_SETTING_KEY,
  __flushFilesWorkspaceWrites,
  type FilesWorkspacePersisted,
} from "../lib/filesWorkspace/persist";
import { useFilesWorkspaceStore } from "./useFilesWorkspaceStore";

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
  const tree = LAYOUT_PRESETS.single.build();
  state().hydrate({ tree, panes: [], activePaneId: "" }, "global");
  memSettings.settings = {};
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

  it("splitPane side=before 新窗格在左且打开指定路径", () => {
    const a = state().activePaneId;
    state().openInPane(a, "D:\\main", "newTab");
    const newId = state().splitPane(a, "horizontal", "D:\\left-side", "before");
    expect(newId).not.toBeNull();
    const s = state();
    const root = s.tree as Extract<SplitNode, { type: "split" }>;
    expect((root.first as { type: string }).type).toBe("pane");
    expect((root.first as { paneId?: string }).paneId).toBe(newId!);
    expect((root.second as { paneId?: string }).paneId).toBe(a);
    expect(s.panes[newId!].tabs[0].path).toBe("D:\\left-side");
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
