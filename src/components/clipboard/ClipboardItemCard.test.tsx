/**
 * @vitest-environment jsdom
 */
//! 历史条目卡片的「标题一行 + 正文两行」布局守卫。
//!
//! 回归背景：标题/预览改成 `.clip-preview-body` 纵向排列后，旧的截断约束
//! （`.clip-preview > span`）不再命中，`.clip-text` 只剩 `-webkit-line-clamp`
//! 而没有自己的 `overflow: hidden`。line-clamp 只压布局盒高度，剩余行照样绘制，
//! 于是卡片高度不变、文字却盖住下一张卡和底部状态栏。
//!
//! 这里锁两件事：
//! 1. DOM 契约——预览文本一律放在 `.clip-preview-body` 里，`.clip-preview`
//!    不再有直系 span（否则截断规则会再次落空）；
//! 2. CSS 契约——截断声明必须挂在新的父级上，且 line-clamp 必须自带 overflow。
//!    jsdom 不做布局，所以样式用 `?raw` 读原文断言，和 `styles-themes.test.ts` 同路。

import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach } from "vitest";
import appCss from "../../styles.css?raw";
import ClipboardItemCard from "./ClipboardItemCard";
import type { ClipboardItem } from "../../lib/bridge";

afterEach(cleanup);

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

