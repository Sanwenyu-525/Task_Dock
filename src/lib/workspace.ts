//! 工作区批量启动的状态汇总（纯函数，便于直接单测）。
//!
//! 为什么要单独抽出来：这段统计是「用户唯一能看到的执行结论」。
//! 把未执行/取消的目标算成成功，等于对用户谎报——必须可测。

export type ItemState =
  | { phase: "pending" }
  | { phase: "running" }
  | { phase: "done"; success: boolean }
  | { phase: "skipped" };

export interface WorkspaceSummary {
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  /** 尚未开始（仍在排队） */
  pending: number;
  text: string | null;
  tone: "ok" | "warn" | "bad" | null;
}

/**
 * 汇总一次批量启动的结果。
 *
 * 规则：
 * - 分母恒为「计划启动的目标数」，取消的目标计入 skipped，绝不并入成功；
 * - 全部成功必须 ok === total 且 skipped === 0；
 * - 一个都没跑就被取消 → 明确说「已取消」，而不是「全部成功 0/0」；
 * - 运行中 / 尚未产生任何终态 → 不给结论（text = null）。
 */
export function summarizeWorkspace(
  states: ItemState[],
  total: number,
  running: boolean,
): WorkspaceSummary {
  const done = states.filter((s) => s.phase === "done");
  const ok = done.filter((s) => s.phase === "done" && s.success).length;
  const failed = done.length - ok;
  const skipped = states.filter((s) => s.phase === "skipped").length;
  const settled = done.length + skipped;
  const pending = Math.max(total - settled, 0);

  const base: WorkspaceSummary = {
    total,
    ok,
    failed,
    skipped,
    pending,
    text: null,
    tone: null,
  };

  if (running || total === 0 || settled === 0) return base;

  if (done.length === 0) {
    return { ...base, text: `已取消（${skipped} 个目标未执行）`, tone: "warn" };
  }
  if (failed === 0 && skipped === 0) {
    return { ...base, text: `全部成功（${ok}/${total}）`, tone: "ok" };
  }
  if (ok === 0) {
    return {
      ...base,
      text:
        skipped > 0
          ? `全部失败：${failed} 个失败 · ${skipped} 个已取消`
          : `全部失败（${failed} 个目标）`,
      tone: "bad",
    };
  }
  return {
    ...base,
    text: `部分成功：${ok} 成功 · ${failed} 失败${skipped > 0 ? ` · ${skipped} 已取消` : ""}`,
    tone: "warn",
  };
}
