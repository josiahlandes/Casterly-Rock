import { describe, expect, it } from 'vitest';

import { parsePdf } from '../src/tools/executors/parsers/pdf.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a minimal valid PDF buffer with given text content.
 * This produces a basic PDF 1.4 document with a single page.
 */
function createMinimalPdf(text: string): Buffer {
  // Minimal PDF structure with a single page containing text
  const streamContent = `BT /F1 12 Tf 100 700 Td (${text}) Tj ET`;
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

  return Buffer.from(pdf, 'ascii');
}

// ─── parsePdf ────────────────────────────────────────────────────────────────

describe('parsePdf', () => {
  it('extracts text from a minimal PDF', async () => {
    const buffer = createMinimalPdf('Hello World');
    const result = await parsePdf(buffer);

    expect(result.content).toContain('Hello World');
    expect(result.pages).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('returns page count', async () => {
    const buffer = createMinimalPdf('Test content');
    const result = await parsePdf(buffer);

    expect(result.pages).toBeGreaterThanOrEqual(1);
  });

  it('returns metadata object', async () => {
    const buffer = createMinimalPdf('Test');
    const result = await parsePdf(buffer);

    expect(result.metadata).toBeDefined();
    // Minimal PDFs may not have title/author/creator
    expect(typeof result.metadata).toBe('object');
  });

  it('does not truncate when pages within limit', async () => {
    const buffer = createMinimalPdf('Short doc');
    const result = await parsePdf(buffer, { maxPages: 50 });

    expect(result.truncated).toBe(false);
  });

  it('respects maxPages = 1 on single-page doc', async () => {
    const buffer = createMinimalPdf('Single page');
    const result = await parsePdf(buffer, { maxPages: 1 });

    expect(result.truncated).toBe(false);
    expect(result.content).toContain('Single page');
  });
});
