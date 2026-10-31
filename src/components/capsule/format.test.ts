//! 胶囊面板时间文案单测（纯函数）。

import { describe, expect, it } from "vitest";
import { dueLabel, humanGap, sortPending } from "./format";

const at = (s: string) => new Date(s).getTime();

describe("humanGap", () => {
  it("分 / 时 / 天三档，取绝对值", () => {
    expect(humanGap(-90_000)).toBe("2m");
    expect(humanGap(3 * 3600_000)).toBe("3h");
    expect(humanGap(-50 * 3600_000)).toBe("2d");
    expect(humanGap(10_000)).toBe("1m"); // 不足 1 分钟按 1m，不出现 0m
  });
});

describe("dueLabel", () => {
  const now = at("2026-10-31T20:00:00");

  it("无截止时间 → 无期限", () => {
    expect(dueLabel(null, now)).toEqual({ text: "无期限", tone: "normal" });
    expect(dueLabel("not-a-date", now).text).toBe("无期限");
  });

  it("已过期 → 逾期 + 时长，语义色 overdue", () => {
    expect(dueLabel("2026-10-31T18:00:00", now)).toEqual({ text: "逾期 2h", tone: "overdue" });
  });

  it("今天 / 明天带时分", () => {
    expect(dueLabel("2026-10-31T23:30:00", now)).toEqual({ text: "今天 23:30", tone: "soon" });
    expect(dueLabel("2026-11-01T09:05:00", now)).toEqual({ text: "明天 09:05", tone: "soon" });
  });

  it("更远的未来 → 月日；跨年带年份", () => {
    expect(dueLabel("2026-11-05T10:00:00", now).text).toBe("11月5日");
    expect(dueLabel("2027-01-02T10:00:00", now).text).toBe("2027/1/2");
  });
});

describe("sortPending", () => {
  const now = at("2026-10-31T20:00:00");
  const mk = (id: string, due: string | null, created = "2026-10-01T00:00:00") => ({
    id,
    due_at: due,
    created_at: created,
  });

  it("过期优先，其次按截止升序，无期限最后", () => {
    const list = [
      mk("none", null),
      mk("later", "2026-11-02T10:00:00"),
      mk("overdue", "2026-10-30T10:00:00"),
      mk("soon", "2026-10-31T22:00:00"),
    ];
    expect(sortPending(list, now).map((t) => t.id)).toEqual(["overdue", "soon", "later", "none"]);
  });

  it("同档同时间按创建时间倒序（新的在前）", () => {
    const list = [
      mk("old", "2026-11-02T10:00:00", "2026-10-01T00:00:00"),
      mk("new", "2026-11-02T10:00:00", "2026-10-20T00:00:00"),
    ];
    expect(sortPending(list, now).map((t) => t.id)).toEqual(["new", "old"]);
  });

  it("不修改入参", () => {
    const list = [mk("a", "2026-11-02T10:00:00"), mk("b", null)];
    const before = list.map((t) => t.id);
    sortPending(list, now);
    expect(list.map((t) => t.id)).toEqual(before);
  });
});
