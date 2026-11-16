// 写入失败故障注入（P1）：真实 SQLite 测试覆盖不到「写盘抛错」这条分支，
// 这里把 db 层换成可控假实现，验证回滚、错误传播与写队列不被污染。
//
// 覆盖的承诺：
// 1. 写失败必须抛给界面（不能静默当成功）；
// 2. 内存配置回滚到最后一次成功落盘的状态（含 source/corrupt 等标记）；
// 3. 失败不会让后续写入失效（写队列的 catch 不能传染下一次）；
// 4. 连续失败不出现状态污染；
// 5. 快速连续提交按顺序执行，不会用旧配置覆盖新配置。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ENTRY_LAYOUT_VERSION,
  defaultEntryLayout,
  normalizeEntryLayout,
  setEntryVisible,
  type EntryLayoutConfig,
} from "../entryLayout";
import { availableEntryIds, defaultVisibleEntryIds, type EntryId } from "../entryRegistry";
import type { EntryLayoutSnapshot } from "../../db/entryLayout";

const ID = (value: string) => value as EntryId;

/** 被 mock 的 db 层：load 返回什么、save 成功还是失败，由每个用例决定 */
const dbMock = vi.hoisted(() => ({
  loads: 0,
  saves: [] as unknown[],
  loadResult: null as unknown,
  saveImpl: null as ((config: unknown) => Promise<void>) | null,
}));

vi.mock("../../db/entryLayout", () => ({
  loadEntryLayout: async () => {
    dbMock.loads += 1;
    if (dbMock.loadResult === null) throw new Error("test did not set loadResult");
    return dbMock.loadResult;
  },
  saveEntryLayout: async (config: unknown) => {
    dbMock.saves.push(config);
    if (dbMock.saveImpl) await dbMock.saveImpl(config);
  },
  clearEntryLayout: async () => undefined,
}));

import {
  __resetEntryLayoutStore,
  commitEntryVisibility,
  ensureEntryLayoutLoaded,
  getEntryLayoutState,
} from "../entryLayoutStore";

/** 构造一份「像从 kv 读出来的」快照 */
function settingsSnapshot(visible: readonly EntryId[]): EntryLayoutSnapshot {
  const config = normalizeEntryLayout({
    version: ENTRY_LAYOUT_VERSION,
    visible,
    known: availableEntryIds(),
  }).config;
  return {
    config,
    source: "settings",
    migrated: false,
    dropped: 0,
    corrupt: false,
    readFailed: false,
    rawLength: JSON.stringify(config).length,
  };
}

function defaultSnapshot(): EntryLayoutSnapshot {
  return {
    config: defaultEntryLayout(),
    source: "default",
    migrated: false,
    dropped: 0,
    corrupt: false,
    readFailed: false,
    rawLength: 0,
  };
}

/** 直接改 save 的行为（不动 load） */
function setSaveMode(mode: "ok" | "fail" | "slow-ok") {
  if (mode === "ok") {
    dbMock.saveImpl = null;
    return;
  }
  if (mode === "fail") {
    dbMock.saveImpl = async () => {
      throw new Error("disk full");
    };
    return;
  }
  dbMock.saveImpl = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
}

function lastSaved(): EntryLayoutConfig {
  return dbMock.saves[dbMock.saves.length - 1] as EntryLayoutConfig;
}

beforeEach(() => {
  __resetEntryLayoutStore();
  dbMock.loads = 0;
  dbMock.saves = [];
  dbMock.loadResult = settingsSnapshot(defaultVisibleEntryIds());
  dbMock.saveImpl = null;
});

afterEach(() => {
  __resetEntryLayoutStore();
});

describe("读取成功后的写入", () => {
  it("首次读取成功：配置来自 kv，标记 loaded", async () => {
    await ensureEntryLayoutLoaded();
    const state = getEntryLayoutState();
    expect(state.loaded).toBe(true);
    expect(state.source).toBe("settings");
    expect(state.config.visible).toEqual(defaultVisibleEntryIds());
  });

  it("修改成功：内存立即生效，落盘内容与内存一致", async () => {
    await ensureEntryLayoutLoaded();
    await commitEntryVisibility(ID("files"), true);

    expect(getEntryLayoutState().config.visible).toContain("files");
    expect(lastSaved().visible).toContain("files");
    expect(lastSaved().version).toBe(ENTRY_LAYOUT_VERSION);
    expect(lastSaved().known).toEqual(availableEntryIds());
  });
});

