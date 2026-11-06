//! Agent 历史数据分页 hook（P1-02）。
//!
//! 与实时快照刷新完全分离：历史请求只由「展开/搜索」显式触发，不轮询、不随
//! `agent-changed` 事件全量重拉，因此实时事件刷新不会被历史查询阻塞，历史分页
//! 也不会覆盖实时状态。会话列表加载成功后仅订阅 `agent-changed` 做 limit=1 的
//! 轻量头部探测（800ms 去抖，P3-01），发现更新只置 `hasNewer` 交由 UI 提示，
//! 绝不自动重拉。
//!
//! 一致性规则：
//! - 筛选条件变化 = 一次新的「代际」；旧代际的响应（无论成功/失败）直接丢弃，
//!   不会把上一轮筛选的结果写进当前列表；
//! - 「加载更多」只追加、不重置；追加按 id 去重，游标相同不会重复请求；
//! - 组件卸载/条件关闭时递增代际，迟到的响应不再 setState；
//! - 搜索输入做防抖（默认 300ms），避免每次按键都打后端。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  agentHistoryGroups,
  agentHistoryRuns,
  agentHistorySessions,
  normalizeAgentChangedPayload,
  onAgentChanged,
  type AgentHistoryGroup,
  type AgentHistorySession,
  type AgentHistorySessionsQuery,
  type AgentRun,
} from "../lib/bridge";
import { errorMessage } from "../lib/errors";
import { createSubscriptionScope, type SubscriptionScope } from "../lib/subscriptions";
import { useFullViewVisible } from "./useMainUiVisible";

export interface AgentHistoryPageBase<T> {
  items: T[];
  /** 后端 COUNT 聚合的准确总数（与当前页/游标无关） */
  total: number;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  /** 首屏加载失败原因；保留旧列表不变，由 UI 提供重试 */
  error: string | null;
  /** 是否已成功收到一次后端响应（区分「尚未加载」与「准确 0 条」） */
  loaded: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  reload: () => void;
}

export interface AgentHistoryPageState<T> extends AgentHistoryPageBase<T> {
  /**
   * 轻量探测（limit=1）发现「比当前列表头部更新的会话」。
   * 只置位提示，绝不自动 reload、不清除已加载分页、不改滚动。
   */
  hasNewer: boolean;
  /** 自动更新监听不可用；分页与手动刷新仍可使用。 */
  liveError: string | null;
  /** 用户确认提示（点击「更新」时立即消除提示，不等刷新完成） */
  markSeen: () => void;
}

interface PageData<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loaded: boolean;
}

const EMPTY = <T,>(): PageData<T> => ({
  items: [],
  total: 0,
  nextCursor: null,
  loading: false,
  loadingMore: false,
  error: null,
  loaded: false,
});

