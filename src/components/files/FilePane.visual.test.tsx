/**
 * @vitest-environment jsdom
 *
 * R10 Agent C：视觉修复的 DOM/CSS 契约测试。
 * jsdom 不做真实排版，无法证明像素对齐；这里只验证「契约」：
 * - 搜索框内层 input 的焦点样式被 files.css 局部清掉，容器 :focus-within 保留唯一一层；
 * - 筛选条改为不换行的单行，不再预留多行高度；
 * - 空窗格顶部操作区 .fw-pane-tabbar-actions 已有正式 CSS，可去掉内联样式；
 * - 操作区关闭按钮的 focus-visible 焦点环清晰且内缩（不被标签栏裁切）；
 * - 标签 Tooltip 由全局 portal + fixed 定位承载，不会被窗格边界裁切。
 * 真实视觉像素待 B/C 通道真机验收。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/components/files/files.css", "utf8");
const tooltipLayerSrc = readFileSync("src/components/ui/TooltipLayer.tsx", "utf8");
const popoverSrc = readFileSync("src/components/ui/Popover.tsx", "utf8");

/** 取首个匹配选择器规则块的声明体（不含注释与花括号）。 */
function ruleBlock(selectorPattern: RegExp): string | null {
  const match = selectorPattern.exec(css);
  if (!match) return null;
  const start = css.indexOf("{", match.index);
  const end = css.indexOf("}", start);
  return css.slice(start + 1, end);
}

describe("搜索框：只保留容器一层焦点反馈", () => {
  it("容器 :focus-within 的强调色边框仍在", () => {
    const container = ruleBlock(/\.fw-searchbox:focus-within\s*\{/);
    expect(container).toBeTruthy();
    expect(container).toContain("border-color: var(--accent)");
  });

  it("内层 input 的 :focus / :focus-visible 清掉 box-shadow、outline、border", () => {
    const focus = ruleBlock(
      /\.fw-searchbox input:focus,\s*\.fw-searchbox input:focus-visible\s*\{/,
    );
    expect(focus).toBeTruthy();
    expect(focus).toContain("box-shadow: none");
    expect(focus).toContain("outline: none");
    expect(focus).toContain("border: none");
  });

  it("覆写是无 @layer 的组件样式，优先级高于 theme/ui 层（无需改 styles-ui 豁免清单）", () => {
    // files.css 顶层不能出现 @layer，否则无层优先级优势消失，双层边框会复现。
    expect(css).not.toMatch(/^\s*@layer\s/m);
    // 主题层仍在，证明只做局部覆写而非全局删焦点样式。
    const themesCss = readFileSync("src/styles-themes.css", "utf8");
    expect(themesCss).toContain("input:focus");
    expect(themesCss).toContain("box-shadow: var(--control-shadow-focus)");
  });
});

describe("筛选条：单行紧凑，不预留多行空白", () => {
  it(".fw-filter-bar 不换行、横向滚动、无 max-height 多行预留", () => {
    const bar = ruleBlock(/\.fw-filter-bar\s*\{/);
    expect(bar).toBeTruthy();
    expect(bar).toContain("flex-wrap: nowrap");
    expect(bar).toContain("overflow-x: auto");
    expect(bar).not.toContain("max-height");
    // 仍固定在列表上方，不参与 .fw-body 纵向虚拟滚动。
    expect(bar).toContain("flex: 0 0 auto");
  });

  it("chip 不被压缩，横向滚动条不额外撑高", () => {
    const chip = ruleBlock(/\.fw-filter-chip\s*\{/);
    expect(chip).toContain("flex: 0 0 auto");
    expect(css).toMatch(/\.fw-filter-bar::-webkit-scrollbar\s*\{\s*display:\s*none/);
  });
});

describe("空窗格操作区与关闭按钮", () => {
  it(".fw-pane-tabbar-actions 提供 margin-left:auto 等正式样式", () => {
    const actions = ruleBlock(/\.fw-pane-tabbar-actions\s*\{/);
    expect(actions).toBeTruthy();
    expect(actions).toContain("margin-left: auto");
    expect(actions).toContain("display: flex");
    expect(actions).toContain("gap: 2px");
  });

  it("关闭按钮 hover 背景与 focus-visible 焦点环均具备，且焦点环内缩不被裁切", () => {
    const hover = ruleBlock(/\.fw-icon-btn:hover:not\(:disabled\)\s*\{/);
    expect(hover).toContain("background: var(--surface-overlay)");

    const focus = ruleBlock(/\.fw-pane-tabbar-actions \.fw-icon-btn:focus-visible\s*\{/);
    expect(focus).toBeTruthy();
    expect(focus).toContain("outline: 2px solid var(--accent)");
    expect(focus).toContain("outline-offset: -2px");
  });

  it("默认态低调：图标按钮为透明底、次要色，不抢注意力", () => {
    const base = ruleBlock(/\.fw-icon-btn\s*\{/);
    expect(base).toContain("background: transparent");
    expect(base).toContain("color: var(--text-secondary)");
  });
});

describe("标签 Tooltip 不被窗格边界裁切", () => {
  it("TooltipLayer 走 layer=null，Popover 把浮层 portal 到 body 并用 fixed 定位", () => {
    expect(tooltipLayerSrc).toMatch(/layer=\{null\}/);
    expect(popoverSrc).toMatch(
      /createPortal\(content,\s*findOverlayPortal\(anchorRef\.current\)\s*\?\?\s*document\.body\)/,
    );
    expect(popoverSrc).toMatch(/strategy:\s*"fixed"/);
  });

  it("定位做视口边缘收敛，气泡不会溢出窗口", () => {
    expect(tooltipLayerSrc).toContain("computeTooltipPosition");
    expect(tooltipLayerSrc).toContain("VIEWPORT_PADDING");
  });
});
