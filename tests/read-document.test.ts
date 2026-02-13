import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

import { createReadDocumentExecutor } from '../src/tools/executors/read-document.js';
import type { NativeToolCall } from '../src/tools/schemas/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tempDir: string;
let callId = 0;

function makeCall(input: Record<string, unknown>): NativeToolCall {
  callId++;
  return { id: `call-${callId}`, name: 'read_document', input };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'read-doc-test-'));
  callId = 0;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function createTestXlsx(
  sheets: Array<{ name: string; data: (string | number)[][] }>,
): Promise<string> {
  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    for (const row of sheet.data) {
      ws.addRow(row);
    }
  }
  const filePath = join(tempDir, 'test.xlsx');
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

async function createTestDocx(paragraphs: string[]): Promise<string> {
  const bodyContent = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join('');

  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    '  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    `  <w:body>${bodyContent}</w:body>`,
    '</w:document>',
  ].join('\n');

  const contentTypesXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '  <Default Extension="xml" ContentType="application/xml"/>',
    '  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '</Types>',
  ].join('\n');

  const relsXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '</Relationships>',
  ].join('\n');

  const wordRelsXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '</Relationships>',
  ].join('\n');

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypesXml);
  zip.file('_rels/.rels', relsXml);
  zip.file('word/document.xml', documentXml);
  zip.file('word/_rels/document.xml.rels', wordRelsXml);

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const filePath = join(tempDir, 'test.docx');
  writeFileSync(filePath, buffer);
  return filePath;
}

function createTestCsv(): string {
  const filePath = join(tempDir, 'test.csv');
  writeFileSync(filePath, 'name,age,city\nAlice,30,NYC\nBob,25,LA\n');
  return filePath;
}

function createMinimalPdf(): string {
  const streamContent = 'BT /F1 12 Tf 100 700 Td (Hello PDF) Tj ET';
  const streamLength = Buffer.byteLength(streamContent, 'ascii');

  const pdf = [
    '%PDF-1.4',
    '',
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '',
    '2 0 obj',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    'endobj',
    '',
    '3 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]',
    '   /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    'endobj',
    '',
    '4 0 obj',
    `<< /Length ${streamLength} >>`,
    'stream',
    streamContent,
    'endstream',
    'endobj',
    '',
    '5 0 obj',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    'endobj',
    '',
    'xref',
    '0 6',
    '0000000000 65535 f ',
    '0000000009 00000 n ',
    '0000000058 00000 n ',
    '0000000115 00000 n ',
    '0000000266 00000 n ',
    `0000000${(317 + streamLength).toString().padStart(3, '0')} 00000 n `,
    '',
    'trailer',
    '<< /Size 6 /Root 1 0 R >>',
    'startxref',
    '9',
    '%%EOF',
  ].join('\n');

  const filePath = join(tempDir, 'test.pdf');
  writeFileSync(filePath, pdf, 'ascii');
  return filePath;
}

// ─── Validation Tests ────────────────────────────────────────────────────────

describe('createReadDocumentExecutor - validation', () => {
  const executor = createReadDocumentExecutor();

  it('rejects empty path', async () => {
    const result = await executor.execute(makeCall({ path: '' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty string');
  });

  it('rejects missing path', async () => {
    const result = await executor.execute(makeCall({}));
    expect(result.success).toBe(false);
  });

  it('rejects non-existent file', async () => {
    const result = await executor.execute(makeCall({ path: '/tmp/nonexistent.pdf' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });

  it('rejects directory path', async () => {
    const result = await executor.execute(makeCall({ path: tempDir }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('directory');
  });

  it('rejects unsupported extension', async () => {
    const filePath = join(tempDir, 'test.txt');
    writeFileSync(filePath, 'hello');
    const result = await executor.execute(makeCall({ path: filePath }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported file type');
    expect(result.error).toContain('read_file');
  });

  it('rejects blocked paths', async () => {
    const result = await executor.execute(makeCall({ path: '/some/path/.env' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('protected');
  });
});

// ─── CSV Integration ─────────────────────────────────────────────────────────

describe('createReadDocumentExecutor - CSV', () => {
  const executor = createReadDocumentExecutor();

  it('reads CSV file successfully', async () => {
    const filePath = createTestCsv();
    const result = await executor.execute(makeCall({ path: filePath }));

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.headers).toEqual(['name', 'age', 'city']);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.truncated).toBe(false);
  });
});

// ─── XLSX Integration ────────────────────────────────────────────────────────

describe('createReadDocumentExecutor - XLSX', () => {
  const executor = createReadDocumentExecutor();

  it('reads XLSX file successfully', async () => {
    const filePath = await createTestXlsx([
      { name: 'Data', data: [['Name', 'Value'], ['Alice', 42]] },
    ]);
    const result = await executor.execute(makeCall({ path: filePath }));

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.totalSheets).toBe(1);
    expect(parsed.sheets[0].name).toBe('Data');
    expect(parsed.sheets[0].data[0]).toEqual(['Name', 'Value']);
  });

  it('passes sheet filter option', async () => {
    const filePath = await createTestXlsx([
      { name: 'Sheet1', data: [['A']] },
      { name: 'Target', data: [['B']] },
    ]);
    const result = await executor.execute(makeCall({ path: filePath, sheet: 'Target' }));

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.sheets).toHaveLength(1);
    expect(parsed.sheets[0].name).toBe('Target');
  });
});

// ─── DOCX Integration ────────────────────────────────────────────────────────

describe('createReadDocumentExecutor - DOCX', () => {
  const executor = createReadDocumentExecutor();

  it('reads DOCX file successfully', async () => {
    const filePath = await createTestDocx(['Hello from DOCX']);
    const result = await executor.execute(makeCall({ path: filePath }));

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.format).toBe('text');
    expect(parsed.content).toContain('Hello from DOCX');
  });

  it('passes format option for HTML', async () => {
    const filePath = await createTestDocx(['HTML content']);
    const result = await executor.execute(makeCall({ path: filePath, format: 'html' }));

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.format).toBe('html');
    expect(parsed.content).toContain('<p>');
  });
});

// ─── PDF Integration ─────────────────────────────────────────────────────────

describe('createReadDocumentExecutor - PDF', () => {
  const executor = createReadDocumentExecutor();

  it('reads PDF file successfully', async () => {
    const filePath = createMinimalPdf();
    const result = await executor.execute(makeCall({ path: filePath }));

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.pages).toBe(1);
    expect(parsed.content).toContain('Hello PDF');
  });
});
