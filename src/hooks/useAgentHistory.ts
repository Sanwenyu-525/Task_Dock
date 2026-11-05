//! Agent 历史数据分页 hook（P1-02）。
//!
//! 与实时快照刷新完全分离：历史请求只由「展开/搜索」显式触发，不轮询、不随
//! `agent-changed` 事件全量重拉，因此实时事件刷新不会被历史查询阻塞，历史分页
//! 也不会覆盖实时状态。
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
  type AgentHistoryGroup,
  type AgentHistorySession,
  type AgentHistorySessionsQuery,
  type AgentRun,
} from "../lib/bridge";
import { errorMessage } from "../lib/errors";

export interface AgentHistoryPageState<T> {
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

function useSessionsPage(
  query: AgentHistorySessionsQuery,
  key: string,
  enabled: boolean,
  pageSize: number,
): AgentHistoryPageState<AgentHistorySession> {
  const [state, setState] = useState<PageData<AgentHistorySession>>(EMPTY);
  const [reloadToken, setReloadToken] = useState(0);
  const generation = useRef(0);
  const loadingMoreRef = useRef(false);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    const gen = ++generation.current;
    loadingMoreRef.current = false;
    if (!enabled) {
      setState(EMPTY());
      return;
    }
    // 新筛选立即清空旧结果，避免旧筛选内容短暂冒充新结果。
    setState({ ...EMPTY(), loading: true });
    void (async () => {
      try {
        const page = await agentHistorySessions({ ...queryRef.current, limit: pageSize });
        if (gen !== generation.current) return;
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
        setState({ ...EMPTY(), error: errorMessage(e) });
      }
    })();
    return () => {
      // 卸载/条件变化：让所有在途响应失效。
      generation.current += 1;
    };
  }, [enabled, key, pageSize, reloadToken]);

  const loadMore = useCallback(async () => {
    const cursor = state.nextCursor;
    if (!enabled || !cursor || state.loading || loadingMoreRef.current) return;
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
      loadingMoreRef.current = false;
    }
  }, [enabled, pageSize, state.loading, state.nextCursor]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  return {
    ...state,
    hasMore: state.nextCursor !== null,
    loadMore,
    reload,
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
  }, [sourceId, enabled, refreshKey, reloadToken]);

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
): AgentHistoryPageState<AgentRun> {
  const [state, setState] = useState<RunsData>(EMPTY_RUNS);
  const [reloadToken, setReloadToken] = useState(0);
  const generation = useRef(0);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    const gen = ++generation.current;
    loadingMoreRef.current = false;
    if (!sessionId || !enabled) {
      setState(EMPTY_RUNS());
      return;
    }
    setState({ ...EMPTY_RUNS(), loading: true });
    void (async () => {
      try {
        const page = await agentHistoryRuns(sessionId, null, pageSize);
        if (gen !== generation.current) return;
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
  }, [sessionId, enabled, pageSize, reloadToken]);

  const loadMore = useCallback(async () => {
    if (!sessionId || !enabled || !state.nextCursor || state.loading || loadingMoreRef.current) {
      return;
    }
    loadingMoreRef.current = true;
    const gen = generation.current;
    setState((prev) => ({ ...prev, loadingMore: true, error: null }));
    try {
      const page = await agentHistoryRuns(sessionId, state.nextCursor, pageSize);
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
      loadingMoreRef.current = false;
    }
  }, [enabled, pageSize, sessionId, state.loading, state.nextCursor]);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  return {
    ...state,
    hasMore: state.nextCursor !== null,
    loadMore,
    reload,
  };
}
