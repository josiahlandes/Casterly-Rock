import { describe, expect, it, beforeEach } from 'vitest';

import { MemoryChecker, createMemoryChecker } from '../src/autonomous/memory/checker.js';
import type { ExistingKnowledge } from '../src/autonomous/memory/checker.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

beforeEach(() => {
  resetTracer();
  initTracer({ enabled: false });
});

function makeKnowledge(overrides: Partial<ExistingKnowledge> = {}): ExistingKnowledge {
  return {
    id: 'existing-1',
    content: 'Tests in this repo use Vitest with the vi.fn() mock pattern',
    ...overrides,
  };
}

describe('MemoryChecker', () => {
  describe('check — passing', () => {
    it('approves novel, relevant, safe content', () => {
      const checker = createMemoryChecker();
      const verdict = checker.check(
        { content: 'The provider interface enforces a stable contract with explicit timeouts and retries' },
        [makeKnowledge()],
      );

      expect(verdict.approved).toBe(true);
      expect(verdict.compositeScore).toBeGreaterThan(0.5);
    });
  });

  describe('check — duplicate detection', () => {
    it('rejects exact duplicates', () => {
      const checker = createMemoryChecker();
      const verdict = checker.check(
        { content: 'Tests in this repo use Vitest with the vi.fn() mock pattern' },
        [makeKnowledge()],
      );

      expect(verdict.approved).toBe(false);
      const dupCheck = verdict.checks.find((c) => c.check === 'duplicate');
      expect(dupCheck?.verdict).toBe('fail');
    });
  });

  describe('check — safety', () => {
    it('rejects content with sensitive data patterns', () => {
      const checker = createMemoryChecker();

      const verdict = checker.check(
        { content: 'The API key is: sk-abc123def456ghi789jklmnop' },
        [],
      );

      expect(verdict.approved).toBe(false);
      const safetyCheck = verdict.checks.find((c) => c.check === 'safety');
      expect(safetyCheck?.verdict).toBe('fail');
    });

    it('rejects content with password patterns', () => {
      const checker = createMemoryChecker();
      const verdict = checker.check(
        { content: 'The database password = mysecretpassword123' },
        [],
      );

      expect(verdict.approved).toBe(false);
    });
  });

  describe('check — relevance', () => {
    it('rejects content that is too short', () => {
      const checker = createMemoryChecker();
      const verdict = checker.check({ content: 'ok' }, []);

      const relevanceCheck = verdict.checks.find((c) => c.check === 'relevance');
      expect(relevanceCheck?.verdict).toBe('fail');
    });
  });

  describe('check — consistency', () => {
    it('warns on potential contradictions', () => {
      const checker = createMemoryChecker();
      const verdict = checker.check(
        { content: 'Tests in this repo do not use Vitest anymore' },
        [makeKnowledge({ content: 'Tests in this repo use Vitest with the vi.fn() mock pattern' })],
      );

      const consistencyCheck = verdict.checks.find((c) => c.check === 'consistency');
      expect(consistencyCheck?.verdict).toBe('warn');
    });
  });

  describe('configurable checks', () => {
    it('allows disabling specific checks', () => {
      const checker = createMemoryChecker({
        enabledChecks: {
          consistency: false,
          relevance: true,
          duplicate: false,
          freshness: false,
          safety: true,
        },
      });

      const verdict = checker.check({ content: 'Valid content about TypeScript patterns' }, []);
      const checkNames = verdict.checks.map((c) => c.check);

      expect(checkNames).toContain('relevance');
      expect(checkNames).toContain('safety');
      expect(checkNames).not.toContain('consistency');
      expect(checkNames).not.toContain('duplicate');
    });
  });
});
