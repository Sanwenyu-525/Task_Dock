//! useWorkflowsStore 单元测试：mock bridge，验证读失败保留旧数据、请求代际防乱序、
//! 写命令就地更新、运行状态（active/activeRunDetail/终态清理）与历史分页错误路径。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowsStore } from "./useWorkflowsStore";
import type { Workflow, WorkflowDetail, WorkflowRunDetail } from "../lib/bridge";

const bridge = vi.hoisted(() => {
  return {
    workflowList: vi.fn(),
    workflowGet: vi.fn(),
    workflowCreate: vi.fn(),
    workflowUpdate: vi.fn(),
    workflowDelete: vi.fn(),
    workflowDuplicate: vi.fn(),
    workflowReorder: vi.fn(),
    workflowReplaceSteps: vi.fn(),
    workflowRun: vi.fn(),
    workflowPause: vi.fn(),
    workflowResume: vi.fn(),
    workflowCancel: vi.fn(),
    workflowActive: vi.fn(),
    workflowRunDetail: vi.fn(),
    workflowLastRunSummary: vi.fn(),
    workflowListRuns: vi.fn(),
  };
});

vi.mock("../lib/bridge", () => bridge);

function wf(id: string, stepCount = 2): Workflow {
  return {
    id,
    name: `工作流 ${id}`,
    description: "",
    enabled: true,
    sort_order: 0,
    step_count: stepCount,
    created_at: "2026-11-04T00:00:00Z",
    updated_at: "2026-11-04T00:00:00Z",
    last_run_at: null,
  };
}

function detail(id: string, steps: WorkflowDetail["steps"] = []): WorkflowDetail {
  return { ...wf(id), steps };
}

function runDetail(runId: string, workflowId: string, finishedAt: string | null): WorkflowRunDetail {
  return {
    id: runId,
    workflow_id: workflowId,
    workflow_name: "工作流 w1",
    status: finishedAt ? "completed" : "running",
    current_step_index: 0,
    total_steps: 2,
    completed_steps: finishedAt ? 2 : 1,
    started_at: "2026-11-04T00:00:00Z",
    finished_at: finishedAt,
    error: null,
    steps: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkflowsStore.setState({
    workflows: null,
    workflowsLoading: false,
    workflowsError: null,
    activeRun: null,
    activeRunDetail: null,
    lastRuns: {},
    history: { workflowId: null, page: null, loading: false, error: null },
  });
});

describe("loadWorkflows", () => {
  it("成功加载列表", async () => {
    bridge.workflowList.mockResolvedValue([wf("w1"), wf("w2")]);
    await useWorkflowsStore.getState().loadWorkflows();
    const s = useWorkflowsStore.getState();
    expect(s.workflows).toHaveLength(2);
    expect(s.workflowsLoading).toBe(false);
    expect(s.workflowsError).toBeNull();
  });

  it("失败保留旧数据并置 error（不用空列表冒充）", async () => {
    useWorkflowsStore.setState({ workflows: [wf("w-old")] });
    bridge.workflowList.mockRejectedValue("boom");
    await useWorkflowsStore.getState().loadWorkflows();
    const s = useWorkflowsStore.getState();
    expect(s.workflows).toHaveLength(1);
    expect(s.workflows?.[0].id).toBe("w-old");
    expect(s.workflowsError).toBe("boom");
  });

  it("代际防乱序：慢的旧响应被丢弃", async () => {
    let resolveA!: (v: Workflow[]) => void;
    bridge.workflowList.mockImplementationOnce(() => new Promise((r) => (resolveA = r)));
    const p1 = useWorkflowsStore.getState().loadWorkflows();
    bridge.workflowList.mockResolvedValueOnce([wf("w-new")]);
    await useWorkflowsStore.getState().loadWorkflows();
    expect(useWorkflowsStore.getState().workflows?.[0].id).toBe("w-new");
    resolveA([wf("w-stale")]);
    await p1;
    // 旧响应不得覆盖新响应
    expect(useWorkflowsStore.getState().workflows?.[0].id).toBe("w-new");
  });
});

