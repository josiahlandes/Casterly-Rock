import { describe, expect, it } from 'vitest';
import {
  TRIAGE_SYSTEM_PROMPT,
  buildTriagePrompt,
  parseTriageResponse,
} from '../src/dual-loop/triage-prompt.js';
import {
  REVIEW_SYSTEM_PROMPT,
  buildReviewPrompt,
  countDiffLines,
  parseReviewResponse,
} from '../src/dual-loop/review-prompt.js';
import type { TaskArtifact } from '../src/dual-loop/task-board-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Triage Prompt Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Triage Prompt', () => {
  describe('TRIAGE_SYSTEM_PROMPT', () => {
    it('is a non-empty string', () => {
      expect(TRIAGE_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    });

    it('mentions the three classifications', () => {
      expect(TRIAGE_SYSTEM_PROMPT).toContain('simple');
      expect(TRIAGE_SYSTEM_PROMPT).toContain('complex');
      expect(TRIAGE_SYSTEM_PROMPT).toContain('conversational');
    });
  });

  describe('buildTriagePrompt', () => {
    it('includes the sender, message, and task summary', () => {
      const prompt = buildTriagePrompt({
        message: 'Fix the login bug',
        sender: 'alice',
        taskBoardSummary: '(no active tasks)',
      });
      expect(prompt).toContain('alice');
      expect(prompt).toContain('Fix the login bug');
      expect(prompt).toContain('(no active tasks)');
    });
  });

  describe('parseTriageResponse', () => {
    it('parses valid JSON response', () => {
      const result = parseTriageResponse(JSON.stringify({
        classification: 'simple',
        confidence: 0.9,
        triageNotes: 'Easy question',
        directResponse: 'The answer is 42',
      }));

      expect(result.classification).toBe('simple');
      expect(result.confidence).toBe(0.9);
      expect(result.triageNotes).toBe('Easy question');
      expect(result.directResponse).toBe('The answer is 42');
    });

    it('defaults to complex on invalid JSON', () => {
      const result = parseTriageResponse('not json at all');
      expect(result.classification).toBe('complex');
      expect(result.confidence).toBe(0.0);
      expect(result.triageNotes).toContain('parse failure');
    });

    it('defaults to complex on missing classification', () => {
      const result = parseTriageResponse(JSON.stringify({
        confidence: 0.5,
      }));
      expect(result.classification).toBe('complex');
    });

    it('handles partial JSON gracefully', () => {
      const result = parseTriageResponse(JSON.stringify({
        classification: 'conversational',
      }));
      expect(result.classification).toBe('conversational');
      expect(result.confidence).toBe(0.5);
      expect(result.triageNotes).toBe('');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review Prompt Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Review Prompt', () => {
  describe('REVIEW_SYSTEM_PROMPT', () => {
    it('is a non-empty string', () => {
      expect(REVIEW_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    });

    it('mentions correctness and security', () => {
      expect(REVIEW_SYSTEM_PROMPT).toContain('Correctness');
      expect(REVIEW_SYSTEM_PROMPT).toContain('Security');
    });

    it('does NOT contain "When in doubt, approve"', () => {
      expect(REVIEW_SYSTEM_PROMPT).not.toContain('When in doubt, approve');
    });

    it('instructs to request changes when in doubt', () => {
      // The review prompt should bias toward caution, not rubber-stamping
      expect(REVIEW_SYSTEM_PROMPT).toContain('request changes');
    });
  });

  describe('buildReviewPrompt', () => {
    it('includes plan and artifacts', () => {
      const artifacts: TaskArtifact[] = [
        {
          type: 'file_diff',
          path: 'src/auth.ts',
          content: '+const isValid = true;',
          timestamp: new Date().toISOString(),
        },
      ];

      const prompt = buildReviewPrompt({
        plan: 'Fix the authentication check',
        artifacts,
      });

      expect(prompt).toContain('Fix the authentication check');
      expect(prompt).toContain('file_diff');
      expect(prompt).toContain('src/auth.ts');
      expect(prompt).toContain('+const isValid = true;');
    });

    it('handles artifacts without content', () => {
      const artifacts: TaskArtifact[] = [
        {
          type: 'commit',
          timestamp: new Date().toISOString(),
        },
      ];

      const prompt = buildReviewPrompt({ plan: 'Commit', artifacts });
      expect(prompt).toContain('(no content)');
    });
  });

  describe('countDiffLines', () => {
    it('counts lines in file_diff artifacts', () => {
      const artifacts: TaskArtifact[] = [
        { type: 'file_diff', content: 'line1\nline2\nline3', timestamp: '' },
        { type: 'file_diff', content: 'a\nb', timestamp: '' },
        { type: 'commit', content: 'ignored', timestamp: '' },
      ];
      expect(countDiffLines(artifacts)).toBe(5); // 3 + 2
    });

    it('returns 0 for no diffs', () => {
      expect(countDiffLines([])).toBe(0);
    });

    it('skips artifacts without content', () => {
      const artifacts: TaskArtifact[] = [
        { type: 'file_diff', timestamp: '' },
      ];
      expect(countDiffLines(artifacts)).toBe(0);
    });
  });

  describe('parseReviewResponse', () => {
    it('parses valid approved review', () => {
      const result = parseReviewResponse(JSON.stringify({
        result: 'approved',
        notes: 'Looks good',
      }));
      expect(result.result).toBe('approved');
      expect(result.notes).toBe('Looks good');
    });

    it('parses changes_requested with feedback', () => {
      const result = parseReviewResponse(JSON.stringify({
        result: 'changes_requested',
        notes: 'Missing validation',
        feedback: 'Add input validation in handleLogin()',
      }));
      expect(result.result).toBe('changes_requested');
      expect(result.feedback).toBe('Add input validation in handleLogin()');
    });

    it('defaults to approved on invalid JSON (prevents phantom rejection loops)', () => {
      const result = parseReviewResponse('garbage');
      expect(result.result).toBe('approved');
      expect(result.notes).toContain('parse failure');
    });
  });
});
