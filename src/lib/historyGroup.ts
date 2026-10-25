//! 历史时间轴：通知 + Agent 事件合并、按日分组、连续重复事件聚合（纯函数）。

import type { AgentEventRow, NotificationRow } from "./bridge";

export interface HistoryEntry {
  key: string;
  ts: number; // 排序用毫秒时间戳
  iso: string;
  kind: "notification" | "event";
  source: string; // 通知 kind 或事件 source_id
  title: string;
  unread: boolean;
  /** 聚合的重复条数（≥2 表示连续重复） */
  count: number;
  notification?: NotificationRow;
  event?: AgentEventRow;
  /** 聚合代表的原始条目（含被折叠的） */
  collapsedKeys?: string[];
}

export interface DayGroup {
  label: string; // 今天 / 昨天 / 10-24
  entries: HistoryEntry[];
}

const DAY = 86400000;

function startOfDay(d: Date): number {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function dayLabel(ts: number, now = Date.now()): string {
  const diff = Math.round((startOfDay(new Date(ts)) - startOfDay(new Date(now))) / DAY);
  if (diff === 0) return "今天";
  if (diff === -1) return "昨天";
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 连续重复判定：同来源 + 同状态（事件）或同类型 + 同标题（通知）。 */
function sameSignature(a: HistoryEntry, b: HistoryEntry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "event") {
    return a.source === b.source && a.event?.state === b.event?.state;
  }
  return a.source === b.source && a.title === b.title;
}

/**
 * 合并通知与事件 → 按时间倒序 → 按日分组 → 组内折叠连续重复。
 * 折叠只发生在同一天内（跨日的相同事件分属各自日期，不互相吞并）。
 * 聚合保留全部原始 key（不丢失记录，展开可见）。
 */
export function groupHistory(
  notifications: NotificationRow[],
  events: AgentEventRow[],
  opts: { aggregate?: boolean; now?: Date } = {},
): DayGroup[] {
  const aggregate = opts.aggregate ?? true;
  const now = opts.now ?? new Date();

  const entries: HistoryEntry[] = [];
  for (const n of notifications) {
    const ts = new Date(n.created_at).getTime();
    if (!Number.isNaN(ts)) {
      entries.push({
        key: `n:${n.id}`,
        ts,
        iso: n.created_at,
        kind: "notification",
        source: n.kind,
        title: n.title,
        unread: !n.is_read,
        count: 1,
        notification: n,
      });
    }
  }
  for (const e of events) {
    const ts = new Date(e.received_at).getTime();
    if (!Number.isNaN(ts)) {
      entries.push({
        key: `e:${e.id}`,
        ts,
        iso: e.received_at,
        kind: "event",
        source: e.source_id,
        title: e.state,
        unread: false,
        count: 1,
        event: e,
      });
    }
  }
  entries.sort((a, b) => b.ts - a.ts);

  // 先按日分组（倒序遍历 → 组按日期倒序）
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;
  for (const e of entries) {
    const label = dayLabel(e.ts, now.getTime());
    if (!current || current.label !== label) {
      current = { label, entries: [] };
      groups.push(current);
    }
    current.entries.push(e);
  }

  // 组内折叠连续重复
  if (aggregate) {
    for (const g of groups) {
      const folded: HistoryEntry[] = [];
      for (const e of g.entries) {
        const prev = folded[folded.length - 1];
        if (prev && sameSignature(prev, e)) {
          prev.count += 1;
          prev.collapsedKeys = [...(prev.collapsedKeys ?? []), e.key];
        } else {
          folded.push({ ...e });
        }
      }
      g.entries = folded;
    }
  }
  return groups;
}

/** 时间过滤：仅保留 fromTs 之后的条目（重新分组）。 */
export function filterGroupsByTime(groups: DayGroup[], fromTs: number): DayGroup[] {
  return groups
    .map((g) => ({ ...g, entries: g.entries.filter((e) => e.ts >= fromTs) }))
    .filter((g) => g.entries.length > 0);
}