describe("写命令就地更新", () => {
  it("saveSteps 更新 step_count 而不重拉列表", async () => {
    useWorkflowsStore.setState({ workflows: [wf("w1", 2)] });
    bridge.workflowReplaceSteps.mockResolvedValue(detail("w1", [
      {} as never,
      {} as never,
      {} as never,
    ]));
    const d = await useWorkflowsStore.getState().saveSteps("w1", []);
    expect(d.steps).toHaveLength(3);
    expect(bridge.workflowList).not.toHaveBeenCalled();
    expect(useWorkflowsStore.getState().workflows?.[0].step_count).toBe(3);
  });

  it("deleteWorkflow 移除条目与最近运行摘要", async () => {
    useWorkflowsStore.setState({
      workflows: [wf("w1"), wf("w2")],
      lastRuns: { w1: { run_id: "r", status: "completed", total_steps: 1, completed_steps: 1, error: null, started_at: "", started_at_local: "", finished_at: null } },
    });
    bridge.workflowDelete.mockResolvedValue(undefined);
    await useWorkflowsStore.getState().deleteWorkflow("w1");
    const s = useWorkflowsStore.getState();
    expect(s.workflows?.map((w) => w.id)).toEqual(["w2"]);
    expect(s.lastRuns.w1).toBeUndefined();
  });

  it("reorderWorkflows 本地重排（后端已落库）", async () => {
    useWorkflowsStore.setState({ workflows: [wf("a"), wf("b"), wf("c")] });
    bridge.workflowReorder.mockResolvedValue(undefined);
    await useWorkflowsStore.getState().reorderWorkflows(["c", "a", "b"]);
    expect(useWorkflowsStore.getState().workflows?.map((w) => w.id)).toEqual(["c", "a", "b"]);
  });

  it("写失败直接 throw 给调用方", async () => {
    bridge.workflowCreate.mockRejectedValue("校验失败: 名称不能为空");
    await expect(useWorkflowsStore.getState().createWorkflow({ name: "" })).rejects.toBe(
      "校验失败: 名称不能为空",
    );
  });
});

describe("运行状态", () => {
  it("runWorkflow 设置 activeRun 与 activeRunDetail", async () => {
    bridge.workflowRun.mockResolvedValue(runDetail("r1", "w1", null));
    await useWorkflowsStore.getState().runWorkflow("w1");
    const s = useWorkflowsStore.getState();
    expect(s.activeRun?.run_id).toBe("r1");
    expect(s.activeRun?.workflow_id).toBe("w1");
    expect(s.activeRunDetail?.id).toBe("r1");
    expect(bridge.workflowLastRunSummary).toHaveBeenCalledWith("w1");
  });

  it("applyProgress：进行中事件更新详情；终态事件清空 activeRun", () => {
    useWorkflowsStore.setState({
      activeRun: { run_id: "r1", workflow_id: "w1", paused: false, cancel_requested: false },
    });
    useWorkflowsStore.getState().applyProgress(runDetail("r1", "w1", null));
    expect(useWorkflowsStore.getState().activeRun).not.toBeNull();
    expect(useWorkflowsStore.getState().activeRunDetail?.completed_steps).toBe(1);

    useWorkflowsStore.getState().applyProgress(runDetail("r1", "w1", "2026-11-04T01:00:00Z"));
    expect(useWorkflowsStore.getState().activeRun).toBeNull();
    expect(useWorkflowsStore.getState().activeRunDetail?.status).toBe("completed");
  });

  it("applyProgress：无关运行的进行中事件不落地", () => {
    useWorkflowsStore.setState({ activeRun: null, activeRunDetail: null });
    useWorkflowsStore.getState().applyProgress(runDetail("r-other", "w2", null));
    expect(useWorkflowsStore.getState().activeRunDetail).toBeNull();
  });

  it("pause/resume/cancel 更新 activeRun 标志位", async () => {
    useWorkflowsStore.setState({
      activeRun: { run_id: "r1", workflow_id: "w1", paused: false, cancel_requested: false },
    });
    bridge.workflowPause.mockResolvedValue(runDetail("r1", "w1", null));
    await useWorkflowsStore.getState().pauseWorkflow("w1");
    expect(useWorkflowsStore.getState().activeRun?.paused).toBe(true);
    bridge.workflowResume.mockResolvedValue(runDetail("r1", "w1", null));
    await useWorkflowsStore.getState().resumeWorkflow("w1");
    expect(useWorkflowsStore.getState().activeRun?.paused).toBe(false);
    bridge.workflowCancel.mockResolvedValue(runDetail("r1", "w1", null));
    await useWorkflowsStore.getState().cancelWorkflow("w1");
    expect(useWorkflowsStore.getState().activeRun?.cancel_requested).toBe(true);
  });

  it("refreshActive：无活动运行时清空详情", async () => {
    useWorkflowsStore.setState({
      activeRun: { run_id: "r1", workflow_id: "w1", paused: false, cancel_requested: false },
      activeRunDetail: runDetail("r1", "w1", null),
    });
    bridge.workflowActive.mockResolvedValue(null);
    await useWorkflowsStore.getState().refreshActive();
    expect(useWorkflowsStore.getState().activeRun).toBeNull();
    expect(useWorkflowsStore.getState().activeRunDetail).toBeNull();
  });
});

describe("运行历史分页", () => {
  it("加载失败置 error 且保留分页结构", async () => {
    bridge.workflowListRuns.mockRejectedValue("db locked");
    await useWorkflowsStore.getState().loadHistoryPage("w1", 0);
    const h = useWorkflowsStore.getState().history;
    expect(h.error).toBe("db locked");
    expect(h.loading).toBe(false);
  });

  it("clearHistory 清空状态", () => {
    useWorkflowsStore.setState({
      history: { workflowId: "w1", page: { items: [], total: 0, limit: 20, offset: 0 }, loading: false, error: null },
    });
    useWorkflowsStore.getState().clearHistory();
    expect(useWorkflowsStore.getState().history.workflowId).toBeNull();
  });
});
