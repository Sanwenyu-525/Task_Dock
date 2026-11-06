//! 规划中心 store（v0.7）：多项目功能规划的前端状态层。
//!
//! 一致性约定：
//! - 每类列表带请求代际（seq），切换项目 / 快速连续操作后旧响应一律丢弃，
//!   不会把项目 A 的功能覆盖到项目 B 上；
//! - 变更命令返回后端权威实体（含步骤与统计），就地替换，不整页重拉；
//! - 无轮询：数据只在面板挂载、切换项目、用户操作后刷新；
//! - 失败保留旧数据并置 error（面板显示重试入口），不拿空列表冒充现状。

import { create } from "zustand";
import {
  planningActivityPage,
  planningAddNote,
  planningAddStep,
  planningArchiveProject,
  planningCreateFeature,
  planningCreateMilestone,
  planningCreateProject,
  planningDeleteFeature,
  planningDeleteMilestone,
  planningDeleteProject,
  planningDeleteStep,
  planningListFeatures,
  planningListMilestones,
  planningListProjects,
  planningReorderFeatures,
  planningReorderSteps,
  planningUpdateFeature,
  planningUpdateMilestone,
  planningUpdateProject,
  planningUpdateStep,
  type PlanningActivity,
  type PlanningFeature,
  type PlanningFeatureInput,
  type PlanningFeaturePatch,
  type PlanningMilestone,
  type PlanningMilestoneInput,
  type PlanningMilestonePatch,
  type PlanningProject,
  type PlanningProjectInput,
  type PlanningProjectPatch,
  type PlanningChangedEvent,
  type PlanningProjectStats,
  type PlanningStepPatch,
  onPlanningChanged,
} from "../lib/bridge";

/** 历史分页每页条数 */
export const ACTIVITY_PAGE_SIZE = 30;

interface PlanningState {
  projects: PlanningProject[];
  projectsLoading: boolean;
  projectsError: string | null;
  /** 当前选中项目；null = 未选择（空态由面板处理） */
  activeProjectId: string | null;

  features: PlanningFeature[];
  featuresLoading: boolean;
  featuresError: string | null;
  /** 功能/里程碑数据已加载完成的项目 id（空项目也算已加载）；切换中为 null */
  loadedForProject: string | null;

  milestones: PlanningMilestone[];
  milestonesLoading: boolean;
  milestonesError: string | null;

  activity: PlanningActivity[];
  activityHasMore: boolean;
  activityLoading: boolean;
  activityError: string | null;
  /** 当前 activity 列表对应的作用域；项目级与功能级历史共用 activity 字段时靠它隔离 */
  activityScope: { projectId: string; featureId: string | null } | null;

  loadProjects: () => Promise<void>;
  createProject: (input: PlanningProjectInput) => Promise<PlanningProject>;
  updateProject: (id: string, patch: PlanningProjectPatch) => Promise<PlanningProject>;
  archiveProject: (id: string, archived: boolean) => Promise<PlanningProject>;
  deleteProject: (id: string) => Promise<void>;

  /** 选择项目并加载其功能 / 里程碑；已加载同一项目时不重拉 */
  selectProject: (id: string) => Promise<void>;
  createFeature: (input: PlanningFeatureInput) => Promise<PlanningFeature>;
  updateFeature: (id: string, patch: PlanningFeaturePatch) => Promise<PlanningFeature>;
  deleteFeature: (id: string) => Promise<void>;
  reorderFeatures: (ids: string[]) => Promise<void>;

  addStep: (featureId: string, title: string) => Promise<void>;
  updateStep: (stepId: string, patch: PlanningStepPatch) => Promise<void>;
  deleteStep: (stepId: string) => Promise<void>;
  reorderSteps: (featureId: string, ids: string[]) => Promise<void>;

  loadMilestones: (projectId?: string) => Promise<void>;
  createMilestone: (input: PlanningMilestoneInput) => Promise<PlanningMilestone>;
  updateMilestone: (id: string, patch: PlanningMilestonePatch) => Promise<PlanningMilestone>;
  deleteMilestone: (id: string) => Promise<void>;

