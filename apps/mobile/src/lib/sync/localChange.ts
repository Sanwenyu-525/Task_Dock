// 本机数据变更信号：数据层在每次成功写库后通知一次，不携带任何业务内容。
//
// 为什么要独立成文件：db/* 需要通知「有新内容待同步」，而调度器在 lib/sync/autoSync.ts
// 里需要读 db/*；把信号放在这里可以让数据层只依赖一个零依赖的小模块，避免循环引用。
type Listener = () => void;

const listeners = new Set<Listener>();

/** 记录一次本地写入（收集箱 / 任务 / 笔记）。调用方不需要 await。 */
export function notifyLocalChange(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 监听者异常不能影响刚刚成功的写库
    }
  }
}

export function subscribeLocalChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
