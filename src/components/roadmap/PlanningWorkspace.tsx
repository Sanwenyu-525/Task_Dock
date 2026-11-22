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
  const resolvePlanForProject = useCallback(
    async (pid: string): Promise<string | null> => {
      const seq = ++planResolveSeq.current;
      setPlanResolve("loading");
      setPlanResolveError(null);
      try {
        const snap = await projectHubGetProject(pid);
        if (seq !== planResolveSeq.current) return null;
        if (!snap.planId) {
          setPlanResolve("no-plan");
          return null;
        }
        const st = usePlanningStore.getState();
        if (!(st.activePlanId === snap.planId && st.loadedForPlan === snap.planId)) {
          await selectPlan(snap.planId);
          if (seq !== planResolveSeq.current) return null;
        }
        setPlanResolve("idle");
        return snap.planId;
      } catch (cause) {
        if (seq !== planResolveSeq.current) return null;
        setPlanResolve("error");
        setPlanResolveError(cause instanceof Error ? cause.message : String(cause));
        return null;
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
  // 目标计划必须归属当前项目根；归属可证时不静默换计划。
  const deepLinkApplied = useRef(false);
  useEffect(() => {
    if (deepLinkApplied.current) return;
    if (!initialPlanId || !projectId) return;
    if (planResolve === "loading") return;
    deepLinkApplied.current = true;
    const plan = plans.find((p) => p.id === initialPlanId);
    if (plan?.workspace_project_id && plan.workspace_project_id !== projectId) {
      showToast("该计划不属于当前项目，已忽略深链", { kind: "warning" });
      return;
    }
    if (activePlanId !== initialPlanId) void selectPlan(initialPlanId);
  }, [initialPlanId, projectId, planResolve, plans, activePlanId, selectPlan, showToast]);

  const switchView = (next: PlanningView) => {
    // 手动切换视图时清空跳转定位，避免旧看板/里程碑的定位残留
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
  const locateRunSeq = useRef(0);
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
        if (feature) {
          openFeature(feature.id);
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
        if (milestone) {
          openMilestone(milestone.id);
        } else {
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
      // 1. 全局项目上下文对齐目标项目根（ADR-0010：导航 projectId 是项目根，
      //    不能再拿它与 planning store 的计划 ID 比较）。
      if (target.projectId !== projectId) {
        const ok = await selectProject(target.projectId);
        if (seq !== locateRunSeq.current) return;
        if (!ok) {
          showToast("切换项目未完成，无法精确定位", { kind: "warning" });
          return;
        }
      }
      // 2. 由项目根权威快照解析 activePlanId（显式 planId 缺省时用它）。
      const planId = await resolvePlanForProject(target.projectId);
      if (seq !== locateRunSeq.current) return;
      if (!planId) {
        showToast("该项目尚无可用计划，无法定位", { kind: "warning" });
        return;
      }
      // 3. 选中计划并加载，然后定位对象。
      await selectPlan(planId);
      if (seq !== locateRunSeq.current) return;
      locateFeatureOrMilestone(target);
    },
    [projectId, selectProject, resolvePlanForProject, selectPlan, locateFeatureOrMilestone, showToast],
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
      let planId = intent.kind === "project" ? intent.id : intent.parentId;
      let rootId = intent.workspaceProjectId ?? null;
      if (!rootId && planId) {
        // 计划列表未就绪时补一次加载（只用于解析归属，不做任何选择）。
        const st0 = usePlanningStore.getState();
        if (st0.plans.length === 0 && !st0.plansLoading && !st0.plansError) {
          await loadPlans();
          if (seq !== locateRunSeq.current) return;
        }
        const plan = usePlanningStore.getState().plans.find((p) => p.id === planId);
        rootId = plan?.workspace_project_id ?? null;
      }
      if (!planId) {
        showToast("目标不存在或已被删除", { kind: "warning" });
        return;
      }
      if (!rootId) {
        showToast("该计划未关联项目（旧数据），无法定位", { kind: "warning" });
        return;
      }
      if (rootId !== projectId) {
        const ok = await selectProject(rootId);
        if (seq !== locateRunSeq.current) return;
        if (!ok) {
          showToast("切换项目未完成，无法精确定位", { kind: "warning" });
          return;
        }
      }
      await selectPlan(planId);
      if (seq !== locateRunSeq.current) return;
      locateFeatureOrMilestone(
        intent.kind === "feature"
          ? { featureId: intent.id }
          : intent.kind === "milestone"
            ? { milestoneId: intent.id }
            : {},
      );
    },
    [projectId, selectProject, loadPlans, selectPlan, locateFeatureOrMilestone, showToast],
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
