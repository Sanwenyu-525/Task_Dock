//! 安全 Markdown 解析（GFM 子集，纯函数、零依赖、不执行任何 HTML）。
//!
//! 为什么自己实现：项目约束不允许为预览引入大型 Markdown 依赖，也不允许用几条
//! 正则冒充完整引擎。这里是一个**有明确边界的块级 + 行内解析器**：
//!
//! 支持：ATX 标题（1-6）、段落（保留软换行）、粗体 / 斜体 / 删除线、行内代码、
//! 围栏代码块（含语言）、无序 / 有序 / 任务列表（层级由缩进递归表达）、引用块、
//! 分隔线、表格（含对齐）、链接与自动链接。
//!
//! 明确不支持（避免「看起来支持、实际错乱」）：原始 HTML（按源码块展示，绝不执行）、
//! 引用式链接 `[x][id]`、脚注、定义列表、目录、公式、图片渲染（只显示替代文本，
//! 不自动加载任何远程资源）。
//!
//! 安全模型：输出是带偏移的纯数据结构，渲染层只会生成 React 文本节点；
//! 链接必须通过 `sanitizeLinkHref`（仅 http/https/mailto），相对链接与
//! `javascript:`/`data:` 一律降级为纯文本。

export type MdAlign = "left" | "center" | "right" | null;

export type MdInline =
  | { type: "text"; value: string; start: number }
  | { type: "code"; value: string; start: number }
  | { type: "strong" | "em" | "del"; children: MdInline[]; start: number }
  | { type: "link"; href: string; children: MdInline[]; start: number }
  /** 协议不合法或被拒绝的链接：保留原文字，渲染为普通文本 + 提示。 */
  | { type: "link-blocked"; rawHref: string; children: MdInline[]; start: number }
  | { type: "image"; alt: string; start: number }
  | { type: "break" };

export interface MdListItem {
  /** 原始标记（`-` / `*` / `1.`…），有序列表用于显示编号。 */
  marker: string;
  /** 任务列表状态；`null` = 不是任务项。 */
  checked: boolean | null;
  blocks: MdBlock[];
  start: number;
}

export type MdBlock =
  | { type: "heading"; level: number; children: MdInline[]; start: number }
  | { type: "paragraph"; children: MdInline[]; start: number }
  | { type: "code"; lang: string; text: string; start: number }
  | { type: "quote"; blocks: MdBlock[]; start: number }
  | { type: "list"; ordered: boolean; items: MdListItem[]; start: number }
  | { type: "hr"; start: number }
  | {
      type: "table";
      align: MdAlign[];
      header: MdInline[][];
      rows: MdInline[][][];
      start: number;
    }
  | { type: "html"; text: string; start: number };

export interface MarkdownDocument {
  blocks: MdBlock[];
  /** 解析预算耗尽（节点/层级上限）时为 true，渲染层给出「内容未完整解析」提示。 */
  truncated: boolean;
}

export interface MarkdownParseOptions {
  /** 单次解析的最大行数（默认 5000）；超出部分不解析。 */
  maxLines?: number;
  /** 块 + 行内节点预算（默认 20000）。 */
  maxNodes?: number;
}

const MAX_DEPTH = 6;
export const DEFAULT_MAX_MARKDOWN_LINES = 5000;
export const DEFAULT_MAX_MARKDOWN_NODES = 20000;

interface Line {
  text: string;
  start: number;
}

interface Budget {
  nodes: number;
  maxNodes: number;
  truncated: boolean;
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i <= source.length; i += 1) {
    if (i === source.length || source.charCodeAt(i) === 10) {
      lines.push({ text: source.slice(start, i), start });
      start = i + 1;
    }
  }
  return lines;
}

// ── 链接安全 ────────────────────────────────────────────────────────────

export type LinkDecision =
  | { ok: true; href: string }
  | { ok: false; reason: "empty" | "too-long" | "relative" | "protocol" };

const ALLOWED_PROTOCOLS = new Set(["http", "https", "mailto"]);

/**
 * 链接协议白名单：只放行 http/https/mailto。
 * 相对链接在本地文件预览里没有可靠基准，直接拒绝（渲染为纯文本）。
 */
export function sanitizeLinkHref(raw: string): LinkDecision {
  let value = raw.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
  if (!value) return { ok: false, reason: "empty" };
  if (value.length > 2048) return { ok: false, reason: "too-long" };
  // 控制字符与空白（除 mailto 的 subject 空格）一律视为不可信。
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, reason: "protocol" };
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  if (!match) return { ok: false, reason: "relative" };
  const protocol = match[1].toLowerCase();
  if (!ALLOWED_PROTOCOLS.has(protocol)) return { ok: false, reason: "protocol" };
  if ((protocol === "http" || protocol === "https") && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$/.test(value)) {
    return { ok: false, reason: "protocol" };
  }
  return { ok: true, href: value };
}

