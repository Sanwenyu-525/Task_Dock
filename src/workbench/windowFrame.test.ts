// @vitest-environment jsdom
//! 工作台**窗口级**外形的守卫：原生区域裁剪与应用内可见弧必须同源。
//!
//! 这里锁住三件事，避免以后改样式时把原生窗口外观又改回直角矩形：
//! 1. `workbench.css` 的最外层窗口框使用预设 Token（`--radius-window`），
//!    不写死像素值，两套视觉预设自然一致；边框只用 1px `--window-border`，
//!    不出现双层边框；
//! 2. `html/body/#root` 必须透明——圆角外侧要真的是背景像素，否则会有
//!    白色/黑色直角方块；
//! 3. 最大化时窗口框退成直角无边（原生区域同时取直角，见 Rust
//!    `sync_workbench_frame`），避免屏边缝隙与 1px 亮边。
import { describe, expect, it, beforeEach } from "vitest";
import workbenchCss from "./workbench.css?raw";
import {
  CONTINUOUS_CORNER_CSS_K,
  CONTINUOUS_CORNER_CSS_VALUE,
  CONTINUOUS_CORNER_EXPONENT,
  readWindowRadiusCss,
  windowCornerPlan,
} from "./windowFrame";

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 扁平规则表；这里只需要选择器 + 声明体，不做层叠计算。 */
const RULES = [...stripComments(workbenchCss).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim().replace(/\s+/g, " "),
  body: m[2].trim(),
}));

const bodyOf = (selector: string): string => {
  const hit = RULES.filter((r) => r.selector === selector);
  return hit.map((r) => r.body).join(";");
};

const declarations = (body: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const part of body.split(";")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  return map;
};

describe("workbench 窗口框", () => {
  it("外壳使用预设圆角 Token 与 1px 细边框", () => {
    const decls = declarations(bodyOf(".wb-root, .wb-boot"));
    // 半径 = 预设 Token + 连续圆角补偿；两端同源（补偿由 windowFrame.ts 计算并下发）
    expect(decls.get("border-radius")).toBe(
      "calc(var(--radius-window) + var(--wb-corner-extra, 0px))",
    );
    expect(decls.get("border")).toBe("1px solid var(--window-border)");
    expect(decls.get("overflow")).toBe("hidden");
    expect(decls.get("box-sizing")).toBe("border-box");
    // 不写死半径：写死就意味着一套预设被固定成第三套规范
    expect(bodyOf(".wb-root, .wb-boot")).not.toMatch(/border-radius:\s*\d/);
    // 不支持 corner-shape 的环境下补偿必须为 0，半径与第一轮完全一致
    expect(decls.get("border-radius")).toContain("var(--wb-corner-extra, 0px)");
  });

  it("窗口外阴影交给原生 window_shadow，不在根容器上写会被裁剪的 box-shadow", () => {
    // Win32 区域裁剪按窗口矩形切掉圆角外的像素，CSS 外阴影无法在根容器上
    // 完整画出来；这里锁住 CSS 不越权，原生伴生阴影由 window_shadow.rs 负责。
    expect(bodyOf(".wb-root, .wb-boot")).not.toContain("box-shadow");
    expect(bodyOf(".wb-root, .wb-boot")).toContain("overflow: hidden");
  });

  it("连续圆角由能力检测开关控制，未支持时不启用 corner-shape", () => {
    const squircle = bodyOf(
      'html[data-window-corner="squircle"] .wb-root, html[data-window-corner="squircle"] .wb-boot',
    );
    expect(squircle).toContain("corner-shape: superellipse(2)");
    // 规则必须在 @supports 内：避免"检测通过但 CSS 引擎不支持"时残留半套曲线
    expect(stripComments(workbenchCss)).toContain("@supports (corner-shape: superellipse(2))");
    // 不能把 corner-shape 直接写进基础窗口框（那会在不支持的运行时丢掉整条声明以外的一切）
    expect(bodyOf(".wb-root, .wb-boot")).not.toContain("corner-shape");
  });

  it("html/body/#root 透明，圆角外侧不留直角方块", () => {
    const decls = declarations(bodyOf("html, body, #root"));
    expect(decls.get("background")).toBe("transparent");
    expect(declarations(bodyOf("body")).get("background")).toBeUndefined();
  });

  it("最大化时退成直角无边（与原生区域取直角同源）", () => {
    const decls = declarations(
      bodyOf('html[data-window-maximized="true"] .wb-root, html[data-window-maximized="true"] .wb-boot'),
    );
    expect(decls.get("border-radius")).toBe("0");
    expect(decls.get("border-width")).toBe("0");
  });
});

describe("windowCornerPlan", () => {
  it("CSS 参数 K 与数学指数 n 的映射是 n = 2^K（防再次混用）", () => {
    // Chromium 实测：superellipse(1)→n=2、2→n=4、3→n=8、4→n=16、8→n=64
    expect(CONTINUOUS_CORNER_CSS_K).toBe(2);
    expect(CONTINUOUS_CORNER_EXPONENT).toBe(2 ** CONTINUOUS_CORNER_CSS_K);
    expect(CONTINUOUS_CORNER_EXPONENT).toBe(4);
    expect(CONTINUOUS_CORNER_CSS_VALUE).toBe("superellipse(2)");
  });

  it("支持 corner-shape 时用超椭圆并补偿名义半径", () => {
    const plan = windowCornerPlan(18, true);
    expect(plan).toEqual({ radius: 22, cssK: 2, exponent: 4, extra: 4, squircle: true });
    expect(windowCornerPlan(20, true).radius).toBe(24);
  });

  it("不支持时指数回落 2、半径不动，与第一轮圆弧完全一致", () => {
    expect(windowCornerPlan(18, false)).toEqual({
      radius: 18,
      cssK: 1,
      exponent: 2,
      extra: 0,
      squircle: false,
    });
  });

  it("非法基础半径回落到默认预设值", () => {
    expect(windowCornerPlan(Number.NaN, false).radius).toBe(18);
    expect(windowCornerPlan(-3, false).radius).toBe(18);
  });
});

describe("readWindowRadiusCss", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("读取当前预设的 --radius-window", () => {
    document.documentElement.style.setProperty("--radius-window", "20px");
    expect(readWindowRadiusCss()).toBe(20);
  });

  it("缺省/非法值回落到默认预设半径", () => {
    expect(readWindowRadiusCss()).toBe(18);
    document.documentElement.style.setProperty("--radius-window", "nonsense");
    expect(readWindowRadiusCss()).toBe(18);
  });
});
