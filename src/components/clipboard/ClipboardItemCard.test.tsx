/**
 * @vitest-environment jsdom
 */
//! 历史条目卡片（2026-11-16 大卡片重构；2026-11-19 卡片精修）。
//!
//! 本轮守卫：
//! - 根节点 article：无 onClick / tabIndex / role=button；
//! - 主预览入口是真按钮 `.clip-item-main`，图片是并列的真按钮 `.clip-hero`；
//! - 复制 + 目标窗口合并为分体按钮，仍是两个独立动作；
//! - 详情不再有第二个卡片内入口：主体 → 右栏 → 完整详情；
//! - `previewed`（右栏正在展示）与 `selected`（批量勾选）互不覆盖；
//! - 同一行等高、元数据贴底、标题两行等 CSS 契约在页面样式表中守卫。
//!
//! jsdom 不做布局，所以**列数、卡片高度、行数截断**这类结果用 `?raw` 读 CSS
//! 断言规则存在且挂在正确的父级上；真实渲染由 Playwright 截图验收，不在这里冒充。

import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import appCss from "../../styles.css?raw";
import pageCss from "./clipboard-page.css?raw";
import ClipboardItemCard from "./ClipboardItemCard";
import type { ClipboardItem } from "../../lib/bridge";

vi.mock("../../lib/bridge", () => ({
  clipboardThumb: vi.fn(async () => null),
  clipboardPreview: vi.fn(async () => null),
  clipboardImage: vi.fn(async () => null),
}));

afterEach(() => {
  cleanup();
  // 窄卡测试会替换 ResizeObserver；还原后不影响同文件其他用例与 setup 的空实现。
  vi.unstubAllGlobals();
});

const LONG_TEXT =
  "task_dock — 方案 B 液态融合翼片最终版开发：本次改动集中在翼片表面材质、跨厚度渐变与内侧高光带，" +
  "同时把停靠边的方向换算进 SVG 渐变坐标，保证四条边共用一套语义 token，并且需要在 125% / 150% DPI 下复核。";

function makeItem(over: Partial<ClipboardItem> = {}): ClipboardItem {
  return {
    id: "ci1",
    kind: "text",
    text: "",
    html: "",
    preview: "预览",
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
    created_at: "2026-11-02T10:00:00Z",
    last_seen_at: "2026-11-02T10:00:00Z",
    has_image: false,
    has_thumb: false,
    ...over,
  };
}

type Handlers = {
  onSelect: () => void;
  onCopy: () => void;
  onCopySwitch: () => void;
  onToggle: (flag: "favorite" | "pinned") => void;
  onDetail: () => void;
  onPreview: () => void;
  onDelete: () => void;
  onLink: () => void;
  onOpenImage: () => void;
  onOpenUrl: () => void;
};

function renderCard(
  over: Partial<ClipboardItem> = {},
  density?: "comfort" | "compact" | "list",
  handlers: Partial<Handlers> = {},
  opts: { pending?: boolean; removing?: boolean; selected?: boolean; previewed?: boolean } = {},
) {
  const fns = {
    onSelect: vi.fn(),
    onCopy: vi.fn(),
    onCopySwitch: vi.fn(),
    onToggle: vi.fn(),
    onDetail: vi.fn(),
    onPreview: vi.fn(),
    onDelete: vi.fn(),
    onLink: vi.fn(),
    onOpenImage: vi.fn(),
    onOpenUrl: vi.fn(),
    ...handlers,
  };
  const { container } = render(
    <ClipboardItemCard
      item={makeItem(over)}
      selected={opts.selected ?? false}
      previewed={opts.previewed ?? false}
      linkMode={false}
      removing={opts.removing ?? false}
      pending={opts.pending ?? false}
      density={density}
      onSelect={fns.onSelect}
      onCopy={fns.onCopy}
      onCopySwitch={fns.onCopySwitch}
      onToggle={fns.onToggle}
      onDetail={fns.onDetail}
      onPreview={fns.onPreview}
      onDelete={fns.onDelete}
      onLink={fns.onLink}
      onOpenImage={fns.onOpenImage}
      onOpenUrl={fns.onOpenUrl}
    />,
  );
  const card = container.querySelector<HTMLElement>(".clip-item");
  if (!card) throw new Error("没有渲染出 .clip-item");
  return { card, fns };
}

/**
 * 模拟一次真实测量：ResizeObserver 在首次 observe 时就回调节点宽度。
 * 只在窄卡用例里替换，用例结束由 afterEach 还原测试环境的空实现。
 */
