// 工具使用痕迹：最近使用工具、取色历史。放 kv 表而不是新表：
// 数据量小（最近工具 ≤12、颜色 ≤60），无需索引与关联；写失败不会影响工具主流程。
//
// 注意：这里只记录**工具 id 与颜色值**，不记录任何输入正文/图片/请求内容。
import { getSetting, setSetting } from "./kv";

const RECENT_TOOLS_KEY = "tools.recent.v1";
const COLOR_HISTORY_KEY = "tools.colors.v1";
const RECENT_LIMIT = 12;
const COLOR_LIMIT = 60;

export interface RecentToolUse {
  id: string;
  at: number;
  count: number;
}

/** 最近使用变化订阅：工具页常驻挂载，需要在不重新进 Tab 的情况下刷新「最近使用」。 */
const recentListeners = new Set<() => void>();

export function subscribeRecentTools(listener: () => void): () => void {
  recentListeners.add(listener);
  return () => {
    recentListeners.delete(listener);
  };
}

function parseJsonArray(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function listRecentTools(): Promise<RecentToolUse[]> {
  const rows = parseJsonArray(await getSetting(RECENT_TOOLS_KEY));
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row != null)
    .map((row) => ({
      id: typeof row.id === "string" ? row.id : "",
      at: typeof row.at === "number" ? row.at : 0,
      count: typeof row.count === "number" ? row.count : 1,
    }))
    .filter((row) => row.id.length > 0)
    .sort((left, right) => right.at - left.at)
    .slice(0, RECENT_LIMIT);
}

/** 记录一次工具进入：同一 id 去重并前移，保留次数用于排序兜底。 */
export async function recordToolUse(id: string): Promise<void> {
  const current = await listRecentTools();
  const existing = current.find((row) => row.id === id);
  const next: RecentToolUse[] = [
    { id, at: Date.now(), count: (existing?.count ?? 0) + 1 },
    ...current.filter((row) => row.id !== id),
  ].slice(0, RECENT_LIMIT);
  await setSetting(RECENT_TOOLS_KEY, JSON.stringify(next));
  for (const listener of [...recentListeners]) listener();
}

export async function clearRecentTools(): Promise<void> {
  await setSetting(RECENT_TOOLS_KEY, "[]");
}

export interface SavedColor {
  /** #RRGGBB（统一大写） */
  hex: string;
  at: number;
  favorite: boolean;
  /** 来源说明，例如「取色器」；不含图片路径 */
  source: string;
}

function normalizeHex(value: string): string | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  return match ? `#${match[1].toUpperCase()}` : null;
}

export async function listSavedColors(): Promise<SavedColor[]> {
  const rows = parseJsonArray(await getSetting(COLOR_HISTORY_KEY));
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row != null)
    .map((row) => ({
      hex: typeof row.hex === "string" ? normalizeHex(row.hex) ?? "" : "",
      at: typeof row.at === "number" ? row.at : 0,
      favorite: row.favorite === true,
      source: typeof row.source === "string" ? row.source : "",
    }))
    .filter((row) => row.hex.length === 7)
    .sort((left, right) => {
      if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
      return right.at - left.at;
    })
    .slice(0, COLOR_LIMIT);
}

/** 记录取色：同色去重（保留收藏状态并前移），超出上限裁剪最旧的非收藏项。 */
export async function recordColor(hex: string, source = "取色器"): Promise<void> {
  const normalized = normalizeHex(hex);
  if (!normalized) return;
  const current = await listSavedColors();
  const existing = current.find((row) => row.hex === normalized);
  const rest = current.filter((row) => row.hex !== normalized);
  const next = [{ hex: normalized, at: Date.now(), favorite: existing?.favorite ?? false, source }, ...rest];
  const favorites = next.filter((row) => row.favorite);
  const others = next.filter((row) => !row.favorite).slice(0, Math.max(0, COLOR_LIMIT - favorites.length));
  await setSetting(
    COLOR_HISTORY_KEY,
    JSON.stringify([...favorites, ...others].sort((left, right) => right.at - left.at)),
  );
}

export async function toggleColorFavorite(hex: string): Promise<void> {
  const normalized = normalizeHex(hex);
  if (!normalized) return;
  const current = await listSavedColors();
  const existing = current.find((row) => row.hex === normalized);
  if (!existing) {
    await recordColor(normalized);
    const after = await listSavedColors();
    if (after[0]?.hex === normalized) await toggleColorFavorite(normalized);
    return;
  }
  const next = current.map((row) => (row.hex === normalized ? { ...row, favorite: !row.favorite } : row));
  await setSetting(COLOR_HISTORY_KEY, JSON.stringify(next));
}

export async function removeColor(hex: string): Promise<void> {
  const current = await listSavedColors();
  await setSetting(
    COLOR_HISTORY_KEY,
    JSON.stringify(current.filter((row) => row.hex !== hex)),
  );
}

export async function clearColors(): Promise<void> {
  await setSetting(COLOR_HISTORY_KEY, "[]");
}
