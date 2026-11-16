//! 全局 2D 体系守卫（2026-11-16 · round-2）。
//!
//! `styles-themes.test.ts` 覆盖旧主题 Token 的结构；这里专门锁住第二轮的
//! **语义层叠与实际选择器**：
//! - 主窗/工作台/捕获/通知入口都确实加载 `styles-flat.css`；
//! - 圆角、窗口描边、窗口外部阴影是三个可独立控制的语义 Token；
//! - 窗口外围阴影由原生 `window_shadow` 承担，CSS 不再被迫在会被裁剪的
//!   `.wb-root` / `.dock-window` 上伪造外阴影；
//! - `styles-themes.css` 里点名的旧材质组件不再直接写内高光/内阴影；
//! - 通知、捕获、文件工作区的第二轮表面改造不会被后续换肤悄悄绕开。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import flatCss from "./styles-flat.css?raw";
import themesCss from "./styles-themes.css?raw";
import appCss from "./styles.css?raw";
import workbenchCss from "./workbench/workbench.css?raw";
import captureCss from "./capture/styles-capture.css?raw";
import notificationCss from "./notifications/styles-notifications.css?raw";
import filesCss from "./components/files/files.css?raw";
import tasksWorkspaceCss from "./components/tasks/tasks-workspace.css?raw";

const repo = process.cwd();
const read = (path: string): string => readFileSync(join(repo, path), "utf8");
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 扁平规则表：选择器归一空白，声明体原样保留（用于组件级断言）。 */
function bodiesOf(css: string, selector: string): string[] {
  const out: string[] = [];
  const clean = stripComments(css);
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]
      .split(",")
      .map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(selector)) out.push(m[2]);
  }
  return out;
}

const singleBody = (css: string, selector: string): string => bodiesOf(css, selector).join(";");

describe("入口加载顺序", () => {
  it("主窗/工作台/捕获/通知入口都加载 styles-flat，且位于模块样式之前", () => {
    const main = read("src/main.tsx");
    const workspace = read("src/workspace/main.tsx");
    const capture = read("src/capture/main.tsx");
    const notification = read("src/notifications/main.tsx");

    for (const [name, source] of [
      ["main", main],
      ["workspace", workspace],
      ["capture", capture],
      ["notification", notification],
    ] as const) {
      expect(source, `${name} 未加载 styles-flat.css`).toContain("styles-flat.css");
    }

    // 主窗顺序必须保持：主题 → flat → 组件层。flat 在组件层之前才能作为基础。
    expect(main.indexOf("styles.css")).toBeLessThan(main.indexOf("styles-themes.css"));
    expect(main.indexOf("styles-themes.css")).toBeLessThan(main.indexOf("styles-flat.css"));
    expect(main.indexOf("styles-flat.css")).toBeLessThan(main.indexOf("styles-ui.css"));
    expect(workspace.indexOf("styles-flat.css")).toBeLessThan(workspace.indexOf("workbench/workbench.css"));
    expect(notification.lastIndexOf("styles-notifications.css")).toBeGreaterThan(
      notification.indexOf("styles-flat.css"),
    );
  });
});

describe("Token 与层叠", () => {
  it("flat 层排在主题层和组件层之后", () => {
    expect(stripComments(flatCss)).toMatch(/@layer\s+base,\s*theme,\s*ui,\s*menu,\s*flat/);
  });

  it("圆角、描边、窗口外阴影是独立语义 Token", () => {
    for (const token of [
      "--radius-xs:",
      "--radius-sm:",
      "--radius-md:",
      "--radius-lg:",
      "--radius-xl:",
      "--radius-2xl:",
      "--radius-window:",
      "--radius-capture:",
    ]) {
      expect(flatCss, `缺少圆角 Token ${token}`).toContain(token);
    }
    expect(flatCss).toContain("--window-edge: 0 0 0 1px var(--window-border)");
    expect(flatCss).toContain("--window-shadow: 0 16px 44px -18px");
    expect(flatCss).toContain("--window-shadow: 0 20px 56px -20px");
    expect(flatCss).toContain("--window-shadow-maximized: none");
  });

  it("窗口描边 Token 不再混入 inset 阴影", () => {
    for (const line of stripComments(flatCss)
      .split("\n")
      .filter((l) => l.includes("--window-edge"))) {
      expect(line).not.toContain("inset");
    }
  });
});

