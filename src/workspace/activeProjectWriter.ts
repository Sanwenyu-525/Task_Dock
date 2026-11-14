//! 活跃工作空间项目写入队列（P0-B，2026-11-13）。
//!
//! ## 唯一写入所有权
//! `workspace_active_project` 只表示「用户最后一次明确选择/打开的项目」。
//! 模块布局保存（`workspace_instance_save`）不再隐式写它；本队列是前端唯一的
//! 显式写入点（选择项目、创建后选择、删除后的回退、跨窗口 project-selected）。
//!
//! ## 为什么需要队列
//! 快速 A→B 或 A→B→A 时，如果并发 `invoke`，先发出的请求可能后落库，最终
//! `workspace_active_project` 变成过期值。这里串行化并**合并**排队请求：
//! 每次只发最新值，最后一次用户选择必然最后落库。旧请求失败不会阻塞新选择，
//! 只有「本次失败之后没有更新的选择」时才报告错误，避免旧错误盖住新成功。

export interface ActiveProjectWriter {
  /** 记录一次项目选择（null = 清除）。返回时只保证已入队，不保证已落库。 */
  write: (value: string | null) => void;
  /** 等待队列清空（测试 / 关闭窗口前用）。 */
  idle: () => Promise<void>;
  /** 最近一次「已入队」的值，用于诊断。 */
  latest: () => string | null | undefined;
}

export function createActiveProjectWriter(
  persist: (value: string | null) => Promise<void>,
  onError?: (error: unknown, superseded: boolean) => void,
): ActiveProjectWriter {
  const box: {
    pending: { value: string | null } | null;
    running: boolean;
    latest: string | null | undefined;
    waiters: Array<() => void>;
  } = { pending: null, running: false, latest: undefined, waiters: [] };

  const drain = async (): Promise<void> => {
    box.running = true;
    try {
      while (box.pending) {
        const target = box.pending.value;
        box.pending = null;
        try {
          await persist(target);
        } catch (e) {
          // 之后还有更新的选择：这次失败已被取代，不打扰用户。
          onError?.(e, box.pending !== null);
        }
      }
    } finally {
      box.running = false;
      const waiters = box.waiters;
      box.waiters = [];
      for (const resolve of waiters) resolve();
    }
  };

  return {
    write: (value) => {
      box.latest = value;
      box.pending = { value };
      if (!box.running) void drain();
    },
    idle: () => {
      if (!box.running && !box.pending) return Promise.resolve();
      return new Promise<void>((resolve) => box.waiters.push(resolve));
    },
    latest: () => box.latest,
  };
}
