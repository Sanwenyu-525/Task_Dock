/**
 * 应用搜索（选择器 / 应用中心 / 胶囊共用，规则一致、数据范围各自独立）。
 *
 * 规则：
 * - 中文只做连续子串匹配（微信命中「微信」「企业微信」「微信开发者工具」「微信读书」，
 *   「微开」不命中「微信开发者工具」）；不做拼音、不做跨字组合、不做纠错；
 * - 英文大小写不敏感（WECHAT = wechat = WeChat）；
 * - 别名只做「补充可搜索词」，不覆盖展示名；别名按真实身份绑定（exe 文件名 / AUMID），
 *   不因共享单词把不同程序判成同一个；
 * - 搜索字段：显示名、别名、exe 文件名、应用身份、已保存目标的自定义名；
 * - 排序：展示名/自定义名完全匹配 → 前缀 → 包含 → 别名/exe/身份匹配。
 */

export interface SearchableApp {
  /** 稳定应用身份（扫描用 app_key，已保存目标用 target id） */
  key: string;
  displayName: string;
  category?: string;
  /** 可执行文件完整路径（用于取文件名与别名身份判定） */
  exePath?: string;
  /** 应用身份（app_key / AUMID） */
  identity?: string;
  /** 已保存目标的自定义名称 */
  customName?: string;
}

interface AliasRule {
  aliases: string[];
  /** 只按真实身份命中；display 仅用于少数没有 exe 的商店应用 */
  match: (exeLower: string, exeStem: string, displayLower: string) => boolean;
}

const ALIAS_RULES: AliasRule[] = [
  {
    aliases: ["微信", "WeChat", "Weixin"],
    // 主程序 Weixin.exe / WeChat.exe；不含「微信开发者工具」（exe 名是中文）
    match: (_exe, stem) => stem === "wechat" || stem === "weixin",
  },
  {
    aliases: ["企业微信", "WeCom", "WeChat Work"],
    match: (_exe, stem) => stem === "wecom" || stem === "wxwork" || stem === "wechatwork",
  },
  {
    aliases: ["QQ", "Tencent QQ"],
    // 精确 qq.exe，避免把 QQ音乐(qqmusic)、QQ浏览器(qqbrowser) 当成 QQ
    match: (_exe, stem) => stem === "qq",
  },
  {
    aliases: ["酷狗音乐", "KuGou"],
    match: (_exe, stem) => stem.includes("kugou"),
  },
  {
    aliases: ["Visual Studio Code", "VS Code", "VSCode"],
    match: (_exe, stem) => stem === "code",
  },
];

function exeStemOf(item: SearchableApp): string {
  const raw = (item.exePath || item.identity || "").toLowerCase();
  const file = raw.split(/[\\/]/).pop() ?? "";
  return file.replace(/\.exe$/, "");
}

function aliasesFor(item: SearchableApp): string[] {
  const exe = (item.exePath ?? "").toLowerCase();
  const stem = exeStemOf(item);
  const display = item.displayName.toLowerCase();
  return ALIAS_RULES.filter((r) => r.match(exe, stem, display)).flatMap((r) => r.aliases);
}

/** 单条应用的匹配等级：0 完全匹配，1 前缀，2 包含，3 别名/文件名/身份。未命中返回 null。 */
export function matchRank(item: SearchableApp, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const names = [item.displayName, item.customName ?? ""]
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.some((n) => n === q)) return 0;
  if (names.some((n) => n.startsWith(q))) return 1;
  if (names.some((n) => n.includes(q))) return 2;

  const stem = exeStemOf(item);
  const identity = (item.identity ?? "").toLowerCase();
  if (stem.includes(q) || identity.includes(q)) return 3;

  if (aliasesFor(item).some((a) => a.toLowerCase().includes(q))) return 3;
  return null;
}

/**
 * 过滤 + 排序。`category` 不传或 "all" 时不按分类过滤。
 * 返回新数组，不修改入参；相同等级内按展示名排序（中文按 pinyin 顺序的本地化比较）。
 */
export function searchApps<T extends SearchableApp>(
  items: T[],
  query: string,
  opts?: { category?: string },
): T[] {
  const category = opts?.category ?? "all";
  const ranked: Array<{ item: T; rank: number }> = [];
  for (const item of items) {
    if (category !== "all" && item.category !== category) continue;
    const rank = matchRank(item, query);
    if (rank === null) continue;
    ranked.push({ item, rank });
  }
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.item.displayName.localeCompare(b.item.displayName, "zh-Hans-CN");
  });
  return ranked.map((r) => r.item);
}

/** 已保存快捷目标的最小排序字段（完整面板与胶囊共用，避免各自复制一套排序）。 */
export interface TargetSortFields {
  favorite?: boolean | null;
  last_used_at?: string | null;
  display_name: string;
}

/**
 * 快捷目标展示排序：收藏优先 → 最近使用 → 名称。
 * `recent: false` 用于没有最近使用语义的分区（如网址/文件夹）；
 * `favorite: false` 用于「最近使用」筛选，保持该筛选自身的最近优先语义。
 */
export function compareTargetOrder(
  a: TargetSortFields,
  b: TargetSortFields,
  opts?: { recent?: boolean; favorite?: boolean },
): number {
  if (opts?.favorite !== false) {
    const byFavorite = Number(Boolean(b.favorite)) - Number(Boolean(a.favorite));
    if (byFavorite !== 0) return byFavorite;
  }
  if (opts?.recent !== false) {
    const byRecent = (b.last_used_at ?? "").localeCompare(a.last_used_at ?? "");
    if (byRecent !== 0) return byRecent;
  }
  return a.display_name.localeCompare(b.display_name, "zh");
}

/** 返回排序后的新数组，不修改入参。 */
export function sortTargetsForDisplay<T extends TargetSortFields>(
  items: readonly T[],
  opts?: { recent?: boolean; favorite?: boolean },
): T[] {
  return [...items].sort((a, b) => compareTargetOrder(a, b, opts));
}

/** 列表分页大小：不做「只给前 N 条」的假完整，滚到底部/点加载更多继续取。 */
export const APP_PAGE_SIZE = 40;
