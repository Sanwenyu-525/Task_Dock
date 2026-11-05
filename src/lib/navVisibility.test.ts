//! 导航布局配置：默认值、用户自定义保留、新入口合并、版本迁移与损坏回退。
//!
/**
 * @vitest-environment jsdom
 */
//! 以纯函数测试为主；旧版 localStorage 迁移读取单独覆盖，不触碰 SQLite / 组件。

import { describe, expect, it } from "vitest";
import {
  LEGACY_NAV_VISIBILITY_STORAGE_KEY,
  NAV_LAYOUT_VERSION,
  applyLegacyHiddenEntries,
  defaultNavigationLayout,
  insertEntryByDefaultOrder,
  isEntryVisible,
  isTabHidden,
  moveEntryInList,
  normalizeNavigationLayout,
  readLegacyHiddenEntryIds,
  safeTabForHiddenEntry,
} from "./navVisibility";
import { allEntryIds, defaultVisibleIds } from "./navigationRegistry";

const ALL_LEFT = allEntryIds("left");

function visibleExcept(surface: "left" | "capsule", hidden: string[]) {
  const base = defaultNavigationLayout();
  return base[surface].filter((id) => !hidden.includes(id));
}

describe("导航布局配置", () => {
  it("默认配置覆盖注册中心默认可见入口，两个界面独立", () => {
    const layout = defaultNavigationLayout();
    expect(layout.version).toBe(NAV_LAYOUT_VERSION);
    expect(layout.left).toEqual(defaultVisibleIds("left"));
    expect(layout.capsule).toEqual(defaultVisibleIds("capsule"));
    expect(layout.known.left).toEqual(ALL_LEFT);
    // 设置默认可见且锁定（locked）：不可隐藏、不可排序，固定底部
    expect(layout.left).toContain("settings");
    expect(layout.capsule).toContain("agents");
  });

  it("有效配置原样保留用户显隐与排序", () => {
    const left = ["clipboard", ...visibleExcept("left", ["clipboard", "apps"])];
    const capsule = visibleExcept("capsule", ["apps"]);
    const raw = {
      version: NAV_LAYOUT_VERSION,
      left,
      capsule,
      known: { left: ALL_LEFT, capsule: allEntryIds("capsule") },
    };
    const result = normalizeNavigationLayout(raw);
    expect(result.source).toBe("settings");
    expect(result.migrated).toBe(false);
    expect(result.dropped).toBe(0);
    expect(result.config.left).toEqual(left);
    expect(result.config.capsule).toEqual(capsule);
  });

  it("老配置缺少的新入口按默认值补齐；用户已隐藏的入口不会被恢复", () => {
    const left = visibleExcept("left", ["apps", "history", "settings"]);
    const knownOld = ALL_LEFT.filter((id) => id !== "settings"); // 模拟「设置」是后来新增的入口
    const result = normalizeNavigationLayout({
      version: NAV_LAYOUT_VERSION,
      left,
      capsule: allEntryIds("capsule"),
      known: { left: knownOld, capsule: allEntryIds("capsule") },
    });
    // 新入口「设置」按默认可见补齐
    expect(result.config.left).toContain("settings");
    // 用户隐藏的仍在数组外
    expect(result.config.left).not.toContain("apps");
    expect(result.config.left).not.toContain("history");
    // 补齐后 known 更新为当前全部入口
    expect(result.config.known.left).toEqual(ALL_LEFT);
  });

  it("版本不符时按 ID 对齐迁移：保留可识别项、丢弃未知 ID 并计数、补齐新入口", () => {
    const result = normalizeNavigationLayout({
      version: 0, // 旧版本
      left: ["legacy-unknown", "tasks", "apps", "tasks"],
      capsule: ["unknown-capsule", "tasks"],
      known: { left: ["tasks", "apps"], capsule: ["tasks"] },
    });
    expect(result.migrated).toBe(true);
    expect(result.dropped).toBe(3); // 2 个未知 + 1 个重复
    // 保留可识别的显式项与相对顺序
    expect(result.config.left.indexOf("tasks")).toBeLessThan(result.config.left.indexOf("apps"));
    // 迁移后按默认顺序补齐其余入口（apps 已存在，不会重复）
    expect(result.config.left).toEqual(
      expect.arrayContaining(["tasks", "apps", "agents", "settings"]),
    );
    expect(result.config.left.filter((id) => id === "apps")).toHaveLength(1);
    // 迁移结果统一写入当前版本与 known 快照
    expect(result.config.version).toBe(NAV_LAYOUT_VERSION);
    expect(result.config.known.left).toEqual(ALL_LEFT);
  });

  it("缺失 / 非对象 / 数组损坏 → 回退默认（全部默认可见）", () => {
    for (const raw of [null, undefined, "{broken", 42, {}, { version: 1 }, { version: 1, left: "x", capsule: [] }]) {
      const result = normalizeNavigationLayout(raw);
      expect(result.source).toBe("default");
      expect(result.config.left).toEqual(defaultVisibleIds("left"));
      expect(result.config.capsule).toEqual(defaultVisibleIds("capsule"));
    }
  });

  it("空数组是合法状态：除锁定入口外不会被默认值重新填满", () => {
    const result = normalizeNavigationLayout({
      version: NAV_LAYOUT_VERSION,
      left: [],
      capsule: [],
      known: { left: ALL_LEFT, capsule: allEntryIds("capsule") },
    });
    // 「设置」锁定入口必须始终可达，即使旧配置把它删光也要补回
    expect(result.config.left).toEqual(["settings"]);
    expect(result.config.capsule).toEqual([]);
  });

  it("锁定入口不可被旧配置/人为删除：缺失时按默认顺序补回末尾", () => {
    const result = normalizeNavigationLayout({
      version: NAV_LAYOUT_VERSION,
      left: ["tasks", "clipboard"],
      capsule: allEntryIds("capsule"),
      known: { left: ALL_LEFT, capsule: allEntryIds("capsule") },
    });
    expect(result.config.left).toContain("settings");
    expect(result.config.left[result.config.left.length - 1]).toBe("settings");
  });

  it("旧版 localStorage 显隐安全迁移：只影响完整面板，保留锁定入口", () => {
    const layout = defaultNavigationLayout();
    const migrated = applyLegacyHiddenEntries(layout, ["apps", "history", "settings"]);
    expect(migrated.left).not.toContain("apps");
    expect(migrated.left).not.toContain("history");
    // 旧数据试图隐藏设置也无效：锁定入口仍在
    expect(migrated.left).toContain("settings");
    // 胶囊是独立配置，不继承左侧旧隐藏项
    expect(migrated.capsule).toEqual(layout.capsule);
  });

  it("旧版键损坏 / 未知 ID / 非数组时读取为空，不抛错", () => {
    localStorage.setItem(LEGACY_NAV_VISIBILITY_STORAGE_KEY, "{broken");
    expect(readLegacyHiddenEntryIds()).toEqual([]);
    localStorage.setItem(LEGACY_NAV_VISIBILITY_STORAGE_KEY, JSON.stringify({ hidden: "apps" }));
    expect(readLegacyHiddenEntryIds()).toEqual([]);
    localStorage.setItem(
      LEGACY_NAV_VISIBILITY_STORAGE_KEY,
      JSON.stringify({ version: 1, hidden: ["apps", "not-real", "apps", 42] }),
    );
    expect(readLegacyHiddenEntryIds()).toEqual(["apps"]);
    localStorage.removeItem(LEGACY_NAV_VISIBILITY_STORAGE_KEY);
  });

  it("显示入口时按默认顺序插回，不重排用户已有顺序；上移/下移可键盘操作", () => {
    const ids = ["clipboard", "tasks", "agents"];
    expect(insertEntryByDefaultOrder(ids, "settings", "left")).toEqual([
      "clipboard",
      "tasks",
      "agents",
      "settings",
    ]);
    expect(insertEntryByDefaultOrder(ids, "collection", "left")).toEqual([
      "clipboard",
      "tasks",
      "agents",
      "collection",
    ]);
    // apps 默认顺序在 clipboard 之前，插回不会改变既有项目的相对顺序
    expect(insertEntryByDefaultOrder(ids, "apps", "left")).toEqual([
      "apps",
      "clipboard",
      "tasks",
      "agents",
    ]);
    expect(moveEntryInList(ids, "tasks", -1)).toEqual(["tasks", "clipboard", "agents"]);
    expect(moveEntryInList(ids, "clipboard", -1)).toEqual(["clipboard", "tasks", "agents"]);
    expect(moveEntryInList(ids, "agents", 1)).toEqual(["clipboard", "tasks", "agents"]);
  });

  it("隐藏当前页时安全页：优先任务，其次第一个可见入口，全部隐藏回退设置页", () => {
    const base = defaultNavigationLayout();
    expect(safeTabForHiddenEntry(base)).toBe("tasks");
    expect(safeTabForHiddenEntry({ ...base, left: ["clipboard", "agents"] })).toBe("clipboard");
    expect(safeTabForHiddenEntry({ ...base, left: [] })).toBe("settings");
    expect(isEntryVisible(base, "left", "settings")).toBe(true);
    expect(isTabHidden({ ...base, left: [] }, "settings")).toBe(true);
  });
});

