/**
 * @vitest-environment jsdom
 */
//! 完整模式左侧导航（v0.6）：
//! - 六个入口 + 底部「快速添加」始终存在，标签与图标语义正确；
//! - 点击切换 tab（保持 Ctrl+1…6 同一套 store）；
//! - 徽标直接复用任务统计 / 行动中心口径，不新造计数；
//! - 底部入口切到任务页并聚焦快速添加。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// 面板本身有独立测试，这里只验证导航结构，避免加载全部业务依赖
vi.mock("./tasks/TasksPanel", () => ({ default: () => <div>tasks-panel</div> }));
vi.mock("./agents/AgentPanel", () => ({ default: () => <div>agents-panel</div> }));
vi.mock("./actions/ActionCenterPanel", () => ({ default: () => <div>actions-panel</div> }));
vi.mock("./clipboard/ClipboardPanel", () => ({ default: () => <div>clipboard-panel</div> }));
vi.mock("./history/HistoryPanel", () => ({ default: () => <div>history-panel</div> }));
vi.mock("./settings/SettingsPanel", () => ({ default: () => <div>settings-panel</div> }));

import FullView from "./FullView";
import { useUiStore } from "../store/useUiStore";
import { useTasksStore } from "../store/useTasksStore";
import { useActionsStore } from "../store/useActionsStore";

function seedCounts() {
  useUiStore.setState({ tab: "tasks", quickAddToken: 0 });
  useTasksStore.setState({
    stats: { pending: 3, overdue: 1, due_today: 2, completed_today: 0, next_due_at: null },
  });
  useActionsStore.setState({
    feed: {
      enabled: true,
      generated_at: "2026-10-30T00:00:00Z",
      counts: { total: 2, intervention: 1, running: 1, reminder: 0 },
      items: [],
    } as never,
  });
}

beforeEach(seedCounts);
afterEach(cleanup);

describe("完整模式左侧导航", () => {
  /** 导航项的可访问名是「标签（徽标数）」，用正则匹配标签部分。 */
  const navItem = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });

  it("渲染六个导航入口与底部快捷入口", () => {
    render(<FullView />);
    const nav = screen.getByRole("navigation", { name: "主导航" });
    expect(nav).toBeTruthy();
    for (const label of ["任务", "Agent", "行动", "剪贴板", "历史", "设置"]) {
      expect(navItem(label)).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "快速添加任务" })).toBeTruthy();
    // 默认任务页
    expect(screen.getByText("tasks-panel")).toBeTruthy();
  });

  it("点击导航切换面板，并保留 aria-current 语义", async () => {
    const user = userEvent.setup();
    render(<FullView />);

    await user.click(navItem("历史"));
    expect(screen.getByText("history-panel")).toBeTruthy();
    expect(useUiStore.getState().tab).toBe("history");
    expect(navItem("历史").getAttribute("aria-current")).toBe("page");
    expect(navItem("任务").getAttribute("aria-current")).toBeNull();

    await user.click(navItem("设置"));
    expect(screen.getByText("settings-panel")).toBeTruthy();
  });

  it("剪贴板是第 4 个入口，点击后进入剪贴板页面", async () => {
    const user = userEvent.setup();
    render(<FullView />);

    await user.click(navItem("剪贴板"));
    expect(screen.getByText("clipboard-panel")).toBeTruthy();
    expect(useUiStore.getState().tab).toBe("clipboard");
    expect(navItem("剪贴板").getAttribute("aria-current")).toBe("page");
  });

  it("徽标复用任务统计与行动中心计数", () => {
    render(<FullView />);
    // 任务 3、Agent 需介入 1、行动总数 2
    const badges = [...document.querySelectorAll(".rail-badge")].map((b) => b.textContent);
    expect(badges).toContain("3");
    expect(badges).toContain("1");
    expect(badges).toContain("2");
  });

  it("底部快速添加入口：切回任务页并触发聚焦信号", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ tab: "settings" });
    render(<FullView />);

    const before = useUiStore.getState().quickAddToken;
    await user.click(screen.getByRole("button", { name: "快速添加任务" }));
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useUiStore.getState().quickAddToken).toBe(before + 1);
  });

  it("行动中心关闭时不显示行动徽标（与行动中心口径一致）", () => {
    useActionsStore.setState({
      feed: {
        enabled: false,
        generated_at: "2026-10-30T00:00:00Z",
        counts: { total: 9, intervention: 9, running: 0, reminder: 0 },
        items: [],
      } as never,
    });
    render(<FullView />);
    const badges = [...document.querySelectorAll(".rail-badge")].map((b) => b.textContent);
    // 行动中心关闭：intervention 与 attention 都归零，只剩任务徽标
    expect(badges).toEqual(["3"]);
  });
});
