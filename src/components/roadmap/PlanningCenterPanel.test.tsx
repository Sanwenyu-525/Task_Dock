/**
 * @vitest-environment jsdom
 */
//! 规划中心面板测试（jsdom）：
//! 双数据源切换（我的项目 / 内置路线图）、项目总览统计、功能新增/编辑、功能详情步骤、
//! 功能看板状态切换与受阻/暂停入口、里程碑时间轴与关联统计、空项目、删除确认、
//! 请求失败重试。bridge planning 命令全部 mock，store 用真实实现覆盖联动。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PlanningCenterPanel from "./PlanningCenterPanel";
import { usePlanningStore } from "../../store/usePlanningStore";
import { useUiStore } from "../../store/useUiStore";
import type { PlanningFeature, PlanningMilestone, PlanningProject } from "../../lib/bridge";

const bridge = vi.hoisted(() => ({
  planningListProjects: vi.fn(),
  planningCreateProject: vi.fn(),
  planningUpdateProject: vi.fn(),
  planningArchiveProject: vi.fn(),
  planningDeleteProject: vi.fn(),
  planningReorderProjects: vi.fn(),
  planningListFeatures: vi.fn(),
  planningCreateFeature: vi.fn(),
  planningUpdateFeature: vi.fn(),
  planningDeleteFeature: vi.fn(),
  planningReorderFeatures: vi.fn(),
  planningAddStep: vi.fn(),
  planningUpdateStep: vi.fn(),
  planningDeleteStep: vi.fn(),
  planningReorderSteps: vi.fn(),
  planningListMilestones: vi.fn(),
  planningCreateMilestone: vi.fn(),
  planningUpdateMilestone: vi.fn(),
  planningDeleteMilestone: vi.fn(),
  planningActivityPage: vi.fn(),
  planningAddNote: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/bridge")>()),
  ...bridge,
}));

function proj(id: string, name: string, overrides: Partial<PlanningProject> = {}): PlanningProject {
  return {
    id,
    name,
    description: "",
    status: "in_progress",
    archived: false,
    target_date: null,
    sort_order: 0,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
    stats: {
      feature_total: 3,
      feature_completed: 1,
      feature_in_progress: 1,
      feature_blocked: 0,
      feature_planned: 1,
      feature_review: 0,
      feature_paused: 0,
      has_features: true,
      progress_percent: 33,
    },
    ...overrides,
  };
}

function feat(id: string, title: string, overrides: Partial<PlanningFeature> = {}): PlanningFeature {
  return {
    id,
    project_id: "p1",
    title,
    description: "",
    acceptance_criteria: "",
    status: "planned",
    priority: "P1",
    milestone_id: null,
    milestone_name: null,
    target_date: null,
    sort_order: 0,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
    completed_at: null,
    steps: [],
    step_total: 0,
    step_done: 0,
    ...overrides,
  };
}

function ms(
  id: string,
  name: string,
  total = 0,
  completed = 0,
  targetDate: string | null = null,
): PlanningMilestone {
  return {
    id,
    project_id: "p1",
    name,
    description: "",
    target_date: targetDate,
    sort_order: 0,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-02T00:00:00Z",
    feature_total: total,
    feature_completed: completed,
  };
}

const PROJECT_A = proj("p1", "我的应用");
const PROJECT_B = proj("p2", "副业项目", {
  stats: {
    feature_total: 0,
    feature_completed: 0,
    feature_in_progress: 0,
    feature_blocked: 0,
    feature_planned: 0,
    feature_review: 0,
    feature_paused: 0,
    has_features: false,
    progress_percent: 0,
  },
});
const FEATURE_STEPS = feat("f1", "登录系统", {
  status: "in_progress",
  step_total: 2,
  step_done: 1,
  steps: [
    { id: "s1", feature_id: "f1", title: "设计数据库", done: true, sort_order: 0, created_at: "", updated_at: "", completed_at: "2026-11-02T00:00:00Z" },
    { id: "s2", feature_id: "f1", title: "实现接口", done: false, sort_order: 1, created_at: "", updated_at: "", completed_at: null },
  ],
});
const FEATURE_NO_STEPS = feat("f2", "全局搜索", { status: "planned" });
const FEATURE_DONE = feat("f3", "已上线", { status: "completed" });

