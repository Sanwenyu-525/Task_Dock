//! 历史面板：通知 + Agent 事件统一时间轴。
//! 按日分组、连续重复（失联/重连等）聚合、来源/类型/时间过滤、
//! 点击展开详情、通知点击标已读、清空走统一 ConfirmDialog（危险操作默认聚焦取消）；
//! 订阅 notification / agent-changed 事件实时刷新。
//!
//! 分页与筛选全部在数据库完成：通知与事件各自 keyset 翻页，`has_more` 与
//! `filtered_total` 使用同一筛选口径；未读数来自全库统计，不受首页 100 条限制。
//! 后台刷新只合并在时间上连续的页；若新数据与已加载旧页之间出现空隙，则保留
//! 旧页并提示刷新，绝不把有缺口的列表伪装成完整时间轴。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, CheckCheck, Trash2, ChevronRight, ChevronDown, History, Inbox } from "lucide-react";
import "./history-page.css";
import AgentIcon from "../ui/AgentIcon";
import {
  clearNotifications,
  listAgentEvents,
  markAllNotificationsRead,
  markNotificationRead,
  notificationInboxStats,
  notificationPage,
  normalizeAgentChangedPayload,
  onAgentChanged,
  onNotification,
  type AgentEventPage,
  type AgentEventRow,
  type NotificationPage,
  type NotificationRow,
} from "../../lib/bridge";
import { useUiStore } from "../../store/useUiStore";
import WorkspaceSplit from "../../workbench/WorkspaceSplit";

/** 右栏时间用本地可读格式；原始 ISO 只保留给接口/日志，不直接暴露给用户。 */
function formatHistoryTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
import SearchField from "../ui/SearchField";
import {
  WorkbenchDetailFacts,
  WorkbenchPageDetail,
  useWorkbenchDetailHost,
} from "../../workbench/pageDetail";
import WorkbenchPageHeader from "../../workbench/WorkbenchPageHeader";
import { useAgentsStore } from "../../store/useAgentsStore";
import { createSubscriptionScope } from "../../lib/subscriptions";
import { ConfirmDialog, EmptyState, Select } from "../ui";
import { NOTIFICATION_KIND_LABELS, AGENT_STATE_LABELS, formatRelative } from "../../lib/format";
import { groupHistory } from "../../lib/historyGroup";
import { useLocale } from "../../hooks/useLocale";
import { useFullViewVisible } from "../../hooks/useMainUiVisible";
import type { MessageKey } from "../../i18n";

type KindFilter = "all" | "notification" | "event";
type TimeFilter = "today" | "3d" | "7d" | "all";

