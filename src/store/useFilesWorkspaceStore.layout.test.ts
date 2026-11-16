//! 第三轮 P0 回归：目录会话与布局解耦。
//!
//! 核心断言（本文件所有布局用例共用）：
//! **任何非显式关闭标签的布局操作，执行前后的全部目录标签 ID 集合必须一致。**
//! 目录属于用户的工作内容，布局只是内容的组织方式。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LAYOUT_PRESETS, MAX_TABS_PER_PANE, paneIds, type SplitNode } from "../lib/filesWorkspace/model";
import {
  bindSettingsStore,
  FILE_WORKSPACE_SETTING_KEY,
  __flushFilesWorkspaceWrites,
  type FilesWorkspacePersisted,
} from "../lib/filesWorkspace/persist";
import { normalizePath } from "../lib/filesWorkspace/pathUtils";
import { useFilesWorkspaceStore } from "./useFilesWorkspaceStore";

const memSettings: { settings: Record<string, unknown>; update: (patch: Record<string, unknown>) => Promise<void> } = {
  settings: {},
  async update(patch) {
    Object.assign(memSettings.settings, patch);
  },
};
bindSettingsStore(() => memSettings);

function state() {
  return useFilesWorkspaceStore.getState();
}

function persistedNow(): FilesWorkspacePersisted {
  return (memSettings.settings[FILE_WORKSPACE_SETTING_KEY] ?? {
    version: 1,
    states: {},
    templates: [],
    recentTemplates: [],
  }) as FilesWorkspacePersisted;
}

/** 全部「已打开」的标签 ID（含收纳），布局操作前后必须一致。 */
function tabIdSet(): Set<string> {
  const s = state();
  const ids = new Set<string>();
  for (const paneId of paneIds(s.tree)) {
    for (const tab of s.panes[paneId]?.tabs ?? []) ids.add(tab.tabId);
  }
  for (const tab of s.stashed) ids.add(tab.tabId);
  return ids;
}

function sortedIds(set: Set<string>): string[] {
  return [...set].sort();
}

/** 以指定布局与每窗格标签数注入状态（tabId 稳定为 tab-<pane>-<n>）。 */
function seedLayout(
  tree: SplitNode,
  layout: Array<{ path: string; extra?: number }>,
  options: { activePaneIndex?: number } = {},
): string[] {
  const ids = paneIds(tree);
  const panes = ids.map((paneId, index) => {
    const item = layout[index];
    if (!item || !item.path) return { paneId, tabs: [], activeTabId: null };
    const tabs = [
      { tabId: `tab-${index}-0`, path: normalizePath(item.path) },
      ...Array.from({ length: item.extra ?? 0 }, (_, n) => ({
        tabId: `tab-${index}-${n + 1}`,
        path: normalizePath(`${item.path}\\sub${n + 1}`),
      })),
    ];
    return { paneId, tabs, activeTabId: tabs[0].tabId };
  });
  state().hydrate({ tree, panes, activePaneId: ids[options.activePaneIndex ?? 0] }, "global");
  return ids;
}

function seedQuad(): string[] {
  return seedLayout(LAYOUT_PRESETS.quad.build(), [
    { path: "D:\\src" },
    { path: "D:\\art" },
    { path: "D:\\docs" },
    { path: "D:\\build" },
  ]);
}

function reset(): void {
  state().hydrate({ tree: LAYOUT_PRESETS.single.build(), panes: [], activePaneId: "" }, "global");
  memSettings.settings = {};
}

afterEach(async () => {
  await state().flushPending();
  await __flushFilesWorkspaceWrites();
});

beforeEach(reset);

