//! usePlanningStore 一致性测试（node 环境）：
//! 项目切换的乱序防护、删除后自动切换、历史分页追加、失败保留旧数据。
//! bridge 全部 mock，用受控 deferred promise 模拟乱序返回。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlanningStore, ACTIVITY_PAGE_SIZE } from "./usePlanningStore";
import type {
  PlanningChangedEvent,
  PlanningFeature,
  PlanningMilestone,
  PlanningProject,
} from "../lib/bridge";

const bridge = vi.hoisted(() => {
  // 捕获 store 注册的 planning-changed 回调，测试直接驱动它模拟 MCP 写入广播
  const state: { planningChangedCb: ((e: unknown) => void) | null } = {
    planningChangedCb: null,
  };
  return {
    state,
    onPlanningChanged: vi.fn((cb: (e: unknown) => void) => {
      state.planningChangedCb = cb;
      return Promise.resolve(() => {});
    }),
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
};});

vi.mock("../lib/bridge", () => bridge);

function proj(id: string, name: string, archived = false): PlanningProject {
  return {
    id,
    name,
    description: "",
    status: "planning",
    archived,
    target_date: null,
    sort_order: 0,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
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
  };
}

function feat(id: string, projectId: string, title: string): PlanningFeature {
  return {
    id,
    project_id: projectId,
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
    updated_at: "2026-11-01T00:00:00Z",
    completed_at: null,
    steps: [],
    step_total: 0,
    step_done: 0,
  };
}

function ms(id: string, name: string, total = 0, completed = 0): PlanningMilestone {
  return {
    id,
    project_id: "P",
    name,
    description: "",
    target_date: null,
    sort_order: 0,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    feature_total: total,
    feature_completed: completed,
  };
}

