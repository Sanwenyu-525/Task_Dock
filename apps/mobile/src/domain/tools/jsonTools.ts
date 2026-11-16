// JSON 工具的纯函数层：自建解析器 + 保真格式化 + 树形投影。
//
// 为什么不用 JSON.parse：
// 1. 超过 Number.MAX_SAFE_INTEGER 的整数会被静默改值（1234567890123456789 → …7890），
//    用户以为「只是格式化」，实际数据已经被改坏；
// 2. JSON.parse 的报错只有一句 "Unexpected token"，没有行列号，手机上看不出错在哪；
// 3. 树形查看需要保留键的顺序、重复键与原始数字字面量，JSON.parse 之后这些信息就没了。
//
// 这里实现的递归下降解析器严格按 RFC 8259 收字符：数字保留 raw 字面量、字符串按
// JSON 规则反转义、对象保留键顺序并记录重复键告警。格式化只重排空白，不改变任何值。
//
// 边界（手机内存与主线程）：
// - 输入超过 MAX_JSON_CHARS 直接拒绝，不进入解析；
// - 节点超过 MAX_JSON_NODES、嵌套超过 MAX_JSON_DEPTH 立即报错，避免爆栈/长时间占用；
// - 解析是同步的，但上限保证单次在百毫秒级；调用方仍应先渲染「正在解析」再让出一帧。
//
// 本文件为纯函数：不得 import react / react-native / expo / db。

export const MAX_JSON_CHARS = 1_000_000;
export const MAX_JSON_NODES = 120_000;
export const MAX_JSON_DEPTH = 200;

