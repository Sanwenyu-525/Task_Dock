/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioDetail, ScenarioEnterResult, ScenarioSummary, WorkflowRunDetail, WorkspaceRestoreProgress } from "../lib/bridge";

const { scenarioDelete, scenarioDuplicate, scenarioEnter, scenarioGet, scenarioList, scenarioSave } = vi.hoisted(() => ({
  scenarioDelete: vi.fn(),
  scenarioDuplicate: vi.fn(),
  scenarioEnter: vi.fn(),
  scenarioGet: vi.fn(),
  scenarioList: vi.fn(),
  scenarioSave: vi.fn(),
}));

vi.mock("../lib/bridge", () => ({
  scenarioDelete: (...args: unknown[]) => scenarioDelete(...args),
  scenarioDuplicate: (...args: unknown[]) => scenarioDuplicate(...args),
  scenarioEnter: (...args: unknown[]) => scenarioEnter(...args),
  scenarioGet: (...args: unknown[]) => scenarioGet(...args),
  scenarioList: (...args: unknown[]) => scenarioList(...args),
  scenarioSave: (...args: unknown[]) => scenarioSave(...args),
}));

import { useScenarioStore, scenarioItemProgressKey } from "./useScenarioStore";

const summary: ScenarioSummary = {
  id: "scene-1",
  name: "写作场景",
  icon: null,
  appCount: 0,
  urlCount: 0,
  folderCount: 0,
  linkedWorkflowId: "workflow-1",
  lastEnteredAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function workflowProgress(overrides: Partial<WorkflowRunDetail> = {}): WorkflowRunDetail {
  return {
    id: "run-1",
    workflow_id: "workflow-1",
    workflow_name: "写作流程",
    status: "running",
    current_step_index: 0,
    total_steps: 1,
    completed_steps: 0,
    started_at: "2026-01-01T00:00:00Z",
    finished_at: null,
    error: null,
    steps: [],
    ...overrides,
  };
}

beforeEach(() => {
  scenarioDelete.mockReset();
  scenarioDuplicate.mockReset();
  scenarioEnter.mockReset();
  scenarioGet.mockReset();
  scenarioList.mockReset();
  scenarioSave.mockReset();
  scenarioList.mockResolvedValue([summary]);
  useScenarioStore.setState({
    summaries: [], loading: false, loaded: false, error: null,
    enteringId: null, editing: null, results: {}, progressByItem: {},
    activeSnapshotId: null, activeWorkflowId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useScenarioStore", () => {
  it("保存场景时只提交暂存架稳定 ID，不调用文件复制或删除接口", async () => {
    const input = {
      name: "带资料的场景",
      apps: [],
      urls: [],
      folders: [],
      shelfItemIds: ["shelf-file-1", "shelf-folder-2"],
    };
    scenarioSave.mockResolvedValue({ id: "scene-1" });

    await useScenarioStore.getState().save(input);

    expect(scenarioSave).toHaveBeenCalledWith(input);
    expect(scenarioDelete).not.toHaveBeenCalled();
    expect(scenarioList).toHaveBeenCalled();
  });

  it("进入前读取软引用并执行单飞，保留实际逐项结果", async () => {
    useScenarioStore.setState({ summaries: [summary] });
    scenarioGet.mockResolvedValue({ ...summary, apps: [], urls: [], folders: [], snapshotId: "snapshot-1" });
    const result: ScenarioEnterResult = {
      startedAt: "2026-01-01T00:00:00Z",
      items: [
        { kind: "snapshot", label: "snapshot-1", status: "ok" },
        { kind: "workflow", label: "workflow-1", status: "failed", detail: "工作流槽已占用" },
      ],
    };
    let resolveEnter: (value: ScenarioEnterResult) => void = () => undefined;
    scenarioEnter.mockReturnValue(new Promise((resolve) => { resolveEnter = resolve; }));

    const first = useScenarioStore.getState().enter("scene-1");
    const second = await useScenarioStore.getState().enter("scene-1");
    expect(second).toBeNull();
    expect(scenarioGet).toHaveBeenCalledTimes(1);
    expect(scenarioEnter).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(scenarioEnter).toHaveBeenCalledTimes(1));
    resolveEnter(result);
    await expect(first).resolves.toEqual(result);
    expect(useScenarioStore.getState().results["scene-1"]).toEqual(result);
    expect(useScenarioStore.getState().activeSnapshotId).toBeNull();
  });

  it("使用现场与工作流的现有事件把已受理状态推进到真实终态", () => {
    const result: ScenarioEnterResult = {
      startedAt: "2026-01-01T00:00:00Z",
      items: [
        { kind: "snapshot", label: "snapshot-1", status: "ok" },
        { kind: "workflow", label: "workflow-1", status: "ok" },
      ],
    };
    useScenarioStore.setState({ results: { "scene-1": result } });

    const restoreEvent: WorkspaceRestoreProgress = {
      snapshot_id: "snapshot-1",
      index: 2,
      total: 2,
      phase: "done",
      summary: {
        snapshot_id: "snapshot-1",
        total: 2,
        restored: 1,
        failed: 1,
        skipped: 0,
        cancelled: 0,
        items: [],
      },
    };
    useScenarioStore.getState().applyRestoreProgress(restoreEvent);
    expect(useScenarioStore.getState().progressByItem[scenarioItemProgressKey("snapshot", "snapshot-1")]).toMatchObject({
      status: "partial",
      detail: "恢复 1，跳过 0，失败 1，取消 0",
    });

    useScenarioStore.getState().applyWorkflowProgress(workflowProgress());
    expect(useScenarioStore.getState().progressByItem[scenarioItemProgressKey("workflow", "workflow-1")].status).toBe("running");
    useScenarioStore.getState().applyWorkflowProgress(workflowProgress({
      status: "cancelled",
      finished_at: "2026-01-01T00:01:00Z",
    }));
    expect(useScenarioStore.getState().progressByItem[scenarioItemProgressKey("workflow", "workflow-1")].status).toBe("cancelled");
  });

  // ── P1-03 场景单飞边界（失败释放/快速重复/删除清理）──
  it("scenarioGet 失败释放单飞锁，后续进入可继续", async () => {
    useScenarioStore.setState({ summaries: [summary] });
    scenarioGet.mockRejectedValueOnce(new Error("get failed"));
    await expect(useScenarioStore.getState().enter("scene-1")).rejects.toThrow("get failed");
    expect(useScenarioStore.getState().enteringId).toBeNull();
    expect(scenarioEnter).not.toHaveBeenCalled();
    expect(useScenarioStore.getState().error).toContain("get failed");
    // 锁已释放：下一次进入能发起新的读取
    scenarioGet.mockResolvedValueOnce({ ...summary, apps: [], urls: [], folders: [], snapshotId: null });
    const result: ScenarioEnterResult = { startedAt: "2026-01-01T00:00:00Z", items: [] };
    scenarioEnter.mockResolvedValueOnce(result);
    await expect(useScenarioStore.getState().enter("scene-1")).resolves.toEqual(result);
    expect(useScenarioStore.getState().enteringId).toBeNull();
  });

  it("scenarioEnter 失败释放单飞锁并保留错误", async () => {
    useScenarioStore.setState({ summaries: [summary] });
    scenarioGet.mockResolvedValueOnce({ ...summary, apps: [], urls: [], folders: [], snapshotId: "snapshot-1" });
    scenarioEnter.mockRejectedValueOnce(new Error("enter failed"));
    await expect(useScenarioStore.getState().enter("scene-1")).rejects.toThrow("enter failed");
    expect(useScenarioStore.getState().enteringId).toBeNull();
    expect(useScenarioStore.getState().activeSnapshotId).toBeNull();
    expect(useScenarioStore.getState().error).toContain("enter failed");
  });

  it("快速重复与不同场景并发均被全局单飞拒绝，不重复调用后端", async () => {
    useScenarioStore.setState({ summaries: [summary, { ...summary, id: "scene-2", name: "第二场景" }] });
    const pendingGet = { resolve: (_value: ScenarioDetail) => {} };
    const getPromise: Promise<ScenarioDetail> = new Promise((resolve) => { pendingGet.resolve = resolve; });
    scenarioGet.mockReturnValue(getPromise as unknown);
    scenarioEnter.mockResolvedValue({ startedAt: "2026-01-01T00:00:00Z", items: [] });
    const first = useScenarioStore.getState().enter("scene-1");
    const second = await useScenarioStore.getState().enter("scene-1");
    const third = await useScenarioStore.getState().enter("scene-2");
    expect(second).toBeNull();
    expect(third).toBeNull();
    expect(scenarioGet).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(useScenarioStore.getState().enteringId).toBe("scene-1"));
    const detail: ScenarioDetail = {
      ...summary,
      apps: [],
      urls: [],
      folders: [],
      snapshotId: null,
      shelfItemIds: [],
    };
    pendingGet.resolve(detail);
    await expect(first).resolves.toMatchObject({ startedAt: expect.any(String) });
    expect(scenarioEnter).toHaveBeenCalledTimes(1);
    expect(useScenarioStore.getState().enteringId).toBeNull();
  });

  it("成功后列表刷新不覆盖进入结果", async () => {
    useScenarioStore.setState({ summaries: [summary] });
    scenarioGet.mockResolvedValueOnce({ ...summary, apps: [], urls: [], folders: [], snapshotId: "snapshot-1" });
    const result: ScenarioEnterResult = { startedAt: "2026-01-01T00:00:00Z", items: [] };
    scenarioEnter.mockResolvedValueOnce(result);
    scenarioList.mockResolvedValueOnce([summary]);
    await useScenarioStore.getState().enter("scene-1");
    expect(useScenarioStore.getState().results["scene-1"]).toEqual(result);
    expect(scenarioList).toHaveBeenCalled();
  });

  it("删除场景清理其进入结果与编辑态", async () => {
    scenarioDelete.mockResolvedValue(undefined);
    scenarioList.mockResolvedValueOnce([]);
    useScenarioStore.setState({
      summaries: [summary],
      results: { "scene-1": { startedAt: "2026-01-01T00:00:00Z", items: [] } },
      editing: {
        ...summary,
        apps: [],
        urls: [],
        folders: [],
        snapshotId: null,
        shelfItemIds: [],
      },
    });
    await useScenarioStore.getState().remove("scene-1");
    expect(useScenarioStore.getState().results["scene-1"]).toBeUndefined();
    expect(useScenarioStore.getState().editing).toBeNull();
  });
});
