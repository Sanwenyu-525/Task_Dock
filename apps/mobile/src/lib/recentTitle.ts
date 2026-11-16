// 「最近内容」标题展示层解码：数据层偶尔把 content:// URI 的冒号写成 %3A，
// 这里只处理明确的百分号编码；不改数据库原始标题，也不影响正常中文/英文/自定义标题。

export const RECENT_TITLE_MAX_LENGTH = 48;

export function decodeRecentTitle(raw: string): string {
  if (!raw) return raw;
  if (!/%[0-9A-Fa-f]{2}/.test(raw)) {
    return raw.length > RECENT_TITLE_MAX_LENGTH
      ? raw.slice(0, RECENT_TITLE_MAX_LENGTH)
      : raw;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // 非法转义（如单个 %、截断的多字节序列）原样保留，不能把标题解成空白。
    return raw.length > RECENT_TITLE_MAX_LENGTH
      ? raw.slice(0, RECENT_TITLE_MAX_LENGTH)
      : raw;
  }
  return decoded.length > RECENT_TITLE_MAX_LENGTH
    ? decoded.slice(0, RECENT_TITLE_MAX_LENGTH)
    : decoded;
}
