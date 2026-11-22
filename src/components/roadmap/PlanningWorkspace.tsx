//! 规划工作区（ADR-0010）：全局项目根上下文内的计划编辑视图。
//!
//! - 全局项目（workspace_projects.id）来自 ProjectContext；本组件**只读消费**，
//!   绝不反向改写全局项目；
//! - 计划（planning_projects.id）是本组件的工作对象：进入时按项目根快照解析
//!   activePlanId 并 selectPlan；没有 active 计划显示明确空态；
//! - 不再维护跨项目选择器，也不自动选中任何项目/计划（空态引导用户去顶栏/项目中枢）；
//! - 视图：项目总览 / 功能列表·详情 / 功能看板 / 里程碑；跳转状态只存在于本组件，
//!   不写进 Store；
//! - 精确定位意图（useUiStore.roadmapFocusRequest / 全局搜索 pendingLocate）：
//!   先对齐全局项目根，再解析计划，最后定位对象；目标不存在按「尽力定位 + 明确反馈」
//!   兜底，不伪装成功。

import { useCallback, useEffect, useRef, useState } from "react";
import { Flag, KanbanSquare, LayoutList, LayoutDashboard } from "lucide-react";
import { projectHubGetProject } from "../../lib/bridge";
import { usePlanningStore } from "../../store/usePlanningStore";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useUiStore } from "../../store/useUiStore";
import { useProjectContext } from "../../workbench/ProjectContext";
import ProjectsView from "./ProjectsView";
import FeatureListView from "./FeatureListView";
import PlanningKanban from "./PlanningKanban";
import MilestonesView from "./MilestonesView";

type PlanningView = "overview" | "features" | "kanban" | "milestones";
/** 项目根 → 计划的解析状态；error/no-plan 是明确空态，不用旧计划数据冒充。 */
type PlanResolveState = "idle" | "loading" | "no-plan" | "error";
/** 解析结果：stale=被更新请求取代（静默作废）；error 带可读原因，调用方可区分失败与无计划。 */
type PlanResolveResult =
  | { ok: true; planId: string }
  | { ok: false; reason: "no-plan" }
  | { ok: false; reason: "stale" }
  | { ok: false; reason: "error"; message: string };

const VIEW_TABS: { key: PlanningView; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "overview", label: "项目总览", icon: LayoutDashboard },
  { key: "features", label: "功能列表", icon: LayoutList },
  { key: "kanban", label: "功能看板", icon: KanbanSquare },
  { key: "milestones", label: "里程碑", icon: Flag },
];

