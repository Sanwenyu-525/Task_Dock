//! 投递目标管理（完整面板内的独立内容视图 + 真实文件投递区）。
//!
//! 结构（与「文件暂存架」视图互斥，不新增左侧导航 Tab）：
//! 返回暂存架 → 标题与目标数量 → 主要添加操作 → 目标卡片列表（含最近投递结果）
//! → 辅助刷新/说明。
//! 拖入语义：本视图是投递落点之一。拖入订阅仍在 ShelfWorkspace（全面板唯一消费者），
//! 松手坐标命中这里的 `data-drop-target` 卡片 → 真实投递到该目录；未命中仍按
//! 暂存处理。卡片高亮与提示条只表达落点，不改变这一路由归属。
//!
//! 与工具面板共享同一份配置（同一后端表 + 同一 store）：这里改名称/路径/模式/可见性，
//! 胶囊「文件」子页立即看到；反过来也成立。投递结果（store.reports）同样共享：
//! 胶囊里投递失败的批次在对应目标卡片下方也能看到并可重试。
//!
//! 所有的删除都只是「移除快捷入口」：真实目录与其中的文件一律不动。

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Folder,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type {
  DropTargetOpMode,
  ShelfConflictStrategy,
  ShelfDropEntry,
  ShelfDropReport,
  ShelfDropTarget,
} from "../../lib/bridge";
import { errorMessage } from "../../lib/errors";
import { useDropTargetsStore } from "../../store/useDropTargetsStore";
import { useUiStore } from "../../store/useUiStore";
import { ConfirmDialog } from "../ui/Dialog";
import DropTargetForm from "./DropTargetForm";
import { deliverToTarget } from "./shelfDeliver";

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return path;
  return `…\\${parts.slice(-3).join("\\")}`;
}

/** 结果条的状态标签：跳过 / 部分完成都不能被说成成功（与胶囊同口径）。 */
const STATUS_LABEL: Record<ShelfDropEntry["status"], string> = {
  ok: "成功",
  skipped: "跳过",
  failed: "失败",
  partial: "部分完成",
};

