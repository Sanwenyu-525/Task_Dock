/**
 * @vitest-environment jsdom
 */
//! 「复制并切换到目标窗口」完整面板。
//!
//! 业务顺序与竞态由共享 hook/lib 持有，这里锁面板契约：
//! - 目标列表加载/失败重试/空列表，不自动选第一个窗口；
//! - 选择目标 = 立即执行 precheck → copy → focus，且**绝不**调用逐项粘贴接口；
//! - 复制失败不切换、列表仍在、可重试；
//! - 已复制但切换失败时只重试切换（不再复制），仍可改选其他目标；
//! - 部分成功（stats_recorded=false）如实标注且不本地累加使用次数；
//! - 条目已不存在时提示返回刷新，不自动复制。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const bridge = vi.hoisted(() => ({
  clipboardVisibleTargets: vi.fn(),
  clipboardTargetIcon: vi.fn(),
  clipboardPastePrecheck: vi.fn(),
  clipboardCopyItem: vi.fn(),
  clipboardFocusTarget: vi.fn(),
  // 面板绝不能走逐项粘贴：保留同名 mock 用于断言「零调用」
  clipboardPasteItems: vi.fn(),
  clipboardPasteGroup: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  applyWindowMaterial: vi.fn(),
}));
vi.mock("../../lib/bridge", () => bridge);

import CopySwitchPanel from "./CopySwitchPanel";
import type { ClipboardItem, ClipboardView, CopyReport, PasteTarget } from "../../lib/bridge";
import { useClipboardStore } from "../../store/useClipboardStore";

const TARGETS: PasteTarget[] = [
  { hwnd: 101, pid: 1001, title: "记事本", exe_path: "C:\\Windows\\notepad.exe" },
  { hwnd: 202, pid: 2002, title: "VS Code", exe_path: "C:\\Apps\\Code.exe" },
];

const COPY_OK: CopyReport = {
  mode: "text",
  bytes: 20,
  warnings: [],
  sequence: 1,
  item_count: 1,
  stats_recorded: true,
};

function makeItem(): ClipboardItem {
  return {
    id: "ci1",
    kind: "text",
    text: "",
    html: "",
    preview: "复制并切换的内容",
    title: "待复制条目",
    title_source: "manual",
    byte_size: 20,
    source_app: "notepad.exe",
    source_title: "记事本",
    image_width: null,
    image_height: null,
    file_paths: [],
    favorite: false,
    pinned: false,
    copy_count: 1,
    created_at: "2026-11-06T00:00:00Z",
    last_seen_at: "2026-11-06T00:00:00Z",
    has_image: false,
    has_thumb: false,
  };
}

function makeView(item: ClipboardItem): ClipboardView {
  return {
    items: [item],
    groups: [],
    stats: {
      items: 1,
      groups: 0,
      images: 0,
      files: 0,
      favorites: 0,
      bytes: 20,
      asset_bytes: 0,
      max_items: 5000,
      max_storage_bytes: 0,
      enabled: true,
      paused: false,
      auto_group: true,
    },
    total_items: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.clipboardVisibleTargets.mockResolvedValue(TARGETS);
  // 图标属于增强信息：统一回退通用图标，不阻塞选择。
  bridge.clipboardTargetIcon.mockResolvedValue(null);
  // 目标身份校验/切换都按 HWND 返回对应窗口，反馈文案才是用户真正选的那个
  bridge.clipboardPastePrecheck.mockImplementation(
    async (hwnd: number) => TARGETS.find((t) => t.hwnd === hwnd)!,
  );
  bridge.clipboardCopyItem.mockResolvedValue(COPY_OK);
  bridge.clipboardFocusTarget.mockImplementation(
    async (hwnd: number) => TARGETS.find((t) => t.hwnd === hwnd)!,
  );
  useClipboardStore.setState({ view: makeView(makeItem()) });
});

afterEach(() => {
  cleanup();
  useClipboardStore.setState({ view: null });
});

async function renderPanel() {
  const onBack = vi.fn();
  render(<CopySwitchPanel item={makeItem()} onBack={onBack} />);
  await screen.findByText("记事本");
  return { onBack };
}

function targetRow(name: RegExp) {
  return screen.getByRole("button", { name });
}

