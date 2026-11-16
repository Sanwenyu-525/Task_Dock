// 入口配置归一化（P0）：这是「用户配置不被覆盖 + 损坏可恢复 + 升级可迁移」的核心。
//
// 每个 it 对应一条产品承诺，失败即代表某条验收项不成立：
// 空数组合法、暂不可用不可加入、新功能自动补位、用户隐藏不被升级翻出来、损坏回默认。
import { describe, expect, it } from "vitest";

import {
  ENTRY_LAYOUT_VERSION,
  defaultEntryLayout,
  insertEntryByDefaultOrder,
  isEntryVisible,
  mergeEntryOrder,
  moveEntryByDelta,
  moveEntryByIndex,
  moveEntryToIndex,
  normalizeEntryLayout,
  setEntriesVisible,
  setEntryVisible,
  type EntryLayoutConfig,
} from "../entryLayout";
import { availableEntryIds, defaultVisibleEntryIds, type EntryId } from "../entryRegistry";

const DEFAULT_VISIBLE = defaultVisibleEntryIds();

/** 测试用的 id 列表（含故意不存在的 id，类型上仍按契约传入） */
const ids = (...values: string[]) => values as unknown as EntryId[];

function snapshot(raw: unknown) {
  return normalizeEntryLayout(raw);
}

describe("首次安装与损坏兜底", () => {
  it("默认布局就是 5 个默认可见入口", () => {
    const layout = defaultEntryLayout();
    expect(layout.version).toBe(ENTRY_LAYOUT_VERSION);
    expect(layout.visible).toEqual(DEFAULT_VISIBLE);
    expect(layout.known).toEqual(availableEntryIds());
  });

  it.each([undefined, null, 42, "oops", [], { visible: "nope" }, { visible: 3 }])(
    "非对象或结构错误 → 安全回默认（source=default）：%s",
    (raw) => {
      const result = snapshot(raw);
      expect(result.source).toBe("default");
      expect(result.config.visible).toEqual(DEFAULT_VISIBLE);
      expect(result.config.version).toBe(ENTRY_LAYOUT_VERSION);
    },
  );

  it("空数组合法：用户可以把工作台清空", () => {
    const result = snapshot({ version: ENTRY_LAYOUT_VERSION, visible: [], known: availableEntryIds() });
    expect(result.source).toBe("settings");
    expect(result.config.visible).toEqual([]);
    expect(result.migrated).toBe(false);
    expect(result.dropped).toBe(0);
  });
});

describe("逐项校验", () => {
  it("未知 id、暂不可用 id、重复项与非字符串项都被丢弃并计数", () => {
    const result = snapshot({
      version: ENTRY_LAYOUT_VERSION,
      visible: ["capture", "ghost", "dev-workbench", "capture", 7],
      known: availableEntryIds(),
    });
    expect(result.config.visible).toEqual(["capture"]);
    // ghost(1) + dev-workbench(1) + 重复 capture(1) + 数字 7(1)
    expect(result.dropped).toBe(4);
    expect(result.source).toBe("settings");
  });

  it("暂不可用入口永远进不了工作台", () => {
    const result = snapshot({
      version: ENTRY_LAYOUT_VERSION,
      visible: ["dev-workbench", "cast"],
      known: availableEntryIds(),
    });
    expect(result.config.visible).toEqual([]);
    expect(result.dropped).toBe(2);
  });

  it("known 会收敛为当前全部可用入口", () => {
    const result = snapshot({ version: ENTRY_LAYOUT_VERSION, visible: ["files"], known: ["files"] });
    expect(result.config.known).toEqual(availableEntryIds());
  });
});

describe("升级：新增功能不覆盖用户配置", () => {
  // 真实升级场景：老版本写下的 known = 当时全部可用入口。新版本多了一个入口，
  // 只有它不在 known 里，所以只有它会被自动补进工作台。
  const knownWithout = (id: string) => availableEntryIds().filter((entryId) => entryId !== id);

  it("新版本新增的默认可见入口会被补进工作台", () => {
    const result = snapshot({
      version: ENTRY_LAYOUT_VERSION,
      visible: ["capture"],
      known: knownWithout("create-task"),
    });
    expect(result.config.visible).toEqual(["capture", "create-task"]);
  });

  it("补位后不改变用户既有顺序", () => {
    const result = snapshot({
      version: ENTRY_LAYOUT_VERSION,
      visible: ["tools", "stash"],
      known: knownWithout("capture"),
    });
    // capture 默认 order 最小，插到最前；用户排的 tools → stash 保持不变
    expect(result.config.visible).toEqual(["capture", "tools", "stash"]);
  });

  it("默认隐藏的新功能不会自动冒出来", () => {
    const result = snapshot({
      version: ENTRY_LAYOUT_VERSION,
      visible: ["capture"],
      known: knownWithout("create-task"),
    });
    expect(result.config.visible).not.toContain("files");
    expect(result.config.visible).not.toContain("sync");
  });

  it("用户主动隐藏过的入口不会被升级重新显示", () => {
    // 用户隐藏了 tools（它默认可见），known 里有它 → 不补回
    const result = snapshot({
      version: ENTRY_LAYOUT_VERSION,
      visible: ["capture", "create-task", "workspace", "stash"],
      known: availableEntryIds(),
    });
    expect(result.config.visible).toEqual(["capture", "create-task", "workspace", "stash"]);
    expect(result.config.visible).not.toContain("tools");
  });

  it("缺 known 快照（更早格式）时保守处理：不把现存入口当新增", () => {
    const result = snapshot({ version: ENTRY_LAYOUT_VERSION, visible: ["capture"] });
    expect(result.config.visible).toEqual(["capture"]);
    expect(result.migrated).toBe(false);
  });
});

