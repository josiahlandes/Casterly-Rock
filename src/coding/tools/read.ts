/**
 * Read Tool
 *
 * Read file contents with token counting and optional line limits.
 * More structured than raw `cat` - tracks tokens and provides metadata.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { tokenCounter } from '../token-counter.js';

export interface ReadOptions {
  /** Starting line (1-indexed, default: 1) */
  startLine?: number;
  /** Number of lines to read (default: all) */
  lineCount?: number;
  /** Maximum tokens to return (truncates if exceeded) */
  maxTokens?: number;
  /** Include line numbers in output */
  includeLineNumbers?: boolean;
}

export interface ReadResult {
  success: boolean;
  path: string;
  content?: string;
  error?: string;

  /** Metadata about the read */
  metadata?: {
    /** Total tokens in returned content */
    tokens: number;
    /** Total lines in file */
    totalLines: number;
    /** Lines actually returned */
    linesReturned: number;
    /** Starting line number */
    startLine: number;
    /** Whether content was truncated */
    truncated: boolean;
    /** File size in bytes */
    sizeBytes: number;
    /** File modification time */
    modifiedAt: string;
  };
}

/**
 * Read a file with optional line range and token limits.
 */
export async function readFile(filePath: string, options: ReadOptions = {}): Promise<ReadResult> {
  const {
    startLine = 1,
    lineCount,
    maxTokens,
    includeLineNumbers = false,
  } = options;

  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

  try {
    // Check file exists and get stats
    const stats = await fs.stat(absolutePath);

    if (!stats.isFile()) {
      return {
        success: false,
        path: absolutePath,
        error: `Not a file: ${absolutePath}`,
      };
    }

    // Read file content
    const rawContent = await fs.readFile(absolutePath, 'utf-8');
    const allLines = rawContent.split('\n');
    const totalLines = allLines.length;

    // Calculate line range
    const start = Math.max(1, startLine) - 1; // Convert to 0-indexed
    const end = lineCount ? Math.min(start + lineCount, totalLines) : totalLines;

    // Extract requested lines
    let lines = allLines.slice(start, end);
    let truncated = false;

    // Add line numbers if requested
    if (includeLineNumbers) {
      const lineNumWidth = String(end).length;
      lines = lines.map((line, i) => {
        const lineNum = String(start + i + 1).padStart(lineNumWidth, ' ');
        return `${lineNum} │ ${line}`;
      });
    }

    let content = lines.join('\n');

    // Check token limit
    let tokens = tokenCounter.count(content);

    if (maxTokens && tokens > maxTokens) {
      // Truncate to fit within token limit
      // Approximate: remove lines from end until under limit
      while (tokens > maxTokens && lines.length > 1) {
        lines.pop();
        content = lines.join('\n');
        tokens = tokenCounter.count(content);
      }

      // Add truncation indicator
      content += '\n... [truncated]';
      tokens = tokenCounter.count(content);
      truncated = true;
    }

    return {
      success: true,
      path: absolutePath,
      content,
      metadata: {
        tokens,
        totalLines,
        linesReturned: lines.length,
        startLine: start + 1,
        truncated,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      },
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;

    if (error.code === 'ENOENT') {
      return {
        success: false,
        path: absolutePath,
        error: `File not found: ${absolutePath}`,
      };
    }

    if (error.code === 'EACCES') {
      return {
        success: false,
        path: absolutePath,
        error: `Permission denied: ${absolutePath}`,
      };
    }

    return {
      success: false,
      path: absolutePath,
      error: `Failed to read file: ${error.message}`,
    };
  }
}

/**
 * Read multiple files, respecting a total token budget.
 */
export async function readFiles(
  filePaths: string[],
  options: { maxTotalTokens?: number; includeLineNumbers?: boolean } = {}
): Promise<{ results: ReadResult[]; totalTokens: number }> {
  const { maxTotalTokens, includeLineNumbers = false } = options;
  const results: ReadResult[] = [];
  let totalTokens = 0;

  for (const filePath of filePaths) {
    // Calculate remaining budget for this file
    const remainingTokens = maxTotalTokens !== undefined ? maxTotalTokens - totalTokens : undefined;

    if (remainingTokens !== undefined && remainingTokens <= 0) {
      // No budget left, skip remaining files
      results.push({
        success: false,
        path: filePath,
        error: 'Token budget exhausted',
      });
      continue;
    }

    const readOptions: ReadOptions = { includeLineNumbers };
    if (remainingTokens !== undefined) {
      readOptions.maxTokens = remainingTokens;
    }

    const result = await readFile(filePath, readOptions);

    results.push(result);

    if (result.success && result.metadata) {
      totalTokens += result.metadata.tokens;
    }
  }

  return { results, totalTokens };
}

/**
 * Check if a file exists and is readable.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    await fs.access(absolutePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file metadata without reading content.
 */
export async function getFileInfo(
  filePath: string
): Promise<{ exists: boolean; size?: number; lines?: number; modified?: string }> {
  try {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    const stats = await fs.stat(absolutePath);

    if (!stats.isFile()) {
      return { exists: false };
    }

    // Count lines without loading entire file into memory
    const content = await fs.readFile(absolutePath, 'utf-8');
    const lines = content.split('\n').length;

    return {
      exists: true,
      size: stats.size,
      lines,
      modified: stats.mtime.toISOString(),
    };
  } catch {
    return { exists: false };
  }
}
