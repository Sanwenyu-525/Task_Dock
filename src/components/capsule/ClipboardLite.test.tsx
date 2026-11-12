/**
 * @vitest-environment jsdom
 */
//! 剪贴板 Lite 二级视图（A1–A4）回归：图片预览 / 文本查看 / 文件列表 / 截图组预览，
//! 以及 Escape 只关最上层的 overlayStack 行为。只跑本文件，不触碰其它面板用例。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ClipboardGroup, ClipboardGroupPage, ClipboardItem } from "../../lib/bridge";
import { overlayStack, registerOverlay, resetOverlayStack } from "../../lib/overlayStack";
import { resetClipboardRequestState, useClipboardStore } from "../../store/useClipboardStore";
import { useUiStore } from "../../store/useUiStore";
import ClipboardLite from "./ClipboardLite";
import ClipboardPanel from "../clipboard/ClipboardPanel";
import { registerTabGuard } from "../../lib/tabGuard";
import { clearGroupPageCache, groupPageCacheKey, loadGroupPage } from "./ClipboardLiteViews";
import { PanelCloseProvider } from "./panelClose";

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

vi.mock("../../lib/bridge", () => ({
  onClipboardChanged: async () => () => {},
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
  onClipboardPaste: async () => () => {},
  applyMode: async () => undefined,
}));

const now = new Date("2026-11-04T10:00:00+08:00").getTime();
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

function group(over: Partial<ClipboardGroup> & { id: string }): ClipboardGroup {
  return {
    name: "",
    mode: "auto",
    status: "collecting",
    favorite: false,
    pinned: false,
    created_at: iso(now),
    updated_at: iso(now),
    closed_at: null,
    item_count: 0,
    image_count: 0,
    preview: "",
    items: [],
    ...over,
  };
}

function view(items: ClipboardItem[], groups: ClipboardGroup[] = []) {
  return {
    items,
    groups,
    stats: {},
    total_items: items.length + groups.length,
  };
}

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
  clipboardCopyItem.mockResolvedValue({ mode: "text", bytes: 1, warnings: [], sequence: 1 });
  clipboardCopyGroupRich.mockResolvedValue({ mode: "text", bytes: 1, warnings: [], sequence: 1 });
  clipboardThumb.mockResolvedValue(null);
  clearGroupPageCache();
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

describe("A1 图片点击放大预览", () => {
  it("未点击不预加载；点击缩略图后在面板内显示原图与底部操作", async () => {
    const img = item({
      id: "lite-img-a",
      kind: "image",
      title: "截图 A",
      has_image: true,
      has_thumb: true,
      image_width: 1280,
      image_height: 720,
      byte_size: 900_000,
    });
    clipboardView.mockResolvedValue(view([img]));
    clipboardImage.mockResolvedValue("data:image/png;base64,LITE-A");
    render(<ClipboardLite />);

    await screen.findByText("截图 A");
    expect(clipboardImage).not.toHaveBeenCalled(); // 原图按需加载

    fireEvent.click(screen.getByRole("button", { name: "查看大图" }));
    const image = await screen.findByRole("img", { name: "剪贴板图片预览" });
    expect(image.getAttribute("src")).toBe("data:image/png;base64,LITE-A");
    expect(clipboardImage).toHaveBeenCalledWith("lite-img-a");
    expect(screen.getByRole("button", { name: "返回列表" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制图片" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开完整剪贴板" })).toBeTruthy();
  });

  it("读取失败显示错误；返回后恢复列表", async () => {
    const img = item({
      id: "lite-img-b",
      kind: "image",
      title: "截图 B",
      has_image: true,
      has_thumb: true,
      image_width: 800,
      image_height: 600,
    });
    clipboardView.mockResolvedValue(view([img]));
    clipboardImage.mockRejectedValue("read failed");
    render(<ClipboardLite />);
    await screen.findByText("截图 B");

    fireEvent.click(screen.getByRole("button", { name: "查看大图" }));
    await waitFor(() => expect(screen.getByText(/图片读取失败：read failed/)).toBeTruthy());
    expect(screen.queryByRole("img", { name: "剪贴板图片预览" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    await screen.findByText("截图 B");
    expect(screen.queryByText(/图片读取失败/)).toBeNull();
  });

  it("原图缺失时显示缺失状态", async () => {
    const img = item({
      id: "lite-img-c",
      kind: "image",
      title: "截图 C",
      has_image: true,
      has_thumb: true,
      image_width: 640,
      image_height: 480,
    });
    clipboardView.mockResolvedValue(view([img]));
    clipboardImage.mockResolvedValue(null);
    render(<ClipboardLite />);
    await screen.findByText("截图 C");

    fireEvent.click(screen.getByRole("button", { name: "查看大图" }));
    await waitFor(() => expect(screen.getByText("图片文件缺失或已被清理")).toBeTruthy());
  });
});

describe("A2 文本快速查看", () => {
  it("按需读完整正文；超长文本截断渲染并提示完整页", async () => {
    const text = item({
      id: "lite-text-a",
      kind: "text",
      title: "长文本",
      preview: "前 80 字预览",
      byte_size: 120_000,
    });
    clipboardView.mockResolvedValue(view([text]));
    clipboardItem.mockResolvedValue({
      ...text,
      text: "字".repeat(25_000),
      preview: "前 80 字预览",
    });
    render(<ClipboardLite />);
    await screen.findByText("长文本");

    fireEvent.click(screen.getByRole("button", { name: "查看「长文本」" }));
    const pre = await screen.findByText((_, el) => el?.tagName === "PRE" && el.textContent?.length === 20_000);
    expect(pre.textContent?.length).toBe(20_000);
    expect(screen.getAllByText(/仅显示前 20000 字/).length).toBeGreaterThan(0);
    expect(clipboardItem).toHaveBeenCalledWith("lite-text-a");

    fireEvent.click(screen.getByRole("button", { name: "复制文本" }));
    await waitFor(() => expect(clipboardCopyItem).toHaveBeenCalledWith("lite-text-a"));
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain("已复制文本");

    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    await screen.findByText("长文本");
  });

  it("完整正文读取失败时给出错误与重试", async () => {
    const text = item({ id: "lite-text-b", kind: "text", title: "文本 B", preview: "预览" });
    clipboardView.mockResolvedValue(view([text]));
    clipboardItem.mockRejectedValueOnce({ code: "NOT_FOUND", message: "gone" });
    render(<ClipboardLite />);
    await screen.findByText("文本 B");

    fireEvent.click(screen.getByRole("button", { name: "查看「文本 B」" }));
    await waitFor(() => expect(screen.getByText(/读取完整内容失败：/)).toBeTruthy());

    clipboardItem.mockResolvedValueOnce({ ...text, text: "完整内容" });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText("完整内容")).toBeTruthy());
  });
});

describe("A3 文件基础查看", () => {
  it("显示文件名、数量与复制文件列表，不触发额外读取", async () => {
    const files = item({
      id: "lite-files-a",
      kind: "files",
      title: "三个文件",
      file_paths: ["C:\\work\\a.png", "C:\\work\\b.pdf", "C:\\work\\c.txt"],
      byte_size: 40_000,
    });
    clipboardView.mockResolvedValue(view([files]));
    render(<ClipboardLite />);
    await screen.findByText("三个文件");

    fireEvent.click(screen.getByRole("button", { name: "查看「三个文件」" }));
    expect(screen.getByText("3 个文件")).toBeTruthy();
    expect(screen.getByText("a.png")).toBeTruthy();
    expect(screen.getByText("b.pdf")).toBeTruthy();
    expect(screen.getByText("c.txt")).toBeTruthy();
    expect(clipboardItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "复制文件列表" }));
    await waitFor(() => expect(clipboardCopyItem).toHaveBeenCalledWith("lite-files-a"));
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain("已复制文件列表");
  });
});

describe("复制结果反馈", () => {
  it("写入成功但统计失败：提示部分成功（info）并保留成功勾选", async () => {
    const text = item({ id: "lite-copy-partial", kind: "text", title: "部分成功文本" });
    clipboardView.mockResolvedValue(view([text]));
    clipboardCopyItem.mockResolvedValueOnce({
      mode: "text",
      bytes: 1,
      warnings: ["使用次数未能记录（统计写入失败），不影响本次复制"],
      sequence: 1,
      stats_recorded: false,
    });
    render(<ClipboardLite />);
    await screen.findByText("部分成功文本");

    fireEvent.click(screen.getByRole("button", { name: "复制「部分成功文本」" }));
    await waitFor(() => {
      const toast = useUiStore
        .getState()
        .toasts.find((t) => t.message.includes("已复制（部分成功"));
      expect(toast?.kind).toBe("info");
      expect(toast?.message).toContain("使用次数未记录");
    });
    // 剪贴板写入本身成功：仍显示成功勾选，不退化成「复制失败」
    expect(document.querySelector(".cap-mini.is-ok")).toBeTruthy();
  });
});

