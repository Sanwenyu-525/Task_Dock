//! 功能生命周期前端适配层。
//!
//! 职责边界（与后端 `src-tauri/src/lifecycle.rs` 对齐）：
//! - **不保存运行状态**：有效状态来自后端 `lifecycle_status` 的批量快照；
//! - **不保存用户意图**：暂停/恢复通过既有设置写入（`useSettingsStore.update`），
//!   SQLite 设置键是唯一事实源，完整页、胶囊、设置页与资源管理共享同一份值；
//! - 本文件只提供稳定的「模块 ID → 设置键」映射与展示元数据，避免各页面各自
//!   硬编码暂停逻辑。
//!
//! 暂停语义分四类（见验收报告与 ARCHITECTURE.md）：
//! - resident：常驻后台，支持独立暂停/恢复；
//! - task：任务级能力，暂停属于运行中的具体任务；
//! - ondemand：纯按需执行，没有常驻后台，不提供无效暂停按钮；
//! - shared：共享基础设施，不允许被单一模块停止（停止会丢其他业务的数据）。

import type { ModuleRuntimeStatus, Settings } from "./bridge";

export interface ModuleControl {
  /** 既有设置键：写入它即表达用户的暂停/恢复意图 */
  settingKey: keyof Settings & string;
  /** 请求「暂停」时写入的值（不同模块语义相反，例如开关型设置是 false） */
  pausedValue: boolean;
}

/**
 * 可暂停模块的唯一控制映射。
 *
 * 注意：这里只登记**已有真实后台工作**且能独立回收的模块。Agent 接入、
 * 诊断写入、任务数据、全局热键属于共享基础设施，不在此表；纯按需模块
 * （OCR / 应用扫描 / 历史 / 规划 / 收集箱 / 微件）也没有可独立停止的常驻工作。
 */
export const MODULE_CONTROLS: Readonly<Record<string, ModuleControl>> = {
  clipboard: { settingKey: "clipboard_paused", pausedValue: true },
  // 自动清理是「开关型」设置：false 才是暂停（线程真正退出）。
  shelf_cleanup: { settingKey: "shelf_auto_cleanup_enabled", pausedValue: false },
  reminders: { settingKey: "reminders_paused", pausedValue: true },
  actions: { settingKey: "actions_enabled", pausedValue: false },
  // 只停自动语音播报；提示音（audio_sound_enabled）是独立维度，不被连带改写。
  voice: { settingKey: "tts_enabled", pausedValue: false },
};

export function controlFor(moduleId: string): ModuleControl | undefined {
  return MODULE_CONTROLS[moduleId];
}

export function isControllableModule(moduleId: string): boolean {
  return moduleId in MODULE_CONTROLS;
}

/**
 * 由设置派生「用户意图是否为暂停」。
 *
 * 用于生命周期快照尚未返回时的首帧渲染（按钮图标不能等一次 IPC 才正确），
 * 也用于测试与验收脚本交叉核对后端 `intent`。
 */
export function modulePausedFromSettings(
  moduleId: string,
  settings: Partial<Settings> | null | undefined,
): boolean {
  const control = controlFor(moduleId);
  if (!control || !settings) return false;
  const raw = settings[control.settingKey];
  if (typeof raw !== "boolean") return false;
  return raw === control.pausedValue;
}

/** 写入设置时使用的补丁值（恢复 = 暂停值的反面）。 */
export function moduleControlPatch(moduleId: string, paused: boolean): Partial<Settings> | null {
  const control = controlFor(moduleId);
  if (!control) return null;
  return {
    [control.settingKey]: paused ? control.pausedValue : !control.pausedValue,
  } as Partial<Settings>;
}

export function moduleStatusById(
  statuses: readonly ModuleRuntimeStatus[] | null,
  moduleId: string,
): ModuleRuntimeStatus | undefined {
  return statuses?.find((item) => item.id === moduleId);
}

/** 是否处于「已接受暂停但仍在安全收尾」的过渡态。 */
export function isLifecycleTransition(status: ModuleRuntimeStatus | undefined): boolean {
  return status?.state === "pausing";
}

/** 状态徽标文案键（纯表现层映射，状态本身不在前端推导）。 */
export const LIFECYCLE_STATE_LABEL: Readonly<Record<string, string>> = {
  running: "lifecycle.state.running",
  pausing: "lifecycle.state.pausing",
  paused: "lifecycle.state.paused",
  stopped: "lifecycle.state.stopped",
  idle: "lifecycle.state.idle",
  error: "lifecycle.state.error",
  unsupported: "lifecycle.state.unsupported",
};
