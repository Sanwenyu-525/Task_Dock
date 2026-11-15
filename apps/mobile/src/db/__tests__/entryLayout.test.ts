// 入口配置的持久化（P0）：用真实 SQLite（node:sqlite harness）跑真表真键，
// 验证 App 关闭/重启后配置还在，以及坏数据不会把 App 弄成白屏。
//
// 覆盖：首次安装无配置 → 默认；写入后读回；非法 JSON；结构错误；旧版本迁移；
// 已删除入口被清理；读取本身失败（数据库不可用）单独标记 readFailed。
import { beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, openDatabase } from "../database";
import { clearEntryLayout, loadEntryLayout, saveEntryLayout } from "../entryLayout";
import { getSetting, setSetting } from "../kv";
import {
  ENTRY_LAYOUT_SETTING_KEY,
  defaultEntryLayout,
  type EntryLayoutConfig,
} from "../../lib/entryLayout";
import { availableEntryIds, defaultVisibleEntryIds } from "../../lib/entryRegistry";

async function writeRaw(text: string) {
  await setSetting(ENTRY_LAYOUT_SETTING_KEY, text);
}

beforeEach(async () => {
  await closeDatabase();
  await openDatabase();
  await clearEntryLayout();
});

function configOf(visible: string[]): EntryLayoutConfig {
  return { version: 1, visible: visible as EntryLayoutConfig["visible"], known: availableEntryIds() };
}

describe("首次安装与往返", () => {
  it("没有配置时返回默认布局，且不标记损坏", async () => {
    const snapshot = await loadEntryLayout();
    expect(snapshot.source).toBe("default");
    expect(snapshot.corrupt).toBe(false);
    expect(snapshot.readFailed).toBe(false);
    expect(snapshot.config.visible).toEqual(defaultVisibleEntryIds());
  });

  // 注意：本仓库的 expo-sqlite 测试替身用 `:memory:` 库，close/open 等于换了一个新库，
  // 因此「进程重启后仍在」不能用关库再开库来模拟（那测的是替身实现，不是我们的逻辑）。
  // 这里验证的是「真的写进了 kv 表」：同一条连接重新读库能读回完全一致的结构。
  it("保存后能从 kv 表原样读回", async () => {
    await saveEntryLayout(configOf(["files", "tasks", "capture"]));

    const snapshot = await loadEntryLayout();
    expect(snapshot.source).toBe("settings");
    expect(snapshot.config.visible).toEqual(["files", "tasks", "capture"]);
    expect(snapshot.migrated).toBe(false);
    expect(snapshot.corrupt).toBe(false);
  });

  it("保存时会做归一化：暂不可用与未知 id 不会落盘", async () => {
    await saveEntryLayout(configOf(["capture", "dev-workbench", "ghost"]));
    const snapshot = await loadEntryLayout();
    expect(snapshot.config.visible).toEqual(["capture"]);
    expect((await getSetting(ENTRY_LAYOUT_SETTING_KEY)) ?? "").not.toContain("dev-workbench");
  });

  it("空数组可以保存并读回（工作台清空是合法状态）", async () => {
    await saveEntryLayout(configOf([]));
    const snapshot = await loadEntryLayout();
    expect(snapshot.config.visible).toEqual([]);
    expect(snapshot.corrupt).toBe(false);
  });

  it("恢复默认：删除键后再读就是默认布局", async () => {
    await saveEntryLayout(configOf(["files"]));
    await clearEntryLayout();
    const snapshot = await loadEntryLayout();
    expect(snapshot.source).toBe("default");
    expect(snapshot.config.visible).toEqual(defaultVisibleEntryIds());
  });
});

describe("损坏数据安全恢复", () => {
  it("不是 JSON → corrupt，退回默认布局", async () => {
    await writeRaw("{{{ 这不是配置");
    const snapshot = await loadEntryLayout();
    expect(snapshot.corrupt).toBe(true);
    expect(snapshot.config.visible).toEqual(defaultVisibleEntryIds());
    expect(snapshot.rawLength).toBeGreaterThan(0);
  });

  it("JSON 合法但结构错误 → corrupt，退回默认布局", async () => {
    await writeRaw(JSON.stringify({ version: 1, visible: "capture" }));
    const snapshot = await loadEntryLayout();
    expect(snapshot.corrupt).toBe(true);
    expect(snapshot.config.visible).toEqual(defaultVisibleEntryIds());
  });

  it("空字符串视为未配置，不标记损坏", async () => {
    await writeRaw("   ");
    const snapshot = await loadEntryLayout();
    expect(snapshot.corrupt).toBe(false);
    expect(snapshot.source).toBe("default");
  });

  it("旧版本配置按迁移处理并保留用户选择", async () => {
    await writeRaw(JSON.stringify({ version: 0, visible: ["files"], known: availableEntryIds() }));
    const snapshot = await loadEntryLayout();
    expect(snapshot.migrated).toBe(true);
    expect(snapshot.corrupt).toBe(false);
    expect(snapshot.config.visible).toEqual(["files"]);
  });

  it("已删除/改名的入口被清理且计数", async () => {
    await writeRaw(
      JSON.stringify({
        version: 1,
        visible: ["capture", "removed-feature", "dev-workbench"],
        known: availableEntryIds(),
      }),
    );
    const snapshot = await loadEntryLayout();
    expect(snapshot.dropped).toBe(2);
    expect(snapshot.config.visible).toEqual(["capture"]);
  });
});

describe("读取失败", () => {
  it("数据库不可用时标记 readFailed 而不是崩溃", async () => {
    await closeDatabase();
    const snapshot = await loadEntryLayout();
    expect(snapshot.readFailed).toBe(true);
    expect(snapshot.config.visible).toEqual(defaultEntryLayout().visible);
  });
});
