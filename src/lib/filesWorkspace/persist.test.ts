//! 持久化归一化单测：损坏回退、模板校验、states 上限、写入链。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetFilesWorkspaceWrites,
  __flushFilesWorkspaceWrites,
  bindSettingsStore,
  FILE_WORKSPACE_SETTING_KEY,
  FILE_WORKSPACE_VERSION,
  GLOBAL_STATE_KEY,
  MAX_STATES,
  defaultPersisted,
  normalizePersisted,
  persistFilesWorkspace,
  readFilesWorkspacePersisted,
  type FilesWorkspacePersisted,
} from "./persist";
import { LAYOUT_PRESETS, type SplitNode } from "./model";

function validTree(): SplitNode {
  return LAYOUT_PRESETS.leftRight.build();
}

describe("normalizePersisted", () => {
  it("损坏/未知版本整体回默认", () => {
    expect(normalizePersisted(null)).toEqual(defaultPersisted());
    expect(normalizePersisted("junk")).toEqual(defaultPersisted());
    expect(normalizePersisted({ version: 999 })).toEqual(defaultPersisted());
    expect(normalizePersisted({ version: "1" })).toEqual(defaultPersisted());
  });

  it("states 键校验：非法键丢弃，合法键恢复", () => {
    const raw = {
      version: FILE_WORKSPACE_VERSION,
      states: {
        global: { tree: validTree(), panes: [], activePaneId: "x" },
        "project:abc_1": { tree: validTree(), panes: [], activePaneId: "x" },
        "project:bad key!": { tree: validTree(), panes: [] },
        weird: { tree: validTree(), panes: [] },
      },
    };
    const out = normalizePersisted(raw);
    expect(Object.keys(out.states).sort()).toEqual(["global", "project:abc_1"]);
  });

  it("states 超上限时保住 global（腾出的名额来自项目态）", () => {
    const base = { tree: validTree(), panes: [], activePaneId: "x" };
    const states: Record<string, unknown> = {};
    for (let i = 1; i <= MAX_STATES; i += 1) states[`project:p${i}`] = base;
    // global 排在最后：朴素 slice(0, MAX_STATES) 会把它裁掉。
    states[GLOBAL_STATE_KEY] = base;
    const out = normalizePersisted({ version: FILE_WORKSPACE_VERSION, states });
    expect(Object.keys(out.states)).toHaveLength(MAX_STATES);
    expect(out.states[GLOBAL_STATE_KEY]).toBeDefined();
    expect(out.states[`project:p${MAX_STATES}`]).toBeUndefined();
  });

  it("状态内 activePaneId 非法时落到第一个窗格", () => {
    const raw = {
      version: FILE_WORKSPACE_VERSION,
      states: {
        global: {
          tree: validTree(),
          panes: [{ paneId: paneIdsOf(validTree())[0], tabs: [{ tabId: "t1", path: "D:\\a" }], activeTabId: "t1" }],
          activePaneId: "ghost",
        },
      },
    };
    const out = normalizePersisted(raw);
    expect(out.states.global?.activePaneId).toBe(paneIdsOf(validTree())[0]);
    expect(out.states.global?.panes[0].tabs[0]).toEqual({ tabId: "t1", path: "D:\\a", openedPath: "D:\\a" });
  });

  it("colWidths 透传合法值、丢弃非法列；旧数据缺失时字段为 undefined（向后兼容）", () => {
    const base = { tree: validTree(), panes: [], activePaneId: "x" };
    const out = normalizePersisted({
      version: FILE_WORKSPACE_VERSION,
      states: {
        global: { ...base, colWidths: { time: 150.6, size: 10, junk: 999 } },
        "project:p1": base,
      },
    });
    expect(out.states.global?.colWidths).toEqual({ time: 151 });
    expect(out.states["project:p1"]?.colWidths).toBeUndefined();
  });

  it("窗格不在树中时丢弃该窗格数据（保留窗格空态由恢复侧补）", () => {
    const raw = {
      version: FILE_WORKSPACE_VERSION,
      states: {
        global: {
          tree: validTree(),
          panes: [
            { paneId: "ghost-pane", tabs: [{ tabId: "t", path: "C:\\x" }], activeTabId: "t" },
            { paneId: paneIdsOf(validTree())[0], tabs: [{ tabId: "t2", path: "D:\\y" }], activeTabId: "t2" },
          ],
          activePaneId: paneIdsOf(validTree())[0],
        },
      },
    };
    const out = normalizePersisted(raw);
    expect(out.states.global?.panes).toHaveLength(1);
  });

  it("模板逐条校验：无名字/树损坏的模板丢弃，数量上限 20", () => {
    const tree = validTree();
    const templates = Array.from({ length: 25 }, (_, i) => ({
      id: `tpl-${i}`,
      name: i % 5 === 0 ? "" : `模板 ${i}`,
      tree,
      panes: [],
    }));
    const raw = { version: FILE_WORKSPACE_VERSION, templates };
    const out = normalizePersisted(raw);
    expect(out.templates.length).toBeLessThanOrEqual(20);
    expect(out.templates.every((t) => t.name.length > 0)).toBe(true);
  });

  it("recentTemplates 去重且上限 8", () => {
    const raw = {
      version: FILE_WORKSPACE_VERSION,
      recentTemplates: ["a", "a", "b", 42, "c", "d", "e", "f", "g", "h", "i"],
    };
    const out = normalizePersisted(raw);
    expect(out.recentTemplates).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });
});

