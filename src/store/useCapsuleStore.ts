//! 分类胶囊的 UI 状态（zustand）。
//!
//! 只保存**纯 UI 选择**：当前展开的功能分类。窗口相位（折叠/展开）仍由
//! `useEdgeSnapStore` 的 phase 唯一决定，引擎是唯一写入方——这里不复制
//! 第二套状态源，也不缓存任何业务数据（任务/Agent/剪贴板都直接读各自 store）。

import { create } from "zustand";
import type { RailCategory } from "../lib/capsuleModel";

/** 首次展开且从未选择过分类时的默认入口（方案 D：任务）。 */
export const DEFAULT_CAPSULE_CATEGORY: RailCategory = "tasks";

export const useCapsuleStore = create<{
  /** 当前展开的分类；null = 只显示轨道（折叠态） */
  active: RailCategory | null;
  /** 最近一次有效选择：展开态兜底与「保留用户最近选择」的依据 */
  lastActive: RailCategory | null;
  /** 切换分类：同一分类再次点击 = 收起（返回 null） */
  select: (c: RailCategory) => RailCategory | null;
  /** 直接设定（Esc/收起按钮 → null） */
  setActive: (c: RailCategory | null) => void;
  /** 展开态兜底：当前无有效分类时回到最近选择，从未选过则用默认入口。
   *  托盘 / 全局热键 / 重启恢复只切窗口相位，不经过分类点击，
   *  必须由这里保证「展开态总有明确分类」，否则会出现空白面板。 */
  ensureActive: () => void;
}>((set, get) => ({
  active: null,
  lastActive: null,
  select: (c) => {
    const next = get().active === c ? null : c;
    if (next === null) set({ active: null });
    else set({ active: next, lastActive: next });
    return next;
  },
  setActive: (c) => (c === null ? set({ active: null }) : set({ active: c, lastActive: c })),
  ensureActive: () => {
    if (get().active !== null) return;
    set({ active: get().lastActive ?? DEFAULT_CAPSULE_CATEGORY });
  },
}));