export type JsonAst =
  | { kind: "object"; entries: JsonEntry[] }
  | { kind: "array"; items: JsonAst[] }
  | { kind: "string"; value: string }
  | { kind: "number"; raw: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" };

export interface JsonEntry {
  key: string;
  value: JsonAst;
}

export interface JsonPosition {
  offset: number;
  line: number;
  column: number;
}

export interface JsonError extends JsonPosition {
  message: string;
}

export type JsonParseResult =
  | { ok: true; ast: JsonAst; warnings: string[]; nodeCount: number; maxDepth: number }
  | { ok: false; error: JsonError };

function positionAt(text: string, offset: number): JsonPosition {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(Math.max(0, offset), text.length);
  for (let index = 0; index < end; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { offset: end, line, column: end - lineStart + 1 };
}

function fail(text: string, offset: number, message: string): JsonParseResult {
  return { ok: false, error: { ...positionAt(text, offset), message } };
}

/** 数字字面量是否超出 JS 安全整数范围：只做展示告警，格式化仍保留原文。 */
export function isUnsafeNumberLiteral(raw: string): boolean {
  const digits = raw.replace(/^[+-]/, "").replace(/\./, "").replace(/e[+-]?\d+$/i, "");
  const trimmed = digits.replace(/^0+/, "");
  if (trimmed.length > 15) return true;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && !Number.isSafeInteger(numeric) && !raw.includes(".");
}

/**
 * 严格 JSON 解析。返回 AST（数字保留原始字面量），不返回 JS 对象，
 * 因此格式化与树形查看都不会改变超大整数。
 */
export function parseJson(text: string): JsonParseResult {
  if (text.length > MAX_JSON_CHARS) {
    return fail(
      text,
      0,
      `输入 ${text.length} 个字符，超过本机安全上限 ${MAX_JSON_CHARS}；请先拆分后再格式化`,
    );
  }

  const warnings: string[] = [];
  let index = 0;
  let nodes = 0;
  let maxDepth = 0;

  const skipWhitespace = (): void => {
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 32 || code === 9 || code === 10 || code === 13) {
        index += 1;
        continue;
      }
      break;
    }
  };

  const countNode = (depth: number): string | null => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) return `节点数量超过上限 ${MAX_JSON_NODES}，请先拆分数据`;
    if (depth > MAX_JSON_DEPTH) return `嵌套层级超过上限 ${MAX_JSON_DEPTH}，无法安全解析`;
    if (depth > maxDepth) maxDepth = depth;
    return null;
  };

  const parseString = (): { ok: true; value: string } | { ok: false; error: JsonError } => {
    const start = index;
    index += 1; // 开引号
    let value = "";
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 34) {
        index += 1;
        return { ok: true, value };
      }
      if (code === 92) {
        index += 1;
        if (index >= text.length) {
          return {
            ok: false,
            error: { ...positionAt(text, start), message: "字符串没有闭合" },
          };
        }
        const escape = text[index];
        switch (escape) {
          case '"':
            value += '"';
            index += 1;
            break;
          case "\\":
            value += "\\";
            index += 1;
            break;
          case "/":
            value += "/";
            index += 1;
            break;
          case "b":
            value += "\b";
            index += 1;
            break;
          case "f":
            value += "\f";
            index += 1;
            break;
          case "n":
            value += "\n";
            index += 1;
            break;
          case "r":
            value += "\r";
            index += 1;
            break;
          case "t":
            value += "\t";
            index += 1;
            break;
          case "u": {
            const hex = text.slice(index + 1, index + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              return {
                ok: false,
                error: { ...positionAt(text, index), message: "\\u 转义需要 4 位十六进制" },
              };
            }
            value += String.fromCharCode(parseInt(hex, 16));
            index += 5;
            break;
          }
          default:
            return {
              ok: false,
              error: {
                ...positionAt(text, index),
                message: `不支持的转义 \\${escape}（JSON 只允许 \" \\\\ \\/ \\b \\f \\n \\r \\t \\uXXXX）`,
              },
            };
        }
        continue;
      }
      if (code < 0x20) {
        return {
          ok: false,
          error: { ...positionAt(text, index), message: "字符串里不能出现未转义的控制字符" },
        };
      }
      value += text[index];
      index += 1;
    }
    return { ok: false, error: { ...positionAt(text, start), message: "字符串没有闭合" } };
  };

  const parseNumber = (): { ok: true; raw: string } | { ok: false; error: JsonError } => {
    const start = index;
    if (text[index] === "-") index += 1;
    if (index >= text.length) {
      return { ok: false, error: { ...positionAt(text, start), message: "数字缺少整数部分" } };
    }
    if (text[index] === "0") {
      index += 1;
    } else if (text[index] >= "1" && text[index] <= "9") {
      while (index < text.length && text[index] >= "0" && text[index] <= "9") index += 1;
    } else {
      return { ok: false, error: { ...positionAt(text, index), message: "这里需要数字" } };
    }
    if (text[index] === ".") {
      index += 1;
      const fractionStart = index;
      while (index < text.length && text[index] >= "0" && text[index] <= "9") index += 1;
      if (index === fractionStart) {
        return { ok: false, error: { ...positionAt(text, index), message: "小数点后需要数字" } };
      }
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      const exponentStart = index;
      while (index < text.length && text[index] >= "0" && text[index] <= "9") index += 1;
      if (index === exponentStart) {
        return { ok: false, error: { ...positionAt(text, index), message: "指数部分需要数字" } };
      }
    }
    const raw = text.slice(start, index);
    if (isUnsafeNumberLiteral(raw)) {
      warnings.push(
        `数字 ${raw.length > 24 ? `${raw.slice(0, 24)}…` : raw} 超出 JS 安全整数范围；已保留原始字面量，格式化不会改值`,
      );
    }
    return { ok: true, raw };
  };

  const parseValue = (depth: number): { ok: true; value: JsonAst } | { ok: false; error: JsonError } => {
    skipWhitespace();
    if (index >= text.length) {
      return { ok: false, error: { ...positionAt(text, index), message: "内容不完整，缺少值" } };
    }
    const limit = countNode(depth);
    if (limit) return { ok: false, error: { ...positionAt(text, index), message: limit } };

    const char = text[index];
    if (char === "{") {
      index += 1;
      const entries: JsonEntry[] = [];
      const seen = new Map<string, number>();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return { ok: true, value: { kind: "object", entries } };
      }
      for (;;) {
        skipWhitespace();
        if (text[index] !== '"') {
          return {
            ok: false,
            error: { ...positionAt(text, index), message: "对象的键必须是双引号字符串" },
          };
        }
        const key = parseString();
        if (!key.ok) return key;
        skipWhitespace();
        if (text[index] !== ":") {
          return { ok: false, error: { ...positionAt(text, index), message: "键后面需要冒号" } };
        }
        index += 1;
        const value = parseValue(depth + 1);
        if (!value.ok) return value;
        const previous = seen.get(key.value);
        if (previous === undefined) {
          seen.set(key.value, entries.length);
          entries.push({ key: key.value, value: value.value });
        } else {
          // 与 JSON.parse 的最终结果保持一致：保留最后一个值，但把重复键明确告警。
          entries[previous] = { key: key.value, value: value.value };
          warnings.push(`对象存在重复键「${key.value}」，已保留最后一个值（与 JSON.parse 一致）`);
        }
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "}") {
          index += 1;
          return { ok: true, value: { kind: "object", entries } };
        }
        return { ok: false, error: { ...positionAt(text, index), message: "对象成员之间需要逗号或 }" } };
      }
    }
    if (char === "[") {
      index += 1;
      const items: JsonAst[] = [];
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return { ok: true, value: { kind: "array", items } };
      }
      for (;;) {
        const item = parseValue(depth + 1);
        if (!item.ok) return item;
        items.push(item.value);
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "]") {
          index += 1;
          return { ok: true, value: { kind: "array", items } };
        }
        return { ok: false, error: { ...positionAt(text, index), message: "数组元素之间需要逗号或 ]" } };
      }
    }
    if (char === '"') {
      const value = parseString();
      if (!value.ok) return value;
      return { ok: true, value: { kind: "string", value: value.value } };
    }
    if (char === "t") {
      if (text.startsWith("true", index)) {
        index += 4;
        return { ok: true, value: { kind: "boolean", value: true } };
      }
      return { ok: false, error: { ...positionAt(text, index), message: "这里只允许 true / false / null" } };
    }
    if (char === "f") {
      if (text.startsWith("false", index)) {
        index += 5;
        return { ok: true, value: { kind: "boolean", value: false } };
      }
      return { ok: false, error: { ...positionAt(text, index), message: "这里只允许 true / false / null" } };
    }
    if (char === "n") {
      if (text.startsWith("null", index)) {
        index += 4;
        return { ok: true, value: { kind: "null" } };
      }
      return { ok: false, error: { ...positionAt(text, index), message: "这里只允许 true / false / null" } };
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      const number = parseNumber();
      if (!number.ok) return number;
      return { ok: true, value: { kind: "number", raw: number.raw } };
    }
    return {
      ok: false,
      error: {
        ...positionAt(text, index),
        message: `无法识别的字符「${char}」；JSON 的值必须以 { [ " 数字 true false null 开头`,
      },
    };
  };

  const root = parseValue(0);
  if (!root.ok) return root;
  skipWhitespace();
  if (index < text.length) {
    return fail(text, index, "JSON 结束后还有多余内容（一次只能解析一个 JSON 值）");
  }
  return { ok: true, ast: root.value, warnings, nodeCount: nodes, maxDepth };
}

