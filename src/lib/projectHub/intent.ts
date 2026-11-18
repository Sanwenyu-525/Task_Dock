/**
 * 本地目标解析（无 AI 可用时的默认实现）。
 *
 * 原则：
 * 1. 只提取用户**明确说了**的信息；
 * 2. 相对期限只记录天数，不转换成具体日期；
 * 3. 未提及的预算、平台、题材一律保持 null，并进入「不确定信息」；
 * 4. 解析失败不抛出，返回可编辑的空意图 + 阻塞问题。
 */

import type {
  ConstraintKind,
  ProjectConstraint,
  ProjectGoal,
  ProjectIntent,
  ProjectKind,
  ProjectUncertainty,
} from "./types";

export interface ParseOptions {
  /** `agent` 为后续 AI 端口保留；本地实现始终返回 `local` 结构。 */
  provider?: "local" | "agent";
}

const CN_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 把「三 / 十二 / 二十 / 三十」这类常见中文数字转成整数；无法识别返回 null。 */
export function chineseToNumber(text: string): number | null {
  const value = text.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "十") return 10;
  if (value === "半") return 0.5;

  const tens = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(value);
  if (tens) {
    const high = tens[1] ? CN_DIGITS[tens[1]] : 1;
    const low = tens[2] ? CN_DIGITS[tens[2]] : 0;
    return high * 10 + low;
  }
  if (value.length === 1 && CN_DIGITS[value]) return CN_DIGITS[value];
  return null;
}

/** 中文/阿拉伯数字 + 时间单位 → 天数；只用于相对期限。 */
const DEADLINE_PATTERN = /(\d+|[一二两三四五六七八九十]+|半)\s*(个月|月|星期|周|天|日|年)/;

export function parseRelativeDays(text: string): number | null {
  const match = DEADLINE_PATTERN.exec(text);
  if (!match) return null;
  const amount = chineseToNumber(match[1]);
  if (amount === null) return null;
  const unit = match[2];
  const daysPerUnit =
    unit === "天" || unit === "日"
      ? 1
      : unit === "周" || unit === "星期"
        ? 7
        : unit === "个月" || unit === "月"
          ? 30
          : 365;
  return Math.round(amount * daysPerUnit);
}

const ABSOLUTE_DATE_PATTERN = /(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})[日号]?/;

export function parseAbsoluteDate(text: string): string | null {
  const match = ABSOLUTE_DATE_PATTERN.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) return null;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

const BUDGET_PATTERN = /(?:预算|花费|成本|经费)[^\d]{0,4}(\d+(?:\.\d+)?)\s*(万|千)?\s*元/;

function parseBudget(text: string): { amount: number; currency: string } | null {
  const match = BUDGET_PATTERN.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const scale = match[2] === "万" ? 10000 : match[2] === "千" ? 1000 : 1;
  return { amount: value * scale, currency: "CNY" };
}

const SCOPE_EXCLUSION_PATTERN =
  /(?:先|暂时)?(?:不要|不用|不做|不加|不含|不包括|不需要|去掉|砍掉|删掉)\s*(?:做|要|加|上)?\s*(.{1,20}?)(?:功能|模块|部分)?(?=[，。；;,\n]|$)/g;

function parseScopeNotes(text: string): string[] {
  const notes: string[] = [];
  for (const match of text.matchAll(SCOPE_EXCLUSION_PATTERN)) {
    const note = match[1].trim().replace(/^的/, "").replace(/[的\s]+$/, "");
    if (note && !notes.includes(note)) notes.push(note);
  }
  return notes;
}

const PLATFORM_WORDS = [
  "Windows",
  "macOS",
  "Linux",
  "Steam",
  "Android",
  "安卓",
  "iOS",
  "Switch",
  "主机",
  "网页",
  "Web",
  "小程序",
];

function parsePlatform(text: string): string | null {
  const lower = text.toLowerCase();
  return PLATFORM_WORDS.find((word) => lower.includes(word.toLowerCase())) ?? null;
}

