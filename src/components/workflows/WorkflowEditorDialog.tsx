//! 工作流编辑器：名称 / 描述 + 步骤编排（增删改、上下移、单步启停、失败策略）。
//!
//! 保存走两条命令：编辑 = replace_steps（原子）→ update（元信息）；
//! 新建 = workflow_create（元信息 + 步骤一次写入）。
//! 目标与快照选项由后端列表提供（导航目标 / 工作现场快照），前端不拼路径。

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Trash2 } from "lucide-react";
import {
  WORKFLOW_STEP_TYPE_LABELS,
  workflowCreate,
  workflowReplaceSteps,
  workflowUpdate,
  type WorkflowDetail,
  type WorkflowOnError,
  type WorkflowStepInput,
  type WorkflowStepParams,
  type WorkflowStepType,
} from "../../lib/bridge";
import { navListTargets, type NavTarget } from "../../lib/navigation";
import { workspaceList, type SnapshotSummary } from "../../lib/bridge";
import { Combobox, DateTimePicker, Dialog, Select } from "../ui";
import { errText } from "../../store/useWorkflowsStore";
import type { WorkflowTemplate } from "./templates";

/** 编辑器内的步骤草稿。 */
interface EditorStep {
  id: string;
  step_type: WorkflowStepType;
  params: WorkflowStepParams;
  enabled: boolean;
  on_error: WorkflowOnError;
}

const STEP_TYPE_OPTIONS: { value: WorkflowStepType; label: string; disabled?: boolean }[] = (
  Object.keys(WORKFLOW_STEP_TYPE_LABELS) as WorkflowStepType[]
).map((t) => ({
  value: t,
  label: WORKFLOW_STEP_TYPE_LABELS[t],
  // 场景工作区模块尚未集成：类型保留展示但不可选（依赖注记见 docs/workflows）
  disabled: t === "enter_scene",
}));

const ON_ERROR_OPTIONS = [
  { value: "stop" as WorkflowOnError, label: "失败后停止" },
  { value: "continue" as WorkflowOnError, label: "失败后继续" },
];

const PRIORITY_OPTIONS = [
  { value: "0", label: "P0 紧急" },
  { value: "1", label: "P1 高" },
  { value: "2", label: "P2 普通" },
  { value: "3", label: "P3 低" },
];

function newStep(step_type: WorkflowStepType): EditorStep {
  return { id: crypto.randomUUID(), step_type, params: {}, enabled: true, on_error: "stop" };
}

/** 步骤是否满足本地必填项（保存前校验；后端仍会复核引用存在性）。 */
export function stepDraftError(s: EditorStep): string | null {
  switch (s.step_type) {
    case "open_app":
    case "open_url":
    case "open_path":
      if (!s.params.target_id) return "请选择导航目标";
      return null;
    case "create_task":
      if (!s.params.title?.trim()) return "请填写任务标题";
      return null;
    case "restore_workspace":
      if (!s.params.snapshot_id) return "请选择工作现场快照";
      return null;
    case "enter_scene":
      return "场景工作区模块尚未集成，该步骤不可用";
  }
}

function editorStepToInput(s: EditorStep): WorkflowStepInput {
  const params: WorkflowStepParams = { ...s.params };
  if (s.step_type === "create_task") {
    // 空提醒 → 显式清空（后端把空串当清除）
    if (!params.remind_at) delete params.remind_at;
  }
  return {
    id: s.id,
    step_type: s.step_type,
    params,
    enabled: s.enabled,
    on_error: s.on_error,
  };
}

/** datetime-local 形态的本地值 ↔ RFC3339。 */
function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return "";
  }
}

function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export interface WorkflowEditorDialogProps {
  open: boolean;
  onClose: () => void;
  /** 编辑的既有工作流；null = 新建。 */
  workflow: WorkflowDetail | null;
  /** 新建时套用的模板（可空）。 */
  template?: WorkflowTemplate | null;
  /** 保存成功回调（返回保存后的详情）。 */
  onSaved: (detail: WorkflowDetail) => void;
}

