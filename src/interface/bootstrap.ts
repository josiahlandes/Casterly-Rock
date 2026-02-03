/**
 * Bootstrap file loader
 * Loads workspace files (SOUL.md, TOOLS.md, etc.) that get injected into the system prompt
 * Compatible with OpenClaw workspace file conventions
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Standard bootstrap files in order of injection
 * These mirror OpenClaw's workspace file conventions
 */
export const BOOTSTRAP_FILES = [
  'IDENTITY.md',   // Agent name and character
  'SOUL.md',       // Personality and behavioral boundaries
  'TOOLS.md',      // User guidance on tool usage
  'USER.md',       // User profile information
] as const;

export type BootstrapFileName = (typeof BOOTSTRAP_FILES)[number];

export interface BootstrapConfig {
  /** Maximum characters per file (default: 20000) */
  maxFileSize: number;
  /** Workspace directory path */
  workspacePath: string;
  /** Which files to load (default: all standard files) */
  files: readonly string[];
}

export interface BootstrapFile {
  /** File name */
  name: string;
  /** File content (potentially truncated) */
  content: string;
  /** Whether the file was truncated */
  truncated: boolean;
  /** Original size before truncation */
  originalSize: number;
}

export interface BootstrapResult {
  /** Successfully loaded files */
  files: BootstrapFile[];
  /** Combined content for injection */
  combined: string;
  /** Workspace path used */
  workspacePath: string;
}

const DEFAULT_MAX_FILE_SIZE = 20000;

/**
 * Get the default workspace path
 */
export function getDefaultWorkspacePath(): string {
  return join(homedir(), '.casterly', 'workspace');
}

/**
 * Get all possible workspace paths in order of priority
 */
export function getWorkspacePaths(): string[] {
  return [
    join(homedir(), '.casterly', 'workspace'),
    join(homedir(), 'Casterly', 'workspace'),
    join(process.cwd(), 'workspace'),
  ];
}

/**
 * Find the first existing workspace path
 */
export function findWorkspacePath(): string | undefined {
  for (const path of getWorkspacePaths()) {
    if (existsSync(path)) {
      return path;
    }
  }
  return undefined;
}

/**
 * Load a single bootstrap file
 */
export function loadBootstrapFile(
  filePath: string,
  maxSize: number = DEFAULT_MAX_FILE_SIZE
): BootstrapFile | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const originalSize = content.length;

    // Skip empty files
    if (content.trim().length === 0) {
      return undefined;
    }

    // Truncate if needed
    let finalContent = content;
    let truncated = false;

    if (content.length > maxSize) {
      finalContent = content.substring(0, maxSize);
      // Try to truncate at a newline for cleaner output
      const lastNewline = finalContent.lastIndexOf('\n');
      if (lastNewline > maxSize * 0.8) {
        finalContent = finalContent.substring(0, lastNewline);
      }
      finalContent += '\n\n[... truncated ...]';
      truncated = true;
    }

    return {
      name: filePath.split('/').pop() || filePath,
      content: finalContent.trim(),
      truncated,
      originalSize,
    };
  } catch {
    return undefined;
  }
}

/**
 * Load all bootstrap files from a workspace
 */
export function loadBootstrapFiles(config?: Partial<BootstrapConfig>): BootstrapResult {
  const workspacePath = config?.workspacePath ?? findWorkspacePath() ?? getDefaultWorkspacePath();
  const maxFileSize = config?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const fileNames = config?.files ?? BOOTSTRAP_FILES;

  const files: BootstrapFile[] = [];

  for (const fileName of fileNames) {
    const filePath = join(workspacePath, fileName);
    const file = loadBootstrapFile(filePath, maxFileSize);
    if (file) {
      files.push(file);
    }
  }

  // Combine files with headers
  const combined = files
    .map((file) => {
      const truncateNote = file.truncated ? ' (truncated)' : '';
      return `## ${file.name}${truncateNote}\n\n${file.content}`;
    })
    .join('\n\n---\n\n');

  return {
    files,
    combined,
    workspacePath,
  };
}

/**
 * Format bootstrap content for injection into system prompt
 */
export function formatBootstrapSection(result: BootstrapResult): string {
  if (result.files.length === 0) {
    return '';
  }

  return `# Project Context

The following workspace files define your identity and guidelines:

${result.combined}`;
}
