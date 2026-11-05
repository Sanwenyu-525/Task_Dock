//! 导航 Store：应用扫描缓存、任务关联映射、目标清单。
//!
//! 运行状态按需刷新（不轮询）：loadTaskLinks 在任务刷新/窗口打开选择器时调用；
//! 扫描带 5 分钟后端缓存，这里不再额外加定时器，避免常驻开销。
//!
//! **刷新结果契约**：三个 load 函数都返回 `RefreshOutcome`，调用方必须用返回值区分
//! 「本次成功 / 被更新的请求取代 / 失败」，不得在 `await` 后读取 store 旧状态推断成功：
//! - `ok`：本次请求结果已写入 store；
//! - `stale`：已有更新的请求（代际更大）在途或已落地，本次结果不写入，也不应报错；
//! - `error`：本次请求失败，旧数据保留，错误原因写入对应 `*Error` 字段供 UI 展示与重试。

import { create } from "zustand";
import {
  navAllTaskLinks,
  navListTargets,
  navScanApps,
  onNavScanBatch,
  type AppScanResult,
  type DiscoveredApp,
  type NavTarget,
  type TaskNavLink,
} from "../lib/navigation";
import { errorMessage } from "../lib/errors";

/** 单次刷新结果：调用方据此区分持久化成功与界面刷新失败。 */
export type RefreshOutcome = "ok" | "stale" | "error";

/** 请求代际：只接受最新一次请求的结果（旧响应不得覆盖新数据）。 */
let targetsSeq = 0;
let linksSeq = 0;
let scanSeq = 0;

/** 渐进扫描进度：只展示真实信息（来源完成数），不适配虚假百分比。 */
export interface ScanProgress {
  /** 本次扫描累计发现数（含已推送批次） */
  discovered: number;
  sourcesDone: number;
  sourcesTotal: number;
  batches: number;
}

/**
 * 扫描状态机（显式建模，UI 不再用 `scan === null && scanning` 之类的组合推断）：
 * - `unscanned`：从未扫描，也不在扫描；
 * - `scanning-empty`：扫描中且尚无任何可用结果（含首个空批次）；
 * - `scanning-partial`：扫描中但已有可用结果（首批结果或重扫时的上次完整结果），
 *   列表继续接收新批次；
 * - `complete`：本次/上次结果完整可用（刷新失败但上次结果完整也归入此态，另有提示）；
 * - `partial`：结果可用但不完整（首次扫描中途失败，或本轮刷新后标明部分来源失败）；
 * - `failed`：没有任何可用结果（首次扫描直接失败）。
 */
export type ScanState =
  | "unscanned"
  | "scanning-empty"
  | "scanning-partial"
  | "complete"
  | "partial"
  | "failed";

/**
 * 由扫描字段派生状态。空批次不会把 `scan` 置为非 null，因此不会提前翻成
 * `complete`；`scanning` 优先，确保「后续来源仍在扫」时不显示完成。
 * `incomplete` 由调用方根据 `scan.diagnostics` 判定（部分来源失败的诊断）。
 */
export function deriveScanState(input: {
  scan: AppScanResult | null;
  scanning: boolean;
  scanError: string | null;
  scanPartial: boolean;
  incomplete?: boolean;
}): ScanState {
  if (input.scan === null) {
    if (input.scanning) return "scanning-empty";
    return input.scanError !== null ? "failed" : "unscanned";
  }
  if (input.scanning) return "scanning-partial";
  if (input.incomplete || (input.scanPartial && input.scanError !== null)) return "partial";
  return "complete";
}

/** 按 app_key 去重并按名称稳定排序，保证批次追加时列表顺序不抖动。 */
function mergeProgressiveApps(apps: Map<string, DiscoveredApp>): DiscoveredApp[] {
  return [...apps.values()].sort((a, b) => {
    const byName = a.display_name.toLowerCase().localeCompare(b.display_name.toLowerCase());
    if (byName !== 0) return byName;
    return a.app_key < b.app_key ? -1 : a.app_key > b.app_key ? 1 : 0;
  });
}