beforeEach(() => {
  vi.clearAllMocks();
  usePlanningStore.setState({
    projects: [],
    projectsLoading: false,
    projectsError: null,
    activeProjectId: null,
    loadedForProject: null,
    features: [],
    featuresLoading: false,
    featuresError: null,
    milestones: [],
    milestonesLoading: false,
    milestonesError: null,
    activity: [],
    activityHasMore: false,
    activityLoading: false,
    activityError: null,
    activityScope: null,
  });
  useUiStore.setState({ toasts: [], toast: null });
});

afterEach(cleanup);

// 全量套件并行时本机负载高：所有显式等待放宽超时，避免偶发抖动
const WAIT = { timeout: 15000 };

async function renderWithProjects() {
  bridge.planningListProjects.mockResolvedValue([PROJECT_A, PROJECT_B]);
  bridge.planningListFeatures.mockImplementation(async (pid: string) =>
    pid === "p1" ? [FEATURE_STEPS, FEATURE_NO_STEPS, FEATURE_DONE] : [],
  );
  bridge.planningListMilestones.mockResolvedValue([]);
  const user = userEvent.setup();
  render(<PlanningCenterPanel />);
  await waitFor(() => expect(screen.getAllByText("我的应用").length).toBeGreaterThan(0), WAIT);
  return user;
}

async function goToFeatures(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "功能列表" }));
}

describe("数据源与视图导航", () => {
  it("提供规划中心对应的上下文教程入口", () => {
    bridge.planningListProjects.mockResolvedValue([]);
    render(<PlanningCenterPanel />);

    expect(
      screen.getByRole("button", { name: "查看帮助：规划中心：管理项目与内置路线图" }),
    ).toBeTruthy();
  });

  it("默认显示项目总览；无项目时给出创建引导并提示内置路线图位置", async () => {
    bridge.planningListProjects.mockResolvedValue([]);
    render(<PlanningCenterPanel />);
    expect(await screen.findByText(/创建你的第一个项目/, {}, WAIT)).toBeTruthy();
    expect(screen.getByRole("button", { name: /新建项目/ })).toBeTruthy();
    expect(screen.getAllByText(/内置路线图/).length).toBeGreaterThanOrEqual(1);
    // 空态不得显示 0% 进度
    expect(screen.queryByText(/0%/)).toBeNull();
    // 四视图入口存在
    expect(screen.getByRole("tab", { name: "项目总览" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "功能列表" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "功能看板" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "里程碑" })).toBeTruthy();
  });

  it("切到内置路线图后渲染 Task Dock 既有目录，28 项入口保留", async () => {
    const user = userEvent.setup();
    bridge.planningListProjects.mockResolvedValue([]);
    render(<PlanningCenterPanel />);
    await user.click(screen.getByRole("button", { name: "内置路线图" }));
    expect(screen.getByText("核心效率功能")).toBeTruthy();
    expect(screen.getByText(/已实现 \d+/)).toBeTruthy();
    expect(screen.queryByText(/创建你的第一个项目/)).toBeNull();
  });

  it("内置路线图与我的项目互不影响：切回后总览恢复", async () => {
    const user = await renderWithProjects();
    await user.click(screen.getByRole("button", { name: "内置路线图" }));
    expect(screen.getByText("核心效率功能")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "我的项目" }));
    await waitFor(() => expect(screen.getAllByText("我的应用").length).toBeGreaterThan(0), WAIT);
  });
});

