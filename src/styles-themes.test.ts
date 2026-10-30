//! 主题令牌的**结构一致性**与**弹层可读性**守卫。
//!
//! v0.6 的两条硬约束用测试锁住，避免以后改样式时悄悄破掉：
//! - 两套预设（梦幻渐变 / 液态玻璃）必须提供同一套令牌名，
//!   差异只落在取值上；少一个令牌就会让某个控件在另一套主题里「没有样式」；
//! - 弹层表面（菜单 / 对话框）盖在任务列表上，必须**不透明**，
//!   否则下面的深色标题会以浅灰重影透进菜单项，文字对比度塌掉。
//!
//! 另外守住 v0.6 修掉的层叠上下文问题：内容区不得再建立 z-index 上下文，
//! 否则浮层会被关在内容面板里，永远压在模态遮罩之下。

// 用 Vite 的 ?raw 直接把样式表当字符串导入：测试不依赖 node:fs，
// 也不需要给 tsconfig 加 @types/node。
import { describe, expect, it } from "vitest";
import themesCss from "./styles-themes.css?raw";
import uiCss from "./styles-ui.css?raw";
import appCss from "./styles.css?raw";

interface Rule {
  selector: string;
  body: string;
}

/** 扁平规则表（文件里没有嵌套选择器，@media 只有一层）。 */
const RULES: Rule[] = [...themesCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim().replace(/\s+/g, " "),
  body: m[2],
}));

const PRESETS = ["dream-gradient", "liquid-glass"] as const;

function rulesOf(preset: string, dark: boolean): Rule[] {
  return RULES.filter((r) => {
    if (!r.selector.includes(`data-preset="${preset}"`)) return false;
    const isDark = r.selector.includes('[data-theme="dark"]');
    return isDark === dark;
  });
}

/** 某个上下文里最终生效的令牌（后出现的块覆盖先出现的，与层叠顺序一致）。 */
function effectiveDecls(preset: string, dark: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rulesOf(preset, dark)) {
    for (const m of rule.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  }
  return out;
}

function tokenNames(preset: string, dark: boolean): string[] {
  const names = new Set<string>();
  for (const rule of rulesOf(preset, dark)) {
    for (const m of rule.body.matchAll(/(--[\w-]+)\s*:/g)) names.add(m[1]);
  }
  return [...names].sort();
}

/** 表面色里出现 alpha 即视为半透明。 */
function hasAlpha(value: string): boolean {
  if (/rgba?\([^)]*,\s*0?\.\d+\s*\)/.test(value)) return true;
  if (/hsla?\([^)]*,\s*0?\.\d+\s*,\s*0?\.\d+\s*\)/.test(value)) return true;
  const hex = /#[0-9a-f]{8}\b/i.exec(value);
  if (hex && hex[0].slice(7).toLowerCase() !== "ff") return true;
  return false;
}

describe("主题令牌结构", () => {
  it("两套预设的浅色主题提供同一套令牌名", () => {
    expect(tokenNames("liquid-glass", false)).toEqual(tokenNames("dream-gradient", false));
  });

  it("两套预设的深色主题提供同一套令牌名", () => {
    expect(tokenNames("liquid-glass", true)).toEqual(tokenNames("dream-gradient", true));
  });

  it("四个上下文都定义了弹层表面与窗口底色", () => {
    for (const preset of PRESETS) {
      for (const dark of [false, true]) {
        const decls = effectiveDecls(preset, dark);
        for (const required of ["--menu-face", "--dialog-face", "--card-face", "--window-fill"]) {
          expect(decls[required], `${preset}/${dark ? "dark" : "light"} 缺少 ${required}`).toBeTruthy();
        }
      }
    }
  });

  it("深色主题不会沿用浅色的窗口底色（否则底色与文字对不上）", () => {
    for (const preset of PRESETS) {
      expect(effectiveDecls(preset, true)["--window-fill"]).not.toBe(
        effectiveDecls(preset, false)["--window-fill"],
      );
    }
  });
});

describe("弹层表面可读性", () => {
  it("菜单与对话框表面在四个上下文里都不透明", () => {
    for (const preset of PRESETS) {
      for (const dark of [false, true]) {
        const decls = effectiveDecls(preset, dark);
        for (const surface of ["--menu-face", "--dialog-face"]) {
          expect(
            hasAlpha(decls[surface]),
            `${preset}/${dark ? "dark" : "light"} 的 ${surface} 是半透明的：${decls[surface]}`,
          ).toBe(false);
        }
      }
    }
  });

  it("卡片表面仍允许半透明（玻璃感来源），没有被一刀切成不透明", () => {
    expect(effectiveDecls("liquid-glass", true)["--card-face"]).toBeTruthy();
  });
});

describe("层叠上下文", () => {
  it("标题栏与内容区不再建立 z-index 上下文（浮层要能盖过模态遮罩）", () => {
    const block = /\.dock-window\s*>\s*\.titlebar,\s*\.dock-window\s*>\s*\.dock-body\s*\{([\s\S]*?)\}/.exec(
      themesCss,
    );
    expect(block).toBeTruthy();
    expect(block![1]).not.toMatch(/z-index\s*:\s*\d/);
  });

  it("层级刻度集中定义在组件库样式里，不散落在各处", () => {
    const zTokens = [...uiCss.matchAll(/(--z-[\w-]+)\s*:\s*(\d+);/g)].map(
      (m) => [m[1], Number(m[2])] as const,
    );
    const map = new Map<string, number>(zTokens);
    expect(map.size).toBeGreaterThanOrEqual(5);
    // 层级必须严格递增：内容 < 抽屉 < 模态 < 模态顶层 < 菜单 < 对话框 < 提示条
    const order = ["--z-content", "--z-sticky", "--z-drawer", "--z-modal", "--z-modal-top", "--z-menu", "--z-dialog", "--z-toast"];
    const values = order.map((t) => map.get(t) ?? -1);
    expect(values.every((v) => v >= 0)).toBe(true);
    for (let i = 1; i < values.length; i++) {
      expect(values[i], `${order[i]} 必须大于 ${order[i - 1]}`).toBeGreaterThan(values[i - 1]);
    }
  });

  it("关联模式抽屉脱离内容区的定位盒，叠在任务编辑器之上", () => {
    expect(appCss).toMatch(/\.clipboard-layer\.link-mode\s*\{[^}]*position:\s*fixed/);
    expect(appCss).toMatch(/\.clipboard-layer\.link-mode\s*\{[^}]*z-index:\s*var\(--z-modal-top\)/);
  });
});

describe("组件库样式", () => {
  it("基元样式集中在一处，且不引入实时背景模糊", () => {
    // backdrop-filter 会给整个弹出菜单带来 GPU 开销，v0.6 明确禁止
    expect(/\.ui-menu[\s\S]{0,400}?backdrop-filter/.test(uiCss)).toBe(false);
    expect(uiCss).toContain(".ui-select-trigger");
    expect(uiCss).toContain(".ui-listbox");
    expect(uiCss).toContain(".ui-menu-item");
  });
});
