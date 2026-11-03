//! 规划中心对话框：项目、功能、里程碑的新建/编辑，以及里程碑管理。
//!
//! 统一走 ui/Dialog + 全局弹层栈（Escape 只关本层）；表单失败保留用户输入
//! （错误只提示不关框），删除项目/里程碑必须经 ConfirmDialog 明确影响面。

import { useEffect, useState, type ReactNode } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Dialog, ConfirmDialog } from "../ui/Dialog";
import { Select } from "../ui";
import {
  PLANNING_FEATURE_STATUS_LABELS,
  PLANNING_PROJECT_STATUS_LABELS,
  type PlanningFeature,
  type PlanningFeatureStatus,
  type PlanningMilestone,
  type PlanningPriority,
  type PlanningProject,
  type PlanningProjectStatus,
} from "../../lib/bridge";
import { usePlanningStore } from "../../store/usePlanningStore";
import { useUiStore } from "../../store/useUiStore";

const PROJECT_STATUS_OPTIONS = (
  Object.keys(PLANNING_PROJECT_STATUS_LABELS) as PlanningProjectStatus[]
).map((value) => ({ value, label: PLANNING_PROJECT_STATUS_LABELS[value] }));

const FEATURE_STATUS_OPTIONS = (
  Object.keys(PLANNING_FEATURE_STATUS_LABELS) as PlanningFeatureStatus[]
).map((value) => ({ value, label: PLANNING_FEATURE_STATUS_LABELS[value] }));

const PRIORITY_OPTIONS: { value: PlanningPriority; label: string }[] = [
  { value: "P0", label: "P0（紧急）" },
  { value: "P1", label: "P1（高）" },
  { value: "P2", label: "P2（中）" },
];

/** 目标日期统一 YYYY-MM-DD；空串归一为 null（清除）。 */
function normalizeDateInput(v: string): string | null {
  const t = v.trim();
  return t === "" ? null : t;
}

export interface ProjectDialogProps {
  open: boolean;
  /** null = 新建；否则编辑该项目 */
  project: PlanningProject | null;
  onClose: () => void;
}

