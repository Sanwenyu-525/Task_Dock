//! 窗口入口样式契约守卫（2026-11-21）。
//!
//! Design System v1.0 之后每个 Tauri WebView 入口各自组装 CSS 层。缺一层
//! 不会在构建期报错，只会让该窗口的 Token 取值与主窗分叉（例如微件窗口
//! 曾缺 styles-tokens.css，旧语义名的取值停留在 flat 层旧值）。本测试把
//! 六个入口的加载矩阵与顺序锁死；新增窗口时在此登记。
//!
//! 矩阵（✓ = 必须 import）：
//! | 入口           | base | themes | flat | tokens | ui | components | pages | 专用样式 |
//! | 主窗           |  ✓   |   ✓    |  ✓   |   ✓    | ✓  |     ✓      |   ✓   | workbench/global-search/resource |
//! | 工作台         |  ✓   |   ✓    |  ✓   |   ✓    | ✓  |     ✓      |   ✓   | workspace/workbench/global-search/resource |
//! | 捕获           |  –   |   ✓    |  ✓   |   ✓    | ✓  |     –      |   –   | styles-capture |
//! | 通知           |  –   |   ✓    |  ✓   |   ✓    | ✓  |     –      |   –   | styles-notifications |
//! | 投屏工具栏     |  –   |   ✓    |  ✓   |   ✓    | ✓  |     –      |   –   | projection-controls |
//! | 桌面微件       |  –   |   ✓    |  ✓   |   ✓    | ✓  |     –      |   –   | widgets + widgets-desktop |
//!
//! 小窗口不加载 base/components/pages 是有意保留：透明 WebView 只要 Token
//! 与控件基元，不需要页面骨架；专用样式自带所需视觉。主题与颜色语义
//! （themes × flat × tokens 三层）必须全窗口一致。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = process.cwd();
const read = (path: string): string => readFileSync(join(repo, path), "utf8");

interface EntrySpec {
  name: string;
  file: string;
  required: string[];
  /** 顺序约束：前者必须早于后者出现（indexOf）。 */
  order: Array<[string, string]>;
}

const ENTRIES: EntrySpec[] = [
  {
    name: "主窗口",
    file: "src/main.tsx",
    required: [
      "styles.css",
      "styles-themes.css",
      "styles-flat.css",
      "styles-tokens.css",
      "styles-ui.css",
      "styles-components.css",
      "styles-pages.css",
    ],
    order: [
      ["styles.css", "styles-themes.css"],
      ["styles-themes.css", "styles-flat.css"],
      ["styles-flat.css", "styles-tokens.css"],
      ["styles-tokens.css", "styles-ui.css"],
      ["styles-components.css", "styles-pages.css"],
    ],
  },
  {
    name: "统一工作台",
    file: "src/workspace/workspaceEntry.tsx",
    required: [
      "styles.css",
      "styles-themes.css",
      "styles-flat.css",
      "styles-tokens.css",
      "styles-ui.css",
      "styles-components.css",
      "styles-pages.css",
    ],
    order: [
      ["styles.css", "styles-themes.css"],
      ["styles-themes.css", "styles-flat.css"],
      ["styles-flat.css", "styles-tokens.css"],
      ["styles-tokens.css", "styles-ui.css"],
      ["styles-components.css", "styles-pages.css"],
    ],
  },
  {
    name: "快速捕获",
    file: "src/capture/main.tsx",
    required: ["styles-themes.css", "styles-flat.css", "styles-tokens.css", "styles-ui.css", "styles-capture.css"],
    order: [
      ["styles-themes.css", "styles-flat.css"],
      ["styles-flat.css", "styles-tokens.css"],
      ["styles-tokens.css", "styles-ui.css"],
    ],
  },
  {
    name: "通知",
    file: "src/notifications/main.tsx",
    required: [
      "styles-themes.css",
      "styles-flat.css",
      "styles-tokens.css",
      "styles-ui.css",
      "styles-notifications.css",
    ],
    order: [
      ["styles-themes.css", "styles-flat.css"],
      ["styles-flat.css", "styles-tokens.css"],
      ["styles-tokens.css", "styles-ui.css"],
    ],
  },
  {
    name: "投屏工具栏",
    file: "src/toolbar/main.tsx",
    required: [
      "styles-themes.css",
      "styles-flat.css",
      "styles-tokens.css",
      "styles-ui.css",
      "projection-controls.css",
    ],
    order: [
      ["styles-themes.css", "styles-flat.css"],
      ["styles-flat.css", "styles-tokens.css"],
      ["styles-tokens.css", "styles-ui.css"],
    ],
  },
  {
    name: "桌面微件",
    file: "src/widgets/main.tsx",
    required: [
      "styles-themes.css",
      "styles-flat.css",
      "styles-tokens.css",
      "styles-ui.css",
      "widgets-desktop.css",
    ],
    order: [
      ["styles-themes.css", "styles-flat.css"],
      ["styles-flat.css", "styles-tokens.css"],
      ["styles-tokens.css", "styles-ui.css"],
    ],
  },
];

describe("窗口入口样式契约", () => {
  for (const entry of ENTRIES) {
    it(`${entry.name}（${entry.file}）加载完整 Token 层且顺序正确`, () => {
      const source = read(entry.file);
      for (const css of entry.required) {
        expect(source, `${entry.name} 未加载 ${css}`).toContain(css);
      }
      for (const [before, after] of entry.order) {
        expect(
          source.indexOf(before),
          `${entry.name}：${before} 必须先于 ${after} 加载`,
        ).toBeGreaterThanOrEqual(0);
        expect(source.indexOf(before)).toBeLessThan(source.indexOf(after));
      }
    });
  }
});
