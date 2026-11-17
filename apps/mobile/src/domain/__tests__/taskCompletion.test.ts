// 首页完成率口径：验收表 05 的纯计算部分。
// 只认「全部任务」：分子=全部已完成，分母=全部任务；空任务不产生 NaN。
import { describe, expect, it } from "vitest";

import { completionOf } from "../taskQuery";

describe("completionOf", () => {
  it("空任务：0%，不出现 0/0 = NaN", () => {
    const result = completionOf({ total: 0, pending: 0, completed: 0, dueToday: 0, overdue: 0 });
    expect(result.percent).toBe(0);
    expect(result.ratio).toBe(0);
    expect(Number.isFinite(result.ratio)).toBe(true);
  });

  it("全部未完成：0%", () => {
    expect(completionOf({ total: 5, pending: 5, completed: 0, dueToday: 0, overdue: 0 }).percent).toBe(0);
  });

  it("全部完成：100%", () => {
    expect(completionOf({ total: 5, pending: 0, completed: 5, dueToday: 0, overdue: 0 }).percent).toBe(100);
  });

  it("部分完成：百分比四舍五入且比例在 0~1 之间", () => {
    const result = completionOf({ total: 7, pending: 4, completed: 3, dueToday: 0, overdue: 0 });
    expect(result.percent).toBe(43);
    expect(result.ratio).toBeCloseTo(3 / 7, 6);
  });

  it("异常计数也不越界（防御性 clamp）", () => {
    const result = completionOf({ total: 3, pending: 0, completed: 9, dueToday: 0, overdue: 0 });
    expect(result.ratio).toBe(1);
    expect(result.percent).toBe(100);
  });
});
