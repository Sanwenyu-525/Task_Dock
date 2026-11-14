//! P0-02 / P0-A 主窗口跨窗口导航事务测试（2026-11-13）。
//!
//! 这些断言覆盖「事件送达 ≠ 用户看到开发工作台」的全部分支：
//! 胶囊停靠必须先退出、紧凑/极简必须先回完整模式、草稿拦截要 pending 且
//! 用户确认/取消必须有最终结果、保存中要失败、导航未生效要报错、任何一步失败
//! 都要回滚开发项目上下文、并发请求要串行且旧的 pending 不能覆盖新请求。
//! 原生窗口几何/区域仍由 Windows 真机验收，单测只证明事务编排与门禁行为。

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const win = vi.hoisted(() => ({
  unminimize: vi.fn(async () => {}),
  show: vi.fn(async () => {}),
  isVisible: vi.fn(async () => true),
  setFocus: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

const bridge = vi.hoisted(() => ({
  applyMode: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({})),
  applyWindowMaterial: vi.fn(async () => {}),
  applyWindowRadius: vi.fn(async () => {}),
  updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({ ...patch })),
}));

// useSettingsStore 与主窗口导航共用同一个 bridge 模块：这里给出它们真正 import
// 的导出，避免「模块缺少导出」在 jsdom 里变成加载期错误。
vi.mock("./bridge", () => bridge);

import {
  __resetMainWindowNavigationForTests,
  openDevWorkbenchInMainWindow,
  type MainWindowNavigationOutcome,
} from "./mainWindowNavigation";
import { registerTabGuard } from "./tabGuard";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { useUiStore } from "../store/useUiStore";

const originalSetTab = useUiStore.getState().setTab;

/** 只保留本测试关心的字段：settings.mode + workbench_current_project。 */
function setSettings(mode: string, devProject = "dev-old") {
  useSettingsStore.setState({
    settings: { mode, workbench_current_project: devProject } as never,
  });
}

let unregisterGuard: (() => void) | null = null;
function guard(flags: { dirty?: boolean; busy?: boolean }) {
  const state = { dirty: flags.dirty ?? false, busy: flags.busy ?? false };
  unregisterGuard = registerTabGuard({
    id: `test-guard-${Math.random()}`,
    label: () => "任务编辑器",
    isDirty: () => state.dirty,
    isBusy: () => state.busy,
    discard: () => {
      state.dirty = false;
    },
  });
  return state;
}

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const req = (requestId: number, devProjectId: string) => ({ requestId, devProjectId });

beforeEach(() => {
  vi.clearAllMocks();
  __resetMainWindowNavigationForTests();
  win.isVisible.mockResolvedValue(true);
  bridge.applyMode.mockResolvedValue(undefined);
  bridge.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => ({
    ...((useSettingsStore.getState().settings ?? {}) as unknown as Record<string, unknown>),
    ...patch,
  }));
  useEdgeSnapStore.setState({ phase: "free", undock: null, dockedEdge: null });
  useUiStore.setState({ tab: "tasks", setTab: originalSetTab, pendingTab: null });
  setSettings("full");
});

afterEach(() => {
  unregisterGuard?.();
  unregisterGuard = null;
});

