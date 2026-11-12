//! 导航注册中心（统一导航架构）：左侧导航与停靠胶囊入口的**唯一元数据源**。
//!
//! 职责边界：
//! - 只定义入口身份与元数据（稳定 ID、展示名、图标、所属界面、覆盖页面、分组、
//!   默认顺序、默认可见、快捷键说明、入口类型）；**不持有业务 Store、不做路由**。
//! - 用户的显隐与排序属于「配置」，由 `navVisibility.ts` 负责版本化、迁移与合并；
//!   注册中心只提供默认值，不能反过来从配置推导入口清单。
//! - 左侧导航（`FullView`）与停靠胶囊轨道（`CapsuleRail`）都从这里取入口，
//!   禁止在组件里再声明第二份入口数组。
//!
//! 新增功能入口的步骤：
//! 1. 在 `NAV_ENTRIES` 中追加一项（稳定英文 ID，绝不使用中文标题作身份）；
//! 2. 若覆盖逻辑 Tab，必须在 `tabs` 中列出（左侧每个 Tab 必须至少有一个入口）；
//! 3. 指定 `surfaces` 与各面的默认顺序/默认可见；
//! 4. 若是胶囊入口，补 `capsuleCategory`；若占用 Ctrl+数字，补 `shortcut` 并加契约断言。
//!
//! 快捷键：`shortcut` 只是展示元数据；真实语义仍由 `useUiStore.TAB_ORDER` 与
//! `useGlobalShortcuts` 决定。新增视觉入口默认**不分配数字键**，避免已有语义漂移。

import {
  Activity,
  Blocks,
  Clipboard,
  HardDrive,
  History,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  LifeBuoy,
  ListTodo,
  Map as MapIcon,
  Settings as SettingsIcon,
  Smartphone,
  Workflow,
} from "lucide-react";
import AgentIcon, { type IconComponent } from "../components/ui/AgentIcon";
import PointerClickIcon from "../components/ui/PointerClickIcon";
import type { Tab } from "../store/useUiStore";
import type { MessageKey, MessageParams } from "../i18n/messages";
import type { CapsuleCategory } from "./capsuleModel";

/** 入口出现的界面：完整面板左侧导航 / 停靠胶囊轨道。 */
export type NavSurface = "left" | "capsule";

/**
 * 入口类型：
 * - `page`：普通页面入口（1:1 对应一个逻辑 Tab）；
 * - `merged`：合并入口（如「收集与暂存」覆盖 inbox + shelf 两个逻辑 Tab）；
 * - `agent-status`：Agent 状态入口（胶囊顶部状态球，同时监控状态与入口）；
 * - `visual`：仅视觉入口（应用 / 微件，不占快捷键，页面仍可被深链打开）。
 */
export type NavEntryKind = "page" | "merged" | "agent-status" | "visual";

/** 导航分组：设置页按组展示，顺序与分组内顺序都由入口定义驱动。 */
export type NavGroup = "core" | "capture" | "planning" | "system";

export type NavEntryId =
  | "workbench"
  | "tasks"
  | "agents"
  | "apps"
  | "widgets"
  | "actions"
  | "clipboard"
  | "mobile"
  | "collection"
  | "workflows"
  | "history"
  | "roadmap"
  | "settings"
  | "inbox"
  | "help"
  | "diagnostics"
  | "resource";

/** 左侧徽标口径：复用既有统计，不在注册中心里计算。 */
export type NavBadge = "intervention" | "attention" | "pending" | "inbox";

