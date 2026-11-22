//! 规划 store（ADR-0010 Plan 语义）：计划、阶段、功能、里程碑的前端状态层。
//!
//! ID 契约（重要）：
//! - 本 store 的一切 `planId` 都是 `planning_projects.id`（计划 ID），
//!   **不是**项目根 `workspace_projects.id`；全局项目上下文见 workbench/ProjectContext；
//! - 后端旧 IPC 命令（planning_list_projects 等）与 planning_* 表字段沿用历史命名，
//!   前端在类型与命名上统一为 Plan 语义，不改外部契约；
//! - `plans` 列表来自 planning_list_projects：每个项目一条当前激活计划 + 未补链的
//!   孤儿旧计划。每条计划带 `workspace_project_id`（项目根归属），UI 按
//!   全局 projectId 过滤展示，不把跨项目列表当项目选择器。
//!
//! 一致性约定：
//! - 每类列表带请求代际（seq），切换计划 / 快速连续操作后旧响应一律丢弃，
//!   不会把计划 A 的功能覆盖到计划 B 上；
//! - 变更命令返回后端权威实体（含步骤与统计），就地替换，不整页重拉；
//! - 无轮询：数据只在面板挂载、切换计划、用户操作后刷新；
//! - 失败保留旧数据并置 error（面板显示重试入口），不拿空列表冒充现状。

import { create } from "zustand";
import { errorMessage } from "../lib/errors";
import { logEvent } from "../lib/diagnostics";
import { useNotesStore } from "./useNotesStore";
import { useTasksStore } from "./useTasksStore";
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
  type PlanningPlan,
  type PlanningPlanInput,
  type PlanningPlanPatch,
  type PlanningChangedEvent,
  type PlanningPlanStats,
  type PlanningStepPatch,
  onPlanningChanged,
} from "../lib/bridge";

/** 历史分页每页条数 */
export const ACTIVITY_PAGE_SIZE = 30;

interface PlanningState {
  /** 全部计划的当前激活计划列表（含未补链孤儿）；按 workspace_project_id 过滤后展示。 */
  plans: PlanningPlan[];
  plansLoading: boolean;
  plansError: string | null;
  /** 当前选中计划（planning_projects.id）；null = 未选择（空态由面板处理） */
  activePlanId: string | null;

  features: PlanningFeature[];
  featuresLoading: boolean;
  featuresError: string | null;
  /** 功能/里程碑数据已加载完成的计划 id（空计划也算已加载）；切换中为 null */
  loadedForPlan: string | null;

  milestones: PlanningMilestone[];
  milestonesLoading: boolean;
  milestonesError: string | null;

  activity: PlanningActivity[];
  activityHasMore: boolean;
  activityLoading: boolean;
  activityError: string | null;
  /** 当前 activity 列表对应的作用域；计划级与功能级历史共用 activity 字段时靠它隔离 */
  activityScope: { planId: string; featureId: string | null } | null;

  loadPlans: () => Promise<void>;
  /** 创建「计划」实际走 ADR-0008 统一创建事务：同时生成项目根 + 初始计划。 */
  createPlan: (input: PlanningPlanInput) => Promise<PlanningPlan>;
  updatePlan: (id: string, patch: PlanningPlanPatch) => Promise<PlanningPlan>;
  archivePlan: (id: string, archived: boolean) => Promise<PlanningPlan>;
  /** 删除计划（不删项目根）；最后一个计划的保护由后端 ADR-0008 规则保证。 */
  deletePlan: (id: string) => Promise<void>;

  /** 选择计划并加载其功能 / 里程碑；已加载同一计划时不重拉 */
  selectPlan: (id: string) => Promise<void>;
  createFeature: (input: PlanningFeatureInput) => Promise<PlanningFeature>;
  updateFeature: (id: string, patch: PlanningFeaturePatch) => Promise<PlanningFeature>;
  deleteFeature: (id: string) => Promise<void>;
  reorderFeatures: (ids: string[]) => Promise<void>;

  addStep: (featureId: string, title: string) => Promise<void>;
  updateStep: (stepId: string, patch: PlanningStepPatch) => Promise<void>;
  deleteStep: (stepId: string) => Promise<void>;
  reorderSteps: (featureId: string, ids: string[]) => Promise<void>;

  loadMilestones: (planId?: string) => Promise<void>;
  createMilestone: (input: PlanningMilestoneInput) => Promise<PlanningMilestone>;
  updateMilestone: (id: string, patch: PlanningMilestonePatch) => Promise<PlanningMilestone>;
  deleteMilestone: (id: string) => Promise<void>;

  loadActivity: (featureId?: string | null) => Promise<void>;
  loadMoreActivity: (featureId?: string | null) => Promise<void>;
  addNote: (message: string, featureId?: string | null) => Promise<void>;
}

/** 请求代际：只有最新一次请求允许写状态（计划切换 / 乱序返回防护） */
let plansSeq = 0;
let featuresSeq = 0;
let milestonesSeq = 0;
let activitySeq = 0;

