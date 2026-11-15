// 暂存删除的会话隔离（P0）：业务界面只能按「当前列表里用户看到的 id 集合」删除，
// 不得整表清空——另一采集会话或系统分享中途接入的暂存行必须留存。
//
// 用真实 SQL（node:sqlite harness）+ 内存文件系统替身，验证：
// 1. 按 id 删除只影响选中项，其他暂存行与文件原样保留；
// 2. 空集合/未知 id 不误删；
// 3. clearStash 只作为测试与本地重置入口（仍能清空全部）。
import { beforeEach, describe, expect, it } from "vitest";

import { __activeFiles, __resetFs, __seedFile } from "../../test/mocks/expo-file-system";
import { addStashItem, clearStash, listStash, removeStashItems } from "../captureStash";
import { closeDatabase, openDatabase } from "../database";

const DIR = "file:///data/user/0/dev.taskdock.mobile/files/capture";

function seed(name: string, bytes = 64) {
  const file = __seedFile(DIR, name, new Uint8Array(bytes));
  return file.uri;
}

async function add(name: string) {
  return addStashItem({
    kind: "image",
    mime: "image/jpeg",
    name,
    localUri: seed(name),
    size: 64,
    source: "camera",
  });
}

beforeEach(async () => {
  __resetFs();
  await closeDatabase();
});

describe("暂存按 id 删除", () => {
  it("只删选中项，其他会话的暂存行与文件保留", async () => {
    await openDatabase();
    const first = await add("a.jpg");
    const second = await add("b.jpg");
    const third = await add("c.jpg");

    expect(await listStash()).toHaveLength(3);
    const removed = await removeStashItems([second.id]);
    expect(removed).toBe(1);

    const left = await listStash();
    expect(left.map((item) => item.id)).toEqual([first.id, third.id]);
    // 文件：只删 b.jpg，a/c 仍可打开
    const active = __activeFiles();
    expect(active).toContain(first.localUri);
    expect(active).toContain(third.localUri);
    expect(active).not.toContain(second.localUri);
  });

  it("空集合与未知 id 不产生删除", async () => {
    await openDatabase();
    const item = await add("keep.jpg");
    expect(await removeStashItems([])).toBe(0);
    expect(await removeStashItems(["does-not-exist"])).toBe(0);
    expect(await listStash()).toHaveLength(1);
    expect(__activeFiles()).toContain(item.localUri);
  });

  it("clearStash 仅用于重置：删除全部行与文件", async () => {
    await openDatabase();
    await add("x.jpg");
    await add("y.jpg");
    await clearStash();
    expect(await listStash()).toHaveLength(0);
    expect(__activeFiles()).toEqual([]);
  });
});
