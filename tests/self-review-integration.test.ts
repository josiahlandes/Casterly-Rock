import { describe, it, expect, vi } from 'vitest';
import { DeepLoop } from '../src/dual-loop/deep-loop.js';
import { parseReviewResponse, INTENT_REVIEW_SYSTEM_PROMPT } from '../src/dual-loop/review-prompt.js';
import type { LlmProvider } from '../src/providers/base.js';
import type { ConcurrentProvider } from '../src/providers/concurrent.js';
import type { TaskBoard } from '../src/dual-loop/task-board.js';
import type { EventBus } from '../src/autonomous/events.js';
import type { Task, FileOperation } from '../src/dual-loop/task-board-types.js';
import type { AgentToolkit } from '../src/autonomous/tools/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — minimal mocks
// ─────────────────────────────────────────────────────────────────────────────

function makeMockProvider(): LlmProvider {
  return {
    generate: vi.fn().mockResolvedValue(''),
    generateWithTools: vi.fn().mockResolvedValue({ text: '{}', toolCalls: [] }),
    chat: vi.fn().mockResolvedValue(''),
    name: 'mock-provider',
  } as unknown as LlmProvider;
}

function makeMockConcurrentProvider(): ConcurrentProvider {
  return {
    generate: vi.fn().mockResolvedValue(''),
    chat: vi.fn().mockResolvedValue(''),
    name: 'mock-concurrent',
  } as unknown as ConcurrentProvider;
}

function makeMockTaskBoard(): TaskBoard {
  return {
    get: vi.fn(),
    update: vi.fn(),
    claimNext: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
  } as unknown as TaskBoard;
}

function makeMockEventBus(): EventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as EventBus;
}

function makeMockToolkit(): AgentToolkit {
  return {
    schemas: [
      { name: 'read_file', description: 'Read a file', inputSchema: {} },
      { name: 'grep', description: 'Search files', inputSchema: {} },
      { name: 'glob', description: 'Find files', inputSchema: {} },
      { name: 'validate_project', description: 'Validate project', inputSchema: {} },
    ],
    execute: vi.fn().mockResolvedValue({ content: '' }),
  } as unknown as AgentToolkit;
}

// ─────────────────────────────────────────────────────────────────────────────
// DeepLoop selfReview existence (3-phase pipeline)
// ─────────────────────────────────────────────────────────────────────────────

describe('DeepLoop 3-phase verification pipeline', () => {
  it('DeepLoop has selfReview method', () => {
    const deepLoop = new DeepLoop(
      makeMockProvider(),
      makeMockConcurrentProvider(),
      makeMockTaskBoard(),
      makeMockEventBus(),
    );

    expect(typeof (deepLoop as any)['selfReview']).toBe('function');
  });

  it('integrationReview was removed (subsumed by Phase 1 automated gates)', () => {
    const deepLoop = new DeepLoop(
      makeMockProvider(),
      makeMockConcurrentProvider(),
      makeMockTaskBoard(),
      makeMockEventBus(),
    );

    // integrationReview should no longer exist as a method
    expect(typeof (deepLoop as any)['integrationReview']).not.toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseReviewResponse fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('parseReviewResponse', () => {
  it('fallback is approved on invalid JSON (prevents phantom rejection loops)', () => {
    const result = parseReviewResponse('not valid json at all');
    expect(result.result).toBe('approved');
    expect(result.notes).toContain('parse failure');
  });

  it('parses valid approved response', () => {
    const result = parseReviewResponse(JSON.stringify({
      result: 'approved',
      notes: 'Ship it',
    }));
    expect(result.result).toBe('approved');
    expect(result.notes).toBe('Ship it');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INTENT_REVIEW_SYSTEM_PROMPT
// ─────────────────────────────────────────────────────────────────────────────

describe('INTENT_REVIEW_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(INTENT_REVIEW_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it('mentions read-only tools (read_file, grep, glob)', () => {
    expect(INTENT_REVIEW_SYSTEM_PROMPT).toContain('read_file');
    expect(INTENT_REVIEW_SYSTEM_PROMPT).toContain('grep');
    expect(INTENT_REVIEW_SYSTEM_PROMPT).toContain('glob');
  });

  it('focuses on intent, not mechanical bugs', () => {
    expect(INTENT_REVIEW_SYSTEM_PROMPT).toContain('Intent Match');
    expect(INTENT_REVIEW_SYSTEM_PROMPT).toContain('DO NOT check');
  });
});
