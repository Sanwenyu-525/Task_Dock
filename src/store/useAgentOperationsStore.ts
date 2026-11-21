//! Agent 操作统一状态（v86）：全应用只在这里合并操作事件与数据库游标。
//!
//! 设计约束（见 `docs/agent-workspace/operation-visualization.md`）：
//! - **数据库是事实来源**：事件只做低延迟更新，丢失/乱序由游标同步补齐；
//! - 按 `operationId` 合并，同一操作重复事件不产生第二条记录；
//! - 事件乱序时以 `updatedAt` 为准，旧事件直接丢弃（不把终态改回 running）；
//! - 资源索引按 key 局部重建，未受影响的资源保持原数组引用，避免整列表重渲染；
//! - 只有本 store 维持低频同步：页面不得各自轮询、不得各自监听 Tauri 事件；
//! - 页面隐藏时不同步；应用启动时先做一次「最近 N 条」恢复，已结束的操作
//!   绝不会被显示成运行中。

import { create } from "zustand";
import { isTauri } from "@tauri-apps/api/core";
import {
  agentOperationsSync,
  onAgentOperationChanged,
  type AgentOperation,
  type AgentOperationCursor,
  type AgentOperationStatus,
} from "../lib/bridge";

/** 终态在资源卡片上的短暂停留：成功 4.2s；失败/冲突更久，便于看清原因。 */
const FLASH_MS: Record<Exclude<AgentOperationStatus, "running">, number> = {
  committed: 4200,
  failed: 9000,
  conflict: 9000,
  interrupted: 7000,
};

const RECENT_LIMIT = 20;
/** 有运行中操作时的同步间隔：低频兜底，独立 CLI 只能靠它被感知。 */
const POLL_ACTIVE_MS = 5000;
/** 空闲时的同步间隔：仍有跨进程写入可能，保持很轻的检查。 */
const POLL_IDLE_MS = 20000;

const EMPTY: AgentOperation[] = [];

/** 资源索引 key：优先真实资源 ID；新建尚未分配 ID 时退到所属项目列表。 */
export function operationResourceKey(op: AgentOperation): string {
  if (op.resourceId) return `${op.resourceKind}:${op.resourceId}`;
  if (op.projectId) return `project:${op.projectId}`;
  return "";
}

function timeOf(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** 同一操作的新旧比较：先用解析后的时间，解析失败再退回字符串序。 */
function isOlder(next: AgentOperation, prev: AgentOperation): boolean {
  const a = timeOf(next.updatedAt);
  const b = timeOf(prev.updatedAt);
  if (a && b) return a < b;
  return next.updatedAt < prev.updatedAt;
}

function byUpdatedDesc(a: AgentOperation, b: AgentOperation): number {
  const delta = timeOf(b.updatedAt) - timeOf(a.updatedAt);
  return delta !== 0 ? delta : a.id.localeCompare(b.id);
}

/** 只有运行中或仍在短暂停留窗口内的操作才进入资源索引。 */
function isVisible(op: AgentOperation, now: number): boolean {
  if (op.status === "running") return true;
  const until = flashDeadlines.get(op.id);
  return typeof until === "number" && until > now;
}

const flashDeadlines = new Map<string, number>();
const flashTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearFlashTimer(id: string): void {
  const timer = flashTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    flashTimers.delete(id);
  }
}

function scheduleFlashExpiry(id: string, status: AgentOperationStatus): void {
  clearFlashTimer(id);
  if (status === "running") {
    flashDeadlines.delete(id);
    return;
  }
  const ms = FLASH_MS[status];
  flashDeadlines.set(id, Date.now() + ms);
  flashTimers.set(
    id,
    setTimeout(() => {
      flashTimers.delete(id);
      flashDeadlines.delete(id);
      useAgentOperationsStore.getState().expire(id);
    }, ms + 20),
  );
}

export interface AgentOperationsState {
  byId: Record<string, AgentOperation>;
  /** key → 该资源当前可见的操作，按更新时间倒序。 */
  index: Record<string, AgentOperation[]>;
  /** 当前运行中的操作（按更新时间倒序）。 */
  active: AgentOperation[];
  /** 最近结束的操作（时间倒序，含失败/冲突/中断）。 */
  recent: AgentOperation[];
  activeCount: number;
  cursor: AgentOperationCursor | null;
  subscribed: boolean;
  syncing: boolean;
  error: string | null;
  lastSyncAt: number;
  /** 合并一条操作（事件或同步结果）。重复与乱序在此处收敛。
   *  `flash=false` 用于启动恢复：历史终态只进「最近记录」，不在资源上闪一下。 */
  ingest: (op: AgentOperation, options?: { flash?: boolean }) => void;
  /** 短暂停留结束：只从索引与 byId 移除，历史仍保留在 recent。 */
  expire: (id: string) => void;
  /** 单飞游标同步：并发调用复用同一请求。 */
  syncNow: () => Promise<void>;
  /** 测试/登出用：清空 UI 状态与定时器。 */
  reset: () => void;
}

function buildLists(byId: Record<string, AgentOperation>) {
  const active: AgentOperation[] = [];
  for (const op of Object.values(byId)) {
    if (op.status === "running") active.push(op);
  }
  active.sort(byUpdatedDesc);
  return { active };
}

