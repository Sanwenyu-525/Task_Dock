//! 验收工作台的派生状态（纯函数，无副作用、不触达 IPC）。
//!
//! 输入三类事实源：最新验收判定（latestVerdict）、规划功能状态（featureStatus）、
//! 任务状态（taskStatus）。判定优先级（上层命中即返回，不再看下层）：
//! ① latestVerdict —— 验收记录是最强的直接证据；
//! ② featureStatus —— 规划功能状态是开发进度的次级信号；
//! ③ taskStatus     —— 只有任务时按任务状态保守推导；
//! ④ 全部为空       —— unlinked（无可派生依据）。
//!
//! 边界：`hasSubject = false` 表示当前没有任何可验收对象（无任务且无关联功能），
//! 直接返回 unlinked，不看其余字段。`in_review` 是契约保留值：当前规则把
//! review 映射为 awaiting（等待验收动作），不单独产出 in_review。

export type DevFeatureStatus =
  | "planned"
  | "in_progress"
  | "review"
  | "completed"
  | "blocked"
  | "paused";

export type DevTaskStatus = "pending" | "completed";

export type DevVerdict = "pass" | "fail" | "blocked" | "not_verified";

export type DerivedAcceptanceState =
  | "pending_dev"
  | "in_dev"
  | "awaiting"
  | "in_review"
  | "rejected"
  | "accepted"
  | "blocked"
  | "unlinked";

export interface DeriveAcceptanceInput {
  featureStatus?: DevFeatureStatus | null;
  taskStatus?: DevTaskStatus | null;
  latestVerdict?: DevVerdict | null;
  /** 是否存在可验收对象（当前任务或关联规划功能）。 */
  hasSubject: boolean;
}

export interface DerivedAcceptance {
  state: DerivedAcceptanceState;
  /**
   * 最新判定为 not_verified 时为 true：记录存在但未提供有效证据，
   * 只能视为「等待验收」并提示证据不足，不得当作通过或失败。
   */
  evidenceInsufficient?: boolean;
}

export function deriveAcceptanceState(input: DeriveAcceptanceInput): DerivedAcceptance {
  const featureStatus = input.featureStatus ?? null;
  const taskStatus = input.taskStatus ?? null;
  const latestVerdict = input.latestVerdict ?? null;

  if (!input.hasSubject) return { state: "unlinked" };

  // ① 最新验收判定优先：一条明确的判定覆盖开发状态推导。
  if (latestVerdict) {
    switch (latestVerdict) {
      case "pass":
        return { state: "accepted" };
      case "fail":
        return { state: "rejected" };
      case "blocked":
        return { state: "blocked" };
      case "not_verified":
        return { state: "awaiting", evidenceInsufficient: true };
    }
  }

  // ② 规划功能状态：开发进度信号。
  if (featureStatus) {
    switch (featureStatus) {
      case "planned":
        return { state: "pending_dev" };
      case "in_progress":
        return { state: "in_dev" };
      case "blocked":
      case "paused":
        return { state: "blocked" };
      case "review":
        return { state: "awaiting" };
      case "completed":
        return { state: "accepted" };
    }
  }

  // ③ 只有任务状态时保守推导：待办 = 待开发；已完成 = 等待验收（不等于通过）。
  if (taskStatus) {
    return taskStatus === "pending" ? { state: "pending_dev" } : { state: "awaiting" };
  }

  // ④ 无任何依据。
  return { state: "unlinked" };
}
