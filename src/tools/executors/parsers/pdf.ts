/**
 * PDF Parser (ISSUE-001)
 *
 * Extracts text content and metadata from PDF files using pdf-parse.
 */

import { PDFParse } from 'pdf-parse';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PdfParseOptions {
  maxPages?: number | undefined;
}

interface PdfMetadata {
  title?: string | undefined;
  author?: string | undefined;
  creator?: string | undefined;
}

interface PdfParseResult {
  content: string;
  pages: number;
  metadata: PdfMetadata;
  truncated: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_PAGES = 50;

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Extract text content and metadata from a PDF buffer.
 */
export async function parsePdf(data: Buffer, options?: PdfParseOptions): Promise<PdfParseResult> {
  const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;

  const pdf = new PDFParse({ data });

  // Get total page count from info
  const info = await pdf.getInfo();
  const totalPages = info.total;
  const truncated = totalPages > maxPages;

  // Extract text, limiting pages if needed
  const text = await pdf.getText(
    truncated ? { first: maxPages } : undefined,
  );

  await pdf.destroy();

  // Extract metadata safely
  const metadata: PdfMetadata = {};
  if (info.info) {
    if (typeof info.info.Title === 'string') {
      metadata.title = info.info.Title;
    }
    if (typeof info.info.Author === 'string') {
      metadata.author = info.info.Author;
    }
    if (typeof info.info.Creator === 'string') {
      metadata.creator = info.info.Creator;
    }
  }

  return {
    content: text.text,
    pages: totalPages,
    metadata,
    truncated,
  };
}