describe("版本迁移", () => {
  it.each([0, 2, 99])("版本 %s 视为迁移，结构重建但保留用户选择", (version) => {
    const result = snapshot({ version, visible: ["files", "sync"], known: availableEntryIds() });
    expect(result.migrated).toBe(true);
    expect(result.config.version).toBe(ENTRY_LAYOUT_VERSION);
    expect(result.config.visible).toEqual(["files", "sync"]);
  });

  it("缺 version 字段按 0 处理 → 迁移", () => {
    const result = snapshot({ visible: [], known: [] });
    expect(result.migrated).toBe(true);
  });

  it("当前版本不标记迁移", () => {
    const result = snapshot({ version: ENTRY_LAYOUT_VERSION, visible: ["files"], known: ["files"] });
    expect(result.migrated).toBe(false);
  });
});

describe("边界输入与 dropped 统计", () => {
  it("非字符串项逐项过滤：null / 数字 / 布尔 / 对象 / 嵌套数组都计入 dropped", () => {
    const result = snapshot({
      version: ENTRY_LAYOUT_VERSION,
      visible: ["capture", null, 7, false, { id: "capture" }, ["stash"]],
      known: availableEntryIds(),
    });
    expect(result.config.visible).toEqual(["capture"]);
    expect(result.dropped).toBe(5);
  });

  it("重复出现的有效 id 只保留第一次，其余全部计数", () => {
    const result = snapshot({
      version: ENTRY_LAYOUT_VERSION,
      visible: ["capture", "capture", "capture"],
      known: availableEntryIds(),
    });
    expect(result.config.visible).toEqual(["capture"]);
    expect(result.dropped).toBe(2);
  });

  it("未知 id 与暂不可用 id 混合时分别计数，可用项保持原顺序", () => {
    const result = snapshot({
      version: ENTRY_LAYOUT_VERSION,
      visible: ["tools", "cast", "capture", "ghost", "dev-workbench"],
      known: availableEntryIds(),
    });
    expect(result.config.visible).toEqual(["tools", "capture"]);
    expect(result.dropped).toBe(3);
  });

  it.each([null, "capture", 42, { 0: "capture" }])(
    "visible 不是数组 → 安全回默认且不虚报 dropped：%s",
    (visible) => {
      const result = snapshot({ version: ENTRY_LAYOUT_VERSION, visible, known: availableEntryIds() });
      expect(result.source).toBe("default");
      expect(result.config.visible).toEqual(DEFAULT_VISIBLE);
      expect(result.dropped).toBe(0);
    },
  );

  it("空数组 + 缺 known：保持空工作台，不补回默认项", () => {
    const result = snapshot({ version: ENTRY_LAYOUT_VERSION, visible: [] });
    expect(result.source).toBe("settings");
    expect(result.config.visible).toEqual([]);
  });

  it("空数组 + 空 known 快照：按「新增功能」规则补回默认可见项", () => {
    // known 为空意味着「写入时还不知道任何入口」，现有默认可见项都算新功能；
    // 这是数据异常下的保守选择，正常写入不会产生这种组合。
    const result = snapshot({ version: ENTRY_LAYOUT_VERSION, visible: [], known: [] });
    expect(result.config.visible).toEqual(DEFAULT_VISIBLE);
  });

  it("known 不完整：只补默认可见的缺失项，默认隐藏项不冒出来", () => {
    const known = availableEntryIds().filter(
      (id) => id !== "create-task" && id !== "files",
    );
    const result = snapshot({ version: ENTRY_LAYOUT_VERSION, visible: ["capture"], known });
    expect(result.config.visible).toContain("create-task");
    expect(result.config.visible).not.toContain("files");
  });

  it("known 里的未知/暂不可用项被忽略，最终收敛为全部可用入口", () => {
    const result = snapshot({
      version: ENTRY_LAYOUT_VERSION,
      visible: ["capture"],
      known: ["capture", "ghost", "cast"],
    });
    expect(result.config.known).toEqual(availableEntryIds());
    expect(result.config.known).not.toContain("ghost");
    expect(result.config.known).not.toContain("cast");
  });

  it("旧版本结构（无 version + 无 known + 含失效项）迁移后保留可用项", () => {
    const result = snapshot({ visible: ["tools", "ghost", "stash"] });
    expect(result.migrated).toBe(true);
    expect(result.config.visible).toEqual(["tools", "stash"]);
    expect(result.dropped).toBe(1);
    expect(result.config.version).toBe(ENTRY_LAYOUT_VERSION);
  });

  it("合法配置的 dropped 恒为 0", () => {
    const result = snapshot({
      version: ENTRY_LAYOUT_VERSION,
      visible: ["files", "capture"],
      known: availableEntryIds(),
    });
    expect(result.dropped).toBe(0);
    expect(result.migrated).toBe(false);
  });
});

