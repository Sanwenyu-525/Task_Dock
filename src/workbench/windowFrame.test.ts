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
import { readWindowRadiusCss } from "./windowFrame";

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
    expect(decls.get("border-radius")).toBe("var(--radius-window)");
    expect(decls.get("border")).toBe("1px solid var(--window-border)");
    expect(decls.get("overflow")).toBe("hidden");
    expect(decls.get("box-sizing")).toBe("border-box");
    // 不写死半径：写死就意味着一套预设被固定成第三套规范
    expect(bodyOf(".wb-root, .wb-boot")).not.toMatch(/border-radius:\s*\d/);
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