describe("A4 截图组有界预览", () => {
  const imageOf = (id: string, title: string) =>
    item({
      id,
      kind: "image",
      title,
      has_image: true,
      has_thumb: true,
      image_width: 800,
      image_height: 600,
    });
  const pageOf = (
    groupId: string,
    items: ClipboardItem[],
    totalCount = items.length,
    imageCount = items.length,
    revision = "r1",
  ): ClipboardGroupPage => ({
    groupId,
    items,
    totalCount,
    imageCount,
    offset: 0,
    limit: items.length,
    revision,
  });

  const limitOf = (call: unknown[]) => (call[1] as { limit: number }).limit;

  it("封面 limit=1、预览 limit=9、imagesOnly；总数来自后端；返回不重复请求；复制走完整命令", async () => {
    // 组摘要故意与后端真实总数不同：界面必须用 page 的 totalCount/imageCount。
    const g = group({ id: "lite-group-a", name: "截图组 A", image_count: 3, item_count: 4 });
    const images = [1, 2, 3].map((n) => imageOf(`lite-group-a-${n}`, `组图 ${n}`));
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockImplementation(
      async (id: string, opts: { limit: number; offset?: number; imagesOnly?: boolean }) =>
        pageOf(id, images.slice(0, opts.limit), 15, 12, "r1"),
    );
    clipboardImage.mockResolvedValue("data:image/png;base64,LITE-G");
    render(<ClipboardLite />);
    await screen.findByText("截图组 A");

    await waitFor(() =>
      expect(clipboardGroupPage).toHaveBeenCalledWith("lite-group-a", {
        limit: 1,
        offset: 0,
        imagesOnly: true,
      }),
    );
    expect(clipboardGroupPage.mock.calls.filter((c) => limitOf(c) === 1)).toHaveLength(1); // 封面只取 1 张

    fireEvent.click(screen.getByRole("button", { name: "预览截图组「截图组 A」" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    expect(clipboardGroupPage).toHaveBeenCalledWith("lite-group-a", {
      limit: 9,
      offset: 0,
      imagesOnly: true,
    });
    expect(screen.getByText("12 张 · 共 15 项")).toBeTruthy();
    expect(screen.getByText("共 12 张，仅显示前 3 张")).toBeTruthy();
    const previewCalls = clipboardGroupPage.mock.calls.filter((c) => limitOf(c) === 9).length;

    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 1 张图片" }));
    const image = await screen.findByRole("img", { name: "剪贴板图片预览" });
    expect(image.getAttribute("src")).toBe("data:image/png;base64,LITE-G");
    expect(clipboardImage).toHaveBeenCalledWith("lite-group-a-1");

    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    // 同一快照内返回组不重复请求
    expect(clipboardGroupPage.mock.calls.filter((c) => limitOf(c) === 9).length).toBe(previewCalls);

    fireEvent.click(screen.getByRole("button", { name: "复制整组" }));
    await waitFor(() => expect(clipboardCopyGroupRich).toHaveBeenCalledWith("lite-group-a"));
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain("已复制截图组");
  });

  it("缓存键包含组 / 分页 / 范围 / revision，任一项变化都不复用；未知 revision 不命中", () => {
    const base = groupPageCacheKey("g-key", 9, 0, true, "r1");
    expect(base).toBe("g-key|9|0|1|r1");
    expect(groupPageCacheKey("g-other", 9, 0, true, "r1")).not.toBe(base);
    expect(groupPageCacheKey("g-key", 1, 0, true, "r1")).not.toBe(base);
    expect(groupPageCacheKey("g-key", 9, 9, true, "r1")).not.toBe(base);
    expect(groupPageCacheKey("g-key", 9, 0, false, "r1")).not.toBe(base);
    expect(groupPageCacheKey("g-key", 9, 0, true, "r2")).not.toBe(base);
    expect(groupPageCacheKey("g-key", 9, 0, true, null)).toBe("");
  });

  it("同 revision 复用缓存；clear 后按新 revision 重新读取", async () => {
    const cover = imageOf("lite-group-k-1", "组图 K1");
    const g = group({ id: "lite-group-k", name: "截图组 K", image_count: 2, item_count: 2 });
    clipboardGroupPage.mockResolvedValueOnce(pageOf(g.id, [cover], 2, 2, "r1"));
    const first = await loadGroupPage(g, 1, 0, true);
    expect(first.revision).toBe("r1");
    const second = await loadGroupPage(g, 1, 0, true);
    expect(second).toBe(first); // 同 revision 命中缓存
    expect(clipboardGroupPage).toHaveBeenCalledTimes(1);

    clearGroupPageCache(); // 列表快照变化（删除/移动/分组修改）后的整体失效
    clipboardGroupPage.mockResolvedValueOnce(pageOf(g.id, [], 1, 0, "r2"));
    const third = await loadGroupPage(g, 1, 0, true);
    expect(third.revision).toBe("r2");
    expect(clipboardGroupPage).toHaveBeenCalledTimes(2);
  });

  it("列表摘要变化（删除图片）时即使 revision 未更新也不复用旧封面", async () => {
    const cover = imageOf("lite-group-s-1", "组图 S1");
    const g = group({ id: "lite-group-s", name: "截图组 S", image_count: 2, item_count: 2 });
    clipboardGroupPage.mockResolvedValueOnce(pageOf(g.id, [cover], 2, 2, "r1"));
    await loadGroupPage(g, 1, 0, true);
    // 删除一张图片后列表刷新：计数变化但后端 revision 尚未反映到缓存键
    const next = group({ ...g, image_count: 1, item_count: 1, updated_at: iso(now + 60_000) });
    clipboardGroupPage.mockResolvedValueOnce(pageOf(g.id, [], 1, 0, "r2"));
    const page = await loadGroupPage(next, 1, 0, true);
    expect(page.revision).toBe("r2");
    expect(clipboardGroupPage).toHaveBeenCalledTimes(2);
  });

  it("组内容变化（删除/分组修改）后封面与预览缓存失效并重新读取", async () => {
    const cover = imageOf("lite-group-b-1", "组图 B1");
    const g = group({ id: "lite-group-b", name: "截图组 B", image_count: 2, item_count: 2 });
    let revision = "r1";
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockImplementation(async (id: string) =>
      pageOf(id, [cover], 2, 2, revision),
    );
    const { rerender } = render(<ClipboardLite />);
    await screen.findByText("截图组 B");
    await waitFor(() => expect(clipboardGroupPage.mock.calls.filter((c) => limitOf(c) === 1)).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "预览截图组「截图组 B」" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「截图组 B」" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    expect(clipboardGroupPage.mock.calls.filter((c) => limitOf(c) === 9)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));

    // 模拟删除后列表刷新：组签名与后端 revision 都变化 → 封面与预览重新读取
    revision = "r2";
    act(() => {
      useClipboardStore.setState({
        lite: view([], [{ ...g, updated_at: iso(now + 60_000), image_count: 1, item_count: 1 }]),
      });
    });
    rerender(<ClipboardLite />);
    await waitFor(() => expect(clipboardGroupPage.mock.calls.filter((c) => limitOf(c) === 1)).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「截图组 B」" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    expect(clipboardGroupPage.mock.calls.filter((c) => limitOf(c) === 9)).toHaveLength(2);
  });

  it("快速切组：旧组的慢响应不覆盖新组内容", async () => {
    const a = group({ id: "ga", name: "组 A", image_count: 2, item_count: 2 });
    const b = group({ id: "gb", name: "组 B", image_count: 2, item_count: 2 });
    const imgA = [imageOf("a1", "A1"), imageOf("a2", "A2")];
    const imgB = [imageOf("b1", "B1"), imageOf("b2", "B2")];
    let resolveA: ((p: ClipboardGroupPage) => void) | null = null;
    clipboardView.mockResolvedValue(view([], [a, b]));
    clipboardGroupPage.mockImplementation((id: string, opts: { limit: number }) => {
      if (opts.limit === 1) {
        return Promise.resolve(pageOf(id, [id === "ga" ? imgA[0] : imgB[0]], 2, 2));
      }
      if (id === "ga") {
        return new Promise<ClipboardGroupPage>((res) => {
          resolveA = res;
        });
      }
      return Promise.resolve(pageOf(id, imgB, 2, 2, "r-b"));
    });
    clipboardImage.mockResolvedValue("data:image/png;base64,LITE-B");
    render(<ClipboardLite />);
    await screen.findByText("组 A");

    fireEvent.click(screen.getByRole("button", { name: "预览截图组「组 A」" }));
    expect(screen.getByText("正在读取截图组…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「组 B」" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    expect(screen.getByText("组 B")).toBeTruthy();

    act(() => {
      resolveA?.(pageOf("ga", imgA, 2, 2, "r-a"));
    });
    await waitFor(() =>
      expect(
        clipboardGroupPage.mock.calls.filter((c) => c[0] === "gb" && limitOf(c) === 9),
      ).toHaveLength(1),
    );
    // 仍是组 B 的数据：点第一张加载的是 b1，不是 a1
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 1 张图片" }));
    await waitFor(() => expect(clipboardImage).toHaveBeenCalledWith("b1"));
    expect(clipboardImage).not.toHaveBeenCalledWith("a1");
  });

  it("有界读取失败显示错误与重试；整组复制不依赖该查询", async () => {
    const g = group({ id: "lite-group-c", name: "截图组 C", image_count: 1, item_count: 1 });
    const img = imageOf("lite-group-c-1", "组图 C1");
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockImplementation((id: string, opts: { limit: number }) =>
      opts.limit === 1
        ? Promise.resolve(pageOf(id, [img], 1, 1))
        : Promise.reject(new Error("unsupported")),
    );
    render(<ClipboardLite />);
    await screen.findByText("截图组 C");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「截图组 C」" }));
    await waitFor(() => expect(screen.getByText(/读取截图组失败：unsupported/)).toBeTruthy());

    clipboardGroupPage.mockResolvedValueOnce(pageOf(g.id, [img], 1, 1));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });

    fireEvent.click(screen.getByRole("button", { name: "复制整组" }));
    await waitFor(() => expect(clipboardCopyGroupRich).toHaveBeenCalledWith("lite-group-c"));
  });

  it("9 张不是真实全部：明确剩余数量，按页加载更多后显示全部且返回保留", async () => {
    const g = group({ id: "lite-group-more", name: "截图组 更多", image_count: 12, item_count: 12 });
    const images = Array.from({ length: 12 }, (_, i) => imageOf(`more-${i + 1}`, `组图 ${i + 1}`));
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockImplementation(
      async (id: string, opts: { limit: number; offset?: number; imagesOnly?: boolean }) => {
        const offset = opts.offset ?? 0;
        return pageOf(id, images.slice(offset, offset + opts.limit), 12, 12, "r1");
      },
    );
    clipboardImage.mockResolvedValue("data:image/png;base64,LITE-MORE");
    render(<ClipboardLite />);
    await screen.findByText("截图组 更多");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「截图组 更多」" }));

    await screen.findByRole("button", { name: "查看截图组第 9 张图片" });
    // 首屏只到 9 张：必须说明这是真实总数的一部分，而不是组里只有 9 张。
    expect(screen.getByText("共 12 张，仅显示前 9 张")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "查看截图组第 10 张图片" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "加载更多截图，还有 3 张" }));
    await screen.findByRole("button", { name: "查看截图组第 12 张图片" });
    expect(clipboardGroupPage).toHaveBeenCalledWith("lite-group-more", {
      limit: 9,
      offset: 9,
      imagesOnly: true,
    });
    expect(screen.queryByRole("button", { name: /加载更多截图/ })).toBeNull();
    expect(screen.getByText("共 12 张，已全部显示")).toBeTruthy();

    // 打开第 12 张再返回：分页结果仍保留，不退回前 9 张。
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 12 张图片" }));
    await screen.findByRole("button", { name: "返回列表" });
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    await screen.findByRole("button", { name: "查看截图组第 12 张图片" });
    expect(screen.getByText("共 12 张，已全部显示")).toBeTruthy();
  });

  it("加载更多失败给出错误与重试，不静默停在前 9 张", async () => {
    const g = group({ id: "lite-group-fail", name: "截图组 失败", image_count: 12, item_count: 12 });
    const images = Array.from({ length: 12 }, (_, i) => imageOf(`fail-${i + 1}`, `组图 ${i + 1}`));
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockImplementation(
      async (id: string, opts: { limit: number; offset?: number }) => {
        if ((opts.offset ?? 0) > 0) throw new Error("读取超时");
        return pageOf(id, images.slice(0, opts.limit), 12, 12, "r1");
      },
    );
    render(<ClipboardLite />);
    await screen.findByText("截图组 失败");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「截图组 失败」" }));
    await screen.findByRole("button", { name: "查看截图组第 9 张图片" });

    fireEvent.click(screen.getByRole("button", { name: "加载更多截图，还有 3 张" }));
    await waitFor(() => expect(screen.getByText(/加载更多失败：读取超时/)).toBeTruthy());
    expect(screen.getByText("共 12 张，仅显示前 9 张")).toBeTruthy();

    clipboardGroupPage.mockResolvedValueOnce(pageOf(g.id, images.slice(9), 12, 12, "r1"));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByRole("button", { name: "查看截图组第 12 张图片" });
    expect(screen.queryByText(/加载更多失败/)).toBeNull();
    expect(screen.getByText("共 12 张，已全部显示")).toBeTruthy();
  });

  it("多图封面：列表直接用 cover_items 渲染 2～3 张真实缩略图，额外读取被省略", async () => {
    const covers = [1, 2, 3].map((n) => imageOf(`cover-${n}`, `封面 ${n}`));
    const g = group({
      id: "lite-group-covers",
      name: "截图组 封面",
      image_count: 5,
      item_count: 5,
      cover_items: covers,
    });
    clipboardView.mockResolvedValue(view([], [g]));
    render(<ClipboardLite />);
    await screen.findByText("截图组 封面");

    const stack = document.querySelector(".cap-stack.is-multi") as HTMLElement;
    expect(stack).toBeTruthy();
    expect(stack.querySelectorAll("i")).toHaveLength(3);
    // 封面来自列表接口，不为封面额外拉取组分页。
    expect(clipboardGroupPage).not.toHaveBeenCalled();
    await waitFor(() => expect(clipboardThumb).toHaveBeenCalledTimes(3));
  });

  it("截图组不再只显示前两组：所有有图分组都可访问", async () => {
    const groups = [1, 2, 3, 4].map((n) =>
      group({ id: `lite-group-${n}`, name: `截图组 ${n}`, image_count: 1, item_count: 1 }),
    );
    clipboardView.mockResolvedValue(view([], groups));
    render(<ClipboardLite />);
    await screen.findByText("截图组 1");
    for (const n of [1, 2, 3, 4]) {
      expect(
        screen.getByRole("button", { name: `预览截图组「截图组 ${n}」` }),
      ).toBeTruthy();
    }
  });

  it("逐项粘贴按钮在复制左侧：请求完整面板的粘贴意图并切到剪贴板页", async () => {
    const g = group({ id: "lite-group-paste", name: "截图组 粘贴", image_count: 2, item_count: 2 });
    clipboardView.mockResolvedValue(view([], [g]));
    useUiStore.setState({ clipboardPasteRequest: null, tab: "tasks" });
    render(<ClipboardLite />);
    await screen.findByText("截图组 粘贴");

    const paste = screen.getByRole("button", { name: "逐项粘贴截图组「截图组 粘贴」" });
    const copy = screen.getByRole("button", { name: "复制截图组「截图组 粘贴」" });
    // DOM 顺序：粘贴在复制之前
    expect(
      paste.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(paste);
    expect(useUiStore.getState().clipboardPasteRequest?.groupId).toBe("lite-group-paste");
    expect(useUiStore.getState().tab).toBe("clipboard");
  });

  it("未保存草稿拦截：取消导航不产生粘贴意图，确认后才打开 PastePanel", async () => {
    const g = group({ id: "lite-group-nav", name: "截图组 导航", image_count: 2, item_count: 2 });
    clipboardView.mockResolvedValue(view([], [g]));
    useUiStore.setState({ tab: "tasks", clipboardPasteRequest: null, pendingTab: null });
    const discard = vi.fn();
    const unregister = registerTabGuard({
      id: "round2-note-guard",
      label: () => "笔记",
      isDirty: () => true,
      isBusy: () => false,
      discard,
    });
    render(<ClipboardLite />);
    await screen.findByText("截图组 导航");
    const paste = screen.getByRole("button", { name: "逐项粘贴截图组「截图组 导航」" });

    // 连续点击只留下一个待确认导航，不提前写意图。
    fireEvent.click(paste);
    fireEvent.click(paste);
    expect(useUiStore.getState().pendingTab?.tab).toBe("clipboard");
    expect(useUiStore.getState().clipboardPasteRequest).toBeNull();
    expect(useUiStore.getState().tab).toBe("tasks");

    act(() => useUiStore.getState().cancelPendingTab());
    expect(useUiStore.getState().pendingTab).toBeNull();
    expect(useUiStore.getState().clipboardPasteRequest).toBeNull();

    // 再次发起并确认离开：导航成功后才写意图，完整页面消费后打开 PastePanel。
    fireEvent.click(paste);
    act(() => useUiStore.getState().confirmPendingTab());
    expect(discard).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().tab).toBe("clipboard");
    expect(useUiStore.getState().pendingTab).toBeNull();
    expect(useUiStore.getState().clipboardPasteRequest?.groupId).toBe("lite-group-nav");

    render(<ClipboardPanel />);
    expect(await screen.findByText(/逐项粘贴 · 截图组 导航/)).toBeTruthy();
    unregister();
  });

  it("当前页面保存中：拒绝导航且不留下粘贴意图", async () => {
    const g = group({ id: "lite-group-busy", name: "截图组 保存中", image_count: 1, item_count: 1 });
    clipboardView.mockResolvedValue(view([], [g]));
    useUiStore.setState({ tab: "tasks", clipboardPasteRequest: null, pendingTab: null, toast: null, toasts: [] });
    const unregister = registerTabGuard({
      id: "round2-busy-guard",
      label: () => "笔记",
      isDirty: () => false,
      isBusy: () => true,
      discard: vi.fn(),
    });
    render(<ClipboardLite />);
    await screen.findByText("截图组 保存中");
    fireEvent.click(screen.getByRole("button", { name: "逐项粘贴截图组「截图组 保存中」" }));

    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useUiStore.getState().pendingTab).toBeNull();
    expect(useUiStore.getState().clipboardPasteRequest).toBeNull();
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
      "正在保存，请等待完成后再切换页面",
    );
    unregister();
  });

  it("过期粘贴意图不会在之后进入剪贴板页时突然弹层", async () => {
    useUiStore.setState({
      tab: "clipboard",
      pendingTab: null,
      clipboardPasteRequest: {
        token: 99,
        groupId: "expired-group",
        groupName: "过期组",
        expiresAt: Date.now() - 1_000,
      },
    });
    render(<ClipboardPanel />);
    await waitFor(() => expect(useUiStore.getState().clipboardPasteRequest).toBeNull());
    expect(screen.queryByText(/逐项粘贴 · 过期组/)).toBeNull();
  });

  it("多个粘贴意图先后发生：只消费最后一次，不叠加弹层", async () => {
    const groups = [
      group({ id: "seq-intent-a", name: "意图 A", image_count: 1, item_count: 1 }),
      group({ id: "seq-intent-b", name: "意图 B", image_count: 1, item_count: 1 }),
    ];
    clipboardView.mockResolvedValue(view([], groups));
    useUiStore.setState({ tab: "tasks", clipboardPasteRequest: null, pendingTab: null });
    render(<ClipboardLite />);
    await screen.findByText("意图 A");
    fireEvent.click(screen.getByRole("button", { name: "逐项粘贴截图组「意图 A」" }));
    fireEvent.click(screen.getByRole("button", { name: "逐项粘贴截图组「意图 B」" }));
    expect(useUiStore.getState().clipboardPasteRequest?.groupId).toBe("seq-intent-b");

    render(<ClipboardPanel />);
    expect(await screen.findByText(/逐项粘贴 · 意图 B/)).toBeTruthy();
    expect(screen.queryByText(/逐项粘贴 · 意图 A/)).toBeNull();
  });

  it("目标截图组已删除：仍打开粘贴面板并如实显示分组读取失败，不崩溃", async () => {
    useUiStore.setState({
      tab: "clipboard",
      pendingTab: null,
      clipboardPasteRequest: {
        token: 100,
        groupId: "deleted-group",
        groupName: "已删除组",
        expiresAt: Date.now() + 10_000,
      },
    });
    clipboardGroup.mockRejectedValueOnce(new Error("分组已删除"));
    render(<ClipboardPanel />);
    expect(await screen.findByText(/逐项粘贴 · 已删除组/)).toBeTruthy();
    // 不进入执行状态，也没有伪造目标窗口。
    expect(screen.queryByRole("button", { name: /开始逐项粘贴/ })).toBeTruthy();
  });
});

describe("A5 截图组原图序列导航", () => {
  const imageOf = (id: string, title: string) =>
    item({
      id,
      kind: "image",
      title,
      has_image: true,
      has_thumb: true,
      image_width: 800,
      image_height: 600,
    });
  const pageOf = (
    groupId: string,
    items: ClipboardItem[],
    totalCount: number,
    imageCount: number,
    revision = "r1",
  ): ClipboardGroupPage => ({
    groupId,
    items,
    totalCount,
    imageCount,
    offset: 0,
    limit: items.length,
    revision,
  });

  it("单图组：只显示原图，不出现上一张/下一张", async () => {
    const g = group({ id: "seq-single", name: "单图组", image_count: 1, item_count: 1 });
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockResolvedValue(pageOf(g.id, [imageOf("single-1", "单图")], 1, 1));
    clipboardImage.mockResolvedValue("data:image/png;base64,SINGLE");
    render(<ClipboardLite />);
    await screen.findByText("单图组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「单图组」" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 1 张图片" }));

    expect(await screen.findByRole("img", { name: "剪贴板图片预览" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "上一张图片" })).toBeNull();
    expect(screen.queryByRole("button", { name: "下一张图片" })).toBeNull();
  });

  it("2 张图片：首尾禁用、按钮与方向键切换、序号更新", async () => {
    const g = group({ id: "seq-two", name: "两张组", image_count: 2, item_count: 2 });
    const imgs = [imageOf("two-1", "两张 1"), imageOf("two-2", "两张 2")];
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockResolvedValue(pageOf(g.id, imgs, 2, 2));
    clipboardImage.mockImplementation(async (id: string) =>
      id === "two-1" ? "data:image/png;base64,TWO-1" : "data:image/png;base64,TWO-2",
    );
    render(<ClipboardLite />);
    await screen.findByText("两张组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「两张组」" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 1 张图片" }));

    const img = await screen.findByRole("img", { name: "剪贴板图片预览" });
    expect(img.getAttribute("src")).toContain("TWO-1");
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect((screen.getByRole("button", { name: "上一张图片" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "下一张图片" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    await waitFor(() => expect(screen.getByRole("img", { name: "剪贴板图片预览" }).getAttribute("src")).toContain("TWO-2"));
    expect(screen.getByText("2 / 2")).toBeTruthy();
    expect((screen.getByRole("button", { name: "下一张图片" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() => expect(screen.getByText("1 / 2")).toBeTruthy());
    expect((await screen.findByRole("img", { name: "剪贴板图片预览" })).getAttribute("src")).toContain("TWO-1");
  });

  it("超过一页：第 9 张继续下一张时按需补页，序号按真实总数显示", async () => {
    const g = group({ id: "seq-many", name: "多图组", image_count: 12, item_count: 12 });
    const all = Array.from({ length: 12 }, (_, i) => imageOf(`many-${i + 1}`, `多图 ${i + 1}`));
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockImplementation(
      async (_id: string, opts: { limit: number; offset?: number; imagesOnly?: boolean }) => {
        const offset = opts.offset ?? 0;
        return pageOf(g.id, all.slice(offset, offset + opts.limit), 12, 12, "r1");
      },
    );
    clipboardImage.mockImplementation(async (id: string) => `data:image/png;base64,${id}`);
    render(<ClipboardLite />);
    await screen.findByText("多图组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「多图组」" }));
    await screen.findByRole("button", { name: "查看截图组第 9 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 9 张图片" }));
    expect(await screen.findByText("9 / 12")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    await screen.findByText("10 / 12");
    expect(clipboardGroupPage).toHaveBeenCalledWith("seq-many", {
      limit: 9,
      offset: 9,
      imagesOnly: true,
    });
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "剪贴板图片预览" }).getAttribute("src")).toContain("many-10"),
    );

    // 返回组视图后，预览期间补下的第 10～12 张已同步，不需要再点「加载更多」。
    fireEvent.keyDown(window, { key: "Escape" });
    await screen.findByRole("button", { name: "查看截图组第 10 张图片" });
    expect(screen.getByText("共 12 张，已全部显示")).toBeTruthy();
  });

  it("图片读取失败与文件缺失都给出明确反馈，且仍可继续切换", async () => {
    const g = group({ id: "seq-fail", name: "失败组", image_count: 2, item_count: 2 });
    const imgs = [imageOf("fail-1", "失败 1"), imageOf("fail-2", "失败 2")];
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockResolvedValue(pageOf(g.id, imgs, 2, 2));
    clipboardImage.mockImplementation(async (id: string) => {
      if (id === "fail-1") throw new Error("decode failed");
      return null;
    });
    render(<ClipboardLite />);
    await screen.findByText("失败组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「失败组」" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 1 张图片" }));
    expect(await screen.findByText(/图片读取失败/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    expect(await screen.findByText(/图片文件缺失或已被清理/)).toBeTruthy();
    expect(screen.getByText("2 / 2")).toBeTruthy();
  });

  it("快速连续切换：旧原图响应不得覆盖当前图片", async () => {
    const g = group({ id: "seq-race", name: "竞态组", image_count: 2, item_count: 2 });
    const imgs = [imageOf("race-1", "竞态 1"), imageOf("race-2", "竞态 2")];
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockResolvedValue(pageOf(g.id, imgs, 2, 2));
    let resolveFirst!: (v: string) => void;
    clipboardImage.mockImplementation(async (id: string) => {
      if (id === "race-1") {
        return new Promise<string>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return "data:image/png;base64,RACE-2";
    });
    render(<ClipboardLite />);
    await screen.findByText("竞态组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「竞态组」" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 1 张图片" }));
    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "剪贴板图片预览" }).getAttribute("src")).toContain("RACE-2"),
    );
    // 第一张迟到：不能把当前第二张替换成旧图。
    act(() => resolveFirst("data:image/png;base64,RACE-1"));
    expect((await screen.findByRole("img", { name: "剪贴板图片预览" })).getAttribute("src")).toContain("RACE-2");
    expect(screen.getByText("2 / 2")).toBeTruthy();
  });

  it("20 张组在 revision 更新后继续翻页：不反复回第一页、不重复遗漏", async () => {
    const all = Array.from({ length: 20 }, (_, i) => imageOf(`rev-${i + 1}`, `变更 ${i + 1}`));
    const g = group({ id: "seq-rev", name: "变更组", image_count: 20, item_count: 20 });
    let revision = "r1";
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockImplementation(
      async (_id: string, opts: { limit: number; offset?: number }) => {
        const offset = opts.offset ?? 0;
        return pageOf(g.id, all.slice(offset, offset + opts.limit), 20, 20, revision);
      },
    );
    // 组内容变化后当前图片可能跨页：按定位接口按 ID 找回（revision 随全局变量同步）。
    clipboardGroupItemPosition.mockImplementation(async (_gid: string, itemId: string) => ({
      found: true,
      index: all.findIndex((i) => i.id === itemId),
      imageCount: 20,
      totalCount: 20,
      revision,
    }));
    clipboardImage.mockImplementation(async (id: string) => `data:image/png;base64,${id}`);
    render(<ClipboardLite />);
    await screen.findByText("变更组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「变更组」" }));
    await screen.findByRole("button", { name: "查看截图组第 9 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 9 张图片" }));
    expect(await screen.findByText("9 / 20")).toBeTruthy();

    // 外部新增/删除图片 → 组 revision 更新；当前第 9 张仍存在，应按 ID 保持位置。
    revision = "r2";
    const updated = group({ ...g, updated_at: new Date(now + 60_000).toISOString() });
    act(() => {
      useClipboardStore.setState({ lite: view([], [updated]) });
    });
    expect(await screen.findByText(/截图组内容已变化/)).toBeTruthy();
    expect(screen.getByText("9 / 20")).toBeTruthy();

    // 继续向后翻：必须使用最新 revision，而不是每次回到第一页。
    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    expect(await screen.findByText("10 / 20")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    expect(await screen.findByText("11 / 20")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    expect(await screen.findByText("12 / 20")).toBeTruthy();
    expect(clipboardGroupPage).toHaveBeenCalledWith("seq-rev", {
      limit: 9,
      offset: 9,
      imagesOnly: true,
    });
    expect(screen.queryByText("9 / 20")).toBeNull();

    // 再次 revision 变化：仍按当前 ID 保持位置，并可继续翻页。
    revision = "r3";
    const updatedAgain = group({
      ...g,
      updated_at: new Date(now + 120_000).toISOString(),
    });
    act(() => {
      useClipboardStore.setState({ lite: view([], [updatedAgain]) });
    });
    expect(await screen.findByText("12 / 20")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    expect(await screen.findByText("13 / 20")).toBeTruthy();

    // 返回组视图后，下层组也使用新 revision 的前缀；继续加载剩余图片不会回第一页。
    fireEvent.keyDown(window, { key: "Escape" });
    await screen.findByRole("button", { name: "查看截图组第 18 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "加载更多截图，还有 2 张" }));
    await screen.findByRole("button", { name: "查看截图组第 20 张图片" });
    expect(clipboardGroupPage).toHaveBeenCalledWith("seq-rev", {
      limit: 9,
      offset: 18,
      imagesOnly: true,
    });
  });

  it("预览期间当前图片被删除：刷新序列并就近落到相邻图片，不显示已删数据", async () => {
    const first = [imageOf("del-1", "删除 1"), imageOf("del-2", "删除 2"), imageOf("del-3", "删除 3")];
    const g = group({
      id: "seq-delete",
      name: "删除组",
      image_count: 3,
      item_count: 3,
      cover_items: first,
    });
    clipboardView.mockResolvedValue(view([], [g]));
    let deleted = false;
    clipboardGroupPage.mockImplementation(async () =>
      deleted
        ? pageOf(g.id, [first[0], first[2]], 2, 2, "r2")
        : pageOf(g.id, first, 3, 3, "r1"),
    );
    clipboardImage.mockImplementation(async (id: string) => `data:image/png;base64,${id}`);
    render(<ClipboardLite />);
    await screen.findByText("删除组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「删除组」" }));
    await screen.findByRole("button", { name: "查看截图组第 2 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 2 张图片" }));
    expect(await screen.findByText("2 / 3")).toBeTruthy();

    // 组内容变化：第二张被删除，总数变为 2。预览层应按最新序列刷新并落到相邻项。
    deleted = true;
    clipboardGroupItemPosition.mockResolvedValue({
      found: false,
      index: null,
      imageCount: 2,
      totalCount: 2,
      revision: "r2",
    });
    const updated = group({
      ...g,
      image_count: 2,
      item_count: 2,
      updated_at: new Date(now + 60_000).toISOString(),
    });
    act(() => {
      useClipboardStore.setState({ lite: view([], [updated]) });
    });
    expect(await screen.findByText(/当前图片已不在截图组中/)).toBeTruthy();
    expect(screen.getByText("2 / 2")).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "剪贴板图片预览" }).getAttribute("src")).toContain("del-3"),
    );
  });

  it("当前图片前插入 2 张：仍保持原图片 ID，序号与总数反映最新结果（不静默换图）", async () => {
    const all = Array.from({ length: 20 }, (_, i) => imageOf(`ins-${i + 1}`, `插入 ${i + 1}`));
    const g = group({ id: "seq-ins", name: "插入组", image_count: 20, item_count: 20 });
    let revision = "r1";
    let images = all;
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockImplementation(
      async (_id: string, opts: { limit: number; offset?: number }) => {
        const offset = opts.offset ?? 0;
        return pageOf(g.id, images.slice(offset, offset + opts.limit), images.length, images.length, revision);
      },
    );
    clipboardImage.mockImplementation(async (id: string) => `data:image/png;base64,${id}`);
    render(<ClipboardLite />);
    await screen.findByText("插入组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「插入组」" }));
    await screen.findByRole("button", { name: "查看截图组第 9 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 9 张图片" }));
    expect(await screen.findByText("9 / 20")).toBeTruthy();
    expect((await screen.findByRole("img", { name: "剪贴板图片预览" })).getAttribute("src")).toContain("ins-9");

    // 当前图片前插入 2 张：ins-9 变为第 11 张、总数 22。必须按图片 ID 保持同一张图。
    images = [imageOf("ins-new-1", "新图 1"), imageOf("ins-new-2", "新图 2"), ...all];
    revision = "r2";
    clipboardGroupItemPosition.mockResolvedValue({
      found: true,
      index: 10,
      imageCount: 22,
      totalCount: 22,
      revision: "r2",
    });
    const updated = group({
      ...g,
      image_count: 22,
      item_count: 22,
      updated_at: new Date(now + 60_000).toISOString(),
    });
    act(() => {
      useClipboardStore.setState({ lite: view([], [updated]) });
    });

    expect(await screen.findByText(/截图组内容已变化/)).toBeTruthy();
    // 核心回归断言：组内排序变化不得悄悄改变当前图片 ID。
    expect((await screen.findByRole("img", { name: "剪贴板图片预览" })).getAttribute("src")).toContain("ins-9");
    expect(screen.getByText("11 / 22")).toBeTruthy();
    expect(clipboardGroupItemPosition).toHaveBeenCalledWith("seq-ins", "ins-9");

    // 返回组视图：下层组视图已同步到新 revision 的最新前缀。
    fireEvent.keyDown(window, { key: "Escape" });
    await screen.findByRole("button", { name: "查看截图组第 9 张图片" });
  });

  it("当前图片前删除 2 张：仍保持原图片 ID，序号前移到 7（第一页命中不浪费定位请求）", async () => {
    const all = Array.from({ length: 20 }, (_, i) => imageOf(`shr-${i + 1}`, `收缩 ${i + 1}`));
    const g = group({ id: "seq-shr", name: "收缩组", image_count: 20, item_count: 20 });
    let revision = "r1";
    let images = all;
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockImplementation(
      async (_id: string, opts: { limit: number; offset?: number }) => {
        const offset = opts.offset ?? 0;
        return pageOf(g.id, images.slice(offset, offset + opts.limit), images.length, images.length, revision);
      },
    );
    clipboardImage.mockImplementation(async (id: string) => `data:image/png;base64,${id}`);
    render(<ClipboardLite />);
    await screen.findByText("收缩组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「收缩组」" }));
    await screen.findByRole("button", { name: "查看截图组第 9 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 9 张图片" }));
    expect(await screen.findByText("9 / 20")).toBeTruthy();

    // 删除前 2 张：shr-9 变为第 7 张；第一页（9 条）直接命中，无需定位接口。
    images = all.slice(2);
    revision = "r2";
    const updated = group({
      ...g,
      image_count: 18,
      item_count: 18,
      updated_at: new Date(now + 60_000).toISOString(),
    });
    act(() => {
      useClipboardStore.setState({ lite: view([], [updated]) });
    });

    expect(await screen.findByText("7 / 18")).toBeTruthy();
    expect((await screen.findByRole("img", { name: "剪贴板图片预览" })).getAttribute("src")).toContain("shr-9");
    expect(clipboardGroupItemPosition).not.toHaveBeenCalled();
  });

  it("当前图片移到下一页（跨过第一页边界）：按 ID 补页找回，不显示别的图", async () => {
    const all = Array.from({ length: 20 }, (_, i) => imageOf(`cross-${i + 1}`, `跨页 ${i + 1}`));
    const g = group({ id: "seq-cross", name: "跨页组", image_count: 20, item_count: 20 });
    let revision = "r1";
    let images = all;
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockImplementation(
      async (_id: string, opts: { limit: number; offset?: number }) => {
        const offset = opts.offset ?? 0;
        return pageOf(g.id, images.slice(offset, offset + opts.limit), images.length, images.length, revision);
      },
    );
    clipboardImage.mockImplementation(async (id: string) => `data:image/png;base64,${id}`);
    render(<ClipboardLite />);
    await screen.findByText("跨页组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「跨页组」" }));
    await screen.findByRole("button", { name: "查看截图组第 5 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 5 张图片" }));
    expect(await screen.findByText("5 / 20")).toBeTruthy();

    // 前面插入 6 张：cross-5 变为第 11 张（index 10），跨过第一页边界。
    const head = Array.from({ length: 6 }, (_, i) => imageOf(`cross-new-${i + 1}`, `新头 ${i + 1}`));
    images = [...head, ...all];
    revision = "r2";
    clipboardGroupItemPosition.mockResolvedValue({
      found: true,
      index: 10,
      imageCount: 26,
      totalCount: 26,
      revision: "r2",
    });
    const updated = group({
      ...g,
      image_count: 26,
      item_count: 26,
      updated_at: new Date(now + 60_000).toISOString(),
    });
    act(() => {
      useClipboardStore.setState({ lite: view([], [updated]) });
    });

    expect(await screen.findByText("11 / 26")).toBeTruthy();
    expect((await screen.findByRole("img", { name: "剪贴板图片预览" })).getAttribute("src")).toContain("cross-5");
    // 定位序位落在第二页：只补一页缩略图元数据（offset 9）。
    expect(clipboardGroupPage).toHaveBeenCalledWith("seq-cross", {
      limit: 9,
      offset: 9,
      imagesOnly: true,
    });
  });

  it("当前组被删除（分页接口 NotFound）：明确提示并退出组内预览，不静默停留", async () => {
    const g = group({ id: "seq-gone", name: "消失组", image_count: 3, item_count: 3 });
    const imgs = [1, 2, 3].map((n) => imageOf(`gone-${n}`, `消失 ${n}`));
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockResolvedValue(pageOf(g.id, imgs, 3, 3, "r1"));
    clipboardImage.mockResolvedValue("data:image/png;base64,GONE");
    render(<ClipboardLite />);
    await screen.findByText("消失组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「消失组」" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 1 张图片" }));
    expect(await screen.findByRole("img", { name: "剪贴板图片预览" })).toBeTruthy();

    // 组从列表快照删除：定位接口返回 NotFound（组不存在）→ 提示 + 退出组内预览。
    clipboardGroupItemPosition.mockRejectedValue({ code: "NOT_FOUND", message: "分组不存在" });
    act(() => {
      useClipboardStore.setState({ lite: view([], []) });
    });

    expect(await screen.findByRole("button", { name: "查看截图组第 1 张图片" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "剪贴板图片预览" })).toBeNull();
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
      "截图组已删除，已退出预览",
    );
  });

  it("当前图片移动到其他截图组：定位 found=false → 相邻图片 + 明确提示", async () => {
    const g = group({ id: "seq-moved", name: "移出组", image_count: 3, item_count: 3 });
    const initial = [imageOf("mv-1", "移出 1"), imageOf("mv-2", "移出 2"), imageOf("mv-3", "移出 3")];
    const after = [imageOf("mv-1", "移出 1"), imageOf("mv-4", "新进 4"), imageOf("mv-3", "移出 3")];
    clipboardView.mockResolvedValue(view([], [g]));
    let moved = false;
    clipboardGroupPage.mockImplementation(async () =>
      moved ? pageOf(g.id, after, 3, 3, "r2") : pageOf(g.id, initial, 3, 3, "r1"),
    );
    clipboardImage.mockImplementation(async (id: string) => `data:image/png;base64,${id}`);
    render(<ClipboardLite />);
    await screen.findByText("移出组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「移出组」" }));
    await screen.findByRole("button", { name: "查看截图组第 2 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 2 张图片" }));
    expect(await screen.findByText("2 / 3")).toBeTruthy();

    // mv-2 被移动到其他截图组：本组定位 found=false → 按旧序号落到相邻图片。
    moved = true;
    clipboardGroupItemPosition.mockResolvedValue({
      found: false,
      index: null,
      imageCount: 3,
      totalCount: 3,
      revision: "r2",
    });
    const updated = group({ ...g, updated_at: new Date(now + 60_000).toISOString() });
    act(() => {
      useClipboardStore.setState({ lite: view([], [updated]) });
    });

    expect(await screen.findByText(/当前图片已不在截图组中/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "剪贴板图片预览" }).getAttribute("src")).toContain("mv-4"),
    );
    expect(screen.getByText("2 / 3")).toBeTruthy();
  });

  it("连续两次 revision 更新：后者胜出、旧请求不写 state、无重复请求风暴", async () => {
    const all = Array.from({ length: 20 }, (_, i) => imageOf(`tw-${i + 1}`, `连变 ${i + 1}`));
    const g = group({ id: "seq-twice", name: "连变组", image_count: 20, item_count: 20 });
    let revision = "r1";
    clipboardView.mockResolvedValue(view([], [g]));
    let armed = false;
    let slowGate: ((v: ClipboardGroupPage) => void) | null = null;
    clipboardGroupPage.mockImplementation(
      async (_id: string, opts: { limit: number; offset?: number }) => {
        const offset = opts.offset ?? 0;
        const page = pageOf(g.id, all.slice(offset, offset + opts.limit), 20, 20, revision);
        if (armed && offset === 0 && opts.limit === 9) {
          armed = false;
          return new Promise<ClipboardGroupPage>((res) => {
            slowGate = res;
          });
        }
        return page;
      },
    );
    clipboardImage.mockImplementation(async (id: string) => `data:image/png;base64,${id}`);
    render(<ClipboardLite />);
    await screen.findByText("连变组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「连变组」" }));
    await screen.findByRole("button", { name: "查看截图组第 9 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 9 张图片" }));
    expect(await screen.findByText("9 / 20")).toBeTruthy();

    // 变异同一 group 对象：liveSignature 变化触发预览层刷新，但组视图 props 引用
    // 不变 → 组视图不会整体重读，并发只发生在两次序列刷新之间。
    // 第一次变化：刷新请求被挂起；第二次变化随后到来，必须使前者整体作废。
    armed = true;
    g.updated_at = new Date(now + 60_000).toISOString();
    act(() => {
      useClipboardStore.setState({ lite: view([], [g]) });
    });
    revision = "r3";
    g.updated_at = new Date(now + 120_000).toISOString();
    act(() => {
      useClipboardStore.setState({ lite: view([], [g]) });
    });
    // 刷新 2 用 r3 直接完成：当前图片仍在第一页，最终状态必须与 r3 一致。
    expect(await screen.findByText(/截图组内容已变化/)).toBeTruthy();
    expect(screen.getByText("9 / 20")).toBeTruthy();
    expect((await screen.findByRole("img", { name: "剪贴板图片预览" })).getAttribute("src")).toContain("tw-9");
    expect(clipboardGroupItemPosition).not.toHaveBeenCalled();

    // 迟到的旧响应（r2）：不得覆盖 r3 的最终状态。
    act(() => slowGate?.(pageOf(g.id, all.slice(0, 9), 20, 20, "r2")));
    expect(screen.getByText("9 / 20")).toBeTruthy();
    expect(screen.getByRole("img", { name: "剪贴板图片预览" }).getAttribute("src")).toContain("tw-9");

    // 无重复请求风暴：第一页（limit 9 / offset 0）只有初始打开 + 两次刷新 = 3 次。
    expect(
      clipboardGroupPage.mock.calls.filter(
        (c) => (c[1] as { limit: number; offset?: number }).limit === 9 &&
          ((c[1] as { offset?: number }).offset ?? 0) === 0,
      ),
    ).toHaveLength(3);

    // 之后继续翻页仍用最新 revision，不回第一页。
    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    expect(await screen.findByText("10 / 20")).toBeTruthy();
  });

  it("当前图片移动超出预载范围（>90）：明确提示并回到组首，不静默显示其他图片", async () => {
    const all = Array.from({ length: 120 }, (_, i) => imageOf(`beyond-${i + 1}`, `超限 ${i + 1}`));
    const g = group({ id: "seq-beyond", name: "超限组", image_count: 120, item_count: 120 });
    let revision = "r1";
    let images = all;
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockImplementation(
      async (_id: string, opts: { limit: number; offset?: number }) => {
        const offset = opts.offset ?? 0;
        return pageOf(g.id, images.slice(offset, offset + opts.limit), images.length, images.length, revision);
      },
    );
    clipboardImage.mockImplementation(async (id: string) => `data:image/png;base64,${id}`);
    render(<ClipboardLite />);
    await screen.findByText("超限组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「超限组」" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 1 张图片" }));
    expect(await screen.findByText("1 / 120")).toBeTruthy();

    // 前面插入 100 张：beyond-1 变为第 101 张，超出 10 页（90 张）的预载查找能力。
    const head = Array.from({ length: 100 }, (_, i) => imageOf(`beyond-new-${i + 1}`, `超限新 ${i + 1}`));
    images = [...head, ...all];
    revision = "r2";
    clipboardGroupItemPosition.mockResolvedValue({
      found: true,
      index: 100,
      imageCount: 220,
      totalCount: 220,
      revision: "r2",
    });
    const updated = group({
      ...g,
      image_count: 220,
      item_count: 220,
      updated_at: new Date(now + 60_000).toISOString(),
    });
    act(() => {
      useClipboardStore.setState({ lite: view([], [updated]) });
    });

    // 明确提示新序位并回到组首（组首图片 + 提示），绝不静默显示其他图片。
    expect(await screen.findByText(/超出预载范围，已回到组首/)).toBeTruthy();
    expect(screen.getByText(/第 101 张/)).toBeTruthy();
    expect(screen.getByText("1 / 220")).toBeTruthy();
    expect((await screen.findByRole("img", { name: "剪贴板图片预览" })).getAttribute("src")).toContain(
      "beyond-new-1",
    );
  });

  it("方向键在输入框内不劫持，焦点不在输入框时才切换图片", async () => {
    const g = group({ id: "seq-keys", name: "键盘组", image_count: 2, item_count: 2 });
    const imgs = [imageOf("keys-1", "键盘 1"), imageOf("keys-2", "键盘 2")];
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockResolvedValue(pageOf(g.id, imgs, 2, 2));
    clipboardImage.mockImplementation(async (id: string) => `data:image/png;base64,${id}`);
    render(<ClipboardLite />);
    await screen.findByText("键盘组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「键盘组」" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 1 张图片" }));
    expect(await screen.findByText("1 / 2")).toBeTruthy();

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(screen.getByText("1 / 2")).toBeTruthy();
    input.remove();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByText("2 / 2")).toBeTruthy());
  });

  it("返回截图组后保留组内滚动位置", async () => {
    const g = group({ id: "seq-scroll", name: "滚动组", image_count: 9, item_count: 9 });
    const imgs = Array.from({ length: 9 }, (_, i) => imageOf(`scroll-${i + 1}`, `滚动 ${i + 1}`));
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockResolvedValue(pageOf(g.id, imgs, 9, 9));
    clipboardImage.mockResolvedValue("data:image/png;base64,SCROLL");
    const { container } = render(<ClipboardLite />);
    await screen.findByText("滚动组");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「滚动组」" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    const scroller = container.querySelector(".cap-clip-scroll") as HTMLDivElement;
    scroller.scrollTop = 72;
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 1 张图片" }));
    await screen.findByRole("img", { name: "剪贴板图片预览" });
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    expect((container.querySelector(".cap-clip-scroll") as HTMLDivElement).scrollTop).toBe(72);
  });
});

