/**
 * @vitest-environment jsdom
 */
//! 左侧导航契约测试（脚本侧清单 ↔ 真实导航）：
//! - scripts/rail-contract.mjs 供 Playwright 脚本使用（脚本无法导入 TS 模块），
//!   此处校验它与 `TAB_ORDER`（10 个逻辑 Tab）、`RAIL_ENTRIES`（16 个声明视觉入口，
//!   其中 14 个默认可见）及 FullView 实际渲染的入口顺序 / aria-label / data-tip 一致；
//! - v0.8 起收集箱+暂存架合并为「收集与暂存」单一视觉入口：inbox / shelf 两个
//!   逻辑 Tab 都让该入口呈选中态；快捷键仍按 TAB_ORDER 映射（Ctrl+5/6）不偏移；
//! - v0.9 新增「工作流」视觉入口（Ctrl+7），第 10 个逻辑 Tab（设置）= Ctrl+0；
//! - v0.10 新增「应用」视觉入口：仅视觉入口、**不占 Ctrl+数字**（`RAIL_ONLY_TABS`）；
//! - v0.11 注册「帮助」视觉入口（规划中心之后、设置之前，不占 Ctrl+数字），新配置默认隐藏；
//! - v0.14 注册「诊断中心」视觉入口（帮助之后、设置之前，不占 Ctrl+数字），默认隐藏；
//! - v0.14 注册「资源管理」视觉入口（设置之前、默认可见、可隐藏/排序，不占 Ctrl+数字）；
//! - v0.17 注册「手机互传」视觉入口（剪贴板之后、收集与暂存之前，不占 Ctrl+数字）；
//! - 2026-11 注册「工作台」视觉入口（最前、开发模式主要入口，不占 Ctrl+数字，默认可见）；
//! - 同时校验导航顶部「新建任务」按钮（`.rail-new-task`）的类名与可访问名；
//! - 导航增删、换序、改名时本测试失败，防止脚本侧过期断言再次出现。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// 与 FullView.test.tsx 保持一致：只验证导航结构，不加载面板业务依赖。
vi.mock("./workbench/DevWorkbenchPanel", () => ({ default: () => <div>workbench-panel</div> }));
vi.mock("./workspace/WorkspaceProjectsPanel", () => ({ default: () => <div>workspace-panel</div> }));
vi.mock("./tasks/TasksPanel", () => ({ default: () => <div>tasks-panel</div> }));
vi.mock("./agents/AgentPanel", () => ({ default: () => <div>agents-panel</div> }));
vi.mock("./apps/AppsPanel", () => ({ default: () => <div>apps-panel</div> }));
vi.mock("./widgets/WidgetsPanel", () => ({ default: () => <div>widgets-panel</div> }));
vi.mock("./actions/ActionCenterPanel", () => ({ default: () => <div>actions-panel</div> }));
vi.mock("./clipboard/ClipboardPanel", () => ({ default: () => <div>clipboard-panel</div> }));
vi.mock("./collection/CollectionPanel", () => ({ default: () => <div>collection-panel</div> }));
vi.mock("./workflows/WorkflowsPanel", () => ({ default: () => <div>workflows-panel</div> }));
vi.mock("./history/HistoryPanel", () => ({ default: () => <div>history-panel</div> }));
vi.mock("./roadmap/FeatureRoadmapPanel", () => ({ default: () => <div>roadmap-panel</div> }));
vi.mock("./help/HelpCenterPanel", () => ({ default: () => <div>help-panel</div> }));
vi.mock("./settings/SettingsPanel", () => ({ default: () => <div>settings-panel</div> }));

import FullView from "./FullView";
import { RAIL_ORDER, TAB_ORDER, type Tab } from "../store/useUiStore";
import {
  LOGICAL_TABS,
  RAIL_ADD_BUTTON,
  RAIL_ENTRIES,
  RAIL_ITEM_COUNT,
  RAIL_LABELS,
  RAIL_ONLY_TABS,
} from "../../scripts/rail-contract.mjs";

beforeEach(() => {
  // 稳定徽标：不注入 store 计数，全部按 0 断言基础可访问名
});

afterEach(cleanup);

