//! 命令面板命令注册表：全局搜索弹窗内「命令」能力层的唯一事实源。
//!
//! 设计边界（任务书 §9.1）：
//! - **不新建第二个弹窗、不建第二套索引**：命令列表只在全局搜索弹窗内渲染，
//!   数据检索仍走 `global_search` 后端；本文件只做前端本地匹配（命令量小）。
//! - **危险操作不得通过模糊命令直接执行**：命令只允许「打开 / 跳转 / 新建草稿 /
//!   运行工作流 / 进入场景」这类打开类动作；删除、覆盖、批量操作、停用模块
//!   **一律不登记**（`EXECUTABLE_ACTION_KINDS` 白名单 + 契约测试双重拦截）。
//!   新增动作类型时必须先扩白名单并补契约测试，否则注册表编译期就拒绝。
//! - 静态命令从既有注册中心派生（导航入口 `NAV_ENTRIES`、设置分组
//!   `SETTINGS_SECTION_META`），**不复制第二份入口清单**；动态实体（场景/工作流）
//!   由 store 在弹窗打开时用既有列表命令水合后经 `buildScenarioCommands` /
//!   `buildWorkflowCommands` 生成。
//! - 本文件保持纯净：不 import 任何 store 值（仅 type），可单测。

import type { Tab } from "../store/useUiStore";
import type { MessageKey } from "../i18n/messages";
import type { SettingsSectionId } from "./settingsSections";
import { SETTINGS_SECTION_META } from "./settingsCategories";
import { NAV_ENTRIES, type NavEntry } from "./navigationRegistry";
import type { IconComponent } from "../components/ui/AgentIcon";
import { Plus, BellRing, Command as CommandIcon } from "lucide-react";

// ── 动作白名单 ──────────────────────────────────────────────

/** 可登记的动作类型白名单：只含打开/跳转/草稿/运行类；危险动作永不进面板。 */
export const EXECUTABLE_ACTION_KINDS = [
  "open-tab",
  "quick-add",
  "reminder-draft",
  "open-settings-section",
  "open-scenario",
  "run-workflow",
] as const;

export type CommandActionKind = (typeof EXECUTABLE_ACTION_KINDS)[number];

export type CommandAction =
  | { kind: "open-tab"; tab: Tab }
  | { kind: "quick-add" }
  | { kind: "reminder-draft" }
  | { kind: "open-settings-section"; sectionId: SettingsSectionId }
  | { kind: "open-scenario"; scenarioId: string; name: string }
  | { kind: "run-workflow"; workflowId: string; name: string };

export function isExecutableActionKind(kind: string): kind is CommandActionKind {
  return (EXECUTABLE_ACTION_KINDS as readonly string[]).includes(kind);
}

/** 单条命令定义。静态命令标题走 i18n Key；动态实体直接携带实体名（用户内容不进词典）。 */
export interface CommandDef {
  /** 稳定唯一 ID：`nav.<entryId>` / `create.task` / `create.reminder` /
   * `settings.<sectionId>` / `scenario.<id>` / `workflow.<id>`。 */
  id: string;
  /** 命令组（渲染与测试分组用）。 */
  group: "create" | "page" | "scenario" | "workflow" | "settings";
  /** 静态命令标题 Key（与 title 二选一，titleKey 优先）。 */
  titleKey?: MessageKey;
  /** 动态实体标题（实体展示名，来自用户数据）。 */
  title?: string;
  /** 副标题 Key（动作说明）。 */
  subtitleKey: MessageKey;
  /** 关键词（中英文，除 title 外的补充匹配面）。 */
  keywords: readonly string[];
  icon: IconComponent;
  action: CommandAction;
}

/** 翻译函数形状（与 i18n 的 t 一致；用结构类型避免循环依赖）。 */
export type TranslateFn = (key: MessageKey, params?: Record<string, string | number | undefined>) => string;

// ── 静态命令：新建草稿类 ────────────────────────────────────

const CREATE_COMMANDS: readonly CommandDef[] = [
  {
    id: "create.task",
    group: "create",
    titleKey: "commandPalette.createTask",
    subtitleKey: "commandPalette.subQuickAdd",
    keywords: ["新建任务", "任务", "快速录入", "新增", "new task", "task", "quick add"],
    icon: Plus,
    action: { kind: "quick-add" },
  },
  {
    id: "create.reminder",
    group: "create",
    titleKey: "commandPalette.createReminder",
    subtitleKey: "commandPalette.subReminderDraft",
    keywords: ["创建提醒", "提醒", "闹钟", "定时", "reminder", "remind", "timer"],
    icon: BellRing,
    action: { kind: "reminder-draft" },
  },
];

// ── 静态命令：打开功能页（派生自导航注册中心）──────────────

/** 导航入口的英文补充关键词（标题随语言变化，关键词保底中英文召回）。 */
const NAV_ENTRY_KEYWORDS: Record<string, readonly string[]> = {
  tasks: ["任务", "task", "todo"],
  agents: ["会话", "监控", "agent", "session"],
  apps: ["应用", "启动", "快捷方式", "app", "launcher"],
  widgets: ["微件", "桌面", "widget"],
  actions: ["行动", "聚合", "action"],
  clipboard: ["剪贴板", "复制", "粘贴", "clipboard"],
  collection: ["收集", "暂存", "inbox", "shelf", "capture"],
  inbox: ["收集箱", "笔记", "inbox", "note"],
  workflows: ["工作流", "场景", "workflow", "automation"],
  history: ["历史", "记录", "history"],
  roadmap: ["规划", "路线", "roadmap", "plan"],
  settings: ["设置", "偏好", "settings", "preference"],
  help: ["帮助", "教程", "help", "tutorial"],
  diagnostics: ["诊断", "性能", "diagnostics"],
  resource: ["资源", "磁盘", "占用", "resource", "disk"],
};