describe("CopySwitchPanel 目标选择与执行顺序", () => {
  it("加载目标后不自动选第一个；点击目标立即 precheck → copy → focus，且不调用粘贴接口", async () => {
    await renderPanel();
    expect(bridge.clipboardPastePrecheck).not.toHaveBeenCalled();
    expect(bridge.clipboardCopyItem).not.toHaveBeenCalled();
    expect(bridge.clipboardFocusTarget).not.toHaveBeenCalled();
    // 点下即执行，不是「先选中再确认」：不得出现单选语义
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(document.querySelector("[aria-checked]")).toBeNull();
    expect(screen.getByText("选择目标后复制并切换窗口；不会自动粘贴，也不会发送 Ctrl+V。")).toBeTruthy();

    fireEvent.click(targetRow(/VS Code/));
    expect(await screen.findByText(/已复制并切换到「VS Code」/)).toBeTruthy();

    expect(bridge.clipboardPastePrecheck).toHaveBeenCalledWith(202, 2002);
    expect(bridge.clipboardCopyItem).toHaveBeenCalledWith("ci1");
    expect(bridge.clipboardFocusTarget).toHaveBeenCalledWith(202, 2002);
    const precheck = bridge.clipboardPastePrecheck.mock.invocationCallOrder[0];
    const copy = bridge.clipboardCopyItem.mock.invocationCallOrder[0];
    const focus = bridge.clipboardFocusTarget.mock.invocationCallOrder[0];
    expect(precheck).toBeLessThan(copy);
    expect(copy).toBeLessThan(focus);

    // 只复制 + 切换：没有逐项粘贴、没有分组粘贴
    expect(bridge.clipboardPasteItems).not.toHaveBeenCalled();
    expect(bridge.clipboardPasteGroup).not.toHaveBeenCalled();
  });

  it("点击行右侧箭头同样执行操作，且一次点击只复制一次、切换一次", async () => {
    await renderPanel();
    const row = targetRow(/记事本/);
    const arrow = row.querySelector(".clip-target-state");
    // 箭头不是独立控件而是整行按钮内部的图示：不存在第二个可聚焦/可点击入口
    expect(arrow).not.toBeNull();
    expect(arrow!.closest("button")).toBe(row);
    expect(screen.getAllByRole("button", { name: /记事本/ })).toHaveLength(1);

    fireEvent.click(arrow!);
    expect(await screen.findByText(/已复制并切换到「记事本」/)).toBeTruthy();
    expect(bridge.clipboardPastePrecheck).toHaveBeenCalledTimes(1);
    expect(bridge.clipboardCopyItem).toHaveBeenCalledTimes(1);
    expect(bridge.clipboardFocusTarget).toHaveBeenCalledTimes(1);
  });

  it("执行中只有目标行显示处理中，其他目标禁用", async () => {
    let finishCopy: (r: CopyReport) => void = () => {};
    bridge.clipboardCopyItem.mockImplementation(
      () => new Promise<CopyReport>((resolve) => {
        finishCopy = resolve;
      }),
    );
    await renderPanel();

    fireEvent.click(targetRow(/记事本/));
    await waitFor(() => expect(bridge.clipboardCopyItem).toHaveBeenCalledTimes(1));
    expect(targetRow(/VS Code/)).toHaveProperty("disabled", true);
    expect(targetRow(/记事本/).getAttribute("aria-busy")).toBe("true");

    finishCopy(COPY_OK);
    expect(await screen.findByText(/已复制并切换到「记事本」/)).toBeTruthy();
    expect(targetRow(/VS Code/)).toHaveProperty("disabled", false);
  });
});

