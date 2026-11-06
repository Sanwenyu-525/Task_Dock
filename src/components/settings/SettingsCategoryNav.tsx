//! 设置页一级分类导航（紧凑 tablist）。
//!
//! 只负责「选哪个分类」的呈现与键盘交互，分类元数据一律来自
//! `lib/settingsCategories.ts`（标题/说明/图标/顺序），组件内不维护第二份列表。
//!
//! 交互约定：
//! - `role="tablist"` + `role="tab"`：当前分类用 `aria-selected` 表达，
//!   内容区用 `role="tabpanel"` + `aria-labelledby` 关联（见 `SettingsPanel`）；
//! - 漫游 tabindex：只有选中项进入 Tab 序列，方向键 / Home / End 在分类间移动
//!   并**同时激活**（分类内容很轻，无需「先聚焦再回车」的两步操作）；
//! - 窄窗下由 CSS 网格自动降列（3 → 2 → 1），标签允许换行而不是截断，
//!   因此分类名称始终完整可读。

import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useLocale } from "../../hooks/useLocale";
import {
  SETTINGS_CATEGORIES,
  type SettingsCategoryId,
} from "../../lib/settingsCategories";

/** 分类 tab 的 DOM id：与内容区 `aria-labelledby` / `aria-controls` 共用。 */
export function settingsCategoryTabId(id: SettingsCategoryId): string {
  return `settings-category-tab-${id}`;
}

/** 分类内容区的 DOM id（`role="tabpanel"`）。 */
export function settingsCategoryPanelId(id: SettingsCategoryId): string {
  return `settings-category-panel-${id}`;
}

export default function SettingsCategoryNav({
  active,
  onSelect,
}: {
  active: SettingsCategoryId;
  onSelect: (id: SettingsCategoryId) => void;
}) {
  const { t } = useLocale();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  const activate = useCallback(
    (index: number) => {
      const category = SETTINGS_CATEGORIES[index];
      if (!category) return;
      onSelect(category.id);
      tabs.current[index]?.focus();
    },
    [onSelect],
  );

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const last = SETTINGS_CATEGORIES.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = index === last ? 0 : index + 1;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = index === 0 ? last : index - 1;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = last;
    }
    if (next === null) return;
    event.preventDefault();
    activate(next);
  }

  return (
    <div
      className="settings-categories"
      role="tablist"
      aria-label={t("settings.category.aria")}
      aria-orientation="horizontal"
    >
      {SETTINGS_CATEGORIES.map((category, index) => {
        const selected = category.id === active;
        return (
          <button
            key={category.id}
            ref={(el) => {
              tabs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={settingsCategoryTabId(category.id)}
            aria-selected={selected}
            aria-controls={settingsCategoryPanelId(category.id)}
            tabIndex={selected ? 0 : -1}
            className={`settings-category${selected ? " is-active" : ""}`}
            onClick={() => onSelect(category.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <category.icon
              size={14}
              strokeWidth={1.7}
              className="settings-category-icon"
              aria-hidden="true"
            />
            <span className="settings-category-label">{t(category.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}
