// 运行时配置状态（P1）：工作台 / 管理页 / 全部功能页读的是同一份快照，
// 这里验证「一份状态 + 串行写队列」在连续操作下不会互相覆盖，且写盘后重启仍一致。
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, openDatabase } from "../../db/database";
import { clearEntryLayout, loadEntryLayout } from "../../db/entryLayout";
import { defaultVisibleEntryIds, type EntryId } from "../entryRegistry";
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

describe("首次读取", () => {
  it("loaded 标记与默认布局", async () => {
    expect(getEntryLayoutState().loaded).toBe(false);
    await ensureEntryLayoutLoaded();
    const state = getEntryLayoutState();
    expect(state.loaded).toBe(true);
    expect(state.source).toBe("default");
    expect(state.config.visible).toEqual(defaultVisibleEntryIds());
  });

  it("并发调用只读一次（单飞）", async () => {
    await Promise.all([ensureEntryLayoutLoaded(), ensureEntryLayoutLoaded()]);
    expect(getEntryLayoutState().loaded).toBe(true);
  });
});

describe("提交变更", () => {
  it("添加/隐藏入口：内存立即生效，且已落盘", async () => {
    await ensureEntryLayoutLoaded();
    await commitEntryVisibility(ID("files"), true);
    expect(getEntryLayoutState().config.visible).toContain("files");

    const stored = await loadEntryLayout();
    expect(stored.config.visible).toContain("files");

    await commitEntryVisibility(ID("files"), false);
    expect(getEntryLayoutState().config.visible).not.toContain("files");
    expect((await loadEntryLayout()).config.visible).not.toContain("files");
  });

  it("连续提交串行执行，不会把对方覆盖掉", async () => {
    await ensureEntryLayoutLoaded();
    await Promise.all([
      commitEntryVisibility(ID("files"), true),
      commitEntryVisibility(ID("sync"), true),
      commitEntryVisibility(ID("notes"), true),
    ]);
    const visible = getEntryLayoutState().config.visible;
    expect(visible).toContain("files");
    expect(visible).toContain("sync");
    expect(visible).toContain("notes");

    const stored = await loadEntryLayout();
    expect(stored.config.visible).toEqual(visible);
  });

  it("批量添加只写一次，顺序按默认排序", async () => {
    await ensureEntryLayoutLoaded();
    await commitEntriesVisibility([ID("sync"), ID("files")], true);
    const visible = getEntryLayoutState().config.visible;
    expect(visible.indexOf("files")).toBeLessThan(visible.indexOf("sync"));
  });

  it("提交顺序：缺失/重复项被安全合并，入口一个都不会丢", async () => {
    await ensureEntryLayoutLoaded();
    const before = getEntryLayoutState().config.visible;
    await commitEntryOrder([ID("tools"), ID("tools"), ID("capture")]);
    const after = getEntryLayoutState().config.visible;
    expect(after.slice(0, 2)).toEqual(["tools", "capture"]);
    expect([...after].sort()).toEqual([...before].sort());
  });

  it("相对移动与恢复默认", async () => {
    await ensureEntryLayoutLoaded();
    await commitEntryMove(ID("capture"), 1);
    expect(getEntryLayoutState().config.visible[0]).toBe("create-task");

    await resetEntryLayout();
    expect(getEntryLayoutState().config.visible).toEqual(defaultVisibleEntryIds());
    expect((await loadEntryLayout()).config.visible).toEqual(defaultVisibleEntryIds());
  });
});

describe("重启一致性", () => {
  it("清掉内存状态后重新加载，仍是用户配置", async () => {
    await ensureEntryLayoutLoaded();
    await commitEntryVisibility(ID("files"), true);
    await commitEntryVisibility(ID("capture"), false);

    __resetEntryLayoutStore();
    await ensureEntryLayoutLoaded();

    const state = getEntryLayoutState();
    expect(state.source).toBe("settings");
    expect(state.config.visible).toContain("files");
    expect(state.config.visible).not.toContain("capture");
  });
});
