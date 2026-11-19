//! 预览参数快照：任一参数变化都必须让预览失效，执行只能使用预览过的参数。

import { describe, expect, it } from "vitest";
import {
  changedFields,
  createSnapshot,
  optionsKey,
  selectionKey,
  snapshotMatches,
} from "./previewSnapshot";
import type { TransferOptions, TransferTarget } from "./types";

const options: TransferOptions = {
  conflict: "rename",
  textFormat: "txt",
  textMode: "separate",
  fileOperation: "copy",
  urlMode: "url",
};

const target: TransferTarget = { module: "files", ref: "D:\\out" };

describe("previewSnapshot", () => {
  it("参数完全一致时匹配（选择顺序不影响）", () => {
    const snapshot = createSnapshot({ ids: ["a", "b"], target, options }, 1);
    expect(snapshotMatches(snapshot, { ids: ["b", "a"], target, options })).toBe(true);
  });

  it("选择集变化即失效", () => {
    const snapshot = createSnapshot({ ids: ["a", "b"], target, options }, 1);
    expect(snapshotMatches(snapshot, { ids: ["a"], target, options })).toBe(false);
    expect(snapshotMatches(snapshot, { ids: ["a", "b", "c"], target, options })).toBe(false);
  });

  it("目标变化即失效（含首尾空格归一）", () => {
    const snapshot = createSnapshot({ ids: ["a"], target, options }, 1);
    expect(
      snapshotMatches(snapshot, { ids: ["a"], target: { module: "files", ref: "D:\\other" }, options }),
    ).toBe(false);
    expect(
      snapshotMatches(snapshot, { ids: ["a"], target: { module: "files", ref: " D:\\out " }, options }),
    ).toBe(true);
  });

  it.each([
    ["conflict", "skip"],
    ["textFormat", "md"],
    ["textMode", "merge"],
    ["fileOperation", "move"],
    ["urlMode", "markdown"],
  ] as Array<[keyof TransferOptions, string]>)("选项 %s 变化即失效", (key, value) => {
    const snapshot = createSnapshot({ ids: ["a"], target, options }, 1);
    const next = { ...options, [key]: value } as TransferOptions;
    expect(snapshotMatches(snapshot, { ids: ["a"], target, options: next })).toBe(false);
    expect(changedFields(snapshot, { ids: ["a"], target, options: next })).toContain(key);
  });

  it("没有快照时永远不匹配（必须先预览）", () => {
    expect(snapshotMatches(null, { ids: ["a"], target, options })).toBe(false);
  });

  it("选择键去重并排序，比较稳定", () => {
    expect(selectionKey(["b", "a", "b"])).toBe(selectionKey(["a", "b"]));
    expect(optionsKey(options)).toBe(optionsKey({ ...options }));
  });
});
