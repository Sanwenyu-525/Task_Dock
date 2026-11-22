//! 规划中心表单的页面内编辑态：项目、功能、里程碑的新建/编辑。
//!
//! 不再使用 Dialog：由列表页（`ProjectsView` / `FeatureListView` / `MilestonesView`）
//! 在主内容区内切换进入，与工作流编辑器同一套交互语言——返回按钮、未保存徽标、
//! 页内「放弃修改」确认条、随内容流式排布的操作行；不铺全局遮罩、不盖大浮层。
//! 表单控件复用既有 `form-grid` / `form-field` / `input` 与 `ui/Select`，
//! 不新增第二套表单或弹层实现。
//! 保存失败保留全部输入；连点保存只提交一次；卸载后到达的响应不再回调。

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { DatePicker, Select } from "../ui";
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
import { useTabGuard } from "../../lib/tabGuard";

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

interface EditorShellProps {
  title: string;
  subtitle: string;
  /** 返回按钮的可访问名称（各视图不同，避免同页多个「返回」歧义）。 */
  backLabel: string;
  dirty: boolean;
  busy: boolean;
  error: string | null;
  leaveGuard: boolean;
  onRequestLeave: () => void;
  onContinueEditing: () => void;
  onDiscard: () => void;
  children: ReactNode;
  actions: ReactNode;
}

