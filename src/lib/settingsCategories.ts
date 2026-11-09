//! 设置页信息架构（IA）注册表：一级分类 + 分组归属的**唯一事实源**。
//!
//! 分层：
//! 1. `settingsSections.ts`：稳定分组 ID 与折叠状态持久化（不含分类概念）；
//! 2. 本文件：把 `SETTINGS_SECTION_IDS` 组织成六个一级分类，并提供分类选中态持久化；
//! 3. `SettingsPanel`：只按注册表渲染分类导航与分类内容，不再维护第二份索引。
//!
//! 约束：
//! - **每个稳定分组必须且只能归属一个分类**：由 `settingsCategories.test.ts` 的完整性
//!   断言强制（新增分组忘记归类会直接失败，而不是静默丢失）；
//! - 分类与分组身份一律用稳定英文 ID，绝不按中文标题匹配（标题可随语言变化）；
//! - 分类标题/说明与分组标题都是 i18n Key，注册表不持有任何中文文案；
//! - `aliases` 只服务于设置页内的“查找设置”匹配，不参与身份判定、不写库。
//!
//! 新增设置分组的步骤：在 `SETTINGS_SECTION_IDS` 追加 ID → 在本文件 `SETTINGS_SECTION_META`
//! 追加一项（标题 Key + 分类）→ 在设置页对应分类里渲染 `<Section>`。完整性测试会拦住漏项。

import {
  Bell,
  Database,
  LayoutGrid,
  LifeBuoy,
  Plug,
  SlidersHorizontal,
} from "lucide-react";
import type { IconComponent } from "../components/ui/AgentIcon";
import type { MessageKey } from "../i18n/messages";
import type { SettingsSectionId } from "./settingsSections";

/** 一级设置分类（顺序即导航顺序）。 */
export const SETTINGS_CATEGORY_IDS = [
  "general",
  "features",
  "notify-voice",
  "data-resources",
  "integration",
  "help",
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORY_IDS)[number];

export interface SettingsCategory {
  id: SettingsCategoryId;
  labelKey: MessageKey;
  /** 分类说明：分类标题下的一行次级文本（窄窗自动换行，不挤压控件）。 */
  descriptionKey: MessageKey;
  icon: IconComponent;
}

/** 分类元数据：标题、说明与图标。顺序即分类导航的渲染顺序。 */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    id: "general",
    labelKey: "settings.category.general",
    descriptionKey: "settings.category.generalDesc",
    icon: SlidersHorizontal,
  },
  {
    id: "features",
    labelKey: "settings.category.features",
    descriptionKey: "settings.category.featuresDesc",
    icon: LayoutGrid,
  },
  {
    id: "notify-voice",
    labelKey: "settings.category.notifyVoice",
    descriptionKey: "settings.category.notifyVoiceDesc",
    icon: Bell,
  },
  {
    id: "data-resources",
    labelKey: "settings.category.dataResources",
    descriptionKey: "settings.category.dataResourcesDesc",
    icon: Database,
  },
  {
    id: "integration",
    labelKey: "settings.category.integration",
    descriptionKey: "settings.category.integrationDesc",
    icon: Plug,
  },
  {
    id: "help",
    labelKey: "settings.category.help",
    descriptionKey: "settings.category.helpDesc",
    icon: LifeBuoy,
  },
];

export interface SettingsSectionMeta {
  id: SettingsSectionId;
  /** 分组标题 Key（与设置页 `<Section>` 使用同一 Key）。 */
  labelKey: MessageKey;
  category: SettingsCategoryId;
  /** 查找设置的补充关键词（中文别名/英文词），仅用于搜索匹配。 */
  aliases?: readonly string[];
}

/**
 * 全部分组元数据：顺序 = 分类顺序 + 分类内页面渲染顺序。
 *
 * 「查找设置」与分类内容共用本数组：新增分组只改这里，不会出现
 * 「页面有分组但索引缺失」（历史缺陷：`diagnostics-logs` 未进入跳转索引）。
 */
