// cURL 导入（纯函数）：把用户从电脑/文档里复制来的常见 curl 命令还原成请求草稿。
//
// 边界：
// - 只做解析与建模，不执行、不联网；
// - 支持 GET/POST/PUT/PATCH/DELETE、-H、-d、--json、-G、-u、-A、-b 等常见参数；
// - multipart（-F/--form）、上传（-T）、代理、cookie 文件、证书文件不猜测语义，
//   直接返回失败并说明原因，避免「看起来导入了，实际请求体丢了」；
// - -k/--insecure 必须显式提示「已忽略，不会跳过证书校验」——这是产品底线，不是 warning 堆里的一行。
//
// 纯函数：不得 import react / react-native / expo / db。

import {
  type BodyKind,
  type HttpMethod,
  type KeyValueRow,
  type RequestDraft,
  HTTP_METHODS,
  newRow,
  validateDraft,
} from "./apiRequest";

export interface CurlParseSuccess {
  ok: true;
  draft: RequestDraft;
  warnings: string[];
}

export type CurlParseResult = CurlParseSuccess | { ok: false; message: string };

interface TokenizeResult {
  tokens: string[];
  error?: string;
}

/**
 * Shell 风格分词。只支持 curl 命令里真实出现的写法：
 * 单引号（内部不转义）、双引号（支持 \" \\ \$ \` 与续行）、反斜杠续行、行内空白。
 */
export function tokenizeCurl(command: string): TokenizeResult {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;

  const push = (): void => {
    if (!started) return;
    tokens.push(current);
    current = "";
    started = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === "\\") {
        const next = command[index + 1];
        if (next === "\n") {
          index += 1;
          continue;
        }
        if (next === "\r" && command[index + 2] === "\n") {
          index += 2;
          continue;
        }
        if (next !== undefined && ['"', "\\", "$", "`", "\n"].includes(next)) {
          current += next;
          index += 1;
          continue;
        }
        current += char;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      const next = command[index + 1];
      if (next === "\n") {
        index += 1;
        continue;
      }
      if (next === "\r" && command[index + 2] === "\n") {
        index += 2;
        continue;
      }
      if (next !== undefined) {
        current += next;
        index += 1;
        started = true;
        continue;
      }
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    current += char;
    started = true;
  }

  if (quote) return { tokens, error: quote === "'" ? "单引号没有闭合" : "双引号没有闭合" };
  push();
  return { tokens };
}

function splitHeader(value: string): { name: string; value: string } | null {
  const colon = value.indexOf(":");
  if (colon <= 0) return null;
  return { name: value.slice(0, colon).trim(), value: value.slice(colon + 1).trim() };
}

function base64(text: string): string {
  // 只用于 -u user:pass 的 Basic 头；纯 ASCII 场景足够。非 ASCII 由 UTF-8 编码后处理。
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index];
    const b1 = bytes[index + 1] ?? 0;
    const b2 = bytes[index + 2] ?? 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += alphabet[(triple >> 18) & 0x3f];
    out += alphabet[(triple >> 12) & 0x3f];
    out += index + 1 < bytes.length ? alphabet[(triple >> 6) & 0x3f] : "=";
    out += index + 2 < bytes.length ? alphabet[triple & 0x3f] : "=";
  }
  return out;
}

const FLAGS_WITH_VALUE = new Set([
  "-X",
  "--request",
  "-H",
  "--header",
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-ascii",
  "--data-urlencode",
  "--url",
  "-u",
  "--user",
  "-A",
  "--user-agent",
  "-b",
  "--cookie",
  "-e",
  "--referer",
  "-m",
  "--max-time",
  "--connect-timeout",
  "-o",
  "--output",
  "-x",
  "--proxy",
  "--cacert",
  "--cert",
  "--key",
  "-c",
  "--cookie-jar",
  "-F",
  "--form",
  "-T",
  "--upload-file",
]);

const UNSUPPORTED = new Set([
  "-F",
  "--form",
  "-T",
  "--upload-file",
  "-x",
  "--proxy",
  "--cacert",
  "--cert",
  "--key",
  "-c",
  "--cookie-jar",
]);