// ── 排序不变量（2026-11-05）────────────────────────────────────────
// 锁定入口（设置）固定末尾：不能通过归一化被挤出，也不能被普通入口
// 的上下移动间接推走；排序不改变显隐。
describe("排序不变量：锁定入口固定末尾", () => {
  it("归一化把位于中间的锁定入口收敛到可见数组末尾", () => {
    // known 必须是完整快照：缺失的入口会被当成「新增入口」按默认值补回，
    // 与本用例验证的「锁定入口收敛」无关。
    const raw = {
      version: NAV_LAYOUT_VERSION,
      left: ["settings", "tasks", "agents"],
      capsule: [],
      known: { left: ALL_LEFT, capsule: allEntryIds("capsule") },
    };
    const { config } = normalizeNavigationLayout(raw);
    expect(config.left).toEqual(["tasks", "agents", "settings"]);
  });

  it("普通入口不能与锁定入口交换位置（下移越过设置无效）", () => {
    const ids = ["tasks", "agents", "settings"];
    expect(moveEntryInList(ids, "agents", 1, (id) => id === "settings")).toEqual([
      "tasks",
      "agents",
      "settings",
    ]);
    // 上移方向同样受保护：设置不会被挤到普通入口之后
    expect(moveEntryInList(["tasks", "settings", "agents"], "agents", -1, (id) => id === "settings")).toEqual([
      "tasks",
      "settings",
      "agents",
    ]);
  });

  it("锁定入口自身不可移动", () => {
    const ids = ["tasks", "agents", "settings"];
    expect(moveEntryInList(ids, "settings", -1, (id) => id === "settings")).toEqual(ids);
    expect(moveEntryInList(ids, "settings", 1, (id) => id === "settings")).toEqual(ids);
  });

  it("排序只改变顺序，不改变成员集合（隐藏状态不受影响）", () => {
    const ids = ["tasks", "agents", "apps", "settings"];
    const moved = moveEntryInList(ids, "apps", -1, (id) => id === "settings");
    expect(moved).toEqual(["tasks", "apps", "agents", "settings"]);
    expect([...moved].sort()).toEqual([...ids].sort());
  });

  it("恢复默认后锁定入口仍在末尾", () => {
    const layout = defaultNavigationLayout();
    expect(layout.left[layout.left.length - 1]).toBe("settings");
  });
});
