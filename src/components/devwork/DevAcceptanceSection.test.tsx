/**
 * @vitest-environment jsdom
 */
//! DevAcceptanceSection（验收工作台区块）交互测试：
//! 1. 派生状态徽章：无记录+feature in_progress → 开发中；最新 fail → 验收不通过；
//!    pass → 验收通过；not_verified → 等待验收 + 证据不足提示；
//! 2. summary 为空：四个验收动作禁用；
//! 3. 创建记录成功：dev_acceptance_record_create 参数正确，成功后刷新历史；
//! 4. 证据登记：加入/移除草稿项；
//! 5. 返工提示词：最新 fail 时可用，剪贴板文本包含标题/原因/验收标准；
//! 6. 创建返工任务：调用 create_task，标题为「【返工】…」；
//! 7. 历史记录无更新/删除入口（追加式）；
//! 8. feature 查询失败：如实显示失败提示，不伪造「无关联」。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useLocaleStore } from "../../i18n";
import DevAcceptanceSection from "./DevAcceptanceSection";
import type {
  DevAcceptanceRecord,
  PlanningAgentFeatureLink,
  PlanningFeature,
  Task,
  TaskAgentLink,
} from "../../lib/bridge";

const FIX_TASK: Task = {
  id: "t1",
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

const FIX_FEATURE: PlanningFeature = {
  id: "f1",
  project_id: "prj1",
  title: "采集管线加固",
  description: "",
  acceptance_criteria: "waiting/failed 不合并\n采集丢弃必须计数",
  status: "in_progress",
  priority: "P1",
  milestone_id: null,
  milestone_name: null,
  target_date: null,
  sort_order: 0,
  created_at: "2026-11-12T00:00:00Z",
  updated_at: "2026-11-12T00:00:00Z",
  completed_at: null,
  steps: [],
  step_total: 0,
  step_done: 0,
};

const FIX_LINK: TaskAgentLink = {
  id: "l1",
  task_id: "t1",
  source_id: "codex",
  session_external_id: "sess-1",
  run_external_id: null,
  created_at: "2026-11-12T00:00:00Z",
  available: true,
};

const FIX_FEATURE_LINK: PlanningAgentFeatureLink = {
  id: "fl1",
  feature_id: "f1",
  feature_title: "采集管线加固",
  project_id: "prj1",
  project_name: "Task Dock",
  agent_source: "codex",
  agent_name: "Codex",
  session_id: "sess-1",
  status: "linked",
  agent_status: null,
  agent_session_id: "sess-1",
  last_seen_at: null,
  last_execution_at: null,
};

function record(patch: Partial<DevAcceptanceRecord>): DevAcceptanceRecord {
  return {
    id: "r1",
    subjectKind: "task",
    subjectId: "t1",
    verdict: "pass",
    summary: "全部通过",
    evidence: "",
    createdAt: "2026-11-12T09:00:00Z",
    ...patch,
  };
}

const {
  fetchTask,
  listTaskLinks,
  planningListAgentFeatureLinks,
  planningListFeatures,
  devAcceptanceRecordList,
  devAcceptanceRecordCreate,
  createTask,
  copyText,
} = vi.hoisted(() => ({
  fetchTask: vi.fn(),
  listTaskLinks: vi.fn(),
  planningListAgentFeatureLinks: vi.fn(),
  planningListFeatures: vi.fn(),
  devAcceptanceRecordList: vi.fn(),
  devAcceptanceRecordCreate: vi.fn(),
  createTask: vi.fn(),
  copyText: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    fetchTask,
    listTaskLinks,
    planningListAgentFeatureLinks,
    planningListFeatures,
    devAcceptanceRecordList,
    devAcceptanceRecordCreate,
    createTask,
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({
      ...(useSettingsStore.getState().settings ?? {}),
      ...patch,
    })),
    getSettings: vi.fn(async () => useSettingsStore.getState().settings ?? {}),
  };
});

vi.mock("../../lib/clipboard", () => ({
  copyText: (...a: unknown[]) => copyText(...a),
}));

function seedSettings(patch: Record<string, unknown> = {}) {
  useSettingsStore.setState({
    settings: {
      ...(useSettingsStore.getState().settings ?? {}),
      theme: "system",
      mode: "full",
      ...patch,
    } as never,
  });
}

/** 默认可信数据：任务 + 一条会话关联 + 功能详情 + 空记录。 */
function seedHappyPath() {
  fetchTask.mockResolvedValue(FIX_TASK);
  listTaskLinks.mockResolvedValue([FIX_LINK]);
  planningListAgentFeatureLinks.mockResolvedValue([FIX_FEATURE_LINK]);
  planningListFeatures.mockResolvedValue([FIX_FEATURE]);
  devAcceptanceRecordList.mockResolvedValue({ records: [] });
}

