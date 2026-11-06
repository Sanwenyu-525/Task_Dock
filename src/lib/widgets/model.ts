//! 桌面微件模型：类型、默认布局、校验与排序纯函数。
//!
//! 设计边界（与悬浮胶囊互补，不是第二套胶囊）：
//! - 微件只做「持续展示少量信息」，不承担高频快速操作、停靠磁吸与当前状态入口；
//! - 第一版每个类型最多一个实例，不支持网格自由摆放与插件脚本；
//! - config 只保存展示层参数（条目数量），业务数据一律来自现有 Store / 查询。

import type { MessageKey } from "../../i18n";

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

/**
 * 桌面独立窗口配置（与「看板启用」相互独立）。
 *
 * 只存窗口归属信息，不存业务数据；坐标以**归一化锚点**（nx/ny，0~1，相对
 * 显示器工作区）保存，跨显示器/跨设备恢复时按当前显示器重新换算，避免把
 * 物理像素坐标盲搬到另一块屏幕。`width/height` 为 CSS 逻辑像素。
 */
export interface WidgetDesktopState {
  /** 是否在桌面显示独立窗口；与 enabled（看板卡片）互不影响。 */
  visible: boolean;
  /** 用户是否要求「始终置顶」。 */
  topmost: boolean;
  /**
   * 用户**手动缩放**后的自定义逻辑尺寸；缺省表示跟随 `size` 预设。
   * 程序自身 set_size、首次创建测量值不得写入这里，否则切 sm/md/lg 会被旧尺寸覆盖。
   */
  width?: number;
  height?: number;
  /** 窗口左上角在工作区内的归一化锚点（0~1）。 */
  nx?: number;
  ny?: number;
  /** 保存时所在显示器名称快照；找不到时按主显示器恢复。 */
  monitor?: string;
}

export const DEFAULT_DESKTOP_STATE: WidgetDesktopState = {
  visible: false,
  topmost: false,
};

/** 桌面窗口逻辑尺寸上下限；防止手写/损坏配置把窗口缩成不可用或撑满屏幕。 */
export const DESKTOP_WIDTH_RANGE = { min: 220, max: 560 } as const;
export const DESKTOP_HEIGHT_RANGE = { min: 120, max: 640 } as const;

/** 每类微件的桌面窗口预设（CSS 逻辑像素）。内容按该尺寸设计，保证可读且不溢出。 */
const DESKTOP_PRESETS: Record<WidgetType, Record<WidgetSize, { width: number; height: number }>> = {
  // 高度按内容密度收紧：默认尺寸不再预留大块空白；用户手动缩放优先于预设，
  // 修改预设只影响后续新建/切尺寸的窗口，不会在内容变化时反复 resize。
  // 空/单条状态较矮，微件体内部滚动（.wd-body overflow-auto）兜住超量内容；
  // sm/md 以默认条目数不滚动或轻微滚动为界，lg 才预留更富余空间。
  "today-tasks": {
    sm: { width: 300, height: 175 },
    md: { width: 340, height: 200 },
    lg: { width: 400, height: 245 },
  },
  "next-reminder": {
    sm: { width: 280, height: 120 },
    md: { width: 320, height: 132 },
    lg: { width: 380, height: 152 },
  },
  "agent-status": {
    sm: { width: 300, height: 150 },
    md: { width: 340, height: 168 },
    lg: { width: 400, height: 215 },
  },
  "quick-actions": {
    sm: { width: 300, height: 120 },
    md: { width: 340, height: 126 },
    lg: { width: 380, height: 138 },
  },
  "focus-timer": {
    sm: { width: 260, height: 120 },
    md: { width: 300, height: 124 },
    lg: { width: 360, height: 135 },
  },
  efficiency: {
    sm: { width: 280, height: 132 },
    md: { width: 320, height: 140 },
    lg: { width: 380, height: 160 },
  },
};

export function desktopPresetSize(type: WidgetType, size: WidgetSize): { width: number; height: number } {
  return DESKTOP_PRESETS[type][size];
}

