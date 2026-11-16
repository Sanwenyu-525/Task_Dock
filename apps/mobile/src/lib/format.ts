// 通用时间展示：只做「本地时间的年月日时分」，不参与计算、不做时区换算。
// 工具页的历史 / 最近使用只需要稳定、可读的一行，避免各页面自己拼日期出现格式不一致。
export function formatDateTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** 只要日期：用于列表里空间很窄的行。 */
export function formatDate(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