beforeEach(() => {
  useLocaleStore.setState({ locale: "zh-CN", preference: "zh-CN" });
  useUiStore.setState({ toasts: [], toast: null });
  seedSettings({ workbench_current_task: "t1" });
  seedHappyPath();
  devAcceptanceRecordCreate.mockImplementation(async (input: { summary: string }) => ({
    record: record({ id: "r-new", summary: input.summary, createdAt: "2026-11-12T10:00:00Z" }),
  }));
  createTask.mockImplementation(async (input: { title: string }) => ({
    ...FIX_TASK,
    id: "t-rework",
    title: input.title,
  }));
  copyText.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useSettingsStore.setState({ settings: null });
});

describe("DevAcceptanceSection · 派生状态徽章", () => {
  it("无记录 + feature in_progress → 开发中", async () => {
    render(<DevAcceptanceSection />);
    expect(await screen.findByText("开发中")).toBeTruthy();
  });

  it("最新判定 fail → 验收不通过（覆盖 feature 状态）", async () => {
    devAcceptanceRecordList.mockResolvedValue({
      records: [record({ verdict: "fail", summary: "测试未跑", createdAt: "2026-11-12T09:00:00Z" })],
    });
    render(<DevAcceptanceSection />);
    // 徽章 / 历史徽章 / 动作按钮共用同一文案：断言至少出现一次即可
    expect((await screen.findAllByText("验收不通过")).length).toBeGreaterThanOrEqual(1);
  });

  it("最新判定 pass → 验收通过", async () => {
    devAcceptanceRecordList.mockResolvedValue({ records: [record({})] });
    render(<DevAcceptanceSection />);
    expect((await screen.findAllByText("验收通过")).length).toBeGreaterThanOrEqual(1);
  });

  it("最新判定 not_verified → 等待验收 + 证据不足提示", async () => {
    devAcceptanceRecordList.mockResolvedValue({
      records: [record({ verdict: "not_verified", summary: "没跑测试" })],
    });
    render(<DevAcceptanceSection />);
    expect(await screen.findByText("等待验收")).toBeTruthy();
    expect(screen.getByText(/不能视为通过或失败/)).toBeTruthy();
  });

  it("未设置当前任务：空态文案，不显示验收动作", async () => {
    seedSettings({ workbench_current_task: "" });
    render(<DevAcceptanceSection />);
    expect(await screen.findByText(/未设置当前任务/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "验收通过" })).toBeNull();
  });
});

describe("DevAcceptanceSection · 验收动作与证据", () => {
  it("summary 为空：四个验收动作禁用", async () => {
    render(<DevAcceptanceSection />);
    await screen.findByText("验收工作台");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "验收通过" })).toHaveProperty("disabled", true);
    });
    expect(screen.getByRole("button", { name: "验收不通过" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "阻塞" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "未验证" })).toHaveProperty("disabled", true);
  });

  it("填写 summary 后创建记录：参数正确，成功后清空输入并刷新历史", async () => {
    render(<DevAcceptanceSection />);
    await screen.findByText("验收工作台");
    const summaryInput = screen.getByLabelText("验收结论摘要（必填）") as HTMLInputElement;
    await waitFor(() => expect(screen.getByRole("button", { name: "验收通过" })).toBeTruthy());
    fireEvent.change(summaryInput, { target: { value: "npm test 全量通过" } });
    fireEvent.click(screen.getByRole("button", { name: "验收通过" }));
    await waitFor(() => {
      expect(devAcceptanceRecordCreate).toHaveBeenCalledWith({
        subjectKind: "task",
        subjectId: "t1",
        verdict: "pass",
        summary: "npm test 全量通过",
        evidence: [],
      });
    });
    // 创建成功后重读记录列表
    await waitFor(() => {
      expect(devAcceptanceRecordList.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect((summaryInput as HTMLInputElement).value).toBe("");
  });

  it("证据登记：加入草稿后可移除", async () => {
    render(<DevAcceptanceSection />);
    await screen.findByText("验收工作台");
    const input = screen.getByLabelText("证据描述") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "npm test 3553/3554 通过（2026-11-12）" } });
    fireEvent.click(screen.getByRole("button", { name: "登记证据" }));
    expect(await screen.findByText("npm test 3553/3554 通过（2026-11-12）")).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "移除该条证据" }));
    await waitFor(() => {
      expect(screen.queryByText("npm test 3553/3554 通过（2026-11-12）")).toBeNull();
    });
  });

  it("创建记录失败：Toast 报错 + 输入保留", async () => {
    devAcceptanceRecordCreate.mockRejectedValue(new Error("db locked"));
    render(<DevAcceptanceSection />);
    await screen.findByText("验收工作台");
    fireEvent.change(screen.getByLabelText("验收结论摘要（必填）"), {
      target: { value: "结论" },
    });
    fireEvent.click(screen.getByRole("button", { name: "验收通过" }));
    // 失败走既有 Toast 通道（本测试只挂区块，断言 store 里的真实 toast 内容）
    await waitFor(() => {
      expect(
        useUiStore.getState().toasts.some((t) => t.message.includes("保存验收记录失败")),
      ).toBe(true);
    });
    expect((screen.getByLabelText("验收结论摘要（必填）") as HTMLInputElement).value).toBe("结论");
  });
});

