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
import { clearGroupPageCache, groupPageCacheKey, loadGroupPage } from "./ClipboardLiteViews";

const clipboardView = vi.fn();
const clipboardGroupPage = vi.fn();
const clipboardCopyItem = vi.fn();
const clipboardCopyGroupRich = vi.fn();
const clipboardStatus = vi.fn();
const clipboardItem = vi.fn();
const clipboardImage = vi.fn();
const clipboardThumb = vi.fn();

vi.mock("../../lib/bridge", () => ({
  onClipboardChanged: async () => () => {},
  clipboardView: (...a: unknown[]) => clipboardView(...a),
  clipboardGroupPage: (...a: unknown[]) => clipboardGroupPage(...a),
  clipboardCopyItem: (...a: unknown[]) => clipboardCopyItem(...a),
  clipboardCopyGroupRich: (...a: unknown[]) => clipboardCopyGroupRich(...a),
  clipboardStatus: (...a: unknown[]) => clipboardStatus(...a),
  clipboardItem: (...a: unknown[]) => clipboardItem(...a),
  clipboardImage: (...a: unknown[]) => clipboardImage(...a),
  clipboardThumb: (...a: unknown[]) => clipboardThumb(...a),
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
  clipboardCopyItem.mockReset();
  clipboardCopyGroupRich.mockReset();
  clipboardStatus.mockReset();
  clipboardItem.mockReset();
  clipboardImage.mockReset();
  clipboardThumb.mockReset();
  clipboardView.mockResolvedValue(view([]));
  clipboardGroupPage.mockResolvedValue({ items: [], totalCount: 0, imageCount: 0, offset: 0 });
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
