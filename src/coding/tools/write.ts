/**
 * Write Tool
 *
 * Create or overwrite files with validation and safety checks.
 * Creates directories as needed, tracks history for undo.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { tokenCounter } from '../token-counter.js';

export interface WriteOptions {
  /** Create parent directories if they don't exist (default: true) */
  createDirs?: boolean;
  /** Overwrite existing file (default: true) */
  overwrite?: boolean;
  /** Backup existing file before overwriting */
  backup?: boolean;
}

export interface WriteResult {
  success: boolean;
  path: string;
  error?: string;

  /** Whether this was a new file or overwrite */
  created: boolean;
  /** Original content if file existed */
  previousContent?: string;
  /** Token count of written content */
  tokens: number;
  /** Bytes written */
  bytesWritten: number;
}

/**
 * Patterns for files that should never be written.
 */
const FORBIDDEN_PATTERNS = [
  /\.env$/i,
  /\.env\..+$/i,
  /credentials/i,
  /secrets?\.json$/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /id_ed25519/i,
];

/**
 * Directories that should never be written to.
 */
const FORBIDDEN_DIRS = [
  'node_modules',
  '.git/objects',
  '.git/refs',
  'dist',
  'build',
  '__pycache__',
];

/**
 * Check if a path is forbidden from writing.
 */
function isForbiddenPath(filePath: string): { forbidden: boolean; reason?: string } {
  const normalized = path.normalize(filePath);
  const basename = path.basename(normalized);

  // Check forbidden patterns
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(basename)) {
      return {
        forbidden: true,
        reason: `Cannot write to sensitive file matching pattern: ${pattern}`,
      };
    }
  }

  // Check forbidden directories
  for (const dir of FORBIDDEN_DIRS) {
    if (normalized.includes(`/${dir}/`) || normalized.includes(`\\${dir}\\`)) {
      return {
        forbidden: true,
        reason: `Cannot write to protected directory: ${dir}`,
      };
    }
  }

  return { forbidden: false };
}

/**
 * Write content to a file.
 */
export async function writeFile(
  filePath: string,
  content: string,
  options: WriteOptions = {}
): Promise<WriteResult> {
  const { createDirs = true, overwrite = true, backup = false } = options;

  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

  // Check for forbidden paths
  const forbidden = isForbiddenPath(absolutePath);
  if (forbidden.forbidden) {
    const result: WriteResult = {
      success: false,
      path: absolutePath,
      created: false,
      tokens: 0,
      bytesWritten: 0,
    };
    if (forbidden.reason) {
      result.error = forbidden.reason;
    }
    return result;
  }

  try {
    // Check if file exists
    let fileExists = false;
    let previousContent: string | undefined;

    try {
      previousContent = await fs.readFile(absolutePath, 'utf-8');
      fileExists = true;
    } catch {
      // File doesn't exist, that's fine
    }

    // Check overwrite permission
    if (fileExists && !overwrite) {
      return {
        success: false,
        path: absolutePath,
        error: 'File exists and overwrite is disabled',
        created: false,
        tokens: 0,
        bytesWritten: 0,
      };
    }

    // Create backup if requested
    if (fileExists && backup && previousContent !== undefined) {
      const backupPath = `${absolutePath}.bak`;
      await fs.writeFile(backupPath, previousContent, 'utf-8');
    }

    // Create parent directories if needed
    if (createDirs) {
      const dir = path.dirname(absolutePath);
      await fs.mkdir(dir, { recursive: true });
    }

    // Write the file
    await fs.writeFile(absolutePath, content, 'utf-8');

    const tokens = tokenCounter.count(content);
    const bytesWritten = Buffer.byteLength(content, 'utf-8');

    const result: WriteResult = {
      success: true,
      path: absolutePath,
      created: !fileExists,
      tokens,
      bytesWritten,
    };
    if (fileExists && previousContent !== undefined) {
      result.previousContent = previousContent;
    }
    return result;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;

    if (error.code === 'ENOENT') {
      return {
        success: false,
        path: absolutePath,
        error: `Parent directory does not exist: ${path.dirname(absolutePath)}`,
        created: false,
        tokens: 0,
        bytesWritten: 0,
      };
    }

    if (error.code === 'EACCES') {
      return {
        success: false,
        path: absolutePath,
        error: `Permission denied: ${absolutePath}`,
        created: false,
        tokens: 0,
        bytesWritten: 0,
      };
    }

    return {
      success: false,
      path: absolutePath,
      error: `Failed to write file: ${error.message}`,
      created: false,
      tokens: 0,
      bytesWritten: 0,
    };
  }
}

/**
 * Delete a file.
 */