/** 错误位置的一行上下文：UI 用它显示「第 3 行附近」。 */
export function errorContext(text: string, error: JsonError, radius = 1): string {
  const lines = text.split(/\r?\n/);
  const from = Math.max(0, error.line - 1 - radius);
  const to = Math.min(lines.length - 1, error.line - 1 + radius);
  const out: string[] = [];
  for (let index = from; index <= to; index += 1) {
    const marker = index === error.line - 1 ? "→ " : "  ";
    out.push(`${marker}${String(index + 1).padStart(3, " ")} | ${lines[index] ?? ""}`);
  }
  return out.join("\n");
}

function escapeString(value: string): string {
  return JSON.stringify(value);
}

function formatValue(ast: JsonAst, indent: number, level: number, minified: boolean): string {
  const pad = minified ? "" : " ".repeat(indent * level);
  const padChild = minified ? "" : " ".repeat(indent * (level + 1));
  const colon = minified ? ":" : ": ";
  switch (ast.kind) {
    case "object": {
      if (ast.entries.length === 0) return "{}";
      if (minified) {
        return `{${ast.entries
          .map((entry) => `${escapeString(entry.key)}:${formatValue(entry.value, indent, level + 1, true)}`)
          .join(",")}}`;
      }
      const body = ast.entries
        .map(
          (entry) =>
            `${padChild}${escapeString(entry.key)}${colon}${formatValue(entry.value, indent, level + 1, false)}`,
        )
        .join(",\n");
      return `{\n${body}\n${pad}}`;
    }
    case "array": {
      if (ast.items.length === 0) return "[]";
      if (minified) {
        return `[${ast.items
          .map((item) => formatValue(item, indent, level + 1, true))
          .join(",")}]`;
      }
      const body = ast.items
        .map((item) => `${padChild}${formatValue(item, indent, level + 1, false)}`)
        .join(",\n");
      return `[\n${body}\n${pad}]`;
    }
    case "string":
      return escapeString(ast.value);
    case "number":
      // 关键：直接输出原始字面量，绝不经过 Number
      return ast.raw;
    case "boolean":
      return ast.value ? "true" : "false";
    case "null":
      return "null";
  }
}

/** 格式化：只改空白，值（含超大数字）逐字节保留。 */
export function formatJson(ast: JsonAst, indent: number): string {
  return formatValue(ast, Math.max(0, Math.min(8, indent)), 0, false);
}

/** 压缩：去掉全部可省略空白。 */
export function minifyJson(ast: JsonAst): string {
  return formatValue(ast, 0, 0, true);
}

function previewOf(ast: JsonAst): string {
  switch (ast.kind) {
    case "object":
      return ast.entries.length === 0 ? "{}" : `{…} ${ast.entries.length} 个键`;
    case "array":
      return ast.items.length === 0 ? "[]" : `[…] ${ast.items.length} 项`;
    case "string": {
      const oneLine = ast.value.replace(/\s+/g, " ");
      return `"${oneLine.length > 48 ? `${oneLine.slice(0, 48)}…` : oneLine}"`;
    }
    case "number":
      return ast.raw;
    case "boolean":
      return ast.value ? "true" : "false";
    case "null":
      return "null";
  }
}

