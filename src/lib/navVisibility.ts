//! 导航布局配置层：完整面板（left）与停靠胶囊（capsule）各自的显隐 + 排序。
//!
//! 三层分工：
//! 1. `navigationRegistry.ts`：入口元数据与默认值（唯一事实源）；
//! 2. 本文件：把外部存储的原始 JSON 归一化为可用的布局配置（版本迁移、ID 对齐、
//!    新入口合并、损坏回退），全部为纯函数，便于单测；
//! 3. `navigationLayout.ts`：把纯函数接到 SQLite 设置存储（读-改-写串行化）。
//!
//! 存储结构（`application_settings.navigation_layout`，版本化 JSON 对象）：
//!
//! ```json
//! {
//!   "version": 1,
//!   "left": ["tasks", "agents", "..."],   // 左侧可见入口，数组顺序即排序
//!   "capsule": ["agents", "tasks", "..."] // 胶囊可见入口，数组顺序即排序
//!   "known": { "left": [...], "capsule": [...] } // 写入时注册中心已有的入口
//! }
//! ```
//!
//! `known` 用于区分「用户隐藏」与「后续版本新增」：老配置里不存在的 ID 视为新入口，
//! 按注册中心默认值合并（默认可见）；存在于 `known` 但不在可见数组里的视为用户隐藏，
//! 绝不擅自恢复。这样既满足「新入口默认可见」，也不会覆盖用户已有自定义。
//!
//! 兼容与回退：
//! - `version` 不符 → 按 ID 对齐迁移：能识别的 ID 保留选择与顺序，无法识别的丢弃并计数，
//!   再按注册中心补齐新入口；不整体丢弃用户配置；
//! - 缺失 / 非对象 / 数组损坏 → 回退到注册中心默认（全部默认可见）；
//! - 空数组是合法状态（用户主动隐藏全部），不会被默认值重新填满。

import {
  allEntryIds,
  defaultVisibleIds,
  entriesForSurface,
  leftEntryForTab,
  navEntry,
  type NavSurface,
} from "./navigationRegistry";
import type { Tab } from "../store/useUiStore";

/** SQLite 设置键：配置不进备份白名单之外的独立表，也不新增 IPC。 */
export const NAV_LAYOUT_SETTING_KEY = "navigation_layout";

/** 配置结构版本：结构或合并语义发生破坏性变化时才递增。 */
export const NAV_LAYOUT_VERSION = 1;

export interface NavLayoutConfig {
  version: number;
  /** 左侧可见入口 ID，顺序即排序。 */
  left: string[];
  /** 胶囊可见入口 ID，顺序即排序。 */
  capsule: string[];
  /** 写入时注册中心已有的入口快照（区分用户隐藏与新增入口）。 */
  known: { left: string[]; capsule: string[] };
}