export default function DropTargetManager({
  onClose,
  onDirtyChange,
  dragActive = false,
  overTargetId = null,
  dropBlocked = false,
}: {
  onClose: () => void;
  /** 把「有未保存表单」上报给工作区：外部定位需要先确认才能切换视图。 */
  onDirtyChange?: (dirty: boolean) => void;
  /** 拖入会话进行中（由 ShelfWorkspace 消费者透传）：驱动落点提示条。 */
  dragActive?: boolean;
  /** 当前悬停命中的目标卡片 id：卡片用强调色内描边表达投递落点。 */
  overTargetId?: string | null;
  /** 当前拖入内容不能变成真实文件（链接/文本/未识别）：提示条如实说明不能投递。 */
  dropBlocked?: boolean;
}) {
  const targets = useDropTargetsStore((s) => s.targets);
  const loading = useDropTargetsStore((s) => s.loading);
  const error = useDropTargetsStore((s) => s.error);
  const reports = useDropTargetsStore((s) => s.reports);
  const reportNames = useDropTargetsStore((s) => s.reportNames);
  const load = useDropTargetsStore((s) => s.load);
  const update = useDropTargetsStore((s) => s.update);
  const remove = useDropTargetsStore((s) => s.remove);
  const move = useDropTargetsStore((s) => s.move);
  const openDir = useDropTargetsStore((s) => s.openDir);
  const showToast = useUiStore((s) => s.showToast);
  const [adding, setAdding] = useState(false);
  /** 正在编辑的目标 id：表单就地替换该行，不新开模态。 */
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  /** 有未保存表单时返回暂存架必须先确认，不能静默丢弃输入。 */
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /** 表单字段相对初始值是否真的变化（只是打开表单不算未保存修改）。 */
  const [formDirty, setFormDirty] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const formOpen = adding || editing !== null;
  const dirty = formOpen && formDirty;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // 打开/切换表单时先清掉上一张表单的脏标记，等新表单上报真实差异。
  useEffect(() => {
    setFormDirty(false);
  }, [adding, editing]);

  // 卸载时清掉标记：离开视图后不存在「未保存表单」。
  useEffect(() => {
    return () => onDirtyChange?.(false);
  }, [onDirtyChange]);

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) showToast(ok, { kind: "success" });
    } catch (e) {
      showToast(errorMessage(e), { kind: "error" });
    }
  };

  const requestClose = () => {
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  return (
    <div className="shelf-targets-view">
      <div className="shelf-targets-head">
        <button
          type="button"
          className="shelf-targets-back"
          aria-label="返回文件暂存架"
          onClick={requestClose}
        >
          <ArrowLeft size={13} strokeWidth={2.2} aria-hidden="true" />
          文件暂存架
        </button>
        <div className="shelf-targets-title">
          <h2>投递目标</h2>
          <span className="shelf-targets-count">
            {loading && targets.length === 0 ? "读取中" : `${targets.length} 个目录`}
          </span>
        </div>
        <div className="shelf-targets-head-actions">
          {!formOpen && (
            <button type="button" className="btn sm primary" onClick={() => setAdding(true)}>
              <Plus size={13} aria-hidden="true" /> 添加目标文件夹
            </button>
          )}
          <button
            type="button"
            className="btn sm"
            disabled={loading}
            onClick={() => void load({ force: true })}
          >
            {loading ? (
              <Loader2 size={13} className="spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={13} aria-hidden="true" />
            )}
            重新检查目录
          </button>
        </div>
      </div>

      <p className="shelf-targets-desc">
        拖进工具面板「收集箱 → 文件」中的目标卡片，即按这里的配置写入真实目录；默认复制并保留源文件。
        也可以把文件直接拖到下方目标卡片上完成投递；拖到卡片之外松手则暂存到文件暂存架。
      </p>

      {/* 落点提示必须渲染在目标列表之前但只占一行：拖入进行中才出现，
          与胶囊同一语义（命中卡片投递，空白松手暂存）。 */}
      {dragActive && targets.length > 0 && (
        <p className="shelf-targets-drop-hint is-live" role="status">
          {dropBlocked
            ? "此内容不能直接投递到文件夹；松手不会写入任何目录"
            : overTargetId
              ? `松开鼠标即投递到「${targets.find((t) => t.id === overTargetId)?.name ?? ""}」`
              : "把文件拖到目标卡片上投递；空白处松手将暂存到文件暂存架"}
        </p>
      )}

      {error && (
        <div className="shelf-targets-error" role="alert">
          <AlertTriangle size={13} strokeWidth={2.2} aria-hidden="true" />
          <span>{error}</span>
          <button type="button" className="btn sm" onClick={() => void load({ force: true })}>
            重试
          </button>
        </div>
      )}

      {adding && (
        <DropTargetForm
          target={null}
          variant="shelf"
          onDirtyChange={setFormDirty}
          onDone={(msg) => {
            setAdding(false);
            if (msg) showToast(msg, { kind: "success" });
          }}
          onError={(msg) => showToast(msg, { kind: "error" })}
        />
      )}

      {targets.length === 0 && !loading && !adding && (
        <div className="shelf-targets-empty">
          <Folder size={22} strokeWidth={1.5} aria-hidden="true" />
          <p>还没有配置投递目标。</p>
          <p className="shelf-targets-empty-sub">
            添加一个真实文件夹后，就能在工具面板把文件直接拖到对应卡片；默认复制，源文件保留。
          </p>
          <button type="button" className="btn sm primary" onClick={() => setAdding(true)}>
            <Plus size={13} aria-hidden="true" /> 添加目标文件夹
          </button>
        </div>
      )}

      {targets.length === 0 && loading && (
        <p className="shelf-targets-loading" role="status">
          <Loader2 size={14} className="spin" aria-hidden="true" /> 正在检查目标目录…
        </p>
      )}

      {targets.length > 0 && (
        <ul className={`shelf-drop-targets-list${editing !== null ? " is-editing" : ""}`}>
          {targets.map((t, index) => (
            <li key={t.id} className="shelf-drop-targets-item">
              {editing === t.id ? (
                <DropTargetForm
                  target={t}
                  variant="shelf"
                  onDirtyChange={setFormDirty}
                  onDone={(msg) => {
                    setEditing(null);
                    if (msg) showToast(msg, { kind: "success" });
                  }}
                  onError={(msg) => showToast(msg, { kind: "error" })}
                />
              ) : (
                <TargetRow
                  target={t}
                  first={index === 0}
                  last={index === targets.length - 1}
                  confirming={confirmId === t.id}
                  over={overTargetId === t.id}
                  onOpen={() => void run(() => openDir(t.id))}
                  onEdit={() => setEditing(t.id)}
                  onMove={(dir) => void run(() => move(t.id, dir))}
                  onToggleVisible={() =>
                    void run(
                      () => update(t.id, { show_in_capsule: !t.show_in_capsule }),
                      t.show_in_capsule ? "已从工具面板隐藏" : "已显示在工具面板",
                    )
                  }
                  onMode={(mode) =>
                    void run(
                      () => update(t.id, { op_mode: mode }),
                      mode === "move" ? "已切换为移动" : "已切换为复制",
                    )
                  }
                  onConflict={(conflict) => void run(() => update(t.id, { conflict }))}
                  onAskRemove={() => setConfirmId(t.id)}
                  onCancelRemove={() => setConfirmId(null)}
                  onConfirmRemove={() => {
                    setConfirmId(null);
                    void run(() => remove(t.id), "已移除入口（目录与文件未改动）");
                  }}
                />
              )}
              {/* 最近一次投递结果跟着目标卡片走：胶囊里投递的批次在这里同样可见。 */}
              {editing !== t.id && reports[t.id] && (
                <TargetReport
                  key={reports[t.id].batch_id}
                  report={reports[t.id]}
                  target={t}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {/* 目标入口已移除但结果重要（有失败/部分完成）的报告：保留可见，不丢关键信息。 */}
      {Object.entries(reports)
        .filter(([id]) => !targets.some((t) => t.id === id))
        .map(([id, report]) => (
          <OrphanReport key={report.batch_id} report={report} name={reportNames[id] ?? ""} />
        ))}

      <p className="shelf-drop-targets-note">
        移除只删除快捷入口，不会删除真实目录或其中的文件；投递默认复制并保留源文件。
      </p>

      <ConfirmDialog
        open={confirmDiscard}
        title="放弃未保存的目标修改？"
        detail="正在新增或编辑的目标配置还没有保存，返回文件暂存架会丢失这些输入。"
        confirmLabel="放弃并返回"
        danger
        onConfirm={() => {
          setConfirmDiscard(false);
          setAdding(false);
          setEditing(null);
          onClose();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}

function TargetRow({
  target,
  first,
  last,
  confirming,
  over,
  onOpen,
  onEdit,
  onMove,
  onToggleVisible,
  onMode,
  onConflict,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: {
  target: ShelfDropTarget;
  first: boolean;
  last: boolean;
  confirming: boolean;
  /** 拖入悬停命中本卡片：强调色内描边表达投递落点（样式层不挡命中）。 */
  over: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onMove: (dir: "up" | "down") => void;
  onToggleVisible: () => void;
  onMode: (mode: DropTargetOpMode) => void;
  onConflict: (conflict: ShelfConflictStrategy) => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
}) {
  return (
    <div
      className={`shelf-drop-target-row${target.available ? "" : " is-off"}${over ? " is-over" : ""}`}
      data-drop-target={target.id}
    >
      <span className="shelf-drop-target-icon" aria-hidden="true">
        <Folder size={15} strokeWidth={1.8} />
      </span>

      <div className="shelf-drop-target-main">
        <span className="shelf-drop-target-name-line">
          <span className="shelf-drop-target-name" title={target.name}>
            {target.name}
          </span>
          {!target.available && (
            <span className="shelf-fileop-badge" data-tip="目录不存在或不可访问；投递会被拒绝">
              不可用
            </span>
          )}
        </span>
        <button
          type="button"
          className="shelf-drop-target-path"
          data-tip={`${target.path}（点击在资源管理器中打开）`}
          onClick={onOpen}
        >
          {shortPath(target.path)}
        </button>
      </div>

      <div className="shelf-drop-target-modes" role="group" aria-label={`「${target.name}」投递方式`}>
        <div className="seg-group">
          <button
            type="button"
            className={`seg-btn ${target.op_mode === "copy" ? "active" : ""}`}
            aria-pressed={target.op_mode === "copy"}
            onClick={() => onMode("copy")}
          >
            复制
          </button>
          <button
            type="button"
            className={`seg-btn ${target.op_mode === "move" ? "active" : ""}`}
            aria-pressed={target.op_mode === "move"}
            onClick={() => onMode("move")}
          >
            移动
          </button>
        </div>
        <div className="seg-group subtle">
          <button
            type="button"
            className={`seg-btn ${target.conflict === "rename" ? "active" : ""}`}
            aria-pressed={target.conflict === "rename"}
            onClick={() => onConflict("rename")}
          >
            自动重命名
          </button>
          <button
            type="button"
            className={`seg-btn ${target.conflict === "skip" ? "active" : ""}`}
            aria-pressed={target.conflict === "skip"}
            onClick={() => onConflict("skip")}
          >
            同名跳过
          </button>
        </div>
      </div>

      <div className="shelf-drop-target-actions">
        <button
          type="button"
          className="icon-btn sm"
          aria-label={`上移「${target.name}」`}
          data-tip="上移"
          disabled={first}
          onClick={() => onMove("up")}
        >
          <ArrowUp size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-btn sm"
          aria-label={`下移「${target.name}」`}
          data-tip="下移"
          disabled={last}
          onClick={() => onMove("down")}
        >
          <ArrowDown size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-btn sm"
          aria-label={`编辑「${target.name}」`}
          data-tip="编辑名称与目录"
          onClick={onEdit}
        >
          <Pencil size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-btn sm"
          aria-label={target.show_in_capsule ? `从工具面板隐藏「${target.name}」` : `在工具面板显示「${target.name}」`}
          aria-pressed={target.show_in_capsule}
          data-tip={target.show_in_capsule ? "在工具面板显示" : "已从工具面板隐藏"}
          onClick={onToggleVisible}
        >
          {target.show_in_capsule ? <Eye size={12} aria-hidden="true" /> : <EyeOff size={12} aria-hidden="true" />}
        </button>
        {confirming ? (
          <>
            <button type="button" className="btn sm danger" onClick={onConfirmRemove}>
              确认移除
            </button>
            <button type="button" className="btn sm" onClick={onCancelRemove}>
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            className="icon-btn sm"
            aria-label={`移除「${target.name}」入口`}
            data-tip="移除入口（不删文件）"
            onClick={onAskRemove}
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

/** 逐项结果里需要解释的条目（跳过不是成功，部分完成也不是失败）。 */
function pendingEntriesOf(report: ShelfDropReport): ShelfDropEntry[] {
  return (report.entries ?? []).filter((e) => e.status !== "ok");
}

/** 目标卡片下方的最近投递结果：计数、逐项原因与恢复建议、可操作出口。 */
function TargetReport({ report, target }: { report: ShelfDropReport; target: ShelfDropTarget }) {
  const openDir = useDropTargetsStore((s) => s.openDir);
  const clearReport = useDropTargetsStore((s) => s.clearReport);
  const showToast = useUiStore((s) => s.showToast);
  /** 有失败/部分完成时默认展开：用户需要立刻看到原因，而不是再点一次。 */
  const [open, setOpen] = useState(report.failed > 0 || report.partial > 0);
  const [retrying, setRetrying] = useState(false);

  // 新批次到达时重置展开态：上一批的手动收起不迁移到新结果。
  useEffect(() => {
    setOpen(report.failed > 0 || report.partial > 0);
  }, [report.batch_id, report.failed, report.partial]);

  const pending = pendingEntriesOf(report);
  const hasProblem = report.failed > 0 || report.partial > 0;

  /** 查看诊断：意图随导航事务下发（`after`），取消/保存中拦截时不残留。 */
  const showDiagnostics = () => {
    useUiStore.getState().setTab("diagnostics", {
      after: () => useUiStore.getState().requestDiagnosticsOperation(report.batch_id),
    });
  };

  /** 重试失败项：failed/partial/skipped 的 source 原样重投，可用性兜底同拖放投递。 */
  const retryPending = async () => {
    if (retrying) return;
    const sources = pending.map((e) => e.source);
    if (sources.length === 0) return;
    setRetrying(true);
    try {
      const result = await deliverToTarget(target.id, sources);
      if (result.kind === "blocked") {
        showToast(result.reason, { kind: "error" });
        return;
      }
      if (result.kind === "error") {
        showToast(`重试投递失败：${result.message}`, { kind: "error" });
        return;
      }
      // 新报告已由 store 落库并替换展示；有剩余失败再显式提示，不冒充全部成功。
      const r = result.report;
      if (r.failed > 0 || r.partial > 0) {
        const parts: string[] = [];
        if (r.failed > 0) parts.push(`${r.failed} 项失败`);
        if (r.partial > 0) parts.push(`${r.partial} 项部分完成`);
        showToast(`重试完成：${parts.join("、")}，详情见结果条`, { kind: "warning" });
      } else if (r.skipped > 0) {
        showToast(`重试完成：${r.success} 项成功，${r.skipped} 项跳过`, { kind: "success" });
      } else {
        showToast(`重试完成：${r.success} 项成功`, { kind: "success" });
      }
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className={`shelf-drop-report${hasProblem ? " is-warn" : ""}`}>
      <button
        type="button"
        className="shelf-drop-report-head"
        aria-expanded={open}
        aria-controls={`shelf-drop-report-detail-${report.target_id}`}
        onClick={() => setOpen((v) => !v)}
      >
        {hasProblem ? (
          <AlertTriangle size={13} strokeWidth={2.2} aria-hidden="true" />
        ) : (
          <Check size={13} strokeWidth={2.4} aria-hidden="true" />
        )}
        <span className="shelf-drop-report-text">
          最近投递：成功 {report.success} 项 · 跳过 {report.skipped} 项
          {report.partial > 0 ? ` · 部分完成 ${report.partial} 项` : ""}
          {` · 失败 ${report.failed} 项`}
        </span>
        <ChevronDown
          size={12}
          strokeWidth={2.2}
          aria-hidden="true"
          className={open ? "is-open" : undefined}
        />
      </button>
      {open && (
        <ul
          className="shelf-drop-report-list"
          id={`shelf-drop-report-detail-${report.target_id}`}
        >
          {pending.map((e, i) => (
            <li key={`${e.source}-${i}`}>
              <span className="shelf-drop-report-name" title={e.source}>
                <span className={`shelf-drop-report-tag is-${e.status}`}>
                  {STATUS_LABEL[e.status] ?? e.status}
                </span>
                {e.display_name}
              </span>
              <span className="shelf-drop-report-reason">{e.reason ?? STATUS_LABEL[e.status]}</span>
              {e.residual_source && (
                <span className="shelf-drop-report-residual" title={e.residual_source}>
                  可能残留：{e.residual_source}
                </span>
              )}
              {e.recovery && <span className="shelf-drop-report-recovery">{e.recovery}</span>}
            </li>
          ))}
          {pending.length === 0 && (
            <li>
              <span className="shelf-drop-report-reason">全部条目已完整写入目标目录。</span>
            </li>
          )}
        </ul>
      )}
      <div className="shelf-drop-report-actions">
        {hasProblem && (
          <button type="button" className="link-btn" onClick={showDiagnostics}>
            查看诊断
          </button>
        )}
        {pending.length > 0 && (
          <button
            type="button"
            className="link-btn"
            disabled={retrying}
            onClick={() => void retryPending()}
          >
            {retrying ? <Loader2 size={11} className="spin" aria-hidden="true" /> : null}
            重试失败项（{pending.length}）
          </button>
        )}
        <button
          type="button"
          className="link-btn"
          onClick={() => void openDir(target.id).catch((e) => showToast(errorMessage(e), { kind: "error" }))}
        >
          打开目标文件夹
        </button>
        <button
          type="button"
          className="link-btn"
          aria-label={`清除「${target.name}」的投递结果`}
          onClick={() => clearReport(target.id)}
        >
          清除结果
        </button>
      </div>
    </div>
  );
}

/** 目标入口已移除但结果仍重要（有失败/部分完成）的孤儿报告：不丢关键信息。 */
function OrphanReport({ report, name }: { report: ShelfDropReport; name: string }) {
  const clearReport = useDropTargetsStore((s) => s.clearReport);
  const [open, setOpen] = useState(true);
  const pending = pendingEntriesOf(report);
  return (
    <div className="shelf-drop-report is-warn is-orphan">
      <button
        type="button"
        className="shelf-drop-report-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <AlertTriangle size={13} strokeWidth={2.2} aria-hidden="true" />
        <span className="shelf-drop-report-text">
          「{name || "已移除的目标"}」有未完成的投递：失败 {report.failed} 项
          {report.partial > 0 ? ` · 部分完成 ${report.partial} 项` : ""}
          {report.skipped > 0 ? ` · 跳过 ${report.skipped} 项` : ""}
        </span>
        <ChevronDown
          size={12}
          strokeWidth={2.2}
          aria-hidden="true"
          className={open ? "is-open" : undefined}
        />
      </button>
      {open && (
        <ul className="shelf-drop-report-list">
          {pending.map((e, i) => (
            <li key={`${e.source}-${i}`}>
              <span className="shelf-drop-report-name" title={e.source}>
                <span className={`shelf-drop-report-tag is-${e.status}`}>
                  {STATUS_LABEL[e.status] ?? e.status}
                </span>
                {e.display_name}
              </span>
              <span className="shelf-drop-report-reason">{e.reason ?? STATUS_LABEL[e.status]}</span>
              {e.residual_source && (
                <span className="shelf-drop-report-residual" title={e.residual_source}>
                  可能残留：{e.residual_source}
                </span>
              )}
              {e.recovery && <span className="shelf-drop-report-recovery">{e.recovery}</span>}
            </li>
          ))}
          <li>
            <span className="shelf-drop-report-reason">
              目标入口已移除；请到「{report.target_path}」手工核对残留文件。
            </span>
          </li>
        </ul>
      )}
      <div className="shelf-drop-report-actions">
        <button
          type="button"
          className="link-btn"
          onClick={() =>
            useUiStore.getState().setTab("diagnostics", {
              after: () => useUiStore.getState().requestDiagnosticsOperation(report.batch_id),
            })
          }
        >
          查看诊断
        </button>
        <button type="button" className="link-btn" onClick={() => clearReport(report.target_id)}>
          清除结果
        </button>
      </div>
    </div>
  );
}
