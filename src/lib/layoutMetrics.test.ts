//! 窗口尺寸规范守卫（2026-11-16）。
//!
//! 这类「同一组数字出现在 Rust / TS / CSS 三处」的规范，最容易在某次局部修改里
//! 悄悄漂移（例如有人只把 Rust 最小值改成 880，CSS 文档与前端档位仍写 960）。
//! 本测试把三处当成契约核对：任何一处单独改动都会失败，强制同步修改并更新文档。
//!
//! 只读文本，不依赖真实窗口——原生行为由真机验收覆盖（见 docs/ACCEPTANCE_ROUTING.md）。

import { describe, expect, it } from "vitest";
import appCss from "../styles.css?raw";
import rustSource from "../../src-tauri/src/window_layout.rs?raw";
import systemSource from "../../src-tauri/src/commands/system.rs?raw";
import tauriConfRaw from "../../src-tauri/tauri.conf.json?raw";
import workbenchCss from "../workbench/workbench.css?raw";
import projectPanelSource from "../workbench/ProjectWorkspacePanel.tsx?raw";
import buildStatusSource from "../workbench/WorkbenchBuildStatus.tsx?raw";
import buildRsSource from "../../src-tauri/build.rs?raw";
import globalSearchCss from "../components/global-search/global-search.css?raw";
import globalSearchDialogSource from "../components/global-search/GlobalSearchDialog.tsx?raw";
import {
  SEARCH_METRICS,
  ULTRA_NARROW_WIDTH,
  WINDOW_METRICS,
  WINDOW_TIERS,
  isUltraNarrow,
  shouldCollapseWorkbenchDetail,
  windowTier,
} from "./layoutMetrics";

function cssToken(css: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css);
  return match ? match[1].trim() : null;
}

/** 取某个顶层选择器的声明块（本文件的选择器均为单层，无嵌套规则）。 */
function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] ?? "";
}

function rustConst(source: string, name: string): number | null {
  const match = new RegExp(`pub const ${name}: f64 = ([0-9.]+);`).exec(source);
  return match ? Number(match[1]) : null;
}

describe("窗口尺寸规范三处一致", () => {
  it("CSS Token 与前端窗口规格一致", () => {
    const expected: Record<string, number> = {
      "--layout-window-default-w": WINDOW_METRICS.workbench.defaultWidth,
      "--layout-window-default-h": WINDOW_METRICS.workbench.defaultHeight,
      "--layout-window-min-w": WINDOW_METRICS.workbench.minWidth,
      "--layout-window-min-h": WINDOW_METRICS.workbench.minHeight,
      "--layout-window-floor-w": WINDOW_METRICS.workbench.floorWidth,
      "--layout-window-floor-h": WINDOW_METRICS.workbench.floorHeight,
    };
    for (const [token, value] of Object.entries(expected)) {
      expect(cssToken(appCss, token), `${token} 必须在 :root 声明`).toBe(`${value}px`);
    }
  });

  it("Rust 原生常量与前端窗口规格一致（DIP，不允许按 DPI 缩放常量）", () => {
    expect(rustConst(rustSource, "WORKBENCH_DEFAULT_WIDTH")).toBe(
      WINDOW_METRICS.workbench.defaultWidth,
    );
    expect(rustConst(rustSource, "WORKBENCH_DEFAULT_HEIGHT")).toBe(
      WINDOW_METRICS.workbench.defaultHeight,
    );
    expect(rustConst(rustSource, "WORKBENCH_MIN_WIDTH")).toBe(
      WINDOW_METRICS.workbench.minWidth,
    );
    expect(rustConst(rustSource, "WORKBENCH_MIN_HEIGHT")).toBe(
      WINDOW_METRICS.workbench.minHeight,
    );
    expect(rustConst(rustSource, "WORKBENCH_FLOOR_WIDTH")).toBe(
      WINDOW_METRICS.workbench.floorWidth,
    );
    expect(rustConst(rustSource, "WORKBENCH_FLOOR_HEIGHT")).toBe(
      WINDOW_METRICS.workbench.floorHeight,
    );
  });

  it("顶栏档位媒体查询与 WINDOW_TIERS 对齐", () => {
    // 每一档都必须真的存在对应媒体查询，否则「统一断点」只是文档口号。
    expect(workbenchCss).toContain(`@media (max-width: ${WINDOW_TIERS.compact - 1}px)`);
    expect(workbenchCss).toContain(`@media (max-width: ${WINDOW_TIERS.narrow - 1}px)`);
    expect(workbenchCss).toContain(`@media (max-width: ${WINDOW_TIERS.cramped - 1}px)`);
    // 超窄图标轨是 inclusive 上界（≤560），不是档位下界，查询口径不同（见常量注释）。
    expect(workbenchCss).toContain(`@media (max-width: ${ULTRA_NARROW_WIDTH}px)`);
    // 低优先级工具在窄档位收进「更多」，不能直接消失
    expect(workbenchCss).toMatch(
      new RegExp(
        `@media \\(max-width: ${WINDOW_TIERS.narrow - 1}px\\)[\\s\\S]*?\\.wb-toolbar-appearance\\s*{[^}]*display:\\s*none`,
      ),
    );
    expect(workbenchCss).toMatch(
      new RegExp(
        `@media \\(max-width: ${WINDOW_TIERS.narrow - 1}px\\)[\\s\\S]*?\\.wb-toolbar-more\\s*{[^}]*display:\\s*inline-flex`,
      ),
    );
  });
});