describe("二级视图 Escape 层级", () => {
  it("Escape 只关预览，不收起面板；再按一次才关面板层", async () => {
    const text = item({ id: "lite-esc-a", kind: "text", title: "文本 A", preview: "预览 A" });
    clipboardView.mockResolvedValue(view([text]));
    clipboardItem.mockResolvedValue({ ...text, text: "完整内容 A" });
    const drawerEscape = vi.fn();
    registerOverlay({ kind: "drawer", onEscape: drawerEscape, blocksAutoHide: false });
    render(<ClipboardLite />);
    await screen.findByText("文本 A");

    fireEvent.click(screen.getByRole("button", { name: "查看「文本 A」" }));
    await screen.findByText("完整内容 A");

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await screen.findByText("文本 A");
    expect(screen.queryByText("完整内容 A")).toBeNull();
    expect(drawerEscape).not.toHaveBeenCalled(); // 一次按键只关一层

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(drawerEscape).toHaveBeenCalledTimes(1);
  });

  it("关闭预览后恢复列表滚动位置", async () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      item({ id: `lite-scroll-${i}`, kind: "text", title: `条目 ${i}`, preview: `预览 ${i}` }),
    );
    clipboardView.mockResolvedValue(view(items));
    clipboardItem.mockResolvedValue({ ...items[3], text: "完整内容" });
    const { container } = render(<ClipboardLite />);
    await screen.findByText("条目 3");

    const list = container.querySelector(".cap-list") as HTMLDivElement;
    list.scrollTop = 120;

    fireEvent.click(screen.getByRole("button", { name: "查看「条目 3」" }));
    await screen.findByText("完整内容");
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    await screen.findByText("条目 3");

    await waitFor(() => expect((container.querySelector(".cap-list") as HTMLDivElement).scrollTop).toBe(120));
  });
});