function paneIdsOf(tree: SplitNode): string[] {
  if (tree.type === "pane") return [tree.paneId];
  return [...paneIdsOf(tree.first), ...paneIdsOf(tree.second)];
}

describe("normalizePersisted：会话字段与 tabId 唯一性", () => {
  it("透传全部会话字段（含 history/historyIndex/openedPath）", () => {
    const tree = validTree();
    const paneId = paneIdsOf(tree)[0];
    const raw = {
      version: FILE_WORKSPACE_VERSION,
      states: {
        global: {
          tree,
          panes: [{
            paneId,
            tabs: [{
              tabId: "t1",
              path: "D:\\work\\sub",
              openedPath: "D:\\work",
              history: ["D:\\work", "D:\\work\\sub"],
              historyIndex: 1,
              viewMode: "grid",
              sortField: "modified",
              sortAsc: false,
              search: "报表",
              filter: "sheet",
              showHidden: true,
            }],
            activeTabId: "t1",
          }],
          activePaneId: paneId,
        },
      },
    };
    const out = normalizePersisted(raw);
    expect(out.states.global?.panes[0].tabs[0]).toEqual({
      tabId: "t1",
      path: "D:\\work\\sub",
      openedPath: "D:\\work",
      history: ["D:\\work", "D:\\work\\sub"],
      historyIndex: 1,
      viewMode: "grid",
      sortField: "modified",
      sortAsc: false,
      search: "报表",
      filter: "sheet",
      showHidden: true,
    });
  });

  it("旧数据缺 openedPath 时用 path 兜底；无 history 时不写 history 字段", () => {
    const tree = validTree();
    const paneId = paneIdsOf(tree)[0];
    const out = normalizePersisted({
      version: FILE_WORKSPACE_VERSION,
      states: {
        global: {
          tree,
          panes: [{ paneId, tabs: [{ tabId: "old", path: "C:\\legacy" }], activeTabId: "old" }],
          activePaneId: paneId,
        },
      },
    });
    const tab = out.states.global?.panes[0].tabs[0];
    expect(tab).toEqual({ tabId: "old", path: "C:\\legacy", openedPath: "C:\\legacy" });
    expect(tab?.history).toBeUndefined();
  });

  it("historyIndex 越界被钳制；非法枚举/字段被丢弃", () => {
    const tree = validTree();
    const paneId = paneIdsOf(tree)[0];
    const out = normalizePersisted({
      version: FILE_WORKSPACE_VERSION,
      states: {
        global: {
          tree,
          panes: [{
            paneId,
            tabs: [{
              tabId: "t", path: "D:\\x",
              history: ["D:\\x", "D:\\x\\y"],
              historyIndex: 99,
              viewMode: "bogus",
              sortField: "bogus",
              filter: "bogus",
              sortAsc: "yes",
            }],
            activeTabId: "t",
          }],
          activePaneId: paneId,
        },
      },
    });
    const tab = out.states.global?.panes[0].tabs[0]!;
    expect(tab.historyIndex).toBe(1);
    expect(tab.viewMode).toBeUndefined();
    expect(tab.sortField).toBeUndefined();
    expect(tab.filter).toBeUndefined();
    expect(tab.sortAsc).toBeUndefined();
  });

  it("重复 tabId 跨窗格去重；activeTabId 无效回落首个", () => {
    const tree = validTree();
    const [a, b] = paneIdsOf(tree);
    const out = normalizePersisted({
      version: FILE_WORKSPACE_VERSION,
      states: {
        global: {
          tree,
          panes: [
            {
              paneId: a,
              tabs: [{ tabId: "dup", path: "D:\\a" }, { tabId: "only-a", path: "D:\\a2" }],
              activeTabId: "dup",
            },
            {
              paneId: b,
              tabs: [{ tabId: "dup", path: "D:\\b" }, { tabId: "only-b", path: "D:\\b2" }],
              activeTabId: "ghost",
            },
          ],
          activePaneId: a,
        },
      },
    });
    const panes = out.states.global?.panes!;
    // 第二个窗格里的 dup 被丢弃，仅保留 first-wins 的那一个。
    expect(panes[0].tabs.map((t) => t.tabId)).toEqual(["dup", "only-a"]);
    expect(panes[1].tabs.map((t) => t.tabId)).toEqual(["only-b"]);
    expect(panes[1].activeTabId).toBe("only-b");
  });

  it("重复 tabId 跨窗格与收纳去重（收纳中与窗格冲突的被丢弃）", () => {
    const tree = validTree();
    const paneId = paneIdsOf(tree)[0];
    const out = normalizePersisted({
      version: FILE_WORKSPACE_VERSION,
      states: {
        global: {
          tree,
          panes: [{ paneId, tabs: [{ tabId: "shared", path: "D:\\inPane" }], activeTabId: "shared" }],
          activePaneId: paneId,
          stashed: [
            { tabId: "shared", path: "D:\\stashedDup" },
            { tabId: "stashed-ok", path: "D:\\stashedOk" },
          ],
        },
      },
    });
    expect(out.states.global?.stashed?.map((t) => t.tabId)).toEqual(["stashed-ok"]);
  });
});

