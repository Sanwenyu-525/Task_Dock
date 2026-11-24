//! 剪贴板侧栏「历史 / 分组」导航的**结构守卫**（2026-11-24）。
//!
//! 两个入口并排一行，选中态由一条可滑动的指示条承担。守卫三条硬约束：
//! - 容器必须是两列 grid + `position: relative`（指示条绝对定位的基准）；
//! - 指示条的位移只跟 `--clip-tab-index` 走，且有 transform 过渡；
//! - 选中按钮自身不能再铺底色/描边，否则会盖住指示条、动画看不见；
//! - 必须尊重 `prefers-reduced-motion`（关掉过渡而不是换一套样式）。

import { describe, expect, it } from "vitest";
import pageCss from "./clipboard-page.css?raw";

interface Rule {
  selector: string;
  body: string;
}

// 注释里也有花括号与选择器字样，先剥掉注释再按「选择器 { 声明 }」切分，
// 否则选择器会带上整段注释文本，精确匹配就永远打不中。
const CLEAN_CSS = pageCss.replace(/\/\*[\s\S]*?\*\//g, "");

const RULES: Rule[] = [...CLEAN_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim().replace(/\s+/g, " "),
  body: m[2],
}));

function rule(selector: string): Rule | undefined {
  return RULES.find((r) => r.selector === selector);
}

describe("剪贴板导航：历史 / 分组并排 + 滑动指示条", () => {
  it("容器是两列 grid，并作为指示条的定位基准", () => {
    const sections = rule(".clip-side-sections");
    expect(sections).toBeDefined();
    expect(sections!.body).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(sections!.body).toMatch(/position:\s*relative/);
    expect(sections!.body).toMatch(/--clip-tab-index:\s*0/);
  });

  it("指示条按索引位移，并带 transform 过渡", () => {
    const indicator = rule(".clip-side-indicator");
    expect(indicator).toBeDefined();
    expect(indicator!.body).toMatch(/position:\s*absolute/);
    expect(indicator!.body).toMatch(
      /transform:\s*translateX\(calc\(var\(--clip-tab-index\)\s*\*\s*\(100%\s*\+\s*3px\)\)\)/,
    );
    expect(indicator!.body).toMatch(/transition:[^;]*transform/);
    // 指示条只做视觉，不参与命中测试（否则会挡住按钮点击）。
    expect(indicator!.body).toMatch(/pointer-events:\s*none/);
  });

  it("选中按钮只换文字颜色，不再自铺底色盖住指示条", () => {
    const active = rule(".clip-side-sections button.active");
    expect(active).toBeDefined();
    expect(active!.body).toMatch(/background:\s*transparent/);
    expect(active!.body).toMatch(/border-color:\s*transparent/);
    expect(active!.body).toMatch(/color:\s*var\(--text-primary\)/);
  });

  it("减少动效偏好下关闭过渡", () => {
    // `@media` 包装层不参与规则切分，直接按源码片段校验：
    // 减少动效块里必须恰好是「关过渡」，而不是换成别的样式。
    expect(CLEAN_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.clip-side-indicator \{\s*transition: none;/,
    );
  });
});