export const useAgentOperationsStore = create<AgentOperationsState>((set, get) => ({
  byId: {},
  index: {},
  active: [],
  recent: [],
  activeCount: 0,
  cursor: null,
  subscribed: false,
  syncing: false,
  error: null,
  lastSyncAt: 0,

  ingest: (op, options) => {
    if (!op || !op.id) return;
    const state = get();
    const prev = state.byId[op.id] ?? state.recent.find((item) => item.id === op.id);
    // 乱序/重复：旧事件不得覆盖新状态，更不得把终态改回 running。
    if (prev && (isOlder(op, prev) || (op.updatedAt === prev.updatedAt && op.status === prev.status))) {
      return;
    }
    const flash = options?.flash ?? true;
    const previousKey = prev ? operationResourceKey(prev) : "";
    const nextKey = operationResourceKey(op);
    const byId: Record<string, AgentOperation> = { ...state.byId };

    let recent = state.recent;
    if (op.status === "running") {
      byId[op.id] = op;
      scheduleFlashExpiry(op.id, op.status);
    } else {
      // 终态始终进入「最近记录」，供活动面板与历史查看。
      recent = [op, ...state.recent.filter((item) => item.id !== op.id)].slice(0, RECENT_LIMIT);
      if (flash) {
        byId[op.id] = op;
        scheduleFlashExpiry(op.id, op.status);
      } else {
        // 启动恢复：历史终态不进入资源索引，避免无关卡片在启动时集体闪一下。
        delete byId[op.id];
        flashDeadlines.delete(op.id);
        clearFlashTimer(op.id);
      }
    }

    // 同一操作换了资源（新建 → 绑定真实 ID）：旧 key 也要剔除。
    const index: Record<string, AgentOperation[]> = { ...state.index };
    const affected = new Set<string>();
    if (previousKey) affected.add(previousKey);
    if (nextKey) affected.add(nextKey);
    const now = Date.now();
    for (const key of affected) {
      const ops = Object.values(byId)
        .filter((item) => operationResourceKey(item) === key && isVisible(item, now))
        .sort(byUpdatedDesc);
      // 只有受影响的资源拿到新数组，其他列表保持引用稳定。
      if (ops.length > 0) index[key] = ops;
      else delete index[key];
    }

    const lists = buildLists(byId);
    set({
      byId,
      index,
      active: lists.active,
      activeCount: lists.active.length,
      recent,
    });
  },

  expire: (id) => {
    const state = get();
    const op = state.byId[id];
    if (!op || op.status === "running") return;
    const byId = { ...state.byId };
    delete byId[id];
    const key = operationResourceKey(op);
    const index = { ...state.index };
    if (key) {
      const ops = (index[key] ?? []).filter((item) => item.id !== id);
      if (ops.length > 0) index[key] = ops;
      else delete index[key];
    }
    set({ byId, index });
  },

  syncNow: async () => {
    if (inflightSync) return inflightSync;
    set({ syncing: true });
    inflightSync = (async () => {
      try {
        const result = await agentOperationsSync(get().cursor, 50);
        // 首次恢复（无游标）只把历史终态放进「最近记录」，不触发资源闪烁；
        // 之后的增量与实时事件一样，按真实变更闪烁。
        const bootstrap = get().cursor === null;
        for (const op of result.operations) get().ingest(op, { flash: !bootstrap });
        set({
          cursor: result.cursor,
          syncing: false,
          error: null,
          lastSyncAt: Date.now(),
        });
      } catch (error) {
        set({
          syncing: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        inflightSync = null;
      }
    })();
    return inflightSync;
  },

  reset: () => {
    for (const timer of flashTimers.values()) clearTimeout(timer);
    flashTimers.clear();
    flashDeadlines.clear();
    set({
      byId: {},
      index: {},
      active: [],
      recent: [],
      activeCount: 0,
      cursor: null,
      syncing: false,
      error: null,
      lastSyncAt: 0,
    });
  },
}));

// ── 单例同步（事件 + 低频游标）──────────────────────────────────

let inflightSync: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityBound = false;

function schedulePoll(delay: number): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    if (hidden) {
      // 应用不可见：不发起查询，只保留一个很轻的检查点。
      schedulePoll(POLL_IDLE_MS);
      return;
    }
    void useAgentOperationsStore
      .getState()
      .syncNow()
      .finally(() => {
        const active = useAgentOperationsStore.getState().activeCount;
        schedulePoll(active > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS);
      });
  }, delay);
  // 不阻止进程退出（Node/测试环境）。
  (pollTimer as unknown as { unref?: () => void }).unref?.();
}

/**
 * 幂等启动：注册事件监听 + 首次游标恢复 + 可见期低频同步。
 * 应用根部调用一次；页面组件不得自行调用 listen 或轮询。
 */
export function ensureAgentOperationSync(): void {
  // 浏览器预览 / 单元测试没有 Tauri IPC：不注册监听、不轮询，页面照常渲染。
  if (!isTauri()) return;
  const state = useAgentOperationsStore.getState();
  if (!state.subscribed) {
    useAgentOperationsStore.setState({ subscribed: true });
    try {
      onAgentOperationChanged((payload) =>
        useAgentOperationsStore.getState().ingest(payload),
      ).catch(() => {
        // 监听注册失败：保留游标同步，不视为致命错误。
        useAgentOperationsStore.setState({ subscribed: false });
      });
    } catch {
      useAgentOperationsStore.setState({ subscribed: false });
    }
  }
  if (!visibilityBound && typeof document !== "undefined") {
    visibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        // 回到前台立即补一次，缩短「错过事件」的窗口。
        schedulePoll(0);
      }
    });
  }
  schedulePoll(0);
}

/** 测试与热重载：停止同步、清空状态，不影响数据库。 */
export function resetAgentOperationSync(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  inflightSync = null;
  useAgentOperationsStore.setState({ subscribed: false });
  useAgentOperationsStore.getState().reset();
}

/** 资源维度查询（供 hook 使用的稳定空数组）。 */
export function selectResourceOperations(
  state: AgentOperationsState,
  key: string,
): AgentOperation[] {
  return key ? (state.index[key] ?? EMPTY) : EMPTY;
}

export const EMPTY_OPERATIONS = EMPTY;
