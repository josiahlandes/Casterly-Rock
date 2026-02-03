import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_ROOT = join(process.cwd(), 'src');
const ALLOWED_CONSOLE_LOG_FILES = new Set([
  'src/logging/safe-logger.ts',
  'src/interfaces/cli.ts',
  'src/index.ts',
  'src/test-cli.ts'
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

runNpmAudit();
scanConsoleLogs();
console.log('[security] Security scan passed.');