// ── 行内解析 ────────────────────────────────────────────────────────────

const ESCAPABLE = new Set(["\\", "`", "*", "_", "~", "[", "]", "(", ")", "#", "-", "+", ".", "!", "<", ">", "|", "{", "}"]);

function textNode(value: string, start: number): MdInline {
  return { type: "text", value, start };
}

/** 行内解析：`base` 是该段文本在原文中的起始偏移（用于搜索定位）。 */
export function parseInline(source: string, base: number, budget?: Budget): MdInline[] {
  const nodes: MdInline[] = [];
  let buffer = "";
  let bufferStart = -1;
  let i = 0;

  const flush = () => {
    if (buffer) {
      nodes.push(textNode(buffer, bufferStart < 0 ? base : bufferStart));
      buffer = "";
      bufferStart = -1;
      if (budget) budget.nodes += 1;
    }
  };
  const push = (node: MdInline) => {
    flush();
    nodes.push(node);
    if (budget) budget.nodes += 1;
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === "\\" && ESCAPABLE.has(source[i + 1] ?? "")) {
      if (!buffer) bufferStart = base + i;
      buffer += source[i + 1];
      i += 2;
      continue;
    }

    if (ch === "\n") {
      // 软换行保留为换行：本地文件阅读里「按行写」比 CommonMark 的空格更符合预期。
      push({ type: "break" });
      i += 1;
      continue;
    }

    if (ch === "`") {
      let run = 1;
      while (source[i + run] === "`") run += 1;
      const marker = "`".repeat(run);
      const end = source.indexOf(marker, i + run);
      if (end > i) {
        let value = source.slice(i + run, end);
        if (value.startsWith(" ") && value.endsWith(" ") && value.trim()) value = value.slice(1, -1);
        push({ type: "code", value, start: base + i });
        i = end + run;
        continue;
      }
    }

    if (ch === "*" || ch === "_" || ch === "~") {
      const double = source.startsWith(`${ch}${ch}`, i);
      const marker = double ? `${ch}${ch}` : ch;
      if (ch === "~" && !double) {
        // 单个 `~` 不是 Markdown 语法，按普通字符处理。
      } else {
        const end = findInlineClose(source, marker, i + marker.length);
        if (end > i) {
          const inner = source.slice(i + marker.length, end);
          if (inner.trim()) {
            const children = parseInline(inner, base + i + marker.length, budget);
            if (ch === "~") push({ type: "del", children, start: base + i });
            else if (double) push({ type: "strong", children, start: base + i });
            else push({ type: "em", children, start: base + i });
            i = end + marker.length;
            continue;
          }
        }
      }
    }

    if (ch === "!" && source[i + 1] === "[") {
      const parsed = parseLinkAt(source, i + 1, base, budget, true);
      if (parsed) {
        push(parsed.node);
        i = parsed.next;
        continue;
      }
    }

    if (ch === "[") {
      const parsed = parseLinkAt(source, i, base, budget, false);
      if (parsed) {
        push(parsed.node);
        i = parsed.next;
        continue;
      }
    }

    if (ch === "<") {
      const end = source.indexOf(">", i + 1);
      if (end > i) {
        const candidate = source.slice(i + 1, end);
        if (/^(https?:\/\/|mailto:)/i.test(candidate)) {
          const decision = sanitizeLinkHref(candidate);
          if (decision.ok) {
            push({
              type: "link",
              href: decision.href,
              children: [textNode(candidate, base + i + 1)],
              start: base + i,
            });
            i = end + 1;
            continue;
          }
        }
      }
    }

    if (!buffer) bufferStart = base + i;
    buffer += ch;
    i += 1;
  }

  flush();
  return nodes;
}

/** 找到与 `marker` 配对的结束位置（跳过转义字符）。找不到返回 -1。 */
function findInlineClose(source: string, marker: string, from: number): number {
  let i = from;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source.startsWith(marker, i)) return i;
    // 行内强调不跨行：换行后不再寻找闭合标记，避免整段被吞。
    if (source[i] === "\n") return -1;
    i += 1;
  }
  return -1;
}

