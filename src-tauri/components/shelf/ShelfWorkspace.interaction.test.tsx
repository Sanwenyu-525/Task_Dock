/**
 * @vitest-environment jsdom
 */
//! 暂存架交互升级：缩略图直开灯箱、Ctrl/Shift 多选、框选、键盘、网格视图、
//! 删除撤销与拖入垃圾桶（外部文件 / Alt 内部拖动）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const api = vi.hoisted(() => ({
  shelfList: vi.fn(),
  shelfGroups: vi.fn(),
  shelfStats: vi.fn(),
  shelfCheckExists: vi.fn(),
  shelfGetItem: vi.fn(),
  shelfReadImage: vi.fn(),
  shelfReadText: vi.fn(async () => ({ content: "正文", truncated: false })),
  shelfTaskLinks: vi.fn(async () => []),
  listTasks: vi.fn(async () => []),
  shelfProjectLinks: vi.fn(async () => []),
  workspaceProjectList: vi.fn(async () => ({ projects: [] })),
  shelfDragOut: vi.fn(),
  shelfSendToStatus: vi.fn(),
  shelfTrashDelete: vi.fn(),
  shelfTrashRestore: vi.fn(),
  shelfRecyclePreview: vi.fn(),
  shelfRecycleExecute: vi.fn(),
  shelfCopyFiles: vi.fn(async () => 1),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  shelfRecentTags: vi.fn(async () => []),
  shelfTagItems: vi.fn(),
  shelfDuplicateScan: vi.fn(),
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
import type { ShelfRecyclePreview } from "../../lib/bridge";

type Consumer = {
  onEnter?: (point: { x: number; y: number } | null) => void;
  onOver?: (point: { x: number; y: number } | null) => void;
  onDrop: (paths: string[], point: { x: number; y: number } | null) => void;
  onLeave?: () => void;
};

function row(id: string, over: Record<string, unknown> = {}) {
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
    group_id: null,
    scene_id: null,
    note: "",
    expire_at: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    ...over,
  };
}

function imageRow(id: string, name: string) {
  return row(id, {
    kind: "image",
    display_name: name,
    file_ext: "png",
    original_path: `D:\\Pics\\${name}`,
    byte_size: 4096,
  });
}