function uniqueAppend<T extends { id: string }>(prev: T[], next: T[]): T[] {
  if (prev.length === 0) return next;
  const seen = new Set(prev.map((item) => item.id));
  const merged = [...prev];
  for (const item of next) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

/** 「有新的历史记录」探测去抖：一批 agent-changed 事件只安排一次轻量探测。 */
const NEWER_PROBE_DEBOUNCE_MS = 800;

type SessionsPage = Awaited<ReturnType<typeof agentHistorySessions>>;
interface ProbeListener {
  page: (page: SessionsPage) => void;
  error: (message: string | null) => void;
}
interface HistoryProbe {
  query: AgentHistorySessionsQuery;
  listeners: Set<ProbeListener>;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  dirty: boolean;
}

// 只保存当前可见、展开分区的订阅，不缓存历史结果。相同筛选共享去抖/单飞，
// 不同实例仍各自探测；原生监听与 visibilitychange 均在最后一个消费者退出时释放。
const historyProbes = new Map<string, HistoryProbe>();
const queuedProbes = new Set<HistoryProbe>();
const MAX_CONCURRENT_PROBES = 3;
let activeProbes = 0;
let historyScope: SubscriptionScope | null = null;
let historyListenFailed = false;
const HISTORY_LISTEN_ERROR = "历史更新监听不可用，可手动刷新。";

function scheduleProbe(probe: HistoryProbe) {
  probe.dirty = true;
  if (probe.timer !== null) clearTimeout(probe.timer);
  probe.timer = null;
  if (document.visibilityState === "hidden") return;
  probe.timer = setTimeout(() => {
    probe.timer = null;
    queuedProbes.add(probe);
    drainProbes();
  }, NEWER_PROBE_DEBOUNCE_MS);
}

function drainProbes() {
  if (document.visibilityState === "hidden") return;
  for (const probe of queuedProbes) {
    if (activeProbes >= MAX_CONCURRENT_PROBES) break;
    queuedProbes.delete(probe);
    if (probe.listeners.size === 0 || probe.inFlight) continue;
    probe.inFlight = true;
    probe.dirty = false;
    activeProbes += 1;
    const listeners = [...probe.listeners];
    void agentHistorySessions({ ...probe.query, limit: 1 })
      .then((page) => {
        for (const listener of listeners) {
          if (probe.listeners.has(listener)) listener.page(page);
        }
      })
      .catch(() => {
        // 探测失败不清空已加载列表；下个事件或用户刷新可重新读取。
      })
      .finally(() => {
        probe.inFlight = false;
        activeProbes -= 1;
        if (probe.dirty && probe.listeners.size > 0) scheduleProbe(probe);
        drainProbes();
      });
  }
}

function onHistoryVisibilityChange() {
  for (const probe of historyProbes.values()) {
    if (document.visibilityState === "hidden") {
      probe.dirty = probe.dirty || probe.inFlight || queuedProbes.has(probe);
      if (probe.timer !== null) clearTimeout(probe.timer);
      probe.timer = null;
      queuedProbes.delete(probe);
    } else if (probe.dirty) {
      scheduleProbe(probe);
    }
  }
}

function ensureHistoryListener() {
  if (historyScope && !historyListenFailed) return;
  historyScope?.dispose();
  const scope = createSubscriptionScope();
  historyScope = scope;
  historyListenFailed = false;
  for (const probe of historyProbes.values()) {
    for (const listener of probe.listeners) listener.error(null);
  }
  void scope.add(onAgentChanged((rawPayload) => {
    if (scope.closed) return;
    const payload = normalizeAgentChangedPayload(rawPayload);
    if (!payload || payload.changed === false) return;
    for (const probe of historyProbes.values()) {
      const sourceId = probe.query.sourceId;
      // 空 sources = 全局事件（stale 汇总等），所有分区均需刷新探测。
      if (sourceId && payload.sources.length > 0 && !payload.sources.includes(sourceId)) continue;
      scheduleProbe(probe);
    }
  })).then((ok) => {
    if (historyScope !== scope || scope.closed || ok) return;
    historyListenFailed = true;
    // 诊断只含固定代码；不记录事件、搜索词或会话数据。
    console.warn("[agent-history] event-listen-failed");
    for (const probe of historyProbes.values()) {
      for (const listener of probe.listeners) listener.error(HISTORY_LISTEN_ERROR);
    }
  });
}

function subscribeHistoryProbe(
  key: string,
  query: AgentHistorySessionsQuery,
  listener: ProbeListener,
  catchUp: boolean,
): () => void {
  let probe = historyProbes.get(key);
  if (!probe) {
    probe = { query, listeners: new Set(), timer: null, inFlight: false, dirty: false };
    historyProbes.set(key, probe);
  }
  probe.listeners.add(listener);
  listener.error(historyListenFailed ? HISTORY_LISTEN_ERROR : null);
  if (historyProbes.size === 1 && probe.listeners.size === 1) {
    document.addEventListener("visibilitychange", onHistoryVisibilityChange);
  }
  ensureHistoryListener();
  if (catchUp) scheduleProbe(probe);
  return () => {
    probe.listeners.delete(listener);
    if (probe.listeners.size === 0) {
      if (probe.timer !== null) clearTimeout(probe.timer);
      queuedProbes.delete(probe);
      historyProbes.delete(key);
    }
    if (historyProbes.size === 0) {
      historyScope?.dispose();
      historyScope = null;
      historyListenFailed = false;
      document.removeEventListener("visibilitychange", onHistoryVisibilityChange);
    }
  };
}

function useSessionsPage(
  query: AgentHistorySessionsQuery,
  key: string,
  enabled: boolean,
  pageSize: number,
): AgentHistoryPageState<AgentHistorySession> {
  const [state, setState] = useState<PageData<AgentHistorySession>>(EMPTY);
  const [hasNewer, setHasNewer] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const visible = useFullViewVisible();
  const generation = useRef(0);
  const loadedRequest = useRef<string | null>(null);
  const resumeProbe = useRef(false);
  const loadingMoreRef = useRef(false);
  const queryRef = useRef(query);
  queryRef.current = query;
  // 探测比较需要读取「当前列表头部」；用 ref 避免 head 变化反复重挂订阅。
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const gen = ++generation.current;
    loadingMoreRef.current = false;
    if (!enabled) {
      loadedRequest.current = null;
      setState(EMPTY());
      setHasNewer(false);
      setLiveError(null);
      return;
    }
    if (!visible) {
      setState((prev) => prev.loading || prev.loadingMore
        ? { ...prev, loading: false, loadingMore: false }
        : prev);
      return;
    }
    const requestKey = JSON.stringify([key, pageSize, reloadToken]);
    if (loadedRequest.current === requestKey) return;
    // 新筛选立即清空旧结果，避免旧筛选内容短暂冒充新结果。
    setState({ ...EMPTY(), loading: true });
    void (async () => {
      try {
        const page = await agentHistorySessions({ ...queryRef.current, limit: pageSize });
        if (gen !== generation.current) return;
        loadedRequest.current = requestKey;
        setState({
          items: page.items,
          total: page.total,
          nextCursor: page.next_cursor,
          loading: false,
          loadingMore: false,
          error: null,
          loaded: true,
        });
        // 全量重拉成功 = 头部已是最新的已知状态，复位提示。
        setHasNewer(false);
      } catch (e) {
        if (gen !== generation.current) return;
        setState({ ...EMPTY(), error: errorMessage(e) });
      }
    })();
    return () => {
      // 卸载/条件变化：让所有在途响应失效。
      generation.current += 1;
    };
  }, [enabled, visible, key, pageSize, reloadToken]);

  // 「有新的历史记录」轻量探测（P3-01）：列表成功加载后订阅 agent-changed，
  // 800ms 去抖合并一批事件，再用 limit=1 的单行查询比较头部是否变化。
  // 绝不自动 reload、不清除已加载分页、不改滚动，只把 hasNewer 交给 UI 提示；
  // 页面隐藏时跳过探测，可见性恢复后补一次。不新增轮询/interval。
  useEffect(() => {
    if (!visible) {
      resumeProbe.current = true;
      return;
    }
    if (!enabled || !state.loaded) return;
    let disposed = false;
    const gen = generation.current;
    const unsubscribe = subscribeHistoryProbe(key, queryRef.current, {
      page: (page) => {
        if (disposed || gen !== generation.current || document.visibilityState === "hidden") return;
        const newest = page.items[0];
        if (!newest) return;
        const head = stateRef.current.items[0];
        // 头部 id 或 last_seen_at 任一变化都算「有更新」；相同则不打扰。
        if (!head || newest.id !== head.id || newest.last_seen_at !== head.last_seen_at) {
          setHasNewer(true);
        }
      },
      error: (message) => {
        if (!disposed) setLiveError(message);
      },
    }, resumeProbe.current);
    resumeProbe.current = false;

    return () => {
      disposed = true;
      // 卸载/条件变化：在途探测响应由 disposed + 探测自捕获的代际守卫丢弃。
      // 这里不能动 generation.current：cleanup 也会在 loaded true→false（点击
      // 「更新」重拉）时运行，递增会连带作废正在途的全量重拉响应。
      unsubscribe();
    };
  }, [enabled, visible, key, state.loaded]);

  const loadMore = useCallback(async () => {
    const cursor = state.nextCursor;
    if (!enabled || !visible || !cursor || state.loading || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    const gen = generation.current;
    setState((prev) => ({ ...prev, loadingMore: true, error: null }));
    try {
      const page = await agentHistorySessions({
        ...queryRef.current,
        cursor,
        limit: pageSize,
      });
      if (gen !== generation.current) return;
      setState((prev) => ({
        items: uniqueAppend(prev.items, page.items),
        total: page.total,
        nextCursor: page.next_cursor,
        loading: false,
        loadingMore: false,
        error: null,
        loaded: true,
      }));
    } catch (e) {
      if (gen !== generation.current) return;
      setState((prev) => ({ ...prev, loadingMore: false, error: errorMessage(e) }));
    } finally {
      if (gen === generation.current) loadingMoreRef.current = false;
    }
  }, [enabled, visible, pageSize, state.loading, state.nextCursor]);

  const reload = useCallback(() => {
    // 立即停止旧代际监听，避免同步完成的重拉把 loaded=false 中间态合并掉。
    setState((prev) => ({ ...prev, loaded: false }));
    setReloadToken((n) => n + 1);
  }, []);
  const markSeen = useCallback(() => setHasNewer(false), []);

  return {
    ...state,
    hasNewer,
    liveError,
    hasMore: state.nextCursor !== null,
    loadMore,
    reload,
    markSeen,
  };
}

