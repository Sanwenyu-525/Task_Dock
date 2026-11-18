/**
 * 五种工作模式的阶段模板（代码常量，不入库）。
 *
 * 规则：
 * - 模板只提供**默认值**，用户可改名/删除/排序/跳过；
 * - 模板不得生成具体截止日期或预算；
 * - `initialTasks` 只用于首阶段的最小启动集，不铺满整个项目；
 * - 能力 key 与项目能力需求草案一一对应，阶段通过 `phaseKeys` 引用。
 */

import type { CapabilityCategory, Necessity, Priority, ProjectKind } from "./types";

export interface TemplateFeature {
  title: string;
  acceptance: string;
}

export interface TemplatePhase {
  title: string;
  purpose: string;
  key: string;
  features: TemplateFeature[];
  milestone: string;
  capabilityKeys: string[];
}

export interface TemplateCapability {
  key: string;
  name: string;
  category: CapabilityCategory;
  necessity: Necessity;
  targetLevel: "basic" | "proficient";
  impact: string;
  alternative: string;
}

export interface TemplateTask {
  title: string;
  phaseKey: string;
  priority: Priority;
  capabilityKeys: string[];
}

export interface ProjectTemplate {
  id: ProjectKind;
  label: string;
  /** 新建时的一句话提示，不代替用户目标。 */
  goalHint: string;
  workspaceModules: string[];
  phases: TemplatePhase[];
  capabilities: TemplateCapability[];
  initialTasks: TemplateTask[];
}

export const KIND_LABELS: Record<ProjectKind, string> = {
  novel: "小说",
  game: "游戏",
  ai_comic: "漫剧",
  general: "通用",
  development: "开发",
};

const NOVEL_TEMPLATE: ProjectTemplate = {
  id: "novel",
  label: "小说",
  goalHint: "例如：写一本 30 万字的科幻小说，三个月内完成",
  workspaceModules: ["overview", "manuscript", "characters", "worldview", "items", "links", "settings"],
  phases: [
    {
      key: "world",
      title: "世界观",
      purpose: "确定世界规则、时代背景与核心设定",
      features: [
        { title: "核心设定文档", acceptance: "能用 500 字说明世界规则与独特卖点" },
        { title: "势力与地理", acceptance: "主要势力、地点与关系可查" },
      ],
      milestone: "世界观定稿",
      capabilityKeys: ["novel.worldbuilding", "novel.writing"],
    },
    {
      key: "characters",
      title: "人物",
      purpose: "建立主角、对手与关键配角档案",
      features: [
        { title: "主角档案", acceptance: "动机、缺陷、成长弧线齐全" },
        { title: "人物关系网", acceptance: "关键关系与冲突可查" },
      ],
      milestone: "人物设定完成",
      capabilityKeys: ["novel.character", "novel.writing"],
    },
    {
      key: "storyline",
      title: "故事主线",
      purpose: "确定幕结构、主线冲突与结局方向",
      features: [
        { title: "故事大纲", acceptance: "三幕结构与关键转折可读" },
        { title: "结局与主题", acceptance: "主题一句话可说明" },
      ],
      milestone: "大纲通过",
      capabilityKeys: ["novel.structure"],
    },
    {
      key: "volumes",
      title: "分卷",
      purpose: "按篇幅拆分卷与章节节奏",
      features: [{ title: "分卷规划", acceptance: "每卷目标、字数与结尾钩子明确" }],
      milestone: "分卷规划完成",
      capabilityKeys: ["novel.structure"],
    },
    {
      key: "chapters",
      title: "章节",
      purpose: "按卷写作并保持节奏",
      features: [{ title: "章节正文", acceptance: "完成计划章节并记录字数" }],
      milestone: "初稿完成",
      capabilityKeys: ["novel.writing", "tool.editor"],
    },
    {
      key: "proofread",
      title: "校对",
      purpose: "通读、修订与一致性检查",
      features: [
        { title: "通读修订", acceptance: "完成至少一轮全文修订" },
        { title: "一致性检查", acceptance: "设定、人名、时间线无冲突" },
      ],
      milestone: "修订稿完成",
      capabilityKeys: ["novel.proofread"],
    },
    {
      key: "final",
      title: "完稿",
      purpose: "终稿整理与交付",
      features: [{ title: "终稿导出", acceptance: "导出文件可读、目录完整" }],
      milestone: "完稿",
      capabilityKeys: ["tool.editor"],
    },
  ],
  capabilities: [
    { key: "novel.writing", name: "长篇写作", category: "human", necessity: "required", targetLevel: "proficient", impact: "决定正文产出速度与质量", alternative: "拆分为短篇练习或口述转写" },
    { key: "novel.structure", name: "叙事结构设计", category: "human", necessity: "required", targetLevel: "basic", impact: "影响主线清晰度与可读性", alternative: "参考结构模板并做大纲评审" },
    { key: "novel.worldbuilding", name: "世界观构建", category: "human", necessity: "recommended", targetLevel: "basic", impact: "影响设定一致性", alternative: "使用既有设定库或简化背景" },
    { key: "novel.character", name: "人物塑造", category: "human", necessity: "recommended", targetLevel: "basic", impact: "影响角色可信度", alternative: "先写关系网再补动机" },
    { key: "novel.proofread", name: "校对与一致性检查", category: "human", necessity: "required", targetLevel: "basic", impact: "影响交付质量", alternative: "分轮专项校对或外部校对" },
    { key: "tool.editor", name: "长文编辑器", category: "tool", necessity: "required", targetLevel: "basic", impact: "影响写作与保存可靠性", alternative: "使用工作空间正文模块" },
  ],
  initialTasks: [
    { title: "写下世界观核心设定", phaseKey: "world", priority: "P1", capabilityKeys: ["novel.worldbuilding"] },
    { title: "列出主角与主要冲突", phaseKey: "characters", priority: "P1", capabilityKeys: ["novel.character"] },
  ],
};

