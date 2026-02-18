import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_ROOT = join(process.cwd(), 'src');
const ALLOWED_CONSOLE_LOG_FILES = new Set([
  'src/logging/safe-logger.ts',
  'src/interfaces/cli.ts',
  'src/index.ts',
  'src/test-cli.ts',
  'src/autonomous/loop.ts',  // Daemon needs to log output
  'src/benchmark-cli.ts',    // Benchmark CLI needs console output
  'src/terminal-repl.ts',    // Terminal REPL needs console output
  'src/autonomous/debug.ts'  // Debug tracer applies redaction before console output
]);

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }

    if (fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

function runNpmAudit() {
  try {
    execSync('npm audit --audit-level=high', { stdio: 'inherit' });
  } catch (error) {
    console.error('[security] npm audit reported high-severity vulnerabilities.');
    process.exit(1);
  }
}

function scanConsoleLogs() {
  const violations = [];

  for (const file of walk(SRC_ROOT)) {
    const rel = relative(process.cwd(), file);
    const content = readFileSync(file, 'utf8');

    if (!content.includes('console.log')) {
      continue;
    }

    if (!ALLOWED_CONSOLE_LOG_FILES.has(rel)) {
      violations.push(rel);
    }
  }

  if (violations.length === 0) {
    console.log('[security] No disallowed console.log usage found.');
    return;
  }

  console.error('[security] Disallowed console.log usage detected in:');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  console.error('[security] Route logging through src/logging/safe-logger.ts instead.');
  process.exit(1);
}

// ── Dangerous shell patterns ────────────────────────────────────────────────
// Detects unsanitized exec/execSync calls that could allow command injection.
// Safe alternatives: execFile/execFileAsync (no shell), or validated inputs.

const SHELL_INJECTION_PATTERNS = [
  // Template literal interpolation inside exec/execSync calls
  /exec\w*\(\s*`[^`]*\$\{/,
  // String concatenation inside exec/execSync calls
  /exec\w*\([^)]*\+\s*\w/,
];

const SHELL_INJECTION_ALLOWLIST = new Set([
  // Validator runs trusted invariant commands from config, not user input
  'src/autonomous/validator.ts',
  // These modules use exec with controlled internal values, not user input
  'src/autonomous/analyzer.ts',
  'src/autonomous/git.ts',
  'src/imessage/reader.ts',
  'src/imessage/sender.ts',
  'src/skills/loader.ts',
  'src/tools/executors/calendar-read.ts',
  'src/tools/executors/reminder-create.ts',
]);

function scanShellInjection() {
  const violations = [];

  for (const file of walk(SRC_ROOT)) {
    const rel = relative(process.cwd(), file);
    if (SHELL_INJECTION_ALLOWLIST.has(rel)) continue;

    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of SHELL_INJECTION_PATTERNS) {
        if (pattern.test(line)) {
          violations.push(`${rel}:${i + 1} potential shell injection — use execFile() or validate input`);
        }
      }
    }
  }

  if (violations.length === 0) {
    console.log('[security] No shell injection patterns found.');
    return;
  }

  console.error('[security] Shell injection risks detected:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

// ── CJS require() in ESM project ───────────────────────────────────────────
// This project uses ESM ("type": "module"). require() calls break consistency
// and can cause runtime failures. Use import/import() instead.

function scanCjsRequire() {
  const violations = [];

  for (const file of walk(SRC_ROOT)) {
    const rel = relative(process.cwd(), file);
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match require() calls but not comments or strings describing require
      if (/(?<!\/)(?<!\/\/.*)require\s*\(/.test(line) && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*')) {
        violations.push(`${rel}:${i + 1} uses require() — use ESM import instead`);
      }
    }
  }

  if (violations.length === 0) {
    console.log('[security] No CJS require() usage found.');
    return;
  }

  console.error('[security] CJS require() detected in ESM project:');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

// ── Orphaned source files ──────────────────────────────────────────────────
// New src/ files must be imported by at least one other file. Orphaned files
// indicate the agent generated code without wiring it in.

function scanOrphanedFiles() {
  const allSrcFiles = walk(SRC_ROOT);
  const allFiles = [...allSrcFiles];

  // Also scan tests/ for imports
  const testsRoot = join(process.cwd(), 'tests');
  try { allFiles.push(...walk(testsRoot)); } catch { /* tests dir may not exist */ }

  // Build a set of all file basenames and relative paths for import resolution
  const allContent = new Map();
  for (const file of allFiles) {
    allContent.set(file, readFileSync(file, 'utf8'));
  }

  // Only check src/ files that were added in the current diff (git-tracked new files)
  let newFiles = [];
  try {
    const diff = execSync('git diff HEAD~1 --name-only --diff-filter=A', { encoding: 'utf8' });
    newFiles = diff.trim().split('\n').filter((f) => f.startsWith('src/') && f.endsWith('.ts'));
  } catch {
    // If git diff fails (e.g., initial commit), skip orphan check
    console.log('[security] Orphan check skipped (no git diff baseline).');
    return;
  }

  if (newFiles.length === 0) {
    console.log('[security] No new src/ files to check for orphans.');
    return;
  }

  // index.ts and barrel files are entry points, not orphans
  const entryPatterns = [/index\.ts$/, /cli\.ts$/, /repl\.ts$/, /daemon\.ts$/];

  const orphans = [];
  for (const newFile of newFiles) {
    if (entryPatterns.some((p) => p.test(newFile))) continue;

    // Derive the import path variants that would reference this file
    const withoutExt = newFile.replace(/\.ts$/, '');
    const withJsExt = withoutExt + '.js';
    const importVariants = [withoutExt, withJsExt, newFile];

    // Check if any other file imports this one
    let imported = false;
    for (const [otherFile, content] of allContent) {
      const otherRel = relative(process.cwd(), otherFile);
      if (otherRel === newFile) continue; // Don't count self-references

      for (const variant of importVariants) {
        // Check for relative imports or bare path references
        if (content.includes(variant) || content.includes('./' + variant) || content.includes('../' + variant)) {
          imported = true;
          break;
        }
      }
      if (imported) break;
    }

    if (!imported) {
      orphans.push(newFile);
    }
  }

  if (orphans.length === 0) {
    console.log('[security] No orphaned new files detected.');
    return;
  }

  console.error('[security] Orphaned files detected (new files not imported anywhere):');
  for (const o of orphans) {
    console.error(`  - ${o}`);
  }
  console.error('[security] New source files must be imported by at least one other module.');
  process.exit(1);
}

runNpmAudit();
scanConsoleLogs();
scanShellInjection();
scanCjsRequire();
scanOrphanedFiles();
console.log('[security] Security scan passed.');
