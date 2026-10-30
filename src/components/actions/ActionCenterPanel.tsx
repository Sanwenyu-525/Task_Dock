//! Agent 行动中心：按「需介入 / 通知 / 历史」三层展示。
//!
//! - 需介入：当前轮次停在等待/失败且未确认；授权为关键词推断并明确标注；
//! - 通知：未读任务提醒与已恢复轮次遗留的失败（不与需介入重复计数）；
//! - 历史：最近 30 天真实轮次，只读，不受确认影响；
//! - 计数来自后端全局 SQL，与筛选/分页无关；列表使用 keyset 游标加载更多；
//! - 监控覆盖度单独展示：未接入/未验证的来源明确说明，绝不显示成「监控中」。

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Bot,
  Check,
  ChevronDown,
  Inbox,
  Layers,
  RefreshCw,
  ShieldQuestion,
  Undo2,
} from "lucide-react";
import {
  useActionsStore,
  attentionCount,
  categoryCount,
  kindLabel,
} from "../../store/useActionsStore";
import { useUiStore } from "../../store/useUiStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import {
  taskContext,
  type ActionCategory,
  type ActionItem,
  type ActionKind,
} from "../../lib/bridge";
import { formatRelative } from "../../lib/format";
import { Checkbox, Select } from "../ui";

const KIND_FILTERS: Record<ActionCategory, { id: ActionKind | "all"; label: string }[]> = {
  intervention: [
    { id: "all", label: "全部" },
    { id: "failed", label: "失败" },
    { id: "authorization", label: "授权" },
    { id: "waiting_input", label: "等待" },
  ],
  notification: [
    { id: "all", label: "全部" },
    { id: "failed", label: "重要失败" },
    { id: "reminder", label: "提醒" },
  ],
  history: [
    { id: "all", label: "全部" },
    { id: "failed", label: "失败" },
    { id: "authorization", label: "授权" },
    { id: "waiting_input", label: "等待" },
    { id: "running", label: "运行" },
    { id: "completed", label: "完成" },
    { id: "disconnected", label: "中断" },
  ],
};

const CATEGORY_LABELS: Record<ActionCategory, string> = {
  intervention: "需介入",
  notification: "通知",
  history: "历史",
};

const PRIORITY_LABELS = ["P0", "P1", "P2", "P3"];

function emptyTitle(category: ActionCategory, filteredTotal: number, globalTotal: number): string {
  if (filteredTotal === 0 && globalTotal > 0) return "当前筛选没有匹配项";
  switch (category) {
    case "intervention":
      return "没有需要介入的动作";
    case "notification":
      return "没有未确认通知";
    case "history":
      return "最近 30 天没有历史轮次";
  }
}

function emptyHint(category: ActionCategory, filteredTotal: number, globalTotal: number): string {
  if (filteredTotal === 0 && globalTotal > 0) {
    return `「${CATEGORY_LABELS[category]}」仍有 ${globalTotal} 条，调整来源/任务/类型筛选或清除条件。`;
  }
  switch (category) {
    case "intervention":
      return "失败、等待输入与需授权（关键词推断）的当前轮次会出现在这里；运行中与已完成在「历史」中。";
    case "notification":
      return "未读任务提醒、以及已恢复轮次遗留的失败通知会出现在这里；完成与断连通知只进历史，不占用徽标。";
    case "history":
      return "最近 30 天的真实轮次（运行中 / 已完成 / 历史等待 / 失败 / 断连）会出现在这里；原始事件流水在主导航「历史」。";
  }
}

