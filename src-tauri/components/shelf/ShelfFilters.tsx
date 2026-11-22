//! 暂存架筛选浮层：类型、分组、只看收藏与清除。
//!
//! 只做展示与回调，筛选状态仍由 ShelfWorkspace 的 filter/Store 持有；
//! 使用既有 Popover + 按钮基元，不引入第二套定位或状态源。

import type { ReactNode, RefObject } from "react";
import { Check } from "lucide-react";
import Popover from "../ui/Popover";
import { Switch } from "../ui";
import type { ShelfGroup, ShelfKind } from "../../lib/bridge";

export const KIND_FILTERS: { value: ShelfKind | "all"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "image", label: "图片" },
  { value: "file", label: "文件" },
  { value: "folder", label: "文件夹" },
  { value: "link", label: "链接" },
  { value: "text", label: "文本" },
];

function FilterChip({
  active,
  children,
  onClick,
  label,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      className={`shelf-filter-chip${active ? " is-active" : ""}`}
      aria-pressed={active}
      aria-label={label}
      onClick={onClick}
    >
      {active && <Check size={11} strokeWidth={2.6} aria-hidden="true" />}
      {children}
    </button>
  );
}

export interface ShelfFiltersProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: RefObject<HTMLElement | null>;
  kind: ShelfKind | "all";
  onKindChange: (kind: ShelfKind | "all") => void;
  groupId: string;
  groups: ShelfGroup[];
  onGroupChange: (groupId: string) => void;
  favoriteOnly: boolean;
  onFavoriteOnlyChange: (value: boolean) => void;
  hasFilters: boolean;
  onClear: () => void;
}

export default function ShelfFilters({
  open,
  onOpenChange,
  anchorRef,
  kind,
  onKindChange,
  groupId,
  groups,
  onGroupChange,
  favoriteOnly,
  onFavoriteOnlyChange,
  hasFilters,
  onClear,
}: ShelfFiltersProps) {
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      placement="bottom-end"
      className="shelf-filter-pop"
      role="dialog"
      ariaLabel="筛选暂存条目"
    >
      <div className="shelf-filter-section">
        <span className="shelf-filter-label">类型</span>
        <div className="shelf-filter-chips" role="group" aria-label="类型筛选">
          {KIND_FILTERS.map((option) => (
            <FilterChip
              key={option.value}
              active={kind === option.value}
              onClick={() => onKindChange(option.value)}
            >
              {option.label}
            </FilterChip>
          ))}
        </div>
      </div>

      <div className="shelf-filter-section">
        <span className="shelf-filter-label">分组</span>
        <div
          className="shelf-filter-chips shelf-filter-groups"
          role="group"
          aria-label="分组筛选"
        >
          <FilterChip
            active={groupId === "all"}
            onClick={() => onGroupChange("all")}
          >
            全部分组
          </FilterChip>
          <FilterChip
            active={groupId === "none"}
            onClick={() => onGroupChange("none")}
          >
            未分组
          </FilterChip>
          {groups.map((group) => (
            <FilterChip
              key={group.id}
              active={groupId === group.id}
              onClick={() => onGroupChange(group.id)}
            >
              {group.name}
            </FilterChip>
          ))}
        </div>
      </div>

      <div className="shelf-filter-switch-row">
        <Switch
          checked={favoriteOnly}
          onChange={onFavoriteOnlyChange}
          label="只看收藏"
        />
      </div>

      <div className="shelf-filter-actions">
        <button
          type="button"
          className="btn sm"
          disabled={!hasFilters}
          onClick={onClear}
        >
          清除筛选
        </button>
      </div>
    </Popover>
  );
}
