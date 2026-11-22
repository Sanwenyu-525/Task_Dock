/** @vitest-environment jsdom */
//! 暂存架卡片来源标记：origin=mobile_capture 显示「移动端采集」徽标；
//! 其他来源不渲染该标记。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ShelfItem } from "../../lib/bridge";
import { resetOverlayStack } from "../../lib/overlayStack";
import ShelfItemCard from "./ShelfItemCard";

function item(over: Partial<ShelfItem> = {}): ShelfItem {
  return {
    id: "s-1",
    kind: "file",
    display_name: "报告.pdf",
    source_kind: "picker",
    storage_mode: "reference",
    original_path: "D:/Docs/报告.pdf",
    managed_path: null,
    content: null,
    byte_size: 1024,
    file_ext: "pdf",
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

function renderCard(over: Partial<ShelfItem> = {}) {
  return render(
    <ShelfItemCard
      item={item(over)}
      selected={false}
      thumbUrl={null}
      menuItems={[]}
      onOpen={() => {}}
      onToggleSelect={() => {}}
      onPreview={() => {}}
    />,
  );
}

beforeEach(() => {
  resetOverlayStack();
});

afterEach(() => {
  cleanup();
});

describe("ShelfItemCard 来源标记", () => {
  it("origin=mobile_capture 时显示「移动端采集」徽标", () => {
    renderCard({ origin: "mobile_capture" });
    expect(screen.getByText("移动端采集")).toBeTruthy();
  });

  it("其他来源不显示移动端采集徽标", () => {
    renderCard({ origin: null });
    expect(screen.queryByText("移动端采集")).toBeNull();
  });
});
