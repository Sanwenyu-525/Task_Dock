// API 调试的请求模型（纯函数）：URL 组装、校验、敏感 header 脱敏、cURL 导出。
//
// 安全边界（与 docs/mobile/16-dev-tools-network-review.md 对应）：
// - 这里只做字符串处理，**不发送任何请求**；
// - 明文 http 可以编辑，但 `secure=false`，UI 必须据此禁用发送；
// - 保存历史前必须调用 redactDraftForHistory：Authorization/Cookie/X-Api-Key 等
//   只留末 4 位，疑似密钥的 JSON 字段整体省略；请求体里的真实 token 不落库。
//
// 纯函数：不得 import react / react-native / expo / db。

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export interface KeyValueRow {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
}

export type BodyKind = "none" | "json" | "text";

export interface RequestDraft {
  method: HttpMethod;
  url: string;
  query: KeyValueRow[];
  headers: KeyValueRow[];
  body: string;
  bodyKind: BodyKind;
}

let rowSeq = 0;

/** 新行 id：只在本地 UI 用作 React key，不参与存储语义。 */
export function newRowId(prefix = "row"): string {
  rowSeq += 1;
  return `${prefix}_${rowSeq}_${Math.random().toString(36).slice(2, 7)}`;
}

export function newRow(prefix = "row", name = "", value = ""): KeyValueRow {
  return { id: newRowId(prefix), name, value, enabled: true };
}

export function emptyDraft(): RequestDraft {
  return {
    method: "GET",
    url: "",
    query: [],
    headers: [newRow("h", "Accept", "application/json")],
    body: "",
    bodyKind: "none",
  };
}

/** 敏感 header：大小写不敏感、按子串匹配（覆盖 x-api-key / X-Auth-Token 这类变体）。 */
export const SENSITIVE_HEADERS = [
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-xsrf-token",
  "private-key",
  "secret",
  "password",
  "passwd",
  "access-key",
  "token",
];

export function isSensitiveHeader(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  return SENSITIVE_HEADERS.some((keyword) => normalized.includes(keyword));
}

/** 脱敏显示：长度不足 8 时连末 4 位也不留，避免「末 4 位」本身泄漏。 */
export function maskHeaderValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length < 8) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

export function maskSensitiveHeaders(rows: KeyValueRow[]): KeyValueRow[] {
  return rows.map((row) =>
    isSensitiveHeader(row.name) ? { ...row, value: maskHeaderValue(row.value) } : { ...row },
  );
}

const URL_PATTERN = /^(https?):\/\/([^/?#\s]+)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i;

export interface UrlValidationSuccess {
  ok: true;
  url: string;
  /** false = 明文 http；UI 必须禁用发送 */
  secure: boolean;
}

export type UrlValidation = UrlValidationSuccess | { ok: false; message: string };

function splitAuthority(authority: string): { host: string; port: string } | null {
  if (authority.includes("@")) return null; // 不接受 URL 内嵌凭据
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return null;
    const host = authority.slice(1, end);
    const rest = authority.slice(end + 1);
    const port = rest.startsWith(":") ? rest.slice(1) : "";
    if (rest && !rest.startsWith(":")) return null;
    return { host, port };
  }
  const colon = authority.lastIndexOf(":");
  if (colon < 0) return { host: authority, port: "" };
  return { host: authority.slice(0, colon), port: authority.slice(colon + 1) };
}

/**
 * 合并查询参数并校验 URL。
 *
 * 语义（写清楚，避免 UI 猜）：
 * - 只合并 enabled 且 name 非空的行；name 为空的行忽略（value 也一起丢）；
 * - value 为空串时输出 `name=`（保留「显式空值」），不会省略成 `name`；
 * - 已存在同名参数时保留 URL 原参数，新参数追加在后；
 * - 只接受 http/https 绝对地址；拒绝用户名密码、空白、非法端口。
 */
export function buildUrl(input: string, query: KeyValueRow[] = []): UrlValidation {
  const raw = input.trim();
  if (!raw) return { ok: false, message: "请输入 URL" };
  if (/\s/.test(raw)) return { ok: false, message: "URL 不能包含空格，请先做 URL 编码" };

  const match = URL_PATTERN.exec(raw);
  if (!match) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      return { ok: false, message: "只支持 http / https 地址" };
    }
    return { ok: false, message: "URL 需要以 http:// 或 https:// 开头" };
  }
  const scheme = match[1].toLowerCase();
  const authority = splitAuthority(match[2]);
  if (!authority) return { ok: false, message: "URL 不能内嵌用户名或密码（user:pass@）" };
  if (!authority.host) return { ok: false, message: "URL 缺少主机名" };
  if (authority.port) {
    if (!/^\d{1,5}$/.test(authority.port) || Number(authority.port) < 1 || Number(authority.port) > 65535) {
      return { ok: false, message: "端口必须是 1–65535 的数字" };
    }
  }

  const extra = query
    .filter((row) => row.enabled && row.name.trim().length > 0)
    .map((row) => `${encodeURIComponent(row.name.trim())}=${encodeURIComponent(row.value)}`);

  const existing = (match[4] ?? "").trim();
  const merged = [existing, ...extra].filter((part) => part.length > 0).join("&");
  const path = match[3] || "/";
  const url = `${scheme}://${match[2]}${path}${merged ? `?${merged}` : ""}`;
  return { ok: true, url, secure: scheme === "https" };
}

