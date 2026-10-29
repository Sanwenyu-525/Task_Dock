//! 任务上下文抽屉：把一个任务的现场 / Agent / 关联目标 / 剪贴板 / 动作
//! 汇到同一处。所有「恢复」只反映后端真实结果与验证级别，未核实即如实标注；
//! 窗口只记录标识（标题/类名/进程），不读取内容、不截图。

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppWindow,
  Bell,
  Bot,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Layers,
  Link2,
  RefreshCw,
  Save,
  Trash2,
  Unlink,
  X,
  Zap,
} from "lucide-react";
import {
  actionsOpenSession,
  clipboardSnapshotLinks,
  clipboardUnlinkSnapshot,
  onWorkspaceChanged,
  onWorkspaceRestoreProgress,
  taskContext,
  workspaceCaptureTask,
  workspaceCaptureWindows,
  workspaceCreate,
  workspaceDelete,
  workspaceGet,
  workspaceRestore,
  workspaceRestoreCancel,
  workspaceRestoreStatus,
  type ActionItem,
  type CaptureWindow,
  type ClipboardSnapshotLink,
  type ContextAgent,
  type RestoreItemResult,
  type SnapshotDetail,
  type SnapshotSummary,
  type TaskContext,
} from "../../lib/bridge";
import { useUiStore } from "../../store/useUiStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { useActionsStore, kindLabel as actionKindLabel } from "../../store/useActionsStore";
import { kindLabel as clipKindLabel } from "../../lib/clipboardUi";
import { AGENT_STATE_LABELS, formatRelative } from "../../lib/format";
import {
  navNavigate,
  resultMessage,
  stateBadge,
  verificationLabel,
  type NavigationTargetType,
  type TaskNavLink,
} from "../../lib/navigation";
import { TargetAvatar } from "../navigation/TargetMenu";

const ITEM_KIND_LABELS: Record<string, string> = {
  application: "应用",
  url: "网址",
  file: "文件",
  directory: "目录",
  agent_session: "Agent 会话",
};

const TARGET_TYPE_LABELS: Record<NavigationTargetType, string> = {
  application: "应用",
  url: "网址",
  file: "文件",
  directory: "目录",
  agent_session: "Agent 会话",
};

const OUTCOME_LABELS: Record<string, string> = {
  restored: "已恢复",
  skipped: "已跳过",
  failed: "失败",
  cancelled: "已取消",
};

function verificationShort(level: string): string {
  return verificationLabel(level);
}

