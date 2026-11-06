//! 帮助分类元数据：标签走全局 i18n 词典（切语言即时生效），顺序即展示顺序。

import type { MessageKey } from "../i18n/messages";
import type { HelpCategoryId } from "./types";

export const HELP_CATEGORY_ORDER: readonly HelpCategoryId[] = [
  "quickstart",
  "tasks",
  "agents",
  "clipboard",
  "capture",
  "workflows",
  "personalize",
  "troubleshooting",
] as const;

/** 分类展示名的全局词典键（zh-CN 与 en-US 都必须存在，i18n 测试兜底）。 */
export const HELP_CATEGORY_LABEL_KEYS: Record<HelpCategoryId, MessageKey> = {
  quickstart: "help.category.quickstart",
  tasks: "help.category.tasks",
  agents: "help.category.agents",
  clipboard: "help.category.clipboard",
  capture: "help.category.capture",
  workflows: "help.category.workflows",
  personalize: "help.category.personalize",
  troubleshooting: "help.category.troubleshooting",
};