function stats(total: number) {
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

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function preview(): ShelfRecyclePreview {
  return {
    entries: [
      {
        path: "D:\\Temp\\a.txt",
        name: "a.txt",
        is_dir: false,
        byte_size: 12,
        modified_ms: 1000,
        status: "ready",
        reason: null,
      },
    ],
    ready: 1,
    blocked: 0,
    has_dirs: false,
    total_bytes: 12,
  };
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.shelfList.mockResolvedValue({ items: [], total: 0 });
  api.shelfGroups.mockResolvedValue([]);
  api.shelfStats.mockResolvedValue(stats(0));
  api.shelfCheckExists.mockResolvedValue([]);
  api.shelfGetItem.mockImplementation(async (id: string) => row(id));
  api.shelfReadImage.mockResolvedValue("data:image/png;base64,AAAA");
  api.shelfDragOut.mockResolvedValue({ effect: "none", count: 0, missing_ids: [] });
  api.shelfSendToStatus.mockResolvedValue({
    enabled: false,
    exe: "C:/TaskDock/task-dock.exe",
    command: null,
    stale: false,
  });
  api.shelfTrashDelete.mockResolvedValue({
    batch_id: "batch-1",
    removed: 1,
    skipped_protected: 0,
    managed_retained: 0,
  });
  api.shelfTrashRestore.mockResolvedValue({
    batch_id: "batch-1",
    restored: 1,
    conflicts: 0,
    restored_relations: 0,
  });
  api.shelfRecyclePreview.mockResolvedValue(preview());
  api.shelfRecycleExecute.mockResolvedValue({
    deleted: 1,
    skipped: 0,
    failed: 0,
    entries: [
      { path: "D:\\Temp\\a.txt", name: "a.txt", status: "ok", reason: null },
    ],
  });
  api.getSettings.mockResolvedValue({ shelf_auto_cleanup_enabled: false });
  api.updateSettings.mockResolvedValue(undefined);
  api.shelfDuplicateScan.mockResolvedValue({
    scanned: 0,
    hashed: 0,
    groups: [],
    unreadable: [],
    truncated: false,
  });
  api.shelfTagItems.mockResolvedValue({
    tags: [],
    items: 0,
    changed: 0,
    skipped: 0,
    failed: [],
    success: true,
    partial: false,
    code: null,
  });
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
  useUiStore.setState({ toast: null, toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderWith(items: ReturnType<typeof row>[]) {
  api.shelfList.mockResolvedValue({ items, total: items.length });
  api.shelfStats.mockResolvedValue(stats(items.length));
  render(<ShelfWorkspace active />);
  await screen.findByText(items[0].display_name);
}

describe("缩略图与灯箱", () => {
  it("点击图片缩略图直接打开灯箱；点击名称仍打开详情", async () => {
    await renderWith([imageRow("img1", "截图.png"), row("f1")]);

    fireEvent.click(screen.getByRole("button", { name: "预览 截图.png" }));
    const lightbox = await screen.findByRole("dialog", { name: "图片预览：截图.png" });
    expect(lightbox).toBeTruthy();
    fireEvent.click(within(lightbox).getByRole("button", { name: "关闭预览" }));

    fireEvent.click(screen.getByRole("button", { name: "截图.png" }));
    expect(await screen.findByRole("region", { name: "详情：截图.png" })).toBeTruthy();
  });

  it("灯箱按当前顺序左右切换，并显示序号", async () => {
    await renderWith([imageRow("img1", "一.png"), row("f1"), imageRow("img2", "二.png")]);
    fireEvent.click(screen.getByRole("button", { name: "预览 一.png" }));
    const first = await screen.findByRole("dialog", { name: "图片预览：一.png" });
    expect(first.textContent).toContain("1 / 2");

    fireEvent.keyDown(first, { key: "ArrowRight" });
    const second = await screen.findByRole("dialog", { name: "图片预览：二.png" });
    expect(second.textContent).toContain("2 / 2");

    fireEvent.keyDown(second, { key: "ArrowLeft" });
    expect(await screen.findByRole("dialog", { name: "图片预览：一.png" })).toBeTruthy();
  });
});

describe("多选语义", () => {
  it("Ctrl+点击切换单项，Shift+点击从锚点连选", async () => {
    await renderWith([row("a"), row("b"), row("c")]);
    const name = (text: string) => screen.getByRole("button", { name: text });
    const card = (text: string) =>
      screen.getByRole("button", { name: text }).closest("[data-shelf-id]") as HTMLElement;
    const pressed = (text: string) =>
      card(text).querySelector(".shelf-check")?.getAttribute("aria-pressed");

    // 卡片空白区域普通点击 = 单选（名称点击仍打开详情）。
    fireEvent.click(card("条目 a"));
    expect(useShelfStore.getState().selectedIds).toEqual(["a"]);

    fireEvent.click(name("条目 b"), { ctrlKey: true });
    expect(useShelfStore.getState().selectedIds.sort()).toEqual(["a", "b"]);

    // Ctrl 点击同时把锚点移到 b：Shift 点击 c 选择 b..c。
    fireEvent.click(name("条目 c"), { shiftKey: true });
    expect(useShelfStore.getState().selectedIds.sort()).toEqual(["b", "c"]);
    expect(pressed("条目 c")).toBe("true");
  });

  it("Ctrl+A 全选，Esc 清空选择", async () => {
    await renderWith([row("a"), row("b")]);
    const list = screen.getByRole("list", { name: "暂存条目" });
    fireEvent.keyDown(list, { key: "a", ctrlKey: true });
    expect(useShelfStore.getState().selectedIds.sort()).toEqual(["a", "b"]);

    fireEvent.keyDown(list, { key: "Escape" });
    expect(useShelfStore.getState().selectedIds).toEqual([]);
  });

  it("Delete 打开确认框，确认后软删除并提供撤销", async () => {
    await renderWith([row("a"), row("b")]);
    const list = screen.getByRole("list", { name: "暂存条目" });
    fireEvent.keyDown(list, { key: "a", ctrlKey: true });

    const toast = vi.spyOn(useUiStore.getState(), "showToast");
    fireEvent.keyDown(list, { key: "Delete" });
    const dialog = await screen.findByRole("dialog", { name: "删除 2 个条目？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(api.shelfTrashDelete).toHaveBeenCalledWith(["a", "b"], false));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const call = toast.mock.calls.find((entry) => String(entry[0]).includes("可撤销"));
    expect(call).toBeTruthy();
    const action = (call![1] as { action?: { label: string; run: () => void } }).action;
    expect(action?.label).toBe("撤销");

    action!.run();
    await waitFor(() => expect(api.shelfTrashRestore).toHaveBeenCalledWith("batch-1"));
  });
});

describe("框选", () => {
  it("从空白处拖出矩形，实时选中相交条目并在松手后提交", async () => {
    await renderWith([row("a"), row("b"), row("c")]);
    const list = screen.getByRole("list", { name: "暂存条目" });
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 0, 500, 300));
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-shelf-id]"));
    expect(cards).toHaveLength(3);
    cards.forEach((card, index) => {
      vi.spyOn(card, "getBoundingClientRect").mockReturnValue(
        rect(10, 10 + index * 50, 400, 44),
      );
    });

    fireEvent.pointerDown(list, { button: 0, clientX: 5, clientY: 5, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 300, clientY: 75, pointerId: 1 });
    await waitFor(() => expect(document.querySelector(".shelf-marquee")).toBeTruthy());
    // 预览态不写 store，只在卡片上显示。
    expect(useShelfStore.getState().selectedIds).toEqual([]);

    fireEvent.pointerUp(document, { clientX: 300, clientY: 75, pointerId: 1 });
    await waitFor(() =>
      expect(useShelfStore.getState().selectedIds.sort()).toEqual(["a", "b"]),
    );
    expect(document.querySelector(".shelf-marquee")).toBeNull();
    // 框选绝不触发 Windows OLE 拖出。
    expect(api.shelfDragOut).not.toHaveBeenCalled();
  });

  it("框选中按 Esc 取消并保留取消前的选择", async () => {
    await renderWith([row("a"), row("b")]);
    const cardA = document.querySelector<HTMLElement>('[data-shelf-id="a"]')!;
    fireEvent.click(cardA);
    expect(useShelfStore.getState().selectedIds).toEqual(["a"]);

    const list = screen.getByRole("list", { name: "暂存条目" });
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(rect(0, 0, 500, 300));
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-shelf-id]"));
    cards.forEach((card, index) => {
      vi.spyOn(card, "getBoundingClientRect").mockReturnValue(
        rect(10, 10 + index * 50, 400, 44),
      );
    });

    fireEvent.pointerDown(list, { button: 0, clientX: 5, clientY: 5, pointerId: 2 });
    fireEvent.pointerMove(document, { clientX: 300, clientY: 110, pointerId: 2 });
    await waitFor(() => expect(document.querySelector(".shelf-marquee")).toBeTruthy());

    fireEvent.keyDown(list, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".shelf-marquee")).toBeNull());
    expect(useShelfStore.getState().selectedIds).toEqual(["a"]);
  });
});

