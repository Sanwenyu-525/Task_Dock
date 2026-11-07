//! 入口 CSS 作用域守卫（2026-11-06 · edge-tab-round2；2026-11-07 round3 补分组选择器）。
//!
//! 六个入口共享同一份打包 CSS（`cssCodeSplit: false`），**任何无作用域的
//! html / body / #root 布局规则都会同时作用到主窗**。历史故障：tab-hint 页的
//! `#root{position:absolute;display:flex}` 把主窗 `.dock-window` 压成 0 宽，
//! 右/上/下停靠的标签被排到窗口之外（真机证据见
//! `tmp/acceptance/edge-tab-visual-cursor-round2/report.md`）。
//!
//! 这里做**结构级**断言（解析选择器与声明，而不是对源码做字符串匹配）：
//! 裸根选择器（html / body / #root / *）不允许声明改变布局模型的属性。
//! 打包产物另由 `scripts/check-entry-css.mjs` 在 dist 上复查（npm run build 后）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENTRY_CSS_FILES,
  findUnscopedRootLayoutRules,
  isBareRootSelector,
  parseCssRules,
  splitSelectorList,
} from "../scripts/entryCssScope.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function readEntry(name: string): string {
  return readFileSync(repoRoot + name, "utf8");
}

describe("入口 CSS 作用域（共享打包 CSS）", () => {
  it("所有入口的裸根选择器都不得声明布局模型属性", () => {
    const violations: string[] = [];
    for (const file of ENTRY_CSS_FILES) {
      const rules = parseCssRules(readEntry(file));
      for (const v of findUnscopedRootLayoutRules(rules, file)) {
        violations.push(
          `${v.file} → «${v.selector}» 声明了 ${v.props.join(", ")}` +
            (v.atPath.length ? `（位于 ${v.atPath.join(" > ")} 内）` : ""),
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("tab-hint 的页面级规则全部挂在 .tab-hint-page 作用域下", () => {
    const css = readEntry("src/tab-hint/styles-tab-hint.css");
    const rules = parseCssRules(css);
    const offenders = rules
      .map((r) => r.selector)
      .filter(
        (sel) =>
          /(^|[>\s,+~])(html|body|#root|\*)($|[\s.:,[>+~])/.test(sel) &&
          !sel.includes("tab-hint-page"),
      );
    expect(offenders).toEqual([]);
  });

  it("tab-hint 存在页面根作用域规则（气泡定位依赖它）", () => {
    const css = readEntry("src/tab-hint/styles-tab-hint.css");
    expect(css).toMatch(/html\.tab-hint-page\s+#root\s*\{/);
  });

  it("解析器能识别典型违规（守卫自身的最小自检）", () => {
    const bad = parseCssRules("#root { position: absolute; display: flex; color: red; }");
    expect(findUnscopedRootLayoutRules(bad).map((v) => v.props)).toEqual([
      ["position:absolute", "display:flex"],
    ]);
    // 有类作用域的不算裸根
    const scoped = parseCssRules("html.tab-hint-page #root { position: absolute; }");
    expect(findUnscopedRootLayoutRules(scoped)).toEqual([]);
  });
});

describe("裸根判定与选择器列表拆分", () => {
  it("逗号列表按顶层逗号拆分，括号内逗号不拆", () => {
    expect(splitSelectorList("html, body, #root")).toEqual(["html", "body", "#root"]);
    expect(splitSelectorList(":is(.clipboard-page, .clipboard-drawer) .clip-item")).toEqual([
      ":is(.clipboard-page, .clipboard-drawer) .clip-item",
    ]);
    expect(splitSelectorList("html,\nbody")).toEqual(["html", "body"]);
  });

  it("裸根：单个 html / body / :root / #root / *（含伪类）", () => {
    for (const sel of ["html", "body", "html::before", "body:hover", "#root", "*", ":root", "HTML"]) {
      expect(isBareRootSelector(sel), sel).toBe(true);
    }
    for (const sel of [
      "html.tab-hint-page",
      "html[data-theme=\"dark\"]",
      "body .app",
      "html body",
      ".tab-hint-page #root",
      ":is(.a, .b) .clip-item",
    ]) {
      expect(isBareRootSelector(sel), sel).toBe(false);
    }
  });

  it("分组内的每个选择器单独判定，不因同组有作用域选择器而放行", () => {
    const rules = parseCssRules(
      "html, .tab-hint-page #root { display: flex; position: absolute; }",
    );
    const found = findUnscopedRootLayoutRules(rules);
    expect(found).toHaveLength(1);
    expect(found[0].selector).toBe("html");
    expect(found[0].props).toEqual(["display:flex", "position:absolute"]);
    expect(found[0].list).toBe("html, .tab-hint-page #root");
  });

  it("html, body, #root 分组整体命中（每个选择器一条）", () => {
    const rules = parseCssRules("html, body, #root { display: flex; }");
    expect(findUnscopedRootLayoutRules(rules).map((v) => v.selector)).toEqual([
      "html",
      "body",
      "#root",
    ]);
  });

  it(":is(html, body) 等价于分组列表，同样命中", () => {
    const rules = parseCssRules(":is(html, body) { display: flex; }");
    expect(findUnscopedRootLayoutRules(rules).map((v) => v.selector)).toEqual([
      ":is(html, body)",
    ]);
  });

  it("合法规则不误报：裸根只声明非布局属性 / 作用域内声明布局属性", () => {
    const rules = parseCssRules(`
      html, body, #root { height: 100%; overflow: hidden; background: transparent; }
      html.tab-hint-page #root { position: absolute; inset: 0; display: flex; }
      .capsule-tab { position: absolute; display: flex; }
    `);
    expect(findUnscopedRootLayoutRules(rules)).toEqual([]);
  });

  it("嵌套 @layer / @media 内的违规同样被识别（atPath 保留）", () => {
    const rules = parseCssRules(`
      @layer base {
        @media (max-width: 600px) {
          html, body { display: flex; }
        }
      }
    `);
    const found = findUnscopedRootLayoutRules(rules);
    expect(found.map((v) => v.selector)).toEqual(["html", "body"]);
    expect(found[0].atPath).toEqual(["@layer base", "@media (max-width: 600px)"]);
  });

  it("压缩后的 CSS 仍能正确解析并命中", () => {
    const cases = [
      ["html,body,#root{display:flex}", ["html", "body", "#root"]],
      ["html{position:absolute;inset:0}", ["html"]],
      ["@media (max-width:600px){body{display:grid}}", ["body"]],
      ["@layer x{html,body{position:fixed}}", ["html", "body"]],
    ] as const;
    for (const [css, expected] of cases) {
      expect(
        findUnscopedRootLayoutRules(parseCssRules(css)).map((v) => v.selector),
        css,
      ).toEqual([...expected]);
    }
  });
});