  loadActivity: (featureId?: string | null) => Promise<void>;
  loadMoreActivity: (featureId?: string | null) => Promise<void>;
  addNote: (message: string, featureId?: string | null) => Promise<void>;
}

/** 请求代际：只有最新一次请求允许写状态（项目切换 / 乱序返回防护） */
let projectsSeq = 0;
let featuresSeq = 0;
let milestonesSeq = 0;
let activitySeq = 0;

function sameActivityScope(
  a: { projectId: string; featureId: string | null } | null,
  b: { projectId: string; featureId: string | null },
): boolean {
  return !!a && a.projectId === b.projectId && a.featureId === b.featureId;
}

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * 把后端返回的权威功能实体就地替换进列表（保持原有排序位置）。
 * 后端 list 按 sort_order 排序，但单条替换时保持现有槽位可避免列表跳动。
 */
function upsertFeature(list: PlanningFeature[], next: PlanningFeature): PlanningFeature[] {
  const idx = list.findIndex((f) => f.id === next.id);
  if (idx === -1) return [...list, next];
  const out = [...list];
  out[idx] = next;
  return out;
}

function removeFeature(list: PlanningFeature[], id: string): PlanningFeature[] {
  return list.filter((f) => f.id !== id);
}

/**
 * 由后端权威功能实体派生项目统计。
 * 功能增删改后立即同步总览/看板/列表，避免出现「列表已变、统计还是旧值」。
 */
function deriveProjectStats(features: PlanningFeature[]): PlanningProjectStats {
  let completed = 0;
  let inProgress = 0;
  let blocked = 0;
  let planned = 0;
  let review = 0;
  let paused = 0;
  for (const f of features) {
    if (f.status === "completed") completed += 1;
    else if (f.status === "in_progress") inProgress += 1;
    else if (f.status === "blocked") blocked += 1;
    else if (f.status === "planned") planned += 1;
    else if (f.status === "review") review += 1;
    else if (f.status === "paused") paused += 1;
  }
  const total = features.length;
  return {
    feature_total: total,
    feature_completed: completed,
    feature_in_progress: inProgress,
    feature_blocked: blocked,
    feature_planned: planned,
    feature_review: review,
    feature_paused: paused,
    has_features: total > 0,
    progress_percent: total > 0 ? Math.floor((completed * 100) / total) : 0,
  };
}

/**
 * 功能列表变化后同步：当前项目统计 + 里程碑关联统计。
 * 只使用后端返回的功能实体推导，不伪造数字。
 */
function syncDerivedLists(
  state: Pick<PlanningState, "projects" | "milestones" | "activeProjectId">,
  features: PlanningFeature[],
  sourceMilestones: PlanningMilestone[] = state.milestones,
): Pick<PlanningState, "projects" | "milestones"> {
  const stats = deriveProjectStats(features);
  const projects = state.projects.map((p) =>
    p.id === state.activeProjectId ? { ...p, stats } : p,
  );
  const milestones = sourceMilestones.map((m) => {
    let total = 0;
    let completed = 0;
    for (const f of features) {
      if (f.milestone_id !== m.id) continue;
      total += 1;
      if (f.status === "completed") completed += 1;
    }
    return { ...m, feature_total: total, feature_completed: completed };
  });
  return { projects, milestones };
}

