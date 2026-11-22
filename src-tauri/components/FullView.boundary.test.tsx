/**
 * @vitest-environment jsdom
 */
//! 完整面板内容区错误边界（任务 B 回归）：
//! - 单个页面渲染崩溃只替换内容区：左侧导航（`.rail`）与标题栏外层仍可用；
//! - 切换页面（resetKey 变化）自动恢复，不残留上一页错误；
//! - 用户点「重试」在组件恢复后能重新渲染；
//! - 错误提示定位到具体页面，不泄露原始异常文本。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const crash = vi.hoisted(() => ({ tasks: true }));

vi.mock("../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bridge")>();
  return {
    ...actual,
    getSettings: async () => ({ theme: "light", mode: "full", material: "solid" }),
    updateSettings: async (patch: Record<string, unknown>) => ({
      theme: "light",
      mode: "full",
      material: "solid",
      ...patch,
    }),
    applyMode: async () => undefined,
    applyWindowMaterial: async () => ({ applied: false, effect: "none", os_version: "" }),
    applyWindowRadius: async () => true,
  };
});

vi.mock("./tasks/TasksPanel", () => ({
  default: () => {
    if (crash.tasks) throw new Error("tasks panel boom");
    return <div>tasks-panel</div>;
  },
}));
vi.mock("./agents/AgentPanel", () => ({ default: () => <div>agents-panel</div> }));
vi.mock("./apps/AppsPanel", () => ({ default: () => <div>apps-panel</div> }));
vi.mock("./widgets/WidgetsPanel", () => ({ default: () => <div>widgets-panel</div> }));
vi.mock("./actions/ActionCenterPanel", () => ({ default: () => <div>actions-panel</div> }));
vi.mock("./clipboard/ClipboardPanel", () => ({ default: () => <div>clipboard-panel</div> }));
vi.mock("./collection/CollectionPanel", () => ({ default: () => <div>collection-panel</div> }));
vi.mock("./workflows/WorkflowsPanel", () => ({ default: () => <div>workflows-panel</div> }));
vi.mock("./history/HistoryPanel", () => ({ default: () => <div>history-panel</div> }));
vi.mock("./roadmap/PlanningCenterPanel", () => ({ default: () => <div>roadmap-panel</div> }));
vi.mock("./settings/SettingsPanel", () => ({ default: () => <div>settings-panel</div> }));

import FullView from "./FullView";
import { useSettingsStore } from "../store/useSettingsStore";
import { useUiStore } from "../store/useUiStore";
import { useTasksStore } from "../store/useTasksStore";
import { useActionsStore } from "../store/useActionsStore";
import { useCaptureStore } from "../store/useCaptureStore";
import { defaultNavigationLayout } from "../lib/navVisibility";

const BASE = {
  theme: "light",
  mode: "full",
  material: "solid",
  visual_preset: "frosted",
  snap_enabled: false,
  snap_display_mode: "capsule",
  actions_enabled: true,
  navigation_layout: defaultNavigationLayout(),
};

beforeEach(() => {
  crash.tasks = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  useSettingsStore.setState({ settings: BASE as never, materialInfo: null });
  useUiStore.setState({ tab: "tasks", collectionSub: "inbox" });
  useTasksStore.setState({ stats: null } as never);
  useActionsStore.setState({ feed: null } as never);
  useCaptureStore.setState({ inboxCount: 0 } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FullView 内容区错误边界", () => {
  it("页面崩溃只替换内容区：左侧导航保留、错误定位到页面、不泄露原始文本", () => {
    render(<FullView />);

    const rail = document.querySelector(".rail");
    expect(rail, "左侧导航必须仍然存在").toBeTruthy();
    expect(rail?.querySelectorAll(".rail-item").length ?? 0).toBeGreaterThan(5);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("「任务」暂时无法显示");
    expect(alert.textContent).toContain("切换到其它页面");
    expect(alert.textContent).not.toContain("tasks panel boom");
    // 内容区之外的结构（.full-view/.tab-content）仍在
    expect(document.querySelector(".full-view")).toBeTruthy();
    expect(document.querySelector(".tab-content")).toBeTruthy();
  });

  it("切换页面自动恢复，不残留上一页错误；导航仍可继续使用", async () => {
    render(<FullView />);
    expect(screen.getByRole("alert")).toBeTruthy();

    // 切到设置页：resetKey 变化 → 清除错误并渲染新页面
    const settingsEntry = document.querySelector(
      '.rail-item[aria-label="设置"]',
    ) as HTMLButtonElement | null;
    expect(settingsEntry, "设置入口必须仍可点击").toBeTruthy();
    await act(async () => {
      fireEvent.click(settingsEntry!);
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("settings-panel")).toBeTruthy();
    expect(useUiStore.getState().tab).toBe("settings");
  });

  it("点「重试」在组件恢复后重新渲染，不重载窗口、不清空数据", async () => {
    render(<FullView />);
    expect(screen.getByRole("alert")).toBeTruthy();

    crash.tasks = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("tasks-panel")).toBeTruthy();
    // 设置对象未被清空
    expect(useSettingsStore.getState().settings).toBeTruthy();
  });
});
