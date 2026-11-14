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

export interface ActiveProjectWriteResult {
  /** 本次值是否仍是最后一次意图并成功落库（被更新选择取代时为 false）。 */
  applied: boolean;
  /** 落库失败原因；被取代或成功时为 null。 */
  error: unknown | null;
}

export interface ActiveProjectWriter {
  /** 记录一次项目选择（null = 清除）。返回时只保证已入队，不保证已落库。 */
  write: (value: string | null) => void;
  /**
   * 记录一次选择并等待真实结果。导航提交等需要「知悉是否被新选择取代」的调用方
   * 必须用它，而不是自己直接 invoke（否则会绕过 latest-wins 串行队列）。
   */
  submit: (value: string | null) => Promise<ActiveProjectWriteResult>;
  /** 等待队列清空（测试 / 关闭窗口前用）。 */
  idle: () => Promise<void>;
  /** 最近一次「已入队」的值，用于诊断。 */
  latest: () => string | null | undefined;
}

export function createActiveProjectWriter(
  persist: (value: string | null) => Promise<void>,
  onError?: (error: unknown, superseded: boolean) => void,
): ActiveProjectWriter {
  type Waiter = (result: ActiveProjectWriteResult) => void;
  const box: {
    pending: { value: string | null; waiters: Waiter[] } | null;
    running: boolean;
    latest: string | null | undefined;
    waiters: Array<() => void>;
  } = { pending: null, running: false, latest: undefined, waiters: [] };

  const drain = async (): Promise<void> => {
    box.running = true;
    try {
      while (box.pending) {
        const item = box.pending;
        box.pending = null;
        try {
          await persist(item.value);
          // 落库期间又出现不同的新选择：本次结果已被取代，不能宣称生效。
          // 断言避开 TS 对 `box.pending = null` 的过度收窄（await 期间会被重新赋值）。
          const queued = box.pending as { value: string | null } | null;
          const superseded = queued !== null && queued.value !== item.value;
          const result: ActiveProjectWriteResult = { applied: !superseded, error: null };
          for (const resolve of item.waiters) resolve(result);
        } catch (e) {
          // 之后还有更新的选择：这次失败已被取代，不打扰用户。
          const queued = box.pending as { value: string | null } | null;
          const superseded = queued !== null && queued.value !== item.value;
          onError?.(e, superseded);
          const result: ActiveProjectWriteResult = { applied: false, error: e };
          for (const resolve of item.waiters) resolve(result);
        }
      }
    } finally {
      box.running = false;
      const waiters = box.waiters;
      box.waiters = [];
      for (const resolve of waiters) resolve();
    }
  };

  const submit = (value: string | null): Promise<ActiveProjectWriteResult> =>
    new Promise((resolve) => {
      box.latest = value;
      // 尚未开始落库的旧排队值直接被新选择取代：它的调用方得到 applied=false，
      // 不会为了一个过期目标覆盖最新选择。
      if (box.pending) {
        for (const waiter of box.pending.waiters) {
          waiter({ applied: false, error: null });
        }
      }
      box.pending = { value, waiters: [resolve] };
      if (!box.running) void drain();
    });

  return {
    write: (value) => {
      void submit(value);
    },
    submit,
    idle: () => {
      if (!box.running && !box.pending) return Promise.resolve();
      return new Promise<void>((resolve) => box.waiters.push(resolve));
    },
    latest: () => box.latest,
  };
}
