//! 设置中心树形二级导航（2026-11-20 重构）。
//!
//! 结构与语义：
//! - `role="tree"`：一级分类 = `role="treeitem" aria-expanded`（可折叠组），
//!   二级页面 = 叶子 `treeitem aria-selected`；`aria-level` 显式声明层级
//!   （扁平 DOM 下读屏无法从嵌套推导）。旧版 tablist 语义随本组件退役。
//! - 分类/页面元数据一律来自 `lib/settingsCategories.ts`（唯一事实源），
//!   组件内不维护第二份列表。
//! - 交互约定（宽/中容器）：
//!   - ↑/↓ 在可见项间移动并**激活页面**（页面内容轻，沿用旧 tablist
//!     「方向键即切换」约定；分类仅移动焦点，展开/收起交给 ←/→）；
//!   - → 展开 / 进入第一个页面；← 折叠 / 回父分类；Home/End 首尾；
//!   - Enter/Space / 点击：分类 = 展开（当前页面不在其下时顺带打开该分类
//!     第一个页面）或收起；页面 = 切换。每个分类的行为都可预期，
//!     不存在「像按钮但不知道会发生什么」的状态。
//! - 窄容器（<760px，见 useSettingsResponsiveLayout）：折叠为顶部紧凑条——
//!   分类下拉（Select）+ 当前分类的页面 chips，内容区独占宽度。
//! - 展开状态持久化 `taskdock.settings.navexpand.v1`；当前页面所属分类被
//!   外部定位（搜索/跨模块 reveal）时自动展开，并保证当前项滚入可视区。

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useLocale } from "../../hooks/useLocale";
import type { SettingsLayoutMode } from "../../hooks/useSettingsResponsiveLayout";
import {
  SETTINGS_CATEGORIES,
  firstSectionOf,
  sectionsForCategory,
  settingsCategory,
  type SettingsCategoryId,
} from "../../lib/settingsCategories";
import {
  type SettingsSectionId,
} from "../../lib/settingsSections";
import { settingsSectionMeta } from "../../lib/settingsCategories";
import { Select } from "../ui";

/** 分类展开状态持久化（纯本地 UI 偏好；损坏/未知分类安全忽略）。 */
const NAV_EXPAND_STORAGE_KEY = "taskdock.settings.navexpand.v1";
const NAV_EXPAND_STORAGE_VERSION = 1;

function readNavExpandedCategories(): Set<SettingsCategoryId> {
  const expanded = new Set<SettingsCategoryId>(SETTINGS_CATEGORIES.map((c) => c.id));
  try {
    const raw = localStorage.getItem(NAV_EXPAND_STORAGE_KEY);
    if (!raw) return expanded;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== NAV_EXPAND_STORAGE_VERSION
    ) {
      return expanded;
    }
    const list = (parsed as { expanded?: unknown }).expanded;
    if (!Array.isArray(list)) return expanded;
    // 全部收起是合法状态：空数组表示用户明确收起了所有分类。
    const valid = new Set<SettingsCategoryId>();
    for (const id of list) {
      if (settingsCategory(id as SettingsCategoryId)) valid.add(id as SettingsCategoryId);
    }
    return valid;
  } catch {
    return expanded;
  }
}

function persistNavExpandedCategories(expanded: Set<SettingsCategoryId>): void {
  try {
    localStorage.setItem(
      NAV_EXPAND_STORAGE_KEY,
      JSON.stringify({
        version: NAV_EXPAND_STORAGE_VERSION,
        expanded: [...expanded],
      }),
    );
  } catch {
    // 存储不可用：只失去下次启动的记忆。
  }
}

/** 分类分组容器的 DOM id（treeitem aria-controls 指向）。 */
function navGroupId(category: SettingsCategoryId): string {
  return `settings-nav-group-${category}`;
}

/** 页面项的 DOM id（测试与「当前项滚入可视区」共用）。 */
export function navItemElementId(section: SettingsSectionId): string {
  return `settings-nav-item-${section}`;
}

/** 树内可见项的扁平模型：分类项与页面项统一编号，键盘移动按此索引。 */
interface VisibleItem {
  kind: "category" | "page";
  id: SettingsCategoryId | SettingsSectionId;
  /** 页面项所属分类（分类项为自身）。 */
  category: SettingsCategoryId;
}

interface SettingsNavigationProps {
  activeSection: SettingsSectionId;
  onSelectSection: (section: SettingsSectionId) => void;
  layoutMode: SettingsLayoutMode;
}

