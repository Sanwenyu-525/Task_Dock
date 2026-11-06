/**
 * @vitest-environment jsdom
 */
//! 胶囊「复制并切换到目标窗口」回归：
//! 入口分体按钮（复制 ≠ 打开视图）、目标列表只枚举一次、precheck→copy→focus 顺序、
//! 失败分支（复制失败 / 切换失败 / 条目不存在）、Escape 与滚动恢复、卸载竞态。
//!
//! 所有 IPC 走 bridge mock；不触发真实系统剪贴板、窗口切换或逐项粘贴。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ClipboardItem, PasteTarget } from "../../lib/bridge";
import { overlayStack, registerOverlay, resetOverlayStack } from "../../lib/overlayStack";
import { resetClipboardRequestState, useClipboardStore } from "../../store/useClipboardStore";
import { useUiStore } from "../../store/useUiStore";
import ClipboardLite from "./ClipboardLite";
import ClipboardTargetView from "./ClipboardTargetView";

const clipboardView = vi.fn();
const clipboardGroupPage = vi.fn();
const clipboardGroupItemPosition = vi.fn();
const clipboardCopyItem = vi.fn();
const clipboardCopyGroupRich = vi.fn();
const clipboardStatus = vi.fn();
const clipboardItem = vi.fn();
const clipboardImage = vi.fn();
const clipboardThumb = vi.fn();
const clipboardVisibleTargets = vi.fn();
const clipboardPasteActive = vi.fn();
const clipboardGroup = vi.fn();
const clipboardPastePrecheck = vi.fn();
const clipboardFocusTarget = vi.fn();
const clipboardPasteItems = vi.fn();
const clipboardPasteGroup = vi.fn();
const clipboardTargetIcon = vi.fn();

vi.mock("../../lib/bridge", () => ({
  onClipboardChanged: async () => () => {},
  onClipboardPaste: async () => () => {},
  clipboardView: (...a: unknown[]) => clipboardView(...a),
  clipboardGroupPage: (...a: unknown[]) => clipboardGroupPage(...a),
  clipboardGroupItemPosition: (...a: unknown[]) => clipboardGroupItemPosition(...a),
  clipboardCopyItem: (...a: unknown[]) => clipboardCopyItem(...a),
  clipboardCopyGroupRich: (...a: unknown[]) => clipboardCopyGroupRich(...a),
  clipboardStatus: (...a: unknown[]) => clipboardStatus(...a),
  clipboardItem: (...a: unknown[]) => clipboardItem(...a),
  clipboardImage: (...a: unknown[]) => clipboardImage(...a),
  clipboardThumb: (...a: unknown[]) => clipboardThumb(...a),
  clipboardVisibleTargets: (...a: unknown[]) => clipboardVisibleTargets(...a),
  clipboardPasteActive: (...a: unknown[]) => clipboardPasteActive(...a),
  clipboardGroup: (...a: unknown[]) => clipboardGroup(...a),
  clipboardPastePrecheck: (...a: unknown[]) => clipboardPastePrecheck(...a),
  clipboardFocusTarget: (...a: unknown[]) => clipboardFocusTarget(...a),
  clipboardPasteItems: (...a: unknown[]) => clipboardPasteItems(...a),
  clipboardPasteGroup: (...a: unknown[]) => clipboardPasteGroup(...a),
  clipboardTargetIcon: (...a: unknown[]) => clipboardTargetIcon(...a),
  applyMode: async () => undefined,
}));

const now = new Date("2026-11-06T10:00:00+08:00").getTime();
const iso = (ms: number) => new Date(ms).toISOString();

function item(over: Partial<ClipboardItem> & { id: string }): ClipboardItem {
  return {
    kind: "text",
    text: "",
    html: "",
    preview: "",
    title: "",
    title_source: "none",
    byte_size: 0,
    source_app: "",
    source_title: "",
    image_width: null,
    image_height: null,
    file_paths: [],
    favorite: false,
    pinned: false,
    copy_count: 0,
    created_at: iso(now),
    last_seen_at: iso(now),
    has_image: false,
    has_thumb: false,
    ...over,
  };
}

