//! 场景与工作流类教程（2 篇）。
//! help.workflows.scenes 对应「场景工作区」（partial 状态），文章定位是说明
//! 现有能力与缺口，status=draft（等场景功能落地后补全操作步骤）。

import type { HelpArticle } from "../types";

export const WORKFLOWS_ARTICLES: readonly HelpArticle[] = [
  {
    id: "help.workflows.one-click",
    categoryId: "workflows",
    status: "verified",
    contentVersion: 1,
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
              "添加步骤：打开应用 / 网页 / 文件目录、创建任务、恢复工作现场，均为白名单动作。",
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
            text: "工作流只执行白名单内的动作，不支持任意脚本；「进入场景」步骤待场景工作区落地后开放，当前版本会拒绝执行该类步骤。",
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
    status: "draft",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "场景工作区：一键进入标准工作组合（规划中）",
        summary:
          "场景是预先定义的应用 / 网页 / 目录 / 任务组合；当前版本已具备任务级现场恢复，独立场景管理仍在开发。",
        sections: [
          {
            type: "callout",
            text: "当前状态：独立于任务的「场景」实体与一键进入场景尚未发布。本文为草案，功能落地后会补全操作步骤并转为「已核对」。",
          },
          { type: "heading", text: "现在就能用的能力" },
          {
            type: "steps",
            items: [
              "任务关联目标 + 窗口身份记忆：在任务上下文抽屉「现场」分区保存窗口组合。",
              "任务卡「打开工作区」批量启动：应用复用已有窗口（绝不重复启动），网页 / 目录 / Agent 会话逐项打开并逐项反馈成败。",
              "恢复可取消：取消后剩余项如实记为 cancelled，不中断已完成项。",
            ],
          },
          { type: "heading", text: "与「场景」的区别" },
          {
            type: "paragraph",
            text: "「现场」是某个任务此刻环境的快照；「场景」是预先定义、可反复进入的标准工作组合（不依赖某个具体任务）。场景将复用现有现场快照与导航启动链路，不会另起第二套系统。",
          },
          {
            type: "note",
            text: "当前缺口：窗口位置与大小恢复、浏览器多标签页恢复暂不支持；恢复的是「哪些窗口」而不是几何布局。",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["场景", "工作区", "现场", "恢复", "批量启动", "开发中"],
    },
    relatedFeatureIds: ["core.scenario-workspace", "core.workspace-restore"],
    relatedRouteIds: ["workflows", "tasks"],
  },
];
