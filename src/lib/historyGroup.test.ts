import { describe, expect, it } from "vitest";
import type { AgentEventRow, NotificationRow } from "./bridge";
import { dayLabel, filterGroupsByTime, groupHistory } from "./historyGroup";

const NOW = new Date("2026-10-25T12:00:00");

function notif(id: string, kind: string, title: string, createdAt: string, unread = false): NotificationRow {
  return { id, kind, title, body: "", ref_type: null, ref_id: null, occurrence: null, is_read: !unread, created_at: createdAt };
}
function ev(id: string, src: string, state: string, receivedAt: string, over: Partial<AgentEventRow> = {}): AgentEventRow {
  return { id, source_id: src, session_external_id: "s", run_external_id: null, event_type: "status", state, message: null, received_at: receivedAt, ...over };
}

describe("groupHistory", () => {
  it("合并通知与事件并按时间倒序", () => {
    const groups = groupHistory(
      [notif("n1", "reminder", "提醒A", "2026-10-25T11:00:00Z")],
      [ev("e1", "codex", "running", "2026-10-25T11:30:00Z")],
      { now: NOW },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("今天");
    const kinds = groups[0].entries.map((e) => e.kind);
    expect(kinds).toEqual(["event", "notification"]);
  });

  it("连续重复的失联事件聚合为一条并计数", () => {
    const groups = groupHistory(
      [],
      [
        ev("e1", "codex", "disconnected", "2026-10-25T11:20:00Z"),
        ev("e2", "codex", "disconnected", "2026-10-25T11:10:00Z"),
        ev("e3", "codex", "disconnected", "2026-10-25T11:00:00Z"),
      ],
      { now: NOW },
    );
    const entries = groups[0].entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(3);
    expect(entries[0].collapsedKeys).toEqual(["e:e2", "e:e3"]);
  });

  it("同来源不同状态不聚合", () => {
    const groups = groupHistory(
      [],
      [
        ev("e1", "codex", "disconnected", "2026-10-25T11:20:00Z"),
        ev("e2", "codex", "running", "2026-10-25T11:10:00Z"),
      ],
      { now: NOW },
    );
    expect(groups[0].entries).toHaveLength(2);
  });

  it("聚合不跨日：相邻但隔日的相同事件分属各自日期", () => {
    // 用本地时间字符串确保跨越本地午夜（NOW 为本地 2026-10-25 12:00）
    const groups = groupHistory(
      [],
      [
        ev("e1", "codex", "disconnected", "2026-10-24T23:50:00"),
        ev("e2", "codex", "disconnected", "2026-10-25T00:10:00"),
      ],
      { now: NOW, aggregate: true },
    );
    // 折叠只发生在同一天内，隔日的相同事件不会被吞并
    const total = groups.reduce((acc, g) => acc + g.entries.length, 0);
    expect(total).toBe(2);
    expect(groups.every((g) => g.entries.every((e) => e.count === 1))).toBe(true);
  });

  it("按日期分组：今天/昨天/更早", () => {
    const groups = groupHistory(
      [],
      [
        ev("e1", "codex", "running", "2026-10-25T09:00:00Z"),
        ev("e2", "codex", "running", "2026-10-24T09:00:00Z"),
        ev("e3", "codex", "running", "2026-10-20T09:00:00Z"),
      ],
      { now: NOW },
    );
    expect(groups.map((g) => g.label)).toEqual(["今天", "昨天", "10-20"]);
  });

  it("同一时间戳的条目按稳定 key 排序，翻页合并不改变顺序", () => {
    const ts = "2026-10-25T11:00:00Z";
    const groups = groupHistory(
      [notif("a", "reminder", "提醒A", ts)],
      [ev("z", "codex", "running", ts)],
      { now: NOW },
    );
    expect(groups[0].entries.map((e) => e.key)).toEqual(["n:a", "e:z"]);
  });

  it("未读状态保留在条目上", () => {
    const groups = groupHistory([notif("n1", "agent_waiting", "等待", "2026-10-25T10:00:00Z", true)], [], { now: NOW });
    expect(groups[0].entries[0].unread).toBe(true);
  });
});

describe("filterGroupsByTime", () => {
  it("按时间下限过滤并丢弃空分组", () => {
    const groups = groupHistory(
      [],
      [
        ev("e1", "codex", "running", "2026-10-25T11:00:00Z"),
        ev("e2", "codex", "running", "2026-10-23T11:00:00Z"),
      ],
      { now: NOW },
    );
    const from = new Date("2026-10-24T00:00:00").getTime();
    const filtered = filterGroupsByTime(groups, from);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].label).toBe("今天");
  });
});

describe("dayLabel", () => {
  it("边界值", () => {
    expect(dayLabel(NOW.getTime(), NOW.getTime())).toBe("今天");
    expect(dayLabel(new Date("2026-10-24T23:00:00").getTime(), NOW.getTime())).toBe("昨天");
  });
});
