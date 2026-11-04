//! 异步订阅作用域：Tauri 的 listen 返回 Promise，组件/应用在 Promise
//! 兑现前卸载时，迟到的 unlisten 必须立即执行，否则监听器永久泄漏。
//!
//! 用法：
//! ```ts
//! const scope = createSubscriptionScope();
//! scope.add(onSomething(cb));
//! return () => scope.dispose();
//! ```

export type UnlistenFn = () => void;

export interface SubscriptionScope {
  readonly closed: boolean;
  /**
   * 登记一个尚未兑现的监听；作用域已关闭时立即反订阅。
   * 返回 Promise<boolean>：true 表示监听已建立并归本作用域管理，false 表示
   * 订阅失败或作用域已关闭（调用方据此决定是否重建订阅，失败不会产生
   * 未处理的 rejection）。既有调用方可忽略返回值。
   */
  add: (pending: Promise<UnlistenFn>) => Promise<boolean>;
  /** 关闭作用域并释放全部已建立的监听（幂等）。 */
  dispose: () => void;
}

export function createSubscriptionScope(): SubscriptionScope {
  const unlisteners: UnlistenFn[] = [];
  let closed = false;

  return {
    get closed() {
      return closed;
    },
    add(pending) {
      return pending.then(
        (unlisten) => {
          if (closed) {
            safeCall(unlisten);
            return false;
          }
          unlisteners.push(unlisten);
          return true;
        },
        () => false, // 订阅失败不应产生未处理的 rejection，由调用方决定是否重试
      );
    },
    dispose() {
      if (closed) return;
      closed = true;
      for (const unlisten of unlisteners.splice(0)) safeCall(unlisten);
    },
  };
}

function safeCall(fn: UnlistenFn) {
  try {
    fn();
  } catch {
    // 单个反订阅失败不应阻断其余清理
  }
}
