/**
 * CSV Parser (ISSUE-001)
 *
 * Structured CSV parsing with column awareness using csv-parse.
 */

import { parse } from 'csv-parse/sync';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CsvParseOptions {
  maxRows?: number | undefined;
  delimiter?: string | undefined;
}

export interface CsvParseResult {
  headers: string[];
  rows: string[][];
  totalRows: number;
  truncated: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_ROWS = 5000;

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse CSV content into structured headers + rows.
 */
export function parseCsv(content: string, options?: CsvParseOptions): CsvParseResult {
  const maxRows = options?.maxRows ?? DEFAULT_MAX_ROWS;
  const delimiter = options?.delimiter ?? ',';

  const records: string[][] = parse(content, {
    delimiter,
    relax_column_count: true,
    skip_empty_lines: true,
  });

  if (records.length === 0) {
    return { headers: [], rows: [], totalRows: 0, truncated: false };
  }

  const headers = records[0]!;
  const allRows = records.slice(1);
  const totalRows = allRows.length;
  const truncated = totalRows > maxRows;
  const rows = truncated ? allRows.slice(0, maxRows) : allRows;

  return { headers, rows, totalRows, truncated };
}
