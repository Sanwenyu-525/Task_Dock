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
    // 层级意图（v0.7 通知整改后的语义）：对话框 > 菜单 > 提示条 > 模态/抽屉/吸顶/普通内容。
    // Toast 只作反馈：必须盖住普通内容层（--z-content）与模态内容，否则会被面板/遮罩挡住；
    // 但不得压住菜单或对话框，否则底部居中的气泡会挡住确认框的「取消/继续」按钮。
    // 顺序取 Token 实际值比较，不写死像素数字。
    const order = [
      "--z-content",
      "--z-sticky",
      "--z-drawer",
      "--z-modal",
      "--z-modal-top",
      "--z-toast",
      "--z-menu",
      "--z-dialog",
    ];
    const values = order.map((t) => map.get(t) ?? -1);
    expect(values.every((v) => v >= 0)).toBe(true);
    for (let i = 1; i < values.length; i++) {
      expect(values[i], `${order[i]} 必须大于 ${order[i - 1]}`).toBeGreaterThan(values[i - 1]);
    }
    // 单独点名「提示条高于普通内容层」：这是把 toast 从最高层降下来后仍须保持的底线。
    expect(map.get("--z-toast")!).toBeGreaterThan(map.get("--z-content")!);
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

/* ── 工具栏 / 吸顶表面专项（2026-11-02）──────────────────────────
   这三条守住本次修掉的根因，避免以后改样式时又悄悄退回去。 */

// 注释里可以写反例说明，但不能被当成真实声明扫到。
const appCssCode = appCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** 渐变型令牌（预设下解析成 <image>）：它们不能进 color-mix()，但可以正常当背景层。 */
const IMAGE_TOKENS = new Set([
  "--surface-base",
  "--surface-raised",
  "--card-face",
  "--control-face",
  "--window-fill",
]);

/**
 * 收集所有把渐变令牌当颜色用的 color-mix() 调用。
 * 按括号深度取参数串，避免把 `linear-gradient(color-mix(...), var(--window-fill))`
 * 这种合法的多层背景误判成越界引用。
 */
function imageTokenInColorMix(css: string): string[] {
  const offenders: string[] = [];
  for (let i = css.indexOf("color-mix("); i >= 0; i = css.indexOf("color-mix(", i + 1)) {
    let depth = 0;
    let j = i + "color-mix".length;
    for (; j < css.length; j++) {
      if (css[j] === "(") depth++;
      else if (css[j] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    const args = css.slice(i + "color-mix(".length, j);
    for (const tok of args.matchAll(/var\((--[\w-]+)\)/g)) {
      if (IMAGE_TOKENS.has(tok[1])) offenders.push(`color-mix(… var(${tok[1]}) …)`);
    }
  }
  return offenders;
}

/* ── 主窗口玻璃外壳专项（2026-11-03）──────────────────────────
   外壳只允许用「内阴影 + 壳体侧壁渐变」表达厚度：
   窗口区域裁剪会裁掉盒子外投影，写外阴影不会报错、也不会显示，
   只会让后来的维护者误以为悬浮感来自真实投影。 */
describe("主窗口玻璃外壳", () => {
  /** 按括号深度拆分阴影列表（rgba 内部的逗号不能当分隔符）。 */
  function splitShadowLayers(value: string): string[] {
    const layers: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === "(") depth += 1;
      else if (value[i] === ")") depth -= 1;
      else if (value[i] === "," && depth === 0) {
        layers.push(value.slice(start, i).trim());
        start = i + 1;
      }
    }
    layers.push(value.slice(start).trim());
    return layers.filter(Boolean);
  }

  it("四个上下文都有壳体侧壁层，并铺在环境光之上", () => {
    for (const preset of PRESETS) {
      for (const dark of [false, true]) {
        const tag = `${preset}/${dark ? "dark" : "light"}`;
        const wall = effectiveDecls(preset, dark)["--shell-wall"];
        expect(wall, `${tag} 未定义 --shell-wall`).toBeTruthy();
        // 侧壁必须是渐变图像，不能误写成颜色或纯色
        expect(wall, `${tag} 的 --shell-wall 不是渐变层`).toMatch(/linear-gradient|radial-gradient/);
      }
    }
    const bodies = ruleBodies(themesCss, "theme", ".dock-window::before");
    const body = bodies[bodies.length - 1];
    expect(body).toBeTruthy();
    expect(body).toMatch(
      /background-image:\s*var\(--shell-wall\),\s*var\(--decor\)/,
    );
  });

  it("外壳边光全部是 inset：窗口区域会把外投影裁掉", () => {
    for (const preset of PRESETS) {
      for (const dark of [false, true]) {
        const tag = `${preset}/${dark ? "dark" : "light"}`;
        const edge = effectiveDecls(preset, dark)["--window-edge"];
        expect(edge, `${tag} 未定义 --window-edge`).toBeTruthy();
        const layers = splitShadowLayers(edge);
        // 轮廓环 + 顶光 + 顶柔光 + 左反射 + 右渐弱 + 底厚度 + 底沉降 + 内侧遮蔽
        expect(layers.length, `${tag} 的外壳边光层数不足`).toBeGreaterThanOrEqual(6);
        for (const layer of layers) {
          expect(layer.startsWith("inset"), `${tag} 出现了非内阴影：${layer}`).toBe(true);
        }
      }
    }
  });
});

