//! 快捷投递目标的 UI 状态（zustand）。
//!
//! 为什么放在 store 而不是面板组件里：
//! - 投递是大文件操作，可能持续数秒到数分钟；胶囊面板会因收起/切页/解除吸附而卸载，
//!   结果必须活过组件生命周期，不能在卸载后丢失或对已卸载组件 setState；
//! - 工具面板与完整面板**共享同一份配置**（同一后端表），由同一 store 缓存，
//!   避免两处各自加载、各自刷新后出现「这边改了那边没变」。
//!
//! 约束：
//! - 不做轮询；目录可用性有 TTL 缓存（`AVAILABILITY_TTL_MS`），面板打开时过期才
//!   后台重探一次，用户手动刷新 / 投递前的「看起来不可用」会强制重探；
//! - 网络盘探测由后端在阻塞线程里做，前端渲染过程不碰磁盘；
//! - 同一目标同时只允许一个在途批次；相同路径的重复提交在 700ms 内直接忽略
//!   （双击 / 事件重复的兜底），不做队列堆积；
//! - 与暂存架 `useShelfStore` 完全独立：投递**不创建**暂存记录。

import { create } from "zustand";
import {
  shelfDropTargetCreate,
  shelfDropTargetDelete,
  shelfDropTargetMove,
  shelfDropTargetOpen,
  shelfDropTargetUpdate,
  shelfDropTargets,
  shelfDropToDirectory,
  type DropTargetOpMode,
  type ShelfConflictStrategy,
  type ShelfDropReport,
  type ShelfDropTarget,
  type ShelfDropTargetPatch,
} from "../lib/bridge";
import { errorMessage } from "../lib/errors";

/** 在途批次（进度未知，只展示真实条数，不伪造百分比）。 */
export interface DropOpState {
  targetId: string;
  total: number;
  startedAt: number;
}

export interface DropTargetDraft {
  name?: string;
  path: string;
  opMode?: DropTargetOpMode;
  conflict?: ShelfConflictStrategy;
  showInCapsule?: boolean;
}

interface DropTargetsState {
  targets: ShelfDropTarget[];
  loading: boolean;
  /** 是否完成过一次成功加载（决定空态文案，不等于可用性是最新的） */
  loaded: boolean;
  /** 最近一次成功探测目录可用性的时间戳；过期后允许后台重探 */
  lastProbeAt: number | null;
  error: string | null;
  ops: Record<string, DropOpState>;
  /** 每个目标最近一次结果（卸载/重开面板后仍可查看） */
  reports: Record<string, ShelfDropReport>;
  /** 结果产生时的目标名：目标被移除后仍能说明「是哪次投递」 */
  reportNames: Record<string, string>;
  /** 最近一次产生结果的目标 id，用于汇总条定位 */
  lastTargetId: string | null;
  /** 完整面板「管理目标」的一次性意图（胶囊里点击「管理」时置位） */
  manageRequest: number;

  load: (opts?: { force?: boolean }) => Promise<void>;
  create: (draft: DropTargetDraft) => Promise<ShelfDropTarget>;
  update: (id: string, patch: ShelfDropTargetPatch) => Promise<ShelfDropTarget>;
  remove: (id: string) => Promise<void>;
  move: (id: string, direction: "up" | "down") => Promise<void>;
  openDir: (id: string) => Promise<void>;
  /** 投递一批路径；返回报告（被守卫拦下时返回 null） */
  drop: (targetId: string, paths: string[]) => Promise<ShelfDropReport | null>;
  clearReport: (targetId: string) => void;
  requestManage: () => void;
  consumeManage: () => void;
}

/** 重复提交窗口：双击、拖拽事件重复到达都在这个窗口内被合并。 */
const DUPLICATE_WINDOW_MS = 700;

/**
 * 目录可用性缓存 TTL：外接盘重连、网络共享恢复都要能在合理时间内反映出来，
 * 但也不能每次切面板都去探测网络盘（探测在阻塞线程里可能耗时数秒）。
 */
export const AVAILABILITY_TTL_MS = 30_000;

let lastSubmit: { key: string; at: number } | null = null;

/** 请求代次：只接受最新一次 `load` 的响应，避免慢响应覆盖新结果。 */
let loadSeq = 0;
/**
 * 写操作代次：`create/update/remove/move` 真正落地后 +1。
 *
 * 场景：`load` 已经发出 → 用户新增/编辑/删除/排序成功并把结果写进 store →
 * 早先的 `load` 才返回。它带的是**写操作之前**的快照，直接应用会把刚完成的
 * 配置回滚（新增消失、删除复活、排序复原）。所以 load 在发起时记下写代次，
 * 响应回来时若代次已变，就丢弃这份快照。
 */
let mutationSeq = 0;

/**
 * 丢弃过期快照后允许的重试次数：一次 `load` 最多再发一次请求。
 * 有界重试保证「强制刷新最终能看到后端权威数据」，又不会在用户连续操作时形成请求风暴。
 */
const LOAD_RETRY_LIMIT = 1;

function bumpMutation(): void {
  mutationSeq += 1;
}

function availabilityFresh(lastProbeAt: number | null): boolean {
  return lastProbeAt !== null && Date.now() - lastProbeAt < AVAILABILITY_TTL_MS;
}

/** 测试用：清空跨用例的「重复提交」窗口与请求代次（模块级状态，不进 React 树）。 */
export function __resetDropSubmitGuard(): void {
  lastSubmit = null;
  loadSeq = 0;
  mutationSeq = 0;
}

function batchKey(targetId: string, paths: string[]): string {
  return `${targetId}\u0000${paths.join("\u0000")}`;
}

