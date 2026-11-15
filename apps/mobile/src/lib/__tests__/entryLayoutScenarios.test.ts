// 验收场景的业务层复现（2026-11-15）：把「隐藏 → 重启 → 还在」「重新添加 → 能跳转」
// 这类真机要逐条点一遍的场景，先在本层钉死。真机验收仍是最终判据（手势、视觉、系统行为
// 不在这一层），但数据链路的问题不应该等到真机才发现。
//
// 本文件与 tmp/acceptance/mobile-entry-customization/report.md 的场景编号一一对应。
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, openDatabase } from "../../db/database";
import { clearEntryLayout, loadEntryLayout } from "../../db/entryLayout";
import { getSetting, setSetting } from "../../db/kv";
import {
  ENTRY_LAYOUT_SETTING_KEY,
  mergeEntryOrder,
  normalizeEntryLayout,
} from "../entryLayout";
import {
  availableEntryIds,
  defaultVisibleEntryIds,
  entriesForIds,
  entryById,
  entryTargetOf,
  type EntryId,
} from "../entryRegistry";
import {
  __resetEntryLayoutStore,
  commitEntriesVisibility,
  commitEntryMove,
  commitEntryOrder,
  commitEntryVisibility,
  ensureEntryLayoutLoaded,
  getEntryLayoutState,
  resetEntryLayout,
} from "../entryLayoutStore";

const ID = (value: string) => value as EntryId;
const DESKTOP_SETTING_KEY = "navigation_layout";
const DESKTOP_STORAGE_NOTE = "桌面端用 src-tauri 的 settings 表；移动端 SQLite 里不存在这个键";

/** 模拟「App 重启」：内存状态清空 + 重新从库加载（库内容不变） */
async function restart(): Promise<void> {
  __resetEntryLayoutStore();
  await ensureEntryLayoutLoaded();
}

beforeEach(async () => {
  __resetEntryLayoutStore();
  await closeDatabase();
  await openDatabase();
  await clearEntryLayout();
});

afterEach(async () => {
  __resetEntryLayoutStore();
  await closeDatabase();
});

describe("场景一：自定义入口 + 重启保留", () => {
  it("隐藏文件互传与暂不可用的开发工作台，只留任务与拍照，重启后依然是这套", async () => {
    await ensureEntryLayoutLoaded();
    // 用户想要的终态：只留「任务」和「拍照」
    await commitEntryVisibility(ID("tasks"), true);
    await commitEntryVisibility(ID("camera"), true);
    // 开发工作台是暂不可用：它本来就不在工作台，也不允许被加进来
    await commitEntryVisibility(ID("dev-workbench"), true);

    let visible = getEntryLayoutState().config.visible;
    expect(visible).not.toContain("dev-workbench");

    // 把其余可用入口全部隐藏（相当于隐藏了文件互传、采集、工作区等）
    await commitEntriesVisibility(
      availableEntryIds().filter((id) => id !== "tasks" && id !== "camera"),
      false,
    );
    visible = getEntryLayoutState().config.visible;
    expect(visible).toEqual(["tasks", "camera"]);

    await restart();
    expect(getEntryLayoutState().config.visible).toEqual(["tasks", "camera"]);
    expect(getEntryLayoutState().source).toBe("settings");
  });
});

describe("场景二：重新添加并保持可跳转", () => {
  it("从全部功能加回文件互传，入口存在且落点是真实路由", async () => {
    await ensureEntryLayoutLoaded();
    await commitEntryVisibility(ID("files"), false);
    await commitEntryVisibility(ID("files"), true);

    expect(getEntryLayoutState().config.visible).toContain("files");
    const resolved = entriesForIds(getEntryLayoutState().config.visible).find(
      (entry) => entry.id === "files",
    );
    expect(resolved).toBeDefined();
    expect(entryTargetOf(resolved!)).toEqual({ kind: "route", route: "files" });

    await restart();
    expect(getEntryLayoutState().config.visible).toContain("files");
  });

  it("暂不可用入口点开没有落点（不会跳进不存在的页面）", async () => {
    // dev-workbench 是暂不可用入口：注册表里没有 launch，点开只提示原因
    expect(entryTargetOf(entryById("dev-workbench")!)).toBeNull();
    expect(entryById("dev-workbench")!.availability).toBe("unavailable");
  });
});

describe("场景三：连续拖拽排序 + 重启保持", () => {
  it("多次移动后顺序稳定，重启后一致", async () => {
    await ensureEntryLayoutLoaded();
    // 连续三步：capture 下移、tools 上移、workspace 移到最前
    await commitEntryMove(ID("capture"), 1);
    await commitEntryMove(ID("tools"), -1);
    await commitEntryMove(ID("workspace"), -2);

    const expected = getEntryLayoutState().config.visible;
    expect(expected.length).toBe(defaultVisibleEntryIds().length);

    await restart();
    expect(getEntryLayoutState().config.visible).toEqual(expected);

    // 库里存的也是这个顺序
    expect((await loadEntryLayout()).config.visible).toEqual(expected);
  });

  it("拖拽提交的集合异常时不会丢入口", async () => {
    await ensureEntryLayoutLoaded();
    const before = getEntryLayoutState().config.visible;
    await commitEntryOrder(mergeEntryOrder(before, [ID("tools")]));
    const after = getEntryLayoutState().config.visible;
    expect(after[0]).toBe("tools");
    expect(new Set(after)).toEqual(new Set(before));
  });
});

