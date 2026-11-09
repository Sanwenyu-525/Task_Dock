// 深链配对意图：系统相机扫描 taskdock://pair 后，App 可能在冷启动或已运行时被唤起。
// 这里用一个只存在于内存的待处理载荷 + 订阅者，避免把 URL 参数塞进导航栈类型，
// 也避免在屏幕挂载前丢失载荷。载荷含 6 位配对码，不写日志、不落盘。

import { parsePairingUri, type PairingTarget } from "./pairing";

type Listener = (target: PairingTarget) => void;

let pending: PairingTarget | null = null;
const listeners = new Set<Listener>();

/** 记录深链载荷并通知已挂载的配对页；返回是否为合法 TaskDock 配对链接。 */
export function offerPairingUri(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const target = parsePairingUri(raw);
  if (!target) return false;
  pending = target;
  for (const listener of listeners) listener(target);
  return true;
}

/** 配对页挂载时取走待处理载荷（取走后清空，避免返回再进入时重复弹出）。 */
export function consumePendingPairing(): PairingTarget | null {
  const target = pending;
  pending = null;
  return target;
}

export function subscribePendingPairing(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearPendingPairing(): void {
  pending = null;
}
