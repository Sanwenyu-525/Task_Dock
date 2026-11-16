//! 通用线「milestones」模块（U1 D2 + D4）：阶段/里程碑管理与真实进度交付汇总。
//!
//! - 里程碑：标题、目标日期、状态、备注、关联事项（弱引用）、关联任务（弱引用）。
//! - 进度统计：事项/里程碑/关联任务/资料计数与当前里程碑、活动记录，全部来自
//!   `general_stats` 真实 SQLite 数据；无数据时显示 0 / 空态，不填示例数字。
//! - 归档项目只读：所有写入控件禁用。
//! - IPC 只经本目录 `./ipc.ts` 的包装（内部走 `creativeInvoke`）。

import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Pencil, Trash2, Flag, Activity } from "lucide-react";

import type { CreativeModuleProps } from "../types";
import { errorMessage } from "../../../lib/errors";
import Select from "../../../components/ui/Select";
import {
  coreItemList,
  coreTaskLinkList,
  generalApplyTemplate,
  generalMilestoneDelete,
  generalMilestoneList,
  generalMilestoneSave,
  generalStats,
  type CoreTaskLink,
  type CoreWorkspaceItem,
  type GeneralMilestone,
  type GeneralStats,
  type MilestoneStatus,
} from "./ipc";
import { GENERAL_TEMPLATES, templateCounts } from "./templates";
import "./general.css";

const STATUS_LABEL: Record<MilestoneStatus, string> = {
  open: "进行中",
  done: "已完成",
  skipped: "已跳过",
};

const ITEM_STATUS_LABEL: Record<string, string> = {
  todo: "待办",
  doing: "进行中",
  blocked: "阻塞",
  done: "已完成",
  archived: "已归档",
};

const ACTIVITY_KIND_LABEL: Record<string, string> = {
  item: "事项",
  milestone: "里程碑",
  material: "资料",
  taskLink: "关联任务",
};

interface Draft {
  id: string | null;
  title: string;
  targetDate: string;
  status: MilestoneStatus;
  note: string;
  linkedItemId: string;
  linkedTaskId: string;
}

function emptyDraft(): Draft {
  return {
    id: null,
    title: "",
    targetDate: "",
    status: "open",
    note: "",
    linkedItemId: "",
    linkedTaskId: "",
  };
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  return iso.slice(0, 16).replace("T", " ");
}

