//! 文件工作区分割树模型（纯函数，无 React/Tauri 依赖）。
//!
//! 数据模型：递归分割树；split 节点持有稳定 id（分割线拖动定位用），
//! pane 节点只存 paneId（标签与目录状态在 store 的 panes 表里，树只管形状）。
//! 上限：窗格 ≤ 12、树深 ≤ 6、每窗格标签 ≤ 12——归一化时超限裁剪，绝不白屏。

export type SplitDirection = "horizontal" | "vertical";

export interface SplitInner {
  type: "split";
  id: string;
  direction: SplitDirection;
  /** first 占比（0.15–0.85）；second = 1 - ratio。 */
  ratio: number;
  first: SplitNode;
  second: SplitNode;
}

export interface SplitLeaf {
  type: "pane";
  paneId: string;
}

export type SplitNode = SplitInner | SplitLeaf;

/** 每窗格标签数上限。 */
export const MAX_TABS_PER_PANE = 12;
/** 窗格总数上限（超限的分栏/拖拽操作被拒绝并提示）。 */
export const MAX_PANES = 12;
/** 树深上限。 */
export const MAX_DEPTH = 6;
export const RATIO_MIN = 0.15;
export const RATIO_MAX = 0.85;

let idSeq = 0;
/** 唯一 ID：自增 + 随机段，进程内足够；持久化后重放不冲突（仅新 id 才生成）。 */
export function freshId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio));
}

/** 深度优先收集窗格 ID（顺序即视觉顺序：先 first 后 second）。 */
export function paneIds(node: SplitNode): string[] {
  if (node.type === "pane") return [node.paneId];
  return [...paneIds(node.first), ...paneIds(node.second)];
}

export function paneCount(node: SplitNode): number {
  return paneIds(node).length;
}

export function hasPane(node: SplitNode, paneId: string): boolean {
  return node.type === "pane"
    ? node.paneId === paneId
    : hasPane(node.first, paneId) || hasPane(node.second, paneId);
}

/** 默认树：单窗格。 */
export function defaultTree(): SplitNode {
  return { type: "pane", paneId: "pane-1" };
}

export function newPaneNode(): SplitLeaf {
  return { type: "pane", paneId: freshId("pane") };
}

/**
 * 在指定窗格旁分割出下一个新窗格。
 * - direction: horizontal = 左右分割，vertical = 上下分割；
 * - side: "after"（默认）= 新窗格在右/下侧，原窗格保持 first（视觉位置不变）；
 *   "before" = 新窗格在左/上侧（拖拽落点四方向分栏的关键：左/上落点必须前侧插入，
 *   不能只改视觉提示而不改变树顺序）；
 * - 超出窗格/深度上限时返回 null（调用方提示，不静默失败）。
 */
export function splitPane(
  node: SplitNode,
  paneId: string,
  direction: SplitDirection,
  side: "before" | "after" = "after",
): { tree: SplitNode; newPaneId: string } | null {
  if (paneCount(node) >= MAX_PANES) return null;
  const newLeaf = newPaneNode();
  // next 返回 null = 深度拒绝（本分支整体不可分割）；changed 区分「找到并分割」
  // 与「目标不在此分支」——二者混同会导致过深窗格分割时静默假成功。
  const next = (cur: SplitNode, depth: number): { node: SplitNode; changed: boolean } | null => {
    if (depth > MAX_DEPTH) return null;
    if (cur.type === "pane") {
      if (cur.paneId !== paneId) return { node: cur, changed: false };
      const original: SplitLeaf = { type: "pane", paneId: cur.paneId };
      return {
        node: {
          type: "split",
          id: freshId("split"),
          direction,
          ratio: 0.5,
          first: side === "before" ? newLeaf : original,
          second: side === "before" ? original : newLeaf,
        },
        changed: true,
      };
    }
    const first = next(cur.first, depth + 1);
    if (!first) return null;
    if (first.changed) return { node: { ...cur, first: first.node }, changed: true };
    const second = next(cur.second, depth + 1);
    if (!second) return null;
    return { node: { ...cur, first: first.node, second: second.node }, changed: second.changed };
  };
  const outcome = next(node, 0);
  return outcome?.changed ? { tree: outcome.node, newPaneId: newLeaf.paneId } : null;
}

