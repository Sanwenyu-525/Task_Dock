// @vitest-environment jsdom
//! 各存储模式的文件操作入口判定（纯函数，不渲染）。
import { describe, expect, it } from "vitest";
import type { ShelfItem } from "../../lib/bridge";
import { canCopyItem, canMoveItem, copyActionLabel } from "./ShelfWorkspace";

function item(over: Partial<ShelfItem> = {}): ShelfItem {
  return {
    id: "i1",
    kind: "file",
    display_name: "a.txt",
    source_kind: "picker",
    storage_mode: "reference",
    original_path: "D:\\src\\a.txt",
    managed_path: null,
    content: null,
    byte_size: 100,
    file_ext: "txt",
    favorite: false,
    pinned: false,
    exists_state: "ok",
    group_id: null,
    scene_id: null,
    note: "",
    expire_at: null,
    created_at: "2026-11-05T00:00:00Z",
    updated_at: "2026-11-05T00:00:00Z",
    ...over,
  };
}

describe("文件操作入口判定", () => {
  it("移动仅适用于存在且未失效的引用文件", () => {
    expect(canMoveItem(item())).toBe(true);
    expect(canMoveItem(item({ exists_state: "missing" }))).toBe(false);
    expect(canMoveItem(item({ storage_mode: "managed", original_path: null }))).toBe(false);
    expect(canMoveItem(item({ kind: "link" }))).toBe(false);
    expect(canMoveItem(item({ kind: "text" }))).toBe(false);
  });

  it("复制允许引用文件与托管副本，但失效文件不可复制", () => {
    expect(canCopyItem(item())).toBe(true);
    expect(canCopyItem(item({ storage_mode: "managed", original_path: null }))).toBe(true);
    expect(canCopyItem(item({ exists_state: "missing" }))).toBe(false);
    expect(canCopyItem(item({ kind: "link" }))).toBe(false);
  });

  it("批量复制入口按托管占比给出不同文案", () => {
    expect(copyActionLabel([item()])).toBe("复制到…");
    expect(
      copyActionLabel([item({ storage_mode: "managed", original_path: null })]),
    ).toBe("导出副本到…");
    expect(
      copyActionLabel([
        item(),
        item({ id: "i2", storage_mode: "managed", original_path: null }),
      ]),
    ).toBe("复制 / 导出到…");
  });
});