function parseLinkAt(
  source: string,
  open: number,
  base: number,
  budget: Budget | undefined,
  image: boolean,
): { node: MdInline; next: number } | null {
  const closeBracket = findCloseBracket(source, open);
  if (closeBracket < 0) return null;
  if (source[closeBracket + 1] !== "(") return null;
  const closeParen = findCloseParen(source, closeBracket + 2);
  if (closeParen < 0) return null;

  const label = source.slice(open + 1, closeBracket);
  const target = source.slice(closeBracket + 2, closeParen).trim();
  const next = closeParen + 1;

  if (image) {
    return { node: { type: "image", alt: label, start: base + open - 1 }, next };
  }

  if (!label) return null;
  const children = parseInline(label, base + open + 1, budget);
  const href = splitLinkTarget(target);
  const decision = href ? sanitizeLinkHref(href) : ({ ok: false, reason: "empty" } as const);
  if (!decision.ok) {
    return {
      node: { type: "link-blocked", rawHref: href ?? "", children, start: base + open },
      next,
    };
  }
  return { node: { type: "link", href: decision.href, children, start: base + open }, next };
}

/** `[text](href "title")` → 只取 href（title 不参与）。 */
function splitLinkTarget(target: string): string | null {
  if (!target) return null;
  if (target.startsWith("<")) {
    const end = target.indexOf(">");
    if (end > 0) return target.slice(1, end);
  }
  const space = target.search(/\s/);
  return space < 0 ? target : target.slice(0, space);
}

