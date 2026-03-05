/**
 * Validate Project Executor
 *
 * Static analysis tool that validates cross-file API consistency for a
 * project directory. Checks imports, exports, method calls, and detects
 * uncaptured return values.
 */

import { glob } from 'glob';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateProjectAPIs, detectUncapturedReturns } from '../static-analysis.js';
import type { NativeToolCall, NativeToolResult } from '../schemas/types.js';

export const VALIDATE_PROJECT_SCHEMA = {
  name: 'validate_project',
  description:
    'Static analysis: validate cross-file API consistency (imports, exports, method calls, uncaptured returns).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      directory: {
        type: 'string' as const,
        description: 'Project directory to validate (relative to project root)',
      },
    },
    required: ['directory'],
  },
};

export async function executeValidateProject(
  call: NativeToolCall,
  projectRoot: string,
): Promise<NativeToolResult> {
  const directory = call.input['directory'];
  if (typeof directory !== 'string' || directory.trim() === '') {
    return {
      toolCallId: call.id,
      success: false,
      error: 'Invalid input: directory must be a non-empty string',
    };
  }

  const targetDir = resolve(projectRoot, directory);

  try {
    // 1. Glob for *.js and *.ts files in directory
    const filePaths = await glob('**/*.{js,ts,jsx,tsx}', {
      cwd: targetDir,
      nodir: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/coverage/**'],
    });

    if (filePaths.length === 0) {
      return {
        toolCallId: call.id,
        success: true,
        output: `No .js/.ts files found in ${directory}`,
      };
    }

    // 2. Read all files into a Map<relativePath, content>
    const files = new Map<string, string>();
    for (const relPath of filePaths) {
      try {
        const fullPath = resolve(targetDir, relPath);
        const content = await readFile(fullPath, 'utf8');
        // Use directory-relative paths (matching import resolution style)
        files.set(relPath, content);
      } catch {
        // Skip unreadable files
      }
    }

    if (files.size === 0) {
      return {
        toolCallId: call.id,
        success: true,
        output: `Found ${filePaths.length} files but none were readable`,
      };
    }

    // 3. Run validateProjectAPIs + detectUncapturedReturns
    const apiIssues = validateProjectAPIs(files);
    const returnIssues = detectUncapturedReturns(files);

    // 4. Format results
    const totalIssues = apiIssues.length + returnIssues.length;

    if (totalIssues === 0) {
      return {
        toolCallId: call.id,
        success: true,
        output: `Validated ${files.size} files in ${directory} — no issues found.`,
      };
    }

    const sections: string[] = [
      `Validated ${files.size} files in ${directory} — ${totalIssues} issue(s) found:`,
      '',
    ];

    if (apiIssues.length > 0) {
      sections.push(`## API Consistency (${apiIssues.length} issue(s))`);
      for (const issue of apiIssues.slice(0, 30)) {
        sections.push(`- ${issue}`);
      }
      if (apiIssues.length > 30) {
        sections.push(`... and ${apiIssues.length - 30} more`);
      }
      sections.push('');
    }

    if (returnIssues.length > 0) {
      sections.push(`## Uncaptured Returns (${returnIssues.length} issue(s))`);
      for (const issue of returnIssues.slice(0, 30)) {
        sections.push(`- ${issue}`);
      }
      if (returnIssues.length > 30) {
        sections.push(`... and ${returnIssues.length - 30} more`);
      }
    }

    return {
      toolCallId: call.id,
      success: true,
      output: sections.join('\n'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      toolCallId: call.id,
      success: false,
      error: `Validation failed: ${message}`,
    };
  }
}
