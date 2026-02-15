import { describe, expect, it } from 'vitest';

import {
  detectMime,
  mimeToFormat,
  extToFormat,
  detectFormat,
  isDocumentFormat,
  isArchiveFormat,
} from '../src/tools/executors/parsers/mime.js';

// ═══════════════════════════════════════════════════════════════════════════════
// detectMime
// ═══════════════════════════════════════════════════════════════════════════════

describe('detectMime', () => {
  it('detects PDF from magic bytes', async () => {
    // PDF magic bytes: %PDF
    const pdfBuffer = Buffer.from('%PDF-1.4 fake content');
    const result = await detectMime(pdfBuffer);
    expect(result).toBeDefined();
    expect(result?.mime).toBe('application/pdf');
    expect(result?.ext).toBe('pdf');
  });

  it('detects ZIP from magic bytes', async () => {
    // ZIP magic bytes: PK\x03\x04
    const zipBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
    const result = await detectMime(zipBuffer);
    expect(result).toBeDefined();
    expect(result?.ext).toBe('zip');
  });

  it('detects GZIP from magic bytes', async () => {
    // GZIP magic bytes: \x1f\x8b
    const gzipBuffer = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const result = await detectMime(gzipBuffer);
    expect(result).toBeDefined();
    expect(result?.ext).toBe('gz');
  });

  it('returns undefined for plain text', async () => {
    const textBuffer = Buffer.from('Hello, world! This is plain text.');
    const result = await detectMime(textBuffer);
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty buffer', async () => {
    const result = await detectMime(Buffer.alloc(0));
    expect(result).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// mimeToFormat
// ═══════════════════════════════════════════════════════════════════════════════

describe('mimeToFormat', () => {
  it('maps application/pdf to pdf', () => {
    expect(mimeToFormat({ mime: 'application/pdf', ext: 'pdf' })).toBe('pdf');
  });

  it('maps docx MIME to docx', () => {
    expect(
      mimeToFormat({
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ext: 'docx',
      }),
    ).toBe('docx');
  });

  it('maps xlsx MIME to xlsx', () => {
    expect(
      mimeToFormat({
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ext: 'xlsx',
      }),
    ).toBe('xlsx');
  });

  it('maps xls MIME to xlsx', () => {
    expect(mimeToFormat({ mime: 'application/vnd.ms-excel', ext: 'xls' })).toBe('xlsx');
  });

  it('maps application/zip to zip', () => {
    expect(mimeToFormat({ mime: 'application/zip', ext: 'zip' })).toBe('zip');
  });

  it('maps application/gzip to gzip', () => {
    expect(mimeToFormat({ mime: 'application/gzip', ext: 'gz' })).toBe('gzip');
  });

  it('returns undefined for unknown MIME', () => {
    expect(mimeToFormat({ mime: 'image/png', ext: 'png' })).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// extToFormat
// ═══════════════════════════════════════════════════════════════════════════════

describe('extToFormat', () => {
  it('maps .pdf to pdf', () => {
    expect(extToFormat('.pdf')).toBe('pdf');
  });

  it('maps .docx to docx', () => {
    expect(extToFormat('.docx')).toBe('docx');
  });

  it('maps .xlsx to xlsx', () => {
    expect(extToFormat('.xlsx')).toBe('xlsx');
  });

  it('maps .xls to xlsx', () => {
    expect(extToFormat('.xls')).toBe('xlsx');
  });

  it('maps .csv to csv', () => {
    expect(extToFormat('.csv')).toBe('csv');
  });

  it('maps .zip to zip', () => {
    expect(extToFormat('.zip')).toBe('zip');
  });

  it('maps .tar to tar', () => {
    expect(extToFormat('.tar')).toBe('tar');
  });

  it('maps .gz to gzip', () => {
    expect(extToFormat('.gz')).toBe('gzip');
  });

  it('maps .tgz to gzip', () => {
    expect(extToFormat('.tgz')).toBe('gzip');
  });

  it('maps .tar.gz to gzip', () => {
    expect(extToFormat('.tar.gz')).toBe('gzip');
  });

  it('is case-insensitive', () => {
    expect(extToFormat('.PDF')).toBe('pdf');
    expect(extToFormat('.XLSX')).toBe('xlsx');
  });

  it('handles extension without dot', () => {
    expect(extToFormat('pdf')).toBe('pdf');
    expect(extToFormat('zip')).toBe('zip');
  });

  it('returns undefined for unknown extension', () => {
    expect(extToFormat('.png')).toBeUndefined();
    expect(extToFormat('.txt')).toBeUndefined();
    expect(extToFormat('.mp3')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// detectFormat
// ═══════════════════════════════════════════════════════════════════════════════

describe('detectFormat', () => {
  it('detects PDF from magic bytes regardless of extension', async () => {
    const pdfBuffer = Buffer.from('%PDF-1.4 fake content');
    const format = await detectFormat(pdfBuffer, '.unknown');
    expect(format).toBe('pdf');
  });

  it('falls back to extension when magic bytes are inconclusive', async () => {
    const textBuffer = Buffer.from('name,age\nAlice,30');
    const format = await detectFormat(textBuffer, '.csv');
    expect(format).toBe('csv');
  });

  it('returns undefined for unknown buffer and extension', async () => {
    const textBuffer = Buffer.from('Hello world');
    const format = await detectFormat(textBuffer, '.unknown');
    expect(format).toBeUndefined();
  });

  it('prefers MIME detection over extension', async () => {
    // ZIP magic bytes but .dat extension
    const zipBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
    const format = await detectFormat(zipBuffer, '.dat');
    expect(format).toBe('zip');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// isDocumentFormat / isArchiveFormat
// ═══════════════════════════════════════════════════════════════════════════════

describe('isDocumentFormat', () => {
  it('returns true for document formats', () => {
    expect(isDocumentFormat('pdf')).toBe(true);
    expect(isDocumentFormat('docx')).toBe(true);
    expect(isDocumentFormat('xlsx')).toBe(true);
    expect(isDocumentFormat('csv')).toBe(true);
  });

  it('returns false for archive formats', () => {
    expect(isDocumentFormat('zip')).toBe(false);
    expect(isDocumentFormat('gzip')).toBe(false);
    expect(isDocumentFormat('tar')).toBe(false);
  });

  it('returns false for unknown', () => {
    expect(isDocumentFormat('png')).toBe(false);
  });
});

describe('isArchiveFormat', () => {
  it('returns true for archive formats', () => {
    expect(isArchiveFormat('zip')).toBe(true);
    expect(isArchiveFormat('gzip')).toBe(true);
    expect(isArchiveFormat('tar')).toBe(true);
  });

  it('returns false for document formats', () => {
    expect(isArchiveFormat('pdf')).toBe(false);
    expect(isArchiveFormat('docx')).toBe(false);
  });
});
