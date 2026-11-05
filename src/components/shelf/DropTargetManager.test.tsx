/**
 * @vitest-environment jsdom
 */
//! 完整面板「投递目标」管理：已有目标编辑入口、字段保留、失败不覆盖原配置。
//!
//! 与胶囊共用同一个 store / 后端表，因此这里只验证「编辑器提交了什么」，
//! 不用重复覆盖投递链路（见 `InboxDropPane.test.tsx`）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  shelfDropTargets: vi.fn(),
  shelfDropTargetUpdate: vi.fn(),
  shelfDropTargetDelete: vi.fn(),
  shelfDropTargetMove: vi.fn(),
  shelfDropTargetOpen: vi.fn(),
  shelfDropTargetCreate: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...api };
});

const ui = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../../store/useUiStore", () => ({
  useUiStore: (select: (state: { showToast: unknown }) => unknown) =>
    select({ showToast: ui.showToast }),
}));

const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialog.open }));

import DropTargetManager from "./DropTargetManager";
import { useDropTargetsStore, __resetDropSubmitGuard } from "../../store/useDropTargetsStore";

function target(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    name: "工作资料",
    path: "D:\\Work",
    sort_order: 0,
    show_in_capsule: false,
    op_mode: "copy",
    conflict: "rename",
    available: true,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  ui.showToast.mockReset();
  dialog.open.mockReset();
  __resetDropSubmitGuard();
  useDropTargetsStore.setState({
    targets: [],
    loading: false,
    loaded: false,
    lastProbeAt: null,
    error: null,
    ops: {},
    reports: {},
    reportNames: {},
    lastTargetId: null,
    manageRequest: 0,
  });
});

afterEach(cleanup);

describe("DropTargetManager 编辑已有目标", () => {
  it("点击编辑 → 表单带出当前名称与目录，保存只提交表单字段", async () => {
    api.shelfDropTargets.mockResolvedValue([target({ show_in_capsule: false })]);
    api.shelfDropTargetUpdate.mockResolvedValue(
      target({ name: "工作", show_in_capsule: false }),
    );
    render(<DropTargetManager onClose={() => {}} />);
    await screen.findByText("工作资料");

    fireEvent.click(screen.getByRole("button", { name: "编辑「工作资料」" }));
    const nameInput = screen.getByDisplayValue("工作资料") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "工作" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(api.shelfDropTargetUpdate).toHaveBeenCalledTimes(1));
    const [id, patch] = api.shelfDropTargetUpdate.mock.calls[0];
    expect(id).toBe("t1");
    expect(patch).toEqual({
      name: "工作",
      path: "D:\\Work",
      op_mode: "copy",
      conflict: "rename",
    });
    // 可见性 / 排序不在表单里，不能被顺手改写
    expect(patch).not.toHaveProperty("show_in_capsule");
    expect(patch).not.toHaveProperty("sort_order");
    await waitFor(() => expect(ui.showToast).toHaveBeenCalledWith("已保存", { kind: "success" }));
  });

  it("保存失败（重复目录）→ 保留原配置并留在表单，不写本地状态", async () => {
    api.shelfDropTargets.mockResolvedValue([target()]);
    api.shelfDropTargetUpdate.mockRejectedValue(new Error("该目录已配置为其他投递目标"));
    render(<DropTargetManager onClose={() => {}} />);
    await screen.findByText("工作资料");

    fireEvent.click(screen.getByRole("button", { name: "编辑「工作资料」" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(ui.showToast).toHaveBeenCalledWith("该目录已配置为其他投递目标", { kind: "error" }),
    );
    // 表单仍在编辑态，列表里的名称没有被改写
    expect(screen.getByRole("form", { name: "编辑投递目标" })).toBeTruthy();
    expect(useDropTargetsStore.getState().targets[0].name).toBe("工作资料");
  });

  it("目录选择器选到新目录后随表单一起提交", async () => {
    api.shelfDropTargets.mockResolvedValue([target()]);
    api.shelfDropTargetUpdate.mockResolvedValue(target({ path: "E:\\Archive" }));
    dialog.open.mockResolvedValue("E:\\Archive");
    render(<DropTargetManager onClose={() => {}} />);
    await screen.findByText("工作资料");

    fireEvent.click(screen.getByRole("button", { name: "编辑「工作资料」" }));
    fireEvent.click(screen.getByRole("button", { name: /D:\\Work/ }));
    await waitFor(() => expect(dialog.open).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(api.shelfDropTargetUpdate).toHaveBeenCalledTimes(1));
    expect(api.shelfDropTargetUpdate.mock.calls[0][1].path).toBe("E:\\Archive");
    await waitFor(() =>
      expect(useDropTargetsStore.getState().targets[0].path).toBe("E:\\Archive"),
    );
  });
});

describe("DropTargetManager 列表", () => {
  it("不可用目录标注且不隐藏（仍可编辑/移除）", async () => {
    api.shelfDropTargets.mockResolvedValue([target({ available: false })]);
    render(<DropTargetManager onClose={() => {}} />);
    await screen.findByText("工作资料");
    expect(screen.getByText("不可用")).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑「工作资料」" })).toBeTruthy();
  });
});