function textItem(id: string, title: string): ClipboardItem {
  return item({ id, kind: "text", title, preview: title, byte_size: 8 });
}

function view(items: ClipboardItem[]) {
  return { items, groups: [], stats: {}, total_items: items.length };
}

function targetOf(hwnd: number, pid: number, title: string): PasteTarget {
  return { hwnd, pid, title, exe_path: "C:\\Apps\\Fixture.exe" };
}

const REPORT = { mode: "text", bytes: 1, warnings: [], sequence: 1, item_count: 1 };

beforeEach(() => {
  clipboardView.mockReset();
  clipboardGroupPage.mockReset();
  clipboardGroupItemPosition.mockReset();
  clipboardCopyItem.mockReset();
  clipboardCopyGroupRich.mockReset();
  clipboardStatus.mockReset();
  clipboardItem.mockReset();
  clipboardImage.mockReset();
  clipboardThumb.mockReset();
  clipboardVisibleTargets.mockReset();
  clipboardPasteActive.mockReset();
  clipboardGroup.mockReset();
  clipboardPastePrecheck.mockReset();
  clipboardFocusTarget.mockReset();
  clipboardPasteItems.mockReset();
  clipboardPasteGroup.mockReset();
  clipboardTargetIcon.mockReset();

  clipboardView.mockResolvedValue(view([]));
  clipboardGroupPage.mockResolvedValue({ items: [], totalCount: 0, imageCount: 0, offset: 0 });
  clipboardGroupItemPosition.mockResolvedValue({
    found: false,
    index: null,
    imageCount: 0,
    totalCount: 0,
    revision: "r0",
  });
  clipboardVisibleTargets.mockResolvedValue([]);
  clipboardPasteActive.mockResolvedValue(null);
  clipboardGroup.mockResolvedValue({ items: [] });
  clipboardPastePrecheck.mockImplementation(async (hwnd: number, pid: number) =>
    targetOf(hwnd, pid, "目标"),
  );
  clipboardCopyItem.mockResolvedValue(REPORT);
  clipboardCopyGroupRich.mockResolvedValue(REPORT);
  clipboardFocusTarget.mockImplementation(async (hwnd: number, pid: number) =>
    targetOf(hwnd, pid, "目标"),
  );
  clipboardTargetIcon.mockResolvedValue(null);
  clipboardThumb.mockResolvedValue(null);
  clipboardImage.mockResolvedValue(null);
  clipboardStatus.mockResolvedValue({
    enabled: true,
    paused: false,
    monitoring: true,
    activeJob: null,
    platform: "windows",
    configError: null,
    configOrigin: null,
    captureAllowed: true,
  });

  resetOverlayStack();
  resetClipboardRequestState();
  useClipboardStore.setState({
    lite: null,
    liteLoading: false,
    liteStatus: "loading",
    liteError: null,
    liteActive: false,
    monitor: "checking",
  });
  useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  resetOverlayStack();
});

