//! 开发工作台（2026-11）：以「当前开发任务」为核心的任务优先布局。
//!
//! 四个区域（首屏优先级从高到低）：
//! A. 当前开发任务 —— 任务信息、关联 Agent 会话、工作现场、下一步动作；
//! B. Agent 运行 —— 复用 `agent_snapshot` + `liveSummary` 六态聚合；
//! C. 需要处理 —— 复用行动中心 intervention 分区 + 当前任务未读提醒
//!    （notification 分区；不建第二套事件系统）；
//! D. 快速继续 —— 最近待办任务及其工作现场，逐项反馈恢复结果。
//!
//! 数据边界：
//! - 「当前开发任务」是用户显式设置（`workbench_current_task`），绝不按标题相似度
//!   自动绑定；任务删除后保留原值，读侧校验并如实展示失效状态。
//! - Agent 完成一轮 ≠ 开发任务完成：本页不写任务状态，完成只经 `toggle_task`
//!   由用户确认（两段式确认 + 可撤销），与任务页同一后端入口。
//! - 恢复现场复用 `workspace_restore`（后台单飞 + 逐项回执），每个操作的真实
//!   结果（成功/跳过/失败/已在恢复中）就地反馈，不伪造恢复成功。
//! - 全部数据来自既有命令与 store；事件刷新复用 App 层既有订阅
//!   （agent 快照 / 行动中心计数 / workspace-changed），不新增轮询。
//! - 恢复回执订阅在本面板只有一条（createSubscriptionScope 管理），区域 A/D 共用；
//!   语义与 TaskContextDrawer 的恢复进度一致（done 汇总 toast、error 明确报错）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Layers,
  ListTodo,
  Pencil,
  Save,
} from "lucide-react";
import AgentIcon from "../ui/AgentIcon";
import {
  actionsFeed,
  actionsOpenSession,
  fetchTask,
  listTasks,
  onWorkspaceChanged,
  onWorkspaceRestoreProgress,
  taskContext,
  taskReminderLinkGet,
  toggleTask,
  workspaceList,
  workspaceRestore,
  workspaceRestoreCancel,
  type ActionItem,
  type RestoreSummary,
  type SnapshotSummary,
  type Task,
  type TaskContext,
  type TaskReminderLink,
  type WorkspaceRestoreProgress,
} from "../../lib/bridge";
import { useUiStore } from "../../store/useUiStore";
import { useTasksStore } from "../../store/useTasksStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { useActionsStore, kindLabel as actionKindLabel } from "../../store/useActionsStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { liveSummary } from "../../lib/agentTree";
import { createSubscriptionScope } from "../../lib/subscriptions";
import { errorMessage } from "../../lib/errors";
import { AGENT_STATE_LABELS, formatDue, formatRelative, priorityLabel } from "../../lib/format";
import { verificationLabel } from "../../lib/navigation";
import { useLocale } from "../../hooks/useLocale";
import { t as translate } from "../../i18n";

/** 最近待办数量：区域 D 与空态快捷选择共用，保持首屏一屏内可读。 */
const RECENT_LIMIT = 6;
/** 需要处理事项的首屏条数：完整列表在行动中心。 */
const TODO_LIMIT = 8;

/** 最近待办（区域 D）每一行的现场摘要：loading=读取中；error=读取失败。 */
interface RecentSnapshots {
  state: "loading" | "ok" | "error";
  snaps: SnapshotSummary[];
}

/** 恢复过程的状态（按快照 ID 记录）：running / done / error。 */
type RestoreState =
  | { phase: "running" }
  | { phase: "done"; summary: RestoreSummary }
  | { phase: "error"; error: string };

/** 取最近更新的一份现场（确定性选择，不依赖后端返回顺序）。 */
function latestSnapshot(snaps: SnapshotSummary[]): SnapshotSummary | null {
  let best: SnapshotSummary | null = null;
  for (const s of snaps) {
    if (!best || s.updated_at > best.updated_at) best = s;
  }
  return best;
}

/** 后端「任务不存在」类错误的读侧判定（fetch_task/task_context 404 语义）。 */
function isTaskMissingError(msg: string): boolean {
  return /not[_ ]?found|不存在|no rows|未找到/i.test(msg);
}