/**
 * 关闭窗格：兄弟节点上移。最后一个窗格不可关闭（返回 null）。
 * 若被关窗格是「最大化」目标，由 store 复位 maximizedPaneId。
 */
export function removePane(node: SplitNode, paneId: string): SplitNode | null {
  if (node.type === "pane") return null; // 根窗格不可移除
  const fromFirst = node.first;
  const fromSecond = node.second;
  if (fromFirst.type === "pane" && fromFirst.paneId === paneId) return fromSecond;
  if (fromSecond.type === "pane" && fromSecond.paneId === paneId) return fromFirst;
  const first = removePane(fromFirst, paneId);
  if (first) return { ...node, first };
  const second = removePane(fromSecond, paneId);
  if (second) return { ...node, second };
  return null;
}

/** 更新指定分割节点的比例（拖动分割线）。 */
export function updateRatio(node: SplitNode, splitId: string, ratio: number): SplitNode {
  if (node.type === "pane") return node;
  if (node.id === splitId) return { ...node, ratio: clampRatio(ratio) };
  return { ...node, first: updateRatio(node.first, splitId, ratio), second: updateRatio(node.second, splitId, ratio) };
}

/** 交换窗格与其兄弟位置（保持标签/状态，视觉互换）。 */
export function swapPaneWithSibling(node: SplitNode, paneId: string): SplitNode {
  if (node.type === "split") {
    if (node.first.type === "pane" && node.first.paneId === paneId) {
      return { ...node, first: node.second, second: node.first };
    }
    if (node.second.type === "pane" && node.second.paneId === paneId) {
      return { ...node, second: node.first, first: node.second };
    }
  }
  if (node.type === "pane") return node;
  return {
    ...node,
    first: swapPaneWithSibling(node.first, paneId),
    second: swapPaneWithSibling(node.second, paneId),
  };
}

/**
 * 交换任意两个窗格的位置（叶节点互换，标签/导航状态随窗格 ID 不动）。
 *
 * 与 `swapPaneWithSibling` 的差别：这里支持跨层级、任意两区域交换——布局编辑模式
 * 「把 A 拖到 D 的中心」必须让 A 与 D 互换显示位置，而不是新建窗格搬标签再删旧窗格
 * （那会产生新窗格、丢失原窗格的活动标签与最大化状态，并触发额外的持久化写入）。
 * 找不到目标或同一窗格时返回 null：调用方不得据此提示成功。
 */
export function swapPanes(node: SplitNode, a: string, b: string): SplitNode | null {
  if (a === b) return null;
  if (!hasPane(node, a) || !hasPane(node, b)) return null;
  const walk = (cur: SplitNode): SplitNode => {
    if (cur.type === "pane") {
      if (cur.paneId === a) return { type: "pane", paneId: b };
      if (cur.paneId === b) return { type: "pane", paneId: a };
      return cur;
    }
    return { ...cur, first: walk(cur.first), second: walk(cur.second) };
  };
  return walk(node);
}

/**
 * 相邻窗格（关闭区域时标签的默认转移目标）。
 *
 * 规则：沿 pane 到根的路径，取最近一层父分割的兄弟子树；pane 在 first 侧时取兄弟子树
 * 的第一个窗格（视觉上紧随其后），在 second 侧时取最后一个窗格（视觉上紧邻其前）。
 * 单窗格树返回 null（最后一个区域不可关闭，由 store 拒绝）。
 */
export function adjacentPaneId(node: SplitNode, paneId: string): string | null {
  const path = pathToPane(node, paneId);
  if (!path || path.length === 0) return null;
  for (const parent of path) {
    const inFirst = hasPane(parent.first, paneId);
    const sibling = inFirst ? parent.second : parent.first;
    const ids = paneIds(sibling);
    if (ids.length === 0) continue;
    return inFirst ? ids[0] : ids[ids.length - 1];
  }
  return null;
}

/** 窗格到根的路径（含自身）；用于渲染定位与分割线归属。 */
export function pathToPane(node: SplitNode, paneId: string): SplitInner[] | null {
  if (node.type === "pane") return node.paneId === paneId ? [] : null;
  const viaFirst = pathToPane(node.first, paneId);
  if (viaFirst) return [node, ...viaFirst];
  const viaSecond = pathToPane(node.second, paneId);
  if (viaSecond) return [node, ...viaSecond];
  return null;
}

