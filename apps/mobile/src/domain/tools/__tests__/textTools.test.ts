// 文本/接口工具纯函数测试：JSON 保真与错误定位、秒/毫秒换算、编码往返、cURL 导入。
// 这些用例不依赖 React Native 运行时，全部在 Node 下执行。
import { describe, expect, it } from "vitest";

import {
  formatJson,
  isUnsafeNumberLiteral,
  minifyJson,
  parseJson,
  flattenJsonTree,
} from "../jsonTools";
import {
  decodeBase64,
  decodeUnicodeEscapes,
  decodeUrl,
  describeText,
  encodeBase64,
  encodeUnicodeEscapes,
  encodeUrl,
  convertNewlines,
} from "../textCodec";
import { formatEpoch, parseDateInput, parseTimestampInput } from "../timestamp";
import { parseCurl } from "../curl";
import { emptyDraft, maskSensitiveHeaders, newRow, toCurl, validateDraft } from "../apiRequest";

describe("JSON：保真解析与格式化", () => {
  it("超过安全整数范围的数字在格式化后保持原字面量", () => {
    const parsed = parseJson('{"id":1234567890123456789}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(formatJson(parsed.ast, 2)).toContain("1234567890123456789");
    expect(minifyJson(parsed.ast)).toBe('{"id":1234567890123456789}');
    expect(isUnsafeNumberLiteral("1234567890123456789")).toBe(true);
    expect(isUnsafeNumberLiteral("123")).toBe(false);
  });

  it("非法 JSON 返回可定位的行列与上下文", () => {
    const parsed = parseJson('{\n  "a": 1,\n  "b": ,\n}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.line).toBe(3);
    expect(parsed.error.column).toBeGreaterThan(1);
    expect(parsed.error.message.length).toBeGreaterThan(0);
  });

  it("重复键给出告警但保留原始键顺序", () => {
    const parsed = parseJson('{"a":1,"a":2,"b":3}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings.join(" ")).toContain("重复");
    expect(parsed.ast.kind).toBe("object");
  });

  it("树形投影按展开路径生成行并支持字段搜索", () => {
    const parsed = parseJson('{"user":{"name":"dock","roles":["a","b"]}}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rows = flattenJsonTree(parsed.ast, new Set([""]), { query: "name" });
    expect(rows.some((row) => row.label.includes("name"))).toBe(true);
  });
});

describe("时间戳：显式单位与日期校验", () => {
  it("秒与毫秒分别乘以 / 保持原值，不做位数猜测", () => {
    const seconds = parseTimestampInput("1700000000", "seconds");
    expect(seconds.ok && seconds.epochMs).toBe(1_700_000_000_000);
    const milliseconds = parseTimestampInput("1700000000000", "milliseconds");
    expect(milliseconds.ok && milliseconds.epochMs).toBe(1_700_000_000_000);
  });

  it("自动识别返回实际单位并给出说明", () => {
    const parsed = parseTimestampInput("1700000000000", "auto");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.unit).toBe("milliseconds");
    expect(parsed.note).toBeTruthy();
  });

  it("ISO 8601 带时区按绝对时间解析，不带时区按 UTC 解释", () => {
    const zoned = parseDateInput("2026-11-16T08:30:00Z", "utc");
    expect(zoned.ok && zoned.epochMs).toBe(Date.UTC(2026, 10, 16, 8, 30, 0));
    const plainUtc = parseDateInput("2026-11-16 08:30", "utc");
    expect(plainUtc.ok && plainUtc.epochMs).toBe(Date.UTC(2026, 10, 16, 8, 30, 0));
  });

  it("非法日期明确报错而不是被 Date 悄悄顺延", () => {
    const parsed = parseDateInput("2026-02-30", "utc");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("2 月");
  });

  it("UTC 格式化与秒/毫秒展示一致", () => {
    const display = formatEpoch(1_700_000_000_000, "utc");
    expect(display.seconds).toBe("1700000000");
    expect(display.milliseconds).toBe("1700000000000");
    expect(display.dateTime).toBe("2023-11-14 22:13:20");
  });
});

describe("文本编解码：UTF-8 与非法输入", () => {
  it("URL 编码支持空格与加号语义切换", () => {
    const encoded = encodeUrl("a b+c/d");
    expect(encoded.ok && encoded.text).toBe("a%20b%2Bc%2Fd");
    expect(decodeUrl("a+b", { plusAsSpace: true }).ok).toBe(true);
    expect(decodeUrl("a+b", { plusAsSpace: true })).toEqual({ ok: true, text: "a b" });
    expect(decodeUrl("%E0%A4%A").ok).toBe(false);
  });

  it("Base64 对中文与 emoji 往返一致，非法输入报错", () => {
    const encoded = encodeBase64("你好🙂");
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeBase64(encoded.text);
    expect(decoded.ok && decoded.text).toBe("你好🙂");
    expect(decodeBase64("!!!!").ok).toBe(false);
  });

  it("Unicode 转义与换行转换可用于一次性文本处理", () => {
    const escaped = encodeUnicodeEscapes("A中", { escapeAscii: false });
    expect(escaped.ok && escaped.text).toBe("A\\u4E2D");
    expect(decodeUnicodeEscapes("A\\u4e2d")).toEqual({ ok: true, text: "A中" });
    expect(convertNewlines("a\nb\rc", "crlf")).toBe("a\r\nb\r\nc");
    expect(describeText("a\nb").lines).toBe(2);
  });
});

describe("cURL 导入与请求校验", () => {
  it("解析 POST 的 URL、Header 与 JSON 请求体", () => {
    const parsed = parseCurl(
      "curl -X POST 'https://api.example.com/v1/items?page=1' -H 'Content-Type: application/json' -H 'Authorization: Bearer t' -d '{\"name\":\"dock\"}'",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.draft.method).toBe("POST");
    expect(parsed.draft.url).toContain("https://api.example.com/v1/items");
    expect(parsed.draft.headers.some((row) => row.name === "Authorization")).toBe(true);
    expect(parsed.draft.body).toContain("dock");
  });

  it("拒绝表单上传与证书绕过标记，避免误把危险参数带进请求", () => {
    expect(parseCurl("curl -F 'file=@a.png' https://example.com/upload").ok).toBe(false);
    const insecure = parseCurl("curl -k https://example.com");
    expect(insecure.ok).toBe(true);
    if (!insecure.ok) return;
    expect(insecure.warnings.length).toBeGreaterThan(0);
  });

  it("敏感 Header 脱敏且请求导出保留方法与 URL", () => {
    const rows = maskSensitiveHeaders([
      { ...newRow("header"), name: "Authorization", value: "Bearer secret-token" },
      { ...newRow("header"), name: "Accept", value: "application/json" },
    ]);
    expect(rows[0].value).not.toContain("secret-token");
    expect(rows[1].value).toBe("application/json");

    const draft = emptyDraft();
    draft.url = "https://example.com/api";
    const curl = toCurl(draft);
    expect(curl).toContain("curl");
    expect(curl).toContain("https://example.com/api");
    expect(validateDraft(draft).ok).toBe(true);
    const http = validateDraft({ ...draft, url: "http://example.com" });
    expect(http.ok).toBe(true);
    if (!http.ok) return;
    expect(http.secure).toBe(false);
  });
});
