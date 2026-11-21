//! Agent 操作统一状态（v86 / v86.1）：全应用只在这里合并操作事件与数据库游标。
//!
//! 设计约束（见 `docs/agent-workspace/operation-visualization.md`）：
//! - **数据库是事实来源**：事件只做低延迟更新，丢失/乱序由游标同步补齐；
//! - 按 `operationId` 合并，同一操作重复事件不产生第二条记录；
//! - **先看状态版本，再看时间**：`stateRevision` 高于当前才接受；相同版本但内容不同
//!   一律拒绝并记诊断（说明有第二套写入路径或事件被伪造）；旧数据无版本时退回
//!   `updatedAt` 比较；
//! - **终态不可回退**：`committed/failed/conflict` 不会再变回 `running`；
//!   `interrupted → committed` 只允许真实恢复（后端在业务提交后才会这样写）；
//! - 资源索引按 key 局部重建，未受影响的资源保持原数组引用，避免整列表重渲染；
//! - 只有本 store 维持低频同步：页面不得各自轮询、不得各自监听 Tauri 事件；
//! - 同步按 `hasMore` 连续读取，但**单轮有固定页数上限**，不会无限循环；
//! - 页面隐藏时不同步；应用启动时先恢复**全部运行中操作**，已结束的操作
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
/**
 * 可见期的同步间隔：独立 CLI 只能靠它被感知。
 * 4s 是「感知及时」与「一次索引查询」之间的折中；隐藏时完全停止查询。
 */
const POLL_VISIBLE_MS = 4000;
/** 隐藏时的检查点间隔（只检查可见性，不发查询）。 */
const POLL_HIDDEN_MS = 20000;
/** 单页条数（后端上限 100）。 */
const SYNC_PAGE = 100;
/** 单轮最多连续读取页数：高频事件下也能收敛，但不会占满一次轮询。 */
const MAX_SYNC_PAGES = 5;

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

function byUpdatedDesc(a: AgentOperation, b: AgentOperation): number {
  const delta = timeOf(b.updatedAt) - timeOf(a.updatedAt);
  return delta !== 0 ? delta : a.id.localeCompare(b.id);
}

/**
 * 合法状态转换（与后端 UPDATE 的 WHERE 条件保持一致）：
 * - `running` 可以进入任意终态；
 * - `interrupted` 允许被**真实结果**修正为 committed/failed/conflict（业务提交后恢复、
 *   迟到的失败结果），但不能回到 running；
 * - committed/failed/conflict 是最终结论，只能保持自身。
 */
const LEGAL_TRANSITIONS: Record<AgentOperationStatus, readonly AgentOperationStatus[]> = {
  running: ["running", "committed", "failed", "conflict", "interrupted"],
  interrupted: ["interrupted", "committed", "failed", "conflict"],
  committed: ["committed"],
  failed: ["failed"],
  conflict: ["conflict"],
};

export function isLegalStatusTransition(
  prev: AgentOperationStatus,
  next: AgentOperationStatus,
): boolean {
  return LEGAL_TRANSITIONS[prev]?.includes(next) ?? false;
}

/** 合并结论（导出以便单测与诊断）。 */
export type MergeDecision =
  | "apply"
  | "duplicate"
  | "stale"
  | "illegal-transition"
  | "same-revision-conflict";

/** 两条记录除时间/版本外是否描述同一状态（用于去重与同版本冲突判定）。 */
function samePayload(a: AgentOperation, b: AgentOperation): boolean {
  return (
    a.status === b.status &&
    a.phase === b.phase &&
    a.resourceKind === b.resourceKind &&
    a.resourceId === b.resourceId &&
    a.projectId === b.projectId &&
    (a.revision ?? null) === (b.revision ?? null) &&
    a.errorCode === b.errorCode &&
    a.detail === b.detail
  );
}

/**
 * 决定一条新记录是否覆盖已有记录。
 *
 * 顺序很重要：
 * 1. `stateRevision` 两侧都有 → 只认版本；相同版本内容不同 → 拒绝（并记录诊断）；
 * 2. 任一侧没有版本（旧后端/旧事件）→ 退回 `updatedAt`；
 * 3. 最后才看状态转换：即使版本更新，`committed → running` 也必须拒绝。
 */
