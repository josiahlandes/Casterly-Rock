/**
 * DOCX Parser (ISSUE-001)
 *
 * Extracts text or HTML content from Word documents using mammoth.
 */

import mammoth from 'mammoth';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DocxParseOptions {
  format?: 'text' | 'html' | undefined;
}

export interface DocxParseResult {
  content: string;
  format: 'text' | 'html';
  paragraphs: number;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Extract text or HTML content from a DOCX buffer.
 */
export async function parseDocx(buffer: Buffer, options?: DocxParseOptions): Promise<DocxParseResult> {
  const format = options?.format ?? 'text';

  let content: string;

  if (format === 'html') {
    const result = await mammoth.convertToHtml({ buffer });
    content = result.value;
  } else {
    const result = await mammoth.extractRawText({ buffer });
    content = result.value;
  }

  // Count paragraphs by splitting on double newlines (text) or <p> tags (html)
  let paragraphs: number;
  if (format === 'html') {
    const matches = content.match(/<p[\s>]/g);
    paragraphs = matches ? matches.length : 0;
  } else {
    const parts = content.split(/\n\n+/);
    paragraphs = parts.filter((p) => p.trim().length > 0).length;
  }

  return { content, format, paragraphs };
}