function sameActivityScope(
  a: { planId: string; featureId: string | null } | null,
  b: { planId: string; featureId: string | null },
): boolean {
  return !!a && a.planId === b.planId && a.featureId === b.featureId;
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
 * 由后端权威功能实体派生计划统计。
 * 功能增删改后立即同步总览/看板/列表，避免出现「列表已变、统计还是旧值」。
 */
function derivePlanStats(features: PlanningFeature[]): PlanningPlanStats {
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
 * 功能列表变化后同步：当前计划统计 + 里程碑关联统计。
 * 只使用后端返回的功能实体推导，不伪造数字。
 */
function syncDerivedLists(
  state: Pick<PlanningState, "plans" | "milestones" | "activePlanId">,
  features: PlanningFeature[],
  sourceMilestones: PlanningMilestone[] = state.milestones,
): Pick<PlanningState, "plans" | "milestones"> {
  const stats = derivePlanStats(features);
  const plans = state.plans.map((p) =>
    p.id === state.activePlanId ? { ...p, stats } : p,
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
  return { plans, milestones };
}

export const usePlanningStore = create<PlanningState>((set, get) => ({
  plans: [],
  plansLoading: false,
  plansError: null,
  activePlanId: null,

  features: [],
  featuresLoading: false,
  featuresError: null,
  loadedForPlan: null,

  milestones: [],
  milestonesLoading: false,
  milestonesError: null,

  activity: [],
  activityHasMore: false,
  activityLoading: false,
  activityError: null,
  activityScope: null,

  loadPlans: async () => {
    ensurePlanningSync();
    const seq = ++plansSeq;
    set({ plansLoading: true, plansError: null });
    try {
      const plans = await planningListProjects();
      if (seq !== plansSeq) return;
      set({ plans, plansLoading: false });
    } catch (e) {
      if (seq !== plansSeq) return;
      set({ plansLoading: false, plansError: errText(e) });
    }
  },

  createPlan: async (input) => {
    const p = await planningCreateProject(input);
    set((s) => ({ plans: [...s.plans, p] }));
    return p;
  },

  updatePlan: async (id, patch) => {
    const p = await planningUpdateProject(id, patch);
    set((s) => ({ plans: s.plans.map((x) => (x.id === id ? p : x)) }));
    return p;
  },

  archivePlan: async (id, archived) => {
    const p = await planningArchiveProject(id, archived);
    set((s) => ({ plans: s.plans.map((x) => (x.id === id ? p : x)) }));
    return p;
  },

  deletePlan: async (id) => {
    await planningDeleteProject(id);
    set((s) => {
      const plans = s.plans.filter((x) => x.id !== id);
      const activePlanId = s.activePlanId === id ? null : s.activePlanId;
      const loadedForPlan = s.activePlanId === id ? null : s.loadedForPlan;
      return { plans, activePlanId, loadedForPlan };
    });
    // 不自动切换到剩余计划（ADR-0010 §3.6）：空态由面板明确展示，
    // 是否新建/激活计划由用户决定，不拿「第一个可见计划」静默代替。
  },

  selectPlan: async (id) => {
    ensurePlanningSync();
    // 同一计划且数据已就绪（加载完成、无错误）：不重拉（空计划也是就绪态）
    if (
      get().activePlanId === id &&
      get().loadedForPlan === id &&
      !get().featuresLoading &&
      !get().featuresError
    ) {
      return;
    }
    const seq = ++featuresSeq;
    const mSeq = ++milestonesSeq;
    set({
      activePlanId: id,
      loadedForPlan: null,
      featuresLoading: true,
      featuresError: null,
      milestonesLoading: true,
      milestonesError: null,
      // 切换立即清空旧计划数据：加载中界面不显示上一个计划的内容
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
        loadedForPlan: id,
        ...syncDerivedLists({ ...s, activePlanId: id }, features, milestones),
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
    const planId = get().activePlanId;
    if (!planId) throw new Error("未选择计划");
    const f = await planningCreateFeature(planId, input);
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
    const planId = get().activePlanId;
    if (!planId) return;
    await planningReorderFeatures(planId, ids);
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

  loadMilestones: async (planId) => {
    const id = planId ?? get().activePlanId;
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
    const planId = get().activePlanId;
    if (!planId) throw new Error("未选择计划");
    const m = await planningCreateMilestone(planId, input);
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
    const planId = get().activePlanId;
    if (!planId) return;
    const scope = { planId, featureId: featureId ?? null };
    const seq = ++activitySeq;
    set({
      activityLoading: true,
      activityError: null,
      activity: [],
      activityHasMore: false,
      activityScope: scope,
    });
    try {
      const page = await planningActivityPage(planId, {
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
    const planId = get().activePlanId;
    // 参数只用于调用方表达意图；分页必须沿用当前已加载的作用域，避免计划级/功能级历史串页
    if (!scope || !planId || scope.planId !== planId) return;
    if (featureId !== undefined && (featureId ?? null) !== scope.featureId) return;
    if (get().activityLoading || !get().activityHasMore) return;
    const seq = ++activitySeq;
    const offset = get().activity.length;
    set({ activityLoading: true, activityError: null });
    try {
      const page = await planningActivityPage(planId, {
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
    const planId = get().activePlanId;
    if (!planId) throw new Error("未选择计划");
    const targetFeature = featureId ?? null;
    const a = await planningAddNote(planId, targetFeature, message);
    // 有更早历史未加载时追加会破坏时间倒序；只在第一页场景就地前插。
    // 当前历史列表属于其他作用域时不写入，避免把计划级记录插进功能历史。
    set((s) => {
      if (s.activityHasMore) return { activity: s.activity };
      if (s.activityScope && (s.activityScope.planId !== planId || s.activityScope.featureId !== targetFeature)) {
        return { activity: s.activity };
      }
      return { activity: [a, ...s.activity] };
    });
  },
}));

// ── planning-changed 订阅（v37）────────────────────────────────────
//
// 外部 MCP 客户端写入成功后，主进程广播 `planning-changed`
// { kind, projectId?, featureId?, revision? }（广播里的 projectId 沿用旧契约，
// 实际是计划 ID planning_projects.id）。本 store 订阅该事件做局部刷新：
// - 全应用只挂一条监听（首次 loadPlans/selectPlan 时懒注册，幂等）；
// - 短时重复事件去抖合并（SYNC_DEBOUNCE_MS 内只刷一次）；
// - 刷新全部走带请求代际（seq）的加载路径，旧响应一律丢弃，
//   不会覆盖用户刚提交的更新（防旧响应覆盖新数据）；
// - 不新增任何轮询：事件驱动，无事件无请求。

const SYNC_DEBOUNCE_MS = 300;

let syncSubscribed = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
const pendingSyncEvents: PlanningChangedEvent[] = [];

function refreshActivePlan(): Promise<void> {
  const { activePlanId: planId } = usePlanningStore.getState();
  if (!planId) return Promise.resolve();
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
        planningListFeatures(planId),
        planningListMilestones(planId),
      ]);
      if (seq !== featuresSeq || mSeq !== milestonesSeq) return;
      usePlanningStore.setState((s) => ({
        features,
        featuresLoading: false,
        milestonesLoading: false,
        loadedForPlan: planId,
        ...syncDerivedLists({ ...s, activePlanId: planId }, features, milestones),
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
  // 计划级变化（新建/改名/归档/统计）刷新计划列表
  if (events.some((e) => e.kind === "project")) {
    void usePlanningStore.getState().loadPlans();
  }
  // 事件命中当前计划时局部刷新功能/里程碑/历史
  const active = usePlanningStore.getState().activePlanId;
  if (active && events.some((e) => e.projectId === active)) {
    void refreshActivePlan();
  }
  // 任务/笔记的 MCP 写入走同一广播：按领域刷新对应 store（去抖后每批一次），
  // 不整页重载、不新增轮询。组件未打开时也只是一次轻量列表查询。
  if (events.some((e) => e.kind === "task")) {
    void useTasksStore.getState().refresh();
  }
  if (events.some((e) => e.kind === "note")) {
    void useNotesStore.getState().load({ silent: true });
  }
}

/**
 * 外部写入（CLI / REST / 受控文件导入）后的局部刷新。
 *
 * 这些入口不经过 MCP bridge，不会发 `planning-changed`；但它们会写
 * `agent_operations`。前端游标同步发现新的终态操作后调用本函数，复用
 * planning-changed 的同一条带代际守卫的刷新路径，不新增轮询。
 *
 * @param rootOrPlanId 操作归属 ID：可能是项目根（agent_operations.project_id，v92
 *   统一身份），也可能是计划 ID（旧记录）。命中当前计划本身或其项目根时才刷新
 *   当前工作区；否则只刷新计划列表（名称/统计），不动当前视图（ADR-0010）。
 */
export function refreshPlanningFromExternalChange(rootOrPlanId?: string): void {
  const state = usePlanningStore.getState();
  const active = state.activePlanId;
  if (!active) {
    void state.loadPlans();
    return;
  }
  if (rootOrPlanId && rootOrPlanId !== active) {
    const activePlan = state.plans.find((p) => p.id === active);
    if (rootOrPlanId !== activePlan?.workspace_project_id) {
      // 变化属于其他项目/计划：只刷新计划列表，不动当前工作区。
      void state.loadPlans();
      return;
    }
  }
  void refreshActivePlan();
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
    logEvent({
      level: "WARN",
      module: "planning",
      action: "changed_subscribe",
      event: "failed",
      status: "failed",
      message: `planning-changed 订阅失败：${errorMessage(e)}`,
    });
  });
}
