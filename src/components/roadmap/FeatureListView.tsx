//! 规划中心「功能列表/功能详情」视图。
//!
//! - 功能详情就地展开，复用 PlanningFeatureCard（步骤、历史、状态）；
//! - 补齐新增/编辑功能入口：FeatureDialog 负责名称、描述、验收标准、状态、
//!   优先级、里程碑、目标日期；保存失败保留输入；
//! - 列表按里程碑分组；搜索与状态/里程碑筛选可组合；
//! - 无功能时显示「尚未添加功能」，筛选无结果时给出清除筛选入口；
//! - 看板点击卡片后通过 focusFeatureId 定位并展开同一张卡片。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Plus,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Select, ConfirmDialog } from "../ui";
import {
  PLANNING_FEATURE_STATUS_LABELS,
  type PlanningFeature,
  type PlanningFeatureStatus,
} from "../../lib/bridge";
import { usePlanningStore } from "../../store/usePlanningStore";
import { useUiStore } from "../../store/useUiStore";
import { PlanningFeatureCard } from "./PlanningFeatureCard";
import { FeatureDialog } from "./PlanningDialogs";

export interface FeatureListViewProps {
  /** 从看板/里程碑跳转过来时要展开的功能 */
  focusFeatureId?: string | null;
  /** 从里程碑视图跳转过来时预选的里程碑筛选 */
  milestoneFilterId?: string | null;
  onFocusConsumed?: () => void;
  onClearMilestoneFilter?: () => void;
  onOpenMilestones: () => void;
}

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "全部状态" },
  ...(
    Object.keys(PLANNING_FEATURE_STATUS_LABELS) as PlanningFeatureStatus[]
  ).map((value) => ({ value, label: PLANNING_FEATURE_STATUS_LABELS[value] })),
];

const PRIORITY_FILTER_OPTIONS = [
  { value: "all", label: "全部优先级" },
  { value: "P0", label: "P0（紧急）" },
  { value: "P1", label: "P1（高）" },
  { value: "P2", label: "P2（中）" },
];

