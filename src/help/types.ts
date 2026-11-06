//! 帮助系统类型定义：教程文章与结构化正文。
//!
//! 设计决策（第一轮交付，见 docs/help/README.md）：
//! - **正文不走全局 MessageKey 词典**：教程正文量大且持续增长，走全局词典会让
//!   MessageKey 类型与翻译文件键爆炸。文章自备 `translations`，zh-CN 必填、
//!   en-US 可选（缺失时 UI 明确显示「暂无英文版」，不伪称国际化完成）；
//! - 界面骨架（按钮 / 分类名 / 搜索框 / 空态）仍走全局词典，保证切换语言即时生效；
//! - `status` 是**内容校验状态**，与 featureCatalog 的功能实现状态（implemented/partial…）
//!   是两个正交维度：`verified` 表示「该文与当前版本界面核对一致」，
//!   `needs_review` 表示「操作语义可能过时 / 功能仍在开发」，不得伪装自动通过。

/** 教程内容校验状态。 */
export type HelpArticleStatus = "draft" | "verified" | "needs_review" | "unavailable";

export const HELP_ARTICLE_STATUSES: readonly HelpArticleStatus[] = [
  "draft",
  "verified",
  "needs_review",
  "unavailable",
];

/** 帮助分类（8 类），顺序即帮助中心展示顺序。 */
export type HelpCategoryId =
  | "quickstart"
  | "tasks"
  | "agents"
  | "clipboard"
  | "capture"
  | "workflows"
  | "personalize"
  | "troubleshooting";

/** 支持的正文语言；与 i18n 的 LocaleCode 保持一致但不反向依赖（避免循环）。 */
export type HelpLocale = "zh-CN" | "en-US";

/**
 * 结构化正文段落。渲染为纯 React，不引入 markdown 解析器：
 * - heading：小节标题；
 * - paragraph：普通段落；
 * - steps：有序操作步骤（每项一句话，可含「设置 → 外观」式路径）；
 * - tip / note / callout：提示 / 注意 / 重要（视觉强度递增）。
 */
export type HelpSection =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "steps"; items: readonly string[] }
  | { type: "tip"; text: string }
  | { type: "note"; text: string }
  | { type: "callout"; text: string };

/** 单语言的教程正文。 */
export interface HelpArticleContent {
  title: string;
  /** 一句话摘要：列表与 ContextHelpButton 弹层展示。 */
  summary: string;
  sections: readonly HelpSection[];
}

/** 帮助教程文章（注册中心条目）。 */
export interface HelpArticle {
  /**
   * 稳定唯一 ID，格式 `help.<categoryId>.<slug>`（slug 为小写字母/数字/短横线）。
   * ID 是公开契约：ContextHelpButton、测试与文档都引用它，重命名视为破坏性变更。
   */
  id: string;
  categoryId: HelpCategoryId;
  /** 正文翻译；zh-CN 必填，en-US 缺失时 UI 显示「暂无英文版」状态徽标。 */
  translations: { "zh-CN": HelpArticleContent; "en-US"?: HelpArticleContent };
  /** 搜索关键词（按语言）；zh-CN 必填，verified 文章强制非空。 */
  keywords: { "zh-CN": readonly string[]; "en-US"?: readonly string[] };
  /** 关联功能（必须是 featureCatalog 已登记的 id，契约测试校验）。 */
  relatedFeatureIds: readonly string[];
  /** 关联页面（必须是 navigationRegistry 已登记的入口 id，契约测试校验）。 */
  relatedRouteIds: readonly string[];
  /**
   * 阅读前提能力（自由字符串，如 "system-notification"）。
   * 当前无能力注册表可校验，仅要求非空字符串数组；后续接入能力探测时再收紧。
   */
  requiredCapabilities?: readonly string[];
  /** 正文结构版本：内容结构性修改（增删段落/步骤语义变化）时递增，≥1。 */
  contentVersion: number;
  /** 最近一次人工核对针对的发布版本（如 "v0.11"），非空。 */
  reviewedForVersion: string;
  status: HelpArticleStatus;
}
