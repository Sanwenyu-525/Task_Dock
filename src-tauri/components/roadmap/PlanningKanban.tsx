//! 规划中心「功能看板」视图。
//!
//! - 四列：待开发 / 开发中 / 待验收 / 已完成；受阻、已暂停不能隐藏：
//!   顶部常驻计数徽标可直接切到对应状态列表；状态下拉也包含它们；
//! - 不引入拖拽库：卡片内状态下拉调用 updateFeature，失败时 Store 不更新，
//!   界面自动保持原状态（无假成功），并 Toast 提示；
//! - 卡片点击进入功能详情（由工作区切到功能视图并展开同一张卡片）；
//! - 每列默认最多渲染 40 张，超出用「显示更多」，避免一次渲染数千卡片。

import { useMemo, useState } from "react";
import { AlertTriangle, ChevronRight, Loader2, PauseCircle, Plus } from "lucide-react";
import { Select } from "../ui";
import {
  PLANNING_FEATURE_STATUS_LABELS,
  type PlanningFeature,
  type PlanningFeatureStatus,
} from "../../lib/bridge";
import { usePlanningStore } from "../../store/usePlanningStore";
import { useUiStore } from "../../store/useUiStore";
import { PlanningFeatureStatusBadge, PlanningProgressBar } from "./PlanningBits";
import { stepProgressText } from "./PlanningFeatureCard";

export interface PlanningKanbanProps {
  onOpenFeature: (featureId: string) => void;
  onOpenFeatureList: () => void;
}

interface ColumnDef {
  key: PlanningFeatureStatus;
  title: string;
}

const COLUMNS: ColumnDef[] = [
  { key: "planned", title: "待开发" },
  { key: "in_progress", title: "开发中" },
  { key: "review", title: "待验收" },
  { key: "completed", title: "已完成" },
];

const STATUS_OPTIONS = (
  Object.keys(PLANNING_FEATURE_STATUS_LABELS) as PlanningFeatureStatus[]
).map((value) => ({ value, label: PLANNING_FEATURE_STATUS_LABELS[value] }));

const PRIORITY_OPTIONS = [
  { value: "all", label: "全部优先级" },
  { value: "P0", label: "P0（紧急）" },
  { value: "P1", label: "P1（高）" },
  { value: "P2", label: "P2（中）" },
];

const COLUMN_LIMIT = 40;

function KanbanCard({
  feature,
  busy,
  onOpen,
  onStatusChange,
}: {
  feature: PlanningFeature;
  busy: boolean;
  onOpen: () => void;
  onStatusChange: (status: PlanningFeatureStatus) => void;
}) {
  return (
    <article className="task-card planning-kanban-card">
      <button
        type="button"
        className="planning-kanban-card-head"
        onClick={onOpen}
        aria-label={`查看功能详情：${feature.title}`}
      >
        <span className="planning-kanban-card-title">{feature.title}</span>
        <span className="planning-kanban-card-flags">
          <span className={`priority-tag ${feature.priority.toLowerCase()}`}>{feature.priority}</span>
          <PlanningFeatureStatusBadge status={feature.status} />
        </span>
      </button>
      <div className="planning-kanban-card-meta">
        {feature.milestone_name ? (
          <span className="planning-milestone-chip">{feature.milestone_name}</span>
        ) : (
          <span className="planning-card-meta-muted">未关联里程碑</span>
        )}
        <span className={`planning-kanban-step ${feature.step_total === 0 ? "is-empty" : ""}`}>
          {stepProgressText(feature)}
        </span>
      </div>
      {feature.step_total > 0 && (
        <PlanningProgressBar value={Math.round((feature.step_done / feature.step_total) * 100)} />
      )}
      <div className="planning-kanban-card-foot">
        <Select
          size="sm"
          value={feature.status}
          options={STATUS_OPTIONS}
          disabled={busy}
          ariaLabel={`修改 ${feature.title} 的状态`}
          onChange={onStatusChange}
        />
        <button
          className="icon-btn sm"
          data-tip="打开功能详情"
          aria-label={`打开功能详情：${feature.title}`}
          onClick={onOpen}
        >
          <ChevronRight size={13} />
        </button>
      </div>
    </article>
  );
}