describe("吸顶与工具栏表面", () => {
  it("渐变令牌不喂给 color-mix()，否则整条声明被静默丢弃", () => {
    // --surface-base / --surface-raised 在两套预设下解析成 --window-fill / --card-face，
    // 都是 <image>；color-mix() 只接受 <color>，写进去不会报错，只会让声明失效，
    // 表现为「背景根本没画上」（历史吸顶标签与 .history-new-banner 原来的症状）。
    expect(imageTokenInColorMix(appCssCode)).toEqual([]);
    expect(imageTokenInColorMix(uiCss.replace(/\/\*[\s\S]*?\*\//g, ""))).toEqual([]);
    expect(imageTokenInColorMix(themesCss.replace(/\/\*[\s\S]*?\*\//g, ""))).toEqual([]);
  });

  it("历史吸顶日期标签自带不透明底，不靠 backdrop-filter 遮", () => {
    // 卡片会从标签底下穿过：没有自身不透明底就只能靠 GPU 模糊糊过去；
    // --surface-overlay 在浅色预设下仍有 4%–8% alpha，故改用全不透明的 --clip-detail-face。
    expect(appCssCode).toMatch(/\.history-day-label\s*\{[^}]*background:\s*var\(--clip-detail-face\)/);
    expect(/\.history-day-label\s*\{[^}]*backdrop-filter/.test(appCssCode)).toBe(false);
    // --clip-detail-face 在六个预设×明暗组合里都必须是不透明纯色
    expect(themesCss).toMatch(/--clip-detail-face:\s*var\(--c-paper\)/);
    const faceDecls = themesCss.match(/--clip-detail-face:\s*[^;]+;/g) ?? [];
    expect(faceDecls.length).toBeGreaterThanOrEqual(4);
    expect(faceDecls.some((d) => /transparent|rgba\(|color-mix/.test(d))).toBe(false);
    // 同一个块里不得再出现两次 padding（后写的会静默覆盖前一个）
    const body = appCssCode.match(/\.history-day-label\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(body.match(/padding\s*:/g)?.length).toBe(1);
  });

  it("工具栏与操作条走圆角令牌，不各自写死像素", () => {
    expect(appCssCode).toMatch(/\.clip-selectbar\s*\{[^}]*border-radius:\s*var\(--radius-card\)/);
    expect(appCssCode).toMatch(/\.clip-detail-head\s*\{[^}]*border-radius:\s*var\(--radius-card\)/);
    expect(appCssCode).toMatch(/\.clip-splitbar\s*\{[^}]*border-radius:\s*var\(--radius-control\)/);
    // 完整页的提示条已经左右留白，不能再是悬在留白里的直角矩形
    expect(appCssCode).toMatch(
      /\.clipboard-page \.clip-link-banner\s*\{[^}]*border-radius:\s*var\(--radius-control\)/,
    );
    // 行内标题编辑框交回全局 input 规则，不再自己用窗口渐变当底色
    expect(appCssCode).not.toMatch(/\.clip-title-input\s*\{[^}]*--surface-base/);
  });
});