/** 三个编辑器共用的页面内骨架（只做布局，不做业务）。 */
function EditorShell({
  title,
  subtitle,
  backLabel,
  dirty,
  busy,
  error,
  leaveGuard,
  onRequestLeave,
  onContinueEditing,
  onDiscard,
  children,
  actions,
}: EditorShellProps) {
  // 三个规划编辑器共用同一套跨 Tab 离开保护，避免各视图复制导航拦截。
  useTabGuard({
    id: "planning-editor",
    label: title,
    dirty,
    busy,
    discard: onDiscard,
  });
  return (
    <div className="planning-editor" role="region" aria-label={title}>
      <header className="planning-editor-head">
        <button
          type="button"
          className="icon-btn sm"
          aria-label={backLabel}
          data-tip="返回列表"
          onClick={onRequestLeave}
          disabled={busy}
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <div className="planning-editor-head-main">
          <h2 className="planning-editor-title">{title}</h2>
          <p className="planning-editor-subtitle">{subtitle}</p>
        </div>
        {dirty ? (
          <span className="planning-unsaved-badge" role="status">
            未保存
          </span>
        ) : null}
      </header>

      {leaveGuard ? (
        <div className="planning-leave-guard" role="alert">
          <span>有未保存的修改，返回列表会丢失这些修改。</span>
          <div className="planning-leave-guard-actions">
            <button type="button" className="btn sm" onClick={onContinueEditing}>
              继续编辑
            </button>
            <button type="button" className="btn sm danger" onClick={onDiscard}>
              放弃修改
            </button>
          </div>
        </div>
      ) : null}

      <div className="form-grid">{children}</div>

      {error ? (
        <p className="planning-editor-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="planning-editor-actions">{actions}</div>
    </div>
  );
}

export interface ProjectEditorViewProps {
  /** null = 新建；否则编辑该项目 */
  project: PlanningProject | null;
  onClose: () => void;
}

export function ProjectEditorView({ project, onClose }: ProjectEditorViewProps) {
  const createProject = usePlanningStore((s) => s.createProject);
  const updateProject = usePlanningStore((s) => s.updateProject);
  const showToast = useUiStore((s) => s.showToast);

  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [status, setStatus] = useState<PlanningProjectStatus>(project?.status ?? "planning");
  const [targetDate, setTargetDate] = useState(project?.target_date ?? "");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaveGuard, setLeaveGuard] = useState(false);

  // 同步防重入：状态更新到下一次渲染之间，连点保存不能触发第二次请求。
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const patch = <T,>(setter: (v: T) => void) => (v: T) => {
    setDirty(true);
    setter(v);
  };

  const requestLeave = () => {
    if (busyRef.current) return;
    if (dirty) {
      setLeaveGuard(true);
      return;
    }
    onClose();
  };

  const discardAndLeave = () => {
    if (busyRef.current) return;
    setLeaveGuard(false);
    onClose();
  };

  const submit = async () => {
    if (busyRef.current) return;
    if (!name.trim()) {
      setError("项目名称不能为空");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
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
      if (aliveRef.current) onClose();
    } catch (e) {
      // 保留输入，仅提示错误（编辑失败不丢用户内容）
      if (aliveRef.current) {
        setError(`保存失败：${String(e)}`);
        showToast(`保存失败：${String(e)}`, { kind: "error" });
      }
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  return (
    <EditorShell
      title={project ? "编辑项目" : "新建项目"}
      subtitle={
        project ? "修改项目名称、状态与目标日期，保存后回到项目总览。" : "填写项目基本信息，保存后回到项目总览。"
      }
      backLabel="返回项目总览"
      dirty={dirty}
      busy={busy}
      error={error}
      leaveGuard={leaveGuard}
      onRequestLeave={requestLeave}
      onContinueEditing={() => setLeaveGuard(false)}
      onDiscard={discardAndLeave}
      actions={
        <>
          <button type="button" className="btn" onClick={requestLeave} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
          >
            {busy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null}
            {project ? "保存" : "创建"}
          </button>
        </>
      }
    >
      <label className="form-field">
        <span className="form-label">项目名称</span>
        <input
          className="input"
          value={name}
          maxLength={100}
          placeholder="例如：Task Dock v1.0"
          aria-label="项目名称"
          autoFocus={!project}
          onChange={(e) => patch(setName)(e.target.value)}
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
          onChange={(e) => patch(setDescription)(e.target.value)}
        />
      </label>
      <div className="form-field">
        <span className="form-label">项目状态</span>
        <Select
          value={status}
          options={PROJECT_STATUS_OPTIONS}
          onChange={(v) => patch(setStatus)(v)}
          ariaLabel="项目状态"
          block
        />
      </div>
      <div className="form-field">
        <span className="form-label">目标日期（可选）</span>
        <DatePicker
          value={targetDate}
          ariaLabel="目标日期"
          onChange={patch(setTargetDate)}
        />
      </div>
    </EditorShell>
  );
}

export interface FeatureEditorViewProps {
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
export function FeatureEditorView({
  feature,
  initialMilestoneId,
  onClose,
  onSaved,
}: FeatureEditorViewProps) {
  const createFeature = usePlanningStore((s) => s.createFeature);
  const updateFeature = usePlanningStore((s) => s.updateFeature);
  const milestones = usePlanningStore((s) => s.milestones);
  const activeProjectId = usePlanningStore((s) => s.activeProjectId);
  const showToast = useUiStore((s) => s.showToast);

  const [title, setTitle] = useState(feature?.title ?? "");
  const [description, setDescription] = useState(feature?.description ?? "");
  const [acceptance, setAcceptance] = useState(feature?.acceptance_criteria ?? "");
  const [status, setStatus] = useState<PlanningFeatureStatus>(feature?.status ?? "planned");
  const [priority, setPriority] = useState<PlanningPriority>(feature?.priority ?? "P1");
  const [milestoneId, setMilestoneId] = useState(
    feature?.milestone_id ?? initialMilestoneId ?? "",
  );
  const [targetDate, setTargetDate] = useState(feature?.target_date ?? "");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaveGuard, setLeaveGuard] = useState(false);

  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const patch = <T,>(setter: (v: T) => void) => (v: T) => {
    setDirty(true);
    setter(v);
  };

  const milestoneOptions = [
    { value: "", label: "不关联里程碑" },
    ...milestones.map((m) => ({ value: m.id, label: m.name })),
  ];

  const requestLeave = () => {
    if (busyRef.current) return;
    if (dirty) {
      setLeaveGuard(true);
      return;
    }
    onClose();
  };

  const discardAndLeave = () => {
    if (busyRef.current) return;
    setLeaveGuard(false);
    onClose();
  };

  const submit = async () => {
    if (busyRef.current) return;
    if (!title.trim()) {
      setError("功能名称不能为空");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
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
      if (aliveRef.current) {
        onSaved?.(saved);
        onClose();
      }
    } catch (e) {
      // 失败保留全部输入，用户可直接重试
      if (aliveRef.current) {
        setError(`保存失败：${String(e)}`);
        showToast(`保存失败：${String(e)}`, { kind: "error" });
      }
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  return (
    <EditorShell
      title={feature ? "编辑功能" : "新增功能"}
      subtitle={
        feature ? "修改功能信息与验收标准，保存后回到功能列表。" : "登记功能与验收标准，保存后回到功能列表。"
      }
      backLabel="返回功能列表"
      dirty={dirty}
      busy={busy}
      error={error}
      leaveGuard={leaveGuard}
      onRequestLeave={requestLeave}
      onContinueEditing={() => setLeaveGuard(false)}
      onDiscard={discardAndLeave}
      actions={
        <>
          <button type="button" className="btn" onClick={requestLeave} disabled={busy}>
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
      <label className="form-field">
        <span className="form-label">功能名称</span>
        <input
          className="input"
          value={title}
          maxLength={200}
          placeholder="例如：登录与账号系统"
          aria-label="功能名称"
          autoFocus={!feature}
          onChange={(e) => patch(setTitle)(e.target.value)}
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
          onChange={(e) => patch(setDescription)(e.target.value)}
        />
      </label>
      <div className="planning-form-row">
        <div className="form-field">
          <span className="form-label">开发状态</span>
          <Select
            value={status}
            options={FEATURE_STATUS_OPTIONS}
            onChange={(v) => patch(setStatus)(v)}
            ariaLabel="开发状态"
            block
          />
        </div>
        <div className="form-field">
          <span className="form-label">优先级</span>
          <Select
            value={priority}
            options={PRIORITY_OPTIONS}
            onChange={(v) => patch(setPriority)(v)}
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
            onChange={(v) => patch(setMilestoneId)(v)}
            ariaLabel="关联里程碑"
            block
          />
        </div>
        <div className="form-field">
          <span className="form-label">目标日期（可选）</span>
          <DatePicker
            value={targetDate}
            ariaLabel="目标日期"
            onChange={patch(setTargetDate)}
          />
        </div>
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
          onChange={(e) => patch(setAcceptance)(e.target.value)}
        />
        <span className="form-hint">
          验收标准是交付判据，与开发步骤相互独立，不会替代步骤进度。
        </span>
      </label>
    </EditorShell>
  );
}

export interface MilestoneEditorViewProps {
  /** null = 新建；否则编辑该里程碑 */
  milestone: PlanningMilestone | null;
  onClose: () => void;
  onSaved?: (milestone: PlanningMilestone) => void;
}

/** 里程碑新建/编辑（名称、描述、目标日期）。 */
export function MilestoneEditorView({ milestone, onClose, onSaved }: MilestoneEditorViewProps) {
  const createMilestone = usePlanningStore((s) => s.createMilestone);
  const updateMilestone = usePlanningStore((s) => s.updateMilestone);
  const showToast = useUiStore((s) => s.showToast);

  const [name, setName] = useState(milestone?.name ?? "");
  const [description, setDescription] = useState(milestone?.description ?? "");
  const [targetDate, setTargetDate] = useState(milestone?.target_date ?? "");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaveGuard, setLeaveGuard] = useState(false);

  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const patch = <T,>(setter: (v: T) => void) => (v: T) => {
    setDirty(true);
    setter(v);
  };

  const requestLeave = () => {
    if (busyRef.current) return;
    if (dirty) {
      setLeaveGuard(true);
      return;
    }
    onClose();
  };

  const discardAndLeave = () => {
    if (busyRef.current) return;
    setLeaveGuard(false);
    onClose();
  };

  const submit = async () => {
    if (busyRef.current) return;
    if (!name.trim()) {
      setError("里程碑名称不能为空");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
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
      if (aliveRef.current) {
        onSaved?.(saved);
        onClose();
      }
    } catch (e) {
      if (aliveRef.current) {
        setError(`保存失败：${String(e)}`);
        showToast(`保存失败：${String(e)}`, { kind: "error" });
      }
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  return (
    <EditorShell
      title={milestone ? "编辑里程碑" : "新建里程碑"}
      subtitle={
        milestone ? "修改阶段名称、说明与目标日期，保存后回到里程碑列表。" : "填写阶段名称与目标日期，保存后回到里程碑列表。"
      }
      backLabel="返回里程碑列表"
      dirty={dirty}
      busy={busy}
      error={error}
      leaveGuard={leaveGuard}
      onRequestLeave={requestLeave}
      onContinueEditing={() => setLeaveGuard(false)}
      onDiscard={discardAndLeave}
      actions={
        <>
          <button type="button" className="btn" onClick={requestLeave} disabled={busy}>
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
      <label className="form-field">
        <span className="form-label">里程碑名称</span>
        <input
          className="input"
          value={name}
          maxLength={100}
          placeholder="例如：MVP / v1.0"
          aria-label="里程碑名称"
          autoFocus={!milestone}
          onChange={(e) => patch(setName)(e.target.value)}
        />
      </label>
      <div className="form-field">
        <span className="form-label">目标日期（可选）</span>
        <DatePicker
          value={targetDate}
          ariaLabel="里程碑目标日期"
          onChange={patch(setTargetDate)}
        />
      </div>
      <label className="form-field">
        <span className="form-label">阶段说明（可选）</span>
        <textarea
          className="input"
          value={description}
          maxLength={2000}
          rows={2}
          placeholder="这个阶段要交付什么"
          aria-label="里程碑说明"
          onChange={(e) => patch(setDescription)(e.target.value)}
        />
      </label>
    </EditorShell>
  );
}
