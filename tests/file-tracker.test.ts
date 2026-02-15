import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FileTracker } from '../src/coding/context-manager/file-tracker.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-tracker-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function writeTestFile(name: string, content: string): string {
  mkdirSync(join(TEST_BASE, 'src'), { recursive: true });
  const filePath = join(TEST_BASE, 'src', name);
  writeFileSync(filePath, content);
  return `src/${name}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FileTracker — construction
// ═══════════════════════════════════════════════════════════════════════════════

describe('FileTracker — construction', () => {
  it('starts with no tracked files', () => {
    const tracker = new FileTracker(TEST_BASE, 10000);
    expect(tracker.getFilePaths()).toEqual([]);
    expect(tracker.getTotalTokens()).toBe(0);
  });

  it('reports full remaining budget initially', () => {
    const tracker = new FileTracker(TEST_BASE, 5000);
    expect(tracker.getRemainingTokens()).toBe(5000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// addFile
// ═══════════════════════════════════════════════════════════════════════════════

describe('FileTracker — addFile', () => {
  it('adds a file and returns success', async () => {
    mkdirSync(join(TEST_BASE, 'src'), { recursive: true });
    const relPath = writeTestFile('hello.ts', 'export const x = 1;\n');
    const tracker = new FileTracker(TEST_BASE, 10000);

    const result = await tracker.addFile(relPath);
    expect(result.success).toBe(true);
    expect(result.tokens).toBeGreaterThan(0);
  });

  it('tracks the file after adding', async () => {
    const relPath = writeTestFile('tracked.ts', 'const a = 1;\n');
    const tracker = new FileTracker(TEST_BASE, 10000);

    await tracker.addFile(relPath);
    expect(tracker.isTracked(relPath)).toBe(true);
    expect(tracker.getFilePaths()).toContain(relPath);
  });

  it('caches file content', async () => {
    const relPath = writeTestFile('cached.ts', 'export function foo() {}\n');
    const tracker = new FileTracker(TEST_BASE, 10000);

    await tracker.addFile(relPath);
    const content = tracker.getFileContent(relPath);
    expect(content).toBeDefined();
    expect(content!.content).toContain('export function foo()');
  });

  it('updates access count on re-add', async () => {
    const relPath = writeTestFile('reaccess.ts', 'const x = 1;\n');
    const tracker = new FileTracker(TEST_BASE, 10000);

    await tracker.addFile(relPath);
    const result = await tracker.addFile(relPath);
    expect(result.success).toBe(true);

    const tracked = tracker.getTrackedFiles();
    expect(tracked[0]!.accessCount).toBe(2);
  });

  it('upgrades priority on re-add with higher priority', async () => {
    const relPath = writeTestFile('upgrade.ts', 'const x = 1;\n');
    const tracker = new FileTracker(TEST_BASE, 10000);

    await tracker.addFile(relPath, 'low');
    await tracker.addFile(relPath, 'high');

    const tracked = tracker.getTrackedFiles();
    expect(tracked[0]!.priority).toBe('high');
  });

  it('returns error for non-existent file', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const tracker = new FileTracker(TEST_BASE, 10000);

    const result = await tracker.addFile('src/nonexistent.ts');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to read file');
  });

  it('fails when file exceeds remaining budget', async () => {
    const relPath = writeTestFile('big.ts', 'x'.repeat(10000) + '\n');
    const tracker = new FileTracker(TEST_BASE, 5); // tiny budget

    const result = await tracker.addFile(relPath);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Not enough token budget');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// removeFile
// ═══════════════════════════════════════════════════════════════════════════════

describe('FileTracker — removeFile', () => {
  it('removes a tracked file', async () => {
    const relPath = writeTestFile('removable.ts', 'const x = 1;\n');
    const tracker = new FileTracker(TEST_BASE, 10000);

    await tracker.addFile(relPath);
    expect(tracker.removeFile(relPath)).toBe(true);
    expect(tracker.isTracked(relPath)).toBe(false);
  });

  it('returns false for non-tracked file', () => {
    const tracker = new FileTracker(TEST_BASE, 10000);
    expect(tracker.removeFile('not-tracked.ts')).toBe(false);
  });

  it('frees tokens when removing', async () => {
    const relPath = writeTestFile('free-tokens.ts', 'const y = 42;\n');
    const tracker = new FileTracker(TEST_BASE, 10000);

    await tracker.addFile(relPath);
    const usedBefore = tracker.getTotalTokens();
    expect(usedBefore).toBeGreaterThan(0);

    tracker.removeFile(relPath);
    expect(tracker.getTotalTokens()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Path normalization
// ═══════════════════════════════════════════════════════════════════════════════

describe('FileTracker — path normalization', () => {
  it('strips leading ./', async () => {
    const relPath = writeTestFile('normalize.ts', 'const x = 1;\n');
    const tracker = new FileTracker(TEST_BASE, 10000);

    await tracker.addFile(`./${relPath}`);
    expect(tracker.isTracked(relPath)).toBe(true);
  });

  it('converts absolute paths to relative', async () => {
    const relPath = writeTestFile('absolute.ts', 'const x = 1;\n');
    const absPath = join(TEST_BASE, relPath);
    const tracker = new FileTracker(TEST_BASE, 10000);

    await tracker.addFile(absPath);
    expect(tracker.isTracked(relPath)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// markModified / getModifiedFiles
// ═══════════════════════════════════════════════════════════════════════════════

describe('FileTracker — modifications', () => {
  it('marks a file as modified', async () => {
    const relPath = writeTestFile('modifiable.ts', 'let x = 1;\n');
    const tracker = new FileTracker(TEST_BASE, 10000);

    await tracker.addFile(relPath);
    tracker.markModified(relPath);

    expect(tracker.getModifiedFiles()).toContain(relPath);
  });

  it('returns empty modified list initially', () => {
    const tracker = new FileTracker(TEST_BASE, 10000);
    expect(tracker.getModifiedFiles()).toEqual([]);
  });

  it('does not mark non-tracked file', () => {
    const tracker = new FileTracker(TEST_BASE, 10000);
    tracker.markModified('nonexistent.ts');
    expect(tracker.getModifiedFiles()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// updateFile
// ═══════════════════════════════════════════════════════════════════════════════

describe('FileTracker — updateFile', () => {
  it('refreshes content from disk', async () => {
    const relPath = writeTestFile('refresh.ts', 'const v1 = 1;\n');
    const tracker = new FileTracker(TEST_BASE, 10000);

    await tracker.addFile(relPath);

    // Modify the file on disk
    writeFileSync(join(TEST_BASE, relPath), 'const v2 = 2; const extra = 3;\n');

    const result = await tracker.updateFile(relPath);
    expect(result.success).toBe(true);

    const content = tracker.getFileContent(relPath);
    expect(content!.content).toContain('v2');
    expect(content!.modified).toBe(true);
  });

  it('fails for non-tracked file', async () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const tracker = new FileTracker(TEST_BASE, 10000);

    const result = await tracker.updateFile('not-tracked.ts');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not tracked');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Priority sorting and eviction
// ═══════════════════════════════════════════════════════════════════════════════

describe('FileTracker — getFilesByPriority', () => {
  it('sorts by priority descending', async () => {
    const low = writeTestFile('low.ts', 'const l = 1;\n');
    const high = writeTestFile('high.ts', 'const h = 1;\n');
    const req = writeTestFile('req.ts', 'const r = 1;\n');
    const tracker = new FileTracker(TEST_BASE, 100000);

    await tracker.addFile(low, 'low');
    await tracker.addFile(high, 'high');
    await tracker.addFile(req, 'required');

    const sorted = tracker.getFilesByPriority();
    expect(sorted[0]!.priority).toBe('required');
    expect(sorted[sorted.length - 1]!.priority).toBe('low');
  });
});

describe('FileTracker — eviction', () => {
  it('evicts lower-priority files when budget is tight', async () => {
    // Create files with enough content to exceed a small budget together
    const lowFile = writeTestFile('low-evict.ts', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
    const highFile = writeTestFile('high-evict.ts', 'export const d = 4;\nexport const e = 5;\nexport const f = 6;\n');

    // First add the low-priority file to see how many tokens it uses
    const sizeTracker = new FileTracker(TEST_BASE, 100000);
    const sizeResult = await sizeTracker.addFile(lowFile);
    const fileTokens = sizeResult.tokens!;

    // Budget that fits one file but not two
    const tightBudget = Math.ceil(fileTokens * 1.5);
    const tracker = new FileTracker(TEST_BASE, tightBudget);

    // Add low-priority file first
    const lowResult = await tracker.addFile(lowFile, 'low');
    expect(lowResult.success).toBe(true);

    // Now add high-priority file that would exceed budget
    // The tracker should evict the low-priority file to make room
    const highResult = await tracker.addFile(highFile, 'high');
    expect(highResult.success).toBe(true);
    expect(tracker.isTracked(lowFile)).toBe(false);
    expect(tracker.isTracked(highFile)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// clear / setMaxTokens
// ═══════════════════════════════════════════════════════════════════════════════

describe('FileTracker — clear', () => {
  it('removes all tracked files', async () => {
    const file = writeTestFile('clearable.ts', 'const x = 1;\n');
    const tracker = new FileTracker(TEST_BASE, 10000);

    await tracker.addFile(file);
    tracker.clear();

    expect(tracker.getFilePaths()).toEqual([]);
    expect(tracker.getTotalTokens()).toBe(0);
  });
});

describe('FileTracker — setMaxTokens', () => {
  it('updates the max token budget', () => {
    const tracker = new FileTracker(TEST_BASE, 10000);
    tracker.setMaxTokens(20000);
    expect(tracker.getRemainingTokens()).toBe(20000);
  });
});
