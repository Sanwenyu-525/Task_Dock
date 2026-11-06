//! 场景与工作流类教程。
//! 场景和工作流调用均已接入；C4 文件关联及现场几何仍有缺口，且界面/原生行为未完整复核，教程保持 needs_review。

import type { HelpArticle } from "../types";

export const WORKFLOWS_ARTICLES: readonly HelpArticle[] = [
  {
    id: "help.workflows.one-click",
    categoryId: "workflows",
    status: "needs_review",
    contentVersion: 2,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "一键工作流：把重复操作变成一次点击",
        summary: "用白名单动作编排固定顺序流程，支持暂停/取消、逐步骤反馈与失败策略。",
        sections: [
          { type: "heading", text: "创建工作流" },
          {
            type: "steps",
            items: [
              "Ctrl+7 进入「工作流」页，点「新建」从空白开始，或套用「开发 / 办公」示例模板（模板中的应用目标由你自己选择，不会假设安装了特定软件）。",
              "添加步骤：打开应用 / 网页 / 文件目录、创建任务、恢复工作现场或进入场景，均为白名单动作。",
              "拖动或用上移/下移调整顺序；每个步骤可单独启停，并可设置失败策略（停止或继续）。",
              "保存后点「运行」：流程顺序执行，逐步骤显示成功 / 失败与原因。",
            ],
          },
          { type: "heading", text: "运行控制" },
          {
            type: "paragraph",
            text: "运行中可暂停 / 继续 / 取消；同一时刻只有一个运行在执行，异常退出会标记为 interrupted 且不会自动重放副作用，需要你手动再跑。",
          },
          { type: "heading", text: "历史" },
          {
            type: "paragraph",
            text: "每个工作流保留最近 50 条运行历史，可查看每次运行的逐步骤结果。",
          },
          {
            type: "note",
            text: "工作流只执行白名单内的动作，不支持任意脚本。「进入场景」会等待场景恢复结果；失败会显示步骤结果，取消会传递到当前场景流程。",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["工作流", "一键", "编排", "模板", "失败策略", "暂停", "运行历史"],
    },
    relatedFeatureIds: ["core.one-click-workflow"],
    relatedRouteIds: ["workflows"],
  },
  {
    id: "help.workflows.scenes",
    categoryId: "workflows",
    status: "needs_review",
    contentVersion: 2,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "场景工作区：管理并进入可复用场景",
        summary: "场景可以独立创建、整理并进入，也能作为工作流步骤调用；当前仍有文件关联和窗口几何缺口。",
        sections: [
          {
            type: "heading",
            text: "管理与进入场景",
          },
          {
            type: "steps",
            items: [
              "按 Ctrl+7 打开「工作流」页，再选择「场景工作区」。",
              "在场景工作区中创建、编辑、复制或删除场景；进入场景后可以查看逐项结果。",
              "在工作流编辑器添加「进入场景」步骤，并从真实场景列表选择要进入的场景。",
            ],
          },
          { type: "heading", text: "场景与工作现场" },
          {
            type: "paragraph",
            text: "场景是可重复进入的标准组合；工作现场是某个任务当前环境的快照。场景复用已有导航与现场恢复，不代表窗口几何能完整还原。",
          },
          {
            type: "note",
            text: "当前场景编辑器可选择暂存架条目，但后端尚未持久化场景关联；不要把文件选择视为已保存。窗口矩形、尺寸、显示器和 DPI 也未纳入快照。删除场景不会删除用户原文件。",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["场景", "工作区", "现场", "恢复", "进入场景", "工作流", "文件关联"],
    },
    relatedFeatureIds: ["core.scenario-workspace", "core.workspace-restore"],
    relatedRouteIds: ["workflows", "tasks"],
  },
  {
    id: "help.workflows.planning-center",
    categoryId: "workflows",
    status: "needs_review",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "规划中心：管理项目与内置路线图",
        summary: "「我的项目」保存你的规划数据；「内置路线图」只读展示 task_dock 的功能状态。",
        sections: [
          { type: "heading", text: "切换数据来源" },
          {
            type: "steps",
            items: [
              "进入 Ctrl+7「规划中心」，顶部可以切换「我的项目」与「内置路线图」。",
              "在「我的项目」中创建并管理自己的项目、功能、步骤、进度和里程碑。",
              "「内置路线图」来自 task_dock 的功能目录，只读展示功能状态，不会改动你的项目数据。",
            ],
          },
          {
            type: "note",
            text: "MCP 外部 Agent 使用的是经授权的「我的项目」数据服务；它不会获得内置路线图或其他页面数据的隐式访问权限。",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["规划中心", "我的项目", "内置路线图", "项目", "里程碑", "功能状态"],
    },
    relatedFeatureIds: [],
    relatedRouteIds: ["roadmap"],
  },
];
