//! 文件操作队列（当前会话）：只报告前端真实知道的状态，不伪造后端进度/取消。
//!
//! 后端 `fs_copy_paths` / `fs_move_paths` / `fs_delete_paths` 是一次阻塞 IPC，
//! 不提供逐文件进度事件，也不支持安全中止。因此：
//! - running 阶段只显示「总数」与「处理中」，已完成计数保持 0；
//! - `cancelable` 恒为 false，UI 必须明确标注「当前后端不可安全取消」；
//! - IPC 返回后用量化 report 填入 ok/failed/skipped/partial，不推断不存在的结果。

export type QueueEffect = "copy" | "move" | "delete" | "deletePermanent" | "rename";
export type QueueStatus = "running" | "done" | "failed";

export interface FileQueueEntry {
  id: string;
  effect: QueueEffect;
  total: number;
  startedAt: number;
  finishedAt: number | null;
  status: QueueStatus;
  ok: number;
  failed: number;
  skipped: number;
  partial: number;
  error: string | null;
}

interface QueueOpReportLike {
  ok: number;
  failed: number;
  skipped: number;
  partial: number;
}

const MAX_ENTRIES = 8;
let entries: FileQueueEntry[] = [];
const listeners = new Set<(items: FileQueueEntry[]) => void>();

function emit(): void {
  const snapshot = entries.map((entry) => ({ ...entry }));
  for (const listener of listeners) listener(snapshot);
}

export function startQueueOperation(input: {
  id: string;
  effect: QueueEffect;
  total: number;
}): void {
  const existing = entries.find((entry) => entry.id === input.id);
  if (existing) return;
  const entry: FileQueueEntry = {
    id: input.id,
    effect: input.effect,
    total: input.total,
    startedAt: Date.now(),
    finishedAt: null,
    status: "running",
    ok: 0,
    failed: 0,
    skipped: 0,
    partial: 0,
    error: null,
  };
  entries = [...entries, entry].slice(-MAX_ENTRIES);
  emit();
}

export function finishQueueOperation(
  id: string,
  report: QueueOpReportLike | null,
  error: string | null = null,
): void {
  const current = entries.find((entry) => entry.id === id);
  if (!current) return;
  entries = entries.map((entry) =>
    entry.id !== id
      ? entry
      : {
          ...entry,
          finishedAt: Date.now(),
          status: error ? "failed" : "done",
          ok: report?.ok ?? 0,
          failed: report?.failed ?? 0,
          skipped: report?.skipped ?? 0,
          partial: report?.partial ?? 0,
          error,
        },
  );
  emit();
}

export function getQueueEntries(): FileQueueEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

export function subscribeQueue(listener: (items: FileQueueEntry[]) => void): () => void {
  listeners.add(listener);
  listener(getQueueEntries());
  return () => {
    listeners.delete(listener);
  };
}

/** 后端没有安全取消通道；UI 只能等待 IPC 返回，不能显示假取消按钮。 */
export const QUEUE_CANCEL_SUPPORTED = false;

/** 前端文件操作并发上限：同一时刻只允许一个高成本 IPC，其余在内存中排队。 */
export const MAX_CONCURRENT_OPERATIONS = 1;
let activeOperations = 0;
const operationWaiters: Array<() => void> = [];

/**
 * 用有限并发包裹一次真实文件操作。排队期间不动磁盘；释放时把名额直接交给
 * 下一个等待者，避免并发计数抖动。抛出/取消路径都在 finally 归还名额。
 */
export async function withFileOperationSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeOperations >= MAX_CONCURRENT_OPERATIONS) {
    await new Promise<void>((resolve) => operationWaiters.push(resolve));
  } else {
    activeOperations += 1;
  }
  try {
    return await task();
  } finally {
    const next = operationWaiters.shift();
    if (next) next();
    else activeOperations -= 1;
  }
}