export function decideMerge(prev: AgentOperation, next: AgentOperation): MergeDecision {
  const prevRev = prev.stateRevision;
  const nextRev = next.stateRevision;
  if (typeof prevRev === "number" && typeof nextRev === "number") {
    if (nextRev < prevRev) return "stale";
    if (nextRev === prevRev) {
      // 心跳不推进版本；同版本同内容就是重复事件（只刷新最新时间戳）。
      if (samePayload(prev, next)) return "duplicate";
      // 同版本不同内容：说明有人绕过了状态机或两个入口写了同一操作。
      return "same-revision-conflict";
    }
    return isLegalStatusTransition(prev.status, next.status) ? "apply" : "illegal-transition";
  }
  const nextAt = timeOf(next.updatedAt);
  const prevAt = timeOf(prev.updatedAt);
  if (nextAt && prevAt && nextAt < prevAt) return "stale";
  if (nextAt === prevAt && prev.updatedAt === next.updatedAt && samePayload(prev, next)) {
    return "duplicate";
  }
  return isLegalStatusTransition(prev.status, next.status) ? "apply" : "illegal-transition";
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
  /** 最近一次同步实际读取的页数（诊断高频事件是否被页数上限截断）。 */
  lastSyncPages: number;
  /** 被拒绝的合并次数（乱序/非法回退/同版本冲突），用于诊断而不是影响 UI。 */
  mergeRejections: number;
  /** 最近一次拒绝原因（`stale@opId` 之类，直接可读）。 */
  lastMergeIssue: string;
  /** 合并一条操作（事件或同步结果）。重复与乱序在此处收敛。
   *  `flash=false` 用于启动恢复：历史终态只进「最近记录」，不在资源上闪一下。 */
  ingest: (op: AgentOperation, options?: { flash?: boolean }) => void;
  /** 短暂停留结束：只从索引与 byId 移除，历史仍保留在 recent。 */
  expire: (id: string) => void;
  /** 单飞游标同步：并发调用复用同一请求；hasMore 时连续读取，页数有上限。 */
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
  lastSyncPages: 0,
  mergeRejections: 0,
  lastMergeIssue: "",

  ingest: (op, options) => {
    if (!op || !op.id) return;
    const state = get();
    const prev = state.byId[op.id] ?? state.recent.find((item) => item.id === op.id);
    if (prev) {
      const decision = decideMerge(prev, op);
      if (decision !== "apply") {
        if (decision === "duplicate") {
          // 重复事件：只刷新时间戳，保持引用与列表稳定（高频事件下不反复重渲染）。
          if (prev.updatedAt !== op.updatedAt) {
            const refreshed = { ...prev, updatedAt: op.updatedAt };
            const byId = state.byId[op.id]
              ? { ...state.byId, [op.id]: refreshed }
              : state.byId;
            const recent = state.recent.some((item) => item.id === op.id)
              ? state.recent.map((item) => (item.id === op.id ? refreshed : item))
              : state.recent;
            set({ byId, recent });
          }
          return;
        }
        // 乱序/非法回退/同版本冲突：一律不覆盖，并留下可诊断的计数与原因。
        set({
          mergeRejections: state.mergeRejections + 1,
          lastMergeIssue: `${decision}@${op.id}`,
        });
        if (import.meta.env.DEV) {
          console.warn(
            `[agent-operation] 拒绝合并 ${decision}: ${op.id} ${prev.status}#${prev.stateRevision ?? "-"} ← ${op.status}#${op.stateRevision ?? "-"}`,
          );
        }
        return;
      }
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
      // 每页成功后才推进本地游标：中途失败时下一次从上一页末尾继续，不跳行也不重放。
      let cursor = get().cursor;
      const bootstrap = cursor === null;
      let pages = 0;
      try {
        for (;;) {
          const result = await agentOperationsSync(cursor, SYNC_PAGE);
          const batch = result.operations ?? [];
          // 首次恢复（无游标）只把历史终态放进「最近记录」，不触发资源闪烁；
          // 之后的增量与实时事件一样，按真实变更闪烁。
          for (const op of batch) get().ingest(op, { flash: !bootstrap });
          const advanced =
            !!result.cursor &&
            (!cursor ||
              result.cursor.updatedAt !== cursor.updatedAt ||
              result.cursor.id !== cursor.id);
          if (result.cursor) cursor = result.cursor;
          pages += 1;
          // 页数上限保证高频事件不会让一次轮询无限循环；剩余部分下一轮继续。
          if (!result.hasMore || pages >= MAX_SYNC_PAGES || !advanced) break;
        }
        set({
          cursor,
          syncing: false,
          error: null,
          lastSyncAt: Date.now(),
          lastSyncPages: pages,
        });
      } catch (error) {
        // 失败不回退已经合并的状态；游标停在最后一页成功的位置，下次继续。
        set({
          cursor,
          syncing: false,
          error: error instanceof Error ? error.message : String(error),
          lastSyncPages: pages,
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
      lastSyncPages: 0,
      mergeRejections: 0,
      lastMergeIssue: "",
    });
  },
}));

// Dev 专用只读句柄：验收脚本据此读取**应用真实实例**。
// 不能靠动态 import：Vite 在 HMR 后会给依赖加 `?t=`，再 import 会得到第二个实例。
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__AGENT_OP_STORE__ = useAgentOperationsStore;
}

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
      schedulePoll(POLL_HIDDEN_MS);
      return;
    }
    void useAgentOperationsStore
      .getState()
      .syncNow()
      .finally(() => schedulePoll(POLL_VISIBLE_MS));
  }, delay);
  // 不阻止进程退出（Node/测试环境）。
  (pollTimer as unknown as { unref?: () => void }).unref?.();
}

/**
 * 幂等启动：注册事件监听 + 首次游标恢复 + 可见期低频同步。
 * 应用根部调用一次；页面组件不得自行调用 listen 或轮询。
 */
export function ensureAgentOperationSync(): void {
  // Dev 专用只读标记：定位启动时序；生产构建中不存在。
  if (import.meta.env.DEV && typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__AGENT_OP_BOOT__ = {
      at: Date.now(),
      tauri: isTauri(),
      href: location.href,
    };
  }
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
