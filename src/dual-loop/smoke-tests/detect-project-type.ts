/**
 * Project Type Detection — Infers project type from the workspace manifest
 * and filesystem to select appropriate verification gates and smoke tests.
 *
 * Priority: web > node-cli > python > typescript > generic.
 * Web takes priority over typescript because web projects often contain .ts files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileOperation } from '../task-board-types.js';
import type { ProjectType } from './types.js';

/**
 * Detect the project type from the workspace manifest and project directory.
 *
 * @param manifest - Files created/modified during implementation
 * @param projectDirAbsolute - Absolute path to the project directory
 */
export function detectProjectType(
  manifest: FileOperation[],
  projectDirAbsolute: string,
): ProjectType {
  const extensions = new Set(
    manifest.map((f) => {
      const dot = f.path.lastIndexOf('.');
      return dot >= 0 ? f.path.slice(dot).toLowerCase() : '';
    }),
  );

  const filenames = new Set(
    manifest.map((f) => {
      const slash = f.path.lastIndexOf('/');
      return slash >= 0 ? f.path.slice(slash + 1) : f.path;
    }),
  );

  // 1. Web: has .html files or index.html on disk
  if (
    extensions.has('.html') ||
    filenames.has('index.html') ||
    existsSync(join(projectDirAbsolute, 'index.html'))
  ) {
    return 'web';
  }

  // 2. Node CLI: package.json with bin field
  const pkgPath = join(projectDirAbsolute, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
      if (pkg['bin']) {
        return 'node-cli';
      }
    } catch {
      // Ignore malformed package.json
    }
  }

  // 3. Python: .py files in manifest or setup.py/pyproject.toml on disk
  if (
    extensions.has('.py') ||
    existsSync(join(projectDirAbsolute, 'setup.py')) ||
    existsSync(join(projectDirAbsolute, 'pyproject.toml'))
  ) {
    return 'python';
  }

  // 4. TypeScript: .ts/.tsx files in manifest or tsconfig.json on disk
  if (
    extensions.has('.ts') ||
    extensions.has('.tsx') ||
    existsSync(join(projectDirAbsolute, 'tsconfig.json'))
  ) {
    return 'typescript';
  }

  return 'generic';
}
