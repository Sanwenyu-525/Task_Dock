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
import {
  WINDOW_METRICS,
  WINDOW_TIERS,
  shouldCollapseWorkbenchDetail,
  windowTier,
} from "./layoutMetrics";

function cssToken(css: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css);
  return match ? match[1].trim() : null;
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