export default function ActionCenterPanel() {
  const [coverageOpen, setCoverageOpen] = useState(false);
  const feed = useActionsStore((s) => s.feed);
  const loading = useActionsStore((s) => s.loading);
  const loadingMore = useActionsStore((s) => s.loadingMore);
  const error = useActionsStore((s) => s.error);
  const filter = useActionsStore((s) => s.filter);
  const load = useActionsStore((s) => s.load);
  const loadMore = useActionsStore((s) => s.loadMore);
  const setFilter = useActionsStore((s) => s.setFilter);
  const ack = useActionsStore((s) => s.ack);
  const unack = useActionsStore((s) => s.unack);
  const openSession = useActionsStore((s) => s.openSession);
  const showToast = useUiStore((s) => s.showToast);
  const setTab = useUiStore((s) => s.setTab);
  const refreshAgents = useAgentsStore((s) => s.load);
  const openContext = useUiStore((s) => s.openContext);
  const [busy, setBusy] = useState<string | null>(null);

  const category: ActionCategory = filter.category ?? "intervention";
  // 分类切换后、新数据到达前不展示旧分类列表
  const current = feed && feed.category === category ? feed : null;
  const counts = feed?.counts;
  const attention = attentionCount(feed);
  const categoryTotal = categoryCount(feed, category);

  useEffect(() => {
    if (!feed) void load();
  }, [feed, load]);

  const coverageIssues = useMemo(
    () => (feed?.coverage ?? []).filter((c) => c.level !== "live"),
    [feed],
  );
  const activeCount = (feed?.coverage ?? []).filter((c) => c.level === "live").length;
  const taskOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const it of current?.items ?? []) {
      if (it.task_id && it.task_title) map.set(it.task_id, it.task_title);
    }
    return [...map.entries()].map(([id, title]) => ({ id, title }));
  }, [current]);

  function switchCategory(next: ActionCategory) {
    if (next === category) return;
    setFilter({
      category: next,
      kind: undefined,
      priority: undefined,
      include_acked: false,
    });
  }

  function canAck(item: ActionItem): boolean {
    if (item.category !== "history") return true;
    return ["failed", "authorization", "waiting_input"].includes(item.kind);
  }

  async function onAck(item: ActionItem) {
    if (busy) return;
    setBusy(item.id);
    try {
      if (item.acked) {
        await unack([item.id]);
        showToast("已恢复为待处理", { kind: "info" });
      } else {
        await ack([item.id]);
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
        <div className="seg-group subtle" role="group" aria-label="行动分类">
          {(["intervention", "notification", "history"] as ActionCategory[]).map((id) => {
            const badge = categoryCount(feed, id);
            return (
              <button
                key={id}
                className={`seg-btn ${category === id ? "active" : ""}`}
                onClick={() => switchCategory(id)}
                aria-pressed={category === id}
              >
                {CATEGORY_LABELS[id]}
                {id !== "history" && badge > 0 && <em className="badge">{badge}</em>}
              </button>
            );
          })}
        </div>
        <span className="flex-spacer" />
        <button className="btn sm" onClick={() => load()} title="重新聚合动作">
          <RefreshCw size={12} /> 刷新
        </button>
      </div>

      {feed?.enabled === false ? (
        <div className="empty-state">
          <div className="empty-icon">
            <Inbox size={22} />
          </div>
          <div className="empty-title">行动中心已关闭</div>
          <div className="empty-hint">
            Agent 事件仍会照常入库，历史与会话跳转不受影响；可在「设置」中重新开启行动中心以恢复聚合与徽标。
          </div>
        </div>
      ) : (
        <>
          <div className="filter-bar secondary">
            <div className="seg-group subtle action-kind-filter" role="group" aria-label="类型筛选">
              {KIND_FILTERS[category].map((k) => (
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
            {category !== "notification" && (
              <Select
                className="sort-select"
                size="sm"
                ariaLabel="优先级筛选"
                value={filter.priority === undefined ? "" : String(filter.priority)}
                options={[
                  { value: "", label: "全部优先级" },
                  ...PRIORITY_LABELS.map((label, p) => ({ value: String(p), label })),
                ]}
                onChange={(v) =>
                  setFilter({
                    priority: v === "" ? undefined : Number(v),
                  })
                }
              />
            )}
          </div>
          <div className="filter-bar secondary">
            <Select
              className="sort-select"
              size="sm"
              ariaLabel="来源筛选"
              value={filter.source_id ?? ""}
              options={[
                { value: "", label: "全部来源" },
                ...(feed?.coverage ?? []).map((c) => ({ value: c.source_id, label: c.display_name })),
              ]}
              onChange={(v) => setFilter({ source_id: v || undefined })}
            />
            <Select
              className="sort-select"
              size="sm"
              ariaLabel="任务筛选"
              value={filter.task_id ?? ""}
              options={[
                { value: "", label: "全部任务" },
                ...taskOptions.map((t) => ({ value: t.id, label: t.title })),
              ]}
              onChange={(v) => setFilter({ task_id: v || undefined })}
            />
            <span className="flex-spacer" />
            {category === "intervention" && (
              <label className="check-inline">
                <Checkbox
                  checked={filter.include_acked ?? false}
                  ariaLabel="显示已确认"
                  onChange={(v) => setFilter({ include_acked: v })}
                />
                显示已确认
              </label>
            )}
          </div>

          {counts && (
            <div className="action-summary" role="status">
              <span>需关注 {attention}</span>
              <span className="pending">需介入 {counts.intervention}</span>
              <span>通知 {counts.notification}</span>
              <span className="muted">历史 {counts.history}</span>
              {current && <span>当前筛选 {current.filtered_total}</span>}
              {current && <span className="muted">已加载 {current.loaded}</span>}
            </div>
          )}

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

          {error && <div className="empty-hint error-text">加载失败：{error}</div>}
          {!current && !error && <div className="empty-hint">加载中…</div>}
          {current && current.items.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon">
                <Inbox size={22} />
              </div>
              <div className="empty-title">
                {emptyTitle(category, current.filtered_total, categoryTotal)}
              </div>
              <div className="empty-hint">
                {emptyHint(category, current.filtered_total, categoryTotal)}
              </div>
            </div>
          )}
          {current && current.items.length > 0 && (
            <div className="action-list">
              {current.items.map((item) => (
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
                      {item.category === "notification" && (
                        <span className="action-inferred">未确认</span>
                      )}
                      <span className="flex-spacer" />
                      <span className="action-time">{formatRelative(item.occurred_at)}</span>
                    </div>
                    <div className="action-title">{item.title}</div>
                    {item.message && <div className="action-msg">{item.message}</div>}
                    <div className="action-meta">
                      <span>{item.source_name}</span>
                      {item.task_title && (
                        <span className="action-task">任务：{item.task_title}</span>
                      )}
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
                    {canAck(item) && (
                      <button
                        className={`icon-btn sm action-ack ${item.acked ? "acked" : ""}`}
                        onClick={() => void onAck(item)}
                        disabled={busy === item.id}
                        title={item.acked ? "恢复为待处理" : "标记已处理"}
                        aria-label={item.acked ? "恢复为待处理" : "标记已处理"}
                      >
                        {item.acked ? <Undo2 size={13} /> : <Check size={13} />}
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {current.has_more && (
                <div className="action-more">
                  <button
                    className="btn sm"
                    onClick={() => void loadMore()}
                    disabled={loadingMore || loading}
                  >
                    {loadingMore
                      ? "加载中…"
                      : `加载更多（已加载 ${current.loaded}/${current.filtered_total}）`}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
