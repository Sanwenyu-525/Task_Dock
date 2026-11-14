//! 句式命令的前端纯函数：帧表近似判定、行数与可发现性提示。
//!
//! 这里是**路由启发式**，不是解析事实源：真正的帧表与时间解析在 Rust
//! `command_phrases.rs`。判定只用来避免每次按键都发 IPC，宽松命中后由后端裁决；
//! 后端返回 null 时按普通搜索处理（零损失回退）。

import type { PhraseResolution } from "./bridge";
import type { MessageKey } from "../i18n";

/** 帧表可能覆盖的起手词/关键词（刻意宽松，避免漏发解析请求）。 */
const PHRASE_PREFIXES = ["完成", "把", "本周", "有哪些", "逾期", "今天要", "哪些"];

export function looksLikePhrase(raw: string): boolean {
  const q = raw.trim();
  if (!q) return false;
  if (PHRASE_PREFIXES.some((p) => q.startsWith(p))) return true;
  return q.includes("改到") || q.includes("优先级");
}

/** 句式区在 flat 键盘序中的行数（写意图 = 候选数，查询 = 结果条目数）。 */
export function phraseRowCount(phrase: PhraseResolution | null): number {
  if (!phrase) return 0;
  return phrase.kind === "query" ? phrase.items.length : phrase.candidates.length;
}

/** 未命中帧表时的模板提示：教用户可用的句式，而不是静默无反应。 */
export function phraseHints(raw: string): MessageKey[] {
  const q = raw.trim();
  if (!q) return [];
  if (q.startsWith("本周")) return ["commandPhrases.hint.week"];
  if (q.startsWith("有哪些") || q.startsWith("逾期")) return ["commandPhrases.hint.overdue"];
  if (q.startsWith("今天要")) return ["commandPhrases.hint.today"];
  if (q.startsWith("哪些")) return ["commandPhrases.hint.agents"];
  if (q.includes("优先级")) return ["commandPhrases.hint.priority"];
  if (q.includes("改到")) return ["commandPhrases.hint.reschedule"];
  if (q.startsWith("把")) {
    return [
      "commandPhrases.hint.completeBaci",
      "commandPhrases.hint.reschedule",
      "commandPhrases.hint.priority",
    ];
  }
  if (q.startsWith("完成")) return ["commandPhrases.hint.complete"];
  return [];
}

/** 空输入时的可发现性示例（固定短列表，不随语言分支变化）。 */
export const PHRASE_EXAMPLES: MessageKey[] = [
  "commandPhrases.hint.complete",
  "commandPhrases.hint.reschedule",
  "commandPhrases.hint.week",
];

export function priorityLabelKey(priority: number | null | undefined): MessageKey {
  if (priority === 1) return "commandPhrases.priority.high";
  if (priority === 3) return "commandPhrases.priority.low";
  return "commandPhrases.priority.medium";
}
