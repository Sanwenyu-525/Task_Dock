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
  WORKBENCH_NAV_WIDTH_RAIL,
  defaultWorkbenchLayout,
  hasStoredWorkbenchLayout,
  isWorkbenchRoute,
  normalizeProjectId,
  normalizeWorkbenchLayout,
  resolveWorkbenchNavPresentation,
  resolveWorkbenchNavWidth,
  selectWorkbenchLayout,
  shouldCompactWorkbenchNavLabels,
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

  it("导航宽度只留两个稳态：图标轨或 ≥ 名称所需宽度（2026-11-17）", () => {
    expect(WORKBENCH_NAV_WIDTH_MIN).toBe(WORKBENCH_NAV_WIDTH_RAIL);
    // 名称需要 200px：199/150 都会被名称遮住，一律吸附到 72px 图标轨。
    expect(resolveWorkbenchNavWidth(199.4, 200)).toBe(WORKBENCH_NAV_WIDTH_RAIL);
    expect(resolveWorkbenchNavWidth(150, 200)).toBe(WORKBENCH_NAV_WIDTH_RAIL);
    expect(resolveWorkbenchNavWidth(WORKBENCH_NAV_WIDTH_RAIL, 200)).toBe(WORKBENCH_NAV_WIDTH_RAIL);
    // 刚好放下名称即进入宽态；上限与取整仍按协议钳制。
    expect(resolveWorkbenchNavWidth(200, 200)).toBe(200);
    expect(resolveWorkbenchNavWidth(200.4, 200)).toBe(200);
    expect(resolveWorkbenchNavWidth(999, 200)).toBe(WORKBENCH_NAV_WIDTH_MAX);
    // 量不到名称宽度（首帧 / jsdom）时只做区间钳制，不凭空吸附。
    expect(resolveWorkbenchNavWidth(150, null)).toBe(150);
    expect(resolveWorkbenchNavWidth(180)).toBe(180);
  });

  it("折叠判据按名称实测宽度取整比较，缺省回退 180px", () => {
    expect(shouldCompactWorkbenchNavLabels(200, 200)).toBe(false);
    expect(shouldCompactWorkbenchNavLabels(199.4, 200)).toBe(true);
    expect(shouldCompactWorkbenchNavLabels(96, 200)).toBe(true);
    // 未量到名称宽度（jsdom）时保持旧兜底语义：180 起显示名称。
    expect(shouldCompactWorkbenchNavLabels(180)).toBe(false);
    expect(shouldCompactWorkbenchNavLabels(179.4)).toBe(true);
  });

  it("导航单态解析：compact 时渲染宽度必为图标轨（R13）", () => {
    // 旧存档 96：首帧就直接渲染 72px，不留「图标导航 + 空白侧栏」。
    expect(resolveWorkbenchNavPresentation(96, 200, false, false)).toEqual({
      width: WORKBENCH_NAV_WIDTH_RAIL,
      compact: true,
    });
    // 宽态：渲染宽度就是用户设定宽度。
    expect(resolveWorkbenchNavPresentation(200, 200, false, false)).toEqual({
      width: 200,
      compact: false,
    });
    // 名称所需宽度边界：199 进图标轨，200 显示名称。
    expect(resolveWorkbenchNavPresentation(199, 200, false, false)).toEqual({
      width: WORKBENCH_NAV_WIDTH_RAIL,
      compact: true,
    });
    expect(resolveWorkbenchNavPresentation(199.4, 200, false, false).compact).toBe(true);
    expect(resolveWorkbenchNavPresentation(200, 200, false, false).compact).toBe(false);
    // 中英文名称只是实测宽度不同，判据一致（英文更长 → 更早折叠）。
    expect(resolveWorkbenchNavPresentation(180, 240, false, false)).toEqual({
      width: WORKBENCH_NAV_WIDTH_RAIL,
      compact: true,
    });
    expect(resolveWorkbenchNavPresentation(240, 240, false, false)).toEqual({
      width: 240,
      compact: false,
    });
    // 未量到名称宽度时回退 180px 兜底阈值。
    expect(resolveWorkbenchNavPresentation(180, null, false, false).compact).toBe(false);
    expect(resolveWorkbenchNavPresentation(179, null, false, false).compact).toBe(true);
  });

  it("导航单态解析：窄窗固定图标轨，拖拽中宽度连续跟手（R13）", () => {
    // 窄窗优先于用户宽度：固定 72。
    expect(resolveWorkbenchNavPresentation(200, 200, true, false)).toEqual({
      width: WORKBENCH_NAV_WIDTH_RAIL,
      compact: true,
    });
    expect(resolveWorkbenchNavPresentation(200, 200, true, true)).toEqual({
      width: WORKBENCH_NAV_WIDTH_RAIL,
      compact: true,
    });
    // 拖拽中不吸附：宽度就是实时宽度，折叠随实时宽度变化。
    expect(resolveWorkbenchNavPresentation(150, 200, false, true)).toEqual({
      width: 150,
      compact: true,
    });
    expect(resolveWorkbenchNavPresentation(260, 200, false, true)).toEqual({
      width: 260,
      compact: false,
    });
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
