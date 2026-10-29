//! Agent 行动中心：把散落事件聚合成可处理的动作。
//!
//! - 「行动」子视图：优先级排序的待处理动作、去重合并计数、批量确认、跳回会话；
//! - 「历史」子视图：复用既有 HistoryPanel（通知 + 原始事件流水）；
//! - 监控覆盖度单独展示：未接入/未验证的来源明确说明，绝不显示成「监控中」。

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Bot,
  Check,
  ChevronDown,
  Layers,
  RefreshCw,
  ShieldQuestion,
  Inbox,
  Undo2,
} from "lucide-react";
import HistoryPanel from "../history/HistoryPanel";
import { useActionsStore, attentionCount, kindLabel } from "../../store/useActionsStore";
import { useUiStore } from "../../store/useUiStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { taskContext, type ActionItem, type ActionKind } from "../../lib/bridge";
import { formatRelative } from "../../lib/format";

const KIND_FILTERS: { id: ActionKind | "all"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "failed", label: "失败" },
  { id: "authorization", label: "授权" },
  { id: "waiting_input", label: "等待" },
  { id: "running", label: "运行" },
  { id: "completed", label: "完成" },
  { id: "reminder", label: "提醒" },
];

const PRIORITY_LABELS = ["P0", "P1", "P2", "P3"];

