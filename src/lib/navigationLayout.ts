//! 导航布局的读写适配层：把纯配置函数接到既有 SQLite 设置管道。
//!
//! 单一事实源：配置只存在 `application_settings.navigation_layout`（经
//! `useSettingsStore`），组件通过本文件的 `useNavigationLayout()` 派生读取，
//! **不另建 zustand 布局状态**，避免出现内存与数据库两份真源。
//!
//! 唯一的例外是 `navOrderIntent` 的**乐观意图层**：拖动/长按期间尚未落库的顺序
//! 以「意图」形式共享给全部消费者（设置列表、侧边栏、胶囊、帮助页），写入完成
//! 即清除。它不是第二份配置——不持久化、只表达顺序、失败即回滚，事实源仍是
//! SQLite（见 `navOrderIntent.ts` 的边界说明）。
//!
//! 写入约束：
//! - 读-改-写必须串行化：快速连续点击开关/排序时，后一次写入基于前一次已落库
//!   的结果，而不是渲染时的旧快照；
//! - 读-改-写的基准是**有效布局**（已提交 + 未落库意图）：任何导航写入都不会
//!   用旧顺序覆盖用户刚做的调整；
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
import { applyNavOrderIntents, useNavOrderIntentVersion } from "./navOrderIntent";
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

/** 从后端设置派生当前布局（缺失/损坏 → 注册中心默认）。**不含**乐观意图。 */
export function selectNavigationLayout(settings: unknown): NavLayoutConfig {
  return normalizeNavigationLayout(
    (settings as Record<string, unknown> | null)?.[NAV_LAYOUT_SETTING_KEY],
  ).config;
}

/**
 * React 侧唯一读取入口：所有导航消费者都读**同一份有效排序**。
 *
 * 已提交配置（SQLite）是事实源；未落库的排序意图叠在它上面，因此设置列表移动
 * 一次，侧边栏 / 胶囊 / 帮助页在同一次 React 更新里一起变化，不需要等待写入、
 * 不需要重开设置页。写入成功后意图清除，界面无缝落回事实源。
 */
export function useNavigationLayout(): NavLayoutConfig {
  const raw = useSettingsStore((s) => s.settings?.[NAV_LAYOUT_SETTING_KEY]);
  const settingsLoaded = useSettingsStore((s) => s.settings !== null);
  // 订阅乐观意图版本：意图变化必须让本组件（以及所有消费者）重新计算。
  const intentVersion = useNavOrderIntentVersion();
  // 旧版 localStorage 配置的迁移只在设置加载后触发；失败静默保留旧键，下次再试。
  useEffect(() => {
    if (!settingsLoaded) return;
    void ensureLegacyNavigationMigration().catch(() => {});
  }, [settingsLoaded]);
  return useMemo(
    () => applyNavOrderIntents(normalizeNavigationLayout(raw).config),
    // intentVersion 只用于建立依赖：意图本身通过模块级共享层读取。
    [raw, intentVersion],
  );
}

/**
 * 只读**已提交**布局（不含乐观意图）。
 *
 * 排序草稿层用它做两件事：以事实源为基准计算下一步顺序、失败时回滚到这个值。
 * 若这里也用有效布局，`apply` 会从"上一份草稿"再推一次，导致重复位移。
 */
export function useCommittedNavigationLayout(): NavLayoutConfig {
  const raw = useSettingsStore((s) => s.settings?.[NAV_LAYOUT_SETTING_KEY]);
  const settingsLoaded = useSettingsStore((s) => s.settings !== null);
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
 * `mutate` 接收**已归一化、且叠加了未落库排序意图**的当前布局，返回目标布局；
 * 随后统一补齐版本与 `known` 快照。设置尚未加载时拒绝写入，避免用默认值覆盖
 * 用户真实配置。
 *
 * 为什么基准要叠加意图：若这里只读数据库，用户在排序尚未落库时点开关/恢复默认，
 * 写回的顺序就是旧的，看起来像"刚排好的被冲掉"。以有效布局为基准后，任何导航
 * 写入都保留用户最新意图；意图的清除与回滚仍由排序草稿层按序号负责。
 */
export function persistNavigationLayout(
  mutate: (current: NavLayoutConfig) => NavLayoutConfig,
): Promise<void> {
  return enqueueWrite(async () => {
    const store = useSettingsStore.getState();
    if (!store.settings) throw new Error("设置尚未加载，请稍后重试");
    const current = applyNavOrderIntents(selectNavigationLayout(store.settings));
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
