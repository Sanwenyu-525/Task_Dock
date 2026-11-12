/**
 * @vitest-environment jsdom
 */
//! DevWorkbenchPanel 交互测试：围绕 P0 闭环的核心断言——
//! 1. 未设置当前任务：空态 + 最近待办一键「设为当前」（显式设置，不自动推断）；
//! 2. 已设置当前任务：task_context 聚合渲染任务/关联会话/现场，「继续工作」触发真实恢复；
//! 3. 任务已删除：读侧校验展示失效态，不静默清空、不伪造任务；
//! 4. Agent 摘要与需要处理列表来自既有 snapshot / actions feed；
//! 5. 需要处理条目点击 → actions_open_session 定位会话。
//!
//! bridge mock：按需覆盖命令与事件订阅（importOriginal 保留类型与纯函数）；
//! store 用真实实例（与 TasksPanel.test 同一惯例）。fixtures 在 vi.hoisted 中
//! （vi.mock 工厂会被提升到模块顶部执行）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { useSettingsStore } from "../../store/useSettingsStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { useUiStore } from "../../store/useUiStore";
import { useLocaleStore } from "../../i18n";
import DevWorkbenchPanel from "./DevWorkbenchPanel";
import type { Task, TaskContext } from "../../lib/bridge";

const { FIX_TASK, FIX_CTX, FIX_RUNS, FIX_ACTIONS, FIX_REMINDERS } = vi.hoisted(() => {
  const FIX_TASK: Task = {
    id: "a",
    title: "重构剪贴板模块",
    description: "",
    priority: 1,
    status: "pending",
    category: "dev",
    tags: [],
    due_at: null,
    remind_at: null,
    advance_minutes: 0,
    recurrence: null,
    created_at: "2026-11-12T00:00:00Z",
    updated_at: "2026-11-12T00:00:00Z",
    completed_at: null,
    linked_agents: 1,
  };
  const FIX_CTX: TaskContext = {
    task: FIX_TASK,
    agents: [
      {
        link_id: "l1",
        source_id: "codex",
        source_name: "Codex",
        session_external_id: "sess-1",
        title: "重构剪贴板模块 · 会话",
        state: "running",
        last_seen_at: "2026-11-12T01:00:00Z",
        origin: "user",
      },
    ],
    navigation: [],
    clipboard: [],
    snapshots: [
      {
        id: "snap-1",
        task_id: "a",
        task_title: FIX_TASK.title,
        name: "前端 + Agent 终端",
        note: "",
        source: "task",
        item_count: 3,
        created_at: "2026-11-12T00:30:00Z",
        updated_at: "2026-11-12T00:30:00Z",
        last_restored_at: null,
        restore_count: 0,
      },
    ],
    actions: [],
  };
  const FIX_RUNS = [
    {
      id: "run-1",
      session_id: "s1",
      source_id: "codex",
      external_run_id: null,
      task_title: "等待确认的补丁",
      status: "waiting",
      started_at: "2026-11-12T01:00:00Z",
      updated_at: "2026-11-12T01:05:00Z",
      ended_at: null,
      pending_items: [],
    },
    {
      id: "run-2",
      session_id: "s1",
      source_id: "codex",
      external_run_id: null,
      task_title: "已完成的一轮",
      status: "completed",
      started_at: "2026-11-12T00:00:00Z",
      updated_at: "2026-11-12T00:10:00Z",
      ended_at: "2026-11-12T00:10:00Z",
      pending_items: [],
    },
  ];
  const FIX_ACTIONS = [
    {
      id: "run:1",
      category: "intervention",
      kind: "waiting_input",
      priority: 0,
      source_id: "codex",
      source_name: "Codex",
      session_external_id: "sess-1",
      run_row_id: "run-1",
      run_external_id: null,
      task_id: "a",
      task_title: FIX_TASK.title,
      title: "等待输入",
      message: "需要确认补丁",
      occurred_at: "2026-11-12T01:05:00Z",
      acked: false,
      authorization_inferred: false,
    },
  ];
  const FIX_REMINDERS = [
    {
      id: "notification:1",
      category: "notification",
      kind: "reminder",
      priority: 1,
      source_id: "",
      source_name: "任务提醒",
      session_external_id: "",
      run_row_id: null,
      run_external_id: null,
      task_id: "a",
      task_title: FIX_TASK.title,
      title: "任务提醒：重构剪贴板模块",
      message: "今天 18:00 截止",
      occurred_at: "2026-11-12T01:00:00Z",
      acked: false,
      authorization_inferred: false,
    },
  ];
  return { FIX_TASK, FIX_CTX, FIX_RUNS, FIX_ACTIONS, FIX_REMINDERS };
});

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    listTasks: vi.fn(async () => [FIX_TASK]),
    fetchTask: vi.fn(async () => FIX_TASK),
    taskContext: vi.fn(async () => FIX_CTX),
    taskReminderLinkGet: vi.fn(async () => null),
    toggleTask: vi.fn(async () => FIX_TASK),
    workspaceList: vi.fn(async () => []),
    workspaceRestore: vi.fn(async () => true),
    workspaceRestoreCancel: vi.fn(async () => undefined),
    agentSnapshot: vi.fn(async () => ({ sources: [], instances: [], sessions: [], runs: [] })),
    actionsFeed: vi.fn(async (filter?: { category?: string }) => {
      const category = filter?.category ?? "intervention";
      const items = category === "notification" ? FIX_REMINDERS : FIX_ACTIONS;
      return {
        category,
        items,
        counts: { total: 2, intervention: 1, running: 0, reminder: 1 },
        db_total: items.length,
        has_more: false,
        next_cursor: null,
        generated_at: "2026-11-12T01:05:00Z",
        enabled: true,
        coverage: { sources: [], intervention_total: 1 },
      };
    }),
    actionsOpenSession: vi.fn(async () => ({
      success: true,
      verification_level: "window-confirmed",
      fallback_used: false,
      target_id: "t1",
      action: "focus_window",
      detail: null,
      reason: null,
    })),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({
      ...(useSettingsStore.getState().settings ?? {}),
      ...patch,
    })),
    getSettings: vi.fn(async () => useSettingsStore.getState().settings ?? {}),
    onWorkspaceChanged: vi.fn(async () => () => {}),
    onWorkspaceRestoreProgress: vi.fn(async () => () => {}),
  };
});