export default function DevWorkbenchPanel() {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  const currentId = useSettingsStore((s) => s.settings?.workbench_current_task ?? "") || null;

  const clearCurrent = useCallback(() => {
    void useSettingsStore
      .getState()
      .update({ workbench_current_task: "" })
      .catch((e) =>
        showToast(t("workbench.setCurrentFailed", { error: errorMessage(e) }), { kind: "error" }),
      );
  }, [showToast, t]);
  const setCurrent = useCallback(
    (id: string) => {
      void useSettingsStore
        .getState()
        .update({ workbench_current_task: id })
        .catch((e) =>
          showToast(t("workbench.setCurrentFailed", { error: errorMessage(e) }), { kind: "error" }),
        );
    },
    [showToast, t],
  );

  // ── 恢复运行时：面板内唯一一条回执订阅，区域 A/D 共用 ─────────────
  const [restores, setRestores] = useState<Record<string, RestoreState>>({});
  const restoresRef = useRef(restores);
  restoresRef.current = restores;
  /** 恢复完成/现场变化后的统一刷新（当前任务上下文 + 最近列表的现场摘要）。 */
  const [refreshTick, setRefreshTick] = useState(0);
  const bumpRefresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  useEffect(() => {
    const scope = createSubscriptionScope();
    scope.add(
      onWorkspaceRestoreProgress((p: WorkspaceRestoreProgress) => {
        if (p.phase === "started" || p.phase === "running" || p.phase === "item-done") {
          setRestores((m) =>
            m[p.snapshot_id]?.phase === "running"
              ? m
              : { ...m, [p.snapshot_id]: { phase: "running" } },
          );
          return;
        }
        if (p.phase === "done") {
          const sum = p.summary;
          if (sum) {
            setRestores((m) => ({ ...m, [p.snapshot_id]: { phase: "done", summary: sum } }));
            showToast(
              t("workbench.restoreDone", {
                restored: sum.restored,
                skipped: sum.skipped,
                failed: sum.failed,
              }),
              { kind: sum.failed > 0 ? "warning" : "success" },
            );
          }
          bumpRefresh();
          return;
        }
        setRestores((m) => ({
          ...m,
          [p.snapshot_id]: { phase: "error", error: p.error ?? "unknown" },
        }));
        showToast(t("workbench.restoreFailed", { error: p.error ?? "unknown" }), { kind: "error" });
        bumpRefresh();
      }),
    );
    return () => scope.dispose();
  }, [showToast, t, bumpRefresh]);

  const restoringAny = useMemo(
    () => Object.values(restores).some((r) => r.phase === "running"),
    [restores],
  );

  const restoreSnapshot = useCallback(
    async (snap: SnapshotSummary) => {
      if (restoresRef.current[snap.id]?.phase === "running") return;
      try {
        const started = await workspaceRestore(snap.id);
        if (!started) {
          // false = 已有恢复在后台进行（单飞约束）：如实提示，不算失败
          showToast(t("workbench.restoreDeclined"), { kind: "info" });
          return;
        }
        setRestores((m) => ({ ...m, [snap.id]: { phase: "running" } }));
      } catch (e) {
        showToast(t("workbench.restoreFailed", { error: errorMessage(e) }), { kind: "error" });
      }
    },
    [showToast, t],
  );

  const cancelRestore = useCallback(async () => {
    try {
      await workspaceRestoreCancel();
      showToast(t("workbench.cancelRequested"), { kind: "info" });
    } catch (e) {
      showToast(t("workbench.cancelRestoreFailed", { error: errorMessage(e) }), { kind: "error" });
    }
  }, [showToast, t]);

  return (
    <div className="workbench-panel page-fill">
      <header className="wb-head">
        <div>
          <h2 className="wb-title">{t("nav.workbench")}</h2>
          <p className="wb-subtitle">{t("workbench.subtitle")}</p>
        </div>
        {restoringAny && (
          <button type="button" className="btn sm" onClick={() => void cancelRestore()}>
            {t("workbench.stopRestore")}
          </button>
        )}
      </header>
      <div className="page-scroll wb-body">
        <CurrentTaskSection
          currentId={currentId}
          onClear={clearCurrent}
          onPick={setCurrent}
          restores={restores}
          onRestore={restoreSnapshot}
          refreshTick={refreshTick}
          restoringAny={restoringAny}
        />
        <div className="wb-grid">
          <AgentSummarySection />
          <AttentionSection currentId={currentId} />
        </div>
        <RecentSection
          excludeId={currentId}
          restores={restores}
          onRestore={restoreSnapshot}
          refreshTick={refreshTick}
        />
      </div>
    </div>
  );
}

/* ══ A. 当前开发任务 ══════════════════════════════════════════════ */

