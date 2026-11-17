//! 异步等待上限（客户端）。
//!
//! 只给「必须尽快给出确定状态」的入口使用：窗口创建命令、初始化读请求。
//! 超时即拒绝，晚到的结果被忽略——调用方据此进入可重试的失败态，
//! 而不是让按钮或启动页无限停在 loading。
//!
//! 不用于回执（ack）等待：那类流程有独立的事务超时与终态语义。

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