describe("旧材质组件的实际选择器", () => {
  const directThreeD = [
    [".preset-preview", themesCss],
    [".pp-card", themesCss],
    [".capsule-panel", themesCss],
    [".snap-feedback", themesCss],
    [".clip-kind", themesCss],
    [".history-kind", themesCss],
    [".action-kind", themesCss],
  ] as const;

  it("styles-themes.css 中点名的组件不再直接写 inset 高光/内侧厚度", () => {
    for (const [selector, css] of directThreeD) {
      for (const body of bodiesOf(css, selector)) {
        expect(body, `${selector} 仍有直接 inset`).not.toMatch(/\binset\b/);
      }
    }
  });

  it("主窗玻璃材质不再直接写顶部内高光", () => {
    for (const body of bodiesOf(appCss, ".dock-window.material-glass")) {
      expect(body).not.toMatch(/\binset\b/);
    }
  });

  it("开关滑块与胶囊搜索不再使用直接内阴影", () => {
    const ui = read("src/styles-ui.css");
    const thumb = singleBody(ui, ".ui-switch-thumb");
    expect(thumb).not.toMatch(/\binset\b/);
    const capsuleSearch = singleBody(ui, ".ui-search.ui-search--capsule");
    expect(capsuleSearch).not.toMatch(/\binset\b/);
  });

  it("胶囊入口与工具分段不再用顶部内高光伪造凸起", () => {
    for (const selector of [
      ".snap-capsule",
      ".snap-capsule:hover",
      ".cap-btn:hover",
      ".cap-btn.is-active",
      ".cap-seg",
      '.cap-seg-btn[aria-selected="true"]',
    ]) {
      for (const body of bodiesOf(appCss, selector)) {
        expect(body, `${selector} 仍有内高光/内阴影`).not.toMatch(/\binset\b/);
      }
    }
    expect(singleBody(appCss, ".snap-capsule:hover")).not.toContain("filter: brightness");
  });

  it("空状态插画已改为平面语义表面，不再有高光球体/气泡/云影", () => {
    const orb = singleBody(themesCss, ".empty-orb");
    expect(orb).toContain("background: var(--surface-raised)");
    expect(orb).toContain("border: 1px solid var(--border-subtle)");
    expect(orb).toContain("box-shadow: none");
    expect(orb).not.toMatch(/radial-gradient|linear-gradient|\binset\b/);
    for (const selector of [".empty-bubble", ".empty-spark", ".empty-cloud"]) {
      expect(singleBody(themesCss, selector)).toContain("display: none");
    }
    expect(singleBody(themesCss, ':root[data-theme="dark"] .empty-orb')).not.toMatch(
      /radial-gradient|linear-gradient|\binset\b/,
    );
  });
});

describe("窗口外围阴影", () => {
  it("工作台不在会被原生区域裁剪的根容器上伪造 box-shadow", () => {
    expect(singleBody(workbenchCss, ".wb-root, .wb-boot")).not.toContain("box-shadow");
    expect(workbenchCss).toContain("--wb-corner-extra");
  });

  it("原生窗口阴影实现存在，且工作台/主窗/右键菜单/微件已挂接", () => {
    const shadow = read("src-tauri/src/window_shadow.rs");
    expect(shadow).toContain("pub fn attach");
    expect(shadow).toContain("MARGIN_CSS");
    expect(shadow).toContain("AMBIENT_BLUR_CSS");
    expect(shadow).toContain("UpdateLayeredWindow");

    const workspace = read("src-tauri/src/project_workspace_window.rs");
    expect(workspace).toContain("window_shadow::attach");
    expect(workspace).toContain(".shadow(false)");

    const lib = read("src-tauri/src/lib.rs");
    expect(lib).toContain("window_shadow::attach");
  });

  it("捕获/极简标签窗口先设置原生圆角区域，再挂伴生阴影", () => {
    const capture = read("src-tauri/src/quick_capture/mod.rs");
    expect(capture).toContain("window_shape::apply_with_radius");
    expect(capture).toContain("window_shadow::attach");
    expect(capture).toContain("CAPTURE_RADIUS");

    const hint = read("src-tauri/src/tab_hint.rs");
    expect(hint).toContain("window_shape::apply_with_radius");
    expect(hint).toContain("window_shadow::attach");
  });

  it("捕获卡片与原生半径一致，且不写会被窗口矩形裁剪的外阴影", () => {
    const card = singleBody(captureCss, ".capture-card");
    expect(card).toContain("border-radius: var(--radius-capture, 16px)");
    expect(card).toContain("box-shadow: var(--window-edge)");
    expect(card).not.toContain("--window-shadow");
  });
});

describe("窄窗任务页回退", () => {
  it("任务工作区启用容器查询，400px 主窗不会留下 122px 任务列", () => {
    const panel = singleBody(tasksWorkspaceCss, ".tasks-panel.tasks-workspace-layout");
    expect(panel).toContain("container-type: inline-size");
    expect(tasksWorkspaceCss).toContain("@container (max-width: 520px)");
    expect(tasksWorkspaceCss).toContain("@media (max-width: 640px)");
    expect(tasksWorkspaceCss).toContain("grid-template-columns: minmax(0, 1fr)");
  });
});

describe("通知与文件工作区", () => {
  it("通知卡片使用统一 2D 表面，不再铺径向光斑或浅色独立玻璃", () => {
    const card = singleBody(notificationCss, ".ntf-card");
    expect(card).toContain("background: var(--surface-overlay)");
    expect(card).toContain("border: 1px solid var(--border-subtle)");
    expect(card).toContain("box-shadow: var(--elev-3)");
    expect(card).not.toMatch(/radial-gradient|linear-gradient/);
    expect(notificationCss).not.toContain('html[data-theme="light"] .ntf-card');
  });

  it("文件工作区不再建立第二套基础表面/边框 Token", () => {
    const root = singleBody(filesCss, ".fw-root");
    expect(root).toContain("--fw-surface-base: var(--surface-base)");
    expect(root).toContain("--fw-border-subtle: var(--border-subtle)");
    expect(root).not.toMatch(/--fw-surface-base:\s*#/);
    expect(root).not.toMatch(/--surface-base:\s*var\(--fw/);
  });

  it("按压反馈用颜色而不是缩放位移", () => {
    expect(singleBody(notificationCss, ".ntf-cta:active")).not.toContain("transform");
    expect(singleBody(captureCss, ".capture-submit:active:not(:disabled)")).not.toContain(
      "transform",
    );
  });
});
