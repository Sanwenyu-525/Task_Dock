/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipboardGroup, ClipboardItem, ClipboardGroupKindCounts } from "../../lib/bridge";
import ClipboardGroupCard from "./ClipboardGroupCard";

vi.mock("../../lib/bridge", () => ({
  clipboardThumb: vi.fn(async (id: string) => `data:image/png;base64,${id}`),
  clipboardImage: vi.fn(async () => "data:image/png;base64,large"),
}));

import { clipboardThumb } from "../../lib/bridge";

const thumbMock = vi.mocked(clipboardThumb);

function makeItem(id: string, patch: Partial<ClipboardItem> = {}): ClipboardItem {
  return {
    id,
    kind: "image",
    text: "",
    html: "",
    preview: "图片",
    title: "",
    title_source: "auto",
    byte_size: 1024,
    source_app: "snip.exe",
    source_title: "截图工具",
    source_kind: "owner",
    image_width: 1920,
    image_height: 1080,
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

function makeGroup(patch: Partial<ClipboardGroup> = {}): ClipboardGroup {
  return {
    id: "g1",
    name: "截图组",
    mode: "auto",
    status: "closed",
    favorite: false,
    pinned: false,
    created_at: "2026-11-05T09:00:00Z",
    updated_at: "2026-11-05T09:05:00Z",
    closed_at: "2026-11-05T09:05:00Z",
    item_count: 1,
    image_count: 0,
    preview: "",
    kind_counts: { image: 0, text: 0, html: 0, url: 0, files: 0 },
    cover_items: [],
    items: [],
    ...patch,
  };
}

const counts = (patch: Partial<ClipboardGroupKindCounts>): ClipboardGroupKindCounts => ({
  image: 0,
  text: 0,
  html: 0,
  url: 0,
  files: 0,
  ...patch,
});

const noop = () => {};

function renderCard(
  group: ClipboardGroup,
  overrides: {
    onDetail?: () => void;
    onOpenImage?: (item: ClipboardItem) => void;
    pending?: boolean;
  } = {},
) {
  const onDetail = overrides.onDetail ?? vi.fn();
  const onOpenImage = overrides.onOpenImage ?? vi.fn();
  const utils = render(
    <ClipboardGroupCard
      group={group}
      selected={false}
      linkMode={false}
      removing={false}
      pending={overrides.pending ?? false}
      onSelect={noop}
      onToggle={noop}
      onCopyRich={noop}
      onCopyFiles={noop}
      onPaste={noop}
      onDetail={onDetail}
      onDelete={noop}
      onLink={noop}
      onOpenImage={onOpenImage}
    />,
  );
  return { ...utils, onDetail, onOpenImage };
}

let originalIO: typeof IntersectionObserver | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  // 默认让封面视为已进入视口：大部分用例验证的是「可见后」的渲染，
  // 懒加载本身由下方「可见性加载」用例单独覆盖。
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalIO) globalThis.IntersectionObserver = originalIO;
});

