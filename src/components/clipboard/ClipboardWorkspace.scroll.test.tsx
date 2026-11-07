/**
 * @vitest-environment jsdom
 */
//! 历史列表滚动稳定性 + 复制结果一致性（P2-1 / P2-2）。
//!
//! jsdom 没有真实布局，这里用一次受控的 getBoundingClientRect 模拟
//! 「固定行高 + 单一滚动容器 .clip-body」，验证滚动锚点补偿的实际行为：
//! 外部新增历史不跳顶、筛选切换回顶且不恢复旧位置、详情往返恢复位置、
//! 复制不改变浏览位置；同时验证统计失败时显示「部分成功」且不本地加次数。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const bridge = vi.hoisted(() => ({
  clipboardView: vi.fn(),
  clipboardStatus: vi.fn(),
  onClipboardChanged: vi.fn(),
  clipboardCopyItem: vi.fn(),
  clipboardCopyItemsRich: vi.fn(),
  clipboardCopyItemsFiles: vi.fn(),
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
  clipboardItem: vi.fn(),
  clipboardVisibleTargets: vi.fn(),
  clipboardTargetIcon: vi.fn(),
  clipboardPastePrecheck: vi.fn(),
  clipboardFocusTarget: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...bridge };
});

import ClipboardWorkspace from "./ClipboardWorkspace";
import type { ClipboardItem, ClipboardView } from "../../lib/bridge";
import { useClipboardStore, resetClipboardRequestState } from "../../store/useClipboardStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";

/** 模拟布局：每行 60px，滚动容器顶部为 0。 */
const ROW_H = 60;

function rect(top: number, height = ROW_H) {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 600,
    width: 600,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as unknown as DOMRect;
}

let originalRect: (this: HTMLElement) => DOMRect;

function makeItem(i: number, prefix = "ci"): ClipboardItem {
  return {
    id: `${prefix}${i}`,
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

function makeView(count = 120, prefix = "ci"): ClipboardView {
  return {
    items: Array.from({ length: count }, (_, i) => makeItem(i, prefix)),
    groups: [],
    stats: {
      items: count,
      groups: 0,
      images: 0,
      files: 0,
      favorites: 0,
      bytes: count * 20,
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

function bodyEl() {
  return document.querySelector<HTMLElement>(".clip-body")!;
}

function scrollTo(top: number) {
  const body = bodyEl();
  body.scrollTop = top;
  fireEvent.scroll(body);
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
    stats_recorded: true,
  });
  bridge.clipboardItem.mockImplementation(async (id: string) => {
    const n = Number(id.replace(/^\D+/, ""));
    return makeItem(Number.isFinite(n) ? n : 0);
  });
  bridge.clipboardVisibleTargets.mockResolvedValue([
    { hwnd: 101, pid: 1001, title: "记事本", exe_path: "C:\\Windows\\notepad.exe" },
  ]);
  bridge.clipboardTargetIcon.mockResolvedValue(null);
  bridge.clipboardPastePrecheck.mockResolvedValue({
    hwnd: 101,
    pid: 1001,
    title: "记事本",
    exe_path: "C:\\Windows\\notepad.exe",
  });
  bridge.clipboardFocusTarget.mockResolvedValue({
    hwnd: 101,
    pid: 1001,
    title: "记事本",
    exe_path: "C:\\Windows\\notepad.exe",
  });
  useClipboardStore.setState({
    view: makeView(),
    filters: { kind: "all", search: "", favorite: false },
    section: "items",
    searchText: "",
    loading: false,
    loadingMore: false,
    error: null,
    selectedItems: [],
    selectedGroups: [],
    exiting: {},
  });
  useSettingsStore.setState({ settings: { clipboard_enabled: true, clipboard_paused: false } as never });
  useUiStore.setState({ tab: "clipboard", clipboardOpen: false, clipboardLinkTask: null, toast: null });

  // 受控布局：.clip-body 是滚动容器，行按文档顺序排列。
  originalRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("clip-body")) return rect(0, 400);
    if (this.classList.contains("clip-item")) {
      const body = this.closest<HTMLElement>(".clip-body");
      const rows = Array.from(body?.querySelectorAll<HTMLElement>(".clip-item") ?? []);
      return rect(rows.indexOf(this) * ROW_H - (body?.scrollTop ?? 0));
    }
    return rect(0, 0);
  };
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  cleanup();
  useUiStore.setState({ tab: "tasks", clipboardOpen: false, toast: null });
  useSettingsStore.setState({ settings: null });
});

async function mount() {
  render(<ClipboardWorkspace variant="page" active={true} />);
  await waitFor(() => expect(document.querySelectorAll(".clip-item").length).toBeGreaterThan(20));
}

