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
const clipboardStatus = vi.fn();
const quickCaptureList = vi.fn();
const quickCaptureState = vi.fn();
const openAgentSession = vi.fn();
const agentSnapshot = vi.fn();
const navListTargets = vi.fn();
const navNavigate = vi.fn();

vi.mock("../../lib/bridge", () => ({
  onClipboardChanged: async () => () => {},
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
  clipboardStatus: (...a: unknown[]) => clipboardStatus(...a),
  quickCaptureList: (...a: unknown[]) => quickCaptureList(...a),
  quickCaptureState: (...a: unknown[]) => quickCaptureState(...a),
  quickCaptureMarkHandled: vi.fn(),
  quickCaptureDelete: vi.fn(),
  quickCaptureConvertToTask: vi.fn(),
  clipboardThumb: async () => null,
  clipboardImage: async () => null,
  openAgentSession: (...a: unknown[]) => openAgentSession(...a),
  agentSnapshot: (...a: unknown[]) => agentSnapshot(...a),
  applyMode: async () => undefined,
}));

vi.mock("../../lib/navigation", () => ({
  navNavigate: (...a: unknown[]) => navNavigate(...a),
  navListTargets: (...a: unknown[]) => navListTargets(...a),
  avatarHue: () => 250,
  // AppIcon 统一请求真实图标；胶囊测试只关心名称/启动，图标直接回退字母
  navAppIcon: async () => null,
}));

import TasksLite from "./TasksLite";
import AgentsLite from "./AgentsLite";
import ClipboardLite from "./ClipboardLite";
import AppsLite from "./AppsLite";
import { useTasksStore } from "../../store/useTasksStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { useClipboardStore } from "../../store/useClipboardStore";
import { useCaptureStore } from "../../store/useCaptureStore";
import { useNavigationStore } from "../../store/useNavigationStore";
import { useUiStore } from "../../store/useUiStore";
import type { AgentSnapshot, Task } from "../../lib/bridge";

//! 固定到「今天中午」的时间锚点：今日/逾期/日程断言不再受跑测时刻影响
//! （凌晨或深夜 +/- 1 小时会跨日，曾经导致用例在特定时段必失败）。
const ANCHOR = new Date();
ANCHOR.setHours(12, 0, 0, 0);
const now = ANCHOR.getTime();
const iso = (ms: number) => new Date(ms).toISOString();

