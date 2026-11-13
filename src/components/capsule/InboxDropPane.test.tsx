/**
 * @vitest-environment jsdom
 */
//! 收集箱「文件投递」子页：真实 store + mock 后端，覆盖命中、未命中与结果反馈。
//!
//! 拖入事件走真实的 `lib/fileDrop` 分发（只 mock 掉 Webview 订阅本身），
//! 因此这里验证的是「谁接管 + 落到哪张卡片」这条链路，而不只是回调被调用。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act, within } from "@testing-library/react";

const dropTargets = vi.fn();
const dropToDirectory = vi.fn();
const openDir = vi.fn();
const removeTarget = vi.fn();
const moveTarget = vi.fn();
const listRecent = vi.fn();
const checkExists = vi.fn();
const openShelfItem = vi.fn();
const copyShelfFiles = vi.fn();
const copyShelfPaths = vi.fn();
const addShelfPaths = vi.fn();
const getShelfItem = vi.fn();
const readShelfText = vi.fn();
const copyClipboardText = vi.fn();
const updateShelfItem = vi.fn();
const revealShelfItem = vi.fn();
const deleteShelfItems = vi.fn();
const dragOut = vi.fn();
const openDialog = vi.fn();
// 原生桥（通用拖入）通道：提交/放弃都只传 operationId。
const commitPayloadShelf = vi.fn();
const commitPayloadDirectory = vi.fn();
const discardPayload = vi.fn();

// 导航结果可控：默认成功并执行 after；个别用例模拟被未保存草稿阻止。
const openFullAppMock = vi.hoisted(() =>
  vi.fn((_tab: string, after?: () => void) => {
    after?.();
    return "switched";
  }),
);
vi.mock("./actions", () => ({ openFullApp: openFullAppMock }));

type Handler = (event: { payload: Record<string, unknown> }) => void;
const handlers: Handler[] = [];
/** 原生桥事件（taskdock://drag-*）的监听回调，按事件名分组。 */
const bridgeHandlers = new Map<string, Handler[]>();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: Handler) => {
      handlers.push(cb);
      return Promise.resolve(unlisten);
    },
    // `lib/fileDrop` 用 webview.listen 订阅原生桥事件；测试里捕获回调后
    // 直接投递 = 模拟 Rust 侧 emit，不经过任何真实 Tauri IPC。
    listen: (name: string, cb: Handler) => {
      const list = bridgeHandlers.get(name) ?? [];
      list.push(cb);
      bridgeHandlers.set(name, list);
      return Promise.resolve(() => {
        bridgeHandlers.set(
          name,
          (bridgeHandlers.get(name) ?? []).filter((h) => h !== cb),
        );
      });
    },
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openDialog(...a),
}));

vi.mock("../../lib/bridge", () => ({
  shelfDropTargets: (...a: unknown[]) => dropTargets(...a),
  shelfDropTargetCreate: vi.fn(),
  shelfDropTargetUpdate: vi.fn(),
  shelfDropTargetDelete: (...a: unknown[]) => removeTarget(...a),
  shelfDropTargetMove: (...a: unknown[]) => moveTarget(...a),
  shelfDropTargetOpen: (...a: unknown[]) => openDir(...a),
  shelfDropToDirectory: (...a: unknown[]) => dropToDirectory(...a),
  // 最近暂存：默认空列表，个别用例再覆盖
  shelfList: (...a: unknown[]) => listRecent(...a),
  shelfCheckExists: (...a: unknown[]) => checkExists(...a),
  shelfOpenItem: (...a: unknown[]) => openShelfItem(...a),
  shelfCopyFiles: (...a: unknown[]) => copyShelfFiles(...a),
  shelfCopyPaths: (...a: unknown[]) => copyShelfPaths(...a),
  shelfAddPaths: (...a: unknown[]) => addShelfPaths(...a),
  shelfGetItem: (...a: unknown[]) => getShelfItem(...a),
  shelfReadText: (...a: unknown[]) => readShelfText(...a),
  shelfUpdate: (...a: unknown[]) => updateShelfItem(...a),
  shelfRevealItem: (...a: unknown[]) => revealShelfItem(...a),
  shelfDragOut: (...a: unknown[]) => dragOut(...a),
  shelfDelete: (...a: unknown[]) => deleteShelfItems(...a),
  clipboardCopyText: (...a: unknown[]) => copyClipboardText(...a),
  // 通用拖入：前端只传 operationId（内容留在后端暂存区）。
  dragPayloadCommitShelf: (...a: unknown[]) => commitPayloadShelf(...a),
  dragPayloadCommitDirectory: (...a: unknown[]) => commitPayloadDirectory(...a),
  dragPayloadDiscard: (...a: unknown[]) => discardPayload(...a),
  dragBridgeStatus: async () => ({
    active: true,
    maxItems: 32,
    maxTextBytes: 524288,
    maxImageBytes: 67108864,
  }),
  shelfStats: vi.fn(async () => ({
    total: 0,
    file_count: 0,
    image_count: 0,
    folder_count: 0,
    link_count: 0,
    text_count: 0,
    managed_bytes: 0,
    disk_bytes: 0,
    quota_mb: 2048,
  })),
  shelfGroups: vi.fn(async () => []),
  SHELF_KIND_LABELS: {
    file: "文件",
    image: "图片",
    folder: "文件夹",
    link: "链接",
    text: "文本",
  },
  applyMode: async () => undefined,
}));

import InboxDropPane from "./InboxDropPane";
import { useDropTargetsStore, __resetDropSubmitGuard } from "../../store/useDropTargetsStore";
import { useShelfStore, __resetShelfRecentCache } from "../../store/useShelfStore";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useUiStore } from "../../store/useUiStore";
import { __resetFileDrop } from "../../lib/fileDrop";
import type { ShelfFailedEntry } from "../../lib/bridge";

/** 每个用例都可能改写 DPI/命中函数：统一在 afterEach 复原，避免串味。 */
const initialDpr = window.devicePixelRatio;
const initialElementFromPoint = document.elementFromPoint;

function target(over: Partial<Record<string, unknown>> = {}) {
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
    ...over,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function emit(payload: Record<string, unknown>): void {
  for (const h of handlers) h({ payload });
}

/** 触发一次原生桥事件（模拟 Rust `taskdock://drag-*` 的 emit）。 */
function emitBridge(name: string, payload: Record<string, unknown>): void {
  for (const h of bridgeHandlers.get(name) ?? []) h({ payload });
}

const BRIDGE_PROBE = "taskdock://drag-probe";
const BRIDGE_ACCEPTED = "taskdock://drag-accepted";
const BRIDGE_PAYLOAD = "taskdock://drag-payload";

function report(over: Record<string, unknown> = {}) {
  return {
    batch_id: "b1",
    target_id: "t1",
    target_path: "D:\\Work",
    op: "copy",
    total: 1,
    success: 1,
    skipped: 0,
    failed: 0,
    partial: 0,
    entries: [
      { source: "C:\\a.txt", display_name: "a.txt", target: "D:\\Work\\a.txt", status: "ok" },
    ],
    ...over,
  };
}

function shelfItem(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    kind: "file",
    display_name: "报告.pdf",
    source_kind: "picker",
    storage_mode: "reference",
    original_path: "C:\\Docs\\报告.pdf",
    managed_path: null,
    content: null,
    byte_size: 1024,
    file_ext: "pdf",
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

/**
 * 临时替换 store 的 addPaths：按重构后契约直接 mock（原始路径进、
 * `{ added, failed }` 出，failed 已合并预检与后端失败），让用例与
 * store 内部实现解耦。返回恢复函数，测试 finally 里调用。
 */
function stubAddPaths(
  impl: (
    paths: string[],
    mode: "reference" | "managed",
    source: "picker" | "drag" | "manual",
  ) => Promise<{ added: number; failed: ShelfFailedEntry[] }>,
): () => void {
  const original = useShelfStore.getState().addPaths;
  useShelfStore.setState({ addPaths: vi.fn(impl) });
  return () => useShelfStore.setState({ addPaths: original });
}

beforeEach(() => {
  localStorage.clear();
  handlers.length = 0;
  bridgeHandlers.clear();
  commitPayloadShelf.mockReset();
  commitPayloadDirectory.mockReset();
  discardPayload.mockReset();
  discardPayload.mockResolvedValue(true);
  dropTargets.mockReset();
  dropToDirectory.mockReset();
  openDir.mockReset();
  removeTarget.mockReset();
  moveTarget.mockReset();
  listRecent.mockReset();
  checkExists.mockReset();
  openShelfItem.mockReset();
  copyShelfFiles.mockReset();
  copyShelfPaths.mockReset();
  addShelfPaths.mockReset();
  getShelfItem.mockReset();
  readShelfText.mockReset();
  copyClipboardText.mockReset();
  openDialog.mockReset();
  openFullAppMock.mockReset();
  openFullAppMock.mockImplementation((_tab: string, after?: () => void) => {
    after?.();
    return "switched";
  });
  listRecent.mockResolvedValue({ items: [], total: 0 });
  checkExists.mockResolvedValue([]);
  openShelfItem.mockResolvedValue(undefined);
  copyShelfFiles.mockResolvedValue(1);
  copyShelfPaths.mockResolvedValue(1);
  addShelfPaths.mockResolvedValue({ added: [], failed: [] });
  getShelfItem.mockResolvedValue(shelfItem({ content: "链接内容" }));
  readShelfText.mockResolvedValue({ content: "正文内容", truncated: false });
  copyClipboardText.mockResolvedValue(undefined);
  updateShelfItem.mockReset();
  updateShelfItem.mockImplementation(async (id: string, patch: Record<string, unknown>) =>
    shelfItem({ id, ...patch }),
  );
  revealShelfItem.mockReset();
  revealShelfItem.mockResolvedValue(undefined);
  deleteShelfItems.mockReset();
  deleteShelfItems.mockResolvedValue({
    deleted: 1,
    skipped: 0,
    freed_bytes: 0,
    failed_files: 0,
  });
  dragOut.mockReset();
  dragOut.mockResolvedValue({ effect: "none", count: 0, missing_ids: [] });
  openDialog.mockResolvedValue(null);
  __resetShelfRecentCache();
  useShelfStore.setState({
    recent: [],
    recentLoading: false,
    recentLoaded: false,
    recentError: null,
  });
  useGlobalSearchStore.setState({ pendingLocate: null });
  __resetFileDrop();
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
  useUiStore.setState({ diagnosticsOperationRequest: null });
});

afterEach(() => {
  cleanup();
  __resetFileDrop();
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value: initialDpr,
  });
  document.elementFromPoint = initialElementFromPoint;
});