export const SETTINGS_SECTION_META: readonly SettingsSectionMeta[] = [
  // 通用与外观
  {
    id: "appearance",
    labelKey: "settings.section.appearance",
    category: "general",
    aliases: ["主题", "深色", "浅色", "材质", "玻璃", "语言", "theme", "material", "language"],
  },
  {
    id: "navigation",
    labelKey: "settings.section.navigation",
    category: "general",
    aliases: ["侧栏", "入口", "排序", "显隐", "nav", "sidebar"],
  },
  {
    id: "window-hotkeys",
    labelKey: "settings.section.windowHotkeys",
    category: "general",
    aliases: ["快捷键", "吸附", "停靠", "窗口", "hotkey", "snap"],
  },
  // 功能与应用
  {
    id: "features",
    labelKey: "settings.section.features",
    category: "features",
    aliases: ["模块", "开关", "启用", "module"],
  },
  {
    id: "apps",
    labelKey: "settings.section.apps",
    category: "features",
    aliases: ["应用", "快捷方式", "启动", "app", "launcher"],
  },
  {
    id: "clipboard",
    labelKey: "settings.section.clipboard",
    category: "features",
    aliases: ["复制", "粘贴", "剪贴", "clipboard"],
  },
  // 通知与语音
  {
    id: "notifications",
    labelKey: "settings.section.notifications",
    category: "notify-voice",
    aliases: ["提醒", "静音", "免打扰", "notification", "reminder"],
  },
  {
    id: "audio-sound",
    labelKey: "settings.section.audioSound",
    category: "notify-voice",
    aliases: ["提示音", "声音", "音效", "sound"],
  },
  {
    id: "tts",
    labelKey: "settings.section.tts",
    category: "notify-voice",
    aliases: ["语音播报", "朗读", "音色", "voice", "speech"],
  },
  {
    id: "tts-cache",
    labelKey: "settings.section.ttsCache",
    category: "notify-voice",
    aliases: ["语音缓存", "清理缓存", "cache"],
  },
  // 数据与资源
  {
    id: "resource-cleanup",
    labelKey: "settings.section.resourceCleanup",
    category: "data-resources",
    aliases: ["磁盘", "缓存", "占用", "清理", "disk", "cleanup"],
  },
  {
    id: "data",
    labelKey: "settings.section.data",
    category: "data-resources",
    aliases: ["备份", "恢复", "导入", "导出", "backup", "import", "export"],
  },
  // 接入与诊断
  {
    id: "agent",
    labelKey: "settings.section.agent",
    category: "integration",
    aliases: ["接入", "端口", "令牌", "mcp", "agent"],
  },
  {
    id: "mobile-sync",
    labelKey: "settings.section.mobileSync",
    category: "integration",
    aliases: ["手机", "配对", "二维码", "局域网", "同步", "mobile", "pair", "qr", "sync"],
  },
  {
    id: "diagnostics-logs",
    labelKey: "settings.section.diagnosticsLogs",
    category: "integration",
    aliases: ["日志", "异常", "报错", "log", "error"],
  },
  {
    id: "diagnostics",
    labelKey: "settings.section.diagnostics",
    category: "integration",
    aliases: ["性能", "延迟", "队列", "retention", "performance"],
  },
  {
    id: "developer",
    labelKey: "settings.section.developer",
    category: "integration",
    aliases: ["开发者", "调试", "mock", "developer"],
  },
  // 帮助与教程
  {
    id: "help",
    labelKey: "settings.section.help",
    category: "help",
    aliases: ["教程", "引导", "帮助中心", "help", "onboarding"],
  },
];

const SECTION_META_BY_ID = new Map<SettingsSectionId, SettingsSectionMeta>(
  SETTINGS_SECTION_META.map((meta) => [meta.id, meta]),
);

const CATEGORY_BY_ID = new Map<SettingsCategoryId, SettingsCategory>(
  SETTINGS_CATEGORIES.map((category) => [category.id, category]),
);

export function settingsCategory(id: SettingsCategoryId): SettingsCategory | undefined {
  return CATEGORY_BY_ID.get(id);
}

export function settingsSectionMeta(id: SettingsSectionId): SettingsSectionMeta | undefined {
  return SECTION_META_BY_ID.get(id);
}

/**
 * 分组所属分类。ID 类型受 `SettingsSectionId` 约束，完整性由测试保证；
 * 万一出现未归类 ID（例如并行分支新增分组），回退到第一个分类而不是抛错——
 * 设置页不能因为一次索引缺失整页白屏。
 */
export function categoryForSection(id: SettingsSectionId): SettingsCategoryId {
  return SECTION_META_BY_ID.get(id)?.category ?? SETTINGS_CATEGORIES[0].id;
}

/** 某分类下的分组元数据（保持页面渲染顺序）。 */
export function sectionsForCategory(id: SettingsCategoryId): SettingsSectionMeta[] {
  return SETTINGS_SECTION_META.filter((meta) => meta.category === id);
}

// ── 分类选中态持久化（纯本地 UI 偏好）────────────────────────────────
//
// 与折叠状态分开存：`taskdock.settings.sections.v1` 保持原结构不动，
// 避免旧版本/旧备份读取失败，也避免把「上次看的分类」混进折叠偏好。
// 读取失败、损坏、版本不符或未知分类一律回退首个分类（安全默认）。

export const SETTINGS_CATEGORY_STORAGE_KEY = "taskdock.settings.category.v1";

const CATEGORY_STORAGE_VERSION = 1;

export function isSettingsCategoryId(value: unknown): value is SettingsCategoryId {
  return (
    typeof value === "string" &&
    (SETTINGS_CATEGORY_IDS as readonly string[]).includes(value)
  );
}

/** 首次进入与任何读取失败时的安全默认：第一个分类。 */
export function defaultSettingsCategory(): SettingsCategoryId {
  return SETTINGS_CATEGORIES[0].id;
}

export function readSettingsCategory(): SettingsCategoryId {
  try {
    if (typeof localStorage === "undefined") return defaultSettingsCategory();
    const raw = localStorage.getItem(SETTINGS_CATEGORY_STORAGE_KEY);
    if (!raw) return defaultSettingsCategory();
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== CATEGORY_STORAGE_VERSION
    ) {
      return defaultSettingsCategory();
    }
    const category = (parsed as { category?: unknown }).category;
    return isSettingsCategoryId(category) ? category : defaultSettingsCategory();
  } catch {
    return defaultSettingsCategory();
  }
}

/** 持久化分类选中态；写入失败静默忽略（本次会话仍然有效）。 */
export function persistSettingsCategory(category: SettingsCategoryId): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      SETTINGS_CATEGORY_STORAGE_KEY,
      JSON.stringify({ version: CATEGORY_STORAGE_VERSION, category }),
    );
  } catch {
    // 存储不可用：只失去下次启动的记忆，不影响当前分类。
  }
}

/**
 * 设置页内“查找设置”的匹配函数（大小写不敏感；中文按连续子串匹配）。
 * 命中范围：分组标题、分类标题、别名。
 */
export function matchesSettingsQuery(
  haystack: { label: string; categoryLabel: string; aliases?: readonly string[] },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (haystack.label.toLowerCase().includes(q)) return true;
  if (haystack.categoryLabel.toLowerCase().includes(q)) return true;
  return (haystack.aliases ?? []).some((alias) => alias.toLowerCase().includes(q));
}
