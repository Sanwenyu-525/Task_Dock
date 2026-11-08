//! 规划中心面板（胶囊内）：当前项目的功能列表、步骤勾选与完整入口。
//!
//! 边界：重型编辑（项目 / 功能 / 里程碑 CRUD、看板与历史）仍在完整规划中心；
//! 胶囊只复用 `usePlanningStore` 的既有数据与命令，不新增 IPC、不新增轮询：
//! - 挂载时 `loadProjects()`，并按既有 `activeProjectId` / 第一个未归档项目选择一次；
//!   选择用挂载标记守卫，空项目不会让 effect 反复重发 IPC（v0.7 的 P0 回归点）；
//! - `planning-changed` 订阅由 store 统一懒注册，面板不复制第二套刷新逻辑；
//! - 切换项目只走 `selectProject`（带请求代际，旧响应自动丢弃）；
//! - 步骤勾选走 `updateStep`，失败保留后端原状并提示，不做乐观伪造。
//!
//! 项目切换采用面板内二级视图（不是浮层菜单）：胶囊是 Win32 `SetWindowRgn`
//! 裁剪窗口，弹出到面板外的下拉菜单会被裁掉；二级视图始终落在 340×440 的
//! 可见矩形内，也沿用既有的 PanelKit 外壳与胶囊行样式。
//!
//! 数据来源有两种（与完整规划中心一致）：
//! - 我的项目：用户自建 `planning_*` 数据，可勾选步骤；
//! - 内置路线图：`lib/featureCatalog.ts` 静态目录（只读），不触达用户数据。
//! 用户没有任何项目时默认落到内置路线图，否则面板只剩一个空态，用户会以为
//! 「路线图没显示」；有项目时仍在顶部分段开关手动切换。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, FolderKanban, Map as MapIcon } from "lucide-react";
import {
  type PlanningFeature,
  type PlanningFeatureStatus,
  type PlanningProject,
  type PlanningStep,
} from "../../lib/bridge";
import {
  CATEGORY_META,
  FEATURE_CATALOG,
  STATUS_META,
  featuresByCategory,
  type FeatureEntry,
  type FeatureStatus,
} from "../../lib/featureCatalog";
import { usePlanningStore } from "../../store/usePlanningStore";
import { PlanningFeatureStatusBadge, PlanningProgressBar } from "../roadmap/PlanningBits";
import { openFullApp } from "./actions";
import { EmptyState, PanelHead, Segmented, type SegOption } from "./PanelKit";

type View = "features" | "projects";
type Source = "mine" | "builtin";
type Filter = "all" | "todo" | "active" | "done";

const SOURCES: readonly SegOption<Source>[] = [
  { value: "mine", label: "我的项目" },
  { value: "builtin", label: "内置路线图" },
];

const FILTERS: readonly SegOption<Filter>[] = [
  { value: "all", label: "全部" },
  { value: "todo", label: "待办" },
  { value: "active", label: "进行中" },
  { value: "done", label: "已完成" },
];

/** 内置路线图是静态目录：分组与总数在模块级算一次，切换来源不重复遍历。 */
const BUILTIN_GROUPS = featuresByCategory();
const BUILTIN_IMPLEMENTED = FEATURE_CATALOG.filter((f) => f.status === "implemented").length;

/** 内置路线图状态 → 既有胶囊药丸语义色（文案仍用目录的 STATUS_META）。 */
const BUILTIN_STATUS_TONE: Record<FeatureStatus, string> = {
  implemented: "tone-done",
  partial: "tone-soon",
  planned: "",
  blocked: "tone-overdue",
};

/**
 * 展示分组（只影响筛选，不改变后端状态）：
 * 待办 = 未开始 / 已暂停；进行中 = 进行中 / 评审 / 阻塞。
 */
function matchesFilter(status: PlanningFeatureStatus, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "todo":
      return status === "planned" || status === "paused";
    case "active":
      return status === "in_progress" || status === "review" || status === "blocked";
    case "done":
      return status === "completed";
  }
}

/** 面板内排序：需要推进的在前，已完成沉底；同状态保持用户排序（sort_order）。 */
const STATUS_ORDER: Record<PlanningFeatureStatus, number> = {
  in_progress: 0,
  blocked: 1,
  review: 2,
  planned: 3,
  paused: 4,
  completed: 5,
};

