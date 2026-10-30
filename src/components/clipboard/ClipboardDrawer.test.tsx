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
  useUiStore.setState({ clipboardOpen: false, tab: "tasks" });
  useSettingsStore.setState({ settings: null });
});

describe("ClipboardDrawer", () => {
  // 只保留列表/分页断言在这一组：80 张卡片在 jsdom 里渲染本身就要秒级，
  // 状态类断言用下面的小样本，避免把 DOM 体积当成功能问题。
  it("分页：80/100 时加载更多只追加一页", async () => {
    const { container } = render(<ClipboardDrawer />);
    // 80 张卡片在 jsdom 中按 role 扫描很慢；这里只验证分页按钮与追加调用。
    const more = container.querySelector<HTMLButtonElement>("button.clip-more");
    expect(more?.textContent).toContain("加载更多（80/100）");
    fireEvent.click(more!);
    await waitFor(() => expect(loadSpy).toHaveBeenCalledWith({ append: true }));
  });

  it("监听中、监听线程未启动与手动暂停显示不同状态", async () => {
    const small = viewWith(4, 4);
    useClipboardStore.setState({ view: small });
    const first = render(<ClipboardDrawer />);
    expect((await screen.findAllByText("监听中")).length).toBeGreaterThan(0);
    first.unmount();

    bridge.clipboardStatus.mockResolvedValue({ ...STATUS_OK, monitoring: false });
    const second = render(<ClipboardDrawer />);
    expect((await screen.findAllByText("监听未启动")).length).toBeGreaterThan(0);
    second.unmount();

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

  it("剪贴板配置损坏时提示已暂停，绝不显示监听中", async () => {
    const message = "剪贴板设置已损坏（clipboard_enabled），已停止自动记录";
    useClipboardStore.setState({ view: viewWith(4, 4) });
    bridge.clipboardStatus.mockResolvedValue({
      ...STATUS_OK,
      enabled: false,
      paused: true,
      configError: {
        kind: "json",
        keys: ["clipboard_enabled"],
        message,
      },
    });
    useUiStore.setState({ tab: "tasks" });
    render(<ClipboardDrawer />);
    expect((await screen.findAllByText("配置异常，自动记录已暂停")).length).toBeGreaterThan(0);
    expect(screen.queryByText("监听中")).toBeNull();
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain(message);
    expect(banner.textContent).toContain("clipboard_enabled");
    expect(banner.textContent).toContain("监听线程仍在运行");
    fireEvent.click(screen.getByRole("button", { name: "去修复" }));
    expect(useUiStore.getState().tab).toBe("settings");
  });

  it("旧版本升级默认暂停并提示用户确认", async () => {
    useClipboardStore.setState({ view: viewWith(2, 2) });
    useSettingsStore.setState({
      settings: { clipboard_enabled: true, clipboard_paused: true } as never,
    });
    bridge.clipboardStatus.mockResolvedValue({
      ...STATUS_OK,
      paused: true,
      configOrigin: "legacy_upgrade_paused",
    });
    render(<ClipboardDrawer />);
    expect(
      (await screen.findAllByText(/从旧版本升级/)).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("监听中")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Tab 在抽屉内循环：末项回到首项、首项回到末项", async () => {
    useClipboardStore.setState({ view: viewWith(2, 2) });
    const { container } = render(<ClipboardDrawer />);
    await screen.findAllByText("监听中");
    const drawer = container.querySelector<HTMLElement>(".clipboard-drawer")!;
    const focusables = drawer.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    expect(focusables.length).toBeGreaterThan(5);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("焦点漏到背景时按 Tab 立即拉回抽屉，蒙层不接收焦点", async () => {
    useClipboardStore.setState({ view: viewWith(2, 2) });
    const { container } = render(<ClipboardDrawer />);
    await screen.findAllByText("监听中");
    const drawer = container.querySelector<HTMLElement>(".clipboard-drawer")!;
    const scrim = container.querySelector<HTMLElement>(".clipboard-scrim")!;
    (drawer.querySelector<HTMLElement>("button") ?? drawer).blur();
    scrim.focus();
    expect(document.activeElement).not.toBe(scrim);

    fireEvent.keyDown(window, { key: "Tab" });
    expect(drawer.contains(document.activeElement)).toBe(true);

    fireEvent.mouseDown(scrim);
    expect(useUiStore.getState().clipboardOpen).toBe(false);
  });

  it("确认框打开时焦点进入弹层，Escape 只关确认框并把焦点还给触发按钮", async () => {
    useClipboardStore.setState({ view: viewWith(2, 2) });
    const { container } = render(<ClipboardDrawer />);
    await screen.findAllByText("监听中");

    const trigger = container.querySelectorAll<HTMLElement>(
      '.clip-actions button[aria-label="删除"]',
    )[0];
    trigger.focus();
    fireEvent.click(trigger);

    // 确认框走统一的 Dialog 基元：有独立可访问名，与抽屉本身区分得开
    const dialog = await screen.findByRole("dialog", { name: "删除这条剪贴板历史？" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    const inDialog = dialog.querySelectorAll<HTMLElement>("button");
    inDialog[inDialog.length - 1].focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(inDialog[0]);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "删除这条剪贴板历史？" })).toBeNull();
    expect(useUiStore.getState().clipboardOpen).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().clipboardOpen).toBe(false);
  });

  // 任务关联流程：从任务编辑器发起 → 抽屉内选择 → 写关联 → 自动回到编辑器
  it("关联模式：条目卡片出现关联按钮，普通模式不出现", async () => {
    useClipboardStore.setState({ view: viewWith(2, 2) });
    const { container, unmount } = render(<ClipboardDrawer />);
    await screen.findAllByText("监听中");
    expect(screen.queryAllByRole("button", { name: "关联" })).toHaveLength(0);
    expect(container.querySelector(".clipboard-layer.link-mode")).toBeNull();
    unmount();

    useUiStore.setState({
      clipboardOpen: true,
      clipboardLinkTask: { id: "t1", title: "写周报" } as never,
    });
    const second = render(<ClipboardDrawer />);
    await screen.findAllByText("监听中");
    expect(screen.getAllByRole("button", { name: "关联" })).toHaveLength(2);
    expect(second.container.querySelector(".clipboard-layer.link-mode")).toBeTruthy();
    expect(screen.getByText(/为任务「写周报」选择要关联的条目或分组/)).toBeTruthy();
  });

  it("关联模式：点击关联后写入后端、提示成功并关闭抽屉", async () => {
    useClipboardStore.setState({ view: viewWith(2, 2) });
    useUiStore.setState({
      clipboardOpen: true,
      clipboardLinkTask: { id: "t1", title: "写周报" } as never,
    });
    render(<ClipboardDrawer />);
    await screen.findAllByText("监听中");

    const before = useUiStore.getState().clipboardLinkVersion;
    fireEvent.click(screen.getAllByRole("button", { name: "关联" })[0]);

    await waitFor(() => expect(bridge.clipboardLinkTask).toHaveBeenCalledWith("t1", "item", "item-0"));
    // 关联写入后抽屉自动关闭，把用户交还给任务编辑器
    await waitFor(() => expect(useUiStore.getState().clipboardOpen).toBe(false));
    expect(useUiStore.getState().clipboardLinkVersion).toBe(before + 1);
    expect(useUiStore.getState().toast?.message).toContain("已关联到任务");
  });

  it("关联模式下 Escape 只关抽屉，不会连带关掉任务编辑器", async () => {
    useClipboardStore.setState({ view: viewWith(2, 2) });
    useUiStore.setState({
      clipboardOpen: true,
      clipboardLinkTask: { id: "t1", title: "写周报" } as never,
      editor: { open: true, task: { id: "t1", title: "写周报" } as never },
    });
    render(<ClipboardDrawer />);
    await screen.findAllByText("监听中");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(useUiStore.getState().clipboardOpen).toBe(false);
    // 任务编辑器保持打开，关联流程可以继续
    expect(useUiStore.getState().editor.open).toBe(true);
  });
});
