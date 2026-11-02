/**
 * @vitest-environment jsdom
 */
//! 四个胶囊面板的行为测试（真实 store + mock 后端命令）。
//!
//! 覆盖验收要求里的关键项：
//! - 任务完成：成功后有明确反馈并移出列表；失败必须回滚，不能伪装成已完成；
//! - 任务筛选：只对已取回的真实列表做本地过滤（今日 / 逾期 / 日程）；
//! - Agent：状态标签带文字、会话数与运行数来自快照；打开会话调用真实命令；
//! - 剪贴板：类型筛选、单项复制调用真实命令，且复制**不改变列表顺序**；
//! - 应用：搜索是真实过滤；启动失败如实显示后端 reason，不显示「已启动」。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";

const listTasks = vi.fn();
const toggleTask = vi.fn();
const taskStats = vi.fn();
const createFromQuickAdd = vi.fn();
const clipboardView = vi.fn();
const clipboardGroup = vi.fn();
const clipboardCopyItem = vi.fn();
const clipboardCopyGroupRich = vi.fn();
const openAgentSession = vi.fn();
const navNavigate = vi.fn();

vi.mock("../../lib/bridge", () => ({
  listTasks: (...a: unknown[]) => listTasks(...a),
  toggleTask: (...a: unknown[]) => toggleTask(...a),
  taskStats: (...a: unknown[]) => taskStats(...a),
  createFromQuickAdd: (...a: unknown[]) => createFromQuickAdd(...a),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  clipboardView: (...a: unknown[]) => clipboardView(...a),
  clipboardGroup: (...a: unknown[]) => clipboardGroup(...a),
  clipboardCopyItem: (...a: unknown[]) => clipboardCopyItem(...a),
  clipboardCopyGroupRich: (...a: unknown[]) => clipboardCopyGroupRich(...a),
  clipboardThumb: async () => null,
  clipboardImage: async () => null,
  openAgentSession: (...a: unknown[]) => openAgentSession(...a),
  applyMode: async () => undefined,
}));

vi.mock("../../lib/navigation", () => ({
  navNavigate: (...a: unknown[]) => navNavigate(...a),
  avatarHue: () => 250,
}));

import TasksLite from "./TasksLite";
import AgentsLite from "./AgentsLite";
import ClipboardLite from "./ClipboardLite";
import AppsLite from "./AppsLite";
import { useTasksStore } from "../../store/useTasksStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import type { AgentSnapshot, Task } from "../../lib/bridge";

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

function task(id: string, title: string, due: number | null, extra: Partial<Task> = {}): Task {
  return {
    id,
    title,
    description: "",
    priority: 0,
    status: "pending",
    category: "",
    tags: [],
    due_at: due === null ? null : iso(due),
    remind_at: null,
    advance_minutes: 0,
    recurrence: null,
    created_at: iso(now - 60_000),
    updated_at: iso(now - 60_000),
    completed_at: null,
    linked_agents: 0,
    ...extra,
  };
}

beforeEach(() => {
  listTasks.mockReset();
  toggleTask.mockReset();
  taskStats.mockReset();
  clipboardView.mockReset();
  clipboardGroup.mockReset();
  clipboardCopyItem.mockReset();
  clipboardCopyGroupRich.mockReset();
  openAgentSession.mockReset();
  navNavigate.mockReset();
  taskStats.mockResolvedValue({
    pending: 0,
    overdue: 0,
    due_today: 0,
    completed_today: 0,
    next_due_at: null,
  });
  useTasksStore.setState({ stats: null });
  useAgentsStore.setState({ snapshot: null });
});

afterEach(() => {
  cleanup();
});