const GAME_TEMPLATE: ProjectTemplate = {
  id: "game",
  label: "游戏",
  goalHint: "例如：开发一款 2D Roguelike 游戏，先做单机核心玩法",
  workspaceModules: ["overview", "items", "assets", "builds", "links", "settings"],
  phases: [
    {
      key: "idea",
      title: "创意设计",
      purpose: "确定核心体验、目标玩家与差异化",
      features: [{ title: "一页创意案", acceptance: "核心循环与卖点可用一段话说明" }],
      milestone: "创意通过",
      capabilityKeys: ["game.design"],
    },
    {
      key: "gdd",
      title: "游戏设计文档",
      purpose: "把玩法、系统、内容范围写成可执行文档",
      features: [
        { title: "核心循环与系统", acceptance: "循环、资源、失败条件明确" },
        { title: "内容范围清单", acceptance: "关卡/敌人/道具范围可估算" },
      ],
      milestone: "GDD 定稿",
      capabilityKeys: ["game.design"],
    },
    {
      key: "prototype",
      title: "原型",
      purpose: "验证核心玩法是否成立",
      features: [{ title: "可玩原型", acceptance: "能完成一次完整核心循环" }],
      milestone: "原型可玩",
      capabilityKeys: ["game.engine", "game.code"],
    },
    {
      key: "core",
      title: "核心玩法",
      purpose: "打磨操作、反馈与难度曲线",
      features: [{ title: "核心玩法实现", acceptance: "关键操作手感与反馈达标" }],
      milestone: "核心玩法锁定",
      capabilityKeys: ["game.engine", "game.code"],
    },
    {
      key: "art",
      title: "美术",
      purpose: "统一视觉风格并产出可用资源",
      features: [{ title: "美术风格与资源", acceptance: "主要角色/场景资源可用" }],
      milestone: "美术资源就绪",
      capabilityKeys: ["game.art2d", "game.ui"],
    },
    {
      key: "audio",
      title: "音频",
      purpose: "补齐音乐与音效反馈",
      features: [{ title: "音乐与音效", acceptance: "关键交互有声音反馈" }],
      milestone: "音频就绪",
      capabilityKeys: ["game.audio"],
    },
    {
      key: "test",
      title: "测试",
      purpose: "功能、性能与兼容性验证",
      features: [{ title: "测试与缺陷修复", acceptance: "阻断级缺陷清零" }],
      milestone: "测试通过",
      capabilityKeys: ["game.test"],
    },
    {
      key: "release",
      title: "发布",
      purpose: "打包、商店材料与发布检查",
      features: [{ title: "发布构建", acceptance: "安装包可运行并通过清单检查" }],
      milestone: "发布",
      capabilityKeys: ["game.release", "game.test"],
    },
  ],
  capabilities: [
    { key: "game.design", name: "游戏设计", category: "human", necessity: "required", targetLevel: "proficient", impact: "决定玩法是否成立", alternative: "先做玩法原型再补文档" },
    { key: "game.code", name: "编程语言（C#/C++）", category: "human", necessity: "required", targetLevel: "basic", impact: "影响功能实现速度", alternative: "使用低代码插件或缩小系统范围" },
    { key: "game.engine", name: "游戏引擎（Unity/Godot）", category: "tool", necessity: "required", targetLevel: "basic", impact: "影响原型与构建能力", alternative: "选用更轻量的引擎或模板工程" },
    { key: "game.art2d", name: "2D 美术", category: "human", necessity: "recommended", targetLevel: "basic", impact: "影响视觉完成度", alternative: "使用素材库或 AI 生成后再修" },
    { key: "game.ui", name: "UI 设计", category: "human", necessity: "recommended", targetLevel: "basic", impact: "影响可读性与操作", alternative: "复用成熟 UI 套件" },
    { key: "game.audio", name: "音频制作", category: "human", necessity: "optional", targetLevel: "basic", impact: "影响反馈质感", alternative: "使用免费音效包" },
    { key: "game.test", name: "测试与缺陷跟踪", category: "human", necessity: "required", targetLevel: "basic", impact: "影响发布质量", alternative: "建立最小验收清单" },
    { key: "game.release", name: "打包与发布", category: "tool", necessity: "required", targetLevel: "basic", impact: "影响交付", alternative: "先出内部测试包" },
  ],
  initialTasks: [
    { title: "写一页创意案并自评核心循环", phaseKey: "idea", priority: "P1", capabilityKeys: ["game.design"] },
    { title: "搭一个可运行的空工程", phaseKey: "prototype", priority: "P1", capabilityKeys: ["game.engine"] },
  ],
};

