import type { HelpArticle } from "../types";

/**
 * 2026-11 路线图补登后的能力导览。
 *
 * 这篇不重复各模块的操作细节，只回答「路线图里的新能力在界面哪里、当前能用到什么程度」；
 * 具体操作仍由各模块教程与 docs/ 文档承载。状态如实按 featureCatalog：大型工作台/文件工作区
 * 已实现，项目空间与三类专业工作台仍是部分实现，游戏/漫剧的专用流水线尚未接入。
 */
export const CAPABILITIES_ARTICLES: readonly HelpArticle[] = [
  {
    id: "help.quickstart.capabilities-tour",
    categoryId: "quickstart",
    status: "draft",
    contentVersion: 1,
    reviewedForVersion: "v0.11",
    translations: {
      "zh-CN": {
        title: "工作台、专业创作与设备能力导览",
        summary:
          "路线图里的统一工作台、项目空间、文件工作区、专业创作、移动端、资源与诊断分别在哪里，当前完成到什么程度。",
        sections: [
          {
            type: "paragraph",
            text: "Task Dock 现在有三层入口：贴边胶囊负责随时唤起，快捷工具面板负责高频操作，独立的大型工作台（workspace.html）负责复杂工作。本页只做能力地图，不替代各模块的详细教程。",
          },
          { type: "heading", text: "进入统一大型工作台" },
          {
            type: "steps",
            items: [
              "从胶囊或快捷工具面板点击「工作台」，或在页面里选择「在完整工作台中打开」。",
              "大型工作台有 20 条路由：首页、开发工作台、项目空间、文件、任务、Agent、应用、微件、行动、剪贴板、移动端、收集箱、暂存架、工作流、历史、规划中心、设置、帮助、诊断、资源。",
              "当前路由、打开的项目、右栏状态与分栏宽度会写入 workbench_layout，下次进入按上次布局恢复。",
            ],
          },
          { type: "heading", text: "项目空间与专业创作" },
          {
            type: "paragraph",
            text: "「项目空间」是项目容器，不是某一个专业工作台。它支持开发、游戏、AI 漫剧、通用、小说五类项目，提供概览、事项/阶段树、任务与暂存素材关联，以及每项目独立的窗口状态。项目里的能力会标注 available / limited / planned / unavailable 四态；标 planned 或 unavailable 的入口不会伪装成可用。",
          },
          {
            type: "paragraph",
            text: "三类专业工作台目前都还是部分实现：小说已有卷→章树、纯文本正文、自动保存、字数与 8 MiB 单章上限；人物、世界观、大纲、版本记录与 AI 辅助仍在规划。游戏以事项阶段承载关卡/系统/美术工作，还没有设计文档、资源库与构建流水线。AI 漫剧已有剧集/镜头导航与事项阶段，但分镜元数据、素材库与生成管线尚未接入。",
          },
          { type: "heading", text: "文件工作区" },
          {
            type: "paragraph",
            text: "「文件」是独立的多目录工作区：可以打开任意目录、横向或纵向分栏、最多 12 个窗格与每窗格 12 个标签，跨窗格拖拽复制或移动文件，冲突会整批询问一次。布局会保存；删除走回收站或永久删除两条独立确认路径。它和「收集与暂存」里的文件暂存架不是同一功能：暂存架负责临时收纳与后续投递，文件工作区负责长期目录操作。",
          },
          { type: "heading", text: "应用、移动端与虚拟屏" },
          {
            type: "paragraph",
            text: "「应用」页扫描本机已安装应用并读取真实图标，按启动 → 唤醒窗口 → 打开工作区 → 恢复会话四级尝试；后两级依赖各 Agent 的公开接口，缺接口时会明确降级，不会把「已启动」当成「已连接」。",
          },
          {
            type: "paragraph",
            text: "「移动端」页用于设备配对、任务/收集箱/笔记同步与文件互传；Android 客户端也可主动把采集内容发回桌面。虚拟屏是运行期设备会话：镜像模式投射手机画面，虚拟屏模式在电脑上开独立工作界面；多屏实验默认关闭，最多两个会话，超时或关闭窗口会回收进程。",
          },
          { type: "heading", text: "资源、诊断与备份" },
          {
            type: "paragraph",
            text: "「资源」区分应用缓存（TTS、暂存架残留、无引用缩略图）与用户级垃圾（回收站、临时文件、崩溃转储）：先只读预览，确认后按一次性 previewId 执行，目录归属、文件身份、大小、时间与年龄都会复核，占用中的文件跳过。",
          },
          {
            type: "paragraph",
            text: "「诊断」把脱敏事件写入有界队列与轮转 JSONL，支持异常列表、operationId 操作链、摘要、导出与清理；页面不可见时不轮询。备份与恢复是数据安全能力而不是清理能力：完整/快速备份、流式 bundle、恢复可续跑与回滚，见「备份与恢复：数据在哪些环节受保护」。",
          },
          {
            type: "note",
            text: "路线图条目的状态与这里一致：partial 表示已有真实入口但仍有缺口，planned 表示还没有可点击的实现。遇到入口不可用，先看规划中心对应条目，不要把计划中的能力当成故障。",
          },
        ],
      },
      "en-US": {
        title: "Tour: workspace, creative projects and device capabilities",
        summary:
          "Where the unified workspace, project space, file workspace, creative workbenches, mobile companion, resources and diagnostics live, and how complete each one is.",
        sections: [
          {
            type: "paragraph",
            text: "Task Dock now has three layers: the docked capsule for quick access, the quick tool panel for frequent actions, and the standalone large workspace (workspace.html) for complex work. This page is a capability map, not a replacement for each module's detailed guide.",
          },
          { type: "heading", text: "Entering the unified workspace" },
          {
            type: "steps",
            items: [
              "Click “Workspace” from the capsule or quick panel, or choose “Open in the full workspace” from a page.",
              "The workspace has 20 routes: home, dev workbench, project space, files, tasks, agents, apps, widgets, actions, clipboard, mobile, inbox, shelf, workflows, history, planning center, settings, help, diagnostics and resources.",
              "The active route, open project, detail pane and split widths are stored in workbench_layout and restored next time.",
            ],
          },
          { type: "heading", text: "Project space and creative workbenches" },
          {
            type: "paragraph",
            text: "Project space is a container, not a single professional workbench. It supports development, game, AI comic, general and novel projects, with an overview, item/stage tree, task and shelf links, and per-project window state. Each capability is marked available, limited, planned or unavailable; planned and unavailable entries are never presented as usable.",
          },
          {
            type: "paragraph",
            text: "All three creative workbenches are partial. Novel already has a volume → chapter tree, plain-text body, autosave, word count and an 8 MiB chapter limit; characters, worldview, outline, version history and AI assistance are still planned. Game uses items and stages for levels/systems/art, without a design doc, asset library or build pipeline. AI comic has episode/shot navigation and items, but shot metadata, asset library and the generation pipeline are not connected.",
          },
          { type: "heading", text: "File workspace" },
          {
            type: "paragraph",
            text: "Files is a separate multi-directory workspace: open any directory, split horizontally or vertically, up to 12 panes with 12 tabs each, drag files across panes to copy or move, and resolve conflicts in one batch prompt. Layout is saved; delete has separate recycle-bin and permanent-delete confirmations. It is not the file shelf: the shelf is temporary intake, Files is long-term directory work.",
          },
          { type: "heading", text: "Apps, mobile and virtual display" },
          {
            type: "paragraph",
            text: "Apps scans installed applications with real icons and tries four levels: launch → wake window → open workspace → resume session. The last two depend on each agent's public API and degrade explicitly when unavailable; “launched” is never reported as “connected”.",
          },
          {
            type: "paragraph",
            text: "Mobile handles pairing, task/inbox/note sync and file transfer; the Android app can also push captures back to the desktop. Virtual display is a runtime device session: mirror projects the phone screen, virtual mode opens an independent work surface on the PC. Multi-display experiments are off by default, capped at two sessions, and processes are reclaimed on timeout or window close.",
          },
          { type: "heading", text: "Resources, diagnostics and backup" },
          {
            type: "paragraph",
            text: "Resources separates app cache (TTS, shelf leftovers, unreferenced thumbnails) from user-level junk (recycle bin, temp files, crash dumps): read-only preview first, then a one-time previewId, re-checking ownership, identity, size, time and age, skipping files in use.",
          },
          {
            type: "paragraph",
            text: "Diagnostics writes redacted events to a bounded queue and rotating JSONL, with an exception list, operationId chains, summary, export and cleanup; it does not poll while hidden. Backup is data safety rather than cleanup: full/quick bundles, resumable and rollback-capable restore. See the backup guide for details.",
          },
          {
            type: "note",
            text: "Roadmap states match this page: partial means a real entry exists with gaps, planned means nothing clickable yet. If an entry is unavailable, check its roadmap card first instead of treating a planned capability as a defect.",
          },
        ],
      },
    },
    keywords: {
      "zh-CN": ["工作台", "项目空间", "文件工作区", "小说", "游戏", "漫剧", "移动端", "虚拟屏", "资源", "诊断", "备份"],
      "en-US": ["workspace", "project space", "files", "novel", "game", "comic", "mobile", "virtual display", "resources", "diagnostics", "backup"],
    },
    relatedFeatureIds: [
      "workbench.unified",
      "workbench.projects",
      "workbench.files",
      "create.novel",
      "create.game",
      "create.ai-comic",
      "core.app-launcher",
      "mobile.companion",
      "mobile.virtual-display",
      "system.resources",
      "system.diagnostics",
    ],
    relatedRouteIds: ["workbench", "workspace", "files", "apps", "mobile", "resource", "diagnostics"],
  },
];
