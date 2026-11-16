/** 工作台窗口关闭握手：先阻止本次关闭，等待正文 flush，成功后才真正关闭。 */
export interface WorkbenchCloseEvent {
  preventDefault: () => void;
}

export interface WorkbenchCloseWindow {
  onCloseRequested: (
    handler: (event: WorkbenchCloseEvent) => void | Promise<void>,
  ) => Promise<() => void>;
  close: () => Promise<void>;
}

export interface WorkbenchCloseGuardOptions {
  window: WorkbenchCloseWindow;
  /** 当前工作台注册的正文离开守卫；没有正文模块时返回 null。 */
  getFlush: () => (() => Promise<boolean>) | null;
  /** 保存失败/关闭失败时通知 UI；不会吞掉错误。 */
  onError: (error: unknown) => void;
}

/**
 * 安装关闭握手。设计约束：
 * - 无正文守卫时不拦截，窗口走原生正常关闭；
 * - 有守卫时先同步 `preventDefault()`，再 await flush；
 * - 关闭成功前置 allow 标记，二次 `close()` 不再被拦截；
 * - 重复关闭只跑一轮 flush；保存失败保持窗口并恢复可重试状态。
 */
export async function installWorkbenchCloseGuard(
  options: WorkbenchCloseGuardOptions,
): Promise<() => void> {
  let allowClose = false;
  let running = false;
  let disposed = false;

  const stop = await options.window.onCloseRequested((event) => {
    if (disposed || allowClose) return;
    const flush = options.getFlush();
    if (!flush) return;

    // 必须在 await 前同步阻止；否则 Rust 侧可能已经完成销毁。
    event.preventDefault();
    if (running) return;
    running = true;

    void (async () => {
      try {
        const ok = await flush();
        if (!ok) {
          options.onError(new Error("正文尚未保存，工作台窗口保持打开"));
          return;
        }
        allowClose = true;
        try {
          await options.window.close();
        } catch (error) {
          allowClose = false;
          options.onError(error);
        }
      } catch (error) {
        options.onError(error);
      } finally {
        running = false;
      }
    })();
  });

  return () => {
    disposed = true;
    stop();
  };
}
