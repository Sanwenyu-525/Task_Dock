//! JSON 结构解析（纯函数）：把文本变成可折叠树的节点模型。
//!
//! 只调用 `JSON.parse` + 一次遍历，不读盘、不渲染、不做 HTML 注入：
//! - 解析失败保留解析器消息与位置，UI 据此回退源码模式（不假装「树」还在）；
//! - 预算：字符上限 → 节点上限 → 子项上限 → 层级上限，超限打 `truncated`；
//! - 标量只生成短预览文本（字符串带引号、超长截断），完整内容仍在源码视图里。

export const JSON_MAX_CHARS = 2_000_000;
export const JSON_MAX_NODES = 3000;
export const JSON_MAX_CHILDREN = 200;
export const JSON_MAX_DEPTH = 64;
export const JSON_MAX_LEAF_CHARS = 300;

export type JsonNodeKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface JsonNode {
  kind: JsonNodeKind;
  /** 对象属性名；数组为 `[i]`；根为 null。 */
  key: string | null;
  /** 标量展示文本（字符串含引号、已截断）；容器为空串。 */
  preview: string;
  /** 容器子节点；标量为 null。 */
  children: JsonNode[] | null;
  /** 容器真实子项数（裁剪前）。 */
  size: number;
  /** 子项因节点/子项预算被裁剪。 */
  truncated: boolean;
  /** 1 基层级（根为 1）。 */
  depth: number;
}

export interface JsonParseError {
  code: "empty" | "invalid" | "too-large";
  /** 解析器原始消息（不本地化，UI 按 code 显示文案）。 */
  message: string;
  /** 字符偏移（1 基；未知为 0）。 */
  position: number;
  /** 行号 / 列号（1 基；未知为 0）。 */
  line: number;
  column: number;
}

export interface JsonDocument {
  ok: boolean;
  root: JsonNode | null;
  error: JsonParseError | null;
  /** 生成节点数（受 `JSON_MAX_NODES` 限制）。 */
  nodes: number;
  /** 实际生成的最大层级。 */
  depth: number;
  /** 因预算裁剪（节点/子项/层级）。 */
  truncated: boolean;
}

function matchNumber(text: string, pattern: RegExp): number {
  const found = pattern.exec(text);
  if (!found) return 0;
  const value = Number(found[1]);
  return Number.isFinite(value) ? value : 0;
}

export function describeJsonError(cause: unknown): JsonParseError {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const message = raw.replace(/^SyntaxError:\s*/i, "").trim();
  return {
    code: "invalid",
    message: message || "invalid JSON",
    position: matchNumber(message, /position\s+(\d+)/i),
    line: matchNumber(message, /line\s+(\d+)/i),
    column: matchNumber(message, /column\s+(\d+)/i),
  };
}

function leafPreview(value: string | number | boolean): string {
  const text =
    typeof value === "string" ? JSON.stringify(value) : typeof value === "boolean" ? String(value) : String(value);
  if (text.length <= JSON_MAX_LEAF_CHARS) return text;
  return `${text.slice(0, JSON_MAX_LEAF_CHARS)}…`;
}

function kindOf(value: unknown): JsonNodeKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object":
      return "object";
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "null";
  }
}

/**
 * 解析 JSON 文本并生成树节点。
 * - `ok: false` 时不返回半成品树，UI 一律回退源码视图；
 * - 节点按对象键顺序（`Object.keys`）与数组下标顺序展开。
 */
export function buildJsonTree(text: string): JsonDocument {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!source.trim()) {
    return {
      ok: false,
      root: null,
      error: { code: "empty", message: "", position: 0, line: 0, column: 0 },
      nodes: 0,
      depth: 0,
      truncated: false,
    };
  }
  if (source.length > JSON_MAX_CHARS) {
    return {
      ok: false,
      root: null,
      error: { code: "too-large", message: "", position: 0, line: 0, column: 0 },
      nodes: 0,
      depth: 0,
      truncated: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    return {
      ok: false,
      root: null,
      error: describeJsonError(cause),
      nodes: 0,
      depth: 0,
      truncated: false,
    };
  }

  let nodes = 0;
  let depth = 0;
  let truncated = false;

  const build = (key: string | null, value: unknown, level: number): JsonNode | null => {
    if (nodes >= JSON_MAX_NODES) {
      truncated = true;
      return null;
    }
    nodes += 1;
    if (level > depth) depth = level;

    const kind = kindOf(value);
    if (kind === "array" && Array.isArray(value)) {
      const children: JsonNode[] = [];
      let childTruncated = false;
      for (let i = 0; i < value.length; i += 1) {
        if (children.length >= JSON_MAX_CHILDREN || level >= JSON_MAX_DEPTH) {
          childTruncated = true;
          break;
        }
        const child = build(`[${i}]`, value[i], level + 1);
        if (!child) {
          childTruncated = true;
          break;
        }
        children.push(child);
      }
      if (childTruncated) truncated = true;
      return { kind, key, preview: "", children, size: value.length, truncated: childTruncated, depth: level };
    }

    if (kind === "object") {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      const children: JsonNode[] = [];
      let childTruncated = false;
      for (const childKey of keys) {
        if (children.length >= JSON_MAX_CHILDREN || level >= JSON_MAX_DEPTH) {
          childTruncated = true;
          break;
        }
        const child = build(childKey, record[childKey], level + 1);
        if (!child) {
          childTruncated = true;
          break;
        }
        children.push(child);
      }
      if (childTruncated) truncated = true;
      return { kind, key, preview: "", children, size: keys.length, truncated: childTruncated, depth: level };
    }

    if (kind === "null") {
      return { kind, key, preview: "null", children: null, size: 0, truncated: false, depth: level };
    }
    const scalar = value as string | number | boolean;
    return { kind, key, preview: leafPreview(scalar), children: null, size: 0, truncated: false, depth: level };
  };

  const root = build(null, parsed, 1);
  return { ok: root !== null, root, error: null, nodes, depth, truncated };
}

/** 全部容器节点的路径（供「展开全部」使用，顺序即渲染顺序）。 */
export function collectContainerPaths(root: JsonNode | null): string[] {
  if (!root) return [];
  const paths: string[] = [];
  const visit = (node: JsonNode, path: string) => {
    if (node.children && node.children.length > 0) paths.push(path);
    node.children?.forEach((child, index) => visit(child, `${path}/${index}`));
  };
  visit(root, "root");
  return paths;
}