describe("项目总览", () => {
  it("统计来自真实功能数据：总数、各状态数量与整体完成率", async () => {
    await renderWithProjects();
    // 项目级加载完成后，Store 用后端功能实体同步统计
    await waitFor(() => expect(usePlanningStore.getState().projects[0].stats.feature_total).toBe(3));
    const overview = screen.getByLabelText("项目概览");
    const totalCard = within(overview).getByText("功能总数").parentElement!;
    expect(totalCard.textContent).toContain("3");
    const doneCard = within(overview).getByText("已完成").parentElement!;
    expect(doneCard.textContent).toContain("1");
    expect(screen.getByText(/整体完成率/)).toBeTruthy();
    expect(screen.getAllByText("33%").length).toBeGreaterThanOrEqual(1);
  });

  it("项目切换：Select 换项目后加载其数据；空项目显示尚未添加功能且不显示 0%", async () => {
    const user = await renderWithProjects();
    await user.click(screen.getByRole("combobox", { name: "选择项目" }));
    await user.click(screen.getByRole("option", { name: "副业项目" }));
    await waitFor(() => expect(usePlanningStore.getState().activeProjectId).toBe("p2"));
    await waitFor(() => expect(screen.getAllByText("尚未添加功能").length).toBeGreaterThanOrEqual(1), WAIT);
    expect(screen.queryByText(/整体完成率/)).toBeTruthy();
    expect(screen.queryByText(/0%/)).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "选择项目" }));
    await user.click(screen.getByRole("option", { name: "我的应用" }));
    await waitFor(() => expect(screen.getAllByText("我的应用").length).toBeGreaterThan(0), WAIT);
  });

  it("新建项目：填名创建后出现在项目里", async () => {
    const user = await renderWithProjects();
    await user.click(screen.getByRole("button", { name: /新建项目/ }));
    const editor = await screen.findByRole("region", { name: "新建项目" }, WAIT);
    await user.type(within(editor).getByLabelText("项目名称"), "新坑");
    bridge.planningCreateProject.mockResolvedValue(proj("p3", "新坑"));
    await user.click(within(editor).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(bridge.planningCreateProject).toHaveBeenCalled(), WAIT);
    await waitFor(() => expect(screen.queryByRole("region", { name: "新建项目" })).toBeNull(), WAIT);
    expect(screen.getAllByText("新坑").length).toBeGreaterThan(0);
  });

  it("项目目标日期：选择后标记未保存并随保存提交", async () => {
    const user = await renderWithProjects();
    await user.click(screen.getByRole("button", { name: "编辑项目" }));
    const editor = await screen.findByRole("region", { name: "编辑项目" }, WAIT);
    await user.click(within(editor).getByRole("textbox", { name: "目标日期" }));
    await user.click(screen.getByRole("button", { name: "2026-11-20" }));
    expect(within(editor).getByRole("status").textContent).toContain("未保存");

    bridge.planningUpdateProject.mockResolvedValue(proj("p1", "我的应用", { target_date: "2026-11-20" }));
    await user.click(within(editor).getByRole("button", { name: "保存" }));
    await waitFor(
      () =>
        expect(bridge.planningUpdateProject).toHaveBeenCalledWith(
          "p1",
          expect.objectContaining({ target_date: "2026-11-20" }),
        ),
      WAIT,
    );
  });

  it("编辑项目失败：提示错误、页面内编辑态保留用户输入", async () => {
    const user = await renderWithProjects();
    await user.click(screen.getByRole("button", { name: "编辑项目" }));
    const editor = await screen.findByRole("region", { name: "编辑项目" }, { timeout: WAIT.timeout });
    const nameInput = within(editor).getByLabelText("项目名称") as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, "改名后失败");
    bridge.planningUpdateProject.mockRejectedValue("写入被拒绝");
    await user.click(within(editor).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(useUiStore.getState().toasts.some((t) => t.kind === "error")).toBe(true),
    );
    // 页面内编辑态保留：输入未丢失
    expect(screen.getByRole("region", { name: "编辑项目" })).toBeTruthy();
    expect((screen.getByLabelText("项目名称") as HTMLInputElement).value).toBe("改名后失败");
  });

  it("项目未保存返回保护：放弃修改后回到总览", async () => {
    const user = await renderWithProjects();
    await user.click(screen.getByRole("button", { name: "编辑项目" }));
    const editor = await screen.findByRole("region", { name: "编辑项目" }, WAIT);
    await user.type(within(editor).getByLabelText("项目名称"), "改一半");
    await user.click(within(editor).getByRole("button", { name: "返回项目总览" }));
    expect(within(editor).getByRole("alert").textContent).toContain("未保存");
    await user.click(within(editor).getByRole("button", { name: "放弃修改" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "编辑项目" })).toBeNull(), WAIT);
    expect(screen.getByLabelText("项目概览")).toBeTruthy();
  });

  it("删除项目必须确认且明确影响面（功能/步骤/历史）", async () => {
    const user = await renderWithProjects();
    await user.click(screen.getByRole("button", { name: "删除项目" }));
    const dialog = await screen.findByRole("dialog", { name: "删除项目" }, { timeout: WAIT.timeout });
    expect(within(dialog).getByText(/3 个功能/)).toBeTruthy();
    expect(within(dialog).getByText(/进度历史/)).toBeTruthy();
    bridge.planningDeleteProject.mockResolvedValue(undefined);
    await user.click(within(dialog).getByRole("button", { name: "删除项目" }));
    await waitFor(() => expect(bridge.planningDeleteProject).toHaveBeenCalledWith("p1"), WAIT);
  });
});

