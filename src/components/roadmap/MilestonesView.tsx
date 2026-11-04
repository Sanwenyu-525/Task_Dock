//! 规划中心「里程碑」视图。
//!
//! - 宽窗水平时间轴、窄窗纵向列表（同一 DOM，由容器查询切换布局）；
//! - 节点展示名称、目标日期、关联功能数、已完成数、完成率与阶段状态；
//! - 完成率 = 已完成 / 关联总数；没有关联功能时显示「尚未关联功能」且不画进度条；
//! - 目标日期过期只显示「已逾期」，绝不自动把里程碑标记为完成；
//! - 操作：新建/编辑/删除、查看关联功能（跳转功能视图并预选该里程碑）。

import { useRef, useState } from "react";
import {
  CalendarDays,
  Flag,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { ConfirmDialog } from "../ui";
import {
  type PlanningMilestone,
} from "../../lib/bridge";
import { usePlanningStore } from "../../store/usePlanningStore";
import { useUiStore } from "../../store/useUiStore";
import { MilestoneEditorView } from "./PlanningEditors";
import { PlanningProgressBar, findScrollParent } from "./PlanningBits";

export interface MilestonesViewProps {
  onOpenFeatures: (milestoneId: string) => void;
}

type Stage = { key: "empty" | "not_started" | "ongoing" | "overdue" | "done"; label: string };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 阶段状态是派生展示，不是持久化状态：
 * - 无关联功能 → 未关联功能（不伪造进度）
 * - 全部完成 → 已完成
 * - 未完成且目标日期已过 → 已逾期（提醒，不代表完成）
 * - 已有完成 → 进行中；否则待开始
 */
export function milestoneStage(m: PlanningMilestone): Stage {
  if (m.feature_total === 0) return { key: "empty", label: "尚未关联功能" };
  if (m.feature_completed >= m.feature_total) return { key: "done", label: "已完成" };
  if (m.target_date && m.target_date < todayIso()) return { key: "overdue", label: "已逾期" };
  if (m.feature_completed > 0) return { key: "ongoing", label: "进行中" };
  return { key: "not_started", label: "待开始" };
}

function completionText(m: PlanningMilestone): string {
  if (m.feature_total === 0) return "尚未关联功能";
  return `${m.feature_completed}/${m.feature_total} 完成 · ${Math.round(
    (m.feature_completed * 100) / m.feature_total,
  )}%`;
}

export default function MilestonesView({ onOpenFeatures }: MilestonesViewProps) {
  const milestones = usePlanningStore((s) => s.milestones);
  const milestonesLoading = usePlanningStore((s) => s.milestonesLoading);
  const milestonesError = usePlanningStore((s) => s.milestonesError);
  const activeProjectId = usePlanningStore((s) => s.activeProjectId);
  const reloadMilestones = usePlanningStore((s) => s.loadMilestones);
  const deleteMilestone = usePlanningStore((s) => s.deleteMilestone);
  const showToast = useUiStore((s) => s.showToast);

  /** null = 列表态；非空 = 页面内编辑态（milestone 为 null 表示新建）。 */
  const [editor, setEditor] = useState<{ milestone: PlanningMilestone | null } | null>(null);
  const [deleting, setDeleting] = useState<PlanningMilestone | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 进入编辑前列表的滚动位置：返回时恢复，避免用户回到列表顶部。 */
  const listScrollTop = useRef(0);

  /** 进入编辑态前记住列表滚动位置；返回时一次性恢复（页面级单一滚动容器）。 */
  const openEditor = (milestone: PlanningMilestone | null) => {
    const sc = findScrollParent(rootRef.current);
    if (sc) listScrollTop.current = sc.scrollTop;
    setEditor({ milestone });
    window.requestAnimationFrame(() => {
      const container = findScrollParent(rootRef.current);
      if (container) container.scrollTop = 0;
    });
  };

  const closeEditor = () => {
    setEditor(null);
    window.requestAnimationFrame(() => {
      const container = findScrollParent(rootRef.current);
      if (container) container.scrollTop = listScrollTop.current;
    });
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

  // ── 页面内编辑态：整块内容区切换为表单，不叠遮罩 ──
  if (editor) {
    return (
      <div className="planning-projects planning-milestones-page planning-editor-page" ref={rootRef}>
        <MilestoneEditorView milestone={editor.milestone} onClose={closeEditor} />
      </div>
    );
  }

  return (
    <div className="planning-projects planning-milestones-page" ref={rootRef}>
      {(milestonesError) && (
        <div className="planning-error" role="alert">
          <span>里程碑加载失败：{milestonesError}</span>
          <button className="btn sm" onClick={() => void reloadMilestones(activeProjectId)}>
            重试
          </button>
        </div>
      )}

      <div className="planning-toolbar planning-milestones-toolbar">
        <div className="planning-milestones-summary">
          <span>
            <Flag size={13} aria-hidden="true" /> {milestones.length} 个阶段
          </span>
          <span className="planning-muted">
            完成率按关联功能的完成状态计算；目标日期过期不会自动完成。
          </span>
        </div>
        <button className="btn sm primary" onClick={() => openEditor(null)}>
          <Plus size={13} aria-hidden="true" /> 新建里程碑
        </button>
      </div>

      {!milestonesError && (milestonesLoading && milestones.length === 0 ? (
        <div className="planning-loading" role="status">
          <Loader2 size={14} className="spin" aria-hidden="true" /> 加载里程碑…
        </div>
      ) : milestones.length === 0 ? (
        <div className="planning-empty-features">
          <h3>还没有里程碑</h3>
          <p>用里程碑把功能按阶段组织起来，查看每个阶段的目标日期与完成率。</p>
          <button className="btn primary" onClick={() => openEditor(null)}>
            <Plus size={14} aria-hidden="true" /> 新建里程碑
          </button>
        </div>
      ) : (
        <ol className="planning-timeline" aria-label="里程碑时间轴">
          {milestones.map((m, index) => {
            const stage = milestoneStage(m);
            return (
              <li className={`planning-timeline-node stage-${stage.key}`} key={m.id}>
                <div className="planning-timeline-marker" aria-hidden="true">
                  <span>{index + 1}</span>
                </div>
                <article className="task-card planning-timeline-card">
                  <div className="planning-timeline-card-head">
                    <h4>{m.name}</h4>
                    <span className={`planning-stage-badge stage-${stage.key}`}>
                      {stage.label}
                    </span>
                  </div>
                  {m.description && (
                    <p className="planning-timeline-desc">{m.description}</p>
                  )}
                  <div className="planning-timeline-meta">
                    <span>
                      <CalendarDays size={12} aria-hidden="true" />
                      {m.target_date ? `目标 ${m.target_date}` : "未设置目标日期"}
                    </span>
                    <span>{m.feature_total} 个关联功能</span>
                    <span>已完成 {m.feature_completed}</span>
                  </div>
                  {m.feature_total > 0 ? (
                    <>
                      <PlanningProgressBar
                        value={Math.round((m.feature_completed * 100) / m.feature_total)}
                      />
                      <div className="planning-timeline-progress-text">{completionText(m)}</div>
                    </>
                  ) : (
                    <div className="planning-timeline-progress-text is-empty">
                      {completionText(m)}
                    </div>
                  )}
                  <div className="planning-timeline-actions">
                    <button className="btn sm" onClick={() => onOpenFeatures(m.id)}>
                      查看关联功能
                    </button>
                    <button
                      className="icon-btn sm"
                      data-tip="编辑里程碑"
                      aria-label={`编辑里程碑 ${m.name}`}
                      onClick={() => openEditor(m)}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="icon-btn sm"
                      data-tip="删除里程碑（不会删除关联功能）"
                      aria-label={`删除里程碑 ${m.name}`}
                      onClick={() => setDeleting(m)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      ))}

      <ConfirmDialog
        open={deleting !== null}
        title="删除里程碑"
        detail={
          deleting
            ? `确定删除里程碑「${deleting.name}」？关联的 ${deleting.feature_total} 个功能不会被删除，只会解除与这个里程碑的关联。`
            : ""
        }
        danger
        confirmLabel="删除里程碑"
        onConfirm={() => {
          const m = deleting;
          setDeleting(null);
          if (!m) return;
          deleteMilestone(m.id)
            .then(() => showToast(`里程碑「${m.name}」已删除`, { kind: "success" }))
            .catch((e) => showToast(`删除失败：${String(e)}`, { kind: "error" }));
        }}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
