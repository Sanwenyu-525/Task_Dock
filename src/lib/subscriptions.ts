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
  /** 登记一个尚未兑现的监听；作用域已关闭时立即反订阅。 */
  add: (pending: Promise<UnlistenFn>) => void;
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
      pending.then(
        (unlisten) => {
          if (closed) {
            safeCall(unlisten);
          } else {
            unlisteners.push(unlisten);
          }
        },
        () => {
          // 订阅失败不应产生未处理的 rejection；功能层已有状态提示
        },
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
