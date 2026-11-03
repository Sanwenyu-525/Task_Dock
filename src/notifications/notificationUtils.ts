//! 通知队列纯逻辑：状态模板配置、合并键、入栈折叠（容量上限 + 关键卡保护）、
//! 自动消失计时。无 React/Tauri 依赖，全部可单测。
//!
//! 策略要点（任务规格）：
//! - 同一合并键（同一轮次/同一提醒）的新事件**更新既有卡片**，不重复创建；
//! - 最多 3 条独立卡：溢出时优先折叠**普通卡**（执行中/完成/提醒），
//!   等待/失败/断连等关键卡不能被普通卡挤掉（全是关键卡时才折叠最旧关键卡）；
//! - 被折叠的通知进入紫色摘要卡（kind=digest），数量按类型累计，
//!   原始通知历史不受影响（折叠只影响展示栈）；
//! - 各状态自动消失时长来自原型规格：hover/focus/展开暂停，离开续接剩余时间。

import type {
  ActionId,
  DetailRow,
  NotificationCardData,
  NotificationKind,
  QueuedCard,
} from "./notificationTypes";

/** 默认按钮文案；view 的准确文案由 actionLabel 按可定位性动态给出。 */
export const ACTION_LABELS: Record<ActionId, string> = {
  view: "查看详情",
  handle: "立即处理",
  snooze: "稍后提醒",
  done: "完成任务",
  center: "通知中心",
  expand: "展开详情",
};

/** 同时独立展示的卡片上限（摘要卡不占新位，替换既有摘要时也不超限）。 */
export const MAX_VISIBLE = 3;

/** 卡片正文区可见的摘要最大字符数：超出后由展开详情承载完整内容（与 CSS 两行截断对齐）。 */
export const SUMMARY_CLAMP_CHARS = 80;

/** 各状态自动消失时长（ms，原型规格值）。 */
export const AUTO_DISMISS_MS: Record<NotificationKind, number> = {
  agent_running: 6000,
  agent_waiting: 12000,
  agent_done: 5000,
  agent_failed: 13000,
  agent_disconnected: 13000,
  digest: 8000,
  reminder: 6000,
  generic: 6000,
};

/** 普通卡：可被新通知挤进摘要；关键卡（等待/失败/断连）受保护。 */
export function isCriticalKind(kind: string): boolean {
  return kind === "agent_waiting" || kind === "agent_failed" || kind === "agent_disconnected";
}

/** 运行时归一化：后端未来新增 kind 时窗口不崩，落到中性模板。 */
export function normalizeKind(kind: string): NotificationKind {
  switch (kind) {
    case "agent_running":
    case "agent_waiting":
    case "agent_done":
    case "agent_failed":
    case "agent_disconnected":
    case "reminder":
    case "digest":
      return kind;
    default:
      return "generic";
  }
}

/** 状态色（原型 C 方案语义色；浅色主题下文本用加深变体，见样式表）。 */
export const KIND_TONE: Record<NotificationKind, string> = {
  agent_running: "#3882F6",
  agent_waiting: "#F5B90B",
  agent_done: "#22C55E",
  agent_failed: "#EF4444",
  agent_disconnected: "#F97316",
  digest: "#A855F7",
  reminder: "#3882F6",
  generic: "#3882F6",
};

/** 合并键：同一轮次（refId=run id）更新同一张卡；提醒按任务；摘要唯一。 */
export function mergeKeyOf(card: NotificationCardData): string {
  if (card.kind === "digest") return "digest";
  if (card.refId) return `ref:${card.refId}`;
  if (card.sourceId && card.sessionId) return `agent:${card.sourceId}:${card.sessionId}`;
  return `id:${card.id}`;
}

function toQueued(card: NotificationCardData, now: number): QueuedCard {
  const kind = normalizeKind(card.kind);
  return {
    ...card,
    kind,
    mergeKey: mergeKeyOf(card),
    expiresAt: now + AUTO_DISMISS_MS[kind],
  };
}

/** 摘要卡内容（folded 为被折叠卡的类型与标题，展开详情用）。 */
function digestCard(folded: { kind: string; title: string }[], now: number): QueuedCard {
  const counts = countByKind(folded);
  const parts: string[] = [];
  const labels: Record<string, string> = {
    agent_running: "执行中",
    agent_done: "完成",
    agent_waiting: "等待",
    agent_failed: "失败",
    agent_disconnected: "断连",
    reminder: "提醒",
  };
  for (const [k, n] of Object.entries(counts)) {
    parts.push(`${n} 个${labels[k] ?? k}`);
  }
  return {
    id: "digest",
    kind: "digest",
    title: `${folded.length} 条状态更新已合并`,
    body: parts.join(" · "),
    createdAt: new Date(now).toISOString(),
    mergeKey: "digest",
    expiresAt: now + AUTO_DISMISS_MS.digest,
    folded,
  };
}

