//! 验收 UI-03/04/05 的回归守卫（2026-11-07 Impeccable 审计）。
//!
//! 三个缺陷都属于「Token 本身不合法/不达标」，组件层看不出来，必须锁在样式表上：
//! - 焦点环间隙不能引用 `--surface-base`（主题层是多段渐变 = <image>，
//!   代入 box-shadow 颜色位会让整条声明在 computed-value 阶段非法）；
//! - `.btn.primary` 白字压在 `--accent-gradient` 上，每个色标都必须 ≥4.5:1，
//!   并给 hover 的 brightness(1.05) 留余量；
//! - 搜索框占位符必须用语义文字色，不能沿用 Chromium UA 的固定 #757575。
import { describe, expect, it } from "vitest";
import themesCss from "./styles-themes.css?raw";
import uiCss from "./styles-ui.css?raw";
import appCss from "./styles.css?raw";

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** WCAG sRGB 相对亮度。 */
function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastWithWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

const THEME_CSS = stripComments(themesCss);
const UI_CSS = stripComments(uiCss);
const APP_CSS = stripComments(appCss);

function tokenColor(css: string, name: string): string {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error("token not found: " + name);
  return match[1];
}

describe("浅色语义色作为文字时达标（验收 UI-06）", () => {
  // 浅色窗口/卡片底的最差取值：dream 34% 停止点与 frosted 48% 停止点。
  const WORST_BACKGROUNDS = ["#efeaff", "#edf5fd", "#fbfcff"];

  it("状态色与优先级色在浅色底上 ≥4.5:1", () => {
    // 状态/优先级文字都落在卡片面（surface-raised）上，用卡片合成底评估；
    // 窗口最差渐变停止点只用于直接压在窗口上的三级文字。
    const CARD_BACKGROUNDS = ["#f6f8fe", "#fbfcff"];
    for (const token of [
      "--status-running",
      "--status-waiting",
      "--status-success",
      "--status-error",
      "--status-disconnected",
      "--p0",
      "--p1",
      "--p2",
      "--p3",
    ]) {
      const color = tokenColor(APP_CSS, token);
      for (const bg of CARD_BACKGROUNDS) {
        const ratio =
          (Math.max(luminance(color), luminance(bg)) + 0.05) /
          (Math.min(luminance(color), luminance(bg)) + 0.05);
        expect(ratio, `${token} ${color} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("浅色三级文字在窗口渐变停止点上 ≥4.5:1", () => {
    // styles.css 的 --text-tertiary 是基础值；themes 里三套浅色（dream /
    // liquid 基底 / frosted）都必须达标。逐个取出现值检查。
    const values = [...THEME_CSS.matchAll(/--text-tertiary:\s*(#[0-9a-fA-F]{6})/g)]
      .map((m) => m[1])
      .filter((hex) => luminance(hex) < 0.2); // 只取浅色主题的深字
    expect(values.length).toBeGreaterThanOrEqual(3);
    for (const color of values) {
      for (const bg of WORST_BACKGROUNDS) {
        const ratio =
          (Math.max(luminance(color), luminance(bg)) + 0.05) /
          (Math.min(luminance(color), luminance(bg)) + 0.05);
        expect(ratio, `tertiary ${color} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("浅色 accent 作为文字时 ≥4.5:1（含软底药丸）", () => {
    const lightAccent = THEME_CSS.match(/--c-accent:\s*(#[0-9a-fA-F]{6}|rgb\([^)]+\))/);
    expect(lightAccent).not.toBeNull();
    const raw = lightAccent![1];
    const color = raw.startsWith("#")
      ? raw
      : "#" +
        raw
          .replace(/rgba?\(|\)/g, "")
          .split(",")
          .slice(0, 3)
          .map((n) => Number(n.trim()).toString(16).padStart(2, "0"))
          .join("");
    // 软底药丸（accent 10% 叠白）近似 #eef0fd
    for (const bg of ["#eef0fd", "#f3f8fe", "#fbfcff"]) {
      const ratio =
        (Math.max(luminance(color), luminance(bg)) + 0.05) /
        (Math.min(luminance(color), luminance(bg)) + 0.05);
      expect(ratio, `accent ${color} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("焦点环 Token", () => {
  it("间隙使用实色 Token，不再把渐变 --surface-base 放进 box-shadow", () => {
    expect(UI_CSS).not.toMatch(/--focus-ring:[^;]*var\(--surface-base\)/);
    expect(UI_CSS).toMatch(/--focus-ring:\s*0 0 0 2px var\(--focus-ring-gap\)/);
  });

  it("浅色与深色都定义了 --focus-ring-gap", () => {
    expect(UI_CSS).toMatch(/:root\s*\{[^}]*--focus-ring-gap:\s*#ffffff/);
    expect(UI_CSS).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*--focus-ring-gap:/);
  });
});

describe("主按钮渐变对白字的对比度", () => {
  it("每个预设 × 明暗的每个色标都 ≥5.0:1（给 hover brightness 留余量）", () => {
    const gradients = [...THEME_CSS.matchAll(/--accent-gradient:\s*linear-gradient\([^;]+\);/g)].map(
      (m) => m[0],
    );
    expect(gradients.length).toBe(4);
    for (const gradient of gradients) {
      const stops = [...gradient.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0]);
      expect(stops.length).toBeGreaterThanOrEqual(3);
      for (const stop of stops) {
        expect(contrastWithWhite(stop), `${stop} in ${gradient}`).toBeGreaterThanOrEqual(5.0);
      }
    }
  });
});

describe("搜索框占位符", () => {
  it("SearchField 与内嵌输入都声明了语义文字的 ::placeholder", () => {
    expect(UI_CSS).toMatch(/\.ui-search \.ui-search-input::placeholder/);
    expect(UI_CSS).toMatch(/\.input-embedded::placeholder/);
    const rule = UI_CSS.match(
      /\.ui-search \.ui-search-input::placeholder,\s*\.input-embedded::placeholder\s*\{([^}]*)\}/,
    );
    expect(rule?.[1]).toContain("var(--text-tertiary)");
    expect(rule?.[1]).toContain("opacity: 1");
  });
});

describe("高对比度覆盖的层叠位置（验收 UI-19）", () => {
  it("base 层不再声明 prefers-contrast 文本/边框覆盖", () => {
    expect(APP_CSS).not.toMatch(/@media \(prefers-contrast: more\)/);
  });

  it("覆盖写在 theme 层，并用预设选择器拿到同 specificity", () => {
    const block = THEME_CSS.slice(THEME_CSS.lastIndexOf("@media (prefers-contrast: more)"));
    expect(block).toContain(":root[data-preset]");
    expect(block).toContain("--border-subtle");
    expect(block).toContain("--text-secondary");
  });
});

describe("frosted 浅色亮度（2026-11-07 观感修正）", () => {
  it("窗口与卡片底色已压暗一档，防止回退成近白", () => {
    const block = THEME_CSS.slice(
      THEME_CSS.lastIndexOf(':root[data-preset="frosted"][data-theme="light"] {'),
    );
    // 旧值：窗口 rgb(248,251,255)/rgb(229,241,251)，卡片白 0.88。
    expect(block).toContain("rgba(238, 244, 252, 0.93)");
    expect(block).toContain("rgba(217, 229, 243, 0.89)");
    expect(block).toContain("rgba(250, 253, 255, 0.86)");
    expect(block).not.toContain("rgba(248, 251, 255, 0.93)");
  });
});

describe("极限窗口宽度（验收 UI-17）", () => {
  it("内容区在超大窗口下约束测量宽度并居中", () => {
    const rule = APP_CSS.match(/\.tab-content\s*\{([^}]*)\}/);
    expect(rule?.[1]).toContain("max-width: 560px");
    expect(rule?.[1]).toContain("margin-inline: auto");
  });

  it("≤280 宽把提醒卡改为纵向堆叠、统计标签允许换行", () => {
    const block = APP_CSS.slice(APP_CSS.indexOf("@media (max-width: 280px)"));
    expect(block).toContain(".active-reminder-card");
    expect(block).toContain("flex-wrap: wrap");
    expect(block).toContain(".summary-card .summary-label");
    expect(block).toContain("white-space: normal");
  });
});