function CurrentTaskSection({
  currentId,
  onClear,
  onPick,
  restores,
  onRestore,
  refreshTick,
  restoringAny,
}: {
  currentId: string | null;
  onClear: () => void;
  onPick: (id: string) => void;
  restores: Record<string, RestoreState>;
  onRestore: (snap: SnapshotSummary) => Promise<void>;
  refreshTick: number;
  restoringAny: boolean;
}) {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  const setTab = useUiStore((s) => s.setTab);
  const openContext = useUiStore((s) => s.openContext);
  const openEditor = useUiStore((s) => s.openEditor);
  // 任务统计随 task 事件刷新；以其为节拍同步当前任务上下文（完成/撤销后状态及时更新）
  const statsTick = useTasksStore((s) => s.stats);

  const [ctx, setCtx] = useState<TaskContext | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<TaskReminderLink | null>(null);
  /** 完成确认两段式：第一段只点亮确认态，3s 内再点才执行（完成后可撤销）。 */
  const [confirmDone, setConfirmDone] = useState(false);
  const confirmTimer = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCtx(null);
    setStale(false);
    setError(null);
    setLink(null);
    setConfirmDone(false);
  }, [currentId]);

  const refresh = useCallback(async () => {
    if (!currentId) return;
    try {
      const c = await taskContext(currentId);
      setCtx(c);
      setStale(false);
      setError(null);
    } catch (e) {
      // 读侧校验：任务不存在（已删除）时不静默清空设置，如实展示失效状态
      const msg = errorMessage(e);
      if (isTaskMissingError(msg)) setStale(true);
      else setError(msg);
    }
  }, [currentId]);

  useEffect(() => {
    if (!currentId) return;
    void refresh();
    void taskReminderLinkGet(currentId)
      .then((l) => setLink(l))
      .catch(() => setLink(null)); // 联动读取失败不影响主信息展示
    // workspace-changed：现场捕获/删除/恢复后短去抖刷新（与任务抽屉同节拍）
    const scope = createSubscriptionScope();
    let timer: number | undefined;
    scope.add(
      onWorkspaceChanged(() => {
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => void refresh(), 300);
      }),
    );
    return () => {
      scope.dispose();
      if (timer) window.clearTimeout(timer);
    };
  }, [currentId, refresh, refreshTick]);

  useEffect(() => {
    if (currentId) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsTick]);

  useEffect(
    () => () => {
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    },
    [],
  );

  const onMarkComplete = async () => {
    const task = ctx?.task;
    if (!task || busy) return;
    if (!confirmDone) {
      setConfirmDone(true);
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirmDone(false), 3000);
      return;
    }
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    setConfirmDone(false);
    setBusy(true);
    try {
      const updated = await toggleTask(task.id);
      showToast(t("workbench.completeDone", { title: updated.title }), {
        kind: "success",
        action: {
          label: t("workbench.undo"),
          run: () => {
            void toggleTask(updated.id)
              .then(() => {
                void refresh();
                void useTasksStore.getState().refresh();
              })
              .catch((e) =>
                showToast(t("workbench.undoFailed", { error: errorMessage(e) }), {
                  kind: "error",
                }),
              );
          },
        },
      });
      await refresh();
      void useTasksStore.getState().refresh();
    } catch (e) {
      showToast(t("workbench.toggleFailed", { error: errorMessage(e) }), { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const task = ctx?.task ?? null;
  const snaps = ctx?.snapshots ?? [];
  const latest = latestSnapshot(snaps);
  const latestRestore = latest ? restores[latest.id] : undefined;
  /** 「继续工作」的真实优先级：最新现场 → 最近关联会话（如实回执）→ 打开上下文。 */
  const linkedAgent = ctx?.agents[0] ?? null;

  return (
    <section className="wb-card wb-current" aria-label={t("workbench.currentTask")}>
      <div className="wb-section-head">
        <h3 className="wb-section-title">{t("workbench.currentTask")}</h3>
        <span className="flex-spacer" />
        {currentId && !stale && (
          <button
            type="button"
            className="btn sm"
            onClick={onClear}
            data-tip={t("workbench.clearCurrent")}
          >
            {t("workbench.clearCurrent")}
          </button>
        )}
      </div>

      {!currentId && <CurrentTaskEmpty onPick={onPick} />}

      {currentId && stale && (
        <div className="wb-stale" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span className="wb-stale-text">{t("workbench.staleTask")}</span>
          <button type="button" className="btn sm" onClick={() => setTab("tasks")}>
            {t("workbench.goTasks")}
          </button>
          <button type="button" className="btn sm" onClick={onClear}>
            {t("workbench.clearCurrent")}
          </button>
        </div>
      )}

      {currentId && !stale && error && (
        <div className="wb-error-row" role="alert">
          <span>{t("workbench.loadFailed", { error })}</span>
          <button type="button" className="btn sm" onClick={() => void refresh()}>
            {t("workbench.retry")}
          </button>
        </div>
      )}

      {currentId && !stale && !error && !ctx && (
        <div className="empty-hint" role="status">
          {t("nav.loading")}
        </div>
      )}

      {task && (
        <>
          <div className="wb-task-head">
            <span className={`priority-tag p${task.priority}`}>{priorityLabel(task.priority)}</span>
            <span className="wb-task-title" title={task.title}>
              {task.title}
            </span>
            <span className="badge subtle">
              {task.status === "completed"
                ? t("workbench.statusCompleted")
                : t("workbench.statusPending")}
            </span>
          </div>
          <div className="wb-task-meta">
            {task.due_at && (
              <span
                className={`wb-meta-item${task.status === "pending" && isTaskOverdue(task.due_at) ? " is-overdue" : ""}`}
              >
                {formatDue(task.due_at)}
              </span>
            )}
            {task.category && <span className="wb-meta-item">{task.category}</span>}
            {task.updated_at && (
              <span className="wb-meta-item">
                {t("workbench.updatedAt", { time: formatRelative(task.updated_at) })}
              </span>
            )}
            {link?.label && (
              <span
                className="wb-meta-item wb-meta-scene"
                title={t("workbench.sceneLinked", { name: link.label })}
              >
                {t("workbench.sceneLinked", { name: link.label })}
              </span>
            )}
          </div>

          {/* 下一步动作：继续工作按「现场 → 关联会话 → 上下文」给出真实可执行的一步 */}
          <div className="wb-actions">
            <button
              type="button"
              className="btn primary"
              disabled={restoringAny}
              data-tip={
                latest
                  ? `${t("workbench.restoreLatest")}：${latest.name}`
                  : linkedAgent
                    ? t("workbench.resumeSession", {
                        name: linkedAgent.title || linkedAgent.session_external_id,
                      })
                    : t("workbench.openContext")
              }
              onClick={() => {
                if (latest) void onRestore(latest);
                else if (linkedAgent)
                  void jumpToSession(linkedAgent.source_id, linkedAgent.session_external_id);
                else openContext(task);
              }}
            >
              {latest && latestRestore?.phase === "running"
                ? t("workbench.restoreRunning")
                : t("workbench.continueWork")}
            </button>
            <button type="button" className="btn sm" onClick={() => openContext(task)}>
              <Layers size={12} aria-hidden="true" /> {t("workbench.openContext")}
            </button>
            <button type="button" className="btn sm" onClick={() => setTabSafe("agents")}>
              <AgentIcon size={12} /> {t("workbench.viewAgents")}
            </button>
            <button type="button" className="btn sm" onClick={() => openEditor(task)}>
              <Pencil size={12} aria-hidden="true" /> {t("workbench.editTask")}
            </button>
            {task.status === "pending" && (
              <button
                type="button"
                className={`btn sm${confirmDone ? " danger" : ""}`}
                disabled={busy}
                onClick={() => void onMarkComplete()}
                data-tip={
                  confirmDone
                    ? t("workbench.markCompleteTip")
                    : t("workbench.completeTask")
                }
              >
                {confirmDone ? <Check size={12} aria-hidden="true" /> : null}
                {confirmDone ? t("workbench.markCompleteConfirm") : t("workbench.completeTask")}
              </button>
            )}
          </div>

          {/* 关联摘要：Agent 会话 + 工作现场（复用 task_context 聚合，不二次查询） */}
          <div className="wb-links">
            <div className="wb-links-col">
              <div className="wb-links-title">
                <AgentIcon size={12} />
                {t("workbench.linkedAgents")}
                <em className="badge subtle">{ctx?.agents.length ?? 0}</em>
              </div>
              {(ctx?.agents.length ?? 0) === 0 && (
                <div className="endpoint-hint">{t("workbench.noLinkedAgents")}</div>
              )}
              {ctx?.agents.map((a) => (
                <div className="wb-row" key={`${a.source_id}:${a.session_external_id}`}>
                  <span
                    className={`agent-dot state-${a.state}`}
                    title={AGENT_STATE_LABELS[a.state] ?? a.state}
                  />
                  <span className="wb-row-main" title={a.title || a.session_external_id}>
                    {a.title || a.session_external_id}
                  </span>
                  <span className="wb-row-meta">
                    {AGENT_STATE_LABELS[a.state] ?? a.state}
                    {a.last_seen_at ? ` · ${formatRelative(a.last_seen_at)}` : ""}
                  </span>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => void jumpToSession(a.source_id, a.session_external_id)}
                  >
                    {t("workbench.openSession")}
                  </button>
                </div>
              ))}
            </div>
            <div className="wb-links-col">
              <div className="wb-links-title">
                <Save size={12} aria-hidden="true" />
                {t("workbench.snapshots")}
                <em className="badge subtle">{snaps.length}</em>
              </div>
              {snaps.length === 0 && (
                <div className="endpoint-hint">{t("workbench.noSnapshots")}</div>
              )}
              {snaps.slice(0, 3).map((s) => (
                <div className="wb-row" key={s.id}>
                  <span className="wb-row-main" title={s.name}>
                    {s.name}
                  </span>
                  <span className="wb-row-meta">
                    {t("workbench.snapshotItems", { count: s.item_count })}
                    {s.last_restored_at
                      ? ` · ${t("workbench.restore")} ${formatRelative(s.last_restored_at)}`
                      : ""}
                  </span>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={restoringAny}
                    onClick={() => void onRestore(s)}
                  >
                    {restores[s.id]?.phase === "running"
                      ? t("workbench.restoreRunning")
                      : t("workbench.restore")}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** 空态：从最近待办里一键设为当前（显式选择，不自动推断）。 */
function CurrentTaskEmpty({ onPick }: { onPick: (id: string) => void }) {
  const { t } = useLocale();
  const setTab = useUiStore((s) => s.setTab);
  const [recent, setRecent] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listTasks({ view: "all", status: "pending", sort: "created", limit: 5 })
      .then((rows) => {
        if (alive) setRecent(rows);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="wb-empty">
      <p className="wb-empty-title">{t("workbench.currentTaskEmpty")}</p>
      <p className="endpoint-hint">{t("workbench.currentTaskEmptyHint")}</p>
      {error && (
        <div className="wb-error-row" role="alert">
          <span>{t("workbench.loadFailed", { error })}</span>
          <button type="button" className="btn sm" onClick={() => setTab("tasks")}>
            {t("workbench.goTasks")}
          </button>
        </div>
      )}
      {!error && recent && recent.length > 0 && (
        <div className="wb-pick-list">
          {recent.map((task) => (
            <div className="wb-row" key={task.id}>
              <span className={`priority-tag p${task.priority}`}>{priorityLabel(task.priority)}</span>
              <span className="wb-row-main" title={task.title}>
                {task.title}
              </span>
              <button type="button" className="btn sm" onClick={() => onPick(task.id)}>
                {t("workbench.setAsCurrent")}
              </button>
            </div>
          ))}
        </div>
      )}
      {!error && recent !== null && recent.length === 0 && (
        <div className="endpoint-hint">{t("workbench.recentEmpty")}</div>
      )}
      <button type="button" className="btn sm wb-empty-more" onClick={() => setTab("tasks")}>
        {t("workbench.goTasks")}
        <ChevronRight size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

/* ══ B. Agent 运行 ════════════════════════════════════════════════ */

function AgentSummarySection() {
  const { t } = useLocale();
  const snapshot = useAgentsStore((s) => s.snapshot);
  const loadAgents = useAgentsStore((s) => s.load);

  useEffect(() => {
    if (!snapshot) void loadAgents();
  }, [snapshot, loadAgents]);

  const now = Date.now();
  const summary = liveSummary(snapshot, now);
  // 「最近完成」= 实时快照窗口内的已完成轮次（快照有界；完整历史在 Agent 页历史分区）
  const recentCompleted = snapshot?.runs.filter((r) => r.status === "completed").length ?? 0;

  // 等待与失败优先，其次运行中；同类内按最近更新倒序
  const attentionRuns = useMemo(() => {
    const runs = snapshot?.runs ?? [];
    const bySession = new Map((snapshot?.sessions ?? []).map((s) => [s.id, s]));
    const pick = (status: string) =>
      runs
        .filter((r) => r.status === status)
        .map((r) => ({ run: r, session: bySession.get(r.session_id) ?? null }));
    return [...pick("waiting"), ...pick("failed"), ...pick("running")].sort((a, b) =>
      (b.run.updated_at ?? "").localeCompare(a.run.updated_at ?? ""),
    );
  }, [snapshot]);

  const chips: { label: string; count: number; tone: string }[] = [
    { label: t("workbench.stateWaiting"), count: summary.waiting, tone: "waiting" },
    { label: t("workbench.stateFailed"), count: summary.failed, tone: "failed" },
    { label: t("workbench.stateRunning"), count: summary.running, tone: "running" },
    { label: t("workbench.stateDisconnected"), count: summary.disconnected, tone: "disconnected" },
    { label: t("workbench.stateCompleted"), count: recentCompleted, tone: "idle" },
  ];

  return (
    <section className="wb-card" aria-label={t("workbench.agentSummary")}>
      <div className="wb-section-head">
        <h3 className="wb-section-title">
          <AgentIcon size={13} /> {t("workbench.agentSummary")}
        </h3>
        <span className="flex-spacer" />
        <button type="button" className="btn sm" onClick={() => setTabSafe("agents")}>
          {t("workbench.viewAllAgents")}
        </button>
      </div>
      <div className="wb-chips" role="list">
        {chips.map((c) => (
          <span key={c.label} className={`wb-chip tone-${c.tone}`} role="listitem">
            {/* 未加载显示中性占位，不把未知伪装成 0 */}
            <em>{snapshot ? c.count : "–"}</em>
            {c.label}
          </span>
        ))}
      </div>
      {/* 证据边界：已安装 / 已接入 / 正在运行是三个维度，页面只统计真实事件 */}
      <p className="endpoint-hint wb-evidence">{t("workbench.agentEvidence")}</p>
      {!snapshot && (
        <div className="empty-hint" role="status">
          {t("nav.loading")}
        </div>
      )}
      {snapshot && attentionRuns.length === 0 && (
        <div className="endpoint-hint">{t("workbench.agentIdle")}</div>
      )}
      {attentionRuns.slice(0, 5).map(({ run, session }) => (
        <div className="wb-row" key={run.id}>
          <span
            className={`agent-dot state-${run.status}`}
            title={AGENT_STATE_LABELS[run.status] ?? run.status}
          />
          <span className="wb-row-main" title={run.task_title || session?.title || ""}>
            {run.task_title || session?.title || session?.external_id || run.id}
          </span>
          <span className="wb-row-meta">{formatRelative(run.updated_at)}</span>
          {session ? (
            <button
              type="button"
              className="btn sm"
              onClick={() => void jumpToSession(run.source_id, session.external_id)}
            >
              {t("workbench.openSession")}
            </button>
          ) : (
            <span className="endpoint-hint">{t("workbench.sessionNotInSnapshot")}</span>
          )}
        </div>
      ))}
    </section>
  );
}

/* ══ C. 需要处理 ══════════════════════════════════════════════════ */

function AttentionSection({ currentId }: { currentId: string | null }) {
  const { t } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  const setTab = useUiStore((s) => s.setTab);
  const openContext = useUiStore((s) => s.openContext);
  const loadAgents = useAgentsStore((s) => s.load);
  // 事件驱动的计数刷新由 App 层调度（工作台已在消费者门控内）；
  // 本地列表在 lastLoadedAt 变化后按同一节拍重取 intervention + 提醒，不重复订阅事件。
  const lastLoadedAt = useActionsStore((s) => s.lastLoadedAt);
  const countsIntervention = useActionsStore((s) => s.feed?.counts.intervention ?? null);
  const [items, setItems] = useState<ActionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 提醒读取失败只降级提醒部分，不影响 intervention 主列表。 */
  const [remindersFailed, setRemindersFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const intervention = actionsFeed({
      category: "intervention",
      include_acked: false,
      limit: TODO_LIMIT,
    });
    // 重要提醒：有当前任务时只取该任务的未读提醒（可靠关系），否则取最近的全局未读提醒。
    // 与 intervention 同一数据源（notification_history），不建第二套通知表。
    const reminders = actionsFeed({
      category: "notification",
      kind: "reminder",
      limit: currentId ? 3 : 2,
      ...(currentId ? { task_id: currentId } : {}),
    });
    Promise.allSettled([intervention, reminders]).then(([a, b]) => {
      if (!alive) return;
      if (a.status === "fulfilled") {
        const reminderItems = b.status === "fulfilled" ? b.value.items : [];
        setItems([...a.value.items, ...reminderItems]);
        setError(null);
      } else {
        // intervention 失败时不展示只有提醒的残缺列表，避免误以为没有待处理
        setItems(null);
        setError(errorMessage(a.reason));
      }
      setRemindersFailed(b.status === "rejected");
    });
    return () => {
      alive = false;
    };
    // lastLoadedAt 变化（事件刷新/确认操作）后重取；挂载时也执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastLoadedAt, currentId]);

  const onOpen = async (item: ActionItem) => {
    if (item.kind === "reminder") {
      if (!item.task_id) {
        setTab("tasks");
        return;
      }
      try {
        const task = await fetchTask(item.task_id);
        openContext(task);
      } catch (e) {
        showToast(t("workbench.jumpFailed", { error: errorMessage(e) }), { kind: "error" });
        setTab("tasks");
      }
      return;
    }
    if (!item.source_id || !item.session_external_id) return;
    try {
      const r = await actionsOpenSession(item.source_id, item.session_external_id);
      showToast(
        r.success
          ? t("workbench.sessionLocatedSource", {
              source: item.source_name,
              level: verificationLabel(r.verification_level),
            })
          : (r.reason ?? t("workbench.jumpUnfinished")),
        { kind: r.success ? "success" : "error" },
      );
      if (r.success) void loadAgents();
    } catch (e) {
      showToast(t("workbench.jumpFailed", { error: errorMessage(e) }), { kind: "error" });
    }
  };

  const kindText = (kind: ActionItem["kind"]): string => {
    switch (kind) {
      case "failed":
        return t("workbench.kindFailed");
      case "authorization":
        return t("workbench.kindAuthorization");
      case "waiting_input":
        return t("workbench.kindWaitingInput");
      case "reminder":
        return t("workbench.kindReminder");
      default:
        return actionKindLabel(kind);
    }
  };

  return (
    <section className="wb-card" aria-label={t("workbench.todo")}>
      <div className="wb-section-head">
        <h3 className="wb-section-title">
          <CircleAlert size={13} aria-hidden="true" /> {t("workbench.todo")}
          {countsIntervention !== null && countsIntervention > 0 && (
            <em className="badge subtle">{countsIntervention}</em>
          )}
        </h3>
        <span className="flex-spacer" />
        <button type="button" className="btn sm" onClick={() => setTab("actions")}>
          {t("workbench.todoAll")}
        </button>
      </div>
      {error && items === null && (
        <div className="wb-error-row" role="alert">
          <span>{t("workbench.loadFailed", { error })}</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => void useActionsStore.getState().load()}
          >
            {t("workbench.retry")}
          </button>
        </div>
      )}
      {!error && items === null && (
        <div className="empty-hint" role="status">
          {t("nav.loading")}
        </div>
      )}
      {items !== null && items.length === 0 && (
        <div className="endpoint-hint">{t("workbench.todoEmpty")}</div>
      )}
      {remindersFailed && items !== null && (
        <div className="endpoint-hint">{t("workbench.remindersUnavailable")}</div>
      )}
      {items?.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`wb-row wb-row-btn p${item.priority}`}
          onClick={() => void onOpen(item)}
          title={item.kind === "reminder" ? t("workbench.openTask") : t("workbench.jumpSession")}
        >
          <span className={`action-kind k-${item.kind}`}>{kindText(item.kind)}</span>
          <span className="wb-row-main">
            <span className="wb-row-title">{item.title}</span>
            {item.message && <span className="wb-row-sub">{item.message}</span>}
          </span>
          {item.task_id && item.task_id === currentId && (
            <span className="badge subtle">{t("workbench.currentTaskBadge")}</span>
          )}
          <span className="wb-row-meta">{formatRelative(item.occurred_at)}</span>
        </button>
      ))}
    </section>
  );
}

/* ══ D. 快速继续 ══════════════════════════════════════════════════ */

function RecentSection({
  excludeId,
  restores,
  onRestore,
  refreshTick,
}: {
  excludeId: string | null;
  restores: Record<string, RestoreState>;
  onRestore: (snap: SnapshotSummary) => Promise<void>;
  refreshTick: number;
}) {
  const { t } = useLocale();
  const openContext = useUiStore((s) => s.openContext);
  // 任务统计随 task 事件刷新；以其为节拍重读最近待办，不新增订阅
  const statsTick = useTasksStore((s) => s.stats);
  const [recent, setRecent] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snapsByTask, setSnapsByTask] = useState<Record<string, RecentSnapshots>>({});
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    listTasks({ view: "all", status: "pending", sort: "created", limit: RECENT_LIMIT })
      .then((rows) => {
        if (seq !== seqRef.current) return;
        setRecent(rows);
        setError(null);
      })
      .catch((e) => {
        if (seq !== seqRef.current) return;
        setError(errorMessage(e));
      });
  }, [refreshTick, statsTick]);

  // 恢复/现场变化后强制重读现场摘要（先清缓存，避免「已加载」守卫挡住刷新）
  useEffect(() => {
    if (refreshTick > 0) setSnapsByTask({});
  }, [refreshTick]);

  // 逐任务读取现场摘要（任务数有界 ≤ RECENT_LIMIT；无轮询）
  useEffect(() => {
    if (!recent) return;
    let alive = true;
    for (const task of recent) {
      const cur = snapsByTask[task.id];
      if (cur && (cur.state === "loading" || cur.state === "ok")) continue;
      setSnapsByTask((m) => ({ ...m, [task.id]: { state: "loading", snaps: [] } }));
      workspaceList(task.id)
        .then((snaps) => {
          if (alive) setSnapsByTask((m) => ({ ...m, [task.id]: { state: "ok", snaps } }));
        })
        .catch(() => {
          if (alive) setSnapsByTask((m) => ({ ...m, [task.id]: { state: "error", snaps: [] } }));
        });
    }
    return () => {
      alive = false;
    };
    // snapsByTask 只作已加载判断（读快照引用）；刷新由 refreshTick 显式触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent]);

  return (
    <section className="wb-card" aria-label={t("workbench.recent")}>
      <div className="wb-section-head">
        <h3 className="wb-section-title">
          <ListTodo size={13} aria-hidden="true" /> {t("workbench.recent")}
        </h3>
        <span className="flex-spacer" />
        <button type="button" className="btn sm" onClick={() => setTabSafe("tasks")}>
          {t("workbench.goTasks")}
        </button>
      </div>
      {error && recent === null && (
        <div className="wb-error-row" role="alert">
          <span>{t("workbench.loadFailed", { error })}</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => void useTasksStore.getState().loadStats()}
          >
            {t("workbench.retry")}
          </button>
        </div>
      )}
      {!error && recent === null && (
        <div className="empty-hint" role="status">
          {t("nav.loading")}
        </div>
      )}
      {recent !== null && recent.filter((task) => task.id !== excludeId).length === 0 && (
        <div className="endpoint-hint">{t("workbench.recentEmpty")}</div>
      )}
      {recent
        ?.filter((task) => task.id !== excludeId)
        .slice(0, RECENT_LIMIT)
        .map((task) => {
          const snapState = snapsByTask[task.id];
          const latest = snapState?.state === "ok" ? latestSnapshot(snapState.snaps) : null;
          const restoreState = latest ? restores[latest.id] : undefined;
          return (
            <div className="wb-recent-row" key={task.id}>
              <span className={`priority-tag p${task.priority}`}>{priorityLabel(task.priority)}</span>
              <span className="wb-row-main">
                <span className="wb-row-title" title={task.title}>
                  {task.title}
                </span>
                <span className="wb-row-sub">
                  {/* 未加载完成前不显示现场结论，避免把「未知」说成「无现场」 */}
                  {snapState === undefined || snapState.state === "loading"
                    ? ""
                    : snapState.state === "error"
                      ? t("workbench.snapshotUnknown")
                      : latest
                        ? t("workbench.snapshotCount", { count: snapState.snaps.length })
                        : t("workbench.noSnapshot")}
                  {task.due_at ? ` · ${formatDue(task.due_at)}` : ""}
                </span>
              </span>
              {latest ? (
                <button
                  type="button"
                  className="btn sm"
                  disabled={restoreState?.phase === "running"}
                  onClick={() => void onRestore(latest)}
                >
                  {restoreState?.phase === "running" ? t("workbench.restoreRunning") : t("workbench.restore")}
                </button>
              ) : (
                <button type="button" className="btn sm" onClick={() => openContext(task)}>
                  {t("workbench.openContext")}
                </button>
              )}
              <button
                type="button"
                className="icon-btn sm"
                aria-label={t("workbench.openContextAria", { title: task.title })}
                data-tip={t("workbench.openContext")}
                onClick={() => openContext(task)}
              >
                <ChevronRight size={13} aria-hidden="true" />
              </button>
            </div>
          );
        })}
    </section>
  );
}

/* ── 共用小工具 ──────────────────────────────────────────────────── */

/** 定位 Agent 会话：与行动中心/任务抽屉同一命令，成功后刷新快照。 */
async function jumpToSession(sourceId: string, sessionId: string): Promise<void> {
  const { showToast } = useUiStore.getState();
  try {
    const r = await actionsOpenSession(sourceId, sessionId);
    showToast(
      r.success
        ? translate("workbench.sessionLocated", { level: verificationLabel(r.verification_level) })
        : (r.reason ?? translate("workbench.jumpUnfinished")),
      { kind: r.success ? "success" : "error" },
    );
    if (r.success) void useAgentsStore.getState().load();
  } catch (e) {
    showToast(translate("workbench.jumpFailed", { error: errorMessage(e) }), { kind: "error" });
  }
}

/** 区域头「全部」跳转：走 setTab 门禁（草稿/保存中被拦截时由确认条处理）。 */
function setTabSafe(tab: "agents" | "tasks"): void {
  void useUiStore.getState().setTab(tab);
}

function isTaskOverdue(dueAt: string): boolean {
  const ts = Date.parse(dueAt);
  return Number.isFinite(ts) && ts < Date.now();
}
