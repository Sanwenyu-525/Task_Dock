export interface RailEntry {
  readonly id: string;
  readonly label: string;
  /** 逻辑 Tab 快捷键；合并入口声明覆盖的两个快捷键（如 "Ctrl+5 / Ctrl+6"） */
  readonly shortcut: string;
  /** 该视觉入口覆盖的逻辑 Tab（v0.8 起合并入口覆盖 ["inbox","shelf"]，其余 1:1） */
  readonly tabs?: readonly string[];
}

/** 逻辑 Tab 顺序（= useUiStore.TAB_ORDER；快捷键 Ctrl+1…9 的事实源） */
export declare const LOGICAL_TABS: readonly string[];
export declare const RAIL_ENTRIES: readonly RailEntry[];
export declare const RAIL_ITEM_COUNT: number;
export declare const RAIL_LABELS: readonly string[];
export declare const RAIL_ADD_BUTTON: {
  readonly selector: string;
  readonly ariaLabel: string;
  readonly tip: string;
};
