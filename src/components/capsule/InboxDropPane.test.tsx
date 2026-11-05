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
import { __resetFileDrop } from "../../lib/fileDrop";

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
});

afterEach(() => {
  cleanup();
  __resetFileDrop();
});

describe("InboxDropPane", () => {
  it("未配置目标 → 空态 + 添加入口", async () => {
    dropTargets.mockResolvedValue([]);
    render(<InboxDropPane />);
    await screen.findByText("还没有文件投递目标");
    expect(screen.getByRole("button", { name: /添加目标文件夹/ })).toBeTruthy();
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
});
