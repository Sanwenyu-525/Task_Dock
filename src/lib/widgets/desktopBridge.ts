//! 桌面微件窗口 IPC 薄封装。
//!
//! 所有窗口创建/销毁/几何命令都在 Rust 侧校验调用者身份；这里只做类型化调用，
//! 不缓存窗口状态、不轮询。事件订阅由调用方在卸载时释放。

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  WIDGET_EVENTS,
  type DesktopActionKind,
  type WidgetActionEvent,
  type WidgetBoundsReport,
  type WidgetDismissedEvent,
  type WidgetSnapshotEnvelope,
  type WidgetSnapshotRequestEvent,
  type WidgetWindowInfo,
} from "./desktop";
import type { WidgetDesktopState, WidgetType } from "./model";

function available(): boolean {
  return typeof window !== "undefined" && isTauri();
}

export interface ShowWidgetWindowSpec {
  widgetType: WidgetType;
  width: number;
  height: number;
  nx?: number;
  ny?: number;
  monitor?: string;
  topmost: boolean;
  /** true：应用 nx/ny；false：保留当前位置（仅更新尺寸/置顶）。 */
  place: boolean;
  resetPosition?: boolean;
}

export async function showWidgetWindow(spec: ShowWidgetWindowSpec): Promise<WidgetWindowInfo> {
  return invoke<WidgetWindowInfo>("show_widget_window", {
    spec: {
      widgetType: spec.widgetType,
      width: spec.width,
      height: spec.height,
      nx: spec.nx,
      ny: spec.ny,
      monitor: spec.monitor,
      topmost: spec.topmost,
      place: spec.place,
      resetPosition: spec.resetPosition ?? false,
    },
  });
}

export async function hideWidgetWindow(type: WidgetType): Promise<void> {
  await invoke("hide_widget_window", { widgetType: type });
}

export async function dismissWidgetWindow(): Promise<void> {
  await invoke("dismiss_widget_window");
}

export async function setWidgetTopmost(topmost: boolean): Promise<void> {
  await invoke("set_widget_topmost", { topmost });
}

/** 微件窗口读取自身初始状态（置顶/尺寸/锚点）；仅 `widget-*` 窗口可用。 */
export async function getWidgetWindowInfo(): Promise<WidgetWindowInfo> {
  return invoke<WidgetWindowInfo>("widget_window_info");
}

/** 拖动/缩放结束后调用；Rust 读取真实几何并回传主窗口。 */
export async function reportWidgetBounds(): Promise<void> {
  await invoke("report_widget_bounds");
}

export async function resetWidgetPosition(type: WidgetType): Promise<void> {
  await invoke("reset_widget_position", { widgetType: type });
}

export interface SnapshotPublishMeta {
  /** 主窗口 WebView 会话标识；接收端据此区分主窗重载前后的 revision。 */
  epoch: string;
  /** 目标窗口代际；缺省时由 Rust 读取当前窗口代际。 */
  generation?: number;
}

export async function publishWidgetSnapshot(
  type: WidgetType,
  revision: number,
  snapshot: unknown,
  meta: SnapshotPublishMeta,
): Promise<boolean> {
  if (!available()) return false;
  return invoke<boolean>("publish_widget_snapshot", {
    widgetType: type,
    revision,
    epoch: meta.epoch,
    generation: meta.generation ?? null,
    snapshot,
  });
}

export async function requestWidgetSnapshot(): Promise<void> {
  await invoke("request_widget_snapshot");
}

export async function dispatchWidgetAction(
  action: DesktopActionKind,
  options: { tab?: string; taskId?: string } = {},
): Promise<void> {
  await invoke("dispatch_widget_action", {
    action,
    tab: options.tab ?? null,
    taskId: options.taskId ?? null,
  });
}

export function onWidgetSnapshot(listener: (payload: WidgetSnapshotEnvelope) => void): Promise<UnlistenFn> {
  return listen<WidgetSnapshotEnvelope>(WIDGET_EVENTS.snapshot, (event) => listener(event.payload));
}

export function onWidgetSnapshotRequest(
  listener: (payload: WidgetSnapshotRequestEvent) => void,
): Promise<UnlistenFn> {
  return listen<WidgetSnapshotRequestEvent>(WIDGET_EVENTS.request, (event) =>
    listener(event.payload),
  );
}

export function onWidgetAction(listener: (payload: WidgetActionEvent) => void): Promise<UnlistenFn> {
  return listen<WidgetActionEvent>(WIDGET_EVENTS.action, (event) => listener(event.payload));
}

export function onWidgetBounds(listener: (payload: WidgetBoundsReport) => void): Promise<UnlistenFn> {
  return listen<WidgetBoundsReport>(WIDGET_EVENTS.bounds, (event) => listener(event.payload));
}

export function onWidgetDismissed(
  listener: (payload: WidgetDismissedEvent) => void,
): Promise<UnlistenFn> {
  return listen<WidgetDismissedEvent>(WIDGET_EVENTS.dismissed, (event) => listener(event.payload));
}

/**
 * 将 IPC 回报的窗口信息合并进布局配置；只保留归一化锚点与逻辑尺寸。
 * `customSize` 仅在用户手动缩放后为 true——预设尺寸由 `size` 决定，程序
 * set_size / 首次创建测量值不得覆盖，否则切换 sm/md/lg 会失效。
 */
export function desktopFromWindowInfo(
  info: WidgetWindowInfo,
  previous: WidgetDesktopState,
  customSize = false,
): WidgetDesktopState {
  const next: WidgetDesktopState = {
    ...previous,
    nx: info.nx,
    ny: info.ny,
    monitor: info.monitor ?? undefined,
    topmost: info.topmost,
  };
  if (customSize) {
    next.width = Math.round(info.width);
    next.height = Math.round(info.height);
  }
  return next;
}
