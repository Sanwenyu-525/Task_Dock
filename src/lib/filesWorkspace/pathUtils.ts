//! 路径工具（Windows 优先；不访问文件系统，纯字符串操作）。

/** 目录分隔符规范化：反斜杠统一、去尾部分隔符（盘符根除外）。 */
export function normalizePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let p = trimmed.replace(/\//g, "\\");
  const isRoot = /^[a-zA-Z]:\\?$/.test(p) || p === "\\\\";
  if (!isRoot) p = p.replace(/\\+$/, "");
  return p;
}

/** 取末段目录/文件名；根目录返回盘符形式。 */
export function basename(raw: string): string {
  const p = normalizePath(raw);
  if (!p) return "";
  if (/^[a-zA-Z]:\\?$/.test(p)) return `${p[0].toUpperCase()}:盘`;
  const parts = p.split("\\").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** 父目录；根目录返回 null（不能向上）。 */
export function parentOf(raw: string): string | null {
  const p = normalizePath(raw);
  if (!p) return null;
  if (/^[a-zA-Z]:\\?$/.test(p)) return null;
  const idx = p.lastIndexOf("\\");
  if (idx <= 0) return null;
  const parent = p.slice(0, idx);
  // "C:" → "C:\"
  if (/^[a-zA-Z]:$/.test(parent)) return `${parent}\\`;
  return parent || null;
}

/** 拼接子路径（不访问文件系统；name 必须是单分量）。 */
export function joinPath(parent: string, name: string): string {
  const p = normalizePath(parent);
  if (!p) return name;
  if (/\\$/.test(p)) return `${p}${name}`;
  return `${p}\\${name}`;
}

/** Windows 路径相等（大小写不敏感、分隔符规范化）。 */
export function samePath(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

/** inner 是否位于 outer 之内（严格子路径）。 */
export function isSubPath(outer: string, inner: string): boolean {
  const o = normalizePath(outer).toLowerCase();
  const i = normalizePath(inner).toLowerCase();
  return i.startsWith(`${o}\\`);
}

/** 面包屑分段：[{ name, path }]；根目录至少一段。 */
export function breadcrumbSegments(raw: string): Array<{ name: string; path: string }> {
  const p = normalizePath(raw);
  if (!p) return [];
  const out: Array<{ name: string; path: string }> = [];
  if (p.startsWith("\\\\")) {
    // UNC：\\server\share\...
    const parts = p.split("\\").filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}\\${part}` : `\\\\${part}`;
      out.push({ name: part, path: acc });
    }
    return out;
  }
  const driveMatch = /^([a-zA-Z]):(.*)$/.exec(p);
  if (!driveMatch) return [{ name: p, path: p }];
  out.push({ name: `${driveMatch[1].toUpperCase()}:盘`, path: `${driveMatch[1]}:\\` });
  const rest = driveMatch[2];
  if (rest) {
    let acc = `${driveMatch[1]}:\\`;
    for (const part of rest.split("\\").filter(Boolean)) {
      acc = `${acc}${part}\\`;
      out.push({ name: part, path: acc });
    }
  }
  return out;
}