describe("P0 布局转换保留目录会话", () => {
  it("四宫格 → 左右双栏：A/B 左、C/D 右，标签 ID 集合不变", () => {
    seedQuad();
    const before = tabIdSet();
    expect(sortedIds(before)).toEqual(["tab-0-0", "tab-1-0", "tab-2-0", "tab-3-0"]);
    const result = state().applyLayoutPresetPreservingTabs("leftRight");
    expect(result.ok).toBe(true);
    const ids = paneIds(state().tree);
    expect(ids).toHaveLength(2);
    expect(state().panes[ids[0]].tabs.map((t) => t.path)).toEqual(["D:\\src", "D:\\art"]);
    expect(state().panes[ids[1]].tabs.map((t) => t.path)).toEqual(["D:\\docs", "D:\\build"]);
    expect(sortedIds(tabIdSet())).toEqual(sortedIds(before));
  });

  it("左右双栏 → 上下双栏 → 单栏 → 四宫格：四轮转换标签集合始终不变", () => {
    seedQuad();
    const before = sortedIds(tabIdSet());
    for (const preset of ["leftRight", "topBottom", "single", "quad"] as const) {
      const result = state().applyLayoutPresetPreservingTabs(preset);
      expect(result.ok, preset).toBe(true);
      expect(sortedIds(tabIdSet()), `preset=${preset}`).toEqual(before);
    }
    // 回到四宫格：单栏 4 个目录按标签铺开，每格一个，顺序与展平顺序一致。
    const ids = paneIds(state().tree);
    expect(ids).toHaveLength(4);
    expect(state().panes[ids[0]].tabs.map((t) => t.path)).toEqual(["D:\\src"]);
    expect(state().panes[ids[1]].tabs.map((t) => t.path)).toEqual(["D:\\art"]);
    expect(state().panes[ids[2]].tabs.map((t) => t.path)).toEqual(["D:\\docs"]);
    expect(state().panes[ids[3]].tabs.map((t) => t.path)).toEqual(["D:\\build"]);
  });

  it("单栏 4 个标签 → 四宫格：每格一个目录（区域变多时按标签铺开）", () => {
    const ids = seedLayout(LAYOUT_PRESETS.single.build(), [
      { path: "D:\\src", extra: 3 },
    ]);
    expect(state().panes[ids[0]].tabs).toHaveLength(4);
    const before = sortedIds(tabIdSet());
    expect(state().applyLayoutPresetPreservingTabs("quad").ok).toBe(true);
    expect(sortedIds(tabIdSet())).toEqual(before);
    expect(paneIds(state().tree).map((id) => state().panes[id].tabs.length)).toEqual([1, 1, 1, 1]);
  });

  it("多标签混合分配：3+1+1+1 变成 4/2", () => {
    seedLayout(LAYOUT_PRESETS.quad.build(), [
      { path: "D:\\src", extra: 2 },
      { path: "D:\\art" },
      { path: "D:\\docs" },
      { path: "D:\\build" },
    ]);
    const before = sortedIds(tabIdSet());
    expect(state().applyLayoutPresetPreservingTabs("leftRight").ok).toBe(true);
    const ids = paneIds(state().tree);
    expect(state().panes[ids[0]].tabs).toHaveLength(4);
    expect(state().panes[ids[1]].tabs).toHaveLength(2);
    expect(sortedIds(tabIdSet())).toEqual(before);
  });

  it("激活标签保留：切换布局后活动区域与激活标签跟随原激活目录", () => {
    const ids = seedQuad();
    state().setActivePane(ids[2]);
    const activeTabId = state().panes[ids[2]].activeTabId!;
    expect(state().applyLayoutPresetPreservingTabs("leftRight").ok).toBe(true);
    const after = paneIds(state().tree);
    const activePane = state().activePaneId;
    expect(after).toContain(activePane);
    expect(state().panes[activePane].activeTabId).toBe(activeTabId);
    expect(state().panes[activePane].tabs.some((t) => t.tabId === activeTabId)).toBe(true);
  });

  it("分栏比例：目标预设比例生效，标签集合不变", () => {
    seedQuad();
    const before = sortedIds(tabIdSet());
    expect(state().applyLayoutPresetPreservingTabs("threeLeft").ok).toBe(true);
    const root = state().tree;
    expect(root.type).toBe("split");
    if (root.type === "split") expect(root.ratio).toBeCloseTo(0.34, 3);
    expect(sortedIds(tabIdSet())).toEqual(before);
  });

  it("同一预设重复点击：视为同形，不重建树（窗格 ID 不变）", () => {
    seedQuad();
    const idsBefore = paneIds(state().tree);
    const result = state().applyLayoutPresetPreservingTabs("quad");
    expect(result).toMatchObject({ ok: true, unchanged: true });
    expect(paneIds(state().tree)).toEqual(idsBefore);
    expect(state().layoutHistory).toHaveLength(0);
  });

  it("容量上限：四宫格 16 个标签 → 单栏，超出 12 的进入可恢复收纳而不是被丢弃", () => {
    seedLayout(LAYOUT_PRESETS.quad.build(), [
      { path: "D:\\a", extra: 3 },
      { path: "D:\\b", extra: 3 },
      { path: "D:\\c", extra: 3 },
      { path: "D:\\d", extra: 3 },
    ]);
    const before = sortedIds(tabIdSet());
    const result = state().applyLayoutPresetPreservingTabs("single");
    expect(result).toMatchObject({ ok: true, stashedCount: 4 });
    expect(state().panes[paneIds(state().tree)[0]].tabs).toHaveLength(MAX_TABS_PER_PANE);
    expect(state().stashed).toHaveLength(4);
    expect(sortedIds(tabIdSet())).toEqual(before);
  });

  it("容量上限：48 标签四宫格 ↔ 单栏往返，收纳标签在扩容时自动放回", () => {
    seedLayout(LAYOUT_PRESETS.quad.build(), [
      { path: "D:\\a", extra: 11 },
      { path: "D:\\b", extra: 11 },
      { path: "D:\\c", extra: 11 },
      { path: "D:\\d", extra: 11 },
    ]);
    // 48 个标签 → 单区域 12 + 收纳上限 64：第一轮收纳 36 个（≤64），可成功。
    expect(state().applyLayoutPresetPreservingTabs("single").ok).toBe(true);
    // 再切回四宫格会把 36 个收纳标签释放；反复切换不会丢标签。
    expect(state().applyLayoutPresetPreservingTabs("quad").ok).toBe(true);
    expect(state().stashed).toHaveLength(0);
    expect(tabIdSet().size).toBe(48);
  });

  it("容量上限：收纳容量不足时阻止本次布局转换（状态与标签集合完全不变）", () => {
    // 12 个区域各 12 个标签（144）→ 单区域 12 + 收纳 132 > 64：必须阻止而不是截断。
    const paneIdList = Array.from({ length: 12 }, (_, i) => `pane-${i}`);
    const tree = (function build(ids: string[]): SplitNode {
      if (ids.length === 1) return { type: "pane", paneId: ids[0] };
      const mid = Math.floor(ids.length / 2);
      return {
        type: "split",
        id: `split-${ids.length}`,
        direction: "horizontal",
        ratio: 0.5,
        first: build(ids.slice(0, mid)),
        second: build(ids.slice(mid)),
      };
    })(paneIdList);
    const panes = paneIdList.map((paneId, index) => ({
      paneId,
      tabs: Array.from({ length: MAX_TABS_PER_PANE }, (_, n) => ({
        tabId: `wide-${index}-${n}`,
        path: `D:\\wide${index}\\sub${n}`,
      })),
      activeTabId: `wide-${index}-0`,
    }));
    state().hydrate({ tree, panes, activePaneId: paneIdList[0] }, "global");
    const before = sortedIds(tabIdSet());
    const beforeTree = state().tree;
    const result = state().applyLayoutPresetPreservingTabs("single");
    expect(result).toMatchObject({ ok: false, reason: "capacity", tabCount: 144 });
    expect(state().tree).toEqual(beforeTree);
    expect(sortedIds(tabIdSet())).toEqual(before);
  });
});

  it("撤销 / 重做跨「单栏收纳」：标签不重复、不丢失", () => {
    seedLayout(LAYOUT_PRESETS.quad.build(), [
      { path: "D:\\a", extra: 3 },
      { path: "D:\\b", extra: 3 },
      { path: "D:\\c", extra: 3 },
      { path: "D:\\d", extra: 3 },
    ]);
    const before = sortedIds(tabIdSet());
    expect(state().applyLayoutPresetPreservingTabs("single").ok).toBe(true);
    expect(state().stashed).toHaveLength(4);
    expect(state().undoLayout()).toBe(true);
    expect(state().redoLayout()).toBe(true);
    // 重做回到单栏 + 4 个收纳；全部 16 个标签 ID 唯一且齐全（不因收纳快照重复安置）。
    const all = [
      ...paneIds(state().tree).flatMap((id) => state().panes[id].tabs.map((t) => t.tabId)),
      ...state().stashed.map((t) => t.tabId),
    ];
    expect(all).toHaveLength(16);
    expect(sortedIds(new Set(all))).toEqual(before);
  });

