//! 布局转换标签分配纯函数测试（第三轮 P0：布局切换不得丢目录）。

import { describe, expect, it } from "vitest";

import { planTabTransfer, sameLayoutShape, slotIndexForSource, slotIndexForTab } from "./layoutTransfer";
import { LAYOUT_PRESETS, adjacentPaneId, paneIds, swapPanes, type SplitNode } from "./model";

interface FakeTab {
  tabId: string;
  path: string;
}

function tab(id: string, path: string): FakeTab {
  return { tabId: id, path };
}

/** 四宫格：A/B/C/D 各一个目录+一个额外标签（验证顺序与容量）。 */
function quadSources(): Array<{ paneId: string; tabs: FakeTab[]; activeTabId: string | null }> {
  return [
    { paneId: "pane-a", tabs: [tab("ta", "D:\\src")], activeTabId: "ta" },
    { paneId: "pane-b", tabs: [tab("tb", "D:\\art")], activeTabId: "tb" },
    { paneId: "pane-c", tabs: [tab("tc", "D:\\docs")], activeTabId: "tc" },
    { paneId: "pane-d", tabs: [tab("td", "D:\\build")], activeTabId: "td" },
  ];
}

function pathsOf(plan: ReturnType<typeof planTabTransfer<FakeTab>>): string[] {
  return plan.slots.flatMap((slot) => slot.tabs.map((t) => t.path));
}

describe("slotIndexForSource：比例映射", () => {
  it("四源 → 双槽：前二进 0，后二进 1", () => {
    expect([0, 1, 2, 3].map((i) => slotIndexForSource(i, 4, 2))).toEqual([0, 0, 1, 1]);
  });

  it("四源 → 单槽全部进 0；四源 → 四槽一一对应", () => {
    expect([0, 1, 2, 3].map((i) => slotIndexForSource(i, 4, 1))).toEqual([0, 0, 0, 0]);
    expect([0, 1, 2, 3].map((i) => slotIndexForSource(i, 4, 4))).toEqual([0, 1, 2, 3]);
  });

  it("双源 → 四槽：前两槽各一个，后两槽为空", () => {
    expect([0, 1].map((i) => slotIndexForSource(i, 2, 4))).toEqual([0, 2]);
  });

  it("三源 → 双槽：0/1 进 0，2 进 1（floor 规则）", () => {
    expect([0, 1, 2].map((i) => slotIndexForSource(i, 3, 2))).toEqual([0, 0, 1]);
  });

  it("越界输入不抛错", () => {
    expect(slotIndexForSource(0, 0, 3)).toBe(0);
    expect(slotIndexForSource(9, 4, 0)).toBe(0);
  });
});

describe("slotIndexForTab：区域变多时按标签铺开", () => {
  it("4 个标签 → 4 槽：一一对应", () => {
    expect([0, 1, 2, 3].map((i) => slotIndexForTab(i, 4, 4))).toEqual([0, 1, 2, 3]);
  });

  it("2 个标签 → 4 槽：填前两槽（不留跳位）", () => {
    expect([0, 1].map((i) => slotIndexForTab(i, 2, 4))).toEqual([0, 1]);
  });

  it("标签多于槽位时余量留在前槽", () => {
    expect([0, 1, 2, 3, 4].map((i) => slotIndexForTab(i, 5, 4))).toEqual([0, 0, 1, 2, 3]);
    expect([0, 1, 2, 3, 4, 5].map((i) => slotIndexForTab(i, 6, 4))).toEqual([0, 0, 1, 2, 2, 3]);
  });
});

