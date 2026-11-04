//! 规划中心功能卡片：状态/优先级/里程碑/目标日期展示 + 展开详情（步骤清单、
//! 状态修改、进度历史、开发日志、编辑与删除）。
//!
//! 交互契约：
//! - 卡片头点击就地展开（与内置路线图一致，不使用弹层）；
//! - 步骤勾选立即反馈进度；带未完成步骤标记「已完成」前必须确认，绝不静默改步骤；
//! - 进度来源唯一：已完成步骤数 / 总步骤数；未拆分步骤显示「未拆分步骤」，不伪造百分比；
//! - 删除走 ProjectsView 的确认框；离开动画由 leaving 标记驱动，CSS 尊重 prefers-reduced-motion。

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  History,
  Loader2,
  Pencil,
  Plus,
  Send,
  Trash2,
} from "lucide-react";
import { DatePicker, Select, Checkbox, ConfirmDialog } from "../ui";
import { formatRelative } from "../../lib/format";
import {
  PLANNING_FEATURE_STATUS_LABELS,
  type PlanningActivity,
  type PlanningFeature,
  type PlanningFeatureStatus,
  type PlanningPriority,
} from "../../lib/bridge";
import { usePlanningStore } from "../../store/usePlanningStore";
import { useUiStore } from "../../store/useUiStore";

export const FEATURE_STATUS_OPTIONS = (
  Object.keys(PLANNING_FEATURE_STATUS_LABELS) as PlanningFeatureStatus[]
).map((value) => ({ value, label: PLANNING_FEATURE_STATUS_LABELS[value] }));

const PRIORITY_OPTIONS: { value: PlanningPriority; label: string }[] = [
  { value: "P0", label: "P0（紧急）" },
  { value: "P1", label: "P1（高）" },
  { value: "P2", label: "P2（中）" },
];

/** 步骤进度的唯一口径：done/total；未拆分时不产出百分比。 */
export function stepProgressText(f: PlanningFeature): string {
  if (f.step_total === 0) return "未拆分步骤";
  return `步骤 ${f.step_done}/${f.step_total}`;
}

function statusBadgeClass(status: PlanningFeatureStatus): string {
  switch (status) {
    case "completed":
      return "p-completed";
    case "in_progress":
      return "p-in_progress";
    case "review":
      return "p-review";
    case "blocked":
      return "p-blocked";
    case "paused":
      return "p-paused";
    default:
      return "p-planned";
  }
}

export function PlanningActivityRow({ a }: { a: PlanningActivity }) {
  let text: string;
  switch (a.kind) {
    case "status_change": {
      const from = a.old_status
        ? PLANNING_FEATURE_STATUS_LABELS[a.old_status as PlanningFeatureStatus] ?? a.old_status
        : "";
      const to = a.new_status
        ? PLANNING_FEATURE_STATUS_LABELS[a.new_status as PlanningFeatureStatus] ?? a.new_status
        : "";
      text = from ? `状态：${from} → ${to}` : "状态变化";
      break;
    }
    case "step_done":
      text = "步骤";
      break;
    default:
      text = "记录";
  }
  return (
    <li className={`planning-act k-${a.kind}`}>
      <span className="planning-act-kind">{text}</span>
      <span className="planning-act-body">
        {a.message || (a.kind === "status_change" ? text : "")}
      </span>
      <time className="planning-act-time" dateTime={a.created_at}>
        {formatRelative(a.created_at)}
      </time>
    </li>
  );
}

