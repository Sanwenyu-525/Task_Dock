//! 历史面板：通知 + Agent 事件统一时间轴。
//! 按日分组、连续重复（失联/重连等）聚合、来源/类型/时间过滤、
//! 点击展开详情、通知点击标已读、清空需二次确认；
//! 订阅 notification / agent-changed 事件实时刷新。
//!
//! 分页与筛选全部在数据库完成：通知与事件各自 keyset 翻页，`has_more` 与
//! `filtered_total` 使用同一筛选口径；未读数来自全库统计，不受首页 100 条限制。
//! 后台刷新只合并在时间上连续的页；若新数据与已加载旧页之间出现空隙，则保留
//! 旧页并提示刷新，绝不把有缺口的列表伪装成完整时间轴。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Bot, CheckCheck, Trash2, ChevronRight, ChevronDown, Inbox } from "lucide-react";
import {
  clearNotifications,
  listAgentEvents,
  markAllNotificationsRead,
  markNotificationRead,
  notificationInboxStats,
  notificationPage,
  onAgentChanged,
  onNotification,
  type AgentEventPage,
  type AgentEventRow,
  type NotificationPage,
  type NotificationRow,
} from "../../lib/bridge";
import { useUiStore } from "../../store/useUiStore";
import { useAgentsStore } from "../../store/useAgentsStore";
import { createSubscriptionScope } from "../../lib/subscriptions";
import { Select } from "../ui";
import { NOTIFICATION_KIND_LABELS, AGENT_STATE_LABELS, formatRelative } from "../../lib/format";
import { groupHistory } from "../../lib/historyGroup";

type KindFilter = "all" | "notification" | "event";
type TimeFilter = "today" | "3d" | "7d" | "all";

const TIME_FILTERS: { id: TimeFilter; label: string }[] = [
  { id: "today", label: "今天" },
  { id: "3d", label: "近 3 天" },
  { id: "7d", label: "近 7 天" },
  { id: "all", label: "全部" },
];

const DAY = 86400000;
const PAGE = 100;

function sinceIso(filter: TimeFilter): string | undefined {
  if (filter === "all") return undefined;
  const now = new Date();
  if (filter === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  }
  return new Date(now.getTime() - (filter === "3d" ? 3 : 7) * DAY).toISOString();
}

function sortEvents(rows: AgentEventRow[]): AgentEventRow[] {
  return [...rows].sort((a, b) =>
    a.received_at === b.received_at
      ? a.id < b.id
        ? 1
        : -1
      : a.received_at < b.received_at
        ? 1
        : -1,
  );
}

function sortNotifications(rows: NotificationRow[]): NotificationRow[] {
  return [...rows].sort((a, b) =>
    a.created_at === b.created_at
      ? a.id < b.id
        ? 1
        : -1
      : a.created_at < b.created_at
        ? 1
        : -1,
  );
}

/** 合并已加载页与新到的首页，返回是否出现无法自动衔接的空隙。 */
function mergeRefresh<T extends { id: string }>(
  prev: T[],
  next: T[],
  sort: (rows: T[]) => T[],
): { items: T[]; gap: boolean } {
  if (prev.length === 0) return { items: next, gap: false };
  if (next.length === 0) return { items: [], gap: false };
  const prevIds = new Set(prev.map((r) => r.id));
  if (!next.some((r) => prevIds.has(r.id))) {
    // 首页与已加载页不重叠：旧页与最新页之间可能有未加载记录。
    // 保留旧页并提示刷新，避免显示一个缺少中间记录的时间轴。
    return { items: prev, gap: true };
  }
  const map = new Map<string, T>();
  for (const r of prev) map.set(r.id, r);
  for (const r of next) map.set(r.id, r);
  return { items: sort([...map.values()]), gap: false };
}

