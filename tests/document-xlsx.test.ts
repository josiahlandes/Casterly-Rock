import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';

import { parseXlsx } from '../src/tools/executors/parsers/xlsx.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'xlsx-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function createTestWorkbook(
  sheets: Array<{ name: string; data: (string | number)[][] }>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    for (const row of sheet.data) {
      ws.addRow(row);
    }
  }
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

// ─── parseXlsx ───────────────────────────────────────────────────────────────

describe('parseXlsx', () => {
  it('extracts data from a single-sheet workbook', async () => {
    const buffer = await createTestWorkbook([
      { name: 'Sheet1', data: [['Name', 'Age'], ['Alice', 30], ['Bob', 25]] },
    ]);

    const result = await parseXlsx(buffer);
    expect(result.totalSheets).toBe(1);
    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0]!.name).toBe('Sheet1');
    expect(result.sheets[0]!.rows).toBe(3);
    expect(result.sheets[0]!.data[0]!).toEqual(['Name', 'Age']);
    expect(result.sheets[0]!.data[1]!).toEqual(['Alice', '30']);
    expect(result.sheets[0]!.data[2]!).toEqual(['Bob', '25']);
  });

  it('extracts data from multi-sheet workbook', async () => {
    const buffer = await createTestWorkbook([
      { name: 'People', data: [['Name'], ['Alice']] },
      { name: 'Cities', data: [['City'], ['NYC'], ['LA']] },
    ]);

    const result = await parseXlsx(buffer);
    expect(result.totalSheets).toBe(2);
    expect(result.sheets).toHaveLength(2);
    expect(result.sheets[0]!.name).toBe('People');
    expect(result.sheets[1]!.name).toBe('Cities');
    expect(result.sheets[1]!.rows).toBe(3);
  });

  it('filters to a specific sheet by name', async () => {
    const buffer = await createTestWorkbook([
      { name: 'Sheet1', data: [['A']] },
      { name: 'Target', data: [['B'], ['C']] },
      { name: 'Sheet3', data: [['D']] },
    ]);

    const result = await parseXlsx(buffer, { sheet: 'Target' });
    expect(result.totalSheets).toBe(3);
    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0]!.name).toBe('Target');
    expect(result.sheets[0]!.rows).toBe(2);
  });

  it('respects maxRows limit', async () => {
    const data: (string | number)[][] = [['ID', 'Value']];
    for (let i = 1; i <= 50; i++) {
      data.push([i, `val${i}`]);
    }
    const buffer = await createTestWorkbook([{ name: 'Big', data }]);

    const result = await parseXlsx(buffer, { maxRows: 10 });
    expect(result.sheets[0]!.data).toHaveLength(10);
    expect(result.sheets[0]!.rows).toBe(51);
    expect(result.sheets[0]!.truncated).toBe(true);
  });

  it('does not truncate when rows within limit', async () => {
    const buffer = await createTestWorkbook([
      { name: 'Small', data: [['A'], ['B'], ['C']] },
    ]);

    const result = await parseXlsx(buffer, { maxRows: 10 });
    expect(result.sheets[0]!.truncated).toBe(false);
    expect(result.sheets[0]!.data).toHaveLength(3);
  });

  it('handles empty workbook', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Empty');
    const arrayBuffer = await wb.xlsx.writeBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const result = await parseXlsx(buffer);
    expect(result.totalSheets).toBe(1);
    expect(result.sheets[0]!.data).toHaveLength(0);
    expect(result.sheets[0]!.rows).toBe(0);
  });

  it('reports correct column count', async () => {
    const buffer = await createTestWorkbook([
      { name: 'Wide', data: [['A', 'B', 'C', 'D', 'E'], ['1', '2', '3', '4', '5']] },
    ]);

    const result = await parseXlsx(buffer);
    expect(result.sheets[0]!.columns).toBe(5);
  });
});