export default function PlanningKanban({ onOpenFeature, onOpenFeatureList }: PlanningKanbanProps) {
  const features = usePlanningStore((s) => s.features);
  const milestones = usePlanningStore((s) => s.milestones);
  const activeProjectId = usePlanningStore((s) => s.activeProjectId);
  const featuresLoading = usePlanningStore((s) => s.featuresLoading);
  const updateFeature = usePlanningStore((s) => s.updateFeature);
  const showToast = useUiStore((s) => s.showToast);

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [milestoneFilter, setMilestoneFilter] = useState<string>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [limits, setLimits] = useState<Record<string, number>>({});

  const milestoneOptions = useMemo(
    () => [
      { value: "all", label: "全部里程碑" },
      { value: "none", label: "未关联里程碑" },
      ...milestones.map((m) => ({ value: m.id, label: m.name })),
    ],
    [milestones],
  );

  const baseFiltered = useMemo(
    () =>
      features.filter((f) => {
        if (priorityFilter !== "all" && f.priority !== priorityFilter) return false;
        if (milestoneFilter !== "all") {
          if (milestoneFilter === "none" ? f.milestone_id !== null : f.milestone_id !== milestoneFilter) {
            return false;
          }
        }
        return true;
      }),
    [features, priorityFilter, milestoneFilter],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {
      planned: 0,
      in_progress: 0,
      review: 0,
      completed: 0,
      blocked: 0,
      paused: 0,
    };
    for (const f of baseFiltered) c[f.status] = (c[f.status] ?? 0) + 1;
    return c;
  }, [baseFiltered]);

  const changeStatus = async (f: PlanningFeature, next: PlanningFeatureStatus) => {
    if (next === f.status) return;
    setBusyId(f.id);
    try {
      await updateFeature(f.id, { status: next });
      showToast(`「${f.title}」已改为${PLANNING_FEATURE_STATUS_LABELS[next]}`, {
        kind: "success",
      });
    } catch (e) {
      // Store 未更新，卡片保持原状态；这里只提示失败
      showToast(`状态修改失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusyId(null);
    }
  };

  if (!activeProjectId) {
    return (
      <div className="planning-projects">
        <div className="planning-empty-features">
          <p>请先在项目总览中创建或选择一个项目。</p>
        </div>
      </div>
    );
  }

  const singleColumn = statusFilter !== "all";
  const shown = singleColumn
    ? baseFiltered.filter((f) => f.status === statusFilter)
    : baseFiltered;

  return (
    <div className="planning-projects planning-kanban-page">
      <div className="planning-toolbar planning-kanban-toolbar">
        <div className="planning-filter-row">
          <Select
            size="sm"
            value={statusFilter}
            options={[
              { value: "all", label: "全部状态" },
              ...STATUS_OPTIONS,
            ]}
            onChange={(v) => {
              setStatusFilter(v);
              setLimits({});
            }}
            ariaLabel="按状态筛选看板"
          />
          <Select
            size="sm"
            value={priorityFilter}
            options={PRIORITY_OPTIONS}
            onChange={setPriorityFilter}
            ariaLabel="按优先级筛选看板"
          />
          <Select
            size="sm"
            value={milestoneFilter}
            options={milestoneOptions}
            onChange={setMilestoneFilter}
            ariaLabel="按里程碑筛选看板"
          />
        </div>
        <div className="planning-kanban-extra">
          <button
            className={`planning-kanban-alert ${statusFilter === "blocked" ? "is-active" : ""}`}
            onClick={() => setStatusFilter(statusFilter === "blocked" ? "all" : "blocked")}
            aria-pressed={statusFilter === "blocked"}
          >
            <AlertTriangle size={12} aria-hidden="true" /> 受阻 {counts.blocked ?? 0}
          </button>
          <button
            className={`planning-kanban-alert ${statusFilter === "paused" ? "is-active" : ""}`}
            onClick={() => setStatusFilter(statusFilter === "paused" ? "all" : "paused")}
            aria-pressed={statusFilter === "paused"}
          >
            <PauseCircle size={12} aria-hidden="true" /> 已暂停 {counts.paused ?? 0}
          </button>
          {singleColumn && (
            <button className="btn sm subtle" onClick={() => setStatusFilter("all")}>
              返回四列看板
            </button>
          )}
        </div>
      </div>

      {featuresLoading ? (
        <div className="planning-loading" role="status">
          <Loader2 size={14} className="spin" aria-hidden="true" /> 加载看板…
        </div>
      ) : features.length === 0 ? (
        <div className="planning-empty-features">
          <h3>尚未添加功能</h3>
          <p>看板按开发状态分组展示功能。先添加功能后，这里会自动出现卡片。</p>
          <button className="btn primary" onClick={onOpenFeatureList}>
            <Plus size={14} aria-hidden="true" /> 去添加功能
          </button>
        </div>
      ) : singleColumn ? (
        <section className="planning-kanban-column is-wide" aria-label="状态筛选结果">
          <div className="planning-kanban-column-head">
            <span>{PLANNING_FEATURE_STATUS_LABELS[statusFilter as PlanningFeatureStatus]}</span>
            <span className="planning-kanban-count">{shown.length}</span>
          </div>
          {shown.length === 0 ? (
            <p className="planning-kanban-empty">该状态下暂无功能。</p>
          ) : (
            <div className="planning-kanban-list">
              {shown.map((f) => (
                <KanbanCard
                  key={f.id}
                  feature={f}
                  busy={busyId === f.id}
                  onOpen={() => onOpenFeature(f.id)}
                  onStatusChange={(v) => void changeStatus(f, v)}
                />
              ))}
            </div>
          )}
        </section>
      ) : (
        <div className="planning-kanban">
          {COLUMNS.map((col) => {
            const items = baseFiltered.filter((f) => f.status === col.key);
            const limit = limits[col.key] ?? COLUMN_LIMIT;
            return (
              <section className="planning-kanban-column" key={col.key} aria-label={col.title}>
                <div className="planning-kanban-column-head">
                  <span>{col.title}</span>
                  <span className="planning-kanban-count">{items.length}</span>
                </div>
                {items.length === 0 ? (
                  <p className="planning-kanban-empty">暂无功能。</p>
                ) : (
                  <div className="planning-kanban-list">
                    {items.slice(0, limit).map((f) => (
                      <KanbanCard
                        key={f.id}
                        feature={f}
                        busy={busyId === f.id}
                        onOpen={() => onOpenFeature(f.id)}
                        onStatusChange={(v) => void changeStatus(f, v)}
                      />
                    ))}
                    {items.length > limit && (
                      <button
                        className="btn sm subtle planning-kanban-more"
                        onClick={() =>
                          setLimits((s) => ({ ...s, [col.key]: limit + COLUMN_LIMIT }))
                        }
                      >
                        显示更多（还有 {items.length - limit} 个）
                      </button>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