describe("planTabTransfer：目录集合恒定", () => {
  it("四宫格 → 左右双栏：A/B 左，C/D 右，标签 ID 集合不变", () => {
    const sources = quadSources();
    const plan = planTabTransfer(sources, ["p1", "p2"]);
    expect(plan.slots[0].tabs.map((t) => t.tabId)).toEqual(["ta", "tb"]);
    expect(plan.slots[1].tabs.map((t) => t.tabId)).toEqual(["tc", "td"]);
    expect(plan.stashed).toHaveLength(0);
    expect(pathsOf(plan).sort()).toEqual(["D:\\art", "D:\\build", "D:\\docs", "D:\\src"]);
    expect(plan.activePaneId).toBe("p1"); // pane-a 原激活 → 左槽
  });

  it("四宫格 → 单栏：全部进唯一区域且顺序稳定", () => {
    const plan = planTabTransfer(quadSources(), ["only"]);
    expect(plan.slots[0].tabs.map((t) => t.tabId)).toEqual(["ta", "tb", "tc", "td"]);
    expect(plan.activePaneId).toBe("only");
  });

  it("双栏 → 四宫格：区域变多时按标签铺开（每个区域优先一个目录）", () => {
    const sources = [
      { paneId: "p1", tabs: [tab("t1", "D:\\a")], activeTabId: "t1" },
      { paneId: "p2", tabs: [tab("t2", "D:\\b"), tab("t3", "D:\\c")], activeTabId: "t3" },
    ];
    const plan = planTabTransfer(sources, ["s0", "s1", "s2", "s3"], { activePaneId: "p2" });
    // 3 个标签 → 前三个区域各一个，第四个区域为空（新增区域可以为空）。
    expect(plan.slots.map((s) => s.tabs.map((t) => t.tabId))).toEqual([["t1"], ["t2"], ["t3"], []]);
    expect(plan.slots[2].activeTabId).toBe("t3");
    expect(plan.activePaneId).toBe("s2");
  });

  it("单栏 4 个目录 → 四宫格：每格一个目录，顺序与展平顺序一致", () => {
    const sources = [
      {
        paneId: "only",
        tabs: [tab("ta", "D:\\src"), tab("tb", "D:\\art"), tab("tc", "D:\\docs"), tab("td", "D:\\build")],
        activeTabId: "ta",
      },
    ];
    const plan = planTabTransfer(sources, ["s0", "s1", "s2", "s3"], { activePaneId: "only", activeTabId: "ta" });
    expect(plan.slots.map((s) => s.tabs.map((t) => t.tabId))).toEqual([["ta"], ["tb"], ["tc"], ["td"]]);
    expect(plan.activePaneId).toBe("s0");
  });

  it("原激活标签保留：多标签窗格合并后仍指向同一 tabId", () => {
    const sources = [
      { paneId: "p1", tabs: [tab("a1", "D:\\a"), tab("a2", "D:\\b")], activeTabId: "a2" },
      { paneId: "p2", tabs: [tab("b1", "D:\\c")], activeTabId: "b1" },
    ];
    const plan = planTabTransfer(sources, ["t1", "t2"], { activePaneId: "p1", activeTabId: "a2" });
    expect(plan.slots[0].tabs.map((t) => t.tabId)).toEqual(["a1", "a2", "b1"]);
    expect(plan.slots[0].activeTabId).toBe("a2");
    expect(plan.slots[1].activeTabId).toBeNull();
  });

  it("容量上限：单区域装不下时，多余标签进入可恢复收纳而不是被截断", () => {
    const big = {
      paneId: "p1",
      tabs: Array.from({ length: 15 }, (_, i) => tab(`t${i}`, `D:\\dir${i}`)),
      activeTabId: "t0",
    };
    const plan = planTabTransfer([big], ["only"], { maxPerPane: 12 });
    expect(plan.slots[0].tabs).toHaveLength(12);
    expect(plan.stashed.map((t) => t.tabId)).toEqual(["t12", "t13", "t14"]);
    // 全部标签仍在（进入收纳），一个都没丢。
    expect(plan.slots[0].tabs.length + plan.stashed.length).toBe(15);
  });

  it("容量上限：后续目标区域仍有空间时先溢出到该区域", () => {
    const wide = {
      paneId: "p1",
      tabs: Array.from({ length: 15 }, (_, i) => tab(`t${i}`, `D:\\dir${i}`)),
      activeTabId: null,
    };
    const small = {
      paneId: "p2",
      tabs: [tab("other", "D:\\other")],
      activeTabId: "other",
    };
    const plan = planTabTransfer([wide, small], ["s0", "s1"], { maxPerPane: 12 });
    expect(plan.slots[0].tabs).toHaveLength(12);
    expect(plan.slots[1].tabs.map((t) => t.tabId)).toEqual(["t12", "t13", "t14", "other"]);
    expect(plan.stashed).toHaveLength(0);
  });

  it("空布局转换：无标签时不产生内容也不抛错", () => {
    const plan = planTabTransfer([], ["a", "b"]);
    expect(plan.slots.every((s) => s.tabs.length === 0)).toBe(true);
    expect(plan.activePaneId).toBe("a");
  });
});

describe("swapPanes：任意两区域位置互换", () => {
  const quad = LAYOUT_PRESETS.quad.build();

  it("四宫格 A↔D：叶节点互换，窗格 ID 集合与树形不变", () => {
    const next = swapPanes(quad, "pane-a", "pane-d")!;
    expect(next).not.toBeNull();
    expect(paneIds(next)).toEqual(["pane-d", "pane-b", "pane-c", "pane-a"]);
    expect(next.type).toBe("split");
  });

  it("同一窗格 / 不存在的窗格 → null（调用方不得据此提示成功）", () => {
    expect(swapPanes(quad, "pane-a", "pane-a")).toBeNull();
    expect(swapPanes(quad, "pane-a", "ghost")).toBeNull();
  });

  it("跨层级交换不改变分割方向与比例", () => {
    const leftRight = LAYOUT_PRESETS.leftRight.build();
    const next = swapPanes(leftRight, "pane-a", "pane-b")!;
    const root = next as Extract<SplitNode, { type: "split" }>;
    expect(root.direction).toBe("horizontal");
    expect(root.ratio).toBeCloseTo(0.5);
    expect(paneIds(next)).toEqual(["pane-b", "pane-a"]);
  });
});

describe("adjacentPaneId：关闭区域的默认转移目标", () => {
  it("左右双栏：左窗格 → 右窗格", () => {
    const tree = LAYOUT_PRESETS.leftRight.build();
    expect(adjacentPaneId(tree, "pane-a")).toBe("pane-b");
    expect(adjacentPaneId(tree, "pane-b")).toBe("pane-a");
  });

  it("四宫格：A → B（同级兄弟），C → D", () => {
    const tree = LAYOUT_PRESETS.quad.build();
    expect(adjacentPaneId(tree, "pane-a")).toBe("pane-b");
    expect(adjacentPaneId(tree, "pane-c")).toBe("pane-d");
  });

  it("单窗格返回 null（最后一个区域不可关闭）", () => {
    expect(adjacentPaneId(LAYOUT_PRESETS.single.build(), "pane-1")).toBeNull();
  });
});

describe("sameLayoutShape：结构比较（忽略随机 split id）", () => {
  it("同预设两次构建视为同形；不同预置不同形", () => {
    expect(sameLayoutShape(LAYOUT_PRESETS.quad.build(), LAYOUT_PRESETS.quad.build())).toBe(true);
    expect(sameLayoutShape(LAYOUT_PRESETS.quad.build(), LAYOUT_PRESETS.leftRight.build())).toBe(false);
  });

  it("窗格 ID 不同但结构相同仍视为同形", () => {
    const a: SplitNode = { type: "pane", paneId: "p-x" };
    const b: SplitNode = { type: "pane", paneId: "p-y" };
    expect(sameLayoutShape(a, b)).toBe(true);
  });
});
