//! 页面适配层归位守卫（2026-11-21）。
//!
//! 背景：FeatureRegistry 的动态页面 chunk 会把页面 CSS 后插入 head 尾部，
//! 同特异性下「晚插入者生效」。styles-pages.css 是入口静态导入，它对
//! 动态页面选择器（.workspace-split / .tasks-panel / .settings-panel …）
//! 写的同属性规则全部是死规则——2026-11-20 的分栏卡面、任务页统计卡
//! 次级面、设置页标题字号都因此从未真正生效。
//!
//! 本测试锁住归位后的契约：
//! - 动态页面的**最终视觉**写在页面自己的 CSS（顺序确定，见各文件头注）；
//! - styles-pages.css 只承载对**静态层**（styles.css / themes / ui /
//!   components / workbench.css）的适配——未分层规则压过 @layer，顺序稳定。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import pagesCss from "./styles-pages.css?raw";
import splitCss from "./workbench/workspaceSplit.css?raw";
import tasksWorkspaceCss from "./components/tasks/tasks-workspace.css?raw";
import tasksLayoutCss from "./components/tasks/tasks-layout.css?raw";
import settingsPageCss from "./components/settings/settings-page.css?raw";

const repo = process.cwd();
const read = (path: string): string => readFileSync(join(repo, path), "utf8");
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取样式表里精确匹配某个选择器的规则体（同 WorkspaceSplit.test 的惯例）。 */
function ruleBody(css: string, selector: string): string {
  const src = stripComments(css);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = src.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  expect(m, `缺少规则：${selector}`).not.toBeNull();
  return m![1];
}

describe("styles-pages.css 只承载静态层适配", () => {
  it("保留三条静态层适配：极窄候选行 / 确认弹窗危险按钮 / Agent 关注态", () => {
    expect(pagesCss).toContain(".wb-pick-list .wb-row");
    expect(pagesCss).toContain(".ui-dialog .btn.danger");
    expect(pagesCss).toContain(".tree-agent.attention-waiting .tree-agent-row");
  });

  it("不再包含动态页面选择器（防止死规则回归）", () => {
    const src = stripComments(pagesCss);
    for (const selector of [
      ".workspace-split",
      ".workspace-split__sidebar",
      ".tasks-panel",
      ".settings-panel",
      ".preset-card",
      ".overview-card",
    ]) {
      expect(src, `适配层不应再写 ${selector}（目标在动态页面 CSS）`).not.toContain(selector);
    }
  });
});

describe("WorkspaceSplit 卡面归位（workspaceSplit.css）", () => {
  it("分栏卡面：边框/圆角/白面写在分栏自己的 CSS，取值 v1.0 语义", () => {
    const body = ruleBody(splitCss, ".workspace-split");
    expect(body).toContain("border: 1px solid var(--color-border-default)");
    expect(body).toContain("border-radius: var(--radius-card)");
    expect(body).toContain("background: var(--color-bg-surface)");
  });

  it("侧栏背景是 bg-sidebar 平色，不再使用旧渐变（v1.0 §10）", () => {
    const body = ruleBody(splitCss, ".workspace-split__sidebar");
    expect(body).toContain("background: var(--color-bg-sidebar)");
    expect(body).toContain("border-right: 1px solid var(--color-border-default)");
    expect(stripComments(splitCss).split(".workspace-split__sidebar")[0]).not.toBe("");
    // 渐变背景只允许出现在预设预览等适配场景，分栏侧栏不再有。
    const sidebarRule = body;
    expect(sidebarRule).not.toMatch(/linear-gradient/);
  });

  it("窄容器侧栏底部分隔线与右边界同用中性边框", () => {
    const block = splitCss.slice(splitCss.indexOf("@container workspace-split (max-width: 559px)"));
    expect(block).toContain("border-bottom: 1px solid var(--color-border-default)");
    expect(block).not.toContain("var(--border-subtle)");
  });
});

describe("任务页卡面归位", () => {
  it("tasks-workspace.css 持有整列卡面伪元素与列表卡面", () => {
    expect(tasksWorkspaceCss).toContain(".tasks-panel.tasks-workspace-layout::before");
    const before = ruleBody(tasksWorkspaceCss, ".tasks-panel.tasks-workspace-layout::before");
    expect(before).toContain("background: var(--color-bg-surface)");
    expect(before).toContain("border: 1px solid var(--color-border-default)");

    const list = ruleBody(tasksWorkspaceCss, ".tasks-panel.tasks-workspace-layout > .task-list");
    expect(list).toContain("border: 1px solid var(--color-border-default)");
    expect(list).toContain("background: var(--color-bg-surface)");
  });

  it("tasks-layout.css 统计卡是次级面（避免卡中卡同白底）", () => {
    const card = ruleBody(
      tasksLayoutCss,
      ".tasks-panel .tasks-overview--stats .overview-card",
    );
    expect(card).toContain("background: var(--color-bg-surface-secondary)");
    expect(card).toContain("border: 1px solid var(--color-border-default)");
  });
});

describe("设置页卡面归位（settings-page.css）", () => {
  it("导航栏与页面卡片面在同文件维护，取值 v1.0 语义", () => {
    const nav = ruleBody(settingsPageCss, ".settings-panel .settings-nav");
    expect(nav).toContain("padding: 10px");
    expect(nav).toContain("border: 1px solid var(--color-border-default)");
    expect(nav).toContain("background: var(--color-bg-surface)");

    const body = ruleBody(settingsPageCss, ".settings-panel .settings-page-body");
    expect(body).toContain("padding: 16px 18px");
    expect(body).toContain("background: var(--color-bg-surface)");
  });

  it("预设预览走语义面（暗色不再固定白纸色），归位到设置页 CSS", () => {
    const preview = ruleBody(settingsPageCss, ".settings-panel .preset-card .preset-preview");
    expect(preview).toContain("background: var(--color-bg-surface-secondary)");
    const ppCard = ruleBody(settingsPageCss, ".settings-panel .preset-card .pp-card");
    expect(ppCard).toContain("background: var(--color-bg-surface)");
    expect(ppCard).not.toMatch(/#fff|#ffffff/);
  });

  it("主窗/工作台入口仍加载 styles-pages（静态层适配的唯一入口）", () => {
    const main = read("src/main.tsx");
    const workspace = read("src/workspace/workspaceEntry.tsx");
    expect(main).toContain("styles-pages.css");
    expect(workspace).toContain("styles-pages.css");
    // 适配层必须晚于静态层：components 之后。
    expect(main.indexOf("styles-components.css")).toBeLessThan(main.indexOf("styles-pages.css"));
  });
});