describe("主窗形态最小尺寸与启动配置同源", () => {
  // 主窗是最容易「改了一半」的地方：Rust 常量、mode_min_size、tauri.conf 的启动
  // minWidth/minHeight 三处必须同时改，否则从完整面板切极简会被启动值卡住。
  it("极简下限 264×112 在 Rust 常量、mode_min_size、tauri.conf 三处一致", () => {
    expect(rustConst(rustSource, "MAIN_MINIMAL_MIN_WIDTH")).toBe(264);
    expect(rustConst(rustSource, "MAIN_MINIMAL_MIN_HEIGHT")).toBe(112);
    expect(systemSource).toContain("crate::window_layout::MAIN_MINIMAL_MIN_WIDTH");
    expect(systemSource).toContain("crate::window_layout::MAIN_MINIMAL_MIN_HEIGHT");

    const conf = JSON.parse(tauriConfRaw) as {
      app: { windows: Array<{ label?: string; minWidth?: number; minHeight?: number }> };
    };
    const main = conf.app.windows.find((win) => win.label === "main") ?? conf.app.windows[0];
    expect(main?.minWidth, "tauri.conf 的启动最小宽度必须跟随极简下限").toBe(264);
    expect(main?.minHeight, "tauri.conf 的启动最小高度必须跟随极简下限").toBe(112);
  });

  it("完整/紧凑下限保持 340 档，且由 mode_min_size 引用", () => {
    expect(rustConst(rustSource, "MAIN_COMPACT_MIN_WIDTH")).toBe(340);
    expect(rustConst(rustSource, "MAIN_COMPACT_MIN_HEIGHT")).toBe(280);
    expect(rustConst(rustSource, "MAIN_FULL_MIN_WIDTH")).toBe(340);
    expect(rustConst(rustSource, "MAIN_FULL_MIN_HEIGHT")).toBe(340);
    expect(systemSource).toContain("crate::window_layout::MAIN_FULL_MIN_WIDTH");
    expect(systemSource).toContain("crate::window_layout::MAIN_COMPACT_MIN_WIDTH");
  });
});