export default function ActionCenterPanel() {
  const [view, setView] = useState<"actions" | "history">("actions");
  const [coverageOpen, setCoverageOpen] = useState(false);
  const feed = useActionsStore((s) => s.feed);
  const loading = useActionsStore((s) => s.loading);
  const error = useActionsStore((s) => s.error);
  const filter = useActionsStore((s) => s.filter);
  const load = useActionsStore((s) => s.load);
  const setFilter = useActionsStore((s) => s.setFilter);
  const ack = useActionsStore((s) => s.ack);
  const unack = useActionsStore((s) => s.unack);
  const openSession = useActionsStore((s) => s.openSession);
  const showToast = useUiStore((s) => s.showToast);
  const setTab = useUiStore((s) => s.setTab);
  const refreshAgents = useAgentsStore((s) => s.load);
  const openContext = useUiStore((s) => s.openContext);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (view !== "actions") return;
    if (!feed) void load();
  }, [view, feed, load]);

  const attention = attentionCount(feed);
  const coverageIssues = useMemo(
    () => (feed?.coverage ?? []).filter((c) => c.level !== "live"),
    [feed],
  );
  const activeCount = (feed?.coverage ?? []).filter((c) => c.level === "live").length;
  const taskOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const it of feed?.items ?? []) {
      if (it.task_id && it.task_title) map.set(it.task_id, it.task_title);
    }
    return [...map.entries()].map(([id, title]) => ({ id, title }));
  }, [feed]);

  async function onAck(item: ActionItem) {
    if (busy) return;
    setBusy(item.id);
    try {
      if (item.acked) {
        await unack(item.event_ids);
        showToast("已恢复为待处理", { kind: "info" });
      } else {
        await ack(item.event_ids);
      }
    } catch (e) {
      showToast(`确认失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onOpen(item: ActionItem) {
    if (item.kind === "reminder") {
      setTab("tasks");
      return;
    }
    if (!item.source_id || !item.session_external_id) return;
    setBusy(item.id);
    try {
      const r = await openSession(item.source_id, item.session_external_id);
      showToast(
        r.success
          ? `已定位 ${item.source_name} 会话（${r.verification_level}）`
          : r.reason ?? "跳转未完成",
        { kind: r.success ? "success" : "error" },
      );
      if (r.success) void refreshAgents();
    } catch (e) {
      showToast(`跳转失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function onOpenTaskContext(item: ActionItem) {
    if (!item.task_id) return;
    setBusy(item.id);
    try {
      const ctx = await taskContext(item.task_id);
      openContext(ctx.task);
    } catch (e) {
      showToast(`打开任务上下文失败：${String(e)}`, { kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="action-panel">
      <div className="filter-bar primary">
        <div className="seg-group subtle" role="group" aria-label="视图">
          <button
            className={`seg-btn ${view === "actions" ? "active" : ""}`}
            onClick={() => setView("actions")}
          >
            行动
            {attention > 0 && <em className="badge">{attention}</em>}
          </button>
          <button
            className={`seg-btn ${view === "history" ? "active" : ""}`}
            onClick={() => setView("history")}
          >
            历史
          </button>
        </div>
        <span className="flex-spacer" />
        {view === "actions" && (
          <button className="btn sm" onClick={() => load()} title="重新聚合动作">
            <RefreshCw size={12} /> 刷新
          </button>
        )}
      </div>

      {view === "history" && <HistoryPanel />}

      {view === "actions" && (
        <>
          <div className="filter-bar secondary">
            <div className="seg-group subtle action-kind-filter" role="group" aria-label="类型筛选">
              {KIND_FILTERS.map((k) => (
                <button
                  key={k.id}
                  className={`seg-btn ${(filter.kind ?? "all") === k.id ? "active" : ""}`}
                  onClick={() => setFilter({ kind: k.id === "all" ? undefined : k.id })}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <span className="flex-spacer" />
            <select
              className="sort-select"
              aria-label="优先级筛选"
              value={filter.priority ?? ""}
              onChange={(e) =>
                setFilter({ priority: e.target.value === "" ? undefined : Number(e.target.value) })
              }
            >
              <option value="">全部优先级</option>
              {PRIORITY_LABELS.map((label, p) => (
                <option key={label} value={p}>{label}</option>
              ))}
            </select>
          </div>
          <div className="filter-bar secondary">
            <select
              className="sort-select"
              aria-label="来源筛选"
              value={filter.source_id ?? ""}
              onChange={(e) => setFilter({ source_id: e.target.value || undefined })}
            >
              <option value="">全部来源</option>
              {(feed?.coverage ?? []).map((c) => (
                <option key={c.source_id} value={c.source_id}>
                  {c.display_name}
                </option>
              ))}
            </select>
            <select
              className="sort-select"
              aria-label="任务筛选"
              value={filter.task_id ?? ""}
              onChange={(e) => setFilter({ task_id: e.target.value || undefined })}
            >
              <option value="">全部任务</option>
              {taskOptions.map((t) => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
            <span className="flex-spacer" />
            <label className="check-inline">
              <input
                type="checkbox"
                checked={filter.include_acked ?? false}
                onChange={(e) => setFilter({ include_acked: e.target.checked })}
              />
              显示已确认
            </label>
          </div>

          {/* 监控覆盖度：未接入/未验证必须显式说明 */}
          {(feed?.coverage.length ?? 0) > 0 && (
            <div className={`coverage-strip ${coverageIssues.length > 0 ? "warn" : ""}`}>
              <button
                className="coverage-head"
                onClick={() => setCoverageOpen((v) => !v)}
                aria-expanded={coverageOpen}
              >
                {coverageIssues.length > 0 ? (
                  <ShieldQuestion size={13} />
                ) : (
                  <Check size={13} />
                )}
                <span>
                  监控覆盖：{activeCount} 个来源在线
                  {coverageIssues.length > 0 && `，${coverageIssues.length} 个未接入/未验证`}
                </span>
                <ChevronDown size={12} className={coverageOpen ? "rot" : ""} />
              </button>
              {coverageOpen && (
                <div className="coverage-list">
                  {feed?.coverage.map((c) => (
                    <div key={c.source_id} className={`coverage-row level-${c.level}`}>
                      <span className="coverage-name">{c.display_name}</span>
                      <span className="coverage-note">{c.explanation}</span>
                    </div>
                  ))}
                  <div className="coverage-foot">
                    未接入的来源不会产生运行状态；「授权」类型为文本关键词推断，不是权限系统。
                  </div>
                </div>
              )}
            </div>
          )}

          {loading && !feed && <div className="empty-hint">加载中…</div>}
          {error && <div className="empty-hint error-text">加载失败：{error}</div>}
          {feed && feed.items.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon">
                <Inbox size={22} />
              </div>
              <div className="empty-title">没有待处理动作</div>
              <div className="empty-hint">
                失败、等待输入、需授权与未读提醒会出现在这里；Agent 原始流水在「历史」中。
              </div>
            </div>
          )}
          {feed && feed.items.length > 0 && (
            <div className="action-list">
              {feed.items.map((item) => (
                <div
                  key={item.id}
                  className={`action-item p${item.priority} kind-${item.kind} ${item.acked ? "acked" : ""}`}
                >
                  <button
                    className="action-main"
                    onClick={() => onOpen(item)}
                    title={item.kind === "reminder" ? "查看任务" : "跳转到该 Agent 会话"}
                  >
                    <div className="action-head">
                      <span className={`action-prio p${item.priority}`}>
                        {PRIORITY_LABELS[item.priority] ?? "P3"}
                      </span>
                      <span className={`action-kind k-${item.kind}`}>
                        {item.kind === "reminder" ? <Bell size={10} /> : <Bot size={10} />}
                        {kindLabel(item.kind)}
                      </span>
                      {item.count > 1 && (
                        <span className="action-count" title={`合并 ${item.count} 条相同事件`}>
                          ×{item.count}
                        </span>
                      )}
                      <span className="flex-spacer" />
                      <span className="action-time">{formatRelative(item.occurred_at)}</span>
                    </div>
                    <div className="action-title">{item.title}</div>
                    {item.message && <div className="action-msg">{item.message}</div>}
                    <div className="action-meta">
                      <span>{item.source_name}</span>
                      {item.task_title && <span className="action-task">任务：{item.task_title}</span>}
                      {item.authorization_inferred && (
                        <span className="action-inferred">
                          <AlertTriangle size={10} /> 推断
                        </span>
                      )}
                    </div>
                  </button>
                  <div className="action-side">
                    {item.task_id && (
                      <button
                        className="icon-btn sm"
                        onClick={() => void onOpenTaskContext(item)}
                        disabled={busy === item.id}
                        title="任务上下文（现场 / 关联目标）"
                        aria-label="打开任务上下文"
                      >
                        <Layers size={12} />
                      </button>
                    )}
                    <button
                      className={`icon-btn sm action-ack ${item.acked ? "acked" : ""}`}
                      onClick={() => void onAck(item)}
                      disabled={busy === item.id}
                      title={item.acked ? "恢复为待处理" : "标记已处理"}
                      aria-label={item.acked ? "恢复为待处理" : "标记已处理"}
                    >
                      {item.acked ? <Undo2 size={13} /> : <Check size={13} />}
                    </button>
                  </div>
                </div>
              ))}
              {feed.truncated && (
                <div className="empty-hint">已显示前 {feed.items.length} 条，使用筛选缩小范围。</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
