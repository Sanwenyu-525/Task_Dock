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
  moveEntryToIndex,
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
    expect(layout.left).not.toContain("help");
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

  it("已保存的帮助入口显隐与顺序保持不变", () => {
    const left = ["tasks", "help", ...visibleExcept("left", ["tasks", "help", "settings"]), "settings"];
    const visible = normalizeNavigationLayout({
      version: NAV_LAYOUT_VERSION,
      left,
      capsule: allEntryIds("capsule"),
      known: { left: ALL_LEFT, capsule: allEntryIds("capsule") },
    });
    expect(visible.config.left).toEqual(left);

    const hidden = normalizeNavigationLayout({
      version: NAV_LAYOUT_VERSION,
      left: left.filter((id) => id !== "help"),
      capsule: allEntryIds("capsule"),
      known: { left: ALL_LEFT, capsule: allEntryIds("capsule") },
    });
    expect(hidden.config.left).not.toContain("help");
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

  it("安全页落在合并入口时保留用户子页（shelf / notes），不重置回快速收集", () => {
    const base = defaultNavigationLayout();
    // 只剩合并入口（收集与暂存）+ 锁定的设置：安全页必须落在合并入口上
    const onlyCollection = { ...base, left: ["collection", "settings"] };
    expect(safeTabForHiddenEntry(onlyCollection, "shelf")).toBe("shelf");
    expect(safeTabForHiddenEntry(onlyCollection, "notes")).toBe("inbox");
    expect(safeTabForHiddenEntry(onlyCollection)).toBe("inbox");
    // 任务仍可见时优先任务，与子页无关
    expect(safeTabForHiddenEntry(base, "shelf")).toBe("tasks");
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
    // 资源管理是普通入口：known 中存在但不在可见数组里 = 用户隐藏，不补回
    expect(config.left).toEqual(["tasks", "agents", "settings"]);
  });

  it("普通入口可以跨过锁定入口排序（固定项原地不动）", () => {
    // 新语义：固定入口不是障碍——agents 与 tasks 在可排序子序列内交换，
    // settings 原地不动；归一化会再把设置收敛回末尾。
    expect(moveEntryInList(["tasks", "agents", "settings"], "agents", -1, (id) => id === "settings")).toEqual([
      "agents",
      "tasks",
      "settings",
    ]);
    // 上移方向同样可以跨过：agents 与子序列中的前一项（tasks）交换，
    // settings 原地不动；归一化收敛后等效于 agents 上移一位
    expect(moveEntryInList(["tasks", "settings", "agents"], "agents", -1, (id) => id === "settings")).toEqual([
      "agents",
      "settings",
      "tasks",
    ]);
    // 首个可排序入口再上移无效（不越出子序列边界）；末个可排序入口再下移无效
    expect(moveEntryInList(["tasks", "settings", "agents"], "tasks", -1, (id) => id === "settings")).toEqual([
      "tasks",
      "settings",
      "agents",
    ]);
    expect(moveEntryInList(["tasks", "agents", "settings"], "agents", 1, (id) => id === "settings")).toEqual([
      "tasks",
      "agents",
      "settings",
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

describe("胶囊 Agent 状态球排序边界", () => {
  // Agent 状态球是固定入口：不参与排序，也不阻挡普通分类
  const isFixed = (id: string) => id === "agents";

  it("旧配置 Agent 夹在中间：普通分类上移跨过它，Agent 原地不动", () => {
    // 任务 → Agent → 收集箱 → 剪贴板 → 应用，上移「收集箱」
    const ids = ["tasks", "agents", "inbox", "clipboard", "apps"];
    const moved = moveEntryInList(ids, "inbox", -1, isFixed);
    // 普通分类顺序变为 收集箱 → 任务 → 剪贴板 → 应用；Agent 未被移动
    expect(moved).toEqual(["inbox", "agents", "tasks", "clipboard", "apps"]);
    // 归一化后 Agent 收敛到端头，普通分类相对顺序保留（roadmap 已在 known 中且
    // 不在列表里，表示用户已隐藏它，归一化不会按默认值补回）
    const { config } = normalizeNavigationLayout({
      version: NAV_LAYOUT_VERSION,
      capsule: moved,
      left: ALL_LEFT,
      known: { left: ALL_LEFT, capsule: allEntryIds("capsule") },
    });
    expect(config.capsule).toEqual(["agents", "inbox", "tasks", "clipboard", "apps"]);
  });

  it("Agent 在数组首/尾时普通分类同样可以自由排序", () => {
    expect(moveEntryInList(["agents", "tasks", "inbox"], "inbox", -1, isFixed)).toEqual([
      "agents",
      "inbox",
      "tasks",
    ]);
    expect(moveEntryInList(["tasks", "inbox", "agents"], "tasks", 1, isFixed)).toEqual([
      "inbox",
      "tasks",
      "agents",
    ]);
  });

  it("Agent 自身不可被底层 API 移动", () => {
    const ids = ["tasks", "agents", "inbox"];
    expect(moveEntryInList(ids, "agents", -1, isFixed)).toEqual(ids);
    expect(moveEntryInList(ids, "agents", 1, isFixed)).toEqual(ids);
  });

  it("归一化把 Agent 收敛到端头：首/中/尾三种旧配置、普通分类相对顺序保留", () => {
    const known = { left: ALL_LEFT, capsule: allEntryIds("capsule") };
    const normalizeCapsule = (capsule: string[]) =>
      normalizeNavigationLayout({
        version: NAV_LAYOUT_VERSION,
        capsule,
        left: ALL_LEFT,
        known,
      }).config.capsule;
    expect(normalizeCapsule(["agents", "tasks", "inbox", "clipboard", "apps"])).toEqual([
      "agents",
      "tasks",
      "inbox",
      "clipboard",
      "apps",
    ]);
    expect(normalizeCapsule(["tasks", "agents", "inbox", "clipboard", "apps"])).toEqual([
      "agents",
      "tasks",
      "inbox",
      "clipboard",
      "apps",
    ]);
    expect(normalizeCapsule(["tasks", "inbox", "clipboard", "apps", "agents"])).toEqual([
      "agents",
      "tasks",
      "inbox",
      "clipboard",
      "apps",
    ]);
  });

  it("Agent 被隐藏时不重新显示；只有 Agent 可见与全部分类隐藏都是合法状态", () => {
    const known = { left: ALL_LEFT, capsule: allEntryIds("capsule") };
    const normalizeCapsule = (capsule: string[]) =>
      normalizeNavigationLayout({
        version: NAV_LAYOUT_VERSION,
        capsule,
        left: ALL_LEFT,
        known,
      }).config.capsule;
    // Agent 隐藏：保持隐藏，不意外恢复
    expect(normalizeCapsule(["tasks", "inbox", "clipboard", "apps"])).toEqual([
      "tasks",
      "inbox",
      "clipboard",
      "apps",
    ]);
    // 只有 Agent 可见
    expect(normalizeCapsule(["agents"])).toEqual(["agents"]);
    // 所有胶囊分类隐藏（空数组合法）
    expect(normalizeCapsule([])).toEqual([]);
  });

  it("未知 ID 与重复 ID 被丢弃计数，不影响 Agent 收敛与用户排序", () => {
    const result = normalizeNavigationLayout({
      version: NAV_LAYOUT_VERSION,
      capsule: ["tasks", "agents", "tasks", "unknown-id", "inbox"],
      left: ALL_LEFT,
      known: { left: ALL_LEFT, capsule: allEntryIds("capsule") },
    });
    // 重复的 tasks 与未知 ID 各丢弃 1 次；known 快照含全量入口，
    // 缺失的 clipboard/apps 视为用户隐藏，不会被重新补齐
    expect(result.dropped).toBe(2);
    expect(result.config.capsule).toEqual(["agents", "tasks", "inbox"]);
  });

  it("归一化不影响完整面板配置：left 排序原样保留（设置仍固定末尾）", () => {
    const left = ["apps", "tasks", "history", "settings"];
    const { config } = normalizeNavigationLayout({
      version: NAV_LAYOUT_VERSION,
      left,
      capsule: ["agents", "tasks"],
      known: { left: ALL_LEFT, capsule: allEntryIds("capsule") },
    });
    expect(config.left).toEqual(["apps", "tasks", "history", "settings"]);
  });
});

// ── 拖拽落位（2026-11-13）────────────────────────────────────────
// `moveEntryToIndex` 是拖拽排序的唯一顺序实现：目标下标按**最终数组**语义，
// 固定入口原地钉住，普通入口不越出可排序段。
describe("拖拽落位：moveEntryToIndex", () => {
  const ids = ["tasks", "agents", "apps", "widgets", "settings"];
  const isFixed = (id: string) => id === "settings";

  it("向下拖动：目标行与中间行前移，被拖行落到目标下标", () => {
    expect(moveEntryToIndex(ids, "tasks", 2, isFixed)).toEqual([
      "agents",
      "apps",
      "tasks",
      "widgets",
      "settings",
    ]);
  });

  it("向上拖动：中间行后移，被拖行落到目标下标", () => {
    expect(moveEntryToIndex(ids, "widgets", 1, isFixed)).toEqual([
      "tasks",
      "widgets",
      "agents",
      "apps",
      "settings",
    ]);
  });

  it("拖到首位 / 末位：目标下标越界时按边界收敛", () => {
    expect(moveEntryToIndex(ids, "widgets", 0, isFixed)[0]).toBe("widgets");
    const toEnd = moveEntryToIndex(ids, "tasks", 99, isFixed);
    // 锁定入口固定在最后：普通入口最多排到它前面
    expect(toEnd).toEqual(["agents", "apps", "widgets", "tasks", "settings"]);
    expect(moveEntryToIndex(ids, "tasks", -5, isFixed)[0]).toBe("tasks");
  });

  it("固定入口自身不可移动，也不会被普通入口推走", () => {
    expect(moveEntryToIndex(ids, "settings", 0, isFixed)).toEqual(ids);
    const moved = moveEntryToIndex(ids, "apps", 99, isFixed);
    expect(moved[moved.length - 1]).toBe("settings");
  });

  it("成员集合不变：只改顺序，不影响显隐", () => {
    const moved = moveEntryToIndex(ids, "agents", 3, isFixed);
    expect([...moved].sort()).toEqual([...ids].sort());
    expect(moved).toHaveLength(ids.length);
  });

  it("未知 ID / 单元素列表原样返回副本", () => {
    expect(moveEntryToIndex(ids, "nope", 1, isFixed)).toEqual(ids);
    expect(moveEntryToIndex(ids, "nope", 1, isFixed)).not.toBe(ids);
    expect(moveEntryToIndex(["tasks"], "tasks", 0)).toEqual(["tasks"]);
  });

  it("胶囊端头 Agent 固定：普通分类可以排到它后面，但不会挤走它", () => {
    const capsule = ["agents", "tasks", "inbox", "clipboard"];
    const fixedAgent = (id: string) => id === "agents";
    const moved = moveEntryToIndex(capsule, "clipboard", 0, fixedAgent);
    expect(moved).toEqual(["agents", "clipboard", "tasks", "inbox"]);
    expect(moved[0]).toBe("agents");
  });

  it("归一化对 moveEntryToIndex 的输出保持幂等（UI 顺序 = 持久化顺序）", () => {
    const moved = moveEntryToIndex(ids, "apps", 0, isFixed);
    const { config } = normalizeNavigationLayout({
      version: NAV_LAYOUT_VERSION,
      left: moved,
      capsule: allEntryIds("capsule"),
      known: { left: ALL_LEFT, capsule: allEntryIds("capsule") },
    });
    expect(config.left).toEqual(moved);
  });
});