export default function FeatureListView({
  focusFeatureId,
  milestoneFilterId,
  onFocusConsumed,
  onClearMilestoneFilter,
  onOpenMilestones,
}: FeatureListViewProps) {
  const features = usePlanningStore((s) => s.features);
  const featuresLoading = usePlanningStore((s) => s.featuresLoading);
  const featuresError = usePlanningStore((s) => s.featuresError);
  const activeProjectId = usePlanningStore((s) => s.activeProjectId);
  const loadedForProject = usePlanningStore((s) => s.loadedForProject);
  const milestones = usePlanningStore((s) => s.milestones);
  const deleteFeature = usePlanningStore((s) => s.deleteFeature);
  const showToast = useUiStore((s) => s.showToast);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [milestoneFilter, setMilestoneFilter] = useState<string>(milestoneFilterId ?? "all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [leavingId, setLeavingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<PlanningFeature | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PlanningFeature | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 切换项目：清空就地展开与筛选，避免展示上一个项目的详情
  useEffect(() => {
    setExpandedId(null);
    setLeavingId(null);
    setStatusFilter("all");
    setPriorityFilter("all");
    setSearch("");
    setMilestoneFilter("all");
  }, [activeProjectId]);

  useEffect(() => {
    setMilestoneFilter(milestoneFilterId ?? "all");
  }, [milestoneFilterId]);

  useEffect(() => {
    if (!focusFeatureId) return;
    setExpandedId(focusFeatureId);
    setStatusFilter("all");
    setMilestoneFilter("all");
    setSearch("");
    const timer = window.setTimeout(() => {
      const card = listRef.current?.querySelector<HTMLElement>(
        `[data-feature-id="${focusFeatureId}"]`,
      );
      card?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
    onFocusConsumed?.();
    return () => window.clearTimeout(timer);
  }, [focusFeatureId, onFocusConsumed]);

  const milestoneOptions = useMemo(
    () => [
      { value: "all", label: "全部里程碑" },
      { value: "none", label: "未关联里程碑" },
      ...milestones.map((m) => ({ value: m.id, label: m.name })),
    ],
    [milestones],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return features.filter((f) => {
      if (statusFilter !== "all" && f.status !== statusFilter) return false;
      if (priorityFilter !== "all" && f.priority !== priorityFilter) return false;
      if (milestoneFilter !== "all") {
        if (milestoneFilter === "none" ? f.milestone_id !== null : f.milestone_id !== milestoneFilter) {
          return false;
        }
      }
      if (q) {
        const stepText = f.steps.map((s) => s.title).join("\n");
        const hay = `${f.title}\n${f.description}\n${f.acceptance_criteria}\n${stepText}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [features, search, statusFilter, priorityFilter, milestoneFilter]);

  const grouped = useMemo(() => {
    const groups: {
      key: string;
      name: string;
      targetDate: string | null;
      items: PlanningFeature[];
    }[] = [];
    const byMilestone = new Map<string, (typeof groups)[number]>();
    for (const m of milestones) {
      const g = { key: m.id, name: m.name, targetDate: m.target_date, items: [] as PlanningFeature[] };
      byMilestone.set(m.id, g);
      groups.push(g);
    }
    const none = {
      key: "none",
      name: "未关联里程碑",
      targetDate: null,
      items: [] as PlanningFeature[],
    };
    for (const f of filtered) {
      if (f.milestone_id && byMilestone.has(f.milestone_id)) {
        byMilestone.get(f.milestone_id)!.items.push(f);
      } else {
        none.items.push(f);
      }
    }
    if (none.items.length > 0) groups.push(none);
    return groups.filter((g) => g.items.length > 0);
  }, [filtered, milestones]);

  const filtersActive =
    search.trim() !== "" ||
    statusFilter !== "all" ||
    priorityFilter !== "all" ||
    milestoneFilter !== "all";

  const clearFilters = () => {
    setSearch("");
    setStatusFilter("all");
    setPriorityFilter("all");
    setMilestoneFilter("all");
    onClearMilestoneFilter?.();
  };

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const requestDelete = (f: PlanningFeature) => setDeleting(f);
  const confirmDelete = () => {
    const f = deleting;
    if (!f) return;
    setDeleting(null);
    setLeavingId(f.id);
    window.setTimeout(() => {
      deleteFeature(f.id)
        .then(() => showToast(`功能「${f.title}」已删除`, { kind: "success" }))
        .catch((e) => showToast(`删除失败：${String(e)}`, { kind: "error" }))
        .finally(() => setLeavingId((id) => (id === f.id ? null : id)));
    }, 180);
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

  return (
    <div className="planning-projects planning-feature-page" ref={listRef}>
      {featuresError && (
        <div className="planning-error" role="alert">
          <span>功能列表加载失败：{featuresError}</span>
          <button className="btn sm" onClick={() => void usePlanningStore.getState().selectProject(activeProjectId)}>
            重试
          </button>
        </div>
      )}

      <div className="planning-toolbar planning-feature-toolbar">
        <div className="planning-search">
          <Search size={13} aria-hidden="true" />
          <input
            className="input sm"
            value={search}
            placeholder="搜索功能名称、描述或验收标准"
            aria-label="搜索功能"
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              className="icon-btn sm"
              data-tip="清空搜索"
              aria-label="清空搜索"
              onClick={() => setSearch("")}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div className="planning-filter-row">
          <span className="planning-filter-label">
            <SlidersHorizontal size={12} aria-hidden="true" /> 筛选
          </span>
          <Select
            size="sm"
            value={statusFilter}
            options={STATUS_FILTER_OPTIONS}
            onChange={setStatusFilter}
            ariaLabel="按状态筛选"
          />
          <Select
            size="sm"
            value={priorityFilter}
            options={PRIORITY_FILTER_OPTIONS}
            onChange={setPriorityFilter}
            ariaLabel="按优先级筛选"
          />
          <Select
            size="sm"
            value={milestoneFilter}
            options={milestoneOptions}
            onChange={setMilestoneFilter}
            ariaLabel="按里程碑筛选"
          />
          {filtersActive && (
            <button className="btn sm subtle" onClick={clearFilters}>
              清除筛选
            </button>
          )}
        </div>
        <button className="btn sm primary planning-add-feature" onClick={openCreate}>
          <Plus size={13} aria-hidden="true" /> 新增功能
        </button>
      </div>

      {!featuresError &&
        (featuresLoading && loadedForProject !== activeProjectId ? (
          <div className="planning-loading" role="status">
            <Loader2 size={14} className="spin" aria-hidden="true" /> 加载功能…
          </div>
        ) : features.length === 0 ? (
          <div className="planning-empty-features">
            <h3>尚未添加功能</h3>
            <p>先登记要交付的功能，再拆分开发步骤、关联里程碑并记录进度。</p>
            <div className="planning-empty-actions">
              <button className="btn primary" onClick={openCreate}>
                <Plus size={14} aria-hidden="true" /> 新增功能
              </button>
              <button className="btn" onClick={onOpenMilestones}>
                先建里程碑
              </button>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="planning-empty-features">
            <h3>没有匹配的功能</h3>
            <p>当前筛选条件下没有结果，调整或清除筛选后再试。</p>
            <button className="btn" onClick={clearFilters}>
              清除筛选
            </button>
          </div>
        ) : (
          <div className="planning-groups">
            {grouped.map((g) => (
              <section className="planning-group" key={g.key} aria-label={g.name}>
                <div className="planning-group-head">
                  <h4>{g.name}</h4>
                  <span className="planning-group-count">{g.items.length}</span>
                  {g.targetDate && <span className="planning-group-date">目标 {g.targetDate}</span>}
                </div>
                {g.items.map((f) => (
                  <PlanningFeatureCard
                    key={f.id}
                    feature={f}
                    expanded={expandedId === f.id}
                    leaving={leavingId === f.id}
                    onToggle={() => setExpandedId((id) => (id === f.id ? null : f.id))}
                    onEdit={() => {
                      setEditing(f);
                      setDialogOpen(true);
                    }}
                    onDelete={() => requestDelete(f)}
                  />
                ))}
              </section>
            ))}
            <div className="planning-list-summary">
              共 {features.length} 个功能
              {filtered.length !== features.length && ` · 当前显示 ${filtered.length} 个`}
            </div>
          </div>
        ))}

      <FeatureDialog
        open={dialogOpen}
        feature={editing}
        initialMilestoneId={milestoneFilter !== "all" && milestoneFilter !== "none" ? milestoneFilter : null}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSaved={(f) => {
          setExpandedId(f.id);
          setSearch("");
          setStatusFilter("all");
          setPriorityFilter("all");
          setMilestoneFilter("all");
          onClearMilestoneFilter?.();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除功能"
        detail={
          deleting
            ? `确定删除「${deleting.title}」？其 ${deleting.step_total} 个开发步骤与进度历史将一并删除，且无法恢复。`
            : ""
        }
        danger
        confirmLabel="删除功能"
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
