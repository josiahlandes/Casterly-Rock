import { execSync } from 'node:child_process';

const PROTECTED_PREFIXES = [
  'docs/rulebook.md',
  'docs/subagents.md',
  'src/security/',
  'src/router/classifier.ts',
  'src/providers/',
  'config/',
  '.env',
  '.env.',
  'scripts/guardrails.mjs'
];

function isProtected(filePath) {
  return PROTECTED_PREFIXES.some((prefix) =>
    prefix.endsWith('/') ? filePath.startsWith(prefix) : filePath === prefix || filePath.startsWith(prefix)
  );
}

function getChangedFiles() {
  try {
    const unstaged = execSync('git diff --name-only --diff-filter=ACMRTUXB', {
      stdio: ['ignore', 'pipe', 'pipe']
    })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);

    const staged = execSync('git diff --cached --name-only --diff-filter=ACMRTUXB', {
      stdio: ['ignore', 'pipe', 'pipe']
    })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);

    return [...new Set([...unstaged, ...staged])];
  } catch (error) {
    console.log('[guardrails] Git diff unavailable; skipping protected-path checks.');
    return null;
  }
}

const changedFiles = getChangedFiles();

if (!changedFiles) {
  process.exit(0);
}

const protectedChanges = changedFiles.filter(isProtected);

if (protectedChanges.length === 0) {
  console.log('[guardrails] No protected paths changed.');
  process.exit(0);
}

if (process.env.ALLOW_PROTECTED_CHANGES === '1') {
  console.log('[guardrails] Protected changes allowed by ALLOW_PROTECTED_CHANGES=1.');
  console.log('[guardrails] Protected files changed:');
  for (const file of protectedChanges) {
    console.log(`  - ${file}`);
  }
  process.exit(0);
}

console.error('[guardrails] Protected paths were modified:');
for (const file of protectedChanges) {
  console.error(`  - ${file}`);
}
console.error('[guardrails] Set ALLOW_PROTECTED_CHANGES=1 only when you intend to change these files.');
process.exit(1);
