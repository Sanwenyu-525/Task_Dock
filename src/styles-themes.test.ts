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

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 扁平规则表（文件里没有嵌套选择器，@media 只有一层）。
 * 先剥掉注释：注释里会出现 `:root[data-preset=…]` 的示例，若被当成选择器，
 * 会把 `:root` 结构令牌误算进某套预设的令牌集合。 */
const RULES: Rule[] = [...stripComments(themesCss).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim().replace(/\s+/g, " "),
  body: m[2],
}));

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
      if (selectors.some((s) => s.endsWith(".dock-window.is-capsule"))) bodies.push(rule[2]);
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
      if (selectors.some((s) => s.endsWith(selector))) bodies.push(rule[2]);
    }
  }
  return bodies;
}

const PRESETS = ["dream-gradient", "liquid-glass", "frosted", "clear"] as const;

function rulesOf(preset: string, dark: boolean): Rule[] {
  return RULES.filter((r) => {
    if (!r.selector.includes(`data-preset="${preset}"`)) return false;
    // 预设级断言只描述「默认」状态（材质=玻璃、前景=auto）。
    // data-clear-fg 是独立的前景色板维度，不属于 preset/theme 组合，
    // 否则强制浅色文字会被误当成浅色主题的默认值。
    if (r.selector.includes("data-clear-fg=")) return false;
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
  it("所有预设的浅色主题提供同一套令牌名", () => {
    for (const preset of PRESETS) {
      expect(tokenNames(preset, false), `${preset} 浅色令牌名不一致`).toEqual(
        tokenNames("dream-gradient", false),
      );
    }
  });

  it("所有预设的深色主题提供同一套令牌名", () => {
    for (const preset of PRESETS) {
      expect(tokenNames(preset, true), `${preset} 深色令牌名不一致`).toEqual(
        tokenNames("dream-gradient", true),
      );
    }
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

/* ── 清透玻璃（v0.9）──────────────────────────────────────────
   清透模式的硬约束：窗口底色近乎无色、不启用任何整窗模糊；
   前景色板可以强制深/浅，但不得顺手改掉玻璃材质。 */
describe("清透玻璃材质约束", () => {
  it("窗口底色近乎透明，且主题层不出现 backdrop-filter", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const render of ["native", "css"] as const) {
        const tokens = computedTokens({ preset: "clear", theme, render });
        const stops = gradientStops(tokens["--window-fill"]);
        expect(stops.length, `clear/${theme}/${render} 底色不可解析`).toBeGreaterThan(0);
        const maxAlpha = Math.max(...stops.map((s) => s[3]));
        expect(maxAlpha, `clear/${theme}/${render} 底色蒙层过重`).toBeLessThanOrEqual(0.2);
      }
    }
    // backdrop-filter 无法模糊原生窗口之后的桌面，只会增加 GPU 开销。
    // 只匹配实际声明（注释里会说明「不使用 backdrop-filter」）。
    expect(stripComments(themesCss)).not.toMatch(/backdrop-filter\s*:/);
  });

  it("清透前景覆盖只改前景与可读面，不改变窗口整体玻璃材质", () => {
    const rules = TOKEN_RULES.filter((r) => r.selector.includes("data-clear-fg="));
    // 5d.5：只改文字/菜单前景；5d.7：追加「前景↔表面」配对色板
    // （深色文字配浅色玻璃面、浅色文字配深色玻璃面，避免文字与背景一起变淡）。
    expect(rules.length, "缺少清透前景的强制色板规则").toBe(4);
    for (const rule of rules) {
      // 窗口外壳透明度与边光属于窗口材质，不属于前景色板：
      // 只改前景色板、不改窗口整体透明度，因此任何前景覆盖都不得改动这些令牌。
      expect(rule.body).not.toMatch(/--window-fill|--window-edge|--decor-opacity|--glass-tint/);
    }
  });

  it("清透前景在纯白/纯黑桌面最坏情况下仍达到 AA 4.5:1", () => {
    const rgbaOf = (v: string): [number, number, number, number] | null => {
      const hex = /#([0-9a-f]{6})\b/i.exec(v);
      if (hex) {
        const n = parseInt(hex[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
      }
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(v);
      return m ? [+m[1], +m[2], +m[3], m[4] ? +m[4] : 1] : null;
    };
    const lum = ([r, g, b]: number[]): number => {
      const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const contrast = (a: number[], b: number[]): number => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const surfaceOver = (face: string, base: number[]): number[] => {
      const stops = [...face.matchAll(/rgba?\([^)]*\)/g)]
        .map((m) => rgbaOf(m[0]))
        .filter((x): x is [number, number, number, number] => !!x);
      const last = stops[stops.length - 1] ?? [255, 255, 255, 0];
      if (stops.length === 0) return last.slice(0, 3);
      return [0, 1, 2].map((i) => last[i] * last[3] + base[i] * (1 - last[3]));
    };
    const foreground = (fg: "dark" | "light"): string => {
      const rule = TOKEN_RULES.find(
        (r) => r.selector.includes(`data-clear-fg="${fg}"`) && !r.selector.includes("data-material"),
      );
      const m = rule?.body.match(/--text-primary:\s*([^;]+);/);
      return m ? m[1].trim() : "";
    };
    const faceOf = (fg: "dark" | "light", token: string): string => {
      const rule = TOKEN_RULES.find(
        (r) =>
          r.selector.includes(`data-clear-fg="${fg}"`) && r.selector.includes('data-material="glass"'),
      );
      return rule?.body.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1] ?? "";
    };

    for (const fg of ["dark", "light"] as const) {
      const text = rgbaOf(foreground(fg));
      expect(text, `${fg} 前景色不可解析`).toBeTruthy();
      // 深色文字最怕纯黑桌面、浅色文字最怕纯白桌面：按最坏底色合成本地表面。
      const base = fg === "dark" ? [0, 0, 0] : [255, 255, 255];
      for (const token of ["--card-face", "--control-face"]) {
        const ratio = contrast(text!.slice(0, 3), surfaceOver(faceOf(fg, token), base));
        expect(ratio, `${fg} 前景在 ${token} 最坏底色下对比度不足`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("清透前景与表面配对：深字配浅面、浅字配深面", () => {
    const paired = TOKEN_RULES.filter(
      (r) => r.selector.includes("data-clear-fg=") && r.selector.includes('data-material="glass"'),
    );
    expect(paired.length, "缺少清透前景的配对表面规则").toBe(2);
    const dark = paired.find((r) => r.selector.includes('data-clear-fg="dark"'));
    const light = paired.find((r) => r.selector.includes('data-clear-fg="light"'));
    expect(dark, "缺少深色文字配对规则").toBeTruthy();
    expect(light, "缺少浅色文字配对规则").toBeTruthy();
    // 深字必须落在浅色玻璃面上（白系渐变），否则深色桌面上会「字面同色」不可读。
    for (const surface of ["--card-face", "--control-face", "--inset-face"]) {
      expect(dark!.body, `深字配浅面缺少 ${surface}`).toMatch(
        new RegExp(`${surface}:\\s*[^;]*rgba\\(255, 255, 255`),
      );
      expect(light!.body, `浅字配深面缺少 ${surface}`).toMatch(
        new RegExp(`${surface}:\\s*[^;]*rgba\\((6|14|16),`),
      );
    }
    // 导航轨与悬停面同属可读面，必须一起配对，否则图标/选中项跟着背景变淡。
    expect(dark!.body).toMatch(/--rail-bg|--rail-active-face/);
    expect(light!.body).toMatch(/--rail-bg|--rail-active-face/);
  });


  it("关闭玻璃材质时清透预设回退到不透明窗口", () => {
    const solid = computedTokens({ preset: "clear", theme: "light", render: "solid" });
    expect(hasAlpha(solid["--window-fill"]), "清透/solid 仍残留透明窗口").toBe(false);
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
    // 只取基础规则（行首 .capsule-panel），避免命中 .edge-left .capsule-panel 等组合选择器。
    const panel = /^\s*\.capsule-panel\s*\{([\s\S]*?)\}/m.exec(appCss);
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

  it("历史吸顶日期标签：文字无底色，整条不透明遮罩按窗口底色重绘", () => {
    const labelBody = appCssCode.match(/\.history-day-label\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(labelBody, "styles.css 缺少 .history-day-label").not.toBe("");
    // 文字不再带局部底色：底色属于整条吸顶遮罩
    const textBody = appCssCode.match(/\.history-day-label-text\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(textBody, "styles.css 缺少 .history-day-label-text").not.toBe("");
    expect(textBody).not.toMatch(/background|border-radius/);
    // 吸顶：负 top 抵消滚动容器 padding-top，滚过标题条的卡片不会从顶部缝里露出来
    expect(labelBody).toMatch(/position:\s*sticky/);
    expect(labelBody).toMatch(/top:\s*-\d+px/);
    expect(labelBody).toMatch(/z-index:\s*var\(--z-sticky\)/);
    // 细线所在的透明区不拦截指针，卡片滚过时 hover/click 反馈不被遮挡；只有文字块可交互
    expect(labelBody).toMatch(/pointer-events:\s*none/);
    expect(textBody).toMatch(/pointer-events:\s*auto/);
    // 整条遮罩必须完全不透明：不透明窗口底 + 窗口渐变 + 氛围光（按预设自身的 --decor-opacity 衰减）
    const mask = appCssCode.match(/\.history-day-label-mask\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(mask, "缺少整条吸顶遮罩 .history-day-label-mask").not.toBe("");
    expect(mask).toMatch(/position:\s*absolute/);
    expect(mask).toMatch(/inset:\s*0/);
    expect(mask).toMatch(/background-color:\s*var\(--capsule-face\)/);
    expect(mask).toMatch(/background-image:\s*var\(--window-fill\)/);
    // 固定视口坐标重绘，才能和 .dock-window 的整窗渐变对齐、不出接缝
    expect(mask).toMatch(/background-attachment:\s*fixed/);
    const maskDecor = appCssCode.match(/\.history-day-label-mask::before\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(maskDecor, "遮罩缺少氛围光复刻层").not.toBe("");
    expect(maskDecor).toMatch(/background-image:\s*var\(--decor\)/);
    expect(maskDecor).toMatch(/opacity:\s*var\(--decor-opacity/);
    // 不靠实时背景模糊遮内容
    expect(appCssCode).not.toMatch(/\.history-day-label[^{]*\{[^}]*backdrop-filter/);
    // 两侧细线使用低对比边框语义，深浅主题均可见
    expect(appCssCode).toMatch(
      /\.history-day-label::before[^{]*\{[^}]*background:\s*var\(--border-subtle\)/,
    );
    // 同一个块里不得再出现两次 padding（后写的会静默覆盖前一个）
    expect(labelBody.match(/padding\s*:/g)?.length).toBe(1);
    // 去掉文字底色后仍要保持正文级对比，不能退回弱对比灰
    expect(labelBody).toMatch(/color:\s*var\(--text-(secondary|primary)\)/);
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

/* ── 全局卡片基础表面守卫（方案 D，2026-11-04）────────────────────
   新页面接入共享卡片时，只允许追加 .surface-card / 变体类，
   不得再把 radius / background / box-shadow 整套复制一遍。
   这条测试只锁「已迁移」的卡片，避免误伤仍在独立维护的专用表面。 */
describe("全局卡片基础表面", () => {
  function bodyOf(css: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(stripComments(css))?.[1] ?? "";
  }

  it(".surface-card 承担基础材质，.task-card 作为兼容别名并入同一规则", () => {
    expect(themesCss).toMatch(
      /\.surface-card,\s*\.task-card\s*\{[^}]*border-radius:\s*var\(--radius-card\)[^}]*background:\s*var\(--card-face\)[^}]*box-shadow:\s*var\(--card-shadow\)/,
    );
  });

  it("历史卡 hover 只做描边与轻阴影，不做垂直位移", () => {
    const hover = bodyOf(appCssCode, ".history-item:hover");
    expect(hover, "缺少 .history-item:hover 覆盖").not.toBe("");
    // 必须落在顶层 ui 层：styles.css 整体包在 @layer base 内，若在 base 内再写
    // @layer ui 会变成子层 base.ui，仍低于 theme，压不过通用交互变体的
    // .surface-card--interactive:hover 的 translateY(-1px)。
    expect(
      appCssCode,
      ".history-item:hover 必须写在顶层 @layer ui（不能嵌套在 base 内）",
    ).toMatch(/\}\s*@layer\s+ui\s*\{[^}]*\.history-item:hover[^}]*transform:\s*none/);
    expect(hover).toMatch(/transform:\s*none/);
    expect(hover).not.toMatch(/translateY|translate3d/);
    // 替代反馈是低对比内描边 + 已有的轻阴影，不占布局
    expect(hover).toMatch(/box-shadow:[^;]*var\(--card-shadow-hover\)[^;]*inset 0 0 0 1px var\(--border-strong\)/);
  });

  it("已迁移的卡片不再自己写圆角 / 卡面 / 阴影", () => {
    const migrated = [".history-item", ".inbox-item", ".shelf-item", ".discovery-card"];
    for (const selector of migrated) {
      const body = bodyOf(appCss, selector);
      expect(body, `${selector} 没有找到规则`).not.toBe("");
      expect(body, `${selector} 应改用 .surface-card`).not.toMatch(
        /border-radius|box-shadow|--card-face|--surface-raised/,
      );
    }
  });
});

/* ── 深色液态玻璃选中态层叠回归（2026-11-03）────────────────────
   本次根因不是某个控件写错颜色，而是 CSS 层叠：一节「浅色 CSS 玻璃」
   的多属性选择器（:root[data-preset][data-glass-render]）漏了明暗条件，
   与深色基础规则同为 (0,3,0)，但位于文件更后面，于是深色也被套上了
   #ffffff..#f2f6fc 的导航选中底与浅色白边卡片阴影。

   下面用「选择器匹配 + 权重 + 文件顺序」还原最终生效值（与浏览器层叠
   规则一致；已用 jsdom 载入真实样式表交叉核对过同一组取值）。只做字符串
   包含判断无法发现这类「规则都写了、但被别的规则压过」的问题。 */

type ThemeState = {
  preset: "dream-gradient" | "liquid-glass" | "frosted" | "clear";
  theme: "light" | "dark";
  render: "native" | "css" | "solid";
};

const stateAttrs = (s: ThemeState): Record<string, string> => ({
  "data-preset": s.preset,
  "data-theme": s.theme,
  "data-material": s.render === "solid" ? "solid" : "glass",
  "data-glass-render": s.render,
});

/** 去掉 @media 块：对比度/宽度查询不参与默认 Token 层叠。 */
function withoutMediaBlocks(css: string): string {
  let out = "";
  let last = 0;
  const re = /@media[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
    }
    out += css.slice(last, m.index);
    last = i;
    re.lastIndex = i;
  }
  return out + css.slice(last);
}

/** 根容器 Token 规则（选择器全部是 `:root` / `:root[...]`），保持文件顺序。 */
const TOKEN_RULES: Rule[] = [
  ...withoutMediaBlocks(stripComments(themesCss)).matchAll(/([^{}]+)\{([^{}]*)\}/g),
]
  .map((m) => ({
    selector: m[1].trim().replace(/\s+/g, " "),
    body: m[2],
  }))
  .filter((rule) => selectorsOf(rule).every((s) => /^(:root|html)[[\]:]?/.test(s)));

/** 单条根选择器是否命中当前属性组合；返回 CSS 权重（身份+属性数）。 */
function selectorSpecificity(selector: string, state: ThemeState): number {
  const compact = selector.trim().replace(/\s+/g, " ");
  const m = /^(:root|html)((?:\[data-[\w-]+="[^"]+"\])*)$/.exec(compact);
  if (!m) return -1;
  const attrs = stateAttrs(state);
  for (const cond of m[2].matchAll(/\[data-([\w-]+)="([^"]+)"\]/g)) {
    if (attrs[`data-${cond[1]}`] !== cond[2]) return -1;
  }
  const count = [...m[2].matchAll(/\[data-[\w-]+="[^"]+"\]/g)].length;
  return 1 + count; // :root 身份(0,1,0) + 每个属性选择器(0,1,0)
}

/** 某属性组合下最终生效的 Token（权重升序 + 同权重按文件顺序）。 */
function computedTokens(state: ThemeState): Record<string, string> {
  const matched: { spec: number; index: number; body: string }[] = [];
  TOKEN_RULES.forEach((rule, index) => {
    const spec = Math.max(-1, ...selectorsOf(rule).map((s) => selectorSpecificity(s, state)));
    if (spec >= 0) matched.push({ spec, index, body: rule.body });
  });
  matched.sort((a, b) => a.spec - b.spec || a.index - b.index);
  const out: Record<string, string> = {};
  for (const { body } of matched) {
    for (const decl of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[decl[1]] = decl[2].trim();
  }
  return out;
}

const LIQUID = {
  lightNative: { preset: "liquid-glass", theme: "light", render: "native" },
  lightCss: { preset: "liquid-glass", theme: "light", render: "css" },
  lightSolid: { preset: "liquid-glass", theme: "light", render: "solid" },
  darkNative: { preset: "liquid-glass", theme: "dark", render: "native" },
  darkCss: { preset: "liquid-glass", theme: "dark", render: "css" },
  darkSolid: { preset: "liquid-glass", theme: "dark", render: "solid" },
} as const satisfies Record<string, ThemeState>;

type Rgba = [number, number, number, number];

function colorOf(text: string): Rgba | null {
  const rgba = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i.exec(text);
  if (rgba) {
    return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  }
  const hex = /#([0-9a-f]{6})([0-9a-f]{2})?\b/i.exec(text);
  if (!hex) return null;
  const raw = hex[1];
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
    hex[2] === undefined ? 1 : parseInt(hex[2], 16) / 255,
  ];
}

/** 渐变里按出现顺序的所有颜色停靠点。 */
function gradientStops(value: string): Rgba[] {
  const out: Rgba[] = [];
  for (const m of value.matchAll(/(?:rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+)?\s*\)|#[0-9a-f]{3,8}\b)/gi)) {
    const c = colorOf(m[0]);
    if (c) out.push(c);
  }
  return out;
}

function compositeOver(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3] + bottom[3] * (1 - top[3]);
  if (a === 0) return [0, 0, 0, 0];
  const mix = (i: 0 | 1 | 2) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
  return [mix(0), mix(1), mix(2), a];
}

function relativeLuminance([r, g, b]: Rgba): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** 窗口底色最深的一个停靠点，作为选中面合成时的底。 */
function deepestWindowStop(fill: string): Rgba {
  const stops = gradientStops(fill);
  const solid = stops.filter((c) => c[3] >= 0.9);
  const pool = solid.length > 0 ? solid : stops;
  return pool.reduce((acc, c) => (acc[0] + acc[1] + acc[2] <= c[0] + c[1] + c[2] ? acc : c), pool[0]);
}

/** 选中面在真实底面上的合成亮度（取最亮停靠点 = 可读性最差位置）。 */
function faceMaxLuminance(face: string, windowFill: string): number {
  const bg = deepestWindowStop(windowFill);
  return Math.max(...gradientStops(face).map((stop) => relativeLuminance(compositeOver(stop, bg))));
}

describe("深色液态玻璃选中态（层叠回归）", () => {
  it("深色 CSS 玻璃的导航选中面是深色玻璃，不是 #ffffff 浅色面", () => {
    const light = computedTokens(LIQUID.lightCss);
    const dark = computedTokens(LIQUID.darkCss);
    expect(light["--rail-active-face"], "浅色 CSS 玻璃选中面丢失").toBeTruthy();
    expect(dark["--rail-active-face"], "深色 CSS 玻璃缺少专有选中面").toBeTruthy();
    // 同一个属性选择器规则的取值必须真正不同，不能再被浅色规则压过
    expect(dark["--rail-active-face"]).not.toBe(light["--rail-active-face"]);
    expect(dark["--rail-active-face"]).not.toMatch(/#ffffff|#fff\b/);
    const lum = faceMaxLuminance(dark["--rail-active-face"], dark["--window-fill"]);
    expect(lum, `深色选中面合成后仍偏亮（L=${lum.toFixed(3)}）`).toBeLessThan(0.12);
    // 浅色选中面必须保持明亮：修复不能把浅色一起压暗
    const lightLum = faceMaxLuminance(light["--rail-active-face"], light["--window-fill"]);
    expect(lightLum, `浅色选中面被压暗（L=${lightLum.toFixed(3)}）`).toBeGreaterThan(0.85);
  });

  it("深色 CSS 玻璃不继承浅色霜面专属的白边卡片阴影", () => {
    const light = computedTokens(LIQUID.lightCss)["--card-shadow"];
    const dark = computedTokens(LIQUID.darkCss)["--card-shadow"];
    expect(dark).toBeTruthy();
    expect(dark).not.toBe(light);
    expect(dark).not.toMatch(/#ffffff/i);
    // 不允许出现「白色 + 高不透明度」的浅色高光层（那是浅色霜面的做法）
    for (const stop of gradientStops(dark)) {
      const [r, g, b, a] = stop;
      expect(r + g + b === 765 && a > 0.5, `深色卡片阴影出现白色高光层：${stop.join(",")}`).toBe(false);
    }
    expect(computedTokens(LIQUID.darkCss)["--card-shadow-hover"]).not.toBe(
      computedTokens(LIQUID.lightCss)["--card-shadow-hover"],
    );
  });

  it("选中面令牌确实被导航与停靠胶囊选中态消费", () => {
    const rail = /\.rail-item\.active\s*\{([\s\S]*?)\}/.exec(themesCss);
    expect(rail?.[1]).toMatch(/background:\s*var\(--rail-active-face\)/);
    const cap = /\.cap-btn\.is-active\s*\{([\s\S]*?)\}/.exec(themesCss);
    expect(cap?.[1], "themes 层缺少 .cap-btn.is-active 覆盖").toBeTruthy();
    expect(cap?.[1]).toMatch(/background:\s*var\(--rail-active-face\)/);
    expect(cap?.[1]).toMatch(/color:\s*var\(--rail-active-text\)/);
  });

  it("六种液态玻璃渲染组合都定义选中态与卡片层级令牌", () => {
    for (const state of Object.values(LIQUID)) {
      const tokens = computedTokens(state);
      const tag = `${state.theme}/${state.render}`;
      for (const key of [
        "--rail-active-face",
        "--rail-active-text",
        "--rail-active-shadow",
        "--card-face",
        "--card-shadow",
        "--card-shadow-hover",
        "--window-edge",
        "--control-face",
        "--pill-active-face",
      ]) {
        expect(tokens[key], `${tag} 未解析出 ${key}`).toBeTruthy();
      }
    }
  });

  it("明暗与材质切换会更新选中面和卡片阴影，而不是沿用上一态", () => {
    const pairs: [ThemeState, ThemeState][] = [
      [LIQUID.lightNative, LIQUID.darkNative],
      [LIQUID.lightCss, LIQUID.darkCss],
      [LIQUID.lightSolid, LIQUID.darkSolid],
    ];
    for (const [light, dark] of pairs) {
      const l = computedTokens(light);
      const d = computedTokens(dark);
      for (const key of ["--rail-active-face", "--card-face", "--window-fill", "--text-tertiary"]) {
        expect(d[key], `${light.render} 的 ${key} 明暗切换后未变化`).not.toBe(l[key]);
      }
    }
    const css = computedTokens(LIQUID.darkCss);
    const solid = computedTokens(LIQUID.darkSolid);
    expect(css["--window-fill"]).not.toBe(solid["--window-fill"]);
    expect(css["--rail-active-face"]).not.toBe(solid["--rail-active-face"]);
  });

  it("CSS 玻璃的根 Token 规则都限定了明暗，不再有无条件覆盖", () => {
    const offenders: string[] = [];
    for (const rule of TOKEN_RULES) {
      if (!rule.selector.includes('data-glass-render="css"')) continue;
      for (const selector of selectorsOf(rule)) {
        if (!/data-theme="(light|dark)"/.test(selector) && !/:not\(/.test(selector)) offenders.push(selector);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("说明文字的第三级颜色在两套预设的明暗下都达到 WCAG AA 4.5:1", () => {
    const bg: Record<"light" | "dark", Rgba> = { light: [251, 253, 255, 1], dark: [27, 34, 52, 1] };
    for (const preset of PRESETS) {
      for (const theme of ["light", "dark"] as const) {
        const token = computedTokens({ preset, theme, render: "native" })["--text-tertiary"];
        const color = colorOf(token);
        expect(color, `${preset}/${theme} 的 --text-tertiary 不是可解析颜色：${token}`).toBeTruthy();
        const ratio = contrastRatio(color!, bg[theme]);
        expect(ratio, `${preset}/${theme} 的 --text-tertiary 对比度 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("深色主题卡未选中圆点不再用 85% 白，选中态仍由 accent 表达", () => {
    const darkRadio = /:root\[data-theme="dark"\]\s*\.preset-card:not\(\.active\)\s*\.preset-radio\s*\{([\s\S]*?)\}/.exec(
      themesCss,
    );
    expect(darkRadio?.[1], "缺少深色未选中圆点规则").toBeTruthy();
    expect(darkRadio![1]).not.toMatch(/var\(--c-paper\)\s*85%/);
    expect(themesCss).toMatch(/\.preset-card\.active \.preset-radio\s*\{[^}]*background:\s*var\(--accent\)/);
  });

  it("导航项有键盘焦点环，且焦点环收在窄轨内不被裁掉", () => {
    const focus = /\.rail-item:focus-visible\s*\{([\s\S]*?)\}/.exec(themesCss);
    expect(focus?.[1], "缺少 .rail-item:focus-visible").toBeTruthy();
    expect(focus![1]).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(focus![1]).toMatch(/outline-offset:\s*-2px/);
  });
});

/* ── 交互稳定性专项（2026-11-04）────────────────────────────────
   主题选择卡与左侧导航只用表面/颜色表达状态：
   hover / 选中 / 按下不得出现位移、缩放或旋转；
   reduced-motion 块之后不得再有覆盖它的过渡声明（层叠顺序守卫）。 */
describe("预设卡与导航项的悬停稳定性", () => {
  /** 匹配单个类及其状态链（`.rail-item.active`、`.preset-card:not(.active):hover`）。 */
  const STATE_SELECTOR = /^\.(rail-item|preset-card)(?:[.:][\w-]+(?:\([^)]*\))?)*$/;

  function declarations(selector: string): string {
    return RULES.filter((rule) => selectorsOf(rule).includes(selector))
      .map((rule) => rule.body)
      .join("\n");
  }

  /** 只收集真正产生位移/缩放的声明；reduce 块里的 `transform: none` 视为无动效。 */
  function motionOf(body: string): string[] {
    const out: string[] = [];
    for (const prop of ["transform", "translate", "scale", "rotate"]) {
      const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+);`));
      if (m && m[1].trim() !== "none") out.push(`${prop}: ${m[1].trim()}`);
    }
    return out;
  }

  it("主题卡与导航项的状态规则不含 transform / translate / scale / rotate", () => {
    const offenders: string[] = [];
    for (const rule of RULES) {
      const sels = selectorsOf(rule);
      if (!sels.some((s) => STATE_SELECTOR.test(s))) continue;
      for (const motion of motionOf(rule.body)) offenders.push(`${rule.selector} → ${motion}`);
    }
    expect(offenders).toEqual([]);
  });

  it("主题卡四态可区分：hover 淡染、选中强调环、键盘焦点环", () => {
    const hover = declarations(".preset-card:not(.active):hover");
    expect(hover).toMatch(/background-color:\s*color-mix/);
    expect(motionOf(hover)).toEqual([]);

    const selected = declarations(".preset-card.active");
    expect(selected).toMatch(/0 0 0 1\.5px var\(--accent\)/);

    const focus = declarations(".preset-card:focus-visible");
    expect(focus).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(focus).toMatch(/outline-offset:\s*2px/);
  });

  it("导航项 hover / 选中 / 按下不位移，状态仍由背景与颜色表达", () => {
    for (const selector of [".rail-item:hover", ".rail-item.active", ".rail-item.active:active"]) {
      expect(motionOf(declarations(selector)), `${selector} 不应再声明位移动效`).toEqual([]);
    }
    expect(declarations(".rail-item:hover")).toMatch(/background:\s*var\(--rail-hover-face\)/);
    expect(declarations(".rail-item.active")).toMatch(/background:\s*var\(--rail-active-face\)/);
  });

  it("reduced-motion 块之后没有覆盖它的 transition 声明", () => {
    const css = stripComments(themesCss);
    const blocks = [...css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g)]
      .map((m) => {
        let depth = 0;
        let end = m.index!;
        for (; end < css.length; end += 1) {
          if (css[end] === "{") depth += 1;
          else if (css[end] === "}") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        return { start: m.index!, end: end + 1, body: css.slice(m.index!, end + 1) };
      })
      .filter((block) => block.body.includes(".rail-item"));

    expect(blocks.length, "缺少覆盖导航/预设卡的 reduced-motion 块").toBeGreaterThan(0);
    const block = blocks[blocks.length - 1];
    expect(block.body, "reduce 下导航项应关闭过渡").toMatch(/\.rail-item[\s\S]*?transition:\s*none/);
    expect(block.body, "reduce 下预设卡应关闭位移动效").toMatch(
      /\.preset-card[\s\S]*?transform:\s*none/,
    );

    // 关键：reduce 块之后的同名规则会按文件顺序压过它（历史回归点）。
    const tail = css.slice(block.end);
    expect(tail, "reduced-motion 之后仍有覆盖的 transition 声明").not.toMatch(
      /\.(rail-item|preset-card)(?:[.:][\w-]+(?:\([^)]*\))?)*\s*\{[^}]*transition\s*:/,
    );
  });
});

/* ── 胶囊面板输入与网格复用规范（2026-11-05）────────────────────
   胶囊搜索框改为复用 SearchField 后，焦点只允许外层容器画一次；
   内层 input 不得再叠加背景/边框/outline/box-shadow。
   添加入口回归为「与图标同尺度的加号」，不再是大面积卡片。 */
describe("胶囊面板共享输入与添加入口", () => {
  it("内嵌输入在 ui 层统一清掉第二层焦点背景/边框/阴影", () => {
    const rule = /\.input-embedded[^{]*\{([\s\S]*?)\}/.exec(uiCss);
    expect(rule?.[1], "缺少 .input-embedded 规范").toBeTruthy();
    expect(rule![1]).toMatch(/border:\s*none/);
    expect(rule![1]).toMatch(/box-shadow:\s*none/);
    expect(rule![1]).toMatch(/outline:\s*none/);
  });

  it("胶囊搜索变体只由容器 :focus-within 表达焦点", () => {
    const rule = /\.ui-search\.ui-search--capsule:focus-within\s*\{([\s\S]*?)\}/.exec(uiCss);
    expect(rule?.[1], "缺少胶囊搜索焦点规则").toBeTruthy();
    expect(rule![1]).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--accent\)/);
    expect(rule![1]).not.toMatch(/var\(--focus-ring\)/);
  });

  it("添加入口有常显轮廓、默认无外阴影与底色", () => {
    const rule = /\.cap-app-add\s*\{([\s\S]*?)\}/.exec(appCss);
    expect(rule?.[1], "缺少 .cap-app-add 基础规则").toBeTruthy();
    // 整格按钮本身不画边框/底色/外阴影，轮廓只落在 34px 视觉容器上
    expect(rule![1]).toMatch(/border:\s*0/);
    expect(rule![1]).toMatch(/background:\s*transparent/);
    expect(rule![1]).toMatch(/box-shadow:\s*none/);

    const avatar = /(?:^|\n)\.cap-app-avatar\.is-add\s*\{([\s\S]*?)\}/.exec(appCss);
    expect(avatar?.[1], "缺少 .cap-app-avatar.is-add 轮廓规则").toBeTruthy();
    expect(avatar![1]).toMatch(/border:\s*1px solid/);
    expect(avatar![1]).toMatch(/background:\s*transparent/);
    expect(avatar![1]).toMatch(/box-shadow:\s*none/);
  });

  // 2026-11-06 设计调整：应用磁贴不再保持全透明，改为轻量 hover / active 反馈
  // （对照 Win11 开始菜单的手感）。不变的部分：1px 描边走 inset 阴影不参与盒模型，
  // 图标容器不铺底色、不缩放，浅色 Logo 的对比度不受影响。
  it("普通应用 hover / active 用半透明底 + 内描边反馈，图标容器仍不铺底色", () => {
    const hover = /\.cap-app-slot:hover \.cap-app,\s*\.cap-app-add:hover\s*\{([\s\S]*?)\}/.exec(
      appCss,
    );
    expect(hover?.[1], "缺少磁贴 hover 规则").toBeTruthy();
    expect(hover![1]).toMatch(/background:\s*color-mix\(in srgb, var\(--cap-text-1\) 6%/);
    // 1px 描边用 inset 阴影：不参与盒模型，网格不会因新增 border 抖动
    expect(hover![1]).toMatch(/box-shadow:\s*inset 0 0 0 1px/);
    expect(hover![1]).not.toMatch(/\bborder:/);

    const active = /\.cap-app:active:not\(:disabled\)\s*\{([\s\S]*?)\}/.exec(appCss);
    expect(active?.[1], "缺少磁贴 active 规则").toBeTruthy();
    expect(active![1]).toMatch(/background:\s*color-mix\(in srgb, var\(--cap-text-1\) 10%/);

    // 图标容器不得出现 hover / active 背景，也不留 background 过渡
    expect(appCss).not.toMatch(/\.cap-app:hover[^{]*\.cap-app-icon\s*\{[^}]*background\s*:/);
    expect(appCss).not.toMatch(/\.cap-app:active[^{]*\.cap-app-icon\s*\{[^}]*background\s*:/);
    expect(appCss).not.toMatch(/\.cap-app-icon\s*\{[^}]*transition:\s*background/);
  });

  // 2026-11-06：`--cap-panel-base` 此前只有 4 处引用、没有任何定义，
  // 导致 color-mix 声明失效，启动 spinner 与图片切换按钮的底衬退化成透明。
  it("启动 spinner / 图片浮层的底衬 Token 有真实定义", () => {
    expect(appCss).toMatch(/--cap-panel-base:\s*var\(--wing-panel-base\)/);
    expect(appCss).toMatch(/\.cap-app-spinner\s*\{[^}]*background:\s*color-mix\([^)]*--cap-panel-base/);
  });

  it("工具面板关闭按钮：28×28、默认透明、hover/active 用中性半透明、不投阴影", () => {
    const close = /(?:^|\n)\.cap-close\s*\{([\s\S]*?)\}/.exec(appCss);
    expect(close?.[1], "缺少 .cap-close 基础规则").toBeTruthy();
    expect(close![1]).toMatch(/width:\s*28px/);
    expect(close![1]).toMatch(/height:\s*28px/);
    expect(close![1]).toMatch(/background:\s*transparent/);
    expect(close![1]).toMatch(/border:\s*0/);
    expect(close![1]).not.toMatch(/box-shadow/);
    // 常驻红色会让「关闭」看起来像危险操作，这里只允许语义文本色
    expect(close![1]).not.toMatch(/status-error/);

    const hover = /\.cap-close:hover\s*\{([\s\S]*?)\}/.exec(appCss);
    expect(hover?.[1], "缺少 .cap-close hover 规则").toBeTruthy();
    expect(hover![1]).toMatch(/color-mix\(in srgb, var\(--cap-text-1\) 7%/);

    const focus = /\.cap-close:focus-visible\s*\{([\s\S]*?)\}/.exec(appCss);
    expect(focus?.[1], "缺少 .cap-close 键盘焦点规则").toBeTruthy();
    expect(focus![1]).toMatch(/outline:\s*2px solid var\(--accent\)/);
  });

  it("应用磁贴内容在整格内垂直居中，尺寸与 hover 覆盖范围不变", () => {
    const tile = /(?:^|\n)\.cap-app\s*\{([\s\S]*?)\}/.exec(appCss);
    expect(tile?.[1], "缺少 .cap-app 基础规则").toBeTruthy();
    expect(tile![1]).toMatch(/justify-content:\s*center/);
    expect(tile![1]).toMatch(/align-items:\s*center/);
    // 高度仍由网格统一变量决定，hover 仍覆盖整格
    expect(tile![1]).toMatch(/height:\s*var\(--cap-app-cell-h\)/);
    expect(appCss).toMatch(/\.cap-app-slot:hover \.cap-app[\s\S]{0,200}?background:/);
  });

  // 2026-11-06 精修：22px 删除热区在 72px 磁贴里与 34px 图标包围盒重叠 3px
  //（窄窗 65px 磁贴重叠 6.5px），实测 8% 的磁贴采样点命中删除而不是启动。
  // 收成 18px 后名义尺寸下两者分离；图标容器尺寸不变（不允许为避让而缩图标）。
  it("应用磁贴删除按钮收在角上，不与居中图标热区重叠", () => {
    const del = /(?:^|\n)\.cap-app-del\s*\{([\s\S]*?)\}/.exec(appCss);
    expect(del?.[1], "缺少 .cap-app-del 基础规则").toBeTruthy();
    expect(del![1]).toMatch(/width:\s*18px/);
    expect(del![1]).toMatch(/height:\s*18px/);
    expect(del![1]).toMatch(/top:\s*0/);
    expect(del![1]).toMatch(/right:\s*0/);
    expect(appCss).toMatch(/\.cap-app-icon\s*\{[^}]*width:\s*36px/);
    expect(appCss).toMatch(/\.cap-app-icon\s*\{[^}]*height:\s*36px/);
  });

  // 2026-11-07：18px 是热区下限（继续缩小会牺牲可用性），窄窗改为收敛列数。
  // 34px 图标在 W 宽磁贴里距右边缘 (W-34)/2，要完整放下 18px 删除按钮需 W ≥ 70。
  // 真实面板宽度：原生胶囊窗口 404 CSS px 触发窄窗兜底，面板 = 404-68 = 336
  //（不是设计常量 340），4 列时每列 71px、图标与按钮仍留 0.5px 间隙；因此
  // 4 列的判定按 336 而不是 340。换算：4 列需面板 ≥ 336（内容盒 ≥ 308），
  // 3 列需 ≥ 262（≥72/列），2 列需 ≥ 184。容器查询取面板**内容盒**（面板宽 - 28）。
  it("窄面板应用网格按容器宽度收敛列数（4→3→2→1），原生默认宽度不改变布局", () => {
    // 容器参照是应用面板自身，而不是列表滚动盒：滚动条出现不会让列数抖动
    expect(appCss).toMatch(
      /\.capsule-panel\[data-panel="apps"\]\s*\{[^}]*container-type:\s*inline-size/,
    );
    expect(appCss).toMatch(
      /\.capsule-panel\[data-panel="apps"\]\s*\{[^}]*container-name:\s*cap-panel/,
    );
    // 默认仍是 4 列；原生 336 面板（内容盒 308）不下发任何收敛规则
    const grid = /(?:^|\n)\.cap-app-grid\s*\{([\s\S]*?)\}/.exec(appCss);
    expect(grid?.[1], "缺少 .cap-app-grid 基础规则").toBeTruthy();
    expect(grid![1]).toMatch(/grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);

    const block = (max: number) => {
      const m = new RegExp(
        `@container cap-panel \\(max-width: ${max}px\\)\\s*\\{([\\s\\S]*?)\\}\\s*\\}`,
      ).exec(appCss);
      expect(m?.[1], `缺少 ${max}px 的列数收敛规则`).toBeTruthy();
      return m![1];
    };
    expect(block(307)).toMatch(/grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
    expect(block(233)).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(block(155)).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  });

  it("添加入口有清晰键盘焦点且不叠第二层焦点框", () => {
    // 由面板焦点统一规则只画一次 2px 实色 outline
    expect(appCss).toMatch(
      /\.cap-app-add:focus-visible,[\s\S]{0,300}?\{[^}]*outline:\s*2px solid var\(--accent\)/,
    );
    // 不再存在单独声明的第二层焦点框（offset 与外层规则不一致）
    expect(appCss).not.toMatch(/\}\s*\.cap-app-add:focus-visible\s*\{/);
  });

  it("compact 搜索档沿用常规字号（13px），容器高度保持 26px 不撑破工具栏", () => {
    // 真实渲染实测：12px compact 档的 font box 约 11px，常规档 13px 约 12px；
    // 统一提高字号而不放大容器，9 处工具栏行高不变。
    const compactBox = /\.ui-search--compact\s*\{([\s\S]*?)\}/.exec(uiCss);
    expect(compactBox?.[1], "缺少 compact 搜索容器规则").toBeTruthy();
    expect(compactBox![1]).toMatch(/min-height:\s*26px/);
    expect(compactBox![1]).toMatch(/padding:\s*2px 4px 2px 7px/);

    const compactInput = /\.ui-search--compact \.ui-search-input\s*\{([\s\S]*?)\}/.exec(uiCss);
    expect(compactInput?.[1], "缺少 compact 搜索输入字号规则").toBeTruthy();
    expect(compactInput![1]).toMatch(/font-size:\s*var\(--input-font-size\)/);
    expect(compactInput![1]).not.toMatch(/--input-font-size-sm/);

    const capsuleBox = /\.ui-search\.ui-search--capsule\s*\{([\s\S]*?)\}/.exec(uiCss);
    expect(capsuleBox?.[1], "缺少胶囊搜索容器规则").toBeTruthy();
    expect(capsuleBox![1]).toMatch(/height:\s*var\(--input-height-sm\)/);

    const quickAdd = /\.cap-input input\s*\{([\s\S]*?)\}/.exec(appCss);
    expect(quickAdd?.[1], "缺少胶囊快捷输入规则").toBeTruthy();
    expect(quickAdd![1]).toMatch(/font-size:\s*var\(--input-font-size\)/);
  });
});

/* ── 输入框光标颜色统一（2026-11-06 · 核对补验）──────────────────
   光标颜色全部收敛到 --input-caret-color（指向主题 accent）：
   - 全局基线 input/select/textarea 与内嵌输入组（styles-ui.css）都必须引用变量；
   - 任何样式表不得把 caret-color 写死成字面颜色，否则深浅主题切换后
     光标会在另一套主题里不可见（历史上「光标不可读」的根因形态）。 */
describe("输入框光标可读性", () => {
  const caretDecls = (css: string): string[] =>
    [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/caret-color:\s*([^;}]+)/g)].map((m) =>
      m[1].trim(),
    );

  it("全局基线与内嵌输入组都引用统一的 caret 令牌", () => {
    const globalBaseline = /(?:^|\})\s*input,\s*\n?select,\s*\n?textarea\s*\{([^{}]*)\}/.exec(
      appCssCode,
    );
    expect(globalBaseline?.[1], "缺少全局 input/select/textarea 基线规则").toBeTruthy();
    expect(globalBaseline![1]).toMatch(/caret-color:\s*var\(--input-caret-color\)/);

    const embedded = /\.input-embedded,\s*\n\.search-box input[\s\S]*?\{([^{}]*)\}/.exec(uiCss);
    expect(embedded?.[1], "缺少内嵌输入 caret 统一组").toBeTruthy();
    expect(embedded![1]).toMatch(/caret-color:\s*var\(--input-caret-color\)/);

    const searchInput = /\.ui-search \.ui-search-input\s*\{([^{}]*)\}/.exec(uiCss);
    expect(searchInput?.[1]).toMatch(/caret-color:\s*var\(--input-caret-color\)/);
  });

  it("两套样式表不存在写死的 caret 颜色（一律走主题令牌）", () => {
    for (const [name, decl] of [
      ["styles-ui.css", caretDecls(uiCss)],
      ["styles.css", caretDecls(appCssCode)],
    ] as const) {
      for (const value of decl) {
        expect(value, `${name} 中 caret-color 未使用令牌: ${value}`).toMatch(
          /^var\(--[\w-]+\)$/,
        );
      }
    }
    // 令牌定义本身指向 accent（主题色），随预设/明暗联动。
    expect(uiCss).toMatch(/--input-caret-color:\s*var\(--accent\)/);
  });
});

