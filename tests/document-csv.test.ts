import { describe, expect, it } from 'vitest';

import { parseCsv } from '../src/tools/executors/parsers/csv.js';

// ─── parseCsv ────────────────────────────────────────────────────────────────

describe('parseCsv', () => {
  it('parses CSV with headers and rows', () => {
    const content = 'name,age,city\nAlice,30,NYC\nBob,25,LA\n';
    const result = parseCsv(content);

    expect(result.headers).toEqual(['name', 'age', 'city']);
    expect(result.rows).toEqual([
      ['Alice', '30', 'NYC'],
      ['Bob', '25', 'LA'],
    ]);
    expect(result.totalRows).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('handles empty CSV', () => {
    const result = parseCsv('');
    expect(result.headers).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('handles header-only CSV', () => {
    const result = parseCsv('name,age,city\n');
    expect(result.headers).toEqual(['name', 'age', 'city']);
    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('respects maxRows limit', () => {
    const lines = ['id,value'];
    for (let i = 1; i <= 20; i++) {
      lines.push(`${i},val${i}`);
    }
    const content = lines.join('\n');

    const result = parseCsv(content, { maxRows: 5 });
    expect(result.rows).toHaveLength(5);
    expect(result.totalRows).toBe(20);
    expect(result.truncated).toBe(true);
    expect(result.rows[0]!).toEqual(['1', 'val1']);
    expect(result.rows[4]!).toEqual(['5', 'val5']);
  });

  it('does not truncate when rows equal maxRows', () => {
    const content = 'a,b\n1,2\n3,4\n5,6\n';
    const result = parseCsv(content, { maxRows: 3 });
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(3);
  });

  it('handles custom delimiter', () => {
    const content = 'name;age;city\nAlice;30;NYC\n';
    const result = parseCsv(content, { delimiter: ';' });
    expect(result.headers).toEqual(['name', 'age', 'city']);
    expect(result.rows[0]!).toEqual(['Alice', '30', 'NYC']);
  });

  it('handles quoted fields with commas', () => {
    const content = 'name,description\nAlice,"likes cats, dogs"\n';
    const result = parseCsv(content);
    expect(result.rows[0]!).toEqual(['Alice', 'likes cats, dogs']);
  });

  it('skips empty lines', () => {
    const content = 'a,b\n1,2\n\n3,4\n\n';
    const result = parseCsv(content);
    expect(result.totalRows).toBe(2);
  });
});