describe("场景四：全部隐藏 → 空状态可恢复", () => {
  it("清空工作台后仍是合法配置，重启不会白屏，恢复默认能回退", async () => {
    await ensureEntryLayoutLoaded();
    await commitEntriesVisibility(availableEntryIds(), false);
    expect(getEntryLayoutState().config.visible).toEqual([]);
    expect(getEntryLayoutState().loaded).toBe(true);

    await restart();
    expect(getEntryLayoutState().config.visible).toEqual([]);
    expect(getEntryLayoutState().loaded).toBe(true);
    expect((await loadEntryLayout()).corrupt).toBe(false);

    await resetEntryLayout();
    expect(getEntryLayoutState().config.visible).toEqual(defaultVisibleEntryIds());
  });
});

describe("场景五：旧版本配置升级", () => {
  it("旧结构（没有 known、version 0）保留用户选择并标记迁移", async () => {
    await setSetting(
      ENTRY_LAYOUT_SETTING_KEY,
      JSON.stringify({ version: 0, visible: ["tools", "notes"] }),
    );
    await restart();

    const state = getEntryLayoutState();
    // 老配置里的选择必须保留下来
    expect(state.config.visible).toContain("tools");
    expect(state.config.visible).toContain("notes");
    expect(state.config.visible).toEqual(["tools", "notes"]);

    // 归一化层面标记迁移；启动时的修复写回已经把它写成新结构
    const stored = await loadEntryLayout();
    expect(stored.config.version).toBe(1);
    expect(stored.corrupt).toBe(false);
  });

  it("升级新增功能时只有新入口被补进来，用户隐藏的不动", async () => {
    // 旧版本写下的配置：known 里没有 create-task（那是新版本才有的入口）
    const known = availableEntryIds().filter((id) => id !== "create-task");
    // 必须写原始 JSON：saveEntryLayout 会把 known 补齐成当前全集（新写配置本就应该如此）
    await setSetting(
      ENTRY_LAYOUT_SETTING_KEY,
      JSON.stringify({ version: 1, visible: ["tools"], known }),
    );

    await restart();
    const visible = getEntryLayoutState().config.visible;
    // create-task 默认 order 20 < tools 50：新入口按默认顺序插到 tools 之前，
    // 但不会打乱用户已经排好的相对顺序
    expect(visible).toEqual(["create-task", "tools"]);
  });
});

describe("场景六：两端配置隔离", () => {
  it("移动端只写自己的配置键，不碰桌面端的 navigation_layout", async () => {
    await ensureEntryLayoutLoaded();
    await commitEntryVisibility(ID("files"), true);

    expect(await getSetting(ENTRY_LAYOUT_SETTING_KEY)).not.toBeNull();
    // 移动端 SQLite 里不应出现桌面端的键（桌面端配置在 src-tauri 的 settings 表里）
    expect(await getSetting(DESKTOP_SETTING_KEY)).toBeNull();
    expect(DESKTOP_SETTING_KEY).not.toBe(ENTRY_LAYOUT_SETTING_KEY);
    expect(DESKTOP_STORAGE_NOTE).toContain("settings");
  });

  it("桌面端键的存在不会影响移动端读取", async () => {
    await setSetting(DESKTOP_SETTING_KEY, JSON.stringify({ version: 1, lists: {} }));
    await restart();
    expect(getEntryLayoutState().config.visible).toEqual(defaultVisibleEntryIds());
  });
});

describe("异常场景", () => {
  it("快速连续添加/移除：最后一次操作生效", async () => {
    await ensureEntryLayoutLoaded();
    await Promise.all([
      commitEntryVisibility(ID("files"), true),
      commitEntryVisibility(ID("files"), false),
      commitEntryVisibility(ID("files"), true),
    ]);
    expect(getEntryLayoutState().config.visible).toContain("files");
  });

  it("配置损坏后能恢复到默认并继续编辑", async () => {
    await setSetting(ENTRY_LAYOUT_SETTING_KEY, "{broken");
    await restart();
    expect(getEntryLayoutState().corrupt).toBe(true);
    expect(getEntryLayoutState().config.visible).toEqual(defaultVisibleEntryIds());

    // 修复写回后继续编辑
    await commitEntryVisibility(ID("files"), true);
    expect(getEntryLayoutState().config.visible).toContain("files");
    await restart();
    expect(getEntryLayoutState().config.visible).toContain("files");
    expect(getEntryLayoutState().corrupt).toBe(false);
  });

  it("功能被删除/改 ID 后不会让配置带上脏数据", async () => {
    const dirty = normalizeEntryLayout({
      version: 1,
      visible: ["capture", "deleted-feature"],
      known: availableEntryIds(),
    });
    expect(dirty.dropped).toBe(1);
    expect(dirty.config.visible).toEqual(["capture"]);
  });
});
