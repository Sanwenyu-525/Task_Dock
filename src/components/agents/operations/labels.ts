//! Agent 操作状态标签（唯一文案来源，供 Indicator / Highlight / Timeline 复用）。

import type { AgentOperation, AgentOperationStatus } from "../../../lib/bridge";

export const AGENT_OPERATION_STATUS_LABELS: Record<AgentOperationStatus, string> = {
  running: "进行中",
  committed: "已完成",
  failed: "失败",
  conflict: "版本冲突",
  interrupted: "已中断",
};

/** 常用动作的短标签；未知动作原样展示（不猜测语义）。 */
const ACTION_LABELS: Record<string, string> = {
  "task.create": "新建任务",
  "task.update": "修改任务",
  "task.complete": "完成任务",
  "task.delete": "删除任务",
  "feature.create": "新建功能",
  "feature.update": "修改功能",
  "feature.delete": "删除功能",
  "milestone.create": "新建里程碑",
  "milestone.update": "修改里程碑",
  "note.create": "新建笔记",
  "note.update": "修改笔记",
  "knowledge.create": "写入知识",
  "knowledge.update": "修改知识",
  "decision.create": "记录决策",
  "handoff.create": "创建交接",
  "report.create": "提交报告",
  "import.approve": "批准导入",
  "import.reject": "拒绝导入",
  "import.create": "导入新资源",
  "import.apply": "应用文件修改",
  "sync.init": "初始化工作空间",
  "sync.export": "导出工作空间",
  "sync.scan": "扫描导入",
  "sync.resolve": "解决冲突",
  "taskdock_create_task": "新建任务",
  "taskdock_update_task": "修改任务",
  "taskdock_create_feature": "新建功能",
  "taskdock_update_feature": "修改功能",
  "taskdock_create_project": "新建项目",
  "taskdock_update_project": "修改项目",
  "taskdock_add_step": "新增步骤",
  "taskdock_update_step": "修改步骤",
  "taskdock_add_progress_note": "追加进度",
  "taskdock_submit_for_review": "提交评审",
  "taskdock_link_agent_session": "关联会话",
  "taskdock_unlink_agent_session": "解除关联",
  "taskdock_create_note": "新建笔记",
  "taskdock_update_note": "修改笔记",
  "taskdock_link_note_task": "关联笔记任务",
  "taskdock_add_task_progress": "追加任务进度",
};

export function actionLabel(op: Pick<AgentOperation, "action">): string {
  return ACTION_LABELS[op.action] ?? op.action;
}

/** 身份展示：本机用户 / 已认证 Agent / 未认证文件来源必须能区分。 */
export function agentLabel(op: Pick<AgentOperation, "agentId" | "actorKind">): string {
  const id = op.agentId.trim();
  if (!id) return "未知 Agent";
  if (id === "local") return "本机用户";
  if (id === "system") return "TaskDock";
  if (id.startsWith("file:")) {
    const claimed = id.slice("file:".length);
    return claimed && claimed !== "unverified" ? `文件 · ${claimed}` : "文件导入";
  }
  return id;
}

export function resourceLabel(op: Pick<AgentOperation, "resourceKind" | "resourceId">): string {
  if (!op.resourceKind) return "—";
  if (!op.resourceId) return `${op.resourceKind} · 新建中`;
  return `${op.resourceKind} · ${op.resourceId.slice(0, 8)}`;
}

/** 相对时间：只用于展示，不参与任何判定。 */
export function operationTimeLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const delta = Date.now() - ms;
  if (delta < 10_000) return "刚刚";
  if (delta < 60_000) return `${Math.floor(delta / 1000)} 秒前`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Date(ms).toLocaleDateString();
}
