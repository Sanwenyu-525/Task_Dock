//! 导航布局的读写适配层：把纯配置函数接到既有 SQLite 设置管道。
//!
//! 单一事实源：配置只存在 `application_settings.navigation_layout`（经
//! `useSettingsStore`），组件通过本文件的 `useNavigationLayout()` 派生读取，
//! **不另建 zustand 布局状态**，避免出现内存与数据库两份真源。
//!
//! 写入约束：
//! - 读-改-写必须串行化：快速连续点击开关/排序时，后一次写入基于前一次已落库
//!   的结果，而不是渲染时的旧快照；
//! - 每次写入把 `known` 快照更新为当前注册中心全部入口，保证「刚隐藏的新入口」
//!   不会被下一次读取按默认值重新补齐；
//! - 写入失败直接抛错，由设置页就地反馈；内存状态仍是后端值，不会出现开关与
//!   配置不一致的假成功。

import { useEffect, useMemo } from "react";
import {
  allEntryIds,
  defaultVisibleIds,
  isEntrySortable,
  navEntry,
  type NavSurface,
} from "./navigationRegistry";
import {
  LEGACY_NAV_VISIBILITY_STORAGE_KEY,
  NAV_LAYOUT_SETTING_KEY,
  NAV_LAYOUT_VERSION,
  applyLegacyHiddenEntries,
  defaultNavigationLayout,
  insertEntryByDefaultOrder,
  moveEntryInList,
  normalizeNavigationLayout,
  readLegacyHiddenEntryIds,
  type NavLayoutConfig,
} from "./navVisibility";
import { useSettingsStore } from "../store/useSettingsStore";

/** 从后端设置派生当前布局（缺失/损坏 → 注册中心默认）。 */
export function selectNavigationLayout(settings: unknown): NavLayoutConfig {
  return normalizeNavigationLayout(
    (settings as Record<string, unknown> | null)?.[NAV_LAYOUT_SETTING_KEY],
  ).config;
}

/** React 侧唯一读取入口：只订阅设置值，不制造第二份状态。 */
export function useNavigationLayout(): NavLayoutConfig {
  const raw = useSettingsStore((s) => s.settings?.[NAV_LAYOUT_SETTING_KEY]);
  const settingsLoaded = useSettingsStore((s) => s.settings !== null);
  // 旧版 localStorage 配置的迁移只在设置加载后触发；失败静默保留旧键，下次再试。
  useEffect(() => {
    if (!settingsLoaded) return;
    void ensureLegacyNavigationMigration().catch(() => {});
  }, [settingsLoaded]);
  return useMemo(() => normalizeNavigationLayout(raw).config, [raw]);
}

let writeChain: Promise<void> = Promise.resolve();

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const run = writeChain.then(task, task);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 串行化的读-改-写。
 *
 * `mutate` 接收**已归一化**的当前布局，返回目标布局；随后统一补齐版本与
 * `known` 快照。设置尚未加载时拒绝写入，避免用默认值覆盖用户真实配置。
 */
export function persistNavigationLayout(
  mutate: (current: NavLayoutConfig) => NavLayoutConfig,
): Promise<void> {
  return enqueueWrite(async () => {
    const store = useSettingsStore.getState();
    if (!store.settings) throw new Error("设置尚未加载，请稍后重试");
    const current = selectNavigationLayout(store.settings);
    const next = normalizeNavigationLayout({
      ...mutate(current),
      version: NAV_LAYOUT_VERSION,
      known: { left: allEntryIds("left"), capsule: allEntryIds("capsule") },
    }).config;
    await store.update({ [NAV_LAYOUT_SETTING_KEY]: next });
  });
}

/** 切换某界面单个入口的可见性。 */
export function setNavigationEntryVisible(
  surface: NavSurface,
  id: string,
  visible: boolean,
): Promise<void> {
  // 系统锁定入口（设置）不可隐藏：越界调用静默忽略，配置保持原样。
  if (!visible && navEntry(id)?.locked) return Promise.resolve();
  return persistNavigationLayout((current) => ({
    ...current,
    [surface]: visible
      ? insertEntryByDefaultOrder(current[surface], id, surface)
      : current[surface].filter((entryId) => entryId !== id),
  }));
}

/** 上移 / 下移一个可见入口（键盘可用的排序实现，不引入拖拽系统）。
 *
 * 排序规则与设置页 UI 共用同一份元数据（`isEntrySortable`）：
 * - 固定入口（左侧 `locked` 设置、胶囊 Agent 状态球）自身不可移动；
 * - 固定入口**不是障碍**：普通入口在可排序子序列内交换，可以跨过固定项
 *   （固定项原地不动；胶囊分类因此不受端头 Agent 阻挡）；
 * - 未知 ID 不会出现在已归一化的布局里，谓词按普通入口处理。
 */
export function moveNavigationEntry(
  surface: NavSurface,
  id: string,
  delta: -1 | 1,
): Promise<void> {
  return persistNavigationLayout((current) => ({
    ...current,
    [surface]: moveEntryInList(current[surface], id, delta, (entryId) => {
      const entry = navEntry(entryId);
      return entry ? !isEntrySortable(entry, surface) : false;
    }),
  }));
}

/** 单独恢复某界面的默认显隐与顺序，不影响另一界面。 */
export function resetNavigationSurface(surface: NavSurface): Promise<void> {
  return persistNavigationLayout((current) => ({
    ...current,
    [surface]: defaultVisibleIds(surface),
  }));
}

/** 恢复两个界面的默认值（供未来「全部恢复」入口使用）。 */
export function resetNavigationLayout(): Promise<void> {
  return persistNavigationLayout(() => defaultNavigationLayout());
}

/** 后端是否已有有效的导航布局（null / 损坏都算「未写入」）。 */
export function hasStoredNavigationLayout(settings: unknown): boolean {
  return normalizeNavigationLayout(
    (settings as Record<string, unknown> | null)?.[NAV_LAYOUT_SETTING_KEY],
  ).source === "settings";
}

let legacyMigrationDone = false;
let legacyMigrationInFlight: Promise<void> | null = null;

/**
 * 旧版 localStorage 导航显隐的一次性迁移。
 *
 * - 已有新配置 / 旧键不存在 → 直接结束，不写库、不删旧键；
 * - 迁移写入成功后才删除旧键；失败保留旧键，下一次挂载重试；
 * - 写入仍走 `persistNavigationLayout` 的串行链，避免与用户即时开关乱序覆盖。
 */
export function ensureLegacyNavigationMigration(): Promise<void> {
  if (legacyMigrationDone) return Promise.resolve();
  if (legacyMigrationInFlight) return legacyMigrationInFlight;
  const store = useSettingsStore.getState();
  if (!store.settings) return Promise.resolve(); // 由 hook 在 settings 加载后重新触发
  if (hasStoredNavigationLayout(store.settings)) {
    legacyMigrationDone = true;
    return Promise.resolve();
  }
  const hidden = readLegacyHiddenEntryIds();
  if (hidden.length === 0) {
    legacyMigrationDone = true;
    return Promise.resolve();
  }
  legacyMigrationInFlight = persistNavigationLayout((current) =>
    applyLegacyHiddenEntries(current, hidden),
  )
    .then(() => {
      legacyMigrationDone = true;
      try {
        localStorage.removeItem(LEGACY_NAV_VISIBILITY_STORAGE_KEY);
      } catch {
        // 存储被拒：旧键残留不影响新配置，下次启动按「已有新配置」直接跳过。
      }
    })
    .finally(() => {
      legacyMigrationInFlight = null;
    });
  return legacyMigrationInFlight;
}
