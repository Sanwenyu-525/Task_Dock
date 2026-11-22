//! 订阅可选的 A/C 数据源；未注入时恒为 null，组件据此显示「等待接入」。

import { useSyncExternalStore } from "react";

import type { WidgetSource } from "../../lib/widgets/sources";

function noopSubscribe(_onChange: () => void): () => void {
  return () => {};
}

function nullSnapshot<T>(): T | null {
  return null;
}

export function useWidgetSource<T>(source: WidgetSource<T> | undefined): T | null {
  const subscribe = source ? source.subscribe : noopSubscribe;
  const getSnapshot = source ? source.getSnapshot : nullSnapshot<T>;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