export default function MilestonesPanel({ projectId, archived }: CreativeModuleProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [milestones, setMilestones] = useState<GeneralMilestone[]>([]);
  const [stats, setStats] = useState<GeneralStats | null>(null);
  const [items, setItems] = useState<CoreWorkspaceItem[]>([]);
  const [links, setLinks] = useState<CoreTaskLink[]>([]);

  const [templateId, setTemplateId] = useState(GENERAL_TEMPLATES[0]?.id ?? "blank");
  const [applying, setApplying] = useState(false);
  const [applyNotice, setApplyNotice] = useState<{ tone: "ok" | "info" | "error"; text: string } | null>(null);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  async function reload() {
    setError(null);
    setLoading(true);
    try {
      const [milestoneRes, statsRes, itemRes, linkRes] = await Promise.all([
        generalMilestoneList(projectId),
        generalStats(projectId),
        coreItemList(projectId),
        coreTaskLinkList(projectId),
      ]);
      if (!aliveRef.current) return;
      setMilestones(milestoneRes.milestones);
      setStats(statsRes.stats);
      setItems(itemRes.items);
      setLinks(linkRes.links);
    } catch (e) {
      if (aliveRef.current) setError(errorMessage(e));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const selectedTemplate = GENERAL_TEMPLATES.find((t) => t.id === templateId) ?? GENERAL_TEMPLATES[0];
  const counts = selectedTemplate ? templateCounts(selectedTemplate) : { items: 0, milestones: 0 };

  async function applyTemplate() {
    if (!selectedTemplate || archived || applying) return;
    setApplying(true);
    setApplyNotice(null);
    try {
      const stages = selectedTemplate.stages.map((stage) => ({
        title: stage.title,
        items: stage.items,
        milestone: stage.milestone
          ? { title: stage.milestone.title, note: stage.milestone.note ?? "" }
          : null,
      }));
      const result = await generalApplyTemplate(projectId, selectedTemplate.id, stages);
      if (!aliveRef.current) return;
      if (result.applied) {
        setApplyNotice({
          tone: "ok",
          text: `已创建 ${result.itemsCreated} 个事项、${result.milestonesCreated} 个里程碑。`,
        });
      } else {
        setApplyNotice({ tone: "info", text: result.reason ?? "模板未重复应用。" });
      }
      await reload();
    } catch (e) {
      if (aliveRef.current) setApplyNotice({ tone: "error", text: errorMessage(e) });
    } finally {
      if (aliveRef.current) setApplying(false);
    }
  }

  function openNewDraft() {
    if (archived) return;
    setDraft(emptyDraft());
  }

  function openEditDraft(m: GeneralMilestone) {
    if (archived) return;
    setDraft({
      id: m.id,
      title: m.title,
      targetDate: m.targetDate ?? "",
      status: m.status,
      note: m.note,
      linkedItemId: m.linkedItemId ?? "",
      linkedTaskId: m.linkedTaskId ?? "",
    });
  }

  async function saveDraft() {
    if (!draft || archived || saving) return;
    if (!draft.title.trim()) {
      setApplyNotice({ tone: "error", text: "里程碑名称不能为空。" });
      return;
    }
    setSaving(true);
    try {
      await generalMilestoneSave({
        id: draft.id,
        projectId,
        title: draft.title.trim(),
        targetDate: draft.targetDate || null,
        status: draft.status,
        note: draft.note,
        linkedItemId: draft.linkedItemId || null,
        linkedTaskId: draft.linkedTaskId || null,
      });
      if (!aliveRef.current) return;
      setDraft(null);
      await reload();
    } catch (e) {
      if (aliveRef.current) setError(errorMessage(e));
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  }

  async function removeMilestone(m: GeneralMilestone) {
    if (archived || busy) return;
    if (deletingId !== m.id) {
      setDeletingId(m.id);
      return;
    }
    setBusy(true);
    try {
      await generalMilestoneDelete(m.id);
      if (!aliveRef.current) return;
      setDeletingId(null);
      await reload();
    } catch (e) {
      if (aliveRef.current) setError(errorMessage(e));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  const itemOptions = [
    { value: "", label: "不关联事项" },
    ...items.map((item) => ({ value: item.id, label: item.title })),
  ];
  const taskOptions = [
    { value: "", label: "不关联任务" },
    ...links.map((link) => ({ value: link.taskId, label: link.title })),
  ];

  return (
    <div className="ws-general">
      {archived && (
        <div className="ws-notice" data-tone="info" role="status">
          <span>项目已归档，阶段与里程碑为只读；恢复为进行中后才能修改。</span>
        </div>
      )}

      {error && (
        <div className="ws-notice" data-tone="error" role="alert">
          <span>{error}</span>
          <button type="button" className="ws-btn" onClick={() => void reload()}>
            重试
          </button>
        </div>
      )}

      {loading ? (
        <div className="ws-state" data-tone="muted">
          <Loader2 size={12} className="ws-spin" /> 正在读取阶段与进度…
        </div>
      ) : (
        <>
          {/* 真实统计概览（D4） */}
          <section className="ws-general-stats" aria-label="项目进度概览">
            <div className="ws-stat">
              <strong>{stats ? `${stats.doneItems}/${stats.totalItems}` : "0/0"}</strong>
              <span>事项完成</span>
            </div>
            <div className="ws-stat">
              <strong>{stats ? `${stats.milestonesOpen}/${stats.milestonesTotal}` : "0/0"}</strong>
              <span>进行中里程碑</span>
            </div>
            <div className="ws-stat">
              <strong>{stats?.linkedTasks ?? 0}</strong>
              <span>关联任务</span>
            </div>
            <div className="ws-stat">
              <strong>{stats ? `${stats.materialsAlive}/${stats.materialsTotal}` : "0/0"}</strong>
              <span>可用资料</span>
            </div>
            <div className="ws-stat ws-general-current">
              <strong>{stats?.currentMilestone?.title ?? "—"}</strong>
              <span>当前里程碑</span>
            </div>
          </section>

          {/* 模板初始化（D1） */}
          <section className="ws-general-card" aria-label="项目模板">
            <div className="ws-card-head">
              <h3>项目模板</h3>
            </div>
            <div className="ws-form-row">
              <Select
                className="ws-flex"
                ariaLabel="选择项目模板"
                value={templateId}
                options={GENERAL_TEMPLATES.map((t) => ({ value: t.id, label: t.label }))}
                onChange={(value) => {
                  setTemplateId(value);
                  setApplyNotice(null);
                }}
                disabled={archived}
              />
              <button
                type="button"
                className="ws-btn ws-btn-primary"
                disabled={archived || applying}
                onClick={() => void applyTemplate()}
              >
                {applying ? <Loader2 size={12} className="ws-spin" /> : <Plus size={12} />}
                应用模板
              </button>
            </div>
            <p className="ws-meta">
              {selectedTemplate?.description ?? ""} 将创建 {counts.items} 个事项、
              {counts.milestones} 个里程碑；已有内容的项目不会重复初始化。
            </p>
            {applyNotice && (
              <div className="ws-notice" data-tone={applyNotice.tone} role="status">
                <span>{applyNotice.text}</span>
              </div>
            )}
          </section>

          {/* 里程碑列表（D2） */}
          <section className="ws-general-card" aria-label="阶段与里程碑">
            <div className="ws-card-head">
              <h3>阶段与里程碑</h3>
              <button
                type="button"
                className="ws-btn"
                disabled={archived}
                onClick={openNewDraft}
              >
                <Plus size={12} /> 新建里程碑
              </button>
            </div>

            {draft && (
              <div className="ws-general-draft" aria-label="里程碑编辑">
                <div className="ws-form-row">
                  <input
                    className="ws-input ws-flex"
                    aria-label="里程碑名称"
                    value={draft.title}
                    placeholder="里程碑名称"
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  />
                  <input
                    className="ws-input"
                    type="date"
                    aria-label="目标日期"
                    value={draft.targetDate}
                    onChange={(e) => setDraft({ ...draft, targetDate: e.target.value })}
                  />
                  <Select
                    ariaLabel="里程碑状态"
                    value={draft.status}
                    options={(Object.keys(STATUS_LABEL) as MilestoneStatus[]).map((s) => ({
                      value: s,
                      label: STATUS_LABEL[s],
                    }))}
                    onChange={(value) => setDraft({ ...draft, status: value as MilestoneStatus })}
                  />
                </div>
                <div className="ws-form-row">
                  <Select
                    className="ws-flex"
                    ariaLabel="关联事项"
                    value={draft.linkedItemId}
                    options={itemOptions}
                    onChange={(value) => setDraft({ ...draft, linkedItemId: value })}
                  />
                  <Select
                    className="ws-flex"
                    ariaLabel="关联任务"
                    value={draft.linkedTaskId}
                    options={taskOptions}
                    onChange={(value) => setDraft({ ...draft, linkedTaskId: value })}
                  />
                </div>
                <div className="ws-form-row">
                  <textarea
                    className="ws-input ws-flex"
                    aria-label="阶段备注"
                    rows={2}
                    value={draft.note}
                    placeholder="阶段备注（可选）"
                    onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                  />
                </div>
                <div className="ws-general-draft-actions">
                  <button
                    type="button"
                    className="ws-btn ws-btn-primary"
                    disabled={saving}
                    onClick={() => void saveDraft()}
                  >
                    {saving ? <Loader2 size={12} className="ws-spin" /> : null} 保存
                  </button>
                  <button type="button" className="ws-btn" onClick={() => setDraft(null)}>
                    取消
                  </button>
                </div>
              </div>
            )}

            {milestones.length === 0 && !draft ? (
              <div className="ws-empty">还没有里程碑；可应用模板初始化，或新建里程碑。</div>
            ) : (
              <ul className="ws-list">
                {milestones.map((m) => (
                  <li className="ws-row ws-general-row" key={m.id}>
                    <Flag size={13} className="ws-general-row-icon" />
                    <div className="ws-flex ws-general-row-main">
                      <div className="ws-general-row-title">
                        <strong>{m.title}</strong>
                        <span className={`ws-badge ws-general-status-${m.status}`}>
                          {STATUS_LABEL[m.status]}
                        </span>
                      </div>
                      <div className="ws-meta">
                        {m.targetDate ? `目标 ${m.targetDate}` : "未设目标日期"}
                        {m.linkedItemTitle ? ` · 事项：${m.linkedItemTitle}` : ""}
                        {m.linkedTaskTitle ? ` · 任务：${m.linkedTaskTitle}` : ""}
                        {m.note ? ` · ${m.note}` : ""}
                      </div>
                    </div>
                    {!archived && (
                      <span className="ws-general-row-actions">
                        <button
                          type="button"
                          className="ws-btn ws-btn-quiet"
                          aria-label={`编辑 ${m.title}`}
                          data-tip="编辑"
                          onClick={() => openEditDraft(m)}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          className="ws-btn ws-btn-quiet ws-btn-danger"
                          aria-label={deletingId === m.id ? `确认删除 ${m.title}` : `删除 ${m.title}`}
                          data-tip={deletingId === m.id ? "再次点击确认删除" : "删除"}
                          disabled={busy}
                          onClick={() => void removeMilestone(m)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 活动记录（D4，真实时间戳推导） */}
          <section className="ws-general-card" aria-label="项目活动记录">
            <div className="ws-card-head">
              <h3>
                <Activity size={13} /> 最近活动
              </h3>
            </div>
            {!stats || stats.recentActivity.length === 0 ? (
              <div className="ws-empty">暂无活动记录。</div>
            ) : (
              <ul className="ws-list">
                {stats.recentActivity.map((event) => (
                  <li className="ws-row ws-general-row" key={`${event.kind}-${event.refId}`}>
                    <div className="ws-flex ws-general-row-main">
                      <div className="ws-general-row-title">
                        <span className="ws-badge">{ACTIVITY_KIND_LABEL[event.kind] ?? event.kind}</span>
                        <strong>{event.title}</strong>
                      </div>
                      <div className="ws-meta">
                        {event.status ? `状态：${ITEM_STATUS_LABEL[event.status] ?? event.status}` : ""}
                        {" · "}
                        {formatTime(event.at)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