export interface NavLayoutNormalization {
  config: NavLayoutConfig;
  /** 输入版本与当前版本不一致（已按 ID 对齐迁移）。 */
  migrated: boolean;
  /** 被丢弃的无法识别 / 非字符串 / 重复项数量。 */
  dropped: number;
  /** 数据源：`settings` 为有效对象；`default` 为缺失或损坏回退。 */
  source: "settings" | "default";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 注册中心默认：默认可见入口按默认顺序，known 为当前全部入口。 */
export function defaultNavigationLayout(): NavLayoutConfig {
  return {
    version: NAV_LAYOUT_VERSION,
    left: defaultVisibleIds("left"),
    capsule: defaultVisibleIds("capsule"),
    known: { left: allEntryIds("left"), capsule: allEntryIds("capsule") },
  };
}

/**
 * 按默认顺序把入口插入可见列表：用于「显示一个已隐藏入口」。
 * 用户自定义顺序优先——只在默认顺序的相邻位置插入，不重排既有项目。
 */
export function insertEntryByDefaultOrder(
  ids: readonly string[],
  id: string,
  surface: NavSurface,
): string[] {
  if (ids.includes(id)) return [...ids];
  const order = navEntry(id)?.defaults[surface].order;
  if (order === undefined) return [...ids];
  const index = ids.findIndex((existing) => {
    const existingOrder = navEntry(existing)?.defaults[surface].order;
    return existingOrder !== undefined && existingOrder > order;
  });
  const next = [...ids];
  next.splice(index === -1 ? next.length : index, 0, id);
  return next;
}

/** 键盘可用的排序操作（上移 / 下移），不引入拖拽依赖。
 *
 * 排序不变量：**固定入口不可移动，也不阻挡普通入口排序**。
 * - `isFixed(id)` 判定固定入口（左侧 `locked` 设置、胶囊 Agent 状态球）；
 * - 固定入口自身移动无效（返回原顺序副本）；
 * - 普通入口在「可排序子序列」内相邻交换：固定入口不是障碍，普通入口可以
 *   跨过它（固定项原地不动），胶囊分类因此不受端头 Agent 状态球阻挡；
 * - 隐藏入口不在可见数组里，天然不参与上下移动；
 * - 排序只改变顺序，不改变任何入口的显隐（数组成员集合不变）。
 */
export function moveEntryInList(
  ids: readonly string[],
  id: string,
  delta: -1 | 1,
  isFixed: (id: string) => boolean = () => false,
): string[] {
  const index = ids.indexOf(id);
  if (index < 0) return [...ids];
  if (isFixed(id)) return [...ids];
  const sortableIndexes: number[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    if (!isFixed(ids[i])) sortableIndexes.push(i);
  }
  const from = sortableIndexes.indexOf(index);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= sortableIndexes.length) return [...ids];
  const target = sortableIndexes[to];
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * 拖拽排序：把入口放到 `toIndex`（**最终数组下标**，含固定入口）。
 *
 * 与 `moveEntryInList` 共用同一套固定项语义：固定入口原地不动，普通入口可以
 * 跨过它们；因此先把目标索引钳制到「可排序段」内（左侧设置固定在末尾、
 * 胶囊 Agent 状态球固定在端头），再在去掉被拖行后的数组里插入，最后把固定项
 * 钉回它原来的绝对下标。这样：
 * - 拖到固定项附近不会产生「普通入口跑到锁定项之后」的非法顺序，
 *   下一次读取归一化时也就不需要再纠正，UI 与持久化结果一致；
 * - 成员集合（显隐）完全不变，只改变顺序；
 * - 目标索引越界（拖过列表末端）按边界收敛，不抛错、不丢项。
 */
export function moveEntryToIndex(
  ids: readonly string[],
  id: string,
  toIndex: number,
  isFixed: (id: string) => boolean = () => false,
): string[] {
  const from = ids.indexOf(id);
  if (from < 0 || isFixed(id)) return [...ids];
  const others = ids.filter((entryId) => entryId !== id);
  if (others.length === 0) return [...ids];

  // 可排序段边界：首尾连续固定项之间的区间。归一化保证固定项只在两端，
  // 这里对中间出现的固定项同样安全（仅参与钉回，不参与钳制）。
  let first = 0;
  while (first < ids.length && isFixed(ids[first])) first += 1;
  let last = ids.length - 1;
  while (last >= 0 && isFixed(ids[last])) last -= 1;
  const lower = Math.min(first, last);
  const upper = Math.max(lower, last);
  const target = Math.min(Math.max(toIndex, lower), upper);

  const inserted = [...others];
  inserted.splice(Math.min(target, inserted.length), 0, id);

  // 固定项钉回原绝对下标：普通入口的插入不会间接挪走固定项。
  const pinned = ids
    .map((entryId, index) => ({ entryId, index }))
    .filter(({ entryId }) => isFixed(entryId));
  if (pinned.length === 0) return inserted;
  const next = inserted.filter((entryId) => !isFixed(entryId));
  for (const { entryId, index } of pinned) {
    next.splice(Math.min(index, next.length), 0, entryId);
  }
  return next;
}

function sanitizeSurfaceList(
  value: unknown,
  surface: NavSurface,
): { ids: string[]; dropped: number } {
  const allowed = new Set<string>(entriesForSurface(surface).map((entry) => entry.id));
  const seen = new Set<string>();
  let dropped = 0;
  if (!Array.isArray(value)) return { ids: [], dropped: 0 };
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item) || seen.has(item)) {
      dropped += 1;
      continue;
    }
    seen.add(item);
  }
  return { ids: [...seen], dropped };
}