export interface NavEntry {
  /** 稳定身份：持久化只存它，显示名可随时改。 */
  id: NavEntryId;
  kind: NavEntryKind;
  surfaces: readonly NavSurface[];
  /**
   * 稳定翻译 Key：渲染时按当前语言取文案。入口身份仍是 `id`，改文案不影响
   * 用户显隐 / 排序 / 快捷键。
   */
  labelKey: MessageKey;
  /**
   * 兼容字段：简体中文默认展示名。仅用于非 React 环境或旧调用方的默认回退，
   * 组件渲染一律走 `t(labelKey)`，避免英文模式直出中文。
   */
  label: string;
  icon: IconComponent;
  /** 该入口覆盖的逻辑 Tab（合并入口可覆盖多个；胶囊入口对应其面板）。 */
  tabs: readonly Tab[];
  group: NavGroup;
  /** 展示用快捷键说明；为空表示不占 Ctrl+数字。 */
  shortcut?: string;
  badge?: NavBadge;
  /** 胶囊分类身份（仅胶囊入口）：决定该入口打开哪个轻量面板。 */
  capsuleCategory?: CapsuleCategory;
  /** 各界面的默认值：顺序用于首次安装与「恢复默认」，可见用于新入口合并。 */
  defaults: Readonly<Record<NavSurface, { order: number; visible: boolean }>>;
  /**
   * 系统入口保护：不可隐藏、不可排序，归一化时固定补回本面末尾。
   * 用于「设置」这类必须始终可达的稳定入口，避免用户把自己锁在门外。
   */
  locked?: boolean;
}

