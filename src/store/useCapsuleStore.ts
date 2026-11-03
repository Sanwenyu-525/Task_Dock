//! 分类胶囊的 UI 状态（zustand）。
//!
//! 只保存**纯 UI 选择**：展开哪个功能分类。窗口相位（折叠/展开）由
//! `useEdgeSnapStore` 的 phase 唯一决定，引擎是唯一写入方——这里不复制第二套
//! 状态源，也不缓存任何业务数据（任务/Agent/剪贴板都直接读各自 store）。
//!
//! 分类**恒有值**，收起面板时不清空：面板可见性只看相位。
//! 曾经用 `active = null` 兼作「折叠态」，于是同一个事实写进了两处，而两处的提交
//! 时机不同——`active` 立刻清空、相位要等 Win32 区域写回来才推进。中间那一帧
//! `expanded` 仍为真、`active` 已为空，渲染兜底就会把面板闪成另一个分类。

import { create } from "zustand";
import type { CapsuleCategory } from "../lib/capsuleModel";

/** 从未选择过分类时，展开所用的默认入口（方案 D：任务）。 */
export const DEFAULT_CAPSULE_CATEGORY: CapsuleCategory = "tasks";

export const useCapsuleStore = create<{
  /** 当前（收起后即「最近一次」）展开的分类；是否显示面板由相位决定，与此无关 */
  active: CapsuleCategory;
  setActive: (c: CapsuleCategory) => void;
}>((set) => ({
  active: DEFAULT_CAPSULE_CATEGORY,
  setActive: (c) => set({ active: c }),
}));
