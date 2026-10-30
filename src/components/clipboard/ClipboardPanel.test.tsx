/**
 * @vitest-environment jsdom
 */
//! 剪贴板主页面（完整模式第 4 个导航入口）：加载、筛选、复制。
//!
//! 页面与任务关联抽屉共用 ClipboardWorkspace，这里验证「页面形态」这一路：
//! - 进入页面即按当前筛选拉取历史；
//! - 类型 / 收藏 / 搜索筛选会重新拉取，且参数与界面状态一致；
//! - 复制单条走后端命令并回报结果；
//! - 页面形态没有「关闭」按钮（那是抽屉才有的）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const bridge = vi.hoisted(() => ({
  clipboardView: vi.fn(),
  clipboardStatus: vi.fn(),
  onClipboardChanged: vi.fn(),
  clipboardCopyItem: vi.fn(),
  clipboardCopyGroupRich: vi.fn(),
  clipboardCopyGroupFiles: vi.fn(),
  clipboardCreateGroup: vi.fn(),
  clipboardDeleteGroup: vi.fn(),
  clipboardDeleteItems: vi.fn(),
  clipboardLinkTask: vi.fn(),
  clipboardMergeGroups: vi.fn(),
  clipboardToggleGroup: vi.fn(),
  clipboardToggleItem: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...bridge };
});

import ClipboardPanel from "./ClipboardPanel";
import type { ClipboardItem, ClipboardView } from "../../lib/bridge";
import { useClipboardStore, resetClipboardRequestState } from "../../store/useClipboardStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";

function makeItem(i: number): ClipboardItem {
  return {
    id: `ci${i}`,
    kind: "text",
    text: "",
    html: "",
    preview: `第 ${i} 条剪贴板预览`,
    byte_size: 20,
    source_app: "notepad.exe",
    source_title: "记事本",
    image_width: null,
    image_height: null,
    file_paths: [],
    favorite: false,
    pinned: false,
    copy_count: 1,
    created_at: "2026-10-29T00:00:00Z",
    last_seen_at: "2026-10-29T00:00:00Z",
    has_image: false,
    has_thumb: false,
  };
}

function makeView(count = 3): ClipboardView {
  return {
    items: Array.from({ length: count }, (_, i) => makeItem(i)),
    groups: [],
    stats: {
      items: count,
      groups: 0,
      images: 0,
      files: 0,
      favorites: 0,
      bytes: 60,
      asset_bytes: 0,
      max_items: 5000,
      max_storage_bytes: 0,
      enabled: true,
      paused: false,
      auto_group: true,
    },
    total_items: count,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetClipboardRequestState();
  bridge.clipboardView.mockResolvedValue(makeView());
  bridge.clipboardStatus.mockResolvedValue({
    enabled: true,
    paused: false,
    monitoring: true,
    activeJob: null,
    platform: "windows",
  });
  bridge.onClipboardChanged.mockResolvedValue(() => {});
  bridge.clipboardCopyItem.mockResolvedValue({
    mode: "text",
    bytes: 20,
    warnings: [],
    sequence: 1,
    item_count: 1,
  });
  useClipboardStore.setState({
    view: null,
    filters: { kind: "all", search: "", favorite: false },
    section: "items",
    searchText: "",
    loading: false,
    loadingMore: false,
    error: null,
    selectedItems: [],
    selectedGroups: [],
  });
  useSettingsStore.setState({ settings: { clipboard_enabled: true, clipboard_paused: false } as never });
  useUiStore.setState({ tab: "clipboard", clipboardOpen: false, clipboardLinkTask: null, toast: null });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ tab: "tasks", clipboardOpen: false, toast: null });
  useSettingsStore.setState({ settings: null });
});

describe("剪贴板主页面", () => {
  it("进入页面即拉取历史，并渲染条目与统计", async () => {
    render(<ClipboardPanel />);

    await waitFor(() => expect(bridge.clipboardView).toHaveBeenCalled());
    expect(bridge.clipboardView).toHaveBeenCalledWith({
      kind: "all",
      search: undefined,
      favorite: false,
      limit: 80,
      offset: 0,
    });
    expect(await screen.findByText("第 0 条剪贴板预览")).toBeTruthy();
    expect(screen.getByText("第 2 条剪贴板预览")).toBeTruthy();
  });

  it("类型筛选会带着新的 kind 重新拉取", async () => {
    const user = userEvent.setup();
    render(<ClipboardPanel />);
    await waitFor(() => expect(bridge.clipboardView).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "图片" }));

    await waitFor(() =>
      expect(bridge.clipboardView).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "image" }),
      ),
    );
    expect(useClipboardStore.getState().filters.kind).toBe("image");
  });

  it("只看收藏会以 favorite=true 重新拉取", async () => {
    const user = userEvent.setup();
    render(<ClipboardPanel />);
    await waitFor(() => expect(bridge.clipboardView).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "只看收藏" }));

    await waitFor(() =>
      expect(bridge.clipboardView).toHaveBeenLastCalledWith(
        expect.objectContaining({ favorite: true }),
      ),
    );
  });

  it("搜索输入防抖后按关键词重新拉取", async () => {
    const user = userEvent.setup();
    render(<ClipboardPanel />);
    await waitFor(() => expect(bridge.clipboardView).toHaveBeenCalled());

    await user.type(screen.getByLabelText("搜索剪贴板历史"), "周报");

    await waitFor(
      () => expect(bridge.clipboardView).toHaveBeenLastCalledWith(expect.objectContaining({ search: "周报" })),
      { timeout: 2000 },
    );
  });

  it("复制单条：调用后端命令并回报结果", async () => {
    const user = userEvent.setup();
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");

    await user.click(screen.getAllByRole("button", { name: "复制" })[0]);

    await waitFor(() => expect(bridge.clipboardCopyItem).toHaveBeenCalledWith("ci0"));
    await waitFor(() => expect(useUiStore.getState().toast?.message).toContain("已复制 1 项"));
    expect(useUiStore.getState().toast?.kind).toBe("success");
  });

  it("复制失败时给出错误提示，不静默吞掉", async () => {
    const user = userEvent.setup();
    bridge.clipboardCopyItem.mockRejectedValueOnce(new Error("剪贴板不可用"));
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");

    await user.click(screen.getAllByRole("button", { name: "复制" })[0]);

    await waitFor(() => expect(useUiStore.getState().toast?.kind).toBe("error"));
    expect(useUiStore.getState().toast?.message).toContain("复制失败");
  });

  it("页面形态没有关闭按钮（那是抽屉才有的）", async () => {
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");
    expect(screen.queryByRole("button", { name: "关闭剪贴板" })).toBeNull();
  });

  it("切到分组页签展示分组视图", async () => {
    const user = userEvent.setup();
    bridge.clipboardView.mockResolvedValue({
      ...makeView(),
      groups: [
        {
          id: "cg1",
          name: "调试截图",
          kind: "image",
          item_count: 3,
          created_at: "2026-10-29T00:00:00Z",
          updated_at: "2026-10-29T00:00:00Z",
          closed: false,
          preview: "",
        },
      ] as never,
    });
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");

    await user.click(screen.getByRole("tab", { name: /分组/ }));

    expect(await screen.findByText("调试截图")).toBeTruthy();
  });

  it("加载失败时显示错误并可重试", async () => {
    bridge.clipboardView.mockRejectedValueOnce(new Error("数据库暂时不可用"));
    render(<ClipboardPanel />);

    expect(await screen.findByText(/数据库暂时不可用/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(bridge.clipboardView).toHaveBeenCalledTimes(2));
  });
});
