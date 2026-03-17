import { describe, expect, it } from 'vitest';
import { detectProjectType } from '../src/dual-loop/smoke-tests/detect-project-type.js';
import { buildIntentReviewPrompt, parseReviewResponse } from '../src/dual-loop/review-prompt.js';
import type { FileOperation } from '../src/dual-loop/task-board-types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// detectProjectType
// ═══════════════════════════════════════════════════════════════════════════════

describe('detectProjectType', () => {
  // Use a non-existent directory so filesystem checks (existsSync) return false —
  // detection relies purely on the manifest entries.
  const noDir = '/tmp/__nonexistent_smoke_test_dir__';

  it('detects web project from .html manifest', () => {
    const manifest: FileOperation[] = [
      { path: 'index.html', action: 'created' },
      { path: 'js/main.js', action: 'created' },
    ];
    expect(detectProjectType(manifest, noDir)).toBe('web');
  });

  it('detects python project from .py manifest', () => {
    const manifest: FileOperation[] = [
      { path: 'main.py', action: 'created' },
      { path: 'utils.py', action: 'created' },
    ];
    expect(detectProjectType(manifest, noDir)).toBe('python');
  });

  it('detects typescript project from .ts manifest', () => {
    const manifest: FileOperation[] = [
      { path: 'src/index.ts', action: 'created' },
      { path: 'src/types.ts', action: 'created' },
    ];
    expect(detectProjectType(manifest, noDir)).toBe('typescript');
  });

  it('returns generic for empty manifest with no files on disk', () => {
    expect(detectProjectType([], noDir)).toBe('generic');
  });

  it('web takes priority over typescript when both .html and .ts exist', () => {
    const manifest: FileOperation[] = [
      { path: 'index.html', action: 'created' },
      { path: 'src/app.ts', action: 'created' },
    ];
    expect(detectProjectType(manifest, noDir)).toBe('web');
  });

  it('web takes priority over python', () => {
    const manifest: FileOperation[] = [
      { path: 'index.html', action: 'created' },
      { path: 'server.py', action: 'created' },
    ];
    expect(detectProjectType(manifest, noDir)).toBe('web');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildIntentReviewPrompt
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildIntentReviewPrompt', () => {
  it('includes original request, plan, and manifest', () => {
    const result = buildIntentReviewPrompt({
      originalMessage: 'Build a calculator',
      plan: 'Create add/subtract functions',
      manifest: [
        { path: 'src/calc.ts', action: 'created', lines: 50 },
        { path: 'src/index.ts', action: 'modified', lines: 10 },
      ],
    });

    expect(result).toContain('Build a calculator');
    expect(result).toContain('Create add/subtract functions');
    expect(result).toContain('src/calc.ts');
    expect(result).toContain('src/index.ts');
    expect(result).toContain('create');
  });

  it('does NOT include file contents (reviewer reads via tools)', () => {
    const result = buildIntentReviewPrompt({
      plan: 'Some plan',
      manifest: [
        { path: 'src/calc.ts', action: 'created', lines: 50 },
      ],
    });

    // Should not contain any code blocks or file content
    expect(result).not.toContain('```');
    expect(result).not.toContain('function ');
  });

  it('includes project directory when provided', () => {
    const result = buildIntentReviewPrompt({
      plan: 'Build something',
      manifest: [],
      projectDir: 'projects/my-app',
    });

    expect(result).toContain('projects/my-app');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseReviewResponse
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseReviewResponse', () => {
  it('parses valid JSON response', () => {
    const response = JSON.stringify({
      result: 'approved',
      notes: 'Code looks good',
    });
    const outcome = parseReviewResponse(response);
    expect(outcome.result).toBe('approved');
    expect(outcome.notes).toBe('Code looks good');
  });

  it('parses changes_requested with feedback', () => {
    const response = JSON.stringify({
      result: 'changes_requested',
      notes: 'Missing edge case',
      feedback: 'Handle null input in calculate()',
    });
    const outcome = parseReviewResponse(response);
    expect(outcome.result).toBe('changes_requested');
    expect(outcome.feedback).toBe('Handle null input in calculate()');
  });

  it('handles <think> tags from reasoner (thinking ON)', () => {
    const response = `<think>
Let me review this code carefully...
The implementation looks correct but I need to check edge cases.
</think>
{"result": "approved", "notes": "Implementation matches intent"}`;
    const outcome = parseReviewResponse(response);
    expect(outcome.result).toBe('approved');
    expect(outcome.notes).toBe('Implementation matches intent');
  });

  it('defaults to approved on parse failure', () => {
    const outcome = parseReviewResponse('This is not JSON at all');
    expect(outcome.result).toBe('approved');
    expect(outcome.notes).toContain('parse failure');
  });

  it('defaults to approved on empty response', () => {
    const outcome = parseReviewResponse('');
    expect(outcome.result).toBe('approved');
  });
});
