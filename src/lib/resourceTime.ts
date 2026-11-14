//! 资源页时间/采样窗口的可读格式：界面只显示短时间，完整时区信息放 Tooltip。
//!
//! 不丢失时区语义：短文本只用于「刚刚/今天」的实时读数；悬浮与
//! 屏幕阅读器仍拿到 `YYYY-MM-DD HH:mm UTC±HH:MM` 的完整时间。

import { formatLocalStamp } from "./format";

export interface ResourceStamp {
  /** `HH:mm`，用于「13:25 更新」这类短文本。 */
  time: string;
  /** 完整本地时间 + 明确时区，用于 Tooltip / aria。 */
  full: string;
}

export function resourceStamp(iso: string | null | undefined): ResourceStamp | null {
  const stamp = formatLocalStamp(iso);
  if (!stamp) return null;
  return {
    time: stamp.time,
    full: `${stamp.date} ${stamp.time} ${stamp.zone}`,
  };
}

/** 毫秒采样窗口 → 整数秒；无效或非正值返回 null，不伪造窗口。 */
export function sampleWindowSeconds(ms: number | null | undefined): number | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.max(1, Math.round(ms / 1000));
}
