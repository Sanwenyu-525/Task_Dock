//! 教程状态 → 徽标（文案键 + 语义色）的统一映射。
//! 业务状态到 tone 的映射集中在这一处（遵循 StatusBadge 的边界约定），
//! 文案键在 zh-CN / en-US 词典中都有真实翻译（契约测试兜底）。

import type { MessageKey } from "../i18n/messages";
import type { StatusTone } from "../components/ui/StatusBadge";
import type { HelpArticleStatus } from "./types";

export interface HelpStatusMeta {
  labelKey: MessageKey;
  tone: StatusTone;
}

export const HELP_STATUS_META: Record<HelpArticleStatus, HelpStatusMeta> = {
  verified: { labelKey: "help.status.verified", tone: "success" },
  needs_review: { labelKey: "help.status.needs_review", tone: "warning" },
  draft: { labelKey: "help.status.draft", tone: "neutral" },
  unavailable: { labelKey: "help.status.unavailable", tone: "danger" },
};
