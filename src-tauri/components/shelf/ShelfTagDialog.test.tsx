/**
 * @vitest-environment jsdom
 */
//! 批量标签对话框：最近标签复用、添加/移除模式、部分失败反馈。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  shelfTagItems: vi.fn(),
  shelfRecentTags: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...api };
});

import ShelfTagDialog from "./ShelfTagDialog";
import { useShelfStore } from "../../store/useShelfStore";
import { useUiStore } from "../../store/useUiStore";

function report(over: Record<string, unknown> = {}) {
  return {
    tags: ["素材"],
    items: 2,
    changed: 2,
    skipped: 0,
    failed: [],
    success: true,
    partial: false,
    code: null,
    ...over,
  };
}

function lastToast() {
  const toasts = useUiStore.getState().toasts;
  return toasts.length > 0 ? toasts[toasts.length - 1] : null;
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.shelfRecentTags.mockResolvedValue([
    { tag: "素材", count: 3, last_used_at: "2026-11-14T00:00:00Z" },
    { tag: "AI", count: 1, last_used_at: "2026-11-13T00:00:00Z" },
  ]);
  useShelfStore.setState({ selectedIds: ["a", "b"] });
  useUiStore.setState({ toast: null, toasts: [] });
});

afterEach(() => cleanup());

describe("ShelfTagDialog", () => {
  it("展示最近标签并批量添加", async () => {
    api.shelfTagItems.mockResolvedValue(report());
    const onClose = vi.fn();
    render(<ShelfTagDialog open ids={["a", "b"]} onClose={onClose} />);

    fireEvent.click(await screen.findByRole("button", { name: "素材" }));
    expect((screen.getByLabelText("标签内容") as HTMLInputElement).value).toBe("素材");
    fireEvent.click(screen.getByRole("button", { name: /添加标签/ }));

    await waitFor(() =>
      expect(api.shelfTagItems).toHaveBeenCalledWith(["a", "b"], ["素材"], "add"),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(lastToast()?.message).toContain("已为 2 项添加标签");
    expect(useShelfStore.getState().selectedIds).toEqual([]);
  });

  it("切换移除模式并传入 remove", async () => {
    api.shelfTagItems.mockResolvedValue(report({ changed: 1 }));
    const onClose = vi.fn();
    render(<ShelfTagDialog open ids={["a"]} onClose={onClose} />);

    await screen.findByRole("button", { name: "素材" });
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    fireEvent.change(screen.getByLabelText("标签内容"), { target: { value: "旧标签，废弃" } });
    fireEvent.click(screen.getByRole("button", { name: /移除标签/ }));

    await waitFor(() =>
      expect(api.shelfTagItems).toHaveBeenCalledWith(["a"], ["旧标签", "废弃"], "remove"),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("部分失败提示 warning 并保留明细", async () => {
    api.shelfTagItems.mockResolvedValue(
      report({
        changed: 1,
        skipped: 1,
        failed: [
          { item_id: "dead", code: "SHELF_ITEM_NOT_FOUND", reason: "条目不存在，可能已被删除" },
        ],
        partial: true,
      }),
    );
    const onClose = vi.fn();
    render(<ShelfTagDialog open ids={["a", "b"]} onClose={onClose} />);

    await screen.findByRole("button", { name: "素材" });
    fireEvent.change(screen.getByLabelText("标签内容"), { target: { value: "素材" } });
    fireEvent.click(screen.getByRole("button", { name: /添加标签/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const toast = lastToast();
    expect(toast?.kind).toBe("warning");
    expect(toast?.message).toContain("1 项失败");
    expect(toast?.detail).toContain("条目不存在");
  });

  it("空输入禁用提交", async () => {
    render(<ShelfTagDialog open ids={["a"]} onClose={() => {}} />);
    await screen.findByRole("button", { name: "素材" });
    const submit = screen.getByRole("button", { name: /添加标签/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("标签内容"), { target: { value: "  ， " } });
    expect(submit.disabled).toBe(true);
  });

  it("未变化时提示 warning 且不关闭", async () => {
    api.shelfTagItems.mockResolvedValue(
      report({ changed: 0, skipped: 1, success: false, code: "SHELF_TAG_NO_CHANGE" }),
    );
    const onClose = vi.fn();
    render(<ShelfTagDialog open ids={["a"]} onClose={onClose} />);

    await screen.findByRole("button", { name: "素材" });
    fireEvent.change(screen.getByLabelText("标签内容"), { target: { value: "素材" } });
    fireEvent.click(screen.getByRole("button", { name: /添加标签/ }));

    await waitFor(() => expect(lastToast()?.kind).toBe("warning"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