/** `--flag=value` 拆开；短选项不做合并（curl 里 `-XPOST` 也存在，单独处理）。 */
function splitFlag(token: string): { flag: string; value?: string } {
  if (token.startsWith("--")) {
    const eq = token.indexOf("=");
    if (eq > 0) return { flag: token.slice(0, eq), value: token.slice(eq + 1) };
    return { flag: token };
  }
  if (token.length === 2 || token.startsWith("--")) return { flag: token };
  // 形如 -XPOST / -H'Name: v'（引号分词后不会粘连，这里只覆盖 -XPOST 这类）
  if (token.length > 2 && token[0] === "-" && !token.startsWith("--")) {
    return { flag: token.slice(0, 2), value: token.slice(2) };
  }
  return { flag: token };
}

/**
 * 解析 curl。默认方法规则与 curl 一致：
 * - 有 -d / --json 且未显式 -X → POST；
 * - 只有 -G 把数据放 query，方法仍为 GET；
 * - 其余 → GET。非 GET 的请求体按 JSON/文本自动判定（能 JSON.parse 就是 json）。
 */
export function parseCurl(command: string): CurlParseResult {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, message: "请粘贴 curl 命令" };
  const cleaned = trimmed.replace(/^[$#>]\s+/, "");
  const tokenized = tokenizeCurl(cleaned);
  if (tokenized.error) return { ok: false, message: `命令无法解析：${tokenized.error}` };
  const tokens = tokenized.tokens;
  if (tokens.length === 0) return { ok: false, message: "请粘贴 curl 命令" };
  if (!/^\s*(?:curl|curl\.exe)$/i.test(tokens[0])) {
    return { ok: false, message: "命令需要以 curl 开头" };
  }

  const warnings: string[] = [];
  let method: HttpMethod | null = null;
  const headers: KeyValueRow[] = [];
  const dataParts: string[] = [];
  let url = "";
  let useGet = false;
  let jsonMode = false;
  let bodyKindOverride: BodyKind | null = null;

  const unsupported: string[] = [];

  for (let index = 1; index < tokens.length; index += 1) {
    const raw = tokens[index];
    if (!raw) continue;
    const { flag, value: inline } = splitFlag(raw);

    if (!flag.startsWith("-")) {
      if (!url) url = raw;
      else warnings.push(`忽略了多余的位置参数「${raw}」`);
      continue;
    }

    if (UNSUPPORTED.has(flag)) {
      unsupported.push(flag);
      // 跳过它的值，避免把值误当 URL
      if (inline === undefined && index + 1 < tokens.length && !tokens[index + 1].startsWith("-")) {
        index += 1;
      }
      continue;
    }

    const readValue = (): string | null => {
      if (inline !== undefined) return inline;
      if (index + 1 < tokens.length) {
        index += 1;
        return tokens[index];
      }
      return null;
    };

    switch (flag) {
      case "-X":
      case "--request": {
        const value = readValue();
        if (!value) return { ok: false, message: `${flag} 缺少方法名` };
        const upper = value.toUpperCase();
        if (!HTTP_METHODS.includes(upper as HttpMethod)) {
          return {
            ok: false,
            message: `不支持方法 ${value}；当前支持 ${HTTP_METHODS.join(" / ")}`,
          };
        }
        method = upper as HttpMethod;
        break;
      }
      case "-H":
      case "--header": {
        const value = readValue();
        if (!value) return { ok: false, message: `${flag} 缺少 header 内容` };
        const parsed = splitHeader(value);
        if (!parsed) {
          warnings.push(`忽略了无法识别的 header「${value.slice(0, 40)}」`);
          break;
        }
        headers.push(newRow("h", parsed.name, parsed.value));
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii": {
        const value = readValue();
        if (value === null) return { ok: false, message: `${flag} 缺少请求体` };
        if (value.startsWith("@")) {
          return { ok: false, message: `${flag} @文件 形式需要读取本地文件，手机端请改为直接把内容粘贴到请求体` };
        }
        dataParts.push(value);
        break;
      }
      case "--data-urlencode": {
        const value = readValue();
        if (value === null) return { ok: false, message: "--data-urlencode 缺少内容" };
        dataParts.push(value);
        warnings.push("--data-urlencode 的内容按原样保留，未再次编码");
        break;
      }
      case "--json": {
        const value = readValue();
        if (value === null) return { ok: false, message: "--json 缺少 JSON 内容" };
        if (value.startsWith("@")) {
          return { ok: false, message: "--json @文件 形式需要读取本地文件，手机端请直接粘贴 JSON" };
        }
        dataParts.push(value);
        jsonMode = true;
        break;
      }
      case "-G":
      case "--get":
        useGet = true;
        break;
      case "--url": {
        const value = readValue();
        if (!value) return { ok: false, message: "--url 缺少地址" };
        url = value;
        break;
      }
      case "-u":
      case "--user": {
        const value = readValue();
        if (!value) return { ok: false, message: `${flag} 缺少 user:password` };
        headers.push(newRow("h", "Authorization", `Basic ${base64(value)}`));
        warnings.push("已把 -u 凭据转换为 Authorization 头；该值保存历史时会被脱敏");
        break;
      }
      case "-A":
      case "--user-agent": {
        const value = readValue();
        if (!value) return { ok: false, message: `${flag} 缺少值` };
        headers.push(newRow("h", "User-Agent", value));
        break;
      }
      case "-b":
      case "--cookie": {
        const value = readValue();
        if (!value) return { ok: false, message: `${flag} 缺少 cookie` };
        if (value.startsWith("@") || value.includes("=") === false) {
          warnings.push("--cookie 文件形式不支持，请把 Cookie 值直接粘贴为 Cookie 头");
          break;
        }
        headers.push(newRow("h", "Cookie", value));
        break;
      }
      case "-e":
      case "--referer": {
        const value = readValue();
        if (value) headers.push(newRow("h", "Referer", value));
        break;
      }
      case "-m":
      case "--max-time":
      case "--connect-timeout": {
        const value = readValue();
        if (value) warnings.push(`已忽略超时参数（${flag} ${value}）：发送功能由本工具的固定上限控制`);
        break;
      }
      case "-o":
      case "--output": {
        const value = readValue();
        if (value) warnings.push(`已忽略输出文件参数「${value}」：手机端不落盘`);
        break;
      }
      case "-k":
      case "--insecure":
        warnings.push("已忽略 -k/--insecure：本工具不会跳过 HTTPS 证书校验");
        break;
      case "-L":
      case "--location":
        warnings.push("已忽略 -L：是否跟随重定向需要独立安全审查，默认不跟随");
        break;
      case "--compressed":
        warnings.push("已忽略 --compressed：手机端由传输层处理压缩");
        break;
      case "-s":
      case "--silent":
      case "-S":
      case "--show-error":
      case "-i":
      case "--include":
      case "-v":
      case "--verbose":
        break;
      default:
        if (FLAGS_WITH_VALUE.has(flag)) {
          const value = readValue();
          warnings.push(`忽略了参数 ${flag}${value ? ` ${value}` : ""}`);
        } else {
          warnings.push(`忽略了未知参数「${flag}」`);
        }
        break;
    }
  }

  if (unsupported.length > 0) {
    return {
      ok: false,
      message: `暂不支持 ${unsupported.join(" / ")}（multipart、上传、代理或证书文件）。请改用 -H + -d 的普通请求`,
    };
  }
  if (!url) return { ok: false, message: "没有找到请求 URL（可以用 --url 显式指定）" };

  const data = dataParts.join("&");
  let resolvedMethod: HttpMethod = method ?? (data.length > 0 ? "POST" : "GET");
  if (method === null && useGet) resolvedMethod = "GET";

  let finalUrl = url;
  if (useGet && data.length > 0) {
    finalUrl = `${url}${url.includes("?") ? "&" : "?"}${data}`;
    bodyKindOverride = "none";
  }

  if (jsonMode) {
    bodyKindOverride = "json";
    if (!headers.some((header) => header.name.toLowerCase() === "content-type")) {
      headers.push(newRow("h", "Content-Type", "application/json"));
    }
  }

  const draft: RequestDraft = {
    method: resolvedMethod,
    url: finalUrl,
    query: [],
    headers,
    body: useGet ? "" : data,
    bodyKind: bodyKindOverride ?? (data ? (looksLikeJson(data) ? "json" : "text") : "none"),
  };

  const validated = validateDraft(draft);
  if (!validated.ok) return { ok: false, message: validated.message };
  if (!validated.secure) warnings.push("这是明文 http 地址：可以编辑与导出，但发送会被安全策略禁用");

  return { ok: true, draft, warnings };
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}
