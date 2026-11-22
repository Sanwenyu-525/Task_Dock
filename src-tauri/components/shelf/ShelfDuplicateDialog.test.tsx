/**
 * @vitest-environment jsdom
 */
//! 重复检测结果：分组标签、只提示不自动处理、失败/截断提示。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  shelfDuplicateScan: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...api };
});

import ShelfDuplicateDialog, { DEDUP_KIND_LABELS } from "./ShelfDuplicateDialog";
import { useShelfStore } from "../../store/useShelfStore";

function item(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id,
    display_name: name,
    kind: "file",
    byte_size: 1024,
    original_path: `D:/docs/${name}`,
    content_hash: "abcdef123456",
    ...over,
  };
}

beforeEach(() => {
  api.shelfDuplicateScan.mockReset();
  useShelfStore.setState({ selectedIds: ["a", "b"] });
});

afterEach(() => cleanup());

describe("ShelfDuplicateDialog", () => {
  it("按四类分组展示，并声明不会自动合并/删除", async () => {
    api.shelfDuplicateScan.mockResolvedValue({
      scanned: 5,
      hashed: 4,
      groups: [
        { kind: "exact", key: "abcdef123456", items: [item("a", "a.txt"), item("b", "b.txt")] },
        {
          kind: "same_path",
          key: "d:\\docs\\a.txt",
          items: [item("a", "a.txt"), item("c", "a-copy.txt")],
        },
        {
          kind: "similar_image",
          key: "00000000000000ff",
          items: [item("d", "shot1.png", { kind: "image" }), item("e", "shot2.png", { kind: "image" })],
        },
        {
          kind: "same_name",
          key: "readme.md",
          items: [item("f", "readme.md"), item("g", "readme.md")],
        },
      ],
      unreadable: [],
      truncated: false,
    });
    render(<ShelfDuplicateDialog open ids={["a", "b"]} onClose={() => {}} />);

    await screen.findByText(DEDUP_KIND_LABELS.exact);
    expect(screen.getByText(DEDUP_KIND_LABELS.same_path)).toBeTruthy();
    expect(screen.getByText(DEDUP_KIND_LABELS.similar_image)).toBeTruthy();
    expect(screen.getByText(DEDUP_KIND_LABELS.same_name)).toBeTruthy();
    expect(screen.getByText(/不会自动合并或删除/)).toBeTruthy();
    expect(api.shelfDuplicateScan).toHaveBeenCalledWith(["a", "b"]);
  });

  it("空结果与不可读/截断提示", async () => {
    api.shelfDuplicateScan.mockResolvedValue({
      scanned: 2,
      hashed: 1,
      groups: [],
      unreadable: [{ item_id: "x", code: "SHELF_HASH_UNREADABLE", reason: "读取失败" }],
      truncated: true,
    });
    render(<ShelfDuplicateDialog open onClose={() => {}} />);

    await screen.findByText("未发现重复内容");
    expect(screen.getByText(/1 项内容暂时无法读取/)).toBeTruthy();
    // 全库检测时 ids 为空，传 undefined。
    expect(api.shelfDuplicateScan).toHaveBeenCalledWith(undefined);
  });

  it("检测失败显示错误并可重试", async () => {
    api.shelfDuplicateScan
      .mockRejectedValueOnce(new Error("db busy"))
      .mockResolvedValueOnce({ scanned: 0, hashed: 0, groups: [], unreadable: [], truncated: false });
    render(<ShelfDuplicateDialog open onClose={() => {}} />);

    expect((await screen.findByRole("alert")).textContent).toContain("检测失败");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(screen.getByRole("button", { name: /重新检测/ }));
    await waitFor(() => expect(screen.getByText("未发现重复内容")).toBeTruthy());
    expect(api.shelfDuplicateScan).toHaveBeenCalledTimes(2);
  });
});