describe("功能列表与详情", () => {
  it("新增功能入口可用：保存后列表与统计更新", async () => {
    const user = await renderWithProjects();
    await goToFeatures(user);
    await waitFor(() => expect(screen.getByRole("button", { name: "新增功能" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "新增功能" }));
    const editor = await screen.findByRole("region", { name: "新增功能" }, WAIT);
    await user.type(within(editor).getByLabelText("功能名称"), "验收新功能");
    await user.type(within(editor).getByLabelText("验收标准"), "打开页面无报错");
    bridge.planningCreateFeature.mockResolvedValue(
      feat("f-new", "验收新功能", { acceptance_criteria: "打开页面无报错" }),
    );
    await user.click(within(editor).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(bridge.planningCreateFeature).toHaveBeenCalled(), WAIT);
    await waitFor(() => expect(screen.queryByRole("region", { name: "新增功能" })).toBeNull(), WAIT);
    expect(screen.getByRole("button", { name: /^验收新功能（/ })).toBeTruthy();
    await waitFor(() =>
      expect(usePlanningStore.getState().projects[0].stats.feature_total).toBe(4),
    );
  });

  it("编辑功能失败：页面内编辑态保留输入", async () => {
    const user = await renderWithProjects();
    await goToFeatures(user);
    await user.click(screen.getByRole("button", { name: /^登录系统（/ }));
    await user.click(screen.getByRole("button", { name: "编辑功能 登录系统" }));
    const editor = await screen.findByRole("region", { name: "编辑功能" }, WAIT);
    const input = within(editor).getByLabelText("功能名称") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "登录失败");
    bridge.planningUpdateFeature.mockRejectedValue("写入失败");
    await user.click(within(editor).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(useUiStore.getState().toasts.some((t) => t.kind === "error")).toBe(true),
    );
    expect(screen.getByRole("region", { name: "编辑功能" })).toBeTruthy();
    expect((within(editor).getByLabelText("功能名称") as HTMLInputElement).value).toBe("登录失败");
  });

  it("功能目标日期：选择后标记未保存并随保存提交", async () => {
    const user = await renderWithProjects();
    await goToFeatures(user);
    await user.click(screen.getByRole("button", { name: /^登录系统（/ }));
    await user.click(screen.getByRole("button", { name: "编辑功能 登录系统" }));
    const editor = await screen.findByRole("region", { name: "编辑功能" }, WAIT);
    await user.click(within(editor).getByRole("textbox", { name: "目标日期" }));
    await user.click(screen.getByRole("button", { name: "2026-11-20" }));
    expect(within(editor).getByRole("status").textContent).toContain("未保存");

    bridge.planningUpdateFeature.mockResolvedValue({ ...FEATURE_STEPS, target_date: "2026-11-20" });
    await user.click(within(editor).getByRole("button", { name: "保存" }));
    await waitFor(
      () =>
        expect(bridge.planningUpdateFeature).toHaveBeenCalledWith(
          "f1",
          expect.objectContaining({ target_date: "2026-11-20" }),
        ),
      WAIT,
    );
  });

  it("详情快捷编辑日期失败：沿用现有错误提示，已保存值不变", async () => {
    const user = await renderWithProjects();
    await goToFeatures(user);
    await user.click(screen.getByRole("button", { name: /^登录系统（/ }));
    const detail = screen.getByRole("region", { name: "登录系统 详情" });
    bridge.planningUpdateFeature.mockRejectedValue("写入失败");
    await user.click(within(detail).getByRole("textbox", { name: "修改 登录系统 的目标日期" }));
    await user.click(screen.getByRole("button", { name: "2026-11-20" }));

    await waitFor(
      () => expect(useUiStore.getState().toasts.some((t) => t.kind === "error")).toBe(true),
      WAIT,
    );
    expect(within(detail).getByRole("textbox", { name: "修改 登录系统 的目标日期" })).toHaveProperty(
      "value",
      "",
    );
  });

  it("未保存返回要保护：返回先出确认条，可继续编辑或放弃修改", async () => {
    const user = await renderWithProjects();
    await goToFeatures(user);
    await user.click(screen.getByRole("button", { name: "新增功能" }));
    const editor = await screen.findByRole("region", { name: "新增功能" }, WAIT);
    await user.type(within(editor).getByLabelText("功能名称"), "草稿标题");
    // 有未保存修改：返回不直接离开，先给页内确认条
    await user.click(within(editor).getByRole("button", { name: "返回功能列表" }));
    expect(within(editor).getByRole("alert").textContent).toContain("未保存");
    await user.click(within(editor).getByRole("button", { name: "继续编辑" }));
    expect(screen.getByRole("region", { name: "新增功能" })).toBeTruthy();
    expect((screen.getByLabelText("功能名称") as HTMLInputElement).value).toBe("草稿标题");
    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "放弃修改" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "新增功能" })).toBeNull());
  });

  it("连点保存只提交一次（同步防重入）", async () => {
    const user = await renderWithProjects();
    await goToFeatures(user);
    await user.click(screen.getByRole("button", { name: "新增功能" }));
    const editor = await screen.findByRole("region", { name: "新增功能" }, WAIT);
    await user.type(within(editor).getByLabelText("功能名称"), "只建一次");
    let resolveCreate: (v: PlanningFeature) => void = () => {};
    bridge.planningCreateFeature.mockImplementation(
      () => new Promise<PlanningFeature>((resolve) => { resolveCreate = resolve; }),
    );
    const submit = within(editor).getByRole("button", { name: "创建" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(bridge.planningCreateFeature).toHaveBeenCalledTimes(1), WAIT);
    resolveCreate(feat("f-once", "只建一次"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "新增功能" })).toBeNull(), WAIT);
  });

  it("返回列表后筛选条件保留", async () => {
    const user = await renderWithProjects();
    await goToFeatures(user);
    await user.type(screen.getByLabelText("搜索功能"), "数据库");
    expect(screen.queryByRole("button", { name: /^全局搜索（/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^登录系统（/ }));
    await user.click(screen.getByRole("button", { name: "编辑功能 登录系统" }));
    await screen.findByRole("region", { name: "编辑功能" }, WAIT);
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "编辑功能" })).toBeNull());
    expect((screen.getByLabelText("搜索功能") as HTMLInputElement).value).toBe("数据库");
    expect(screen.queryByRole("button", { name: /^全局搜索（/ })).toBeNull();
  });

  it("未拆分步骤显示「未拆分步骤」，不伪造百分比", async () => {
    const user = await renderWithProjects();
    await goToFeatures(user);
    const head = screen.getByRole("button", { name: /^全局搜索（/ });
    expect(within(head).getByText("未拆分步骤")).toBeTruthy();
    const withSteps = screen.getByRole("button", { name: /^登录系统（/ });
    expect(within(withSteps).getByText("步骤 1/2")).toBeTruthy();
  });

  it("状态筛选只显示对应功能（含受阻/暂停选项）", async () => {
    const user = await renderWithProjects();
    await goToFeatures(user);
    await user.click(screen.getByRole("combobox", { name: "按状态筛选" }));
    await user.click(screen.getByRole("option", { name: "待开发" }));
    expect(screen.getByRole("button", { name: /^全局搜索（/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^登录系统（/ })).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "按状态筛选" }));
    await user.click(screen.getByRole("option", { name: "开发中" }));
    expect(screen.getByRole("button", { name: /^登录系统（/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^全局搜索（/ })).toBeNull();
  });

  it("搜索匹配标题与步骤文本", async () => {
    const user = await renderWithProjects();
    await goToFeatures(user);
    await user.type(screen.getByLabelText("搜索功能"), "数据库");
    expect(screen.getByRole("button", { name: /^登录系统（/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^全局搜索（/ })).toBeNull();
  });

  it("功能列表加载失败显示重试入口", async () => {
    bridge.planningListProjects.mockResolvedValue([PROJECT_A]);
    bridge.planningListFeatures.mockRejectedValue("查询失败");
    bridge.planningListMilestones.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<PlanningCenterPanel />);
    await waitFor(() => expect(screen.getAllByText("我的应用").length).toBeGreaterThan(0), WAIT);
    await goToFeatures(user);
    await waitFor(() => expect(screen.getByText(/功能列表加载失败/)).toBeTruthy(), WAIT);
    bridge.planningListFeatures.mockResolvedValue([FEATURE_NO_STEPS]);
    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText("全局搜索")).toBeTruthy(), WAIT);
  });

  it("展开功能详情：步骤清单可勾选并即时反馈；验收标准独立展示", async () => {
    const user = await renderWithProjects();
    await goToFeatures(user);
    await user.click(screen.getByRole("button", { name: /^登录系统（/ }));
    const detail = screen.getByRole("region", { name: "登录系统 详情" });
    expect(within(detail).getByText("设计数据库")).toBeTruthy();
    // 无验收标准时给空态，不用步骤冒充
    expect(within(detail).getByText(/尚未填写验收标准/)).toBeTruthy();
    bridge.planningUpdateStep.mockResolvedValue({
      ...FEATURE_STEPS,
      step_done: 2,
      steps: FEATURE_STEPS.steps.map((s) => ({ ...s, done: true })),
    });
    await user.click(within(detail).getByRole("checkbox", { name: "完成步骤：实现接口" }));
    await waitFor(() => expect(bridge.planningUpdateStep).toHaveBeenCalledWith("s2", { done: true }), WAIT);
    await waitFor(() => expect(within(detail).getByText(/步骤 2\/2/)).toBeTruthy());
    // 步骤全完成但状态仍开发中（状态与步骤独立）
    expect(within(detail).getByRole("combobox", { name: "修改 登录系统 的开发状态" })).toBeTruthy();
  });
});

