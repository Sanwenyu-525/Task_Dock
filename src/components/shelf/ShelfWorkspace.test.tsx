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
  shelfDelete: vi.fn(),
  shelfClear: vi.fn(),
  shelfCleanup: vi.fn(),
  shelfCheckExists: vi.fn(),
  shelfGetItem: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
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
  shelfDragOut: vi.fn(),
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

/** 头部图标已收进「⋯」菜单：先开菜单再点目标项。 */
async function openShelfMenu(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "更多暂存架操作" }));
  const item = await screen.findByRole("menuitem", { name });
  fireEvent.click(item);
  return item;
}

async function openCleanupFromMenu() {
  await openShelfMenu("空间与清理");
  return screen.findByRole("dialog", { name: "空间占用与清理设置" });
}

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
  api.shelfDelete.mockResolvedValue({ deleted: 0, skipped: 0, freed_bytes: 0, failed_files: 0 });
  api.shelfClear.mockResolvedValue({ deleted: 0, skipped: 0, freed_bytes: 0, failed_files: 0 });
  api.shelfCleanup.mockImplementation(async (dryRun: boolean) => ({
    dry_run: dryRun,
    candidates: 2,
    skipped_protected: 1,
    temporary_files_skipped: 0,
    freed_bytes: 2048,
    failed_files: 0,
    orphan_files_removed: 0,
  }));
  api.shelfCheckExists.mockResolvedValue([]);
  api.shelfDragOut.mockResolvedValue({ effect: "none", count: 0, missing_ids: [] });
  api.getSettings.mockResolvedValue({ shelf_auto_cleanup_enabled: false, shelf_retention_days: 30 });
  api.updateSettings.mockResolvedValue(undefined);
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
    mutationSyncError: null,
    deletionBusy: false,
    cleanupBusy: false,
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
  it("提供文件暂存架对应的上下文教程入口", async () => {
    render(<ShelfWorkspace active={false} />);

    fireEvent.click(screen.getByRole("button", { name: "更多暂存架操作" }));
    expect(screen.getByRole("menuitem", { name: "查看帮助" })).toBeTruthy();
  });

  it("清空提示按后端报告显示保留内容，并刷新为权威列表", async () => {
    const rows = [
      shelfRow("ordinary"),
      shelfRow("favorite", { favorite: true }),
      shelfRow("pinned", { pinned: true }),
      shelfRow("both", { favorite: true, pinned: true }),
    ];
    api.shelfList.mockResolvedValue({ items: rows, total: rows.length });
    api.shelfStats.mockResolvedValue(stats(rows.length));
    const toast = vi.spyOn(useUiStore.getState(), "showToast");
    render(<ShelfWorkspace active />);
    await screen.findByText("条目 ordinary");

    const remaining = rows.filter((item) => item.id !== "ordinary");
    api.shelfClear.mockResolvedValueOnce({
      deleted: 1,
      skipped: 3,
      freed_bytes: 0,
      failed_files: 0,
    });
    api.shelfList.mockResolvedValue({ items: remaining, total: remaining.length });
    api.shelfStats.mockResolvedValue(stats(remaining.length));

    await openShelfMenu("清空暂存架");
    const dialog = await screen.findByRole("dialog", { name: "清空暂存架？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "清空" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      "已清理 1 项，保留 3 项收藏/置顶/场景引用条目",
      expect.objectContaining({ kind: "warning" }),
    ));
    expect(api.shelfClear).toHaveBeenCalledWith(false);
    expect(screen.queryByText("条目 ordinary")).toBeNull();
    expect(screen.getByText("条目 favorite")).toBeTruthy();
    expect(screen.getByText("条目 pinned")).toBeTruthy();
    expect(screen.getByText("条目 both")).toBeTruthy();
    expect(useShelfStore.getState().stats?.total).toBe(3);
  });

  it("详情删除受保护条目前明确说明收藏与置顶会一并删除", async () => {
    const item = shelfRow("protected", { favorite: true, pinned: true });
    api.shelfList.mockResolvedValue({ items: [item], total: 1 });
    api.shelfStats.mockResolvedValue(stats(1));
    render(<ShelfWorkspace active />);
    fireEvent.click(await screen.findByRole("button", { name: "条目 protected" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除条目" }));

    const dialog = await screen.findByRole("dialog", { name: "删除暂存条目？" });
    expect(within(dialog).getByText(/该条目已收藏且置顶，确认后会一并删除/)).toBeTruthy();
  });

  it("场景引用的条目删除前明确说明场景会失去文件引用", async () => {
    const item = shelfRow("linked", { scene_id: "scene-1" });
    api.shelfList.mockResolvedValue({ items: [item], total: 1 });
    api.shelfStats.mockResolvedValue(stats(1));
    render(<ShelfWorkspace active />);
    fireEvent.click(await screen.findByRole("button", { name: "条目 linked" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除条目" }));

    const dialog = await screen.findByRole("dialog", { name: "删除暂存条目？" });
    expect(within(dialog).getByText(/该条目已被场景引用，确认后会一并删除/)).toBeTruthy();
    expect(within(dialog).getByText(/删除后对应场景会失去该文件引用/)).toBeTruthy();
  });

  it("进入投递目标管理后，暂存架工具栏/筛选/空态不再出现，返回后恢复", async () => {
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    expect(screen.getByText(/把文件、图片拖进窗口/)).toBeTruthy();

    await openShelfMenu("投递目标管理");
    await screen.findByRole("heading", { name: "投递目标" });
    expect(screen.queryByPlaceholderText("搜索名称 / 内容 / 备注")).toBeNull();
    expect(screen.queryByText(/把文件、图片拖进窗口/)).toBeNull();
    expect(screen.queryByRole("tablist", { name: "类型筛选" })).toBeNull();
    expect(screen.getByRole("button", { name: "返回文件暂存架" })).toBeTruthy();

    // 目标管理期间消费者不重注册：拖入仍由同一消费者按落点路由
    //（命中目标卡片投递、未命中暂存），进出视图不应产生注册抖动。
    expect(dropMock.register).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "返回文件暂存架" }));
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    expect(screen.queryByRole("heading", { name: "投递目标" })).toBeNull();
    // 返回后仍是同一次注册（无注销/重注册抖动）
    expect(dropMock.register).toHaveBeenCalledTimes(1);
  });

  it("有未保存的目标表单时，返回暂存架必须先确认", async () => {
    api.shelfDropTargets.mockResolvedValue([baseTarget()]);
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");

    await openShelfMenu("投递目标管理");
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
    await openShelfMenu("投递目标管理");
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
    await openShelfMenu("投递目标管理");
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
    await openShelfMenu("投递目标管理");
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
    expect(screen.getByRole("button", { name: "重试同步" })).toBeTruthy();
  });
});

describe("ShelfWorkspace 手动过期清理", () => {
  async function openCleanupPanel() {
    return openCleanupFromMenu();
  }

  const cleanupDialog = () => screen.queryByRole("dialog", { name: "清理过期条目？" });

  it("立即清理先自动 dry-run 预览，确认前不执行真实清理", async () => {
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    await openCleanupPanel();

    fireEvent.click(screen.getByRole("button", { name: "立即清理过期" }));

    const dialog = await screen.findByRole("dialog", { name: "清理过期条目？" });
    expect(within(dialog).getByText(/预计清理 2 项，释放约 2\.0 KB/)).toBeTruthy();
    expect(within(dialog).getByText(/1 项因收藏、置顶或场景引用而保留/)).toBeTruthy();
    expect(within(dialog).getByText(/不会删除你的原始文件/)).toBeTruthy();
    expect(within(dialog).getByText(/实际结果以执行后报告为准/)).toBeTruthy();
    expect(api.shelfCleanup).toHaveBeenCalledWith(true, false);
    expect(api.shelfCleanup).not.toHaveBeenCalledWith(false, false);
  });

  it("取消确认绝不触发真实清理", async () => {
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    await openCleanupPanel();
    fireEvent.click(screen.getByRole("button", { name: "立即清理过期" }));
    const dialog = await screen.findByRole("dialog", { name: "清理过期条目？" });

    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(cleanupDialog()).toBeNull();
    expect(api.shelfCleanup).not.toHaveBeenCalledWith(false, false);
  });

  it("Escape 关闭确认框且不执行清理", async () => {
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    await openCleanupPanel();
    fireEvent.click(screen.getByRole("button", { name: "立即清理过期" }));
    await screen.findByRole("dialog", { name: "清理过期条目？" });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await waitFor(() => expect(cleanupDialog()).toBeNull());
    expect(api.shelfCleanup).not.toHaveBeenCalledWith(false, false);
  });

  it("dry-run 失败时不弹确认也不执行真实清理", async () => {
    const toast = vi.spyOn(useUiStore.getState(), "showToast");
    api.shelfCleanup.mockRejectedValueOnce(new Error("db locked"));
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    await openCleanupPanel();

    fireEvent.click(screen.getByRole("button", { name: "立即清理过期" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("清理预览失败：db locked", { kind: "error" }),
    );
    expect(cleanupDialog()).toBeNull();
    expect(api.shelfCleanup).not.toHaveBeenCalledWith(false, false);
  });

  it("候选为 0 时不弹确认、不发真实请求，也不报虚假成功", async () => {
    const toast = vi.spyOn(useUiStore.getState(), "showToast");
    api.shelfCleanup.mockImplementationOnce(async () => ({
      dry_run: true,
      candidates: 0,
      skipped_protected: 0,
      temporary_files_skipped: 0,
      freed_bytes: 0,
      failed_files: 0,
      orphan_files_removed: 0,
    }));
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    await openCleanupPanel();

    fireEvent.click(screen.getByRole("button", { name: "立即清理过期" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("没有需要清理的过期条目。", { kind: "info" }),
    );
    expect(cleanupDialog()).toBeNull();
    expect(api.shelfCleanup).not.toHaveBeenCalledWith(false, false);
  });

  it("确认后恰好执行一次清理，并按报告反馈（含场景引用保留项）", async () => {
    const toast = vi.spyOn(useUiStore.getState(), "showToast");
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    await openCleanupPanel();
    fireEvent.click(screen.getByRole("button", { name: "立即清理过期" }));
    const dialog = await screen.findByRole("dialog", { name: "清理过期条目？" });

    fireEvent.click(within(dialog).getByRole("button", { name: "确认清理" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "已清理 2 项，释放约 2.0 KB；1 项因收藏、置顶或场景引用而保留。",
        { kind: "warning" },
      ),
    );
    expect(
      api.shelfCleanup.mock.calls.filter(([dryRun]) => dryRun === false),
    ).toHaveLength(1);
    expect(cleanupDialog()).toBeNull();
    expect(screen.queryByRole("dialog", { name: "空间占用与清理设置" })).toBeNull();
  });

  it("托管文件部分失败时警告而非纯成功，并保留清理面板", async () => {
    const toast = vi.spyOn(useUiStore.getState(), "showToast");
    api.shelfCleanup.mockImplementation(async (dryRun: boolean) =>
      dryRun
        ? {
            dry_run: true,
            candidates: 2,
            skipped_protected: 0,
            temporary_files_skipped: 0,
            freed_bytes: 2048,
            failed_files: 0,
            orphan_files_removed: 0,
          }
        : {
            dry_run: false,
            candidates: 2,
            skipped_protected: 0,
            temporary_files_skipped: 0,
            freed_bytes: 2048,
            failed_files: 3,
            orphan_files_removed: 0,
          },
    );
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    await openCleanupPanel();
    fireEvent.click(screen.getByRole("button", { name: "立即清理过期" }));
    const dialog = await screen.findByRole("dialog", { name: "清理过期条目？" });

    fireEvent.click(within(dialog).getByRole("button", { name: "确认清理" }));

    await waitFor(() => {
      const last = toast.mock.calls.at(-1);
      expect(last?.[0]).toContain("部分托管文件清理失败（3 个）");
      expect(last?.[1]).toMatchObject({ kind: "warning" });
    });
    expect(screen.getByRole("dialog", { name: "空间占用与清理设置" })).toBeTruthy();
  });

  it("清理成功后列表、统计与最近暂存同步，筛选与滚动位置保留", async () => {
    const rows = [shelfRow("a"), shelfRow("b")];
    api.shelfList.mockResolvedValue({ items: rows, total: 2 });
    api.shelfStats.mockResolvedValue(stats(2));
    useShelfStore.setState({
      filter: { search: "", kind: "file", group_id: "all", favorite_only: false },
    });
    render(<ShelfWorkspace active />);
    const list = await screen.findByRole("list", { name: "暂存条目" });
    expect(screen.getByText("条目 a")).toBeTruthy();
    // 挂载时的滚动恢复 effect 走 requestAnimationFrame；先让它执行完再记位置。
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    list.scrollTop = 240;

    await openCleanupPanel();
    fireEvent.click(screen.getByRole("button", { name: "立即清理过期" }));
    const dialog = await screen.findByRole("dialog", { name: "清理过期条目？" });

    api.shelfList.mockResolvedValue({ items: [rows[1]], total: 1 });
    api.shelfStats.mockResolvedValue(stats(1));
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清理" }));

    await waitFor(() => expect(screen.queryByText("条目 a")).toBeNull());
    const state = useShelfStore.getState();
    expect(state.items.map((item) => item.id)).toEqual(["b"]);
    expect(state.stats?.total).toBe(1);
    expect(state.recent.map((item) => item.id)).toEqual(["b"]);
    expect(state.filter.kind).toBe("file");
    expect(list.scrollTop).toBe(240);
  });

  it("后端清理成功但同步失败时提示重试同步，重试不重复清理", async () => {
    const toast = vi.spyOn(useUiStore.getState(), "showToast");
    const rows = [shelfRow("a"), shelfRow("b")];
    api.shelfList.mockResolvedValue({ items: rows, total: 2 });
    api.shelfStats.mockResolvedValue(stats(2));
    render(<ShelfWorkspace active />);
    await screen.findByText("条目 a");

    await openCleanupPanel();
    fireEvent.click(screen.getByRole("button", { name: "立即清理过期" }));
    const dialog = await screen.findByRole("dialog", { name: "清理过期条目？" });

    // 清理写入成功，但随后的权威列表刷新失败一次。
    api.shelfList.mockRejectedValueOnce(new Error("列表不可用"));
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清理" }));

    await waitFor(() => {
      const last = toast.mock.calls.at(-1);
      expect(last?.[0]).toContain("清理操作已经执行，但列表状态尚未同步");
      expect(last?.[1]).toMatchObject({
        kind: "warning",
        action: { label: "重试同步" },
      });
    });
    const retry = toast.mock.calls.at(-1)?.[1]?.action;
    expect(retry?.label).toBe("重试同步");
    const cleanupCalls = api.shelfCleanup.mock.calls.filter(([dryRun]) => dryRun === false).length;

    retry?.run();
    await waitFor(() => expect(useShelfStore.getState().mutationSyncError).toBeNull());
    expect(
      api.shelfCleanup.mock.calls.filter(([dryRun]) => dryRun === false),
    ).toHaveLength(cleanupCalls);
  });

  it("在途重复点击立即清理只发一次 dry-run", async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise((resolve) => (release = resolve));
    api.shelfCleanup.mockReturnValueOnce(gate);
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    await openCleanupPanel();

    const button = screen.getByRole("button", { name: "立即清理过期" });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(api.shelfCleanup).toHaveBeenCalledTimes(1));
    // 预览在途：按钮进入 disabled，不能靠连点再发请求。
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    release({
      dry_run: true,
      candidates: 2,
      skipped_protected: 0,
      temporary_files_skipped: 0,
      freed_bytes: 2048,
      failed_files: 0,
      orphan_files_removed: 0,
    });
    await screen.findByRole("dialog", { name: "清理过期条目？" });
    expect(api.shelfCleanup).toHaveBeenCalledTimes(1);
  });

  it("关闭面板后迟到的 dry-run 结果不会弹确认框", async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise((resolve) => (release = resolve));
    api.shelfCleanup.mockReturnValueOnce(gate);
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    await openCleanupPanel();
    fireEvent.click(screen.getByRole("button", { name: "立即清理过期" }));
    await waitFor(() => expect(api.shelfCleanup).toHaveBeenCalledTimes(1));

    await openShelfMenu("空间与清理");
    release({
      dry_run: true,
      candidates: 2,
      skipped_protected: 0,
      temporary_files_skipped: 0,
      freed_bytes: 2048,
      failed_files: 0,
      orphan_files_removed: 0,
    });
    await act(async () => {});

    expect(cleanupDialog()).toBeNull();
    expect(api.shelfCleanup).not.toHaveBeenCalledWith(false, false);
  });

  it("组件卸载后迟到的预览失败不会写错误状态或弹 Toast", async () => {
    const toast = vi.spyOn(useUiStore.getState(), "showToast");
    let reject!: (e: unknown) => void;
    const gate = new Promise((_resolve, r) => (reject = r));
    api.shelfCleanup.mockReturnValueOnce(gate);
    const view = render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    await openCleanupPanel();
    fireEvent.click(screen.getByRole("button", { name: "立即清理过期" }));
    await waitFor(() => expect(api.shelfCleanup).toHaveBeenCalledTimes(1));

    view.unmount();
    reject(new Error("组件已卸载"));
    await act(async () => {});

    expect(toast).not.toHaveBeenCalledWith("清理预览失败：组件已卸载", { kind: "error" });
    expect(api.shelfCleanup).not.toHaveBeenCalledWith(false, false);
  });

  it("清理面板与清空确认都明确场景引用条目会被保留", async () => {
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    await openCleanupPanel();
    expect(screen.getByText(/收藏、置顶、场景引用条目不自动清理/)).toBeTruthy();
    expect(screen.getByText(/不会删除你的原始文件/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "预览可清理" }));
    await screen.findByText(/1 项因收藏、置顶或场景引用被跳过/);

    await openShelfMenu("清空暂存架");
    const dialog = await screen.findByRole("dialog", { name: "清空暂存架？" });
    expect(
      within(dialog).getByText(/收藏、置顶与场景引用条目保留/),
    ).toBeTruthy();
  });
});

describe("ShelfWorkspace 工具条与拖出", () => {
  it("筛选浮层设置类型/收藏，并可用摘要移除", async () => {
    const rows = [shelfRow("a"), shelfRow("b", { kind: "image" })];
    api.shelfList.mockResolvedValue({ items: rows, total: rows.length });
    api.shelfStats.mockResolvedValue(stats(rows.length));
    render(<ShelfWorkspace active />);
    await screen.findByText("条目 a");

    fireEvent.click(screen.getByRole("button", { name: "筛选暂存条目" }));
    const dialog = await screen.findByRole("dialog", { name: "筛选暂存条目" });
    const typeGroup = within(dialog).getByRole("group", { name: "类型筛选" });
    fireEvent.click(within(typeGroup).getByRole("button", { name: "图片" }));
    await waitFor(() => expect(useShelfStore.getState().filter.kind).toBe("image"));

    const kindChip = await screen.findByRole("button", {
      name: "移除类型筛选：图片",
    });
    fireEvent.click(within(dialog).getByRole("switch", { name: "只看收藏" }));
    await waitFor(() =>
      expect(useShelfStore.getState().filter.favorite_only).toBe(true),
    );
    expect(
      screen.getByRole("button", { name: "取消只看收藏" }),
    ).toBeTruthy();

    fireEvent.click(kindChip);
    await waitFor(() => expect(useShelfStore.getState().filter.kind).toBe("all"));
    expect(
      screen.queryByRole("button", { name: "移除类型筛选：图片" }),
    ).toBeNull();
  });

  it("批量操作栏收纳为单行，移动/文件操作在菜单中可达", async () => {
    const rows = [shelfRow("a"), shelfRow("b")];
    api.shelfList.mockResolvedValue({ items: rows, total: rows.length });
    api.shelfStats.mockResolvedValue(stats(rows.length));
    render(<ShelfWorkspace active />);
    await screen.findByText("条目 a");

    fireEvent.click(screen.getByRole("button", { name: "选择 条目 a" }));
    const bar = await screen.findByRole("toolbar", { name: "批量操作" });
    expect(within(bar).getByText("已选 1 项")).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "收藏所选" })).toBeTruthy();

    fireEvent.click(within(bar).getByRole("button", { name: "批量文件操作" }));
    expect(await screen.findByRole("menuitem", { name: "复制文件" })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /移动原文件到…/ }),
    ).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /复制到…/ })).toBeTruthy();
  });

  it("拖出 move 后刷新存在性并明确提示原路径可能失效", async () => {
    const rows = [shelfRow("a")];
    api.shelfList.mockResolvedValue({ items: rows, total: rows.length });
    api.shelfStats.mockResolvedValue(stats(rows.length));
    api.shelfDragOut.mockResolvedValue({
      effect: "move",
      count: 1,
      missing_ids: ["a"],
    });
    const toast = vi.spyOn(useUiStore.getState(), "showToast");
    render(<ShelfWorkspace active />);

    const name = await screen.findByRole("button", { name: "条目 a" });
    const card = name.closest(".shelf-item") as HTMLElement;
    expect(card.className).toContain("is-draggable");
    fireEvent.pointerDown(card, {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(document, {
      pointerId: 1,
      buttons: 1,
      clientX: 30,
      clientY: 10,
    });

    await waitFor(() => expect(api.shelfDragOut).toHaveBeenCalledWith(["a"]));
    await waitFor(() => expect(api.shelfCheckExists).toHaveBeenCalledWith(["a"]));
    expect(toast).toHaveBeenCalledWith(
      "文件已移动；暂存条目保留，原路径可能已失效，可重新定位或删除",
      expect.objectContaining({ kind: "warning" }),
    );
  });
});