const KIND_KEYWORDS: Record<ProjectKind, string[]> = {
  novel: ["小说", "网文", "长篇", "短篇", "故事集", "字数", "章节"],
  game: ["游戏", "Unity", "Godot", "Roguelike", "RPG", "关卡", "玩法", "Steam"],
  ai_comic: ["漫剧", "漫画", "条漫", "分镜", "动画短片", "动态漫"],
  development: ["桌面应用", "软件", "应用", "程序", "系统", "网站", "工具", "App", "CLI", "插件", "代码"],
  general: ["知识库", "整理", "计划", "方案", "手册", "课程", "资料", "毕业设计", "论文"],
};

/** 关键词长度越长权重越高，避免「游戏」被「开发」类泛词盖过。 */
function scoreKind(text: string, kind: ProjectKind): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const keyword of KIND_KEYWORDS[kind]) {
    if (lower.includes(keyword.toLowerCase())) {
      score += keyword.length >= 2 ? 2 : 1;
    }
  }
  return score;
}

export function classifyProjectType(intent: ProjectIntent): ProjectKind | null {
  if (intent.kind) return intent.kind;
  return detectKind(intent.raw);
}

function detectKind(text: string): ProjectKind | null {
  if (!text.trim()) return null;
  const scores = (Object.keys(KIND_KEYWORDS) as ProjectKind[]).map((kind) => ({
    kind,
    score: scoreKind(text, kind),
  }));
  const best = scores.reduce((left, right) => (right.score > left.score ? right : left));
  if (best.score === 0) return null;
  const ties = scores.filter((item) => item.score === best.score);
  return ties.length > 1 ? null : best.kind;
}

const GOAL_PREFIX = /^(?:我要|我想|我准备|我需要|帮我|请帮我|请|需要|打算|准备)\s*/;
const DEADLINE_CLAUSE =
  /(?:在|于|用时)?\s*(?:\d+|[一二两三四五六七八九十]+|半)\s*(?:个月|月|星期|周|天|日|年)(?:之?内|以内)?(?:完成|做完|交付)?/;