describe("功能看板", () => {
  it("状态切换到已完成：卡片移动到对应列", async () => {
    const user = await renderWithProjects();
    await user.click(screen.getByRole("tab", { name: "功能看板" }));
    await waitFor(() => expect(screen.getByText("登录系统")).toBeTruthy());
    bridge.planningUpdateFeature.mockResolvedValue({ ...FEATURE_STEPS, status: "completed" });
    await user.click(screen.getByRole("combobox", { name: "修改 登录系统 的状态" }));
    await user.click(screen.getByRole("option", { name: "已完成" }));
    await waitFor(() => expect(bridge.planningUpdateFeature).toHaveBeenCalledWith("f1", { status: "completed" }), WAIT);
    await waitFor(() => {
      const doneColumn = screen.getByRole("region", { name: "已完成" });
      expect(within(doneColumn).getByText("登录系统")).toBeTruthy();
    });
  });

  it("受阻状态不隐藏：计数入口可直接查看", async () => {
    const user = await renderWithProjects();
    await user.click(screen.getByRole("tab", { name: "功能看板" }));
    bridge.planningUpdateFeature.mockResolvedValue({ ...FEATURE_STEPS, status: "blocked" });
    await user.click(screen.getByRole("combobox", { name: "修改 登录系统 的状态" }));
    await user.click(screen.getByRole("option", { name: "受阻" }));
    await waitFor(() => expect(bridge.planningUpdateFeature).toHaveBeenCalled(), WAIT);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /受阻 1/ })).toBeTruthy(),
    );
    await user.click(screen.getByRole("button", { name: /受阻 1/ }));
    expect(screen.getByText("登录系统")).toBeTruthy();
    // 已暂停入口同样常驻
    expect(screen.getByRole("button", { name: /已暂停/ })).toBeTruthy();
  });
});

