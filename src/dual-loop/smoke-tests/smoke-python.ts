/**
 * Python Smoke Test (Phase 2) — Verifies that a Python script or package
 * can be imported/executed without crashing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { executeCommand } from '../../coding/validation/runner.js';
import type { FileOperation } from '../task-board-types.js';
import type { GateResult } from './types.js';

const PYTHON_TIMEOUT = 10_000;

/**
 * Detect the Python entry point from the manifest and project structure.
 */
function detectPythonEntry(
  projectDirAbs: string,
  manifest: FileOperation[],
): { mode: 'script'; path: string } | { mode: 'import'; module: string } | null {
  // Check for pyproject.toml with a module name
  const pyprojectPath = join(projectDirAbs, 'pyproject.toml');
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, 'utf8');
      const nameMatch = /^name\s*=\s*"([^"]+)"/m.exec(content);
      if (nameMatch?.[1]) {
        return { mode: 'import', module: nameMatch[1].replace(/-/g, '_') };
      }
    } catch {
      // Ignore
    }
  }

  // Look for a single .py file in the manifest
  const pyFiles = manifest.filter((f) => f.path.endsWith('.py'));
  if (pyFiles.length === 1) {
    return { mode: 'script', path: pyFiles[0]!.path };
  }

  // Common entry points
  for (const name of ['main.py', 'app.py', 'cli.py', '__main__.py']) {
    if (existsSync(join(projectDirAbs, name))) {
      return { mode: 'script', path: name };
    }
  }

  // Any .py file as a last resort
  if (pyFiles.length > 0) {
    return { mode: 'script', path: pyFiles[0]!.path };
  }

  return null;
}

/**
 * Run a Python smoke test by importing or executing the entry point.
 */
export async function runPythonSmokeTest(
  projectRoot: string,
  projectDir: string,
  manifest: FileOperation[],
): Promise<GateResult> {
  const projectDirAbs = resolve(projectRoot, projectDir);
  const entry = detectPythonEntry(projectDirAbs, manifest);

  if (!entry) {
    return {
      gate: 'python',
      passed: true,
      output: 'No Python entry point found — skipping',
      durationMs: 0,
      skipped: true,
    };
  }

  // Check that python3 is available
  const pythonCheck = await executeCommand('python3 --version', projectDirAbs, 5000);
  if (pythonCheck.exitCode !== 0) {
    return {
      gate: 'python',
      passed: true,
      output: 'python3 not available — skipping',
      durationMs: 0,
      skipped: true,
    };
  }

  let command: string;
  if (entry.mode === 'import') {
    command = `python3 -c "import ${entry.module}"`;
  } else {
    command = `python3 ${entry.path} --help`;
  }

  const result = await executeCommand(command, projectDirAbs, PYTHON_TIMEOUT);
  const output = (result.stdout + '\n' + result.stderr).trim();

  // For --help, exit code 0 or 1 is acceptable
  // For import, only exit code 0 is success
  const maxAllowedExit = entry.mode === 'script' ? 1 : 0;
  const passed = !result.timedOut && result.exitCode <= maxAllowedExit;

  return {
    gate: 'python',
    passed,
    output: result.timedOut ? 'Python execution timed out' : output,
    durationMs: result.durationMs,
  };
}
