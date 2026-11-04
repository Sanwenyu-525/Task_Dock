export interface RailEntry {
  readonly id: string;
  readonly label: string;
  /** 逻辑 Tab 快捷键；无快捷键的仅视觉入口为空字符串 */
  readonly shortcut: string;
  /** 该视觉入口覆盖的逻辑 Tab（v0.8 起合并入口覆盖 ["inbox","shelf"]，其余 1:1） */
  readonly tabs?: readonly string[];
}

/** 逻辑 Tab 顺序（= useUiStore.TAB_ORDER；快捷键 Ctrl+1…9 的事实源） */
export declare const LOGICAL_TABS: readonly string[];
/** 仅视觉入口、不占快捷键的 Tab（= useUiStore.RAIL_ORDER 中不属于 TAB_ORDER 的部分） */
export declare const RAIL_ONLY_TABS: readonly string[];
export declare const RAIL_ENTRIES: readonly RailEntry[];
export declare const RAIL_ITEM_COUNT: number;
export declare const RAIL_LABELS: readonly string[];
export declare const RAIL_ADD_BUTTON: {
  readonly selector: string;
  readonly ariaLabel: string;
  readonly tip: string;
};
