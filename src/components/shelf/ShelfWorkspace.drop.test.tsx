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
  shelfReadImage: vi.fn(async () => null),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  listTasks: vi.fn(async () => []),
  shelfTaskLinks: vi.fn(async () => []),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...api };
});

type DragHandler = (event: { payload: Record<string, unknown> }) => void;

const webview = vi.hoisted(() => {
  const listeners = new Set<(event: { payload: Record<string, unknown> }) => void>();
  const onDragDropEvent = vi.fn(
    async (cb: (event: { payload: Record<string, unknown> }) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  );
  return { listeners, onDragDropEvent };
});

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: webview.onDragDropEvent }),
}));

import ShelfWorkspace from "./ShelfWorkspace";
import { __resetFileDrop, fileDropListening } from "../../lib/fileDrop";
import { useShelfStore } from "../../store/useShelfStore";
import { useDropTargetsStore } from "../../store/useDropTargetsStore";
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
  return utils;
}

beforeEach(() => {
  __resetFileDrop();
  webview.listeners.clear();
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

  it("切到「投递目标管理」后释放消费者并清高亮，迟到 drop 不进入暂存架", async () => {
    const { container } = await renderShelf();
    const staleHandler = [...webview.listeners][0] as DragHandler;

    act(() => emit({ type: "enter", paths: ["C:\\tmp\\a.png"], position: { x: 1, y: 1 } }));
    expect(container.querySelector(".shelf-workspace.drag-over")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "更多暂存架操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "投递目标管理" }));

    await waitFor(() => expect(screen.getByText("投递目标")).toBeTruthy());
    await waitFor(() => expect(webview.listeners.size).toBe(0));
    expect(container.querySelector(".shelf-workspace.drag-over")).toBeNull();

    act(() =>
      staleHandler({
        payload: { type: "drop", paths: ["C:\\tmp\\late.png"], position: { x: 1, y: 1 } },
      }),
    );
    expect(api.shelfAddPaths).not.toHaveBeenCalled();
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
