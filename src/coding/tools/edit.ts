/**
 * Edit Tool
 *
 * Search/replace based editing for precise, verifiable file modifications.
 * More reliable than line-based diffs - exact text matching eliminates ambiguity.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface EditRequest {
  /** File path to edit */
  path: string;
  /** Exact text to search for */
  search: string;
  /** Text to replace with */
  replace: string;
  /** Replace all occurrences (default: false, only first) */
  replaceAll?: boolean;
}

export interface EditResult {
  success: boolean;
  path: string;
  error?: string;

  /** Number of matches found */
  matchCount: number;
  /** Number of replacements made */
  replacementsMade: number;
  /** Diff preview showing the change */
  preview?: string;
  /** Original content (for undo) */
  originalContent?: string;
}

interface EditHistoryEntry {
  id: string;
  timestamp: string;
  path: string;
  type: 'edit' | 'write' | 'delete';
  before: string;
  after: string;
  search?: string;
  replace?: string;
}

/**
 * In-memory edit history for undo support.
 */
const editHistory: EditHistoryEntry[] = [];
const MAX_HISTORY_SIZE = 100;

/**
 * Generate a unique ID for history entries.
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Add entry to edit history.
 */
function addToHistory(entry: Omit<EditHistoryEntry, 'id' | 'timestamp'>): string {
  const id = generateId();
  const fullEntry: EditHistoryEntry = {
    ...entry,
    id,
    timestamp: new Date().toISOString(),
  };

  editHistory.unshift(fullEntry);

  // Trim history if too long
  while (editHistory.length > MAX_HISTORY_SIZE) {
    editHistory.pop();
  }

  return id;
}

/**
 * Create a unified diff preview of changes.
 */
function createDiffPreview(
  original: string,
  modified: string,
  filePath: string,
  contextLines: number = 3
): string {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');

  // Find changed regions
  const changes: Array<{ origStart: number; origEnd: number; modStart: number; modEnd: number }> =
    [];

  let i = 0;
  let j = 0;

  while (i < origLines.length || j < modLines.length) {
    if (i < origLines.length && j < modLines.length && origLines[i] === modLines[j]) {
      i++;
      j++;
      continue;
    }

    // Found a difference - find extent
    const origStart = i;
    const modStart = j;

    // Skip differing lines
    while (i < origLines.length && (j >= modLines.length || origLines[i] !== modLines[j])) {
      i++;
    }
    while (j < modLines.length && (i >= origLines.length || origLines[i] !== modLines[j])) {
      j++;
    }

    changes.push({
      origStart,
      origEnd: i,
      modStart,
      modEnd: j,
    });
  }

  if (changes.length === 0) {
    return '(no changes)';
  }

  // Build diff output
  const lines: string[] = [`--- ${filePath}`, `+++ ${filePath}`];

  for (const change of changes) {
    // Add context before
    const contextStart = Math.max(0, change.origStart - contextLines);
    const contextEnd = Math.min(origLines.length, change.origEnd + contextLines);

    lines.push(
      `@@ -${contextStart + 1},${change.origEnd - change.origStart + contextLines * 2} ` +
        `+${change.modStart + 1},${change.modEnd - change.modStart + contextLines * 2} @@`
    );

    // Context before
    for (let k = contextStart; k < change.origStart; k++) {
      lines.push(` ${origLines[k]}`);
    }

    // Removed lines
    for (let k = change.origStart; k < change.origEnd; k++) {
      lines.push(`-${origLines[k]}`);
    }

    // Added lines
    for (let k = change.modStart; k < change.modEnd; k++) {
      lines.push(`+${modLines[k]}`);
    }

    // Context after
    for (let k = change.origEnd; k < contextEnd; k++) {
      lines.push(` ${origLines[k]}`);
    }
  }

  return lines.join('\n');
}

/**
 * Perform a search/replace edit on a file.
 */
export async function editFile(request: EditRequest): Promise<EditResult> {
  const { path: filePath, search, replace, replaceAll = false } = request;

  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

  // Validate inputs
  if (!search) {
    return {
      success: false,
      path: absolutePath,
      error: 'Search string cannot be empty',
      matchCount: 0,
      replacementsMade: 0,
    };
  }

  if (search === replace) {
    return {
      success: false,
      path: absolutePath,
      error: 'Search and replace strings are identical',
      matchCount: 0,
      replacementsMade: 0,
    };
  }

  try {
    // Read current content
    const originalContent = await fs.readFile(absolutePath, 'utf-8');

    // Count matches
    const regex = new RegExp(escapeRegex(search), 'g');
    const matches = originalContent.match(regex);
    const matchCount = matches ? matches.length : 0;

    if (matchCount === 0) {
      return {
        success: false,
        path: absolutePath,
        error: `Search string not found in file`,
        matchCount: 0,
        replacementsMade: 0,
      };
    }

    // Perform replacement
    let modifiedContent: string;
    let replacementsMade: number;

    if (replaceAll) {
      modifiedContent = originalContent.split(search).join(replace);
      replacementsMade = matchCount;
    } else {
      // Replace only first occurrence
      const index = originalContent.indexOf(search);
      modifiedContent =
        originalContent.slice(0, index) + replace + originalContent.slice(index + search.length);
      replacementsMade = 1;
    }

    // Generate diff preview
    const preview = createDiffPreview(originalContent, modifiedContent, absolutePath);

    // Write modified content
    await fs.writeFile(absolutePath, modifiedContent, 'utf-8');

    // Add to history
    addToHistory({
      path: absolutePath,
      type: 'edit',
      before: originalContent,
      after: modifiedContent,
      search,
      replace,
    });

    return {
      success: true,
      path: absolutePath,
      matchCount,
      replacementsMade,
      preview,
      originalContent,
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;

    if (error.code === 'ENOENT') {
      return {
        success: false,
        path: absolutePath,
        error: `File not found: ${absolutePath}`,
        matchCount: 0,
        replacementsMade: 0,
      };
    }

    if (error.code === 'EACCES') {
      return {
        success: false,
        path: absolutePath,
        error: `Permission denied: ${absolutePath}`,
        matchCount: 0,
        replacementsMade: 0,
      };
    }

    return {
      success: false,
      path: absolutePath,
      error: `Failed to edit file: ${error.message}`,
      matchCount: 0,
      replacementsMade: 0,
    };
  }
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


