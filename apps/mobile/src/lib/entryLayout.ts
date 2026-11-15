// 工作台入口配置：默认值、归一化（含旧版本迁移与损坏兜底）、显示/隐藏/排序的纯函数。
//
// 与桌面端 src/lib/navVisibility.ts 同一套语义，但有两条移动端特有的规则：
// 1. 暂不可用入口永远不能出现在 visible 里（用户无法把不存在的能力加进工作台）；
// 2. 空数组是合法配置（用户可以把工作台清空，工作台必须显示空状态而不是白屏）。
//
// known 快照的作用（这是「新增功能不覆盖用户配置」的关键）：
// 写入时记录「当时全部可用入口 id」。归一化时，只有「不在 known 且默认显示」的入口
// 才会被补进工作台——这样 App 升级带来的新功能会自动出现，而用户主动隐藏过的入口
// 不会因为升级被重新塞回来。
//
// 约束：纯函数，不得 import react / react-native / db。
import {
  MOBILE_ENTRIES,
  availableEntryIds,
  defaultVisibleEntryIds,
  entryById,
  isEntryAvailable,
  type EntryId,
} from "./entryRegistry";

/** kv 设置键（本机持久化；与桌面端 navigation_layout 完全独立） */
export const ENTRY_LAYOUT_SETTING_KEY = "workbench_entries";

/** 配置结构版本：改结构必须 +1，并在 normalizeEntryLayout 里给出迁移分支 */
export const ENTRY_LAYOUT_VERSION = 1;

export interface EntryLayoutConfig {
  version: number;
  /** 工作台已显示的入口 ID，数组顺序就是排列顺序 */
  visible: EntryId[];
  /** 写入时「可用入口」的全集快照，用来区分用户隐藏与后续新增 */
  known: EntryId[];
}

export type EntryLayoutSource = "settings" | "default";

export interface EntryLayoutNormalization {
  config: EntryLayoutConfig;
  /** 声明的版本与当前版本不同：结构按当前版本重建，但保留用户的选择 */
  migrated: boolean;
  /** 被丢弃的无效 id 数量（已删除 / 改名 / 暂不可用 / 重复） */
  dropped: number;
  source: EntryLayoutSource;
}