describe("二级视图交互复验", () => {
  const imageOf = (id: string, title: string) =>
    item({ id, kind: "image", title, has_image: true, has_thumb: true });
  const groupOf = (id: string, name: string) =>
    group({ id, name, image_count: 2, item_count: 2 });

  it("组 → 原图 → 组 → 列表 → 抽屉：每次 Escape 只关最上层", async () => {
    const g = groupOf("lg-e", "组 E");
    const imgs = [imageOf("le-1", "E1"), imageOf("le-2", "E2")];
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockResolvedValue({
      groupId: "lg-e",
      items: imgs,
      totalCount: 2,
      imageCount: 2,
      offset: 0,
      limit: 9,
      revision: "r-e",
    });
    clipboardImage.mockResolvedValue("data:image/png;base64,LITE-E");
    const drawerEscape = vi.fn();
    registerOverlay({ kind: "drawer", onEscape: drawerEscape, blocksAutoHide: false });
    render(<ClipboardLite />);
    await screen.findByText("组 E");

    fireEvent.click(screen.getByRole("button", { name: "预览截图组「组 E」" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    fireEvent.click(screen.getByRole("button", { name: "查看截图组第 1 张图片" }));
    await screen.findByRole("img", { name: "剪贴板图片预览" });

    act(() => fireEvent.keyDown(window, { key: "Escape" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    expect(screen.queryByRole("img", { name: "剪贴板图片预览" })).toBeNull();
    expect(drawerEscape).not.toHaveBeenCalled();

    act(() => fireEvent.keyDown(window, { key: "Escape" }));
    await screen.findByRole("button", { name: "预览截图组「组 E」" });
    expect(screen.queryByRole("button", { name: "查看截图组第 1 张图片" })).toBeNull();
    expect(drawerEscape).not.toHaveBeenCalled();

    act(() => fireEvent.keyDown(window, { key: "Escape" }));
    expect(drawerEscape).toHaveBeenCalledTimes(1);
  });

  it("关闭原图后焦点回到组内缩略图；下层视图不可见时不可聚焦", async () => {
    const g = groupOf("lg-f", "组 F");
    const imgs = [imageOf("lf-1", "F1"), imageOf("lf-2", "F2")];
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockResolvedValue({
      groupId: "lg-f",
      items: imgs,
      totalCount: 2,
      imageCount: 2,
      offset: 0,
      limit: 9,
      revision: "r-f",
    });
    clipboardImage.mockResolvedValue("data:image/png;base64,LITE-F");
    render(<ClipboardLite />);
    await screen.findByText("组 F");

    fireEvent.click(screen.getByRole("button", { name: "预览截图组「组 F」" }));
    const thumb = await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    thumb.focus();
    fireEvent.click(thumb);
    await screen.findByRole("img", { name: "剪贴板图片预览" });
    // 原图在上层时，下层组视图 hidden，缩略图不可聚焦
    await waitFor(() => expect(thumb.closest("[hidden]")).not.toBeNull());

    act(() => fireEvent.keyDown(window, { key: "Escape" }));
    await waitFor(() => expect(document.activeElement).toBe(thumb));
  });

  it("卸载面板即销毁二级视图与 overlay 注册；重新挂载回到列表", async () => {
    const g = groupOf("lg-u", "组 U");
    clipboardView.mockResolvedValue(view([], [g]));
    clipboardGroupPage.mockResolvedValue({
      groupId: "lg-u",
      items: [imageOf("lu-1", "U1")],
      totalCount: 1,
      imageCount: 1,
      offset: 0,
      limit: 9,
      revision: "r-u",
    });
    const { unmount } = render(<ClipboardLite />);
    await screen.findByText("组 U");
    fireEvent.click(screen.getByRole("button", { name: "预览截图组「组 U」" }));
    await screen.findByRole("button", { name: "查看截图组第 1 张图片" });
    expect(overlayStack().length).toBeGreaterThan(0);

    unmount();
    expect(overlayStack()).toHaveLength(0);

    render(<ClipboardLite />);
    await screen.findByText("组 U");
    expect(screen.queryByRole("button", { name: "查看截图组第 1 张图片" })).toBeNull();
  });

  it("原图读取尚未返回时关闭视图：迟到的响应不更新界面", async () => {
    const img = imageOf("lite-late", "迟到图");
    let resolveImg: ((v: string | null) => void) | null = null;
    clipboardView.mockResolvedValue(view([img]));
    clipboardImage.mockImplementation(
      () =>
        new Promise<string | null>((res) => {
          resolveImg = res;
        }),
    );
    render(<ClipboardLite />);
    await screen.findByText("迟到图");
    fireEvent.click(screen.getByRole("button", { name: "查看大图" }));
    await screen.findByText("正在加载原图…");
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    await screen.findByText("迟到图");

    act(() => resolveImg?.("data:image/png;base64,LATE"));
    expect(screen.queryByRole("img", { name: "剪贴板图片预览" })).toBeNull();
    expect(screen.getByText("迟到图")).toBeTruthy();
  });
});

describe("二级页面统一关闭入口", () => {
  it("文本详情：返回只退一层，X 收起整个面板，两者是不同按钮", async () => {
    const text = item({ id: "lite-close-text", kind: "text", title: "关闭测试", preview: "预览" });
    clipboardView.mockResolvedValue(view([text]));
    clipboardItem.mockResolvedValue({ ...text, text: "正文内容" });
    const onClose = vi.fn();
    render(
      <PanelCloseProvider onClose={onClose}>
        <ClipboardLite />
      </PanelCloseProvider>,
    );
    await screen.findByText("关闭测试");
    fireEvent.click(screen.getByRole("button", { name: "查看「关闭测试」" }));
    await screen.findByText("正文内容");

    const close = screen.getByRole("button", { name: "关闭剪贴板面板" });
    const back = screen.getByRole("button", { name: "返回列表" });
    // 二级页面同时保留返回与关闭，且是两个不同动作
    expect(close).not.toBe(back);
    expect(close.parentElement?.classList.contains("cap-actions")).toBe(true);
    expect(close.parentElement?.lastElementChild).toBe(close);
    // 关闭按钮不是窗口拖拽热区
    expect(close.hasAttribute("data-tauri-drag-region")).toBe(false);

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    // X 不冒充「返回」：视图本身由 CapsuleDock 收起时卸载，这里不应先退出当前层
    expect(screen.getByText("正文内容")).toBeTruthy();

    fireEvent.click(back);
    await waitFor(() => expect(screen.queryByText("正文内容")).toBeNull());
    // 返回只退当前层，不触发面板关闭
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("没有 provider 时不渲染 X（组件单独复用不受影响）", async () => {
    const text = item({ id: "lite-close-text-2", kind: "text", title: "独立渲染", preview: "预览" });
    clipboardView.mockResolvedValue(view([text]));
    clipboardItem.mockResolvedValue({ ...text, text: "独立正文" });
    render(<ClipboardLite />);
    await screen.findByText("独立渲染");
    fireEvent.click(screen.getByRole("button", { name: "查看「独立渲染」" }));
    await screen.findByText("独立正文");
    expect(screen.queryByRole("button", { name: "关闭剪贴板面板" })).toBeNull();
    expect(screen.getByRole("button", { name: "返回列表" })).toBeTruthy();
  });
});

describe("列表口径与展示行数一致", () => {
  it("副标题不报载入快照总数：最多展示 8 条就写 8 条", async () => {
    const twenty = Array.from({ length: 20 }, (_, i) =>
      item({ id: `lite-cap-${i}`, kind: "text", title: `记录 ${i}`, preview: `预览 ${i}` }),
    );
    clipboardView.mockResolvedValue(view(twenty));
    render(<ClipboardLite />);
    await screen.findByText("记录 0");
    expect(screen.getByText("最近 8 条")).toBeTruthy();
    expect(screen.queryByText(/最近 20 条/)).toBeNull();
  });

  it("截图组计入实际渲染行数，并按可见组数标注", async () => {
    const g = group({ id: "lite-cap-group", name: "截图组口径", image_count: 2, item_count: 2 });
    clipboardView.mockResolvedValue(view([], [g]));
    render(<ClipboardLite />);
    await screen.findByText("截图组口径");
    expect(screen.getByText("最近 1 条 · 含 1 个截图组")).toBeTruthy();
  });
});