export function validateDraft(draft: RequestDraft): UrlValidation {
  return buildUrl(draft.url, draft.query);
}

function jsonErrorPosition(message: string): { line: number; column: number } | null {
  const match = /position\s+(\d+)/i.exec(message);
  if (!match) return null;
  return { line: 0, column: Number(match[1]) };
}

/** 请求体校验：JSON 模式必须真的 JSON.parse（格式化预览不替代校验）。 */
export function normalizeBody(
  draft: RequestDraft,
):
  | { ok: true; body: string | null; contentType: string | null }
  | { ok: false; message: string } {
  if (draft.method === "GET" || draft.method === "DELETE") {
    return { ok: true, body: null, contentType: null };
  }
  if (draft.bodyKind === "none") return { ok: true, body: null, contentType: null };
  if (draft.bodyKind === "text") {
    return { ok: true, body: draft.body, contentType: "text/plain" };
  }
  if (!draft.body.trim()) return { ok: false, message: "JSON 请求体为空" };
  try {
    JSON.parse(draft.body);
    return { ok: true, body: draft.body, contentType: "application/json" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "JSON 解析失败";
    const position = jsonErrorPosition(message);
    return {
      ok: false,
      message: position
        ? `请求体不是合法 JSON（字符位置约 ${position.column}）`
        : "请求体不是合法 JSON",
    };
  }
}

const REDACTED_BODY = "[已省略：可能包含密钥]";

function containsSensitiveKey(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null) return false;
  if (Array.isArray(value)) return value.some((item) => containsSensitiveKey(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
    const lowered = key.toLowerCase();
    if (
      /token|password|passwd|secret|api-?key|authorization|cookie|credential|private-?key/.test(lowered)
    ) {
      return true;
    }
    return containsSensitiveKey(child, depth + 1);
  });
}

function redactJsonText(text: string): string {
  if (!text.trim()) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    return containsSensitiveKey(parsed) ? REDACTED_BODY : text;
  } catch {
    // 不是 JSON 就按普通文本保留；是否敏感由用户自己判断，这里不猜测正文内容。
    return text;
  }
}

/**
 * 写入历史/收藏前的脱敏副本。必须返回新对象，不修改入参。
 * - 敏感 header：值替换为 maskHeaderValue；
 * - 敏感 query：同样脱敏（例如 ?token=…）；
 * - JSON body 命中疑似密钥字段：整体替换为占位文本，避免半截 token 仍能复原。
 */
export function redactDraftForHistory(draft: RequestDraft): RequestDraft {
  return {
    ...draft,
    query: draft.query.map((row) =>
      isSensitiveHeader(row.name) ? { ...row, value: maskHeaderValue(row.value) } : { ...row },
    ),
    headers: maskSensitiveHeaders(draft.headers),
    body: draft.bodyKind === "json" ? redactJsonText(draft.body) : draft.body,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 导出为 cURL（真实值，供用户主动复制到电脑执行）。 */
export function toCurl(draft: RequestDraft): string {
  const validated = validateDraft(draft);
  const target = validated.ok ? validated.url : draft.url;
  const parts = [`curl -X ${draft.method}`, shellQuote(target)];
  for (const header of draft.headers) {
    if (!header.enabled || !header.name.trim()) continue;
    parts.push(`-H ${shellQuote(`${header.name.trim()}: ${header.value}`)}`);
  }
  if (draft.method !== "GET" && draft.method !== "DELETE" && draft.bodyKind !== "none" && draft.body) {
    parts.push(`--data-raw ${shellQuote(draft.body)}`);
  }
  return parts.join(" \\\n  ");
}

/** 历史列表副标题：只保留方法 + 主机 + 路径，绝不带 query/header 值。 */
export function summarizeDraft(draft: RequestDraft): string {
  const validated = validateDraft(draft);
  if (!validated.ok) return `${draft.method} ${draft.url || "（未填写 URL）"}`;
  const match = URL_PATTERN.exec(validated.url);
  if (!match) return `${draft.method} ${draft.url}`;
  return `${draft.method} ${match[2]}${match[3] || "/"}`;
}

/** 请求体是否为可格式化的 JSON（UI 用来决定「格式化」按钮是否可用）。 */
export function isJsonBody(text: string): boolean {
  if (!text.trim()) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** 深拷贝草稿：React 状态更新时避免共享行对象。 */
export function cloneDraft(draft: RequestDraft): RequestDraft {
  return {
    ...draft,
    query: draft.query.map((row) => ({ ...row })),
    headers: draft.headers.map((row) => ({ ...row })),
  };
}