describe("任务面板", () => {
  const items = [
    task("t1", "整理产品周报", now + 3600_000, { category: "工作" }),
    task("t2", "参加项目同步会", now - 3600_000, { category: "会议" }),
    task("t3", "准备评审材料", null),
  ];

  it("完成后有反馈并移出列表", async () => {
    listTasks.mockResolvedValue(items);
    toggleTask.mockResolvedValue({ ...items[0], status: "completed" });
    render(<TasksLite />);
    await screen.findByText("整理产品周报");

    act(() => {
      screen.getByRole("button", { name: "完成「整理产品周报」" }).click();
    });
    await waitFor(() => expect(toggleTask).toHaveBeenCalledWith("t1"));
    // 视觉反馈先行：先进入勾选态，再移出
    await waitFor(() => expect(screen.queryByText("整理产品周报")).toBeNull(), { timeout: 2000 });
  });

  it("完成失败必须回滚：任务仍在列表且给出失败提示", async () => {
    listTasks.mockResolvedValue(items);
    toggleTask.mockRejectedValue(new Error("db locked"));
    render(<TasksLite />);
    await screen.findByText("整理产品周报");

    act(() => {
      screen.getByRole("button", { name: "完成「整理产品周报」" }).click();
    });
    await screen.findByText("完成失败，已回滚");
    expect(screen.getByText("整理产品周报")).toBeTruthy();
    // 失败后重新拉真实状态，不是本地猜测
    expect(listTasks.mock.calls.length).toBeGreaterThan(1);
  });

  it("分段筛选只过滤已取回的真实列表（五段与效果图一致）", async () => {
    listTasks.mockResolvedValue([
      ...items,
      task("t4", "整理依赖清单", null, {
        status: "completed",
        completed_at: iso(now - 120_000),
      }),
    ]);
    render(<TasksLite />);
    await screen.findByText("整理产品周报");

    // 一次取回 pending + completed：status=all，而不是两次快照拼接
    expect(listTasks).toHaveBeenCalledWith({ view: "all", status: "all", sort: "due" });

    const tabs = screen.getAllByRole("tab").map((el) => el.textContent);
    expect(tabs).toEqual(["全部", "待办", "今日", "日程", "已完成"]);

    act(() => screen.getByRole("tab", { name: "待办" }).click());
    expect(screen.getByText("整理产品周报")).toBeTruthy();
    expect(screen.queryByText("整理依赖清单")).toBeNull();

    // 今日 = 截止时间落在今天（含今天已过期的 1 小时前那条），无期限的不在内
    act(() => screen.getByRole("tab", { name: "今日" }).click());
    expect(screen.getByText("整理产品周报")).toBeTruthy();
    expect(screen.getByText("参加项目同步会")).toBeTruthy();
    expect(screen.queryByText("准备评审材料")).toBeNull();

    act(() => screen.getByRole("tab", { name: "日程" }).click());
    expect(screen.queryByText("准备评审材料")).toBeNull();

    act(() => screen.getByRole("tab", { name: "已完成" }).click());
    expect(screen.getByText("整理依赖清单")).toBeTruthy();
    expect(screen.queryByText("整理产品周报")).toBeNull();

    act(() => screen.getByRole("tab", { name: "全部" }).click());
    expect(screen.getByText("准备评审材料")).toBeTruthy();
    expect(screen.getByText("整理依赖清单")).toBeTruthy();
    // 筛选是本地过滤：切分段不再查询后端
    expect(listTasks).toHaveBeenCalledTimes(1);
  });

  it("已完成的条目不提供「再点一次完成」的假入口", async () => {
    listTasks.mockResolvedValue([
      task("t4", "整理依赖清单", null, { status: "completed", completed_at: iso(now - 120_000) }),
    ]);
    render(<TasksLite />);
    await screen.findByText("整理依赖清单");
    expect(screen.queryByRole("button", { name: "完成「整理依赖清单」" })).toBeNull();
  });
});

describe("Agent 面板", () => {
  const snapshot: AgentSnapshot = {
    sources: [],
    instances: [],
    sessions: [
      {
        id: "s1",
        source_id: "codex",
        external_id: "x",
        title: "重构登录",
        status: "running",
        first_seen_at: iso(now - 60_000),
        last_seen_at: iso(now - 1000),
        last_run_id: "r1",
      },
      {
        id: "s2",
        source_id: "codex",
        external_id: "y",
        title: "另一个会话",
        status: "idle",
        first_seen_at: iso(now - 60_000),
        last_seen_at: iso(now - 2000),
        last_run_id: null,
      },
    ],
    runs: [
      {
        id: "r1",
        session_id: "s1",
        source_id: "codex",
        external_run_id: null,
        task_title: "重构登录",
        status: "waiting",
        started_at: iso(now - 60_000),
        updated_at: iso(now - 1000),
        ended_at: null,
        pending_items: ["确认删除旧表"],
      },
    ],
  };

  it("状态标签带文字，会话数/运行数来自快照", async () => {
    useAgentsStore.setState({ snapshot });
    render(<AgentsLite />);
    await screen.findByText("重构登录");
    // 等待确认不是「只有颜色」：必须有可读文字
    expect(screen.getByText("等待处理")).toBeTruthy();
    expect(screen.getByText(/会话\s*2/)).toBeTruthy();
    expect(screen.getByText(/待确认 1 项/)).toBeTruthy();
    expect(screen.getByText(/监控中/)).toBeTruthy();
  });

  it("打开会话调用真实命令；失败时如实提示", async () => {
    useAgentsStore.setState({ snapshot });
    openAgentSession.mockRejectedValueOnce(new Error("no capability"));
    render(<AgentsLite />);
    await screen.findByText("重构登录");
    act(() => screen.getByRole("button", { name: "打开 重构登录 的会话" }).click());
    await screen.findByText("打开会话失败");
    expect(openAgentSession).toHaveBeenCalledWith("codex", "s1");
  });
});

