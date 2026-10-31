//! 液态玻璃菜单样式的**结构守卫**：锁住视觉整改后的材质与状态层级，
//! 避免以后改样式时悄悄退化成不透明灰板或状态混淆。
//!
//! 硬约束（与整改规范一一对应）：
//! - 浅/深两套玻璃底色必须是**有层次的半透明渐变**（不允许退回纯色平涂）；
//! - backdrop-filter 只出现在容器（禁止嵌套模糊），其余环境靠原生 blur；
//! - 项高 34px（密度整改）、圆角 16px、hover 过渡 ≤ 160ms；
//! - Hover（中性染色）与 Checked（主题色染色）必须使用不同背景来源；
//! - 键盘焦点 focus-visible 必须有独立描边；
//! - 分组标题用次级文字色（对比度高于 tertiary）；
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

describe("玻璃材质守卫", () => {
  it("浅色玻璃：半透明**渐变**底色 + backdrop-filter + 内高光（不允许纯色平涂）", () => {
    const r = rule(".liquid-context-menu");
    expect(r).toBeTruthy();
    const d = declsOf(r!.body);
    expect(d["background"]).toContain("linear-gradient");
    expect(d["background"]).toContain("rgba(250, 252, 255");
    expect(d["backdrop-filter"]).toContain("blur(28px)");
    expect(d["border-radius"]).toBe("16px");
    expect(d["box-shadow"]).toContain("inset");
  });

  it("深色玻璃：分层蓝黑**渐变**，冷色边框替代白色边框", () => {
    const r = rule('[data-theme="dark"] .liquid-context-menu');
    expect(r).toBeTruthy();
    const d = declsOf(r!.body);
    expect(d["background"]).toContain("linear-gradient");
    expect(d["background"]).toContain("rgba(46, 60, 92");
    // 冷色高光（蓝调），不再是纯白边框
    expect(d["border-color"]).toContain("rgba(150, 180, 235");
    expect(d["border-color"]).not.toBe("rgba(255, 255, 255, 0.14)");
  });

  it("菜单项高 34px（密度整改）、圆角 8px、过渡不超过 160ms", () => {
    const d = declsOf(rule(".menu-item")!.body);
    expect(d["height"]).toBe("34px");
    expect(d["border-radius"]).toBe("8px");
    const t = d["transition"];
    expect(t).toBeTruthy();
    for (const m of t.matchAll(/(\d+(?:\.\d+)?)ms/g)) {
      expect(Number(m[1])).toBeLessThanOrEqual(160);
    }
  });

  it("状态层级：Hover 是中性染色，Checked 是主题色染色，两者不同源", () => {
    const hoverLight = declsOf(rule(".menu-item:hover")!.body);
    const hoverDark = declsOf(rule('[data-theme="dark"] .menu-item:hover')!.body);
    const checked = declsOf(rule(".menu-item.is-checked")!.body);
    const checkedHover = declsOf(rule(".menu-item.is-checked:hover")!.body);
    // Hover：中性（不使用 accent-soft）
    expect(hoverLight["background"]).not.toContain("accent-soft");
    expect(hoverDark["background"]).not.toContain("accent-soft");
    // Checked：主题色染色 + 强调文字色
    expect(checked["background"]).toContain("var(--accent-soft)");
    expect(checked["color"]).toContain("var(--accent)");
    // Checked+Hover：仍走主题色系（更深），不得退回中性 Hover
    expect(checkedHover["background"]).toContain("var(--accent-soft)");
  });

  it("键盘焦点：focus-visible 有独立 2px 主题色描边", () => {
    const d = declsOf(rule(".menu-item:focus-visible")!.body);
    expect(d["outline"]).toContain("2px solid var(--accent)");
  });

  it("分组标题使用次级文字色（对比度高于 tertiary）", () => {
    const d = declsOf(rule(".menu-group-label")!.body);
    expect(d["color"]).toContain("var(--text-secondary)");
    expect(d["font-weight"]).toBe("500");
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
  });

  it("除容器外不出现第二处 backdrop-filter（禁止嵌套模糊）", () => {
    const hits = RULES.filter((r) => r.body.includes("backdrop-filter"));
    const selectors = new Set(hits.map((h) => h.selector));
    const nonContainer = [...selectors].filter(
      (s) => !s.includes(".liquid-context-menu") || s.includes(".menu-item"),
    );
    // 允许的只有容器本体与 prefers-contrast 的显式关闭（backdrop-filter: none）
    for (const s of nonContainer) {
      expect(s).toContain("@media (prefers-contrast: more)");
    }
  });
});
