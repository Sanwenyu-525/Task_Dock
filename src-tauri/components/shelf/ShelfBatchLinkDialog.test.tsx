/**
 * @vitest-environment jsdom
 */
//! 批量关联对话框：目标加载、项目/任务切换、成功/部分失败/整批失败反馈。
//! 只验证前端协议衔接；关系表写入语义由 Rust `shelf::batch` 单测覆盖。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  shelfBatchLink: vi.fn(),
  workspaceProjectList: vi.fn(),
  listTasks: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...api };
});

import ShelfBatchLinkDialog from "./ShelfBatchLinkDialog";
import { useShelfStore } from "../../store/useShelfStore";
import { useUiStore } from "../../store/useUiStore";

function report(over: Record<string, unknown> = {}) {
  return {
    target: "project",
    target_id: "p1",
    target_name: "漫剧项目",
    linked: 2,
    duplicates: 0,
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
  api.workspaceProjectList.mockResolvedValue({
    projects: [
      { id: "p1", name: "漫剧项目" },
      { id: "p2", name: "游戏项目" },
    ],
  });
  api.listTasks.mockResolvedValue([
    { id: "t1", title: "修复登录" },
    { id: "t2", title: "整理素材" },
  ]);
  useShelfStore.setState({ selectedIds: ["a", "b"] });
  useUiStore.setState({ toast: null, toasts: [] });
});

afterEach(() => cleanup());

describe("ShelfBatchLinkDialog", () => {
  it("加载项目并批量关联，成功后关闭并清空多选", async () => {
    api.shelfBatchLink.mockResolvedValue(report());
    const onClose = vi.fn();
    render(<ShelfBatchLinkDialog open ids={["a", "b"]} onClose={onClose} />);

    await screen.findByText("选择项目…");
    fireEvent.click(screen.getByRole("combobox", { name: "选择要关联的项目" }));
    fireEvent.click(await screen.findByRole("option", { name: "漫剧项目" }));
    fireEvent.click(screen.getByRole("button", { name: /关联 2 项/ }));

    await waitFor(() => expect(api.shelfBatchLink).toHaveBeenCalledWith(["a", "b"], "project", "p1"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(lastToast()?.message).toContain("已关联「漫剧项目」2 项");
    expect(useShelfStore.getState().selectedIds).toEqual([]);
  });

  it("切换到任务后提交任务关联", async () => {
    api.shelfBatchLink.mockResolvedValue(
      report({ target: "task", target_id: "t2", target_name: "整理素材", linked: 1 }),
    );
    const onClose = vi.fn();
    render(<ShelfBatchLinkDialog open ids={["a"]} onClose={onClose} />);

    await screen.findByText("选择项目…");
    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    await screen.findByText("选择任务…");
    fireEvent.click(screen.getByRole("combobox", { name: "选择要关联的任务" }));
    fireEvent.click(await screen.findByRole("option", { name: "整理素材" }));
    fireEvent.click(screen.getByRole("button", { name: /关联 1 项/ }));

    await waitFor(() => expect(api.shelfBatchLink).toHaveBeenCalledWith(["a"], "task", "t2"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("部分失败显示明细但仍视为已关联", async () => {
    api.shelfBatchLink.mockResolvedValue(
      report({
        linked: 1,
        failed: [
          { item_id: "deadbeef-0000", code: "SHELF_ITEM_NOT_FOUND", reason: "条目不存在，可能已被删除" },
        ],
        partial: true,
      }),
    );
    const onClose = vi.fn();
    render(<ShelfBatchLinkDialog open ids={["a", "b"]} onClose={onClose} />);

    await screen.findByText("选择项目…");
    fireEvent.click(screen.getByRole("combobox", { name: "选择要关联的项目" }));
    fireEvent.click(await screen.findByRole("option", { name: "漫剧项目" }));
    fireEvent.click(screen.getByRole("button", { name: /关联 2 项/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const toast = lastToast();
    expect(toast?.kind).toBe("warning");
    expect(toast?.message).toContain("1 项失败");
    expect(toast?.detail).toContain("条目不存在");
  });

  it("全部失败保持对话框并提示，不关闭", async () => {
    api.shelfBatchLink.mockResolvedValue(
      report({
        linked: 0,
        failed: [
          { item_id: "deadbeef-0000", code: "SHELF_ITEM_NOT_FOUND", reason: "条目不存在，可能已被删除" },
        ],
        success: false,
        code: "SHELF_BATCH_LINK_FAILED",
      }),
    );
    const onClose = vi.fn();
    render(<ShelfBatchLinkDialog open ids={["a"]} onClose={onClose} />);

    await screen.findByText("选择项目…");
    fireEvent.click(screen.getByRole("combobox", { name: "选择要关联的项目" }));
    fireEvent.click(await screen.findByRole("option", { name: "漫剧项目" }));
    fireEvent.click(screen.getByRole("button", { name: /关联 1 项/ }));

    await waitFor(() => expect(lastToast()?.kind).toBe("error"));
    expect(lastToast()?.message).toContain("批量关联失败");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("列表加载失败时禁用提交", async () => {
    api.workspaceProjectList.mockRejectedValue(new Error("db locked"));
    api.listTasks.mockRejectedValue(new Error("db locked"));
    render(<ShelfBatchLinkDialog open ids={["a"]} onClose={() => {}} />);

    expect((await screen.findByRole("alert")).textContent).toContain("列表加载失败");
    const submit = screen.getByRole("button", { name: /关联 1 项/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});