function renderCard(over: Partial<ClipboardItem> = {}) {
  const { container } = render(
    <ClipboardItemCard
      item={makeItem(over)}
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
  const card = container.querySelector<HTMLElement>(".clip-item");
  if (!card) throw new Error("没有渲染出 .clip-item");
  return card;
}

/** 取样式表里精确匹配某个选择器的规则体（规则在选择器行单独成段）。 */
function ruleBody(css: string, selector: string): string {
  const src = appCssClean(css);
  const re = new RegExp(`(?:^|\\n)\\s*${escapeRe(selector)}\\s*\\{([^}]*)\\}`);
  const m = src.match(re);
  expect(m, `styles.css 缺少规则：${selector}`).not.toBeNull();
  return m![1];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const appCssClean = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("ClipboardItemCard 预览结构", () => {
  it("长中文正文：标题与正文都在 .clip-preview-body 内，文本按原文渲染（截断交给 CSS）", () => {
    const long =
      "task_dock — 方案 B 液态融合翼片最终版开发：本次改动集中在翼片表面材质、跨厚度渐变与内侧高光带，" +
      "同时把停靠边的方向换算进 SVG 渐变坐标，保证四条边共用一套语义 token，并且需要在 125% / 150% DPI 下复核。";
    const card = renderCard({ title: "task_dock — 方案 B 液态融合翼片最终版开发", preview: long });

    const body = card.querySelector(".clip-preview-body");
    expect(body).not.toBeNull();

    const title = body!.querySelector(".clip-title");
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe("task_dock — 方案 B 液态融合翼片最终版开发");
    // 单行省略靠 CSS；完整标题进 data-tip（悬停与键盘焦点都能看全），未被 JS 截断
    expect(title!.getAttribute("data-tip")).toBe(`标题：${title!.textContent}`);
    expect(title!.getAttribute("tabindex")).toBe("0");

    const text = body!.querySelector(".clip-text");
    expect(text).not.toBeNull();
    expect(text!.classList.contains("clip-preview-sub")).toBe(true);
    expect(text!.textContent).toBe(long);

    // 结构前提：.clip-preview 不再有直系 span，
    // 否则「.clip-preview > span」的旧截断规则会再次落空
    expect(card.querySelector(".clip-preview > span")).toBeNull();
  });

  it("无自动标题：正文占据主位，仍是两行截断类，且不挂弱化次行样式", () => {
    const card = renderCard({ title: "", preview: "只有正文没有标题的一行预览" });
    expect(card.querySelector(".clip-title")).toBeNull();
    const text = card.querySelector(".clip-preview-body > .clip-text");
    expect(text).not.toBeNull();
    expect(text!.classList.contains("clip-preview-sub")).toBe(false);
  });

  it("链接与文件记录：预览走单行省略（不带 clip-text），不会被当成两行正文", () => {
    for (const kind of ["url", "files"] as const) {
      cleanup();
      const card = renderCard({ kind, preview: "https://example.com/" + "a".repeat(200) });
      const span = card.querySelector(".clip-preview-body > span");
      expect(span, `${kind} 预览应仍在 .clip-preview-body 内`).not.toBeNull();
      expect(span!.classList.contains("clip-text")).toBe(false);
    }
  });

  it("富文本：预览与标题同时存在时，正文仍是两行截断类", () => {
    const card = renderCard({ kind: "html", title: "表格：v0.7 验收项", preview: "验收项\t结果\t备注\n翼片材质\t通过" });
    expect(card.querySelector(".clip-preview-body > .clip-title")).not.toBeNull();
    const text = card.querySelector(".clip-preview-body > .clip-text");
    expect(text).not.toBeNull();
    expect(text!.textContent).toContain("\n");
  });

  it("图片记录：缩略图与文本预览并排，文本仍受预览体约束", () => {
    const card = renderCard({ kind: "image", title: "截图 2026-11-02", preview: "1440×900 · PNG" });
    expect(card.querySelector(".clip-preview.with-thumb")).not.toBeNull();
    expect(card.querySelector(".clip-thumb-placeholder")).not.toBeNull();
    expect(card.querySelector(".clip-preview-body > .clip-title")).not.toBeNull();
  });
});

describe("ClipboardItemCard 图片缩略图直达灯箱", () => {
  /** 缩略图按钮化后必须满足：不冒泡到卡片（否则同时打开详情）、键盘可达、有 aria-label。 */
  function renderImageCard(over: Partial<ClipboardItem> = {}, opts: { locked?: boolean } = {}) {
    const onOpenImage = vi.fn();
    const onDetail = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <ClipboardItemCard
        item={makeItem({ kind: "image", title: "截图 800×500", preview: "800×500", ...over })}
        selected={false}
        linkMode={false}
        removing={false}
        pending={opts.locked ?? false}
        onSelect={onSelect}
        onCopy={vi.fn()}
        onToggle={vi.fn()}
        onDetail={onDetail}
        onDelete={vi.fn()}
        onLink={vi.fn()}
        onOpenImage={onOpenImage}
      />,
    );
    const card = container.querySelector<HTMLElement>(".clip-item")!;
    return { card, onOpenImage, onDetail, onSelect };
  }

  it("点击缩略图直接打开大图，且不触发卡片详情与选择", () => {
    const { card, onOpenImage, onDetail, onSelect } = renderImageCard();
    const btn = card.querySelector<HTMLButtonElement>(".clip-thumb-open");
    expect(btn, "缩略图应包成独立按钮").not.toBeNull();
    expect(btn!.getAttribute("aria-label")).toBe("查看大图");
    fireEvent.click(btn!);
    expect(onOpenImage).toHaveBeenCalledTimes(1);
    // 卡片本身 role=button：冒泡会顺带打开详情，必须被拦下
    expect(onDetail).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("键盘 Enter 激活缩略图，按键不外传给卡片（避免同时打开详情）", () => {
    const { card, onOpenImage, onDetail } = renderImageCard();
    const btn = card.querySelector<HTMLButtonElement>(".clip-thumb-open")!;
    fireEvent.keyDown(btn, { key: "Enter" });
    // 按键不冒泡：卡片上的 Enter → 打开详情 不应被触发
    expect(onDetail).not.toHaveBeenCalled();
    fireEvent.click(btn);
    expect(onOpenImage).toHaveBeenCalledTimes(1);
  });

  it("无缩略图时仍可点击：交给灯箱如实报缺失，而不是给一个死图标", () => {
    const { card, onOpenImage } = renderImageCard({ has_thumb: false });
    const btn = card.querySelector<HTMLButtonElement>(".clip-thumb-open");
    expect(btn).not.toBeNull();
    expect(btn!.querySelector(".clip-thumb-placeholder")).not.toBeNull();
    fireEvent.click(btn!);
    expect(onOpenImage).toHaveBeenCalledTimes(1);
  });

  it("删除在途时缩略图不可点（不打开一个即将消失的条目）", () => {
    const { card } = renderImageCard({}, { locked: true });
    expect(card.querySelector(".clip-thumb-open")).toBeNull();
    expect(card.querySelector(".clip-thumb, .clip-thumb-placeholder")).not.toBeNull();
  });
});

describe("styles.css 预览截断契约", () => {
  it("正文两行截断：line-clamp 自带 overflow:hidden，且长串可断行", () => {
    const body = ruleBody(appCss, ".clip-preview-body > .clip-text");
    expect(body).toMatch(/display:\s*-webkit-box/);
    expect(body).toMatch(/-webkit-line-clamp:\s*2/);
    expect(body).toMatch(/-webkit-box-orient:\s*vertical/);
    // 缺这一条时 line-clamp 只压布局盒，文字会画到卡片外
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
    expect(body).toMatch(/white-space:\s*pre-wrap/);
  });

  it("预览体每一行都单行省略，并显式收窄宽度", () => {
    const body = ruleBody(appCss, ".clip-preview-body > span");
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
    expect(body).toMatch(/white-space:\s*nowrap/);
    expect(body).toMatch(/min-width:\s*0/);
    expect(body).toMatch(/max-width:\s*100%/);
  });

  it("预览体自身解除 flex 的 min-content 下限，避免长串把卡片撑宽", () => {
    const body = ruleBody(appCss, ".clip-preview-body");
    expect(body).toMatch(/min-width:\s*0/);
    expect(body).toMatch(/max-width:\s*100%/);
    expect(body).toMatch(/flex-direction:\s*column/);
  });

  it("正文截断不依赖祖先选择器：凡是用 line-clamp 的 .clip-text 规则都自带 overflow", () => {
    // 只查剪贴板正文自身：胶囊面板的 .cap-item-title.clip-2 靠同元素的另一条
    // 规则提供 overflow，属于另一套组件，不在本测试范围。
    const rules = [...appCssClean(appCss).matchAll(/([^{}]+)\{([^}]*)\}/g)];
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

/** 分体复制：主按钮直接复制，右侧箭头直接打开「复制并切换到…」（不是折叠菜单）。 */
function renderSplitCard() {
  const onCopy = vi.fn();
  const onCopySwitch = vi.fn();
  const onDetail = vi.fn();
  const onSelect = vi.fn();
  render(
    <ClipboardItemCard
      item={makeItem()}
      selected={false}
      linkMode={false}
      removing={false}
      pending={false}
      onSelect={onSelect}
      onCopy={onCopy}
      onCopySwitch={onCopySwitch}
      onToggle={vi.fn()}
      onDetail={onDetail}
      onDelete={vi.fn()}
      onLink={vi.fn()}
    />,
  );
  return { onCopy, onCopySwitch, onDetail, onSelect };
}

describe("ClipboardItemCard 分体复制按钮", () => {
  it("点箭头直接打开目标选择器：不复制、不打开详情、没有菜单层级", async () => {
    const user = userEvent.setup();
    const { onCopy, onCopySwitch, onDetail } = renderSplitCard();
    const arrow = screen.getByRole("button", { name: "复制并切换到目标窗口" });
    // 跳转语义：不是折叠/展开，也不再有只有一个选项的菜单
    expect(arrow.getAttribute("aria-haspopup")).toBeNull();
    expect(arrow.getAttribute("aria-expanded")).toBeNull();
    expect(arrow.querySelector("svg")?.getAttribute("class")).toContain("lucide-arrow-up-right");

    await user.click(arrow);
    expect(onCopySwitch).toHaveBeenCalledTimes(1);
    expect(onCopy).not.toHaveBeenCalled();
    expect(onDetail).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("点复制只复制：不打开目标选择器、不打开详情", async () => {
    const user = userEvent.setup();
    const { onCopy, onCopySwitch, onDetail } = renderSplitCard();

    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopySwitch).not.toHaveBeenCalled();
    expect(onDetail).not.toHaveBeenCalled();
  });

  it("键盘 Enter 在箭头或复制按钮上只激活自身，不冒泡触发卡片详情", async () => {
    const user = userEvent.setup();
    const { onCopy, onCopySwitch, onDetail } = renderSplitCard();
    const arrow = screen.getByRole("button", { name: "复制并切换到目标窗口" });
    const copy = screen.getByRole("button", { name: "复制" });

    arrow.focus();
    await user.keyboard("{Enter}");
    expect(onCopySwitch).toHaveBeenCalledTimes(1);
    expect(onCopy).not.toHaveBeenCalled();
    expect(onDetail).not.toHaveBeenCalled();

    copy.focus();
    await user.keyboard("{Enter}");
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onDetail).not.toHaveBeenCalled();
  });

  it("未提供 onCopySwitch 时不渲染箭头（不出现空入口）", () => {
    const card = renderCard();
    expect(card.querySelector('[aria-label="复制并切换到目标窗口"]')).toBeNull();
    expect(card.querySelector('[aria-label="复制"]')).not.toBeNull();
  });

  it("删除在途时箭头同样禁用（不打开一个即将消失的条目选择器）", () => {
    const { container } = render(
      <ClipboardItemCard
        item={makeItem()}
        selected={false}
        linkMode={false}
        removing={false}
        pending
        onSelect={vi.fn()}
        onCopy={vi.fn()}
        onCopySwitch={vi.fn()}
        onToggle={vi.fn()}
        onDetail={vi.fn()}
        onDelete={vi.fn()}
        onLink={vi.fn()}
      />,
    );
    const arrow = container.querySelector<HTMLButtonElement>('[aria-label="复制并切换到目标窗口"]')!;
    expect(arrow.disabled).toBe(true);
  });
});

describe("ClipboardItemCard 来源信息", () => {  it("展示人类可读应用名与「窗口」标题，不直接暴露 exe", () => {
    const card = renderCard({
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
    // 末尾重复的浏览器名已去掉
    expect(win!.textContent).not.toContain("Google Chrome");

    // 可见文本里不再出现原始 exe，原始标识只进提示
    expect(card.textContent).not.toContain("chrome.exe");
    expect(win!.getAttribute("data-tip")).toContain("chrome.exe");
    // 可聚焦：TooltipLayer 的 focusin 也能弹同一条提示（键盘可用）
    expect(win!.getAttribute("tabindex")).toBe("0");
  });

  it("未知来源渲染为「未知应用」，不崩也不猜", () => {
    const card = renderCard({ source_app: "unknown", source_title: "" });
    expect(card.querySelector(".clip-meta-app")!.textContent).toBe("未知应用");
    // 不把后端哨兵值 `unknown` 放进 Tooltip 冒充进程名。
    expect(card.querySelector(".clip-meta-app")!.getAttribute("title")).toBeNull();
    expect(card.querySelector(".clip-meta-window")).toBeNull();
    // 元信息行仍完整（大小还在），不因来源未知而丢结构
    expect(card.querySelector(".clip-meta")!.textContent).toContain("20 B");
  });
});