describe("ClipboardGroupCard 预览", () => {
  it("图片组最多展示 3 张封面、真实数量与尺寸，点封面只开大图", async () => {
    const covers = [
      makeItem("cover-1"),
      makeItem("cover-2"),
      makeItem("cover-3"),
      makeItem("cover-4"),
    ];
    const { onDetail, onOpenImage } = renderCard(
      makeGroup({
        kind_counts: counts({ image: 5 }),
        cover_items: covers,
        image_count: 5,
        item_count: 5,
        preview: "图片 1920×1080",
      }),
    );

    expect(screen.getAllByRole("button", { name: /查看分组第 . 张截图/ })).toHaveLength(3);
    // 徽标移到封面旁（不压在缩略图上），且多图组不再把首图尺寸当整组尺寸
    expect(screen.getByText("5").classList.contains("clip-cover-total")).toBe(true);
    expect(screen.getByText(/5 张截图/)).toBeTruthy();
    expect(screen.queryByText(/1920×1080/)).toBeNull();

    await waitFor(() => expect(thumbMock).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "查看分组第 1 张截图" }));
    expect(onOpenImage).toHaveBeenCalledWith(covers[0]);
    expect(onDetail).not.toHaveBeenCalled();

    // 卡片根节点不再是按钮：鼠标点空白区打开详情，键盘走卡片内「详情」按钮
    fireEvent.click(screen.getByRole("article", { name: /分组 截图组/ }));
    expect(onDetail).toHaveBeenCalled();
  });

  it("内部复制按钮按 Enter 不会误开详情（根节点不再接管键盘）", () => {
    const { onDetail } = renderCard(
      makeGroup({
        kind_counts: counts({ image: 2 }),
        cover_items: [makeItem("cover-1"), makeItem("cover-2")],
        image_count: 2,
        item_count: 2,
      }),
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "复制整组内容" }), { key: "Enter" });
    expect(onDetail).not.toHaveBeenCalled();
  });

  it("低频操作收进「更多」菜单，删除与普通操作保持分离", async () => {
    renderCard(
      makeGroup({
        kind_counts: counts({ image: 2 }),
        cover_items: [makeItem("cover-1")],
        image_count: 2,
        item_count: 2,
      }),
    );
    expect(screen.getByRole("button", { name: "更多操作" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除分组" })).toBeTruthy();
    // 高频入口直接可见：复制整组、逐项粘贴、详情
    expect(screen.getByRole("button", { name: "复制整组内容" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "逐项粘贴" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看分组详情" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(await screen.findByText("复制文件路径（整组）")).toBeTruthy();
    expect(screen.getByText("置顶分组")).toBeTruthy();
    expect(screen.getByText("收藏分组")).toBeTruthy();
  });

  it("文本组展示可辨识摘要与类型数量", () => {
    renderCard(
      makeGroup({
        name: "文本 · 会议纪要",
        kind_counts: counts({ text: 2 }),
        item_count: 2,
        preview: "会议纪要：确认交付节奏与验收范围，下周一同步给客户。",
      }),
    );
    expect(
      screen.getByText("会议纪要：确认交付节奏与验收范围，下周一同步给客户。"),
    ).toBeTruthy();
    expect(screen.getByText("2 段文本")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /查看分组第/ })).toBeNull();
  });

  it("文件组展示代表文件名与文件数量", () => {
    renderCard(
      makeGroup({
        name: "文件 · 季度报告",
        kind_counts: counts({ files: 3 }),
        item_count: 3,
        preview: "季度报告.docx、预算.xlsx 等 3 个文件",
      }),
    );
    expect(screen.getByText("季度报告.docx、预算.xlsx 等 3 个文件")).toBeTruthy();
    expect(screen.getByText("3 个文件")).toBeTruthy();
  });

  it("混合组用代表封面 + 文本摘要 + 各类型数量", () => {
    renderCard(
      makeGroup({
        name: "文本 · 登录流程",
        kind_counts: counts({ image: 2, text: 1, url: 1 }),
        item_count: 4,
        image_count: 2,
        preview: "登录流程说明：先取令牌，再跳转回调。",
        cover_items: [makeItem("mix-1"), makeItem("mix-2")],
      }),
    );
    expect(screen.getByText("登录流程说明：先取令牌，再跳转回调。")).toBeTruthy();
    expect(screen.getByText("2 张截图 · 1 段文本 · 1 个链接")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /查看分组第/ })).toHaveLength(2);
  });

  it("缺缩略图的图片组统一走占位且仍可打开大图", () => {
    const missing = makeItem("missing-1", { has_thumb: false });
    renderCard(
      makeGroup({
        kind_counts: counts({ image: 1 }),
        image_count: 1,
        item_count: 1,
        preview: "图片 800×600",
        cover_items: [missing],
      }),
    );
    expect(document.querySelector(".clip-thumb-placeholder")).toBeTruthy();
    const open = screen.getByRole("button", { name: "查看分组第 1 张截图" });
    fireEvent.click(open);
    expect(open).toBeTruthy();
  });

  it("旧数据缺 kind_counts 时按 image_count/item_count 兜底", () => {
    const legacy = makeGroup({
      kind_counts: undefined,
      image_count: 1,
      item_count: 2,
      preview: "旧记录摘要",
    });
    renderCard(legacy);
    // 1 图 + 1 文本 → 混合；不臆造链接/文件数量。
    expect(screen.getByText("旧记录摘要")).toBeTruthy();
    expect(screen.getByText("1 张截图 · 1 段文本")).toBeTruthy();
  });

  it("删除请求在途时冻结操作并标记忙碌", () => {
    const { getByRole, getAllByRole } = renderCard(makeGroup(), { pending: true });
    expect(getByRole("article", { name: /分组 截图组/ }).getAttribute("aria-busy")).toBe("true");
    const all = getAllByRole("button");
    expect(all.some((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe("ClipboardGroupCard 可见性加载", () => {
  it("封面未进入视口时不发起缩略图 IPC，进入后才加载", async () => {
    class FakeObserver {
      static instances: FakeObserver[] = [];
      private readonly cb: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
        FakeObserver.instances.push(this);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      emit() {
        this.cb(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
    }
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;

    try {
      renderCard(
        makeGroup({
          id: "lazy-group",
          kind_counts: counts({ image: 2 }),
          image_count: 2,
          item_count: 2,
          preview: "图片 100×100",
          cover_items: [makeItem("lazy-1"), makeItem("lazy-2")],
        }),
      );
      expect(thumbMock).not.toHaveBeenCalled();
      await act(async () => {
        FakeObserver.instances[0].emit();
      });
      await waitFor(() => expect(thumbMock).toHaveBeenCalledTimes(2));
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });
});
