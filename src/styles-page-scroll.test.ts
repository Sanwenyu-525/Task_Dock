//! 页面滚动骨架契约（2026-11-09）：
//! 一级页面改为「页头固定 + 列表/内容区独立滚动」后，防止后续样式调整
//! 悄悄退回整页滚动（搜索框、筛选条又被列表带走）。
import { describe, expect, it } from "vitest";
import themesCss from "./styles-themes.css?raw";

const css = themesCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取某个选择器（按逗号拆分后完全匹配）的规则体；同选择器出现多次时合并。 */
function ruleBodies(selector: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(selector)) out.push(m[2]);
  }
  return out;
}

function mergedRule(selector: string): string {
  return ruleBodies(selector).join("\n");
}

/** 从 `@media (...)` 起始位置取配平后的整块内容（含嵌套规则）。 */
function mediaBlock(prefix: string): string {
  const start = css.indexOf(prefix);
  if (start < 0) return "";
  let depth = 0;
  let seen = false;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === "{") {
      depth += 1;
      seen = true;
    } else if (css[i] === "}") {
      depth -= 1;
      if (seen && depth === 0) return css.slice(start, i + 1);
    }
  }
  return "";
}

describe("页面滚动骨架", () => {
  it("内容区是纵向 flex 容器，已迁移页面不再整页滚动", () => {
    expect(mergedRule(".tab-content")).toMatch(/display:\s*flex/);
    expect(mergedRule(".tab-content")).toMatch(/flex-direction:\s*column/);
    for (const tab of [
      "tasks",
      "agents",
      "apps",
      "widgets",
      "actions",
      "inbox",
      "shelf",
      "workflows",
      "history",
      "roadmap",
      "help",
      "diagnostics",
      "resource",
      "settings",
    ]) {
      expect(
        mergedRule(`.tab-content-${tab}`),
        `.tab-content-${tab} 必须隐藏外层滚动（交给页内列表）`,
      ).toMatch(/overflow:\s*hidden/);
    }
  });

  it("page-fill 填满剩余高度，page-scroll 承担列表滚动", () => {
    const fill = mergedRule(".page-fill");
    expect(fill).toMatch(/flex:\s*1 1 auto/);
    expect(fill).toMatch(/min-height:\s*0/);
    expect(fill).toMatch(/display:\s*flex/);

    const scroll = mergedRule(".page-fill > .page-scroll");
    expect(scroll).toMatch(/flex:\s*1 1 auto/);
    expect(scroll).toMatch(/min-height:\s*0/);
    expect(scroll).toMatch(/overflow-y:\s*auto/);
  });

  it("滚动容器内的子项不被压缩（否则列表滚不动、折叠分组被压扁）", () => {
    expect(mergedRule(".page-scroll > *")).toMatch(/flex-shrink:\s*0/);
  });

  it("极矮窗口回退整页滚动，避免固定页头吃掉全部高度", () => {
    const media = mediaBlock("@media (max-height: 380px)");
    expect(media).toBeTruthy();
    expect(media).toMatch(/overflow-y:\s*auto/);
    expect(media).toMatch(/\.page-fill\s*\{[^}]*flex:\s*0 0 auto/);
    expect(media).toMatch(/\.page-fill\s*>\s*\.page-scroll\s*\{[^}]*overflow-y:\s*visible/);
  });

  it("历史日期吸顶标签在页内滚动容器中不再保留 -10px 补偿", () => {
    expect(mergedRule(".history-timeline .history-day-label")).toMatch(/top:\s*0/);
  });
});