export function ProjectDialog({ open, project, onClose }: ProjectDialogProps) {
  const createProject = usePlanningStore((s) => s.createProject);
  const updateProject = usePlanningStore((s) => s.updateProject);
  const showToast = useUiStore((s) => s.showToast);

  // 表单状态挂在 open 生命周期上：每次打开重新初始化；提交失败不清空输入
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<PlanningProjectStatus>("planning");
  const [targetDate, setTargetDate] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(project?.name ?? "");
      setDescription(project?.description ?? "");
      setStatus(project?.status ?? "planning");
      setTargetDate(project?.target_date ?? "");
    }
  }, [open, project]);

  const submit = async () => {
    if (!name.trim()) {
      showToast("项目名称不能为空", { kind: "warning" });
      return;
    }
    setBusy(true);
    try {
      if (project) {
        await updateProject(project.id, {
          name: name.trim(),
          description,
          status,
          target_date: normalizeDateInput(targetDate),
        });
        showToast("项目已更新", { kind: "success" });
      } else {
        await createProject({
          name: name.trim(),
          description,
          status,
          target_date: normalizeDateInput(targetDate),
        });
        showToast("项目已创建", { kind: "success" });
      }
      onClose();
    } catch (e) {
      // 保留输入，仅提示错误（spec：编辑失败保留用户输入）
      showToast(`保存失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={project ? "编辑项目" : "新建项目"}
      size="md"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={submit}
            disabled={busy || !name.trim()}
          >
            {busy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null}
            {project ? "保存" : "创建"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="form-field">
          <span className="form-label">项目名称</span>
          <input
            className="input"
            value={name}
            maxLength={100}
            placeholder="例如：Task Dock v1.0"
            aria-label="项目名称"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="form-field">
          <span className="form-label">项目描述</span>
          <textarea
            className="input"
            value={description}
            maxLength={2000}
            rows={3}
            placeholder="这个项目要做什么（可选）"
            aria-label="项目描述"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="form-field">
          <span className="form-label">项目状态</span>
          <Select
            value={status}
            options={PROJECT_STATUS_OPTIONS}
            onChange={(v) => setStatus(v)}
            ariaLabel="项目状态"
            block
          />
        </div>
        <label className="form-field">
          <span className="form-label">目标日期（可选）</span>
          <input
            type="date"
            className="input"
            value={targetDate}
            aria-label="目标日期"
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </label>
      </div>
    </Dialog>
  );
}

export interface MilestonesDialogProps {
  open: boolean;
  project: PlanningProject | null;
  onClose: () => void;
}

/** 里程碑管理：列表（含关联功能统计）+ 新建 + 就地编辑/删除。 */
export function MilestonesDialog({ open, project, onClose }: MilestonesDialogProps) {
  const milestones = usePlanningStore((s) => s.milestones);
  const milestonesLoading = usePlanningStore((s) => s.milestonesLoading);
  const loadMilestones = usePlanningStore((s) => s.loadMilestones);
  const createMilestone = usePlanningStore((s) => s.createMilestone);
  const updateMilestone = usePlanningStore((s) => s.updateMilestone);
  const deleteMilestone = usePlanningStore((s) => s.deleteMilestone);
  const showToast = useUiStore((s) => s.showToast);

  const [name, setName] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleting, setDeleting] = useState<PlanningMilestone | null>(null);

  useEffect(() => {
    if (open && project) void loadMilestones(project.id);
  }, [open, project, loadMilestones]);

  const create = async () => {
    if (!name.trim() || !project) return;
    setBusy(true);
    try {
      await createMilestone({
        name: name.trim(),
        target_date: normalizeDateInput(targetDate),
      });
      setName("");
      setTargetDate("");
      showToast("里程碑已创建", { kind: "success" });
    } catch (e) {
      showToast(`创建失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (m: PlanningMilestone) => {
    if (!editingName.trim()) return;
    try {
      await updateMilestone(m.id, { name: editingName.trim() });
      setEditingId(null);
      showToast("里程碑已更新", { kind: "success" });
    } catch (e) {
      showToast(`更新失败：${String(e)}`, { kind: "error" });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={project ? `里程碑 · ${project.name}` : "里程碑"}
      size="md"
    >
      <div className="milestone-manager">
        <div className="milestone-create">
          <input
            className="input"
            value={name}
            maxLength={100}
            placeholder="新里程碑名称，如 MVP / v1.0"
            aria-label="新里程碑名称"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
          <input
            type="date"
            className="input"
            value={targetDate}
            aria-label="新里程碑目标日期"
            onChange={(e) => setTargetDate(e.target.value)}
          />
          <button
            className="btn sm"
            onClick={create}
            disabled={busy || !name.trim() || !project}
            aria-label="创建里程碑"
          >
            {busy ? <Loader2 size={12} className="spin" aria-hidden="true" /> : <Plus size={13} />}
            创建
          </button>
        </div>

        {milestonesLoading && milestones.length === 0 ? (
          <p className="milestone-empty">加载中…</p>
        ) : milestones.length === 0 ? (
          <p className="milestone-empty">还没有里程碑。里程碑用于把功能分组到 MVP / v1.0 等阶段。</p>
        ) : (
          <ul className="milestone-list">
            {milestones.map((m) => (
              <li key={m.id} className="milestone-row">
                {editingId === m.id ? (
                  <>
                    <input
                      className="input"
                      value={editingName}
                      maxLength={100}
                      aria-label="里程碑名称"
                      autoFocus
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveEdit(m);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                    />
                    <button className="btn sm" onClick={() => void saveEdit(m)}>
                      保存
                    </button>
                    <button className="btn sm" onClick={() => setEditingId(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <span className="milestone-name">{m.name}</span>
                    {m.target_date && <span className="milestone-date">{m.target_date}</span>}
                    <span className="milestone-count">
                      {m.feature_completed}/{m.feature_total} 功能完成
                    </span>
                    <button
                      className="icon-btn sm"
                      data-tip="编辑里程碑"
                      aria-label={`编辑里程碑 ${m.name}`}
                      onClick={() => {
                        setEditingId(m.id);
                        setEditingName(m.name);
                      }}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      className="icon-btn sm"
                      data-tip="删除里程碑"
                      aria-label={`删除里程碑 ${m.name}`}
                      onClick={() => setDeleting(m)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="milestone-hint">删除里程碑不会删除功能，仅取消它们与该里程碑的关联。</p>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title="删除里程碑"
        detail={
          deleting
            ? `确定删除「${deleting.name}」？关联的 ${deleting.feature_total} 个功能将取消与它的关联（功能本身保留）。`
            : ""
        }
        danger
        confirmLabel="删除"
        onConfirm={() => {
          if (deleting) {
            void deleteMilestone(deleting.id)
              .then(() => showToast("里程碑已删除", { kind: "success" }))
              .catch((e) => showToast(`删除失败：${String(e)}`, { kind: "error" }));
          }
          setDeleting(null);
        }}
        onCancel={() => setDeleting(null)}
      />
    </Dialog>
  );
}

export interface FeatureDialogProps {
  open: boolean;
  /** null = 新建；否则编辑该功能 */
  feature: PlanningFeature | null;
  /** 新建时预选的里程碑（从里程碑视图进入时使用） */
  initialMilestoneId?: string | null;
  onClose: () => void;
  onSaved?: (feature: PlanningFeature) => void;
}

/**
 * 功能新建/编辑。名称与描述、验收标准都在这里维护；
 * 状态与步骤进度相互独立：保存状态不会勾选或取消任何步骤。
 */
export function FeatureDialog({
  open,
  feature,
  initialMilestoneId,
  onClose,
  onSaved,
}: FeatureDialogProps) {
  const createFeature = usePlanningStore((s) => s.createFeature);
  const updateFeature = usePlanningStore((s) => s.updateFeature);
  const milestones = usePlanningStore((s) => s.milestones);
  const activeProjectId = usePlanningStore((s) => s.activeProjectId);
  const showToast = useUiStore((s) => s.showToast);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [status, setStatus] = useState<PlanningFeatureStatus>("planned");
  const [priority, setPriority] = useState<PlanningPriority>("P1");
  const [milestoneId, setMilestoneId] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(feature?.title ?? "");
    setDescription(feature?.description ?? "");
    setAcceptance(feature?.acceptance_criteria ?? "");
    setStatus(feature?.status ?? "planned");
    setPriority(feature?.priority ?? "P1");
    setMilestoneId(feature?.milestone_id ?? initialMilestoneId ?? "");
    setTargetDate(feature?.target_date ?? "");
  }, [open, feature, initialMilestoneId]);

  const milestoneOptions = [
    { value: "", label: "不关联里程碑" },
    ...milestones.map((m) => ({ value: m.id, label: m.name })),
  ];

  const submit = async () => {
    if (!title.trim()) {
      showToast("功能名称不能为空", { kind: "warning" });
      return;
    }
    setBusy(true);
    try {
      const payload = {
        title: title.trim(),
        description,
        acceptance_criteria: acceptance,
        status,
        priority,
        milestone_id: milestoneId === "" ? null : milestoneId,
        target_date: normalizeDateInput(targetDate),
      };
      const saved = feature
        ? await updateFeature(feature.id, payload)
        : await createFeature(payload);
      showToast(feature ? "功能已更新" : "功能已创建", { kind: "success" });
      onSaved?.(saved);
      onClose();
    } catch (e) {
      // 失败保留全部输入，用户可直接重试
      showToast(`保存失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={feature ? "编辑功能" : "新增功能"}
      size="md"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void submit()}
            disabled={busy || !title.trim() || !activeProjectId}
          >
            {busy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null}
            {feature ? "保存" : "创建"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="form-field">
          <span className="form-label">功能名称</span>
          <input
            className="input"
            value={title}
            maxLength={200}
            placeholder="例如：登录与账号系统"
            aria-label="功能名称"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="form-field">
          <span className="form-label">功能描述</span>
          <textarea
            className="input"
            value={description}
            maxLength={2000}
            rows={3}
            placeholder="这个功能要解决什么问题、交付什么结果（可选）"
            aria-label="功能描述"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="planning-form-row">
          <div className="form-field">
            <span className="form-label">开发状态</span>
            <Select
              value={status}
              options={FEATURE_STATUS_OPTIONS}
              onChange={(v) => setStatus(v)}
              ariaLabel="开发状态"
              block
            />
          </div>
          <div className="form-field">
            <span className="form-label">优先级</span>
            <Select
              value={priority}
              options={PRIORITY_OPTIONS}
              onChange={(v) => setPriority(v)}
              ariaLabel="优先级"
              block
            />
          </div>
        </div>
        <div className="planning-form-row">
          <div className="form-field">
            <span className="form-label">关联里程碑（可选）</span>
            <Select
              value={milestoneId}
              options={milestoneOptions}
              onChange={(v) => setMilestoneId(v)}
              ariaLabel="关联里程碑"
              block
            />
          </div>
          <label className="form-field">
            <span className="form-label">目标日期（可选）</span>
            <input
              type="date"
              className="input"
              value={targetDate}
              aria-label="目标日期"
              onChange={(e) => setTargetDate(e.target.value)}
            />
          </label>
        </div>
        <label className="form-field">
          <span className="form-label">验收标准（可选，每行一条）</span>
          <textarea
            className="input"
            value={acceptance}
            maxLength={4000}
            rows={4}
            placeholder={"例如：\n登录成功后 3 秒内进入工作台\n错误密码连续 5 次触发限流提示"}
            aria-label="验收标准"
            onChange={(e) => setAcceptance(e.target.value)}
          />
          <span className="form-hint">
            验收标准是交付判据，与开发步骤相互独立，不会替代步骤进度。
          </span>
        </label>
      </div>
    </Dialog>
  );
}

export interface MilestoneDialogProps {
  open: boolean;
  /** null = 新建；否则编辑该里程碑 */
  milestone: PlanningMilestone | null;
  onClose: () => void;
  onSaved?: (milestone: PlanningMilestone) => void;
}

/** 里程碑新建/编辑（名称、描述、目标日期）。 */
export function MilestoneDialog({ open, milestone, onClose, onSaved }: MilestoneDialogProps) {
  const createMilestone = usePlanningStore((s) => s.createMilestone);
  const updateMilestone = usePlanningStore((s) => s.updateMilestone);
  const showToast = useUiStore((s) => s.showToast);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(milestone?.name ?? "");
    setDescription(milestone?.description ?? "");
    setTargetDate(milestone?.target_date ?? "");
  }, [open, milestone]);

  const submit = async () => {
    if (!name.trim()) {
      showToast("里程碑名称不能为空", { kind: "warning" });
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        description,
        target_date: normalizeDateInput(targetDate),
      };
      const saved = milestone
        ? await updateMilestone(milestone.id, payload)
        : await createMilestone(payload);
      showToast(milestone ? "里程碑已更新" : "里程碑已创建", { kind: "success" });
      onSaved?.(saved);
      onClose();
    } catch (e) {
      showToast(`保存失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={milestone ? "编辑里程碑" : "新建里程碑"}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
          >
            {busy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null}
            {milestone ? "保存" : "创建"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="form-field">
          <span className="form-label">里程碑名称</span>
          <input
            className="input"
            value={name}
            maxLength={100}
            placeholder="例如：MVP / v1.0"
            aria-label="里程碑名称"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="form-field">
          <span className="form-label">目标日期（可选）</span>
          <input
            type="date"
            className="input"
            value={targetDate}
            aria-label="里程碑目标日期"
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </label>
        <label className="form-field">
          <span className="form-label">阶段说明（可选）</span>
          <textarea
            className="input"
            value={description}
            maxLength={2000}
            rows={2}
            placeholder="这个阶段要交付什么"
            aria-label="里程碑说明"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </div>
    </Dialog>
  );
}

/** 共用的表单布局（项目对话框内使用） */
export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="form-grid">{children}</div>;
}