export function PlanningFeatureCard({
  feature,
  expanded,
  leaving,
  onToggle,
  onDelete,
  onEdit,
}: {
  feature: PlanningFeature;
  expanded: boolean;
  leaving: boolean;
  onToggle: () => void;
  /** 请求删除：由列表层统一弹确认并处理离开动画，卡片不直接删 */
  onDelete: () => void;
  /** 请求编辑名称/描述/验收标准等基础信息 */
  onEdit: () => void;
}) {
  const updateFeature = usePlanningStore((s) => s.updateFeature);
  const addStep = usePlanningStore((s) => s.addStep);
  const updateStep = usePlanningStore((s) => s.updateStep);
  const deleteStep = usePlanningStore((s) => s.deleteStep);
  const reorderSteps = usePlanningStore((s) => s.reorderSteps);
  const activity = usePlanningStore((s) => s.activity);
  const activityHasMore = usePlanningStore((s) => s.activityHasMore);
  const activityLoading = usePlanningStore((s) => s.activityLoading);
  const activityError = usePlanningStore((s) => s.activityError);
  const loadActivity = usePlanningStore((s) => s.loadActivity);
  const loadMoreActivity = usePlanningStore((s) => s.loadMoreActivity);
  const addNote = usePlanningStore((s) => s.addNote);
  const milestones = usePlanningStore((s) => s.milestones);
  const projectName = usePlanningStore(
    (s) => s.projects.find((p) => p.id === feature.project_id)?.name ?? "未知项目",
  );
  const showToast = useUiStore((s) => s.showToast);

  const [stepTitle, setStepTitle] = useState("");
  const [noteText, setNoteText] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<PlanningFeatureStatus | null>(null);
  const noteInputRef = useRef<HTMLTextAreaElement>(null);

  // 展开时加载该功能的进度历史（分页，首屏一页）
  useEffect(() => {
    if (expanded) void loadActivity(feature.id);
  }, [expanded, feature.id, loadActivity]);

  const run = async (fn: () => Promise<unknown>, failMsg: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      showToast(`${failMsg}：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  /** 状态切换：带未完成步骤进入 completed 需用户确认（不静默改步骤）。 */
  const onStatusSelect = (next: PlanningFeatureStatus) => {
    if (next === feature.status) return;
    const hasUndone = feature.step_total > 0 && feature.step_done < feature.step_total;
    if (next === "completed" && hasUndone) {
      setPendingStatus(next);
      setConfirmComplete(true);
      return;
    }
    void run(
      () => updateFeature(feature.id, { status: next }),
      "状态修改失败",
    );
  };

  const addStepRow = () => {
    const t = stepTitle.trim();
    if (!t) return;
    void run(async () => {
      await addStep(feature.id, t);
      setStepTitle("");
    }, "添加步骤失败");
  };

  const submitNote = () => {
    const t = noteText.trim();
    if (!t) return;
    void run(async () => {
      await addNote(t, feature.id);
      setNoteText("");
    }, "记录失败");
  };

  const moveStep = (index: number, delta: number) => {
    const ids = feature.steps.map((s) => s.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void run(() => reorderSteps(feature.id, ids), "排序失败");
  };

  const milestoneOptions = [
    { value: "", label: "不关联里程碑" },
    ...milestones.map((m) => ({ value: m.id, label: m.name })),
  ];

  return (
    <div
      className={`task-card planning-card ${leaving ? "is-leaving" : ""}`}
      data-feature-id={feature.id}
    >
      <button
        className="planning-card-head"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${feature.title}（${PLANNING_FEATURE_STATUS_LABELS[feature.status]}）`}
      >
        <span className="planning-card-title-row">
          <span className="planning-card-title">{feature.title}</span>
          <em className={`planning-status ${statusBadgeClass(feature.status)}`}>
            {PLANNING_FEATURE_STATUS_LABELS[feature.status]}
          </em>
          <span className={`priority-tag ${feature.priority.toLowerCase()}`}>{feature.priority}</span>
          <span className={`planning-progress ${feature.step_total === 0 ? "none" : ""}`}>
            {stepProgressText(feature)}
          </span>
          {feature.milestone_name && (
            <span className="planning-milestone-chip">{feature.milestone_name}</span>
          )}
          <ChevronDown
            size={15}
            strokeWidth={1.75}
            aria-hidden="true"
            className={`roadmap-chevron ${expanded ? "open" : ""}`}
          />
        </span>
        {feature.description && (
          <span className="planning-card-desc">{feature.description}</span>
        )}
      </button>

      {expanded && (
        <div className="planning-detail" role="region" aria-label={`${feature.title} 详情`}>
          <div className="planning-detail-summary">
            <span>
              所属项目 <strong>{projectName}</strong>
            </span>
            <span>目标日期 {feature.target_date ?? "未设置"}</span>
            <span>更新于 {formatRelative(feature.updated_at)}</span>
          </div>
          <div className="planning-detail-controls">
            <div className="planning-control">
              <span className="planning-control-label">开发状态</span>
              <Select
                size="sm"
                value={feature.status}
                options={FEATURE_STATUS_OPTIONS}
                onChange={onStatusSelect}
                ariaLabel={`修改 ${feature.title} 的开发状态`}
              />
            </div>
            <div className="planning-control">
              <span className="planning-control-label">优先级</span>
              <Select
                size="sm"
                value={feature.priority}
                options={PRIORITY_OPTIONS}
                onChange={(v) => void run(() => updateFeature(feature.id, { priority: v }), "优先级修改失败")}
                ariaLabel={`修改 ${feature.title} 的优先级`}
              />
            </div>
            <div className="planning-control">
              <span className="planning-control-label">里程碑</span>
              <Select
                size="sm"
                value={feature.milestone_id ?? ""}
                options={milestoneOptions}
                onChange={(v) =>
                  void run(
                    () =>
                      updateFeature(feature.id, {
                        milestone_id: v === "" ? null : v,
                      }),
                    "里程碑关联失败",
                  )
                }
                ariaLabel={`修改 ${feature.title} 关联的里程碑`}
              />
            </div>
            <div className="planning-control">
              <span className="planning-control-label">目标日期</span>
              <DatePicker
                size="sm"
                value={feature.target_date ?? ""}
                ariaLabel={`修改 ${feature.title} 的目标日期`}
                onChange={(v) =>
                  void run(
                    () =>
                      updateFeature(feature.id, {
                        target_date: v === "" ? null : v,
                      }),
                    "目标日期修改失败",
                  )
                }
              />
            </div>
          </div>

          <div className="planning-detail-sections">
            <section className="planning-detail-block" aria-label="功能概述">
              <h4>功能概述</h4>
              {feature.description ? (
                <p>{feature.description}</p>
              ) : (
                <p className="planning-section-empty">尚未填写功能描述。</p>
              )}
            </section>
            <section className="planning-detail-block" aria-label="验收标准">
              <h4>验收标准</h4>
              {feature.acceptance_criteria.trim() ? (
                <ul className="planning-acceptance-list">
                  {feature.acceptance_criteria
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((line, i) => (
                      <li key={`${i}-${line}`}>{line}</li>
                    ))}
                </ul>
              ) : (
                <p className="planning-section-empty">
                  尚未填写验收标准。验收标准与开发步骤相互独立，不会用步骤代替。
                </p>
              )}
            </section>
          </div>

          <div className="planning-steps">
            <div className="planning-steps-head">
              <h4>开发步骤</h4>
              <span className="planning-progress" aria-label="步骤进度">
                {stepProgressText(feature)}
                {feature.step_total > 0 &&
                  ` · ${Math.round((feature.step_done / feature.step_total) * 100)}%`}
              </span>
            </div>
            {feature.steps.length === 0 ? (
              <p className="planning-steps-empty">
                还没有步骤。把功能拆成可勾选的小步骤后，这里会显示完成进度。
              </p>
            ) : (
              <ul className="planning-step-list">
                {feature.steps.map((s, i) => (
                  <li key={s.id} className={`planning-step ${s.done ? "is-done" : ""}`}>
                    <Checkbox
                      checked={s.done}
                      onChange={(v) => void run(() => updateStep(s.id, { done: v }), "步骤更新失败")}
                      ariaLabel={`完成步骤：${s.title}`}
                    />
                    <span className="planning-step-title">{s.title}</span>
                    <span className="planning-step-ops">
                      <button
                        className="icon-btn sm"
                        data-tip="上移"
                        aria-label={`上移步骤：${s.title}`}
                        disabled={i === 0 || busy}
                        onClick={() => moveStep(i, -1)}
                      >
                        ↑
                      </button>
                      <button
                        className="icon-btn sm"
                        data-tip="下移"
                        aria-label={`下移步骤：${s.title}`}
                        disabled={i === feature.steps.length - 1 || busy}
                        onClick={() => moveStep(i, 1)}
                      >
                        ↓
                      </button>
                      <button
                        className="icon-btn sm"
                        data-tip="删除步骤"
                        aria-label={`删除步骤：${s.title}`}
                        disabled={busy}
                        onClick={() => void run(() => deleteStep(s.id), "删除步骤失败")}
                      >
                        <Trash2 size={12} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="planning-step-add">
              <input
                className="input"
                value={stepTitle}
                maxLength={200}
                placeholder="添加一个开发步骤，回车确认"
                aria-label={`为 ${feature.title} 添加步骤`}
                onChange={(e) => setStepTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addStepRow();
                  }
                }}
              />
              <button
                className="icon-btn sm"
                data-tip="添加步骤"
                aria-label="添加步骤"
                disabled={!stepTitle.trim() || busy}
                onClick={addStepRow}
              >
                <Plus size={13} />
              </button>
            </div>
          </div>

          <div className="planning-history">
            <div className="planning-history-head">
              <h4>
                <History size={13} aria-hidden="true" /> 进度历史
              </h4>
              <span className="planning-history-hint">
                状态变化与步骤完成自动记录；也可主动写开发日志。
              </span>
            </div>
            {activityError ? (
              <p className="planning-history-error" role="alert">
                历史加载失败
                <button className="btn sm" onClick={() => void loadActivity(feature.id)}>
                  重试
                </button>
              </p>
            ) : activity.length === 0 && !activityLoading ? (
              <p className="planning-history-empty">暂无记录。</p>
            ) : (
              <ul className="planning-act-list">
                {activity.map((a) => (
                  <PlanningActivityRow key={a.id} a={a} />
                ))}
              </ul>
            )}
            {activityHasMore && (
              <button
                className="btn sm subtle"
                disabled={activityLoading}
                onClick={() => void loadMoreActivity(feature.id)}
              >
                {activityLoading ? (
                  <Loader2 size={12} className="spin" aria-hidden="true" />
                ) : null}
                加载更早记录
              </button>
            )}
            <div className="planning-note-add">
              <textarea
                ref={noteInputRef}
                className="input"
                rows={2}
                maxLength={2000}
                placeholder="记一笔开发日志，如「完成前端基础页面，等待后端联调」"
                aria-label={`为 ${feature.title} 写开发日志`}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    submitNote();
                  }
                }}
              />
              <button
                className="icon-btn sm"
                data-tip="提交记录 (Ctrl+Enter)"
                aria-label="提交开发日志"
                disabled={!noteText.trim() || busy}
                onClick={submitNote}
              >
                <Send size={12} />
              </button>
            </div>
          </div>

          <div className="planning-detail-foot">
            <span className="planning-updated">
              更新于 {formatRelative(feature.updated_at)}
              {feature.completed_at ? " · 已完成" : ""}
            </span>
            <span className="planning-detail-foot-actions">
              <button
                className="btn sm"
                onClick={onEdit}
                aria-label={`编辑功能 ${feature.title}`}
              >
                <Pencil size={12} aria-hidden="true" /> 编辑
              </button>
              <button
                className="btn sm danger-ghost"
                onClick={onDelete}
                aria-label={`删除功能 ${feature.title}`}
              >
                <Trash2 size={12} aria-hidden="true" /> 删除
              </button>
            </span>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmComplete}
        title="确认标记为已完成"
        detail={`「${feature.title}」还有 ${
          feature.step_total - feature.step_done
        } 个未完成步骤。标记完成不会自动勾选这些步骤；稍后可在状态里改回。`}
        danger={false}
        confirmLabel="标记完成"
        busy={busy}
        onConfirm={() => {
          const next = pendingStatus;
          setConfirmComplete(false);
          if (next) {
            void run(() => updateFeature(feature.id, { status: next }), "状态修改失败");
          }
          setPendingStatus(null);
        }}
        onCancel={() => {
          setConfirmComplete(false);
          setPendingStatus(null);
        }}
      />
    </div>
  );
}
