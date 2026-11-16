/**
 * 应用退出握手的前端处理器。
 *
 * Rust 发出带 requestId 的 `app-before-exit` 后等待回执；本模块复用工作台已有的
 * workspaceLeaveGuardRef，不建立第二套保存机制。同一个 requestId 只处理一次，
 * 保存失败必须回执 false，绝不能把失败伪装成成功。
 */
export interface AppExitHandshakeOptions {
  getFlush: () => (() => Promise<boolean>) | null;
  ack: (requestId: number, ok: boolean) => Promise<boolean>;
  onError?: (error: unknown) => void;
}

export type AppExitHandler = (requestId: number) => Promise<boolean>;

export function createAppExitHandler(options: AppExitHandshakeOptions): AppExitHandler {
  const handled = new Set<number>();

  return async (requestId: number): Promise<boolean> => {
    if (!Number.isFinite(requestId) || handled.has(requestId)) return false;
    handled.add(requestId);
    // 只需保留最近一小段，避免长期运行积累所有退出请求编号。
    if (handled.size > 32) {
      const oldest = handled.values().next().value;
      if (oldest !== undefined) handled.delete(oldest);
    }

    let ok = true;
    try {
      const flush = options.getFlush();
      if (flush) ok = await flush();
    } catch (error) {
      ok = false;
      options.onError?.(error);
    }

    try {
      const accepted = await options.ack(requestId, ok);
      if (!accepted) {
        options.onError?.(new Error("退出保存回执已过期，后端已取消本次退出请求"));
        return false;
      }
      return ok;
    } catch (error) {
      options.onError?.(error);
      return false;
    }
  };
}