describe("窗口档位判定", () => {
  it("按窗口 DIP 宽度分档（960 最小窗口落在 compact 档）", () => {
    expect(windowTier(1920)).toBe("full");
    expect(windowTier(1100)).toBe("full");
    expect(windowTier(1099)).toBe("compact");
    expect(windowTier(1200)).toBe("full");
    expect(windowTier(960)).toBe("compact");
    expect(windowTier(900)).toBe("compact");
    expect(windowTier(899)).toBe("narrow");
    expect(windowTier(780)).toBe("narrow");
    expect(windowTier(779)).toBe("cramped");
  });

  it("最小标准窗口 960 必须收起右栏，避免三栏重叠", () => {
    expect(shouldCollapseWorkbenchDetail(960)).toBe(true);
    expect(shouldCollapseWorkbenchDetail(1099)).toBe(true);
    expect(shouldCollapseWorkbenchDetail(1100)).toBe(false);
    expect(shouldCollapseWorkbenchDetail(1440)).toBe(false);
  });

  it("窗口变大后档位回到 full（常用操作恢复内联）", () => {
    expect(windowTier(1200)).toBe("full");
    expect(windowTier(1440)).toBe("full");
  });
});

describe("超窄图标轨兜底带（ULTRA_NARROW_WIDTH）", () => {
  it("边界判定：≤560 进入兜底带，561 不进入；仍归入 cramped 档", () => {
    expect(isUltraNarrow(560)).toBe(true);
    expect(isUltraNarrow(559)).toBe(true);
    expect(isUltraNarrow(561)).toBe(false);
    // 不新增第五档：图标轨是 cramped 档内的子带。
    expect(windowTier(560)).toBe("cramped");
    expect(windowTier(400)).toBe("cramped");
  });

  it("图标轨档位保留窗口控制与搜索入口，核心操作不被 display:none", () => {
    // 窗口控制绝对钉在右上，而不是被 flex 换行挤到左侧或隐藏。
    expect(workbenchCss).toMatch(
      new RegExp(
        `@media \\(max-width: ${ULTRA_NARROW_WIDTH}px\\)[\\s\\S]*?\\.wb-window-controls\\s*{[^}]*position:\\s*absolute`,
      ),
    );
    // 搜索收成 32px 图标，但字段容器本身保留（仍是可点入口）。
    expect(workbenchCss).toMatch(
      new RegExp(
        `@media \\(max-width: ${ULTRA_NARROW_WIDTH}px\\)[\\s\\S]*?\\.wb-search-field\\s*{[^}]*flex:\\s*0 0 32px`,
      ),
    );
  });
});

describe("工作空间项目页宽度契约（2026-11-17 P0 回归）", () => {
  // 事故根因：`.wb-project` 同时是 `container-type: inline-size` 的 `.ui-page-frame`，
  // 父级 `.wb-route` 是纵向 flex；只写 max-width + margin-inline:auto 时 auto margin
  // 取消 flex 拉伸，inline-size 容器按 0 固有宽度计算 → 页面只剩 padding 宽。
  // 契约：必须显式 width:100%，并且空态内容有自己的 560–680 阅读宽。
  const projectBlock = cssBlock(workbenchCss, ".wb-project");
  const emptyBlock = cssBlock(workbenchCss, ".wb-project-empty .wb-empty-state");

  it("项目页显式占满可用宽度，再按 1440 封顶", () => {
    expect(projectBlock).toMatch(/width:\s*100%/);
    expect(projectBlock).toMatch(/max-width:\s*1440px/);
    expect(projectBlock).toMatch(/margin-inline:\s*auto/);
    // width 必须先于 auto margin 生效；只有 auto margin 就是这次坍缩的触发器
    expect(projectBlock.indexOf("width: 100%")).toBeGreaterThan(-1);
    expect(projectBlock.indexOf("width: 100%")).toBeLessThan(
      projectBlock.indexOf("margin-inline"),
    );
  });

  it("通用 max-width:100% 护栏不得把 1440 阅读宽覆盖掉", () => {
    expect(workbenchCss).toMatch(
      /\.wb-route\s*>\s*\.wb-project\s*\{[^}]*max-width:\s*min\(1440px,\s*100%\)/,
    );
  });

  it("项目页确实使用 inline-size 容器，防守规则必须保留", () => {
    expect(projectPanelSource).toContain("wb-project wb-project-empty ui-page-frame");
    expect(projectPanelSource).toContain('className="wb-project ui-page-frame"');
  });

  it("空态内容在可用空间居中且有 560–680px 最大宽度", () => {
    expect(emptyBlock).toMatch(/width:\s*100%/);
    const maxWidth = /max-width:\s*([0-9]+)px/.exec(emptyBlock)?.[1];
    expect(Number(maxWidth)).toBeGreaterThanOrEqual(560);
    expect(Number(maxWidth)).toBeLessThanOrEqual(680);
    expect(emptyBlock).toMatch(/margin-inline:\s*auto/);
  });
});