/** 从原话提取一个「目标标题」；只做去掉口头语与期限，不新增信息。 */
export function goalTitleFromText(raw: string): string {
  let text = raw.trim();
  text = text.replace(GOAL_PREFIX, "");
  text = text.replace(ABSOLUTE_DATE_PATTERN, " ");
  text = text.replace(DEADLINE_CLAUSE, " ");
  text = text.replace(/\s{2,}/g, " ").trim();
  text = text.replace(/^[，,、；;：:\s]+/, "").replace(/[。！？!?；;，,、\s]+$/, "").trim();
  if (!text) return raw.trim().slice(0, 60);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

const PROJECT_NAME_ACTION =
  /^(?:写|开发|制作|整理|完成|做|搭建|创建|设计|编写|绘制)\s*(?:(?:一|1)\s*(?:本|款|部|个|套|张)\s*)?/;

/**
 * 从目标原话推出一个可读的项目名。
 *
 * 只做「去掉期限、范围排除、口头语与动作词」的清洗，不拼造新事实；
 * 例如「我要写一本 20 万字的科幻小说，在三个月内完成初稿，先保证世界观…」
 * →「20 万字的科幻小说」。显式命名场景由调用方优先使用 intent.title。
 */
export function projectNameFromText(raw: string): string {
  let text = raw.trim();
  text = text.replace(ABSOLUTE_DATE_PATTERN, " ");
  text = text.replace(SCOPE_EXCLUSION_PATTERN, " ");
  text = text.replace(/在?\s*(?:\d+|[一二两三四五六七八九十]+|半)\s*(?:个月|月|星期|周|天|日|年)(?:之?内|以内)?\s*(?:完成|做完|交付)?/g, " ");
  text = text.replace(GOAL_PREFIX, " ");
  text = text.replace(/^[，,、；;：:\s]+/, "");
  // 项目名只取第一个语义分句，保留后续约束在草案的「仍不确定」和约束列表中。
  text = text.split(/[，,。；;！？!?\n]/)[0].trim();
  text = text.replace(PROJECT_NAME_ACTION, "");
  text = text.replace(/^(?:一款|一本|一部|一个|一套|一张)\s*/, "");
  text = text.replace(/\s{2,}/g, " ").replace(/[的\s]+$/, "").trim();
  if (!text) return goalTitleFromText(raw);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

interface QuantityGoal {
  metric: string;
  targetValue: number;
  unit: string;
}

function parseQuantity(text: string): QuantityGoal | null {
  const wan = /(\d+(?:\.\d+)?)\s*万字/.exec(text);
  if (wan) {
    return { metric: "字数", targetValue: Number(wan[1]) * 10000, unit: "字" };
  }
  const zi = /(\d+)\s*字/.exec(text);
  if (zi) return { metric: "字数", targetValue: Number(zi[1]), unit: "字" };

  const chapter = /(\d+)\s*章/.exec(text);
  if (chapter) return { metric: "章节", targetValue: Number(chapter[1]), unit: "章" };

  const episode = /(\d+|[一二两三四五六七八九十]+)\s*集/.exec(text);
  if (episode) {
    const value = chineseToNumber(episode[1]);
    if (value !== null) return { metric: "集数", targetValue: value, unit: "集" };
  }

  const level = /(\d+)\s*关/.exec(text);
  if (level) return { metric: "关卡", targetValue: Number(level[1]), unit: "关" };

  const hours = /(\d+(?:\.\d+)?)\s*小时/.exec(text);
  if (hours) return { metric: "时长", targetValue: Number(hours[1]), unit: "小时" };

  return null;
}

const EXPLICIT_NAME_PATTERN =
  /(?:项目名称|项目名|作品名|名字)\s*(?:叫|为|是|：|:)\s*[“"「']?([^”"」',，。；;\n]{1,40})/;

export function extractProjectGoals(intent: ProjectIntent): ProjectGoal[] {
  return intent.goals;
}

export function extractProjectConstraints(intent: ProjectIntent): ProjectConstraint[] {
  return intent.constraints;
}

export function identifyProjectUncertainties(intent: ProjectIntent): ProjectUncertainty[] {
  return intent.uncertainties;
}

function buildConstraints(raw: string): ProjectConstraint[] {
  const constraints: ProjectConstraint[] = [];

  const relativeDays = parseRelativeDays(raw);
  if (relativeDays !== null) {
    const match = DEADLINE_PATTERN.exec(raw);
    constraints.push({
      kind: "deadline",
      text: match ? match[0] : raw,
      relativeDays,
      absoluteDate: null,
      amount: null,
      currency: null,
      value: null,
      source: "user",
    });
  }

  const absoluteDate = parseAbsoluteDate(raw);
  if (absoluteDate) {
    const match = ABSOLUTE_DATE_PATTERN.exec(raw);
    constraints.push({
      kind: "deadline",
      text: match ? match[0] : absoluteDate,
      relativeDays: null,
      absoluteDate,
      amount: null,
      currency: null,
      value: null,
      source: "user",
    });
  }

  const budget = parseBudget(raw);
  if (budget) {
    const match = BUDGET_PATTERN.exec(raw);
    constraints.push({
      kind: "budget",
      text: match ? match[0] : `${budget.amount} 元`,
      relativeDays: null,
      absoluteDate: null,
      amount: budget.amount,
      currency: budget.currency,
      value: null,
      source: "user",
    });
  }

  for (const note of parseScopeNotes(raw)) {
    constraints.push({
      kind: "scope",
      text: note,
      relativeDays: null,
      absoluteDate: null,
      amount: null,
      currency: null,
      value: note,
      source: "user",
    });
  }

  const platform = parsePlatform(raw);
  if (platform) {
    constraints.push({
      kind: "platform",
      text: platform,
      relativeDays: null,
      absoluteDate: null,
      amount: null,
      currency: null,
      value: platform,
      source: "user",
    });
  }

  return constraints;
}

function hasDeadline(constraints: ProjectConstraint[]): boolean {
  return constraints.some((item) => item.kind === "deadline");
}

function buildUncertainties(
  kind: ProjectKind | null,
  raw: string,
  constraints: ProjectConstraint[],
): ProjectUncertainty[] {
  const uncertainties: ProjectUncertainty[] = [];

  if (!kind) {
    uncertainties.push({
      id: "kind",
      field: "kind",
      question: "这个项目更接近哪一类？",
      blocking: true,
      options: ["小说", "游戏", "漫剧", "通用", "开发"],
    });
  }

  if (!hasDeadline(constraints)) {
    uncertainties.push({
      id: "deadline",
      field: "targetDate",
      question: "还没有截止时间，可以稍后补充",
      blocking: false,
      options: [],
    });
  }

  if (kind === "novel") {
    const genres = ["科幻", "奇幻", "玄幻", "悬疑", "推理", "言情", "都市", "历史", "武侠", "恐怖", "青春"];
    if (!genres.some((genre) => raw.includes(genre))) {
      uncertainties.push({
        id: "genre",
        field: "genre",
        question: "题材/风格还没有说明",
        blocking: false,
        options: ["科幻", "奇幻", "悬疑", "言情", "其他"],
      });
    }
  }

  if (kind === "game" || kind === "development") {
    if (!parsePlatform(raw)) {
      uncertainties.push({
        id: "platform",
        field: "platform",
        question: "目标平台还没有说明",
        blocking: false,
        options: kind === "game" ? ["PC", "移动端", "主机", "网页"] : ["Windows", "macOS", "Web", "跨平台"],
      });
    }
  }

  if (kind === "ai_comic" && !/(\d+|[一二两三四五六七八九十]+)\s*集/.test(raw)) {
    uncertainties.push({
      id: "episodes",
      field: "episodes",
      question: "集数与单集时长还没有说明",
      blocking: false,
      options: ["6 集", "12 集", "24 集", "先做 1 集试片"],
    });
  }

  return uncertainties.slice(0, 3);
}

/** 主入口：解析自然语言目标。空输入返回阻塞问题，不抛异常。 */
export function parseProjectIntent(input: string, _options: ParseOptions = {}): ProjectIntent {
  const raw = input.trim();
  const explicitName = EXPLICIT_NAME_PATTERN.exec(raw);
  const cleanTitle = explicitName ? explicitName[1].trim() : raw ? goalTitleFromText(raw) : null;

  const kind = detectKind(raw);
  const constraints = buildConstraints(raw);
  const quantity = parseQuantity(raw);

  const goals: ProjectGoal[] = [];
  if (raw) {
    goals.push({
      id: "goal-1",
      title: cleanTitle ?? raw.slice(0, 60),
      kind: "goal",
      parentId: null,
      metric: quantity?.metric ?? "",
      targetValue: quantity?.targetValue ?? null,
      unit: quantity?.unit ?? "",
      status: "active",
      source: explicitName ? "user" : "inferred",
    });
  }

  const deliverables: string[] = [];
  const deliverableMatch =
    /我(?:要|想|准备|需要)(?:开发|写|制作|整理|完成|做)(?:一|1)?(?:款|本|部|个|套)?(.+?)(?=[，。；;,\n]|$)/.exec(raw);
  if (deliverableMatch) {
    const phrase = deliverableMatch[1].trim();
    if (phrase) deliverables.push(phrase);
  }

  const uncertainties = buildUncertainties(kind, raw, constraints);

  return {
    raw,
    title: cleanTitle,
    titleSource: explicitName ? "user" : "inferred",
    kind,
    goals,
    constraints,
    uncertainties,
    deliverables,
    scopeNotes: parseScopeNotes(raw),
    provider: "local",
  };
}

/** 供 UI 把用户手动选择的类型写回意图（不产生新的事实）。 */
export function withProjectKind(intent: ProjectIntent, kind: ProjectKind): ProjectIntent {
  const constraints = intent.constraints;
  return {
    ...intent,
    kind,
    uncertainties: buildUncertainties(kind, intent.raw, constraints),
  };
}

export function constraintText(constraint: ProjectConstraint): string {
  if (constraint.kind === "deadline") {
    if (constraint.absoluteDate) return `截止 ${constraint.absoluteDate}`;
    if (constraint.relativeDays) return `约 ${constraint.relativeDays} 天`;
  }
  return constraint.text;
}

export const CONSTRAINT_KIND_LABELS: Record<ConstraintKind, string> = {
  deadline: "时间",
  budget: "预算",
  scope: "范围",
  platform: "平台",
  quality: "质量",
  other: "其他",
};
