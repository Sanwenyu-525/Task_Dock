//! CSV / TSV 表格解析（纯函数）。
//!
//! 只做「文本 → 表格结构」，不读盘、不碰 DOM，也不改用户的文件：
//! - RFC 4180 口径：引号只在**字段起始**处生效，`""` 表示一个引号字符，
//!   引号内允许分隔符与换行（多行单元格）；
//! - 分隔符嗅探：`.tsv` 固定 Tab，其余按前若干字符统计引号外的出现次数；
//! - 预算：字符上限 → 记录上限 → 行上限 → 列上限 → 单元格上限，逐级降级并
//!   在结果里标记 `*Truncated`，UI 据此提示「只显示前 N 行」，绝不悄悄丢数据；
//! - 表头是**启发式**（首行全非空且不全为数字），UI 必须提供手动切换。

export const CSV_MAX_CHARS = 2_000_000;
export const CSV_MAX_ROWS = 2000;
export const CSV_MAX_COLS = 120;
export const CSV_MAX_CELL_CHARS = 400;
/** 嗅探分隔符时最多检查的字符数。 */
export const CSV_SNIFF_CHARS = 4096;

const PARSE_RECORDS = CSV_MAX_ROWS + 2;

export type CsvDelimiter = "," | ";" | "\t" | "|";

export const CSV_DELIMITERS: readonly CsvDelimiter[] = [",", ";", "\t", "|"];

export interface CsvTable {
  delimiter: CsvDelimiter;
  /** 表头行：`headerDetected` 为 false 时是空数组。 */
  header: string[];
  rows: string[][];
  /** 列数（表头与数据行的最大值，已受列预算限制）。 */
  columnCount: number;
  /** 首行是否按表头渲染（启发式结果，调用方可再覆盖）。 */
  headerDetected: boolean;
  /** 存在超过单元格上限、被截断的内容。 */
  cellTruncated: boolean;
  /** 达到行上限：`rows` 只保留前 `CSV_MAX_ROWS` 行。 */
  rowsTruncated: boolean;
  /** 达到列上限：超出的列被丢弃。 */
  colsTruncated: boolean;
  /** 达到字符上限：只解析了文件前缀。 */
  charsTruncated: boolean;
  /** 有效数据行数（不含表头，受行上限限制）。 */
  rowCount: number;
  /** 空文件或只有空行。 */
  empty: boolean;
}

export interface CsvParseOptions {
  /** 不传则由 `ext` + 内容嗅探决定。 */
  delimiter?: CsvDelimiter;
  /** 文件名后缀（用于 `.tsv` 固定 Tab）。 */
  ext?: string;
  /** `auto`（默认）按启发式；`true` / `false` 强制。 */
  header?: boolean | "auto";
}

function isNumericCell(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed);
}

/** 表头启发式：首行全非空且不全为数字。调用方可用手动开关纠正。 */
export function looksLikeHeaderRow(record: readonly string[] | undefined): boolean {
  if (!record || record.length === 0) return false;
  if (record.every((cell) => cell.trim() === "")) return false;
  return !record.every(isNumericCell);
}

function countOutsideQuotes(sample: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < sample.length; i += 1) {
    const ch = sample[i];
    if (ch === '"') {
      if (inQuotes && sample[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === delimiter) count += 1;
  }
  return count;
}

/** 分隔符嗅探：`.tsv` 固定 Tab；其余取引号外出现最多的候选，平手优先逗号。 */
export function sniffCsvDelimiter(text: string, ext = ""): CsvDelimiter {
  if (ext.toLowerCase() === "tsv") return "\t";
  const sample = text.length > CSV_SNIFF_CHARS ? text.slice(0, CSV_SNIFF_CHARS) : text;
  let best: CsvDelimiter = ",";
  let bestCount = 0;
  for (const candidate of CSV_DELIMITERS) {
    const count = countOutsideQuotes(sample, candidate);
    // 严格大于：逗号在最前面，平手时保留逗号。
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : ",";
}

function hasContentFrom(text: string, start: number): boolean {
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== " " && ch !== "\t" && ch !== "\r" && ch !== "\n") return true;
  }
  return false;
}

/**
 * 解析分隔文本。返回结构只包含「能安全渲染」的部分，所有降级都带标记。
 * 空文本返回 `empty: true` 的空表格，调用方直接显示空态。
 */
export function parseCsvText(text: string, options: CsvParseOptions = {}): CsvTable {
  const ext = options.ext ?? "";
  const delimiter = options.delimiter ?? sniffCsvDelimiter(text, ext);
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const charsTruncated = source.length > CSV_MAX_CHARS;
  const limited = charsTruncated ? source.slice(0, CSV_MAX_CHARS) : source;

  const records: string[][] = [];
  let cellTruncated = false;
  let colsTruncated = false;
  let rowsTruncated = false;
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let stoppedAt = -1;

  const appendChar = (ch: string) => {
    if (field.length >= CSV_MAX_CELL_CHARS) {
      cellTruncated = true;
      return;
    }
    field += ch;
  };

  const pushField = () => {
    if (row.length >= CSV_MAX_COLS) {
      colsTruncated = true;
      return;
    }
    row.push(field);
    field = "";
  };

  /** 结束当前记录；返回 false 表示达到记录预算、应停止扫描。 */
  const pushRow = (): boolean => {
    pushField();
    const blank = row.length === 1 && row[0] === "";
    if (!blank) {
      records.push(row);
      if (records.length >= PARSE_RECORDS) {
        row = [];
        return false;
      }
    }
    row = [];
    return true;
  };

  for (let i = 0; i < limited.length; i += 1) {
    const ch = limited[i];
    if (inQuotes) {
      if (ch === '"') {
        if (limited[i + 1] === '"') {
          appendChar('"');
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        appendChar(ch);
      }
      continue;
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      continue;
    }
    if (ch === "\n" || (ch === "\r" && limited[i + 1] !== "\n")) {
      if (!pushRow()) {
        stoppedAt = i;
        break;
      }
      continue;
    }
    if (ch === "\r") continue; // CRLF 里的 \r 交给随后的 \n 收尾
    appendChar(ch);
  }

  if (stoppedAt < 0 && (field.length > 0 || row.length > 0)) pushRow();
  if (stoppedAt >= 0) rowsTruncated = hasContentFrom(limited, stoppedAt + 1);

  const headerOption = options.header ?? "auto";
  const headerDetected =
    headerOption === "auto" ? looksLikeHeaderRow(records[0]) : headerOption === true;
  const header = headerDetected ? (records[0] ?? []) : [];
  let rows = headerDetected ? records.slice(1) : records;
  if (rows.length > CSV_MAX_ROWS) {
    rows = rows.slice(0, CSV_MAX_ROWS);
    rowsTruncated = true;
  }

  let columnCount = header.length;
  for (const dataRow of rows) {
    if (dataRow.length > columnCount) columnCount = dataRow.length;
  }

  return {
    delimiter,
    header,
    rows,
    columnCount,
    headerDetected,
    cellTruncated,
    rowsTruncated,
    colsTruncated,
    charsTruncated,
    rowCount: rows.length,
    empty: records.length === 0,
  };
}