describe("构建元数据来源契约（2026-11-17）", () => {
  it("短/完整 commit 都由 build.rs 在编译期注入", () => {
    expect(buildRsSource).toContain("cargo:rustc-env=TASK_DOCK_GIT_COMMIT=");
    expect(buildRsSource).toContain("cargo:rustc-env=TASK_DOCK_GIT_COMMIT_FULL=");
    expect(buildRsSource).toContain('["rev-parse", "HEAD"]');
  });

  it("状态栏运行期 Git 现场走独立 IPC，不在前端执行 rev-parse 冒充构建元数据", () => {
    expect(buildStatusSource).toContain("appRuntimeGitInfo");
    expect(buildStatusSource).toContain("workbench.buildSection.runtime");
    expect(buildStatusSource).not.toContain("rev-parse");
    expect(systemSource).toContain("pub fn app_runtime_git_info");
    expect(systemSource).toContain("option_env!(\"TASK_DOCK_GIT_COMMIT_FULL\")");
  });
});

describe("全局搜索几何同源", () => {
  it("CSS Token 与 SEARCH_METRICS 一致", () => {
    const expected: Record<string, number> = {
      "--layout-search-max": SEARCH_METRICS.fieldMax,
      "--layout-search-basis": SEARCH_METRICS.fieldBasis,
      "--layout-search-panel-max": SEARCH_METRICS.panelMax,
    };
    for (const [token, value] of Object.entries(expected)) {
      expect(cssToken(appCss, token), `${token} 必须在 :root 声明`).toBe(`${value}px`);
    }
  });

  it("顶栏字段用 Token 约束宽度，不再写死 520px", () => {
    // 基础块负责 max-width；容器查询里只覆盖 flex-basis，不应重复声明上限。
    const blocks = workbenchCss.match(/\.wb-search-field\s*\{[^}]*\}/g) ?? [];
    const base = blocks.find((block) => block.includes("max-width"));
    expect(base, "必须有声明 max-width 的基础块").toBeTruthy();
    expect(base).toContain("var(--layout-search-max");
    // 只约束搜索字段自身：520px 仍可能被其它容器查询阈值使用。
    for (const block of blocks) {
      expect(block).not.toContain("max-width: 520px");
    }
  });

  it("模态面板走 panelMax 上限；下拉面板与字段严格等宽（exact-match）", () => {
    expect(globalSearchCss).toContain("var(--layout-search-panel-max");
    // 560 只允许出现在高度上限（max-height），宽度上限必须走 Token
    expect(globalSearchCss).not.toMatch(/width:\s*min\(560px/);
    // 模态面板仍比字段宽（结果标题/分类按钮完整显示）；下拉形态的宽度
    // 改由 Popover exact-match 写入锚点宽（与顶栏搜索框左右缘对齐），
    // 面板自身只保留 --layout-search-min 兜底，不再自设目标宽度。
    expect(SEARCH_METRICS.panelMax).toBeGreaterThan(SEARCH_METRICS.fieldMax);
    expect(globalSearchDialogSource).toContain('widthMode="exact-match"');
    expect(globalSearchCss).toMatch(/\.gs-popover\s*\{[^}]*--layout-search-min/);
    expect(globalSearchCss).not.toMatch(/\.gs-popover\s*\{[^}]*width:\s*min\(/);
  });

  it("GlobalSearchDialog 的 maxWidth 使用共享常量", () => {
    expect(globalSearchDialogSource).toContain("maxWidth={SEARCH_METRICS.panelMax}");
    expect(globalSearchDialogSource).not.toContain("maxWidth={560}");
  });
});
