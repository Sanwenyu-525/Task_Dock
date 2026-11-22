//! 窗口尺寸与断点的唯一事实源（桌面端，2026-11-16）。
//!
//! 与 Rust `src-tauri/src/window_layout.rs` 成对存在：
//! - Rust 侧决定**原生窗口**能有多大/多小（`min_inner_size`、跨屏重算）；
//! - 这里只给前端提供同一组数字，供外壳判断「窗口档位」与测试守卫比对；
//! - CSS 侧同名的 `--layout-window-*` Token 在 `styles.css` 定义，`layoutMetrics.test.ts`
//!   会校验三处数字一致，防止某个模块悄悄另起一套断点。
//!
//! 注意：内容区仍然按**容器宽度**响应（见 `docs/ui-responsive-layout.md`）。
//! 这里的窗口档位只用于「窗口 chrome」（顶栏工具收纳、右栏显隐）这种
//! 天然与窗口等宽的结构，不用于页面卡片列数。

/** 大型完整工作台窗口几何（DIP，必须与 Rust 常量一致）。 */
export const WINDOW_METRICS = {
  workbench: {
    defaultWidth: 1200,
    defaultHeight: 760,
    minWidth: 960,
    minHeight: 600,
    /** 屏幕可用区不足时的布局下限；低于它直接等于可用区。 */
    floorWidth: 720,
    floorHeight: 480,
  },
} as const;

/**
 * 窗口档位（CSS px = DIP）。只描述「窗口有多宽」，不是内容断点：
 * - `full`：≥1100，三栏 + 顶栏全量控件；
 * - `compact`：900–1099，收起右侧上下文栏，顶栏隐藏快捷键/品牌名等低优先信息；
 * - `narrow`：780–899，工具组收纳进「更多」菜单；
 * - `cramped`：<780，顶栏换行，项目选择器独占第二行（仅小屏降级窗口会到这里）。
 *
 * 阈值口径：下列数值是「低于该值进入下一档」的**排他下界**，对应 CSS
 * `@media (max-width: <阈值−1>px)`。另有一个 inclusive 上界常量
 * `ULTRA_NARROW_WIDTH`（≤560，图标轨兜底带），口径不同，不要混用。
 */
export const WINDOW_TIERS = {
  compact: 1100,
  narrow: 900,
  cramped: 780,
} as const;

/**
 * 超窄「图标轨」兜底宽度（DIP，含边界：`≤560`）。
 *
 * 这**不是第五个窗口档位**：`WindowTier` 仍是 full/compact/narrow/cramped 四档，
 * 560 以下在 `windowTier` 里归入 `cramped`。它是 cramped 档内的附加兜底带子，
 * 由 CSS `@media (max-width: 560px)` 命中：工作台顶栏图标轨（窗口控制绝对定位、
 * 搜索收成 32px 图标）、导航极窄规则；同一边界也被主窗（400×560）页头的视口
 * 兜底规则复用——主窗没有 `.wb-content` 容器，容器查询不生效，只能用视口断点
 * 兜同一套换行。
 *
 * 可达性：Rust 侧 `clamp_floor` 在小屏可用区不足时跟随可用区（≥320 DIP），远程
 * 桌面/极小屏上工作台窗口可以落到 560 以下，因此这档是真实兜底，不是死代码。
 */
export const ULTRA_NARROW_WIDTH = 560 as const;

/** 窗口宽度是否进入超窄图标轨兜底带（≤560 DIP）。 */
export function isUltraNarrow(width: number): boolean {
  return width <= ULTRA_NARROW_WIDTH;
}

/**
 * 全局搜索的共享几何（CSS px）。
 *
 * 顶栏搜索框与结果面板是两件事：字段更窄（不挤压项目选择器/窗口控制）；
 * **模态**面板更宽（结果标题/分类按钮要完整显示），**下拉**面板则与
 * 字段严格等宽（`Popover widthMode="exact-match"`，2026-11-22）。
 * 同源关系：
 * - `--layout-search-max` / `--layout-search-basis` / `--layout-search-min`：
 *   顶栏字段（`workbench.css`；下拉面板的 min-width 兜底也用它）
 * - `--layout-search-panel-max`：模态结果面板（`global-search.css` 的 .gs-panel）
 * - `GlobalSearchDialog` 的 `maxWidth`（浮层基元的可用宽兜底）
 * `layoutMetrics.test.ts` 会校验 CSS 与本文件一致。
 */
export const SEARCH_METRICS = {
  /** 顶栏搜索字段最大宽度 */
  fieldMax: 392,
  /** 顶栏搜索字段的 flex-basis（窗口变宽时的增长起点） */
  fieldBasis: 268,
  /** 搜索结果面板（模态与下拉共用）最大宽度 */
  panelMax: 472,
} as const;

export type WindowTier = "full" | "compact" | "narrow" | "cramped";

/** 按窗口 CSS 宽度判定档位。 */
export function windowTier(width: number): WindowTier {
  if (width < WINDOW_TIERS.cramped) return "cramped";
  if (width < WINDOW_TIERS.narrow) return "narrow";
  if (width < WINDOW_TIERS.compact) return "compact";
  return "full";
}

/**
 * 工作台在该窗口宽度下是否需要收起右栏（`compact`）。
 * 阈值取 `WINDOW_TIERS.compact`：125% DPI 的 1280×820 物理窗口 = 1024 CSS px
 * 也必须收起，否则导航 200 + 详情 304 + 主内容会让右栏被裁到屏幕外。
 */
export function shouldCollapseWorkbenchDetail(width: number): boolean {
  return width < WINDOW_TIERS.compact;
}
