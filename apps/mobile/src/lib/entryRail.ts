// 工作台快捷入口横向轨道（2026-11-16）：只算几何，不碰视图。
//
// 改造前是「固定列数（窄屏 2 列 / 其余 4 列）+ flexWrap」：入口超过列数就换行，
// 320dp 窄屏下 4 个入口直接排成两行——首页纵向空间被入口数量牵着走。
//
// 这里只负责一件事：给定「轨道可视宽度 + 入口数量 + 字体缩放」，算出每个磁贴的
// 宽高、步进、内容总宽、是否溢出、最大滚动偏移。视图层
// （components/entry/WorkbenchEntryRail.tsx）只消费这些数字，于是「会不会换行」
// 「能不能滚」「最后一个入口能不能完整露出来」都能在单测里穷举，而不是靠真机试。
//
// 三条规则（与需求一一对应）：
// 1. 单行：这里根本不产出「行数」，磁贴宽度只和可用宽度有关，入口再多也不换行；
// 2. 动态：能放几个由宽度算（4 个一行的基准宽度），大屏上 5、6 个可以同时完整显示；
// 3. 不缩图标：宽度有下限（大字号再抬一档），放不下就滚动，不靠压窄磁贴硬塞。
//
// 约束：纯函数，不得 import react / react-native。
import { font, space } from "../theme/tokens";
import { LARGE_FONT_SCALE } from "./responsiveLayout";

/** 磁贴间距：沿用改造前的 space.sm，视觉密度不变 */
export const RAIL_GAP = space.sm;
/** 轨道左右内边距：与页面左右留白一致，滑动时第一个 / 最后一个入口不会贴死屏幕边 */
export const RAIL_INSET = space.lg;
/** 常规字号下磁贴最小宽度（触控区仍 ≥ 44dp，标签 2 行可读） */
export const RAIL_MIN_TILE = 60;
/** 大字号下文本变宽，最小宽度抬一档，避免名称被压成省略号 */
export const RAIL_MIN_TILE_LARGE_FONT = 72;
/** 单入口 / 两入口时的宽度上限：不允许为了填满一行把磁贴无限放大 */
export const RAIL_MAX_TILE = 104;
/**
 * 溢出时从「刚好 4 个一行」的宽度里再让出一点，让第 5 个入口露出边缘。
 * 这是滑动提示的天然载体；不让出时第 5 个入口正好被切在屏幕外，看不出还能滑。
 */
export const RAIL_PEEK = space.sm;
/** 名称最多两行：与改造前一致，长名称换行而不是省略成「本机素…」 */
export const RAIL_TILE_LINES = 2;

/** 磁贴内部尺寸：与 QuickTile 的视觉常量保持一致 */
export const RAIL_ICON_SIZE = 24;
export const RAIL_ICON_GAP = 6;
export const RAIL_TILE_PADDING_Y = space.sm;
export const RAIL_BASE_TILE_HEIGHT = 78;

export interface RailMetrics {
  /** 磁贴宽度（0 = 没有可展示的入口） */
  tileWidth: number;
  /** 磁贴高度：只与字号缩放有关，与入口数量无关 */
  tileHeight: number;
  /** 相邻磁贴的横向步进 = 宽度 + 间距（吸附与拖拽落位共用） */
  gap: number;
  step: number;
  /** 全部磁贴 + 间距的内容宽度（不含左右内边距） */
  contentSpan: number;
  /** 轨道可视宽度（通栏，含左右内边距） */
  viewportWidth: number;
  /** 内容是否超出可视宽度：false 时不应启用吸附，也不该出现滑动提示 */
  scrollable: boolean;
  /** 最大滚动偏移（含左右内边距；0 表示不需要滚动） */
  maxOffset: number;
  /** 起始位置（偏移 0）能完整看到的入口数，供验收与诊断使用 */
  visibleCount: number;
}

/** 名称行高：显式算出来，系统字体放大时不会把两行文字裁掉半行 */
export function entryTileLineHeight(fontScale: number): number {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return Math.max(14, Math.round(font.label * 1.2 * scale));
}

/**
 * 磁贴高度。
 *
 * 只由「内边距 + 图标 + 间距 + 两行名称」决定；入口数量不参与计算，
 * 所以从 1 个加到 20 个，轨道高度不变。
 */
export function entryTileHeight(fontScale: number): number {
  const lineHeight = entryTileLineHeight(fontScale);
  const content =
    RAIL_TILE_PADDING_Y * 2 + RAIL_ICON_SIZE + RAIL_ICON_GAP + lineHeight * RAIL_TILE_LINES;
  return Math.max(RAIL_BASE_TILE_HEIGHT, content);
}

/** 磁贴最小宽度：大字号时抬高，避免名称被压成一行省略号 */
export function railMinTileWidth(fontScale: number): number {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return scale >= LARGE_FONT_SCALE ? RAIL_MIN_TILE_LARGE_FONT : RAIL_MIN_TILE;
}

/**
 * 轨道几何。
 *
 * 计算顺序与需求里的判定链一致：可见入口数量 → 可用宽度 → 合理磁贴尺寸与间距
 * → 内容是否超出 → 未超出就完整展示、超出就允许横向滚动。这里没有任何
 * 「数量 > 4 就强制只显示 4 个」的分支：4 只是「一行基准宽度」的除数。
 */
export function railMetrics(
  viewportWidth: number,
  count: number,
  fontScale = 1,
): RailMetrics {
  const viewport = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const tileHeight = entryTileHeight(fontScale);
  const strip = Math.max(0, viewport - RAIL_INSET * 2);

  if (safeCount === 0 || strip <= 0) {
    return {
      tileWidth: 0,
      tileHeight,
      gap: RAIL_GAP,
      step: 0,
      contentSpan: 0,
      viewportWidth: viewport,
      scrollable: false,
      maxOffset: 0,
      visibleCount: 0,
    };
  }

  // 一行基准宽度：按「最多 4 个并排」取宽，少于此数时磁贴会变宽（受上限约束）。
  const baseCount = Math.min(safeCount, 4);
  const baseWidth = (strip - RAIL_GAP * (baseCount - 1)) / baseCount;
  // 只有真的溢出（数量超过基准列数）才让出 peek；1~4 个不做无意义的留白。
  const peek = safeCount > baseCount ? RAIL_PEEK : 0;
  const minTile = railMinTileWidth(fontScale);
  const tileWidth = Math.round(
    Math.min(Math.max(baseWidth - peek, minTile), RAIL_MAX_TILE),
  );

  const contentSpan = safeCount * tileWidth + RAIL_GAP * (safeCount - 1);
  const maxOffset = Math.max(0, contentSpan + RAIL_INSET * 2 - viewport);
  const step = tileWidth + RAIL_GAP;
  const visibleCount = Math.min(
    safeCount,
    Math.max(1, Math.floor((strip + RAIL_GAP) / Math.max(1, step))),
  );

  return {
    tileWidth,
    tileHeight,
    gap: RAIL_GAP,
    step,
    contentSpan,
    viewportWidth: viewport,
    // 亚像素误差不算「需要滚动」，否则 4 个入口刚好铺满时会多出一次无意义吸附
    scrollable: maxOffset > 1,
    maxOffset,
    visibleCount,
  };
}

/** 把任意滚动偏移收敛到 [0, maxOffset]：入口变少 / 排序后位置失效时用它修正 */
export function clampRailOffset(offset: number, maxOffset: number): number {
  const max = Number.isFinite(maxOffset) ? Math.max(0, maxOffset) : 0;
  const value = Number.isFinite(offset) ? offset : 0;
  return Math.min(Math.max(value, 0), max);
}
