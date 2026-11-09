//! 手机配对弹层的全局打开意图。
//!
//! 配对是「新增设备时才做一次」的独立动作，不应只能从设置页深处进入：
//! 标题栏快捷入口与设置分区共用**同一个**对话框实例（App 根部常驻挂载），
//! 因此这里只保存一个布尔开合状态，不携带业务数据、不写入设置/备份。
//!
//! 关闭或配对成功后广播 `MOBILE_SYNC_CHANGED_EVENT`，让设置分区刷新
//! 状态与设备列表（对话框本身不持有设备列表）。

import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function openMobilePairing(): void {
  if (open) return;
  open = true;
  emit();
}

export function closeMobilePairing(): void {
  if (!open) return;
  open = false;
  emit();
}

export function isMobilePairingOpen(): boolean {
  return open;
}

/** 配对会话可能改变桌面端设备列表（成功/关闭/撤销后）。 */
export const MOBILE_SYNC_CHANGED_EVENT = "taskdock:mobile-sync-changed";

export function notifyMobileSyncChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(MOBILE_SYNC_CHANGED_EVENT));
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMobilePairingOpen(): boolean {
  return useSyncExternalStore(subscribe, isMobilePairingOpen, isMobilePairingOpen);
}
