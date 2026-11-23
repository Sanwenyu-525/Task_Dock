//! CSV / TSV 表格视图（纯展示）。
//!
//! 只负责把 `csvParse` 的结构渲染成表：黏性表头、行号列、超长单元格截断、
//! 自动换行开关。**不**在这里做解析、不读盘、不排序（排序会改变用户数据的呈现顺序）。
//!
//! 渲染预算：解析上限（2000 行 × 120 列）仍可能生成数十万单元格，
//! 这里再收敛到 `CSV_VIEW_MAX_ROWS × CSV_VIEW_MAX_COLS`，并明确提示
//! 「完整内容见源码视图」，避免一次挂载拖垮滚动。

import { useMemo } from "react";
import { t as i18n } from "../../../i18n";
import { CSV_MAX_CELL_CHARS, CSV_MAX_COLS, CSV_MAX_ROWS, type CsvTable } from "./csvParse";

export const CSV_VIEW_MAX_ROWS = 600;
export const CSV_VIEW_MAX_COLS = 40;

export interface CsvTableViewProps {
  table: CsvTable;
  /** 单元格允许换行（由工具栏「自动换行」控制）。 */
  wrap: boolean;
}

export default function CsvTableView({ table, wrap }: CsvTableViewProps) {
  const viewRows = useMemo(() => table.rows.slice(0, CSV_VIEW_MAX_ROWS), [table.rows]);
  const columns = useMemo(
    () => Array.from({ length: Math.min(table.columnCount, CSV_VIEW_MAX_COLS) }, (_, index) => index),
    [table.columnCount],
  );
  const rowsClipped = table.rows.length > viewRows.length;
  const colsClipped = table.columnCount > columns.length;

  if (table.empty) {
    return <p className="fw-preview-empty-text">{i18n("fw.preview.csv.empty")}</p>;
  }

  return (
    <div className="fw-csv-view" data-wrap={wrap ? "true" : "false"} data-has-header={table.headerDetected ? "true" : "false"}>
      <table
        className="fw-csv-table"
        aria-label={i18n("fw.preview.csv.tableAria", { rows: table.rowCount, columns: table.columnCount })}
      >
        {table.headerDetected && (
          <thead>
            <tr>
              <th scope="col" className="fw-csv-index">
                #
              </th>
              {columns.map((column) => {
                const label = table.header[column] ?? i18n("fw.preview.csv.unnamedColumn", { index: column + 1 });
                return (
                  <th scope="col" key={column} title={label} data-empty={table.header[column] ? undefined : "true"}>
                    {label}
                  </th>
                );
              })}
            </tr>
          </thead>
        )}
        <tbody>
          {viewRows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <th scope="row" className="fw-csv-index" aria-label={i18n("fw.preview.csv.rowNumber", { index: rowIndex + 1 })}>
                {rowIndex + 1}
              </th>
              {columns.map((column) => {
                const cell = row[column] ?? "";
                const clipped = cell.length >= CSV_MAX_CELL_CHARS;
                return (
                  <td
                    key={column}
                    data-empty={cell === "" ? "true" : undefined}
                    data-clipped={clipped ? "true" : undefined}
                    title={cell || undefined}
                  >
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="fw-csv-notes">
        {(rowsClipped || colsClipped) && (
          <p className="fw-preview-encoding">
            {i18n("fw.preview.csv.viewCapped", { rows: CSV_VIEW_MAX_ROWS, columns: CSV_VIEW_MAX_COLS })}
          </p>
        )}
        {table.charsTruncated && (
          <p className="fw-preview-encoding">{i18n("fw.preview.csv.charsTruncated")}</p>
        )}
        {table.rowsTruncated && !rowsClipped && (
          <p className="fw-preview-encoding">{i18n("fw.preview.csv.rowsTruncated", { limit: CSV_MAX_ROWS })}</p>
        )}
        {table.colsTruncated && !colsClipped && (
          <p className="fw-preview-encoding">{i18n("fw.preview.csv.colsTruncated", { limit: CSV_MAX_COLS })}</p>
        )}
        {table.cellTruncated && (
          <p className="fw-preview-encoding">{i18n("fw.preview.csv.cellsTruncated", { limit: CSV_MAX_CELL_CHARS })}</p>
        )}
      </div>
    </div>
  );
}