describe("CopySwitchPanel 结果反馈", () => {
  it("复制失败：不切换、显示错误、列表仍在且可重试", async () => {
    bridge.clipboardCopyItem.mockRejectedValueOnce("剪贴板写入失败");
    await renderPanel();

    fireEvent.click(targetRow(/记事本/));
    expect(await screen.findByText(/复制失败，未切换窗口/)).toBeTruthy();
    expect(bridge.clipboardFocusTarget).not.toHaveBeenCalled();
    // 目标列表仍在，直接再点是重试
    expect(targetRow(/记事本/)).toBeTruthy();

    bridge.clipboardCopyItem.mockResolvedValueOnce(COPY_OK);
    fireEvent.click(targetRow(/记事本/));
    await waitFor(() => expect(bridge.clipboardCopyItem).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/已复制并切换到「记事本」/)).toBeTruthy();
    expect(bridge.clipboardFocusTarget).toHaveBeenCalledTimes(1);
  });

  it("已复制但切换失败：只重试切换，不重复复制；仍可改选其他目标", async () => {
    const user = userEvent.setup();
    bridge.clipboardFocusTarget.mockRejectedValueOnce("目标窗口已关闭或句柄被复用");
    await renderPanel();

    fireEvent.click(targetRow(/记事本/));
    expect(await screen.findByText(/内容已复制，但未能切换窗口/)).toBeTruthy();
    expect(bridge.clipboardCopyItem).toHaveBeenCalledTimes(1);
    // 其他目标仍可选择
    expect(targetRow(/VS Code/)).toHaveProperty("disabled", false);

    // 仅重试切换：copy 不增加，focus 变成第二次
    bridge.clipboardFocusTarget.mockResolvedValueOnce(TARGETS[0]);
    await user.click(screen.getByRole("button", { name: /仅重试切换/ }));
    await waitFor(() => expect(bridge.clipboardFocusTarget).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/已复制并切换到「记事本」/)).toBeTruthy();
    expect(bridge.clipboardCopyItem).toHaveBeenCalledTimes(1);
  });

  it("部分成功（stats_recorded=false）：文案含「部分成功」，不本地累加使用次数", async () => {
    bridge.clipboardCopyItem.mockResolvedValueOnce({
      ...COPY_OK,
      stats_recorded: false,
      warnings: ["使用次数未能记录（统计写入失败），不影响本次复制"],
    });
    await renderPanel();

    fireEvent.click(targetRow(/记事本/));
    expect(await screen.findByText(/部分成功/)).toBeTruthy();
    expect(screen.getByText(/已复制并切换到「记事本」/)).toBeTruthy();
    expect(useClipboardStore.getState().view?.items[0].copy_count).toBe(1);
    expect(bridge.clipboardFocusTarget).toHaveBeenCalledTimes(1);
  });

  it("完全成功且统计落库时才本地 +1", async () => {
    await renderPanel();
    fireEvent.click(targetRow(/记事本/));
    await screen.findByText(/已复制并切换到「记事本」/);
    expect(useClipboardStore.getState().view?.items[0].copy_count).toBe(2);
  });

  it("条目已不存在：提示返回刷新，不自动复制", async () => {
    bridge.clipboardCopyItem.mockRejectedValueOnce({ code: "NOT_FOUND", message: "剪贴板条目不存在" });
    await renderPanel();
    expect(bridge.clipboardCopyItem).not.toHaveBeenCalled();

    fireEvent.click(targetRow(/记事本/));
    expect(await screen.findByText(/该条目已不存在/)).toBeTruthy();
    expect(screen.getByText(/未复制任何内容/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "返回并刷新" })).toBeTruthy();
    expect(bridge.clipboardFocusTarget).not.toHaveBeenCalled();
    // 提示后不自动重试复制
    expect(bridge.clipboardCopyItem).toHaveBeenCalledTimes(1);
  });
});

describe("CopySwitchPanel 目标列表状态", () => {
  it("读取失败显示错误与重试；重试成功后恢复正常列表", async () => {
    bridge.clipboardVisibleTargets.mockRejectedValueOnce("窗口枚举失败");
    render(<CopySwitchPanel item={makeItem()} onBack={vi.fn()} />);

    expect(await screen.findByText(/读取窗口列表失败：窗口枚举失败/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /记事本/ })).toBeNull();

    bridge.clipboardVisibleTargets.mockResolvedValueOnce(TARGETS);
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(await screen.findByRole("button", { name: /记事本/ })).toBeTruthy();
    expect(bridge.clipboardVisibleTargets).toHaveBeenCalledTimes(2);
  });

  it("没有可见窗口时给出明确提示，不伪造目标", async () => {
    bridge.clipboardVisibleTargets.mockResolvedValueOnce([]);
    render(<CopySwitchPanel item={makeItem()} onBack={vi.fn()} />);

    expect(await screen.findByText(/未发现其他可见窗口/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /记事本/ })).toBeNull();
    expect(bridge.clipboardCopyItem).not.toHaveBeenCalled();
  });

  it("刷新按钮重新读取目标列表", async () => {
    const user = userEvent.setup();
    await renderPanel();
    await user.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(bridge.clipboardVisibleTargets).toHaveBeenCalledTimes(2));
  });

  it("返回按钮只回调 onBack，不触发复制", async () => {
    const user = userEvent.setup();
    const { onBack } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "返回列表" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(bridge.clipboardCopyItem).not.toHaveBeenCalled();
  });
});