export function countByKind(folded: { kind: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of folded) {
    counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  }
  return counts;
}

/**
 * 入栈一批新卡片（后端一次事件可能带多条）。
 * 返回新数组；不修改入参。相同 mergeKey 就地更新（保持位置、重置计时）。
 */
export function applyIncoming(
  queue: QueuedCard[],
  incoming: NotificationCardData[],
  now: number,
): QueuedCard[] {
  let next = [...queue];
  for (const raw of incoming) {
    const card = toQueued(raw, now);
    const idx = next.findIndex((c) => c.mergeKey === card.mergeKey);
    if (idx >= 0) {
      next[idx] = card;
    } else {
      next.push(card);
    }
  }
  return withCapacity(next, now);
}

/** 容量上限：溢出时折叠进摘要；关键卡受保护（不能被普通卡挤掉）。
 *  后端下发的 digest 卡保留其原始标题/正文（「另有 N 条已记录到收件箱」），
 *  不占独立卡额度并排在栈尾；本地折叠累计进它的 folded（展开详情/计数用）。 */
export function withCapacity(queue: QueuedCard[], now: number): QueuedCard[] {
  const digestBase = queue.find((c) => c.kind === "digest") ?? null;
  let folded: { kind: string; title: string }[] = digestBase?.folded
    ? [...digestBase.folded]
    : [];
  let next = queue.filter((c) => c.kind !== "digest");
  while (next.length > MAX_VISIBLE) {
    const victimIdx = findEvictionIndex(next);
    const victim = next[victimIdx];
    folded = [...folded, { kind: victim.kind, title: victim.title }];
    next.splice(victimIdx, 1);
  }
  if (digestBase) {
    // 本地合成摘要（id 固定 "digest"）：随折叠重建标题/计数正文；
    // 后端下发摘要：保留原始文案（另有 N 条已记录到收件箱），folded 只喂展开详情
    next.push(
      digestBase.id === "digest"
        ? digestCard(folded, Date.parse(digestBase.createdAt) || now)
        : { ...digestBase, folded },
    );
  } else if (folded.length > 0) {
    next.push(digestCard(folded, now));
  }
  return next;
}

/** 折叠候选：最旧的普通卡优先；全是关键卡时才折叠最旧的关键卡。 */
export function findEvictionIndex(queue: QueuedCard[]): number {
  for (let i = 0; i < queue.length; i++) {
    if (!isCriticalKind(queue[i].kind)) return i;
  }
  return 0;
}

/** 手动/自动关闭后的栈（摘要卡保留，后续折叠继续累计其计数）。 */
export function withoutCard(queue: QueuedCard[], id: string, now: number): QueuedCard[] {
  const next = queue.filter((c) => c.id !== id);
  return withCapacity(next, now);
}

// ── 自动消失计时（悬停/焦点/展开暂停，续接剩余时间）──────────────

/** 暂停时返回剩余 ms；卡片不展开且未暂停时不需要调用。 */
export function remainingMs(card: QueuedCard, now: number): number {
  return Math.max(0, card.expiresAt - now);
}

/** 从暂停恢复：以 now + remaining 重建期限（续接剩余时间，不重置完整时长）。 */
export function resumeDeadline(pausedRemaining: number, now: number): number {
  return now + pausedRemaining;
}

/** 展开期间不自动消失：给展开卡一个远期期限；收起时恢复剩余时间。 */
export const EXPANDED_HOLD_MS = 10 * 60 * 1000;

// ── 展示辅助 ────────────────────────────────────────────────

