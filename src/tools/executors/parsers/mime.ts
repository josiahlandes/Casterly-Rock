/**
 * MIME Detection
 *
 * Detects file type from magic bytes using the file-type library.
 * Falls back to extension-based detection when magic bytes are inconclusive.
 */

import { fileTypeFromBuffer } from 'file-type';

export interface MimeResult {
  /** Detected MIME type (e.g. 'application/pdf') */
  mime: string;
  /** Detected extension without dot (e.g. 'pdf') */
  ext: string;
}

/** Map from MIME types to our internal format labels */
const MIME_TO_FORMAT = new Map<string, string>([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.ms-excel', 'xlsx'],
  ['text/csv', 'csv'],
  ['application/zip', 'zip'],
  ['application/gzip', 'gzip'],
  ['application/x-tar', 'tar'],
]);

/** Map from file extensions to our internal format labels (fallback) */
const EXT_TO_FORMAT = new Map<string, string>([
  ['.pdf', 'pdf'],
  ['.docx', 'docx'],
  ['.xlsx', 'xlsx'],
  ['.xls', 'xlsx'],
  ['.csv', 'csv'],
  ['.zip', 'zip'],
  ['.tar', 'tar'],
  ['.gz', 'gzip'],
  ['.tgz', 'gzip'],
  ['.tar.gz', 'gzip'],
]);

/**
 * Detect file type from buffer magic bytes.
 * Returns undefined if type cannot be determined.
 */
export async function detectMime(buffer: Buffer | Uint8Array): Promise<MimeResult | undefined> {
  const result = await fileTypeFromBuffer(buffer);
  if (!result) return undefined;
  return { mime: result.mime, ext: result.ext };
}

/**
 * Resolve the internal format label from MIME detection result.
 */
export function mimeToFormat(mimeResult: MimeResult): string | undefined {
  return MIME_TO_FORMAT.get(mimeResult.mime);
}

/**
 * Resolve the internal format label from file extension (fallback).
 */
export function extToFormat(ext: string): string | undefined {
  const lower = ext.toLowerCase().startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return EXT_TO_FORMAT.get(lower);
}

/**
 * Detect format from buffer, falling back to extension.
 * Returns the internal format label (pdf, docx, xlsx, csv, zip, tar, gzip).
 */
export async function detectFormat(
  buffer: Buffer | Uint8Array,
  fileExtension: string,
): Promise<string | undefined> {
  // Try magic bytes first
  const mimeResult = await detectMime(buffer);
  if (mimeResult) {
    const format = mimeToFormat(mimeResult);
    if (format) return format;
  }

  // Fall back to extension
  return extToFormat(fileExtension);
}

/**
 * Check if a format is a supported document type (for read_document).
 */
export function isDocumentFormat(format: string): boolean {
  return ['pdf', 'docx', 'xlsx', 'csv'].includes(format);
}

/**
 * Check if a format is an archive type.
 */
export function isArchiveFormat(format: string): boolean {
  return ['zip', 'gzip', 'tar'].includes(format);
}
