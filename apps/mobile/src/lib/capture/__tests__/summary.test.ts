// 采集标题/体积格式化单测：这些字符串直接决定收集箱正文与列表元信息，
// 必须保证「只描述真实附件，不编造转写或占位文案」。
import { describe, expect, it } from "vitest";

import {
  autoCaptureTitle,
  describeItems,
  formatBytes,
  formatCaptureClock,
  formatDuration,
  taskTitleFromText,
} from "../summary";

describe("formatDuration", () => {
  it("按时长换算成分:秒，非法值返回 null", () => {
    expect(formatDuration(72_000)).toBe("1:12");
    expect(formatDuration(7_000)).toBe("0:07");
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });
});

describe("describeItems", () => {
  it("分别描述照片、语音与文件", () => {
    expect(describeItems([{ kind: "image" }, { kind: "image" }])).toBe("照片 2 张");
    expect(describeItems([{ kind: "audio", durationMs: 72_000 }])).toBe("语音 1:12");
    expect(describeItems([{ kind: "file", name: "report.pdf" }])).toBe("文件 report.pdf");
    expect(describeItems([{ kind: "file", name: "a.pdf" }, { kind: "file", name: "b.pdf" }])).toBe(
      "文件 2 个",
    );
  });

  it("混合附件按照片→语音→文件顺序拼接", () => {
    expect(
      describeItems([
        { kind: "file", name: "x.zip" },
        { kind: "image" },
        { kind: "audio", durationMs: 30_000 },
      ]),
    ).toBe("照片 1 张 · 语音 0:30 · 文件 x.zip");
  });

  it("没有附件时返回空串（由调用方保证此时有用户文字）", () => {
    expect(describeItems([])).toBe("");
  });
});

describe("autoCaptureTitle", () => {
  const at = new Date(2026, 10, 14, 9, 5).getTime();

  it("附件标题带本地时间戳", () => {
    expect(formatCaptureClock(at)).toBe("11-14 09:05");
    expect(autoCaptureTitle([{ kind: "image" }], at)).toBe("照片 1 张 · 11-14 09:05");
  });

  it("无附件时不生成标题（避免用假标题占位）", () => {
    expect(autoCaptureTitle([], at)).toBe("");
  });
});

describe("taskTitleFromText", () => {
  it("取首个非空行并限长", () => {
    expect(taskTitleFromText("\n\n第一行\n第二行", "兜底")).toBe("第一行");
    expect(taskTitleFromText("", "照片 1 张")).toBe("照片 1 张");
    expect(taskTitleFromText("x".repeat(80), "兜底").length).toBeLessThanOrEqual(61);
  });
});

describe("formatBytes", () => {
  it("按量级输出可读单位", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
