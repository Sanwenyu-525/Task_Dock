//! 应用搜索纯函数测试：名称与包名两条路径保持既有验收行为。

import { describe, expect, it } from "vitest";

import type { VdApp } from "../../../lib/bridge";
import { filterApps } from "./format";

function app(packageName: string, label: string | null): VdApp {
  return {
    package: packageName,
    label,
    icon: null,
    system: false,
    launchable: true,
    reason: null,
  };
}

const APPS = [
  app("com.android.settings", "设置"),
  app("com.google.android.chrome", "Chrome"),
  app("dev.taskdock.mobile", "TaskDock 手机端"),
  app("com.example.unknown", null),
];

describe("filterApps", () => {
  it("按本地化名称匹配（大小写不敏感）", () => {
    expect(filterApps(APPS, "chrome").map((item) => item.package)).toEqual([
      "com.google.android.chrome",
    ]);
    expect(filterApps(APPS, "设置").map((item) => item.package)).toEqual([
      "com.android.settings",
    ]);
    expect(filterApps(APPS, "  TASKDOCK ").map((item) => item.package)).toEqual([
      "dev.taskdock.mobile",
    ]);
  });

  it("按包名片段匹配", () => {
    expect(filterApps(APPS, "android").map((item) => item.package)).toEqual([
      "com.android.settings",
      "com.google.android.chrome",
    ]);
    expect(filterApps(APPS, "dev.taskdock").map((item) => item.package)).toEqual([
      "dev.taskdock.mobile",
    ]);
  });

  it("空关键词返回原列表，无匹配返回空数组", () => {
    expect(filterApps(APPS, "   ")).toBe(APPS);
    expect(filterApps(APPS, "not-installed")).toEqual([]);
  });
});