function findCloseBracket(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "\n") return -1;
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findCloseParen(source: string, from: number): number {
  let depth = 1;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "\n") return -1;
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ── 块级解析 ────────────────────────────────────────────────────────────

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^( {0,3})(#{1,6})(?:[ \t]+|$)(.*)$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>(?:[ \t]?)(.*)$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;
const HTML_START = /^ {0,3}<(?:[A-Za-z][\w-]*|\/[A-Za-z][\w-]*|!--|\?|!)/;

function isBlank(line: Line): boolean {
  return line.text.trim().length === 0;
}

function startsBlock(lines: Line[], index: number): boolean {
  const text = lines[index].text;
  return (
    FENCE.test(text) || HEADING.test(text) || HR.test(text) || QUOTE.test(text) || LIST_ITEM.test(text) || HTML_START.test(text)
  );
}

function stripLine(line: Line, count: number): Line {
  const remove = Math.min(count, line.text.length - line.text.trimStart().length);
  return { text: line.text.slice(remove), start: line.start + remove };
}

function pushBlock(budget: Budget, blocks: MdBlock[], block: MdBlock): void {
  budget.nodes += 1;
  blocks.push(block);
}

function parseBlocks(lines: Line[], from: number, to: number, depth: number, budget: Budget): MdBlock[] {
  const blocks: MdBlock[] = [];
  let i = from;

  while (i < to) {
    if (budget.nodes >= budget.maxNodes) {
      budget.truncated = true;
      break;
    }
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const text = line.text;

    const fence = FENCE.exec(text);
    if (fence) {
      const marker = fence[2][0];
      const markerLen = fence[2].length;
      const lang = fence[3].trim().split(/\s+/)[0] ?? "";
      const closing = new RegExp(`^ {0,3}${marker === "`" ? "`" : "~"}{${markerLen},}[ \\t]*$`);
      const content: Line[] = [];
      let j = i + 1;
      while (j < to) {
        const candidate = lines[j];
        if (closing.test(candidate.text)) break;
        content.push(candidate);
        j += 1;
      }
      pushBlock(budget, blocks, {
        type: "code",
        lang,
        text: content.map((item) => item.text).join("\n"),
        start: content[0]?.start ?? line.start,
      });
      i = j < to ? j + 1 : to;
      continue;
    }

    const heading = HEADING.exec(text);
    if (heading) {
      const level = heading[2].length;
      const raw = heading[3].replace(/[ \t]+#+[ \t]*$/, "");
      const contentStart = line.start + text.length - heading[3].length;
      const children = parseInline(raw, contentStart, budget);
      pushBlock(budget, blocks, { type: "heading", level, children, start: line.start });
      i += 1;
      continue;
    }

    if (HR.test(text)) {
      pushBlock(budget, blocks, { type: "hr", start: line.start });
      i += 1;
      continue;
    }

    if (QUOTE.test(text)) {
      const quoted: Line[] = [];
      let j = i;
      while (j < to) {
        const match = QUOTE.exec(lines[j].text);
        if (!match) break;
        const markerLen = lines[j].text.indexOf(">") + 1;
        const extra = /^[ \t]?/.exec(lines[j].text.slice(markerLen))?.[0].length ?? 0;
        quoted.push({
          text: lines[j].text.slice(markerLen + extra),
          start: lines[j].start + markerLen + extra,
        });
        j += 1;
      }
      const inner =
        depth >= MAX_DEPTH
          ? [{ type: "paragraph" as const, children: parseInline(quoted.map((q) => q.text).join("\n"), quoted[0]?.start ?? line.start, budget), start: quoted[0]?.start ?? line.start }]
          : parseBlocks(quoted, 0, quoted.length, depth + 1, budget);
      pushBlock(budget, blocks, { type: "quote", blocks: inner, start: line.start });
      i = j;
      continue;
    }

    const table = tryParseTable(lines, i, to, budget);
    if (table) {
      pushBlock(budget, blocks, table.block);
      i = table.next;
      continue;
    }

    const list = tryParseList(lines, i, to, depth, budget);
    if (list) {
      pushBlock(budget, blocks, list.block);
      i = list.next;
      continue;
    }

    if (HTML_START.test(text)) {
      const raw: Line[] = [];
      let j = i;
      while (j < to && !isBlank(lines[j])) {
        raw.push(lines[j]);
        j += 1;
      }
      pushBlock(budget, blocks, {
        type: "html",
        text: raw.map((item) => item.text).join("\n"),
        start: line.start,
      });
      i = j;
      continue;
    }

    // 段落：直到空行或下一个块起始。
    const parts: Line[] = [];
    let j = i;
    while (j < to && !isBlank(lines[j]) && !(j > i && startsBlock(lines, j))) {
      parts.push(lines[j]);
      j += 1;
    }
    if (parts.length === 0) {
      parts.push(line);
      j = i + 1;
    }
    const joined = parts.map((item) => item.text).join("\n");
    pushBlock(budget, blocks, {
      type: "paragraph",
      children: parseInline(joined, parts[0].start, budget),
      start: parts[0].start,
    });
    i = j;
  }

  return blocks;
}

function splitTableRow(text: string, lineStart: number): Array<{ text: string; start: number }> {
  const cells: Array<{ text: string; start: number }> = [];
  let buffer = "";
  let cellStart = 0;
  let i = 0;
  const push = () => {
    cells.push({ text: buffer.trim(), start: lineStart + cellStart + (buffer.length - buffer.trimStart().length) });
    buffer = "";
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "|") {
      buffer += "|";
      i += 2;
      continue;
    }
    if (ch === "|") {
      push();
      i += 1;
      cellStart = i;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  push();
  // GFM：首尾的 `|` 产生空单元格，需要移除。
  if (cells.length > 0 && cells[0].text === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].text === "") cells.pop();
  return cells;
}

function tryParseTable(
  lines: Line[],
  start: number,
  to: number,
  budget: Budget,
): { block: MdBlock; next: number } | null {
  if (start + 1 >= to) return null;
  const headerLine = lines[start];
  if (!headerLine.text.includes("|") || !TABLE_DELIMITER.test(lines[start + 1].text)) return null;
  const headerCells = splitTableRow(headerLine.text, headerLine.start);
  const delimiterCells = splitTableRow(lines[start + 1].text, lines[start + 1].start);
  if (headerCells.length === 0 || delimiterCells.length !== headerCells.length) return null;

  const align = delimiterCells.map<MdAlign>((cell) => {
    const left = cell.text.startsWith(":");
    const right = cell.text.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });

  const rows: MdInline[][][] = [];
  let j = start + 2;
  while (j < to && !isBlank(lines[j]) && lines[j].text.includes("|")) {
    const cells = splitTableRow(lines[j].text, lines[j].start);
    const row: MdInline[][] = [];
    for (let k = 0; k < headerCells.length; k += 1) {
      const cell = cells[k];
      row.push(cell ? parseInline(cell.text, cell.start, budget) : []);
    }
    rows.push(row);
    j += 1;
  }

  return {
    block: {
      type: "table",
      align,
      header: headerCells.map((cell) => parseInline(cell.text, cell.start, budget)),
      rows,
      start: headerLine.start,
    },
    next: j,
  };
}

function tryParseList(
  lines: Line[],
  start: number,
  to: number,
  depth: number,
  budget: Budget,
): { block: MdBlock; next: number } | null {
  const first = LIST_ITEM.exec(lines[start].text);
  if (!first) return null;
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: MdListItem[] = [];
  let i = start;

  while (i < to) {
    const match = LIST_ITEM.exec(lines[i].text);
    if (!match || match[1].length !== baseIndent || /\d/.test(match[2]) !== ordered) break;

    const marker = match[2];
    const contentIndent = match[1].length + marker.length + match[3].length;
    let content = match[4];
    let checked: boolean | null = null;
    let contentStart = lines[i].start + contentIndent;

    const task = /^\[([ xX])\](?:[ \t]+|$)/.exec(content);
    if (task) {
      checked = task[1].toLowerCase() === "x";
      const shift = task[0].length;
      content = content.slice(shift);
      contentStart += shift;
    }

    const contentLines: Line[] = [{ text: content, start: contentStart }];
    let j = i + 1;
    let pendingBlank: Line[] = [];
    while (j < to) {
      const candidate = lines[j];
      if (isBlank(candidate)) {
        pendingBlank.push(candidate);
        j += 1;
        continue;
      }
      const nextItem = LIST_ITEM.exec(candidate.text);
      if (nextItem && nextItem[1].length === baseIndent) break;
      const indent = candidate.text.length - candidate.text.trimStart().length;
      if (indent <= baseIndent && !nextItem) break;
      // 空行只有在后面仍有本项内容时才属于该项（避免把后续段落吞进列表）。
      if (pendingBlank.length > 0) {
        contentLines.push(...pendingBlank);
        pendingBlank = [];
      }
      contentLines.push(stripLine(candidate, Math.min(contentIndent, indent)));
      j += 1;
    }

    const itemBlocks =
      depth >= MAX_DEPTH
        ? [
            {
              type: "paragraph" as const,
              children: parseInline(contentLines.map((line) => line.text).join("\n"), contentLines[0].start, budget),
              start: contentLines[0].start,
            },
          ]
        : parseBlocks(contentLines, 0, contentLines.length, depth + 1, budget);

    items.push({ marker, checked, blocks: itemBlocks, start: lines[i].start });
    i = j;
    // 空行分隔的宽松列表：跳过后继续同层列表。
    if (i < to && isBlank(lines[i])) {
      let k = i;
      while (k < to && isBlank(lines[k])) k += 1;
      const nextItem = k < to ? LIST_ITEM.exec(lines[k].text) : null;
      if (nextItem && nextItem[1].length === baseIndent && /\d/.test(nextItem[2]) === ordered) {
        i = k;
        continue;
      }
      break;
    }
  }

  if (items.length === 0) return null;
  return { block: { type: "list", ordered, items, start: lines[start].start }, next: i };
}

/**
 * 解析 Markdown。绝不抛错：输入异常只会得到更少的块，并把 `truncated` 置为 true。
 */
export function parseMarkdown(source: string, options: MarkdownParseOptions = {}): MarkdownDocument {
  const maxLines = options.maxLines ?? DEFAULT_MAX_MARKDOWN_LINES;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_MARKDOWN_NODES;
  const all = splitLines(source);
  const budget: Budget = { nodes: 0, maxNodes, truncated: all.length > maxLines };
  const lines = all.slice(0, maxLines);
  const blocks = parseBlocks(lines, 0, lines.length, 0, budget);
  return { blocks, truncated: budget.truncated };
}

/** 摘要用：纯文本预览（无渲染、无 HTML），用于目录/搜索结果。 */
export function markdownToPlainText(source: string, limit = 280): string {
  const { blocks } = parseMarkdown(source, { maxLines: 200, maxNodes: 2000 });
  const parts: string[] = [];
  let length = 0;
  const visitInline = (nodes: MdInline[]) => {
    for (const node of nodes) {
      if (length >= limit) return;
      if (node.type === "text" || node.type === "code") {
        const value = node.value.replace(/\s+/g, " ");
        parts.push(value);
        length += value.length;
      } else if (node.type === "break") {
        parts.push(" ");
      } else if (node.type === "image") {
        parts.push(`[图片: ${node.alt}]`);
      } else if ("children" in node) {
        visitInline(node.children);
      }
    }
  };
  const visitBlocks = (blocksToVisit: MdBlock[]) => {
    for (const block of blocksToVisit) {
      if (length >= limit) return;
      switch (block.type) {
        case "heading":
        case "paragraph":
          visitInline(block.children);
          parts.push(" ");
          break;
        case "code":
          parts.push(block.text.slice(0, 80), " ");
          break;
        case "quote":
          visitBlocks(block.blocks);
          break;
        case "list":
          for (const item of block.items) {
            if (item.checked !== null) parts.push(item.checked ? "[x] " : "[ ] ");
            visitBlocks(item.blocks);
          }
          break;
        case "table":
          for (const cell of block.header) visitInline(cell);
          parts.push(" ");
          break;
        default:
          break;
      }
    }
  };
  visitBlocks(blocks);
  return parts.join("").replace(/\s+/g, " ").trim().slice(0, limit);
}