export default function SettingsNavigation({
  activeSection,
  onSelectSection,
  layoutMode,
}: SettingsNavigationProps) {
  const { t } = useLocale();
  const [expandedCategories, setExpandedCategories] = useState<Set<SettingsCategoryId>>(
    () => readNavExpandedCategories(),
  );
  // 漫游 tabindex 锚点：默认落在当前页面项上，键盘进入导航即可继续移动。
  const [focusedId, setFocusedId] = useState<string>(navItemElementId(activeSection));
  const treeRef = useRef<HTMLDivElement | null>(null);
  // 布局模式切换会整体重建 DOM：若焦点原本在导航内，切完把焦点还给当前项。
  const hadFocusRef = useRef(false);

  const activeCategory = settingsSectionMeta(activeSection)?.category ?? SETTINGS_CATEGORIES[0].id;
  const activeCategoryRef = useRef(activeCategory);
  activeCategoryRef.current = activeCategory;
  const onSelectRef = useRef(onSelectSection);
  onSelectRef.current = onSelectSection;

  const setExpanded = useCallback((next: Set<SettingsCategoryId>) => {
    setExpandedCategories(next);
    persistNavExpandedCategories(next);
  }, []);

  // 当前页面所属分类必须展开：外部定位（搜索/reveal/appConfig）会切换
  // activeSection 而不经过分类点击，这里兜底展开（幂等）。
  useEffect(() => {
    setExpandedCategories((prev) => {
      if (prev.has(activeCategoryRef.current)) return prev;
      const next = new Set(prev);
      next.add(activeCategoryRef.current);
      persistNavExpandedCategories(next);
      return next;
    });
  }, [activeSection]);

  // 定位/切页后保证当前页面项可见：只滚导航自身（revealInScroller 的最小
  // 必要滚动语义），不居中、不触碰页面内容滚动位置。
  useLayoutEffect(() => {
    const item = treeRef.current?.querySelector<HTMLElement>(
      `#${navItemElementId(activeSection)}`,
    );
    if (!item) return;
    const box = treeRef.current;
    if (!box) return;
    const itemRect = item.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    if (itemRect.top < boxRect.top) {
      box.scrollTop -= boxRect.top - itemRect.top;
    } else if (itemRect.bottom > boxRect.bottom) {
      box.scrollTop += itemRect.bottom - boxRect.bottom;
    }
  }, [activeSection, layoutMode]);

  // 紧凑条 ↔ 树互切时恢复焦点（DOM 被替换，浏览器把焦点丢到 body）。
  useEffect(() => {
    if (document.activeElement && document.activeElement !== document.body) {
      hadFocusRef.current = treeRef.current?.contains(document.activeElement) ?? false;
      return;
    }
    if (!hadFocusRef.current) return;
    hadFocusRef.current = false;
    if (layoutMode === "narrow") return;
    treeRef.current
      ?.querySelector<HTMLElement>(`#${navItemElementId(activeSection)}`)
      ?.focus({ preventScroll: true });
  }, [layoutMode, activeSection]);

  // 漫游 tabindex 锚点修复：收起分类 / 切页面可能让锚点元素从 DOM 消失，
  // 树里不能出现「没有 tabindex=0 项」的死区。锚点失效时回落到当前页面项，
  // 页面项也不在（其分类被收起）则回落到所属分类按钮。
  useLayoutEffect(() => {
    if (layoutMode === "narrow" || !treeRef.current) return;
    if (treeRef.current.querySelector(`[id="${focusedId}"]`)) return;
    const activeItem = treeRef.current.querySelector(`[id="${navItemElementId(activeSection)}"]`);
    setFocusedId(
      activeItem
        ? navItemElementId(activeSection)
        : `settings-nav-category-${activeCategoryRef.current}`,
    );
  }, [focusedId, expandedCategories, activeSection, layoutMode]);

  /** 展开分类并（可选）打开其第一个页面。 */
  const openCategory = useCallback(
    (category: SettingsCategoryId) => {
      setExpandedCategories((prev) => {
        const next = new Set(prev);
        next.add(category);
        persistNavExpandedCategories(next);
        return next;
      });
      if (activeCategoryRef.current !== category) {
        onSelectRef.current(firstSectionOf(category));
      }
    },
    [setExpanded],
  );

  const toggleCategory = useCallback(
    (category: SettingsCategoryId) => {
      // 展开中的分类点击 = 收起；收起中的分类点击 = 打开（展开 + 进入第一个
      // 页面）。两个方向的语义都唯一，不存在歧义状态。
      if (expandedCategories.has(category)) {
        const next = new Set(expandedCategories);
        next.delete(category);
        setExpanded(next);
      } else {
        openCategory(category);
      }
    },
    [expandedCategories, openCategory, setExpanded],
  );

  /** 树内当前可见项（展开状态驱动；顺序 = 分类顺序 + 分类内页面顺序）。 */
  const visibleItems = useCallback((): VisibleItem[] => {
    const items: VisibleItem[] = [];
    for (const category of SETTINGS_CATEGORIES) {
      items.push({ kind: "category", id: category.id, category: category.id });
      if (!expandedCategories.has(category.id)) continue;
      for (const section of sectionsForCategory(category.id)) {
        items.push({ kind: "page", id: section.id, category: category.id });
      }
    }
    return items;
  }, [expandedCategories]);

  const focusItem = useCallback((item: VisibleItem) => {
    const domId =
      item.kind === "category"
        ? `settings-nav-category-${item.id}`
        : navItemElementId(item.id as SettingsSectionId);
    setFocusedId(domId);
    treeRef.current
      ?.querySelector<HTMLElement>(`#${domId}`)
      ?.focus({ preventScroll: true });
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    const items = visibleItems();
    const target = event.target as HTMLElement;
    const currentDomId = target.id;
    const index = items.findIndex((item) =>
      item.kind === "category"
        ? `settings-nav-category-${item.id}` === currentDomId
        : navItemElementId(item.id as SettingsSectionId) === currentDomId,
    );
    if (index < 0) return;
    const item = items[index];

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = items[(index + delta + items.length) % items.length];
      if (!next) return;
      focusItem(next);
      // 页面跟随焦点激活（轻内容约定）；分类只移动焦点。
      if (next.kind === "page") onSelectRef.current(next.id as SettingsSectionId);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? items[0] : items[items.length - 1];
      if (!next) return;
      focusItem(next);
      if (next.kind === "page") onSelectRef.current(next.id as SettingsSectionId);
      return;
    }
    if (event.key === "ArrowRight" && item.kind === "category") {
      event.preventDefault();
      const category = item.id as SettingsCategoryId;
      if (!expandedCategories.has(category)) {
        openCategory(category);
        return;
      }
      const first = items[index + 1];
      if (first && first.kind === "page") {
        focusItem(first);
        onSelectRef.current(first.id as SettingsSectionId);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      if (item.kind === "page") {
        event.preventDefault();
        focusItem(items[index - 1] ?? items[0]);
        return;
      }
      const category = item.id as SettingsCategoryId;
      if (expandedCategories.has(category)) {
        event.preventDefault();
        const next = new Set(expandedCategories);
        next.delete(category);
        setExpanded(next);
      }
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && item.kind === "category") {
      event.preventDefault();
      toggleCategory(item.id as SettingsCategoryId);
    }
  }

  // ── 窄容器紧凑条 ──────────────────────────────────────────────────────
  if (layoutMode === "narrow") {
    const pages = sectionsForCategory(activeCategory);
    return (
      <nav className="settings-nav is-compact" aria-label={t("settings.category.aria")}>
        <Select
          size="sm"
          className="settings-nav-category-select"
          ariaLabel={t("settings.nav.selectCategory")}
          value={activeCategory}
          align="start"
          options={SETTINGS_CATEGORIES.map((category) => ({
            value: category.id,
            label: t(category.labelKey),
          }))}
          onChange={(id) => onSelectRef.current(firstSectionOf(id as SettingsCategoryId))}
        />
        <div className="settings-nav-chips" role="group" aria-label={t("settings.category.aria")}>
          {pages.map((section) => {
            const active = section.id === activeSection;
            return (
              <button
                key={section.id}
                type="button"
                id={navItemElementId(section.id)}
                className={`settings-nav-chip${active ? " is-active" : ""}`}
                aria-current={active ? "true" : undefined}
                onClick={() => onSelectRef.current(section.id)}
              >
                {t(section.labelKey)}
              </button>
            );
          })}
        </div>
      </nav>
    );
  }

  // ── 宽/中容器：纵向树 ────────────────────────────────────────────────
  return (
    <nav className="settings-nav" aria-label={t("settings.category.aria")}>
      <div
        className="settings-nav-tree"
        role="tree"
        aria-orientation="vertical"
        ref={treeRef}
        onKeyDown={onKeyDown}
      >
        {SETTINGS_CATEGORIES.map((category) => {
          const expanded = expandedCategories.has(category.id);
          const categoryDomId = `settings-nav-category-${category.id}`;
          const containsActive = activeCategory === category.id;
          return (
            <div className="settings-nav-branch" key={category.id}>
              <button
                type="button"
                role="treeitem"
                id={categoryDomId}
                aria-level={1}
                aria-expanded={expanded}
                aria-controls={navGroupId(category.id)}
                tabIndex={focusedId === categoryDomId ? 0 : -1}
                className={`settings-nav-category${containsActive ? " is-current" : ""}`}
                onClick={() => toggleCategory(category.id)}
              >
                <category.icon size={14} strokeWidth={1.7} className="settings-nav-icon" aria-hidden="true" />
                <span className="settings-nav-label">{t(category.labelKey)}</span>
                <span className="settings-nav-chevron" aria-hidden="true" data-expanded={expanded} />
              </button>
              {expanded && (
                <div className="settings-nav-group" role="group" id={navGroupId(category.id)}>
                  {sectionsForCategory(category.id).map((section) => {
                    const active = section.id === activeSection;
                    const domId = navItemElementId(section.id);
                    return (
                      <button
                        key={section.id}
                        type="button"
                        role="treeitem"
                        id={domId}
                        aria-level={2}
                        aria-selected={active}
                        tabIndex={focusedId === domId ? 0 : -1}
                        className={`settings-nav-item${active ? " is-active" : ""}`}
                        onClick={() => onSelectRef.current(section.id)}
                      >
                        {t(section.labelKey)}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
