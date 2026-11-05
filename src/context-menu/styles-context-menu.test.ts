//! 右键菜单样式的**结构守卫**：锁住可读柔光表面与状态层级，
//! 避免以后改样式时退回半透明模糊面、双圆角或状态混淆。
//!
//! 硬约束（与 2026-11-04 修复规范一一对应）：
//! - 表面直接复用弹层 Token（`--menu-face`，无 alpha 的不透明渐变），
//!   整个菜单**不出现 backdrop-filter**（可读性优先、避免实时模糊成本）；
//! - 项高 34px、圆角 16px、hover 过渡 ≤ 160ms；
//! - Hover（中性灰染）与 Checked（主题色染色）必须使用不同背景来源；
//! - 键盘焦点 focus-visible 必须有独立描边；
//! - 分组标题用弹层次级文字 Token，且不再叠透明度；
//! - 唯一动画是入场（finite），必须有 prefers-reduced-motion 兜底。

import { describe, expect, it } from "vitest";
import menuCss from "./styles-context-menu.css?raw";

interface Rule {
  selector: string;
  body: string;
}

const RULES: Rule[] = [...menuCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim().replace(/\s+/g, " "),
  body: m[2],
}));

function rule(selectorIncludes: string): Rule | undefined {
  return RULES.find((r) => r.selector.includes(selectorIncludes));
}

function declsOf(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

describe("柔光材质守卫", () => {
  it("表面复用弹层 Token（不透明渐变），不做实时 backdrop-filter", () => {
    const r = rule(".liquid-context-menu");
    expect(r).toBeTruthy();
    const d = declsOf(r!.body);
    expect(d["background"]).toContain("var(--menu-face");
    // 不透明 Token 表面：不能退回半透明 rgba 染色
    expect(d["background"]).not.toContain("rgba(250, 252, 255");
    expect(d["backdrop-filter"]).toBeUndefined();
    expect(d["-webkit-backdrop-filter"]).toBeUndefined();
    expect(d["border-radius"]).toBe("16px");
    expect(d["box-shadow"]).toContain("var(--menu-highlight");
    // 细而低对比的边框由正文色混出，不出现白色亮边
    expect(d["border"]).toContain("color-mix");
    expect(d["border"]).toContain("var(--text-primary)");
  });

  it("整个样式表不再出现 backdrop-filter（含 -webkit 前缀）", () => {
    const hits = RULES.filter((r) => r.body.includes("backdrop-filter"));
    expect(hits).toHaveLength(0);
  });

  it("菜单项高 34px、圆角 8px、过渡不超过 160ms", () => {
    const d = declsOf(rule(".menu-item")!.body);
    expect(d["height"]).toBe("34px");
    expect(d["border-radius"]).toBe("8px");
    const t = d["transition"];
    expect(t).toBeTruthy();
    for (const m of t.matchAll(/(\d+(?:\.\d+)?)ms/g)) {
      expect(Number(m[1])).toBeLessThanOrEqual(160);
    }
  });

  it("状态层级：Hover 是中性灰染，Checked 是主题色染色，两者不同源", () => {
    const hover = declsOf(rule(".menu-item:hover")!.body);
    const checked = declsOf(rule(".menu-item.is-checked")!.body);
    const checkedHover = declsOf(rule(".menu-item.is-checked:hover")!.body);
    // Hover：中性（正文色低比例），不使用主题色面，也不是白色强覆盖
    expect(hover["background"]).toContain("var(--text-primary)");
    expect(hover["background"]).not.toContain("--menu-active-face");
    expect(hover["background"]).not.toContain("--accent-soft");
    expect(hover["background"]).not.toContain("rgba(255, 255, 255");
    // Checked：低饱和主题色底 + 强调文字色
    expect(checked["background"]).toContain("var(--menu-active-face");
    expect(checked["color"]).toContain("var(--menu-active-text");
    // Checked+Hover：完整主题色面（比 Checked 常态更深），不得退回中性 Hover
    expect(checkedHover["background"]).toContain("var(--menu-active-face");
    expect(checkedHover["background"]).not.toContain("var(--text-primary)");
  });

  it("键盘焦点：focus-visible 有独立 2px 主题色描边", () => {
    const d = declsOf(rule(".menu-item:focus-visible")!.body);
    expect(d["outline"]).toContain("2px solid var(--accent)");
  });

  it("分组标题用弹层次级文字 Token，不再叠透明度", () => {
    const d = declsOf(rule(".menu-group-label")!.body);
    expect(d["color"]).toContain("var(--menu-text-dim");
    expect(d["font-weight"]).toBe("500");
    expect(d["opacity"]).toBeUndefined();
  });

  it("入场动画是唯一动画且有时长上限", () => {
    expect(menuCss.match(/@keyframes/g)).toHaveLength(1);
    expect(menuCss).toContain("animation: liquid-menu-in 150ms");
  });

  it("存在 prefers-reduced-motion / reduced-transparency / contrast 兜底", () => {
    expect(menuCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(menuCss).toContain("@media (prefers-reduced-transparency: more)");
    expect(menuCss).toContain("@media (prefers-contrast: more)");
    const reduced = menuCss.slice(menuCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("animation: none");
    // 用户要求的基准表面（完全实底）在系统关闭透明效果时仍然成立
    expect(menuCss).toContain("#f8f9fc");
    expect(menuCss).toContain("#252b38");
  });
});