const EMPTY_SNAPSHOT: AgentSnapshot = { sources: [], instances: [], sessions: [], runs: [] };

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
  clipboardStatus.mockReset();
  quickCaptureList.mockReset();
  quickCaptureState.mockReset();
  openAgentSession.mockReset();
  agentSnapshot.mockReset();
  agentSnapshot.mockResolvedValue(EMPTY_SNAPSHOT);
  navListTargets.mockReset();
  navNavigate.mockReset();
  taskStats.mockResolvedValue({
    pending: 0,
    overdue: 0,
    due_today: 0,
    completed_today: 0,
    next_due_at: null,
  });
  clipboardStatus.mockResolvedValue({
    enabled: true,
    paused: false,
    monitoring: true,
    activeJob: null,
    platform: "windows",
    configError: null,
    configOrigin: null,
    captureAllowed: true,
  });
  useTasksStore.setState({
    stats: null,
    lite: null,
    liteScope: "all",
    liteLoading: false,
    liteError: null,
  });
  useAgentsStore.setState({ snapshot: null, snapshotError: null });
  useClipboardStore.setState({
    lite: null,
    liteLoading: false,
    liteStatus: "loading",
    liteError: null,
    liteActive: false,
    monitor: "checking",
  });
  useCaptureStore.setState({
    items: [],
    filter: "inbox",
    loading: false,
    error: null,
    inboxCount: 0,
    inboxCountLoaded: false,
    lite: null,
    liteLoading: false,
    liteError: null,
  });
  useNavigationStore.setState({ targets: [], targetsLoaded: false, targetsError: null });
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

  it("分段筛选按范围读取必要结果：已完成不被最近待办截断", async () => {
    const completed = task("t4", "整理依赖清单", null, {
      status: "completed",
      completed_at: iso(now - 120_000),
    });
    // 模拟「最近 12 条」全是待办、已完成被挤出的真实截断
    listTasks.mockImplementation(async (args: { status: string }) =>
      args.status === "completed" ? [completed] : items,
    );
    render(<TasksLite />);
    await screen.findByText("整理产品周报");

    // 初始取 pending + completed 的 all 范围；limit:12 与面板展示量一致
    expect(listTasks).toHaveBeenCalledWith({ view: "all", status: "all", sort: "due", limit: 12 });

    const tabs = screen.getAllByRole("tab").map((el) => el.textContent);
    expect(tabs).toEqual(["全部", "待办", "今日", "日程", "已完成"]);

    act(() => screen.getByRole("tab", { name: "待办" }).click());
    await screen.findByText("整理产品周报");
    expect(screen.queryByText("整理依赖清单")).toBeNull();
    // 待办换成 status=pending 的范围（只读必要结果）
    expect(listTasks).toHaveBeenLastCalledWith({
      view: "all",
      status: "pending",
      sort: "due",
      limit: 12,
    });

    // 今日/日程与待办共用 pending 结果：不产生新请求
    const callsAfterPending = listTasks.mock.calls.length;
    act(() => screen.getByRole("tab", { name: "今日" }).click());
    expect(screen.getByText("整理产品周报")).toBeTruthy();
    expect(screen.getByText("参加项目同步会")).toBeTruthy();
    expect(screen.queryByText("准备评审材料")).toBeNull();

    act(() => screen.getByRole("tab", { name: "日程" }).click());
    expect(screen.queryByText("准备评审材料")).toBeNull();
    expect(listTasks.mock.calls.length).toBe(callsAfterPending);

    // 已完成独立查询：不会被「最近 12 条待办」截断成误判为空
    act(() => screen.getByRole("tab", { name: "已完成" }).click());
    await screen.findByText("整理依赖清单");
    expect(screen.queryByText("整理产品周报")).toBeNull();
    expect(listTasks).toHaveBeenLastCalledWith({
      view: "all",
      status: "completed",
      sort: "due",
      limit: 12,
    });

    act(() => screen.getByRole("tab", { name: "全部" }).click());
    await screen.findByText("准备评审材料");
    expect(listTasks).toHaveBeenLastCalledWith({
      view: "all",
      status: "all",
      sort: "due",
      limit: 12,
    });
    // 四次查询：初始 all / pending / completed / all，同范围切换不重复请求
    expect(listTasks).toHaveBeenCalledTimes(4);
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
    const { container } = render(<AgentsLite />);
    await screen.findByText("重构登录");
    // 等待确认不是「只有颜色」：必须有可读文字
    expect(screen.getByText("等待处理")).toBeTruthy();
    expect(screen.getByText(/会话\s*2/)).toBeTruthy();
    expect(screen.getByText(/待确认 1 项/)).toBeTruthy();
    // 摘要行按真实状态分列（不把实例/会话总数算成「运行中」）
    const summary = container.querySelector(".cap-summary")?.textContent ?? "";
    expect(summary).toContain("运行中");
    expect(summary).toContain("等待");
    expect(summary).toContain("失败");
  });

  it("首次读取失败显示错误空态并重试，不永久停在「读取中…」", async () => {
    agentSnapshot.mockRejectedValueOnce(new Error("ipc broken"));
    render(<AgentsLite />);

    await screen.findByText("Agent 状态读取失败");
    expect(screen.queryByText("读取中…")).toBeNull();
    // 失败不是空数据：不能显示「暂无运行中」这种正常空态文案
    expect(screen.queryByText("未检测到运行中的 Agent")).toBeNull();

    // 重试成功后恢复真实快照，错误空态消失
    act(() => screen.getByRole("button", { name: "重试" }).click());
    await waitFor(() =>
      expect(useAgentsStore.getState().snapshotError).toBeNull(),
    );
    expect(screen.queryByText("Agent 状态读取失败")).toBeNull();
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

  it("复制失败给出明确提示，且不显示成功勾选", async () => {
    clipboardView.mockResolvedValue(view);
    // 条目已不存在：提示刷新，而不是静默失败
    clipboardCopyItem.mockRejectedValueOnce({
      code: "NOT_FOUND",
      message: "clipboard item not found",
    });
    const { container } = render(<ClipboardLite />);
    await screen.findByText("界面设计方案");

    act(() => screen.getByRole("button", { name: "复制「界面设计方案」" }).click());
    await waitFor(() =>
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        "条目已不存在，正在刷新列表",
      ),
    );
    // 刷新列表是恢复动作（不是把失败当成功）
    await waitFor(() => expect(clipboardView.mock.calls.length).toBeGreaterThan(1));
    expect(container.querySelector(".cap-mini.is-ok")).toBeNull();
  });

  it("剪贴板被占用时提示稍后重试", async () => {
    clipboardView.mockResolvedValue(view);
    clipboardCopyItem.mockRejectedValueOnce("剪贴板被其他程序占用，请稍后重试");
    render(<ClipboardLite />);
    await screen.findByText("界面设计方案");

    act(() => screen.getByRole("button", { name: "复制「界面设计方案」" }).click());
    await waitFor(() =>
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        "剪贴板被其他程序占用，请稍后重试",
      ),
    );
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

  it("读取失败且从未成功 → 错误空态 + 重试，不伪装成「尚未配置快捷应用」", async () => {
    useNavigationStore.setState({ targets: [], targetsLoaded: false, targetsError: "ipc broken" });
    navListTargets.mockRejectedValueOnce(new Error("ipc broken"));
    render(<AppsLite />);
    await screen.findByText("快捷应用读取失败");
    expect(screen.queryByText("尚未配置快捷应用")).toBeNull();
    // 重试成功后回到正常列表（空清单 → 真正的「尚未配置」空态）
    navListTargets.mockResolvedValueOnce([target("a", "Obsidian")]);
    act(() => screen.getByRole("button", { name: "重试" }).click());
    await screen.findByText("Obsidian");
    expect(screen.queryByText("快捷应用读取失败")).toBeNull();
  });

  it("读取失败但有旧清单 → 旧清单保留 + 错误提示条（可重试）", async () => {
    useNavigationStore.setState({
      targets: [target("a", "Obsidian")],
      targetsLoaded: true,
      targetsError: "refresh failed",
    });
    render(<AppsLite />);
    await screen.findByText("Obsidian");
    await screen.findByText("刷新失败，显示的是上次结果");
    expect(screen.queryByText("尚未配置快捷应用")).toBeNull();
  });

  it("添加按钮始终可见（列表占满也不消失），点击写入一次性配置意图并切到设置页", async () => {
    useNavigationStore.setState({
      targets: Array.from({ length: 8 }, (_, i) => target(`a${i}`, `应用${i}`)),
      targetsLoaded: true,
    });
    useUiStore.setState({ appConfig: null });
    render(<AppsLite />);
    await screen.findByText("应用0");
    fireEvent.click(screen.getByRole("button", { name: "添加应用" }));
    expect(useUiStore.getState().appConfig?.kind).toBe("picker");
    expect(useUiStore.getState().tab).toBe("settings");
  });

  it("只展示普通应用：网址/文件夹单独分区，Agent 会话不混入应用网格", async () => {
    useNavigationStore.setState({
      targets: [
        target("a", "Obsidian"),
        target("u", "项目官网", { target_type: "url", url: "https://example.com" }),
        target("s", "Agent 会话", { target_type: "agent_session", agent_source_id: "codex" }),
      ],
      targetsLoaded: true,
    });
    render(<AppsLite />);
    await screen.findByText("Obsidian");
    // 普通应用网格：启动语义
    expect(screen.getByRole("button", { name: "启动 Obsidian" })).toBeTruthy();
    // 网址/文件夹单独分区：打开语义，不进入 4 列应用网格
    expect(screen.getByText("网址 / 文件夹")).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开 项目官网" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "启动 项目官网" })).toBeNull();
    expect(screen.queryByText("Agent 会话")).toBeNull();
  });

  it("空状态「去配置」直接进入可添加应用界面；「管理」进入应用管理意图", async () => {
    useNavigationStore.setState({ targets: [], targetsLoaded: true, targetsError: null });
    useUiStore.setState({ appConfig: null, tab: "tasks" });
    render(<AppsLite />);
    fireEvent.click(await screen.findByRole("button", { name: "去配置" }));
    expect(useUiStore.getState().appConfig?.kind).toBe("picker");
    expect(useUiStore.getState().tab).toBe("settings");

    // 一次性意图消费后不会重复触发；「管理」写入新的 manage 意图
    useUiStore.setState({ appConfig: null, tab: "tasks" });
    fireEvent.click(screen.getByRole("button", { name: "管理快捷应用" }));
    expect(useUiStore.getState().appConfig?.kind).toBe("manage");
    expect(useUiStore.getState().tab).toBe("settings");
  });

  it("启动成功后刷新共享目标（最近使用排序反映真实计数）", async () => {
    useNavigationStore.setState({ targets: [target("a", "Obsidian")], targetsLoaded: true });
    navNavigate.mockResolvedValue({
      success: true,
      requested_action: "focus",
      actual_action: "focus_window",
      fallback_used: false,
      target_id: "a",
      verification_level: "window",
    });
    navListTargets.mockResolvedValue([
      target("a", "Obsidian", { use_count: 1, last_used_at: iso(now) }),
    ]);
    render(<AppsLite />);
    await screen.findByText("Obsidian");
    fireEvent.click(screen.getByRole("button", { name: "启动 Obsidian" }));
    await screen.findByText("已聚焦 Obsidian");
    await waitFor(() => expect(navListTargets).toHaveBeenCalledWith(true));
  });
});

