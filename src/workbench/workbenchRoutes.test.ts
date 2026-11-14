//! 工作台路由与导航注册中心契约：不允许出现第二份功能清单或漂移的 ID。

import { describe, expect, it } from "vitest";
import {
  entriesForSurface,
  allEntryIds,
  lockedEntryIds,
  navEntry,
} from "../lib/navigationRegistry";
import { WORKBENCH_ROUTES, isWorkbenchRoute } from "../lib/workbenchLayout";
import { TAB_ORDER } from "../store/useUiStore";

describe("workbench routes", () => {
  it("工作台路由 = 首页 + 左侧注册中心覆盖的全部逻辑 Tab（不多不少）", () => {
    const registryTabs = new Set(
      entriesForSurface("left").flatMap((entry) => entry.tabs),
    );
    const workbenchTabs = new Set(WORKBENCH_ROUTES.filter((route) => route !== "home"));
    expect(workbenchTabs).toEqual(registryTabs);
    expect(WORKBENCH_ROUTES).toContain("home");
  });

  it("覆盖已发布快捷键的全部逻辑 Tab（Ctrl+数字语义不漂移）", () => {
    for (const tab of TAB_ORDER) {
      expect(isWorkbenchRoute(tab)).toBe(true);
    }
  });

  it("路由唯一，且 settings 仍是固定入口", () => {
    expect(new Set(WORKBENCH_ROUTES).size).toBe(WORKBENCH_ROUTES.length);
    expect(lockedEntryIds("left")).toEqual(["settings"]);
    expect(navEntry("settings")?.locked).toBe(true);
  });

  it("注册中心入口 ID 唯一（工作台侧栏直接复用，不另建清单）", () => {
    const ids = allEntryIds("left");
    expect(new Set(ids).size).toBe(ids.length);
  });
});
