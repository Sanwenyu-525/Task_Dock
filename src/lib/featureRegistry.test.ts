// @vitest-environment node
//! 功能注册表契约：路由全覆盖、ID 唯一、策略合法。
//!
//! 目的不是测实现细节，而是**阻止后续新增页面绕过按需加载**：
//! - 新增 `WORKBENCH_ROUTES` 却忘了登记 → 这里失败；
//! - 两个页面共用一个 ID / 一个 ID 两个 loader → 这里失败；
//! - 预加载策略失控（到处 idle）→ 这里失败。

import { describe, expect, it } from "vitest";
import {
  FEATURE_DEFINITIONS,
  WORKBENCH_PENDING_ROUTES,
  featureIdForMainTab,
  featureIdForWorkbenchRoute,
  installFeatureRegistry,
  registeredWorkbenchRoutes,
} from "./featureRegistry";
import { getFeatureSnapshot, isFeatureLoaded, preloadFeature } from "./featureRuntime";
import { WORKBENCH_ROUTES } from "./workbenchLayout";
import { NAV_ENTRIES } from "./navigationRegistry";

const definitionsById = new Map<string, (typeof FEATURE_DEFINITIONS)[number]>(
  FEATURE_DEFINITIONS.map((definition) => [definition.id, definition]),
);

describe("featureRegistry 契约", () => {
  it("工作台每个路由（home 除外）都登记了功能", () => {
    const missing = WORKBENCH_ROUTES.filter(
      (route) => route !== "home" && !featureIdForWorkbenchRoute(route),
    );
    expect(missing).toEqual([]);
    // 待接入清单必须是空的：有内容就说明有页面绕开了按需加载。
    expect(Object.keys(WORKBENCH_PENDING_ROUTES)).toEqual([]);
  });

  it("路由映射指向已登记的功能，且没有悬空 ID", () => {
    for (const route of registeredWorkbenchRoutes()) {
      const id = featureIdForWorkbenchRoute(route);
      expect(id, `路由 ${route} 没有功能 ID`).toBeTruthy();
      expect(definitionsById.has(id as string), `路由 ${route} 指向未登记的功能 ${id}`).toBe(true);
    }
  });

  it("每个功能 ID 唯一、带命名空间、有代码入口", () => {
    const ids = FEATURE_DEFINITIONS.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const definition of FEATURE_DEFINITIONS) {
      expect(definition.id).toMatch(/^page:[a-z0-9-]+$/);
      expect(typeof definition.load, `${definition.id} 缺少代码入口`).toBe("function");
      expect(definition.label.length).toBeGreaterThan(0);
    }
  });

  it("空闲预加载最多一个模块（防止启动期预加载失控）", () => {
    const idle = FEATURE_DEFINITIONS.filter((definition) => definition.preload === "idle");
    expect(idle.map((definition) => definition.id)).toEqual(["page:tasks"]);
  });

  it("page:tasks 只允许空闲预加载：悬停导航项不会加载任务页", () => {
    installFeatureRegistry();
    const snapshot = getFeatureSnapshot("page:tasks");
    expect(snapshot?.preload).toBe("idle");
    // hover 与策略不匹配 → 拒绝，且不产生任何 import
    expect(preloadFeature("page:tasks", "hover")).toBe("skipped");
    expect(isFeatureLoaded("page:tasks")).toBe(false);
  });

  it("release 策略只用于只读工具页（有草稿/编辑态的页面必须 keep）", () => {
    const release = FEATURE_DEFINITIONS.filter(
      (definition) => definition.instance === "release",
    ).map((definition) => definition.id);
    // 白名单：新增 release 必须同时确认「离开后可丢失筛选/滚动位置」。
    expect(release.sort()).toEqual(
      ["page:capability", "page:diagnostics", "page:help", "page:history", "page:resource"].sort(),
    );
  });

  it("主窗口按需加载的入口都指向已登记功能", () => {
    const tabs = ["agents", "actions", "clipboard", "inbox", "shelf", "settings"] as const;
    for (const tab of tabs) {
      const id = featureIdForMainTab(tab);
      expect(id, `主窗口 ${tab} 没有登记功能`).toBeTruthy();
      expect(definitionsById.has(id as string)).toBe(true);
    }
  });

  it("导航入口覆盖的 Tab 至少能解析到一个工作台功能（除已知的合并/状态入口）", () => {
    // 反向检查：导航注册中心里出现的新 Tab 若没有任何功能承接，说明页面会白屏。
    const unresolved = NAV_ENTRIES.flatMap((entry) => entry.tabs)
      .filter((tab) => tab !== "inbox" && tab !== "shelf")
      .filter((tab) => !definitionsById.has(`page:${tab}`));
    expect([...new Set(unresolved)]).toEqual([]);
  });
});