export default function HistoryPanel() {
  const showToast = useUiStore((s) => s.showToast);
  const agentSnapshot = useAgentsStore((s) => s.snapshot);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [events, setEvents] = useState<AgentEventRow[]>([]);
  const [notificationsHasMore, setNotificationsHasMore] = useState(false);
  const [eventsHasMore, setEventsHasMore] = useState(false);
  const [notificationsTotal, setNotificationsTotal] = useState(0);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [unread, setUnread] = useState(0);
  const [inboxTotal, setInboxTotal] = useState(0);
  const [hasNew, setHasNew] = useState(false);
  const [loadingMore, setLoadingMore] = useState<"events" | "notifications" | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const queryKey = `${sourceFilter}\u0000${timeFilter}`;
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;
  const notificationsRef = useRef(notifications);
  notificationsRef.current = notifications;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const queryOpts = useMemo(
    () => ({
      sourceId: sourceFilter === "all" ? undefined : sourceFilter,
      since: sinceIso(timeFilter),
    }),
    [sourceFilter, timeFilter],
  );

  const applyFirstPages = useCallback((np: NotificationPage, ep: AgentEventPage) => {
    setNotifications(np.items);
    setNotificationsHasMore(np.has_more);
    setNotificationsTotal(np.filtered_total);
    setEvents(ep.items);
    setEventsHasMore(ep.has_more);
    setEventsTotal(ep.filtered_total);
    setHasNew(false);
  }, []);

  const refresh = useCallback(
    async (mode: "replace" | "merge") => {
      const key = queryKeyRef.current;
      try {
        const [np, ep, stats] = await Promise.all([
          notificationPage({ ...queryOpts, limit: PAGE }),
          listAgentEvents(PAGE, queryOpts),
          notificationInboxStats(),
        ]);
        if (queryKeyRef.current !== key) return; // 筛选已变化，丢弃旧响应
        setUnread(stats.unread);
        setInboxTotal(stats.total);
        setNotificationsTotal(np.filtered_total);
        setEventsTotal(ep.filtered_total);
        if (mode === "replace") {
          applyFirstPages(np, ep);
        } else {
          const n = mergeRefresh(notificationsRef.current, np.items, sortNotifications);
          const e = mergeRefresh(eventsRef.current, ep.items, sortEvents);
          setNotifications(n.items);
          setEvents(e.items);
          // 合并刷新同样要推进分页状态：否则首屏为空后到达的新事件会让
          // 「加载更早」永远不出现（has_more 停在挂载时的值）。
          setNotificationsHasMore(n.items.length < np.filtered_total);
          setEventsHasMore(e.items.length < ep.filtered_total);
          if (n.gap || e.gap) setHasNew(true);
        }
        setLoaded(true);
      } catch (err) {
        showToast(`加载历史失败：${String(err)}`, { kind: "error" });
      }
    },
    [applyFirstPages, queryOpts, showToast],
  );

  // 时间/来源筛选变化：两个列表一起按新口径重置（分页游标随之失效）。
  useEffect(() => {
    setLoaded(false);
    setNotifications([]);
    setEvents([]);
    setHasNew(false);
    void refresh("replace");
    // refresh 已包含筛选与当前列表；此处只在筛选变化时重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  // 新通知 / Agent 事件到达 → 合并刷新（500ms 窗口，避免事件风暴下反复拉取全量历史）
  useEffect(() => {
    const scope = createSubscriptionScope();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        void refresh("merge");
      }, 500);
    };
    scope.add(onNotification(() => bump()));
    scope.add(onAgentChanged((payload) => {
      if (payload?.changed === false) return;
      bump();
    }));
    return () => {
      if (timer) clearTimeout(timer);
      scope.dispose();
    };
  }, [refresh]);

  const sourceOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of agentSnapshot?.sources ?? []) map.set(s.id, s.display_name);
    for (const [kind, label] of Object.entries(NOTIFICATION_KIND_LABELS)) {
      map.set(kind, `通知 · ${label}`);
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], "zh-CN"));
  }, [agentSnapshot]);

  const groups = useMemo(() => {
    let g = groupHistory(notifications, events);
    if (kindFilter !== "all") {
      g = g
        .map((day) => ({
          ...day,
          entries: day.entries.filter((e) => e.kind === kindFilter),
        }))
        .filter((day) => day.entries.length > 0);
    }
    return g;
  }, [notifications, events, kindFilter]);

  const total = groups.reduce((acc, g) => acc + g.entries.length, 0);
  const filtering = sourceFilter !== "all" || timeFilter !== "all" || kindFilter !== "all";

  async function onEntryClick(key: string, notification?: NotificationRow) {
    setDetailKey((k) => (k === key ? null : key));
    if (notification && !notification.is_read) {
      try {
        await markNotificationRead(notification.id);
        setNotifications((ns) =>
          ns.map((n) => (n.id === notification.id ? { ...n, is_read: true } : n)),
        );
        setUnread((u) => Math.max(0, u - 1));
      } catch (e) {
        showToast(String(e), { kind: "error" });
      }
    }
  }

  async function onMarkAll() {
    try {
      await markAllNotificationsRead();
      await refresh("replace");
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  async function onClear() {
    if (!confirmClear) {
      setConfirmClear(true);
      window.setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    try {
      await clearNotifications();
      await refresh("replace");
      showToast("通知已清空（Agent 事件流水保留）", { kind: "success" });
    } catch (e) {
      showToast(String(e), { kind: "error" });
    } finally {
      setConfirmClear(false);
    }
  }

  async function onLoadMore(kind: "events" | "notifications") {
    if (loadingMore) return;
    const key = queryKeyRef.current;
    setLoadingMore(kind);
    try {
      if (kind === "events") {
        const cursor = events[events.length - 1]?.id;
        if (!cursor) return;
        const page = await listAgentEvents(PAGE, { ...queryOpts, before: cursor });
        if (queryKeyRef.current !== key) return;
        setEvents((prev) => sortEvents([...prev, ...page.items.filter((p) => !prev.some((x) => x.id === p.id))]));
        setEventsHasMore(page.has_more);
        setEventsTotal(page.filtered_total);
      } else {
        const cursor = notifications[notifications.length - 1]?.id;
        if (!cursor) return;
        const page = await notificationPage({ ...queryOpts, before: cursor, limit: PAGE });
        if (queryKeyRef.current !== key) return;
        setNotifications((prev) =>
          sortNotifications([...prev, ...page.items.filter((p) => !prev.some((x) => x.id === p.id))]),
        );
        setNotificationsHasMore(page.has_more);
        setNotificationsTotal(page.filtered_total);
      }
    } catch (e) {
      showToast(`加载更早记录失败：${String(e)}`, { kind: "error" });
    } finally {
      setLoadingMore(null);
    }
  }

  return (
    <div className="history-panel">
      {/* 过滤工具栏：第一行 = 筛选（时间 → 来源 → 类型，窄窗口时靠后的先换行），
          第二行 = 统计 + 批量操作，两行职责分离互不挤压 */}
      <div className="filter-bar primary">
        <div className="seg-group subtle" role="group" aria-label="时间范围">
          {TIME_FILTERS.map((t) => (
            <button
              key={t.id}
              className={`seg-btn ${timeFilter === t.id ? "active" : ""}`}
              onClick={() => setTimeFilter(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Select
          className="sort-select"
          size="sm"
          ariaLabel="来源筛选"
          value={sourceFilter}
          options={[{ value: "all", label: "全部来源" }, ...sourceOptions.map(([value, label]) => ({ value, label }))]}
          onChange={(v) => setSourceFilter(v)}
        />
        <div className="seg-group subtle" role="group" aria-label="类型">
          {(
            [
              { id: "all", label: "全部" },
              { id: "notification", label: "通知" },
              { id: "event", label: "Agent 事件" },
            ] as const
          ).map((k) => (
            <button
              key={k.id}
              className={`seg-btn ${kindFilter === k.id ? "active" : ""}`}
              onClick={() => setKindFilter(k.id)}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>
      <div className="filter-bar secondary">
        <span className="history-unread-hint">
          {unread} 条未读 / 共 {inboxTotal}
        </span>
        <span className="flex-spacer" />
        <button className="btn sm" onClick={onMarkAll} disabled={unread === 0} title="全部标为已读">
          <CheckCheck size={12} /> 全部已读
        </button>
        <button className={`btn sm ${confirmClear ? "danger" : ""}`} onClick={onClear} title={confirmClear ? "再次点击确认清空" : "清空通知"}>
          <Trash2 size={12} /> {confirmClear ? "确认清空？" : "清空"}
        </button>
      </div>

      {hasNew && (
        <div className="history-new-banner">
          <span>有新记录到达，当前列表与最新数据之间还有未加载的空隙。</span>
          <button className="btn sm" onClick={() => void refresh("replace")}>刷新到最新</button>
        </div>
      )}

      {/* 时间轴 */}
      {!loaded && <div className="empty-hint">加载中…</div>}
      {loaded && total === 0 && (
        <div className="empty-state">
          <div className="empty-icon"><Inbox size={22} /></div>
          <div className="empty-title">{filtering ? "当前筛选下暂无记录" : "暂无历史记录"}</div>
          <div className="empty-hint">
            {filtering
              ? `筛选范围内共 ${eventsTotal} 条 Agent 事件、${notificationsTotal} 条通知；可调整来源/时间/类型。`
              : "任务提醒与 Agent 事件会在这里按日期归档"}
          </div>
        </div>
      )}
      {groups.map((g) => (
        <div key={g.label} className="history-day">
          <div className="history-day-label">{g.label}</div>
          <div className="history-list">
            {g.entries.map((e) => {
              const open = detailKey === e.key;
              return (
                <div
                  key={e.key}
                  className={`history-item kind-${e.kind === "event" ? `event-${e.event?.state}` : e.source} ${e.unread ? "unread" : ""}`}
                  onClick={() => onEntryClick(e.key, e.notification)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(ev) => ev.key === "Enter" && onEntryClick(e.key, e.notification)}
                >
                  <div className="history-head">
                    {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    <span className={`history-kind ${e.kind === "event" ? `ev-${e.event?.state}` : `nk-${e.source}`}`}>
                      {e.kind === "event" ? <Bot size={10} /> : <Bell size={10} />}
                      {e.kind === "event"
                        ? `${e.source} · ${AGENT_STATE_LABELS[e.event?.state ?? ""] ?? e.event?.state}`
                        : NOTIFICATION_KIND_LABELS[e.source] ?? e.source}
                    </span>
                    <span className="history-title">
                      {e.kind === "notification" ? e.notification?.title : e.event?.message || e.event?.session_external_id}
                    </span>
                    {e.count > 1 && <span className="history-count" title={`${e.count} 条连续相同记录`}>×{e.count}</span>}
                    <span className="history-time">{formatRelative(e.iso)}</span>
                  </div>
                  {e.kind === "notification" && e.notification?.body && !open && (
                    <div className="history-body">{e.notification.body}</div>
                  )}
                  {open && (
                    <div className="history-detail">
                      {e.kind === "notification" ? (
                        <>
                          <div className="detail-row"><span>内容</span><code>{e.notification?.body || "（空）"}</code></div>
                          <div className="detail-row"><span>类型</span><code>{e.notification?.kind}</code></div>
                          {e.notification?.ref_type && (
                            <div className="detail-row"><span>关联</span><code>{e.notification.ref_type} · {e.notification.ref_id}</code></div>
                          )}
                          <div className="detail-row"><span>时间</span><code>{e.notification?.created_at}</code></div>
                        </>
                      ) : (
                        <>
                          <div className="detail-row"><span>会话</span><code>{e.event?.session_external_id}</code></div>
                          {e.event?.run_external_id && (
                            <div className="detail-row"><span>轮次</span><code>{e.event.run_external_id}</code></div>
                          )}
                          <div className="detail-row"><span>状态</span><code>{e.event?.state}</code></div>
                          {e.event?.transport && (
                            <div className="detail-row"><span>通道</span><code>{e.event.transport}{e.event.evidence_type ? ` · ${e.event.evidence_type}` : ""}</code></div>
                          )}
                          {e.event?.occurred_at && (
                            <div className="detail-row"><span>发生时间</span><code>{e.event.occurred_at}</code></div>
                          )}
                          <div className="detail-row"><span>接收时间</span><code>{e.event?.received_at}</code></div>
                          {e.collapsedKeys && e.collapsedKeys.length > 0 && (
                            <div className="detail-row"><span>聚合</span><code>与相邻 {e.collapsedKeys.length} 条相同记录合并展示</code></div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {loaded && (eventsHasMore || notificationsHasMore) && (
        <div className="history-more">
          {eventsHasMore && (
            <button
              className="btn sm"
              onClick={() => void onLoadMore("events")}
              disabled={loadingMore !== null}
            >
              {loadingMore === "events"
                ? "加载中…"
                : `加载更早的 Agent 事件（已加载 ${events.length}/${eventsTotal}）`}
            </button>
          )}
          {notificationsHasMore && (
            <button
              className="btn sm"
              onClick={() => void onLoadMore("notifications")}
              disabled={loadingMore !== null}
            >
              {loadingMore === "notifications"
                ? "加载中…"
                : `加载更早的通知（已加载 ${notifications.length}/${notificationsTotal}）`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