describe("P0 关闭区域不静默丢标签", () => {
  it("空区域直接关闭", () => {
    const ids = seedLayout(LAYOUT_PRESETS.leftRight.build(), [{ path: "D:\\a" }, { path: "" }]);
    const before = sortedIds(tabIdSet());
    const result = state().closePane(ids[1]);
    expect(result.status).toBe("closed");
    expect(paneIds(state().tree)).toEqual([ids[0]]);
    expect(sortedIds(tabIdSet())).toEqual(before);
  });

  it("非空区域：默认把标签转移到相邻区域", () => {
    const ids = seedLayout(LAYOUT_PRESETS.leftRight.build(), [
      { path: "D:\\a" },
      { path: "D:\\b", extra: 2 },
    ]);
    const before = sortedIds(tabIdSet());
    const result = state().closePane(ids[1]);
    expect(result).toMatchObject({ status: "closed", movedTabs: 3, stashedTabs: 0, discardedTabs: 0 });
    expect(paneIds(state().tree)).toEqual([ids[0]]);
    expect(state().panes[ids[0]].tabs).toHaveLength(4);
    expect(sortedIds(tabIdSet())).toEqual(before);
  });

  it("容量不足：阻止关闭并返回待安置标签（不得静默丢弃）", () => {
    const ids = seedLayout(LAYOUT_PRESETS.leftRight.build(), [
      { path: "D:\\a", extra: 10 },
      { path: "D:\\b", extra: 3 },
    ]);
    expect(state().panes[ids[0]].tabs).toHaveLength(11);
    const before = sortedIds(tabIdSet());
    const result = state().closePane(ids[1]);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toBe("capacity");
      expect(result.tabs).toHaveLength(3); // 11 + 4 → 12 容量，剩 3 个装不下
    }
    // 阻止时状态完全不变。
    expect(paneIds(state().tree)).toEqual(ids);
    expect(sortedIds(tabIdSet())).toEqual(before);
  });

  it("容量不足时选择收纳：装不下的进入收纳并关闭区域", () => {
    const ids = seedLayout(LAYOUT_PRESETS.leftRight.build(), [
      { path: "D:\\a", extra: 10 },
      { path: "D:\\b", extra: 3 },
    ]);
    const before = sortedIds(tabIdSet());
    const result = state().closePane(ids[1], { mode: "stash" });
    expect(result).toMatchObject({ status: "closed", stashedTabs: 3 });
    expect(state().stashed).toHaveLength(3);
    expect(sortedIds(tabIdSet())).toEqual(before);
  });

  it("显式关闭标签（discard）：明确丢弃并关闭区域", () => {
    const ids = seedLayout(LAYOUT_PRESETS.leftRight.build(), [
      { path: "D:\\a" },
      { path: "D:\\b", extra: 2 },
    ]);
    const before = sortedIds(tabIdSet());
    const result = state().closePane(ids[1], { mode: "discard" });
    expect(result).toMatchObject({ status: "closed", discardedTabs: 3 });
    expect(sortedIds(tabIdSet()).length).toBe(before.length - 3);
  });

  it("最后一个区域不可关闭（否则布局无归宿）", () => {
    const ids = seedLayout(LAYOUT_PRESETS.single.build(), [{ path: "D:\\a" }]);
    const result = state().closePane(ids[0]);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(result.reason).toBe("lastPane");
  });

  it("关闭其他区域：标签合并进保留区域", () => {
    seedQuad();
    const ids = paneIds(state().tree);
    const before = sortedIds(tabIdSet());
    const result = state().closeOtherPanes(ids[0]);
    expect(result).toMatchObject({ status: "closed", movedTabs: 3 });
    expect(paneIds(state().tree)).toEqual([ids[0]]);
    expect(state().panes[ids[0]].tabs).toHaveLength(4);
    expect(sortedIds(tabIdSet())).toEqual(before);
  });
});