describe("InboxDropPane", () => {
  it("未配置目标 → 空态 + 添加入口", async () => {
    dropTargets.mockResolvedValue([]);
    render(<InboxDropPane />);
    await screen.findByText("还没有文件投递目标");
    expect(screen.getByRole("button", { name: /添加目标文件夹/ })).toBeTruthy();
  });

  it("目标全部未勾选胶囊显示：只提示去完整面板开启，不误报「还没有目标」", async () => {
    dropTargets.mockResolvedValue([target({ show_in_capsule: false })]);
    render(<InboxDropPane />);
    await screen.findByText(/有 1 个目标未勾选/);
    expect(screen.queryByText("还没有文件投递目标")).toBeNull();
    expect(screen.queryByRole("button", { name: /添加目标文件夹/ })).toBeNull();
  });

  it("目标读取失败：显示错误与重试，不把失败冒充成「正在读取」", async () => {
    dropTargets.mockRejectedValue(new Error("ipc broken"));
    render(<InboxDropPane />);
    await screen.findByText("ipc broken");
    expect(screen.queryByText("正在读取投递目标")).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("拖入命中卡片 → 只向该目标投递一次，并展示结果汇总", async () => {
    dropTargets.mockResolvedValue([target()]);
    dropToDirectory.mockResolvedValue(report());
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();

    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    expect(card).toBeTruthy();
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;

    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    await waitFor(() => expect(card.className).toContain("is-over"));

    emit({ type: "drop", position: { x: 20, y: 20 }, paths: ["C:\\a.txt"] });
    await waitFor(() => expect(dropToDirectory).toHaveBeenCalledTimes(1));
    expect(dropToDirectory.mock.calls[0][0]).toBe("t1");
    expect(dropToDirectory.mock.calls[0][1]).toEqual(["C:\\a.txt"]);
    expect(typeof dropToDirectory.mock.calls[0][2]).toBe("string");

    await screen.findByText(/成功 1 项 · 跳过 0 项 · 失败 0 项/);
    // 全部成功：没有失败诊断可看，不出现「查看诊断」入口。
    expect(screen.queryByRole("button", { name: "查看诊断" })).toBeNull();
    document.elementFromPoint = original;
  });

  it("投递失败 → 结果条提供「查看诊断」，导航成功后下发该批次 operation_id", async () => {
    dropTargets.mockResolvedValue([target()]);
    dropToDirectory.mockResolvedValue(
      report({
        success: 0,
        failed: 1,
        entries: [
          {
            source: "C:\\a.txt",
            display_name: "a.txt",
            target: "D:\\Work\\a.txt",
            status: "failed",
            reason: "拒绝访问",
          },
        ],
      }),
    );
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();

    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;
    emit({ type: "enter", position: { x: 10, y: 10 }, paths: [] });
    emit({ type: "over", position: { x: 10, y: 10 } });
    emit({ type: "drop", position: { x: 10, y: 10 }, paths: ["C:\\a.txt"] });
    await waitFor(() => expect(dropToDirectory).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: "查看诊断" }));
    expect(openFullAppMock).toHaveBeenCalledWith("diagnostics", expect.any(Function));
    // 意图在导航成功后的 after 中下发，携带后端原样返回的批次 id。
    expect(useUiStore.getState().diagnosticsOperationRequest).toEqual({
      token: 1,
      operationId: "b1",
    });
    document.elementFromPoint = original;
  });

  it("诊断导航被保存中拒绝 → 提示失败且不残留一次性意图", async () => {
    openFullAppMock.mockImplementationOnce(() => "blocked");
    dropTargets.mockResolvedValue([target()]);
    dropToDirectory.mockResolvedValue(
      report({
        success: 0,
        partial: 1,
        entries: [
          {
            source: "C:\\a.txt",
            display_name: "a.txt",
            target: "D:\\Work\\a.txt",
            status: "partial",
            reason: "部分内容写入失败",
          },
        ],
      }),
    );
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();

    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;
    emit({ type: "enter", position: { x: 10, y: 10 }, paths: [] });
    emit({ type: "over", position: { x: 10, y: 10 } });
    emit({ type: "drop", position: { x: 10, y: 10 }, paths: ["C:\\a.txt"] });
    await waitFor(() => expect(dropToDirectory).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: "查看诊断" }));
    await screen.findByText(/无法打开诊断中心/);
    expect(useUiStore.getState().diagnosticsOperationRequest).toBeNull();
    document.elementFromPoint = original;
  });

  it("正在投递的卡片在拖拽中不冒充可投递（状态与样式必须一致）", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();
    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;

    await act(async () => {
      useDropTargetsStore.setState({
        ops: { t1: { targetId: "t1", total: 2, startedAt: Date.now() } },
      });
    });
    expect(screen.getByText(/正在复制 2 项/)).toBeTruthy();

    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;
    await act(async () => {
      emit({ type: "enter", position: { x: 10, y: 10 }, paths: [] });
    });
    expect(card.dataset.dropState).toBe("blocked");
    // 强调描边只属于可投递卡片：既不显示 ready 的可接收描边，也不显示 over
    expect(card.className).not.toContain("is-dragging");
    expect(card.className).not.toContain("is-over");

    await act(async () => {
      emit({ type: "over", position: { x: 10, y: 10 } });
    });
    expect(card.className).not.toContain("is-over");
    expect(card.className).not.toContain("is-over-blocked");
    expect(screen.queryByText(/松手即/)).toBeNull();
    document.elementFromPoint = original;
  });

  it("拖拽期间滚动投递列表：按最后一次坐标重算命中，不需要新的 over", async () => {
    dropTargets.mockResolvedValue([
      target(),
      target({ id: "t2", name: "图片归档", path: "D:\\Pics", sort_order: 1 }),
    ]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await screen.findByText("图片归档");
    await flush();
    const card = container.querySelector('[data-drop-target="t2"]') as HTMLElement;
    const scroller = container.querySelector(".cap-drop") as HTMLElement;

    const original = document.elementFromPoint;
    document.elementFromPoint = () => null;
    await act(async () => {
      emit({ type: "enter", position: { x: 30, y: 300 }, paths: [] });
    });
    expect(card.dataset.dropState).toBe("ready");

    // 滚动让内容位移：光标下方变成了这张卡，但系统不会再发 over
    document.elementFromPoint = () => card;
    await act(async () => {
      fireEvent.scroll(scroller);
    });
    await waitFor(() => expect(card.dataset.dropState).toBe("over"));
    document.elementFromPoint = original;
  });

  it("读屏播报当前落点：只在悬停具体目标时播报，离开后清空", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();
    const live = container.querySelector(".cap-drop-live") as HTMLElement;
    expect(live.getAttribute("role")).toBe("status");
    expect(live.className).toContain("sr-only");
    expect(live.textContent).toBe("");

    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;
    await act(async () => {
      emit({ type: "enter", position: { x: 10, y: 10 }, paths: [] });
    });
    expect(live.textContent).toBe("松开鼠标即投递到「工作资料」");

    document.elementFromPoint = () => null;
    await act(async () => {
      emit({ type: "over", position: { x: 300, y: 300 } });
    });
    expect(live.textContent).toBe("");
    document.elementFromPoint = original;
  });

  it("读屏播报不会为一个放不进的目标撒谎（不可用卡片）", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();
    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const live = container.querySelector(".cap-drop-live") as HTMLElement;

    await act(async () => {
      useDropTargetsStore.setState((state) => ({
        targets: state.targets.map((item) => ({ ...item, available: false })),
      }));
    });
    expect(screen.getByText("目录不可用")).toBeTruthy();

    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;
    await act(async () => {
      emit({ type: "enter", position: { x: 10, y: 10 }, paths: [] });
    });
    expect(card.className).toContain("is-over-blocked");
    expect(live.textContent).toBe("");
    document.elementFromPoint = original;
  });

  it("普通状态没有任何拖拽提示：投递提示只在拖拽会话中出现", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();

    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const zone = container.querySelector('[data-drop-zone="shelf-recent"]') as HTMLElement;
    // 顶部 PanelHead 已说明「拖文件到卡片即可投递」，静止态不再重复任何提示。
    expect(card.dataset.dropState).toBe("idle");
    expect(card.className).not.toContain("is-dragging");
    expect(screen.queryByText(/松手即/)).toBeNull();
    expect(zone.className).not.toContain("is-drop-active");
    expect(screen.queryByText(/松开即加入/)).toBeNull();
  });

  it("拖拽开始：可用卡片都进入可投递形态，不可用目标不冒充可投递", async () => {
    dropTargets.mockResolvedValue([
      target(),
      target({
        id: "t2",
        name: "离线盘",
        path: "Z:\\Offline",
        sort_order: 1,
        available: false,
      }),
    ]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await screen.findByText("离线盘");
    await flush();

    const a = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const b = container.querySelector('[data-drop-target="t2"]') as HTMLElement;
    await act(async () => {
      emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    });

    // 可投递：图标换成语义明确的「文件夹 + 向内箭头」，但仍保留完整模式说明
    // （含「删除源文件」警告）——不只用透明度表达状态。
    expect(a.dataset.dropState).toBe("ready");
    expect(a.className).toContain("is-dragging");
    expect(a.querySelector(".lucide-folder-input")).toBeTruthy();
    expect(a.querySelector(".cap-drop-status")?.textContent).toBe("复制 · 保留源文件");

    // 不可投递：保留红字徽标与普通图标，不能和可接收目标长得一样。
    expect(b.dataset.dropState).toBe("blocked");
    expect(b.querySelector(".lucide-folder-input")).toBeNull();
    expect(b.querySelector(".cap-drop-status")?.textContent).toBe("目录不可用");

    // 光标停在不可用目标上：可以标记为「当前指向」，但状态仍是 blocked，
    // 文案保持「目录不可用」，不会显示「松手即投递」。
    const original = document.elementFromPoint;
    document.elementFromPoint = () => b;
    await act(async () => {
      emit({ type: "over", position: { x: 220, y: 20 } });
    });
    expect(b.className).toContain("is-over");
    expect(b.dataset.dropState).toBe("blocked");
    expect(b.querySelector(".cap-drop-status")?.textContent).toBe("目录不可用");
    expect(screen.queryByText(/松手即/)).toBeNull();
    document.elementFromPoint = original;

    emit({ type: "leave" });
    await waitFor(() => expect(a.dataset.dropState).toBe("idle"));
    expect(b.className).not.toContain("is-over");
  });

  it("enter 自带的坐标立即命中：拖进窗口后停在卡片上也能高亮（OLE 静止不补发 over）", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();

    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;

    // 只有 enter、没有任何 over：这正是「鼠标已经在卡片上，界面却仍提示把文件
    // 拖到目标卡片上」的原始复现条件（OLE 只在鼠标移动时才发 DragOver）。
    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });

    await waitFor(() => expect(card.dataset.dropState).toBe("over"));
    expect(card.className).toContain("is-over");
    expect(screen.getByText("松手即复制")).toBeTruthy();

    emit({ type: "leave" });
    await waitFor(() => expect(card.dataset.dropState).toBe("idle"));
    expect(screen.queryByText("松手即复制")).toBeNull();
    document.elementFromPoint = original;
  });

  it("enter 早于目标列表渲染：列表到达后按最后一次坐标补算命中，不必再动鼠标", async () => {
    let resolveTargets: (value: unknown) => void = () => {};
    dropTargets.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTargets = resolve;
        }),
    );
    const { container } = render(<InboxDropPane />);
    await flush();

    const original = document.elementFromPoint;
    // 命中函数在调用时才查 DOM：卡片出现的那一刻即可被命中。
    document.elementFromPoint = () =>
      container.querySelector('[data-drop-target="t1"]');

    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    expect(container.querySelector('[data-drop-target="t1"]')).toBeNull();

    await act(async () => {
      resolveTargets([target()]);
    });
    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;

    // 列表返回后卡片才出现，而 over 不会再来一次：必须自动补算命中。
    await waitFor(() => expect(card.dataset.dropState).toBe("over"));
    expect(screen.getByText("松手即复制")).toBeTruthy();
    document.elementFromPoint = original;
  });

  it("悬停 A → 悬停 B → 离开目标：高亮与文案严格互斥，并按实时坐标切换", async () => {
    dropTargets.mockResolvedValue([
      target(),
      target({
        id: "t2",
        name: "图片归档",
        path: "D:\\Pics",
        sort_order: 1,
        op_mode: "move",
      }),
    ]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await screen.findByText("图片归档");
    await flush();

    const a = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const b = container.querySelector('[data-drop-target="t2"]') as HTMLElement;
    const original = document.elementFromPoint;

    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    document.elementFromPoint = () => a;
    emit({ type: "over", position: { x: 20, y: 20 } });
    await waitFor(() => expect(a.dataset.dropState).toBe("over"));
    expect(b.dataset.dropState).toBe("ready");
    expect(screen.getByText("松手即复制")).toBeTruthy();
    expect(screen.queryByText("松手即移动")).toBeNull();
    // 未悬停的卡片仍保留完整模式语义（含删源警告）
    expect(screen.getByText("移动 · 删除源文件")).toBeTruthy();

    document.elementFromPoint = () => b;
    emit({ type: "over", position: { x: 220, y: 20 } });
    await waitFor(() => expect(b.dataset.dropState).toBe("over"));
    expect(a.dataset.dropState).toBe("ready");
    expect(screen.getByText("松手即移动")).toBeTruthy();
    expect(screen.queryByText("松手即复制")).toBeNull();
    expect(screen.getByText("复制 · 保留源文件")).toBeTruthy();

    document.elementFromPoint = () => null;
    emit({ type: "over", position: { x: 300, y: 300 } });
    await waitFor(() => expect(a.dataset.dropState).toBe("ready"));
    expect(b.dataset.dropState).toBe("ready");
    expect(screen.queryByText(/松手即/)).toBeNull();
    document.elementFromPoint = original;
  });

  it("拖拽期间不插入文档流元素：卡片结构与子节点数在 enter/悬停前后不变（自拖放命中回归）", async () => {
    dropTargets.mockResolvedValue([
      target(),
      target({ id: "t2", name: "图片归档", path: "D:\\Pics", sort_order: 1 }),
    ]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await screen.findByText("图片归档");
    await flush();

    const scroller = container.querySelector(".cap-drop") as HTMLElement;
    const cards = ["t1", "t2"].map(
      (id) => container.querySelector(`[data-drop-target="${id}"]`) as HTMLElement,
    );
    const childrenBefore = Array.from(scroller.children);
    // 只比较 SVG 之外的结构：图标在拖拽期间会从 folder 换成 folder-input，
    // 内部 path 数量不同，但外层尺寸、卡片结构与命中区域都不变。
    const signature = (el: HTMLElement) =>
      Array.from(el.querySelectorAll("*"))
        .filter((node) => !node.closest("svg"))
        .map((node) => node.tagName)
        .join(">");
    const signatures = cards.map(signature);
    const counts = cards.map((card) => card.children.length);

    const original = document.elementFromPoint;
    document.elementFromPoint = () => cards[0];
    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    await waitFor(() => expect(cards[0].dataset.dropState).toBe("over"));

    // 2026-11-10 的回归形态：拖入提示作为普通流元素插入，卡片整体下移 32.7px，
    // drop 按真实松手坐标命中失败。现在拖拽状态只改类名/文案/图标：
    // 不新增任何流内节点，卡片子节点数也不变（几何由浏览器 harness 实测）。
    expect(scroller.children.length).toBe(childrenBefore.length);
    expect(
      Array.from(scroller.children).every((el, i) => el === childrenBefore[i]),
    ).toBe(true);
    expect(cards.map(signature)).toEqual(signatures);
    expect(cards.map((card) => card.children.length)).toEqual(counts);
    expect(cards[0].querySelector(".cap-drop-meta")?.children.length).toBe(1);

    emit({ type: "leave" });
    await waitFor(() => expect(cards[0].dataset.dropState).toBe("idle"));
    expect(
      Array.from(scroller.children).every((el, i) => el === childrenBefore[i]),
    ).toBe(true);
    document.elementFromPoint = original;
  });

  it("未命中任何卡片 → 不执行任何文件操作，并清除高亮", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();

    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;
    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    await waitFor(() => expect(card.className).toContain("is-over"));

    // 松手前光标移到空白处：高亮清除后 drop 不得落到上一张卡片
    document.elementFromPoint = () => null;
    emit({ type: "over", position: { x: 300, y: 300 } });
    await waitFor(() => expect(card.className).not.toContain("is-over"));

    emit({ type: "drop", position: { x: 300, y: 300 }, paths: ["C:\\a.txt"] });
    await flush();
    expect(dropToDirectory).not.toHaveBeenCalled();
    expect(addShelfPaths).not.toHaveBeenCalled();
    document.elementFromPoint = original;
  });

  it("拖入取消（leave）→ 高亮复位，不投递", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();
    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;

    emit({ type: "enter", position: { x: 10, y: 10 }, paths: [] });
    emit({ type: "over", position: { x: 10, y: 10 } });
    await waitFor(() => expect(card.className).toContain("is-over"));
    emit({ type: "leave" });
    await waitFor(() => expect(card.className).not.toContain("is-over"));
    expect(dropToDirectory).not.toHaveBeenCalled();
    document.elementFromPoint = original;
  });

  it("目录不可用 → 不投递并给出内联提示", async () => {
    dropTargets.mockResolvedValue([target({ available: false })]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();
    expect(screen.getByText("目录不可用")).toBeTruthy();

    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;
    emit({ type: "enter", position: { x: 10, y: 10 }, paths: [] });
    emit({ type: "over", position: { x: 10, y: 10 } });
    emit({ type: "drop", position: { x: 10, y: 10 }, paths: ["C:\\a.txt"] });

    await screen.findByText(/目录不可用，未执行投递/);
    expect(dropToDirectory).not.toHaveBeenCalled();
    expect(addShelfPaths).not.toHaveBeenCalled();
    document.elementFromPoint = original;
  });

  it("卸载释放拖放订阅（不留常驻监听）", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { unmount } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();
    expect(handlers.length).toBe(1);
    unmount();
    expect(unlisten).toHaveBeenCalled();
    emit({ type: "drop", position: { x: 0, y: 0 }, paths: ["C:\\a.txt"] });
    expect(dropToDirectory).not.toHaveBeenCalled();
    expect(addShelfPaths).not.toHaveBeenCalled();
  });

  it("拖拽会话进行中卸载：owner 立即清理，迟到 drop 不执行任何文件操作", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container, unmount } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();
    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;
    emit({ type: "enter", position: { x: 10, y: 10 }, paths: [] });
    emit({ type: "over", position: { x: 10, y: 10 } });
    await waitFor(() => expect(card.className).toContain("is-over"));

    unmount();
    // 注销清理会把会话中的 owner 一并清空：随后迟到的 drop 无人接收，不得投递。
    emit({ type: "drop", position: { x: 10, y: 10 }, paths: ["C:\\a.txt"] });
    await flush();

    expect(dropToDirectory).not.toHaveBeenCalled();
    expect(addShelfPaths).not.toHaveBeenCalled();
    document.elementFromPoint = original;
  });

  it("暂存在途时卸载：迟到返回不更新 UI、不触发最近切片刷新", async () => {
    dropTargets.mockResolvedValue([target()]);
    let resolveAdd: (value: { added: number; failed: ShelfFailedEntry[] }) => void = () => {};
    const restore = stubAddPaths(
      () =>
        new Promise<{ added: number; failed: ShelfFailedEntry[] }>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    try {
      const { container, unmount } = render(<InboxDropPane />);
      await screen.findByText("工作资料");
      const zone = container.querySelector('[data-drop-zone="shelf-recent"]') as HTMLElement;
      document.elementFromPoint = () => zone;
      emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
      emit({ type: "drop", position: { x: 20, y: 20 }, paths: ["C:\\a.txt"] });
      await waitFor(() => expect(useShelfStore.getState().addPaths).toHaveBeenCalledTimes(1));

      const recentCalls = listRecent.mock.calls.length;
      unmount();
      resolveAdd({ added: 1, failed: [] });
      await flush();
      await flush();

      // 卸载后不更新任何本地状态：flash 被 alive 守卫拦下，finally 里的
      // loadRecent(force) 也不再执行（新增条目由 store 自身合并保证可见）。
      expect(listRecent.mock.calls.length).toBe(recentCalls);
    } finally {
      restore();
    }
  });

  it("点击卡片主体打开真实目录", async () => {
    dropTargets.mockResolvedValue([target()]);
    openDir.mockResolvedValue(undefined);
    render(<InboxDropPane />);
    await screen.findByText("工作资料");
    fireEvent.click(screen.getByRole("button", { name: "打开「工作资料」目录" }));
    await waitFor(() => expect(openDir).toHaveBeenCalledWith("t1"));
  });

  it("重复 drop（双击/事件重复）只提交一次", async () => {
    dropTargets.mockResolvedValue([target()]);
    dropToDirectory.mockResolvedValue(report());
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();

    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;
    emit({ type: "enter", position: { x: 10, y: 10 }, paths: [] });
    emit({ type: "over", position: { x: 10, y: 10 } });
    emit({ type: "drop", position: { x: 10, y: 10 }, paths: ["C:\\a.txt"] });
    emit({ type: "drop", position: { x: 10, y: 10 }, paths: ["C:\\a.txt"] });

    await waitFor(() => expect(dropToDirectory).toHaveBeenCalledTimes(1));
    await flush();
    expect(dropToDirectory).toHaveBeenCalledTimes(1);
    expect(addShelfPaths).not.toHaveBeenCalled();
    document.elementFromPoint = original;
  });

  it("悬停 A 后快速移到 B 松手 → 必须投递到 B（不复用过期高亮）", async () => {
    // B 配成移动模式：命中错误会直接把源文件搬到错误目录，必须与复制走同一套命中逻辑
    dropTargets.mockResolvedValue([
      target(),
      target({ id: "t2", name: "图片归档", path: "D:\\Pics", sort_order: 1, op_mode: "move" }),
    ]);
    dropToDirectory.mockResolvedValue(
      report({ target_id: "t2", target_path: "D:\\Pics", op: "move" }),
    );
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await screen.findByText("图片归档");
    await flush();

    const a = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const b = container.querySelector('[data-drop-target="t2"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => a;
    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    await waitFor(() => expect(a.className).toContain("is-over"));

    // 快速移到 B 直接松手：系统不会再发 over，缓存高亮仍是 A
    document.elementFromPoint = () => b;
    emit({ type: "drop", position: { x: 200, y: 140 }, paths: ["C:\\a.txt"] });

    await waitFor(() => expect(dropToDirectory).toHaveBeenCalledTimes(1));
    expect(dropToDirectory.mock.calls[0][0]).toBe("t2");
    expect(a.className).not.toContain("is-over");
    document.elementFromPoint = original;
  });

  it("悬停 A 后在空白处松手 → 不投递", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();
    const a = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => a;
    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    await waitFor(() => expect(a.className).toContain("is-over"));

    document.elementFromPoint = () => null;
    emit({ type: "drop", position: { x: 320, y: 400 }, paths: ["C:\\a.txt"] });
    await flush();

    expect(dropToDirectory).not.toHaveBeenCalled();
    await waitFor(() => expect(a.className).not.toContain("is-over"));
    document.elementFromPoint = original;
  });

  it("拖出面板（leave）后松手 → 不投递", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();
    const a = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => a;
    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 }, });
    await waitFor(() => expect(a.className).toContain("is-over"));

    emit({ type: "leave" });
    emit({ type: "drop", position: { x: 20, y: 20 }, paths: ["C:\\a.txt"] });
    await flush();

    expect(dropToDirectory).not.toHaveBeenCalled();
    expect(addShelfPaths).not.toHaveBeenCalled();
    document.elementFromPoint = original;
  });

  it("drop 缺少坐标 → 不猜测目标、不执行文件操作", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();
    const a = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => a;
    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    await waitFor(() => expect(a.className).toContain("is-over"));

    emit({ type: "drop", paths: ["C:\\a.txt"] });
    await flush();

    expect(dropToDirectory).not.toHaveBeenCalled();
    await waitFor(() => expect(a.className).not.toContain("is-over"));
    document.elementFromPoint = original;
  });

  it("卡片在拖入期间被隐藏 → 高亮清除且不再接收投递", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();
    const a = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => a;
    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    await waitFor(() => expect(a.className).toContain("is-over"));

    await act(async () => {
      useDropTargetsStore.setState((s) => ({
        targets: s.targets.map((t) => ({ ...t, show_in_capsule: false })),
      }));
    });
    await waitFor(() => expect(screen.queryByText("工作资料")).toBeNull());

    emit({ type: "drop", position: { x: 20, y: 20 }, paths: ["C:\\a.txt"] });
    await flush();
    expect(dropToDirectory).not.toHaveBeenCalled();
    document.elementFromPoint = original;
  });

  it("视图切换（打开编辑表单）后旧高亮失效、不再投递", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();
    const a = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => a;
    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    await waitFor(() => expect(a.className).toContain("is-over"));

    fireEvent.click(screen.getByRole("button", { name: "「工作资料」更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑" }));
    await waitFor(() => expect(screen.getByRole("form", { name: "编辑投递目标" })).toBeTruthy());
    // 卡片已卸载：光标下方不再是任何投递卡片
    document.elementFromPoint = () => screen.getByRole("form", { name: "编辑投递目标" });

    emit({ type: "drop", position: { x: 20, y: 20 }, paths: ["C:\\a.txt"] });
    await flush();
    expect(dropToDirectory).not.toHaveBeenCalled();
    document.elementFromPoint = original;
  });

  // ── 单消费者落点仲裁：目录卡片 / 最近暂存 / 空白 ─────────────

  it("拖入最近暂存区 → 只按引用暂存一次，不投递任何目录", async () => {
    dropTargets.mockResolvedValue([target()]);
    addShelfPaths.mockResolvedValue({ added: [shelfItem()], failed: [] });
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await screen.findByText("最近暂存");

    const zone = container.querySelector('[data-drop-zone="shelf-recent"]') as HTMLElement;
    expect(zone).toBeTruthy();
    document.elementFromPoint = () => zone;

    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    await waitFor(() => expect(zone.className).toContain("is-drop-over"));
    // 落点在接收区：文案必须明确「松手会发生什么」，与目录卡片的悬停语义同构
    expect(screen.getByText(/松开即加入/)).toBeTruthy();

    emit({ type: "drop", position: { x: 20, y: 20 }, paths: ["C:\\Docs\\新文件.txt"] });
    await waitFor(() => expect(addShelfPaths).toHaveBeenCalledTimes(1));
    expect(addShelfPaths).toHaveBeenCalledWith(
      ["C:\\Docs\\新文件.txt"],
      "reference",
      "drag",
      null,
    );
    expect(dropToDirectory).not.toHaveBeenCalled();
    await screen.findByText("已暂存 1 项");
  });

  it("没有可见目录卡片时，最近暂存仍可接收拖入", async () => {
    dropTargets.mockResolvedValue([]);
    addShelfPaths.mockResolvedValue({ added: [shelfItem()], failed: [] });
    const { container } = render(<InboxDropPane />);
    await screen.findByText("最近暂存");

    const zone = container.querySelector('[data-drop-zone="shelf-recent"]') as HTMLElement;
    document.elementFromPoint = () => zone;
    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    emit({ type: "drop", position: { x: 20, y: 20 }, paths: ["C:\\Docs\\无目标.txt"] });

    await waitFor(() => expect(addShelfPaths).toHaveBeenCalledTimes(1));
    expect(dropToDirectory).not.toHaveBeenCalled();
  });

  it("悬停卡片后移到最近暂存松手 → 只暂存，不投递目录", async () => {
    dropTargets.mockResolvedValue([target()]);
    addShelfPaths.mockResolvedValue({ added: [shelfItem()], failed: [] });
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const zone = container.querySelector('[data-drop-zone="shelf-recent"]') as HTMLElement;

    document.elementFromPoint = () => card;
    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    await waitFor(() => expect(card.className).toContain("is-over"));
    // 会话期间接收区有轻高亮，但没有落点高亮
    await waitFor(() => expect(zone.className).toContain("is-drop-active"));
    expect(zone.className).not.toContain("is-drop-over");

    // 直接移到接收区松手：over 必须实时切换高亮，drop 用松手坐标重新命中
    document.elementFromPoint = () => zone;
    emit({ type: "over", position: { x: 30, y: 300 } });
    await waitFor(() => expect(zone.className).toContain("is-drop-over"));
    expect(card.className).not.toContain("is-over");

    emit({ type: "drop", position: { x: 30, y: 300 }, paths: ["C:\\a.txt"] });
    await waitFor(() => expect(addShelfPaths).toHaveBeenCalledTimes(1));
    expect(dropToDirectory).not.toHaveBeenCalled();
  });

  it("悬停最近暂存后移到卡片松手 → 只投递目录，不暂存", async () => {
    dropTargets.mockResolvedValue([target()]);
    dropToDirectory.mockResolvedValue(report());
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const zone = container.querySelector('[data-drop-zone="shelf-recent"]') as HTMLElement;

    document.elementFromPoint = () => zone;
    emit({ type: "enter", position: { x: 30, y: 300 }, paths: [] });
    emit({ type: "over", position: { x: 30, y: 300 } });
    await waitFor(() => expect(zone.className).toContain("is-drop-over"));

    document.elementFromPoint = () => card;
    emit({ type: "over", position: { x: 20, y: 20 } });
    await waitFor(() => expect(card.className).toContain("is-over"));
    expect(zone.className).not.toContain("is-drop-over");

    emit({ type: "drop", position: { x: 20, y: 20 }, paths: ["C:\\a.txt"] });
    await waitFor(() => expect(dropToDirectory).toHaveBeenCalledTimes(1));
    expect(dropToDirectory.mock.calls[0][0]).toBe("t1");
    expect(addShelfPaths).not.toHaveBeenCalled();
  });

  it("重复 drop 到最近暂存只暂存一次", async () => {
    dropTargets.mockResolvedValue([target()]);
    addShelfPaths.mockResolvedValue({ added: [shelfItem()], failed: [] });
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    const zone = container.querySelector('[data-drop-zone="shelf-recent"]') as HTMLElement;
    document.elementFromPoint = () => zone;

    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    emit({ type: "drop", position: { x: 20, y: 20 }, paths: ["C:\\a.txt"] });
    emit({ type: "drop", position: { x: 20, y: 20 }, paths: ["C:\\a.txt"] });

    await waitFor(() => expect(addShelfPaths).toHaveBeenCalledTimes(1));
    await flush();
    expect(addShelfPaths).toHaveBeenCalledTimes(1);
    expect(dropToDirectory).not.toHaveBeenCalled();
  });

  it("最近暂存收到缺坐标或空 paths → 不执行暂存", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    const zone = container.querySelector('[data-drop-zone="shelf-recent"]') as HTMLElement;
    document.elementFromPoint = () => zone;

    // 会话 1：没有坐标 → 不猜目标
    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    emit({ type: "drop", paths: ["C:\\a.txt"] });
    await flush();

    // 会话 2：paths 为空 → 不执行
    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    emit({ type: "drop", position: { x: 20, y: 20 }, paths: [] });
    await flush();

    expect(addShelfPaths).not.toHaveBeenCalled();
    expect(dropToDirectory).not.toHaveBeenCalled();
  });

  it("空 paths 不执行文件操作，但 UI 必须复位（高亮与拖拽提示消失）", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();
    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const zone = container.querySelector('[data-drop-zone="shelf-recent"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;
    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    await waitFor(() => expect(card.className).toContain("is-over"));
    expect(screen.getByText("松手即复制")).toBeTruthy();

    emit({ type: "drop", position: { x: 20, y: 20 }, paths: [] });
    await waitFor(() => expect(card.className).not.toContain("is-over"));
    expect(card.dataset.dropState).toBe("idle");
    expect(zone.className).not.toContain("is-drop-active");
    expect(screen.queryByText(/松手即/)).toBeNull();
    expect(screen.queryByText(/松开即加入/)).toBeNull();
    expect(dropToDirectory).not.toHaveBeenCalled();
    expect(addShelfPaths).not.toHaveBeenCalled();
    document.elementFromPoint = original;
  });

  it("目标在拖入期间被删除 → 原卡片位置不再投递，也不落到暂存架", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    document.elementFromPoint = () => card;

    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    await waitFor(() => expect(card.className).toContain("is-over"));

    await act(async () => {
      useDropTargetsStore.setState({ targets: [] });
    });
    await waitFor(() => expect(screen.queryByText("工作资料")).toBeNull());

    emit({ type: "drop", position: { x: 20, y: 20 }, paths: ["C:\\a.txt"] });
    await flush();
    expect(dropToDirectory).not.toHaveBeenCalled();
    expect(addShelfPaths).not.toHaveBeenCalled();
  });

  it("最近暂存部分失败 → 只提示「部分」，不冒充成功", async () => {
    dropTargets.mockResolvedValue([target()]);
    addShelfPaths.mockResolvedValue({
      added: [shelfItem()],
      failed: [
        { path: "C:\\b.txt", reason: "访问被拒绝" },
        { path: "C:\\c.txt", reason: "磁盘已满" },
      ],
    });
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    const zone = container.querySelector('[data-drop-zone="shelf-recent"]') as HTMLElement;
    document.elementFromPoint = () => zone;

    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    emit({
      type: "drop",
      position: { x: 20, y: 20 },
      paths: ["C:\\a.txt", "C:\\b.txt", "C:\\c.txt"],
    });

    await screen.findByText(/已部分暂存/);
    expect(screen.getByText(/成功 1 项/)).toBeTruthy();
    expect(screen.getByText(/2 项失败（访问被拒绝）/)).toBeTruthy();
    expect(dropToDirectory).not.toHaveBeenCalled();
  });

  it("最近暂存全部失败 → 明确失败条数与首条原因", async () => {
    dropTargets.mockResolvedValue([target()]);
    addShelfPaths.mockResolvedValue({
      added: [],
      failed: [{ path: "C:\\b.txt", reason: "权限不足" }],
    });
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    const zone = container.querySelector('[data-drop-zone="shelf-recent"]') as HTMLElement;
    document.elementFromPoint = () => zone;

    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    emit({ type: "over", position: { x: 20, y: 20 } });
    emit({ type: "drop", position: { x: 20, y: 20 }, paths: ["C:\\b.txt"] });

    await screen.findByText("有 1 项未能暂存：权限不足");
    expect(screen.queryByText(/已暂存/)).toBeNull();
  });

  it("暂存结果 0/0（后端既无成功也无失败）→ 明确提示，不静默也不冒充成功", async () => {
    dropTargets.mockResolvedValue([target()]);
    // 按重构后 addPaths 契约 mock：全部无效时 added=0 且 failed 非空；这里
    // 单独覆盖后端空批次（0/0）形态，UI 必须给出与完整暂存架同口径的提示。
    const restore = stubAddPaths(async () => ({ added: 0, failed: [] }));
    try {
      const { container } = render(<InboxDropPane />);
      await screen.findByText("工作资料");
      const zone = container.querySelector('[data-drop-zone="shelf-recent"]') as HTMLElement;
      document.elementFromPoint = () => zone;
      emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
      emit({ type: "over", position: { x: 20, y: 20 } });
      emit({ type: "drop", position: { x: 20, y: 20 }, paths: ["C:\\a.txt"] });

      await screen.findByText("没有可添加的文件");
      // 一条结果只出一条提示：不出现「已暂存」，也没有重复提示
      expect(screen.queryByText(/已暂存/)).toBeNull();
      expect(screen.getAllByText("没有可添加的文件")).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it.each([1.25, 2])("DPI %s：物理坐标换算后仍命中卡片与最近暂存", async (dpr) => {
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: dpr,
    });
    dropTargets.mockResolvedValue([target()]);
    dropToDirectory.mockResolvedValue(report());
    addShelfPaths.mockResolvedValue({ added: [shelfItem()], failed: [] });
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const zone = container.querySelector('[data-drop-zone="shelf-recent"]') as HTMLElement;

    // 只接受换算后的 CSS 坐标 (100,50)：直接用物理坐标会落到别处。
    document.elementFromPoint = (x: number, y: number) =>
      Math.abs(x - 100) < 0.001 && Math.abs(y - 50) < 0.001 ? card : null;
    emit({ type: "enter", position: { x: 100 * dpr, y: 50 * dpr }, paths: [] });
    emit({ type: "over", position: { x: 100 * dpr, y: 50 * dpr } });
    emit({ type: "drop", position: { x: 100 * dpr, y: 50 * dpr }, paths: ["C:\\a.txt"] });
    await waitFor(() => expect(dropToDirectory).toHaveBeenCalledTimes(1));
    expect(dropToDirectory.mock.calls[0][0]).toBe("t1");

    document.elementFromPoint = (x: number, y: number) =>
      Math.abs(x - 100) < 0.001 && Math.abs(y - 50) < 0.001 ? zone : null;
    emit({ type: "enter", position: { x: 100 * dpr, y: 50 * dpr }, paths: [] });
    emit({ type: "over", position: { x: 100 * dpr, y: 50 * dpr } });
    emit({ type: "drop", position: { x: 100 * dpr, y: 50 * dpr }, paths: ["C:\\b.txt"] });
    await waitFor(() => expect(addShelfPaths).toHaveBeenCalledTimes(1));
    expect(addShelfPaths).toHaveBeenCalledWith(["C:\\b.txt"], "reference", "drag", null);
  });

  it("最近暂存展示条目与可访问性，点击行直接打开", async () => {
    dropTargets.mockResolvedValue([target()]);
    listRecent.mockResolvedValue({
      items: [
        shelfItem(),
        shelfItem({
          id: "s2",
          kind: "image",
          display_name: "截图.png",
          exists_state: "missing",
        }),
      ],
      total: 2,
    });
    render(<InboxDropPane />);
    await screen.findByText("报告.pdf");
    expect(screen.getByText("截图.png")).toBeTruthy();
    expect(screen.getByText(/原文件不可用/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "打开「报告.pdf」" }));
    await waitFor(() => expect(openShelfItem).toHaveBeenCalledWith("s1"));
    // 只取最近一小段，不加载完整历史
    expect(listRecent).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 4, offset: 0 }),
    );
  });

  it("最近暂存按文件类型显示不同图标与短类型名", async () => {
    dropTargets.mockResolvedValue([target()]);
    listRecent.mockResolvedValue({
      items: [
        shelfItem(),
        shelfItem({
          id: "s2",
          kind: "image",
          display_name: "截图.png",
          file_ext: "png",
        }),
        shelfItem({
          id: "s3",
          kind: "folder",
          display_name: "项目目录",
          original_path: "D:\\Work\\项目目录",
          file_ext: null,
        }),
      ],
      total: 3,
    });
    const { container } = render(<InboxDropPane />);
    await screen.findByText("报告.pdf");

    expect(screen.getByText("PDF 文档 · 引用原文件")).toBeTruthy();
    expect(screen.getByText("PNG 图片 · 引用原文件")).toBeTruthy();
    expect(screen.getByText("文件夹 · 引用原文件")).toBeTruthy();

    const icons = container.querySelectorAll(".cap-shelf-recent-icon");
    expect(icons[0].className).toContain("file-tone-doc");
    expect(icons[1].className).toContain("file-tone-image");
    expect(icons[2].className).toContain("file-tone-folder");
  });

  it("最近暂存可删除：按钮先确认，成功后刷新并提示", async () => {
    dropTargets.mockResolvedValue([target()]);
    listRecent.mockResolvedValue({ items: [shelfItem()], total: 1 });
    render(<InboxDropPane />);
    await screen.findByText("报告.pdf");

    fireEvent.click(screen.getByRole("button", { name: "删除「报告.pdf」" }));
    const confirm = screen.getByRole("group", { name: "删除「报告.pdf」" });
    expect(within(confirm).getByText(/只删暂存记录/)).toBeTruthy();
    // 原删除按钮已卸载：焦点先落到「取消」，键盘用户不会丢失位置。
    expect(document.activeElement).toBe(
      within(confirm).getByRole("button", { name: "取消" }),
    );

    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("group", { name: "删除「报告.pdf」" })).toBeNull();
    expect(deleteShelfItems).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "删除「报告.pdf」" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "删除「报告.pdf」" })).getByRole(
        "button",
        { name: "删除" },
      ),
    );
    await waitFor(() => expect(deleteShelfItems).toHaveBeenCalledWith(["s1"], false));
    await screen.findByText("已删除 1 项");
  });

  it("受保护条目删除需明确提示，确认后传 includeProtected", async () => {
    dropTargets.mockResolvedValue([target()]);
    listRecent.mockResolvedValue({
      items: [shelfItem({ favorite: true })],
      total: 1,
    });
    render(<InboxDropPane />);
    await screen.findByText("报告.pdf");

    fireEvent.click(screen.getByRole("button", { name: "删除「报告.pdf」" }));
    expect(screen.getByText(/已收藏\/置顶\/被场景引用/)).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole("group", { name: "删除「报告.pdf」" })).getByRole(
        "button",
        { name: "删除" },
      ),
    );
    await waitFor(() => expect(deleteShelfItems).toHaveBeenCalledWith(["s1"], true));
  });

  it("更多菜单同样提供删除入口", async () => {
    dropTargets.mockResolvedValue([target()]);
    listRecent.mockResolvedValue({ items: [shelfItem()], total: 1 });
    render(<InboxDropPane />);
    await screen.findByText("报告.pdf");

    fireEvent.click(screen.getByRole("button", { name: "「报告.pdf」更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    expect(screen.getByRole("group", { name: "删除「报告.pdf」" })).toBeTruthy();
    expect(deleteShelfItems).not.toHaveBeenCalled();
  });

  it("最近暂存的更多菜单可复制文件/路径，不改变列表", async () => {
    dropTargets.mockResolvedValue([target()]);
    listRecent.mockResolvedValue({ items: [shelfItem()], total: 1 });
    render(<InboxDropPane />);
    await screen.findByText("报告.pdf");

    fireEvent.click(screen.getByRole("button", { name: "「报告.pdf」更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制文件" }));
    await waitFor(() => expect(copyShelfFiles).toHaveBeenCalledWith(["s1"]));

    fireEvent.click(screen.getByRole("button", { name: "「报告.pdf」更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制路径" }));
    await waitFor(() => expect(copyShelfPaths).toHaveBeenCalledWith(["s1"]));
    expect(screen.getByText("报告.pdf")).toBeTruthy();
  });

  it("最近暂存可收藏，也可在文件夹中显示", async () => {
    dropTargets.mockResolvedValue([target()]);
    listRecent.mockResolvedValue({ items: [shelfItem()], total: 1 });
    render(<InboxDropPane />);
    await screen.findByText("报告.pdf");

    fireEvent.click(screen.getByRole("button", { name: "「报告.pdf」更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "收藏" }));
    await waitFor(() =>
      expect(updateShelfItem).toHaveBeenCalledWith("s1", { favorite: true }),
    );
    await screen.findByText("已收藏");

    fireEvent.click(screen.getByRole("button", { name: "「报告.pdf」更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "在文件夹中显示" }));
    await waitFor(() => expect(revealShelfItem).toHaveBeenCalledWith("s1"));
    await screen.findByText("已在文件夹中显示");
  });

  it("最近暂存文件行可拖出；move 后刷新最近切片并提示", async () => {
    dropTargets.mockResolvedValue([target()]);
    listRecent.mockResolvedValue({ items: [shelfItem()], total: 1 });
    dragOut.mockResolvedValue({ effect: "move", count: 1, missing_ids: ["s1"] });
    render(<InboxDropPane />);
    const name = await screen.findByText("报告.pdf");
    const row = name.closest(".cap-shelf-recent-item") as HTMLElement;
    expect(row.className).toContain("is-draggable");

    fireEvent.pointerDown(row, {
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

    await waitFor(() => expect(dragOut).toHaveBeenCalledWith(["s1"]));
    await waitFor(() =>
      expect(listRecent.mock.calls.length).toBeGreaterThan(1),
    );
    await screen.findByText("文件已移动；最近暂存已刷新，原路径可能已失效");
  });

  it("暂存行开始原生拖出即给出可投递形态（事件被 DoDragDrop 缓冲），结束后复位", async () => {
    dropTargets.mockResolvedValue([target()]);
    listRecent.mockResolvedValue({ items: [shelfItem()], total: 1 });
    let finish: (value: { effect: string; count: number; missing_ids: string[] }) => void =
      () => {};
    dragOut.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { container } = render(<InboxDropPane />);
    const name = await screen.findByText("报告.pdf");
    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const zone = container.querySelector('[data-drop-zone="shelf-recent"]') as HTMLElement;
    const row = name.closest(".cap-shelf-recent-item") as HTMLElement;
    expect(card.dataset.dropState).toBe("idle");

    fireEvent.pointerDown(row, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document, {
      pointerId: 1,
      buttons: 1,
      clientX: 30,
      clientY: 10,
    });

    // 应用内拖出：DoDragDrop 在 UI 线程运行，原生 enter/over/drop 全部被缓冲，
    // 只能靠发起方的前置信号立刻给出「可以放」的形态。
    await waitFor(() => expect(card.dataset.dropState).toBe("ready"));
    expect(zone.className).toContain("is-drop-active");
    // 前置信号只表示「拖拽已开始」，不冒充命中：没有坐标就没有落点高亮
    expect(zone.className).not.toContain("is-drop-over");
    expect(screen.queryByText(/松手即/)).toBeNull();

    await act(async () => {
      finish({ effect: "none", count: 0, missing_ids: [] });
    });
    await waitFor(() => expect(card.dataset.dropState).toBe("idle"));
    expect(zone.className).not.toContain("is-drop-active");
  });

  it("文本条目只提供查看/复制内容，不出现复制路径；正文按需读取", async () => {
    dropTargets.mockResolvedValue([target()]);
    listRecent.mockResolvedValue({
      items: [shelfItem({ id: "s3", kind: "text", display_name: "会议纪要", original_path: null })],
      total: 1,
    });
    render(<InboxDropPane />);
    await screen.findByText("会议纪要");
    expect(readShelfText).not.toHaveBeenCalled(); // 列表不加载正文

    fireEvent.click(screen.getByRole("button", { name: "「会议纪要」更多操作" }));
    expect(await screen.findByRole("menuitem", { name: "查看内容" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "复制内容" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "复制路径" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "复制文件" })).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: "复制内容" }));
    await waitFor(() => expect(readShelfText).toHaveBeenCalledWith("s3"));
    await waitFor(() => expect(copyClipboardText).toHaveBeenCalledWith("正文内容"));
    await screen.findByText("内容已复制");
  });

  it("链接条目复制链接而不是路径或文件", async () => {
    dropTargets.mockResolvedValue([target()]);
    const link = shelfItem({
      id: "s4",
      kind: "link",
      display_name: "示例链接",
      original_path: null,
      content: null,
    });
    listRecent.mockResolvedValue({ items: [link], total: 1 });
    getShelfItem.mockResolvedValue({ ...link, content: "https://example.com/a" });
    render(<InboxDropPane />);
    await screen.findByText("示例链接");

    fireEvent.click(screen.getByRole("button", { name: "「示例链接」更多操作" }));
    expect(await screen.findByRole("menuitem", { name: "复制链接" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "复制路径" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "复制文件" })).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: "复制链接" }));
    await waitFor(() => expect(getShelfItem).toHaveBeenCalledWith("s4"));
    await waitFor(() => expect(copyClipboardText).toHaveBeenCalledWith("https://example.com/a"));
    await screen.findByText("链接已复制");
  });

  it("文件夹只复制路径；图片可复制文件", async () => {
    dropTargets.mockResolvedValue([target()]);
    listRecent.mockResolvedValue({
      items: [
        shelfItem({ id: "s5", kind: "folder", display_name: "项目目录", file_ext: null }),
        shelfItem({ id: "s6", kind: "image", display_name: "截图.png", file_ext: "png" }),
      ],
      total: 2,
    });
    render(<InboxDropPane />);
    await screen.findByText("项目目录");

    fireEvent.click(screen.getByRole("button", { name: "「项目目录」更多操作" }));
    expect(await screen.findByRole("menuitem", { name: "复制路径" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "复制文件" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "「截图.png」更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制文件" }));
    await waitFor(() => expect(copyShelfFiles).toHaveBeenCalledWith(["s6"]));
  });

  it("文件失效时给出明确错误，不调用复制", async () => {
    dropTargets.mockResolvedValue([target()]);
    listRecent.mockResolvedValue({
      items: [shelfItem({ exists_state: "missing" })],
      total: 1,
    });
    render(<InboxDropPane />);
    await screen.findByText("报告.pdf");

    fireEvent.click(screen.getByRole("button", { name: "「报告.pdf」更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制文件" }));
    await screen.findByText("文件不存在，无法复制");
    expect(copyShelfFiles).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "「报告.pdf」更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制路径" }));
    await screen.findByText("文件不存在，无法复制路径");
    expect(copyShelfPaths).not.toHaveBeenCalled();
  });

  it("文本被截断时明确拒绝，不把部分正文当完整内容复制", async () => {
    dropTargets.mockResolvedValue([target()]);
    listRecent.mockResolvedValue({
      items: [shelfItem({ id: "s7", kind: "text", display_name: "超长文本" })],
      total: 1,
    });
    readShelfText.mockResolvedValue({ content: "前 1MB", truncated: true });
    render(<InboxDropPane />);
    await screen.findByText("超长文本");

    fireEvent.click(screen.getByRole("button", { name: "「超长文本」更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "复制内容" }));
    await screen.findByText("内容过大，未能完整复制");
    expect(copyClipboardText).not.toHaveBeenCalled();
  });

  it("定位最近暂存条目：导航成功后下发一次性定位意图", async () => {
    dropTargets.mockResolvedValue([target()]);
    listRecent.mockResolvedValue({ items: [shelfItem()], total: 1 });
    render(<InboxDropPane />);
    await screen.findByText("报告.pdf");

    fireEvent.click(screen.getByRole("button", { name: "「报告.pdf」更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "在暂存架中查看" }));
    await waitFor(() => {
      const intent = useGlobalSearchStore.getState().pendingLocate;
      expect(intent?.category).toBe("shelf");
      expect(intent?.id).toBe("s1");
    });
  });

  it("导航被阻止时不残留定位意图（after 不会执行）", async () => {
    openFullAppMock.mockImplementationOnce(() => "blocked");
    dropTargets.mockResolvedValue([target()]);
    listRecent.mockResolvedValue({ items: [shelfItem()], total: 1 });
    render(<InboxDropPane />);
    await screen.findByText("报告.pdf");

    fireEvent.click(screen.getByRole("button", { name: "「报告.pdf」更多操作" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "在暂存架中查看" }));
    await waitFor(() => expect(openFullAppMock).toHaveBeenCalled());
    expect(useGlobalSearchStore.getState().pendingLocate).toBeNull();
  });

  it("「管理」入口：导航成功后才置位一次性意图", async () => {
    dropTargets.mockResolvedValue([target()]);
    render(<InboxDropPane />);
    await screen.findByText("工作资料");
    expect(useDropTargetsStore.getState().manageRequest).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    expect(openFullAppMock).toHaveBeenCalledWith("shelf", expect.any(Function));
    expect(useDropTargetsStore.getState().manageRequest).toBe(1);
  });

  it("「管理」入口：导航被阻止时不残留一次性意图", async () => {
    openFullAppMock.mockImplementationOnce(() => "blocked");
    dropTargets.mockResolvedValue([target()]);
    render(<InboxDropPane />);
    await screen.findByText("工作资料");

    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    await waitFor(() => expect(openFullAppMock).toHaveBeenCalled());
    // 未导航成功：之后手动进入暂存架也不会突然展开管理面板
    expect(useDropTargetsStore.getState().manageRequest).toBe(0);
  });

  it("最近暂存可在胶囊内直接添加文件（默认引用）", async () => {
    dropTargets.mockResolvedValue([target()]);
    openDialog.mockResolvedValue(["C:\\Docs\\新文件.txt"]);
    addShelfPaths.mockResolvedValue({ added: [{ id: "n1" }], failed: [] });
    render(<InboxDropPane />);
    await screen.findByText("最近暂存");

    fireEvent.click(screen.getByRole("button", { name: "添加文件到暂存架" }));
    await waitFor(() =>
      expect(addShelfPaths).toHaveBeenCalledWith(
        ["C:\\Docs\\新文件.txt"],
        "reference",
        "picker",
        null,
      ),
    );
    // 添加后强制刷新最近切片
    await waitFor(() => expect(listRecent.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("文件选择器添加结果 0/0 → 同样提示「没有可添加的文件」，不静默", async () => {
    dropTargets.mockResolvedValue([target()]);
    const restore = stubAddPaths(async () => ({ added: 0, failed: [] }));
    try {
      openDialog.mockResolvedValue(["C:\\Docs\\新文件.txt"]);
      render(<InboxDropPane />);
      await screen.findByText("最近暂存");

      fireEvent.click(screen.getByRole("button", { name: "添加文件到暂存架" }));
      await screen.findByText("没有可添加的文件");
      expect(screen.queryByText(/已暂存/)).toBeNull();
    } finally {
      restore();
    }
  });

  it("卡片更多菜单：单目标时上移/下移不可用，拖入期间菜单会收起", async () => {
    dropTargets.mockResolvedValue([target()]);
    render(<InboxDropPane />);
    await screen.findByText("工作资料");
    fireEvent.click(screen.getByRole("button", { name: "「工作资料」更多操作" }));
    const up = await screen.findByRole("menuitem", { name: "上移" });
    const down = await screen.findByRole("menuitem", { name: "下移" });
    expect(up.getAttribute("aria-disabled")).toBe("true");
    expect(down.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("menuitem", { name: "编辑" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /移除入口/ })).toBeTruthy();
  });

  it("表单状态底栏只提供保存/取消，不再出现禁用的重复添加入口", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");

    fireEvent.click(screen.getByRole("button", { name: "添加目标" }));
    await screen.findByRole("form", { name: "添加投递目标" });
    const foot = container.querySelector(".cap-drop-foot") as HTMLElement;
    expect(foot).toBeTruthy();
    expect(within(foot).getByRole("button", { name: "添加目标" })).toBeTruthy();
    expect(within(foot).getByRole("button", { name: "取消" })).toBeTruthy();
    // 表单内隐藏重复按钮：底栏只有一套主操作
    expect(within(screen.getByRole("form", { name: "添加投递目标" })).queryByRole("button", { name: "取消" })).toBeNull();

    // 高级选项默认折叠，摘要可见；展开后才出现同名策略
    expect(screen.getByRole("button", { name: /高级选项/ })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "同名文件策略" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /高级选项/ }));
    expect(screen.getByRole("group", { name: "同名文件策略" })).toBeTruthy();

    fireEvent.click(within(foot).getByRole("button", { name: "取消" }));
    await screen.findByText("工作资料");
  });

  it("诊断意图一次性消费：取走后清空，重复消费返回 null", () => {
    useUiStore.getState().requestDiagnosticsOperation("b9");
    expect(useUiStore.getState().diagnosticsOperationRequest).toEqual({
      token: 1,
      operationId: "b9",
    });
    expect(useUiStore.getState().consumeDiagnosticsOperation()).toBe("b9");
    expect(useUiStore.getState().diagnosticsOperationRequest).toBeNull();
    expect(useUiStore.getState().consumeDiagnosticsOperation()).toBeNull();
  });
});

describe("InboxDropPane 重试失败项（W4）", () => {
  it("结果条提供重试入口：失败/跳过条目的源路径原样重投到同一目标", async () => {
    dropTargets.mockResolvedValue([target()]);
    dropToDirectory
      .mockResolvedValueOnce(
        report({
          success: 0,
          skipped: 1,
          failed: 2,
          entries: [
            { source: "C:\a.txt", display_name: "a.txt", status: "failed", reason: "拒绝访问" },
            { source: "C:\b.txt", display_name: "b.txt", status: "skipped", reason: "已存在" },
            { source: "C:\c.txt", display_name: "c.txt", status: "failed", reason: "被占用" },
          ],
        }),
      )
      .mockResolvedValueOnce(report());
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();

    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;
    emit({ type: "enter", position: { x: 10, y: 10 }, paths: [] });
    emit({ type: "over", position: { x: 10, y: 10 } });
    emit({ type: "drop", position: { x: 10, y: 10 }, paths: ["C:\a.txt"] });
    await waitFor(() => expect(dropToDirectory).toHaveBeenCalledTimes(1));
    await screen.findByText(/成功 0 项 · 跳过 1 项 · 失败 2 项/);

    fireEvent.click(await screen.findByRole("button", { name: /重新投递/ }));
    await waitFor(() => expect(dropToDirectory).toHaveBeenCalledTimes(2));
    // 第二次投递 = 失败/跳过条目的源路径（保持原序），目标不变
    expect(dropToDirectory.mock.calls[1][0]).toBe("t1");
    expect(dropToDirectory.mock.calls[1][1]).toEqual(["C:\a.txt", "C:\b.txt", "C:\c.txt"]);
    // 重试全部成功后结果条恢复成功口径，重试入口消失
    await screen.findByText(/成功 1 项 · 跳过 0 项 · 失败 0 项/);
    expect(screen.queryByRole("button", { name: /重新投递/ })).toBeNull();
    document.elementFromPoint = original;
  });

  it("全部成功的结果条不提供重试入口（无 entries 可重投）", async () => {
    dropTargets.mockResolvedValue([target()]);
    dropToDirectory.mockResolvedValue(report());
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();

    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;
    emit({ type: "enter", position: { x: 10, y: 10 }, paths: [] });
    emit({ type: "over", position: { x: 10, y: 10 } });
    emit({ type: "drop", position: { x: 10, y: 10 }, paths: ["C:\a.txt"] });
    await waitFor(() => expect(dropToDirectory).toHaveBeenCalledTimes(1));
    await screen.findByText(/成功 1 项 · 跳过 0 项 · 失败 0 项/);
    expect(screen.queryByRole("button", { name: /重新投递/ })).toBeNull();
    document.elementFromPoint = original;
  });

  // ── 原生桥：非路径内容的真实落点路由 ──────────────────────
  //
  // 这些用例走 `lib/fileDrop` 的双通道订阅：probe(enter) → accepted → payload，
  // 与 Rust `TaskDock://drag-*` 的事件顺序一致；高亮/落点仍由坐标命中决定。

  /** 等桥的三个监听都挂上（注册消费者是异步的）。 */
  async function waitBridgeReady(): Promise<void> {
    await waitFor(() =>
      expect(bridgeHandlers.get(BRIDGE_PROBE)?.length ?? 0).toBeGreaterThan(0),
    );
    await waitFor(() =>
      expect(bridgeHandlers.get(BRIDGE_PAYLOAD)?.length ?? 0).toBeGreaterThan(0),
    );
  }

  it("原生桥：链接落在最近暂存 → 只提交 operationId，不把 URL 当路径", async () => {
    dropTargets.mockResolvedValue([target()]);
    commitPayloadShelf.mockResolvedValue({
      operationId: "op-1",
      kind: "url",
      added: [shelfItem({ kind: "link", display_name: "example.com", content: "https://example.com" })],
      failed: [],
      failures: [],
      skipped: 0,
    });
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await waitBridgeReady();

    const zone = container.querySelector(
      '[data-drop-zone="shelf-recent"]',
    ) as HTMLElement;
    expect(zone).toBeTruthy();
    const original = document.elementFromPoint;
    document.elementFromPoint = () => zone;

    const probe = {
      kind: "url",
      count: 1,
      canShelf: true,
      canDirectory: false,
      formats: ["HTML Format", "UniformResourceLocatorW"],
    };
    emitBridge(BRIDGE_PROBE, { phase: "enter", point: { x: 20, y: 20 }, probe });
    emitBridge(BRIDGE_ACCEPTED, { operationId: "op-1", point: { x: 20, y: 20 }, probe });
    emitBridge(BRIDGE_PAYLOAD, {
      operationId: "op-1",
      point: { x: 20, y: 20 },
      payload: { kind: "url", url: "https://example.com", isImage: false },
      failures: [],
      skipped: 0,
    });

    await waitFor(() => expect(commitPayloadShelf).toHaveBeenCalledTimes(1));
    expect(commitPayloadShelf.mock.calls[0]).toEqual(["op-1", "reference", null]);
    expect(discardPayload).not.toHaveBeenCalled();
    expect(dropToDirectory).not.toHaveBeenCalled();
    expect(addShelfPaths).not.toHaveBeenCalled();
    await screen.findByText(/已暂存 1 项/);
    document.elementFromPoint = original;
  });

  it("原生桥：文本落在目录卡片 → 明确拒绝，不生成 .txt、不留临时副本", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await waitBridgeReady();

    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;

    const probe = {
      kind: "text",
      count: 1,
      canShelf: true,
      canDirectory: false,
      formats: ["CF_UNICODETEXT"],
    };
    emitBridge(BRIDGE_PROBE, { phase: "enter", point: { x: 20, y: 20 }, probe });
    emitBridge(BRIDGE_ACCEPTED, { operationId: "op-2", point: { x: 20, y: 20 }, probe });
    emitBridge(BRIDGE_PAYLOAD, {
      operationId: "op-2",
      point: { x: 20, y: 20 },
      payload: { kind: "text", textPreview: "一段文字", chars: 4 },
      failures: [],
      skipped: 0,
    });

    await waitFor(() => expect(discardPayload).toHaveBeenCalledTimes(1));
    expect(discardPayload.mock.calls[0][0]).toBe("op-2");
    expect(commitPayloadDirectory).not.toHaveBeenCalled();
    expect(dropToDirectory).not.toHaveBeenCalled();
    await screen.findByText("此内容不能直接投递到文件夹");
    document.elementFromPoint = original;
  });

  it("原生桥：图片字节落在目录卡片 → 传 operationId 提交，不走路径通道", async () => {
    dropTargets.mockResolvedValue([target()]);
    commitPayloadDirectory.mockResolvedValue(report());
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await waitBridgeReady();

    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;

    const probe = {
      kind: "image",
      count: 1,
      canShelf: true,
      canDirectory: true,
      formats: ["PNG"],
    };
    emitBridge(BRIDGE_PROBE, { phase: "enter", point: { x: 20, y: 20 }, probe });
    emitBridge(BRIDGE_ACCEPTED, { operationId: "op-3", point: { x: 20, y: 20 }, probe });
    emitBridge(BRIDGE_PAYLOAD, {
      operationId: "op-3",
      point: { x: 20, y: 20 },
      payload: {
        kind: "image",
        count: 1,
        items: [
          { name: "拖入图片.png", size: 128, itemKind: "image", mime: "image/png", width: 2, height: 2 },
        ],
      },
      failures: [],
      skipped: 0,
    });

    await waitFor(() => expect(commitPayloadDirectory).toHaveBeenCalledTimes(1));
    expect(commitPayloadDirectory.mock.calls[0][0]).toBe("t1");
    expect(commitPayloadDirectory.mock.calls[0][1]).toBe("op-3");
    expect(dropToDirectory).not.toHaveBeenCalled();
    expect(discardPayload).not.toHaveBeenCalled();
    document.elementFromPoint = original;
  });

  it("原生桥：本地文件仍走既有路径语义（预检/去重/在途守卫不变）", async () => {
    dropTargets.mockResolvedValue([target()]);
    dropToDirectory.mockResolvedValue(report());
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await waitBridgeReady();

    const card = container.querySelector('[data-drop-target="t1"]') as HTMLElement;
    const original = document.elementFromPoint;
    document.elementFromPoint = () => card;

    const probe = {
      kind: "local-files",
      count: 1,
      canShelf: true,
      canDirectory: true,
      formats: ["CF_HDROP"],
    };
    emitBridge(BRIDGE_PROBE, { phase: "enter", point: { x: 20, y: 20 }, probe });
    emitBridge(BRIDGE_ACCEPTED, { operationId: "op-4", point: { x: 20, y: 20 }, probe });
    emitBridge(BRIDGE_PAYLOAD, {
      operationId: "op-4",
      point: { x: 20, y: 20 },
      payload: { kind: "local-files", paths: ["C:\\a.txt"], count: 1 },
      failures: [],
      skipped: 0,
    });

    await waitFor(() => expect(dropToDirectory).toHaveBeenCalledTimes(1));
    expect(dropToDirectory.mock.calls[0][1]).toEqual(["C:\\a.txt"]);
    // 会话交给路径通道后必须释放，避免临时副本悬挂。
    expect(discardPayload).toHaveBeenCalledWith("op-4");
    document.elementFromPoint = original;
  });

  it("原生桥：未识别内容且未命中接收区 → 明确提示并释放会话", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await waitBridgeReady();
    const original = document.elementFromPoint;
    document.elementFromPoint = () => null;

    const probe = {
      kind: "unsupported",
      count: 0,
      canShelf: false,
      canDirectory: false,
      formats: ["SomePrivateFormat"],
    };
    emitBridge(BRIDGE_PROBE, { phase: "enter", point: { x: 400, y: 400 }, probe });
    emitBridge(BRIDGE_ACCEPTED, { operationId: "op-5", point: { x: 400, y: 400 }, probe });
    emitBridge(BRIDGE_PAYLOAD, {
      operationId: "op-5",
      point: { x: 400, y: 400 },
      payload: {
        kind: "unsupported",
        formats: ["SomePrivateFormat"],
        reason: "来源没有提供可读取的内容",
        code: "DRAG_FORMAT_UNSUPPORTED",
      },
      failures: [],
      skipped: 0,
    });

    await waitFor(() => expect(discardPayload).toHaveBeenCalledTimes(1));
    // 释放命令只接收 operationId；原因仅用于前端诊断，不写进 IPC。
    expect(discardPayload).toHaveBeenCalledWith("op-5");
    expect(dropToDirectory).not.toHaveBeenCalled();
    expect(commitPayloadShelf).not.toHaveBeenCalled();
    // 后端给出具体原因时展示原因，而不是笼统一句「无法识别」。
    await screen.findByText("来源没有提供可读取的内容");
    document.elementFromPoint = original;
    // 容器变量仅用于保持渲染句柄，避免未使用告警。
    expect(container).toBeTruthy();
  });
});