/** 声明顺序无关于展示顺序；展示顺序一律按 `defaults[surface].order`。 */
export const NAV_ENTRIES: readonly NavEntry[] = [
  {
    id: "workbench",
    kind: "page",
    surfaces: ["left"],
    labelKey: "nav.workbench",
    label: "工作台",
    icon: LayoutDashboard,
    tabs: ["workbench"],
    group: "core",
    badge: "intervention",
    defaults: {
      left: { order: 0.5, visible: true },
      capsule: { order: 1, visible: false },
    },
  },
  {
    id: "tasks",
    kind: "page",
    surfaces: ["left", "capsule"],
    labelKey: "nav.tasks",
    label: "任务",
    icon: ListTodo,
    tabs: ["tasks"],
    group: "core",
    shortcut: "Ctrl+1",
    badge: "pending",
    capsuleCategory: "tasks",
    defaults: {
      left: { order: 1, visible: true },
      capsule: { order: 2, visible: true },
    },
  },
  {
    id: "agents",
    kind: "agent-status",
    surfaces: ["left", "capsule"],
    labelKey: "nav.agents",
    label: "Agent",
    icon: AgentIcon,
    tabs: ["agents"],
    group: "core",
    shortcut: "Ctrl+2",
    badge: "intervention",
    capsuleCategory: "agents",
    defaults: {
      left: { order: 2, visible: true },
      // 胶囊顶部状态球：隐藏只影响图标，不停止后台监控与事件接收。
      capsule: { order: 1, visible: true },
    },
  },
  {
    id: "apps",
    kind: "visual",
    surfaces: ["left", "capsule"],
    labelKey: "nav.apps",
    label: "应用",
    icon: LayoutGrid,
    tabs: ["apps"],
    group: "core",
    capsuleCategory: "apps",
    defaults: {
      left: { order: 3, visible: true },
      capsule: { order: 5, visible: true },
    },
  },
  {
    id: "widgets",
    kind: "visual",
    surfaces: ["left"],
    labelKey: "nav.widgets",
    label: "微件",
    icon: Blocks,
    tabs: ["widgets"],
    group: "core",
    defaults: {
      left: { order: 4, visible: true },
      capsule: { order: 0, visible: false },
    },
  },
  {
    id: "actions",
    kind: "page",
    surfaces: ["left"],
    labelKey: "nav.actions",
    label: "行动",
    icon: PointerClickIcon,
    tabs: ["actions"],
    group: "core",
    shortcut: "Ctrl+3",
    badge: "attention",
    defaults: {
      left: { order: 5, visible: true },
      capsule: { order: 0, visible: false },
    },
  },
  {
    id: "clipboard",
    kind: "page",
    surfaces: ["left", "capsule"],
    labelKey: "nav.clipboard",
    label: "剪贴板",
    icon: Clipboard,
    tabs: ["clipboard"],
    group: "core",
    shortcut: "Ctrl+4",
    capsuleCategory: "clipboard",
    defaults: {
      left: { order: 6, visible: true },
      capsule: { order: 4, visible: true },
    },
  },
  {
    id: "mobile",
    kind: "visual",
    surfaces: ["left"],
    labelKey: "nav.mobile",
    label: "手机互传",
    icon: Smartphone,
    tabs: ["mobile"],
    group: "capture",
    defaults: {
      // 放在剪贴板之后、收集与暂存之前：都是「内容进出」类操作。
      left: { order: 6.5, visible: true },
      capsule: { order: 0, visible: false },
    },
  },
  {
    id: "collection",
    kind: "merged",
    surfaces: ["left"],
    labelKey: "nav.collection",
    label: "收集与暂存",
    icon: Inbox,
    tabs: ["inbox", "shelf"],
    group: "capture",
    shortcut: "Ctrl+5 / Ctrl+6",
    badge: "inbox",
    defaults: {
      left: { order: 7, visible: true },
      capsule: { order: 0, visible: false },
    },
  },
  {
    id: "inbox",
    kind: "page",
    surfaces: ["capsule"],
    labelKey: "nav.inbox",
    label: "收集箱",
    icon: Inbox,
    tabs: ["inbox"],
    group: "capture",
    capsuleCategory: "inbox",
    defaults: {
      left: { order: 0, visible: false },
      capsule: { order: 3, visible: true },
    },
  },
  {
    id: "workflows",
    kind: "page",
    surfaces: ["left"],
    labelKey: "nav.workflows",
    label: "工作流",
    icon: Workflow,
    tabs: ["workflows"],
    group: "planning",
    shortcut: "Ctrl+7",
    defaults: {
      left: { order: 8, visible: true },
      capsule: { order: 0, visible: false },
    },
  },
  {
    id: "history",
    kind: "page",
    surfaces: ["left"],
    labelKey: "nav.history",
    label: "历史",
    icon: History,
    tabs: ["history"],
    group: "planning",
    shortcut: "Ctrl+8",
    defaults: {
      left: { order: 9, visible: true },
      capsule: { order: 0, visible: false },
    },
  },
  {
    id: "roadmap",
    kind: "page",
    // 完整面板与胶囊工具面板双入口：重型编辑仍在完整规划中心，胶囊只提供
    // 当前项目的轻量视图（功能列表 / 步骤勾选 / 跳转完整页）。
    surfaces: ["left", "capsule"],
    labelKey: "nav.roadmap",
    label: "规划中心",
    icon: MapIcon,
    tabs: ["roadmap"],
    group: "planning",
    shortcut: "Ctrl+9",
    capsuleCategory: "roadmap",
    defaults: {
      left: { order: 10, visible: true },
      capsule: { order: 6, visible: true },
    },
  },
  {
    id: "settings",
    kind: "page",
    surfaces: ["left"],
    labelKey: "nav.settings",
    label: "设置",
    icon: SettingsIcon,
    tabs: ["settings"],
    group: "system",
    shortcut: "Ctrl+0",
    // 固定入口：设置页是「导航自定义」的兜底，必须始终可达，不可隐藏/排序。
    locked: true,
    defaults: {
      left: { order: 11, visible: true },
      capsule: { order: 0, visible: false },
    },
  },
  {
    // 帮助中心：稳定路由与用户可选的视觉入口，不占 Ctrl+数字；默认隐藏，
    // 已保存的用户显隐和排序由 navVisibility 按 ID 原样保留。
    id: "help",
    kind: "page",
    surfaces: ["left"],
    labelKey: "nav.help",
    label: "帮助",
    icon: LifeBuoy,
    tabs: ["help"],
    group: "system",
    defaults: {
      left: { order: 10.5, visible: false },
      capsule: { order: 0, visible: false },
    },
  },
  {
    // 诊断中心：仅左侧页面的独立入口，默认隐藏（用户可在「导航自定义」中开启），
    // 不占 Ctrl+数字；隐藏时仍可从侧栏底部「更多」进入。不与「设置」合并，
    // 避免重复高亮与路由冲突。
    id: "diagnostics",
    kind: "page",
    surfaces: ["left"],
    labelKey: "nav.diagnostics",
    label: "诊断中心",
    icon: Activity,
    tabs: ["diagnostics"],
    group: "system",
    defaults: {
      left: { order: 10.6, visible: false },
      capsule: { order: 0, visible: false },
    },
  },
  {
    // 资源管理：完整面板的默认可见入口，默认顺序在「设置」之前。
    // 与「设置」不同，它可隐藏/排序：隐藏后仍可从侧栏「更多」和设置页
    // 「数据与资源 → 资源管理」进入，不存在导航自锁风险，因此不加 `locked`。
    // 不占 Ctrl+数字（既有快捷键语义不变），不提供胶囊入口（页面级工具，胶囊不承载）。
    id: "resource",
    kind: "page",
    surfaces: ["left"],
    labelKey: "nav.resource",
    label: "资源管理",
    icon: HardDrive,
    tabs: ["resource"],
    group: "system",
    defaults: {
      left: { order: 10.8, visible: true },
      capsule: { order: 0, visible: false },
    },
  },
];

