/**
 * @vitest-environment jsdom
 */
//! 完整暂存架拖入端到端：真实 `lib/fileDrop` 仲裁 + 假 Webview 事件源 + 真实 `useShelfStore`。
//!
//! 只 mock 两个边界：
//! - `@tauri-apps/api/webview`：提供可控的 `onDragDropEvent` 事件源；
//! - `lib/bridge`：IPC 边界（后端返回值由用例决定）。
//!
//! 与 `ShelfWorkspace.test.tsx` 的差异：这里不 mock `registerFileDropConsumer`，
//! 断言的是「真实事件链 → 真实 store → 列表出现条目」与真实 IPC 参数，而不是
//! 「注册函数被调用了几次」。

import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  shelfAddPaths: vi.fn(),
  shelfList: vi.fn(),
  shelfGroups: vi.fn(),
  shelfStats: vi.fn(),
  shelfCheckExists: vi.fn(),
  shelfDropTargets: vi.fn(),
  shelfDropToDirectory: vi.fn(),
  shelfDropTargetOpen: vi.fn(),
  shelfReadImage: vi.fn(async () => null),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  listTasks: vi.fn(async () => []),
  shelfTaskLinks: vi.fn(async () => []),
  // 通用拖入（非路径内容）：只传 operationId，内容留在后端暂存区。
  dragPayloadCommitShelf: vi.fn(),
  dragPayloadCommitDirectory: vi.fn(),
  dragPayloadDiscard: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...api };
});

type DragHandler = (event: { payload: Record<string, unknown> }) => void;

const webview = vi.hoisted(() => {
  const listeners = new Set<(event: { payload: Record<string, unknown> }) => void>();
  // 原生桥事件（taskdock://drag-*）：与内置路径通道分开捕获。
  const bridgeListeners = new Map<
    string,
    Set<(event: { payload: Record<string, unknown> }) => void>
  >();
  const onDragDropEvent = vi.fn(
    async (cb: (event: { payload: Record<string, unknown> }) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  );
  return { listeners, bridgeListeners, onDragDropEvent };
});

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: webview.onDragDropEvent,
    listen: (name: string, cb: (event: { payload: Record<string, unknown> }) => void) => {
      const set = webview.bridgeListeners.get(name) ?? new Set();
      set.add(cb);
      webview.bridgeListeners.set(name, set);
      return Promise.resolve(() => {
        webview.bridgeListeners.get(name)?.delete(cb);
      });
    },
  }),
}));

import ShelfWorkspace from "./ShelfWorkspace";
import { __resetFileDrop, fileDropListening } from "../../lib/fileDrop";
import { useShelfStore } from "../../store/useShelfStore";
import { useDropTargetsStore, __resetDropSubmitGuard } from "../../store/useDropTargetsStore";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import type { ShelfAddReport, ShelfItem } from "../../lib/bridge";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
let serverItems: ShelfItem[] = [];
let nextId = 1;
/** 每个用例可替换的后端返回值；null 时按「全部成功」处理。 */
let addOutcome:
  | ((paths: string[], mode: "reference" | "managed") => ShelfAddReport)
  | null = null;

function itemFor(path: string, mode: "reference" | "managed" = "reference"): ShelfItem {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
  const kind = ext === null ? "folder" : IMAGE_EXTS.has(ext) ? "image" : "file";
  const seq = nextId++;
  const created = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  return {
    id: `drop-${seq}`,
    kind,
    display_name: name,
    source_kind: "drag",
    storage_mode: mode,
    original_path: path,
    managed_path: mode === "managed" ? `C:\\TaskDock\\shelf\\${name}` : null,
    content: null,
    byte_size: 1024,
    file_ext: ext,
    favorite: false,
    pinned: false,
    exists_state: "ok",
    group_id: "shelf-default",
    scene_id: null,
    note: "",
    expire_at: null,
    created_at: created,
    updated_at: created,
  };
}