describe("openDevWorkbenchInMainWindow", () => {
  it("自由窗口 + 完整模式：提交上下文、切页并聚焦", async () => {
    const outcome = await openDevWorkbenchInMainWindow(req(1, "dev-1"));
    expect(outcome.status).toBe("succeeded");
    expect(outcome.ok).toBe(true);
    expect(outcome.steps).toContain("context-committed");
    expect(outcome.steps).toContain("tab-switched");
    expect(useUiStore.getState().tab).toBe("workbench");
    expect(useSettingsStore.getState().settings?.workbench_current_project).toBe("dev-1");
    expect(win.setFocus).toHaveBeenCalled();
    expect(bridge.applyMode).not.toHaveBeenCalled();
  });

  it("胶囊停靠：先走既有 undock 状态机，再切页", async () => {
    const undock = vi.fn(async () => true);
    useEdgeSnapStore.setState({ phase: "docked-hidden", undock });
    setSettings("compact");

    const outcome = await openDevWorkbenchInMainWindow(req(2, "dev-1"));
    expect(undock).toHaveBeenCalledWith("full");
    expect(outcome.steps).toEqual(
      expect.arrayContaining(["undock", "mode-full", "tab-switched", "focused"]),
    );
    expect(bridge.applyMode).toHaveBeenCalledWith("full");
    expect(outcome.ok).toBe(true);
  });

  it("undock 返回 false：失败且不提交开发项目上下文", async () => {
    useEdgeSnapStore.setState({ phase: "docked-revealed", undock: vi.fn(async () => false) });
    const outcome = await openDevWorkbenchInMainWindow(req(3, "dev-1"));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("退出胶囊模式失败");
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(bridge.updateSettings).not.toHaveBeenCalled();
  });

  it("undock 抛错：带原因失败", async () => {
    useEdgeSnapStore.setState({
      phase: "docked-hidden",
      undock: vi.fn(async () => {
        throw new Error("原生区域写入失败");
      }),
    });
    const outcome = await openDevWorkbenchInMainWindow(req(4, "dev-1"));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("原生区域写入失败");
  });

  it("贴边相位但引擎未注入 undock：明确失败而不是静默切标签", async () => {
    useEdgeSnapStore.setState({ phase: "docked-hidden", undock: null });
    const outcome = await openDevWorkbenchInMainWindow(req(5, "dev-1"));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("窗口引擎未就绪");
  });

  it("applyMode 失败：报错、不切页、不写上下文", async () => {
    bridge.applyMode.mockRejectedValueOnce(new Error("模式切换失败"));
    setSettings("minimal");
    const outcome = await openDevWorkbenchInMainWindow(req(6, "dev-1"));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("模式切换失败");
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(bridge.updateSettings).not.toHaveBeenCalled();
  });

  it("写入上下文失败：不切页并返回真实原因", async () => {
    bridge.updateSettings.mockRejectedValueOnce(new Error("设置写入超时"));
    const outcome = await openDevWorkbenchInMainWindow(req(7, "dev-1"));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("设置写入超时");
    expect(useUiStore.getState().tab).toBe("tasks");
  });

  it("保存中：直接失败，不提交上下文", async () => {
    guard({ busy: true });
    const outcome = await openDevWorkbenchInMainWindow(req(8, "dev-1"));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("正在保存");
    expect(bridge.updateSettings).not.toHaveBeenCalled();
  });

  it("未保存草稿：pending 且完全不写上下文（不依赖回滚）", async () => {
    guard({ dirty: true });
    const outcome = await openDevWorkbenchInMainWindow(req(9, "dev-1"));
    expect(outcome.status).toBe("pending");
    expect(outcome.pending).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.steps).toContain("tab-pending");
    expect(outcome.steps).not.toContain("context-committed");
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(bridge.updateSettings).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().settings?.workbench_current_project).toBe("dev-old");
  });

  it("用户确认草稿切换：提交上下文、切页并回最终 succeeded", async () => {
    guard({ dirty: true });
    const settled: MainWindowNavigationOutcome[] = [];
    const first = await openDevWorkbenchInMainWindow(req(10, "dev-1"), {
      onSettled: (o) => settled.push(o),
    });
    expect(first.status).toBe("pending");

    useUiStore.getState().confirmPendingTab();
    await flush();

    expect(useUiStore.getState().tab).toBe("workbench");
    expect(useSettingsStore.getState().settings?.workbench_current_project).toBe("dev-1");
    expect(settled).toHaveLength(1);
    expect(settled[0].status).toBe("succeeded");
  });

  it("用户取消草稿切换：回 cancelled 且上下文保持旧值", async () => {
    guard({ dirty: true });
    const settled: MainWindowNavigationOutcome[] = [];
    await openDevWorkbenchInMainWindow(req(11, "dev-1"), {
      onSettled: (o) => settled.push(o),
    });
    useUiStore.getState().cancelPendingTab();
    await flush();

    expect(settled).toHaveLength(1);
    expect(settled[0].status).toBe("cancelled");
    expect(settled[0].ok).toBe(false);
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(useSettingsStore.getState().settings?.workbench_current_project).toBe("dev-old");
  });

  it("确认后的最终结果只回一次（重复确认不重复回执）", async () => {
    guard({ dirty: true });
    const settled: MainWindowNavigationOutcome[] = [];
    await openDevWorkbenchInMainWindow(req(12, "dev-1"), {
      onSettled: (o) => settled.push(o),
    });
    useUiStore.getState().confirmPendingTab();
    useUiStore.getState().confirmPendingTab();
    await flush();
    expect(settled).toHaveLength(1);
  });

  it("并发请求串行执行：最后一次请求的目标最终生效", async () => {
    const a = openDevWorkbenchInMainWindow(req(13, "dev-A"));
    const b = openDevWorkbenchInMainWindow(req(14, "dev-B"));
    const [oa, ob] = await Promise.all([a, b]);
    expect(oa.status).toBe("succeeded");
    expect(ob.status).toBe("succeeded");
    expect(useUiStore.getState().tab).toBe("workbench");
    expect(useSettingsStore.getState().settings?.workbench_current_project).toBe("dev-B");
  });

  it("新请求取代仍 pending 的旧请求：旧事务回 cancelled，不被新结果覆盖", async () => {
    guard({ dirty: true });
    const settledFirst: MainWindowNavigationOutcome[] = [];
    const first = await openDevWorkbenchInMainWindow(req(15, "dev-A"), {
      onSettled: (o) => settledFirst.push(o),
    });
    expect(first.status).toBe("pending");

    const second = openDevWorkbenchInMainWindow(req(16, "dev-B"));
    await flush();
    expect(settledFirst).toHaveLength(1);
    expect(settledFirst[0].status).toBe("cancelled");

    const outcomeSecond = await second;
    expect(outcomeSecond.status).toBe("pending");
    // 第二次请求自己又挂起（草稿仍在），旧请求没有把新请求取消。
    expect(useUiStore.getState().pendingTab).not.toBeNull();
  });

  it("setTab 声称成功但标签没变：按真实状态判失败并回滚", async () => {
    useUiStore.setState({ setTab: (() => "switched") as never });
    const outcome = await openDevWorkbenchInMainWindow(req(17, "dev-1"));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("页面切换未生效");
    expect(outcome.steps).toContain("rollback");
    expect(useSettingsStore.getState().settings?.workbench_current_project).toBe("dev-old");
  });

  it("预检有草稿但门禁已放行（草稿刚保存）：提交上下文后成功", async () => {
    guard({ dirty: true });
    // 模拟「预检之后、setTab 之前草稿被保存」：门禁直接放行并切页。
    useUiStore.setState({
      setTab: ((t: string) => {
        useUiStore.setState({ tab: t as never });
        return "switched" as const;
      }) as never,
    });
    const outcome = await openDevWorkbenchInMainWindow(req(20, "dev-1"));
    expect(outcome.status).toBe("succeeded");
    expect(outcome.steps).toContain("context-committed");
    expect(useSettingsStore.getState().settings?.workbench_current_project).toBe("dev-1");
  });

  it("聚焦失败不否定已完成的导航（记录 focus-failed）", async () => {
    win.setFocus.mockRejectedValueOnce(new Error("前台锁拒绝"));
    const outcome = await openDevWorkbenchInMainWindow(req(18, "dev-1"));
    expect(outcome.status).toBe("succeeded");
    expect(outcome.steps).toContain("focus-failed");
  });

  it("窗口唤醒失败（最小化/隐藏）仍能继续完成导航", async () => {
    win.unminimize.mockRejectedValueOnce(new Error("窗口不可用"));
    const outcome = await openDevWorkbenchInMainWindow(req(19, "dev-1"));
    expect(outcome.steps).toContain("window-awake-failed");
    expect(outcome.status).toBe("succeeded");
  });
});