describe("写盘失败", () => {
  it("commit 抛出原始错误，内存回滚到读取到的配置", async () => {
    await ensureEntryLayoutLoaded();
    const before = getEntryLayoutState().config;
    setSaveMode("fail");

    await expect(commitEntryVisibility(ID("files"), true)).rejects.toThrow("disk full");

    expect(getEntryLayoutState().config.visible).toEqual(before.visible);
    expect(getEntryLayoutState().config.visible).not.toContain("files");
  });

  it("首次写盘就失败：回滚到上一次成功状态，source 不残留为「已保存」", async () => {
    // 首次安装（kv 为空）时读取到的是默认布局，从没成功落盘过
    dbMock.loadResult = defaultSnapshot();
    await ensureEntryLayoutLoaded();
    setSaveMode("fail");

    await expect(commitEntryVisibility(ID("files"), true)).rejects.toThrow("disk full");

    const state = getEntryLayoutState();
    expect(state.config.visible).toEqual(defaultVisibleEntryIds());
    // 乐观更新把 source 改成了 settings；失败后必须回到读取时的 default
    expect(state.source).toBe("default");
    expect(state.corrupt).toBe(false);
  });

  it("先成功后失败：回滚到最近一次成功落盘的配置，而不是最初配置", async () => {
    await ensureEntryLayoutLoaded();
    await commitEntryVisibility(ID("sync"), true);
    const persisted = getEntryLayoutState().config;

    setSaveMode("fail");
    await expect(commitEntryVisibility(ID("notes"), true)).rejects.toThrow("disk full");

    const state = getEntryLayoutState();
    expect(state.config.visible).toEqual(persisted.visible);
    expect(state.config.visible).toContain("sync");
    expect(state.config.visible).not.toContain("notes");
    expect(state.source).toBe("settings");
  });

  it("失败后后续写入仍可执行（写队列不被污染）", async () => {
    await ensureEntryLayoutLoaded();
    setSaveMode("fail");
    await expect(commitEntryVisibility(ID("files"), true)).rejects.toThrow("disk full");

    setSaveMode("ok");
    const config = await commitEntryVisibility(ID("files"), true);

    expect(config.visible).toContain("files");
    expect(getEntryLayoutState().config.visible).toContain("files");
    expect(lastSaved().visible).toContain("files");
  });

  it("连续多次失败：状态不累积污染，恢复后立即正常", async () => {
    await ensureEntryLayoutLoaded();
    const baseline = getEntryLayoutState().config;
    setSaveMode("fail");

    for (let index = 0; index < 3; index += 1) {
      await expect(commitEntryVisibility(ID("files"), true)).rejects.toThrow("disk full");
      expect(getEntryLayoutState().config.visible).toEqual(baseline.visible);
      expect(getEntryLayoutState().corrupt).toBe(false);
    }
    // 三次提交都真正调用了写盘（saves 记录的是尝试次数，不是成功次数）
    expect(dbMock.saves.length).toBe(3);

    setSaveMode("ok");
    await commitEntryVisibility(ID("files"), true);
    expect(getEntryLayoutState().config.visible).toContain("files");
  });

  it("启动修复写回失败：本次仍用安全配置，下次启动会再试", async () => {
    const corrupt: EntryLayoutSnapshot = {
      ...defaultSnapshot(),
      source: "settings",
      corrupt: true,
    };
    dbMock.loadResult = corrupt;
    setSaveMode("fail");

    await ensureEntryLayoutLoaded();

    const state = getEntryLayoutState();
    expect(state.loaded).toBe(true);
    expect(state.corrupt).toBe(true);
    expect(state.config.visible).toEqual(defaultVisibleEntryIds());
  });
});

describe("快速连续提交", () => {
  it("串行执行：后一次写盘包含前一次结果，不会旧配置覆盖新配置", async () => {
    await ensureEntryLayoutLoaded();
    setSaveMode("slow-ok");

    const results = await Promise.all([
      commitEntryVisibility(ID("files"), true),
      commitEntryVisibility(ID("sync"), true),
      commitEntryVisibility(ID("notes"), true),
    ]);

    const final = getEntryLayoutState().config.visible;
    expect(final).toContain("files");
    expect(final).toContain("sync");
    expect(final).toContain("notes");
    expect(results[2].visible).toEqual(final);
    expect(lastSaved().visible).toEqual(final);
    expect(dbMock.saves.length).toBe(3);
  });

  it("中间一次失败：后面的提交继续执行，最终状态以后者为准", async () => {
    await ensureEntryLayoutLoaded();
    await commitEntryVisibility(ID("files"), true); // 先建立「上次成功」
    const persistedAfterFirst = getEntryLayoutState().config.visible;

    let calls = 0;
    dbMock.saveImpl = async () => {
      calls += 1;
      if (calls === 1) throw new Error("disk full");
      await new Promise((resolve) => setTimeout(resolve, 20));
    };

    const first = commitEntryVisibility(ID("sync"), true);
    const second = commitEntryVisibility(ID("notes"), true);

    await expect(first).rejects.toThrow("disk full");
    const secondConfig = await second;

    // 第二次提交基于回滚后的配置计算：失败的 sync 不能被悄悄写进去，
    // 而它自己的 notes 变更必须正常生效。
    const expected = setEntryVisible(persistedAfterFirst, ID("notes"), true);
    expect(secondConfig.visible).toEqual(expected);
    expect(secondConfig.visible).not.toContain("sync");
    expect(getEntryLayoutState().config.visible).toEqual(secondConfig.visible);
  });
});
