import { describe, expect, it } from "vitest";
import type { FsEntry } from "../bridge";
import {
  buildPreviewSelection,
  emptyPreviewSelection,
  resolvePreviewSelection,
  summarizePreviewSelection,
} from "./previewSelection";

const DIR = "D:\\proj";

function entry(name: string, kind: "file" | "dir", size: number | null = 100): FsEntry {
  return {
    name,
    kind,
    ext: name.includes(".") ? name.split(".").pop() ?? "" : "",
    size,
    modifiedMs: 1,
    hidden: false,
    category: kind === "dir" ? "folder" : "code",
  };
}

const ENTRIES = [entry("a.ts", "file", 10), entry("b.md", "file", 20), entry("src", "dir", null)];

describe("resolvePreviewSelection", () => {
  it("单选文件 → 预览目标（路径/大小/条目都来自真实条目）", () => {
    const target = resolvePreviewSelection(["D:\\proj\\a.ts"], ENTRIES, "p1", DIR);
    expect(target).toMatchObject({
      paneId: "p1",
      path: "D:\\proj\\a.ts",
      dir: DIR,
      name: "a.ts",
      size: 10,
    });
    expect(target?.entry.name).toBe("a.ts");
  });

  it("路径比较大小写不敏感（Windows 语义）", () => {
    expect(resolvePreviewSelection(["d:\\proj\\A.TS"], ENTRIES, "p1", DIR)?.name).toBe("a.ts");
  });

  it("多选 / 无选择 / 选中文件夹 → null（不对第一个文件做隐式预览）", () => {
    expect(resolvePreviewSelection(["D:\\proj\\a.ts", "D:\\proj\\b.md"], ENTRIES, "p1", DIR)).toBeNull();
    expect(resolvePreviewSelection([], ENTRIES, "p1", DIR)).toBeNull();
    expect(resolvePreviewSelection(["D:\\proj\\src"], ENTRIES, "p1", DIR)).toBeNull();
  });

  it("选中项被筛选隐藏（不在可见条目里）→ null", () => {
    expect(resolvePreviewSelection(["D:\\proj\\gone.ts"], ENTRIES, "p1", DIR)).toBeNull();
  });
});

describe("summarizePreviewSelection", () => {
  it("多选统计文件/文件夹/字节；被隐藏的选中项只计入总数", () => {
    const summary = summarizePreviewSelection(
      ["D:\\proj\\a.ts", "D:\\proj\\b.md", "D:\\proj\\src", "D:\\proj\\hidden.ts"],
      ENTRIES,
      DIR,
    );
    expect(summary).toMatchObject({ count: 4, files: 2, dirs: 1, bytes: 30, folder: null });
  });

  it("单选文件夹给出身份信息，但不递归统计子项", () => {
    const summary = summarizePreviewSelection(["D:\\proj\\src"], ENTRIES, DIR);
    expect(summary.folder).toMatchObject({ path: "D:\\proj\\src", name: "src" });
    expect(summary).toMatchObject({ count: 1, files: 0, dirs: 1, bytes: 0 });
  });

  it("无选择返回空统计对象", () => {
    expect(summarizePreviewSelection([], ENTRIES, DIR)).toEqual({
      count: 0,
      files: 0,
      dirs: 0,
      bytes: 0,
      folder: null,
    });
  });
});

describe("buildPreviewSelection / emptyPreviewSelection", () => {
  it("快照同时携带目标与统计，paneId 用于 Activity 校验", () => {
    const snapshot = buildPreviewSelection(["D:\\proj\\a.ts"], ENTRIES, "p2", DIR);
    expect(snapshot.paneId).toBe("p2");
    expect(snapshot.dir).toBe(DIR);
    expect(snapshot.target?.path).toBe("D:\\proj\\a.ts");
    expect(snapshot.summary.count).toBe(1);
  });

  it("空快照不指向任何文件", () => {
    const snapshot = emptyPreviewSelection("p1", DIR);
    expect(snapshot.target).toBeNull();
    expect(snapshot.summary.count).toBe(0);
  });
});