/** 「刚刚 / N 分钟前 / HH:mm」；消费 createdAt，不做本地时钟写操作。 */
export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 等待卡显示的已等待时长（等待通知的产生时间 = 等待开始的可信下界）。 */
export function waitingDuration(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return "不到 1 分钟";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟`;
  return `${Math.floor(diff / 3_600_000)} 小时 ${Math.floor((diff % 3_600_000) / 60_000)} 分`;
}

/** 展开详情行：只用真实携带的数据，不伪造；与顶部时间/正文重复的信息不再重复展示。 */
export function detailRows(card: QueuedCard, now: number): DetailRow[] {
  const rows: DetailRow[] = [];
  const kind = normalizeKind(card.kind);
  // 正文已带来源时不重复（如 "codex · ..."）；正文没提才作为补充信息。
  if (card.sourceId && !card.body.includes(card.sourceId)) {
    rows.push({ label: "来源 Agent", value: card.sourceId });
  }
  if (kind === "agent_waiting") {
    // 短原因已在卡片正文区可见；只有被限行截断的完整原因才进展开详情。
    if (card.detail?.trim() && card.detail.trim().length > SUMMARY_CLAMP_CHARS) {
      rows.push({ label: "等待原因", value: card.detail.trim(), warning: true });
    }
    rows.push({ label: "已等待", value: waitingDuration(card.createdAt, now) });
    rows.push({ label: "建议操作", value: "进入 Agent 会话处理" });
  }
  if (kind === "agent_disconnected") {
    rows.push({
      label: "结论",
      value: "连接状态无法确认",
      warning: true,
    });
    rows.push({
      label: "任务结果",
      value: "未知，不能推断失败",
      warning: true,
    });
  }
  if (kind === "agent_failed") {
    // 短原因已在卡片正文区可见（见 visibleSummary），这里只在被限行截断时才展开完整原因。
    if (card.detail?.trim() && card.detail.trim().length > SUMMARY_CLAMP_CHARS) {
      rows.push({ label: "错误原因", value: card.detail.trim() });
    }
    // 正文限行：只有被截断/多行时才需要就地看完整错误，避免和正文重复。
    const body = card.body.trim();
    if (body.length > 60 || body.includes("\n")) {
      rows.push({ label: "错误详情", value: body });
    }
  }
  if (kind === "digest" && card.folded?.length) {
    for (const f of card.folded) rows.push({ label: "已合并", value: f.title });
  }
  return rows;
}

/** 是否值得提供「展开详情」：无补充信息时不显示无意义入口。 */
export function hasUsefulDetails(card: QueuedCard, now: number): boolean {
  return detailRows(card, now).length > 0;
}

/**
 * 卡片正文区可直接展示的摘要（结果摘要 / 错误原因 / 等待原因）。
 * 只取事件回执里的真实原因，没有就返回 null，不用占位文案凑数。
 */
export function visibleSummary(card: NotificationCardData): string | null {
  const kind = normalizeKind(card.kind);
  if (kind !== "agent_done" && kind !== "agent_failed" && kind !== "agent_waiting") {
    return null;
  }
  const detail = card.detail?.trim();
  return detail ? detail : null;
}

/** 通知是否携带可定位的 Agent 对象（内部会话行 id 由后端解析，前端不推断）。 */
export function agentLocatable(card: NotificationCardData): boolean {
  return Boolean(card.sourceId && card.sessionId);
}

function isAgentKind(kind: NotificationKind): boolean {
  return (
    kind === "agent_running" ||
    kind === "agent_waiting" ||
    kind === "agent_done" ||
    kind === "agent_failed" ||
    kind === "agent_disconnected"
  );
}

/** 按钮文案必须准确：能定位说定位，只能开页面就说打开页面，提醒说打开任务。 */
export function actionLabel(card: NotificationCardData, id: ActionId): string {
  const kind = normalizeKind(card.kind);
  if (id === "view") {
    if (kind === "reminder") return "打开任务";
    if (isAgentKind(kind)) {
      if (!agentLocatable(card)) return "打开 Agent 面板";
      if (kind === "agent_failed") return "查看失败详情";
      if (kind === "agent_disconnected") return "查看连接详情";
      return "定位本轮";
    }
    return "查看详情";
  }
  return ACTION_LABELS[id];
}

/** 醒目主按钮只在需要立即行动的状态出现；完成/执行中用轻量文字操作。 */
export function primaryActionFor(card: QueuedCard): ActionId | null {
  switch (normalizeKind(card.kind)) {
    case "agent_waiting":
      return agentLocatable(card) ? "handle" : "view";
    case "agent_failed":
    case "agent_disconnected":
      return "view";
    case "reminder":
      return "view";
    default:
      return null;
  }
}

/** 轻量文字操作：完成/执行中不占整行主按钮，避免无意义的强强调。 */
export function isLightweightActionCard(card: QueuedCard): boolean {
  const kind = normalizeKind(card.kind);
  return kind === "agent_running" || kind === "agent_done" || kind === "generic";
}

/** 各状态动作配置；「重试/重新连接」无真实能力不提供（规格禁止伪造入口）。
 * 提醒卡：携带 refId（任务 id）才提供 稍后提醒/完成任务（真实后端操作）；
 * 合并摘要卡只保留「通知中心」外部入口，就地展开由底部详情入口承担，避免重复。 */
export function actionsFor(card: QueuedCard): ActionId[] {
  switch (normalizeKind(card.kind)) {
    case "agent_running":
    case "agent_done":
    case "agent_failed":
    case "agent_disconnected":
      return ["view"];
    case "agent_waiting":
      return agentLocatable(card) ? ["handle", "snooze"] : ["view", "snooze"];
    case "digest":
      return ["center"];
    case "reminder":
      return card.refId ? ["view", "snooze", "done"] : ["view"];
    default:
      return ["view"];
  }
}