const COMIC_TEMPLATE: ProjectTemplate = {
  id: "ai_comic",
  label: "漫剧",
  goalHint: "例如：制作一部 12 集的科幻漫剧，先完成第 1 集",
  workspaceModules: ["overview", "episodes", "shots", "characters", "assets", "links", "settings"],
  phases: [
    { key: "plan", title: "故事策划", purpose: "确定题材、受众与集数结构", features: [{ title: "故事企划", acceptance: "一句话卖点与分集钩子可读" }], milestone: "企划通过", capabilityKeys: ["comic.story"] },
    { key: "script", title: "剧本", purpose: "写成分集剧本与对白", features: [{ title: "分集剧本", acceptance: "每集目标、冲突与结尾明确" }], milestone: "剧本定稿", capabilityKeys: ["comic.script"] },
    { key: "storyboard", title: "分镜", purpose: "把剧本转成镜头语言", features: [{ title: "分镜稿", acceptance: "镜头顺序、景别与节奏可执行" }], milestone: "分镜通过", capabilityKeys: ["comic.storyboard"] },
    { key: "characters", title: "角色设计", purpose: "确定角色外观与表情库", features: [{ title: "角色设定", acceptance: "主角三视图与表情可用" }], milestone: "角色定稿", capabilityKeys: ["comic.art"] },
    { key: "scenes", title: "场景设计", purpose: "确定主要场景与色调", features: [{ title: "场景设定", acceptance: "主要场景风格统一" }], milestone: "场景定稿", capabilityKeys: ["comic.art"] },
    { key: "frames", title: "画面制作", purpose: "完成镜头画面与后期", features: [{ title: "镜头画面", acceptance: "按分镜完成并检查一致性" }], milestone: "画面完成", capabilityKeys: ["comic.art", "comic.generate"] },
    { key: "voice", title: "配音", purpose: "角色配音与音效", features: [{ title: "配音与音效", acceptance: "对白与音效对齐画面" }], milestone: "配音完成", capabilityKeys: ["comic.voice"] },
    { key: "edit", title: "剪辑", purpose: "合成、节奏与字幕", features: [{ title: "成片剪辑", acceptance: "成片可完整播放" }], milestone: "剪辑完成", capabilityKeys: ["comic.edit"] },
    { key: "release", title: "发布", purpose: "封面、标题与发布检查", features: [{ title: "发布包", acceptance: "封面/标题/简介齐全" }], milestone: "发布", capabilityKeys: ["comic.release"] },
  ],
  capabilities: [
    { key: "comic.story", name: "故事策划", category: "human", necessity: "required", targetLevel: "basic", impact: "决定题材与受众匹配", alternative: "改编既有短篇" },
    { key: "comic.script", name: "编剧", category: "human", necessity: "required", targetLevel: "proficient", impact: "决定对白与节奏", alternative: "先写大纲再扩写" },
    { key: "comic.storyboard", name: "分镜", category: "human", necessity: "required", targetLevel: "basic", impact: "决定画面可执行性", alternative: "使用分镜模板" },
    { key: "comic.art", name: "绘画/角色设计", category: "human", necessity: "required", targetLevel: "proficient", impact: "决定视觉质量", alternative: "素材库 + 局部重绘" },
    { key: "comic.generate", name: "AI 图像生成", category: "ai", necessity: "recommended", targetLevel: "basic", impact: "影响产能", alternative: "手工绘制或外部约稿" },
    { key: "comic.voice", name: "配音", category: "human", necessity: "recommended", targetLevel: "basic", impact: "影响成片完成度", alternative: "先做字幕版" },
    { key: "comic.edit", name: "剪辑", category: "tool", necessity: "required", targetLevel: "basic", impact: "影响成片交付", alternative: "使用模板工程" },
    { key: "comic.release", name: "发布运营", category: "human", necessity: "optional", targetLevel: "basic", impact: "影响触达", alternative: "先内部试映" },
  ],
  initialTasks: [
    { title: "写一句话卖点与前三集钩子", phaseKey: "plan", priority: "P1", capabilityKeys: ["comic.story"] },
    { title: "确定主角外观与表情基线", phaseKey: "characters", priority: "P1", capabilityKeys: ["comic.art"] },
  ],
};

