// @vitest-environment jsdom
//! 胶囊动作层导航契约（三层形态收敛 P0/P1，2026-11-14）。
//!
//! 锁定三件事：
//! 1. `openFullApp` 的改道分支不得谎报 switched——请求已发出 ≠ 主窗已切页，
//!    工作台导航的真实结果只能通过回执/toast 体现（P0-1）；
//! 2. `openPanelOrWorkbench` 分流：快捷页就地打开，完整功能页直达工作台
//!    （P0-2 / P1-3：不允许经旧完整面板交接页中转）；
//! 3. 动作级/对象级意图经协议下发：apps+objectId="add"、workbench+taskId
//!    （P1-1 / P1-2），不支持的动作值由工作台外壳明确拒绝。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchNavOutcome } from "../../lib/workbenchNav";

const openWorkbench = vi.fn();

vi.mock("../../lib/workbenchNav", () => ({
  openWorkbench: (...a: unknown[]) => openWorkbench(...a),
}));

// openFullApp 快捷页路径解除吸附时会 applyMode("full")：给真实回值，不碰 Tauri。
vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, applyMode: vi.fn(async () => true) };
});

import { useUiStore } from "../../store/useUiStore";
import {
  openAppsAdd,
  openFullApp,
  openPanelOrWorkbench,
  openWorkbenchTaskFocus,
} from "./actions";

function okOutcome(): WorkbenchNavOutcome {
  const outcome = {
    ok: true,
    pending: false,
    status: "succeeded",
    error: null,
    requestId: 1,
    created: false,
  } as unknown as WorkbenchNavOutcome;
  outcome.settled = Promise.resolve(outcome);
  return outcome;
}

beforeEach(() => {
  openWorkbench.mockReset();
  openWorkbench.mockResolvedValue(okOutcome());
  useUiStore.setState({ tab: "agents", pendingTab: null });
});

describe("openFullApp 改道语义（P0-1）", () => {
  it("非快捷页改道工作台时返回 workbench-rerouted，不谎报 switched", () => {
    const result = openFullApp("workflows");
    expect(result).toBe("workbench-rerouted");
    expect(openWorkbench).toHaveBeenCalledTimes(1);
    expect(openWorkbench).toHaveBeenCalledWith({ tab: "workflows", projectId: null });
  });

  it("快捷页走主窗事务：真实 switched 且不触发工作台导航", () => {
    const result = openFullApp("tasks");
    expect(result).toBe("switched");
    expect(useUiStore.getState().tab).toBe("tasks");
    expect(openWorkbench).not.toHaveBeenCalled();
  });
});

describe("openPanelOrWorkbench 分流（P0-2 / P1-3）", () => {
  it("快捷页转发留在主窗实时面板，不进工作台协议", () => {
    openPanelOrWorkbench("clipboard");
    expect(openWorkbench).not.toHaveBeenCalled();
    expect(useUiStore.getState().tab).toBe("clipboard");
  });

  it("完整功能页直达工作台对应路由（失败经统一 toast 通道）", () => {
    openPanelOrWorkbench("workflows");
    expect(openWorkbench).toHaveBeenCalledTimes(1);
    expect(openWorkbench).toHaveBeenCalledWith({ tab: "workflows", projectId: null });
  });
});

describe("动作级/对象级意图经协议下发（P1-1 / P1-2）", () => {
  it("openAppsAdd = apps 页 + objectId=add（工作台真实切换成功后才写添加意图）", async () => {
    void openAppsAdd();
    await vi.waitFor(() => expect(openWorkbench).toHaveBeenCalledTimes(1));
    expect(openWorkbench).toHaveBeenCalledWith({ tab: "apps", objectId: "add" });
  });

  it("openWorkbenchTaskFocus 携带 taskId 精确定位（不是页面级落点）", async () => {
    void openWorkbenchTaskFocus("t-9");
    await vi.waitFor(() => expect(openWorkbench).toHaveBeenCalledTimes(1));
    expect(openWorkbench).toHaveBeenCalledWith({ tab: "workbench", taskId: "t-9" });
  });
});
