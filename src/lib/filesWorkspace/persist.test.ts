//! 持久化归一化单测：损坏回退、模板校验、states 上限、写入链。

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetFilesWorkspaceWrites,
  __flushFilesWorkspaceWrites,
  bindSettingsStore,
  FILE_WORKSPACE_SETTING_KEY,
  FILE_WORKSPACE_VERSION,
  defaultPersisted,
  normalizePersisted,
  persistFilesWorkspace,
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
    expect(out.states.global?.panes[0].tabs[0]).toEqual({ tabId: "t1", path: "D:\\a" });
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
});