function stubCardWidth(width: number) {
  class FakeResizeObserver {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb(
        [{ target, contentRect: { width } }] as unknown as ResizeObserverEntry[],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver as unknown as typeof ResizeObserver);
}

/** 取样式表里精确匹配某个选择器的规则体（规则在选择器行单独成段）。 */
function ruleBody(css: string, selector: string): string {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = new RegExp(`(?:^|\\n)\\s*${escapeRe(selector)}\\s*\\{([^}]*)\\}`);
  const m = src.match(re);
  expect(m, `样式表缺少规则：${selector}`).not.toBeNull();
  return m![1];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("ClipboardItemCard 预览结构", () => {
  it("长中文正文：标题与正文都在 .clip-preview-body 内，文本按原文渲染（截断交给 CSS）", () => {
    const { card } = renderCard({ title: LONG_TEXT.slice(0, 12), preview: LONG_TEXT });

    const body = card.querySelector(".clip-preview-body");
    expect(body).not.toBeNull();

    const title = body!.querySelector(".clip-title");
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe(LONG_TEXT.slice(0, 12).trim());
    expect(title!.getAttribute("data-tip")).toBe(`标题：${title!.textContent}`);
    // 标题在按钮内部：不再单独可聚焦（按钮内嵌可聚焦元素是非法结构）
    expect(title!.getAttribute("tabindex")).toBeNull();

    const text = body!.querySelector(".clip-text");
    expect(text).not.toBeNull();
    expect(text!.classList.contains("clip-preview-sub")).toBe(true);
    expect(text!.textContent).toBe(LONG_TEXT);

    // 结构前提：.clip-preview 的直系子元素只有 .clip-preview-body，
    // 标题/正文都在它内部（旧截断规则 `.clip-preview > span` 已不会误伤正文）
    const direct = card.querySelectorAll(".clip-preview > span");
    expect(direct.length).toBe(1);
    expect(direct[0].classList.contains("clip-preview-body")).toBe(true);
  });

  it("无自动标题：正文占据主位，仍是正文类，且不挂弱化次行样式", () => {
    const { card } = renderCard({ title: "", preview: "只有正文没有标题的一行预览" });
    expect(card.querySelector(".clip-title")).toBeNull();
    const text = card.querySelector(".clip-preview-body > .clip-text");
    expect(text).not.toBeNull();
    expect(text!.classList.contains("clip-preview-sub")).toBe(false);
  });

  it("链接与文件记录：预览不带 clip-text，不会被当成多行正文", () => {
    for (const kind of ["url", "files"] as const) {
      cleanup();
      const { card } = renderCard({ kind, preview: "https://example.com/" + "a".repeat(200) });
      const span = card.querySelector(".clip-preview-body > span");
      expect(span, `${kind} 预览应仍在 .clip-preview-body 内`).not.toBeNull();
      expect(span!.classList.contains("clip-text")).toBe(false);
    }
  });

  it("富文本：预览与标题同时存在时，正文仍是正文类且保留换行", () => {
    const { card } = renderCard({
      kind: "html",
      title: "表格：v0.7 验收项",
      preview: "验收项\t结果\t备注\n翼片材质\t通过",
    });
    expect(card.querySelector(".clip-preview-body > .clip-title")).not.toBeNull();
    const text = card.querySelector(".clip-preview-body > .clip-text");
    expect(text).not.toBeNull();
    expect(text!.textContent).toContain("\n");
  });
});

describe("ClipboardItemCard 主预览按钮与误触隔离", () => {
  it("根节点不再冒充按钮：没有 role=button / tabIndex / onClick", () => {
    const { card } = renderCard();
    expect(card.getAttribute("role")).toBeNull();
    expect(card.getAttribute("tabindex")).toBeNull();
    // 只有真实按钮才有 tabIndex，卡片本身不进 Tab 序列
    expect(card.querySelectorAll("button").length).toBeGreaterThanOrEqual(2);
  });

  it("点主预览：只打开预览，不复制、不选择、不打开完整详情", async () => {
    const user = userEvent.setup();
    const { card, fns } = renderCard({ title: "标题", preview: "正文" });
    const main = card.querySelector<HTMLButtonElement>(".clip-item-main")!;
    expect(main.getAttribute("aria-label")).toContain("打开右侧预览");

    await user.click(main);
    expect(fns.onPreview).toHaveBeenCalledTimes(1);
    expect(fns.onDetail).not.toHaveBeenCalled();
    expect(fns.onCopy).not.toHaveBeenCalled();
    expect(fns.onSelect).not.toHaveBeenCalled();
  });

  it("键盘 Enter 在主预览上只触发一次预览（不再叠加卡片级 Enter）", async () => {
    const user = userEvent.setup();
    const { card, fns } = renderCard();
    const main = card.querySelector<HTMLButtonElement>(".clip-item-main")!;
    main.focus();
    await user.keyboard("{Enter}");
    expect(fns.onPreview).toHaveBeenCalledTimes(1);
    expect(fns.onDetail).not.toHaveBeenCalled();
  });

  it("点复制只复制；点选择只选择（互不附带第二个动作）", async () => {
    const user = userEvent.setup();
    const { card, fns } = renderCard();
    await user.click(card.querySelector<HTMLButtonElement>('[aria-label="复制"]')!);
    expect(fns.onCopy).toHaveBeenCalledTimes(1);
    expect(fns.onPreview).not.toHaveBeenCalled();
    expect(fns.onDetail).not.toHaveBeenCalled();

    await user.click(card.querySelector<HTMLButtonElement>('[aria-label="选择条目"]')!);
    expect(fns.onSelect).toHaveBeenCalledTimes(1);
    expect(fns.onCopy).toHaveBeenCalledTimes(1);
  });

  it("删除在途：主预览与复制都禁用（不打开一个即将消失的条目）", () => {
    const { card } = renderCard({}, undefined, {}, { pending: true });
    expect(card.querySelector<HTMLButtonElement>(".clip-item-main")!.disabled).toBe(true);
    expect(card.querySelector<HTMLButtonElement>('[aria-label="复制"]')!.disabled).toBe(true);
  });
});

describe("ClipboardItemCard 预览态与批量选中相互独立", () => {
  it("预览态：左侧强调条 + 「预览中」标记，不写入批量选择状态", () => {
    const { card, fns } = renderCard({ title: "正在右栏展示" }, "comfort", {}, { previewed: true });
    expect(card.classList.contains("previewed")).toBe(true);
    expect(card.classList.contains("selected")).toBe(false);
    expect(card.querySelector(".clip-preview-tag")?.textContent).toContain("预览中");
    const select = card.querySelector<HTMLButtonElement>('[aria-label="选择条目"]')!;
    expect(select.getAttribute("aria-pressed")).toBe("false");
    // 预览态是「右栏正在看这条」，不能顺带把条目加入批量操作。
    expect(fns.onSelect).not.toHaveBeenCalled();
    // 预览中的卡片仍然可以直接复制和打开目标窗口。
    expect(card.querySelector<HTMLButtonElement>('[aria-label="复制"]')!.disabled).toBe(false);
    expect(
      card.querySelector<HTMLButtonElement>('[aria-label="复制或粘贴到目标窗口"]')!.disabled,
    ).toBe(false);
  });

  it("批量选中：只显示勾选与选中底色，不出现「预览中」标签", () => {
    const { card } = renderCard({ title: "被勾选" }, "comfort", {}, { selected: true });
    expect(card.classList.contains("selected")).toBe(true);
    expect(card.classList.contains("previewed")).toBe(false);
    expect(card.querySelector(".clip-preview-tag")).toBeNull();
    expect(card.querySelector<HTMLButtonElement>(".clip-check")!.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("两种状态可以同时存在，互不覆盖", () => {
    const { card } = renderCard({ title: "既被勾选又在预览" }, "comfort", {}, {
      selected: true,
      previewed: true,
    });
    expect(card.classList.contains("selected")).toBe(true);
    expect(card.classList.contains("previewed")).toBe(true);
    expect(card.querySelector(".clip-preview-tag")?.textContent).toContain("预览中");
    expect(card.querySelector<HTMLButtonElement>(".clip-check")!.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("没有右栏宿主时，主按钮文案回退为「打开完整详情」", () => {
    const { card } = renderCard({}, "comfort", { onPreview: undefined as unknown as () => void });
    const main = card.querySelector<HTMLButtonElement>(".clip-item-main")!;
    expect(main.getAttribute("aria-label")).toContain("打开完整详情");
  });
});

describe("ClipboardItemCard 更多操作菜单", () => {
  it("宽卡片：复制与收藏/置顶常显，菜单只留低频动作，不存在重复详情入口", async () => {
    const user = userEvent.setup();
    const { card, fns } = renderCard({ title: "待整理" }, "comfort");

    // 高频动作仍留在行内：复制 + 更多；辅助动作在空间足够时也直接可见。
    expect(card.querySelector('[aria-label="复制"]')).not.toBeNull();
    expect(card.querySelector('[aria-label="更多操作"]')).not.toBeNull();
    const actions = card.querySelector<HTMLElement>(".clip-actions")!;

    await user.click(within(actions).getByRole("button", { name: "收藏" }));
    expect(fns.onToggle).toHaveBeenCalledWith("favorite");
    expect(fns.onDetail).not.toHaveBeenCalled();

    await user.click(within(actions).getByRole("button", { name: "置顶" }));
    expect(fns.onToggle).toHaveBeenCalledWith("pinned");

    // 卡片主体已经是预览入口，动作行不再有含义相同的「查看详情」。
    expect(within(actions).queryByRole("button", { name: "查看详情" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "查看详情" })).toBeNull();

    await user.click(card.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!);
    const menu = await screen.findByRole("menu");
    // 同一动作不同时出现在行内与菜单里：菜单只剩删除（类型专属项按需出现）。
    expect(within(menu).queryByRole("menuitem", { name: /收藏|置顶|查看详情/ })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: /删除这条历史/ })).toBeTruthy();
    expect(screen.queryByRole("menu")).not.toBeNull();
  });

  it("窄卡片：辅助动作全部收回菜单，不在行内挤压复制", async () => {
    // jsdom 的 ResizeObserver 不会回调；这里模拟首次 observe 就量到 220px。
    stubCardWidth(220);
    const { card } = renderCard({ title: "窄卡" }, "comfort");
    // 菜单定位/浮层不再需要假测量，先还原测试环境的空实现。
    vi.unstubAllGlobals();

    const actions = card.querySelector<HTMLElement>(".clip-actions")!;
    expect(within(actions).queryByRole("button", { name: "收藏" })).toBeNull();
    expect(within(actions).queryByRole("button", { name: "查看详情" })).toBeNull();

    const user = userEvent.setup();
    await user.click(card.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!);
    const menu = await screen.findByRole("menu");
    for (const name of [/^收藏$/, /^置顶$/, /删除这条历史/]) {
      expect(within(menu).getByRole("menuitem", { name })).toBeTruthy();
    }
    expect(within(menu).queryByRole("menuitem", { name: /查看详情/ })).toBeNull();
  });

  it("删除项标注「不会删除本地文件」并只调用删除", async () => {
    const user = userEvent.setup();
    const { card, fns } = renderCard({ kind: "files", file_paths: ["C:/tmp/a.txt"] });
    await user.click(card.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!);
    const del = await screen.findByRole("menuitem", { name: /删除这条历史/ });
    expect(del.textContent).toContain("不会删除本地文件");
    await user.click(del);
    expect(fns.onDelete).toHaveBeenCalledTimes(1);
    expect(fns.onDetail).not.toHaveBeenCalled();
  });

  it("Escape 关闭菜单（一次按键只关一层）", async () => {
    const user = userEvent.setup();
    const { card } = renderCard();
    await user.click(card.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!);
    expect(await screen.findByRole("menu")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("ClipboardItemCard 密度呈现", () => {
  it("舒适图片：is-card + is-hero，主视觉是独立大图按钮，不再渲染小缩略图", () => {
    const { card } = renderCard({ kind: "image", title: "截图 1440×900", preview: "1440×900 · PNG", has_thumb: true }, "comfort");
    expect(card.classList.contains("is-card")).toBe(true);
    expect(card.classList.contains("is-hero")).toBe(true);
    const hero = card.querySelector<HTMLButtonElement>(".clip-hero");
    expect(hero, "舒适态图片应有独立大图预览按钮").not.toBeNull();
    expect(hero!.getAttribute("aria-label")).toContain("查看大图");
    expect(card.querySelector(".clip-thumb-open")).toBeNull();
    // 图片按钮与正文按钮并列：不存在 button 嵌套 button
    expect(card.querySelector(".clip-hero button")).toBeNull();
    expect(card.querySelector(".clip-item-main button")).toBeNull();
  });

  it("舒适图片：自动标题「截图 W×H」不重复显示；有真实文件名时保留标题", () => {
    const auto = renderCard(
      { kind: "image", title: "截图 1440×900", preview: "1440×900 · PNG", has_thumb: true },
      "comfort",
    );
    expect(auto.card.querySelector(".clip-title")).toBeNull();
    cleanup();
    const named = renderCard(
      { kind: "image", title: "设计稿-首页", preview: "", has_thumb: true },
      "comfort",
    );
    expect(named.card.querySelector(".clip-title")?.textContent).toBe("设计稿-首页");
  });

  it("舒适竖图：is-tall 使用左侧纵向舞台，右侧正文与动作，不把整行拉成两倍高", () => {
    const { card } = renderCard(
      { kind: "image", has_thumb: true, image_width: 900, image_height: 1600 },
      "comfort",
    );
    expect(card.classList.contains("is-hero")).toBe(true);
    expect(card.classList.contains("is-tall")).toBe(true);
    const wide = renderCard(
      { kind: "image", has_thumb: true, image_width: 2560, image_height: 1080 },
      "comfort",
    );
    expect(wide.card.classList.contains("is-tall")).toBe(false);
  });

  it("紧凑图片：is-card + is-thumb，使用 64px 缩略图，不请求大图", () => {
    const { card } = renderCard({ kind: "image", has_thumb: true }, "compact");
    expect(card.classList.contains("is-card")).toBe(true);
    expect(card.classList.contains("is-thumb")).toBe(true);
    const img = card.querySelector<HTMLImageElement>(".clip-thumb");
    expect(card.querySelector(".clip-hero")).toBeNull();
    // 无缩略图数据时是占位，但仍包在缩略图按钮里
    expect(card.querySelector(".clip-thumb-open")).not.toBeNull();
    expect(img?.getAttribute("width") ?? "64").toBe("64");
  });

  it("列表密度：行布局，不带卡片态类，正文仍可多行", () => {
    const { card } = renderCard({ kind: "text", preview: LONG_TEXT }, "list");
    expect(card.classList.contains("is-row")).toBe(true);
    expect(card.classList.contains("is-card")).toBe(false);
    expect(card.querySelector(".clip-item-main")).not.toBeNull();
  });

  it("文件条目按密度收敛行数：舒适 5 行 + 汇总，紧凑 3 行，列表 2 行", () => {
    const paths = Array.from({ length: 8 }, (_, i) => `C:/Users/demo/Documents/2026/季度报告-${i + 1}.pdf`);
    for (const [density, rows, more] of [
      ["comfort", 5, "还有 3 个文件"],
      ["compact", 3, "还有 5 个文件"],
      ["list", 2, "还有 6 个文件"],
    ] as const) {
      cleanup();
      const { card } = renderCard({ kind: "files", preview: "8 个文件", file_paths: paths }, density);
      const names = card.querySelectorAll(".clip-file-row:not(.clip-file-more)");
      expect(names.length, `${density} 文件行数`).toBe(rows);
      expect(card.textContent).toContain(more);
      expect(card.textContent).toContain("仅记录路径，删除历史不会删除本地文件");
      expect(card.textContent).toContain("来源目录 C:/Users/demo/Documents/2026");
      // 每个文件名都有类型名，长路径完整值进 data-tip
      expect(card.querySelector(".clip-file-kind")?.textContent?.trim()).not.toBe("");
      expect(card.querySelector(".clip-file-name")?.getAttribute("data-tip")).toContain("C:/Users/demo");
    }
  });
});

describe("ClipboardItemCard 图片缩略图直达灯箱", () => {
  it("点击缩略图直接打开大图，且不触发预览/详情/选择", () => {
    const { card, fns } = renderCard({ kind: "image", has_thumb: true });
    const btn = card.querySelector<HTMLButtonElement>(".clip-thumb-open");
    expect(btn, "缩略图应包成独立按钮").not.toBeNull();
    expect(btn!.getAttribute("aria-label")).toBe("查看大图");
    fireEvent.click(btn!);
    expect(fns.onOpenImage).toHaveBeenCalledTimes(1);
    expect(fns.onPreview).not.toHaveBeenCalled();
    expect(fns.onDetail).not.toHaveBeenCalled();
    expect(fns.onSelect).not.toHaveBeenCalled();
  });

  it("无缩略图时仍可点击：交给灯箱如实报缺失，而不是给一个死图标", () => {
    const { card, fns } = renderCard({ kind: "image", has_thumb: false });
    const btn = card.querySelector<HTMLButtonElement>(".clip-thumb-open");
    expect(btn).not.toBeNull();
    expect(btn!.querySelector(".clip-thumb-placeholder")).not.toBeNull();
    fireEvent.click(btn!);
    expect(fns.onOpenImage).toHaveBeenCalledTimes(1);
  });

  it("删除在途时缩略图不可点（不打开一个即将消失的条目）", () => {
    const { card } = renderCard({ kind: "image", has_thumb: true }, undefined, {}, { pending: true });
    expect(card.querySelector(".clip-thumb-open")).toBeNull();
    expect(card.querySelector(".clip-thumb-placeholder")).not.toBeNull();
  });
});

/**
 * 图片没有「正文」：preview（「图片 W×H」）只是尺寸描述，
 * 把它当正文渲染会凭空造出一条并不存在的文本。
 */
describe("ClipboardItemCard 图片标题与正文严格区分", () => {
  it("图片不出现伪造的文本正文：尺寸描述不进正文行", () => {
    const { card } = renderCard(
      {
        kind: "image",
        title: "截图 1476×1198",
        preview: "图片 1476×1198",
        text: "",
        has_thumb: true,
        image_width: 1476,
        image_height: 1198,
      },
      "comfort",
    );
    expect(card.textContent).not.toContain("图片 1476×1198");
    expect(card.querySelector(".clip-preview-body")?.textContent).toBe("");
    // 尺寸仍然如实展示在元数据行里
    expect(card.querySelector(".clip-meta-facts")?.textContent).toContain("1476×1198");
  });

  it("图片采集时真实存在的附带文本才作为正文展示", () => {
    const { card } = renderCard(
      {
        kind: "image",
        title: "截图 1476×1198",
        preview: "图片 1476×1198",
        text: "来自截图工具的附带文本",
        has_thumb: true,
      },
      "comfort",
    );
    const body = card.querySelector(".clip-preview-body");
    expect(body?.textContent).toContain("来自截图工具的附带文本");
    expect(card.textContent).not.toContain("图片 1476×1198");
  });

  it("手动命名的图片保留标题，尺寸描述仍不作为正文", () => {
    const { card } = renderCard(
      {
        kind: "image",
        title: "设计稿-首页",
        preview: "图片 1476×1198",
        text: "",
        has_thumb: true,
      },
      "comfort",
    );
    expect(card.querySelector(".clip-title")?.textContent).toBe("设计稿-首页");
    expect(card.textContent).not.toContain("图片 1476×1198");
  });
});

describe("styles.css 预览截断契约", () => {
  it("正文行数由 --clip-text-lines 提供，且 line-clamp 自带 overflow:hidden", () => {
    const body = ruleBody(appCss, ".clip-preview-body > .clip-text");
    expect(body).toMatch(/display:\s*-webkit-box/);
    expect(body).toMatch(/-webkit-line-clamp:\s*var\(--clip-text-lines,\s*2\)/);
    expect(body).toMatch(/-webkit-box-orient:\s*vertical/);
    // 缺这一条时 line-clamp 只压布局盒，文字会画到卡片外
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
    expect(body).toMatch(/white-space:\s*pre-wrap/);
  });

  it("卡片根是具名网格：check/thumb/top/main/actions 各有区域，正文按钮不嵌套", () => {
    const base = ruleBody(appCss, ".clip-item");
    expect(base).toMatch(/display:\s*grid/);
    expect(base).toMatch(/grid-template-areas:/);
    for (const area of ["check", "thumb", "top", "main", "actions"]) {
      expect(appCss).toContain(`grid-area: ${area};`);
    }
    const main = ruleBody(appCss, ".clip-item > .clip-item-main");
    expect(main).toMatch(/border:\s*0/);
    expect(main).toMatch(/background:\s*transparent/);
    expect(main).toMatch(/padding:\s*0/);
  });

  it("正文截断不依赖祖先选择器：凡是用 line-clamp 的 .clip-text 规则都自带 overflow", () => {
    const rules = [...appCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)];
    const clampRules = rules.filter((r) => r[1].includes(".clip-text") && /-webkit-line-clamp/.test(r[2]));
    expect(clampRules.length).toBeGreaterThan(0);
    for (const [, selector, body] of clampRules) {
      expect(
        /overflow(-y)?:\s*(hidden|clip)/.test(body),
        `规则「${selector.trim()}」用了 -webkit-line-clamp 却没有自带 overflow`,
      ).toBe(true);
    }
  });
});

describe("clipboard-page.css 大卡片契约", () => {
  it("舒适网格以 300px 为最小合理宽度；列数完全交给容器宽度，不写死 4/5 列", () => {
    const grid = ruleBody(pageCss, ".clipboard-page .clip-list-grid");
    expect(grid).toMatch(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(300px,\s*1fr\)\)/);
    expect(grid).toMatch(/align-items:\s*stretch/);
    // 1320/1920 这类「按窗口宽度硬塞」的列数规则已删除：内容区只有 1294/1614px，
    // 那些断点永远不会命中，反而在 1920 窗口把 5 列锁成 4 列。
    expect(pageCss).not.toMatch(/clip-list-grid\.clip-density-comfort[^}]*repeat\((4|5),/);
    expect(pageCss).not.toMatch(/@container clip-page \(min-width: 1320px\)/);
    expect(pageCss).not.toMatch(/@container clip-page \(min-width: 1920px\)/);
    // 列表密度是单行密排：不能跟着页面态一起被等高拉伸。
    const listGrid = ruleBody(pageCss, ".clipboard-page .clip-list-grid.clip-density-list");
    expect(listGrid).toMatch(/align-items:\s*start/);
  });

  it("舒适卡片模板：顶行/大图/正文/动作各占一行，动作行贴底、稳定最小高度", () => {
    const card = ruleBody(pageCss, ".clipboard-page .clip-item.is-card");
    expect(card).toMatch(/grid-template-areas:/);
    expect(card).toMatch(/"top check"/);
    expect(card).toMatch(/"actions actions"/);
    expect(card).toMatch(/grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/);
    expect(card).toMatch(/min-height:\s*184px/);
    const heroCard = ruleBody(pageCss, ".clipboard-page .clip-item.is-card.is-hero");
    expect(heroCard).toMatch(/"hero hero"/);
    const actions = ruleBody(pageCss, ".clipboard-page .clip-item.is-card > .clip-actions");
    expect(actions).toMatch(/border-top:/);
    expect(actions).toMatch(/opacity:\s*1/);
    // 元数据贴底：短正文留下的是正文区余量，来源/大小/次数不会浮在卡片中间。
    const meta = ruleBody(pageCss, ".clipboard-page .clip-item.is-card .clip-meta");
    expect(meta).toMatch(/margin-top:\s*auto/);
    expect(meta).toMatch(/flex-wrap:\s*nowrap/);
  });

  it("标题在舒适卡最多两行，紧凑/列表仍保持单行", () => {
    const title = ruleBody(pageCss, ".clipboard-page .clip-item.is-card .clip-preview .clip-title");
    expect(title).toMatch(/-webkit-line-clamp:\s*2/);
    expect(title).toMatch(/white-space:\s*normal/);
    const compact = ruleBody(
      pageCss,
      ".clipboard-page .clip-density-compact .clip-item .clip-preview .clip-title",
    );
    expect(compact).toMatch(/white-space:\s*nowrap/);
    expect(compact).toMatch(/-webkit-line-clamp:\s*unset/);
  });

  it("大图预览：宽图 104–124px 舞台；竖图左侧纵向舞台 186–206px，完整展示不裁切", () => {
    const hero = ruleBody(pageCss, ".clipboard-page .clip-item.is-hero > .clip-hero");
    expect(hero).toMatch(/height:\s*clamp\(104px,\s*9cqi,\s*124px\)/);
    expect(hero).toMatch(/cursor:\s*zoom-in/);
    const tall = ruleBody(pageCss, ".clipboard-page .clip-item.is-hero.is-tall");
    expect(tall).toMatch(/grid-template-columns:\s*minmax\(128px,\s*42%\)/);
    expect(tall).toMatch(/"hero main main"/);
    expect(tall).toMatch(/min-height:\s*220px/);
    const tallHero = ruleBody(pageCss, ".clipboard-page .clip-item.is-hero.is-tall > .clip-hero");
    expect(tallHero).toMatch(/min-height:\s*186px/);
    expect(tallHero).toMatch(/max-height:\s*206px/);
    const img = ruleBody(pageCss, ".clipboard-page .clip-hero-img");
    expect(img).toMatch(/object-fit:\s*contain/);
    expect(img).toMatch(/max-width:\s*100%/);
  });

  it("三种密度的正文行数：舒适最多 5 行；紧凑 2 行、列表 1 行", () => {
    expect(ruleBody(pageCss, ".clipboard-page .clip-density-comfort .clip-item")).toMatch(
      /--clip-text-lines:\s*3/,
    );
    expect(ruleBody(pageCss, ".clipboard-page .clip-density-compact .clip-item")).toMatch(
      /--clip-text-lines:\s*2/,
    );
    expect(ruleBody(pageCss, ".clipboard-page .clip-density-list .clip-item")).toMatch(
      /--clip-text-lines:\s*1/,
    );
    expect(pageCss).toMatch(
      /@container clip-page \(min-width: 1000px\)[\s\S]*?--clip-text-lines:\s*5/,
    );
    // 6 行会把 1300px 容器里的长文本卡拉得比图片卡还高；本轮明确取消。
    expect(pageCss).not.toMatch(/--clip-text-lines:\s*6/);
  });

  it("紧凑卡优先保住来源名，次数在窄卡隐藏，不把「截图工具」挤成「截」", () => {
    const app = ruleBody(
      pageCss,
      ".clipboard-page .clip-density-compact .clip-item.is-card .clip-meta-app",
    );
    expect(app).toMatch(/max-width:\s*46%/);
    expect(app).toMatch(/flex-shrink:\s*0/);
    const use = ruleBody(
      pageCss,
      ".clipboard-page .clip-density-compact .clip-item.is-card .clip-meta-use",
    );
    expect(use).toMatch(/display:\s*none/);
  });
});

describe("ClipboardItemCard 来源信息", () => {
  it("展示人类可读应用名与「窗口」标题，不直接暴露 exe", () => {
    const { card } = renderCard({
      source_app: "chrome.exe",
      source_title: "Go | OpenCode Console - Google Chrome",
    });
    const app = card.querySelector(".clip-meta-app");
    expect(app).not.toBeNull();
    expect(app!.textContent).toBe("Google Chrome");

    const win = card.querySelector(".clip-meta-window");
    expect(win).not.toBeNull();
    expect(win!.textContent).toContain("窗口");
    expect(win!.textContent).toContain("Go | OpenCode Console");
    expect(win!.textContent).not.toContain("Google Chrome");

    expect(card.textContent).not.toContain("chrome.exe");
    expect(win!.getAttribute("data-tip")).toContain("chrome.exe");
    // 窗口标题不再是独立焦点目标（它在主预览按钮内部，嵌套焦点会破坏按钮语义）；
    // 完整来源改由主按钮的 aria-label 提供给键盘与读屏用户。
    expect(win!.getAttribute("tabindex")).toBeNull();
    const main = card.querySelector<HTMLButtonElement>(".clip-item-main")!;
    expect(main.getAttribute("aria-label")).toContain("Google Chrome");
    expect(main.getAttribute("aria-label")).toContain("Go | OpenCode Console");
  });

  it("未知来源渲染为「未知应用」，不崩也不猜", () => {
    const { card } = renderCard({ source_app: "unknown", source_title: "" });
    expect(card.querySelector(".clip-meta-app")!.textContent).toBe("未知应用");
    expect(card.querySelector(".clip-meta-app")!.getAttribute("title")).toBeNull();
    expect(card.querySelector(".clip-meta-window")).toBeNull();
    expect(card.querySelector(".clip-meta")!.textContent).toContain("20 B");
  });
});

describe("ClipboardItemCard 分体复制按钮", () => {
  it("点箭头直接打开目标选择器：不复制、不打开预览/详情，没有菜单层级", async () => {
    const user = userEvent.setup();
    const { card, fns } = renderCard();
    const arrow = card.querySelector<HTMLButtonElement>('[aria-label="复制或粘贴到目标窗口"]')!;
    expect(arrow.getAttribute("aria-haspopup")).toBeNull();
    expect(arrow.getAttribute("aria-expanded")).toBeNull();

    await user.click(arrow);
    expect(fns.onCopySwitch).toHaveBeenCalledTimes(1);
    expect(fns.onCopy).not.toHaveBeenCalled();
    expect(fns.onPreview).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("未提供 onCopySwitch 时只渲染主复制按钮，不出现空入口", () => {
    const { container } = render(
      <ClipboardItemCard
        item={makeItem()}
        selected={false}
        linkMode={false}
        removing={false}
        pending={false}
        onSelect={vi.fn()}
        onCopy={vi.fn()}
        onToggle={vi.fn()}
        onDetail={vi.fn()}
        onDelete={vi.fn()}
        onLink={vi.fn()}
      />,
    );
    expect(container.querySelector('[aria-label="复制或粘贴到目标窗口"]')).toBeNull();
    expect(container.querySelector('[aria-label="复制"]')).not.toBeNull();
  });
});