export async function deleteFile(
  filePath: string
): Promise<{ success: boolean; path: string; error?: string; previousContent?: string }> {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);

  // Check for forbidden paths
  const forbidden = isForbiddenPath(absolutePath);
  if (forbidden.forbidden) {
    const result: { success: boolean; path: string; error?: string; previousContent?: string } = {
      success: false,
      path: absolutePath,
    };
    if (forbidden.reason) {
      result.error = forbidden.reason;
    }
    return result;
  }

  try {
    // Read content before deletion (for undo)
    let previousContent: string | undefined;
    try {
      previousContent = await fs.readFile(absolutePath, 'utf-8');
    } catch {
      // File might not exist
    }

    await fs.unlink(absolutePath);

    const result: { success: boolean; path: string; error?: string; previousContent?: string } = {
      success: true,
      path: absolutePath,
    };
    if (previousContent !== undefined) {
      result.previousContent = previousContent;
    }
    return result;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;

    if (error.code === 'ENOENT') {
      return {
        success: false,
        path: absolutePath,
        error: `File not found: ${absolutePath}`,
      };
    }

    return {
      success: false,
      path: absolutePath,
      error: `Failed to delete file: ${error.message}`,
    };
  }
}

/**
 * Move/rename a file.
 */
export async function moveFile(
  sourcePath: string,
  destPath: string
): Promise<{ success: boolean; source: string; dest: string; error?: string }> {
  const absoluteSource = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(sourcePath);
  const absoluteDest = path.isAbsolute(destPath) ? destPath : path.resolve(destPath);

  // Check for forbidden paths
  const forbiddenSource = isForbiddenPath(absoluteSource);
  if (forbiddenSource.forbidden) {
    const result: { success: boolean; source: string; dest: string; error?: string } = {
      success: false,
      source: absoluteSource,
      dest: absoluteDest,
    };
    if (forbiddenSource.reason) {
      result.error = forbiddenSource.reason;
    }
    return result;
  }

  const forbiddenDest = isForbiddenPath(absoluteDest);
  if (forbiddenDest.forbidden) {
    const result: { success: boolean; source: string; dest: string; error?: string } = {
      success: false,
      source: absoluteSource,
      dest: absoluteDest,
    };
    if (forbiddenDest.reason) {
      result.error = forbiddenDest.reason;
    }
    return result;
  }

  try {
    // Create parent directory if needed
    await fs.mkdir(path.dirname(absoluteDest), { recursive: true });

    // Rename/move the file
    await fs.rename(absoluteSource, absoluteDest);

    return {
      success: true,
      source: absoluteSource,
      dest: absoluteDest,
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;

    if (error.code === 'ENOENT') {
      return {
        success: false,
        source: absoluteSource,
        dest: absoluteDest,
        error: `Source file not found: ${absoluteSource}`,
      };
    }

    return {
      success: false,
      source: absoluteSource,
      dest: absoluteDest,
      error: `Failed to move file: ${error.message}`,
    };
  }
}

/**
 * Copy a file.
 */
export async function copyFile(
  sourcePath: string,
  destPath: string
): Promise<{ success: boolean; source: string; dest: string; error?: string }> {
  const absoluteSource = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(sourcePath);
  const absoluteDest = path.isAbsolute(destPath) ? destPath : path.resolve(destPath);

  // Check for forbidden paths on destination
  const forbiddenDest = isForbiddenPath(absoluteDest);
  if (forbiddenDest.forbidden) {
    const result: { success: boolean; source: string; dest: string; error?: string } = {
      success: false,
      source: absoluteSource,
      dest: absoluteDest,
    };
    if (forbiddenDest.reason) {
      result.error = forbiddenDest.reason;
    }
    return result;
  }

  try {
    // Create parent directory if needed
    await fs.mkdir(path.dirname(absoluteDest), { recursive: true });

    // Copy the file
    await fs.copyFile(absoluteSource, absoluteDest);

    return {
      success: true,
      source: absoluteSource,
      dest: absoluteDest,
    };
  } catch (err) {
    const error = err as NodeJS.ErrnoException;

    if (error.code === 'ENOENT') {
      return {
        success: false,
        source: absoluteSource,
        dest: absoluteDest,
        error: `Source file not found: ${absoluteSource}`,
      };
    }

    return {
      success: false,
      source: absoluteSource,
      dest: absoluteDest,
      error: `Failed to copy file: ${error.message}`,
    };
  }
}

/**
 * Ensure a directory exists, creating it if necessary.
 */
export async function ensureDir(
  dirPath: string
): Promise<{ success: boolean; path: string; created: boolean; error?: string }> {
  const absolutePath = path.isAbsolute(dirPath) ? dirPath : path.resolve(dirPath);

  try {
    // Check if directory exists
    try {
      const stats = await fs.stat(absolutePath);
      if (stats.isDirectory()) {
        return { success: true, path: absolutePath, created: false };
      } else {
        return {
          success: false,
          path: absolutePath,
          created: false,
          error: `Path exists but is not a directory: ${absolutePath}`,
        };
      }
    } catch {
      // Directory doesn't exist, create it
    }

    await fs.mkdir(absolutePath, { recursive: true });

    return { success: true, path: absolutePath, created: true };
  } catch (err) {
    return {
      success: false,
      path: absolutePath,
      created: false,
      error: `Failed to create directory: ${(err as Error).message}`,
    };
  }
}