const GENERAL_TEMPLATE: ProjectTemplate = {
  id: "general",
  label: "通用",
  goalHint: "例如：整理个人知识库，三个月内完成分类与检索",
  workspaceModules: ["overview", "milestones", "materials", "items", "links", "settings"],
  phases: [
    { key: "prepare", title: "准备", purpose: "明确范围、资料与验收方式", features: [{ title: "范围与清单", acceptance: "范围与不做的事写清楚" }], milestone: "准备完成", capabilityKeys: [] },
    { key: "execute", title: "执行", purpose: "完成主体工作", features: [{ title: "主体产出", acceptance: "核心内容达到可用状态" }], milestone: "主体完成", capabilityKeys: [] },
    { key: "review", title: "复查", purpose: "检查质量与遗漏", features: [{ title: "复查记录", acceptance: "问题清单闭环" }], milestone: "复查完成", capabilityKeys: [] },
    { key: "finish", title: "完成", purpose: "整理交付并归档", features: [{ title: "交付与归档", acceptance: "交付物可查、位置明确" }], milestone: "完成", capabilityKeys: [] },
  ],
  capabilities: [],
  initialTasks: [{ title: "写下范围与完成标准", phaseKey: "prepare", priority: "P1", capabilityKeys: [] }],
};

const DEVELOPMENT_TEMPLATE: ProjectTemplate = {
  id: "development",
  label: "开发",
  goalHint: "例如：开发一个 Windows 桌面应用，六个月完成首个可用版本",
  workspaceModules: ["overview", "items", "git", "agents", "builds", "links", "settings"],
  phases: [
    { key: "requirements", title: "需求", purpose: "明确用户、场景与验收标准", features: [{ title: "需求清单", acceptance: "每条需求有验收标准" }], milestone: "需求基线", capabilityKeys: ["dev.requirements"] },
    { key: "architecture", title: "架构", purpose: "确定技术方案与边界", features: [{ title: "架构说明", acceptance: "模块边界与数据流清晰" }], milestone: "架构评审", capabilityKeys: ["dev.architecture"] },
    { key: "design", title: "设计", purpose: "接口、数据模型与交互设计", features: [{ title: "设计与接口", acceptance: "接口契约可评审" }], milestone: "设计定稿", capabilityKeys: ["dev.architecture", "dev.ui"] },
    { key: "build", title: "开发", purpose: "实现功能并保持可构建", features: [{ title: "功能实现", acceptance: "主流程可运行、构建通过" }], milestone: "功能完成", capabilityKeys: ["dev.code", "dev.git"] },
    { key: "test", title: "测试", purpose: "自动化与手工验证", features: [{ title: "测试与修复", acceptance: "关键路径用例通过" }], milestone: "测试通过", capabilityKeys: ["dev.test"] },
    { key: "deploy", title: "部署", purpose: "打包、发布与回滚方案", features: [{ title: "发布包", acceptance: "安装/升级/回滚可用" }], milestone: "发布", capabilityKeys: ["dev.deploy"] },
    { key: "maintain", title: "维护", purpose: "监控、问题响应与迭代", features: [{ title: "维护记录", acceptance: "问题有跟踪与结论" }], milestone: "维护就绪", capabilityKeys: ["dev.test"] },
  ],
  capabilities: [
    { key: "dev.requirements", name: "需求分析", category: "human", necessity: "required", targetLevel: "basic", impact: "影响范围与验收", alternative: "用用户故事模板收敛" },
    { key: "dev.architecture", name: "系统架构", category: "human", necessity: "required", targetLevel: "proficient", impact: "影响可维护性", alternative: "先做模块化单体" },
    { key: "dev.code", name: "编程语言/框架", category: "human", necessity: "required", targetLevel: "proficient", impact: "影响实现速度与质量", alternative: "缩小范围或引入成熟库" },
    { key: "dev.ui", name: "UI/交互设计", category: "human", necessity: "recommended", targetLevel: "basic", impact: "影响可用性", alternative: "复用设计系统" },
    { key: "dev.git", name: "版本管理", category: "tool", necessity: "required", targetLevel: "basic", impact: "影响协作与回滚", alternative: "单人分支 + 标签" },
    { key: "dev.test", name: "测试", category: "human", necessity: "required", targetLevel: "basic", impact: "影响交付质量", alternative: "关键路径冒烟 + 手工清单" },
    { key: "dev.deploy", name: "构建与部署", category: "tool", necessity: "required", targetLevel: "basic", impact: "影响交付", alternative: "先出内部测试包" },
  ],
  initialTasks: [
    { title: "列出首版需求与验收标准", phaseKey: "requirements", priority: "P1", capabilityKeys: ["dev.requirements"] },
    { title: "确认技术栈与模块边界", phaseKey: "architecture", priority: "P1", capabilityKeys: ["dev.architecture"] },
  ],
};

export const PROJECT_TEMPLATES: Record<ProjectKind, ProjectTemplate> = {
  novel: NOVEL_TEMPLATE,
  game: GAME_TEMPLATE,
  ai_comic: COMIC_TEMPLATE,
  general: GENERAL_TEMPLATE,
  development: DEVELOPMENT_TEMPLATE,
};

export function templateFor(kind: ProjectKind): ProjectTemplate {
  return PROJECT_TEMPLATES[kind];
}

export const PROJECT_KINDS: readonly ProjectKind[] = [
  "novel",
  "game",
  "ai_comic",
  "general",
  "development",
] as const;