export default function TaskContextDrawer() {
  const open = useUiStore((s) => s.context.open);
  const task = useUiStore((s) => s.context.task);
  const closeContext = useUiStore((s) => s.closeContext);
  const openClipboard = useUiStore((s) => s.openClipboard);
  const setTab = useUiStore((s) => s.setTab);
  const showToast = useUiStore((s) => s.showToast);
  const loadAgents = useAgentsStore((s) => s.load);
  const reloadActions = useActionsStore((s) => s.load);

  const taskId = task?.id ?? null;
  const [ctx, setCtx] = useState<TaskContext | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, SnapshotDetail>>({});
  const [snapshotLinks, setSnapshotLinks] = useState<Record<string, ClipboardSnapshotLink[]>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [liveResults, setLiveResults] = useState<RestoreItemResult[]>([]);
  const [progress, setProgress] = useState<{ index: number; total: number; name?: string } | null>(
    null,
  );

  // 捕获窗口对话框
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureWindows, setCaptureWindows] = useState<CaptureWindow[]>([]);
  const [captureSelected, setCaptureSelected] = useState<Set<number>>(new Set());
  const [captureName, setCaptureName] = useState("");
  const [captureLoading, setCaptureLoading] = useState(false);

  const drawerRef = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    if (!taskId) return;
    try {
      const c = await taskContext(taskId);
      setCtx(c);
    } catch (e) {
      showToast(`加载任务上下文失败：${String(e)}`, { kind: "error" });
    }
  }, [taskId, showToast]);

  useEffect(() => {
    if (!open || !taskId) return;
    setCtx(null);
    setDetailId(null);
    setDetails({});
    setSnapshotLinks({});
    setConfirmDelete(null);
    setLiveResults([]);
    setProgress(null);
    setCaptureOpen(false);
    void refresh();
    workspaceRestoreStatus()
      .then((s) => {
        if (s.running && s.snapshot_id) setRestoringId(s.snapshot_id);
      })
      .catch(() => {});
    const raf = requestAnimationFrame(() => drawerRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, taskId, refresh]);

  // 现场变化（捕获 / 删除 / 恢复完成）→ 短去抖后刷新上下文
  useEffect(() => {
    if (!open) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    onWorkspaceChanged(() => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 300);
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
      unlisten?.();
    };
  }, [open, refresh]);

  // 恢复进度：只做增量展示，不做整表高频重拉
  useEffect(() => {
    if (!open) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    onWorkspaceRestoreProgress((p) => {
      if (p.phase === "started") {
        setRestoringId((cur) => cur ?? p.snapshot_id);
        setLiveResults([]);
        setProgress({ index: 0, total: p.total });
        return;
      }
      if (p.phase === "running") {
        setRestoringId((cur) => cur ?? p.snapshot_id);
        setProgress({ index: p.index, total: p.total, name: p.display_name });
        return;
      }
      if (p.phase === "item-done") {
        if (p.result) setLiveResults((rs) => [...rs, p.result!]);
        setProgress({ index: p.index + 1, total: p.total });
        return;
      }
      if (p.phase === "done") {
        const sum = p.summary;
        setRestoringId(null);
        setProgress(null);
        setDetails((m) => {
          const next = { ...m };
          delete next[p.snapshot_id];
          return next;
        });
        if (sum) {
          showToast(
            `现场恢复完成：${sum.restored} 项已处理、${sum.skipped} 项跳过、${sum.failed} 项失败`,
            { kind: sum.failed > 0 ? "error" : "success" },
          );
        }
        void refresh();
        return;
      }
      // error
      setRestoringId(null);
      setProgress(null);
      showToast(`现场恢复失败：${p.error ?? "未知错误"}`, { kind: "error" });
      void refresh();
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [open, refresh, showToast]);

  // Escape：捕获对话框 → 抽屉（标题栏已对上下文抽屉避让）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (captureOpen) {
        setCaptureOpen(false);
        e.preventDefault();
        return;
      }
      closeContext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, captureOpen, closeContext]);

  if (!open || !task) return null;

  function close() {
    setCaptureOpen(false);
    setDetailId(null);
    setConfirmDelete(null);
    closeContext();
  }

  async function onSaveScene() {
    if (!taskId) return;
    setBusy("save");
    try {
      const snap = await workspaceCaptureTask(taskId);
      showToast(`已保存现场「${snap.name}」（${snap.item_count} 项）`, { kind: "success" });
      await refresh();
    } catch (e) {
      showToast(`保存现场失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function openCaptureDialog() {
    setCaptureOpen(true);
    setCaptureLoading(true);
    setCaptureSelected(new Set());
    const stamp = new Date().toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    setCaptureName(`${task!.title} · ${stamp}`);
    try {
      const ws = await workspaceCaptureWindows();
      setCaptureWindows(ws);
      // 无法识别进程的窗口后端会跳过，默认不勾选，避免制造「已捕获」的错觉
      setCaptureSelected(new Set(ws.filter((w) => w.exe_path).map((w) => w.hwnd)));
    } catch (e) {
      showToast(`枚举窗口失败：${String(e)}`, { kind: "error" });
      setCaptureWindows([]);
    } finally {
      setCaptureLoading(false);
    }
  }

  function toggleWindow(hwnd: number) {
    setCaptureSelected((s) => {
      const next = new Set(s);
      if (next.has(hwnd)) next.delete(hwnd);
      else next.add(hwnd);
      return next;
    });
  }

  async function onCreateCapture() {
    if (!taskId) return;
    if (captureSelected.size === 0) {
      showToast("请至少勾选一个窗口", { kind: "info" });
      return;
    }
    setBusy("capture");
    try {
      const snap = await workspaceCreate({
        task_id: taskId,
        name: captureName.trim() || "任务现场",
        source: "task",
        window_hwnds: [...captureSelected],
      });
      setCaptureOpen(false);
      showToast(`已保存现场「${snap.name}」（${snap.item_count} 项）`, { kind: "success" });
      await refresh();
    } catch (e) {
      showToast(`保存现场失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onRestore(s: SnapshotSummary) {
    setBusy(s.id);
    try {
      const started = await workspaceRestore(s.id);
      if (!started) {
        showToast("已有恢复在进行中，请稍候", { kind: "info" });
        return;
      }
      setRestoringId(s.id);
      setLiveResults([]);
      setProgress(null);
    } catch (e) {
      showToast(`恢复失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onCancelRestore() {
    try {
      await workspaceRestoreCancel();
      showToast("已请求取消；已发出的启动请求无法撤回", { kind: "info" });
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  async function onDelete(s: SnapshotSummary) {
    if (confirmDelete !== s.id) {
      setConfirmDelete(s.id);
      window.setTimeout(() => setConfirmDelete((cur) => (cur === s.id ? null : cur)), 3000);
      return;
    }
    setConfirmDelete(null);
    setBusy(s.id);
    try {
      await workspaceDelete(s.id);
      showToast("现场已删除（不影响任务与窗口）", { kind: "success" });
      await refresh();
    } catch (e) {
      showToast(`删除失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function toggleDetail(id: string) {
    if (detailId === id) {
      setDetailId(null);
      return;
    }
    setDetailId(id);
    if (details[id] && snapshotLinks[id]) return;
    try {
      const [d, links] = await Promise.all([workspaceGet(id), clipboardSnapshotLinks(id)]);
      setDetails((m) => ({ ...m, [id]: d }));
      setSnapshotLinks((m) => ({ ...m, [id]: links }));
    } catch (e) {
      showToast(`加载现场明细失败：${String(e)}`, { kind: "error" });
    }
  }

  async function onUnlinkSnapshotLink(snapshotId: string, link: ClipboardSnapshotLink) {
    try {
      await clipboardUnlinkSnapshot(link.id);
      setSnapshotLinks((m) => ({
        ...m,
        [snapshotId]: (m[snapshotId] ?? []).filter((l) => l.id !== link.id),
      }));
      showToast("已解除素材关联（剪贴板内容保留）", { kind: "success" });
    } catch (e) {
      showToast(`解除关联失败：${String(e)}`, { kind: "error" });
    }
  }

  async function onAgentJump(a: ContextAgent) {
    try {
      const r = await actionsOpenSession(a.source_id, a.session_external_id);
      showToast(
        r.success ? `已定位 ${a.source_name}（${verificationLabel(r.verification_level)}）` : (r.reason ?? "跳转未完成"),
        { kind: r.success ? "success" : "error" },
      );
      if (r.success) void loadAgents();
    } catch (e) {
      showToast(`跳转失败：${String(e)}`, { kind: "error" });
    }
  }

  async function onNav(l: TaskNavLink) {
    const action =
      l.launch_behavior === "launch"
        ? "open_app"
        : l.launch_behavior === "focus_or_launch"
          ? "focus_window"
          : l.launch_behavior === "resume_session"
            ? "resume_session"
            : undefined;
    try {
      const r = await navNavigate(l.target_id, { action, task_link_id: l.id });
      showToast(resultMessage(r, l.target.display_name), { kind: r.success ? "success" : "error" });
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  async function onAction(item: ActionItem) {
    if (item.kind === "reminder") {
      close();
      setTab("tasks");
      return;
    }
    if (!item.source_id || !item.session_external_id) return;
    try {
      const r = await actionsOpenSession(item.source_id, item.session_external_id);
      showToast(
        r.success ? `已定位 ${item.source_name}（${verificationLabel(r.verification_level)}）` : (r.reason ?? "跳转未完成"),
        { kind: r.success ? "success" : "error" },
      );
      if (r.success) {
        void loadAgents();
        void reloadActions();
      }
    } catch (e) {
      showToast(`跳转失败：${String(e)}`, { kind: "error" });
    }
  }

  const pct = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.index / progress.total) * 100))
    : 0;

  return (
    <>
      <div className="clipboard-layer context-layer">
        <div className="clipboard-scrim" aria-hidden onMouseDown={close} />
        <section
          className="clipboard-drawer context-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="任务上下文"
          ref={drawerRef}
          tabIndex={-1}
        >
          <header className="clip-head">
            <div className="clip-head-title">
              <Layers size={14} />
              <span className="context-title" title={task.title}>
                {task.title}
              </span>
            </div>
            <div className="clip-head-actions">
              <button className="icon-btn sm" onClick={() => void refresh()} title="刷新上下文" aria-label="刷新上下文">
                <RefreshCw size={12} />
              </button>
              <button className="icon-btn sm" onClick={close} title="关闭" aria-label="关闭">
                <X size={13} />
              </button>
            </div>
          </header>

          <div className="context-body">
            {!ctx && <div className="empty-hint">加载中…</div>}

            {ctx && (
              <>
                {/* ── 工作现场 ── */}
                <section className="context-section">
                  <div className="context-section-head">
                    <span className="context-section-title">
                      <Save size={12} /> 工作现场
                      <em className="badge subtle">{ctx.snapshots.length}</em>
                    </span>
                    <span className="flex-spacer" />
                    {restoringId && (
                      <button className="btn sm" onClick={onCancelRestore} title="在项间取消">
                        停止恢复
                      </button>
                    )}
                    <button
                      className="btn sm"
                      onClick={onSaveScene}
                      disabled={busy === "save"}
                      title="按任务关联目标与当前窗口保存现场"
                    >
                      <Save size={12} /> 保存当前现场
                    </button>
                    <button className="btn sm" onClick={openCaptureDialog} disabled={busy === "capture"} title="选择当前窗口保存">
                      <Camera size={12} /> 捕获窗口…
                    </button>
                  </div>
                  <div className="endpoint-hint">
                    只记录窗口标识（标题/类名/进程）与目标信息；不读取窗口内容、不截图。恢复结果按验证级别如实展示。
                  </div>

                  {ctx.snapshots.length === 0 && (
                    <div className="empty-hint">还没有现场。先关联应用/网址/文件，再「保存当前现场」。</div>
                  )}

                  {ctx.snapshots.map((s) => {
                    const expanded = detailId === s.id;
                    const detail = details[s.id];
                    const isRestoring = restoringId === s.id;
                    return (
                      <div key={s.id} className={`snapshot-card ${isRestoring ? "restoring" : ""}`}>
                        <div className="snapshot-row">
                          <button
                            className="snapshot-main"
                            onClick={() => void toggleDetail(s.id)}
                            aria-expanded={expanded}
                          >
                            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                            <span className="snapshot-name">{s.name}</span>
                            <span className="snapshot-meta">
                              {s.item_count} 项 · {formatRelative(s.created_at)}
                              {s.restore_count > 0 && ` · 恢复 ${s.restore_count} 次`}
                              {s.last_restored_at && ` · 上次 ${formatRelative(s.last_restored_at)}`}
                            </span>
                          </button>
                          <button
                            className="btn sm"
                            onClick={() => void onRestore(s)}
                            disabled={Boolean(restoringId) || busy === s.id}
                            title="恢复该现场（优先聚焦已存在窗口）"
                          >
                            {isRestoring ? "恢复中…" : "恢复"}
                          </button>
                          <button
                            className={`icon-btn sm ${confirmDelete === s.id ? "danger" : ""}`}
                            onClick={() => void onDelete(s)}
                            disabled={busy === s.id}
                            title={confirmDelete === s.id ? "再次点击确认删除现场" : "删除现场"}
                            aria-label={confirmDelete === s.id ? "确认删除现场" : "删除现场"}
                          >
                            {confirmDelete === s.id ? <Check size={12} /> : <Trash2 size={12} />}
                          </button>
                        </div>
                        {s.note && <div className="snapshot-note">{s.note}</div>}

                        {isRestoring && progress && (
                          <div className="context-progress">
                            <div className="context-progress-bar">
                              <div style={{ width: `${pct}%` }} />
                            </div>
                            <div className="context-progress-text">
                              {progress.index}/{progress.total}
                              {progress.name ? ` · ${progress.name}` : ""}
                            </div>
                          </div>
                        )}
                        {isRestoring && liveResults.length > 0 && (
                          <div className="snapshot-items">
                            {liveResults.map((r) => (
                              <div key={r.item_id} className={`restore-item outcome-${r.outcome}`}>
                                <span>{r.display_name}</span>
                                <em>
                                  {OUTCOME_LABELS[r.outcome] ?? r.outcome} · {verificationShort(r.verification_level)}
                                </em>
                              </div>
                            ))}
                          </div>
                        )}

                        {expanded && (
                          <>
                            <div className="snapshot-items">
                              {!detail && <div className="empty-hint">加载明细…</div>}
                              {detail?.items.map((it) => (
                                <div key={it.id} className="snapshot-item">
                                  <span className="snapshot-item-name" title={it.display_name}>
                                    {it.display_name}
                                  </span>
                                  <span className="snapshot-item-kind">{ITEM_KIND_LABELS[it.item_kind] ?? it.item_kind}</span>
                                  <span className={`snapshot-item-result outcome-${it.last_result || "none"}`}>
                                    {it.last_result
                                      ? `${OUTCOME_LABELS[it.last_result] ?? it.last_result}${
                                          it.last_verification ? ` · ${verificationShort(it.last_verification)}` : ""
                                        }`
                                      : "未恢复过"}
                                  </span>
                                  {it.restore_note && <span className="snapshot-item-note">{it.restore_note}</span>}
                                </div>
                              ))}
                              {detail?.items.length === 0 && <div className="empty-hint">现场中没有条目</div>}
                            </div>
                            {(snapshotLinks[s.id]?.length ?? 0) > 0 && (
                              <div className="snapshot-items snapshot-links">
                                <div className="snapshot-links-title">
                                  <ClipboardList size={10} /> 关联素材
                                </div>
                                {snapshotLinks[s.id].map((l) => (
                                  <div className="restore-item" key={l.id}>
                                    <span title={l.label}>
                                      {l.target_type === "group" ? "分组" : "条目"} · {l.label || l.target_id}
                                    </span>
                                    <em>{clipKindLabel(l.kind)}</em>
                                    <button
                                      className="icon-btn sm"
                                      onClick={() => void onUnlinkSnapshotLink(s.id, l)}
                                      title="解除关联（不删除剪贴板内容）"
                                      aria-label="解除素材关联"
                                    >
                                      <Unlink size={11} />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </section>

                {/* ── Agent ── */}
                <section className="context-section">
                  <div className="context-section-head">
                    <span className="context-section-title">
                      <Bot size={12} /> Agent 会话
                      <em className="badge subtle">{ctx.agents.length}</em>
                    </span>
                  </div>
                  {ctx.agents.length === 0 && (
                    <div className="empty-hint">暂无关联 Agent 会话；可从 Agent 面板或事件入口建立关联。</div>
                  )}
                  {ctx.agents.map((a) => (
                    <div className="context-row" key={`${a.source_id}:${a.session_external_id}`}>
                      <span className={`agent-dot state-${a.state}`} title={AGENT_STATE_LABELS[a.state] ?? a.state} />
                      <span className="context-row-main">
                        <span>{a.source_name}</span>
                        <em title={a.title || a.session_external_id}>{a.title || a.session_external_id}</em>
                      </span>
                      <span className="context-row-meta">
                        {AGENT_STATE_LABELS[a.state] ?? a.state}
                        {a.last_seen_at ? ` · ${formatRelative(a.last_seen_at)}` : ""}
                      </span>
                      <button className="btn sm" onClick={() => void onAgentJump(a)} title="跳回该 Agent 会话">
                        打开
                      </button>
                    </div>
                  ))}
                </section>

                {/* ── 关联目标 ── */}
                <section className="context-section">
                  <div className="context-section-head">
                    <span className="context-section-title">
                      <Link2 size={12} /> 关联目标
                      <em className="badge subtle">{ctx.navigation.length}</em>
                    </span>
                  </div>
                  {ctx.navigation.length === 0 && <div className="empty-hint">未关联应用/网址/文件。</div>}
                  {ctx.navigation.map((l) => {
                    const badge = stateBadge(l.running_state);
                    return (
                      <div className="context-row" key={l.id}>
                        <TargetAvatar link={l} size={18} />
                        <span className="context-row-main">
                          <span>{l.target.display_name}</span>
                          <em>{TARGET_TYPE_LABELS[l.target.target_type] ?? l.target.target_type}</em>
                        </span>
                        <span className={`context-state tone-${badge.tone}`}>{badge.label}</span>
                        <button className="btn sm" onClick={() => void onNav(l)} title="打开该目标">
                          打开
                        </button>
                      </div>
                    );
                  })}
                </section>

                {/* ── 剪贴板 ── */}
                <section className="context-section">
                  <div className="context-section-head">
                    <span className="context-section-title">
                      <ClipboardList size={12} /> 剪贴板素材
                      <em className="badge subtle">{ctx.clipboard.length}</em>
                    </span>
                    <span className="flex-spacer" />
                    <button
                      className="btn sm"
                      onClick={() => {
                        close();
                        openClipboard({ linkTask: task });
                      }}
                      title="打开智能剪贴板并关联条目/分组"
                    >
                      <ClipboardList size={12} /> 管理关联…
                    </button>
                  </div>
                  {ctx.clipboard.length === 0 && <div className="empty-hint">尚未关联剪贴板内容。</div>}
                  {ctx.clipboard.map((l) => (
                    <div className="context-row" key={l.id}>
                      <ClipboardList size={13} />
                      <span className="context-row-main">
                        <span>{l.target_type === "group" ? "分组" : "条目"}</span>
                        <em title={l.label}>{l.label || l.target_id}</em>
                      </span>
                      <span className="context-row-meta">{formatRelative(l.created_at)}</span>
                    </div>
                  ))}
                </section>

                {/* ── 待处理动作 ── */}
                <section className="context-section">
                  <div className="context-section-head">
                    <span className="context-section-title">
                      <Zap size={12} /> 待处理动作
                      <em className="badge subtle">{ctx.actions.length}</em>
                    </span>
                    <span className="flex-spacer" />
                    <button
                      className="btn sm"
                      onClick={() => {
                        close();
                        setTab("actions");
                      }}
                      title="前往行动中心"
                    >
                      全部…
                    </button>
                  </div>
                  {ctx.actions.length === 0 && <div className="empty-hint">没有与该任务相关的待处理动作。</div>}
                  {ctx.actions.map((item) => (
                    <button
                      key={item.id}
                      className={`context-row context-row-btn context-action p${item.priority}`}
                      onClick={() => void onAction(item)}
                      title={item.kind === "reminder" ? "查看任务" : "跳转到该 Agent 会话"}
                    >
                      <span className={`action-kind k-${item.kind}`}>
                        {item.kind === "reminder" ? <Bell size={10} /> : <Bot size={10} />}
                        {actionKindLabel(item.kind)}
                      </span>
                      <span className="context-row-main">
                        <span>{item.title}</span>
                        {item.message && <em>{item.message}</em>}
                      </span>
                      <span className="context-row-meta">{formatRelative(item.occurred_at)}</span>
                    </button>
                  ))}
                </section>
              </>
            )}
          </div>
        </section>
      </div>

      {captureOpen && (
        <div
          className="modal-mask"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCaptureOpen(false);
          }}
        >
          <div className="modal capture-modal" role="dialog" aria-modal="true" aria-label="捕获当前窗口">
            <div className="modal-head">
              <span>
                <AppWindow size={13} /> 捕获当前窗口
              </span>
              <button className="icon-btn sm" onClick={() => setCaptureOpen(false)} title="关闭" aria-label="关闭">
                <X size={13} />
              </button>
            </div>
            <div className="modal-body">
              <label className="field">
                <span>现场名称</span>
                <input value={captureName} onChange={(e) => setCaptureName(e.target.value)} />
              </label>
              <div className="endpoint-hint">
                只记录窗口标题、类名与进程路径，不读取窗口内容、不截图；句柄仅本次使用，不落库。
              </div>
              {captureLoading && <div className="empty-hint">正在枚举窗口…</div>}
              {!captureLoading && captureWindows.length === 0 && <div className="empty-hint">没有可捕获的窗口。</div>}
              {!captureLoading && captureWindows.length > 0 && (
                <div className="capture-list">
                  {captureWindows.map((w) => {
                    const selectable = Boolean(w.exe_path);
                    return (
                      <label key={w.hwnd} className={`capture-row ${selectable ? "" : "disabled"}`}>
                        <input
                          type="checkbox"
                          checked={captureSelected.has(w.hwnd)}
                          disabled={!selectable}
                          onChange={() => toggleWindow(w.hwnd)}
                        />
                        <span className="capture-title" title={w.title}>
                          {w.title || "（无标题窗口）"}
                        </span>
                        <span className="capture-meta">
                          {selectable ? w.exe_path!.split(/[\\/]/).pop() : "无法识别进程（将跳过）"}
                          {w.is_minimized ? " · 已最小化" : ""}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="modal-foot">
              <span className="endpoint-hint">
                已选 {captureSelected.size} / {captureWindows.length}
              </span>
              <div className="flex-spacer" />
              <button className="btn" onClick={() => setCaptureOpen(false)}>
                取消
              </button>
              <button
                className="btn primary"
                onClick={() => void onCreateCapture()}
                disabled={busy === "capture" || captureSelected.size === 0}
              >
                保存现场
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