export const useNavigationStore = create<{
  /** 软件扫描结果（null = 未加载） */
  scan: AppScanResult | null;
  scanning: boolean;
  /** 扫描最近一次失败原因；null = 无错误。失败时保留旧扫描结果，但 UI 必须可见并可重试 */
  scanError: string | null;
  /** 扫描期间的真实进度（已发现数 / 已扫描来源）；未扫描或完成后为 null */
  scanProgress: ScanProgress | null;
  /** 当前 scan 是否为渐进批次拼出的不完整结果（首次扫描中 / 首次扫描中途失败） */
  scanPartial: boolean;
  /** 全部导航目标 */
  targets: NavTarget[];
  targetsLoaded: boolean;
  /** 目标清单最近一次读取的错误；null = 无错误。失败时旧 targets 原样保留 */
  targetsError: string | null;
  /** taskId → 关联目标（含实时运行状态） */
  linksByTask: Record<string, TaskNavLink[]>;
  /** 关联关系读取失败原因；失败时保留旧映射并标记「可能不是最新」 */
  linksError: string | null;
  /** 选择器等 UI 打开状态（AppPicker 挂载用） */
  picker: { open: boolean; taskId: string | null };
  openPicker: (taskId: string | null) => void;
  closePicker: () => void;
  loadApps: (force?: boolean) => Promise<RefreshOutcome>;
  loadTargets: (force?: boolean) => Promise<RefreshOutcome>;
  loadTaskLinks: () => Promise<RefreshOutcome>;
}>((set, get) => ({
  scan: null,
  scanning: false,
  scanError: null,
  scanProgress: null,
  scanPartial: false,
  targets: [],
  targetsLoaded: false,
  targetsError: null,
  linksByTask: {},
  linksError: null,
  picker: { open: false, taskId: null },
  openPicker: (taskId) => set({ picker: { open: true, taskId } }),
  closePicker: () => set({ picker: { open: false, taskId: null } }),

  loadApps: async (force = false) => {
    // 已有扫描在途：本次不再叠加请求；调用方把结果视为「由在途请求负责」。
    if (get().scanning) return "stale";
    const seq = ++scanSeq;
    // 请求身份：后端原样回传，用于过滤旧扫描残留的批次事件。
    const scanId = `scan-${seq}-${Date.now().toString(36)}`;
    // 只有「上次是完整权威结果」时才保留旧列表；首次扫描的部分结果在重试时重建。
    const keepPrevious = get().scan !== null && !get().scanPartial;
    const merged = new Map<string, DiscoveredApp>();
    let unlisten: (() => void) | null = null;
    set({
      scanning: true,
      scanError: null,
      scanProgress: { discovered: 0, sourcesDone: 0, sourcesTotal: 0, batches: 0 },
      scanPartial: !keepPrevious,
    });
    try {
      // 先订阅再发起扫描，避免首批结果早于监听注册而丢失。
      unlisten = await onNavScanBatch((batch) => {
        if (seq !== scanSeq || batch.scan_id !== scanId) return;
        for (const a of batch.apps) {
          if (a.app_key) merged.set(a.app_key, a);
        }
        const update: Partial<ReturnType<typeof get>> = {
          scanProgress: {
            discovered: batch.discovered,
            sourcesDone: batch.sources_done,
            sourcesTotal: batch.sources_total,
            batches: (get().scanProgress?.batches ?? 0) + 1,
          },
        };
        // 已有完整结果时只补充进度，不替换列表（避免重扫期间列表抖动/清空）。
        // 空批次（定位到 0 个应用）只推进进度，绝不创建 scan——否则界面会把
        // 「扫描仍在进行、尚无结果」误判成「扫描完成、未发现应用」。
        if (!keepPrevious && merged.size > 0) {
          update.scan = {
            apps: mergeProgressiveApps(merged),
            scanned_at: "",
            duration_ms: 0,
            counts: {},
            diagnostics: {},
          };
        }
        set(update);
      });
      if (seq !== scanSeq) return "stale";
      const scan = await navScanApps(force, scanId);
      if (seq !== scanSeq) return "stale";
      // 最终权威结果收敛列表、计数与诊断，避免渐进阶段的数据长期残留。
      set({ scan, scanError: null, scanProgress: null, scanPartial: false });
      return "ok";
    } catch (e) {
      if (seq !== scanSeq) return "stale";
      // 首次扫描中途失败：保留已发现的部分结果并明确标记「不完整」；
      // 已有完整结果时保留上次结果。
      set({
        scanError: errorMessage(e),
        scanProgress: null,
        scanPartial: !keepPrevious && get().scan !== null,
      });
      return "error";
    } finally {
      unlisten?.();
      // 只允许最新请求收起 loading，避免旧请求提前把新请求的 scanning 置回 false。
      if (seq === scanSeq) set({ scanning: false });
    }
  },

  loadTargets: async (_force = false) => {
    // 请求序号防竞态：保存/删除后连续触发多次刷新时，旧响应不得覆盖新数据。
    const seq = ++targetsSeq;
    try {
      const targets = await navListTargets(true);
      if (seq !== targetsSeq) return "stale";
      set({ targets, targetsLoaded: true, targetsError: null });
      return "ok";
    } catch (e) {
      if (seq !== targetsSeq) return "stale";
      // 读取失败必须可见：面板据此显示错误态 + 重试，
      // 不能静默保旧值（或空数组）伪装成「尚未配置应用」。
      set({ targetsError: errorMessage(e) });
      return "error";
    }
  },

  loadTaskLinks: async () => {
    const seq = ++linksSeq;
    try {
      const links = await navAllTaskLinks();
      if (seq !== linksSeq) return "stale";
      const map: Record<string, TaskNavLink[]> = {};
      for (const l of links) {
        (map[l.task_id] ??= []).push(l);
      }
      for (const list of Object.values(map)) {
        list.sort((a, b) => a.display_order - b.display_order);
      }
      set({ linksByTask: map, linksError: null });
      return "ok";
    } catch (e) {
      if (seq !== linksSeq) return "stale";
      // 保持旧映射，但记录错误：抽屉/选择器据此提示「关联信息可能不是最新」
      set({ linksError: errorMessage(e) });
      return "error";
    }
  },
}));
