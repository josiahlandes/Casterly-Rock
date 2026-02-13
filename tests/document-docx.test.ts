import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';

import { parseDocx } from '../src/tools/executors/parsers/docx.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a minimal valid DOCX buffer with given text paragraphs.
 * A DOCX is a ZIP file containing XML files.
 */
async function createMinimalDocx(paragraphs: string[]): Promise<Buffer> {
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

  const arrayBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  return arrayBuffer;
}

// ─── parseDocx ───────────────────────────────────────────────────────────────

describe('parseDocx', () => {
  it('extracts text from a DOCX', async () => {
    const buffer = await createMinimalDocx(['Hello World', 'Second paragraph']);
    const result = await parseDocx(buffer);

    expect(result.format).toBe('text');
    expect(result.content).toContain('Hello World');
    expect(result.content).toContain('Second paragraph');
  });

  it('counts paragraphs in text mode', async () => {
    const buffer = await createMinimalDocx(['Para one', 'Para two', 'Para three']);
    const result = await parseDocx(buffer);

    expect(result.paragraphs).toBeGreaterThanOrEqual(2);
  });

  it('returns HTML when format is html', async () => {
    const buffer = await createMinimalDocx(['Hello HTML']);
    const result = await parseDocx(buffer, { format: 'html' });

    expect(result.format).toBe('html');
    expect(result.content).toContain('<p>');
    expect(result.content).toContain('Hello HTML');
  });

  it('counts paragraphs in html mode', async () => {
    const buffer = await createMinimalDocx(['P1', 'P2']);
    const result = await parseDocx(buffer, { format: 'html' });

    expect(result.paragraphs).toBeGreaterThanOrEqual(1);
  });

  it('handles single-paragraph document', async () => {
    const buffer = await createMinimalDocx(['Only one']);
    const result = await parseDocx(buffer);

    expect(result.content).toContain('Only one');
    expect(result.paragraphs).toBeGreaterThanOrEqual(1);
  });

  it('handles empty document', async () => {
    const buffer = await createMinimalDocx([]);
    const result = await parseDocx(buffer);

    expect(result.content).toBe('');
    expect(result.paragraphs).toBe(0);
  });
});