const TIME_FILTERS: { id: TimeFilter; labelKey: MessageKey }[] = [
  { id: "today", labelKey: "history.time.today" },
  { id: "3d", labelKey: "history.time.3d" },
  { id: "7d", labelKey: "history.time.7d" },
  { id: "all", labelKey: "history.time.all" },
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
  const { t: tr } = useLocale();
  const showToast = useUiStore((s) => s.showToast);
  /** 右栏宿主存在时，展开内容投送到右栏；右栏关闭时保留内联详情作为降级。 */
  const detailHost = useWorkbenchDetailHost();
  /** 只过滤已加载记录：历史没有后端全文检索接口，不假装搜索全库。 */
  const [textQuery, setTextQuery] = useState("");
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
  const [clearing, setClearing] = useState(false);
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

  // 页面活跃态（消费者门控）：完整面板不可见（停靠胶囊、极简/紧凑模式）时
  // 本页不注册独占监听、也不发筛选查询；恢复可见时重新注册并补一次刷新。
  const visible = useFullViewVisible();
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // 时间/来源筛选变化：两个列表一起按新口径重置（分页游标随之失效）。
  useEffect(() => {
    setLoaded(false);
    setNotifications([]);
    setEvents([]);
    setHasNew(false);
    // 隐藏态不发三条历史查询（页面级消费者门控）：恢复可见时由下方
    // 「恢复可见补一次刷新」effect 以 merge 语义补齐首屏（此时列表已清空）。
    if (!visibleRef.current) return;
    void refresh("replace");
    // refresh 已包含筛选与当前列表；此处只在筛选变化时重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  // 新通知 / Agent 事件到达 → 合并刷新（500ms 窗口，避免事件风暴下反复拉取全量历史）。
  // 消费者门控（页面级独占资源）：本页的两个监听只服务于本页刷新，不是共享订阅
  // （全局 Agent 事件存储与历史写入由 App/store 负责）。完整面板不可见时不注册监听，
  // 恢复可见时重新注册并补一次合并刷新；异步 listen() 在作用域关闭后才兑现时
  // 由 createSubscriptionScope 立即反订阅。
  useEffect(() => {
    if (!visible) return;
    const scope = createSubscriptionScope();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!visibleRef.current) return;
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        void refresh("merge");
      }, 500);
    };
    scope.add(onNotification(() => bump()));
    scope.add(onAgentChanged((rawPayload) => {
      const payload = normalizeAgentChangedPayload(rawPayload);
      if (!payload || payload.changed === false) return;
      bump();
    }));
    return () => {
      if (timer) clearTimeout(timer);
      scope.dispose();
    };
  }, [refresh, visible]);

  // 恢复可见：补一次合并刷新，弥补隐藏期间被门控跳过的事件（不重复拉首屏）
  const prevVisibleRef = useRef(visible);
  useEffect(() => {
    if (visible && !prevVisibleRef.current) void refresh("merge");
    prevVisibleRef.current = visible;
  }, [visible, refresh]);

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
    const q = textQuery.trim().toLocaleLowerCase();
    if (q) {
      g = g
        .map((day) => ({
          ...day,
          entries: day.entries.filter((e) => {
            const title =
              e.kind === "notification" ? e.notification?.title ?? "" : e.event?.message ?? "";
            const body =
              e.kind === "notification"
                ? e.notification?.body ?? ""
                : e.event?.session_external_id ?? "";
            return `${title} ${body} ${e.source}`.toLocaleLowerCase().includes(q);
          }),
        }))
        .filter((day) => day.entries.length > 0);
    }
    return g;
  }, [notifications, events, kindFilter, textQuery]);

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
    const n = unread;
    try {
      await markAllNotificationsRead();
      await refresh("replace");
      showToast(n > 0 ? `已将 ${n} 条通知标为已读` : "通知已全部为已读", { kind: "success" });
    } catch (e) {
      showToast(String(e), { kind: "error" });
    }
  }

  /** 清空按钮只打开确认框；真正的删除由确认框回调执行（与危险操作统一口径）。 */
  async function onClearConfirmed() {
    if (clearing) return;
    setClearing(true);
    try {
      await clearNotifications();
      await refresh("replace");
      showToast("通知已清空（Agent 事件流水保留）", { kind: "success" });
      setConfirmClear(false);
    } catch (e) {
      showToast(String(e), { kind: "error" });
    } finally {
      setClearing(false);
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
    <div className="history-panel page-fill ui-page-frame">
      {/* 页面级页头（2026-11-15 统一）：图标 + 标题 + 副标题，主要操作移到右侧动作区，
          与 19 张效果图的页头结构一致；筛选仍在下方工具栏，不与页头混排。 */}
      <WorkbenchPageHeader
        icon={History}
        title={tr("history.pageTitle")}
        subtitle={tr("history.pageSubtitle")}
        actions={
          <>
            <button
              className="btn sm"
              onClick={onMarkAll}
              disabled={unread === 0}
              data-tip={tr("history.markAllTip")}
              aria-label={tr("history.markAll")}
            >
              <CheckCheck size={12} /> {tr("history.markAll")}
            </button>
            <button
              className="btn sm"
              onClick={() => setConfirmClear(true)}
              data-tip={tr("history.clearTip")}
              aria-label={tr("history.clear")}
            >
              <Trash2 size={12} /> {tr("history.clear")}
            </button>
          </>
        }
      />
      {/* 过滤工具栏：第一行 = 筛选（时间 → 来源 → 类型，窄窗口时靠后的先换行），
          第二行 = 统计 + 批量操作，两行职责分离互不挤压 */}
      {/* 过滤工具栏（2026-11-15 合并）：原来「筛选」与「未读统计」分两条 filter-bar，
          第二行只剩一句统计，视觉上悬空。现在合成一条工具栏，统计靠右同排，
          窄窗口时随筛选组一起换行，不再单独占一行。 */}
      <WorkspaceSplit
        id="history"
        sidebarLabel={tr("history.rangeAria")}
        sidebar={
          <div className="history-filter-pane">
            <div className="workspace-rail-head">
              <span className="workspace-rail-eyebrow">事件追踪</span>
              <h2>筛选与范围</h2>
            </div>
            <div className="filter-bar primary history-toolbar">
        <div className="seg-group subtle" role="group" aria-label={tr("history.rangeAria")}>
          {TIME_FILTERS.map((t) => (
            <button
              key={t.id}
              className={`seg-btn ${timeFilter === t.id ? "active" : ""}`}
              onClick={() => setTimeFilter(t.id)}
            >
              {tr(t.labelKey)}
            </button>
          ))}
        </div>
        <Select
          className="sort-select"
          size="sm"
          ariaLabel={tr("history.sourceAria")}
          value={sourceFilter}
          options={[{ value: "all", label: tr("history.allSources") }, ...sourceOptions.map(([value, label]) => ({ value, label }))]}
          onChange={(v) => setSourceFilter(v)}
        />
        <div className="seg-group subtle" role="group" aria-label={tr("history.typeAria")}>
          {(
            [
              { id: "all", labelKey: "history.kind.all" },
              { id: "notification", labelKey: "history.kind.notification" },
              { id: "event", labelKey: "history.kind.event" },
            ] as const
          ).map((k) => (
            <button
              key={k.id}
              className={`seg-btn ${kindFilter === k.id ? "active" : ""}`}
              onClick={() => setKindFilter(k.id)}
            >
              {tr(k.labelKey)}
            </button>
          ))}
        </div>
        <SearchField
          size="compact"
          className="history-search"
          value={textQuery}
          onChange={setTextQuery}
          placeholder="搜索已加载记录"
          ariaLabel="搜索已加载的历史记录"
          clearLabel="清除历史搜索"
        />
        <span className="history-unread-hint history-toolbar-meta">
          {textQuery
            ? `已加载记录中匹配 ${total} 条`
            : tr("history.unread", { unread, total: inboxTotal })}
        </span>
        <span className="history-scope-hint" data-tip="历史接口暂无全库全文检索；搜索只匹配已加载到前端的记录">
          搜索仅限已加载
        </span>
            </div>
          </div>
        }
      >

      {hasNew && (
        <div className="history-new-banner">
          <span>{tr("history.gap")}</span>
          <button className="btn sm" onClick={() => void refresh("replace")}>{tr("history.refreshLatest")}</button>
        </div>
      )}

      {/* 时间轴：筛选条与「有新记录」提示固定，只有时间轴列表滚动 */}
      <div className="page-scroll history-timeline">
        {!loaded && <div className="empty-hint">{tr("history.loading")}</div>}
        {loaded && total === 0 && (
          <EmptyState
            icon={<Inbox size={22} />}
            title={filtering ? tr("history.emptyFiltered") : tr("history.empty")}
            hint={
              filtering
                ? `筛选范围内共 ${eventsTotal} 条 Agent 事件、${notificationsTotal} 条通知；可调整来源/时间/类型。`
                : "任务提醒与 Agent 事件会在这里按日期归档"
            }
          />
        )}
        {groups.map((g) => (
          <div key={g.label} className="history-day">
            <div className="history-day-label">
              <span className="history-day-label-mask" aria-hidden="true" />
              <span className="history-day-label-text">{g.label}</span>
            </div>
            <div className="history-list">
              {g.entries.map((e) => {
                const open = detailKey === e.key;
                return (
                  <div
                    key={e.key}
                    className={`history-item surface-card surface-card--interactive kind-${e.kind === "event" ? `event-${e.event?.state}` : e.source} ${e.unread ? "unread" : ""}`}
                    onClick={() => onEntryClick(e.key, e.notification)}
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    onKeyDown={(ev) => {
                      // role=button 的键盘契约：Enter 与 Space 都要能展开/收起
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        onEntryClick(e.key, e.notification);
                      }
                    }}
                  >
                    <div className="history-head">
                      {e.unread && <span className="history-unread-dot" aria-hidden="true" />}
                      {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      <span className={`history-kind ${e.kind === "event" ? `ev-${e.event?.state}` : `nk-${e.source}`}`}>
                        {e.kind === "event" ? <AgentIcon size={10} /> : <Bell size={10} />}
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
                    {open && !detailHost && (
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
                    {open && detailHost && (
                      <WorkbenchPageDetail
                        title="事件详情"
                        actions={
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => setDetailKey(null)}
                          >
                            收起
                          </button>
                        }
                      >
                        <p className="wb-detail-title">
                          <span>
                            {e.kind === "notification"
                              ? e.notification?.title || "（无标题通知）"
                              : e.event?.message || e.event?.session_external_id || "（无消息内容）"}
                          </span>
                        </p>
                        {e.kind === "notification" && e.notification?.body && (
                          <p className="wb-detail-desc">{e.notification.body}</p>
                        )}
                        <WorkbenchDetailFacts
                          rows={[
                            { label: "发生时间", value: formatHistoryTime(e.iso) },
                            { label: "事件来源", value: e.source },
                            {
                              label: "事件类型",
                              value:
                                e.kind === "event"
                                  ? `Agent · ${AGENT_STATE_LABELS[e.event?.state ?? ""] ?? e.event?.state ?? "事件"}`
                                  : NOTIFICATION_KIND_LABELS[e.source] ?? e.source,
                            },
                            e.kind === "notification" && e.notification?.ref_type
                              ? {
                                  label: "关联对象",
                                  value: `${e.notification.ref_type} · ${e.notification.ref_id}`,
                                }
                              : null,
                            e.kind === "event" && e.event?.session_external_id
                              ? { label: "关联会话", value: e.event.session_external_id }
                              : null,
                            e.count > 1
                              ? { label: "聚合记录", value: `${e.count} 条连续相同记录` }
                              : null,
                          ]}
                        />
                        {e.kind === "event" && (
                          <div className="wb-detail-actions">
                            <button
                              type="button"
                              className="btn sm"
                              onClick={() => {
                                setDetailKey(null);
                                void useUiStore.getState().setTab("agents");
                              }}
                            >
                              前往 Agent 管理
                            </button>
                          </div>
                        )}
                      </WorkbenchPageDetail>
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
      </WorkspaceSplit>

      <ConfirmDialog
        open={confirmClear}
        title="清空通知历史？"
        detail="将删除全部通知记录（Agent 事件流水保留）。此操作不可撤销。"
        confirmLabel="确认清空"
        danger
        busy={clearing}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void onClearConfirmed()}
      />
    </div>
  );
}
