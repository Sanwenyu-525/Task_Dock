// Toast 动画/计时状态迁移：把 Host 里「新消息入场 / 重复消息只重置计时」的判断抽成纯函数，
// 保证旧动画不会控制新消息，也便于在没有原生动画环境时做回归测试。
export type ToastTransition = "enter" | "refresh" | "idle";

export function toastTransition(
  previous: { id: number; rev: number } | null,
  next: { id: number; rev: number },
): ToastTransition {
  if (!previous || previous.id !== next.id) return "enter";
  if (previous.rev !== next.rev) return "refresh";
  return "idle";
}
