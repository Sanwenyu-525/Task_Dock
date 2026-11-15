// 上传取消令牌：UI 持有意图，service 在启动请求前、分块之间、请求返回后检查，
// 同时把取消意图交给 FileClient，让正在进行的 HTTP 请求真正 abort。
//
// 注意：取消不是“删本地文件”。本机素材、系统相册副本必须保留；只清理本轮尚未
// 完成的远端半成品，已经完整接收的 desktop 文件不因取消暂存架而删除。
export interface TransferCancelToken {
  readonly cancelled: boolean;
  cancel(): void;
  isCancelled(): boolean;
  /** 注册在途请求的中止回调；令牌已取消时立即执行一次。 */
  onCancel(listener: () => void): () => void;
}

export function createTransferCancelToken(): TransferCancelToken {
  let cancelled = false;
  const listeners = new Set<() => void>();
  return {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // 单个 abort 失败不能阻止其他在途请求被取消；上层仍会依据 cancelled 停止后续分块。
        }
      }
    },
    isCancelled() {
      return cancelled;
    },
    onCancel(listener) {
      listeners.add(listener);
      if (cancelled) {
        try {
          listener();
        } catch {
          // 同上：注册时立即中止失败不改变取消语义。
        }
      }
      return () => listeners.delete(listener);
    },
  };
}
