//! 规划中心「我的项目」工作区：四视图 Tab + 项目引导加载 + 跨视图跳转状态。
//!
//! - 视图：项目总览 / 功能列表·详情 / 功能看板 / 里程碑；
//! - 首次挂载加载项目列表，并自动选中第一个未归档项目（之后由用户显式切换）；
//! - 看板点卡片 → 功能视图并展开同一张卡片；里程碑「查看关联功能」→ 功能视图
//!   并预选该里程碑；这两类跳转状态只存在于工作区，不写进 Store，避免污染持久数据；
//! - 精确定位意图（useUiStore.roadmapFocusRequest）：工具面板发起的一次性跳转，
//!   挂载或新 token 时消费一次；目标可能已被删除，按「尽力定位 + 明确反馈」兜底，
//!   不在导航前预改 planning store 状态；
//! - 不轮询、不重复加载：项目切换统一走 selectProject 的代际防护。

import { useCallback, useEffect, useRef, useState } from "react";
import { Flag, KanbanSquare, LayoutList, LayoutDashboard } from "lucide-react";
import { usePlanningStore } from "../../store/usePlanningStore";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";
import { useUiStore } from "../../store/useUiStore";
import ProjectsView from "./ProjectsView";
import FeatureListView from "./FeatureListView";
import PlanningKanban from "./PlanningKanban";
import MilestonesView from "./MilestonesView";
import { PlanningProjectPicker } from "./PlanningBits";

type PlanningView = "overview" | "features" | "kanban" | "milestones";

const VIEW_TABS: { key: PlanningView; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "overview", label: "项目总览", icon: LayoutDashboard },
  { key: "features", label: "功能列表", icon: LayoutList },
  { key: "kanban", label: "功能看板", icon: KanbanSquare },
  { key: "milestones", label: "里程碑", icon: Flag },
];

export default function PlanningWorkspace() {
  const projects = usePlanningStore((s) => s.projects);
  const projectsLoading = usePlanningStore((s) => s.projectsLoading);
  const projectsError = usePlanningStore((s) => s.projectsError);
  const loadProjects = usePlanningStore((s) => s.loadProjects);
  const activeProjectId = usePlanningStore((s) => s.activeProjectId);
  const selectProject = usePlanningStore((s) => s.selectProject);
  const showToast = useUiStore((s) => s.showToast);

  const [view, setView] = useState<PlanningView>("overview");
  const [focusFeatureId, setFocusFeatureId] = useState<string | null>(null);
  const [milestoneFilterId, setMilestoneFilterId] = useState<string | null>(null);

  // 首次进入只加载一次：空项目列表是正常结果，不能因 projects.length 仍为 0 再次请求。
  // 失败时由总览视图展示错误与手动重试，不在后台自动循环重试。
  const bootstrapRequested = useRef(false);
  useEffect(() => {
    if (bootstrapRequested.current) return;
    bootstrapRequested.current = true;
    if (projects.length === 0 && !projectsLoading && !projectsError) {
      void loadProjects();
    }
  }, [projects.length, projectsLoading, projectsError, loadProjects]);

  // 自动选中第一个未归档项目；用户随后手动切换
  useEffect(() => {
    if (activeProjectId) return;
    const first = projects.find((p) => !p.archived) ?? projects[0];
    if (first) void selectProject(first.id);
  }, [projects, activeProjectId, selectProject]);

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

  // ── 精确定位意图（工具面板「规划中心」→ 完整面板）──────────────
  // 代际防乱序：连续两次意图只执行最新一次；selectProject 内部另有 featuresSeq，
  // 迟到的响应不会把别的项目数据覆盖进来。
  const locateRunSeq = useRef(0);
  const runRoadmapFocus = useCallback(
    async (target: { projectId: string; featureId?: string; milestoneId?: string }) => {
      const seq = ++locateRunSeq.current;
      // 项目列表尚未就绪（挂载即定位的窗口期）先补一次加载；已有列表则直接判断存在性。
      const st0 = usePlanningStore.getState();
      if (st0.projects.length === 0 && (st0.projectsLoading || st0.projectsError === null)) {
        await loadProjects();
      }
      if (seq !== locateRunSeq.current) return;
      if (!usePlanningStore.getState().projects.some((p) => p.id === target.projectId)) {
        // 项目已删除：不切换任何视图，明确反馈（不预改 planning store 状态）。
        showToast("项目不存在或已删除", { kind: "warning" });
        return;
      }
      await selectProject(target.projectId);
      if (seq !== locateRunSeq.current) return;
      const st = usePlanningStore.getState();
      // 竞态兜底：用户已手动切走（代际失效）或加载失败，放弃本次定位，不抢当前视图。
      if (st.activeProjectId !== target.projectId || st.loadedForProject !== target.projectId) {
        return;
      }
      if (st.featuresError) {
        showToast(`项目数据加载失败，无法精确定位：${st.featuresError}`, { kind: "error" });
        return;
      }
      if (target.featureId) {
        const feature = st.features.find((f) => f.id === target.featureId);
        if (feature) {
          openFeature(feature.id);
        } else {
          // 功能不存在：落到该项目功能列表并反馈，不伪装定位成功。
          setFocusFeatureId(null);
          setMilestoneFilterId(null);
          setView("features");
          showToast("功能不存在或已被删除，已定位到项目功能列表", { kind: "warning" });
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
          showToast("里程碑不存在或已被删除，已定位到项目里程碑列表", { kind: "warning" });
        }
        return;
      }
      // 仅项目级定位 → 项目总览。
      setFocusFeatureId(null);
      setMilestoneFilterId(null);
      setView("overview");
    },
    [loadProjects, selectProject, showToast],
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

  // 全局搜索定位：按结果类型分发到既有视图跳转（不修改任何规划数据）。
  // feature/milestone 先确保所属项目被选中，再复用 openFeature/openMilestone。
  const pendingLocate = useGlobalSearchStore((s) => s.pendingLocate);
  const consumeLocate = useGlobalSearchStore((s) => s.consumeLocate);
  useEffect(() => {
    if (!pendingLocate || pendingLocate.category !== "planning") return;
    const intent = pendingLocate;
    consumeLocate();
    const switchProject = async (projectId: string) => {
      if (projectId && projectId !== activeProjectId) {
        await Promise.resolve(selectProject(projectId));
      }
    };
    if (intent.kind === "project") {
      void switchProject(intent.id).then(() => setView("overview"));
    } else if (intent.kind === "feature") {
      void switchProject(intent.parentId ?? "").then(() => openFeature(intent.id));
    } else if (intent.kind === "milestone") {
      void switchProject(intent.parentId ?? "").then(() => openMilestone(intent.id));
    }
    // 仅响应定位意图变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLocate]);

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
            <PlanningProjectPicker
              projects={projects}
              activeProjectId={activeProjectId}
              onChange={(id) => void selectProject(id)}
            />
          </div>
        )}
      </div>

      <div className="page-scroll planning-view-body">
        {view === "overview" && (
          <ProjectsView
            onOpenFeatures={() => switchView("features")}
            onOpenMilestones={() => switchView("milestones")}
          />
        )}
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
      </div>
    </div>
  );
}
