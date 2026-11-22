/**
 * @vitest-environment jsdom
 */
//! 跨组件集成：分组卡片封面 → 工作区预览上下文 → 多图灯箱。
//!
//! 验证的是真实调用链，而不是分别测卡片与灯箱：
//! 卡片只传出被点击的封面，工作区用 `clipboard_group_page(imagesOnly)` 取整组图片，
//! 再把 items/total 传给灯箱；这里断言箭头、序号、分页、键盘与异步竞态。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  clipboardView: vi.fn(),
  clipboardStatus: vi.fn(),
  onClipboardChanged: vi.fn(),
  clipboardGroupPage: vi.fn(),
  clipboardImage: vi.fn(),
  clipboardThumb: vi.fn(),
  clipboardCopyGroupRich: vi.fn(),
  clipboardCopyGroupFiles: vi.fn(),
  clipboardToggleGroup: vi.fn(),
  clipboardDeleteGroup: vi.fn(),
  clipboardCreateGroup: vi.fn(),
  clipboardItem: vi.fn(),
  getSettings: vi.fn(),
}));
vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...bridge };
});

import ClipboardWorkspace from "./ClipboardWorkspace";
import type {
  ClipboardGroup, ClipboardGroupPage, ClipboardItem, ClipboardView,
} from "../../lib/bridge";
import { useClipboardStore, resetClipboardRequestState } from "../../store/useClipboardStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";

function makeImage(id: string, patch: Partial<ClipboardItem> = {}): ClipboardItem {
  return {
    id,
    kind: "image",
    text: "",
    html: "",
    preview: `图片 ${id}`,
    title: `截图 ${id}`,
    title_source: "auto",
    byte_size: 2048,
    source_app: "snip.exe",
    source_title: "截图工具",
    source_kind: "owner",
    image_width: 800,
    image_height: 600,
    file_paths: [],
    favorite: false,
    pinned: false,
    copy_count: 1,
    created_at: "2026-11-05T09:00:00Z",
    last_seen_at: "2026-11-05T09:00:00Z",
    has_image: true,
    has_thumb: true,
    ...patch,
  };
}

function makeText(id: string): ClipboardItem {
  return makeImage(id, {
    kind: "text",
    title: "",
    preview: "会议纪要",
    image_width: null,
    image_height: null,
    has_image: false,
    has_thumb: false,
    source_app: "notepad.exe",
  });
}

function makeGroup(
  id: string,
  name: string,
  images: ClipboardItem[],
  patch: Partial<ClipboardGroup> = {},
): ClipboardGroup {
  return {
    id,
    name,
    mode: "auto",
    status: "closed",
    favorite: false,
    pinned: false,
    created_at: "2026-11-05T09:00:00Z",
    updated_at: "2026-11-05T09:05:00Z",
    closed_at: "2026-11-05T09:05:00Z",
    item_count: images.length,
    image_count: images.length,
    preview: images[0]?.preview ?? "",
    kind_counts: { image: images.length, text: 0, html: 0, url: 0, files: 0 },
    cover_items: images.slice(0, 3),
    items: [],
    ...patch,
  };
}

function makeView(groups: ClipboardGroup[], items: ClipboardItem[]): ClipboardView {
  return {
    items,
    groups,
    stats: {
      items: items.length,
      groups: groups.length,
      images: items.filter((i) => i.kind === "image").length,
      files: 0,
      favorites: 0,
      bytes: 0,
      asset_bytes: 0,
      max_items: 5000,
      max_storage_bytes: 0,
      enabled: true,
      paused: false,
      auto_group: true,
    },
    total_items: items.length,
  };
}

/** 按页返回图片元数据：offset 只在图片行内计算，与后端 imagesOnly 语义一致。 */
function pageOf(images: ClipboardItem[], revision = "r1") {
  return (id: string, opts: { limit?: number; offset?: number; imagesOnly?: boolean } = {}) => {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    return {
      groupId: id,
      items: images.slice(offset, offset + limit),
      totalCount: images.length,
      imageCount: images.length,
      offset,
      limit,
      revision,
    };
  };
}

