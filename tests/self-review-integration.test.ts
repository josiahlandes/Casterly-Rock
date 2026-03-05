import { describe, it, expect, vi } from 'vitest';
import { DeepLoop } from '../src/dual-loop/deep-loop.js';
import { parseReviewResponse, INTEGRATION_REVIEW_SYSTEM_PROMPT } from '../src/dual-loop/review-prompt.js';
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
// DeepLoop integration review existence
// ─────────────────────────────────────────────────────────────────────────────

describe('DeepLoop integration review', () => {
  it('DeepLoop has integrationReview method', () => {
    const deepLoop = new DeepLoop(
      makeMockProvider(),
      makeMockConcurrentProvider(),
      makeMockTaskBoard(),
      makeMockEventBus(),
    );

    // integrationReview is a private method, but we can verify it exists
    // by checking the prototype
    expect(typeof (deepLoop as any)['integrationReview']).toBe('function');
  });

  it('DeepLoop has selfReview method', () => {
    const deepLoop = new DeepLoop(
      makeMockProvider(),
      makeMockConcurrentProvider(),
      makeMockTaskBoard(),
      makeMockEventBus(),
    );

    expect(typeof (deepLoop as any)['selfReview']).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration review result format
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration review result format', () => {
  it('integrationReview returns { result, issues } when no toolkit', async () => {
    const deepLoop = new DeepLoop(
      makeMockProvider(),
      makeMockConcurrentProvider(),
      makeMockTaskBoard(),
      makeMockEventBus(),
      undefined, // no config override
      undefined, // no toolkit -> integrationReview returns approved
    );

    const task: Task = {
      id: 'test-task-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'reviewing',
      owner: null,
      origin: 'user',
      priority: 0,
      workspaceManifest: [
        { path: 'src/a.js', action: 'created' },
        { path: 'src/b.js', action: 'created' },
      ] as FileOperation[],
    };

    // Call integrationReview directly (it's private, access via any)
    const result = await (deepLoop as any).integrationReview(task);

    expect(result).toHaveProperty('result');
    expect(result).toHaveProperty('issues');
    // Without toolkit, it returns approved
    expect(result.result).toBe('approved');
    expect(Array.isArray(result.issues)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selfReview integration pass logic
// ─────────────────────────────────────────────────────────────────────────────

describe('selfReview integration pass behavior', () => {
  it('selfReview runs integration pass for multi-file tasks (workspaceManifest >= 2 files)', async () => {
    const provider = makeMockProvider();
    // Mock the provider to return valid JSON for the review pass
    (provider.generateWithTools as any).mockResolvedValue(
      JSON.stringify({ result: 'approved', notes: 'All good' }),
    );

    const taskBoard = makeMockTaskBoard();
    const toolkit = makeMockToolkit();

    const deepLoop = new DeepLoop(
      provider,
      makeMockConcurrentProvider(),
      taskBoard,
      makeMockEventBus(),
      undefined,
      toolkit,
    );

    const task: Task = {
      id: 'multi-file-task',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'reviewing',
      owner: 'deep',
      origin: 'user',
      priority: 0,
      plan: 'Build a multi-file project',
      artifacts: [],
      workspaceManifest: [
        { path: 'src/a.js', action: 'created' },
        { path: 'src/b.js', action: 'created' },
        { path: 'src/c.js', action: 'created' },
      ] as FileOperation[],
    };

    (taskBoard.get as any).mockReturnValue(task);

    // Spy on integrationReview
    const integrationSpy = vi.spyOn(deepLoop as any, 'integrationReview');

    // Call selfReview directly
    await (deepLoop as any).selfReview(task);

    // integrationReview should have been called (multi-file task with toolkit)
    expect(integrationSpy).toHaveBeenCalled();

    integrationSpy.mockRestore();
  });

  it('selfReview skips integration pass for single-file tasks', async () => {
    const provider = makeMockProvider();
    (provider.generateWithTools as any).mockResolvedValue(
      JSON.stringify({ result: 'approved', notes: 'All good' }),
    );

    const taskBoard = makeMockTaskBoard();

    const deepLoop = new DeepLoop(
      provider,
      makeMockConcurrentProvider(),
      taskBoard,
      makeMockEventBus(),
      undefined,
      makeMockToolkit(),
    );

    const task: Task = {
      id: 'single-file-task',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'reviewing',
      owner: 'deep',
      origin: 'user',
      priority: 0,
      plan: 'Fix a single file',
      artifacts: [],
      workspaceManifest: [
        { path: 'src/only.js', action: 'created' },
      ] as FileOperation[],
    };

    (taskBoard.get as any).mockReturnValue(task);

    // Spy on integrationReview
    const integrationSpy = vi.spyOn(deepLoop as any, 'integrationReview');

    await (deepLoop as any).selfReview(task);

    // integrationReview should NOT have been called (single-file task)
    expect(integrationSpy).not.toHaveBeenCalled();

    integrationSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseReviewResponse fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('parseReviewResponse', () => {
  it('fallback is changes_requested on invalid JSON', () => {
    const result = parseReviewResponse('not valid json at all');
    expect(result.result).toBe('changes_requested');
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
// INTEGRATION_REVIEW_SYSTEM_PROMPT
// ─────────────────────────────────────────────────────────────────────────────

describe('INTEGRATION_REVIEW_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(INTEGRATION_REVIEW_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it('mentions validate_project tool', () => {
    expect(INTEGRATION_REVIEW_SYSTEM_PROMPT).toContain('validate_project');
  });

  it('mentions cross-module wiring', () => {
    expect(INTEGRATION_REVIEW_SYSTEM_PROMPT).toContain('cross-module');
  });
});