describe("视图与垃圾桶", () => {
  it("列表/网格切换保留筛选与选择", async () => {
    await renderWith([row("a"), row("b")]);
    fireEvent.click(screen.getByRole("button", { name: "选择 条目 a" }));
    fireEvent.click(screen.getByRole("button", { name: "切换到网格视图" }));

    const list = screen.getByRole("list", { name: "暂存条目" });
    expect(list.className).toContain("shelf-list--grid");
    expect(useShelfStore.getState().selectedIds).toEqual(["a"]);
    expect(screen.getByRole("button", { name: "调整缩略图尺寸" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "切换到列表视图" }));
    expect(screen.getByRole("list", { name: "暂存条目" }).className).toContain(
      "shelf-list--list",
    );
    expect(useShelfStore.getState().selectedIds).toEqual(["a"]);
  });

  it("外部文件拖到垃圾桶：先预览，确认后才调用回收站且不暂存", async () => {
    await renderWith([row("a")]);
    await waitFor(() => expect(dropMock.register).toHaveBeenCalled());
    const calls = dropMock.register.mock.calls as unknown as [Consumer][];
    const consumer = calls[calls.length - 1][0];
    const slot = document.querySelector(".shelf-trash-slot") as HTMLElement;
    vi.spyOn(slot, "getBoundingClientRect").mockReturnValue(rect(400, 10, 40, 30));

    consumer.onEnter?.({ x: 410, y: 20 });
    consumer.onOver?.({ x: 410, y: 20 });
    consumer.onDrop(["D:\\Temp\\a.txt"], { x: 410, y: 20 });

    const dialog = await screen.findByRole("dialog", { name: "确认移到回收站" });
    expect(dialog.textContent).toContain("a.txt");
    expect(api.shelfList).toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: /移到回收站（1 项）/ }));
    await waitFor(() =>
      expect(api.shelfRecycleExecute).toHaveBeenCalledWith(
        ["D:\\Temp\\a.txt"],
        [
          {
            path: "D:\\Temp\\a.txt",
            is_dir: false,
            byte_size: 12,
            modified_ms: 1000,
          },
        ],
      ),
    );
  });

  it("Alt+拖动条目到垃圾桶时打开移除确认，不触发原生拖出", async () => {
    await renderWith([row("a")]);
    const card = document.querySelector<HTMLElement>('[data-shelf-id="a"]')!;
    const slot = document.querySelector(".shelf-trash-slot") as HTMLElement;
    vi.spyOn(slot, "getBoundingClientRect").mockReturnValue(rect(400, 10, 40, 30));

    fireEvent.pointerDown(card, {
      button: 0,
      altKey: true,
      clientX: 20,
      clientY: 20,
      pointerId: 9,
    });
    fireEvent.pointerMove(document, { clientX: 410, clientY: 20, pointerId: 9 });
    fireEvent.pointerUp(document, { clientX: 410, clientY: 20, pointerId: 9 });

    expect(await screen.findByRole("dialog", { name: "删除 1 个条目？" })).toBeTruthy();
    expect(api.shelfDragOut).not.toHaveBeenCalled();
  });
});

