//! 功能生命周期展示元数据（仅文案/图标，不参与状态推导）。
//!
//! 模块 ID 来自后端 `lifecycle_status` 的稳定 ID；这里提供本地化标签与
//! 「暂停作用范围」说明。状态、可暂停性、后台活动标记一律以后端快照为准，
//! 避免前端再维护一份会漂移的事实。

import type { MessageKey } from "../i18n";

export type ModuleIcon =
  | "clipboard"
  | "shelf"
  | "bell"
  | "activity"
  | "volume"
  | "plug"
  | "file-text"
  | "keyboard"
  | "workflow"
  | "timer"
  | "archive"
  | "layers"
  | "layout-grid"
  | "app-window"
  | "history"
  | "map"
  | "scan-text"
  | "inbox";

export interface ModulePresentation {
  label: MessageKey;
  /** 暂停作用范围（也是按钮提示的第二行） */
  scope: MessageKey;
  icon: ModuleIcon;
}

export const MODULE_PRESENTATION: Readonly<Record<string, ModulePresentation>> = {
  clipboard: {
    label: "lifecycle.module.clipboard.label",
    scope: "lifecycle.module.clipboard.scope",
    icon: "clipboard",
  },
  shelf_cleanup: {
    label: "lifecycle.module.shelfCleanup.label",
    scope: "lifecycle.module.shelfCleanup.scope",
    icon: "shelf",
  },
  reminders: {
    label: "lifecycle.module.reminders.label",
    scope: "lifecycle.module.reminders.scope",
    icon: "bell",
  },
  actions: {
    label: "lifecycle.module.actions.label",
    scope: "lifecycle.module.actions.scope",
    icon: "activity",
  },
  voice: {
    label: "lifecycle.module.voice.label",
    scope: "lifecycle.module.voice.scope",
    icon: "volume",
  },
  agents: {
    label: "lifecycle.module.agents.label",
    scope: "lifecycle.module.agents.scope",
    icon: "plug",
  },
  diagnostics: {
    label: "lifecycle.module.diagnostics.label",
    scope: "lifecycle.module.diagnostics.scope",
    icon: "file-text",
  },
  hotkeys: {
    label: "lifecycle.module.hotkeys.label",
    scope: "lifecycle.module.hotkeys.scope",
    icon: "keyboard",
  },
  workflows: {
    label: "lifecycle.module.workflows.label",
    scope: "lifecycle.module.workflows.scope",
    icon: "workflow",
  },
  focus: {
    label: "lifecycle.module.focus.label",
    scope: "lifecycle.module.focus.scope",
    icon: "timer",
  },
  backup: {
    label: "lifecycle.module.backup.label",
    scope: "lifecycle.module.backup.scope",
    icon: "archive",
  },
  workspace: {
    label: "lifecycle.module.workspace.label",
    scope: "lifecycle.module.workspace.scope",
    icon: "layers",
  },
  widgets: {
    label: "lifecycle.module.widgets.label",
    scope: "lifecycle.module.widgets.scope",
    icon: "layout-grid",
  },
  apps: {
    label: "lifecycle.module.apps.label",
    scope: "lifecycle.module.apps.scope",
    icon: "app-window",
  },
  history: {
    label: "lifecycle.module.history.label",
    scope: "lifecycle.module.history.scope",
    icon: "history",
  },
  planning: {
    label: "lifecycle.module.planning.label",
    scope: "lifecycle.module.planning.scope",
    icon: "map",
  },
  ocr: {
    label: "lifecycle.module.ocr.label",
    scope: "lifecycle.module.ocr.scope",
    icon: "scan-text",
  },
  collection: {
    label: "lifecycle.module.collection.label",
    scope: "lifecycle.module.collection.scope",
    icon: "inbox",
  },
};

export function presentationFor(moduleId: string): ModulePresentation | undefined {
  return MODULE_PRESENTATION[moduleId];
}

/** 后台活动标记的本地化键（未知标记原样显示稳定 ID，不编造文案）。 */
export const BACKGROUND_LABELS: Readonly<Record<string, MessageKey>> = {
  "clipboard-monitor": "lifecycle.background.clipboardMonitor",
  "clipboard-maintenance": "lifecycle.background.clipboardMaintenance",
  "clipboard-paste": "lifecycle.background.clipboardPaste",
  "shelf-auto-cleanup": "lifecycle.background.shelfAutoCleanup",
  "shared-scheduler-tick": "lifecycle.background.sharedScheduler",
  "agent-ingest-pipeline": "lifecycle.background.agentIngest",
  "agent-adapters": "lifecycle.background.agentAdapters",
  "diagnostics-writer": "lifecycle.background.diagnosticsWriter",
  "global-hotkey-registration": "lifecycle.background.hotkeys",
  "ocr-task": "lifecycle.background.ocrTask",
};

/** 后端稳定错误码 → 本地化文案；未知代码不展示原始服务端文本。 */
export const LIFECYCLE_ERROR_LABELS: Readonly<Record<string, MessageKey>> = {
  settings_unavailable: "lifecycle.error.settingsUnavailable",
  monitor_not_running: "lifecycle.error.monitorNotRunning",
  worker_not_running: "lifecycle.error.workerNotRunning",
  worker_start_failed: "lifecycle.error.workerStartFailed",
  cleanup_failed: "lifecycle.error.cleanupFailed",
  agent_hub_unavailable: "lifecycle.error.agentHubUnavailable",
};
