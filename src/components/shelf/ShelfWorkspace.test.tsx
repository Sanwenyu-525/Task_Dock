/**
 * @vitest-environment jsdom
 */
//! 完整面板暂存架：内容视图分离、空态区分与拖放所有权。
//!
//! 这里验证「目标管理视图不再叠加搜索/筛选/空态」「返回后恢复暂存架」
//! 「有未保存表单时返回需确认」以及「目标管理期间不注册文件拖入消费者」。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const api = vi.hoisted(() => ({
  shelfList: vi.fn(),
  shelfGroups: vi.fn(),
  shelfStats: vi.fn(),
  shelfCheckExists: vi.fn(),
  shelfDropTargets: vi.fn(),
  shelfDropTargetCreate: vi.fn(),
  shelfDropTargetUpdate: vi.fn(),
  shelfDropTargetDelete: vi.fn(),
  shelfDropTargetMove: vi.fn(),
  shelfDropTargetOpen: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...api };
});

const dropMock = vi.hoisted(() => ({ register: vi.fn(() => () => {}) }));
vi.mock("../../lib/fileDrop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/fileDrop")>();
  return { ...actual, registerFileDropConsumer: dropMock.register };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

import ShelfWorkspace from "./ShelfWorkspace";
import { useShelfStore } from "../../store/useShelfStore";
import { useDropTargetsStore } from "../../store/useDropTargetsStore";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";

function stats(total = 0) {
  return {
    total,
    file_count: total,
    image_count: 0,
    folder_count: 0,
    link_count: 0,
    text_count: 0,
    managed_bytes: 0,
    disk_bytes: 0,
    quota_mb: 2048,
  };
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.shelfList.mockResolvedValue({ items: [], total: 0 });
  api.shelfGroups.mockResolvedValue([]);
  api.shelfStats.mockResolvedValue(stats(0));
  api.shelfCheckExists.mockResolvedValue([]);
  api.shelfDropTargets.mockResolvedValue([]);
  dropMock.register.mockClear();

  useShelfStore.setState({
    items: [],
    total: 0,
    groups: [],
    stats: stats(0),
    filter: { search: "", kind: "all", group_id: "all", favorite_only: false },
    loading: false,
    error: null,
    recent: [],
    recentLoading: false,
    recentLoaded: false,
    recentError: null,
    selectedIds: [],
    detailId: null,
  });
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
  useEdgeSnapStore.setState({ phase: "free" });
  useGlobalSearchStore.setState({ pendingLocate: null });
});

afterEach(cleanup);

function baseTarget() {
  return {
    id: "t1",
    name: "工作资料",
    path: "D:\\Work",
    sort_order: 0,
    show_in_capsule: true,
    op_mode: "copy",
    conflict: "rename",
    available: true,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  };
}

describe("ShelfWorkspace 内容视图分离", () => {
  it("进入投递目标管理后，暂存架工具栏/筛选/空态不再出现，返回后恢复", async () => {
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    expect(screen.getByText(/把文件、图片拖进窗口/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "投递目标管理" }));
    await screen.findByRole("heading", { name: "投递目标" });
    expect(screen.queryByPlaceholderText("搜索名称 / 内容 / 备注")).toBeNull();
    expect(screen.queryByText(/把文件、图片拖进窗口/)).toBeNull();
    expect(screen.queryByRole("tablist", { name: "类型筛选" })).toBeNull();
    expect(screen.getByRole("button", { name: "返回文件暂存架" })).toBeTruthy();

    // 目标管理期间不注册文件拖入消费者（拖入不归暂存架管）
    expect(dropMock.register).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "返回文件暂存架" }));
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    expect(screen.queryByRole("heading", { name: "投递目标" })).toBeNull();
    // 返回后恢复拖入
    await waitFor(() => expect(dropMock.register).toHaveBeenCalledTimes(2));
  });

  it("有未保存的目标表单时，返回暂存架必须先确认", async () => {
    api.shelfDropTargets.mockResolvedValue([baseTarget()]);
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");

    fireEvent.click(screen.getByRole("button", { name: "投递目标管理" }));
    await screen.findByText("工作资料");
    fireEvent.click(screen.getByRole("button", { name: "编辑「工作资料」" }));

    fireEvent.click(screen.getByRole("button", { name: "返回文件暂存架" }));
    const dialog = await screen.findByRole("dialog", { name: "放弃未保存的目标修改？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("form", { name: "编辑投递目标" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "返回文件暂存架" }));
    const dialog2 = await screen.findByRole("dialog", { name: "放弃未保存的目标修改？" });
    fireEvent.click(within(dialog2).getByRole("button", { name: "放弃并返回" }));
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
  });
  it("定位意图复位全部筛选并打开目标详情（不被类型/分组筛选挡住）", async () => {
    useShelfStore.setState({
      filter: { search: "旧词", kind: "image", group_id: "g-x", favorite_only: true },
    });
    useGlobalSearchStore.setState({
      pendingLocate: {
        category: "shelf",
        id: "s1",
        kind: "file",
        parentId: null,
        keyword: "",
        token: 1,
      },
    });
    render(<ShelfWorkspace active />);
    await waitFor(() =>
      expect(useShelfStore.getState().filter).toEqual({
        search: "",
        kind: "all",
        group_id: "all",
        favorite_only: false,
      }),
    );
    expect(useGlobalSearchStore.getState().pendingLocate).toBeNull();
    expect(useShelfStore.getState().detailId).toBe("s1");
  });
});

describe("ShelfWorkspace 空态", () => {
  it("有暂存条目但当前筛选无结果 → 提示没有匹配并一键清除筛选", async () => {
    useShelfStore.setState({
      stats: stats(5),
      filter: { search: "不存在", kind: "all", group_id: "all", favorite_only: false },
    });
    api.shelfStats.mockResolvedValue(stats(5));
    render(<ShelfWorkspace active />);
    await screen.findByText("没有匹配的文件");
    expect(screen.queryByText(/把文件、图片拖进窗口/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    await waitFor(() => expect(useShelfStore.getState().filter.search).toBe(""));
  });

  it("暂存架真空 → 显示添加文件入口与拖入提示", async () => {
    render(<ShelfWorkspace active />);
    await screen.findByText(/把文件、图片拖进窗口/);
    expect(screen.getByRole("button", { name: "添加文件" })).toBeTruthy();
    expect(screen.queryByText("没有匹配的文件")).toBeNull();
  });

  it("加载失败且无数据 → 错误空态可重试，不伪装成空暂存架", async () => {
    api.shelfList.mockRejectedValue(new Error("db locked"));
    render(<ShelfWorkspace active />);
    await screen.findByText("暂存架读取失败");
    expect(screen.queryByText(/把文件、图片拖进窗口/)).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });
});