describe("历史列表滚动稳定性", () => {
  it("外部新增历史时保持当前可见内容，不跳顶也不覆盖新内容", async () => {
    await mount();
    scrollTo(1200);
    expect(bodyEl().scrollTop).toBe(1200);

    // 后台采集到一条更新的历史：它排在列表最前面，旧内容整体下移一行
    const fresh = makeView(120);
    act(() => {
      useClipboardStore.setState({
        view: { ...fresh, items: [makeItem(999, "new"), ...fresh.items] },
      });
    });
    // 新行插入后浏览器本身没有布局，这里由补偿逻辑把滚动位置下移一行
    expect(bodyEl().scrollTop).toBe(1200 + ROW_H);
    const anchor = document.querySelector<HTMLElement>('[data-clip-id="ci20"]');
    expect(anchor).toBeTruthy();
    expect(anchor!.getBoundingClientRect().top).toBe(0);
    // 视图顶部仍是用户原来正在看的那一条，而不是被强行回顶
    expect(bodyEl().scrollTop).toBeGreaterThan(0);
  }, 20000);

  it("位于顶部时新增历史正常显示最新内容（不做补偿）", async () => {
    await mount();
    scrollTo(0);
    const fresh = makeView(120);
    act(() => {
      useClipboardStore.setState({
        view: { ...fresh, items: [makeItem(999, "new"), ...fresh.items] },
      });
    });
    expect(bodyEl().scrollTop).toBe(0);
  }, 20000);

  it("复制中部旧条目只更新次数，不改变滚动位置与顺序", async () => {
    const user = userEvent.setup();
    await mount();
    scrollTo(1200);
    const copyButtons = screen.getAllByRole("button", { name: "复制" });
    await user.click(copyButtons[20]);
    await waitFor(() =>
      expect(useClipboardStore.getState().view?.items[20].copy_count).toBe(2),
    );
    expect(bodyEl().scrollTop).toBe(1200);
    expect(useClipboardStore.getState().view?.items.map((i) => i.id).slice(19, 21)).toEqual([
      "ci19",
      "ci20",
    ]);
  }, 20000);

  it("详情往返恢复原滚动位置；筛选切换回顶且不恢复旧筛选位置", async () => {
    const user = userEvent.setup();
    await mount();
    scrollTo(600);

    await user.click(screen.getAllByRole("button", { name: "详情" })[10]);
    await waitFor(() => expect(screen.getByRole("button", { name: "返回列表" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "返回列表" }));
    await waitFor(() => expect(document.querySelectorAll(".clip-item").length).toBeGreaterThan(20));
    expect(bodyEl().scrollTop).toBe(600);

    // 筛选切换允许回顶；新筛选的响应回来也不能把旧位置/旧锚点带过去
    scrollTo(600);
    bridge.clipboardView.mockResolvedValueOnce(makeView(30, "img"));
    await user.click(screen.getByRole("button", { name: "图片" }));
    await waitFor(() =>
      expect(useClipboardStore.getState().view?.items[0]?.id).toBe("img0"),
    );
    expect(bodyEl().scrollTop).toBe(0);
  }, 20000);

  it("复制并切换面板往返恢复原滚动位置，且不整表刷新列表", async () => {
    const user = userEvent.setup();
    await mount();
    const viewCallsBefore = bridge.clipboardView.mock.calls.length;
    scrollTo(600);

    // 卡片跳转箭头 → 完整面板（走既有 setDetail，记录滚动位置）；不再经过菜单
    await user.click(screen.getAllByRole("button", { name: "复制或粘贴到目标窗口" })[10]);
    expect(await screen.findByText("复制或粘贴到…")).toBeTruthy();
    // 只是枚举目标窗口，没有重新加载/重排历史
    expect(bridge.clipboardView.mock.calls.length).toBe(viewCallsBefore);
    expect(useClipboardStore.getState().view?.items[0].id).toBe("ci0");

    await user.click(screen.getByRole("button", { name: "返回列表" }));
    await waitFor(() => expect(document.querySelectorAll(".clip-item").length).toBeGreaterThan(20));
    expect(bodyEl().scrollTop).toBe(600);
  }, 20000);
});

describe("复制结果一致性（P2-1）", () => {
  it("统计未落库时显示部分成功、保留已复制的勾选/Toast，且不本地累加次数", async () => {
    const user = userEvent.setup();
    bridge.clipboardCopyItem.mockResolvedValueOnce({
      mode: "text",
      bytes: 20,
      warnings: ["使用次数未能记录（统计写入失败），不影响本次复制"],
      sequence: 1,
      item_count: 1,
      stats_recorded: false,
    });
    await mount();
    const before = useClipboardStore.getState().view?.items[0].copy_count;

    await user.click(screen.getAllByRole("button", { name: "复制" })[0]);
    await waitFor(() => expect(useUiStore.getState().toast?.message).toContain("部分成功"));
    // 写入成功：不能显示「复制失败」
    expect(useUiStore.getState().toast?.kind).not.toBe("error");
    expect(useClipboardStore.getState().view?.items[0].copy_count).toBe(before);

    // 统计正常时才本地累加，顺序不变
    bridge.clipboardCopyItem.mockResolvedValueOnce({
      mode: "text",
      bytes: 20,
      warnings: [],
      sequence: 2,
      item_count: 1,
      stats_recorded: true,
    });
    await user.click(screen.getAllByRole("button", { name: "复制" })[0]);
    await waitFor(() => expect(useUiStore.getState().toast?.message).toContain("已复制"));
    expect(useUiStore.getState().toast?.kind).toBe("success");
    expect(useClipboardStore.getState().view?.items[0].copy_count).toBe((before ?? 1) + 1);
  }, 20000);
});
