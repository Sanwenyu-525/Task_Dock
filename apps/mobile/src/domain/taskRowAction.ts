// 任务行交互路由：把「点哪里 + 什么手势」映射成唯一动作。
// 第三轮之前整行轻点 = 切换完成，用户在任务列表里想查看内容时会误打卡；
// 现在契约固定为：
//   勾选区轻点 → 完成/恢复
//   行主体轻点 → 打开编辑
//   任意区域长按 → 动作表（删除/编辑/完成）
//   （左滑删除由 SwipeRow 独立处理，不经过这里）
// 抽成纯函数是为了让「轻点行主体不得触发完成」这条回归有可执行断言。
export type TaskRowHit = "checkbox" | "body";
export type TaskRowGesture = "press" | "longPress";
export type TaskRowAction = "toggle" | "openEditor" | "openActions";

export function taskRowAction(hit: TaskRowHit, gesture: TaskRowGesture): TaskRowAction {
  if (gesture === "longPress") return "openActions";
  return hit === "checkbox" ? "toggle" : "openEditor";
}
