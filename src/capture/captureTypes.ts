//! 快速捕获的纯类型与文案常量（与 React 无关）。
//! 捕获窗口与收集箱共用同一份类型标签，避免两处文案漂移。

import type { CaptureKind } from "../lib/bridge";

export interface CaptureKindMeta {
  /** 类型标签：类型药丸、收集箱条目标签共用 */
  label: string;
  /** 输入框占位文案：随类型切换，但绝不清空已输入内容 */
  placeholder: string;
  /** 单选组内的完整可访问名称（aria-label） */
  ariaLabel: string;
}

export const CAPTURE_KIND_META: Record<CaptureKind, CaptureKindMeta> = {
  task: {
    label: "任务",
    placeholder: "记下要做的事，可带时间，例如「明天 10 点 交周报」",
    ariaLabel: "任务：解析时间并创建任务",
  },
  idea: {
    label: "想法",
    placeholder: "记下一个想法，稍后在收集箱整理…",
    ariaLabel: "想法：存入收集箱",
  },
  text: {
    label: "文字",
    placeholder: "粘贴或输入一段文字…",
    ariaLabel: "文字：存入收集箱",
  },
  todo: {
    label: "待办",
    placeholder: "记一条简单待办，不解析提醒时间…",
    ariaLabel: "待办：创建无提醒任务",
  },
  link: {
    label: "链接",
    placeholder: "粘贴链接，可在链接后追加备注…",
    ariaLabel: "链接：保存链接与备注",
  },
};

/** 类型按钮在单选组内的固定顺序（与 PLAN §6 一致）。 */
export const CAPTURE_KIND_ORDER: readonly CaptureKind[] = [
  "task",
  "idea",
  "text",
  "todo",
  "link",
];

export type FeedbackTone = "info" | "success" | "error";

export interface CaptureFeedback {
  tone: FeedbackTone;
  message: string;
}