let originalIO: typeof IntersectionObserver | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  resetClipboardRequestState();
  originalIO = globalThis.IntersectionObserver;
  class ImmediateObserver {
    constructor(cb: IntersectionObserverCallback) {
      queueMicrotask(() =>
        cb([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
      );
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  globalThis.IntersectionObserver = ImmediateObserver as unknown as typeof IntersectionObserver;

  bridge.clipboardStatus.mockResolvedValue({
    enabled: true,
    paused: false,
    monitoring: true,
    activeJob: null,
    platform: "windows",
  });
  bridge.onClipboardChanged.mockResolvedValue(() => {});
  bridge.clipboardImage.mockImplementation(async (id: string) => `data:image/png;base64,${id}`);
  bridge.clipboardThumb.mockImplementation(async (id: string) => `data:image/png;base64,thumb-${id}`);
  bridge.clipboardCopyGroupRich.mockResolvedValue({ mode: "rich", bytes: 0, warnings: [] });
  bridge.clipboardCopyGroupFiles.mockResolvedValue({ mode: "files", bytes: 0, warnings: [] });
  bridge.clipboardToggleGroup.mockResolvedValue(undefined);
  bridge.clipboardDeleteGroup.mockResolvedValue(undefined);
  bridge.clipboardCreateGroup.mockResolvedValue(undefined);

  useSettingsStore.setState({ settings: { clipboard_enabled: true, clipboard_paused: false } as never });
  useUiStore.setState({ tab: "clipboard", clipboardOpen: false, clipboardLinkTask: null, toast: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalIO) globalThis.IntersectionObserver = originalIO;
  useUiStore.setState({ tab: "tasks", clipboardOpen: false, toast: null });
  useSettingsStore.setState({ settings: null });
});

async function mountGroups(groups: ClipboardGroup[], items: ClipboardItem[]) {
  bridge.clipboardView.mockResolvedValue(makeView(groups, items));
  useClipboardStore.setState({
    view: makeView(groups, items),
    filters: { kind: "all", search: "", favorite: false },
    section: "groups",
    searchText: "",
    loading: false,
    loadingMore: false,
    error: null,
    selectedItems: [],
    selectedGroups: [],
    exiting: {},
  });
  render(<ClipboardWorkspace variant="page" active={true} />);
  await waitFor(() => expect(document.querySelectorAll(".clip-group-card").length).toBe(groups.length));
  // 封面缩略图 IPC 是异步的；等按钮出现即可点击
  await waitFor(() => expect(screen.getAllByRole("button", { name: /查看分组第 . 张截图/ }).length).toBeGreaterThan(0));
}

function counter() {
  return document.querySelector(".clip-lightbox-counter")?.textContent?.replace(/\s+/g, " ").trim() ?? null;
}

function pressKey(count: number, key: "ArrowRight" | "ArrowLeft" = "ArrowRight") {
  for (let i = 0; i < count; i += 1) {
    fireEvent.keyDown(window, { key });
  }
}

describe("分组封面 → 多图灯箱", () => {
  it("点封面打开整组图片：items 正确传入，序号、首尾箭头与键盘切换一致", async () => {
    const images = Array.from({ length: 7 }, (_, i) => makeImage(`img${i + 1}`));
    const group = makeGroup("g7", "截图 · 项目评审", images);
    bridge.clipboardGroupPage.mockImplementation(pageOf(images));

    await mountGroups([group], images);
    fireEvent.click(screen.getByRole("button", { name: "查看分组第 1 张截图" }));

    await waitFor(() => expect(counter()).toBe("1 / 7"));
    expect(bridge.clipboardGroupPage).toHaveBeenCalledWith("g7", {
      limit: 50,
      offset: 0,
      imagesOnly: true,
    });
    // 首张禁用「上一张」，末张前「下一张」可用
    expect((screen.getByRole("button", { name: "上一张" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "下一张" }) as HTMLButtonElement).disabled).toBe(false);

    pressKey(6);
    await waitFor(() => expect(counter()).toBe("7 / 7"));
    expect((screen.getByRole("button", { name: "下一张" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "上一张" }) as HTMLButtonElement).disabled).toBe(false);

    pressKey(1, "ArrowLeft");
    await waitFor(() => expect(counter()).toBe("6 / 7"));
  });

  it("点第 3 张封面时从 3 / 7 开始，而不是从第一张开始", async () => {
    const images = Array.from({ length: 7 }, (_, i) => makeImage(`img${i + 1}`));
    const group = makeGroup("g7", "截图 · 项目评审", images);
    bridge.clipboardGroupPage.mockImplementation(pageOf(images));

    await mountGroups([group], images);
    fireEvent.click(screen.getByRole("button", { name: "查看分组第 3 张截图" }));
    await waitFor(() => expect(counter()).toBe("3 / 7"));
  });

  it("超过单页 50 张仍能继续翻到最后一张（分页追加而不是停在 50）", async () => {
    const images = Array.from({ length: 57 }, (_, i) => makeImage(`big${i + 1}`));
    const group = makeGroup("g57", "截图 · 长图集", images);
    bridge.clipboardGroupPage.mockImplementation(pageOf(images));

    await mountGroups([group], images);
    fireEvent.click(screen.getByRole("button", { name: "查看分组第 1 张截图" }));
    await waitFor(() => expect(counter()).toBe("1 / 57"));
    expect((screen.getByRole("button", { name: "下一张" }) as HTMLButtonElement).disabled).toBe(false);

    pressKey(49);
    await waitFor(() => expect(bridge.clipboardGroupPage).toHaveBeenCalledWith("g57", {
      limit: 50,
      offset: 50,
      imagesOnly: true,
    }));
    await waitFor(() => expect(counter()).toBe("50 / 57"));

    pressKey(7);
    await waitFor(() => expect(counter()).toBe("57 / 57"));
    expect((screen.getByRole("button", { name: "下一张" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("单图组不显示箭头与数量；混合组只浏览图片并保持组内顺序", async () => {
    const single = makeImage("solo");
    const singleGroup = makeGroup("g1", "截图 · 单图", [single]);
    bridge.clipboardGroupPage.mockImplementation(pageOf([single]));

    await mountGroups([singleGroup], [single]);
    fireEvent.click(screen.getByRole("button", { name: "查看分组第 1 张截图" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "图片大图预览" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "下一张" })).toBeNull();
    expect(screen.queryByRole("button", { name: "上一张" })).toBeNull();
    expect(counter()).toBeNull();

    cleanup();

    // 混合组：文本不计入图片序号；图片按 position 顺序
    const first = makeImage("mix-img-a");
    const middle = makeText("mix-text");
    const second = makeImage("mix-img-b");
    const mixed = makeGroup("gm", "截图 · 混合", [first, second], {
      item_count: 3,
      image_count: 2,
      kind_counts: { image: 2, text: 1, html: 0, url: 0, files: 0 },
      cover_items: [first, middle, second],
    });
    bridge.clipboardGroupPage.mockImplementation(pageOf([first, second]));

    await mountGroups([mixed], [first, middle, second]);
    fireEvent.click(screen.getByRole("button", { name: "查看分组第 1 张截图" }));
    await waitFor(() => expect(counter()).toBe("1 / 2"));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(counter()).toBe("2 / 2"));
    expect(bridge.clipboardImage).toHaveBeenLastCalledWith("mix-img-b");
  });
});

describe("灯箱异步安全与错误态", () => {
  it("快速跨分组切换时旧请求不得覆盖新分组", async () => {
    const a = Array.from({ length: 7 }, (_, i) => makeImage(`a${i + 1}`));
    const b = Array.from({ length: 3 }, (_, i) => makeImage(`b${i + 1}`));
    const ga = makeGroup("ga", "截图 · A", a);
    const gb = makeGroup("gb", "截图 · B", b);

    let resolveA: (value: ClipboardGroupPage) => void = () => {};
    let resolveB: (value: ClipboardGroupPage) => void = () => {};
    bridge.clipboardGroupPage.mockImplementation((id: string) => {
      return new Promise<ClipboardGroupPage>((resolve) => {
        if (id === "ga") resolveA = resolve;
        else resolveB = resolve;
      });
    });

    await mountGroups([ga, gb], [...a, ...b]);
    const covers = screen.getAllByRole("button", { name: "查看分组第 1 张截图" });
    fireEvent.click(covers[0]);
    fireEvent.click(covers[1]);

    await act(async () => {
      resolveB(pageOf(b)("gb", { limit: 50, offset: 0 }));
    });
    await waitFor(() => expect(counter()).toBe("1 / 3"));

    await act(async () => {
      resolveA(pageOf(a)("ga", { limit: 50, offset: 0 }));
    });
    // A 的旧响应晚到也不能覆盖 B
    await waitFor(() => expect(counter()).toBe("1 / 3"));
    expect(screen.getByRole("dialog", { name: "图片大图预览" })).toBeTruthy();
  });

  it("首屏图片未返回时按方向键，响应到达后补上目标位置", async () => {
    const images = Array.from({ length: 4 }, (_, i) => makeImage(`q${i + 1}`));
    const group = makeGroup("gq", "截图 · 慢响应", images);

    let resolvePage: (value: ClipboardGroupPage) => void = () => {};
    bridge.clipboardGroupPage.mockImplementation(
      () => new Promise<ClipboardGroupPage>((resolve) => {
        resolvePage = resolve;
      }),
    );

    await mountGroups([group], images);
    fireEvent.click(screen.getByRole("button", { name: "查看分组第 1 张截图" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "图片大图预览" })).toBeTruthy());
    // 第一页还在路上就按右键：不能出现「按了没反应」
    fireEvent.keyDown(window, { key: "ArrowRight" });

    await act(async () => {
      resolvePage(pageOf(images)("gq", { limit: 50, offset: 0 }));
    });
    await waitFor(() => expect(counter()).toBe("2 / 4"));
    await waitFor(() => expect(bridge.clipboardImage).toHaveBeenLastCalledWith("q2"));
  });

  it("首屏未返回时从第 3 张封面起步：立即右键落到第 4 张", async () => {
    const images = Array.from({ length: 7 }, (_, i) => makeImage(`r${i + 1}`));
    const group = makeGroup("gr", "截图 · 慢响应", images);
    let resolvePage: (value: ClipboardGroupPage) => void = () => {};
    bridge.clipboardGroupPage.mockImplementation(
      () => new Promise<ClipboardGroupPage>((resolve) => {
        resolvePage = resolve;
      }),
    );

    await mountGroups([group], images);
    fireEvent.click(screen.getByRole("button", { name: "查看分组第 3 张截图" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "图片大图预览" })).toBeTruthy());
    // 占位序列只有一张，不能显示「1 / 7」这种错误序号。
    expect(counter()).toBe("… / 7");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    // 加载期间不闪到别的图片：目标图原图请求必须等真实序列返回后才发起。
    expect(bridge.clipboardImage).not.toHaveBeenCalledWith("r4");

    await act(async () => {
      resolvePage(pageOf(images)("gr", { limit: 50, offset: 0 }));
    });
    await waitFor(() => expect(counter()).toBe("4 / 7"));
    await waitFor(() => expect(bridge.clipboardImage).toHaveBeenLastCalledWith("r4"));
  });

  it("首屏未返回时立即左键：从第 3 张封面退到第 2 张", async () => {
    const images = Array.from({ length: 7 }, (_, i) => makeImage(`l${i + 1}`));
    const group = makeGroup("gl", "截图 · 慢响应", images);
    let resolvePage: (value: ClipboardGroupPage) => void = () => {};
    bridge.clipboardGroupPage.mockImplementation(
      () => new Promise<ClipboardGroupPage>((resolve) => {
        resolvePage = resolve;
      }),
    );

    await mountGroups([group], images);
    fireEvent.click(screen.getByRole("button", { name: "查看分组第 3 张截图" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "图片大图预览" })).toBeTruthy());

    pressKey(1, "ArrowLeft");
    await act(async () => {
      resolvePage(pageOf(images)("gl", { limit: 50, offset: 0 }));
    });
    await waitFor(() => expect(counter()).toBe("2 / 7"));
    await waitFor(() => expect(bridge.clipboardImage).toHaveBeenLastCalledWith("l2"));
  });

  it("首屏未返回时连胜方向键按位移累加，不会都映射到同一张", async () => {
    const images = Array.from({ length: 7 }, (_, i) => makeImage(`s${i + 1}`));
    const group = makeGroup("gs", "截图 · 连按", images);
    let resolvePage: (value: ClipboardGroupPage) => void = () => {};
    bridge.clipboardGroupPage.mockImplementation(
      () => new Promise<ClipboardGroupPage>((resolve) => {
        resolvePage = resolve;
      }),
    );

    await mountGroups([group], images);
    fireEvent.click(screen.getByRole("button", { name: "查看分组第 3 张截图" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "图片大图预览" })).toBeTruthy());

    // 加载期连按 3 次右键 → 真实顺序下从第 3 张再走 3 步 = 第 6 张。
    pressKey(3);
    await act(async () => {
      resolvePage(pageOf(images)("gs", { limit: 50, offset: 0 }));
    });
    await waitFor(() => expect(counter()).toBe("6 / 7"));

    // 左键在已就绪状态下正常回退，不被加载期位移污染。
    pressKey(2, "ArrowLeft");
    await waitFor(() => expect(counter()).toBe("4 / 7"));
  });

  it("分页边界连按：目标页未到时每次按键都推进目标，只发一次请求", async () => {
    const images = Array.from({ length: 57 }, (_, i) => makeImage(`t${i + 1}`));
    const group = makeGroup("gt", "截图 · 边界连按", images);
    let resolveMore: (value: ClipboardGroupPage) => void = () => {};
    bridge.clipboardGroupPage.mockImplementation((id: string, opts: { limit?: number; offset?: number }) => {
      if ((opts.offset ?? 0) === 0) return Promise.resolve(pageOf(images)(id, opts));
      return new Promise<ClipboardGroupPage>((resolve) => {
        resolveMore = resolve;
      });
    });

    await mountGroups([group], images);
    fireEvent.click(screen.getByRole("button", { name: "查看分组第 1 张截图" }));
    await waitFor(() => expect(counter()).toBe("1 / 57"));
    pressKey(49);
    await waitFor(() => expect(counter()).toBe("50 / 57"));
    await waitFor(() =>
      expect(bridge.clipboardGroupPage).toHaveBeenCalledWith("gt", {
        limit: 50,
        offset: 50,
        imagesOnly: true,
      }),
    );

    // 第二页未返回时再连按 7 次：不能都停在 50，而要推进到最后一页。
    pressKey(7);
    expect(bridge.clipboardGroupPage.mock.calls.filter((c) => (c[1] as { offset?: number }).offset === 50)).toHaveLength(1);

    await act(async () => {
      resolveMore(pageOf(images)("gt", { limit: 50, offset: 50 }));
    });
    await waitFor(() => expect(counter()).toBe("57 / 57"));
  });

  it("首屏在途时关闭再打开另一组：旧响应不写入新分组", async () => {
    const a = Array.from({ length: 7 }, (_, i) => makeImage(`ca${i + 1}`));
    const b = Array.from({ length: 3 }, (_, i) => makeImage(`cb${i + 1}`));
    const ga = makeGroup("gca", "截图 · A", a);
    const gb = makeGroup("gcb", "截图 · B", b);
    let resolveA: (value: ClipboardGroupPage) => void = () => {};
    let resolveB: (value: ClipboardGroupPage) => void = () => {};
    bridge.clipboardGroupPage.mockImplementation((id: string) => {
      return new Promise<ClipboardGroupPage>((resolve) => {
        if (id === "gca") resolveA = resolve;
        else resolveB = resolve;
      });
    });

    await mountGroups([ga, gb], [...a, ...b]);
    const covers = screen.getAllByRole("button", { name: "查看分组第 1 张截图" });
    fireEvent.click(covers[0]);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "图片大图预览" })).toBeTruthy());
    expect(counter()).toBe("… / 7");

    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "图片大图预览" })).toBeNull());

    fireEvent.click(covers[1]);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "图片大图预览" })).toBeTruthy());
    expect(counter()).toBe("… / 3");

    // A 的迟到响应不能把 B 的占位序列替换掉。
    await act(async () => {
      resolveA(pageOf(a)("gca", { limit: 50, offset: 0 }));
    });
    expect(counter()).toBe("… / 3");

    await act(async () => {
      resolveB(pageOf(b)("gcb", { limit: 50, offset: 0 }));
    });
    await waitFor(() => expect(counter()).toBe("1 / 3"));
    expect(bridge.clipboardImage).toHaveBeenLastCalledWith("cb1");
  });

  it("真实序列里已没有打开的封面时，就近重定位而不是停在空序号", async () => {
    const images = Array.from({ length: 7 }, (_, i) => makeImage(`d${i + 1}`));
    const group = makeGroup("gd", "截图 · 已删除", images);
    const remaining = images.filter((i) => i.id !== "d3");
    let resolvePage: (value: ClipboardGroupPage) => void = () => {};
    bridge.clipboardGroupPage.mockImplementation(
      () => new Promise<ClipboardGroupPage>((resolve) => {
        resolvePage = resolve;
      }),
    );

    await mountGroups([group], images);
    fireEvent.click(screen.getByRole("button", { name: "查看分组第 3 张截图" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "图片大图预览" })).toBeTruthy());

    await act(async () => {
      resolvePage(pageOf(remaining)("gd", { limit: 50, offset: 0 }));
    });
    await waitFor(() => expect(counter()).toBe("1 / 6"));
    await waitFor(() => expect(bridge.clipboardImage).toHaveBeenLastCalledWith("d1"));
  });

  it("分组读取失败时给出准确错误，不伪装成可翻页的多图", async () => {
    const images = [makeImage("img1"), makeImage("img2")];
    const group = makeGroup("gx", "截图 · 已删除", images);
    bridge.clipboardGroupPage.mockRejectedValue(new Error("分组不存在"));

    await mountGroups([group], images);
    fireEvent.click(screen.getByRole("button", { name: "查看分组第 1 张截图" }));
    await waitFor(() => expect(document.querySelector(".clip-lightbox-list-error")).toBeTruthy());
    expect(document.querySelector(".clip-lightbox-list-error")?.textContent).toContain("分组图片读取失败");
    expect(counter()).toBeNull();

    // 失败后继续按方向键不应崩溃、也不应伪装出序号；Escape 仍关闭最上层。
    pressKey(3);
    expect(counter()).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "图片大图预览" })).toBeNull());
  });

  it("后续分页失败保留已加载图片，并显示错误", async () => {
    const images = Array.from({ length: 57 }, (_, i) => makeImage(`p${i + 1}`));
    const group = makeGroup("gp", "截图 · 分页失败", images);
    bridge.clipboardGroupPage.mockImplementation(async (id: string, opts: { limit?: number; offset?: number }) => {
      if ((opts.offset ?? 0) > 0) throw new Error("读取超时");
      return pageOf(images)(id, opts);
    });

    await mountGroups([group], images);
    fireEvent.click(screen.getByRole("button", { name: "查看分组第 1 张截图" }));
    await waitFor(() => expect(counter()).toBe("1 / 57"));

    pressKey(49);
    await waitFor(() => expect(counter()).toBe("50 / 57"));
    await waitFor(() =>
      expect(document.querySelector(".clip-lightbox-list-error")?.textContent).toContain("分组图片读取失败"),
    );

    // 失败后再次按右键：允许重试同一页，序号不变、错误仍明确，不跳到不存在的图片。
    pressKey(1);
    await waitFor(() =>
      expect(document.querySelector(".clip-lightbox-list-error")?.textContent).toContain("分组图片读取失败"),
    );
    expect(counter()).toBe("50 / 57");
  });

  it("关闭灯箱后清理状态，再次打开重新按第一页取图", async () => {
    const images = Array.from({ length: 4 }, (_, i) => makeImage(`c${i + 1}`));
    const group = makeGroup("gc", "截图 · 重开", images);
    bridge.clipboardGroupPage.mockImplementation(pageOf(images));

    await mountGroups([group], images);
    fireEvent.click(screen.getByRole("button", { name: "查看分组第 1 张截图" }));
    await waitFor(() => expect(counter()).toBe("1 / 4"));

    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "图片大图预览" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "查看分组第 1 张截图" }));
    await waitFor(() => expect(counter()).toBe("1 / 4"));
    expect(bridge.clipboardGroupPage).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(bridge.clipboardGroupPage).toHaveBeenLastCalledWith("gc", {
      limit: 50,
      offset: 0,
      imagesOnly: true,
    }));
  });
});