function defaultOutcome(paths: string[], mode: "reference" | "managed"): ShelfAddReport {
  return { added: paths.map((path) => itemFor(path, mode)), failed: [] };
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

function emit(payload: Record<string, unknown>) {
  for (const handler of [...webview.listeners]) handler({ payload });
}

const BRIDGE_PROBE = "taskdock://drag-probe";
const BRIDGE_ACCEPTED = "taskdock://drag-accepted";
const BRIDGE_PAYLOAD = "taskdock://drag-payload";

/** 触发一次原生桥事件（模拟 Rust `taskdock://drag-*` 的 emit）。 */
function emitBridge(name: string, payload: Record<string, unknown>) {
  for (const handler of [...(webview.bridgeListeners.get(name) ?? [])]) {
    handler({ payload });
  }
}

/** 一次完整会话：enter → over → drop。position 省略即模拟「系统未给出坐标」。 */
function emitSession(
  paths: string[],
  position?: { x: number; y: number },
  overrides: { skipOver?: boolean } = {},
) {
  emit({ type: "enter", paths, ...(position ? { position } : {}) });
  if (!overrides.skipOver) emit({ type: "over", ...(position ? { position } : {}) });
  emit({ type: "drop", paths, ...(position ? { position } : {}) });
}

function toastMessages(): string[] {
  return useUiStore.getState().toasts.map((t) => t.message);
}

function lastToast() {
  return useUiStore.getState().toasts.at(-1);
}

async function renderShelf() {
  const utils = render(<ShelfWorkspace active />);
  await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
  await waitFor(() => expect(webview.onDragDropEvent).toHaveBeenCalled());
  await waitFor(() => expect(fileDropListening()).toBe(true));
  // 原生桥的三个监听是异步挂载的：等到位后再发事件，避免时序假失败。
  await waitFor(() =>
    expect(webview.bridgeListeners.get(BRIDGE_PROBE)?.size ?? 0).toBeGreaterThan(0),
  );
  return utils;
}

beforeEach(() => {
  __resetFileDrop();
  // 清空 store 模块级的「重复提交」窗口：投递用例间同一目标+同一路径
  // 的 700ms 去重不得跨用例生效。
  __resetDropSubmitGuard();
  webview.listeners.clear();
  webview.bridgeListeners.clear();
  webview.onDragDropEvent.mockClear();
  Object.values(api).forEach((fn) => fn.mockReset());

  serverItems = [];
  nextId = 1;
  addOutcome = null;

  api.shelfList.mockImplementation(async () => ({
    items: [...serverItems],
    total: serverItems.length,
  }));
  api.shelfGroups.mockResolvedValue([]);
  api.shelfStats.mockImplementation(async () => stats(serverItems.length));
  api.shelfCheckExists.mockResolvedValue([]);
  api.shelfDropTargets.mockResolvedValue([]);
  // 通用拖入：默认「链接暂存成功」，个别用例覆盖。
  api.dragPayloadDiscard.mockResolvedValue(true);
  api.dragPayloadCommitShelf.mockResolvedValue({
    operationId: "op-bridge",
    kind: "url",
    added: [itemFor("C:\\shelf-link.txt")],
    failed: [],
    failures: [],
    skipped: 0,
  });
  api.getSettings.mockResolvedValue({
    shelf_auto_cleanup_enabled: false,
    shelf_retention_days: 30,
  });
  api.updateSettings.mockResolvedValue(undefined);
  api.shelfAddPaths.mockImplementation(
    async (paths: string[], mode: "reference" | "managed") => {
      const report = (addOutcome ?? defaultOutcome)(paths, mode);
      if (report.added.length > 0) {
        serverItems = [...report.added, ...serverItems];
      }
      return report;
    },
  );

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
    lastCleanup: null,
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
  useSettingsStore.setState({ settings: null });
  useUiStore.setState({ toast: null, toasts: [] });
});

afterEach(() => {
  cleanup();
  __resetFileDrop();
  webview.listeners.clear();
});

describe("完整暂存架拖入 · 真实事件链", () => {
  it.each([
    {
      label: "单个 PNG",
      paths: ["C:\\tmp\\a.png"],
      names: ["a.png"],
    },
    {
      label: "单个 PDF",
      paths: ["C:\\tmp\\报告.pdf"],
      names: ["报告.pdf"],
    },
    {
      label: "多文件",
      paths: ["C:\\tmp\\a.png", "C:\\tmp\\b.pdf", "D:\\资料\\c.docx"],
      names: ["a.png", "b.pdf", "c.docx"],
    },
    {
      label: "文件夹",
      paths: ["C:\\tmp\\素材 文件夹"],
      names: ["素材 文件夹"],
    },
    {
      label: "中文名",
      paths: ["C:\\tmp\\项目 计划\\需求 文档.pdf"],
      names: ["需求 文档.pdf"],
    },
    {
      label: "含空格路径",
      paths: ["C:\\tmp\\my folder\\a b.png"],
      names: ["a b.png"],
    },
  ])("$label：enter → over → drop 后真实 store 出现条目", async ({ paths, names }) => {
    await renderShelf();

    act(() => emitSession(paths, { x: 100, y: 100 }));

    await waitFor(() => expect(api.shelfAddPaths).toHaveBeenCalledTimes(1));
    expect(api.shelfAddPaths).toHaveBeenCalledWith(paths, "reference", "drag", null);

    for (const name of names) {
      expect(await screen.findByText(name)).toBeTruthy();
    }
    expect(useShelfStore.getState().items.map((i) => i.display_name)).toEqual(
      expect.arrayContaining(names),
    );
    expect(lastToast()).toMatchObject({ kind: "success" });
    expect(lastToast()?.message).toBe(`已暂存 ${names.length} 项`);
  });

  it("拖入高亮：enter/over 出现，drop 后立即清除", async () => {
    const { container } = await renderShelf();

    act(() => emit({ type: "enter", paths: ["C:\\tmp\\a.png"], position: { x: 10, y: 10 } }));
    expect(container.querySelector(".shelf-workspace.drag-over")).toBeTruthy();
    expect(container.querySelector(".shelf-dropzone")).toBeTruthy();

    act(() => emit({ type: "over", position: { x: 12, y: 12 } }));
    expect(container.querySelector(".shelf-workspace.drag-over")).toBeTruthy();

    act(() => emitSession(["C:\\tmp\\a.png"], { x: 12, y: 12 }, { skipOver: true }));
    await waitFor(() => expect(api.shelfAddPaths).toHaveBeenCalledTimes(1));
    expect(container.querySelector(".shelf-workspace.drag-over")).toBeNull();
    expect(container.querySelector(".shelf-dropzone")).toBeNull();
  });

  it("重复 drop：同一会话只执行一次", async () => {
    await renderShelf();

    act(() => {
      emit({ type: "enter", paths: ["C:\\tmp\\a.png"], position: { x: 10, y: 10 } });
      emit({ type: "over", position: { x: 10, y: 10 } });
      emit({ type: "drop", paths: ["C:\\tmp\\a.png"], position: { x: 10, y: 10 } });
      emit({ type: "drop", paths: ["C:\\tmp\\a.png"], position: { x: 10, y: 10 } });
    });

    await waitFor(() => expect(api.shelfAddPaths).toHaveBeenCalledTimes(1));
    expect(api.shelfAddPaths).toHaveBeenCalledTimes(1);
  });

  it("无坐标 drop：仍可执行（完整暂存架不依赖命中测试）", async () => {
    await renderShelf();

    act(() => emitSession(["C:\\tmp\\a.png"]));

    await waitFor(() => expect(api.shelfAddPaths).toHaveBeenCalledTimes(1));
    expect(api.shelfAddPaths).toHaveBeenCalledWith(["C:\\tmp\\a.png"], "reference", "drag", null);
    expect(await screen.findByText("a.png")).toBeTruthy();
  });

  it("enter 后 leave 再 drop：不执行且高亮已清除", async () => {
    const { container } = await renderShelf();

    act(() => emit({ type: "enter", paths: ["C:\\tmp\\a.png"], position: { x: 10, y: 10 } }));
    expect(container.querySelector(".shelf-workspace.drag-over")).toBeTruthy();

    act(() => emit({ type: "leave", position: { x: 10, y: 10 } }));
    expect(container.querySelector(".shelf-workspace.drag-over")).toBeNull();

    act(() => emit({ type: "drop", paths: ["C:\\tmp\\a.png"], position: { x: 10, y: 10 } }));
    expect(api.shelfAddPaths).not.toHaveBeenCalled();
    expect(toastMessages().some((m) => m.includes("已暂存"))).toBe(false);
  });

  it("页面卸载后迟到的 drop：不执行并释放 Webview 订阅", async () => {
    const { unmount } = await renderShelf();
    const staleHandler = [...webview.listeners][0] as DragHandler;
    expect(staleHandler).toBeTruthy();

    unmount();
    expect(webview.listeners.size).toBe(0);

    act(() =>
      staleHandler({
        payload: { type: "drop", paths: ["C:\\tmp\\late.png"], position: { x: 1, y: 1 } },
      }),
    );
    expect(api.shelfAddPaths).not.toHaveBeenCalled();
  });

  it("切到「投递目标管理」后清整页高亮、订阅保留（投递区仍按落点路由）", async () => {
    const { container } = await renderShelf();

    act(() => emit({ type: "enter", paths: ["C:\\tmp\\a.png"], position: { x: 1, y: 1 } }));
    expect(container.querySelector(".shelf-workspace.drag-over")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "更多暂存架操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "投递目标管理" }));

    await waitFor(() => expect(screen.getByText("投递目标")).toBeTruthy());
    // 目标管理视图不再释放消费者：拖入由同一消费者按松手坐标路由（卡片投递/空白暂存）。
    await waitFor(() => expect(webview.listeners.size).toBe(1));
    // 进入视图后整页暂存遮罩立即清除（不掩盖目标卡片）。
    expect(container.querySelector(".shelf-workspace.drag-over")).toBeNull();
    expect(container.querySelector(".shelf-dropzone")).toBeNull();
  });

  it("引用/托管模式切换：传给后端正确的 storageMode", async () => {
    await renderShelf();

    act(() => emitSession(["C:\\tmp\\a.png"], { x: 10, y: 10 }));
    await waitFor(() => expect(api.shelfAddPaths).toHaveBeenCalledTimes(1));
    expect(api.shelfAddPaths.mock.calls[0]).toEqual([
      ["C:\\tmp\\a.png"],
      "reference",
      "drag",
      null,
    ]);

    fireEvent.click(screen.getByRole("button", { name: "更多添加方式" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "保存副本到托管目录" }));

    act(() => emitSession(["C:\\tmp\\b.pdf"], { x: 10, y: 10 }));
    await waitFor(() => expect(api.shelfAddPaths).toHaveBeenCalledTimes(2));
    expect(api.shelfAddPaths.mock.calls[1]).toEqual([
      ["C:\\tmp\\b.pdf"],
      "managed",
      "drag",
      null,
    ]);
    await waitFor(() =>
      expect(
        useShelfStore
          .getState()
          .items.some((i) => i.display_name === "b.pdf" && i.storage_mode === "managed"),
      ).toBe(true),
    );
  });
});

describe("完整暂存架拖入 · 失败与空批次", () => {
  it("部分失败：一条汇总 toast，成功数与首条失败原因都在", async () => {
    addOutcome = (paths, mode) => ({
      added: [itemFor(paths[0], mode)],
      failed: [
        { path: paths[1], reason: "路径不存在" },
        { path: paths[2], reason: "拒绝访问" },
      ],
    });
    await renderShelf();

    act(() =>
      emitSession(
        ["C:\\tmp\\ok.png", "C:\\tmp\\missing.png", "C:\\tmp\\denied.png"],
        { x: 10, y: 10 },
      ),
    );

    await waitFor(() => expect(api.shelfAddPaths).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("ok.png")).toBeTruthy();
    await waitFor(() => expect(useUiStore.getState().toasts).toHaveLength(1));
    expect(lastToast()).toMatchObject({
      kind: "warning",
      message: "已暂存 1 项，2 项失败：missing.png — 路径不存在",
    });
  });

  it("全部失败：不报成功，优先使用后端 code，并汇总失败数量", async () => {
    addOutcome = (paths) => ({
      added: [],
      failed: [
        { path: paths[0], reason: "ENOENT: no such file", code: "not_found" },
        { path: paths[1], reason: "拒绝访问", code: "permission_denied" },
      ],
    });
    await renderShelf();

    act(() => emitSession(["C:\\tmp\\missing.png", "C:\\tmp\\denied.png"], { x: 10, y: 10 }));

    await waitFor(() => expect(api.shelfAddPaths).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(lastToast()?.kind).toBe("error"));
    expect(lastToast()?.message).toBe("无法添加「missing.png」：文件不存在（共 2 项失败）");
    expect(toastMessages().some((m) => m.includes("ENOENT"))).toBe(false);
    expect(toastMessages().some((m) => m.includes("已暂存"))).toBe(false);
    expect(useShelfStore.getState().items).toHaveLength(0);
  });

  it("added=0 且 failed=0：不静默成功，明确提示没有可添加的文件", async () => {
    addOutcome = () => ({ added: [], failed: [] });
    await renderShelf();

    act(() => emitSession(["C:\\tmp\\ghost.png"], { x: 10, y: 10 }));

    await waitFor(() => expect(api.shelfAddPaths).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(lastToast()?.message).toBe("没有可添加的文件"));
    expect(lastToast()?.kind).toBe("warning");
    expect(toastMessages().some((m) => m.includes("已暂存"))).toBe(false);
  });

  it("空白/相对路径：不调用 addPaths，明确失败且不显示「已暂存」", async () => {
    await renderShelf();

    act(() => emitSession(["   ", "relative\\a.png", "a.png"], { x: 10, y: 10 }));

    await waitFor(() => expect(lastToast()?.kind).toBe("error"));
    expect(api.shelfAddPaths).not.toHaveBeenCalled();
    expect(lastToast()?.message).toBe("无法添加「（空路径）」：路径为空（共 3 项失败）");
    expect(toastMessages().some((m) => m.includes("已暂存"))).toBe(false);
  });

  it("部分路径无效：只把有效绝对路径交给后端，无效项并入失败汇总", async () => {
    await renderShelf();

    act(() => emitSession(["C:\\tmp\\ok.png", "relative\\a.png"], { x: 10, y: 10 }));

    await waitFor(() => expect(api.shelfAddPaths).toHaveBeenCalledTimes(1));
    expect(api.shelfAddPaths).toHaveBeenCalledWith(["C:\\tmp\\ok.png"], "reference", "drag", null);
    await waitFor(() =>
      expect(lastToast()?.message).toBe(
        "已暂存 1 项，1 项失败：a.png — 只接受绝对路径",
      ),
    );
  });

  it("空 paths：静默复位高亮，不调用后端也不显示「已暂存」", async () => {
    const { container } = await renderShelf();

    act(() => emit({ type: "enter", paths: [], position: { x: 10, y: 10 } }));
    expect(container.querySelector(".shelf-workspace.drag-over")).toBeTruthy();

    act(() => emit({ type: "drop", paths: [], position: { x: 10, y: 10 } }));
    expect(container.querySelector(".shelf-workspace.drag-over")).toBeNull();
    expect(api.shelfAddPaths).not.toHaveBeenCalled();
    expect(toastMessages()).toHaveLength(0);
  });
});

describe("完整暂存架拖入 · 生命周期门控", () => {
  it("StrictMode 双挂载后只保留一条订阅，拖入仍生效", async () => {
    render(
      <StrictMode>
        <ShelfWorkspace active />
      </StrictMode>,
    );
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");
    await waitFor(() => expect(fileDropListening()).toBe(true));

    expect(webview.onDragDropEvent).toHaveBeenCalledTimes(1);
    expect(webview.listeners.size).toBe(1);

    act(() => emitSession(["C:\\tmp\\a.png"], { x: 10, y: 10 }));
    await waitFor(() => expect(api.shelfAddPaths).toHaveBeenCalledTimes(1));
  });

  it("拖拽会话中切换添加方式不重注册，松手仍按最新模式执行", async () => {
    await renderShelf();
    expect(webview.onDragDropEvent).toHaveBeenCalledTimes(1);

    act(() => {
      emit({ type: "enter", paths: ["C:\\tmp\\a.png"], position: { x: 10, y: 10 } });
      emit({ type: "over", position: { x: 10, y: 10 } });
    });

    fireEvent.click(screen.getByRole("button", { name: "更多添加方式" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "保存副本到托管目录" }));

    // 依赖变化没有重建消费者（重建会清空 owner，当前会话的 drop 会丢失）。
    expect(webview.onDragDropEvent).toHaveBeenCalledTimes(1);
    expect(webview.listeners.size).toBe(1);

    act(() => emit({ type: "drop", paths: ["C:\\tmp\\a.png"], position: { x: 10, y: 10 } }));
    await waitFor(() => expect(api.shelfAddPaths).toHaveBeenCalledTimes(1));
    expect(api.shelfAddPaths.mock.calls[0][1]).toBe("managed");
  });

  it("胶囊模式：隐藏的完整面板不注册拖入消费者", async () => {
    useEdgeSnapStore.setState({ phase: "docked-visible" });
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");

    await act(async () => {
      await Promise.resolve();
    });
    expect(webview.onDragDropEvent).not.toHaveBeenCalled();
    expect(fileDropListening()).toBe(false);
  });

  it("docked-full：完整面板仍可见，继续接收拖入", async () => {
    useEdgeSnapStore.setState({ phase: "docked-full" });
    await renderShelf();

    act(() => emitSession(["C:\\tmp\\a.png"], { x: 10, y: 10 }));
    await waitFor(() => expect(api.shelfAddPaths).toHaveBeenCalledTimes(1));
  });

  it("active=false：不注册拖入消费者", async () => {
    render(<ShelfWorkspace active={false} />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");

    await act(async () => {
      await Promise.resolve();
    });
    expect(webview.onDragDropEvent).not.toHaveBeenCalled();
    expect(fileDropListening()).toBe(false);
  });

  it("active 由 true 变 false：释放消费者，迟到 drop 不执行", async () => {
    const { rerender } = await renderShelf();
    const staleHandler = [...webview.listeners][0] as DragHandler;

    rerender(<ShelfWorkspace active={false} />);
    await waitFor(() => expect(webview.listeners.size).toBe(0));

    act(() =>
      staleHandler({
        payload: { type: "drop", paths: ["C:\\tmp\\late.png"], position: { x: 1, y: 1 } },
      }),
    );
    expect(api.shelfAddPaths).not.toHaveBeenCalled();
  });

  it("极简/紧凑模式隐藏完整面板：不注册拖入消费者", async () => {
    useSettingsStore.setState({ settings: { mode: "compact" } as never });
    render(<ShelfWorkspace active />);
    await screen.findByPlaceholderText("搜索名称 / 内容 / 备注");

    await act(async () => {
      await Promise.resolve();
    });
    expect(webview.onDragDropEvent).not.toHaveBeenCalled();
    expect(fileDropListening()).toBe(false);
  });
});

// ── 完整面板投递区：目标管理视图内的真实文件投递 ──────────────────

function dropTargetFixture(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    name: "工作资料",
    path: "D:\\Work",
    sort_order: 0,
    show_in_capsule: false,
    op_mode: "copy" as const,
    conflict: "rename" as const,
    available: true,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    ...over,
  };
}

function dropReportFixture(over: Record<string, unknown> = {}) {
  return {
    batch_id: "batch-1",
    target_id: "t1",
    target_path: "D:\\Work",
    op: "copy" as const,
    total: 2,
    success: 2,
    skipped: 0,
    failed: 0,
    partial: 0,
    entries: [
      {
        source: "C:\\tmp\\a.png",
        display_name: "a.png",
        target: "D:\\Work\\a.png",
        status: "ok" as const,
        reason: null,
        recovery: null,
        residual_source: null,
        code: null,
        stage: null,
      },
      {
        source: "C:\\tmp\\b.pdf",
        display_name: "b.pdf",
        target: "D:\\Work\\b.pdf",
        status: "ok" as const,
        reason: null,
        recovery: null,
        residual_source: null,
        code: null,
        stage: null,
      },
    ],
    ...over,
  };
}

/** 进入目标管理视图并预置一个目标（loaded + TTL 内，避免挂载时重复探测）。 */
async function renderTargetsView(target = dropTargetFixture()) {
  const utils = await renderShelf();
  useDropTargetsStore.setState({
    targets: [target],
    loaded: true,
    lastProbeAt: Date.now(),
  });
  fireEvent.click(screen.getByRole("button", { name: "更多暂存架操作" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "投递目标管理" }));
  await screen.findByText("工作资料");
  return utils;
}

describe("完整面板投递区 · 拖放路由", () => {
  it("命中目标卡片：松手即真实投递，不进暂存架", async () => {
    const { container } = await renderTargetsView();
    const report = dropReportFixture();
    api.shelfDropToDirectory.mockResolvedValue(report);

    const row = container.querySelector<HTMLElement>('[data-drop-target="t1"]')!;
    expect(row).toBeTruthy();
    const original = document.elementFromPoint;
    document.elementFromPoint = () => row;
    try {
      act(() => {
        emit({ type: "enter", paths: ["C:\\tmp\\a.png", "C:\\tmp\\b.pdf"], position: { x: 40, y: 40 } });
        emit({ type: "over", position: { x: 40, y: 40 } });
      });
      // 命中卡片：卡片高亮 + 提示文案与暂存动作可区分
      expect(container.querySelector('[data-drop-target="t1"].is-over')).toBeTruthy();
      expect(screen.getByText("松开鼠标即投递到「工作资料」")).toBeTruthy();
      expect(container.querySelector(".shelf-dropzone")).toBeNull();

      act(() =>
        emit({
          type: "drop",
          paths: ["C:\\tmp\\a.png", "C:\\tmp\\b.pdf"],
          position: { x: 40, y: 40 },
        }),
      );
    } finally {
      document.elementFromPoint = original;
    }

    await waitFor(() =>
      expect(api.shelfDropToDirectory).toHaveBeenCalledTimes(1),
    );
    expect(api.shelfDropToDirectory).toHaveBeenCalledWith("t1", ["C:\\tmp\\a.png", "C:\\tmp\\b.pdf"], expect.any(String));
    expect(api.shelfAddPaths).not.toHaveBeenCalled();
    // 松手后高亮立即清除
    await waitFor(() =>
      expect(container.querySelector('[data-drop-target="t1"].is-over')).toBeNull(),
    );
    // 成功结果条按目标展示
    expect(await screen.findByText(/最近投递：成功 2 项 · 跳过 0 项 · 失败 0 项/)).toBeTruthy();
  });

  it("未命中卡片（空白处松手）：维持暂存动作，不投递", async () => {
    await renderTargetsView();
    // jsdom 默认 elementFromPoint 返回 null → 未命中任何卡片
    act(() => emitSession(["C:\\tmp\\stage.png"], { x: 300, y: 300 }));

    await waitFor(() => expect(api.shelfAddPaths).toHaveBeenCalledTimes(1));
    expect(api.shelfAddPaths).toHaveBeenCalledWith(["C:\\tmp\\stage.png"], "reference", "drag", null);
    expect(api.shelfDropToDirectory).not.toHaveBeenCalled();
  });

  it("目标管理视图内无坐标 drop：无法命中卡片，退回暂存动作", async () => {
    await renderTargetsView();
    act(() => emitSession(["C:\\tmp\\nostage.png"]));

    await waitFor(() => expect(api.shelfAddPaths).toHaveBeenCalledTimes(1));
    expect(api.shelfAddPaths).toHaveBeenCalledWith(["C:\\tmp\\nostage.png"], "reference", "drag", null);
    expect(api.shelfDropToDirectory).not.toHaveBeenCalled();
  });

  it("投递中的会话只消费一次：重复 drop 不重复投递", async () => {
    await renderTargetsView();
    api.shelfDropToDirectory.mockResolvedValue(dropReportFixture());
    const row = document.querySelector<HTMLElement>('[data-drop-target="t1"]')!;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => row;
    try {
      act(() => {
        emit({ type: "enter", paths: ["C:\\tmp\\a.png"], position: { x: 40, y: 40 } });
        emit({ type: "over", position: { x: 40, y: 40 } });
        emit({ type: "drop", paths: ["C:\\tmp\\a.png"], position: { x: 40, y: 40 } });
        emit({ type: "drop", paths: ["C:\\tmp\\a.png"], position: { x: 40, y: 40 } });
      });
    } finally {
      document.elementFromPoint = original;
    }
    await waitFor(() => expect(api.shelfDropToDirectory).toHaveBeenCalledTimes(1));
  });

  it("拖入高亮跟随落点：卡片之间移动时只高亮当前卡片，leave 清除", async () => {
    const { container } = await renderTargetsView(
      dropTargetFixture({ id: "t1" }),
    );
    useDropTargetsStore.setState({
      targets: [dropTargetFixture({ id: "t1" }), dropTargetFixture({ id: "t2", name: "归档", path: "E:\\Archive" })],
    });
    await screen.findByText("归档");
    const rowOf = (id: string) =>
      container.querySelector<HTMLElement>(`[data-drop-target="${id}"]`)!;
    expect(rowOf("t1")).toBeTruthy();
    expect(rowOf("t2")).toBeTruthy();
    const original = document.elementFromPoint;
    document.elementFromPoint = (x: number) => {
      const el = x === 10 ? rowOf("t1") : x === 20 ? rowOf("t2") : null;
      return el;
    };
    try {
      act(() => {
        emit({ type: "enter", paths: ["C:\\tmp\\a.png"], position: { x: 10, y: 10 } });
        emit({ type: "over", position: { x: 10, y: 10 } });
      });
      expect(rowOf("t1").className).toContain("is-over");
      expect(rowOf("t2").className).not.toContain("is-over");

      act(() => emit({ type: "over", position: { x: 20, y: 10 } }));
      expect(rowOf("t1").className).not.toContain("is-over");
      expect(rowOf("t2").className).toContain("is-over");
      expect(screen.getByText("松开鼠标即投递到「归档」")).toBeTruthy();

      act(() => emit({ type: "over", position: { x: 300, y: 300 } }));
      expect(container.querySelector(".shelf-drop-target-row.is-over")).toBeNull();
      expect(screen.getByText(/把文件拖到目标卡片上投递；空白处松手将暂存到文件暂存架/)).toBeTruthy();

      act(() => emit({ type: "leave", position: { x: 300, y: 300 } }));
      expect(screen.queryByText(/空白处松手将暂存到文件暂存架/)).toBeNull();
    } finally {
      document.elementFromPoint = original;
    }
  });
});

describe("完整面板投递区 · 结果条与失败兜底", () => {
  it("失败结果：逐项原因、恢复建议与残留提示可见，默认展开", async () => {
    await renderTargetsView();
    api.shelfDropToDirectory.mockResolvedValue(
      dropReportFixture({
        total: 2,
        success: 0,
        failed: 1,
        partial: 1,
        entries: [
          {
            source: "C:\\tmp\\locked.docx",
            display_name: "locked.docx",
            target: null,
            status: "failed" as const,
            reason: "文件被其他程序占用",
            recovery: "关闭占用程序后重试",
            residual_source: null,
            code: "io_error",
            stage: "copy",
          },
          {
            source: "C:\\tmp\\big.bin",
            display_name: "big.bin",
            target: "D:\\Work\\big.bin",
            status: "partial" as const,
            reason: "写入中断",
            recovery: null,
            residual_source: "D:\\Work\\big.bin.part",
            code: "io_error",
            stage: "commit",
          },
        ],
      }),
    );

    const row = document.querySelector<HTMLElement>('[data-drop-target="t1"]')!;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => row;
    try {
      act(() =>
        emitSession(["C:\\tmp\\locked.docx", "C:\\tmp\\big.bin"], { x: 40, y: 40 }),
      );
    } finally {
      document.elementFromPoint = original;
    }

    await waitFor(() => expect(api.shelfDropToDirectory).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/成功 0 项 · 跳过 0 项 · 部分完成 1 项 · 失败 1 项/)).toBeTruthy();
    expect(screen.getByText("locked.docx")).toBeTruthy();
    expect(screen.getByText("文件被其他程序占用")).toBeTruthy();
    expect(screen.getByText("关闭占用程序后重试")).toBeTruthy();
    expect(screen.getByText(/可能残留：D:\\Work\\big\.bin\.part/)).toBeTruthy();
    // 失败不冒充成功
    expect(useUiStore.getState().toasts.some((t) => t.kind === "warning")).toBe(true);
  });

  it("「查看诊断」把批次 operation_id 随导航事务下发", async () => {
    await renderTargetsView();
    api.shelfDropToDirectory.mockResolvedValue(
      dropReportFixture({
        success: 0,
        failed: 2,
        partial: 0,
        entries: [
          { source: "C:\\tmp\\a.png", display_name: "a.png", status: "failed" as const, reason: "无权限" },
          { source: "C:\\tmp\\b.pdf", display_name: "b.pdf", status: "failed" as const, reason: "无权限" },
        ],
      }),
    );
    const row = document.querySelector<HTMLElement>('[data-drop-target="t1"]')!;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => row;
    try {
      act(() => emitSession(["C:\\tmp\\a.png"], { x: 40, y: 40 }));
    } finally {
      document.elementFromPoint = original;
    }

    fireEvent.click(await screen.findByRole("button", { name: "查看诊断" }));
    await waitFor(() =>
      expect(useUiStore.getState().diagnosticsOperationRequest).toMatchObject({
        operationId: "batch-1",
      }),
    );
    expect(useUiStore.getState().tab).toBe("diagnostics");
  });

  it("「重试失败项」把非 ok 条目的 source 原样重投并展示新结果", async () => {
    await renderTargetsView();
    api.shelfDropToDirectory
      .mockResolvedValueOnce(
        dropReportFixture({
          total: 3,
          success: 1,
          skipped: 1,
          failed: 1,
          entries: [
            { source: "C:\\tmp\\a.png", display_name: "a.png", status: "ok" as const },
            { source: "C:\\tmp\\dup.png", display_name: "dup.png", status: "skipped" as const, reason: "同名跳过" },
            { source: "C:\\tmp\\denied.pdf", display_name: "denied.pdf", status: "failed" as const, reason: "没有访问权限" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        dropReportFixture({
          batch_id: "batch-2",
          total: 2,
          success: 2,
          skipped: 0,
          failed: 0,
          partial: 0,
          entries: [
            { source: "C:\\tmp\\dup.png", display_name: "dup.png", status: "ok" as const },
            { source: "C:\\tmp\\denied.pdf", display_name: "denied.pdf", status: "ok" as const },
          ],
        }),
      );

    const row = document.querySelector<HTMLElement>('[data-drop-target="t1"]')!;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => row;
    try {
      act(() => emitSession(["C:\\tmp\\a.png", "C:\\tmp\\dup.png", "C:\\tmp\\denied.pdf"], { x: 40, y: 40 }));
    } finally {
      document.elementFromPoint = original;
    }
    await waitFor(() => expect(api.shelfDropToDirectory).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /重试失败项（2）/ }));
    await waitFor(() => expect(api.shelfDropToDirectory).toHaveBeenCalledTimes(2));
    // skipped + failed 的 source 都收集重投，成功项不重复投递
    expect(api.shelfDropToDirectory).toHaveBeenLastCalledWith(
      "t1",
      ["C:\\tmp\\dup.png", "C:\\tmp\\denied.pdf"],
      expect.any(String),
    );
    await waitFor(() =>
      expect(screen.getByText(/最近投递：成功 2 项 · 跳过 0 项 · 失败 0 项/)).toBeTruthy(),
    );
    expect(useUiStore.getState().toasts.some((t) => t.message.includes("重试完成"))).toBe(true);
  });

  it("不可用目录：投递前强制重探，仍不可用则明确拒绝，不投递也不暂存", async () => {
    await renderTargetsView(dropTargetFixture({ available: false }));
    api.shelfDropTargets.mockResolvedValue([dropTargetFixture({ available: false })]);
    const row = document.querySelector<HTMLElement>('[data-drop-target="t1"]')!;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => row;
    try {
      act(() => emitSession(["C:\\tmp\\a.png"], { x: 40, y: 40 }));
    } finally {
      document.elementFromPoint = original;
    }

    await waitFor(() => expect(api.shelfDropTargets).toHaveBeenCalledTimes(1));
    // 强制重探发生在投递前
    await waitFor(() =>
      expect(
        useUiStore.getState().toasts.some((t) => t.message.includes("目录不可用，未执行投递")),
      ).toBe(true),
    );
    expect(api.shelfDropToDirectory).not.toHaveBeenCalled();
    expect(api.shelfAddPaths).not.toHaveBeenCalled();
  });

  it("可用性是旧快照：重探后恢复可用则正常投递", async () => {
    await renderTargetsView(dropTargetFixture({ available: false }));
    // 第一次读取（强制重探）返回恢复后的列表
    api.shelfDropTargets.mockResolvedValue([dropTargetFixture({ available: true })]);
    api.shelfDropToDirectory.mockResolvedValue(dropReportFixture());
    const row = document.querySelector<HTMLElement>('[data-drop-target="t1"]')!;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => row;
    try {
      act(() => emitSession(["C:\\tmp\\a.png"], { x: 40, y: 40 }));
    } finally {
      document.elementFromPoint = original;
    }

    await waitFor(() => expect(api.shelfDropToDirectory).toHaveBeenCalledTimes(1));
    expect(api.shelfDropToDirectory).toHaveBeenCalledWith("t1", ["C:\\tmp\\a.png"], expect.any(String));
    expect(api.shelfAddPaths).not.toHaveBeenCalled();
  });

  it("「打开目标文件夹」「清除结果」直达既有命令", async () => {
    await renderTargetsView();
    api.shelfDropToDirectory.mockResolvedValue(dropReportFixture());
    api.shelfDropTargetOpen.mockResolvedValue(undefined);
    const row = document.querySelector<HTMLElement>('[data-drop-target="t1"]')!;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => row;
    try {
      act(() => emitSession(["C:\\tmp\\a.png"], { x: 40, y: 40 }));
    } finally {
      document.elementFromPoint = original;
    }
    await screen.findByText(/最近投递：成功 2 项/);

    fireEvent.click(screen.getByRole("button", { name: "打开目标文件夹" }));
    await waitFor(() => expect(api.shelfDropTargetOpen).toHaveBeenCalledWith("t1"));

    fireEvent.click(screen.getByRole("button", { name: "清除「工作资料」的投递结果" }));
    await waitFor(() => expect(useDropTargetsStore.getState().reports["t1"]).toBeUndefined());
    expect(screen.queryByText(/最近投递：成功 2 项/)).toBeNull();
  });

  it("投递目标被移除后，重要的失败结果保留为孤儿报告，不再可投递", async () => {
    await renderTargetsView();
    api.shelfDropToDirectory.mockResolvedValue(
      dropReportFixture({
        success: 0,
        failed: 1,
        entries: [
          { source: "C:\\tmp\\a.png", display_name: "a.png", status: "failed" as const, reason: "无权限" },
        ],
      }),
    );
    const row = document.querySelector<HTMLElement>('[data-drop-target="t1"]')!;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => row;
    try {
      act(() => emitSession(["C:\\tmp\\a.png"], { x: 40, y: 40 }));
    } finally {
      document.elementFromPoint = original;
    }
    await screen.findByText(/失败 1 项/);

    // 移除入口：配置删除走 store，重要报告保留
    act(() => {
      useDropTargetsStore.setState({ targets: [] });
    });
    expect(await screen.findByText(/有未完成的投递：失败 1 项/)).toBeTruthy();
    expect(screen.getByText(/目标入口已移除；请到「D:\\Work」手工核对残留文件。/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除结果" }));
    await waitFor(() => expect(useDropTargetsStore.getState().reports["t1"]).toBeUndefined());
  });
});

describe("通用拖入（原生桥）· 非路径内容", () => {
  it("链接落在暂存架 → 只把 operationId 交给后端，条目入列", async () => {
    await renderShelf();
    const probe = {
      kind: "url",
      count: 1,
      canShelf: true,
      canDirectory: false,
      formats: ["HTML Format", "UniformResourceLocatorW"],
    };
    act(() => {
      emitBridge(BRIDGE_PROBE, { phase: "enter", point: { x: 40, y: 40 }, probe });
      emitBridge(BRIDGE_ACCEPTED, {
        operationId: "op-9",
        point: { x: 40, y: 40 },
        probe,
      });
      emitBridge(BRIDGE_PAYLOAD, {
        operationId: "op-9",
        point: { x: 40, y: 40 },
        payload: { kind: "url", url: "https://example.com", isImage: false },
        failures: [],
        skipped: 0,
      });
    });

    await waitFor(() => expect(api.dragPayloadCommitShelf).toHaveBeenCalledTimes(1));
    // 前端不重建内容，只传会话 id；本地路径未参与。
    expect(api.dragPayloadCommitShelf.mock.calls[0][0]).toBe("op-9");
    expect(api.dragPayloadCommitShelf.mock.calls[0][1]).toBe("reference");
    expect(api.dragPayloadDiscard).not.toHaveBeenCalled();
    expect(api.shelfAddPaths).not.toHaveBeenCalled();
    await waitFor(() => expect(lastToast()?.message).toBe("已暂存 1 项"));
  });

  it("未识别内容 → 明确提示并释放会话，不静默成功", async () => {
    await renderShelf();
    const probe = {
      kind: "unsupported",
      count: 0,
      canShelf: false,
      canDirectory: false,
      formats: ["SomePrivateFormat"],
    };
    act(() => {
      emitBridge(BRIDGE_PROBE, { phase: "enter", point: { x: 40, y: 40 }, probe });
      emitBridge(BRIDGE_ACCEPTED, {
        operationId: "op-10",
        point: { x: 40, y: 40 },
        probe,
      });
      emitBridge(BRIDGE_PAYLOAD, {
        operationId: "op-10",
        point: { x: 40, y: 40 },
        payload: {
          kind: "unsupported",
          formats: ["SomePrivateFormat"],
          reason: "来源没有提供可读取的内容",
          code: "DRAG_FORMAT_UNSUPPORTED",
        },
        failures: [],
        skipped: 0,
      });
    });

    await waitFor(() => expect(api.dragPayloadDiscard).toHaveBeenCalledWith("op-10"));
    expect(api.dragPayloadCommitShelf).not.toHaveBeenCalled();
    expect(api.shelfAddPaths).not.toHaveBeenCalled();
    // 具体原因来自后端（已脱敏），优先于笼统的「无法识别」。
    await waitFor(() =>
      expect(lastToast()?.message).toBe("来源没有提供可读取的内容"),
    );
  });
});