// ── 右键菜单与键盘扩展选择（2026-11-14 补充）──

describe("右键菜单与键盘", () => {
  it("已选集合上右键，菜单作用于整个选择集", async () => {
    await renderWith([row("a"), row("b"), row("c")]);
    const cardA = document.querySelector<HTMLElement>('[data-shelf-id="a"]')!;
    const cardB = document.querySelector<HTMLElement>('[data-shelf-id="b"]')!;
    fireEvent.click(cardA);
    fireEvent.click(screen.getByRole("button", { name: "条目 b" }), { ctrlKey: true });
    expect(useShelfStore.getState().selectedIds.sort()).toEqual(["a", "b"]);

    fireEvent.contextMenu(cardB, { clientX: 40, clientY: 40 });
    const menu = await screen.findByRole("menu", { name: "条目操作（2 项）" });
    expect(menu.textContent).toContain("删除 2 项");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /删除 2 项/ }));
    expect(await screen.findByRole("dialog", { name: "删除 2 个条目？" })).toBeTruthy();
  });

  it("右键删除单条收藏项：显式确认后可删，不被静默跳过", async () => {
    await renderWith([row("fav", { favorite: true })]);
    fireEvent.contextMenu(document.querySelector<HTMLElement>('[data-shelf-id="fav"]')!, {
      clientX: 30,
      clientY: 30,
    });
    const menu = await screen.findByRole("menu", { name: "条目操作（1 项）" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /删除/ }));
    const dialog = await screen.findByRole("dialog", { name: "删除受保护的条目？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(api.shelfTrashDelete).toHaveBeenCalledWith(["fav"], true),
    );
  });

  it("方向键移动焦点并单选，Shift+方向键扩展选择", async () => {
    await renderWith([row("a"), row("b"), row("c")]);
    const list = screen.getByRole("list", { name: "暂存条目" });
    list.focus();

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(useShelfStore.getState().selectedIds).toEqual(["a"]);
    fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    expect(useShelfStore.getState().selectedIds.sort()).toEqual(["a", "b"]);
    fireEvent.keyDown(list, { key: " " });
    // Space 切换当前焦点（b）的选择。
    expect(useShelfStore.getState().selectedIds).toEqual(["a"]);
  });
});
