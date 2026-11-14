//! 资源页时间格式：短文本用于界面，完整时区保留在 Tooltip/aria；采样窗口按秒取整。

import { describe, expect, it } from "vitest";
import { resourceStamp, sampleWindowSeconds } from "./resourceTime";

describe("resourceStamp", () => {
  it("短时间只取 HH:mm，完整文本保留日期与时区", () => {
    const stamp = resourceStamp("2026-11-13T14:41:00.000Z");
    expect(stamp).not.toBeNull();
    expect(stamp?.time).toMatch(/^\d{2}:\d{2}$/);
    expect(stamp?.full).toMatch(/^2026-11-1[34] \d{2}:\d{2} UTC[+-]\d{2}:\d{2}$/);
    // 完整文本必须包含短文本，避免 Tooltip 与界面时间不一致。
    expect(stamp?.full).toContain(stamp?.time);
  });

  it("无效或缺失时间不伪造读数", () => {
    expect(resourceStamp(null)).toBeNull();
    expect(resourceStamp(undefined)).toBeNull();
    expect(resourceStamp("not-a-date")).toBeNull();
  });
});

describe("sampleWindowSeconds", () => {
  it("毫秒窗口按秒四舍五入，至少 1 秒", () => {
    expect(sampleWindowSeconds(79_355)).toBe(79);
    expect(sampleWindowSeconds(1_400)).toBe(1);
    expect(sampleWindowSeconds(400)).toBe(1);
  });

  it("无效或非正窗口返回 null，不显示 0 秒", () => {
    expect(sampleWindowSeconds(null)).toBeNull();
    expect(sampleWindowSeconds(undefined)).toBeNull();
    expect(sampleWindowSeconds(0)).toBeNull();
    expect(sampleWindowSeconds(-10)).toBeNull();
    expect(sampleWindowSeconds(Number.NaN)).toBeNull();
  });
});