describe("DevAcceptanceSection · 验收标准与关联展示", () => {
  it("关联功能的 acceptance_criteria 只读展示", async () => {
    render(<DevAcceptanceSection />);
    expect(await screen.findByText("waiting/failed 不合并")).toBeTruthy();
    expect(screen.getByText("采集丢弃必须计数")).toBeTruthy();
    expect(screen.getByText(/关联功能：采集管线加固/)).toBeTruthy();
  });

  it("feature 查询失败：如实显示失败提示", async () => {
    planningListAgentFeatureLinks.mockRejectedValue(new Error("boom"));
    render(<DevAcceptanceSection />);
    expect(await screen.findByText(/关联规划功能查询失败/)).toBeTruthy();
  });

  it("feature 无 criteria 时可手动添加标准", async () => {
    planningListFeatures.mockResolvedValue([{ ...FIX_FEATURE, acceptance_criteria: "" }]);
    render(<DevAcceptanceSection />);
    await screen.findByText(/未填写验收标准/);
    const input = screen.getByLabelText("验收标准描述") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "手工标准 A" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(await screen.findByText("手工标准 A")).toBeTruthy();
  });
});

describe("DevAcceptanceSection · 返工", () => {
  it("最新判定为 fail：返工提示词文本包含标题/原因/验收标准，复制走 copyText", async () => {
    devAcceptanceRecordList.mockResolvedValue({
      records: [record({ verdict: "fail", summary: "采集丢弃未计数", createdAt: "2026-11-12T09:00:00Z" })],
    });
    render(<DevAcceptanceSection />);
    const btn = await screen.findByRole("button", { name: "生成返工提示词" });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledTimes(1);
    });
    const text = copyText.mock.calls[0][0] as string;
    expect(text).toContain("针对任务「重构剪贴板模块」的返工请求：");
    expect(text).toContain("验收不通过原因：\n采集丢弃未计数");
    expect(text).toContain("验收标准：\nwaiting/failed 不合并");
    expect(text).toContain("请修复后重新提交验收。");
  });

  it("最新判定非 fail：不出现返工入口", async () => {
    render(<DevAcceptanceSection />);
    await screen.findByText("开发中");
    expect(screen.queryByRole("button", { name: "生成返工提示词" })).toBeNull();
    expect(screen.queryByRole("button", { name: "创建返工任务" })).toBeNull();
  });

  it("创建返工任务：调用 create_task，标题「【返工】…」", async () => {
    devAcceptanceRecordList.mockResolvedValue({
      records: [record({ verdict: "fail", summary: "采集丢弃未计数" })],
    });
    render(<DevAcceptanceSection />);
    fireEvent.click(await screen.findByRole("button", { name: "创建返工任务" }));
    await waitFor(() => {
      expect(createTask).toHaveBeenCalledWith({
        title: "【返工】重构剪贴板模块",
        description: "采集丢弃未计数",
      });
    });
  });
});

describe("DevAcceptanceSection · 追加式历史", () => {
  it("历史倒序展示 verdict 徽章 + summary + 证据 + 时间；无更新/删除入口", async () => {
    devAcceptanceRecordList.mockResolvedValue({
      records: [
        record({ id: "r1", verdict: "pass", summary: "先记录", createdAt: "2026-11-12T09:00:00Z" }),
        record({
          id: "r2",
          verdict: "fail",
          summary: "后记录",
          evidence: "npm test 失败\n截图见附件",
          createdAt: "2026-11-12T10:00:00Z",
        }),
      ],
    });
    render(<DevAcceptanceSection />);
    // 倒序：较新的先出现（DOM 顺序）
    const records = await screen.findAllByText(/记录$/);
    expect(records[0].textContent).toBe("后记录");
    expect(records[1].textContent).toBe("先记录");
    expect(screen.getByText(/npm test 失败/)).toBeTruthy();
    // 追加式：历史记录区没有任何「编辑 / 删除」按钮
    expect(screen.queryAllByRole("button", { name: "删除" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "编辑" })).toHaveLength(0);
  });
});