describe("P1 布局撤销 / 重做", () => {
  it("分割 → 撤销 → 重做", () => {
    const ids = seedLayout(LAYOUT_PRESETS.single.build(), [{ path: "D:\\a" }]);
    expect(state().layoutHistory).toHaveLength(0);
    const newPane = state().splitPane(ids[0], "horizontal");
    expect(newPane).not.toBeNull();
    expect(paneIds(state().tree)).toHaveLength(2);
    expect(state().undoLayout()).toBe(true);
    expect(paneIds(state().tree)).toHaveLength(1);
    expect(sortedIds(tabIdSet())).toEqual(["tab-0-0"]);
    expect(state().redoLayout()).toBe(true);
    expect(paneIds(state().tree)).toHaveLength(2);
    // 重做恢复「分割时复制出的新标签」：布局与标签分配一起回来，不是只剩空窗格。
    const restoredPane = paneIds(state().tree)[1];
    expect(state().panes[restoredPane].tabs).toHaveLength(1);
    expect(state().panes[restoredPane].tabs[0].path).toBe("D:\\a");
    expect(sortedIds(tabIdSet())).toHaveLength(2);
  });

  it("关闭区域 → 撤销恢复标签与区域", () => {
    const ids = seedQuad();
    const before = sortedIds(tabIdSet());
    state().closePane(ids[1]);
    expect(paneIds(state().tree)).toHaveLength(3);
    expect(state().undoLayout()).toBe(true);
    expect(paneIds(state().tree)).toHaveLength(4);
    expect(state().panes[ids[1]].tabs.map((t) => t.path)).toEqual(["D:\\art"]);
    expect(sortedIds(tabIdSet())).toEqual(before);
  });

  it("交换位置 → 撤销", () => {
    const ids = seedQuad();
    expect(state().swapPanes(ids[0], ids[3])).toBe(true);
    expect(paneIds(state().tree)[0]).toBe(ids[3]);
    expect(state().undoLayout()).toBe(true);
    expect(paneIds(state().tree)).toEqual(ids);
  });

  it("比例调整：一次拖动只产生一条历史（撤销回到拖动前）", () => {
    seedLayout(LAYOUT_PRESETS.leftRight.build(), [{ path: "D:\\a" }, { path: "D:\\b" }]);
    const root = state().tree;
    if (root.type !== "split") throw new Error("expect split");
    const splitId = root.id;
    state().updateRatio(splitId, 0.3);
    state().updateRatio(splitId, 0.7);
    expect(state().layoutHistory).toHaveLength(1);
    expect(state().undoLayout()).toBe(true);
    const after = state().tree;
    if (after.type !== "split") throw new Error("expect split");
    expect(after.ratio).toBeCloseTo(0.5, 3);
  });

  it("指针拖动事务：多帧预览只形成一条撤销，取消则完全回滚", () => {
    seedLayout(LAYOUT_PRESETS.leftRight.build(), [{ path: "D:\\a" }, { path: "D:\\b" }]);
    const root = state().tree;
    if (root.type !== "split") throw new Error("expect split");
    const splitId = root.id;

    state().beginRatioResize(splitId);
    state().previewRatio(splitId, 0.3);
    state().previewRatio(splitId, 0.34);
    state().previewRatio(splitId, 0.42);
    state().commitRatioResize();
    expect(state().layoutHistory).toHaveLength(1);
    state().undoLayout();
    let after = state().tree;
    if (after.type !== "split") throw new Error("expect split");
    expect(after.ratio).toBeCloseTo(0.5, 3);

    state().beginRatioResize(splitId);
    state().previewRatio(splitId, 0.2);
    expect((state().tree as { ratio: number }).ratio).toBeCloseTo(0.2, 3);
    state().cancelRatioResize();
    after = state().tree;
    if (after.type !== "split") throw new Error("expect split");
    expect(after.ratio).toBeCloseTo(0.5, 3);
    expect(state().layoutHistory).toHaveLength(0);
  });

  it("标签跨区域移动 → 撤销回到原区域", () => {
    const ids = seedLayout(LAYOUT_PRESETS.leftRight.build(), [
      { path: "D:\\a", extra: 1 },
      { path: "D:\\b" },
    ]);
    const tabId = state().panes[ids[0]].tabs[1].tabId;
    state().moveTabToPane(tabId, ids[0], ids[1]);
    expect(state().panes[ids[1]].tabs.some((t) => t.tabId === tabId)).toBe(true);
    expect(state().undoLayout()).toBe(true);
    expect(state().panes[ids[0]].tabs.some((t) => t.tabId === tabId)).toBe(true);
    expect(sortedIds(tabIdSet())).toEqual(["tab-0-0", "tab-0-1", "tab-1-0"]);
  });

  it("更换布局预设 → 撤销恢复原布局与标签分配", () => {
    const ids = seedQuad();
    expect(state().applyLayoutPresetPreservingTabs("leftRight").ok).toBe(true);
    expect(paneIds(state().tree)).toHaveLength(2);
    expect(state().undoLayout()).toBe(true);
    expect(paneIds(state().tree)).toEqual(ids);
    expect(state().panes[ids[0]].tabs.map((t) => t.path)).toEqual(["D:\\src"]);
  });

  it("撤销栈有上限（20），且撤销后打开的目录不会因撤销而消失", () => {
    const ids = seedLayout(LAYOUT_PRESETS.leftRight.build(), [{ path: "D:\\a" }, { path: "D:\\b" }]);
    for (let i = 0; i < 30; i += 1) {
      state().splitPane(state().activePaneId, i % 2 === 0 ? "horizontal" : "vertical");
      if (paneIds(state().tree).length > 6) {
        // 控制区域数量，避免无意义膨胀。
        const last = paneIds(state().tree).at(-1)!;
        state().closePane(last);
      }
    }
    expect(state().layoutHistory.length).toBeLessThanOrEqual(20);
    // 撤销前打开的目录（历史里没有）必须在撤销后仍然存在（进入收纳或某区域）。
    const active = state().activePaneId;
    state().openInPane(active, "D:\\late", "newTab");
    const lateId = state().panes[active].tabs.at(-1)!.tabId;
    state().undoLayout();
    expect(tabIdSet().has(lateId)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("布局历史不记录文件系统操作：打开/切换目录不产生撤销步骤", () => {
    seedLayout(LAYOUT_PRESETS.quad.build(), [
      { path: "D:\\a" },
      { path: "D:\\b" },
      { path: "D:\\c" },
      { path: "D:\\d" },
    ]);
    expect(state().layoutHistory).toHaveLength(0);
    state().openInPane(state().activePaneId, "D:\\a2", "newTab");
    state().navigate(state().activePaneId, "up");
    expect(state().layoutHistory).toHaveLength(0);
    expect(state().undoLayout()).toBe(false);
  });
});

describe("P1 窗格位置交换", () => {
  it("swapPanes 交换叶节点位置，标签随窗格 ID 不动", () => {
    const ids = seedQuad();
    const tabsBefore = new Map(ids.map((id) => [id, state().panes[id].tabs.map((t) => t.tabId)]));
    expect(state().swapPanes(ids[0], ids[3])).toBe(true);
    const order = paneIds(state().tree);
    expect(order[0]).toBe(ids[3]);
    expect(order.at(-1)).toBe(ids[0]);
    for (const id of ids) {
      expect(state().panes[id].tabs.map((t) => t.tabId)).toEqual(tabsBefore.get(id));
    }
    // 不创建额外窗格、不触发文件操作（这里只断言结构与标签）。
    expect(paneIds(state().tree)).toHaveLength(4);
  });

  it("交换不存在的区域返回 false（UI 不提示成功）", () => {
    const ids = seedQuad();
    expect(state().swapPanes(ids[0], "ghost")).toBe(false);
    expect(state().swapPanes(ids[0], ids[0])).toBe(false);
  });
});

describe("P1 布局持久化与恢复", () => {
  it("布局变化后立即关闭窗口：待写状态经 flushPending 落盘，重启后目录与布局完整", async () => {
    seedQuad();
    expect(state().applyLayoutPresetPreservingTabs("leftRight").ok).toBe(true);
    const expectedIds = sortedIds(tabIdSet());
    // 立刻关闭窗口（不等待 600ms 防抖）。
    await state().persistNow();
    const persisted = persistedNow();
    const saved = persisted.states.global;
    expect(saved.panes.flatMap((p) => p.tabs.map((t) => t.tabId))).toHaveLength(4);
    // 模拟重启：重新 hydrate。
    memSettings.settings = { [FILE_WORKSPACE_SETTING_KEY]: persisted };
    state().hydrate(saved, "global");
    expect(sortedIds(tabIdSet())).toEqual(expectedIds);
    expect(paneIds(state().tree)).toHaveLength(2);
  });

  it("重启后激活标签、收纳标签与固定/最近目录恢复", async () => {
    const ids = seedLayout(LAYOUT_PRESETS.leftRight.build(), [
      { path: "D:\\a", extra: 13 },
      { path: "D:\\b" },
    ]);
    state().setActiveTab(ids[0], state().panes[ids[0]].tabs[3].tabId);
    state().togglePinnedDir("D:\\pinned");
    state().recordRecentDir("D:\\recent");
    expect(state().applyLayoutPresetPreservingTabs("single").ok).toBe(true);
    expect(state().stashed.length).toBeGreaterThan(0);
    await state().persistNow();
    const saved = persistedNow().states.global;
    memSettings.settings = { [FILE_WORKSPACE_SETTING_KEY]: persistedNow() };
    state().hydrate(saved, "global");
    const pane = state().panes[paneIds(state().tree)[0]];
    expect(pane.activeTabId).toBe("tab-0-3");
    expect(state().stashed.length).toBe(saved.stashed?.length ?? 0);
    expect(state().pinnedDirs).toEqual(["D:\\pinned"]);
    expect(state().recentDirs).toEqual(["D:\\recent"]);
  });

  it("项目切换状态隔离：不同 stateKey 各自保存布局与目录", async () => {
    seedQuad();
    state().applyLayoutPresetPreservingTabs("leftRight");
    await state().persistNow();
    const projectState = persistedNow().states.global;
    // 切到项目键：不同快照。
    state().hydrate({ tree: LAYOUT_PRESETS.single.build(), panes: [], activePaneId: "" }, "project:p1");
    state().openInPane(state().activePaneId, "D:\\project", "newTab");
    await state().persistNow();
    expect(persistedNow().states["project:p1"]).toBeTruthy();
    expect(persistedNow().states.global).toEqual(projectState);
  });
});
