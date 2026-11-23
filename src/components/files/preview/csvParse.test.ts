/**
 * CSV / TSV 解析：引号口径、分隔符嗅探、表头启发式与各级预算。
 * 断言落在解析结果本身（行列内容、截断标记），不经过 DOM。
 */

import { describe, expect, it } from "vitest";
import {
  CSV_MAX_CELL_CHARS,
  CSV_MAX_COLS,
  CSV_MAX_ROWS,
  parseCsvText,
  looksLikeHeaderRow,
  sniffCsvDelimiter,
} from "./csvParse";

describe("基础解析", () => {
  it("逗号分隔 + 首行表头", () => {
    const table = parseCsvText("name,age,city\nAlice,30,Hangzhou\nBob,25,Shanghai\n", { ext: "csv" });
    expect(table.delimiter).toBe(",");
    expect(table.headerDetected).toBe(true);
    expect(table.header).toEqual(["name", "age", "city"]);
    expect(table.rowCount).toBe(2);
    expect(table.rows[0]).toEqual(["Alice", "30", "Hangzhou"]);
    expect(table.columnCount).toBe(3);
    expect(table.empty).toBe(false);
    expect(table.rowsTruncated).toBe(false);
  });

  it("首行全是数字时不当表头", () => {
    const table = parseCsvText("2020,2021,2022\n1,2,3\n", { ext: "csv" });
    expect(table.headerDetected).toBe(false);
    expect(table.header).toEqual([]);
    expect(table.rowCount).toBe(2);
  });

  it("手动关闭表头后首行进入数据行", () => {
    const table = parseCsvText("name,age\nAlice,30\n", { ext: "csv", header: false });
    expect(table.headerDetected).toBe(false);
    expect(table.rows[0]).toEqual(["name", "age"]);
  });

  it("跳过空行，空文件只返回空态", () => {
    const table = parseCsvText("a,b\n\n\n1,2\n\n", { ext: "csv" });
    expect(table.rowCount).toBe(1);
    expect(table.rows[0]).toEqual(["1", "2"]);
    expect(parseCsvText("", { ext: "csv" }).empty).toBe(true);
    // 只有空白字符的行仍按数据行保留：空白也可能是用户真实数据，解析器不猜。
    const spaces = parseCsvText(" \n \n", { ext: "csv" });
    expect(spaces.empty).toBe(false);
    expect(spaces.rowCount).toBe(2);
    expect(spaces.rows[0]).toEqual([" "]);
  });

  it("参差行按最长行确定列数", () => {
    const table = parseCsvText("a,b,c\n1,2\n3,4,5,6\n", { ext: "csv" });
    expect(table.columnCount).toBe(4);
    expect(table.rows[0]).toEqual(["1", "2"]);
  });
});

describe("引号与换行口径", () => {
  it("引号内保留分隔符与换行（CRLF 不影响）", () => {
    const text = 'id,note\r\n1,"a,b"\r\n2,"line1\nline2"\r\n';
    const table = parseCsvText(text, { ext: "csv" });
    expect(table.rows[0][1]).toBe("a,b");
    expect(table.rows[1][1]).toBe("line1\nline2");
    expect(table.rowCount).toBe(2);
  });

  it("双写引号还原为单个引号", () => {
    const table = parseCsvText('a,b\n1,"say ""hi"""\n', { ext: "csv" });
    expect(table.rows[0][1]).toBe('say "hi"');
  });

  it("字段中途的引号按普通字符处理", () => {
    const table = parseCsvText('a,b\n1,ab"cd\n', { ext: "csv" });
    expect(table.rows[0][1]).toBe('ab"cd');
  });

  it("未闭合的引号不抛错：剩余内容并入最后一个单元格", () => {
    const table = parseCsvText('a,b\n1,"open\nstill open', { ext: "csv" });
    expect(table.rowCount).toBe(1);
    expect(table.rows[0][1]).toBe("open\nstill open");
  });
});

describe("分隔符嗅探", () => {
  it(".tsv 固定 Tab，即使内容里有逗号", () => {
    expect(sniffCsvDelimiter("a,1\tb,2\n", "tsv")).toBe("\t");
  });

  it("按引号外出现次数选择分号 / 竖线", () => {
    expect(sniffCsvDelimiter("a;b;c\n1;2;3\n", "csv")).toBe(";");
    expect(sniffCsvDelimiter("a|b|c\n1|2|3\n", "csv")).toBe("|");
    // 引号内的分隔符不参与统计。
    expect(sniffCsvDelimiter('a,b\n1,"x;y;z"\n', "csv")).toBe(",");
  });

  it("没有任何候选时退回逗号", () => {
    expect(sniffCsvDelimiter("single-column\nvalue\n", "csv")).toBe(",");
  });
});

describe("预算与降级标记", () => {
  it("行上限：保留前 CSV_MAX_ROWS 行并标记", () => {
    const lines = ["col"];
    for (let i = 0; i <= CSV_MAX_ROWS + 20; i += 1) lines.push(`v${i}`);
    const table = parseCsvText(lines.join("\n"), { ext: "csv" });
    expect(table.rowCount).toBe(CSV_MAX_ROWS);
    expect(table.rows.length).toBe(CSV_MAX_ROWS);
    expect(table.rowsTruncated).toBe(true);
    expect(table.rows[0]).toEqual(["v0"]);
  });

  it("恰好等于行上限时不误报截断", () => {
    const lines = ["col"];
    for (let i = 0; i < CSV_MAX_ROWS; i += 1) lines.push(`v${i}`);
    const table = parseCsvText(lines.join("\n"), { ext: "csv" });
    expect(table.rowCount).toBe(CSV_MAX_ROWS);
    expect(table.rowsTruncated).toBe(false);
  });

  it("列上限：超出列被丢弃并标记", () => {
    const wide = Array.from({ length: CSV_MAX_COLS + 5 }, (_, i) => `c${i}`).join(",");
    const table = parseCsvText(`${wide}\n${wide}\n`, { ext: "csv" });
    expect(table.colsTruncated).toBe(true);
    expect(table.columnCount).toBeLessThanOrEqual(CSV_MAX_COLS);
  });

  it("单元格上限：超长内容被截断并标记", () => {
    const long = "x".repeat(CSV_MAX_CELL_CHARS + 50);
    const table = parseCsvText(`a,b\n1,${long}\n`, { ext: "csv" });
    expect(table.cellTruncated).toBe(true);
    expect(table.rows[0][1].length).toBe(CSV_MAX_CELL_CHARS);
  });
});

describe("表头启发式", () => {
  it("全空 / 全数字 / 混合字符串的判定", () => {
    expect(looksLikeHeaderRow(["", " "])).toBe(false);
    expect(looksLikeHeaderRow(["1", "2.5", "-3"])).toBe(false);
    expect(looksLikeHeaderRow(["name", "1"])).toBe(true);
    expect(looksLikeHeaderRow([])).toBe(false);
    expect(looksLikeHeaderRow(undefined)).toBe(false);
  });
});
