/**
 * @vitest-environment jsdom
 */
//! 完整面板暂存架：内容视图分离、空态区分与拖放所有权。
//!
//! 这里验证「目标管理视图不再叠加搜索/筛选/空态」「返回后恢复暂存架」
//! 「有未保存表单时返回需确认」以及「目标管理期间不注册文件拖入消费者」。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within, act } from "@testing-library/react";

const api = vi.hoisted(() => ({
  shelfList: vi.fn(),
  shelfGroups: vi.fn(),
  shelfStats: vi.fn(),
  shelfCheckExists: vi.fn(),
  shelfGetItem: vi.fn(),
  shelfDropTargets: vi.fn(),
  shelfDropTargetCreate: vi.fn(),
  shelfDropTargetUpdate: vi.fn(),
  shelfDropTargetDelete: vi.fn(),
  shelfDropTargetMove: vi.fn(),
  shelfDropTargetOpen: vi.fn(),
  // 详情组件会读取任务关联/文本预览；测试里给空结果，避免真实 invoke。
  listTasks: vi.fn(async () => []),
  shelfTaskLinks: vi.fn(async () => []),
  shelfTaskLink: vi.fn(async () => undefined),
  shelfUnlinkTask: vi.fn(async () => undefined),
  shelfReadText: vi.fn(async () => ({ content: "正文", truncated: false })),
  shelfReadImage: vi.fn(async () => null),
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
import { useUiStore } from "../../store/useUiStore";

function shelfRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "file",
    display_name: `条目 ${id}`,
    source_kind: "picker",
    storage_mode: "reference",
    original_path: `D:\\Docs\\${id}.zip`,
    managed_path: null,
    content: null,
    byte_size: 1024,
    file_ext: "zip",
    favorite: false,
    pinned: false,
    exists_state: "ok",
    group_id: "shelf-default",
    scene_id: null,
    note: "",
    expire_at: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    ...over,
  };
}

function locate(id: string, token: number) {
  return {
    category: "shelf",
    id,
    kind: "file",
    parentId: null,
    keyword: "",
    token,
  };
}

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
  api.shelfGetItem.mockResolvedValue(shelfRow("s1"));
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
    fireEvent.change(screen.getByDisplayValue("工作资料"), { target: { value: "工作资料改" } });

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

  it("目标管理视图中定位：自动退出视图并打开详情（条目不在当前页也能读）", async () => {
    api.shelfDropTargets.mockResolvedValue([baseTarget()]);
    api.shelfGetItem.mockResolvedValueOnce(shelfRow("s9", { display_name: "目标文件" }));
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    fireEvent.click(screen.getByRole("button", { name: "投递目标管理" }));
    await screen.findByText("工作资料");

    act(() => {
      useGlobalSearchStore.setState({ pendingLocate: locate("s9", 2) });
    });

    await waitFor(() => expect(useShelfStore.getState().detailId).toBe("s9"));
    expect(screen.queryByRole("heading", { name: "投递目标" })).toBeNull();
    expect(screen.getByPlaceholderText("搜索名称 / 内容 / 备注")).toBeTruthy();
    // 不在第一页：单条读取兜底渲染详情
    expect(api.shelfGetItem).toHaveBeenCalledWith("s9");
    await screen.findByRole("region", { name: "详情：目标文件" });
  });

  it("编辑目标时定位：取消保留表单；确认后放弃输入并定位", async () => {
    api.shelfDropTargets.mockResolvedValue([baseTarget()]);
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    fireEvent.click(screen.getByRole("button", { name: "投递目标管理" }));
    await screen.findByText("工作资料");
    fireEvent.click(screen.getByRole("button", { name: "编辑「工作资料」" }));
    await screen.findByRole("form", { name: "编辑投递目标" });
    fireEvent.change(screen.getByDisplayValue("工作资料"), { target: { value: "工作资料改" } });
    // 让 DropTargetManager 的 dirty 上报 effect 先执行
    await act(async () => {});

    act(() => {
      useGlobalSearchStore.setState({ pendingLocate: locate("s1", 3) });
    });
    const dialog = await screen.findByRole("dialog", {
      name: "放弃未保存的目标修改并查看文件？",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("form", { name: "编辑投递目标" })).toBeTruthy();
    expect(useGlobalSearchStore.getState().pendingLocate).toBeNull();
    expect(useShelfStore.getState().detailId).toBeNull();

    act(() => {
      useGlobalSearchStore.setState({ pendingLocate: locate("s1", 4) });
    });
    const dialog2 = await screen.findByRole("dialog", {
      name: "放弃未保存的目标修改并查看文件？",
    });
    fireEvent.click(within(dialog2).getByRole("button", { name: "放弃并定位" }));

    await waitFor(() => expect(useShelfStore.getState().detailId).toBe("s1"));
    expect(screen.queryByRole("heading", { name: "投递目标" })).toBeNull();
    expect(screen.queryByRole("form", { name: "编辑投递目标" })).toBeNull();
  });

  it("只打开表单但未修改：外部定位直接切换，不弹放弃确认", async () => {
    api.shelfDropTargets.mockResolvedValue([baseTarget()]);
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    fireEvent.click(screen.getByRole("button", { name: "投递目标管理" }));
    await screen.findByText("工作资料");
    fireEvent.click(screen.getByRole("button", { name: "编辑「工作资料」" }));
    await screen.findByRole("form", { name: "编辑投递目标" });
    await act(async () => {});

    act(() => {
      useGlobalSearchStore.setState({ pendingLocate: locate("s1", 5) });
    });

    await waitFor(() => expect(useShelfStore.getState().detailId).toBe("s1"));
    expect(
      screen.queryByRole("dialog", { name: "放弃未保存的目标修改并查看文件？" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "投递目标" })).toBeNull();
  });

  it("连续两次定位：只执行最新请求，旧响应不覆盖", async () => {
    let releaseOld!: (v: { items: never[]; total: number }) => void;
    let releaseNew!: (v: { items: never[]; total: number }) => void;
    const oldLoad = new Promise<{ items: never[]; total: number }>((r) => (releaseOld = r));
    const newLoad = new Promise<{ items: never[]; total: number }>((r) => (releaseNew = r));
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    await waitFor(() => expect(api.shelfList).toHaveBeenCalledTimes(1));
    api.shelfList.mockReturnValueOnce(oldLoad).mockReturnValueOnce(newLoad);

    act(() => {
      useGlobalSearchStore.setState({ pendingLocate: locate("old", 10) });
    });
    await waitFor(() => expect(api.shelfList).toHaveBeenCalledTimes(2));
    act(() => {
      useGlobalSearchStore.setState({ pendingLocate: locate("new", 11) });
    });
    await waitFor(() => expect(api.shelfList).toHaveBeenCalledTimes(3));

    releaseNew({ items: [], total: 0 });
    await waitFor(() => expect(useShelfStore.getState().detailId).toBe("new"));
    releaseOld({ items: [], total: 0 });
    await act(async () => {});
    expect(useShelfStore.getState().detailId).toBe("new");
    expect(api.shelfGetItem).not.toHaveBeenCalledWith("old");
  });

  it("目标已删除：明确提示并清除详情，不假装打开", async () => {
    const toast = vi.spyOn(useUiStore.getState(), "showToast");
    api.shelfGetItem.mockRejectedValueOnce(new Error("暂存条目不存在"));
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");

    act(() => {
      useGlobalSearchStore.setState({ pendingLocate: locate("gone", 20) });
    });

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("无法打开暂存条目：暂存条目不存在", { kind: "error" }),
    );
    expect(useShelfStore.getState().detailId).toBeNull();
    expect(screen.queryByRole("region", { name: /详情：/ })).toBeNull();
    toast.mockRestore();
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