export default function WorkflowEditorDialog({
  open,
  onClose,
  workflow,
  template,
  onSaved,
}: WorkflowEditorDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<EditorStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 正在编辑参数的步骤 id（null = 列表态）。 */
  const [editingId, setEditingId] = useState<string | null>(null);

  const [targets, setTargets] = useState<NavTarget[] | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[] | null>(null);
  const [refError, setRefError] = useState<string | null>(null);

  const isCreate = workflow === null;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setEditingId(null);
    if (workflow) {
      setName(workflow.name);
      setDescription(workflow.description);
      setSteps(
        workflow.steps.map((s) => ({
          id: s.id,
          step_type: s.step_type,
          params: { ...s.params },
          enabled: s.enabled,
          on_error: s.on_error,
        })),
      );
    } else if (template) {
      setName(template.name);
      setDescription(template.description);
      setSteps(template.steps.map((s) => ({ ...s, params: { ...s.params } })));
    } else {
      setName("");
      setDescription("");
      setSteps([]);
    }
    // 目标 / 快照选项：打开时拉取一次（写操作不高频，无需缓存失效策略）
    setRefError(null);
    navListTargets()
      .then(setTargets)
      .catch((e) => setRefError(`导航目标加载失败: ${errText(e)}`));
    workspaceList()
      .then(setSnapshots)
      .catch((e) => setRefError(`工作现场快照加载失败: ${errText(e)}`));
  }, [open, workflow, template]);

  const updateStep = (id: string, patch: Partial<EditorStep>) =>
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const move = (idx: number, dir: -1 | 1) =>
    setSteps((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });

  const targetOptions = useMemo(() => {
    const want = (t: NavTarget["target_type"][]) => t;
    return (types: ReturnType<typeof want>) =>
      (targets ?? [])
        .filter((t) => types.includes(t.target_type))
        .map((t) => ({ value: t.id, label: t.display_name || t.id }));
  }, [targets]);

  const snapshotOptions = useMemo(
    () =>
      (snapshots ?? []).map((s) => ({
        value: s.id,
        label: s.name || s.id,
      })),
    [snapshots],
  );

  const save = async () => {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("工作流名称不能为空");
      return;
    }
    for (let i = 0; i < steps.length; i++) {
      const err = stepDraftError(steps[i]);
      if (err) {
        setError(`第 ${i + 1} 步：${err}`);
        setEditingId(steps[i].id);
        return;
      }
    }
    setBusy(true);
    setError(null);
    const stepInputs = steps.map(editorStepToInput);
    try {
      let detail: WorkflowDetail;
      if (isCreate) {
        detail = await workflowCreate({ name: trimmed, description: description.trim(), steps: stepInputs });
      } else {
        // 先原子替换步骤，再更新元信息；任一失败都会把错误抛给界面（保留用户输入）
        detail = await workflowReplaceSteps(workflow.id, stepInputs);
        if (detail.name !== trimmed || detail.description !== description.trim()) {
          detail = await workflowUpdate(workflow.id, { name: trimmed, description: description.trim() });
        }
      }
      onSaved(detail);
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={isCreate ? "新建工作流" : "编辑工作流"}
      ariaLabel={isCreate ? "新建工作流" : "编辑工作流"}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={busy}>
            {busy ? <Loader2 size={13} className="spin" aria-hidden="true" /> : null}
            保存
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="form-field">
          <label className="form-label" htmlFor="wf-name">
            名称
          </label>
          <input
            id="wf-name"
            className="input"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：进入开发状态"
          />
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor="wf-desc">
            描述
          </label>
          <input
            id="wf-desc"
            className="input"
            value={description}
            maxLength={300}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="一句话说明这个工作流做什么（可选）"
          />
        </div>
      </div>

      <div className="wf-steps-head">
        <span className="form-label">步骤（按顺序执行）</span>
        <div className="wf-steps-actions">
          <Select
            options={STEP_TYPE_OPTIONS}
            value=""
            placeholder="＋ 添加步骤"
            ariaLabel="添加步骤"
            size="sm"
            onChange={(t) => {
              setSteps((prev) => [...prev, newStep(t)]);
            }}
          />
        </div>
      </div>
      {refError ? <p className="wf-error-text">{refError}</p> : null}

      {steps.length === 0 ? (
        <p className="wf-empty-steps">还没有步骤。可从上方选择动作类型添加，或从面板的示例模板开始。</p>
      ) : (
        <ol className="wf-steps" aria-label="步骤列表">
          {steps.map((s, idx) => {
            const label = WORKFLOW_STEP_TYPE_LABELS[s.step_type];
            return (
              <li key={s.id} className={`wf-step ${s.enabled ? "" : "is-disabled"}`}>
                <div className="wf-step-row">
                  <span className="wf-step-index">{idx + 1}</span>
                  <button
                    type="button"
                    className="wf-step-main"
                    onClick={() => setEditingId(editingId === s.id ? null : s.id)}
                    aria-expanded={editingId === s.id}
                    data-tip="编辑步骤参数"
                  >
                    <span className="wf-step-type">{label}</span>
                    <span className="wf-step-summary">{stepSummary(s, targets, snapshots)}</span>
                  </button>
                  <label className="wf-step-toggle" aria-label={`启用第 ${idx + 1} 步`}>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={(e) => updateStep(s.id, { enabled: e.target.checked })}
                    />
                    <span aria-hidden="true">启用</span>
                  </label>
                  <Select
                    options={ON_ERROR_OPTIONS}
                    value={s.on_error}
                    onChange={(v) => updateStep(s.id, { on_error: v })}
                    ariaLabel={`第 ${idx + 1} 步失败策略`}
                    size="sm"
                  />
                  <div className="wf-step-tools">
                    <button
                      type="button"
                      className="icon-btn sm"
                      aria-label={`上移第 ${idx + 1} 步`}
                      disabled={idx === 0}
                      onClick={() => move(idx, -1)}
                    >
                      <ArrowUp size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-btn sm"
                      aria-label={`下移第 ${idx + 1} 步`}
                      disabled={idx === steps.length - 1}
                      onClick={() => move(idx, 1)}
                    >
                      <ArrowDown size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-btn sm"
                      aria-label={`删除第 ${idx + 1} 步`}
                      onClick={() => setSteps((prev) => prev.filter((x) => x.id !== s.id))}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                {editingId === s.id ? (
                  <StepParamsForm
                    step={s}
                    targetOptions={targetOptions}
                    snapshotOptions={snapshotOptions}
                    targetsLoading={targets === null}
                    snapshotsLoading={snapshots === null}
                    onChange={(params) => updateStep(s.id, { params })}
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {error ? (
        <p className="wf-error-text" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** 步骤参数摘要（列表态一行展示）。 */
function stepSummary(
  s: EditorStep,
  targets: NavTarget[] | null,
  snapshots: SnapshotSummary[] | null,
): string {
  switch (s.step_type) {
    case "open_app":
    case "open_url":
    case "open_path": {
      if (!s.params.target_id) return "（待选择目标）";
      const t = targets?.find((x) => x.id === s.params.target_id);
      return t ? t.display_name : s.params.target_id;
    }
    case "create_task": {
      const bits = [s.params.title || "（未命名任务）"];
      if (s.params.remind_at) bits.push("提醒已设置");
      return bits.join(" · ");
    }
    case "restore_workspace": {
      if (!s.params.snapshot_id) return "（待选择快照）";
      const snap = snapshots?.find((x) => x.id === s.params.snapshot_id);
      return snap ? snap.name : s.params.snapshot_id;
    }
    case "enter_scene":
      return "（场景工作区未集成）";
  }
}

/** 步骤参数表单（展开态）。 */
function StepParamsForm({
  step,
  targetOptions,
  snapshotOptions,
  targetsLoading,
  snapshotsLoading,
  onChange,
}: {
  step: EditorStep;
  targetOptions: (types: NavTarget["target_type"][]) => { value: string; label: string }[];
  snapshotOptions: { value: string; label: string }[];
  targetsLoading: boolean;
  snapshotsLoading: boolean;
  onChange: (params: WorkflowStepParams) => void;
}) {
  const p = step.params;
  switch (step.step_type) {
    case "open_app":
    case "open_url":
    case "open_path": {
      const types: NavTarget["target_type"][] =
        step.step_type === "open_app"
          ? ["application"]
          : step.step_type === "open_url"
            ? ["url"]
            : ["file", "directory"];
      const hint =
        step.step_type === "open_app"
          ? "选择应用目标（运行时优先唤醒已有窗口，未运行则按设置启动）"
          : step.step_type === "open_url"
            ? "选择网页目标"
            : "选择文件或目录目标";
      return (
        <div className="wf-step-form">
          <label className="form-label" htmlFor={`tgt-${step.id}`}>
            {hint}
          </label>
          {targetsLoading ? (
            <p className="wf-empty-steps">目标加载中…</p>
          ) : (
            <Combobox
              id={`tgt-${step.id}`}
              value={p.target_id ?? ""}
              options={targetOptions(types)}
              onChange={(v) => onChange({ ...p, target_id: v })}
              placeholder="搜索并选择目标"
              ariaLabel="选择导航目标"
              emptyText="没有匹配的目标；可在「行动」面板先添加导航目标"
            />
          )}
        </div>
      );
    }
    case "create_task": {
      const remindLocal = isoToLocalInput(p.remind_at ?? null);
      return (
        <div className="wf-step-form">
          <div className="form-field">
            <label className="form-label" htmlFor={`ttl-${step.id}`}>
              任务标题
            </label>
            <input
              id={`ttl-${step.id}`}
              className="input"
              value={p.title ?? ""}
              maxLength={200}
              onChange={(e) => onChange({ ...p, title: e.target.value })}
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor={`desc-${step.id}`}>
              描述（可选）
            </label>
            <input
              id={`desc-${step.id}`}
              className="input"
              value={p.description ?? ""}
              maxLength={2000}
              onChange={(e) => onChange({ ...p, description: e.target.value })}
            />
          </div>
          <div className="wf-step-form-row">
            <div className="form-field">
              <span className="form-label">优先级</span>
              <Select
                options={PRIORITY_OPTIONS}
                value={String(p.priority ?? 2)}
                onChange={(v) => onChange({ ...p, priority: Number(v) })}
                ariaLabel="任务优先级"
                size="sm"
              />
            </div>
            <div className="form-field">
              <span className="form-label">提醒时间（可选）</span>
              <DateTimePicker
                value={remindLocal}
                onChange={(v) => onChange({ ...p, remind_at: localInputToIso(v) })}
                onClear={() => onChange({ ...p, remind_at: null })}
                clearable
                ariaLabel="任务提醒时间"
                size="sm"
              />
            </div>
          </div>
          <p className="wf-hint-text">每次运行都会创建一个新任务；重复运行不会复用上次的任务。</p>
        </div>
      );
    }
    case "restore_workspace":
      return (
        <div className="wf-step-form">
          <label className="form-label" htmlFor={`snap-${step.id}`}>
            选择要恢复的工作现场快照（恢复走统一门禁，不会与其他窗口操作抢焦点）
          </label>
          {snapshotsLoading ? (
            <p className="wf-empty-steps">快照加载中…</p>
          ) : snapshotOptions.length === 0 ? (
            <p className="wf-empty-steps">还没有工作现场快照；可在「历史」面板捕获现场后使用本步骤。</p>
          ) : (
            <Combobox
              id={`snap-${step.id}`}
              value={p.snapshot_id ?? ""}
              options={snapshotOptions}
              onChange={(v) => onChange({ ...p, snapshot_id: v })}
              placeholder="搜索并选择快照"
              ariaLabel="选择工作现场快照"
              emptyText="没有匹配的快照"
            />
          )}
        </div>
      );
    case "enter_scene":
      return (
        <p className="wf-hint-text">依赖场景工作区模块（尚未集成）；模块就绪并经验证后该步骤才可配置。</p>
      );
  }
}
