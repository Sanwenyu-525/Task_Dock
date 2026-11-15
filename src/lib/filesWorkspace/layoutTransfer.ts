//! 布局转换时的标签重分配（纯函数，不依赖 React/Tauri/store）。
//!
//! 背景（第三轮 P0）：先前的 `applyPreset()` 直接重建布局树与窗格状态，把已打开的
//! 目录标签整批丢弃。目录是用户的工作内容，布局只是内容的组织方式，因此布局转换必须
//! 「先收集全部标签 → 生成目标布局 → 按稳定规则重新分配」。
//!
//! 分配规则（稳定、可预测，不随机）：
//! 1. 源窗格按视觉顺序（分割树先 first 后 second 的深度优先序）编号 0..M-1，
//!    目标窗格同样按视觉顺序编号 0..N-1；
//! 2. **区域变少（N ≤ M）按区域合并**：源窗格 i 归属 `floor(i * N / M)`——
//!    四宫格 → 双栏时 A/B 进左区域、C/D 进右区域（用户原有分组不被打散）；
//! 3. **区域变多（N > M）按标签铺开**：把全部标签按视觉顺序展平成连续序列，
//!    第 j 个标签归属 `floor(j * N / max(T, N))`——单栏 4 个标签 → 四宫格每格一个目录，
//!    区域数量不足时前面的区域先多放一个，永不留下「本该有目录却是空」的跳位；
//! 4. 同一目标区域收到的多个标签按上述顺序串联（顺序稳定，不会每次切换跳位）；
//! 5. 目标区域超过每窗格容量上限时，先向后续仍有空间的区域溢出，全部占满后进入
//!    可恢复收纳（stashed），绝不截断、绝不静默删除。
//!
//! 激活标签：原激活标签所在的目标区域成为激活区域，且该标签保持激活；其他区域取
//! 该源窗格原来的激活标签（若落入该区域），否则取区域首个标签。

import type { SplitNode } from "./model";

export interface TransferTabLike {
  tabId: string;
}

export interface TransferSource<T extends TransferTabLike> {
  paneId: string;
  tabs: T[];
  activeTabId: string | null;
}

export interface TransferSlot<T extends TransferTabLike> {
  paneId: string;
  tabs: T[];
  activeTabId: string | null;
}

export interface TransferPlan<T extends TransferTabLike> {
  slots: TransferSlot<T>[];
  /** 容量装不下的标签（按原顺序，可恢复收纳）。 */
  stashed: T[];
  /** 转换后应激活的区域。 */
  activePaneId: string;
}

/** 区域变少（合并）时，源窗格 i 映射到的目标槽位。 */
export function slotIndexForSource(sourceIndex: number, sourceCount: number, slotCount: number): number {
  if (slotCount <= 0) return 0;
  if (sourceCount <= 0) return 0;
  const raw = Math.floor((sourceIndex * slotCount) / sourceCount);
  return Math.min(slotCount - 1, Math.max(0, raw));
}

/** 区域变多（铺开）时，展平后的第 j 个标签映射到的目标槽位。 */
export function slotIndexForTab(tabIndex: number, tabCount: number, slotCount: number): number {
  if (slotCount <= 0) return 0;
  if (tabIndex < 0) return 0;
  const denom = Math.max(tabCount, slotCount);
  const raw = Math.floor((tabIndex * slotCount) / denom);
  return Math.min(slotCount - 1, Math.max(0, raw));
}

/**
 * 生成标签分配方案。
 *
 * @param sources 源窗格（调用方必须按视觉顺序传入）
 * @param targetPaneIds 目标窗格 ID（视觉顺序）
 * @param options.maxPerPane 每窗格标签上限（默认 12）
 * @param options.activePaneId 转换前激活的区域（用于保留用户当前工作焦点）
 * @param options.activeTabId 转换前激活的标签
 */
