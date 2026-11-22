//! 工作流示例模板（仅前端预填结构，不自动创建、更不自动执行）。
//!
//! 模板里的应用 / 目录 / 网页目标必须由用户在编辑器中选择（target_id 留空），
//! 不假设用户安装了任何特定软件；create_task 的标题可编辑。
//! 「进入场景」依赖用户已创建的场景，模板不包含该步骤（可在编辑器中添加）。

import type { WorkflowStepInput, WorkflowStepType, WorkflowOnError } from "../../lib/bridge";

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  steps: WorkflowStepInput[];
}

function step(
  step_type: WorkflowStepType,
  params: WorkflowStepInput["params"],
  on_error: WorkflowOnError = "stop",
): WorkflowStepInput {
  return { id: crypto.randomUUID(), step_type, params, enabled: true, on_error };
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    key: "dev",
    name: "开发工作流",
    description: "打开 IDE → 打开项目目录 → 打开文档 → 创建当天开发任务。",
    steps: [
      step("open_app", { target_id: "" }, "continue"),
      step("open_path", { target_id: "" }, "continue"),
      step("open_url", { target_id: "" }, "continue"),
      step("create_task", {
        title: `开发任务 ${today()}`,
        description: "由「开发工作流」模板创建",
        priority: 2,
      }),
    ],
  },
  {
    key: "office",
    name: "办公工作流",
    description: "打开办公软件 → 打开待处理文件 → 打开指定网页 → 创建工作提醒。",
    steps: [
      step("open_app", { target_id: "" }, "continue"),
      step("open_path", { target_id: "" }, "continue"),
      step("open_url", { target_id: "" }, "continue"),
      step("create_task", {
        title: "工作提醒",
        description: "由「办公工作流」模板创建",
        priority: 2,
      }),
    ],
  },
];
