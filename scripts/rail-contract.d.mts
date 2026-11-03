export interface RailEntry {
  readonly id: string;
  readonly label: string;
  readonly shortcut: string;
}

export declare const RAIL_ENTRIES: readonly RailEntry[];
export declare const RAIL_ITEM_COUNT: number;
export declare const RAIL_LABELS: readonly string[];
export declare const RAIL_ADD_BUTTON: {
  readonly selector: string;
  readonly ariaLabel: string;
  readonly tip: string;
};