const ENTRY_BY_ID = new Map<string, NavEntry>(NAV_ENTRIES.map((entry) => [entry.id, entry]));

export function navEntry(id: string): NavEntry | undefined {
  return ENTRY_BY_ID.get(id);
}

/** 某界面的入口，按默认顺序升序（默认顺序相同的不会出现，契约测试保证唯一）。 */
export function entriesForSurface(surface: NavSurface): NavEntry[] {
  return NAV_ENTRIES.filter((entry) => entry.surfaces.includes(surface)).sort(
    (a, b) => a.defaults[surface].order - b.defaults[surface].order,
  );
}

/** 某界面的全部入口 ID（默认顺序）。 */
export function allEntryIds(surface: NavSurface): string[] {
  return entriesForSurface(surface).map((entry) => entry.id);
}

/** 某界面默认可见的入口 ID（默认顺序）。 */
export function defaultVisibleIds(surface: NavSurface): string[] {
  return entriesForSurface(surface)
    .filter((entry) => entry.defaults[surface].visible)
    .map((entry) => entry.id);
}

/** 逻辑 Tab 在左侧导航中的归属入口（inbox/shelf 合并为 collection）。 */
export function leftEntryForTab(tab: Tab): NavEntry | undefined {
  return NAV_ENTRIES.find(
    (entry) => entry.surfaces.includes("left") && entry.tabs.includes(tab),
  );
}

/** 胶囊入口对应的分类身份；非胶囊入口返回 undefined。 */
export function capsuleCategoryFor(id: string): CapsuleCategory | undefined {
  return ENTRY_BY_ID.get(id)?.capsuleCategory;
}

/**
 * 入口在指定界面是否参与排序（设置页据此决定是否渲染上移/下移按钮）。
 *
 * 规则（与 navVisibility 的排序不变量一致）：
 * - `locked` 系统入口（设置）不可排序：位置由渲染层固定在侧栏底部；
 * - 胶囊界面的 Agent 状态球（`kind === "agent-status"`）是**固定状态入口**，
 *   渲染在轨道端头，不参与普通分类排序——它仍可隐藏，隐藏不停止 Agent 监控
 *   与关键事件接收；
 * - 其余入口（普通页面 / 合并入口 / 仅视觉入口）可排序。
 */
export function isEntrySortable(entry: NavEntry, surface: NavSurface): boolean {
  if (entry.locked) return false;
  if (surface === "capsule" && entry.kind === "agent-status") return false;
  return true;
}

/** 左侧界面中锁定（固定位置）的入口 ID；渲染层把它们放进固定底部区域。 */
export function lockedEntryIds(surface: NavSurface): string[] {
  return entriesForSurface(surface)
    .filter((entry) => entry.locked)
    .map((entry) => entry.id);
}

/** 按当前语言的翻译函数取入口展示名；`label` 只作为中文默认回退。 */
export function navLabel(
  entry: NavEntry,
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  return t(entry.labelKey);
}
