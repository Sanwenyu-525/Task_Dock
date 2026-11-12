//! 快速捕获的纯逻辑工具：类型归一、内容建议、链接提取、提交校验、草稿状态机。
//! 不接触 React / Tauri，便于纯单测覆盖边界；UI 只做编排。

import type { CaptureKind, SubmitCaptureInput } from "../lib/bridge";

/** 内容上限（前后端一致）。 */
export const CONTENT_MAX = 4000;
/** 只有接近上限才显示字数，避免常驻噪音。 */
export const COUNTER_THRESHOLD = 3600;
/** 草稿保存防抖窗口。 */
export const DRAFT_DEBOUNCE_MS = 600;
/** 成功反馈展示多久后隐藏窗口。 */
export const SUCCESS_HIDE_MS = 500;
export const URL_MAX = 2048;
export const NOTE_MAX = 2000;
export const TASK_TITLE_MAX = 200;

export const CAPTURE_KINDS: readonly CaptureKind[] = ["task", "idea", "text", "todo", "link"];

export function isCaptureKind(value: unknown): value is CaptureKind {
  return typeof value === "string" && (CAPTURE_KINDS as readonly string[]).includes(value);
}

/** 后端/旧库可能返回未知类型，统一归一（默认任务，首次使用也是任务）。 */
export function normalizeKind(value: unknown, fallback: CaptureKind = "task"): CaptureKind {
  return isCaptureKind(value) ? value : fallback;
}

export function wrapKindIndex(index: number): number {
  const len = CAPTURE_KINDS.length;
  return ((index % len) + len) % len;
}

export function kindAt(index: number): CaptureKind {
  return CAPTURE_KINDS[wrapKindIndex(index)];
}

/** 单选组方向键：沿线循环移动，供左右/上下方向键共用。 */
export function nextKind(kind: CaptureKind, delta: number): CaptureKind {
  return kindAt(CAPTURE_KINDS.indexOf(kind) + delta);
}

// ── 链接识别 ───────────────────────────────────────────────────
/** 带协议或 www. 前缀才算链接；避免把中文里的英文单词误判成网址。 */
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`，。；：！？、（）【】「」『』《》]+/i;
/** 句末标点不属于链接（中文/英文都剥掉）。 */
const URL_TRAILING_PUNCTUATION = /[.,;:!?)\]}>，。；：！？、）】」』》]+$/;

export function extractFirstUrl(content: string): string | null {
  const matched = content.match(URL_PATTERN);
  if (!matched) return null;
  const cleaned = matched[0].replace(URL_TRAILING_PUNCTUATION, "");
  return cleaned.length > 0 ? cleaned : null;
}

function ensureUrlScheme(url: string): string {
  return /^www\./i.test(url) ? `https://${url}` : url;
}

// ── 类型建议（只建议，不静默切换） ─────────────────────────────
/**
 * 时间词启发式：只用于「建议：任务」按钮，命中后仍需用户点击才切换类型。
 * 宁少勿多——误报只多一个按钮，漏报不影响手动切换。
 */