export const usePlanningStore = create<PlanningState>((set, get) => ({
  projects: [],
  projectsLoading: false,
  projectsError: null,
  activeProjectId: null,

  features: [],
  featuresLoading: false,
  featuresError: null,
  loadedForProject: null,

  milestones: [],
  milestonesLoading: false,
  milestonesError: null,

  activity: [],
  activityHasMore: false,
  activityLoading: false,
  activityError: null,
  activityScope: null,

  loadProjects: async () => {
    ensurePlanningSync();
    const seq = ++projectsSeq;
    set({ projectsLoading: true, projectsError: null });
    try {
      const projects = await planningListProjects();
      if (seq !== projectsSeq) return;
      set({ projects, projectsLoading: false });
    } catch (e) {
      if (seq !== projectsSeq) return;
      set({ projectsLoading: false, projectsError: errText(e) });
    }
  },

  createProject: async (input) => {
    const p = await planningCreateProject(input);
    set((s) => ({ projects: [...s.projects, p] }));
    return p;
  },

  updateProject: async (id, patch) => {
    const p = await planningUpdateProject(id, patch);
    set((s) => ({ projects: s.projects.map((x) => (x.id === id ? p : x)) }));
    return p;
  },

  archiveProject: async (id, archived) => {
    const p = await planningArchiveProject(id, archived);
    set((s) => ({ projects: s.projects.map((x) => (x.id === id ? p : x)) }));
    return p;
  },

  deleteProject: async (id) => {
    await planningDeleteProject(id);
    set((s) => {
      const projects = s.projects.filter((x) => x.id !== id);
      const activeProjectId = s.activeProjectId === id ? null : s.activeProjectId;
      const loadedForProject = s.activeProjectId === id ? null : s.loadedForProject;
      return { projects, activeProjectId, loadedForProject };
    });
    // 被删项目是当前项目时，切到剩余第一个
    if (get().activeProjectId === null) {
      const first = get().projects[0];
      if (first) await get().selectProject(first.id);
    }
  },

  selectProject: async (id) => {
    ensurePlanningSync();
    // 同一项目且数据已就绪（加载完成、无错误）：不重拉（空项目也是就绪态）
    if (
      get().activeProjectId === id &&
      get().loadedForProject === id &&
      !get().featuresLoading &&
      !get().featuresError
    ) {
      return;
    }
    const seq = ++featuresSeq;
    const mSeq = ++milestonesSeq;
    set({
      activeProjectId: id,
      loadedForProject: null,
      featuresLoading: true,
      featuresError: null,
      milestonesLoading: true,
      milestonesError: null,
      // 切换立即清空旧项目数据：加载中界面不显示上一个项目的内容
      features: [],
      milestones: [],
      activity: [],
      activityHasMore: false,
      activityLoading: false,
      activityError: null,
      activityScope: null,
    });
    try {
      const [features, milestones] = await Promise.all([
        planningListFeatures(id),
        planningListMilestones(id),
      ]);
      const fresh = seq === featuresSeq && mSeq === milestonesSeq;
      if (!fresh) return;
      set((s) => ({
        features,
        featuresLoading: false,
        milestonesLoading: false,
        loadedForProject: id,
        ...syncDerivedLists({ ...s, activeProjectId: id }, features, milestones),
      }));
    } catch (e) {
      if (seq !== featuresSeq) return;
      set({
        featuresLoading: false,
        milestonesLoading: false,
        featuresError: errText(e),
      });
    }
  },

  createFeature: async (input) => {
    const projectId = get().activeProjectId;
    if (!projectId) throw new Error("未选择项目");
    const f = await planningCreateFeature(projectId, input);
    set((s) => {
      const features = [...s.features, f];
      return { features, ...syncDerivedLists(s, features) };
    });
    return f;
  },

  updateFeature: async (id, patch) => {
    const f = await planningUpdateFeature(id, patch);
    set((s) => {
      const features = upsertFeature(s.features, f);
      return { features, ...syncDerivedLists(s, features) };
    });
    return f;
  },

  deleteFeature: async (id) => {
    await planningDeleteFeature(id);
    set((s) => {
      const features = removeFeature(s.features, id);
      return { features, ...syncDerivedLists(s, features) };
    });
  },

  reorderFeatures: async (ids) => {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    await planningReorderFeatures(projectId, ids);
    // 按 ids 顺序重排本地列表
    set((s) => {
      const byId = new Map(s.features.map((f) => [f.id, f]));
      const next = ids.map((id) => byId.get(id)).filter((f): f is PlanningFeature => !!f);
      const tail = s.features.filter((f) => !ids.includes(f.id));
      return { features: [...next, ...tail] };
    });
  },

  addStep: async (featureId, title) => {
    const f = await planningAddStep(featureId, title);
    set((s) => ({ features: upsertFeature(s.features, f) }));
  },

  updateStep: async (stepId, patch) => {
    const f = await planningUpdateStep(stepId, patch);
    set((s) => ({ features: upsertFeature(s.features, f) }));
  },

  deleteStep: async (stepId) => {
    const f = await planningDeleteStep(stepId);
    set((s) => ({ features: upsertFeature(s.features, f) }));
  },

  reorderSteps: async (featureId, ids) => {
    const f = await planningReorderSteps(featureId, ids);
    set((s) => ({ features: upsertFeature(s.features, f) }));
  },

  loadMilestones: async (projectId) => {
    const id = projectId ?? get().activeProjectId;
    if (!id) return;
    const seq = ++milestonesSeq;
    set({ milestonesLoading: true, milestonesError: null });
    try {
      const milestones = await planningListMilestones(id);
      if (seq !== milestonesSeq) return;
      set({ milestones, milestonesLoading: false });
    } catch (e) {
      if (seq !== milestonesSeq) return;
      set({ milestonesLoading: false, milestonesError: errText(e) });
    }
  },

  createMilestone: async (input) => {
    const projectId = get().activeProjectId;
    if (!projectId) throw new Error("未选择项目");
    const m = await planningCreateMilestone(projectId, input);
    set((s) => ({ milestones: [...s.milestones, m] }));
    return m;
  },

  updateMilestone: async (id, patch) => {
    const m = await planningUpdateMilestone(id, patch);
    set((s) => ({ milestones: s.milestones.map((x) => (x.id === id ? m : x)) }));
    // 关联名称变化同步进功能卡片
    set((s) => ({
      features: s.features.map((f) =>
        f.milestone_id === id ? { ...f, milestone_name: m.name } : f,
      ),
    }));
    return m;
  },

  deleteMilestone: async (id) => {
    await planningDeleteMilestone(id);
    set((s) => ({
      milestones: s.milestones.filter((m) => m.id !== id),
      // 关联被置空（后端 ON DELETE SET NULL）
      features: s.features.map((f) =>
        f.milestone_id === id ? { ...f, milestone_id: null, milestone_name: null } : f,
      ),
    }));
  },

  loadActivity: async (featureId) => {
    const projectId = get().activeProjectId;
    if (!projectId) return;
    const scope = { projectId, featureId: featureId ?? null };
    const seq = ++activitySeq;
    set({
      activityLoading: true,
      activityError: null,
      activity: [],
      activityHasMore: false,
      activityScope: scope,
    });
    try {
      const page = await planningActivityPage(projectId, {
        featureId: scope.featureId,
        limit: ACTIVITY_PAGE_SIZE,
        offset: 0,
      });
      if (seq !== activitySeq || !sameActivityScope(get().activityScope, scope)) return;
      set({ activity: page.items, activityHasMore: page.has_more, activityLoading: false });
    } catch (e) {
      if (seq !== activitySeq || !sameActivityScope(get().activityScope, scope)) return;
      set({ activityLoading: false, activityError: errText(e) });
    }
  },

  loadMoreActivity: async (featureId) => {
    const scope = get().activityScope;
    const projectId = get().activeProjectId;
    // 参数只用于调用方表达意图；分页必须沿用当前已加载的作用域，避免项目级/功能级历史串页
    if (!scope || !projectId || scope.projectId !== projectId) return;
    if (featureId !== undefined && (featureId ?? null) !== scope.featureId) return;
    if (get().activityLoading || !get().activityHasMore) return;
    const seq = ++activitySeq;
    const offset = get().activity.length;
    set({ activityLoading: true, activityError: null });
    try {
      const page = await planningActivityPage(projectId, {
        featureId: scope.featureId,
        limit: ACTIVITY_PAGE_SIZE,
        offset,
      });
      if (seq !== activitySeq || !sameActivityScope(get().activityScope, scope)) return;
      set((s) => ({
        activity: [...s.activity, ...page.items],
        activityHasMore: page.has_more,
        activityLoading: false,
      }));
    } catch (e) {
      if (seq !== activitySeq || !sameActivityScope(get().activityScope, scope)) return;
      set({ activityLoading: false, activityError: errText(e) });
    }
  },

  addNote: async (message, featureId) => {
    const projectId = get().activeProjectId;
    if (!projectId) throw new Error("未选择项目");
    const targetFeature = featureId ?? null;
    const a = await planningAddNote(projectId, targetFeature, message);
    // 有更早历史未加载时追加会破坏时间倒序；只在第一页场景就地前插。
    // 当前历史列表属于其他作用域时不写入，避免把项目级记录插进功能历史。
    set((s) => {
      if (s.activityHasMore) return { activity: s.activity };
      if (s.activityScope && (s.activityScope.projectId !== projectId || s.activityScope.featureId !== targetFeature)) {
        return { activity: s.activity };
      }
      return { activity: [a, ...s.activity] };
    });
  },
}));

