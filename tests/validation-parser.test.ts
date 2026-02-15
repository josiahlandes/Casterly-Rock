import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseFile, parseFiles } from '../src/coding/validation/parser.js';

// ─── Temp dir helpers ────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-parser-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function writeTestFile(name: string, content: string): string {
  mkdirSync(TEST_BASE, { recursive: true });
  const filePath = join(TEST_BASE, name);
  writeFileSync(filePath, content);
  return filePath;
}

// ═══════════════════════════════════════════════════════════════════════════════
// parseFile — JSON
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseFile — JSON', () => {
  it('validates correct JSON', async () => {
    const path = writeTestFile('good.json', '{"name": "test", "value": 42}');
    const result = await parseFile(path);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.parser).toBe('json');
  });

  it('detects invalid JSON', async () => {
    const path = writeTestFile('bad.json', '{"name": "test",}');
    const result = await parseFile(path);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.severity).toBe('error');
    expect(result.parser).toBe('json');
  });

  it('includes line/column for JSON errors when available', async () => {
    const path = writeTestFile('lines.json', '{\n  "a": 1,\n  bad\n}');
    const result = await parseFile(path);
    expect(result.valid).toBe(false);
    // Error should have line info
    expect(result.errors[0]!.message).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseFile — YAML
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseFile — YAML', () => {
  it('validates correct YAML', async () => {
    const path = writeTestFile('good.yaml', 'name: test\nvalue: 42\n');
    const result = await parseFile(path);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.parser).toBe('yaml');
  });

  it('validates .yml extension', async () => {
    const path = writeTestFile('good.yml', 'key: value\n');
    const result = await parseFile(path);
    expect(result.valid).toBe(true);
    expect(result.parser).toBe('yaml');
  });

  it('detects invalid YAML', async () => {
    const path = writeTestFile('bad.yaml', 'key: value\n  bad indent:\n- misplaced');
    const result = await parseFile(path);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseFile — TypeScript/JavaScript
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseFile — TypeScript', () => {
  it('validates correct TypeScript', async () => {
    const path = writeTestFile('good.ts', `export function foo(x: number): string {
  return String(x);
}
`);
    const result = await parseFile(path);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.parser).toBe('typescript');
  });

  it('detects unmatched opening brace', async () => {
    const path = writeTestFile('unclosed.ts', `function foo() {
  if (true) {
    console.log("hello");
  // missing closing brace
}
`);
    const result = await parseFile(path);
    expect(result.valid).toBe(false);
    const bracketError = result.errors.find(
      (e) => e.code === 'UNCLOSED_BRACKET' || e.code === 'MISMATCHED_BRACKET',
    );
    expect(bracketError).toBeDefined();
  });

  it('detects unmatched closing brace', async () => {
    const path = writeTestFile('extra-close.ts', `function foo() {
}
}
`);
    const result = await parseFile(path);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'UNMATCHED_BRACKET')).toBe(true);
  });

  it('handles valid code with strings containing brackets', async () => {
    const path = writeTestFile('string-brackets.ts', `const x = "{ not a real bracket }";
const y = '[ also fine ]';
`);
    const result = await parseFile(path);
    expect(result.valid).toBe(true);
  });

  it('handles valid code with comments containing brackets', async () => {
    const path = writeTestFile('comment-brackets.ts', `// { this is a comment }
/* [ and this too ] */
function foo() {
  return 42;
}
`);
    const result = await parseFile(path);
    expect(result.valid).toBe(true);
  });
});

describe('parseFile — JavaScript', () => {
  it('validates correct JavaScript', async () => {
    const path = writeTestFile('good.js', `function hello() {
  console.log("world");
}
`);
    const result = await parseFile(path);
    expect(result.valid).toBe(true);
    expect(result.parser).toBe('javascript');
  });

  it('validates .mjs extension', async () => {
    const path = writeTestFile('module.mjs', `export const x = 42;
`);
    const result = await parseFile(path);
    expect(result.valid).toBe(true);
    expect(result.parser).toBe('javascript');
  });

  it('validates .cjs extension', async () => {
    const path = writeTestFile('common.cjs', `module.exports = { x: 42 };
`);
    const result = await parseFile(path);
    expect(result.valid).toBe(true);
    expect(result.parser).toBe('javascript');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseFile — Unknown / Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseFile — unknown extensions', () => {
  it('treats unknown file types as valid', async () => {
    const path = writeTestFile('readme.md', '# Hello');
    const result = await parseFile(path);
    expect(result.valid).toBe(true);
    expect(result.parser).toBe('none');
  });
});

describe('parseFile — file not found', () => {
  it('returns error for nonexistent file', async () => {
    const result = await parseFile('/nonexistent/file.json');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toContain('Failed to read file');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseFiles (batch)
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseFiles', () => {
  it('returns passed for valid files', async () => {
    const p1 = writeTestFile('a.json', '{"ok": true}');
    const p2 = writeTestFile('b.ts', 'export const x = 1;\n');
    const result = await parseFiles([p1, p2]);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.step).toBe('parse');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns failed when any file has errors', async () => {
    const p1 = writeTestFile('ok.json', '{"ok": true}');
    const p2 = writeTestFile('bad.json', '{invalid}');
    const result = await parseFiles([p1, p2]);
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns passed for empty file list', async () => {
    const result = await parseFiles([]);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