/** 受控 promise：手动 resolve/reject，模拟异步乱序 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
});

afterEach(() => {
  vi.useRealTimers();
});

describe("项目切换与乱序防护", () => {
  it("先发 A（慢）后发 B（快）：B 的数据不被 A 的迟到响应覆盖", async () => {
    const dA = deferred<PlanningFeature[]>();
    const dB = deferred<PlanningFeature[]>();
    bridge.planningListFeatures.mockImplementation((pid: string) =>
      pid === "A" ? dA.promise : dB.promise,
    );
    bridge.planningListMilestones.mockResolvedValue([]);

    const p1 = usePlanningStore.getState().selectProject("A");
    const p2 = usePlanningStore.getState().selectProject("B");
    // B 先返回
    dB.resolve([feat("f-b", "B", "B 功能")]);
    await p2;
    expect(usePlanningStore.getState().features.map((f) => f.id)).toEqual(["f-b"]);

    // A 的迟到响应必须被丢弃
    dA.resolve([feat("f-a", "A", "A 功能")]);
    await p1;
    expect(usePlanningStore.getState().features.map((f) => f.id)).toEqual(["f-b"]);
    expect(usePlanningStore.getState().activeProjectId).toBe("B");
  });

  it("同一项目数据已就绪时重复 select 不重拉", async () => {
    bridge.planningListFeatures.mockResolvedValue([feat("f-1", "P1", "功能1")]);
    bridge.planningListMilestones.mockResolvedValue([]);
    await usePlanningStore.getState().selectProject("P1");
    expect(bridge.planningListFeatures).toHaveBeenCalledTimes(1);
    await usePlanningStore.getState().selectProject("P1");
    expect(bridge.planningListFeatures).toHaveBeenCalledTimes(1);
    // 空项目同样视为已就绪
    bridge.planningListFeatures.mockResolvedValue([]);
    await usePlanningStore.getState().selectProject("P2");
    await usePlanningStore.getState().selectProject("P2");
    expect(bridge.planningListFeatures).toHaveBeenCalledTimes(2);
  });

  it("切换项目期间立即清空旧项目数据", async () => {
    const dA = deferred<PlanningFeature[]>();
    bridge.planningListFeatures.mockImplementation((pid: string) =>
      pid === "A" ? dA.promise : Promise.resolve([]),
    );
    bridge.planningListMilestones.mockResolvedValue([]);
    usePlanningStore.setState({
      activeProjectId: "A",
      loadedForProject: "A",
      features: [feat("f-a", "A", "A 功能")],
      milestones: [],
    });
    void usePlanningStore.getState().selectProject("B");
    expect(usePlanningStore.getState().features).toEqual([]);
    expect(usePlanningStore.getState().loadedForProject).toBeNull();
    dA.resolve([]);
  });

  it("删除当前项目后自动切到剩余第一个项目", async () => {
    usePlanningStore.setState({
      projects: [proj("A", "甲"), proj("B", "乙")],
      activeProjectId: "A",
      loadedForProject: "A",
    });
    bridge.planningDeleteProject.mockResolvedValue(undefined);
    bridge.planningListFeatures.mockResolvedValue([]);
    bridge.planningListMilestones.mockResolvedValue([]);
    await usePlanningStore.getState().deleteProject("A");
    expect(usePlanningStore.getState().projects.map((p) => p.id)).toEqual(["B"]);
    expect(usePlanningStore.getState().activeProjectId).toBe("B");
  });

  it("加载失败置 error 保留旧列表（不拿空列表冒充现状）", async () => {
    bridge.planningListFeatures.mockRejectedValue("boom");
    bridge.planningListMilestones.mockRejectedValue("boom");
    await usePlanningStore.getState().selectProject("P1");
    expect(usePlanningStore.getState().featuresError).toBe("boom");
    expect(usePlanningStore.getState().featuresLoading).toBe(false);
  });
});

describe("变更后就地更新", () => {
  it("updateFeature 把后端权威实体替换进原槽位（不重排）", async () => {
    const a = feat("fa", "P", "甲");
    const b = feat("fb", "P", "乙");
    usePlanningStore.setState({ features: [a, b] });
    bridge.planningUpdateFeature.mockResolvedValue({ ...a, title: "甲改", status: "in_progress" });
    await usePlanningStore.getState().updateFeature("fa", { title: "甲改" });
    const fs = usePlanningStore.getState().features;
    expect(fs.map((f) => f.id)).toEqual(["fa", "fb"]);
    expect(fs[0].title).toBe("甲改");
    expect(fs[0].status).toBe("in_progress");
    expect(fs[1]).toBe(b);
  });

  it("deleteFeature 就地移除", async () => {
    usePlanningStore.setState({ features: [feat("fa", "P", "甲")] });
    bridge.planningDeleteFeature.mockResolvedValue(undefined);
    await usePlanningStore.getState().deleteFeature("fa");
    expect(usePlanningStore.getState().features).toEqual([]);
  });

  it("功能增删改后同步项目统计，不出现列表已变统计仍旧", async () => {
    usePlanningStore.setState({
      projects: [proj("P", "项目")],
      activeProjectId: "P",
      features: [],
      milestones: [ms("m1", "M1")],
    });
    bridge.planningCreateFeature.mockResolvedValue({
      ...feat("f1", "P", "甲"),
      status: "completed",
      milestone_id: "m1",
      milestone_name: "M1",
    });
    await usePlanningStore.getState().createFeature({ title: "甲", milestone_id: "m1" });
    const p = usePlanningStore.getState().projects[0];
    expect(p.stats.feature_total).toBe(1);
    expect(p.stats.feature_completed).toBe(1);
    expect(p.stats.progress_percent).toBe(100);
    expect(p.stats.has_features).toBe(true);
    expect(usePlanningStore.getState().milestones[0].feature_total).toBe(1);
    expect(usePlanningStore.getState().milestones[0].feature_completed).toBe(1);

    const updated = { ...feat("f1", "P", "甲"), status: "blocked" as const, milestone_id: "m1", milestone_name: "M1" };
    bridge.planningUpdateFeature.mockResolvedValue(updated);
    await usePlanningStore.getState().updateFeature("f1", { status: "blocked" });
    const next = usePlanningStore.getState().projects[0];
    expect(next.stats.feature_blocked).toBe(1);
    expect(next.stats.feature_completed).toBe(0);
    expect(next.stats.progress_percent).toBe(0);
    expect(usePlanningStore.getState().milestones[0].feature_completed).toBe(0);
  });

  it("addStep/updateStep 用返回的功能实体刷新对应卡片", async () => {
    const f = feat("fa", "P", "甲");
    usePlanningStore.setState({ features: [f] });
    bridge.planningAddStep.mockResolvedValue({
      ...f,
      step_total: 1,
      steps: [{ id: "s1", feature_id: "fa", title: "步骤", done: false, sort_order: 0, created_at: "", updated_at: "", completed_at: null }],
    });
    await usePlanningStore.getState().addStep("fa", "步骤");
    expect(usePlanningStore.getState().features[0].step_total).toBe(1);
    bridge.planningUpdateStep.mockResolvedValue({
      ...f,
      step_total: 1,
      step_done: 1,
      steps: [{ id: "s1", feature_id: "fa", title: "步骤", done: true, sort_order: 0, created_at: "", updated_at: "", completed_at: "2026-11-03T00:00:00Z" }],
    });
    await usePlanningStore.getState().updateStep("s1", { done: true });
    const cur = usePlanningStore.getState().features[0];
    expect(cur.step_done).toBe(1);
    expect(cur.steps[0].done).toBe(true);
  });
});

describe("进度历史分页", () => {
  it("首页加载后 has_more 时 loadMore 追加且不重复请求", async () => {
    bridge.planningListProjects.mockResolvedValue([]);
    usePlanningStore.setState({ activeProjectId: "P" });
    const page1 = {
      items: Array.from({ length: ACTIVITY_PAGE_SIZE }, (_, i) => ({
        id: `a${i}`, project_id: "P", feature_id: null, feature_title: null,
        kind: "note", old_status: null, new_status: null, message: `m${i}`,
        created_at: "2026-11-02T00:00:00Z",
      })),
      has_more: true,
    };
    const page2 = {
      items: [{ id: "a-x", project_id: "P", feature_id: null, feature_title: null, kind: "note", old_status: null, new_status: null, message: "x", created_at: "2026-11-01T00:00:00Z" }],
      has_more: false,
    };
    bridge.planningActivityPage
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    await usePlanningStore.getState().loadActivity();
    expect(usePlanningStore.getState().activity).toHaveLength(ACTIVITY_PAGE_SIZE);
    expect(usePlanningStore.getState().activityHasMore).toBe(true);
    await usePlanningStore.getState().loadMoreActivity();
    expect(usePlanningStore.getState().activity).toHaveLength(ACTIVITY_PAGE_SIZE + 1);
    expect(usePlanningStore.getState().activityHasMore).toBe(false);
    // 没有更多时不再发请求
    await usePlanningStore.getState().loadMoreActivity();
    expect(bridge.planningActivityPage).toHaveBeenCalledTimes(2);
  });

  it("addNote 在第一页就地前插；有更早历史未加载时不破坏时间序", async () => {
    bridge.planningListProjects.mockResolvedValue([]);
    usePlanningStore.setState({ activeProjectId: "P", activity: [], activityHasMore: false });
    bridge.planningAddNote.mockResolvedValue({
      id: "n1", project_id: "P", feature_id: null, feature_title: null,
      kind: "note", old_status: null, new_status: null, message: "日志",
      created_at: "2026-11-03T00:00:00Z",
    });
    await usePlanningStore.getState().addNote("日志");
    expect(usePlanningStore.getState().activity[0].id).toBe("n1");

    usePlanningStore.setState({ activityHasMore: true });
    await usePlanningStore.getState().addNote("第二条");
    // has_more 时不前插（避免破坏分页时间序），只等重新加载
    expect(usePlanningStore.getState().activity[0].id).toBe("n1");
  });

  it("项目级历史迟到响应不覆盖功能级历史（按作用域隔离）", async () => {
    const dProject = deferred<{ items: unknown[]; has_more: boolean }>();
    const dFeature = deferred<{ items: unknown[]; has_more: boolean }>();
    bridge.planningActivityPage.mockImplementation(
      (_pid: string, opts: { featureId: string | null }) =>
        opts.featureId === null ? dProject.promise : dFeature.promise,
    );
    usePlanningStore.setState({ activeProjectId: "P" });

    const p1 = usePlanningStore.getState().loadActivity(null);
    const p2 = usePlanningStore.getState().loadActivity("f1");
    dFeature.resolve({
      items: [
        {
          id: "feat-log",
          project_id: "P",
          feature_id: "f1",
          feature_title: "功能1",
          kind: "note",
          old_status: null,
          new_status: null,
          message: "功能级",
          created_at: "2026-11-03T00:00:00Z",
        },
      ],
      has_more: false,
    });
    await p2;
    expect(usePlanningStore.getState().activity[0].id).toBe("feat-log");

    dProject.resolve({
      items: [
        {
          id: "proj-log",
          project_id: "P",
          feature_id: null,
          feature_title: null,
          kind: "note",
          old_status: null,
          new_status: null,
          message: "项目级",
          created_at: "2026-11-03T00:00:00Z",
        },
      ],
      has_more: false,
    });
    await p1;
    expect(usePlanningStore.getState().activity[0].id).toBe("feat-log");
    expect(usePlanningStore.getState().activityScope?.featureId).toBe("f1");
  });

  it("功能级作用域下项目级 addNote 不污染当前历史", async () => {
    usePlanningStore.setState({
      activeProjectId: "P",
      activity: [],
      activityScope: { projectId: "P", featureId: "f1" },
    });
    bridge.planningAddNote.mockResolvedValue({
      id: "n-project",
      project_id: "P",
      feature_id: null,
      feature_title: null,
      kind: "note",
      old_status: null,
      new_status: null,
      message: "项目级日志",
      created_at: "2026-11-03T00:00:00Z",
    });
    await usePlanningStore.getState().addNote("项目级日志");
    expect(usePlanningStore.getState().activity).toEqual([]);
  });
});

// ── planning-changed 同步（v37）：MCP 写入 → 去抖局部刷新 + 代际守卫 ──

function emitPlanningChanged(e: PlanningChangedEvent): void {
  if (!bridge.state.planningChangedCb) {
    throw new Error("planning-changed 回调未注册（需先触发 loadProjects/selectProject）");
  }
  bridge.state.planningChangedCb(e);
}

describe("planning-changed 同步", () => {
  it("同项目事件去抖合并为一次局部刷新", async () => {
    vi.useFakeTimers();
    bridge.planningListProjects.mockResolvedValue([proj("P1", "甲")]);
    bridge.planningListFeatures.mockResolvedValue([]);
    bridge.planningListMilestones.mockResolvedValue([]);
    bridge.planningActivityPage.mockResolvedValue({ items: [], has_more: false });
    await usePlanningStore.getState().selectProject("P1");
    const callsBefore = bridge.planningListFeatures.mock.calls.length;

    emitPlanningChanged({ kind: "feature", projectId: "P1" });
    emitPlanningChanged({ kind: "step", projectId: "P1" });
    emitPlanningChanged({ kind: "activity", projectId: "P1" });
    // 去抖窗口内不立即请求
    expect(bridge.planningListFeatures.mock.calls.length).toBe(callsBefore);
    await vi.advanceTimersByTimeAsync(300);
    // 三条事件合并为一次刷新
    expect(bridge.planningListFeatures.mock.calls.length).toBe(callsBefore + 1);
  });

  it("非当前项目的事件不触发当前项目刷新；project 事件刷新项目列表", async () => {
    vi.useFakeTimers();
    bridge.planningListProjects.mockResolvedValue([proj("P1", "甲"), proj("P9", "MCP 新建")]);
    bridge.planningListFeatures.mockResolvedValue([]);
    bridge.planningListMilestones.mockResolvedValue([]);
    await usePlanningStore.getState().selectProject("P1");

    const featCalls = bridge.planningListFeatures.mock.calls.length;
    const projCalls = bridge.planningListProjects.mock.calls.length;
    emitPlanningChanged({ kind: "feature", projectId: "OTHER" });
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.planningListFeatures.mock.calls.length).toBe(featCalls);
    expect(bridge.planningListProjects.mock.calls.length).toBe(projCalls);

    emitPlanningChanged({ kind: "project", projectId: "P9" });
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.planningListProjects.mock.calls.length).toBe(projCalls + 1);
    expect(bridge.planningListFeatures.mock.calls.length).toBe(featCalls);
    // 项目列表已带出 MCP 新建的项目
    expect(usePlanningStore.getState().projects.map((p) => p.id)).toContain("P9");
  });

  it("事件刷新与用户切换的迟到响应互不覆盖（代际守卫）", async () => {
    vi.useFakeTimers();
    const dSel = deferred<PlanningFeature[]>();
    const dSync = deferred<PlanningFeature[]>();
    let call = 0;
    bridge.planningListFeatures.mockImplementation(() => {
      call += 1;
      return call === 1 ? dSel.promise : dSync.promise;
    });
    bridge.planningListMilestones.mockResolvedValue([]);
    bridge.planningListProjects.mockResolvedValue([]);

    void usePlanningStore.getState().selectProject("P1"); // call=1（select，pending）
    emitPlanningChanged({ kind: "feature", projectId: "P1" });
    await vi.advanceTimersByTimeAsync(300); // call=2（事件刷新，pending）

    // 事件刷新先返回
    dSync.resolve([feat("f-new", "P1", "MCP 新数据")]);
    await vi.advanceTimersByTimeAsync(1);
    expect(usePlanningStore.getState().features.map((f) => f.id)).toEqual(["f-new"]);

    // select 的迟到响应必须被丢弃
    dSel.resolve([feat("f-old", "P1", "旧数据")]);
    await vi.advanceTimersByTimeAsync(1);
    expect(usePlanningStore.getState().features.map((f) => f.id)).toEqual(["f-new"]);
    expect(usePlanningStore.getState().activeProjectId).toBe("P1");
  });
});
