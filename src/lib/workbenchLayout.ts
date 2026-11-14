//! 统一工作台外壳布局（U0）：版本化协议 + 安全迁移 + 串行写入。
//!
//! 与既有两层布局正交：
//! 1. `navigation_layout`（入口显隐/排序）继续由 `navVisibility.ts` 管理，工作台
//!    侧栏直接复用同一份配置，**不另建第二份导航配置**；
//! 2. `workspace_instances.layout_json`（项目专业模块顺序）继续由
//!    `workspaceProfiles.ts` 管理；
//! 3. 本文件只新增第三层「工作台外壳布局」：上次路由、当前项目、右栏显隐与
//!    分栏宽度。存储键 `application_settings.workbench_layout`（后端只做结构校验）。
//!
//! 兼容与回退：缺失/损坏/未知版本都不白屏 —— 逐字段校验，非法字段各自回默认，
//! 未知字段忽略；宽度钳制到可用范围；`route` 必须是已注册功能 ID。

import { useMemo } from "react";
import type { Tab } from "../store/useUiStore";
import { useSettingsStore } from "../store/useSettingsStore";

/** SQLite 设置键（ALLOWED_KEYS 已登记；后端只校验结构）。 */
export const WORKBENCH_LAYOUT_SETTING_KEY = "workbench_layout";

/** 结构版本：合并语义或字段含义发生破坏性变化时才递增。 */
export const WORKBENCH_LAYOUT_VERSION = 1;

/**
 * 工作台可路由功能：`home`（工作台首页）+ 全部逻辑 Tab。
 * 契约测试会核对它与导航注册中心的 `tabs` 完全一致，防止两边漂移。
 */
export const WORKBENCH_ROUTES = [
  "home",
  "workbench",
  "workspace",
  "files",
  "tasks",
  "agents",
  "apps",
  "widgets",
  "actions",
  "clipboard",
  "mobile",
  "inbox",
  "shelf",
  "workflows",
  "history",
  "roadmap",
  "settings",
  "help",
  "diagnostics",
  "resource",
] as const;

export type WorkbenchRoute = (typeof WORKBENCH_ROUTES)[number];

export interface WorkbenchLayout {
  version: number;
  /** 上次所在功能（无项目也可用）。 */
  route: WorkbenchRoute;
  /** 上次选择的工作空间项目；无效/删除后由外壳读侧降级。 */
  projectId: string | null;
  /** 右侧上下文栏是否展开。 */
  detailOpen: boolean;
  /** 左侧导航宽度（CSS px）。 */
  navWidth: number;
  /** 右侧上下文栏宽度（CSS px）。 */
  detailWidth: number;
}

export const WORKBENCH_NAV_WIDTH_MIN = 180;
export const WORKBENCH_NAV_WIDTH_MAX = 320;
export const WORKBENCH_DETAIL_WIDTH_MIN = 260;
export const WORKBENCH_DETAIL_WIDTH_MAX = 480;

const DEFAULTS = {
  route: "home" as WorkbenchRoute,
  projectId: null as string | null,
  detailOpen: true,
  navWidth: 224,
  detailWidth: 320,
};

export function defaultWorkbenchLayout(): WorkbenchLayout {
  return { version: WORKBENCH_LAYOUT_VERSION, ...DEFAULTS };
}

export interface WorkbenchLayoutNormalization {
  config: WorkbenchLayout;
  /** 输入版本与当前版本不一致（已按字段对齐迁移）。 */
  migrated: boolean;
  /** 被丢弃/回退的非法字段数量。 */
  dropped: number;
  /** `settings` = 有效对象；`default` = 缺失或整体损坏。 */
  source: "settings" | "default";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isRouteId(value: unknown): value is WorkbenchRoute {
  return typeof value === "string" && (WORKBENCH_ROUTES as readonly string[]).includes(value);
}

/** 项目 ID：非空、去空白、长度受限、无控制字符；其他一律 null。 */
export function normalizeProjectId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return null;
  for (const ch of trimmed) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return trimmed;
}

/**
 * 归一化任意来源的工作台布局。绝不抛错：每个字段独立回退。
 */
