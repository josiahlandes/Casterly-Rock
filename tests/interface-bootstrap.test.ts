import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  BOOTSTRAP_FILES,
  getDefaultWorkspacePath,
  getWorkspacePaths,
  loadBootstrapFile,
  loadBootstrapFiles,
  clearBootstrapCache,
  formatBootstrapSection,
  type BootstrapResult,
} from '../src/interface/bootstrap.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-bootstrap-test-${Date.now()}`);

afterEach(() => {
  clearBootstrapCache();
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

describe('BOOTSTRAP_FILES', () => {
  it('defines standard bootstrap files', () => {
    expect(BOOTSTRAP_FILES).toContain('IDENTITY.md');
    expect(BOOTSTRAP_FILES).toContain('SOUL.md');
    expect(BOOTSTRAP_FILES).toContain('TOOLS.md');
    expect(BOOTSTRAP_FILES).toContain('USER.md');
    expect(BOOTSTRAP_FILES).toHaveLength(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Path helpers
// ═══════════════════════════════════════════════════════════════════════════════

describe('getDefaultWorkspacePath', () => {
  it('returns a path ending with .casterly/workspace', () => {
    const path = getDefaultWorkspacePath();
    expect(path).toContain('.casterly');
    expect(path).toContain('workspace');
  });
});

describe('getWorkspacePaths', () => {
  it('returns multiple search paths', () => {
    const paths = getWorkspacePaths();
    expect(paths.length).toBeGreaterThanOrEqual(3);
    // First should be .casterly/workspace
    expect(paths[0]).toContain('.casterly');
    expect(paths[0]).toContain('workspace');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// loadBootstrapFile
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadBootstrapFile', () => {
  it('returns undefined for nonexistent file', () => {
    expect(loadBootstrapFile('/nonexistent/file.md')).toBeUndefined();
  });

  it('loads existing file', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const filePath = join(TEST_BASE, 'TEST.md');
    writeFileSync(filePath, 'Hello bootstrap');

    const result = loadBootstrapFile(filePath);
    expect(result).toBeDefined();
    expect(result!.content).toBe('Hello bootstrap');
    expect(result!.name).toBe('TEST.md');
    expect(result!.truncated).toBe(false);
    expect(result!.originalSize).toBe(15);
  });

  it('returns undefined for empty file', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const filePath = join(TEST_BASE, 'EMPTY.md');
    writeFileSync(filePath, '   \n  \n');

    expect(loadBootstrapFile(filePath)).toBeUndefined();
  });

  it('truncates long files', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const filePath = join(TEST_BASE, 'LONG.md');
    // Create content with newlines — truncation tries to break at newline
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${'x'.repeat(50)}`);
    writeFileSync(filePath, lines.join('\n'));

    const result = loadBootstrapFile(filePath, 100);
    expect(result).toBeDefined();
    expect(result!.truncated).toBe(true);
    expect(result!.content).toContain('[... truncated ...]');
    expect(result!.originalSize).toBeGreaterThan(100);
  });

  it('truncates at newline boundary when possible', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    const filePath = join(TEST_BASE, 'NEWLINE.md');
    // Create content where there's a newline near the 80% mark of maxSize
    const content = 'A'.repeat(85) + '\n' + 'B'.repeat(20);
    writeFileSync(filePath, content);

    const result = loadBootstrapFile(filePath, 100);
    expect(result).toBeDefined();
    expect(result!.truncated).toBe(true);
    // Should truncate at the newline (position 85) since 85 > 100*0.8
    expect(result!.content).not.toContain('B');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// loadBootstrapFiles
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadBootstrapFiles', () => {
  it('returns empty files array when workspace does not exist', () => {
    const result = loadBootstrapFiles({ workspacePath: '/nonexistent/workspace' });
    expect(result.files).toEqual([]);
    expect(result.combined).toBe('');
    expect(result.workspacePath).toBe('/nonexistent/workspace');
  });

  it('loads files from workspace', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, 'IDENTITY.md'), 'You are Tyrion');
    writeFileSync(join(TEST_BASE, 'SOUL.md'), 'Be helpful');

    const result = loadBootstrapFiles({ workspacePath: TEST_BASE });
    expect(result.files).toHaveLength(2);
    expect(result.files[0]!.name).toBe('IDENTITY.md');
    expect(result.files[1]!.name).toBe('SOUL.md');
    expect(result.workspacePath).toBe(TEST_BASE);
  });

  it('combines files with headers and separators', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, 'IDENTITY.md'), 'Agent identity');
    writeFileSync(join(TEST_BASE, 'SOUL.md'), 'Agent soul');

    const result = loadBootstrapFiles({ workspacePath: TEST_BASE });
    expect(result.combined).toContain('## IDENTITY.md');
    expect(result.combined).toContain('Agent identity');
    expect(result.combined).toContain('---');
    expect(result.combined).toContain('## SOUL.md');
    expect(result.combined).toContain('Agent soul');
  });

  it('marks truncated files in combined output', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, 'IDENTITY.md'), 'x'.repeat(200));

    const result = loadBootstrapFiles({ workspacePath: TEST_BASE, maxFileSize: 50 });
    expect(result.combined).toContain('(truncated)');
  });

  it('respects custom file list', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, 'CUSTOM.md'), 'Custom content');

    const result = loadBootstrapFiles({
      workspacePath: TEST_BASE,
      files: ['CUSTOM.md'],
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.name).toBe('CUSTOM.md');
  });

  it('skips missing files gracefully', () => {
    mkdirSync(TEST_BASE, { recursive: true });
    writeFileSync(join(TEST_BASE, 'IDENTITY.md'), 'Found');
    // SOUL.md, TOOLS.md, USER.md do not exist

    const result = loadBootstrapFiles({ workspacePath: TEST_BASE });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.name).toBe('IDENTITY.md');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatBootstrapSection
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatBootstrapSection', () => {
  it('returns empty string for no files', () => {
    const result: BootstrapResult = {
      files: [],
      combined: '',
      workspacePath: TEST_BASE,
    };
    expect(formatBootstrapSection(result)).toBe('');
  });

  it('wraps combined content with Project Context header', () => {
    const result: BootstrapResult = {
      files: [{ name: 'IDENTITY.md', content: 'Agent', truncated: false, originalSize: 5 }],
      combined: '## IDENTITY.md\n\nAgent',
      workspacePath: TEST_BASE,
    };
    const formatted = formatBootstrapSection(result);
    expect(formatted).toContain('# Project Context');
    expect(formatted).toContain('workspace files define your identity');
    expect(formatted).toContain('## IDENTITY.md');
    expect(formatted).toContain('Agent');
  });
});
