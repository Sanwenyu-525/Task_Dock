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
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const bridge = vi.hoisted(() => ({
  clipboardView: vi.fn(),
  clipboardStatus: vi.fn(),
  onClipboardChanged: vi.fn(),
  clipboardCopyItem: vi.fn(),
  clipboardCopyGroupRich: vi.fn(),
  clipboardCopyGroupFiles: vi.fn(),
  clipboardCreateGroup: vi.fn(),
  clipboardClearHistory: vi.fn(),
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
import ClipboardWorkspace from "./ClipboardWorkspace";
import type { ClipboardItem, ClipboardView, DeleteReport } from "../../lib/bridge";
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
    title: "",
    title_source: "none",
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
  bridge.clipboardClearHistory.mockResolvedValue({
    items: 3,
    groups: 0,
    freed_bytes: 60,
    failed_files: 0,
  });
  bridge.clipboardDeleteItems.mockResolvedValue({
    deleted: 1,
    freed_bytes: 20,
    retained_shared: 0,
    groups_deleted: 0,
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

  it("复制后只更新该条目使用次数，不重新拉取列表", async () => {
    const user = userEvent.setup();
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");
    const callsBefore = bridge.clipboardView.mock.calls.length;

    await user.click(screen.getAllByRole("button", { name: "复制" })[0]);

    await waitFor(() => expect(bridge.clipboardCopyItem).toHaveBeenCalledWith("ci0"));
    expect(bridge.clipboardView.mock.calls.length).toBe(callsBefore);
    const first = useClipboardStore.getState().view?.items[0];
    expect(first?.copy_count).toBe(2);
  });

  it("清空历史：确认后调用命令、清空状态并刷新为空", async () => {
    const user = userEvent.setup();
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");

    await user.click(screen.getByRole("button", { name: "清空剪贴板历史" }));
    const dialog = await screen.findByRole("dialog", { name: "确定清空全部剪贴板历史？" });
    expect(dialog.textContent).toContain("包括收藏和置顶内容");
    expect(dialog.textContent).toContain("不会清除系统当前剪贴板");
    expect(dialog.textContent).toContain("不会删除电脑中的原始文件");

    bridge.clipboardView.mockResolvedValue(makeView(0));
    await user.click(screen.getByRole("button", { name: "确认清空" }));

    await waitFor(() => expect(bridge.clipboardClearHistory).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useUiStore.getState().toast?.message).toContain("已清空 3 条历史、0 个分组"),
    );
    expect(useUiStore.getState().toast?.kind).toBe("success");
    expect(useClipboardStore.getState().view?.items).toHaveLength(0);
    expect(await screen.findByText("还没有剪贴板记录")).toBeTruthy();
  });

  it("清空执行期间禁用重复点击", async () => {
    const user = userEvent.setup();
    let resolveClear: (value: unknown) => void = () => {};
    bridge.clipboardClearHistory.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveClear = resolve;
      }),
    );
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");

    await user.click(screen.getByRole("button", { name: "清空剪贴板历史" }));
    await user.click(screen.getByRole("button", { name: "确认清空" }));
    await waitFor(() => expect(bridge.clipboardClearHistory).toHaveBeenCalledTimes(1));

    const entry = screen.getByRole("button", { name: "清空剪贴板历史" }) as HTMLButtonElement;
    expect(entry.disabled).toBe(true);
    fireEvent.click(entry);
    expect(bridge.clipboardClearHistory).toHaveBeenCalledTimes(1);

    resolveClear({ items: 3, groups: 0, freed_bytes: 60, failed_files: 0 });
    await waitFor(() =>
      expect(useUiStore.getState().toast?.message).toContain("已清空 3 条历史"),
    );
  });

  it("清空失败时提示错误，不显示虚假成功", async () => {
    const user = userEvent.setup();
    bridge.clipboardClearHistory.mockRejectedValueOnce(new Error("数据库暂时不可用"));
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");
    const callsBefore = bridge.clipboardView.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "清空剪贴板历史" }));
    await user.click(screen.getByRole("button", { name: "确认清空" }));

    await waitFor(() => expect(useUiStore.getState().toast?.kind).toBe("error"));
    expect(useUiStore.getState().toast?.message).toContain("清空失败");
    expect(useUiStore.getState().toast?.message).not.toContain("已清空");
    expect(bridge.clipboardView.mock.calls.length).toBe(callsBefore);
  });

  it("没有历史时清空入口禁用", async () => {
    bridge.clipboardView.mockResolvedValue(makeView(0));
    render(<ClipboardPanel />);
    await screen.findByText("还没有剪贴板记录");

    const entry = screen.getByRole("button", { name: "清空剪贴板历史" }) as HTMLButtonElement;
    expect(entry.disabled).toBe(true);
  });

  it("页面形态没有关闭按钮（那是抽屉才有的）", async () => {
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");
    expect(screen.queryByRole("button", { name: "关闭剪贴板" })).toBeNull();
  });

  it("删除成功后先播退出反馈，动画结束才刷新列表", async () => {
    const user = userEvent.setup();
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");
    const callsBefore = bridge.clipboardView.mock.calls.length;

    await user.click(screen.getAllByRole("button", { name: "删除" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "删除这条剪贴板历史？" });
    await user.click(await within(dialog).findByRole("button", { name: "删除" }));

    await waitFor(() => expect(bridge.clipboardDeleteItems).toHaveBeenCalledWith(["ci0"]));
    // 被删条目仍留在 DOM 中收拢淡出；此刻不得抢先刷新（否则用户看不到「哪条被删了」）
    expect(document.querySelector(".clip-item.removing")).toBeTruthy();
    expect(bridge.clipboardView.mock.calls.length).toBe(callsBefore);

    // 一次性定时器到点后移除退出态并静默刷新
    await waitFor(() => expect(bridge.clipboardView.mock.calls.length).toBe(callsBefore + 1));
    expect(document.querySelector(".clip-item.removing")).toBeNull();
  });

  it("删除失败时提示错误，不显示成功也不进入退出动画", async () => {
    const user = userEvent.setup();
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");

    bridge.clipboardDeleteItems.mockRejectedValueOnce(new Error("数据库被占用"));
    await user.click(screen.getAllByRole("button", { name: "删除" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "删除这条剪贴板历史？" });
    await user.click(await within(dialog).findByRole("button", { name: "删除" }));

    await waitFor(() => expect(useUiStore.getState().toast?.message).toContain("数据库被占用"));
    expect(useUiStore.getState().toast?.kind).toBe("error");
    expect(document.querySelector(".clip-item.removing")).toBeNull();
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

/**
 * 操作反馈与离场链（页面与抽屉共用同一套实现）。
 *
 * jsdom 不跑 CSS 动画，这里只能验证**结构与状态**：谁在离场、离场期间数据怎么变、
 * 提示说了什么。真实过渡是否顺滑必须在桌面端人眼验收，不能用这些用例代替。
 */
describe("操作反馈与离场", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  function viewOfItems(items: ClipboardItem[]): ClipboardView {
    return { ...makeView(0), items, total_items: items.length };
  }

  function makeGroup(id = "cg1", name = "调试截图") {
    return {
      id,
      name,
      kind: "image",
      item_count: 3,
      image_count: 0,
      mode: "manual",
      status: "closed",
      favorite: false,
      pinned: false,
      preview: "",
      created_at: "2026-10-29T00:00:00Z",
      updated_at: "2026-10-29T00:00:00Z",
    };
  }

  const cards = () => Array.from(document.querySelectorAll<HTMLElement>("[data-clip-id]"));
  const removingCard = () =>
    document.querySelector<HTMLElement>(".clip-item.removing, .clip-group-card.removing");

  it("离场期间收到静默刷新：被删卡片仍钉在原位，刷新不会落出第二份", async () => {
    const user = userEvent.setup();
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");

    await user.click(screen.getAllByRole("button", { name: "删除" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "删除这条剪贴板历史？" });
    await user.click(await within(dialog).findByRole("button", { name: "删除" }));
    await waitFor(() => expect(bridge.clipboardDeleteItems).toHaveBeenCalledWith(["ci0"]));
    expect(document.querySelector(".clip-item.removing")).toBeTruthy();

    // 动画期间后端采集事件到达：服务端结果里 ci0 已消失、多了一条新内容 ci9
    bridge.clipboardView.mockResolvedValue(viewOfItems([makeItem(1), makeItem(2), makeItem(9)]));
    await useClipboardStore.getState().load({ silent: true });

    expect(cards().map((c) => c.dataset.clipId)).toEqual(["ci0", "ci1", "ci2", "ci9"]);
    expect(document.querySelectorAll('[data-clip-id="ci0"]')).toHaveLength(1);
    expect(removingCard()?.dataset.clipId).toBe("ci0");

    await waitFor(() => expect(useClipboardStore.getState().exiting).toEqual({}));
    await waitFor(() => expect(document.querySelector(".clip-item.removing")).toBeNull());
    await waitFor(() => expect(cards().map((c) => c.dataset.clipId)).toEqual(["ci1", "ci2", "ci9"]));
  });

  it("两条预览完全相同时，离场与提示都落在按 ID 选中的那一条", async () => {
    const user = userEvent.setup();
    const twin = (id: string): ClipboardItem => ({ ...makeItem(0), id, preview: "同样的周报正文" });
    bridge.clipboardView.mockResolvedValue(viewOfItems([twin("ciA"), twin("ciB")]));
    render(<ClipboardPanel />);
    expect((await screen.findAllByText("同样的周报正文")).length).toBe(2);

    await user.click(screen.getAllByRole("button", { name: "删除" })[1]);
    const dialog = await screen.findByRole("dialog", { name: "删除这条剪贴板历史？" });
    await user.click(await within(dialog).findByRole("button", { name: "删除" }));

    await waitFor(() => expect(bridge.clipboardDeleteItems).toHaveBeenCalledWith(["ciB"]));
    expect(removingCard()?.dataset.clipId).toBe("ciB");
    expect(document.querySelector('[data-clip-id="ciA"]')?.classList.contains("removing")).toBe(false);
    await waitFor(() => expect(useUiStore.getState().toast?.message).toContain("同样的周报正文"));
  });

  it("批量删除只成功一部分：如实报数并立即重新同步，不整批演离场", async () => {
    const user = userEvent.setup();
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");
    const callsBefore = bridge.clipboardView.mock.calls.length;

    const checks = screen.getAllByRole("button", { name: "选择条目" });
    await user.click(checks[0]);
    await user.click(checks[1]);
    bridge.clipboardDeleteItems.mockResolvedValueOnce({
      deleted: 1,
      freed_bytes: 20,
      retained_shared: 1,
      groups_deleted: 0,
    });

    await user.click(screen.getByRole("button", { name: "删除所选" }));
    const dialog = await screen.findByRole("dialog", { name: "删除选中的 2 条历史？" });
    await user.click(await within(dialog).findByRole("button", { name: "删除所选" }));

    await waitFor(() => expect(bridge.clipboardDeleteItems).toHaveBeenCalledWith(["ci0", "ci1"]));
    await waitFor(() =>
      expect(useUiStore.getState().toast?.message).toContain("选中 2 条，实际删除 1 条"),
    );
    expect(useUiStore.getState().toast?.kind).toBe("warning");
    expect(useUiStore.getState().toast?.message).not.toContain("已删除 2 条");
    // 分不清哪条没删掉，就不能给整批播成功离场
    expect(document.querySelector(".clip-item.removing")).toBeNull();
    expect(useClipboardStore.getState().exiting).toEqual({});
    await waitFor(() => expect(bridge.clipboardView.mock.calls.length).toBe(callsBefore + 1));
  });

  it("删除请求在途：卡片标记执行中并禁用操作，重复点击不会二次提交", async () => {
    const user = userEvent.setup();
    const pending = deferred<DeleteReport>();
    bridge.clipboardDeleteItems.mockReturnValueOnce(pending.promise);
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");

    await user.click(screen.getAllByRole("button", { name: "删除" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "删除这条剪贴板历史？" });
    await user.click(await within(dialog).findByRole("button", { name: "删除" }));
    await waitFor(() => expect(bridge.clipboardDeleteItems).toHaveBeenCalledTimes(1));

    const card = document.querySelector<HTMLElement>('[data-clip-id="ci0"]')!;
    expect(card.classList.contains("pending")).toBe(true);
    expect(card.getAttribute("aria-busy")).toBe("true");
    const delBtn = within(card).getByRole("button", { name: "删除" }) as HTMLButtonElement;
    const copyBtn = within(card).getByRole("button", { name: "复制" }) as HTMLButtonElement;
    expect(delBtn.disabled).toBe(true);
    expect(copyBtn.disabled).toBe(true);
    fireEvent.click(delBtn);
    expect(bridge.clipboardDeleteItems).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();

    pending.resolve({ deleted: 1, freed_bytes: 20, retained_shared: 0, groups_deleted: 0 });
    await waitFor(() => expect(document.querySelector(".clip-item.removing")).toBeTruthy());
    expect(card.classList.contains("pending")).toBe(false);
  });

  it("后端一条都没删掉时只提示并刷新，绝不演一场成功", async () => {
    const user = userEvent.setup();
    bridge.clipboardDeleteItems.mockResolvedValueOnce({ deleted: 0, freed_bytes: 0, retained_shared: 0, groups_deleted: 0 });
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");

    await user.click(screen.getAllByRole("button", { name: "删除" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "删除这条剪贴板历史？" });
    await user.click(await within(dialog).findByRole("button", { name: "删除" }));

    await waitFor(() => expect(useUiStore.getState().toast?.kind).toBe("warning"));
    expect(useUiStore.getState().toast?.message).toContain("已经不存在");
    expect(useUiStore.getState().toast?.message).not.toContain("已删除");
    expect(useClipboardStore.getState().exiting).toEqual({});
    expect(document.querySelector(".clip-item.removing")).toBeNull();
  });

  it("系统「减少动态」下不播动画，也不靠动画时长拖延数据同步", async () => {
    const user = userEvent.setup();
    const mm = vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
    } as unknown as MediaQueryList);
    try {
      render(<ClipboardPanel />);
      await screen.findByText("第 0 条剪贴板预览");
      const callsBefore = bridge.clipboardView.mock.calls.length;

      await user.click(screen.getAllByRole("button", { name: "删除" })[0]);
      const dialog = await screen.findByRole("dialog", { name: "删除这条剪贴板历史？" });
      await user.click(await within(dialog).findByRole("button", { name: "删除" }));
      await waitFor(() => expect(bridge.clipboardDeleteItems).toHaveBeenCalledWith(["ci0"]));

      // 不等满 EXIT_MS：一个宏任务内就该放开钉住并触发静默刷新
      await new Promise((r) => setTimeout(r, 0));
      expect(useClipboardStore.getState().exiting).toEqual({});
      expect(document.querySelector(".clip-item.removing")).toBeNull();
      await waitFor(() => expect(bridge.clipboardView.mock.calls.length).toBe(callsBefore + 1));
      expect(useUiStore.getState().toast?.message).toContain("已删除");
    } finally {
      mm.mockRestore();
    }
  });

  it("离场期间切换筛选：旧列表里的被删条目不会被钉进新筛选结果", async () => {
    const user = userEvent.setup();
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");

    await user.click(screen.getAllByRole("button", { name: "删除" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "删除这条剪贴板历史？" });
    await user.click(await within(dialog).findByRole("button", { name: "删除" }));
    await waitFor(() => expect(useClipboardStore.getState().exiting["ci0"]).toBeTruthy());

    const image = { ...makeItem(7), id: "ciimg", kind: "image" as const };
    bridge.clipboardView.mockResolvedValue(viewOfItems([image]));
    await user.click(screen.getByRole("button", { name: "图片" }));

    await waitFor(() => expect(cards().map((c) => c.dataset.clipId)).toEqual(["ciimg"]));
    expect(useClipboardStore.getState().exiting).toEqual({});
  });

  it("删掉当前聚焦的卡片后，焦点交给相邻卡片而不是丢给页面", async () => {
    const user = userEvent.setup();
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");

    const first = document.querySelector<HTMLElement>('[data-clip-id="ci0"]')!;
    first.focus();
    await user.click(within(first).getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog", { name: "删除这条剪贴板历史？" });
    // 删除成功后服务端不再返回 ci0
    bridge.clipboardView.mockResolvedValue(viewOfItems([makeItem(1), makeItem(2)]));
    await user.click(await within(dialog).findByRole("button", { name: "删除" }));

    await waitFor(() => expect(useClipboardStore.getState().exiting).toEqual({}));
    await waitFor(() => expect(cards().map((c) => c.dataset.clipId)).toEqual(["ci1", "ci2"]));
    expect((document.activeElement as HTMLElement).dataset.clipId).toBe("ci1");
  });

  it("只看收藏里取消收藏：图标就地翻转，说的是退出筛选而不是删除", async () => {
    const user = userEvent.setup();
    // 后端读模型：切换命令提交后，后续读取返回新状态（命令与读取在同一连接上串行）
    let favorite = true;
    const fav: ClipboardItem = { ...makeItem(0), id: "cif", favorite: true };
    bridge.clipboardView.mockImplementation(async () =>
      viewOfItems([{ ...fav, favorite }, makeItem(1)]),
    );
    bridge.clipboardToggleItem.mockImplementation(async (id: string, flag: string) => {
      if (flag === "favorite") favorite = false;
      return { ...fav, id, favorite };
    });
    useClipboardStore.setState({ filters: { kind: "all", search: "", favorite: true } });
    render(<ClipboardPanel />);

    const card = (await screen.findByText("第 0 条剪贴板预览")).closest<HTMLElement>("[data-clip-id]")!;
    await user.click(within(card).getByRole("button", { name: "取消收藏" }));

    await waitFor(() => expect(bridge.clipboardToggleItem).toHaveBeenCalledWith("cif", "favorite"));
    await waitFor(() =>
      expect(useClipboardStore.getState().view?.items.find((i) => i.id === "cif")?.favorite).toBe(false),
    );
    expect(within(card).getByRole("button", { name: "收藏" })).toBeTruthy();
    await waitFor(() => expect(useUiStore.getState().toast?.kind).toBe("success"));
    expect(useUiStore.getState().toast?.message).toContain("退出「只看收藏」列表");
    expect(useUiStore.getState().toast?.message).toContain("内容仍保留在历史中");
    // 退出筛选不是删除：不进入场动画、不钉行
    expect(document.querySelector(".clip-item.removing")).toBeNull();
    expect(useClipboardStore.getState().exiting).toEqual({});
  });

  it("删除分组：分组卡离场，报告 deleted=0 也算成功且说清条目仍保留", async () => {
    const user = userEvent.setup();
    bridge.clipboardView.mockResolvedValue({
      ...viewOfItems([makeItem(0)]),
      groups: [makeGroup()] as unknown as ClipboardView["groups"],
    });
    bridge.clipboardDeleteGroup.mockResolvedValue({ deleted: 0, freed_bytes: 0, retained_shared: 0, groups_deleted: 1 });
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");

    await user.click(screen.getByRole("tab", { name: /分组/ }));
    await user.click(await screen.findByRole("button", { name: "删除分组" }));
    const dialog = await screen.findByRole("dialog", { name: "删除分组「调试截图」？" });
    expect(dialog.textContent).toContain("分组内的历史条目仍保留");
    await user.click(await within(dialog).findByRole("button", { name: "删除分组" }));

    await waitFor(() => expect(bridge.clipboardDeleteGroup).toHaveBeenCalledWith("cg1", false));
    expect(removingCard()?.dataset.clipId).toBe("cg1");
    await waitFor(() => expect(useUiStore.getState().toast?.kind).toBe("success"));
    expect(useUiStore.getState().toast?.message).toContain("分组「调试截图」已删除");
    expect(useUiStore.getState().toast?.message).toContain("历史条目仍保留");
  });

  it("抽屉形态走同一条离场链（页面与抽屉不是两套实现）", async () => {
    const user = userEvent.setup();
    render(<ClipboardWorkspace variant="drawer" active onClose={vi.fn()} />);
    await screen.findByText("第 0 条剪贴板预览");

    await user.click(screen.getAllByRole("button", { name: "删除" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "删除这条剪贴板历史？" });
    await user.click(await within(dialog).findByRole("button", { name: "删除" }));

    await waitFor(() => expect(bridge.clipboardDeleteItems).toHaveBeenCalledWith(["ci0"]));
    expect(removingCard()?.dataset.clipId).toBe("ci0");
    await waitFor(() => expect(useClipboardStore.getState().exiting).toEqual({}));
    expect(useUiStore.getState().toast?.message).toContain("已删除");
  });

  it("动画中途关闭抽屉：store 收尾离场状态，重开抽屉不会复活已删条目", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ClipboardWorkspace variant="drawer" active onClose={vi.fn()} />);
    await screen.findByText("第 0 条剪贴板预览");

    await user.click(screen.getAllByRole("button", { name: "删除" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "删除这条剪贴板历史？" });
    await user.click(await within(dialog).findByRole("button", { name: "删除" }));
    await waitFor(() => expect(useClipboardStore.getState().exiting["ci0"]).toBeTruthy());

    // 离场没播完就卸载抽屉；组件定时器随之销毁，收尾必须由 store 完成
    unmount();
    // 服务端结果里 ci0 已不存在
    bridge.clipboardView.mockResolvedValue(viewOfItems([makeItem(1), makeItem(2)]));

    await waitFor(() => expect(useClipboardStore.getState().exiting).toEqual({}));
    expect(useClipboardStore.getState().view?.items.map((i) => i.id)).toEqual(["ci1", "ci2"]);

    // 重新打开抽屉：以服务端数据为准，已删条目不以快照形式复活
    render(<ClipboardWorkspace variant="drawer" active onClose={vi.fn()} />);
    await screen.findByText("第 1 条剪贴板预览");
    expect(screen.queryByText("第 0 条剪贴板预览")).toBeNull();
  });

  it("离场卡片键盘不可达：勾选按钮禁用、整卡 inert、自身不可聚焦", async () => {
    const user = userEvent.setup();
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");

    await user.click(screen.getAllByRole("button", { name: "删除" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "删除这条剪贴板历史？" });
    await user.click(await within(dialog).findByRole("button", { name: "删除" }));
    await waitFor(() => expect(removingCard()?.dataset.clipId).toBe("ci0"));

    const card = removingCard()!;
    // aria-hidden 的子树里不允许残留可聚焦元素：inert + 全部内部控件禁用
    expect(card.hasAttribute("inert")).toBe(true);
    expect(card.getAttribute("tabindex")).toBe("-1");
    for (const btn of card.querySelectorAll<HTMLButtonElement>("button")) {
      expect(btn.disabled).toBe(true);
    }
  });

  it("置顶后列表按新顺序重排（FLIP 位移由浏览器播放，数据顺序立即正确）", async () => {
    const user = userEvent.setup();
    render(<ClipboardPanel />);
    await screen.findByText("第 0 条剪贴板预览");

    bridge.clipboardToggleItem.mockResolvedValue({ ...makeItem(2), pinned: true });
    // 置顶后的静默刷新返回新顺序：ci2 排到最前
    bridge.clipboardView.mockResolvedValue(
      viewOfItems([makeItem(2), makeItem(0), makeItem(1)]),
    );
    await user.click(
      within(document.querySelector<HTMLElement>('[data-clip-id="ci2"]')!).getByRole("button", {
        name: "置顶",
      }),
    );

    await waitFor(() =>
      expect(cards().map((c) => c.dataset.clipId)).toEqual(["ci2", "ci0", "ci1"]),
    );
    expect(useUiStore.getState().toast?.message).toContain("已置顶");
  });
});
