//! 场景与工作流类教程（3 篇，均 verified 且自带 en-US）。
//! 2026-11-08 按当前源码复核：WorkflowEditorView/WorkflowsPanel（one-click）、
//! ScenarioWorkspaceView（scenes）、PlanningCenterPanel（planning-center）。
//! scenes：工作现场快照已含窗口几何（v40 迁移），恢复尽力原位/收敛——正文按当前树状态更新；
//! 专属「恢复选项/逐项几何结果」UI 尚未落地（见 tmp/acceptance/help-center/report-round2.md 增量清单）。

import type { HelpArticle } from "../types";

export const WORKFLOWS_ARTICLES: readonly HelpArticle[] = [
  {
    id: "help.workflows.one-click",
    categoryId: "workflows",
    status: "verified",
    contentVersion: 3,
    reviewedForVersion: "v0.11",
    reviewedOperationContractVersions: { "core.one-click-workflow": 2 },
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
              "添加步骤：打开应用 / 激活窗口、打开网页、打开文件或目录、创建任务、恢复工作现场或进入场景，均为白名单动作。",
              "用上移/下移调整顺序；每个步骤可单独启停，并可设置失败策略（失败后停止或失败后继续）。",
              "保存后点「运行」：流程顺序执行，逐步骤显示成功 / 失败与原因。",
            ],
          },
          { type: "heading", text: "运行控制" },
          {
            type: "paragraph",
            text: "运行中可暂停 / 继续 / 取消：暂停在当前步骤完成后生效（运行中的步骤不可中断）。同一时刻只有一个运行在执行，异常退出会标记为 interrupted 且不会自动重放副作用，需要你手动再跑。",
          },
          { type: "heading", text: "历史" },
          {
            type: "paragraph",
            text: "每个工作流保留最近 50 条运行历史，可查看每次运行的逐步骤结果。",
          },
          {
            type: "note",
            text: "工作流只执行白名单内的动作，不支持任意脚本。「进入场景」会等待场景恢复结果；失败会显示步骤结果，取消会传递到当前场景流程。已启动的应用与已创建的任务不会因取消或失败而自动撤销。",
          },
        ],
      },
      "en-US": {
        title: "One-click workflows: turn repeats into a single click",
        summary:
          "Chain allow-listed actions into a fixed order, with pause/cancel, per-step feedback and failure policies.",
        sections: [
          { type: "heading", text: "Create a workflow" },
          {
            type: "steps",
            items: [
              "Press Ctrl+7 to open the \"Workflows\" page, click \"New\" to start blank, or start from the dev / office sample templates (you pick the app targets in a template; Task Dock never assumes a particular app is installed).",
              "Add steps: open app / activate window, open URL, open file or folder, create task, restore workspace or enter scenario — all allow-listed actions.",
              "Reorder with Move up / Move down; each step can be enabled or disabled on its own, and has a failure policy (stop on failure or continue on failure).",
              "After saving, click \"Run\": the flow executes in order and shows success / failure with reasons per step.",
            ],
          },
          { type: "heading", text: "Run controls" },
          {
            type: "paragraph",
            text: "A running workflow can be paused / resumed / cancelled; pausing takes effect after the current step finishes (a running step cannot be interrupted). Only one run executes at a time; an abnormal exit is marked interrupted and its side effects are never replayed automatically — run it again yourself.",
          },
          { type: "heading", text: "History" },
          {
            type: "paragraph",
            text: "Each workflow keeps its last 50 runs, and every run's per-step results can be inspected.",
          },
          {
            type: "note",
            text: "Workflows only execute allow-listed actions — no arbitrary scripts. \"Enter scenario\" waits for the scenario's restore result; failures show the step results, and cancellation propagates into the running scenario flow. Apps already started and tasks already created are not rolled back on cancel or failure.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["工作流", "一键", "编排", "模板", "失败策略", "暂停", "运行历史"],
      "en-US": ["workflow", "one-click", "automation", "template", "failure policy", "pause", "run history"],
    },
    relatedFeatureIds: ["core.one-click-workflow"],
    relatedRouteIds: ["workflows"],
  },
  {
    id: "help.workflows.scenes",
    categoryId: "workflows",
    status: "verified",
    contentVersion: 6,
    reviewedForVersion: "v0.11",
    reviewedOperationContractVersions: { "core.scenario-workspace": 1 },
    translations: {
      "zh-CN": {
        title: "场景工作区：管理并进入可复用场景",
        summary: "场景可以独立创建、整理并进入，也能作为工作流步骤调用；进入场景会恢复导航、现场与窗口几何，进入过程可取消。",
        sections: [
          {
            type: "heading",
            text: "管理与进入场景",
          },
          {
            type: "steps",
            items: [
              "按 Ctrl+7 打开「工作流」页，再选择「场景工作区」。",
              "在场景工作区中创建、编辑、复制或删除场景；进入场景后可以查看逐项结果与恢复摘要。",
              "编辑场景时，文件夹通过「浏览添加」从系统文件选择器选择（可多选），也可以在下方手动输入路径后回车补充；图标从预设图标面板点选。",
              "在工作流编辑器添加「进入场景」步骤，并从真实场景列表选择要进入的场景。",
            ],
          },
          { type: "heading", text: "进入中的取消与超时" },
          {
            type: "paragraph",
            text: "同一时刻只允许一个场景进入：再次进入会得到可重试的冲突提示。进入过程中该卡片会出现「取消」按钮；取消与整体超时（120 秒）都只阻止尚未执行的条目，已经启动的应用、网页、目录、工作流和现场恢复不会被关闭或回滚。结果摘要会显示「已处理 X/Y 项」；被取消的条目按「已取消」呈现，不算失败。删除正在进入的场景会先请求取消并短暂等待，未退出时删除会被拒绝，稍后重试即可。",
          },
          { type: "heading", text: "场景与工作现场" },
          {
            type: "paragraph",
            text: "场景是可重复进入的标准组合；工作现场是某个任务当前环境的快照。场景复用已有的导航与现场恢复：带几何数据的快照条目会尝试把窗口放回原位，显示器布局变化时窗口会收敛到可见区域；旧快照（无几何数据）只唤醒应用、不调整位置。几何还原是尽力而为，不保证 100% 还原。",
          },
          {
            type: "note",
            text: "场景编辑器选择的暂存架文件会随场景保存到数据库（shelf_items.scene_id）；删除场景只解除关联，不删除用户原文件。",
          },
        ],
      },
      "en-US": {
        title: "Scenario workspace: manage and enter reusable scenarios",
        summary:
          "Scenarios can be created, organized and entered on their own, or invoked as workflow steps; entering restores navigation, workspace and window geometry, and an in-flight entry can be cancelled.",
        sections: [
          {
            type: "heading",
            text: "Manage and enter scenarios",
          },
          {
            type: "steps",
            items: [
              "Press Ctrl+7 to open the \"Workflows\" page, then choose \"Scenario workspace\".",
              "Create, edit, duplicate or delete scenarios in the workspace; after entering a scenario you can inspect per-item results and the restore summary.",
              "When editing a scenario, pick folders via \"Browse add\" from the system folder dialog (multi-select), or type a path manually and press Enter to append; choose the icon from the preset picker.",
              "Add an \"Enter scenario\" step in the workflow editor and pick a real scenario from the list.",
            ],
          },
          { type: "heading", text: "Cancel and timeout during entry" },
          {
            type: "paragraph",
            text: "Only one scenario entry runs at a time; a second entry returns a retryable conflict. While entering, the card shows a Cancel button; cancellation and the overall timeout (120 seconds) only stop entries that have not started yet — apps, URLs, folders, workflows and workspace restores that already launched are never closed or rolled back. The result summary shows how many items were processed out of the total; cancelled items are presented as cancelled, not failed. Deleting a scenario that is currently entering first requests a cancel and waits briefly; if it has not exited the delete is rejected — retry later.",
          },
          { type: "heading", text: "Scenarios and workspaces" },
          {
            type: "paragraph",
            text: "A scenario is a reusable standard combination; a workspace is a snapshot of the current environment around one task. Scenario entry reuses the existing navigation and workspace restore: snapshot items carrying geometry try to put windows back where they were, windows converge into a visible area when the monitor layout changed, and old snapshots without geometry only wake the apps without repositioning. Geometry restore is best-effort, not a guaranteed 100% reproduction.",
          },
          {
            type: "note",
            text: "Shelf files selected in the scenario editor are saved with the scenario (shelf_items.scene_id); deleting a scenario only unlinks the IDs and never deletes your original files.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["场景", "工作区", "现场", "恢复", "进入场景", "工作流", "文件关联", "窗口几何", "取消进入", "超时"],
      "en-US": ["scenario", "workspace", "restore", "enter scenario", "workflow", "file link", "window geometry", "cancel entry", "timeout"],
    },
    relatedFeatureIds: ["core.scenario-workspace", "core.workspace-restore"],
    relatedRouteIds: ["workflows", "tasks"],
  },
  {
    id: "help.workflows.planning-center",
    categoryId: "workflows",
    status: "verified",
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
      "en-US": {
        title: "Planning center: your projects and the built-in roadmap",
        summary:
          "\"My projects\" stores your planning data; \"Built-in roadmap\" shows Task Dock's feature status read-only.",
        sections: [
          { type: "heading", text: "Switching data sources" },
          {
            type: "steps",
            items: [
              "Open the \"Planning center\" with Ctrl+7; the top switches between \"My projects\" and \"Built-in roadmap\".",
              "In \"My projects\" you create and manage your own projects, features, steps, progress and milestones.",
              "\"Built-in roadmap\" comes from Task Dock's feature catalog and shows feature statuses read-only; your project data is never touched.",
            ],
          },
          {
            type: "note",
            text: "External agents over MCP use the authorized \"My projects\" data service only; they never get implicit access to the built-in roadmap or any other page's data.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["规划中心", "我的项目", "内置路线图", "项目", "里程碑", "功能状态"],
      "en-US": ["planning center", "my projects", "built-in roadmap", "project", "milestone", "feature status"],
    },
    relatedFeatureIds: [],
    relatedRouteIds: ["roadmap"],
  },
];