describe("脚本侧导航契约与真实导航一致", () => {
  it("默认可见视觉入口 14 项；逻辑 Tab 10 项且与 TAB_ORDER 完全一致", () => {
    expect(RAIL_ITEM_COUNT).toBe(15);
    expect([...LOGICAL_TABS]).toEqual([...TAB_ORDER]);
    // 合并入口覆盖 inbox+shelf，其余 1:1；「工作台」「应用」「微件」「帮助」「诊断中心」「资源管理」是仅视觉入口
    const covered = RAIL_ENTRIES.flatMap((e) => (e.tabs ?? [e.id]));
    expect([...covered].sort()).toEqual([...TAB_ORDER, ...RAIL_ONLY_TABS].sort());
    expect(RAIL_ENTRIES.find((e) => e.id === "collection")?.tabs).toEqual(["inbox", "shelf"]);
    // 视觉顺序：工作台在最前（不占 Ctrl+数字）；应用位于 Agent 之后、行动之前；微件紧随应用之后；
    // 帮助 → 诊断中心 → 资源管理 → 设置 依次相邻
    const visual = RAIL_ENTRIES.map((e) => e.id);
    expect(visual[0]).toBe("workbench");
    expect(visual.indexOf("apps")).toBe(visual.indexOf("agents") + 1);
    expect(visual.indexOf("actions")).toBe(visual.indexOf("apps") + 2);
    expect(visual.indexOf("mobile")).toBe(visual.indexOf("clipboard") + 1);
    expect(visual.indexOf("diagnostics")).toBe(visual.indexOf("help") + 1);
    expect(visual.indexOf("resource")).toBe(visual.indexOf("diagnostics") + 1);
    expect(visual.indexOf("settings")).toBe(visual.indexOf("resource") + 1);
    expect([...RAIL_ORDER]).toEqual([...RAIL_ENTRIES.flatMap((e) => e.tabs ?? [e.id])]);
  });

  it("快捷键按 TAB_ORDER 顺序映射，不因视觉合并 / 仅视觉入口偏移", () => {
    const shortcutsPerLogicalTab = [
      "Ctrl+1",
      "Ctrl+2",
      "Ctrl+3",
      "Ctrl+4",
      "Ctrl+5",
      "Ctrl+6",
      "Ctrl+7",
      "Ctrl+8",
      "Ctrl+9",
      "Ctrl+0",
    ];
    expect([...TAB_ORDER]).toEqual([...LOGICAL_TABS]);
    // 既有快捷键语义不变：Ctrl+3 仍是行动，应用不占数字键
    expect(TAB_ORDER[2]).toBe("actions");
    expect(shortcutsPerLogicalTab[2]).toBe("Ctrl+3");
    expect(RAIL_ENTRIES.find((e) => e.id === "apps")?.shortcut).toBe("");
    // 合并入口声明覆盖 Ctrl+5 与 Ctrl+6 两个逻辑位
    const collection = RAIL_ENTRIES.find((e) => e.id === "collection");
    expect(collection?.shortcut).toBe("Ctrl+5 / Ctrl+6");
    expect(shortcutsPerLogicalTab[TAB_ORDER.indexOf("inbox")]).toBe("Ctrl+5");
    expect(shortcutsPerLogicalTab[TAB_ORDER.indexOf("shelf")]).toBe("Ctrl+6");
    // 其余视觉入口快捷键与逻辑位一致
    for (const e of RAIL_ENTRIES) {
      if (e.id === "collection" || (RAIL_ONLY_TABS as readonly string[]).includes(e.id)) continue;
      expect(e.shortcut, `${e.label} 快捷键`).toBe(
        shortcutsPerLogicalTab[TAB_ORDER.indexOf(e.id as Tab)],
      );
    }
  });

  it("FullView 默认隐藏帮助与诊断中心入口，其他入口顺序和可访问名与契约一致", () => {
    render(<FullView />);
    // 设置固定在底部区域（不在滚动列表内），仍属于视觉入口契约的一部分
    const items = [
      ...document.querySelectorAll(".rail-items .rail-item, .rail-foot > .rail-item"),
    ];
    // RAIL_LABELS 只含默认可见入口（帮助与诊断中心默认隐藏在「更多」菜单里）。
    const visibleLabels = RAIL_LABELS;
    expect(items).toHaveLength(RAIL_ITEM_COUNT);
    expect(items.map((el) => el.getAttribute("data-tip"))).toEqual(visibleLabels);
    items.forEach((el, i) => {
      const label = visibleLabels[i];
      const aria = (el.getAttribute("aria-label") ?? "").trim();
      const tip = (el.getAttribute("data-tip") ?? "").trim();
      expect(aria.startsWith(label), `第 ${i + 1} 个入口 aria-label 应以「${label}」开头`).toBe(true);
      expect(tip.startsWith(label), `第 ${i + 1} 个入口 data-tip 应以「${label}」开头`).toBe(true);
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
