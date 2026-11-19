//! 分割树模型单测：分割/关闭/比例/交换/归一化/窗格上限。

import { describe, expect, it } from "vitest";

import {
  clampRatio,
  defaultTree,
  duplicateTab,
  hasPane,
  LAYOUT_PRESETS,
  MAX_PANES,
  normalizeTree,
  paneCount,
  paneIds,
  pathToPane,
  removePane,
  reassignPaneIds,
  splitPane,
  swapPaneWithSibling,
  updateRatio,
  type SplitNode,
} from "./model";

function quadTree(): SplitNode {
  return LAYOUT_PRESETS.quad.build();
}

describe("splitTree 基础", () => {
  it("默认树是单窗格", () => {
    const tree = defaultTree();
    expect(paneIds(tree)).toHaveLength(1);
    expect(paneCount(tree)).toBe(1);
  });

  it("splitPane 在目标窗格旁创建新窗格且原窗格位置不变", () => {
    const tree = defaultTree();
    const original = paneIds(tree)[0];
    const result = splitPane(tree, original, "horizontal");
    expect(result).not.toBeNull();
    const ids = paneIds(result!.tree);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(original); // 原窗格保持 first
    expect(ids[1]).toBe(result!.newPaneId);
    expect(hasPane(result!.tree, result!.newPaneId)).toBe(true);
  });

  it("side=before 前侧插入：左/上落点的新窗格出现在 first（P0 四方向分栏钉）", () => {
    const tree = defaultTree();
    const original = paneIds(tree)[0];
    const left = splitPane(tree, original, "horizontal", "before");
    expect(left).not.toBeNull();
    const leftIds = paneIds(left!.tree);
    expect(leftIds).toEqual([left!.newPaneId, original]); // 新窗格在左（first）
    const top = splitPane(tree, original, "vertical", "before");
    expect(paneIds(top!.tree)).toEqual([top!.newPaneId, original]); // 新窗格在上
    // after（默认）语义不变：新窗格在右/下。
    const right = splitPane(tree, original, "horizontal", "after");
    expect(paneIds(right!.tree)).toEqual([original, right!.newPaneId]);
  });

  it("side=before 在嵌套树中对深层窗格同样生效", () => {
    // 四宫格：右下窗格（pane-d）左落点 → 新窗格成为 pane-d 所在 split 的 first。
    const tree = quadTree();
    const result = splitPane(tree, "pane-d", "horizontal", "before");
    expect(paneCount(result!.tree)).toBe(5);
    const ids = paneIds(result!.tree);
    const idxD = ids.indexOf("pane-d");
    expect(idxD).toBeGreaterThan(0);
    expect(ids[idxD - 1]).toBe(result!.newPaneId);
  });

  it("四宫格树可继续分割（嵌套）", () => {
    const tree = quadTree();
    expect(paneCount(tree)).toBe(4);
    const result = splitPane(tree, paneIds(tree)[0], "vertical");
    expect(paneCount(result!.tree)).toBe(5);
  });

  it("沿同一角连续分割最终被上限拒绝（窗格数或树深）", () => {
    let tree = defaultTree();
    let refused = false;
    for (let i = 0; i < MAX_PANES + 4; i += 1) {
      const result = splitPane(tree, paneIds(tree)[0], "horizontal");
      if (!result) {
        refused = true;
        break;
      }
      tree = result.tree;
    }
    expect(refused).toBe(true);
    expect(paneCount(tree)).toBeLessThanOrEqual(MAX_PANES);
  });

  it("removePane 用兄弟节点顶替；根窗格不可移除", () => {
    const tree = quadTree();
    const ids = paneIds(tree);
    const next = removePane(tree, ids[0]);
    expect(next).not.toBeNull();
    expect(paneCount(next!)).toBe(3);
    expect(hasPane(next!, ids[0])).toBe(false);
    // 单窗格树：removePane 返回 null（不可关闭最后一个）
    expect(removePane(defaultTree(), paneIds(defaultTree())[0])).toBeNull();
  });

  it("updateRatio 钳制到 0.15–0.85", () => {
    const tree = quadTree();
    const splitId = (tree as Extract<SplitNode, { type: "split" }>).id;
    expect((updateRatio(tree, splitId, 0.9) as Extract<SplitNode, { type: "split" }>).ratio).toBe(0.85);
    expect((updateRatio(tree, splitId, 0.01) as Extract<SplitNode, { type: "split" }>).ratio).toBe(0.15);
    expect(clampRatio(Number.NaN)).toBe(0.5);
  });

  it("swapPaneWithSibling 只交换兄弟", () => {
    const tree = quadTree();
    const ids = paneIds(tree);
    const swapped = swapPaneWithSibling(tree, ids[0]);
    const after = paneIds(swapped);
    expect(after[0]).toBe(ids[1]);
    expect(after[1]).toBe(ids[0]);
    expect(after.slice(2)).toEqual(ids.slice(2));
  });

  it("pathToPane 返回根到窗格的 split 链", () => {
    const tree = quadTree();
    const ids = paneIds(tree);
    expect(pathToPane(tree, ids[0])).toHaveLength(2);
    expect(pathToPane(tree, "nope")).toBeNull();
  });
});

