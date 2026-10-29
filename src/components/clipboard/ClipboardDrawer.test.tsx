/**
 * @vitest-environment jsdom
 */
//! 剪贴板抽屉：监听状态、错误重试与长列表分页。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
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
  applyWindowMaterial: vi.fn(),
}));
vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...bridge };
});

import ClipboardDrawer from "./ClipboardDrawer";
import type { ClipboardItem, ClipboardStatus, ClipboardView } from "../../lib/bridge";
import { useClipboardStore } from "../../store/useClipboardStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";

function makeItem(i: number): ClipboardItem {
  return {
    id: `item-${i}`,
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

function viewWith(items: number, total: number): ClipboardView {
  return {
    items: Array.from({ length: items }, (_, i) => makeItem(i)),
    groups: [],
    stats: {
      items: total,
      groups: 0,
      images: 0,
      files: 0,
      favorites: 0,
      bytes: 0,
      asset_bytes: 0,
      max_items: 5000,
      max_storage_bytes: 0,
      enabled: true,
      paused: false,
      auto_group: true,
    },
    total_items: total,
  };
}

const STATUS_OK: ClipboardStatus = {
  enabled: true,
  paused: false,
  monitoring: true,
  activeJob: null,
  platform: "windows",
};

let loadSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  bridge.clipboardStatus.mockResolvedValue(STATUS_OK);
  bridge.onClipboardChanged.mockResolvedValue(() => {});
  loadSpy = vi.fn(async () => {});
  useClipboardStore.setState({
    view: viewWith(80, 100),
    filters: { kind: "all", search: "", favorite: false },
    loading: false,
    loadingMore: false,
    error: null,
    selectedItems: [],
    selectedGroups: [],
    load: loadSpy as never,
  });
  useSettingsStore.setState({
    settings: { clipboard_enabled: true, clipboard_paused: false } as never,
  });
  useUiStore.setState({
    clipboardOpen: true,
    clipboardLinkTask: null,
    toast: null,
  });
});

afterEach(() => {
  cleanup();
  useUiStore.setState({ clipboardOpen: false });
  useSettingsStore.setState({ settings: null });
});

describe("ClipboardDrawer", () => {
  it("显示监听状态与 80/100 分页，加载更多只追加一页", async () => {
    render(<ClipboardDrawer />);
    expect((await screen.findAllByText("监听中")).length).toBeGreaterThan(0);
    const more = screen.getByRole("button", { name: /加载更多（80\/100）/ });
    fireEvent.click(more);
    await waitFor(() => expect(loadSpy).toHaveBeenCalledWith({ append: true }));
  });

  it("监听线程未启动与手动暂停显示不同状态", async () => {
    bridge.clipboardStatus.mockResolvedValue({ ...STATUS_OK, monitoring: false });
    const { unmount } = render(<ClipboardDrawer />);
    expect((await screen.findAllByText("监听未启动")).length).toBeGreaterThan(0);
    unmount();

    useSettingsStore.setState({
      settings: { clipboard_enabled: true, clipboard_paused: true } as never,
    });
    render(<ClipboardDrawer />);
    expect((await screen.findAllByText("已暂停")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "恢复监听" })).toBeTruthy();
  });

  it("读取失败时显示错误并可重试", async () => {
    useClipboardStore.setState({ view: null, error: "数据库暂时不可用" });
    render(<ClipboardDrawer />);
    expect(await screen.findByText("数据库暂时不可用")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(loadSpy).toHaveBeenCalled());
  });
});