export const useDropTargetsStore = create<DropTargetsState>((set, get) => {
  /**
   * 一次列表加载（内部实现）。
   *
   * 丢弃条件（任一满足都不应用响应）：
   * - `seq !== loadSeq`：已经有更新的 load 发出；
   * - `epoch !== mutationSeq`：等待期间有写操作成功落地，这份快照早于写操作。
   *   此时重试一次拿权威列表；重试后仍被写操作打断则放弃——本地状态已由写操作保证一致。
   */
  const runLoad = async (force: boolean, attempt: number): Promise<void> => {
    if (attempt === 0) {
      const { loading, loaded, lastProbeAt } = get();
      // 已有数据且仍在 TTL 内：不重复探测网络盘
      if (loaded && !force && availabilityFresh(lastProbeAt)) return;
      // 普通加载去重；强制刷新允许打断在途请求（用代次丢弃旧响应）
      if (loading && !force) return;
    }
    const seq = ++loadSeq;
    const epoch = mutationSeq;
    set({ loading: true });
    try {
      const targets = await shelfDropTargets();
      if (seq !== loadSeq) return; // 更新的加载请求已经发出
      if (epoch !== mutationSeq) {
        // 期间有写操作落地：应用这份快照会回滚新增/编辑/删除/排序
        if (attempt < LOAD_RETRY_LIMIT) return runLoad(force, attempt + 1);
        return;
      }
      set({
        targets: Array.isArray(targets) ? targets : [],
        loaded: true,
        lastProbeAt: Date.now(),
        error: null,
      });
    } catch (e) {
      if (seq !== loadSeq) return;
      // 读取失败保留旧列表但明确置错，不伪装成「还没有目标」
      set({ error: errorMessage(e) });
    } finally {
      if (seq === loadSeq) set({ loading: false });
    }
  };

  return {
    targets: [],
    loading: false,
    loaded: false,
    lastProbeAt: null,
    error: null,
    ops: {},
    reports: {},
    reportNames: {},
    lastTargetId: null,
    manageRequest: 0,

    load: (opts) => runLoad(opts?.force === true, 0),

    create: async (draft) => {
      const created = await shelfDropTargetCreate({
        name: draft.name,
        path: draft.path,
        showInCapsule: draft.showInCapsule,
        opMode: draft.opMode,
        conflict: draft.conflict,
      });
      // 写操作成功后才提升代次并落库：在途的旧 load 响应会被丢弃
      bumpMutation();
      set((s) => ({ targets: [...s.targets, created], error: null, loaded: true }));
      return created;
    },

    update: async (id, patch) => {
      const updated = await shelfDropTargetUpdate(id, patch);
      bumpMutation();
      set((s) => ({
        targets: s.targets.map((t) => (t.id === id ? updated : t)),
        error: null,
      }));
      return updated;
    },

    remove: async (id) => {
      await shelfDropTargetDelete(id);
      bumpMutation();
      set((s) => {
        const reports = { ...s.reports };
        const reportNames = { ...s.reportNames };
        const ops = { ...s.ops };
        const report = reports[id];
        // 有失败/部分完成的批次是「需要人工处理」的提示，不能因为移除入口就消失。
        const important = !!report && report.failed + report.partial > 0;
        if (!important) delete reports[id];
        if (!important) delete reportNames[id];
        delete ops[id];
        return {
          targets: s.targets.filter((t) => t.id !== id),
          reports,
          reportNames,
          ops,
          lastTargetId: s.lastTargetId === id && !important ? null : s.lastTargetId,
        };
      });
    },

    move: async (id, direction) => {
      const targets = await shelfDropTargetMove(id, direction);
      if (Array.isArray(targets)) {
        // 后端返回整表并已重新探测可用性：顺带刷新 TTL
        bumpMutation();
        set({ targets, error: null, lastProbeAt: Date.now() });
      }
    },

    openDir: async (id) => {
      await shelfDropTargetOpen(id);
    },

    drop: async (targetId, paths) => {
      const clean = paths.filter((p) => typeof p === "string" && p.trim().length > 0);
      if (clean.length === 0) return null;
      const state = get();
      // 同一目标同时只允许一批：不排队、不并发，避免多批互相覆盖同名文件
      if (state.ops[targetId]) return null;
      const key = batchKey(targetId, clean);
      const now = Date.now();
      if (lastSubmit && lastSubmit.key === key && now - lastSubmit.at < DUPLICATE_WINDOW_MS) {
        return null;
      }
      lastSubmit = { key, at: now };
      // 记下投递时的目标名：目标随后被移除时，结果条仍能说明来源。
      const targetName = state.targets.find((t) => t.id === targetId)?.name ?? "";

      set((s) => ({
        ops: { ...s.ops, [targetId]: { targetId, total: clean.length, startedAt: now } },
        reportNames: { ...s.reportNames, [targetId]: targetName },
      }));
      try {
        const report = await shelfDropToDirectory(targetId, clean, crypto.randomUUID());
        set((s) => {
          const ops = { ...s.ops };
          delete ops[targetId];
          return {
            ops,
            reports: { ...s.reports, [targetId]: report },
            lastTargetId: targetId,
          };
        });
        return report;
      } catch (e) {
        set((s) => {
          const ops = { ...s.ops };
          delete ops[targetId];
          return { ops, error: errorMessage(e) };
        });
        throw e;
      }
    },

    clearReport: (targetId) =>
      set((s) => {
        const reports = { ...s.reports };
        delete reports[targetId];
        const reportNames = { ...s.reportNames };
        delete reportNames[targetId];
        return {
          reports,
          reportNames,
          lastTargetId: s.lastTargetId === targetId ? null : s.lastTargetId,
        };
      }),

    requestManage: () => set((s) => ({ manageRequest: s.manageRequest + 1 })),
    consumeManage: () => set({ manageRequest: 0 }),
  };
});
