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

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取样式表里的 `@layer <name> { … }` 块（含同名的多个块，保持文件顺序）。 */
function layerBlocks(css: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /@layer\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
    }
    out.push({ name: m[1], body: css.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

/** 规则块 → 单条选择器（按逗号拆分并归一空白）。 */
const selectorsOf = (rule: Rule): string[] =>
  rule.selector.split(",").map((s) => s.trim().replace(/\s+/g, " "));

/** 某层里「根容器」规则体：选择器列表中**恰好**包含 `.dock-window.is-capsule`。 */
function capsuleRootBodies(css: string, layer: string): string[] {
  const bodies: string[] = [];
  for (const block of layerBlocks(stripComments(css))) {
    if (block.name !== layer) continue;
    for (const rule of [...block.body.matchAll(/([^{}]+)\{([^{}]*)\}/g)]) {
      const selectors = selectorsOf({ selector: rule[1].trim(), body: rule[2] });
      if (selectors.includes(".dock-window.is-capsule")) bodies.push(rule[2]);
    }
  }
  return bodies;
}

/** 某层里某个选择器的规则体（用于 `::before` 这类唯一规则）。 */
function ruleBodies(css: string, layer: string, selector: string): string[] {
  const bodies: string[] = [];
  for (const block of layerBlocks(stripComments(css))) {
    if (block.name !== layer) continue;
    for (const rule of [...block.body.matchAll(/([^{}]+)\{([^{}]*)\}/g)]) {
      const selectors = selectorsOf({ selector: rule[1].trim(), body: rule[2] });
      if (selectors.includes(selector)) bodies.push(rule[2]);
    }
  }
  return bodies;
}

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
        for (const required of [
          "--menu-face",
          "--dialog-face",
          "--card-face",
          "--window-fill",
          "--capsule-face",
        ]) {
          expect(decls[required], `${preset}/${dark ? "dark" : "light"} 缺少 ${required}`).toBeTruthy();
        }
      }
    }
  });

  it("立体层级令牌在四个上下文都有定义（避免某套主题少一层高度）", () => {
    for (const preset of PRESETS) {
      for (const dark of [false, true]) {
        const decls = effectiveDecls(preset, dark);
        for (const required of [
          "--header-wash",
          "--inset-face",
          "--inset-shadow",
          "--inset-shadow-hover",
          "--inset-shadow-focus",
          "--inset-shadow-sm",
          "--shadow-overlay",
        ]) {
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

  it("剪贴板详情 sticky 顶栏表面在四个上下文里都不透明", () => {
    // 顶栏钉扎时条目/分组/逐项粘贴的图片与文字从它下方滚过：
    // 浅色玻璃的 --surface-overlay 只有 92%（梦幻浅色 96%），历史回归点——透色。
    for (const preset of PRESETS) {
      for (const dark of [false, true]) {
        const decls = effectiveDecls(preset, dark);
        const face = decls["--clip-detail-face"];
        expect(face, `${preset}/${dark ? "dark" : "light"} 未定义 --clip-detail-face`).toBeTruthy();
        expect(
          hasAlpha(face),
          `${preset}/${dark ? "dark" : "light"} 的 --clip-detail-face 是半透明的：${face}`,
        ).toBe(false);
      }
    }
  });

  it("胶囊表面令牌在四个上下文里都不透明（根窗口透明时胶囊不能跟着透明）", () => {
    for (const preset of PRESETS) {
      for (const dark of [false, true]) {
        const face = effectiveDecls(preset, dark)["--capsule-face"];
        expect(face, `${preset}/${dark ? "dark" : "light"} 未定义 --capsule-face`).toBeTruthy();
        expect(
          hasAlpha(face),
          `${preset}/${dark ? "dark" : "light"} 的 --capsule-face 是半透明的：${face}`,
        ).toBe(false);
      }
    }
  });

  it("胶囊表面使用不透明底：面板实色底 + 翼片三段渐变全部不含 alpha", () => {
    const panel = /\.capsule-panel\s*\{([\s\S]*?)\}/.exec(appCss);
    expect(panel, "styles.css 缺少 .capsule-panel").toBeTruthy();
    expect(panel![1]).toMatch(/background-color:\s*var\(--wing-panel-base\)/);
    expect(panel![1]).toMatch(/background-image:\s*var\(--wing-panel-face\)/);

    // 翼片 fill 由 CapsuleWing 内联成 userSpaceOnUse 渐变（方向按停靠边换算），
    // 因此不变量从「fill 指向实色 Token」改为「跨厚度的三个停靠色都不含 alpha」：
    // 只要有一个半透明，深色桌面上胶囊就会局部消失（历史回归点）。
    for (const preset of PRESETS) {
      for (const dark of [false, true]) {
        const decls = effectiveDecls(preset, dark);
        const tag = `${preset}/${dark ? "dark" : "light"}`;
        for (const key of ["--wing-panel-base", "--wing-near", "--wing-mid", "--wing-far"]) {
          const v = decls[key];
          expect(v, `${tag} 未定义 ${key}`).toBeTruthy();
          expect(hasAlpha(v), `${tag} 的 ${key} 是半透明的：${v}`).toBe(false);
        }
      }
    }
  });
});

describe("停靠态根窗口（胶囊模式）", () => {
  // 层叠顺序优先于选择器权重：`.dock-window` 的底色写在 theme 层，
  // 只在 base 层写 transparent 会被无条件压过——历史回归「轨道旁边一整块矩形」。
  it("layer 顺序声明一致：theme 排在 base 之后", () => {
    for (const css of [appCss, themesCss, uiCss]) {
      expect(css).toMatch(/@layer\s+base,\s*theme/);
    }
  });

  it("根容器的最终规则在 theme 层，并清空所有整窗绘制", () => {
    expect(capsuleRootBodies(themesCss, "theme").length).toBeGreaterThan(0);
    const bodies = capsuleRootBodies(themesCss, "theme");
    const body = bodies[bodies.length - 1]; // 同层后位胜出
    expect(body).toMatch(/background:\s*transparent/);
    expect(body).toMatch(/background-image:\s*none/);
    expect(body).toMatch(/border:\s*none/);
    expect(body).toMatch(/box-shadow:\s*none/);
    expect(body).toMatch(/border-radius:\s*0/);
  });

  it("装饰伪元素在胶囊模式不绘制（否则会在区域内部染一层整窗光晕）", () => {
    const bodies = ruleBodies(themesCss, "theme", ".dock-window.is-capsule::before");
    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies[bodies.length - 1];
    expect(body).toMatch(/content:\s*none/);
    expect(body).toMatch(/background-image:\s*none/);
  });

  it("主界面容器在胶囊模式整块隐藏（保留挂载以维持视图状态）", () => {
    expect(appCss).toMatch(
      /\.dock-window\.is-capsule\s+\.dock-app\s*\{[^}]*display:\s*none/,
    );
  });

  it("轨道容器自身不写矩形外观（背景/描边/阴影/圆角由翼片 SVG 承担）", () => {
    const rail = /\.capsule-rail\s*\{([\s\S]*?)\}/.exec(appCss);
    expect(rail).toBeTruthy();
    for (const forbidden of ["background", "border", "box-shadow", "border-radius"]) {
      expect(rail![1], `.capsule-rail 不应设置 ${forbidden}`).not.toMatch(
        new RegExp(`(^|[;\\s])${forbidden}\\s*:`),
      );
    }
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

  it("剪贴板详情顶栏钉在滚动区可视顶端并使用专用不透明表面", () => {
    const block = /\.clip-detail-head\s*\{([\s\S]*?)\}/.exec(appCss);
    expect(block, "styles.css 缺少 .clip-detail-head").toBeTruthy();
    expect(block![1]).toMatch(/position:\s*sticky/);
    // 滚动容器自身的 padding 会内缩 sticky 约束矩形（WebView2 实测）：
    // top 必须为负值抵消 .clip-body 的 padding-top，否则顶栏上方露出 8px 内容带。
    expect(block![1]).toMatch(/top:\s*-\d+px/);
    // 裸 z-index 违反 UI 红线，层级刻度必须走 Token
    expect(block![1]).toMatch(/z-index:\s*var\(--z-sticky\)/);
    // 表面走专用 Token，不允许退回带 alpha 的 --surface-overlay
    expect(block![1]).toMatch(/background:\s*var\(--clip-detail-face\)/);
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