/** 解析桌面窗口实际逻辑尺寸：有自定义尺寸（用户手动缩放）优先，否则用 size 预设。 */
export function resolveDesktopWindowSize(
  type: WidgetType,
  size: WidgetSize,
  desktop: WidgetDesktopState | undefined,
): { width: number; height: number } {
  const preset = desktopPresetSize(type, size);
  return {
    width: clampDesktopSize(desktop?.width, DESKTOP_WIDTH_RANGE, preset.width),
    height: clampDesktopSize(desktop?.height, DESKTOP_HEIGHT_RANGE, preset.height),
  };
}

function clampDesktopSize(
  value: unknown,
  range: { min: number; max: number },
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(range.max, Math.max(range.min, value)));
}

/** 归一化窗口锚点：非法值直接丢弃（由后端按默认层叠位放置）。 */
function normalizeAnchor(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** 校验并归一化桌面窗口配置；未知/损坏字段回落到安全默认，不阻塞布局。 */
export function normalizeDesktop(raw: unknown): WidgetDesktopState {
  const source = isRecord(raw) ? raw : {};
  const desktop: WidgetDesktopState = {
    visible: source.visible === true,
    topmost: source.topmost === true,
  };
  if (typeof source.width === "number" && Number.isFinite(source.width)) {
    desktop.width = clampDesktopSize(source.width, DESKTOP_WIDTH_RANGE, DESKTOP_WIDTH_RANGE.min);
  }
  if (typeof source.height === "number" && Number.isFinite(source.height)) {
    desktop.height = clampDesktopSize(source.height, DESKTOP_HEIGHT_RANGE, DESKTOP_HEIGHT_RANGE.min);
  }
  const nx = normalizeAnchor(source.nx);
  const ny = normalizeAnchor(source.ny);
  if (nx !== undefined) desktop.nx = nx;
  if (ny !== undefined) desktop.ny = ny;
  if (typeof source.monitor === "string" && source.monitor.trim()) {
    desktop.monitor = source.monitor.trim().slice(0, 96);
  }
  return desktop;
}

export interface WidgetItem {
  /** 实例标识；第一版与 type 一致（每个类型一个实例）。 */
  widget_id: string;
  type: WidgetType;
  enabled: boolean;
  config: WidgetConfig;
  size: WidgetSize;
  sort_order: number;
  /** 桌面独立窗口状态；旧布局缺失时按安全默认（不显示）补齐。 */
  desktop: WidgetDesktopState;
}

export interface WidgetDefinition {
  type: WidgetType;
  /** 标题/描述的 i18n 键；由组件层 useLocale().t 翻译，模型本身不依赖语言状态。 */
  titleKey: MessageKey;
  descriptionKey: MessageKey;
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
    titleKey: "widgets.def.todayTasks.title",
    descriptionKey: "widgets.def.todayTasks.description",
    defaultSize: "md",
    defaultEnabled: true,
    dependency: null,
  },
  {
    type: "next-reminder",
    titleKey: "widgets.def.nextReminder.title",
    descriptionKey: "widgets.def.nextReminder.description",
    defaultSize: "md",
    defaultEnabled: true,
    dependency: null,
  },
  {
    type: "agent-status",
    titleKey: "widgets.def.agentStatus.title",
    descriptionKey: "widgets.def.agentStatus.description",
    defaultSize: "md",
    defaultEnabled: true,
    dependency: null,
  },
  {
    type: "quick-actions",
    titleKey: "widgets.def.quickActions.title",
    descriptionKey: "widgets.def.quickActions.description",
    defaultSize: "md",
    defaultEnabled: true,
    dependency: null,
  },
  {
    type: "focus-timer",
    titleKey: "widgets.def.focusTimer.title",
    descriptionKey: "widgets.def.focusTimer.description",
    defaultSize: "sm",
    defaultEnabled: false,
    dependency: "focus",
  },
  {
    type: "efficiency",
    titleKey: "widgets.def.efficiency.title",
    descriptionKey: "widgets.def.efficiency.description",
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
    desktop: { ...DEFAULT_DESKTOP_STATE },
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
        desktop: normalizeDesktop(entry.desktop),
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
      desktop: { ...DEFAULT_DESKTOP_STATE },
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