function statsText(project: PlanningProject | null): string {
  if (!project) return "未选择项目";
  if (!project.stats.has_features) return "尚未添加功能";
  return `${project.stats.feature_completed}/${project.stats.feature_total} 完成 · ${project.stats.progress_percent}%`;
}

function projectProgressText(project: PlanningProject): string {
  if (!project.stats.has_features) return "尚未添加功能";
  return `${project.stats.feature_completed}/${project.stats.feature_total} 完成`;
}

export default function PlanningLite() {
  const projects = usePlanningStore((s) => s.projects);
  const projectsLoading = usePlanningStore((s) => s.projectsLoading);
  const projectsError = usePlanningStore((s) => s.projectsError);
  const loadProjects = usePlanningStore((s) => s.loadProjects);
  const activeProjectId = usePlanningStore((s) => s.activeProjectId);
  const features = usePlanningStore((s) => s.features);
  const featuresError = usePlanningStore((s) => s.featuresError);
  const loadedForProject = usePlanningStore((s) => s.loadedForProject);
  const updateStep = usePlanningStore((s) => s.updateStep);

  const [view, setView] = useState<View>("features");
  const [source, setSource] = useState<Source>("mine");
  const [filter, setFilter] = useState<Filter>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 首次读取完成前不渲染「还没有项目」空态，避免加载中的一帧误报。 */
  const [bootedState, setBootedState] = useState(false);
  const noticeTimer = useRef<number | null>(null);
  // 挂载期只自动选择一次：空项目时任何依赖 projects/loading 的 effect 都会
  // 反复成立，必须用标记而不是「列表为空就再试」。
  const booted = useRef(false);

  const flash = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2400);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  // 打开面板：读项目列表；已有当前项目（完整页可能已选）就沿用，否则选第一个
  // 未归档项目。只执行一次，失败由错误态提供显式重试。
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      const store = usePlanningStore.getState();
      await store.loadProjects();
      const state = usePlanningStore.getState();
      const target =
        state.projects.find((p) => p.id === state.activeProjectId) ??
        state.projects.find((p) => !p.archived) ??
        state.projects[0];
      // 项目列表已就绪：先放行项目空态/列表，功能加载由各视图自己的 loading 表达。
      setBootedState(true);
      // 没有任何用户项目时直接展示内置路线图：否则面板只剩空态，
      // 用户会误以为「路线图没显示」。读取失败不切换，错误态仍给重试。
      if (!state.projectsError && state.projects.length === 0) {
        setSource("builtin");
        return;
      }
      if (!target) return;
      if (state.loadedForProject !== target.id || state.featuresError) {
        await usePlanningStore.getState().selectProject(target.id);
      }
    })();
  }, []);

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const orderedProjects = useMemo(() => {
    // 未归档优先；组内保持用户排序（sort_order）。
    return [...projects].sort(
      (a, b) => Number(a.archived) - Number(b.archived) || a.sort_order - b.sort_order,
    );
  }, [projects]);

  const scopeReady = activeProjectId !== null && loadedForProject === activeProjectId;

  const visible = useMemo(() => {
    // 数据范围与当前项目不一致时视为读取中：不拿上一个项目的功能冒充当前项目。
    if (!scopeReady) return null;
    const list = features.filter((f) => matchesFilter(f.status, filter));
    return list.sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.sort_order - b.sort_order,
    );
  }, [scopeReady, features, filter]);

  const openProject = (id: string) => {
    setExpandedId(null);
    setView("features");
    void usePlanningStore.getState().selectProject(id);
  };

  const toggleStep = async (step: PlanningStep) => {
    if (busyStep) return;
    setBusyStep(step.id);
    try {
      await updateStep(step.id, { done: !step.done });
    } catch {
      flash("步骤更新失败，请重试");
    } finally {
      setBusyStep(null);
    }
  };

  // ── 项目列表（二级视图）──────────────────────────────────────────
  if (view === "projects") {
    return (
      <>
        <PanelHead
          title="规划中心"
          sub={!bootedState ? "读取中" : projects.length > 0 ? `${projects.length} 个项目` : "暂无项目"}
          actions={
            <button
              type="button"
              className="cap-iconbtn"
              aria-label="返回规划面板"
              onClick={() => setView("features")}
            >
              <ChevronLeft size={16} strokeWidth={2.2} aria-hidden="true" />
            </button>
          }
        />
        <div className="cap-list">
          {!bootedState || (projectsLoading && projects.length === 0) ? (
            <EmptyState
              icon={<MapIcon size={22} strokeWidth={1.6} aria-hidden="true" />}
              text="正在读取项目…"
            />
          ) : null}
          {bootedState && projectsError && projects.length === 0 && (
            <EmptyState
              icon={<MapIcon size={22} strokeWidth={1.6} aria-hidden="true" />}
              text="项目列表读取失败"
              actionLabel="重试"
              onAction={() => void loadProjects()}
            />
          )}
          {bootedState && !projectsLoading && !projectsError && projects.length === 0 && (
            <EmptyState
              icon={<FolderKanban size={22} strokeWidth={1.6} aria-hidden="true" />}
              text="还没有规划项目"
              actionLabel="去完整规划中心创建"
              onAction={() => openFullApp("roadmap")}
            />
          )}
          {orderedProjects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={`cap-item cap-plan-row cap-plan-project${
                project.id === activeProjectId ? " is-active" : ""
              }`}
              aria-label={`打开项目「${project.name}」`}
              aria-pressed={project.id === activeProjectId}
              onClick={() => openProject(project.id)}
            >
              <span className="cap-main">
                <span className="cap-plan-line">
                  <span className="cap-item-title">{project.name}</span>
                  {project.archived ? <span className="cap-tag">已归档</span> : null}
                </span>
                <span className="cap-item-sub">{projectProgressText(project)}</span>
                {project.stats.has_features ? (
                  <PlanningProgressBar value={project.stats.progress_percent} />
                ) : null}
              </span>
              <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          ))}
        </div>
        <div className="cap-foot">
          <span className="cap-foot-note">
            <MapIcon size={12} strokeWidth={1.8} aria-hidden="true" />
            选择项目查看功能
          </span>
          <button type="button" className="cap-link" onClick={() => openFullApp("roadmap")}>
            完整规划
            <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      </>
    );
  }

  // ── 功能列表（一级视图）──────────────────────────────────────────
  const projectName = activeProject?.name ?? "未选择项目";
  const showingBuiltin = source === "builtin";
  const emptyProjectList =
    bootedState && !projectsLoading && !projectsError && projects.length === 0;
  const noActiveProject =
    bootedState && !projectsLoading && !projectsError && projects.length > 0 && !activeProject;
  const donePct = activeProject?.stats.has_features
    ? activeProject.stats.progress_percent
    : 0;

  return (
    <>
      <PanelHead
        title="规划中心"
        sub={
          !bootedState
            ? "读取中"
            : showingBuiltin
              ? `内置路线图 · ${FEATURE_CATALOG.length} 项 · 已实现 ${BUILTIN_IMPLEMENTED}`
              : activeProject
                ? `${projectName} · ${statsText(activeProject)}`
                : projectName
        }
        actions={
          showingBuiltin ? undefined : (
            <button
              type="button"
              className="cap-iconbtn"
              aria-label="切换规划项目"
              onClick={() => setView("projects")}
            >
              <FolderKanban size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          )
        }
      />

      <Segmented label="规划数据来源" options={SOURCES} value={source} onChange={setSource} />
      {!showingBuiltin && (
        <Segmented label="功能筛选" options={FILTERS} value={filter} onChange={setFilter} />
      )}

      {showingBuiltin ? (
        <div className="cap-list">
          {BUILTIN_GROUPS.map(({ category, items }) => (
            <section
              key={category}
              className="cap-plan-section"
              aria-label={CATEGORY_META[category].label}
            >
              <div className="cap-plan-section-head">
                <span className="cap-plan-section-title">{CATEGORY_META[category].label}</span>
                <span className="cap-plan-section-count">{items.length}</span>
              </div>
              {items.map((f) => (
                <BuiltinFeatureRow
                  key={f.id}
                  feature={f}
                  open={expandedId === f.id}
                  onToggle={() => setExpandedId((cur) => (cur === f.id ? null : f.id))}
                />
              ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="cap-list">
        {bootedState && projectsError && projects.length === 0 && (
          <EmptyState
            icon={<MapIcon size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="项目列表读取失败"
            actionLabel="重试"
            onAction={() => void loadProjects()}
          />
        )}

        {emptyProjectList && (
          <EmptyState
            icon={<FolderKanban size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="还没有规划项目"
            actionLabel="去完整规划中心创建"
            onAction={() => openFullApp("roadmap")}
          />
        )}

        {noActiveProject && (
          <EmptyState
            icon={<FolderKanban size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="选择一个项目查看功能"
            actionLabel="选择项目"
            onAction={() => setView("projects")}
          />
        )}

        {activeProject &&
          featuresError &&
          loadedForProject !== activeProjectId && (
            <EmptyState
              icon={<MapIcon size={22} strokeWidth={1.6} aria-hidden="true" />}
              text="功能列表读取失败"
              actionLabel="重试"
              onAction={() => void usePlanningStore.getState().selectProject(activeProject.id)}
            />
          )}

        {activeProject && featuresError && loadedForProject === activeProjectId && (
          <div className="cap-item cap-error-row" role="alert">
            <span className="cap-error-text">刷新失败，显示的是上次结果</span>
            <button
              type="button"
              className="cap-mini"
              aria-label="重试读取功能列表"
              onClick={() => void usePlanningStore.getState().selectProject(activeProject.id)}
            >
              重试
            </button>
          </div>
        )}

        {activeProject && !scopeReady && !featuresError && (
          <EmptyState
            icon={<MapIcon size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="正在读取功能…"
          />
        )}

        {activeProject &&
          scopeReady &&
          visible !== null &&
          visible.length === 0 && (
            <EmptyState
              icon={<FolderKanban size={22} strokeWidth={1.6} aria-hidden="true" />}
              text={features.length === 0 ? "这个项目还没有功能" : "当前筛选没有功能"}
              actionLabel={features.length === 0 ? "去完整规划中心添加" : undefined}
              onAction={features.length === 0 ? () => openFullApp("roadmap") : undefined}
            />
          )}

        {activeProject &&
          scopeReady &&
          visible?.map((feature) => (
            <FeatureRow
              key={feature.id}
              feature={feature}
              open={expandedId === feature.id}
              busyStep={busyStep}
              onToggle={() => setExpandedId((cur) => (cur === feature.id ? null : feature.id))}
              onToggleStep={toggleStep}
            />
          ))}
      </div>
      )}

      {showingBuiltin ? (
        <div className="cap-foot">
          <span className="cap-foot-note">
            <MapIcon size={12} strokeWidth={1.8} aria-hidden="true" />
            只读 · 来自功能目录
          </span>
          <button type="button" className="cap-link" onClick={() => openFullApp("roadmap")}>
            完整规划
            <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="cap-foot">
          <span className="cap-foot-note">
            <MapIcon size={12} strokeWidth={1.8} aria-hidden="true" />
            {notice ?? statsText(activeProject)}
          </span>
          {activeProject?.stats.has_features ? (
            <span className="cap-progress" aria-hidden="true">
              <i style={{ width: `${donePct}%` }} />
            </span>
          ) : null}
          <button type="button" className="cap-link" onClick={() => openFullApp("roadmap")}>
            完整规划
            <ChevronRight size={12} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}

function FeatureRow({
  feature,
  open,
  busyStep,
  onToggle,
  onToggleStep,
}: {
  feature: PlanningFeature;
  open: boolean;
  busyStep: string | null;
  onToggle: () => void;
  onToggleStep: (step: PlanningStep) => Promise<void>;
}) {
  return (
    <div className={`cap-plan-feature${open ? " is-open" : ""}`}>
      <div className="cap-item cap-plan-feature-head">
        <button
          type="button"
          className="cap-main cap-row-open"
          aria-label={`${open ? "收起" : "查看"}「${feature.title}」详情`}
          aria-expanded={open}
          aria-controls={`plan-feature-${feature.id}`}
          onClick={onToggle}
        >
          <span className="cap-plan-line">
            <span className="cap-item-title">{feature.title}</span>
            <PlanningFeatureStatusBadge status={feature.status} />
          </span>
          <span className="cap-plan-meta">
            <span
              className={`cap-pill cap-plan-prio${
                feature.priority === "P0"
                  ? " tone-overdue"
                  : feature.priority === "P1"
                    ? " tone-soon"
                    : ""
              }`}
            >
              {feature.priority}
            </span>
            {feature.milestone_name ? (
              <span className="cap-item-sub">{feature.milestone_name}</span>
            ) : null}
            <span className="cap-item-sub">
              {feature.step_total > 0
                ? `${feature.step_done}/${feature.step_total} 步骤`
                : "未拆分步骤"}
            </span>
          </span>
        </button>
      </div>

      {open && (
        <div className="cap-task-detail cap-plan-detail" id={`plan-feature-${feature.id}`}>
          {feature.description ? (
            <p className="cap-detail-desc">{feature.description}</p>
          ) : (
            <p className="cap-detail-desc is-muted">暂无描述</p>
          )}
          {feature.acceptance_criteria ? (
            <div className="cap-detail-row">
              <span className="cap-detail-label">验收</span>
              <span className="cap-detail-value">{feature.acceptance_criteria}</span>
            </div>
          ) : null}

          {feature.steps.length > 0 ? (
            <div className="cap-plan-steps" role="group" aria-label={`「${feature.title}」的步骤`}>
              {feature.steps.map((step) => (
                <button
                  key={step.id}
                  type="button"
                  className="cap-plan-step"
                  aria-pressed={step.done}
                  aria-label={
                    step.done ? `重新打开步骤「${step.title}」` : `完成步骤「${step.title}」`
                  }
                  disabled={busyStep === step.id}
                  onClick={() => void onToggleStep(step)}
                >
                  <span className={`cap-check${step.done ? " is-checked" : ""}`} aria-hidden="true">
                    <Check size={11} strokeWidth={3} />
                  </span>
                  <span className={`cap-plan-step-text${step.done ? " is-done" : ""}`}>
                    {step.title}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="cap-detail-desc is-muted">尚未拆分步骤</p>
          )}

          <div className="cap-detail-actions">
            <button type="button" className="cap-mini" onClick={() => openFullApp("roadmap")}>
              完整规划
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 内置路线图行（只读）：目录条目没有步骤与里程碑，数据全部来自
 * `featureCatalog.ts`，因此不接 store、不发 IPC；展开只展示目录里的
 * 详情与阻塞原因，编辑仍回完整规划中心。
 */
function BuiltinFeatureRow({
  feature,
  open,
  onToggle,
}: {
  feature: FeatureEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const tone = BUILTIN_STATUS_TONE[feature.status];
  return (
    <div className={`cap-plan-feature${open ? " is-open" : ""}`}>
      <div className="cap-item cap-plan-feature-head">
        <button
          type="button"
          className="cap-main cap-row-open"
          aria-label={`${open ? "收起" : "查看"}「${feature.title}」详情`}
          aria-expanded={open}
          aria-controls={`plan-builtin-${feature.id}`}
          onClick={onToggle}
        >
          <span className="cap-plan-line">
            <span className="cap-item-title">{feature.title}</span>
            <span className={`cap-pill cap-plan-prio${tone ? ` ${tone}` : ""}`}>
              {STATUS_META[feature.status].label}
            </span>
          </span>
          <span className="cap-plan-meta">
            <span
              className={`cap-pill cap-plan-prio${
                feature.priority === "P0"
                  ? " tone-overdue"
                  : feature.priority === "P1"
                    ? " tone-soon"
                    : ""
              }`}
            >
              {feature.priority}
            </span>
            <span className="cap-item-sub">{feature.description}</span>
          </span>
        </button>
      </div>

      {open && (
        <div className="cap-task-detail cap-plan-detail" id={`plan-builtin-${feature.id}`}>
          <p className="cap-detail-desc">{feature.detail}</p>
          {feature.status === "blocked" && feature.blockedReason ? (
            <div className="cap-detail-row">
              <span className="cap-detail-label">阻塞</span>
              <span className="cap-detail-value">{feature.blockedReason}</span>
            </div>
          ) : null}
          <div className="cap-detail-actions">
            <button type="button" className="cap-mini" onClick={() => openFullApp("roadmap")}>
              完整规划
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
