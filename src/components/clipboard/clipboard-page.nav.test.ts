//! 剪贴板侧栏「历史 / 分组」导航的**结构守卫**（2026-11-24）。
//!
//! 两个入口并排一行，选中底块由全局滑动指示条（`components/ui/useTabStrip` +
//! `tab-strip.css`）画。这里只守轨道这一半的约束：
//! - 容器必须是两列 grid + `position: relative`（绝对定位指示条的基准）；
//! - 选中按钮自身不能再铺底色/描边，否则会盖住指示条、动画看不见；
//! - 页面 CSS 不得再自带指示条或索引变量（动画只有一个来源，避免两套并存）。

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

describe("剪贴板导航：历史 / 分组并排 + 全局滑动指示条", () => {
  it("容器是两列 grid，并作为指示条的定位基准", () => {
    const sections = rule(".clip-side-sections");
    expect(sections).toBeDefined();
    expect(sections!.body).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(sections!.body).toMatch(/position:\s*relative/);
  });

  it("选中按钮只换文字颜色，不再自铺底色盖住指示条", () => {
    const active = rule(".clip-side-sections button.active");
    expect(active).toBeDefined();
    expect(active!.body).toMatch(/background:\s*transparent/);
    expect(active!.body).toMatch(/border-color:\s*transparent/);
    expect(active!.body).toMatch(/color:\s*var\(--text-primary\)/);
  });

  it("动画只有一个来源：页面 CSS 不再自带指示条与索引变量", () => {
    expect(pageCss).not.toContain(".clip-side-indicator");
    expect(pageCss).not.toContain("--clip-tab-index");
  });
});