describe("错误状态（读取失败绝不伪装成空态）", () => {
  it("任务列表读取失败且无旧数据 → 错误空态 + 重试（不是「暂无待办」）", async () => {
    listTasks.mockRejectedValue(new Error("db locked"));
    render(<TasksLite />);
    await screen.findByText("任务列表读取失败");
    expect(screen.queryByText("暂无任务")).toBeNull();

    listTasks.mockResolvedValueOnce([task("t1", "重试后拿到的任务", null)]);
    act(() => screen.getByRole("button", { name: "重试" }).click());
    await screen.findByText("重试后拿到的任务");
  });

  it("任务列表读取失败但有旧数据 → 旧列表保留 + 错误条", async () => {
    listTasks.mockResolvedValueOnce([task("t1", "先拿到的任务", null)]);
    render(<TasksLite />);
    await screen.findByText("先拿到的任务");
    // 模拟一次失败的实时刷新（store.refresh 顺带刷 lite）
    listTasks.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      await useTasksStore.getState().loadLite();
    });
    await screen.findByText("刷新失败，显示的是上次结果");
    expect(screen.getByText("先拿到的任务")).toBeTruthy();
    // 错误条上的重试可再次拉取
    listTasks.mockResolvedValueOnce([task("t1", "重试拿到的任务", null)]);
    act(() => screen.getByRole("button", { name: "重试读取任务列表" }).click());
    await screen.findByText("重试拿到的任务");
  });

  it("零任务不渲染完成进度条（无意义的 0% 不出现）", async () => {
    listTasks.mockResolvedValue([]);
    const { container } = render(<TasksLite />);
    await screen.findByText("暂无任务");
    expect(container.querySelector(".cap-progress")).toBeNull();
    // 有任务时进度条存在
    cleanup();
    listTasks.mockResolvedValue([task("t1", "有任务", null)]);
    const second = render(<TasksLite />);
    await screen.findByText("有任务");
    expect(second.container.querySelector(".cap-progress")).toBeTruthy();
  });
});