describe("persistFilesWorkspace 写入链", () => {
  interface FakeStore {
    settings: Record<string, unknown> | null;
    writes: number;
    failOnce: boolean;
  }
  let fake: FakeStore;

  beforeEach(() => {
    __resetFilesWorkspaceWrites();
    fake = { settings: { [FILE_WORKSPACE_SETTING_KEY]: { version: FILE_WORKSPACE_VERSION } }, writes: 0, failOnce: false };
    bindSettingsStore(() => ({
      settings: fake.settings,
      update: async (patch: Record<string, unknown>) => {
        if (fake.failOnce) throw new Error("write-failed");
        fake.writes += 1;
        fake.settings = { ...fake.settings, ...patch };
      },
    }));
  });

  afterEach(() => {
    __resetFilesWorkspaceWrites();
  });

  it("串行写入：后一次基于前一次结果", async () => {
    await persistFilesWorkspace((current) => ({ ...current, recentTemplates: ["a"] }));
    await persistFilesWorkspace((current) => ({
      ...current,
      recentTemplates: [...current.recentTemplates, "b"],
    }));
    await __flushFilesWorkspaceWrites();
    expect(fake.writes).toBe(2);
    const saved = fake.settings?.[FILE_WORKSPACE_SETTING_KEY] as FilesWorkspacePersisted;
    expect(saved.recentTemplates).toEqual(["a", "b"]);
  });

  it("写入失败向上抛错且不阻塞后续写入", async () => {
    fake.failOnce = true;
    await expect(persistFilesWorkspace((c) => ({ ...c }))).rejects.toThrow("write-failed");
    fake.failOnce = false;
    await expect(persistFilesWorkspace((c) => ({ ...c, recentTemplates: ["x"] }))).resolves.toBeUndefined();
    await __flushFilesWorkspaceWrites();
  });

  it("设置未加载时报错（不静默）", async () => {
    bindSettingsStore(() => ({ settings: null, update: async () => {} }));
    await expect(persistFilesWorkspace((c) => ({ ...c }))).rejects.toThrow("设置尚未加载");
    await __flushFilesWorkspaceWrites();
  });

  it("超上限写入时保住 global，淘汰最旧的项目态", async () => {
    const base = { tree: validTree(), panes: [], activePaneId: "x" };
    const states: Record<string, unknown> = { [GLOBAL_STATE_KEY]: base };
    for (let i = 1; i < MAX_STATES; i += 1) states[`project:p${i}`] = base;
    fake.settings = {
      [FILE_WORKSPACE_SETTING_KEY]: { version: FILE_WORKSPACE_VERSION, states, templates: [], recentTemplates: [] },
    };

    // 再写一个新项目现场 → 总 9 个键，必须裁掉最旧的 project:p1，global 保留。
    await persistFilesWorkspace((cur) => ({
      ...cur,
      states: { ...cur.states, [`project:p${MAX_STATES}`]: base },
    }));

    const saved = fake.settings?.[FILE_WORKSPACE_SETTING_KEY] as FilesWorkspacePersisted;
    expect(Object.keys(saved.states)).toHaveLength(MAX_STATES);
    expect(saved.states[GLOBAL_STATE_KEY]).toBeDefined();
    expect(saved.states["project:p1"]).toBeUndefined();
    expect(saved.states[`project:p${MAX_STATES}`]).toBeDefined();
  });
});

describe("readFilesWorkspacePersisted", () => {
  it("设置未加载时返回 null（调用方保留内存值）", () => {
    bindSettingsStore(() => ({ settings: null, update: async () => {} }));
    expect(readFilesWorkspacePersisted()).toBeNull();
  });

  it("返回归一化数据：最近模板去重且保持顺序", () => {
    bindSettingsStore(() => ({
      settings: {
        [FILE_WORKSPACE_SETTING_KEY]: {
          version: FILE_WORKSPACE_VERSION,
          recentTemplates: ["b", "b", "a"],
        },
      },
      update: async () => {},
    }));
    expect(readFilesWorkspacePersisted()?.recentTemplates).toEqual(["b", "a"]);
  });
});
