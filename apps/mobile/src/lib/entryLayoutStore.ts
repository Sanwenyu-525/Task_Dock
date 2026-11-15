// 工作台入口配置的运行时状态：内存快照 + 串行写队列 + 订阅。
//
// 为什么要有这一层：工作台、入口管理页、全部功能页都要读到同一份配置，
// 而且管理页改完之后工作台必须立刻变（Tab 页常驻挂载，不会重新读库）。
// 直接把配置 state 塞进各个组件会立刻出现「三处各存一份、谁先谁后」的问题。
//
// 写队列：连续点按 / 连续拖拽会产生多个写请求，必须串行，否则后一次
// 「读-改-写」可能基于旧值，出现「刚加上的入口又被上一次的写入覆盖掉」。
// 失败时回滚到最后一次成功落盘的配置，并通过抛异常让界面给出明确反馈。
import { useSyncExternalStore } from "react";

import {
  mergeEntryOrder,
  moveEntryByDelta,
  setEntriesVisible,
  setEntryVisible,
  normalizeEntryLayout,
  defaultEntryLayout,
  ENTRY_LAYOUT_VERSION,
  type EntryLayoutConfig,
} from "./entryLayout";
import { availableEntryIds, entryById, type EntryId } from "./entryRegistry";
import { describeError } from "./errors";
import { loadEntryLayout, saveEntryLayout } from "../db/entryLayout";

export interface EntryLayoutState {
  config: EntryLayoutConfig;
  /** 是否已完成首次读取（未完成时展示的是默认布局，正常在 Shell 挂载前就已就绪） */
  loaded: boolean;
  source: "settings" | "default";
  /** 原始配置读到了但无法解析，已退回默认 */
  corrupt: boolean;
  /** 读取本身失败（数据库错误） */
  readFailed: boolean;
  /** 升级时按新结构重建过配置 */
  migrated: boolean;
  /** 被丢弃的失效入口数量 */
  dropped: number;
  /** 读取失败的可读原因（仅用于界面提示） */
  readError?: string;
}

function initialState(): EntryLayoutState {
  return {
    config: defaultEntryLayout(),
    loaded: false,
    source: "default",
    corrupt: false,
    readFailed: false,
    migrated: false,
    dropped: 0,
  };
}

let state: EntryLayoutState = initialState();
const listeners = new Set<() => void>();

/** 最后一次成功落盘的配置：写失败时回滚到它，避免界面停在没保存的状态 */
let persisted: EntryLayoutConfig | null = null;
/** 串行写队列 */
let writeChain: Promise<unknown> = Promise.resolve();
/** 首次读取的单飞任务 */
let loadTask: Promise<void> | null = null;

function setState(patch: Partial<EntryLayoutState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): EntryLayoutState {
  return state;
}

export function getEntryLayoutState(): EntryLayoutState {
  return state;
}

/** 组件订阅当前配置（工作台 / 管理页共用同一份） */
export function useEntryLayout(): EntryLayoutState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 首次读取配置。幂等：并发调用共享同一个任务。
 *
 * 修复策略：损坏 / 版本迁移 / 有失效 id 时，把归一化后的配置写回一次，
 * 避免每次启动都重复兜底；修复失败不影响本次使用（内存里已是安全配置）。
 */
export function ensureEntryLayoutLoaded(): Promise<void> {
  if (state.loaded) return Promise.resolve();
  if (loadTask) return loadTask;

  loadTask = (async () => {
    const snapshot = await loadEntryLayout();
    setState({
      config: snapshot.config,
      loaded: true,
      source: snapshot.source,
      corrupt: snapshot.corrupt,
      readFailed: snapshot.readFailed,
      migrated: snapshot.migrated,
      dropped: snapshot.dropped,
    });
    if (snapshot.source === "settings") persisted = snapshot.config;

    const needsRepair =
      !snapshot.readFailed &&
      (snapshot.corrupt || snapshot.migrated || snapshot.dropped > 0);
    if (needsRepair) {
      try {
        await saveEntryLayout(snapshot.config);
        persisted = snapshot.config;
        setState({ corrupt: false, migrated: false, dropped: 0, source: "settings" });
      } catch {
        // 修复写失败：本次仍用安全配置，下次启动会再试
      }
    }
  })()
    .catch((error: unknown) => {
      // 读库异常已在 loadEntryLayout 内收敛；这里兜住极端情况，不让启动流程挂掉
      setState({ loaded: true, readFailed: true, readError: describeError(error) });
    })
    .finally(() => {
      loadTask = null;
    });

  return loadTask;
}

/**
 * 串行提交一次配置变更。
 *
 * @param mutate 基于「当前生效配置」计算下一版；返回值只取 visible 字段，
 *               version 与 known 一律由这里补齐，调用方不能写坏结构。
 * @throws 写盘失败时抛异常（调用方必须提示用户），并已回滚到上次成功配置。
 */
export function commitEntryLayout(
  mutate: (current: EntryLayoutConfig) => EntryLayoutConfig,
): Promise<EntryLayoutConfig> {
  const task = writeChain.then(async () => {
    await ensureEntryLayoutLoaded();

    const current = state.config;
    const next = normalizeEntryLayout({
      version: ENTRY_LAYOUT_VERSION,
      visible: mutate(current).visible,
      known: availableEntryIds(),
    }).config;

    // 乐观更新：先让界面立刻生效，再落盘
    setState({ config: next, source: "settings", corrupt: false });

    try {
      await saveEntryLayout(next);
      persisted = next;
      return next;
    } catch (error) {
      setState({ config: persisted ?? current });
      throw error;
    }
  });

  // 让后续写请求排在这次之后，但不要把这次的失败传染给下一次
  writeChain = task.catch(() => undefined);
  return task;
}

/** 显示 / 隐藏单个入口 */
export function commitEntryVisibility(
  id: EntryId,
  visible: boolean,
): Promise<EntryLayoutConfig> {
  return commitEntryLayout((current) => ({
    ...current,
    visible: setEntryVisible(current.visible, id, visible),
  }));
}

/** 批量显示 / 隐藏（一次写盘） */
export function commitEntriesVisibility(
  ids: readonly EntryId[],
  visible: boolean,
): Promise<EntryLayoutConfig> {
  return commitEntryLayout((current) => ({
    ...current,
    visible: setEntriesVisible(current.visible, ids, visible),
  }));
}

/** 提交拖拽后的顺序（集合必须与当前一致，异常顺序会被安全合并） */
export function commitEntryOrder(
  desired: readonly EntryId[],
): Promise<EntryLayoutConfig> {
  return commitEntryLayout((current) => ({
    ...current,
    visible: mergeEntryOrder(current.visible, desired),
  }));
}

/** 相对移动一步（编辑态动作表与读屏的稳定替代路径） */
export function commitEntryMove(
  id: EntryId,
  delta: number,
): Promise<EntryLayoutConfig> {
  return commitEntryLayout((current) => ({
    ...current,
    visible: moveEntryByDelta(current.visible, id, delta),
  }));
}

/** 恢复默认布局 */
export function resetEntryLayout(): Promise<EntryLayoutConfig> {
  return commitEntryLayout(() => defaultEntryLayout());
}

/** 是否可以把该入口放进工作台（暂不可用一律不行） */
export function canCustomizeEntry(id: string): boolean {
  return entryById(id)?.availability === "available";
}

/** 测试专用：清掉内存状态，模拟「刚启动」 */
export function __resetEntryLayoutStore(): void {
  state = initialState();
  persisted = null;
  writeChain = Promise.resolve();
  loadTask = null;
  for (const listener of [...listeners]) listener();
}
