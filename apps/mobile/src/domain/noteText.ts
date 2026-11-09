// 笔记正文纯函数：编辑器的文本变换与列表摘要都收敛在这里，
// 不 import react/RN/expo/db，保证可以脱离 RN 单独编译断言（logic/check.cjs）。
// 光标约定：start/end 是 TextInput 的 selection（字符偏移，end >= start）。

export interface TextEditResult {
  text: string;
  /** 变换后应把光标放回的位置 */
  start: number;
  end: number;
}

/**
 * 在选区两侧包一层标记（如 **），并把选区保持选中：
 * - 无选区（start === end）时插入一对空标记，光标落在中间；
 * - 已选中时再次执行会重复包裹，由调用方决定是否防重。
 */
export function wrapSelection(
  body: string,
  start: number,
  end: number,
  before: string,
  after: string,
): TextEditResult {
  const head = body.slice(0, clamp(body, start));
  const tail = body.slice(clamp(body, end));
  const selected = body.slice(clamp(body, start), clamp(body, end));
  const text = `${head}${before}${selected}${after}${tail}`;
  const nextStart = head.length + before.length;
  return { text, start: nextStart, end: nextStart + selected.length };
}

/** 在光标处插入一段文本，光标停在插入内容之后 */
export function insertSnippet(
  body: string,
  start: number,
  end: number,
  snippet: string,
): TextEditResult {
  const head = body.slice(0, clamp(body, start));
  const tail = body.slice(clamp(body, end));
  const text = `${head}${snippet}${tail}`;
  const cursor = head.length + snippet.length;
  return { text, start: cursor, end: cursor };
}

// 行首标记：标题 #{1,6}、列表 - * +（可紧随待办框）；可能叠加，由 plainPreview 循环剥离。
const LINE_PREFIX = /^[ \t]*(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]*)?)/gm;

/**
 * 预览去标记：只用于列表摘要与展示标题，不改存储值、不影响 countChars。
 * - 行首 #{1,6} 与 - * + 列表前缀去掉，待办框 [ ] / [x] / [X] 随之去掉；
 * - 成对的 ** __ ` 去掉，不成对的保留原样；
 * - 轻量处理，不做完整 Markdown 解析。
 */
export function plainPreview(body: string): string {
  let text = stripLinePrefixes(body);
  // 成对标记只作用于同一行内，避免跨行吞掉正文。
  text = text.replace(/\*\*([^\n]+?)\*\*/g, "$1");
  text = text.replace(/__([^\n]+?)__/g, "$1");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  // 去掉包裹后可能露出的行首标记（如「**- 列表**」）；预览不保留首尾空白。
  return stripLinePrefixes(text).trim();
}

/** 列表摘要：按去标记后的文本压平空白，再按最大字符数截断（截断带省略号） */
export function excerpt(body: string, max = 64): string {
  const flat = plainPreview(body).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * 字数统计：按中文习惯只数非空白字符（「128 字」不含空格换行）。
 */
export function countChars(body: string): number {
  return body.replace(/\s/g, "").length;
}

/** 笔记展示标题：标题去标记后为空则回退到摘要，再回退到「无标题」 */
export function noteDisplayTitle(title: string, body: string, max = 24): string {
  const trimmed = plainPreview(title);
  if (trimmed) return trimmed;
  const bodyExcerpt = excerpt(body, max);
  return bodyExcerpt || "无标题";
}

/** 循环剥离行首标记（最多 4 轮，覆盖标题/列表/待办叠加的极端写法） */
function stripLinePrefixes(text: string): string {
  let out = text;
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(LINE_PREFIX, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

function clamp(body: string, index: number): number {
  return Math.max(0, Math.min(body.length, index));
}