// ── planning-changed 订阅（v37）────────────────────────────────────
//
// 外部 MCP 客户端写入成功后，主进程广播 `planning-changed`
// { kind, projectId?, featureId?, revision? }。本 store 订阅该事件做局部刷新：
// - 全应用只挂一条监听（首次 loadProjects/selectProject 时懒注册，幂等）；
// - 短时重复事件去抖合并（SYNC_DEBOUNCE_MS 内只刷一次）；
// - 刷新全部走带请求代际（seq）的加载路径，旧响应一律丢弃，
//   不会覆盖用户刚提交的更新（防旧响应覆盖新数据）；
// - 不新增任何轮询：事件驱动，无事件无请求。

const SYNC_DEBOUNCE_MS = 300;

let syncSubscribed = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
const pendingSyncEvents: PlanningChangedEvent[] = [];

function refreshActiveProject(): Promise<void> {
  const { activeProjectId: projectId } = usePlanningStore.getState();
  if (!projectId) return Promise.resolve();
  const seq = ++featuresSeq;
  const mSeq = ++milestonesSeq;
  usePlanningStore.setState({
    featuresLoading: true,
    featuresError: null,
    milestonesLoading: true,
    milestonesError: null,
  });
  return (async () => {
    try {
      const [features, milestones] = await Promise.all([
        planningListFeatures(projectId),
        planningListMilestones(projectId),
      ]);
      if (seq !== featuresSeq || mSeq !== milestonesSeq) return;
      usePlanningStore.setState((s) => ({
        features,
        featuresLoading: false,
        milestonesLoading: false,
        loadedForProject: projectId,
        ...syncDerivedLists({ ...s, activeProjectId: projectId }, features, milestones),
      }));
      // 处于第一页的作用域历史同步刷新（有更早页未加载时不追加以保时间倒序）
      const latest = usePlanningStore.getState();
      if (!latest.activityHasMore) {
        await latest.loadActivity(latest.activityScope?.featureId ?? undefined);
      }
    } catch (e) {
      if (seq !== featuresSeq) return;
      usePlanningStore.setState({
        featuresLoading: false,
        milestonesLoading: false,
        featuresError: errText(e),
      });
    }
  })();
}

function flushPlanningSync(): void {
  syncTimer = null;
  const events = pendingSyncEvents.splice(0, pendingSyncEvents.length);
  if (events.length === 0) return;
  // 项目级变化（新建/改名/归档/统计）刷新项目列表
  if (events.some((e) => e.kind === "project")) {
    void usePlanningStore.getState().loadProjects();
  }
  // 事件命中当前项目时局部刷新功能/里程碑/历史
  const active = usePlanningStore.getState().activeProjectId;
  if (active && events.some((e) => e.projectId === active)) {
    void refreshActiveProject();
  }
}

/** 注册 planning-changed 监听（幂等；首次打开规划面板时调用）。 */
export function ensurePlanningSync(): void {
  if (syncSubscribed) return;
  syncSubscribed = true;
  onPlanningChanged((event) => {
    pendingSyncEvents.push(event);
    if (syncTimer !== null) return;
    syncTimer = setTimeout(flushPlanningSync, SYNC_DEBOUNCE_MS);
  }).catch((e) => {
    // 注册失败（如非 Tauri 环境）：恢复未订阅状态，下次进入面板重试
    syncSubscribed = false;
    console.warn("planning-changed 订阅失败", e);
  });
}