function useSessionFilter(params: {
  sourceId?: string;
  instanceId?: string | null;
  unassigned?: boolean;
}): { query: AgentHistorySessionsQuery; key: string } {
  const { sourceId, instanceId, unassigned = false } = params;
  const query = useMemo<AgentHistorySessionsQuery>(
    () => ({
      sourceId: sourceId?.trim() || undefined,
      instanceId: instanceId?.trim() || undefined,
      unassigned: instanceId ? false : unassigned || undefined,
    }),
    [sourceId, instanceId, unassigned],
  );
  const key = useMemo(
    () => JSON.stringify({ s: query.sourceId ?? "", i: query.instanceId ?? "", u: !!query.unassigned }),
    [query],
  );
  return { query, key };
}

/** 按来源/实例（或未关联实例）分页查询历史会话；`enabled` 为 false 时不请求。 */
export function useAgentSessionHistory(params: {
  sourceId?: string;
  instanceId?: string | null;
  unassigned?: boolean;
  enabled: boolean;
  pageSize?: number;
}): AgentHistoryPageState<AgentHistorySession> {
  const { enabled, pageSize = 10 } = params;
  const { query, key } = useSessionFilter(params);
  return useSessionsPage(query, key, enabled, pageSize);
}

export interface AgentHistoryGroupsState {
  items: AgentHistoryGroup[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * 历史入口分组：一次 SQL 聚合拿到某来源下每个真实实例/未关联实例的历史数量。
 *
 * 监控树仍由实时快照构建；本 hook 只用于补出「快照里没有近期会话、但历史上
 * 有记录」的来源/实例入口。`refreshKey` 在实时状态变化时更新（例如运行转完成），
 * 用 150ms 去抖合并连续事件，不轮询。
 */
export function useAgentHistoryGroups(
  sourceId: string,
  enabled: boolean,
  refreshKey: string,
): AgentHistoryGroupsState {
  const [items, setItems] = useState<AgentHistoryGroup[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const visible = useFullViewVisible();
  const generation = useRef(0);

  useEffect(() => {
    const gen = ++generation.current;
    if (!enabled || !sourceId) {
      setItems([]);
      setTruncated(false);
      setLoading(false);
      setError(null);
      return;
    }
    if (!visible) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const page = await agentHistoryGroups({ sourceId });
          if (gen !== generation.current) return;
          setItems(page.items);
          setTruncated(page.truncated);
          setError(null);
        } catch (e) {
          if (gen !== generation.current) return;
          setError(errorMessage(e));
        } finally {
          if (gen === generation.current) setLoading(false);
        }
      })();
    }, 150);
    return () => {
      generation.current += 1;
      clearTimeout(timer);
    };
  }, [sourceId, enabled, visible, refreshKey, reloadToken]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);
  return { items, truncated, loading, error, reload };
}

