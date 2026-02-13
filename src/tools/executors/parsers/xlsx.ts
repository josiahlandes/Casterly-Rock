/**
 * XLSX Parser (ISSUE-001)
 *
 * Extracts spreadsheet data from Excel files using exceljs.
 */

import ExcelJS from 'exceljs';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface XlsxParseOptions {
  maxRows?: number | undefined;
  sheet?: string | undefined;
}

export interface XlsxSheet {
  name: string;
  rows: number;
  columns: number;
  data: string[][];
  truncated: boolean;
}

export interface XlsxParseResult {
  sheets: XlsxSheet[];
  totalSheets: number;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ROWS = 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  // Rich text
  if (typeof value === 'object' && 'richText' in value) {
    const rt = value as { richText: Array<{ text: string }> };
    return rt.richText.map((r) => r.text).join('');
  }
  // Formula result
  if (typeof value === 'object' && 'result' in value) {
    const formula = value as { result?: ExcelJS.CellValue };
    return cellToString(formula.result ?? null);
  }
  // Hyperlink
  if (typeof value === 'object' && 'text' in value) {
    return String((value as { text: string }).text);
  }
  return String(value);
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Extract structured data from an XLSX buffer.
 */
export async function parseXlsx(buffer: Buffer, options?: XlsxParseOptions): Promise<XlsxParseResult> {
  const maxRows = options?.maxRows ?? DEFAULT_MAX_ROWS;
  const sheetFilter = options?.sheet;

  const workbook = new ExcelJS.Workbook();
  // ExcelJS types expect older Buffer signature; cast through unknown
  await workbook.xlsx.load(buffer as never);

  const totalSheets = workbook.worksheets.length;
  const sheets: XlsxSheet[] = [];

  for (const worksheet of workbook.worksheets) {
    if (sheetFilter && worksheet.name !== sheetFilter) {
      continue;
    }

    const data: string[][] = [];
    let totalRowCount = 0;

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      totalRowCount = rowNumber;
      if (data.length < maxRows) {
        const rowData: string[] = [];
        row.eachCell({ includeEmpty: true }, (_cell, colNumber) => {
          // Pad array to correct column position (1-based → 0-based)
          while (rowData.length < colNumber - 1) {
            rowData.push('');
          }
          rowData.push(cellToString(row.getCell(colNumber).value));
        });
        data.push(rowData);
      }
    });

    const truncated = totalRowCount > maxRows;

    // Determine column count from the widest row
    let columns = 0;
    for (const row of data) {
      if (row.length > columns) {
        columns = row.length;
      }
    }

    sheets.push({
      name: worksheet.name,
      rows: totalRowCount,
      columns,
      data,
      truncated,
    });
  }

  return { sheets, totalSheets };
}