// ── 归一化（持久化恢复）────────────────────────────────────────────────

/** 结构校验：非法值整体回退默认树（损坏数据不白屏）。 */
export function normalizeTree(raw: unknown): SplitNode {
  const paneSeen = new Set<string>();
  const build = (value: unknown, depth: number): SplitNode | null => {
    if (!value || typeof value !== "object" || depth > MAX_DEPTH) return null;
    const obj = value as Record<string, unknown>;
    if (obj.type === "pane") {
      const paneId = typeof obj.paneId === "string" && obj.paneId.length <= 64 ? obj.paneId : null;
      if (!paneId || paneSeen.has(paneId)) return null;
      paneSeen.add(paneId);
      return { type: "pane", paneId };
    }
    if (obj.type !== "split") return null;
    const direction = obj.direction === "horizontal" || obj.direction === "vertical" ? obj.direction : null;
    const id = typeof obj.id === "string" && obj.id.length <= 64 ? obj.id : null;
    if (!direction || !id) return null;
    const first = build(obj.first, depth + 1);
    if (!first) return null;
    const second = build(obj.second, depth + 1);
    if (!second) return null;
    return {
      type: "split",
      id,
      direction,
      ratio: clampRatio(typeof obj.ratio === "number" ? obj.ratio : 0.5),
      first,
      second,
    };
  };
  return build(raw, 0) ?? defaultTree();
}

/** 预置布局（内置模板共用）：窗格 ID 稳定（pane-a…），模板恢复时重映射为全新 ID。 */
export const LAYOUT_PRESETS: Record<
  string,
  { id: string; label: string; build: () => SplitNode }
> = {
  single: { id: "single", label: "单区域", build: defaultTree },
  leftRight: {
    id: "leftRight",
    label: "左右分栏",
    build: () => ({
      type: "split",
      id: freshId("split"),
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "pane", paneId: "pane-a" },
      second: { type: "pane", paneId: "pane-b" },
    }),
  },
  topBottom: {
    id: "topBottom",
    label: "上下分栏",
    build: () => ({
      type: "split",
      id: freshId("split"),
      direction: "vertical",
      ratio: 0.5,
      first: { type: "pane", paneId: "pane-a" },
      second: { type: "pane", paneId: "pane-b" },
    }),
  },
  quad: {
    id: "quad",
    label: "四宫格",
    build: () => ({
      type: "split",
      id: freshId("split"),
      direction: "horizontal",
      ratio: 0.5,
      first: {
        type: "split",
        id: freshId("split"),
        direction: "vertical",
        ratio: 0.5,
        first: { type: "pane", paneId: "pane-a" },
        second: { type: "pane", paneId: "pane-b" },
      },
      second: {
        type: "split",
        id: freshId("split"),
        direction: "vertical",
        ratio: 0.5,
        first: { type: "pane", paneId: "pane-c" },
        second: { type: "pane", paneId: "pane-d" },
      },
    }),
  },
  threeLeft: {
    id: "threeLeft",
    label: "三栏",
    build: () => ({
      type: "split",
      id: freshId("split"),
      direction: "horizontal",
      ratio: 0.34,
      first: { type: "pane", paneId: "pane-a" },
      second: {
        type: "split",
        id: freshId("split"),
        direction: "vertical",
        ratio: 0.5,
        first: { type: "pane", paneId: "pane-b" },
        second: { type: "pane", paneId: "pane-c" },
      },
    }),
  },
};

/** 把预置/模板树重映射为全新窗格 ID，并返回 旧 paneId → 新 paneId 映射。
 * 模板恢复必须同时重映射 PersistedPane 与 activePaneId（P0：旧实现用新 ID
 * 查旧窗格数据，所有标签丢失）。 */
export function reassignPaneIds(node: SplitNode): { tree: SplitNode; mapping: Map<string, string> } {
  const mapping = new Map<string, string>();
  const walk = (cur: SplitNode): SplitNode => {
    if (cur.type === "pane") {
      if (!mapping.has(cur.paneId)) mapping.set(cur.paneId, freshId("pane"));
      return { type: "pane", paneId: mapping.get(cur.paneId)! };
    }
    return { ...cur, first: walk(cur.first), second: walk(cur.second) };
  };
  return { tree: walk(node), mapping };
}
