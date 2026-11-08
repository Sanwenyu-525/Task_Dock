/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenarioDetail, ScenarioEnterResult, ScenarioSummary, WorkflowRunDetail, WorkspaceRestoreProgress } from "../lib/bridge";

const { scenarioDelete, scenarioDuplicate, scenarioEnter, scenarioEnterCancel, scenarioGet, scenarioList, scenarioSave } = vi.hoisted(() => ({
  scenarioDelete: vi.fn(),
  scenarioDuplicate: vi.fn(),
  scenarioEnter: vi.fn(),
  scenarioEnterCancel: vi.fn(),
  scenarioGet: vi.fn(),
  scenarioList: vi.fn(),
  scenarioSave: vi.fn(),
}));

vi.mock("../lib/bridge", () => ({
  scenarioDelete: (...args: unknown[]) => scenarioDelete(...args),
  scenarioDuplicate: (...args: unknown[]) => scenarioDuplicate(...args),
  scenarioEnter: (...args: unknown[]) => scenarioEnter(...args),
  scenarioEnterCancel: (...args: unknown[]) => scenarioEnterCancel(...args),
  scenarioGet: (...args: unknown[]) => scenarioGet(...args),
  scenarioList: (...args: unknown[]) => scenarioList(...args),
  scenarioSave: (...args: unknown[]) => scenarioSave(...args),
}));

import { useScenarioStore, scenarioItemProgressKey, geometryProgressDetail } from "./useScenarioStore";

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

/** 进入结果夹具：默认完整处理（items 即全部），取消/超时用 overrides 表达。 */
function enterResult(items: ScenarioEnterResult["items"], overrides: Partial<ScenarioEnterResult> = {}): ScenarioEnterResult {
  return {
    startedAt: "2026-01-01T00:00:00Z",
    items,
    total: items.length,
    cancelled: false,
    timedOut: false,
    ...overrides,
  };
}

beforeEach(() => {
  scenarioDelete.mockReset();
  scenarioDuplicate.mockReset();
  scenarioEnter.mockReset();
  scenarioEnterCancel.mockReset();
  scenarioGet.mockReset();
  scenarioList.mockReset();
  scenarioSave.mockReset();
  scenarioList.mockResolvedValue([summary]);
  useScenarioStore.setState({
    summaries: [], loading: false, loaded: false, error: null,
    enteringId: null, cancellingId: null, editing: null, results: {}, progressByItem: {},
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
    const result = enterResult([
      { kind: "snapshot", label: "snapshot-1", status: "ok" },
      { kind: "workflow", label: "workflow-1", status: "failed", detail: "工作流槽已占用" },
    ]);
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
    const result = enterResult([
      { kind: "snapshot", label: "snapshot-1", status: "ok" },
      { kind: "workflow", label: "workflow-1", status: "ok" },
    ]);
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

  // ── 窗口几何恢复摘要（C5 收口）──
  it("现场恢复完成时在详情中体现几何恢复成功与降级", () => {
    // 无几何数据（旧快照）：不追加几何文案
    expect(
      geometryProgressDetail({
        snapshot_id: "s",
        total: 1,
        restored: 1,
        failed: 0,
        skipped: 0,
        cancelled: 0,
        items: [{ item_id: "i1", display_name: "n", item_kind: "application", outcome: "restored", action: null, verification_level: "window-confirmed", fallback_used: false, reason: null }],
      }),
    ).toBe("");

    const result = enterResult([{ kind: "snapshot", label: "snapshot-geo", status: "ok" }]);
    useScenarioStore.setState({ results: { "scene-1": result } });
    useScenarioStore.getState().applyRestoreProgress({
      snapshot_id: "snapshot-geo",
      index: 3,
      total: 3,
      phase: "done",
      summary: {
        snapshot_id: "snapshot-geo",
        total: 3,
        restored: 3,
        failed: 0,
        skipped: 0,
        cancelled: 0,
        items: [
          { item_id: "i1", display_name: "a", item_kind: "application", outcome: "restored", action: null, verification_level: "window-confirmed", fallback_used: false, reason: "已恢复窗口位置与尺寸", geometry: "applied" },
          { item_id: "i2", display_name: "b", item_kind: "application", outcome: "restored", action: null, verification_level: "window-confirmed", fallback_used: false, reason: "显示器布局已变化，窗口已收敛到当前可见区域", geometry: "converged" },
          { item_id: "i3", display_name: "c", item_kind: "application", outcome: "restored", action: null, verification_level: "window-confirmed", fallback_used: false, reason: "系统拒绝了窗口位置调整，已保持当前位置", geometry: "failed" },
        ],
      },
    });
    const progress = useScenarioStore.getState().progressByItem[scenarioItemProgressKey("snapshot", "snapshot-geo")];
    expect(progress.status).toBe("completed");
    expect(progress.detail).toContain("恢复 3，跳过 0，失败 0，取消 0");
    expect(progress.detail).toContain("窗口几何：1 项已按原位恢复，1 项因显示器布局变化已收敛到可见区域，1 项未能调整位置");
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
    const result = enterResult([]);
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
    scenarioEnter.mockResolvedValue({ startedAt: "2026-01-01T00:00:00Z", items: [], total: 0, cancelled: false, timedOut: false });
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
    const result = enterResult([]);
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
      results: { "scene-1": enterResult([]) },
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

  // ── 进入取消（后端互斥槽 + 项间取消）──
  it("cancelEnter 只对在途进入转发后端并清理 cancellingId", async () => {
    scenarioEnterCancel.mockResolvedValue(true);
    useScenarioStore.setState({ enteringId: "scene-1" });

    await expect(useScenarioStore.getState().cancelEnter("scene-1")).resolves.toBe(true);
    expect(scenarioEnterCancel).toHaveBeenCalledWith("scene-1");
    expect(useScenarioStore.getState().cancellingId).toBeNull();
  });

  it("cancelEnter 在无在途进入时不调用后端", async () => {
    useScenarioStore.setState({ enteringId: null });
    await expect(useScenarioStore.getState().cancelEnter("scene-1")).resolves.toBe(false);
    expect(scenarioEnterCancel).not.toHaveBeenCalled();
    expect(useScenarioStore.getState().cancellingId).toBeNull();
  });

  it("取消请求失败也清理 cancellingId，不污染错误状态", async () => {
    scenarioEnterCancel.mockRejectedValueOnce(new Error("cancel failed"));
    useScenarioStore.setState({ enteringId: "scene-1" });

    await expect(useScenarioStore.getState().cancelEnter("scene-1")).rejects.toThrow("cancel failed");
    expect(useScenarioStore.getState().cancellingId).toBeNull();
    expect(useScenarioStore.getState().error).toBeNull();
  });

  it("取消后的进入结果原样保留（cancelled/total 与 items 同存）", async () => {
    useScenarioStore.setState({ summaries: [summary] });
    scenarioGet.mockResolvedValueOnce({ ...summary, apps: [], urls: [], folders: [], snapshotId: null });
    const result = enterResult(
      [{ kind: "app", label: "记事本", status: "ok" }],
      { total: 4, cancelled: true },
    );
    scenarioEnter.mockResolvedValueOnce(result);

    await expect(useScenarioStore.getState().enter("scene-1")).resolves.toEqual(result);
    expect(useScenarioStore.getState().results["scene-1"]).toEqual(result);
    expect(useScenarioStore.getState().enteringId).toBeNull();
  });
});