export function planTabTransfer<T extends TransferTabLike>(
  sources: ReadonlyArray<TransferSource<T>>,
  targetPaneIds: ReadonlyArray<string>,
  options: {
    maxPerPane?: number;
    activePaneId?: string | null;
    activeTabId?: string | null;
  } = {},
): TransferPlan<T> {
  const maxPerPane = Math.max(1, options.maxPerPane ?? 12);
  const slots: TransferSlot<T>[] = targetPaneIds.map((paneId) => ({ paneId, tabs: [], activeTabId: null }));
  const stashed: T[] = [];
  if (slots.length === 0) {
    return { slots, stashed, activePaneId: "" };
  }
  const sourceCount = sources.length;
  const totalTabs = sources.reduce((sum, source) => sum + source.tabs.length, 0);
  /** 目标槽位内「哪个标签原本是激活的」：先记录，最后统一回填 activeTabId。 */
  const preferredActive: Array<string | null> = slots.map(() => null);

  const hasRoom = (slot: number): boolean => slots[slot].tabs.length < maxPerPane;
  const nextSlotWithRoom = (from: number): number | null => {
    for (let step = 1; step <= slots.length; step += 1) {
      const candidate = (from + step) % slots.length;
      if (hasRoom(candidate)) return candidate;
    }
    return null;
  };

  // 区域变少按区域合并；区域变多按展平后的标签铺开（见模块头注释规则 2/3）。
  const mergeByPane = sourceCount >= slots.length;
  let flatIndex = 0;

  for (let i = 0; i < sourceCount; i += 1) {
    const source = sources[i];
    const paneSlot = slotIndexForSource(i, sourceCount, slots.length);
    for (const tab of source.tabs) {
      const slot = mergeByPane
        ? paneSlot
        : slotIndexForTab(flatIndex, totalTabs, slots.length);
      flatIndex += 1;
      let destination = slot;
      if (!hasRoom(destination)) {
        const spill = nextSlotWithRoom(destination);
        if (spill === null) {
          stashed.push(tab);
          continue;
        }
        destination = spill;
      }
      slots[destination].tabs.push(tab);
      if (source.activeTabId && tab.tabId === source.activeTabId) {
        preferredActive[destination] = tab.tabId;
      }
    }
  }

  for (let slot = 0; slot < slots.length; slot += 1) {
    const preferred = preferredActive[slot];
    const tabs = slots[slot].tabs;
    slots[slot].activeTabId =
      (preferred && tabs.some((t) => t.tabId === preferred) ? preferred : null) ?? tabs[0]?.tabId ?? null;
  }

  // 激活区域：优先包含原激活标签的槽位，其次原激活区域映射的槽位，最后第一个非空槽位。
  let activePaneId = "";
  if (options.activeTabId) {
    const owner = slots.find((slot) => slot.tabs.some((t) => t.tabId === options.activeTabId));
    if (owner) activePaneId = owner.paneId;
  }
  if (!activePaneId && options.activePaneId) {
    const index = sources.findIndex((s) => s.paneId === options.activePaneId);
    if (index >= 0) activePaneId = slots[slotIndexForSource(index, sourceCount, slots.length)].paneId;
  }
  if (!activePaneId) {
    const nonEmpty = slots.find((s) => s.tabs.length > 0);
    activePaneId = (nonEmpty ?? slots[0]).paneId;
  }

  return { slots, stashed, activePaneId };
}

/**
 * 当前布局是否已经等于目标预置（结构 + 方向 + 比例）。
 * 「点击当前布局预设」不应重建树：重建会换掉窗格 ID，虽不丢标签却会打断
 * 最大化状态与分割线拖动的连续性。比较时忽略分割节点 id（那是渲染用的随机值）。
 */
export function sameLayoutShape(a: SplitNode, b: SplitNode): boolean {
  const sig = (node: SplitNode): string =>
    node.type === "pane"
      ? "P"
      : `S(${node.direction}:${node.ratio.toFixed(3)}:${sig(node.first)}:${sig(node.second)})`;
  return sig(a) === sig(b);
}
