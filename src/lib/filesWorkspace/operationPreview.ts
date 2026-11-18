//! 文件操作预演：只读调用后端统计条目/字节/冲突/无权限/重复源。
//!
//! 预演不是执行计划的一部分：它不产生文件写入，也不缓存磁盘快照。
//! 用户确认后仍由既有的 fsops 任务执行；预演结果只用于「执行前告知」。

import { fsPreviewOperation, type OperationPreview } from "../bridge";

/** 复制/移动达到该数量时默认先预演；小批量保持直接执行，避免拖慢日常操作。 */
export const PREVIEW_COPY_THRESHOLD = 20;
/** 移动更接近破坏性操作，阈值更低。 */
export const PREVIEW_MOVE_THRESHOLD = 10;

export function shouldPreviewTransfer(count: number, effect: "copy" | "move"): boolean {
  return count >= (effect === "move" ? PREVIEW_MOVE_THRESHOLD : PREVIEW_COPY_THRESHOLD);
}

export async function previewFileOperation(input: {
  paths: string[];
  targetDir: string;
  effect: "copy" | "move";
}): Promise<OperationPreview> {
  return fsPreviewOperation(input.paths, input.targetDir, input.effect);
}
