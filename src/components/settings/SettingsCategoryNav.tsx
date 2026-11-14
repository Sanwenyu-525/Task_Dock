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

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useLocale } from "../../hooks/useLocale";
import {
  SETTINGS_CATEGORIES,
  type SettingsCategoryId,
} from "../../lib/settingsCategories";

/**
 * 宽屏左栏布局断点：与 settings-page.css 的 `@media (min-width: …)` 保持一致
 * （单一事实源——改这里必须同步改 CSS，两处注释互指）。宽屏（≥1080 逻辑像素）下分类呈纵向
 * 左栏（图标 + 标题 + 描述，对照效果图 13），窄窗保留横向网格 + 吸顶 +
 * 3→2→1 降列。aria-orientation 必须与视觉布局一致，因此用 matchMedia 感知。
 */
const WIDE_LAYOUT_QUERY = "(min-width: 1080px)";

function useWideCategoryLayout(): boolean {
  const supported =
    typeof window === "object" && typeof window.matchMedia === "function";
  const [wide, setWide] = useState(() =>
    supported ? window.matchMedia(WIDE_LAYOUT_QUERY).matches : false,
  );
  useEffect(() => {
    if (!supported) return;
    const mql = window.matchMedia(WIDE_LAYOUT_QUERY);
    const onChange = (event: MediaQueryListEvent) => setWide(event.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [supported]);
  return wide;
}

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
  const wide = useWideCategoryLayout();

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
      aria-orientation={wide ? "vertical" : "horizontal"}
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
            aria-describedby={`settings-category-desc-${category.id}`}
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
            {/* text 包装层：窄窗 display:contents（保持既有 icon+label 磁贴），
                宽屏左栏展开为「标题 + 描述」两行（描述来自分类元数据）。
                描述不进可访问名称（name 只含标题，测试按名称精确查询），
                经 aria-describedby 在聚焦时播报——标准 tab-with-description 模式。 */}
            <span className="settings-category-text">
              <span className="settings-category-label">{t(category.labelKey)}</span>
              <span
                id={`settings-category-desc-${category.id}`}
                className="settings-category-desc"
                aria-hidden="true"
              >
                {t(category.descriptionKey)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
