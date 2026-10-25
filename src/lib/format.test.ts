import { describe, expect, it } from "vitest";
import {
  formatDayLabel,
  formatDue,
  formatDuration,
  formatRelative,
  fromLocalInputValue,
  isOverdue,
  priorityLabel,
  toLocalInputValue,
} from "./format";

const NOW = new Date("2026-10-25T13:00:00");

describe("formatDayLabel", () => {
  it("识别今天/明天/后天", () => {
    expect(formatDayLabel(new Date("2026-10-25T09:00:00"), NOW)).toBe("今天");
    expect(formatDayLabel(new Date("2026-10-26T09:00:00"), NOW)).toBe("明天");
    expect(formatDayLabel(new Date("2026-10-27T09:00:00"), NOW)).toBe("后天");
  });
  it("其它日期显示月日", () => {
    expect(formatDayLabel(new Date("2026-11-03T09:00:00"), NOW)).toBe("11-03");
  });
});

describe("formatDue", () => {
  it("组合日期与时刻", () => {
    expect(formatDue("2026-10-26T15:00:00", NOW)).toBe("明天 15:00");
  });
  it("空值返回空串", () => {
    expect(formatDue(null, NOW)).toBe("");
    expect(formatDue("invalid", NOW)).toBe("");
  });
});

describe("formatRelative", () => {
  it("未来时间", () => {
    expect(formatRelative("2026-10-25T13:30:00", NOW)).toBe("30 分钟后");
    expect(formatRelative("2026-10-25T16:00:00", NOW)).toBe("3 小时后");
    expect(formatRelative("2026-10-27T13:00:00", NOW)).toBe("2 天后");
  });
  it("过去时间", () => {
    expect(formatRelative("2026-10-25T11:00:00", NOW)).toBe("2 小时前");
  });
});

describe("isOverdue", () => {
  it("过期判断", () => {
    expect(isOverdue("2026-10-25T12:00:00", NOW)).toBe(true);
    expect(isOverdue("2026-10-25T14:00:00", NOW)).toBe(false);
    expect(isOverdue(null, NOW)).toBe(false);
  });
});

describe("formatDuration", () => {
  it("分秒与时分秒", () => {
    expect(formatDuration(83000)).toBe("01:23");
    expect(formatDuration(3723000)).toBe("1:02:03");
  });
});

describe("priorityLabel", () => {
  it("边界收敛", () => {
    expect(priorityLabel(0)).toBe("P0");
    expect(priorityLabel(3)).toBe("P3");
    expect(priorityLabel(9)).toBe("P3");
    expect(priorityLabel(-1)).toBe("P0");
  });
});

describe("datetime-local 转换", () => {
  it("ISO 与本地输入值互转", () => {
    const iso = new Date("2026-10-26T15:30:00").toISOString();
    const local = toLocalInputValue(iso);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(new Date(fromLocalInputValue(local)!).getTime()).toBe(new Date(iso).getTime());
  });
  it("空值安全", () => {
    expect(toLocalInputValue(null)).toBe("");
    expect(fromLocalInputValue("")).toBeNull();
  });
});
