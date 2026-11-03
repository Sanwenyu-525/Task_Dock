/**
 * @vitest-environment jsdom
 */
//! 左侧导航契约测试（脚本侧清单 ↔ 真实导航）：
//! - scripts/rail-contract.mjs 供 Playwright 脚本使用（脚本无法导入 TS 模块），
//!   此处校验它与 `TAB_ORDER`、FullView 实际渲染的入口顺序 / aria-label / data-tip 一致；
//! - 同时校验导航顶部「新建任务」按钮（`.rail-new-task`）的类名与可访问名；
//! - 导航增删、换序、改名时本测试失败，防止脚本侧 RAIL_ITEM_COUNT=7 一类的过期断言再次出现。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// 与 FullView.test.tsx 保持一致：只验证导航结构，不加载面板业务依赖。
vi.mock("./tasks/TasksPanel", () => ({ default: () => <div>tasks-panel</div> }));
vi.mock("./agents/AgentPanel", () => ({ default: () => <div>agents-panel</div> }));
vi.mock("./actions/ActionCenterPanel", () => ({ default: () => <div>actions-panel</div> }));
vi.mock("./clipboard/ClipboardPanel", () => ({ default: () => <div>clipboard-panel</div> }));
vi.mock("./inbox/CaptureInboxPanel", () => ({ default: () => <div>inbox-panel</div> }));
vi.mock("./shelf/ShelfPanel", () => ({ default: () => <div>shelf-panel</div> }));
vi.mock("./history/HistoryPanel", () => ({ default: () => <div>history-panel</div> }));
vi.mock("./roadmap/FeatureRoadmapPanel", () => ({ default: () => <div>roadmap-panel</div> }));
vi.mock("./settings/SettingsPanel", () => ({ default: () => <div>settings-panel</div> }));

import FullView from "./FullView";
import { TAB_ORDER } from "../store/useUiStore";
import {
  RAIL_ADD_BUTTON,
  RAIL_ENTRIES,
  RAIL_ITEM_COUNT,
  RAIL_LABELS,
} from "../../scripts/rail-contract.mjs";

afterEach(cleanup);

describe("脚本侧导航契约与真实导航一致", () => {
  it("九入口 id 顺序与 TAB_ORDER 完全一致", () => {
    expect(RAIL_ITEM_COUNT).toBe(9);
    expect(RAIL_ENTRIES.map((e) => e.id)).toEqual([...TAB_ORDER]);
  });

  it("快捷键按顺序对应 Ctrl+1…9", () => {
    expect(RAIL_ENTRIES.map((e) => e.shortcut)).toEqual([
      "Ctrl+1",
      "Ctrl+2",
      "Ctrl+3",
      "Ctrl+4",
      "Ctrl+5",
      "Ctrl+6",
      "Ctrl+7",
      "Ctrl+8",
      "Ctrl+9",
    ]);
  });

  it("FullView 渲染的入口顺序、data-tip、aria-label 与契约一致", () => {
    render(<FullView />);
    const items = [...document.querySelectorAll(".rail-items .rail-item")];
    expect(items).toHaveLength(RAIL_ITEM_COUNT);
    expect(items.map((el) => el.getAttribute("data-tip"))).toEqual([...RAIL_LABELS]);
    items.forEach((el, i) => {
      const label = RAIL_LABELS[i];
      const aria = (el.getAttribute("aria-label") ?? "").trim();
      const tip = (el.getAttribute("data-tip") ?? "").trim();
      expect(aria.startsWith(label), `第 ${i + 1} 个入口 aria-label 应以「${label}」开头`).toBe(true);
      expect(tip, `第 ${i + 1} 个入口 data-tip 应为「${label}」`).toBe(label);
    });
  });

  it("导航顶部新建任务按钮存在且可访问名符合契约", () => {
    render(<FullView />);
    const add = document.querySelector(RAIL_ADD_BUTTON.selector);
    expect(add, `未找到新建任务按钮 ${RAIL_ADD_BUTTON.selector}`).toBeTruthy();
    expect(add?.getAttribute("aria-label")).toBe(RAIL_ADD_BUTTON.ariaLabel);
    expect(add?.getAttribute("data-tip")).toBe(RAIL_ADD_BUTTON.tip);
  });
});