export function normalizeWorkbenchLayout(raw: unknown): WorkbenchLayoutNormalization {
  if (!isRecord(raw)) {
    return { config: defaultWorkbenchLayout(), migrated: false, dropped: 0, source: "default" };
  }
  // version 是结构契约：缺失/非正整数视为整体损坏，回默认而不是「猜字段」。
  const declared = raw.version;
  if (typeof declared !== "number" || !Number.isInteger(declared) || declared <= 0) {
    return { config: defaultWorkbenchLayout(), migrated: false, dropped: 0, source: "default" };
  }

  let dropped = 0;
  const migrated = declared !== WORKBENCH_LAYOUT_VERSION;

  let route: WorkbenchRoute = DEFAULTS.route;
  if (isRouteId(raw.route)) {
    route = raw.route;
  } else if (raw.route !== undefined) {
    dropped += 1;
  }

  let projectId: string | null = null;
  if (raw.projectId === null || raw.projectId === undefined) {
    projectId = null;
  } else {
    projectId = normalizeProjectId(raw.projectId);
    if (projectId === null) dropped += 1;
  }

  let detailOpen = DEFAULTS.detailOpen;
  if (typeof raw.detailOpen === "boolean") {
    detailOpen = raw.detailOpen;
  } else if (raw.detailOpen !== undefined) {
    dropped += 1;
  }

  const widthOf = (
    value: unknown,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      if (value !== undefined) dropped += 1;
      return fallback;
    }
    const rounded = Math.round(value);
    return clamp(rounded, min, max);
  };

  return {
    config: {
      version: WORKBENCH_LAYOUT_VERSION,
      route,
      projectId,
      detailOpen,
      navWidth: widthOf(
        raw.navWidth,
        DEFAULTS.navWidth,
        WORKBENCH_NAV_WIDTH_MIN,
        WORKBENCH_NAV_WIDTH_MAX,
      ),
      detailWidth: widthOf(
        raw.detailWidth,
        DEFAULTS.detailWidth,
        WORKBENCH_DETAIL_WIDTH_MIN,
        WORKBENCH_DETAIL_WIDTH_MAX,
      ),
    },
    migrated,
    dropped,
    source: "settings",
  };
}

/** 从后端设置派生当前布局（缺失/损坏 → 默认）。 */
export function selectWorkbenchLayout(settings: unknown): WorkbenchLayout {
  return normalizeWorkbenchLayout(
    (settings as Record<string, unknown> | null)?.[WORKBENCH_LAYOUT_SETTING_KEY],
  ).config;
}

/** React 侧唯一读取入口：只订阅设置值，不制造第二份布局状态。 */
export function useWorkbenchLayout(): WorkbenchLayout {
  const raw = useSettingsStore((s) => s.settings?.[WORKBENCH_LAYOUT_SETTING_KEY]);
  return useMemo(() => normalizeWorkbenchLayout(raw).config, [raw]);
}

// ── 串行写入（读-改-写）────────────────────────────────────────────────
//
// 快速拖动分栏/连续切页时，后一次写入必须基于前一次已落库的结果，而不是渲染时
// 的旧快照；写入失败直接抛错，由调用方就地反馈（不制造开关与配置不一致的假成功）。

let writeChain: Promise<void> = Promise.resolve();

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function persistWorkbenchLayout(
  mutate: (current: WorkbenchLayout) => WorkbenchLayout,
): Promise<void> {
  return enqueueWrite(async () => {
    const store = useSettingsStore.getState();
    if (!store.settings) throw new Error("设置尚未加载，请稍后重试");
    const current = selectWorkbenchLayout(store.settings);
    const next = normalizeWorkbenchLayout({
      ...mutate(current),
      version: WORKBENCH_LAYOUT_VERSION,
    }).config;
    await store.update({ [WORKBENCH_LAYOUT_SETTING_KEY]: next });
  });
}

export function setWorkbenchRoute(route: WorkbenchRoute): Promise<void> {
  return persistWorkbenchLayout((current) => ({ ...current, route }));
}

export function setWorkbenchProject(projectId: string | null): Promise<void> {
  return persistWorkbenchLayout((current) => ({
    ...current,
    projectId: normalizeProjectId(projectId),
  }));
}

export function setWorkbenchDetailOpen(detailOpen: boolean): Promise<void> {
  return persistWorkbenchLayout((current) => ({ ...current, detailOpen }));
}

export function setWorkbenchNavWidth(navWidth: number): Promise<void> {
  return persistWorkbenchLayout((current) => ({ ...current, navWidth }));
}

export function setWorkbenchDetailWidth(detailWidth: number): Promise<void> {
  return persistWorkbenchLayout((current) => ({ ...current, detailWidth }));
}

/** 旧版没有该键时视为「未写入」（与损坏区分，供迁移判断）。 */
export function hasStoredWorkbenchLayout(settings: unknown): boolean {
  return (
    normalizeWorkbenchLayout(
      (settings as Record<string, unknown> | null)?.[WORKBENCH_LAYOUT_SETTING_KEY],
    ).source === "settings"
  );
}

/** 路由是否是合法功能 ID（导航协议 / 持久化共用）。 */
export function isWorkbenchRoute(value: unknown): value is WorkbenchRoute {
  return isRouteId(value);
}

/** 逻辑 Tab → 工作台路由（两者取值一致；保留显式函数便于类型收敛）。 */
export function routeForTab(tab: Tab): WorkbenchRoute {
  return tab;
}

/** 测试/调试用：等待当前写入链落定。 */
export function __flushWorkbenchLayoutWrites(): Promise<void> {
  return writeChain;
}

/** 供测试重置（不导出到业务代码路径）。 */
export function __resetWorkbenchLayoutWritesForTests(): void {
  writeChain = Promise.resolve();
}

// 保持设置就绪判据在 hook 层唯一：外壳据此决定何时开始写入布局。
export function useWorkbenchLayoutReady(): boolean {
  return useSettingsStore((s) => s.settings !== null);
}
