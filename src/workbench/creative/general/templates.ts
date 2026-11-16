//! 通用项目模板常量（U1 D1）。
//!
//! 模板只描述「阶段 → 事项 → 里程碑」的初始结构；真正落库由后端
//! `general_apply_template` 经真实写入路径完成，前端不直接写事项/里程碑表。
//! 预览的事项/里程碑数量由本常量派生，不调用后端。

export interface GeneralTemplateMilestone {
  title: string;
  note?: string;
}

export interface GeneralTemplateStage {
  title: string;
  items: string[];
  milestone?: GeneralTemplateMilestone;
}

export interface GeneralTemplate {
  id: string;
  label: string;
  description: string;
  stages: GeneralTemplateStage[];
}

/** 计算模板将创建的事项与里程碑数量（纯前端预览）。 */
export function templateCounts(template: GeneralTemplate): {
  items: number;
  milestones: number;
} {
  return {
    items: template.stages.reduce((sum, stage) => sum + stage.items.length, 0),
    milestones: template.stages.filter((stage) => stage.milestone).length,
  };
}

export const GENERAL_TEMPLATES: GeneralTemplate[] = [
  {
    id: "blank",
    label: "空白项目",
    description: "不预置事项与阶段，从零开始搭建自己的项目结构。",
    stages: [],
  },
  {
    id: "study-plan",
    label: "学习计划",
    description: "按目标梳理、计划拆解、学习执行三个阶段推进的学习计划。",
    stages: [
      {
        title: "目标梳理",
        items: ["明确学习目标", "盘点已有基础"],
        milestone: { title: "目标确认", note: "目标与基础盘点完成" },
      },
      {
        title: "计划拆解",
        items: ["制定学习计划", "准备学习资料"],
        milestone: { title: "计划就绪" },
      },
      {
        title: "学习执行",
        items: ["按计划学习", "练习与复盘"],
        milestone: { title: "阶段验收" },
      },
    ],
  },
  {
    id: "personal-plan",
    label: "个人计划",
    description: "用于习惯养成、个人提升等长期个人目标的跟进计划。",
    stages: [
      {
        title: "现状盘点",
        items: ["梳理现状与期望"],
        milestone: { title: "现状清晰" },
      },
      {
        title: "计划制定",
        items: ["拆解行动步骤", "安排时间节奏"],
        milestone: { title: "计划落地" },
      },
      {
        title: "跟进调整",
        items: ["执行行动项", "定期回顾调整"],
        milestone: { title: "阶段回顾" },
      },
    ],
  },
  {
    id: "content-production",
    label: "内容制作",
    description: "选题、素材、制作发布三段式的内容生产项目。",
    stages: [
      {
        title: "选题策划",
        items: ["确定选题", "调研参考案例"],
        milestone: { title: "选题定稿" },
      },
      {
        title: "素材准备",
        items: ["收集素材", "整理素材清单"],
        milestone: { title: "素材就绪" },
      },
      {
        title: "制作发布",
        items: ["完成初稿", "审核修改", "发布成品"],
        milestone: { title: "成品交付" },
      },
    ],
  },
  {
    id: "event-planning",
    label: "活动筹备",
    description: "方案策划、筹备落实、执行复盘的活动筹备项目。",
    stages: [
      {
        title: "方案策划",
        items: ["确定目标与规模", "拟定活动方案"],
        milestone: { title: "方案确认" },
      },
      {
        title: "筹备落实",
        items: ["排期与预算", "落实场地与物料", "邀约参与人员"],
        milestone: { title: "筹备就绪" },
      },
      {
        title: "执行复盘",
        items: ["现场执行", "整理反馈复盘"],
        milestone: { title: "活动收官" },
      },
    ],
  },
  {
    id: "research",
    label: "研究项目",
    description: "问题界定、方案设计、分析总结的研究类项目。",
    stages: [
      {
        title: "问题界定",
        items: ["明确研究问题", "检索文献资料"],
        milestone: { title: "问题界定" },
      },
      {
        title: "方案设计",
        items: ["设计研究方法", "制定执行计划"],
        milestone: { title: "方案成型" },
      },
      {
        title: "分析总结",
        items: ["收集分析资料", "撰写结论报告"],
        milestone: { title: "成果交付" },
      },
    ],
  },
];