function knownIds(value: unknown, surface: NavSurface): Set<string> {
  const allowed = new Set<string>(entriesForSurface(surface).map((entry) => entry.id));
  if (!Array.isArray(value)) return new Set(allEntryIds(surface));
  const set = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && allowed.has(item)) set.add(item);
  }
  return set;
}

/**
 * 归一化任意来源的布局配置。
 *
 * 合并规则（每个界面独立执行）：
 * - 输入中能识别的 ID 保留原有顺序与显隐；
 * - 输入数组里出现但不在 `known` 快照中的 ID，同样视为已知（避免误当新入口恢复）；
 * - 不存在于输入、且不在 `known` 快照中的 ID = 新入口：按默认可见决定是否补齐，
 *   补齐位置按注册中心默认顺序；
 * - 输出 `known` 更新为当前注册中心全部入口，供下一次写入使用。
 */
export function normalizeNavigationLayout(raw: unknown): NavLayoutNormalization {
  const fallback = defaultNavigationLayout();
  if (!isRecord(raw) || !Array.isArray(raw.left) || !Array.isArray(raw.capsule)) {
    return { config: fallback, migrated: false, dropped: 0, source: "default" };
  }

  const declared = typeof raw.version === "number" ? raw.version : 0;
  const migrated = declared !== NAV_LAYOUT_VERSION;
  const known = isRecord(raw.known) ? raw.known : null;

  let dropped = 0;
  const surfaces: NavSurface[] = ["left", "capsule"];
  const visible: Record<NavSurface, string[]> = { left: [], capsule: [] };

  for (const surface of surfaces) {
    const sanitized = sanitizeSurfaceList(raw[surface], surface);
    dropped += sanitized.dropped;
    const persistedKnown = knownIds(known?.[surface], surface);
    // 输入里实际出现的 ID 一律视为已知：即使 known 快照不完整，也不能把用户
    // 明确保留的入口当作「新增」重新排序或重新显示。
    for (const id of sanitized.ids) persistedKnown.add(id);

    let merged = [...sanitized.ids];
    for (const entry of entriesForSurface(surface)) {
      // 系统锁定入口必须始终可达：旧配置缺失、损坏或人为删除都补回默认位置。
      if (entry.locked) {
        merged = insertEntryByDefaultOrder(merged, entry.id, surface);
        continue;
      }
      if (persistedKnown.has(entry.id)) continue; // 老入口：缺失 = 用户隐藏
      if (!entry.defaults[surface].visible) continue; // 新入口默认隐藏
      merged = insertEntryByDefaultOrder(merged, entry.id, surface);
    }
    // 胶囊 Agent 状态球规范位置：可见数组端头（开头）。渲染层由 CapsuleRail
    // 的独立区域绘制，数组位置不影响界面；收敛持久化模型让旧配置自愈
    // （Agent 曾被历史排序夹在普通分类之间），普通分类的相对顺序保持不变，
    // 「恢复默认 / 用户排序」的边界因此可预期。
    if (surface === "capsule") {
      const statusIds = merged.filter((id) => navEntry(id)?.kind === "agent-status");
      if (statusIds.length > 0) {
        merged = [
          ...statusIds,
          ...merged.filter((id) => navEntry(id)?.kind !== "agent-status"),
        ];
      }
    }
    // 排序不变量：锁定入口固定在可见数组末尾。
    // 旧配置/手工改库可能把锁定入口留在中间（历史 moveEntryInList 允许与它
    // 交换），这里统一收敛，保证「普通入口的上下移动」永远不会间接移动它，
    // 也让「恢复默认」与用户排序的边界可预期。锁定入口之间的相对顺序保持。
    const lockedIds = merged.filter((id) => navEntry(id)?.locked);
    if (lockedIds.length > 0) {
      merged = [...merged.filter((id) => !navEntry(id)?.locked), ...lockedIds];
    }
    visible[surface] = merged;
  }

  return {
    config: {
      version: NAV_LAYOUT_VERSION,
      left: visible.left,
      capsule: visible.capsule,
      known: { left: allEntryIds("left"), capsule: allEntryIds("capsule") },
    },
    migrated,
    dropped,
    source: "settings",
  };
}

/** 某界面的可见入口 ID（数组顺序即排序）。 */
export function visibleEntryIds(config: NavLayoutConfig, surface: NavSurface): string[] {
  return config[surface];
}

