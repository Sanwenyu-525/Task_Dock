//! 导航 Store：应用扫描缓存、任务关联映射、目标清单。
//!
//! 运行状态按需刷新（不轮询）：loadTaskLinks 在任务刷新/窗口打开选择器时调用；
//! 扫描带 5 分钟后端缓存，这里不再额外加定时器，避免常驻开销。

import { create } from "zustand";
import {
  navAllTaskLinks,
  navListTargets,
  navScanApps,
  type AppScanResult,
  type NavTarget,
  type TaskNavLink,
} from "../lib/navigation";

export const useNavigationStore = create<{
  /** 软件扫描结果（null = 未加载） */
  scan: AppScanResult | null;
  scanning: boolean;
  /** 全部导航目标 */
  targets: NavTarget[];
  targetsLoaded: boolean;
  /** 目标清单最近一次读取的错误；null = 无错误。失败时旧 targets 原样保留 */
  targetsError: string | null;
  /** taskId → 关联目标（含实时运行状态） */
  linksByTask: Record<string, TaskNavLink[]>;
  /** 选择器等 UI 打开状态（AppPicker 挂载用） */
  picker: { open: boolean; taskId: string | null };
  openPicker: (taskId: string | null) => void;
  closePicker: () => void;
  loadApps: (force?: boolean) => Promise<void>;
  loadTargets: (force?: boolean) => Promise<void>;
  loadTaskLinks: () => Promise<void>;
}>((set, get) => ({
  scan: null,
  scanning: false,
  targets: [],
  targetsLoaded: false,
  targetsError: null,
  linksByTask: {},
  picker: { open: false, taskId: null },
  openPicker: (taskId) => set({ picker: { open: true, taskId } }),
  closePicker: () => set({ picker: { open: false, taskId: null } }),

  loadApps: async (force = false) => {
    if (get().scanning) return;
    set({ scanning: true });
    try {
      const scan = await navScanApps(force);
      set({ scan });
    } catch {
      // 保留旧扫描结果
    } finally {
      set({ scanning: false });
    }
  },

  loadTargets: async (_force = false) => {
    try {
      const targets = await navListTargets(true);
      set({ targets, targetsLoaded: true, targetsError: null });
    } catch (e) {
      // 读取失败必须可见：面板据此显示错误态 + 重试，
      // 不能静默保旧值（或空数组）伪装成「尚未配置应用」。
      set({ targetsError: String(e) });
    }
  },

  loadTaskLinks: async () => {
    try {
      const links = await navAllTaskLinks();
      const map: Record<string, TaskNavLink[]> = {};
      for (const l of links) {
        (map[l.task_id] ??= []).push(l);
      }
      for (const list of Object.values(map)) {
        list.sort((a, b) => a.display_order - b.display_order);
      }
      set({ linksByTask: map });
    } catch {
      // 保持旧映射
    }
  },
}));