/** 全库历史搜索（面板级）：防抖后调用后端，命中标题/external_id/轮次任务标题。 */
export function useAgentHistorySearch(
  keyword: string,
  enabled: boolean,
  pageSize = 10,
): AgentHistoryPageState<AgentHistorySession> & { query: string } {
  const trimmed = keyword.trim();
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    if (!trimmed) {
      setDebounced("");
      return;
    }
    const timer = setTimeout(() => setDebounced(trimmed), 300);
    return () => clearTimeout(timer);
  }, [trimmed]);

  const query = useMemo<AgentHistorySessionsQuery>(
    () => ({ keyword: debounced || undefined }),
    [debounced],
  );
  const page = useSessionsPage(query, `search:${debounced}`, enabled && debounced.length > 0, pageSize);
  return { ...page, query: debounced };
}

interface RunsData {
  items: AgentRun[];
  total: number;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loaded: boolean;
}

const EMPTY_RUNS = (): RunsData => ({
  items: [],
  total: 0,
  nextCursor: null,
  loading: false,
  loadingMore: false,
  error: null,
  loaded: false,
});

/** 会话轮次分页：只在会话展开（enabled）时请求，首次 10 条，「显示更多轮次」走游标。 */
export function useAgentRunHistory(
  sessionId: string | null,
  enabled: boolean,
  pageSize = 10,
  liveOnly = false,
): AgentHistoryPageBase<AgentRun> {
  const [state, setState] = useState<RunsData>(EMPTY_RUNS);
  const [reloadToken, setReloadToken] = useState(0);
  const visible = useFullViewVisible();
  const generation = useRef(0);
  const loadedRequest = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    const gen = ++generation.current;
    loadingMoreRef.current = false;
    if (!sessionId || !enabled) {
      loadedRequest.current = null;
      setState(EMPTY_RUNS());
      return;
    }
    if (!visible) {
      setState((prev) => prev.loading || prev.loadingMore
        ? { ...prev, loading: false, loadingMore: false }
        : prev);
      return;
    }
    const requestKey = JSON.stringify([sessionId, pageSize, reloadToken, liveOnly]);
    if (loadedRequest.current === requestKey) return;
    setState({ ...EMPTY_RUNS(), loading: true });
    void (async () => {
      try {
        const page = await agentHistoryRuns(sessionId, null, pageSize, false, liveOnly);
        if (gen !== generation.current) return;
        loadedRequest.current = requestKey;
        setState({
          items: page.items,
          total: page.total,
          nextCursor: page.next_cursor,
          loading: false,
          loadingMore: false,
          error: null,
          loaded: true,
        });
      } catch (e) {
        if (gen !== generation.current) return;
        setState({ ...EMPTY_RUNS(), error: errorMessage(e) });
      }
    })();
    return () => {
      generation.current += 1;
    };
  }, [sessionId, enabled, visible, pageSize, reloadToken, liveOnly]);

  const loadMore = useCallback(async () => {
    if (!sessionId || !enabled || !visible || !state.nextCursor || state.loading || loadingMoreRef.current) {
      return;
    }
    loadingMoreRef.current = true;
    const gen = generation.current;
    setState((prev) => ({ ...prev, loadingMore: true, error: null }));
    try {
      const page = await agentHistoryRuns(sessionId, state.nextCursor, pageSize, false, liveOnly);
      if (gen !== generation.current) return;
      setState((prev) => ({
        // 实时溢出只保留当前页，避免长时间翻页把整个活动集合缓存进 React state。
        items: liveOnly ? page.items : uniqueAppend(prev.items, page.items),
        total: page.total,
        nextCursor: page.next_cursor,
        loading: false,
        loadingMore: false,
        error: null,
        loaded: true,
      }));
    } catch (e) {
      if (gen !== generation.current) return;
      setState((prev) => ({ ...prev, loadingMore: false, error: errorMessage(e) }));
    } finally {
      if (gen === generation.current) loadingMoreRef.current = false;
    }
  }, [enabled, visible, liveOnly, pageSize, sessionId, state.loading, state.nextCursor]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  return {
    ...state,
    hasMore: state.nextCursor !== null,
    loadMore,
    reload,
  };
}
