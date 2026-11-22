//! SectionTabs / SectionNavigation 共用的导航键索引推进。
//! 契约见 docs/ui-themes/15-section-navigation.md §2/§4；
//! 语义差异（Tabs 焦点即选中、Navigation 只移焦点）由组件自己处理，这里只算索引。

const NAV_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"] as const;

export type NavKey = (typeof NAV_KEYS)[number];

export function isNavKey(key: string): key is NavKey {
  return (NAV_KEYS as readonly string[]).includes(key);
}

/**
 * 当前索引 → 下一索引；items 由调用方过滤掉 disabled 后传入 count。
 * 与既有 radioGroup / moveNavFocus 行为一致：越界环绕、无焦点时
 * ←/↑ 落到末项、→/↓ 落到首项。
 */
export function nextNavIndex(key: NavKey, current: number, count: number): number {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (current < 0) return key === "ArrowLeft" || key === "ArrowUp" ? count - 1 : 0;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % count;
  return (current - 1 + count) % count;
}
