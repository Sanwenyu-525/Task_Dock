//! 统一工作台布局协议：默认值、逐字段降级、未知版本迁移与宽度钳制。
//!
//! 这些用例锁定「旧数据能读、坏配置不白屏、用户偏好不被静默扩大」三条底线。

import { describe, expect, it } from "vitest";
import {
  WORKBENCH_DETAIL_WIDTH_MAX,
  WORKBENCH_DETAIL_WIDTH_MIN,
  WORKBENCH_LAYOUT_VERSION,
  WORKBENCH_NAV_WIDTH_MAX,
  WORKBENCH_NAV_WIDTH_MIN,
  defaultWorkbenchLayout,
  hasStoredWorkbenchLayout,
  isWorkbenchRoute,
  normalizeProjectId,
  normalizeWorkbenchLayout,
  selectWorkbenchLayout,
} from "./workbenchLayout";

describe("workbenchLayout", () => {
  it("缺失/损坏输入回退默认值且不抛错", () => {
    for (const raw of [undefined, null, "x", 42, [], { version: "1" }]) {
      const result = normalizeWorkbenchLayout(raw);
      expect(result.config).toEqual(defaultWorkbenchLayout());
      expect(result.source).toBe("default");
    }
  });

  it("有效配置逐字段保留，未知字段被忽略", () => {
    const result = normalizeWorkbenchLayout({
      version: WORKBENCH_LAYOUT_VERSION,
      route: "tasks",
      projectId: " p1 ",
      detailOpen: false,
      navWidth: 260,
      detailWidth: 360,
      futureField: { anything: true },
    });
    expect(result.source).toBe("settings");
    expect(result.migrated).toBe(false);
    expect(result.config).toEqual({
      version: WORKBENCH_LAYOUT_VERSION,
      route: "tasks",
      projectId: "p1",
      detailOpen: false,
      navWidth: 260,
      detailWidth: 360,
    });
  });

  it("未知版本按字段迁移，不整体丢弃用户配置", () => {
    const result = normalizeWorkbenchLayout({
      version: 99,
      route: "agents",
      projectId: null,
      detailOpen: true,
      navWidth: 240,
      detailWidth: 300,
    });
    expect(result.migrated).toBe(true);
    expect(result.source).toBe("settings");
    expect(result.config.route).toBe("agents");
    expect(result.config.navWidth).toBe(240);
    expect(result.config.version).toBe(WORKBENCH_LAYOUT_VERSION);
  });

  it("非法路由/项目/宽度各自回退，合法字段不受影响", () => {
    const result = normalizeWorkbenchLayout({
      version: 1,
      route: "tasks/../../etc",
      projectId: "bad\u0007id",
      detailOpen: "yes",
      navWidth: 9999,
      detailWidth: -5,
    });
    expect(result.config.route).toBe("home");
    expect(result.config.projectId).toBeNull();
    expect(result.config.detailOpen).toBe(true);
    expect(result.config.navWidth).toBe(WORKBENCH_NAV_WIDTH_MAX);
    expect(result.config.detailWidth).toBe(WORKBENCH_DETAIL_WIDTH_MIN);
    expect(result.dropped).toBeGreaterThan(0);
  });

  it("宽度钳制在可用区间内", () => {
    const low = normalizeWorkbenchLayout({ version: 1, navWidth: 10, detailWidth: 20 }).config;
    expect(low.navWidth).toBe(WORKBENCH_NAV_WIDTH_MIN);
    expect(low.detailWidth).toBe(WORKBENCH_DETAIL_WIDTH_MIN);
    const high = normalizeWorkbenchLayout({ version: 1, navWidth: 999, detailWidth: 999 }).config;
    expect(high.navWidth).toBe(WORKBENCH_NAV_WIDTH_MAX);
    expect(high.detailWidth).toBe(WORKBENCH_DETAIL_WIDTH_MAX);
  });

  it("项目 ID 规范化：去空白、拒绝空/超长/控制字符", () => {
    expect(normalizeProjectId("  abc  ")).toBe("abc");
    expect(normalizeProjectId("")).toBeNull();
    expect(normalizeProjectId("   ")).toBeNull();
    expect(normalizeProjectId("x".repeat(65))).toBeNull();
    expect(normalizeProjectId("a\u0000b")).toBeNull();
    expect(normalizeProjectId(42)).toBeNull();
  });

  it("路由判据只接受已登记功能 ID", () => {
    expect(isWorkbenchRoute("home")).toBe(true);
    expect(isWorkbenchRoute("tasks")).toBe(true);
    expect(isWorkbenchRoute("settings")).toBe(true);
    expect(isWorkbenchRoute("collection")).toBe(false);
    expect(isWorkbenchRoute("unknown")).toBe(false);
    expect(isWorkbenchRoute(1)).toBe(false);
  });

  it("selectWorkbenchLayout 从设置对象读取同一键", () => {
    const settings = {
      workbench_layout: { version: 1, route: "history", navWidth: 200, detailWidth: 280 },
    };
    expect(selectWorkbenchLayout(settings).route).toBe("history");
    expect(hasStoredWorkbenchLayout(settings)).toBe(true);
    expect(hasStoredWorkbenchLayout({})).toBe(false);
  });
});