const TIME_HINT_PATTERN =
  /(今天|明天|后天|大后天|今晚|明早|明晚|本周|这周|下周|周末|月底|下个月|上旬|中旬|下旬|上午|中午|下午|晚上|傍晚|凌晨|早上|周一|周二|周三|周四|周五|周六|周日|周天|星期[一二三四五六日天]|(?:工作日|每天|每周|每月|每年)|(?:[0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*[点时](?:半|一刻|三刻)?|(?:[0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*(?:分钟|小时|天|周|月)\s*(?:后|以后|之后)|[0-9]{1,2}[:：][0-9]{2}|[0-9]{1,2}\s*月\s*[0-9]{1,2}\s*[日号])/;

export function looksLikeTask(content: string): boolean {
  return TIME_HINT_PATTERN.test(content);
}

/** 返回建议类型；null 表示不建议切换。内容为空时不建议。 */
export function suggestKind(content: string): CaptureKind | null {
  const text = content.trim();
  if (!text) return null;
  if (extractFirstUrl(text)) return "link";
  if (looksLikeTask(text)) return "task";
  return null;
}

// ── 提交校验 ───────────────────────────────────────────────────
/** 返回错误文案；null 表示通过。规则与后端一致（内容 1..4000、链接 ≤2048）。 */
export function validateCapture(kind: CaptureKind, rawContent: string): string | null {
  const content = rawContent.trim();
  if (!content) return "内容不能为空";
  if (rawContent.length > CONTENT_MAX) return `内容最多 ${CONTENT_MAX} 字`;
  if (kind === "link") {
    const url = extractFirstUrl(content);
    if (url && url.length > URL_MAX) return `链接过长（最多 ${URL_MAX} 字符）`;
    return null;
  }
  if (kind === "task" || kind === "todo") {
    const title = (content.split("\n")[0] ?? "").trim();
    if (title.length > TASK_TITLE_MAX) {
      return `任务标题过长（最多 ${TASK_TITLE_MAX} 字，当前 ${title.length}）`;
    }
  }
  return null;
}

/** 提交载荷：link 类型把首个链接拆到 url，剩余文本作为 note（内容仍全量提交）。 */
export function composeSubmitInput(
  kind: CaptureKind,
  rawContent: string,
  clientId: string,
): SubmitCaptureInput {
  const content = rawContent.trim();
  if (kind !== "link") {
    return { client_id: clientId, kind, content };
  }
  const found = extractFirstUrl(content);
  const input: SubmitCaptureInput = { client_id: clientId, kind, content };
  if (found) {
    input.url = ensureUrlScheme(found);
    const note = content.replace(found, " ").replace(/\s+/g, " ").trim();
    if (note) input.note = note.slice(0, NOTE_MAX);
  } else if (content) {
    input.note = content.slice(0, NOTE_MAX);
  }
  return input;
}

// ── 草稿状态机 ─────────────────────────────────────────────────
export type DraftStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export interface DraftUiState {
  status: DraftStatus;
  /** 后端确认的 saved_at；只有 saved 状态才展示 */
  savedAt: string | null;
}

export const initialDraftState: DraftUiState = { status: "idle", savedAt: null };

export type DraftAction =
  | { type: "change" }
  | { type: "saving" }
  | { type: "saved"; savedAt: string }
  | { type: "failed" }
  | { type: "reset" };

export function draftReducer(state: DraftUiState, action: DraftAction): DraftUiState {
  switch (action.type) {
    case "change":
      return { status: "dirty", savedAt: state.savedAt };
    case "saving":
      return { status: "saving", savedAt: state.savedAt };
    case "saved":
      return { status: "saved", savedAt: action.savedAt };
    case "failed":
      return { status: "error", savedAt: state.savedAt };
    case "reset":
      return initialDraftState;
    default:
      return state;
  }
}

/** 把 UTC ISO 时间转成本地 HH:mm；无法解析时返回空串（绝不显示假时间）。 */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 草稿状态文案：
 * - 只有 saved 展示具体时间；dirty/saving 不展示「已保存」以免伪造确认；
 * - error 由 UI 渲染成可点击重试按钮，这里只给兜底文案。
 */
export function describeDraft(state: DraftUiState): string {
  switch (state.status) {
    case "dirty":
      return "待保存…";
    case "saving":
      return "正在保存…";
    case "saved": {
      const clock = formatClock(state.savedAt);
      return clock ? `草稿已保存 ${clock}` : "草稿已保存";
    }
    case "error":
      return "保存失败，点击重试";
    default:
      return "";
  }
}

/** 每次提交的幂等键：成功后才重置，失败重试必须复用同一个。 */
export function newClientId(): string {
  const cryptoObj = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") return cryptoObj.randomUUID();
  return `capture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 把任意异常压成可展示的一行文案（不吞掉错误原因）。 */
export function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const trimmed = message.trim();
  return trimmed || "未知错误";
}

// ── 语音输入 ───────────────────────────────────────────────────
export interface AppendDictationResult {
  content: string;
  /** true = 片段超出上限被截断，调用方应停止听写并提示 */
  overflow: boolean;
}

/**
 * 定稿片段追加：绝不改写已有正文；只在两个 ASCII 词之间补一个空格
 * （中文与英文/数字相邻时不插空格）。超出上限时截断片段并报告 overflow。
 */
export function appendDictation(
  existing: string,
  segment: string,
  max: number = CONTENT_MAX,
): AppendDictationResult {
  const addition = segment.trim();
  if (!addition) return { content: existing, overflow: false };
  const needsSpace =
    existing.length > 0 &&
    !/\s$/.test(existing) &&
    /[A-Za-z0-9]$/.test(existing) &&
    /^[A-Za-z0-9]/.test(addition);
  const separator = needsSpace ? " " : "";
  const available = max - existing.length - separator.length;
  if (available <= 0) return { content: existing, overflow: true };
  const clipped = addition.slice(0, available);
  return {
    content: existing + separator + clipped,
    overflow: clipped.length < addition.length,
  };
}

/**
 * 听写中的提示文案：系统没有中文识别包时如实说明回退语言，
 * 不让用户以为说的是中文却被识别成别的语言。
 */
export function voiceListeningMessage(language: string): string {
  const tag = language.trim();
  if (!tag.toLowerCase().startsWith("zh")) {
    return tag
      ? `系统未提供中文语音包，正在使用 ${tag} 听写，点击麦克风结束`
      : "系统未提供中文语音包，正在使用系统语音听写，点击麦克风结束";
  }
  return "正在听写，点击麦克风结束";
}
