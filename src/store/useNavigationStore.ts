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
  type AppScanResult,
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

export const useNavigationStore = create<{
  /** 软件扫描结果（null = 未加载） */
  scan: AppScanResult | null;
  scanning: boolean;
  /** 扫描最近一次失败原因；null = 无错误。失败时保留旧扫描结果，但 UI 必须可见并可重试 */
  scanError: string | null;
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
    set({ scanning: true });
    try {
      const scan = await navScanApps(force);
      if (seq !== scanSeq) return "stale";
      set({ scan, scanError: null });
      return "ok";
    } catch (e) {
      if (seq !== scanSeq) return "stale";
      // 保留旧扫描结果，但记录失败原因——否则选择器会永远停在「加载中」。
      set({ scanError: errorMessage(e) });
      return "error";
    } finally {
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
