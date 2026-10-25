//! 历史面板：通知 + Agent 事件统一时间轴。
//! 按日分组、连续重复（失联/重连等）聚合、来源/类型/时间过滤、
//! 点击展开详情、通知点击标已读、清空需二次确认；
//! 订阅 notification / agent-changed 事件实时刷新。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, Bot, CheckCheck, Trash2, ChevronRight, ChevronDown, Inbox } from "lucide-react";
import {
  clearNotifications,
  listAgentEvents,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  onAgentChanged,
  onNotification,
  type AgentEventRow,
  type NotificationRow,
} from "../../lib/bridge";
import { useUiStore } from "../../store/useUiStore";
import { NOTIFICATION_KIND_LABELS, AGENT_STATE_LABELS, formatRelative } from "../../lib/format";
import { filterGroupsByTime, groupHistory } from "../../lib/historyGroup";

type KindFilter = "all" | "notification" | "event";
type TimeFilter = "today" | "3d" | "7d" | "all";

const TIME_FILTERS: { id: TimeFilter; label: string }[] = [
  { id: "today", label: "今天" },
  { id: "3d", label: "近 3 天" },
  { id: "7d", label: "近 7 天" },
  { id: "all", label: "全部" },
];

const DAY = 86400000;

export default function HistoryPanel() {
  const showToast = useUiStore((s) => s.showToast);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [events, setEvents] = useState<AgentEventRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [ns, evs] = await Promise.all([listNotifications(false, 100), listAgentEvents(100)]);
      setNotifications(ns);
      setEvents(evs);
      setLoaded(true);
    } catch (e) {
      showToast(`加载历史失败：${String(e)}`, { kind: "error" });
    }
  }, [showToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 新通知 / Agent 事件到达 → 实时刷新（不丢失已滚动位置之外的记录）
  useEffect(() => {
    const cleanups: (() => void)[] = [];
    onNotification(() => void refresh()).then((u) => cleanups.push(u));
    onAgentChanged(() => void refresh()).then((u) => cleanups.push(u));
    return () => cleanups.forEach((u) => u());
  }, [refresh]);

  const sources = useMemo(() => {
    const ids = new Set<string>([
      ...events.map((e) => e.source_id),
      ...notifications.map((n) => n.kind),
    ]);
    return [...ids].sort();
  }, [events, notifications]);

  const groups = useMemo(() => {
    let g = groupHistory(notifications, events);
    if (timeFilter !== "all") {
      const from = Date.now() - (timeFilter === "today" ? 1 : timeFilter === "3d" ? 3 : 7) * DAY;
      g = filterGroupsByTime(g, timeFilter === "today" ? new Date(new Date().toDateString()).getTime() : from);
    }
    if (kindFilter !== "all" || sourceFilter !== "all") {
      g = g
        .map((day) => ({
          ...day,
          entries: day.entries.filter((e) => {
            if (kindFilter !== "all" && e.kind !== kindFilter) return false;
            if (sourceFilter !== "all" && e.source !== sourceFilter) return false;
            return true;
          }),
        }))
        .filter((day) => day.entries.length > 0);
    }
    return g;
  }, [notifications, events, kindFilter, sourceFilter, timeFilter]);

  const unreadCount = notifications.filter((n) => !n.is_read).length;
  const total = groups.reduce((acc, g) => acc + g.entries.length, 0);

  async function onEntryClick(key: string, notification?: NotificationRow) {
    setDetailKey((k) => (k === key ? null : key));
    if (notification && !notification.is_read) {
      try {
        await markNotificationRead(notification.id);
        setNotifications((ns) => ns.map((n) => (n.id === notification.id ? { ...n, is_read: true } : n)));
      } catch (e) {
        showToast(String(e), { kind: "error" });
      }
    }
  }

  async function onMarkAll() {
    try {
      await markAllNotificationsRead();
      await refresh();
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
      await refresh();
      showToast("通知已清空（Agent 事件流水保留）", { kind: "success" });
    } catch (e) {
      showToast(String(e), { kind: "error" });
    } finally {
      setConfirmClear(false);
    }
  }

  return (
    <div className="history-panel">
      {/* 过滤工具栏 */}
      <div className="filter-bar primary">
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
        <span className="flex-spacer" />
        <select
          className="sort-select"
          aria-label="来源筛选"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
        >
          <option value="all">全部来源</option>
          {sources.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <div className="filter-bar secondary">
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
        <span className="flex-spacer" />
        {unreadCount > 0 && <span className="history-unread-hint">{unreadCount} 条未读</span>}
        <button className="btn sm" onClick={onMarkAll} disabled={unreadCount === 0} title="全部标为已读">
          <CheckCheck size={12} /> 全部已读
        </button>
        <button className={`btn sm ${confirmClear ? "danger" : ""}`} onClick={onClear} title={confirmClear ? "再次点击确认清空" : "清空通知"}>
          <Trash2 size={12} /> {confirmClear ? "确认清空？" : "清空"}
        </button>
      </div>

      {/* 时间轴 */}
      {!loaded && <div className="empty-hint">加载中…</div>}
      {loaded && total === 0 && (
        <div className="empty-state">
          <div className="empty-icon"><Inbox size={22} /></div>
          <div className="empty-title">暂无历史记录</div>
          <div className="empty-hint">任务提醒与 Agent 事件会在这里按日期归档</div>
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
    </div>
  );
}