describe("duplicateTab 深拷贝纯函数", () => {
  it("生成新 tabId 且深拷贝 history（改一个不影响另一个）", () => {
    const source = {
      tabId: "tab-src",
      history: ["D:\\a", "D:\\a\\sub"],
      openedPath: "D:\\a",
      path: "D:\\a\\sub",
      viewMode: "grid" as const,
    };
    const copy = duplicateTab(source);
    expect(copy.tabId).not.toBe(source.tabId);
    expect(copy.history).toEqual(source.history);
    expect(copy.history).not.toBe(source.history); // 不共享数组引用
    copy.history.push("D:\\a\\sub\\deep");
    copy.history[0] = "D:\\changed";
    expect(source.history).toEqual(["D:\\a", "D:\\a\\sub"]); // 源完全不受影响
    // 其他字段按值复制。
    expect(copy.openedPath).toBe("D:\\a");
    expect(copy.viewMode).toBe("grid");
  });
});

describe("normalizeTree 损坏回退", () => {
  it("非法输入回退默认树", () => {
    expect(paneCount(normalizeTree(null))).toBe(1);
    expect(paneCount(normalizeTree(42))).toBe(1);
    expect(paneCount(normalizeTree({ type: "split" }))).toBe(1);
    expect(paneCount(normalizeTree({ type: "split", direction: "diagonal", id: "s" }))).toBe(1);
  });

  it("重复 paneId 裁剪为合法树", () => {
    const bad = {
      type: "split",
      direction: "horizontal",
      id: "s1",
      ratio: 0.5,
      first: { type: "pane", paneId: "p1" },
      second: { type: "pane", paneId: "p1" },
    };
    const tree = normalizeTree(bad);
    // second 无效 → 整体回默认（build 要求两侧都合法）
    expect(paneCount(tree)).toBe(1);
  });

  it("合法树完整恢复且比例被钳制", () => {
    const good = {
      type: "split",
      direction: "vertical",
      id: "s1",
      ratio: 0.99,
      first: { type: "pane", paneId: "a" },
      second: { type: "pane", paneId: "b" },
    };
    const tree = normalizeTree(good);
    expect(paneIds(tree)).toEqual(["a", "b"]);
    expect((tree as Extract<SplitNode, { type: "split" }>).ratio).toBe(0.85);
  });
});

describe("reassignPaneIds", () => {
  it("预置树重映射后无 ID 冲突，映射覆盖全部旧 ID", () => {
    const { tree, mapping } = reassignPaneIds(quadTree());
    const ids = paneIds(tree);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toEqual(paneIds(quadTree()));
    // 映射是模板恢复的关键（PersistedPane/activePaneId 都要按它重映射）。
    expect(mapping.size).toBe(ids.length);
    for (const oldId of paneIds(quadTree())) {
      expect(mapping.has(oldId)).toBe(true);
    }
  });
});