export interface JsonTreeRow {
  id: string;
  depth: number;
  /** 键名或数组下标；根节点为空字符串 */
  label: string;
  /** 值的种类，UI 用来选颜色/是否可展开 */
  kind: JsonAst["kind"];
  preview: string;
  expandable: boolean;
  childCount: number;
  /** 是否命中搜索（UI 高亮） */
  matched: boolean;
}

function childId(parent: string, key: string): string {
  return `${parent}/${encodeURIComponent(key)}`;
}

function nodeMatches(ast: JsonAst, label: string, query: string): boolean {
  if (!query) return false;
  if (label.toLowerCase().includes(query)) return true;
  if (ast.kind === "string" && ast.value.toLowerCase().includes(query)) return true;
  if (ast.kind === "number" && ast.raw.includes(query)) return true;
  if (ast.kind === "boolean" && String(ast.value).includes(query)) return true;
  return false;
}

/**
 * 树形投影：按展开集合把 AST 拉平成列表（便于 FlatList 虚拟化）。
 *
 * 搜索时不再依赖用户手动展开：命中节点的祖先链自动展开，其余兄弟节点隐藏，
 * 这样「搜索字段名」在深层结构里也能一步看到位置，而不是让用户逐层点开。
 */
export function flattenJsonTree(
  ast: JsonAst,
  expanded: ReadonlySet<string>,
  options: { query?: string } = {},
): JsonTreeRow[] {
  const query = (options.query ?? "").trim().toLowerCase();
  const rows: JsonTreeRow[] = [];

  const subtreeMatches = (node: JsonAst, pathId: string, label: string): boolean => {
    if (!query) return true;
    if (nodeMatches(node, label.toLowerCase(), query)) return true;
    if (node.kind === "object") {
      return node.entries.some((entry) =>
        subtreeMatches(entry.value, childId(pathId, entry.key), entry.key),
      );
    }
    if (node.kind === "array") {
      return node.items.some((item, index) =>
        subtreeMatches(item, childId(pathId, String(index)), String(index)),
      );
    }
    return false;
  };

  const visited = new Set<string>();

  const walk = (node: JsonAst, pathId: string, label: string, depth: number): void => {
    if (visited.has(pathId)) return;
    visited.add(pathId);
    if (query && !subtreeMatches(node, pathId, label)) return;

    const expandable =
      (node.kind === "object" && node.entries.length > 0) || (node.kind === "array" && node.items.length > 0);
    const childCount = node.kind === "object" ? node.entries.length : node.kind === "array" ? node.items.length : 0;
    rows.push({
      id: pathId || "root",
      depth,
      label,
      kind: node.kind,
      preview: previewOf(node),
      expandable,
      childCount,
      matched: query.length > 0 && nodeMatches(node, label.toLowerCase(), query),
    });

    // 搜索模式下祖先自动展开；非搜索模式完全尊重用户折叠
    const open = query ? true : expanded.has(pathId) || depth === 0;
    if (!expandable || !open) return;

    if (node.kind === "object") {
      for (const entry of node.entries) {
        walk(entry.value, childId(pathId, entry.key), entry.key, depth + 1);
      }
    } else if (node.kind === "array") {
      node.items.forEach((item, index) => {
        walk(item, childId(pathId, String(index)), String(index), depth + 1);
      });
    }
  };

  walk(ast, "", "root", 0);
  return rows;
}

/** 所有可展开节点的 id（「全部展开」用；受节点上限保护）。 */
export function expandableIds(ast: JsonAst): string[] {
  const ids: string[] = [];
  const visited = new Set<string>();
  const walk = (node: JsonAst, pathId: string, depth: number): void => {
    if (visited.has(pathId) || depth > MAX_JSON_DEPTH) return;
    visited.add(pathId);
    const expandable =
      (node.kind === "object" && node.entries.length > 0) || (node.kind === "array" && node.items.length > 0);
    if (!expandable) return;
    if (pathId) ids.push(pathId);
    if (node.kind === "object") {
      for (const entry of node.entries) walk(entry.value, childId(pathId, entry.key), depth + 1);
    } else if (node.kind === "array") {
      node.items.forEach((item, index) => walk(item, childId(pathId, String(index)), depth + 1));
    }
  };
  walk(ast, "", 0);
  return ids;
}

/** 顶层键数量/节点数摘要，用于结果区标题。 */
export function describeJson(ast: JsonAst): string {
  switch (ast.kind) {
    case "object":
      return `对象 · ${ast.entries.length} 个键`;
    case "array":
      return `数组 · ${ast.items.length} 项`;
    case "string":
      return `字符串 · ${ast.value.length} 字符`;
    case "number":
      return "数字";
    case "boolean":
      return "布尔值";
    case "null":
      return "null";
  }
}
