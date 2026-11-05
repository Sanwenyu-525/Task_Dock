//! 胶囊应用网格的展示顺序（纯函数 + 本机持久化）。
//!
//! 产品约束（2026-11-05）：
//! - 「添加应用」加号是网格里的**普通可排序项**，不是绝对定位的浮层；
//! - 默认顺序 = 应用列表自然顺序（收藏 → 最近 → 名称），加号在末尾；
//! - 用户拖动（或 Alt+左右方向键）后切换为手动顺序并持久化；
//! - 加号不是应用，不写入 `navigation_targets`，也不参与使用次数统计；
//! - 搜索过滤、应用增删都不得让加号无故改变相对位置：
//!   - 加号之后新增的应用追加在整体顺序末尾，加号本身不动；
//!   - 搜索时加号仍放在「它前面仍匹配的应用」之后；前面的匹配项被过滤掉时，
//!     加号自然前移，而不是固定跳到末尾或开头。
//!
//! 排序状态只影响展示，不改变后端数据；存储不可用时退化为会话内顺序。

export const APP_ADD_KEY = "__taskdock_app_add__";
export const APP_GRID_ORDER_KEY = "taskdock.apps.grid.order.v1";
const MAX_ORDER = 500;

export type AppGridEntry<T> =
  | { type: "app"; id: string; app: T }
  | { type: "add"; id: typeof APP_ADD_KEY };

function storageOrNull(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** 归一化持久化顺序：去重、丢弃非法值、保留加号的唯一位置。 */
export function normalizeAppGridOrder(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string" || !value) continue;
    if (value !== APP_ADD_KEY && value.length > 200) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= MAX_ORDER) break;
  }
  return out.length > 0 ? out : null;
}

/** 读取手动顺序；缺失/损坏/版本不符返回 null（使用自然顺序）。 */
export function readAppGridOrder(): string[] | null {
  const storage = storageOrNull();
  if (!storage) return null;
  try {
    const raw = storage.getItem(APP_GRID_ORDER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      (parsed as { version?: unknown }).version !== 1
    ) {
      return null;
    }
    const list =
      typeof parsed === "object" && parsed !== null && "order" in parsed
        ? (parsed as { order: unknown }).order
        : parsed;
    return normalizeAppGridOrder(list);
  } catch {
    return null;
  }
}

/** 写入手动顺序；失败不影响当前交互（仅本会话生效）。 */
export function writeAppGridOrder(order: readonly string[]): void {
  const normalized = normalizeAppGridOrder(order);
  const storage = storageOrNull();
  if (!storage) return;
  try {
    if (normalized === null) storage.removeItem(APP_GRID_ORDER_KEY);
    else
      storage.setItem(
        APP_GRID_ORDER_KEY,
        JSON.stringify({ version: 1, order: normalized }),
      );
  } catch {
    // 配额满 / 隐私模式：保持内存态，不阻断操作。
  }
}

/** 仅供测试：清除持久化顺序。 */
export function clearAppGridOrder(): void {
  const storage = storageOrNull();
  try {
    storage?.removeItem(APP_GRID_ORDER_KEY);
  } catch {
    // 忽略。
  }
}

/**
 * 生成网格项（应用 + 加号）。
 *
 * `apps` 必须已经是自然展示顺序；`saved` 是用户手动顺序（null = 从未排序）。
 * 返回的新数组包含所有传入应用与**恰好一个**加号。
 */
export function buildAppGrid<T extends { id: string }>(
  apps: readonly T[],
  saved: readonly string[] | null,
): AppGridEntry<T>[] {
  const byId = new Map(apps.map((app) => [app.id, app]));
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (seen.has(id)) return;
    if (id !== APP_ADD_KEY && !byId.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  if (saved) {
    for (const id of saved) push(id);
  }
  // 手动顺序之后新增的应用追加到末尾；加号若从未记录位置，同样补在末尾。
  for (const app of apps) push(app.id);
  push(APP_ADD_KEY);

  return ids.map<AppGridEntry<T>>((id) =>
    id === APP_ADD_KEY
      ? { type: "add", id: APP_ADD_KEY }
      : { type: "app", id, app: byId.get(id)! },
  );
}

/** 把顺序数组中的 `dragId` 移到 `targetId` 之前/之后；返回新数组。 */
export function moveAppGridId(
  order: readonly string[],
  dragId: string,
  targetId: string,
  after: boolean,
): string[] {
  if (dragId === targetId) return [...order];
  const from = order.indexOf(dragId);
  const target = order.indexOf(targetId);
  if (from < 0 || target < 0) return [...order];
  const next = [...order];
  next.splice(from, 1);
  const targetAt = next.indexOf(targetId);
  next.splice(targetAt + (after ? 1 : 0), 0, dragId);
  return next;
}

/**
 * 键盘移动：把 `id` 向前/后移动一格。
 * 加号与应用一样参与排序，但不越过数组边界。
 */
export function moveAppGridBy(
  order: readonly string[],
  id: string,
  delta: -1 | 1,
): string[] {
  const from = order.indexOf(id);
  if (from < 0) return [...order];
  const to = from + delta;
  if (to < 0 || to >= order.length) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/**
 * 按搜索匹配集合过滤网格项，同时保持加号的相对位置。
 * `matchedAppIds` 为 null 表示不过滤（全部应用）。
 */
export function filterAppGrid<T>(
  entries: readonly AppGridEntry<T>[],
  matchedAppIds: ReadonlySet<string> | null,
): AppGridEntry<T>[] {
  if (matchedAppIds === null) return [...entries];
  return entries.filter(
    (entry) => entry.type === "add" || matchedAppIds.has(entry.id),
  );
}
