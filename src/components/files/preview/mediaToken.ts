//! 预览资源生命周期：媒体 token 与 Blob URL 的有界跟踪器。
//!
//! 媒体 URL 由 Rust 端注册（30 分钟 TTL / 最多 64 个），关闭或切换预览时必须
//! **恰好释放一次**：`release` 只在仍活跃时返回 true，调用方据此决定是否发 IPC。
//! Blob URL 同理：`URL.revokeObjectURL` 只对仍持有的对象调用一次。

import { fsReleasePreviewUrl } from "../../../lib/bridge";

export interface PreviewTokenTracker {
  /** 登记一个已取得、尚未释放的媒体 token。 */
  register(url: string): void;
  /** 释放：只有仍活跃的 token 返回 true（调用方据此发 IPC），重复调用返回 false。 */
  release(url: string): boolean;
  has(url: string): boolean;
  readonly activeCount: number;
  readonly historySize: number;
}

/**
 * 有界媒体 token 跟踪器：活跃集合 + 最近释放历史（默认上限 128）。
 * 活跃集合保证同一 token 只发一次释放 IPC；历史只用于诊断，超限淘汰最旧，
 * 不会随预览次数无限增长。
 */
export function createPreviewTokenTracker(historyMax = 128): PreviewTokenTracker {
  const active = new Set<string>();
  const history: string[] = [];
  return {
    register(url: string): void {
      if (url) active.add(url);
    },
    release(url: string): boolean {
      if (!url || !active.has(url)) return false;
      active.delete(url);
      history.push(url);
      if (history.length > historyMax) history.shift();
      return true;
    },
    has(url: string): boolean {
      return active.has(url);
    },
    get activeCount(): number {
      return active.size;
    },
    get historySize(): number {
      return history.length;
    },
  };
}

/**
 * 释放一个媒体 token：只有当前仍活跃时才调用一次 `fsReleasePreviewUrl`。
 * 释放失败不影响关闭/切换流程（后端 release 幂等兜底）。
 */
export function releaseMediaToken(tracker: PreviewTokenTracker, url: string | null): void {
  if (!url) return;
  if (!tracker.release(url)) return;
  Promise.resolve(fsReleasePreviewUrl(url)).catch(() => undefined);
}

export interface ObjectUrlTracker {
  /** 由 Blob 创建 URL 并登记；空 Blob 返回 null。 */
  create(blob: Blob): string | null;
  /** 吊销：只有仍持有该 URL 时返回 true。 */
  revoke(url: string | null): boolean;
  readonly activeCount: number;
}

/** Blob URL 跟踪器：同一 URL 只吊销一次，组件卸载后不会留下悬空引用。 */
export function createObjectUrlTracker(): ObjectUrlTracker {
  const active = new Set<string>();
  return {
    create(blob: Blob): string | null {
      if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
      const url = URL.createObjectURL(blob);
      active.add(url);
      return url;
    },
    revoke(url: string | null): boolean {
      if (!url || !active.has(url)) return false;
      active.delete(url);
      URL.revokeObjectURL(url);
      return true;
    },
    get activeCount(): number {
      return active.size;
    },
  };
}

/** base64 → Uint8Array（图片原始字节 / PDF 共用，不引入第三方解码库）。 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