describe("增删与排序", () => {
  it("按默认顺序插入（已存在则不变）", () => {
    // files 默认 order 130 > tools 50，所以追加在末尾
    expect(insertEntryByDefaultOrder(["capture", "tools"], "files")).toEqual([
      "capture",
      "tools",
      "files",
    ]);
    expect(insertEntryByDefaultOrder(["capture", "files"], "files")).toEqual(["capture", "files"]);
  });

  it("setEntryVisible：移除 / 按默认位置加回 / 暂不可用无效", () => {
    expect(setEntryVisible(["capture", "tools"], "capture", false)).toEqual(["tools"]);
    expect(setEntryVisible(["capture", "tools"], "files", true)).toEqual([
      "capture",
      "tools",
      "files",
    ]);
    const unavailable = ids("capture");
    expect(setEntryVisible(unavailable, "cast" as EntryId, true)).toEqual(["capture"]);
  });

  it("setEntriesVisible：批量隐藏与批量添加都只动目标", () => {
    expect(setEntriesVisible(["capture", "files", "sync"], ["files", "sync"], false)).toEqual([
      "capture",
    ]);
    expect(
      setEntriesVisible(["capture"], ["files", "sync", "cast"], true),
    ).toEqual(["capture", "files", "sync"]);
  });

  it("拖动下标越界自动收敛", () => {
    expect(moveEntryByIndex(ids("a", "b", "c"), 0, 99)).toEqual(["b", "c", "a"]);
    expect(moveEntryByIndex(ids("a", "b", "c"), -5, 1)).toEqual(["b", "a", "c"]);
    expect(moveEntryByIndex([], 0, 1)).toEqual([]);
  });

  it("按 id 与按增量移动", () => {
    expect(moveEntryToIndex(ids("a", "b", "c"), "c" as EntryId, 0)).toEqual(["c", "a", "b"]);
    expect(moveEntryByDelta(ids("a", "b", "c"), "a" as EntryId, 1)).toEqual(["b", "a", "c"]);
    expect(moveEntryByDelta(ids("a", "b", "c"), "c" as EntryId, 1)).toEqual(["a", "b", "c"]);
    expect(moveEntryByDelta(ids("a", "b", "c"), "ghost" as EntryId, 1)).toEqual(["a", "b", "c"]);
  });

  it("isEntryVisible", () => {
    expect(isEntryVisible(ids("capture"), "capture" as EntryId)).toBe(true);
    expect(isEntryVisible(ids("capture"), "files" as EntryId)).toBe(false);
  });

  it("mergeEntryOrder 只接受相对顺序：缺项与重复都不丢入口", () => {
    expect(mergeEntryOrder(ids("a", "b", "c", "d"), ids("c", "c", "a"))).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
    expect(mergeEntryOrder(ids("a", "b"), ids("ghost"))).toEqual(["a", "b"]);
  });
});

describe("自洽性", () => {
  it("归一化结果再归一化是幂等的", () => {
    const first = snapshot({ version: 0, visible: ["tools", "ghost"], known: ["tools"] });
    const second = snapshot(first.config);
    expect(second.config).toEqual(first.config);
    expect(second.dropped).toBe(0);
    expect(second.migrated).toBe(false);
  });

  it("输出结构与 EntryLayoutConfig 对齐", () => {
    const layout: EntryLayoutConfig = snapshot({ visible: [] }).config;
    expect(Array.isArray(layout.visible)).toBe(true);
    expect(Array.isArray(layout.known)).toBe(true);
  });
});
