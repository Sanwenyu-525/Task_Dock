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
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: Handler) => {
      handlers.push(cb);
      return Promise.resolve(unlisten);
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

beforeEach(() => {
  localStorage.clear();
  handlers.length = 0;
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

  it("拖入提示渲染在目标网格之后，不改变卡片几何（自拖放命中回归）", async () => {
    dropTargets.mockResolvedValue([target()]);
    const { container } = render(<InboxDropPane />);
    await screen.findByText("工作资料");
    await flush();

    emit({ type: "enter", position: { x: 20, y: 20 }, paths: [] });
    const hint = await screen.findByText("把文件拖到目标卡片上");
    const grid = container.querySelector(".cap-drop-grid") as HTMLElement;
    expect(grid).toBeTruthy();
    // 提示条必须在网格之后：从暂存架拖出的原生 OLE 事件在拖拽结束后才处理，
    // 提示条若插在网格上方，卡片会先下移，随后 drop 按真实坐标命中失败。
    expect(
      grid.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    emit({ type: "leave" });
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
    expect(screen.getByText(/拖入文件即可暂存/)).toBeTruthy();

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
