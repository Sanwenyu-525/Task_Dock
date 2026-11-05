//! 工作流运行 / 历史 store 行为测试：
//! 活动运行切页不消失、进度按 store 落地、历史快速切换丢弃旧响应。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listRuns = vi.fn();
const run = vi.fn();
const active = vi.fn();
const runDetail = vi.fn();
const lastSummary = vi.fn();

vi.mock("../lib/bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/bridge")>(),
  workflowListRuns: (...a: unknown[]) => listRuns(...a),
  workflowRun: (...a: unknown[]) => run(...a),
  workflowActive: (...a: unknown[]) => active(...a),
  workflowRunDetail: (...a: unknown[]) => runDetail(...a),
  workflowLastRunSummary: (...a: unknown[]) => lastSummary(...a),
}));

import { useWorkflowsStore } from "./useWorkflowsStore";
import type { WorkflowRun, WorkflowRunDetail, WorkflowRunPage } from "../lib/bridge";

function runRow(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "r1",
    workflow_id: "w1",
    workflow_name: "早间准备",
    status: "running",
    current_step_index: 0,
    total_steps: 2,
    completed_steps: 0,
    started_at: "2026-11-01T00:00:00Z",
    finished_at: null,
    error: null,
    ...overrides,
  };
}

function runDetailRow(overrides: Partial<WorkflowRunDetail> = {}): WorkflowRunDetail {
  return {
    ...runRow(),
    steps: [
      {
        id: "rs1",
        run_id: "r1",
        step_id: "s1",
        step_type: "create_task",
        display_order: 0,
        status: "running",
        detail: "执行中",
        result: null,
        started_at: "2026-11-01T00:00:00Z",
        finished_at: null,
        operation_id: "op1",
      },
    ],
    ...overrides,
  };
}

function page(items: WorkflowRun[]): WorkflowRunPage {
  return { items, total: items.length, limit: 20, offset: 0 };
}

beforeEach(() => {
  listRuns.mockReset();
  run.mockReset().mockResolvedValue(runDetailRow());
  active.mockReset().mockResolvedValue(null);
  runDetail.mockReset().mockResolvedValue(runDetailRow());
  lastSummary.mockReset().mockResolvedValue(null);
  useWorkflowsStore.setState({
    workflows: null,
    activeRun: null,
    activeRunDetail: null,
    lastRuns: {},
    history: { workflowId: null, page: null, loading: false, error: null },
  });
});

afterEach(() => {
  useWorkflowsStore.setState({ activeRun: null, activeRunDetail: null });
  vi.clearAllMocks();
});

describe("活动运行", () => {
  it("启动后活动运行与详情写入 store；离开页面不产生取消", async () => {
    await useWorkflowsStore.getState().runWorkflow("w1");

    expect(useWorkflowsStore.getState().activeRun).toMatchObject({
      run_id: "r1",
      workflow_id: "w1",
    });
    expect(useWorkflowsStore.getState().activeRunDetail?.id).toBe("r1");
    // 没有任何视图卸载会调用取消：后台执行继续由后端和 store 持有
    expect(useWorkflowsStore.getState().activeRun?.cancel_requested).toBe(false);
  });

  it("进度事件更新当前运行详情；终态后清空活动槽但保留结果", () => {
    useWorkflowsStore.setState({ activeRun: { run_id: "r1", workflow_id: "w1", paused: false, cancel_requested: false } });

    useWorkflowsStore.getState().applyProgress(runDetailRow());
    expect(useWorkflowsStore.getState().activeRunDetail?.completed_steps).toBe(0);

    const finished = runDetailRow({
      status: "completed",
      completed_steps: 2,
      finished_at: "2026-11-01T00:00:05Z",
    });
    useWorkflowsStore.getState().applyProgress(finished);
    expect(useWorkflowsStore.getState().activeRun).toBeNull();
    expect(useWorkflowsStore.getState().activeRunDetail?.status).toBe("completed");
  });
});

describe("历史分页", () => {
  it("快速切换工作流：旧请求晚到也不覆盖新工作流历史", async () => {
    let resolveA: (v: WorkflowRunPage) => void = () => {};
    let resolveB: (v: WorkflowRunPage) => void = () => {};
    listRuns
      .mockImplementationOnce(() => new Promise<WorkflowRunPage>((r) => { resolveA = r; }))
      .mockImplementationOnce(() => new Promise<WorkflowRunPage>((r) => { resolveB = r; }));

    const first = useWorkflowsStore.getState().loadHistoryPage("w1", 0);
    const second = useWorkflowsStore.getState().loadHistoryPage("w2", 0);

    resolveB(page([runRow({ id: "r2", workflow_id: "w2" })]));
    await second;
    expect(useWorkflowsStore.getState().history.workflowId).toBe("w2");
    expect(useWorkflowsStore.getState().history.page?.items[0].workflow_id).toBe("w2");

    // 旧请求随后返回：直接丢弃，不能把历史串回 w1
    resolveA(page([runRow({ id: "r1", workflow_id: "w1" })]));
    await first;
    expect(useWorkflowsStore.getState().history.workflowId).toBe("w2");
    expect(useWorkflowsStore.getState().history.page?.items[0].workflow_id).toBe("w2");
  });

  it("翻页失败保留目标工作流标识并给出错误，不清空为其他工作流", async () => {
    listRuns.mockRejectedValueOnce(new Error("查询超时"));
    await useWorkflowsStore.getState().loadHistoryPage("w1", 20);

    const history = useWorkflowsStore.getState().history;
    expect(history.workflowId).toBe("w1");
    expect(history.loading).toBe(false);
    expect(history.error).toContain("查询超时");
    expect(history.page).toBeNull();
  });

  it("clearHistory 释放历史查询结果", async () => {
    listRuns.mockResolvedValueOnce(page([runRow()]));
    await useWorkflowsStore.getState().loadHistoryPage("w1", 0);
    useWorkflowsStore.getState().clearHistory();
    expect(useWorkflowsStore.getState().history).toEqual({
      workflowId: null,
      page: null,
      loading: false,
      error: null,
    });
  });
});