/** 首次安装（或配置损坏）使用的默认布局 */
export function defaultEntryLayout(): EntryLayoutConfig {
  return {
    version: ENTRY_LAYOUT_VERSION,
    visible: defaultVisibleEntryIds(),
    known: availableEntryIds(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * 归一化任意来源的配置（kv 原文 / 内存状态 / 测试输入）。
 *
 * 判定顺序：
 * 1. 不是对象或 visible 不是数组 → 视为损坏，返回默认布局（source=default）；
 * 2. 逐项校验：必须是当前「可用」入口、不重复，否则丢弃并计数；
 * 3. known 缺失（更早的格式）→ 保守地认为「现存全部可用入口都已知」，
 *    不把任何现存入口当成新增，避免把用户隐藏过的入口又显示出来；
 * 4. 不在 known 且默认显示的入口按默认顺序插入（App 升级新增功能的合并规则）；
 * 5. known 收敛为当前全部可用入口，下次写入即可自洽。
 */
export function normalizeEntryLayout(raw: unknown): EntryLayoutNormalization {
  const fallback = defaultEntryLayout();

  if (!isRecord(raw)) {
    return { config: fallback, migrated: false, dropped: 0, source: "default" };
  }
  const rawVisible = asStringArray(raw.visible);
  if (rawVisible === null) {
    return { config: fallback, migrated: false, dropped: 0, source: "default" };
  }

  const declaredVersion = typeof raw.version === "number" ? raw.version : 0;
  const migrated = declaredVersion !== ENTRY_LAYOUT_VERSION;

  const available = new Set<string>(availableEntryIds());
  const seen = new Set<string>();
  let dropped = 0;
  for (const id of rawVisible) {
    if (!available.has(id) || seen.has(id)) {
      dropped += 1;
      continue;
    }
    seen.add(id);
  }
  let visible = [...seen] as EntryId[];

  const rawKnown = asStringArray(raw.known);
  const known = new Set<string>();
  if (rawKnown === null) {
    // 缺快照：不把现存入口当新增（宁可少自动补，也不误把隐藏项弹回来）
    for (const id of available) known.add(id);
  } else {
    for (const id of rawKnown) {
      if (available.has(id)) known.add(id);
    }
  }
  for (const id of visible) known.add(id);

  // 新功能合并：不在 known 且默认显示 → 按默认顺序插入
  for (const entry of MOBILE_ENTRIES) {
    if (!isEntryAvailable(entry)) continue;
    if (known.has(entry.id)) continue;
    if (!entry.defaultVisible) continue;
    visible = insertEntryByDefaultOrder(visible, entry.id as EntryId);
  }

  return {
    config: { version: ENTRY_LAYOUT_VERSION, visible, known: availableEntryIds() },
    migrated,
    dropped,
    source: "settings",
  };
}

/** 按默认顺序把 entry 插到合适位置；已存在则原样返回（不改变用户已有顺序） */
export function insertEntryByDefaultOrder(
  ids: readonly EntryId[],
  id: EntryId,
): EntryId[] {
  if (ids.includes(id)) return [...ids];
  const entry = entryById(id);
  if (!entry) return [...ids];

  const existingOrders = ids.map((existingId) => entryById(existingId)?.order ?? 0);
  const index = existingOrders.findIndex((order) => order > entry.order);
  const next = [...ids];
  next.splice(index === -1 ? next.length : index, 0, id);
  return next;
}

export function isEntryVisible(ids: readonly EntryId[], id: EntryId): boolean {
  return ids.includes(id);
}

/**
 * 设置单个入口的显示状态。
 * 暂不可用入口不允许「显示」：调用方传进来也原样返回，避免把不存在的能力放进工作台。
 */
export function setEntryVisible(
  ids: readonly EntryId[],
  id: EntryId,
  visible: boolean,
): EntryId[] {
  if (!isEntryAvailable(entryById(id))) return [...ids];
  if (!visible) return ids.filter((existing) => existing !== id);
  return insertEntryByDefaultOrder(ids, id);
}

/** 批量显示/隐藏：一次遍历完成，避免多次写库 */
export function setEntriesVisible(
  ids: readonly EntryId[],
  targets: readonly EntryId[],
  visible: boolean,
): EntryId[] {
  const targetSet = new Set(targets);
  if (!visible) return ids.filter((existing) => !targetSet.has(existing));

  const next = [...ids];
  for (const entry of MOBILE_ENTRIES) {
    if (!isEntryAvailable(entry)) continue;
    if (!targetSet.has(entry.id as EntryId)) continue;
    if (next.includes(entry.id as EntryId)) continue;
    const inserted = insertEntryByDefaultOrder(next, entry.id as EntryId);
    next.splice(0, next.length, ...inserted);
  }
  return next;
}

/** 按 id 移动到目标下标（越界自动收敛） */
export function moveEntryToIndex(
  ids: readonly EntryId[],
  id: EntryId,
  toIndex: number,
): EntryId[] {
  const from = ids.indexOf(id);
  if (from === -1) return [...ids];
  return moveEntryByIndex(ids, from, toIndex);
}

/** 按下标移动（拖拽落地时用它，避免「id 找不到」还要再查一次） */
export function moveEntryByIndex(
  ids: readonly EntryId[],
  fromIndex: number,
  toIndex: number,
): EntryId[] {
  if (ids.length === 0) return [];
  const from = Math.min(Math.max(fromIndex, 0), ids.length - 1);
  const to = Math.min(Math.max(toIndex, 0), ids.length - 1);
  if (from === to) return [...ids];
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** 相对移动（上移/下移按钮，读屏与不能用拖拽时的稳定替代路径） */
export function moveEntryByDelta(
  ids: readonly EntryId[],
  id: EntryId,
  delta: number,
): EntryId[] {
  const from = ids.indexOf(id);
  if (from === -1) return [...ids];
  return moveEntryByIndex(ids, from, from + delta);
}

/**
 * 拖拽结果合并：desired 可能缺项或多出重复项，最终集合必须与 current 完全一致。
 * 这里以 current 为基准，只接受 desired 的相对顺序——宁可丢弃异常顺序，
 * 也不允许因为一次拖拽把某个入口从工作台里弄丢。
 */
export function mergeEntryOrder(
  current: readonly EntryId[],
  desired: readonly EntryId[],
): EntryId[] {
  const currentSet = new Set(current);
  const kept: EntryId[] = [];
  const seen = new Set<EntryId>();
  for (const id of desired) {
    if (!currentSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  const rest = current.filter((id) => !seen.has(id));
  return [...kept, ...rest];
}