describe("列表行入口", () => {
  it("点箭头只打开视图不复制；点复制只复制不打开视图", async () => {
    const content = textItem("entry-1", "文本一");
    clipboardView.mockResolvedValue(view([content]));
    clipboardVisibleTargets.mockResolvedValue([targetOf(101, 1001, "记事本")]);
    render(<ClipboardLite />);
    await screen.findByText("文本一");

    fireEvent.click(screen.getByRole("button", { name: "复制并切换到目标窗口" }));
    await screen.findByRole("button", { name: "复制并切换到「记事本」" });
    expect(clipboardCopyItem).not.toHaveBeenCalled();
    // 视图打开时列表整体被替换，主区域不再是可点详情入口
    expect(screen.queryByRole("button", { name: "查看「文本一」" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await screen.findByText("文本一");

    fireEvent.click(screen.getByRole("button", { name: "复制「文本一」" }));
    await waitFor(() => expect(clipboardCopyItem).toHaveBeenCalledWith("entry-1"));
    expect(screen.queryByRole("button", { name: "复制并切换到「记事本」" })).toBeNull();
  });

  it("入口箭头是跳转语义：ArrowUpRight、直接进入视图，不是折叠菜单", async () => {
    const content = textItem("icon-1", "文本图标");
    clipboardView.mockResolvedValue(view([content]));
    clipboardVisibleTargets.mockResolvedValue([targetOf(101, 1001, "记事本")]);
    render(<ClipboardLite />);
    await screen.findByText("文本图标");

    const entry = screen.getByRole("button", { name: "复制并切换到目标窗口" });
    expect(entry.getAttribute("aria-haspopup")).toBeNull();
    expect(entry.querySelector("svg")?.getAttribute("class")).toContain("lucide-arrow-up-right");

    fireEvent.click(entry);
    await screen.findByText("复制并切换到…");
    // 只有箭头打开选择器：没有弹出菜单、没有提前复制
    expect(screen.queryByRole("menu")).toBeNull();
    expect(clipboardCopyItem).not.toHaveBeenCalled();
  });

  it("点主区域仍打开原详情视图，不进入复制并切换", async () => {
    const content = textItem("entry-2", "文本二");
    clipboardView.mockResolvedValue(view([content]));
    clipboardItem.mockResolvedValue({ ...content, text: "完整内容二" });
    render(<ClipboardLite />);
    await screen.findByText("文本二");

    fireEvent.click(screen.getByRole("button", { name: "查看「文本二」" }));
    await screen.findByText("完整内容二");
    expect(screen.queryByRole("button", { name: "复制并切换到目标窗口" })).toBeNull();
    expect(clipboardVisibleTargets).not.toHaveBeenCalled();
  });
});

describe("目标选择视图", () => {
  it("目标列表来自 clipboardVisibleTargets；挂载只枚举一次，重渲染不重复", async () => {
    clipboardVisibleTargets.mockResolvedValue([
      targetOf(101, 1001, "记事本"),
      targetOf(202, 2002, "画图"),
    ]);
    const onBack = vi.fn();
    const content = textItem("list-1", "文本列表");
    const { rerender } = render(
      <ClipboardTargetView item={content} active onBack={onBack} />,
    );

    await screen.findByText("记事本");
    expect(screen.getByText("画图")).toBeTruthy();
    expect(clipboardVisibleTargets).toHaveBeenCalledTimes(1);

    rerender(<ClipboardTargetView item={content} active onBack={onBack} />);
    expect(clipboardVisibleTargets).toHaveBeenCalledTimes(1);
  });

  it("点目标按 precheck → copy → focus 执行，且不调用任何逐项粘贴接口", async () => {
    const target = targetOf(101, 1001, "记事本");
    clipboardVisibleTargets.mockResolvedValue([target]);
    clipboardPastePrecheck.mockResolvedValue(target);
    clipboardCopyItem.mockResolvedValue(REPORT);
    clipboardFocusTarget.mockResolvedValue(target);
    render(<ClipboardTargetView item={textItem("order-1", "顺序")} active onBack={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "复制并切换到「记事本」" }));
    await screen.findByText("已复制并切换到「记事本」");

    expect(clipboardPastePrecheck).toHaveBeenCalledWith(101, 1001);
    expect(clipboardCopyItem).toHaveBeenCalledWith("order-1");
    expect(clipboardFocusTarget).toHaveBeenCalledWith(101, 1001);
    const pre = clipboardPastePrecheck.mock.invocationCallOrder[0];
    const copy = clipboardCopyItem.mock.invocationCallOrder[0];
    const focus = clipboardFocusTarget.mock.invocationCallOrder[0];
    expect(pre).toBeLessThan(copy);
    expect(copy).toBeLessThan(focus);
    expect(clipboardPasteItems).not.toHaveBeenCalled();
    expect(clipboardPasteGroup).not.toHaveBeenCalled();
    expect(screen.queryByText(/部分成功/)).toBeNull();
  });

  it("复制失败：停留本页、不切换窗口、错误可见且可重试", async () => {
    const target = targetOf(101, 1001, "记事本");
    clipboardVisibleTargets.mockResolvedValue([target]);
    clipboardPastePrecheck.mockResolvedValue(target);
    clipboardCopyItem.mockRejectedValue(new Error("剪贴板写入被拒绝"));
    render(<ClipboardTargetView item={textItem("fail-1", "失败")} active onBack={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "复制并切换到「记事本」" }));
    await screen.findByText(/复制失败，未切换窗口/);
    expect(clipboardFocusTarget).not.toHaveBeenCalled();
    // 仍停留在本页：目标行仍在，可换目标或重试
    expect(screen.getByRole("button", { name: "复制并切换到「记事本」" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(clipboardCopyItem).toHaveBeenCalledTimes(2));
    expect(clipboardFocusTarget).not.toHaveBeenCalled();
  });

  it("切换失败：保留已复制结果；仅重试切换不会再次复制", async () => {
    const target = targetOf(101, 1001, "记事本");
    clipboardVisibleTargets.mockResolvedValue([target]);
    clipboardPastePrecheck.mockResolvedValue(target);
    clipboardCopyItem.mockResolvedValue(REPORT);
    clipboardFocusTarget.mockRejectedValue(new Error("前台切换被拒绝"));
    render(<ClipboardTargetView item={textItem("focus-1", "切换")} active onBack={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "复制并切换到「记事本」" }));
    await screen.findByText(/内容已复制，但未能切换窗口/);

    fireEvent.click(screen.getByRole("button", { name: "仅重试切换" }));
    await waitFor(() => expect(clipboardFocusTarget).toHaveBeenCalledTimes(2));
    expect(clipboardCopyItem).toHaveBeenCalledTimes(1);
    // 仍显示「已复制但切换失败」，不回退为复制失败
    expect(screen.getByText(/内容已复制，但未能切换窗口/)).toBeTruthy();
  });

  it("部分成功沿用 hook 文案（含「部分成功」）", async () => {
    const target = targetOf(101, 1001, "记事本");
    clipboardVisibleTargets.mockResolvedValue([target]);
    clipboardPastePrecheck.mockResolvedValue(target);
    clipboardCopyItem.mockResolvedValue({ ...REPORT, stats_recorded: false });
    render(<ClipboardTargetView item={textItem("partial-1", "部分")} active onBack={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "复制并切换到「记事本」" }));
    await screen.findByText(/部分成功/);
    expect(screen.getByText(/使用次数未记录/)).toBeTruthy();
    expect(screen.queryByText(/复制失败/)).toBeNull();
  });

  it("条目不存在：提示条目已不存在、不显示成功，并刷新轻量列表", async () => {
    const target = targetOf(101, 1001, "记事本");
    const content = textItem("missing-1", "消失的条目");
    clipboardView.mockResolvedValue(view([content]));
    clipboardVisibleTargets.mockResolvedValue([target]);
    clipboardPastePrecheck.mockResolvedValue(target);
    clipboardCopyItem.mockRejectedValue({ code: "NOT_FOUND", message: "clipboard item not found" });
    render(<ClipboardLite />);
    await screen.findByText("消失的条目");

    fireEvent.click(screen.getByRole("button", { name: "复制并切换到目标窗口" }));
    fireEvent.click(await screen.findByRole("button", { name: "复制并切换到「记事本」" }));

    await screen.findByText(/条目已不存在/);
    expect(screen.queryByText(/已复制并切换到/)).toBeNull();
    expect(clipboardFocusTarget).not.toHaveBeenCalled();
    await waitFor(() => expect(clipboardView.mock.calls.length).toBeGreaterThan(1));

    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    await screen.findByText("消失的条目");
  });

  it("空列表提示先打开目标应用", async () => {
    clipboardVisibleTargets.mockResolvedValue([]);
    render(<ClipboardTargetView item={textItem("empty-1", "空")} active onBack={vi.fn()} />);
    await screen.findByText("没有可切换的窗口，请先打开目标应用");
    expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
  });

  it("枚举失败显示错误与重试，重试成功后展示目标", async () => {
    clipboardVisibleTargets
      .mockRejectedValueOnce(new Error("窗口枚举失败"))
      .mockResolvedValueOnce([targetOf(101, 1001, "记事本")]);
    render(<ClipboardTargetView item={textItem("err-1", "错误")} active onBack={vi.fn()} />);

    await screen.findByText(/读取窗口列表失败：窗口枚举失败/);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("记事本");
    expect(clipboardVisibleTargets).toHaveBeenCalledTimes(2);
  });
});

describe("Escape 与滚动恢复", () => {
  it("Escape 只返回列表，面板层仍在；再按一次才关面板层", async () => {
    const content = textItem("esc-1", "文本 Esc");
    clipboardView.mockResolvedValue(view([content]));
    clipboardVisibleTargets.mockResolvedValue([targetOf(101, 1001, "记事本")]);
    const drawerEscape = vi.fn();
    registerOverlay({ kind: "drawer", onEscape: drawerEscape, blocksAutoHide: false });
    render(<ClipboardLite />);
    await screen.findByText("文本 Esc");

    fireEvent.click(screen.getByRole("button", { name: "复制并切换到目标窗口" }));
    await screen.findByRole("button", { name: "复制并切换到「记事本」" });

    act(() => fireEvent.keyDown(window, { key: "Escape" }));
    await screen.findByText("文本 Esc");
    expect(screen.queryByRole("button", { name: "复制并切换到「记事本」" })).toBeNull();
    expect(drawerEscape).not.toHaveBeenCalled();

    act(() => fireEvent.keyDown(window, { key: "Escape" }));
    expect(drawerEscape).toHaveBeenCalledTimes(1);
  });

  it("点目标行右侧箭头同样执行，一次点击只复制一次、切换一次", async () => {
    const target = targetOf(101, 1001, "记事本");
    clipboardVisibleTargets.mockResolvedValue([target]);
    clipboardPastePrecheck.mockResolvedValue(target);
    clipboardCopyItem.mockResolvedValue(REPORT);
    clipboardFocusTarget.mockResolvedValue(target);
    render(<ClipboardTargetView item={textItem("arrow-1", "箭头")} active onBack={vi.fn()} />);

    // 箭头是真实按钮（不是无事件的 span），且有独立命中区
    const arrow = await screen.findByRole("button", { name: "复制并切换到该窗口" });
    expect(arrow.tagName).toBe("BUTTON");
    expect(arrow.hasAttribute("disabled")).toBe(false);

    fireEvent.click(arrow);
    await screen.findByText("已复制并切换到「记事本」");

    expect(clipboardPastePrecheck).toHaveBeenCalledTimes(1);
    expect(clipboardCopyItem).toHaveBeenCalledTimes(1);
    expect(clipboardFocusTarget).toHaveBeenCalledTimes(1);
    expect(clipboardPasteItems).not.toHaveBeenCalled();
    expect(clipboardPasteGroup).not.toHaveBeenCalled();
  });

  it("返回列表后恢复列表滚动位置", async () => {
    const items = Array.from({ length: 12 }, (_, i) => textItem(`scroll-${i}`, `条目 ${i}`));
    clipboardView.mockResolvedValue(view(items));
    clipboardVisibleTargets.mockResolvedValue([]);
    const { container } = render(<ClipboardLite />);
    await screen.findByText("条目 3");

    const list = container.querySelector(".cap-list") as HTMLDivElement;
    list.scrollTop = 120;

    const arrows = screen.getAllByRole("button", { name: "复制并切换到目标窗口" });
    fireEvent.click(arrows[3]);
    await screen.findByText("复制并切换到…");

    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await screen.findByText("条目 3");
    await waitFor(() =>
      expect((container.querySelector(".cap-list") as HTMLDivElement).scrollTop).toBe(120),
    );
  });
});

describe("卸载竞态", () => {
  it("卸载后迟到的目标枚举结果不写回、不残留弹层；重新打开重新枚举", async () => {
    const content = textItem("unmount-1", "文本 Unmount");
    clipboardView.mockResolvedValue(view([content]));
    let resolveTargets: ((list: PasteTarget[]) => void) | null = null;
    clipboardVisibleTargets.mockImplementation(
      () =>
        new Promise<PasteTarget[]>((resolve) => {
          resolveTargets = resolve;
        }),
    );

    const first = render(<ClipboardLite />);
    await screen.findByText("文本 Unmount");
    fireEvent.click(screen.getByRole("button", { name: "复制并切换到目标窗口" }));
    await screen.findByText("正在读取可见窗口…");
    expect(overlayStack().length).toBeGreaterThan(0);

    first.unmount();
    expect(overlayStack()).toHaveLength(0);

    await act(async () => {
      resolveTargets?.([targetOf(101, 1001, "记事本")]);
      await Promise.resolve();
    });
    // 迟到的结果没有写进任何仍挂载的视图
    expect(screen.queryByText("记事本")).toBeNull();

    render(<ClipboardLite />);
    await screen.findByText("文本 Unmount");
    fireEvent.click(screen.getByRole("button", { name: "复制并切换到目标窗口" }));
    await screen.findByText("正在读取可见窗口…");
    expect(clipboardVisibleTargets).toHaveBeenCalledTimes(2);
    expect(clipboardCopyItem).not.toHaveBeenCalled();
  });

  it("关闭视图后迟到的枚举响应不会把目标列表写回列表页", async () => {
    const content = textItem("close-1", "文本 Close");
    clipboardView.mockResolvedValue(view([content]));
    let resolveTargets: ((list: PasteTarget[]) => void) | null = null;
    clipboardVisibleTargets.mockImplementation(
      () =>
        new Promise<PasteTarget[]>((resolve) => {
          resolveTargets = resolve;
        }),
    );

    render(<ClipboardLite />);
    await screen.findByText("文本 Close");
    fireEvent.click(screen.getByRole("button", { name: "复制并切换到目标窗口" }));
    await screen.findByText("正在读取可见窗口…");
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    await screen.findByText("文本 Close");

    await act(async () => {
      resolveTargets?.([targetOf(101, 1001, "记事本")]);
      await Promise.resolve();
    });
    expect(screen.queryByText("记事本")).toBeNull();
    expect(screen.getByText("文本 Close")).toBeTruthy();
  });
});

describe("目标行组件接入", () => {
  it("执行中只有当前行显示处理中，其他行禁用", async () => {
    const firstTarget = targetOf(101, 1001, "记事本");
    const secondTarget = targetOf(202, 2002, "画图");
    clipboardVisibleTargets.mockResolvedValue([firstTarget, secondTarget]);
    clipboardPastePrecheck.mockResolvedValue(firstTarget);
    clipboardCopyItem.mockResolvedValue(REPORT);
    let resolveFocus: ((value: PasteTarget) => void) | null = null;
    clipboardFocusTarget.mockImplementation(
      () =>
        new Promise<PasteTarget>((resolve) => {
          resolveFocus = resolve;
        }),
    );
    render(<ClipboardTargetView item={textItem("busy-1", "忙碌")} active onBack={vi.fn()} />);

    const first = await screen.findByRole("button", { name: "复制并切换到「记事本」" });
    const second = screen.getByRole("button", { name: "复制并切换到「画图」" });
    fireEvent.click(first);

    await waitFor(() => expect(first.getAttribute("aria-busy")).toBe("true"));
    expect(first.hasAttribute("disabled")).toBe(true);
    expect(second.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      resolveFocus?.(firstTarget);
      await Promise.resolve();
    });
    await screen.findByText("已复制并切换到「记事本」");
    expect(first.hasAttribute("disabled")).toBe(false);
    expect(second.hasAttribute("disabled")).toBe(false);
  });
});