function navEntryCommand(entry: NavEntry): CommandDef {
  return {
    id: `nav.${entry.id}`,
    group: "page",
    titleKey: entry.labelKey,
    subtitleKey: "commandPalette.subOpenPage",
    keywords: [entry.label, ...(NAV_ENTRY_KEYWORDS[entry.id] ?? [])],
    icon: entry.icon,
    // 合并入口落到第一个逻辑 Tab（与左侧导航 openEntry 的默认子页一致）。
    action: { kind: "open-tab", tab: entry.tabs[0] },
  };
}

/** 打开功能页命令：导航注册表内全部入口（含默认隐藏的入口，页面本身可达）。 */
export const NAV_PAGE_COMMANDS: readonly CommandDef[] = NAV_ENTRIES.map(navEntryCommand);

// ── 静态命令：打开设置分组（派生自设置 IA 注册表）──────────

/** 设置分组命令只在输入关键词时出现（默认列表不放 17 个分组，避免淹没）。 */
export const SETTINGS_SECTION_COMMANDS: readonly CommandDef[] = SETTINGS_SECTION_META.map(
  (meta) => ({
    id: `settings.${meta.id}`,
    group: "settings" as const,
    titleKey: meta.labelKey,
    subtitleKey: "commandPalette.subOpenSettings",
    keywords: [meta.id, ...(meta.aliases ?? [])],
    icon: CommandIcon,
    action: { kind: "open-settings-section" as const, sectionId: meta.id },
  }),
);

/** 全部静态命令（顺序 = 默认列表顺序：新建 → 页面 → 设置分组）。 */
export function buildStaticCommands(): CommandDef[] {
  return [...CREATE_COMMANDS, ...NAV_PAGE_COMMANDS, ...SETTINGS_SECTION_COMMANDS];
}

// ── 动态实体命令（场景 / 工作流）────────────────────────────

/** 动态实体命令的最小形状：只取注册表需要的字段，便于测试构造。 */
export interface ScenarioEntityInput {
  id: string;
  name: string;
}

export interface WorkflowEntityInput {
  id: string;
  name: string;
  /** 停用的工作流不可运行：不进命令列表（如实降级，不伪装可执行）。 */
  enabled: boolean;
}

export function buildScenarioCommands(items: readonly ScenarioEntityInput[] | null | undefined): CommandDef[] {
  if (!items || items.length === 0) return [];
  return items.map((s) => ({
    id: `scenario.${s.id}`,
    group: "scenario" as const,
    title: s.name,
    subtitleKey: "commandPalette.subEnterScenario" as MessageKey,
    keywords: ["场景", "进入场景", "scenario"],
    icon: CommandIcon,
    action: { kind: "open-scenario" as const, scenarioId: s.id, name: s.name },
  }));
}

export function buildWorkflowCommands(items: readonly WorkflowEntityInput[] | null | undefined): CommandDef[] {
  if (!items || items.length === 0) return [];
  return items
    .filter((w) => w.enabled)
    .map((w) => ({
      id: `workflow.${w.id}`,
      group: "workflow" as const,
      title: w.name,
      subtitleKey: "commandPalette.subRunWorkflow" as MessageKey,
      keywords: ["工作流", "运行", "workflow", "run"],
      icon: CommandIcon,
      action: { kind: "run-workflow" as const, workflowId: w.id, name: w.name },
    }));
}

// ── 匹配与默认列表 ─────────────────────────────────────────

/**
 * 空查询默认列表：新建草稿类 + 打开页面类（静态、数量受注册表规模天然约束）。
 * 设置分组与动态实体只在输入关键词后出现——默认列表保持「常用、可一眼扫完」。
 */
export function defaultCommands(): CommandDef[] {
  return buildStaticCommands().filter(
    (c) => c.group === "create" || c.group === "page",
  );
}

/** 输入关键词时命令组的结果上限（防大列表淹没数据结果；超出部分不展示）。 */
export const COMMAND_MATCH_LIMIT = 12;

/**
 * 关键词过滤：大小写不敏感的连续子串匹配（与现有数据搜索 LIKE %q% 口径一致），
 * 匹配面 = 标题（按当前语言解析）+ 关键词。命令组内保持注册顺序。
 */
export function filterCommands(commands: readonly CommandDef[], query: string, t: TranslateFn): CommandDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hit = (c: CommandDef): boolean => {
    const title = c.titleKey ? t(c.titleKey) : (c.title ?? "");
    if (title.toLowerCase().includes(q)) return true;
    return c.keywords.some((k) => k.toLowerCase().includes(q));
  };
  return commands.filter(hit).slice(0, COMMAND_MATCH_LIMIT);
}

/**
 * 组装当前应展示的命令列表（空查询 → 默认列表；有关键词 → 全量过滤）。
 * `all` 由调用方合并静态与动态命令；动态列表未加载/为空时自然降级为静态子集。
 */
export function visibleCommands(all: readonly CommandDef[], query: string, t: TranslateFn): CommandDef[] {
  const q = query.trim();
  if (!q) return defaultCommands();
  return filterCommands(all, q, t);
}
