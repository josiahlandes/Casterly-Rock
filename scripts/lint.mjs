import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['src', 'tests'];
const ALLOWED_CONSOLE_LOG_FILES = new Set([
  'src/logging/safe-logger.ts',
  'src/interfaces/cli.ts',
  'src/index.ts',
  'src/test-cli.ts',
  'src/autonomous/loop.ts'  // Daemon needs to log output
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

const violations = [];

for (const root of ROOTS) {
  for (const file of walk(join(process.cwd(), root))) {
    const rel = relative(process.cwd(), file);
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');

    if (content.includes('@ts-ignore')) {
      violations.push(`${rel}: contains @ts-ignore`);
    }

    if (content.includes('console.log') && !ALLOWED_CONSOLE_LOG_FILES.has(rel)) {
      violations.push(`${rel}: contains console.log outside safe logger`);
    }

    lines.forEach((line, index) => {
      if (/\s+$/.test(line)) {
        violations.push(`${rel}:${index + 1} trailing whitespace`);
      }
    });
  }
}

if (violations.length === 0) {
  console.log('[lint] Lint checks passed.');
  process.exit(0);
}

console.error('[lint] Lint violations found:');
for (const violation of violations) {
  console.error(`  - ${violation}`);
}
process.exit(1);