describe("剪贴板面板", () => {
  const view = {
    items: [
      {
        id: "c1",
        kind: "text",
        text: "液态融合翼片是一种更自然的边栏形态",
        html: "",
        preview: "液态融合翼片是一种更自然的边栏形态",
        title: "",
        title_source: "auto",
        byte_size: 240,
        source_app: "VS Code",
        source_title: "",
        image_width: null,
        image_height: null,
        file_paths: [],
        favorite: false,
        pinned: false,
        copy_count: 1,
        created_at: iso(now),
        last_seen_at: iso(now),
        has_image: false,
        has_thumb: false,
      },
      {
        id: "c2",
        kind: "image",
        text: "",
        html: "",
        preview: "",
        title: "界面设计方案",
        title_source: "manual",
        byte_size: 2_800_000,
        source_app: "Snipaste",
        source_title: "",
        image_width: 1920,
        image_height: 1080,
        file_paths: [],
        favorite: false,
        pinned: false,
        copy_count: 1,
        created_at: iso(now - 1000),
        last_seen_at: iso(now - 1000),
        has_image: true,
        has_thumb: false,
      },
    ],
    groups: [],
    stats: {},
    total_items: 2,
  };

  it("类型筛选与单项复制走真实命令，且复制后顺序不变", async () => {
    clipboardView.mockResolvedValue(view);
    clipboardCopyItem.mockResolvedValue({ mode: "text", bytes: 1, warnings: [], sequence: 1 });
    const { container } = render(<ClipboardLite />);
    await screen.findByText("界面设计方案");

    const firstBefore = container.querySelector(".cap-item .cap-item-title")?.textContent;

    act(() => screen.getByRole("tab", { name: "图片" }).click());
    expect(screen.queryByText(/液态融合翼片/)).toBeNull();
    expect(screen.getByText("界面设计方案")).toBeTruthy();

    act(() => screen.getByRole("tab", { name: "全部" }).click());
    act(() => screen.getByRole("button", { name: "复制「界面设计方案」" }).click());
    await waitFor(() => expect(clipboardCopyItem).toHaveBeenCalledWith("c2"));
    // 复制不触发重新拉取：历史顺序不因复制而跳动
    expect(clipboardView).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".cap-item .cap-item-title")?.textContent).toBe(firstBefore);
  });
});

describe("应用面板", () => {
  const target = (id: string, name: string, extra = {}) => ({
    id,
    display_name: name,
    target_type: "application" as const,
    app_key: name.toLowerCase(),
    exe_path: "",
    launch_args: "",
    working_dir: "",
    app_user_model_id: "",
    url: "",
    path: "",
    agent_source_id: "",
    agent_session_id: "",
    window_title_hint: "",
    icon: "",
    category: "dev",
    favorite: false,
    hidden: false,
    last_used_at: null,
    use_count: 0,
    created_at: iso(now),
    updated_at: iso(now),
    ...extra,
  });

  it("搜索是真实过滤", async () => {
    useNavigationStore.setState({
      targets: [target("a", "微信"), target("b", "Obsidian")],
      targetsLoaded: true,
    });
    render(<AppsLite />);
    await screen.findByText("Obsidian");
    const input = screen.getByLabelText("搜索快捷应用");
    fireEvent.change(input, { target: { value: "obs" } });
    await waitFor(() => expect(screen.queryByText("微信")).toBeNull());
    expect(screen.getByText("Obsidian")).toBeTruthy();
  });

  it("启动失败显示后端 reason，不显示成功文案", async () => {
    useNavigationStore.setState({
      targets: [target("a", "Obsidian")],
      targetsLoaded: true,
    });
    navNavigate.mockResolvedValue({
      success: false,
      requested_action: "launch",
      actual_action: null,
      fallback_used: false,
      target_id: "a",
      reason: "找不到可执行文件",
      verification_level: "none",
    });
    render(<AppsLite />);
    await screen.findByText("Obsidian");
    act(() => screen.getByRole("button", { name: "启动 Obsidian" }).click());
    await screen.findByText("Obsidian：找不到可执行文件");
  });
});
