//! A01 补充契约：工作台路由表唯一性 + 左侧导航入口可解析。
//!
//! 覆盖的失败模式（修复前会真实变红）：
//! 1. 路由表出现重复 id（历史上 `life` 被注册两次）→ 唯一性用例失败；
//! 2. 某左侧入口的 id 无法在路由表解析，或合并入口的某个 tab 缺失 → 解析用例失败；
//! 3. `home` 是固定槽位（不走左侧导航），单独豁免：它必须在路由表内，
//!    但不允许出现在 NAV_ENTRIES 里被当成普通导航项。

import { describe, expect, it } from "vitest";
import {
  NAV_ENTRIES,
  entriesForSurface,
  type NavEntry,
} from "../lib/navigationRegistry";
import { WORKBENCH_ROUTES, isWorkbenchRoute } from "../lib/workbenchLayout";

describe("WORKBENCH_ROUTES 唯一性", () => {
  it("路由 id 不重复（重复注册会让 Tab 状态 / 高亮 / 持久化漂移）", () => {
    expect(new Set(WORKBENCH_ROUTES).size).toBe(WORKBENCH_ROUTES.length);
  });
});

describe("NAV_ENTRIES 左侧入口 → 路由表解析", () => {
  const routes = new Set<string>(WORKBENCH_ROUTES);

  /**
   * 普通入口：id 本身就是路由；合并入口（如 collection = inbox|shelf）
   * id 不是路由，要求它覆盖的每个 tab 都能在路由表解析。
   */
  function resolves(entry: NavEntry): boolean {
    if (routes.has(entry.id)) return true;
    return entry.tabs.length > 0 && entry.tabs.every((tab) => routes.has(tab));
  }

  it("左侧每个入口都能解析到工作台路由（合并入口按 tabs 解析）", () => {
    const unresolved = entriesForSurface("left").filter((entry) => !resolves(entry));
    expect(
      unresolved.map((entry) => entry.id),
      "存在无法解析到路由表的左侧导航入口",
    ).toEqual([]);
  });

  it("入口覆盖的全部逻辑 Tab 都在路由表内（isWorkbenchRoute 为真）", () => {
    for (const entry of entriesForSurface("left")) {
      for (const tab of entry.tabs) {
        expect(isWorkbenchRoute(tab)).toBe(true);
      }
    }
  });

  it("home 作为固定槽位单独豁免：在路由表内，但不属于左侧导航入口", () => {
    expect(routes.has("home")).toBe(true);
    const leftIds = new Set<string>(entriesForSurface("left").map((entry) => entry.id));
    expect(leftIds.has("home")).toBe(false);
    expect(NAV_ENTRIES.some((entry) => String(entry.id) === "home")).toBe(false);
  });
});