describe("里程碑", () => {
  const MS_EMPTY = ms("m2", "二期", 0, 0);
  const MS_OVERDUE = ms("m3", "旧计划", 1, 0, "2020-01-01");

  async function renderMilestoneProject() {
    bridge.planningListProjects.mockResolvedValue([PROJECT_A]);
    bridge.planningListFeatures.mockResolvedValue([
      { ...FEATURE_STEPS, milestone_id: "m1", milestone_name: "MVP" },
      { ...FEATURE_DONE, milestone_id: "m1", milestone_name: "MVP" },
      { ...FEATURE_NO_STEPS, milestone_id: "m3", milestone_name: "旧计划" },
    ]);
    bridge.planningListMilestones.mockResolvedValue([
      ms("m1", "MVP", 2, 1),
      MS_EMPTY,
      MS_OVERDUE,
    ]);
    const user = userEvent.setup();
    render(<PlanningCenterPanel />);
    await waitFor(() => expect(screen.getAllByText("我的应用").length).toBeGreaterThan(0), WAIT);
    return user;
  }

  it("时间轴显示关联数/完成率；无关联显示尚未关联功能；过期不自动完成", async () => {
    const user = await renderMilestoneProject();
    await user.click(screen.getByRole("tab", { name: "里程碑" }));
    expect(screen.getByText("MVP")).toBeTruthy();
    expect(screen.getByText("1/2 完成 · 50%")).toBeTruthy();
    expect(screen.getAllByText("尚未关联功能").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("已逾期")).toBeTruthy();
    expect(screen.queryByText("已完成")).toBeNull();
  });

  it("新建里程碑：页面内编辑态保存后回到时间轴；未保存返回受保护", async () => {
    const user = await renderMilestoneProject();
    await user.click(screen.getByRole("tab", { name: "里程碑" }));
    await user.click(screen.getByRole("button", { name: /新建里程碑/ }));
    const editor = await screen.findByRole("region", { name: "新建里程碑" }, WAIT);
    await user.type(within(editor).getByLabelText("里程碑名称"), "三期");
    // 未保存返回：先出确认条
    await user.click(within(editor).getByRole("button", { name: "返回里程碑列表" }));
    expect(within(editor).getByRole("alert").textContent).toContain("未保存");
    await user.click(within(editor).getByRole("button", { name: "继续编辑" }));
    bridge.planningCreateMilestone.mockResolvedValue(ms("m4", "三期"));
    await user.click(within(editor).getByRole("button", { name: "创建" }));
    await waitFor(() => expect(bridge.planningCreateMilestone).toHaveBeenCalled(), WAIT);
    await waitFor(
      () => expect(screen.queryByRole("region", { name: "新建里程碑" })).toBeNull(),
      WAIT,
    );
    expect(screen.getByText("三期")).toBeTruthy();
  });

  it("里程碑目标日期：选择后随创建提交", async () => {
    const user = await renderMilestoneProject();
    await user.click(screen.getByRole("tab", { name: "里程碑" }));
    await user.click(screen.getByRole("button", { name: /新建里程碑/ }));
    const editor = await screen.findByRole("region", { name: "新建里程碑" }, WAIT);
    await user.type(within(editor).getByLabelText("里程碑名称"), "有日期");
    await user.click(within(editor).getByRole("textbox", { name: "里程碑目标日期" }));
    await user.click(screen.getByRole("button", { name: "2026-11-20" }));

    bridge.planningCreateMilestone.mockResolvedValue(ms("m4", "有日期", 0, 0, "2026-11-20"));
    await user.click(within(editor).getByRole("button", { name: "创建" }));
    await waitFor(
      () =>
        expect(bridge.planningCreateMilestone).toHaveBeenCalledWith(
          "p1",
          expect.objectContaining({ target_date: "2026-11-20" }),
        ),
      WAIT,
    );
  });

  it("查看关联功能跳到功能视图并按里程碑筛选", async () => {
    const user = await renderMilestoneProject();
    await user.click(screen.getByRole("tab", { name: "里程碑" }));
    await user.click(screen.getAllByRole("button", { name: "查看关联功能" })[0]);
    await waitFor(() => expect(screen.getByRole("tab", { name: "功能列表" }).getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => expect(screen.getByRole("button", { name: /^登录系统（/ })).toBeTruthy(), WAIT);
    // 旧计划的关联功能不在 MVP 筛选结果里
    expect(screen.queryByRole("button", { name: /^全局搜索（/ })).toBeNull();
    expect(screen.getByRole("combobox", { name: "按里程碑筛选" })).toBeTruthy();
  });
});
