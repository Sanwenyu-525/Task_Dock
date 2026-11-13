//! 投递执行与目录可用性兜底（完整面板投递区共用：拖放投递与「重试失败项」）。
//!
//! 与胶囊 `InboxDropPane.submit` 同一语义：
//! - 目标按 id 由 store 解析，前端不传目录字符串；
//! - 可用性是缓存快照（TTL 30s）：外接盘刚插回来时不能因旧快照一直拒绝，
//!   只在「看起来不可用」这条路径上强制重探一次（不轮询）；
//! - 重探后仍不可用 → 明确报「未执行投递」，绝不回退成暂存，也不伪装成功；
//! - 同一目标在途 / 700ms 去重窗口内的重复提交由 store 守卫拦下（返回 null），
//!   这里如实报「未执行」，由调用方决定提示方式。

import { errorMessage } from "../../lib/errors";
import type { ShelfDropReport } from "../../lib/bridge";
import { useDropTargetsStore } from "../../store/useDropTargetsStore";

export type DeliverResult =
  | { kind: "delivered"; report: ShelfDropReport; targetName: string }
  | { kind: "blocked"; reason: string }
  | { kind: "error"; message: string };

/** 投递一批路径到目标目录；投递前对「看起来不可用」的目标强制重探一次。 */
export async function deliverToTarget(
  targetId: string,
  paths: string[],
): Promise<DeliverResult> {  const target = useDropTargetsStore
    .getState()
    .targets.find((t) => t.id === targetId);
  if (!target) {
    return { kind: "blocked", reason: "投递目标不存在或已被移除" };
  }
  if (!target.available) {
    await useDropTargetsStore.getState().load({ force: true });
    const fresh = useDropTargetsStore
      .getState()
      .targets.find((t) => t.id === targetId);
    if (!fresh || !fresh.available) {
      return {
        kind: "blocked",
        reason: `「${target.name}」目录不可用，未执行投递`,
      };
    }
  }
  try {
    const report = await useDropTargetsStore.getState().drop(targetId, paths);
    // null = 在途守卫/去重窗口拦下：未投递，如实说明而不是当作成功。
    if (!report) {
      return {
        kind: "blocked",
        reason: `「${target.name}」已有投递在进行中，请等待完成后再试`,
      };
    }
    return { kind: "delivered", report, targetName: target.name };
  } catch (e) {
    return { kind: "error", message: errorMessage(e) };
  }
}

/**
 * 投递一次「通用拖入」会话到目标目录（v49）。
 *
 * 内容（虚拟文件流 / 图片字节）已经在后端暂存区，这里只传 `operationId`；
 * 其余兜底与 `deliverToTarget` **完全一致**：目标按 id 解析、不可用先重探一次、
 * 在途/去重守卫拦下时如实报「未执行」，绝不伪装成功。
 */
export async function deliverOperationToTarget(
  targetId: string,
  operationId: string,
  count: number,
): Promise<DeliverResult> {
  const target = useDropTargetsStore.getState().targets.find((t) => t.id === targetId);
  if (!target) {
    return { kind: "blocked", reason: "投递目标不存在或已被移除" };
  }
  if (!target.available) {
    await useDropTargetsStore.getState().load({ force: true });
    const fresh = useDropTargetsStore.getState().targets.find((t) => t.id === targetId);
    if (!fresh || !fresh.available) {
      return { kind: "blocked", reason: `「${target.name}」目录不可用，未执行投递` };
    }
  }
  try {
    const report = await useDropTargetsStore.getState().commit(targetId, operationId, count);
    if (!report) {
      return {
        kind: "blocked",
        reason: `「${target.name}」已有投递在进行中，请等待完成后再试`,
      };
    }
    return { kind: "delivered", report, targetName: target.name };
  } catch (e) {
    return { kind: "error", message: errorMessage(e) };
  }
}