import { taskContext, workspaceRestore, actionsOpenSession, toggleTask, updateSettings } from "../../lib/bridge";

const BASE_SETTINGS: Record<string, unknown> = {
  theme: "system",
  mode: "full",
  material: "glass",
  visual_preset: "frosted",
  workspace_enabled: true,
  navigation_layout: {
    version: 1,
    left: ["workbench", "tasks", "agents", "actions", "collection", "settings"],
    capsule: [],
    known: { left: [], capsule: [] },
  },
};

function seedSettings(patch: Record<string, unknown> = {}) {
  useSettingsStore.setState({
    settings: {
      ...(useSettingsStore.getState().settings ?? {}),
      ...BASE_SETTINGS,
      ...patch,
    } as never,
  });
}

beforeEach(() => {
  // 各用例独立：清掉上一个用例可能留下的 reject 实现，恢复默认可信数据
  vi.mocked(taskContext).mockResolvedValue(FIX_CTX);
  vi.mocked(workspaceRestore).mockResolvedValue(true);
  vi.mocked(actionsOpenSession).mockResolvedValue({
    success: true,
    verification_level: "window-confirmed",
    fallback_used: false,
    target_id: "t1",
    action: "focus_window",
    detail: null,
    reason: null,
  } as never);
  useLocaleStore.setState({ locale: "zh-CN", preference: "zh-CN" });
  seedSettings();
  useAgentsStore.setState({ snapshot: null, snapshotError: null });
  useUiStore.setState({ tab: "workbench", toasts: [], toast: null, context: { open: false, task: null } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useSettingsStore.setState({ settings: null });
});

describe("开发工作台", () => {
  it("未设置当前任务：展示空态与最近待办，一键设为当前走真实设置写入", async () => {
    render(<DevWorkbenchPanel />);
    expect(await screen.findByText("还没有当前任务")).toBeTruthy();
    // 最近待办来自 listTasks（mock 返回 FIX_TASK）；区域 A 空态与区域 D 各出现一次
    const titles = await screen.findAllByText("重构剪贴板模块");
    expect(titles.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole("button", { name: /设为当前任务/ }));
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ workbench_current_task: "a" }),
      );
    });
  });

  it("已设置当前任务：聚合展示任务、关联会话与现场；继续工作触发真实恢复", async () => {
    seedSettings({ workbench_current_task: "a" });
    render(<DevWorkbenchPanel />);
    expect(await screen.findByText("重构剪贴板模块")).toBeTruthy();
    expect(screen.getByText("进行中")).toBeTruthy();
    // 关联 Agent 会话（task_context.agents）
    expect(screen.getByText("重构剪贴板模块 · 会话")).toBeTruthy();
    // 工作现场（task_context.snapshots）
    expect(screen.getByText("前端 + Agent 终端")).toBeTruthy();
    // 继续工作 = 恢复最新现场（有现场时的一步）
    fireEvent.click(screen.getByRole("button", { name: "继续工作" }));
    await waitFor(() => {
      expect(workspaceRestore).toHaveBeenCalledWith("snap-1");
    });
  });

  it("任务已删除：展示失效状态，不伪造任务内容，也不静默清除设置", async () => {
    seedSettings({ workbench_current_task: "gone" });
    const { taskContext } = await import("../../lib/bridge");
    // 当前任务上下文的每次读取都失败（挂载与统计节拍都会触发读取）
    vi.mocked(taskContext).mockRejectedValue(new Error("任务不存在"));
    render(<DevWorkbenchPanel />);
    expect(await screen.findByText(/该任务已不存在/)).toBeTruthy();
    // 失效提示区内提供「打开任务页」入口（页面其他区域也有同名按钮，这里限定 alert 范围）
    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("button", { name: "打开任务页" })).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "取消当前" })).toBeTruthy();
    expect(useSettingsStore.getState().settings).toMatchObject({ workbench_current_task: "gone" });
  });

  it("Agent 摘要：等待/完成计数来自快照聚合；快照未加载时显示中性占位", async () => {
    seedSettings({ workbench_current_task: "a" });
    // 挂载时的自动加载不让它落地（悬挂 Promise），保持「未加载」占位可断言
    const { agentSnapshot } = await import("../../lib/bridge");
    vi.mocked(agentSnapshot).mockImplementationOnce(
      () => new Promise(() => {}) as never,
    );
    render(<DevWorkbenchPanel />);
    // 未加载：五个状态芯片都是中性占位，不把未知伪装成 0
    const chips = document.querySelectorAll<HTMLSpanElement>(".wb-chip em");
    expect(chips.length).toBe(5);
    for (const em of chips) expect(em.textContent).toBe("–");

    useAgentsStore.setState({
      snapshot: {
        sources: [],
        instances: [],
        sessions: [{ id: "s1", external_id: "sess-1" }],
        runs: FIX_RUNS,
      } as never,
    });
    await waitFor(() => {
      expect(
        document.querySelector<HTMLSpanElement>(".wb-chip.tone-waiting em")?.textContent,
      ).toBe("1");
    });
    expect(
      document.querySelector<HTMLSpanElement>(".wb-chip.tone-idle em")?.textContent,
    ).toBe("1");
    // 需关注会话行：等待中的轮次标题 + 一键定位
    expect(screen.getByText("等待确认的补丁")).toBeTruthy();
  });

  it("需要处理：intervention 条目渲染并一键定位会话", async () => {
    seedSettings({ workbench_current_task: "a" });
    render(<DevWorkbenchPanel />);
    // kind 标签与条目标题都是「等待输入」：用 AllBy 断言存在，点击走整行按钮
    const marks = await screen.findAllByText("等待输入");
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("需要确认补丁")).toBeTruthy();
    // 与当前任务关联的条目带「当前任务」标记（intervention 与提醒均可能命中）
    expect(screen.getAllByText("当前任务").length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByTitle("跳转到该 Agent 会话"));
    await waitFor(() => {
      expect(actionsOpenSession).toHaveBeenCalledWith("codex", "sess-1");
    });
  });

  it("工作现场恢复失败：展示后端真实错误，不伪造成功", async () => {
    seedSettings({ workbench_current_task: "a" });
    vi.mocked(workspaceRestore).mockRejectedValueOnce(new Error("backend down"));
    render(<DevWorkbenchPanel />);
    await screen.findByText("重构剪贴板模块");
    fireEvent.click(screen.getByRole("button", { name: "继续工作" }));
    await waitFor(() => {
      const messages = useUiStore.getState().toasts.map((x) => x.message);
      expect(messages.some((m) => m.includes("恢复失败") && m.includes("backend down"))).toBe(
        true,
      );
    });
  });

  it("没有关联会话与现场：不显示定位/恢复这类虚假操作", async () => {
    seedSettings({ workbench_current_task: "a" });
    vi.mocked(taskContext).mockResolvedValue({ ...FIX_CTX, agents: [], snapshots: [] });
    render(<DevWorkbenchPanel />);
    await screen.findByText("重构剪贴板模块");
    expect(screen.getByText("尚未关联 Agent 会话；可在任务上下文中建立关联。")).toBeTruthy();
    expect(screen.getByText("还没有工作现场；可在任务上下文中「保存当前现场」。")).toBeTruthy();
    // 没有关联数据时不能出现只能失败的按钮
    expect(screen.queryByRole("button", { name: "定位会话" })).toBeNull();
    expect(screen.queryByRole("button", { name: "恢复" })).toBeNull();
  });

  it("没有现场但有关联会话：继续工作定位真实会话（外部 ID）", async () => {
    seedSettings({ workbench_current_task: "a" });
    vi.mocked(taskContext).mockResolvedValue({ ...FIX_CTX, snapshots: [] });
    render(<DevWorkbenchPanel />);
    await screen.findByText("重构剪贴板模块");
    fireEvent.click(screen.getByRole("button", { name: "继续工作" }));
    await waitFor(() => expect(actionsOpenSession).toHaveBeenCalledWith("codex", "sess-1"));
    expect(useUiStore.getState().toasts.some((x) => x.message.includes("已定位会话"))).toBe(true);
  });

  it("Agent 完成一轮不改变任务状态：必须由用户显式确认完成", async () => {
    seedSettings({ workbench_current_task: "a" });
    useAgentsStore.setState({
      snapshot: {
        sources: [],
        instances: [],
        sessions: [{ id: "s1", external_id: "sess-1" }],
        runs: [FIX_RUNS[1]],
      } as never,
    });
    render(<DevWorkbenchPanel />);
    await screen.findByText("重构剪贴板模块");
    // 「最近完成」来自真实快照，但任务卡仍是进行中，且没有任何状态写入
    expect(
      document.querySelector<HTMLSpanElement>(".wb-chip.tone-idle em")?.textContent,
    ).toBe("1");
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(toggleTask).not.toHaveBeenCalled();
  });

  it("重要提醒：来自行动中心 notification 分区，点击打开任务上下文", async () => {
    seedSettings({ workbench_current_task: "a" });
    render(<DevWorkbenchPanel />);
    expect(await screen.findByText("任务提醒：重构剪贴板模块")).toBeTruthy();
    expect(screen.getByText("今天 18:00 截止")).toBeTruthy();
    fireEvent.click(screen.getByTitle("查看任务上下文"));
    await waitFor(() => expect(useUiStore.getState().context.open).toBe(true));
    expect(useUiStore.getState().context.task?.id).toBe("a");
  });

  it("英文界面：工作台区域标题与动作全部本地化", async () => {
    seedSettings({ workbench_current_task: "a" });
    useLocaleStore.setState({ locale: "en-US", preference: "en-US" });
    render(<DevWorkbenchPanel />);
    expect(await screen.findByText("Current dev task")).toBeTruthy();
    expect(screen.getByText("Continue work")).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("Quick resume")).toBeTruthy();
    expect(screen.getByText("Agent activity")).toBeTruthy();
    expect(screen.queryByText("继续工作")).toBeNull();
  });
});
