// 工作台入口注册表的契约测试（P0）：注册表是配置的唯一定义源，
// 一处元数据写错就会变成「用户能看到但点开是空白页」或「图标渲染不出来」。
//
// 这里不测 UI，只把「可以被机器判定的事实」全部钉住：
// 1. id / order 唯一，且 launch 声明的路由与底部栏确实存在；
// 2. available 必有 launch、unavailable 必有 reason 且没有落点；
// 3. 每个图标都在 iconMap.json 里（否则真机上只是空白方块）；
// 4. 首次安装的默认布局稳定，避免一次改动把老用户的工作台清空。
import { describe, expect, it } from "vitest";

import iconMap from "../../components/icons/iconMap.json";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  MOBILE_ENTRIES,
  availableEntries,
  availableEntryIds,
  defaultVisibleEntryIds,
  entriesForIds,
  entryById,
  entryTargetOf,
  isEntryAvailable,
  unavailableEntries,
  type EntryId,
  type MobileEntry,
} from "../entryRegistry";
import { ROUTE_KEYS, TAB_ORDER } from "../nav";


const ICONS = (iconMap as { map: Record<string, string> }).map;

describe("注册表元数据", () => {
  it("id 与默认顺序唯一", () => {
    const ids = MOBILE_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);

    const orders = MOBILE_ENTRIES.map((entry) => entry.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("可用入口一定有落点，暂不可用入口一定没有落点", () => {
    for (const entry of availableEntries()) {
      expect(entry.launch, `${entry.id} 缺少 launch`).toBeDefined();
      expect(entry.reason, `${entry.id} 是可用入口，不应带 reason`).toBeUndefined();
      expect(entryTargetOf(entry), `${entry.id} 点不开`).not.toBeNull();
    }
    for (const entry of unavailableEntries()) {
      expect(entry.launch, `${entry.id} 暂不可用但带了落点`).toBeUndefined();
      expect(entryTargetOf(entry), `${entry.id} 不应可点开`).toBeNull();
      expect((entry.reason ?? "").trim().length, `${entry.id} 缺少不可用原因`).toBeGreaterThan(0);
    }
  });

  it("launch 声明的路由与底部栏真实存在", () => {
    for (const entry of MOBILE_ENTRIES as readonly MobileEntry[]) {
      const launch = entry.launch;
      if (!launch) continue;
      if (launch.kind === "route") {
        expect(
          ROUTE_KEYS.includes(launch.route),
          `${entry.id} 指向不存在的路由 ${launch.route}`,
        ).toBe(true);
      } else if (launch.kind === "tab") {
        expect(TAB_ORDER, `${entry.id} 指向不存在的底部栏 ${launch.tab}`).toContain(launch.tab);
      }
    }
  });

  it("图标全部存在于 iconMap", () => {
    for (const entry of MOBILE_ENTRIES) {
      expect(ICONS[entry.icon], `${entry.id} 的图标 ${entry.icon} 不在 iconMap.json`).toBeDefined();
    }
  });

  it("分类都有标签与展示顺序", () => {
    for (const entry of MOBILE_ENTRIES) {
      expect(CATEGORY_LABELS[entry.category], `${entry.category} 缺少标签`).toBeTruthy();
      expect(CATEGORY_ORDER, `${entry.category} 不在分类顺序里`).toContain(entry.category);
    }
  });

  it("保留全部既有能力：关键入口一个都不能少", () => {
    // 隐藏入口不等于删除功能，所以这些 ID 属于对外契约，缺失即回归。
    const required = [
      "capture",
      "create-task",
      "workspace",
      "stash",
      "tools",
      "tasks",
      "inbox",
      "notes",
      "quick-note",
      "camera",
      "scan",
      "import-media",
      "files",
      "sync",
      "pairing",
      "device",
      "notifications",
      "diagnostics",
      "settings",
    ];
    for (const id of required) {
      expect(entryById(id), `入口 ${id} 被删除了`).toBeDefined();
      expect(isEntryAvailable(entryById(id)), `入口 ${id} 不再是可用状态`).toBe(true);
    }
  });
});

describe("默认布局", () => {
  it("首次安装显示 5 个入口且顺序固定", () => {
    expect(defaultVisibleEntryIds()).toEqual([
      "capture",
      "create-task",
      "workspace",
      "stash",
      "tools",
    ]);
  });

  it("默认可见集合必须是可用入口的子集", () => {
    for (const id of defaultVisibleEntryIds()) {
      expect(isEntryAvailable(entryById(id)), `${id} 默认显示但不可用`).toBe(true);
    }
    for (const entry of MOBILE_ENTRIES) {
      if (entry.defaultVisible) {
        expect(isEntryAvailable(entry), `${entry.id} 默认显示但不可用`).toBe(true);
      }
    }
  });

  it("生活入口首次安装默认隐藏，但仍可用且可在全部功能中找到", () => {
    const life = entryById("life");
    expect(life).toBeDefined();
    expect(life?.defaultVisible).toBe(false);
    expect(isEntryAvailable(life)).toBe(true);
    expect(defaultVisibleEntryIds()).not.toContain("life");
    expect(life?.icon).toBe("package");
  });

  it("known 快照覆盖全部可用入口", () => {
    expect(availableEntryIds().sort()).toEqual(
      availableEntries()
        .map((entry) => entry.id)
        .sort(),
    );
  });
});

describe("entriesForIds", () => {
  it("跳过未知与暂不可用的 id，保持输入顺序", () => {
    const withUnknown = ["tools", "ghost-entry", "dev-workbench", "capture"] as unknown as EntryId[];
    expect(entriesForIds(withUnknown)).toEqual([entryById("tools"), entryById("capture")]);
  });
});
