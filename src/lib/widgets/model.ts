//! 桌面微件模型：类型、默认布局、校验与排序纯函数。
//!
//! 设计边界（与悬浮胶囊互补，不是第二套胶囊）：
//! - 微件只做「持续展示少量信息」，不承担高频快速操作、停靠磁吸与当前状态入口；
//! - 第一版每个类型最多一个实例，不支持网格自由摆放与插件脚本；
//! - config 只保存展示层参数（条目数量），业务数据一律来自现有 Store / 查询。

export const WIDGET_TYPES = [
  "today-tasks",
  "next-reminder",
  "agent-status",
  "quick-actions",
  "focus-timer",
  "efficiency",
] as const;

export type WidgetType = (typeof WIDGET_TYPES)[number];

export const WIDGET_SIZES = ["sm", "md", "lg"] as const;

export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** 今日任务微件可选的条目上限（与任务页数据共用，不另存缓存）。 */
export const MAX_ITEMS_OPTIONS = [3, 5, 8] as const;

export type MaxItems = (typeof MAX_ITEMS_OPTIONS)[number];

export interface WidgetConfig {
  maxItems?: number;
}

export interface WidgetItem {
  /** 实例标识；第一版与 type 一致（每个类型一个实例）。 */
  widget_id: string;
  type: WidgetType;
  enabled: boolean;
  config: WidgetConfig;
  size: WidgetSize;
  sort_order: number;
}

export interface WidgetDefinition {
  type: WidgetType;
  title: string;
  description: string;
  defaultSize: WidgetSize;
  defaultEnabled: boolean;
  /**
   * 依赖模块说明。null 表示数据完全来自现有模块；
   * 非 null 时由 sources.ts 的对应数据源注入，未注入则显示「等待接入」。
   */
  dependency: "focus" | "efficiency" | null;
}

export const WIDGET_DEFINITIONS: readonly WidgetDefinition[] = [
  {
    type: "today-tasks",
    title: "今日任务",
    description: "今天到期与已逾期的待办，点击直接打开任务详情。",
    defaultSize: "md",
    defaultEnabled: true,
    dependency: null,
  },
  {
    type: "next-reminder",
    title: "下一条提醒",
    description: "复用任务提醒调度，显示最近一条尚未触发的提醒与倒计时。",
    defaultSize: "md",
    defaultEnabled: true,
    dependency: null,
  },
  {
    type: "agent-status",
    title: "Agent 状态",
    description: "复用现有 Agent 快照与事件刷新，只读展示运行中、等待与失败数量。",
    defaultSize: "md",
    defaultEnabled: true,
    dependency: null,
  },
  {
    type: "quick-actions",
    title: "快捷操作",
    description: "打开现有功能页的轻量入口，不复制任务或剪贴板逻辑。",
    defaultSize: "md",
    defaultEnabled: true,
    dependency: null,
  },
  {
    type: "focus-timer",
    title: "专注倒计时",
    description: "显示专注模块的当前阶段与剩余时间；未接入时不显示假倒计时。",
    defaultSize: "sm",
    defaultEnabled: false,
    dependency: "focus",
  },
  {
    type: "efficiency",
    title: "今日效率统计",
    description: "显示统计模块的今日完成率与任务分布；未接入时不显示假统计。",
    defaultSize: "sm",
    defaultEnabled: false,
    dependency: "efficiency",
  },
];

const DEFINITION_BY_TYPE = new Map<WidgetType, WidgetDefinition>(
  WIDGET_DEFINITIONS.map((def) => [def.type, def]),
);

export function widgetDefinition(type: WidgetType): WidgetDefinition {
  const def = DEFINITION_BY_TYPE.get(type);
  // WIDGET_DEFINITIONS 覆盖全部 WIDGET_TYPES，这里只是类型收窄兜底。
  if (!def) throw new Error(`未知微件类型: ${type}`);
  return def;
}

export function isWidgetType(value: unknown): value is WidgetType {
  return typeof value === "string" && (WIDGET_TYPES as readonly string[]).includes(value);
}

export function isWidgetSize(value: unknown): value is WidgetSize {
  return typeof value === "string" && (WIDGET_SIZES as readonly string[]).includes(value);
}

function clampMaxItems(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return Math.min(12, Math.max(1, rounded));
}

/** 按类型收敛 config：只保留已知字段，非法值回落到默认。 */
export function normalizeConfig(type: WidgetType, raw: unknown): WidgetConfig {
  const source = isRecord(raw) ? raw : {};
  if (type === "today-tasks") {
    return { maxItems: clampMaxItems(source.maxItems, 5) };
  }
  return {};
}

export function defaultWidgetItems(): WidgetItem[] {
  return WIDGET_DEFINITIONS.map((def, index) => ({
    widget_id: def.type,
    type: def.type,
    enabled: def.defaultEnabled,
    config: normalizeConfig(def.type, {}),
    size: def.defaultSize,
    sort_order: index,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验并归一化持久化布局：
 * - 未知类型、重复类型、非法字段会被丢弃或回落默认值；
 * - 已知类型按保存顺序重排 sort_order；
 * - 缺失的新类型追加到末尾（使用其默认启用状态），保证升级后可见。
 */
export function normalizeLayout(raw: unknown): WidgetItem[] {
  const out: WidgetItem[] = [];
  const seen = new Set<WidgetType>();

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      const type = entry.type;
      if (!isWidgetType(type) || seen.has(type)) continue;
      const def = widgetDefinition(type);
      seen.add(type);
      out.push({
        widget_id: type,
        type,
        enabled: typeof entry.enabled === "boolean" ? entry.enabled : def.defaultEnabled,
        config: normalizeConfig(type, entry.config),
        size: isWidgetSize(entry.size) ? entry.size : def.defaultSize,
        sort_order: out.length,
      });
    }
  }

  for (const def of WIDGET_DEFINITIONS) {
    if (seen.has(def.type)) continue;
    out.push({
      widget_id: def.type,
      type: def.type,
      enabled: def.defaultEnabled,
      config: normalizeConfig(def.type, {}),
      size: def.defaultSize,
      sort_order: out.length,
    });
  }

  return out;
}

/** 重新编号 sort_order，保证与数组顺序一致。 */
export function withSequentialOrder(widgets: WidgetItem[]): WidgetItem[] {
  return widgets.map((item, index) =>
    item.sort_order === index ? item : { ...item, sort_order: index },
  );
}

/**
 * 把 fromId 移动到 toIndex（按当前数组下标计算，越界自动收敛）。
 * 返回新数组并重新编号；未找到 fromId 时原样返回。
 */
export function moveWidgetTo(widgets: WidgetItem[], fromId: string, toIndex: number): WidgetItem[] {
  const from = widgets.findIndex((item) => item.widget_id === fromId);
  if (from < 0) return widgets;
  const target = Math.min(widgets.length - 1, Math.max(0, Math.round(toIndex)));
  if (from === target) return widgets;
  const next = [...widgets];
  const [moved] = next.splice(from, 1);
  if (!moved) return widgets;
  next.splice(target, 0, moved);
  return withSequentialOrder(next);
}

/** 相对移动（键盘 / 上移下移按钮）。 */
export function moveWidgetBy(widgets: WidgetItem[], id: string, delta: -1 | 1): WidgetItem[] {
  const from = widgets.findIndex((item) => item.widget_id === id);
  if (from < 0) return widgets;
  return moveWidgetTo(widgets, id, from + delta);
}

export function enabledWidgets(widgets: WidgetItem[]): WidgetItem[] {
  return widgets.filter((item) => item.enabled).sort((a, b) => a.sort_order - b.sort_order);
}