export default function PlanningWorkspace({ initialPlanId }: { initialPlanId?: string | null } = {}) {
  // 全局项目根上下文（ADR-0010）：projectId 一定是 workspace_projects.id。
  const { projectId, selectedProject, selectProject } = useProjectContext();
  const plans = usePlanningStore((s) => s.plans);
  const plansLoading = usePlanningStore((s) => s.plansLoading);
  const plansError = usePlanningStore((s) => s.plansError);
  const loadPlans = usePlanningStore((s) => s.loadPlans);
  const activePlanId = usePlanningStore((s) => s.activePlanId);
  const selectPlan = usePlanningStore((s) => s.selectPlan);
  const showToast = useUiStore((s) => s.showToast);

  const [view, setView] = useState<PlanningView>("overview");
  const [focusFeatureId, setFocusFeatureId] = useState<string | null>(null);
  const [milestoneFilterId, setMilestoneFilterId] = useState<string | null>(null);
  const [planResolve, setPlanResolve] = useState<PlanResolveState>("idle");
  const [planResolveError, setPlanResolveError] = useState<string | null>(null);

  // 计划列表只在首次进入加载一次：供深链 planId → 项目根解析与总览过滤使用。
  const bootstrapRequested = useRef(false);
  useEffect(() => {
    if (bootstrapRequested.current) return;
    bootstrapRequested.current = true;
    if (plans.length === 0 && !plansLoading && !plansError) {
      void loadPlans();
    }
  }, [plans.length, plansLoading, plansError, loadPlans]);

  // ── 项目根 → activePlanId 解析 ─────────────────────────────────────
  // 代际防乱序：快速切换项目时旧项目的解析/选择一律丢弃。
  const planResolveSeq = useRef(0);
  // 定位意图代际：新定位或用户手动操作都会作废旧定位（含跨项目的迟到回包）。
  const locateRunSeq = useRef(0);
  // 最新全局项目根：await 之后的归属校验必须用最新值，不能依赖闭包旧值。
  const projectIdRef = useRef<string | null>(projectId);
  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  /** 等待自身触发的项目切换在上下文里生效（有上限）；超时返回 false，不无限等待。 */
  const waitForProjectContext = useCallback(async (rootId: string): Promise<boolean> => {
    if (projectIdRef.current === rootId) return true;
    const deadline = Date.now() + 2000;
    while (projectIdRef.current !== rootId && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return projectIdRef.current === rootId;
  }, []);

  const resolvePlanForProject = useCallback(
    async (pid: string): Promise<PlanResolveResult> => {
      const seq = ++planResolveSeq.current;
      setPlanResolve("loading");
      setPlanResolveError(null);
      try {
        const snap = await projectHubGetProject(pid);
        // 请求已过期（项目又切换了）：静默作废，由最新一次解析接管。
        if (seq !== planResolveSeq.current) return { ok: false, reason: "stale" };
        // 快照归属校验：project.id 必须等于请求的项目根，否则拒绝用它解析计划。
        if (snap.project.id !== pid) {
          usePlanningStore.setState({ activePlanId: null, loadedForPlan: null });
          setPlanResolve("error");
          setPlanResolveError("项目快照与请求的项目不一致");
          return { ok: false, reason: "error", message: "项目快照与请求的项目不一致" };
        }
        const planId =
          typeof snap.planId === "string" && snap.planId.trim().length > 0 ? snap.planId : null;
        // 无可用计划：明确空态，并清掉可能属于其他项目的旧计划数据。
        if (!planId) {
          usePlanningStore.setState({ activePlanId: null, loadedForPlan: null });
          setPlanResolve("no-plan");
          return { ok: false, reason: "no-plan" };
        }
        const st = usePlanningStore.getState();
        if (!(st.activePlanId === planId && st.loadedForPlan === planId)) {
          await selectPlan(planId);
          if (seq !== planResolveSeq.current) return { ok: false, reason: "stale" };
          // 选择完成后核对 Store：计划一致且数据真正到位，失败不伪装成成功。
          const after = usePlanningStore.getState();
          if (after.activePlanId !== planId) {
            setPlanResolve("error");
            setPlanResolveError("计划选择未生效");
            return { ok: false, reason: "error", message: "计划选择未生效" };
          }
          if (after.loadedForPlan !== planId) {
            // 计划已选中但数据未就绪（加载失败）：保留 FeatureListView 自带的
            // 错误/重试 UI（解析状态回 idle），只让定位调用方拿 error 结果显式中止。
            const message = after.featuresError ?? "计划数据加载失败";
            setPlanResolve("idle");
            return { ok: false, reason: "error", message };
          }
        }
        setPlanResolve("idle");
        return { ok: true, planId };
      } catch (cause) {
        if (seq !== planResolveSeq.current) return { ok: false, reason: "stale" };
        // 失败时不保留可能属于其他项目的计划数据（错误态与空态可区分）。
        usePlanningStore.setState({ activePlanId: null, loadedForPlan: null });
        const message = cause instanceof Error ? cause.message : String(cause);
        setPlanResolve("error");
        setPlanResolveError(message);
        return { ok: false, reason: "error", message };
      }
    },
    [selectPlan],
  );

  useEffect(() => {
    if (!projectId) {
      planResolveSeq.current += 1;
      setPlanResolve("idle");
      setPlanResolveError(null);
      return;
    }
    // 项目切换：旧计划的选中态立即失效，避免解析失败时把上一个项目的计划
    // 数据显示在新项目名下（ADR-0010 §3.8）。
    if (usePlanningStore.getState().activePlanId !== null) {
      usePlanningStore.setState({ activePlanId: null, loadedForPlan: null });
    }
    void resolvePlanForProject(projectId);
  }, [projectId, resolvePlanForProject]);

  // 当前计划被删除后 activePlanId 变 null：重新解析一次（快照无计划 → 明确空态）。
  useEffect(() => {
    if (!projectId || activePlanId || planResolve !== "idle") return;
    void resolvePlanForProject(projectId);
  }, [projectId, activePlanId, planResolve, resolvePlanForProject]);

  // ── 兼容深链：项目中枢传入的 active 计划 ID 优先查看 ────────────────
  // 目标计划必须能证明归属当前项目根；按 (项目根, 计划) 组合消费一次：
  // 新的合法目标（计划或项目变化）可再次消费，相同目标不重复加载。
  const consumedDeepLink = useRef<string | null>(null);
  useEffect(() => {
    if (!initialPlanId || !projectId) return;
    if (planResolve !== "idle") return;
    if (plansLoading) return;
    const key = `${projectId}:${initialPlanId}`;
    if (consumedDeepLink.current === key) return;
    // 列表为空且无错误 = 尚未加载出结果：等待，不提前消费有效目标。
    if (plans.length === 0 && !plansError) return;
    consumedDeepLink.current = key;
    if (plansError) {
      showToast(`计划列表加载失败，无法确认深链计划归属：${plansError}`, { kind: "warning" });
      return;
    }
    const plan = plans.find((p) => p.id === initialPlanId);
    if (!plan || plan.workspace_project_id !== projectId) {
      showToast("该计划不存在或不属于当前项目，已忽略深链", { kind: "warning" });
      return;
    }
    if (activePlanId !== initialPlanId) void selectPlan(initialPlanId);
  }, [
    initialPlanId,
    projectId,
    planResolve,
    plans,
    plansLoading,
    plansError,
    activePlanId,
    selectPlan,
    showToast,
  ]);

  const switchView = (next: PlanningView) => {
    // 手动切换视图 = 用户接管：作废在途定位（防止迟到回包把视图拉回去），
    // 并清空旧定位残留，避免旧看板/里程碑的定位串到新视图。
    locateRunSeq.current += 1;
    setFocusFeatureId(null);
    setMilestoneFilterId(null);
    setView(next);
  };

  const openFeature = (featureId: string) => {
    setMilestoneFilterId(null);
    setFocusFeatureId(featureId);
    setView("features");
  };

  const openMilestone = (milestoneId: string) => {
    setFocusFeatureId(null);
    setMilestoneFilterId(milestoneId);
    setView("features");
  };

  // ── 精确定位意图（跨窗口导航 / Agent 操作链 → 规划功能）────────────
  // 意图的 projectId 是项目根（workspace_projects.id）；先对齐全局上下文，
  // 再由项目根快照解析计划，最后校验 feature/milestone 归属。
  const locateFeatureOrMilestone = useCallback(
    (target: { featureId?: string; milestoneId?: string }) => {
      const st = usePlanningStore.getState();
      // 竞态兜底：用户已手动切走（代际失效）或加载失败，放弃本次定位，不抢当前视图。
      if (st.featuresError) {
        showToast(`计划数据加载失败，无法精确定位：${st.featuresError}`, { kind: "error" });
        return;
      }
      if (target.featureId) {
        const feature = st.features.find((f) => f.id === target.featureId);
        if (feature && feature.project_id === st.activePlanId) {
          openFeature(feature.id);
        } else if (feature) {
          // 归属不符：其他计划的功能不当作定位成功，落回功能列表并明确反馈。
          setFocusFeatureId(null);
          setMilestoneFilterId(null);
          setView("features");
          showToast("功能不属于当前计划，已定位到功能列表", { kind: "warning" });
        } else {
          // 功能不存在：落到当前计划功能列表并反馈，不伪装定位成功。
          setFocusFeatureId(null);
          setMilestoneFilterId(null);
          setView("features");
          showToast("功能不存在或已被删除，已定位到功能列表", { kind: "warning" });
        }
        return;
      }
      if (target.milestoneId) {
        const milestone = st.milestones.find((m) => m.id === target.milestoneId);
        if (milestone && milestone.project_id === st.activePlanId) {
          openMilestone(milestone.id);
        } else if (milestone) {
          setFocusFeatureId(null);
          setMilestoneFilterId(null);
          setView("milestones");
          showToast("里程碑不属于当前计划，已定位到里程碑列表", { kind: "warning" });
        } else {
          // 里程碑不存在：落到里程碑列表并反馈，不伪装定位成功。
          setFocusFeatureId(null);
          setMilestoneFilterId(null);
          setView("milestones");
          showToast("里程碑不存在或已被删除，已定位到里程碑列表", { kind: "warning" });
        }
        return;
      }
      // 仅计划级定位 → 项目总览。
      setFocusFeatureId(null);
      setMilestoneFilterId(null);
      setView("overview");
    },
    [showToast],
  );

  const runRoadmapFocus = useCallback(
    async (target: { projectId: string; featureId?: string; milestoneId?: string }) => {
      const seq = ++locateRunSeq.current;
      const targetRoot = target.projectId;
      // 1. 对齐全局项目根（ADR-0010：导航 projectId 是项目根，不是计划 ID）。
      if (projectIdRef.current !== targetRoot) {
        const ok = await selectProject(targetRoot);
        if (seq !== locateRunSeq.current) return;
        if (!ok) {
          showToast("切换项目未完成，无法精确定位", { kind: "warning" });
          return;
        }
        // 自身触发的切换：等待上下文就位（有上限）；不算用户取消，也不误判失败。
        if (!(await waitForProjectContext(targetRoot))) return;
        if (seq !== locateRunSeq.current) return;
      }
      // 用户手动切走（等待期间改选了别的项目）：静默放弃，不抢当前视图、不误报失败。
      if (projectIdRef.current !== targetRoot) return;
      // 2. 由项目根权威快照解析计划（快照归属、计划有效性与数据落位都在解析器内校验）。
      const resolved = await resolvePlanForProject(targetRoot);
      if (seq !== locateRunSeq.current) return;
      if (projectIdRef.current !== targetRoot) return;
      if (!resolved.ok) {
        if (resolved.reason === "stale") return;
        if (resolved.reason === "no-plan") {
          showToast("该项目尚无可用计划，无法定位", { kind: "warning" });
        } else {
          showToast(`项目计划解析失败，无法定位：${resolved.message}`, { kind: "error" });
        }
        return;
      }
      // 3. 选中目标计划并确认上下文与数据就位，最后才定位对象。
      //    以 loadedForPlan 判定：并发解析可能已选中计划但数据仍在途，
      //    此时再调 selectPlan 会安全接管（同计划已就绪时内部 no-op）。
      const planId = resolved.planId;
      if (usePlanningStore.getState().loadedForPlan !== planId) {
        await selectPlan(planId);
      }
      if (seq !== locateRunSeq.current) return;
      if (projectIdRef.current !== targetRoot) return;
      const st = usePlanningStore.getState();
      if (st.activePlanId !== planId) return;
      if (st.loadedForPlan !== planId) {
        showToast(`计划数据加载失败，无法精确定位：${st.featuresError ?? "未知错误"}`, {
          kind: "error",
        });
        return;
      }
      locateFeatureOrMilestone(target);
    },
    [
      selectProject,
      waitForProjectContext,
      resolvePlanForProject,
      selectPlan,
      locateFeatureOrMilestone,
      showToast,
    ],
  );

  // 挂载与每次新 token 时消费一次：无意图/已过期（TTL）返回 null，静默跳过。
  const roadmapFocusRequest = useUiStore((s) => s.roadmapFocusRequest);
  const consumeRoadmapFocus = useUiStore((s) => s.consumeRoadmapFocus);
  useEffect(() => {
    if (!roadmapFocusRequest) return;
    const target = consumeRoadmapFocus();
    if (!target) return;
    void runRoadmapFocus(target);
  }, [roadmapFocusRequest, consumeRoadmapFocus, runRoadmapFocus]);

  // ── 全局搜索定位（planning 分类）────────────────────────────────────
  // 搜索契约（ADR-0010）：feature/milestone 的 parentId 是**计划 ID**，
  // workspaceProjectId 才是项目根；kind=project 的 target_id 也是计划 ID。
  // 缺 workspaceProjectId 时从 plans 列表（带 workspace_project_id）解析。
  const pendingLocate = useGlobalSearchStore((s) => s.pendingLocate);
  const consumeLocate = useGlobalSearchStore((s) => s.consumeLocate);
  const runPlanningSearchLocate = useCallback(
    async (intent: {
      kind: string;
      id: string;
      parentId: string | null;
      workspaceProjectId?: string | null;
    }) => {
      const seq = ++locateRunSeq.current;
      const planId = intent.kind === "project" ? intent.id : intent.parentId;
      let rootId = intent.workspaceProjectId ?? null;
      if (!planId) {
        showToast("目标不存在或已被删除", { kind: "warning" });
        return;
      }
      // 缺项目根：从计划列表解析归属（只读，不做任何选择）。
      // 列表加载失败 ≠ 孤儿计划，必须分别反馈。
      if (!rootId) {
        const before = usePlanningStore.getState();
        if (before.plans.length === 0 && !before.plansError) {
          await loadPlans();
          if (seq !== locateRunSeq.current) return;
        }
        const st = usePlanningStore.getState();
        if (st.plansError) {
          showToast(`计划列表加载失败，无法解析计划归属：${st.plansError}`, { kind: "error" });
          return;
        }
        const plan = st.plans.find((p) => p.id === planId);
        if (!plan) {
          showToast("计划不存在或已被删除，无法定位", { kind: "warning" });
          return;
        }
        rootId = plan.workspace_project_id ?? null;
        if (!rootId) {
          showToast("该计划未关联项目（旧数据），无法定位", { kind: "warning" });
          return;
        }
      }
      // 权威快照校验：项目根必须存在且 ID 一致；目标计划必须是该项目的当前激活计划
      //（本轮无多计划版本选择能力：无法确认归属的非激活计划明确拒绝，不自动激活）。
      let snap;
      try {
        snap = await projectHubGetProject(rootId);
      } catch (cause) {
        if (seq !== locateRunSeq.current) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        showToast(`项目快照加载失败，无法精确定位：${message}`, { kind: "error" });
        return;
      }
      if (seq !== locateRunSeq.current) return;
      if (snap.project.id !== rootId) {
        showToast("项目快照与目标项目不一致，已取消定位", { kind: "warning" });
        return;
      }
      if (snap.planId !== planId) {
        showToast("目标计划不是当前项目的激活计划，暂不支持打开", { kind: "warning" });
        return;
      }
      // 对齐全局项目根（selectProject 返回 true = 已真实落库且未被取代）。
      if (projectIdRef.current !== rootId) {
        const ok = await selectProject(rootId);
        if (seq !== locateRunSeq.current) return;
        if (!ok) {
          showToast("切换项目未完成，无法精确定位", { kind: "warning" });
          return;
        }
        if (!(await waitForProjectContext(rootId))) return;
        if (seq !== locateRunSeq.current) return;
      }
      if (projectIdRef.current !== rootId) return; // 用户已切走：静默放弃
      // 数据未就绪（含并发解析已选中但仍在途）时接管加载；已就绪时内部 no-op。
      if (usePlanningStore.getState().loadedForPlan !== planId) {
        await selectPlan(planId);
      }
      if (seq !== locateRunSeq.current) return;
      if (projectIdRef.current !== rootId) return;
      const st = usePlanningStore.getState();
      if (st.activePlanId !== planId) return;
      if (st.loadedForPlan !== planId) {
        showToast(`计划数据加载失败，无法精确定位：${st.featuresError ?? "未知错误"}`, {
          kind: "error",
        });
        return;
      }
      locateFeatureOrMilestone(
        intent.kind === "feature"
          ? { featureId: intent.id }
          : intent.kind === "milestone"
            ? { milestoneId: intent.id }
            : {},
      );
    },
    [
      selectProject,
      waitForProjectContext,
      loadPlans,
      selectPlan,
      locateFeatureOrMilestone,
      showToast,
    ],
  );

  useEffect(() => {
    if (!pendingLocate || pendingLocate.category !== "planning") return;
    const intent = pendingLocate;
    consumeLocate();
    void runPlanningSearchLocate({
      kind: intent.kind,
      id: intent.id,
      parentId: intent.parentId,
      workspaceProjectId: intent.workspaceProjectId,
    });
    // 仅响应定位意图变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLocate]);

  // ── 全局无项目：明确空态，不自动选任何项目 ─────────────────────────
  if (!projectId) {
    return (
      <div className="planning-workspace page-fill">
        <div className="planning-view-bar">
          <div className="planning-view-tabs" role="tablist" aria-label="规划视图">
            {VIEW_TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.key}
                  role="tab"
                  aria-selected={false}
                  disabled
                  className="planning-view-tab"
                >
                  <Icon size={13} aria-hidden="true" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="page-scroll planning-view-body">
          <div className="planning-empty-features" role="note">
            <p>尚未选择项目。规划围绕全局项目展开：请使用顶栏的项目选择器选择项目，
              或到项目中枢创建。</p>
          </div>
        </div>
      </div>
    );
  }

  // ── 当前项目无可用计划：明确空态 ───────────────────────────────────
  if (planResolve === "no-plan") {
    return (
      <div className="planning-workspace page-fill">
        <div className="planning-view-bar">
          <div className="planning-view-project">
            <span className="planning-view-project-label">当前项目</span>
            <strong className="planning-view-project-name">{selectedProject?.name ?? "…"}</strong>
          </div>
        </div>
        <div className="page-scroll planning-view-body">
          <div className="planning-empty-features" role="note">
            <p>当前项目尚无可用计划。可以在项目中枢为新项目创建计划后再回来编辑。</p>
          </div>
        </div>
      </div>
    );
  }

  const planResolveFailed = planResolve === "error";

  return (
    <div className="planning-workspace page-fill">
      <div className="planning-view-bar">
        <div className="planning-view-tabs" role="tablist" aria-label="规划视图">
          {VIEW_TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                role="tab"
                aria-selected={view === tab.key}
                className={`planning-view-tab ${view === tab.key ? "is-active" : ""}`}
                onClick={() => switchView(tab.key)}
              >
                <Icon size={13} aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </div>
        {view !== "overview" && (
          <div className="planning-view-project">
            <span className="planning-view-project-label">当前项目</span>
            <strong className="planning-view-project-name">
              {selectedProject?.name ?? "…"}
            </strong>
          </div>
        )}
      </div>

      <div className="page-scroll planning-view-body">
        {planResolveFailed ? (
          <div className="planning-error" role="alert">
            <span>项目计划解析失败：{planResolveError}</span>
            <button
              className="btn sm"
              onClick={() => projectId && void resolvePlanForProject(projectId)}
            >
              重试
            </button>
          </div>
        ) : null}
        {planResolve === "loading" && !activePlanId ? (
          <div className="planning-loading" role="status">正在解析当前项目的计划…</div>
        ) : null}
        {view === "overview" && activePlanId ? (
          <ProjectsView
            onOpenFeatures={() => switchView("features")}
            onOpenMilestones={() => switchView("milestones")}
          />
        ) : null}
        {view !== "overview" && activePlanId ? (
          <>
            {view === "features" && (
              <FeatureListView
                focusFeatureId={focusFeatureId}
                milestoneFilterId={milestoneFilterId}
                onFocusConsumed={() => setFocusFeatureId(null)}
                onClearMilestoneFilter={() => setMilestoneFilterId(null)}
                onOpenMilestones={() => switchView("milestones")}
              />
            )}
            {view === "kanban" && (
              <PlanningKanban
                onOpenFeature={openFeature}
                onOpenFeatureList={() => switchView("features")}
              />
            )}
            {view === "milestones" && <MilestonesView onOpenFeatures={openMilestone} />}
          </>
        ) : null}
      </div>
    </div>
  );
}
