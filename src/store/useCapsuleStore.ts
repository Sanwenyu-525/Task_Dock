//! 分类胶囊的 UI 状态（zustand）。
//!
//! 只保存**纯 UI 选择**：当前展开的功能分类。窗口相位（折叠/展开）仍由
//! `useEdgeSnapStore` 的 phase 唯一决定，引擎是唯一写入方——这里不复制
//! 第二套状态源，也不缓存任何业务数据（任务/Agent/剪贴板都直接读各自 store）。

import { create } from "zustand";
import type { RailCategory } from "../lib/capsuleModel";

export const useCapsuleStore = create<{
  /** 当前展开的分类；null = 只显示轨道（折叠态） */
  active: RailCategory | null;
  /** 切换分类：同一分类再次点击 = 收起（返回 null） */
  select: (c: RailCategory) => RailCategory | null;
  /** 直接设定（Esc/收起按钮 → null） */
  setActive: (c: RailCategory | null) => void;
}>((set, get) => ({
  active: null,
  select: (c) => {
    const next = get().active === c ? null : c;
    set({ active: next });
    return next;
  },
  setActive: (c) => set({ active: c }),
}));