/** 入口在某界面是否可见。 */
export function isEntryVisible(
  config: NavLayoutConfig,
  surface: NavSurface,
  id: string,
): boolean {
  return config[surface].includes(id);
}

/** 逻辑 Tab 的左侧入口是否被隐藏（通知 / 快捷键跳转时用于判断回显需求）。 */
export function isTabHidden(config: NavLayoutConfig, tab: Tab): boolean {
  const entry = leftEntryForTab(tab);
  return entry ? !config.left.includes(entry.id) : false;
}

/**
 * 隐藏当前入口时自动切换的「安全页」：
 * 优先任务页（最高频）；否则取左侧第一个仍可见入口覆盖的页面；
 * 左侧全部隐藏时回退设置页（页面本身仍可被深链打开，不产生导航死路）。
 *
 * `collectionSub` 只影响合并入口（收集与暂存）：它覆盖 inbox + shelf 两个逻辑 Tab，
 * 恢复目标必须落在用户当时所在的子页，否则「隐藏当前入口」会顺带把暂存架重置回
 * 快速收集。`notes` 没有独立逻辑 Tab，按 inbox 承载，子页状态由调用方在切页后恢复。
 */
export function safeTabForHiddenEntry(
  config: NavLayoutConfig,
  collectionSub?: "inbox" | "shelf" | "notes",
): Tab {
  // 只在「可排序」入口里找落点：锁定入口（设置）是导航自定义的兜底，
  // 不应成为隐藏普通入口后的默认首页；只剩锁定入口时回到设置。
  // 资源管理是普通入口，与其他页面一样可作为正常落点。
  const sortable = config.left
    .map((id) => navEntry(id))
    .filter((entry): entry is NonNullable<ReturnType<typeof navEntry>> => !!entry && !entry.locked);
  const tasks = sortable.find((entry) => entry.tabs.includes("tasks"));
  if (tasks) return "tasks";
  const first = sortable[0];
  if (!first) return "settings";
  if (first.kind === "merged") return collectionSub === "shelf" ? "shelf" : "inbox";
  return first.tabs[0] ?? "settings";
}

// ── 旧版 localStorage 配置迁移（只读；新配置一律写 SQLite）───────────────
//
// v1 之前导航显隐存在 `localStorage["taskdock.nav.visibility.v1"]`，只记录
// 「左侧隐藏了哪些入口」。迁移策略：
// - 只在 `navigation_layout` 尚未写入时执行一次；
// - 迁移成功前不删除旧键，失败时保留原配置并允许下次启动重试；
// - 旧版没有胶囊配置，胶囊一律沿用注册中心默认值，不把左侧隐藏误套到胶囊。

/** 旧版 localStorage 键：仅用于迁移读取，不再写入。 */
export const LEGACY_NAV_VISIBILITY_STORAGE_KEY = "taskdock.nav.visibility.v1";

/** 读取旧版隐藏入口 ID；损坏 / 不可用时返回空数组，绝不抛错。 */
export function readLegacyHiddenEntryIds(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(LEGACY_NAV_VISIBILITY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    const hidden = isRecord(parsed) ? parsed.hidden : undefined;
    if (!Array.isArray(hidden)) return [];
    const allowed = new Set<string>(allEntryIds("left"));
    const seen = new Set<string>();
    for (const item of hidden) {
      if (typeof item === "string" && allowed.has(item) && !seen.has(item)) seen.add(item);
    }
    return [...seen];
  } catch {
    return [];
  }
}

/**
 * 把旧版隐藏列表套到新布局上（纯函数，便于单测）：
 * 只影响完整面板；胶囊保持默认。迁移后用户仍可在设置页重新开启或隐藏。
 */
export function applyLegacyHiddenEntries(
  layout: NavLayoutConfig,
  hidden: readonly string[],
): NavLayoutConfig {
  const locked = new Set<string>(
    entriesForSurface("left")
      .filter((entry) => entry.locked)
      .map((entry) => entry.id),
  );
  return {
    ...layout,
    // 旧数据试图隐藏锁定入口（设置）时不生效，保证总有配置入口。
    left: layout.left.filter((id) => !hidden.includes(id) || locked.has(id)),
  };
}
