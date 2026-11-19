//! 路径识别：普通文件 / 文件夹 / 失效路径必须按真实文件系统判定，不能看扩展名。

import { describe, expect, it, vi } from "vitest";
import type { FsStat } from "../contracts/models";
import { itemTypeForStat, resolvePathInputs, STAT_CHUNK } from "./fileKinds";

function stat(path: string, kind: FsStat["kind"]): FsStat {
  return {
    path,
    exists: kind !== "missing",
    kind,
    size: kind === "dir" ? null : 10,
    createdMs: null,
    modifiedMs: null,
    accessedMs: null,
    attributes: [],
    readonly: false,
    hidden: false,
    childCount: kind === "dir" ? 3 : null,
    childTruncated: false,
  };
}

describe("fileKinds", () => {
  it("按真实形态判定：dir → directory，file/link → file，missing → null", () => {
    expect(itemTypeForStat({ exists: true, kind: "dir" })).toBe("directory");
    expect(itemTypeForStat({ exists: true, kind: "file" })).toBe("file");
    expect(itemTypeForStat({ exists: true, kind: "link" })).toBe("file");
    expect(itemTypeForStat({ exists: false, kind: "missing" })).toBeNull();
  });

  it("不会因为名字带点就把文件夹当文件", async () => {
    const paths = ["D:\\x\\release.2026", "D:\\x\\a.txt"];
    const statFn = vi.fn(async (batch: string[]) =>
      batch.map((path) => stat(path, path.endsWith("2026") ? "dir" : "file")),
    );
    const result = await resolvePathInputs(paths, statFn, "files");
    expect(result.inputs.map((input) => input.itemType)).toEqual(["directory", "file"]);
    expect(result.rejected).toHaveLength(0);
    // 一次批量查询，不为每个文件单独发 IPC。
    expect(statFn).toHaveBeenCalledTimes(1);
  });

  it("失效路径进入 rejected 并保留原始顺序", async () => {
    const paths = ["D:\\x\\missing.txt", "D:\\x\\ok.txt"];
    const statFn = async (batch: string[]) =>
      batch.map((path) => stat(path, path.includes("missing") ? "missing" : "file"));
    const result = await resolvePathInputs(paths, statFn, "clipboard");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("TRANSFER_SOURCE_MISSING");
    expect(result.rejected[0].title).toBe("missing.txt");
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0].payload?.path).toBe("D:\\x\\ok.txt");
  });

  it("重复路径去重但保留首次出现的位置", async () => {
    const paths = ["D:\\a", "D:\\b", "d:\\a"];
    const statFn = async (batch: string[]) => batch.map((path) => stat(path, "file"));
    const result = await resolvePathInputs(paths, statFn, "files");
    expect(result.inputs).toHaveLength(2);
    expect(result.inputs[0].sourceId).toBe("D:\\a");
    expect(result.inputs[1].sourceId).toBe("D:\\b");
  });

  it("整批查询失败时退化为逐条查询，单条非法不影响其他条目", async () => {
    const statFn = vi.fn(async (batch: string[]) => {
      if (batch.length > 1) throw new Error("非法路径导致整批失败");
      const [path] = batch;
      return [stat(path, path.includes("bad") ? "missing" : "file")];
    });
    const result = await resolvePathInputs(["D:\\bad", "D:\\good"], statFn, "files");
    expect(result.inputs.map((input) => input.itemType)).toEqual(["file"]);
    expect(result.rejected.map((entry) => entry.title)).toEqual(["bad"]);
  });

  it("大批量按块查询，不会一次发上百个路径", async () => {
    const paths = Array.from({ length: STAT_CHUNK + 10 }, (_, i) => `D:\\f${i}.txt`);
    const statFn = vi.fn(async (batch: string[]) => batch.map((path) => stat(path, "file")));
    await resolvePathInputs(paths, statFn, "files");
    expect(statFn).toHaveBeenCalledTimes(2);
    expect((statFn.mock.calls[0] as unknown as [string[]])[0]).toHaveLength(STAT_CHUNK);
  });
});
