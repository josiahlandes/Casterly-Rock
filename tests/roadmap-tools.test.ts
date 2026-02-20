import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildAgentToolkit,
  META_SCHEMA,
  CLASSIFY_SCHEMA,
  PLAN_SCHEMA,
  VERIFY_SCHEMA,
  PEEK_QUEUE_SCHEMA,
  CHECK_BUDGET_SCHEMA,
  LIST_CONTEXT_SCHEMA,
  REVIEW_STEPS_SCHEMA,
  ASSESS_SELF_SCHEMA,
  LOAD_CONTEXT_SCHEMA,
  EVICT_CONTEXT_SCHEMA,
  SET_BUDGET_SCHEMA,
  SCHEDULE_SCHEMA,
  LIST_SCHEDULES_SCHEMA,
  CANCEL_SCHEDULE_SCHEMA,
  SEMANTIC_RECALL_SCHEMA,
  PARALLEL_REASON_SCHEMA,
} from '../src/autonomous/agent-tools.js';
import type {
  AgentState,
  AgentToolkit,
  AgentToolkitConfig,
  CycleIntrospection,
} from '../src/autonomous/agent-tools.js';
import type { NativeToolCall } from '../src/tools/schemas/types.js';
import { GoalStack } from '../src/autonomous/goal-stack.js';
import { IssueLog } from '../src/autonomous/issue-log.js';
import { WorldModel } from '../src/autonomous/world-model.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';
import type { SelfModelSummary } from '../src/autonomous/identity.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;
let toolkit: AgentToolkit;
let state: AgentState;

function makeCall(name: string, input: Record<string, unknown>): NativeToolCall {
  return { id: `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, input };
}

function makeMockWorldModel() {
  return {
    load: () => {},
    save: () => {},
    getStats: () => ({ totalFiles: 10, totalLines: 1000 }),
    getHealth: () => ({ tests: { failing: 0 } }),
    getSummary: () => '',
    addActivity: () => {},
    updateActivity: () => Promise.resolve(),
  } as unknown as WorldModel;
}

function makeMockGoalStack() {
  return {
    load: () => {},
    save: () => {},
    getNextGoal: () => null,
    getSummary: () => '',
  } as unknown as GoalStack;
}

function makeMockIssueLog() {
  return {
    load: () => {},
    save: () => {},
    getSummary: () => '',
  } as unknown as IssueLog;
}

async function setupToolkit(
  stateOverrides?: Partial<AgentState>,
  configOverrides?: Partial<AgentToolkitConfig>,
): Promise<void> {
  const goalStack = new GoalStack({ path: join(tempDir, 'goals.yaml') });
  const issueLog = new IssueLog({ path: join(tempDir, 'issues.yaml') });
  const worldModel = new WorldModel({ path: join(tempDir, 'world-model.yaml'), projectRoot: tempDir });

  state = {
    goalStack,
    issueLog,
    worldModel,
    ...stateOverrides,
  };

  toolkit = buildAgentToolkit(
    {
      projectRoot: tempDir,
      maxOutputChars: 5000,
      commandTimeoutMs: 10_000,
      allowedDirectories: ['src/', 'tests/', 'scripts/'],
      forbiddenPatterns: ['**/*.env*', '**/secrets*'],
      delegationEnabled: false,
      ...configOverrides,
    },
    state,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / Teardown
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-roadmap-tools-'));
  await mkdir(join(tempDir, 'src'), { recursive: true });
  await mkdir(join(tempDir, 'tests'), { recursive: true });
  await mkdir(join(tempDir, 'scripts'), { recursive: true });
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema Validation
// ─────────────────────────────────────────────────────────────────────────────

describe('Roadmap Tools — Schema Validation', () => {
  it('exposes all 71 tool schemas after roadmap + reconciliation (was 49)', async () => {
    await setupToolkit();
    expect(toolkit.schemas).toHaveLength(71);
    expect(toolkit.toolNames).toHaveLength(71);
  });

  it('includes all 17 new roadmap tool names', async () => {
    await setupToolkit();
    const names = toolkit.toolNames;
    const newTools = [
      'meta',
      'classify', 'plan', 'verify',
      'peek_queue', 'check_budget', 'list_context', 'review_steps', 'assess_self',
      'load_context', 'evict_context', 'set_budget',
      'schedule', 'list_schedules', 'cancel_schedule',
      'semantic_recall', 'parallel_reason',
    ];
    for (const name of newTools) {
      expect(names).toContain(name);
    }
  });

  it('all new schemas are individually exported with correct names', () => {
    expect(META_SCHEMA.name).toBe('meta');
    expect(CLASSIFY_SCHEMA.name).toBe('classify');
    expect(PLAN_SCHEMA.name).toBe('plan');
    expect(VERIFY_SCHEMA.name).toBe('verify');
    expect(PEEK_QUEUE_SCHEMA.name).toBe('peek_queue');
    expect(CHECK_BUDGET_SCHEMA.name).toBe('check_budget');
    expect(LIST_CONTEXT_SCHEMA.name).toBe('list_context');
    expect(REVIEW_STEPS_SCHEMA.name).toBe('review_steps');
    expect(ASSESS_SELF_SCHEMA.name).toBe('assess_self');
    expect(LOAD_CONTEXT_SCHEMA.name).toBe('load_context');
    expect(EVICT_CONTEXT_SCHEMA.name).toBe('evict_context');
    expect(SET_BUDGET_SCHEMA.name).toBe('set_budget');
    expect(SCHEDULE_SCHEMA.name).toBe('schedule');
    expect(LIST_SCHEDULES_SCHEMA.name).toBe('list_schedules');
    expect(CANCEL_SCHEDULE_SCHEMA.name).toBe('cancel_schedule');
    expect(SEMANTIC_RECALL_SCHEMA.name).toBe('semantic_recall');
    expect(PARALLEL_REASON_SCHEMA.name).toBe('parallel_reason');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: meta
// ─────────────────────────────────────────────────────────────────────────────

describe('Roadmap Tools — meta (Phase 1)', () => {
  it('records a pipeline override and returns success', async () => {
    await setupToolkit();
    const result = await toolkit.execute(makeCall('meta', {
      override: 'skip_classification',
      rationale: 'The task is obvious, no need to classify.',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Pipeline override recorded');
    expect(result.output).toContain('skip_classification');
  });

  it('fails when override is missing', async () => {
    await setupToolkit();
    const result = await toolkit.execute(makeCall('meta', {
      rationale: 'Missing override field.',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('override');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: classify, plan, verify
// ─────────────────────────────────────────────────────────────────────────────

describe('Roadmap Tools — classify (Phase 2)', () => {
  it('returns a classification for a coding task', async () => {
    await setupToolkit();
    const result = await toolkit.execute(makeCall('classify', {
      message: 'Fix the broken test in the detector module.',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Classification:');
    expect(result.output).toContain('Confidence:');
  });

  it('classifies a conversation-type message', async () => {
    await setupToolkit();
    const result = await toolkit.execute(makeCall('classify', {
      message: 'What is the purpose of this module? Explain how it works.',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Classification:');
    expect(result.output).toContain('conversation');
  });
});

describe('Roadmap Tools — plan (Phase 2)', () => {
  it('returns a structured plan for a task', async () => {
    await setupToolkit();
    const result = await toolkit.execute(makeCall('plan', {
      instruction: 'Refactor the agent tools module to separate concerns.',
      context: 'The file is over 4000 lines long.',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Plan:');
    expect(result.output).toContain('Steps');
  });
});

describe('Roadmap Tools — verify (Phase 2)', () => {
  it('returns PASS when evidence matches all criteria', async () => {
    await setupToolkit();
    const result = await toolkit.execute(makeCall('verify', {
      description: 'Add input validation to the API',
      criteria: ['validation', 'error handling'],
      evidence: 'Added validation for all inputs with proper error handling and tests.',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Verification: PASS');
  });

  it('returns FAIL when evidence matches no criteria', async () => {
    await setupToolkit();
    const result = await toolkit.execute(makeCall('verify', {
      description: 'Add input validation to the API',
      criteria: ['validation', 'error handling', 'tests pass'],
      evidence: 'Refactored some code.',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Verification: FAIL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3: Introspection Tools
// ─────────────────────────────────────────────────────────────────────────────

describe('Roadmap Tools — peek_queue (Phase 3)', () => {
  it('returns empty queue message when no event bus', async () => {
    await setupToolkit();
    const result = await toolkit.execute(makeCall('peek_queue', {}));

    expect(result.success).toBe(true);
    expect(result.output).toContain('not available');
  });

  it('returns empty queue when event bus has no events', async () => {
    const mockEventBus = {
      getQueue: () => [],
      getQueueSize: () => 0,
    };
    await setupToolkit({ eventBus: mockEventBus as never });
    const result = await toolkit.execute(makeCall('peek_queue', {}));

    expect(result.success).toBe(true);
    expect(result.output).toContain('empty');
  });

  it('lists events when queue is non-empty', async () => {
    const mockEventBus = {
      getQueue: () => [
        { type: 'file_changed', timestamp: '2026-01-01T00:00:00Z' },
        { type: 'test_failed', timestamp: '2026-01-01T00:01:00Z' },
      ],
      getQueueSize: () => 2,
    };
    await setupToolkit({ eventBus: mockEventBus as never });
    const result = await toolkit.execute(makeCall('peek_queue', {}));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Event Queue (2 events)');
    expect(result.output).toContain('file_changed');
    expect(result.output).toContain('test_failed');
  });
});

describe('Roadmap Tools — check_budget (Phase 3)', () => {
  it('reports budget when cycle state is available', async () => {
    const cycleState: CycleIntrospection = {
      cycleId: 'cycle-test-001',
      currentTurn: 5,
      maxTurns: 20,
      tokensUsed: 4000,
      maxTokens: 32000,
      startedAt: new Date().toISOString(),
      stepHistory: [
        { turn: 1, tool: 'think', success: true, durationMs: 100 },
        { turn: 2, tool: 'read_file', success: true, durationMs: 200 },
      ],
    };
    await setupToolkit({ cycleState });
    const result = await toolkit.execute(makeCall('check_budget', {}));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Budget Report');
    expect(result.output).toContain('cycle-test-001');
    expect(result.output).toContain('5/20');
    expect(result.output).toContain('15 remaining');
  });

  it('returns fallback message when no cycle state', async () => {
    await setupToolkit();
    const result = await toolkit.execute(makeCall('check_budget', {}));

    expect(result.success).toBe(true);
    expect(result.output).toContain('not available');
  });
});

describe('Roadmap Tools — list_context (Phase 3)', () => {
  it('returns fallback when context manager not available', async () => {
    await setupToolkit();
    const result = await toolkit.execute(makeCall('list_context', {}));

    expect(result.success).toBe(true);
    expect(result.output).toContain('not available');
  });

  it('shows tier usage when context manager is present', async () => {
    const mockContextManager = {
      getUsage: async () => ({
        hot: { tokens: 2500, sections: ['worldModel', 'goalStack'] },
        warm: { tokens: 1000, entries: 2, keys: ['file:main.ts', 'recall:mem-123'] },
        cool: { entries: 15 },
        cold: { entries: 80 },
        totalTokensInContext: 3500,
        remainingTokens: 28500,
      }),
      addToWarmTier: () => ({ added: true, evicted: [] }),
      removeFromWarmTier: () => true,
      recall: async () => [],
      getStore: () => ({}),
    };
    await setupToolkit({ contextManager: mockContextManager as never });
    const result = await toolkit.execute(makeCall('list_context', {}));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Memory Tier Usage');
    expect(result.output).toContain('2500 tokens');
    expect(result.output).toContain('file:main.ts');
  });
});

describe('Roadmap Tools — review_steps (Phase 3)', () => {
  it('shows step history from cycle state', async () => {
    const cycleState: CycleIntrospection = {
      cycleId: 'cycle-review',
      currentTurn: 3,
      maxTurns: 20,
      tokensUsed: 2000,
      maxTokens: 32000,
      startedAt: new Date().toISOString(),
      stepHistory: [
        { turn: 1, tool: 'think', success: true, durationMs: 50 },
        { turn: 2, tool: 'read_file', success: true, durationMs: 120 },
        { turn: 3, tool: 'edit_file', success: false, durationMs: 80 },
      ],
    };
    await setupToolkit({ cycleState });
    const result = await toolkit.execute(makeCall('review_steps', {}));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Step History');
    expect(result.output).toContain('think');
    expect(result.output).toContain('edit_file');
    expect(result.output).toContain('FAILED');
    expect(result.output).toContain('2 succeeded');
  });

  it('filters to last_n steps', async () => {
    const cycleState: CycleIntrospection = {
      cycleId: 'cycle-filter',
      currentTurn: 3,
      maxTurns: 20,
      tokensUsed: 2000,
      maxTokens: 32000,
      startedAt: new Date().toISOString(),
      stepHistory: [
        { turn: 1, tool: 'think', success: true, durationMs: 50 },
        { turn: 2, tool: 'read_file', success: true, durationMs: 120 },
        { turn: 3, tool: 'edit_file', success: true, durationMs: 80 },
      ],
    };
    await setupToolkit({ cycleState });
    const result = await toolkit.execute(makeCall('review_steps', { last_n: 1 }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('1 steps');
    expect(result.output).toContain('edit_file');
  });
});

describe('Roadmap Tools — assess_self (Phase 3)', () => {
  it('returns self-assessment with strengths and weaknesses', async () => {
    const selfModelSummary: SelfModelSummary = {
      strengths: [
        { skill: 'testing', successRate: 0.85, sampleSize: 40 },
        { skill: 'refactoring', successRate: 0.78, sampleSize: 20 },
      ],
      weaknesses: [
        { skill: 'regex', successRate: 0.35, sampleSize: 15 },
      ],
      preferences: ['Prefers small commits', 'Likes explicit types'],
    };
    await setupToolkit({ selfModelSummary });
    const result = await toolkit.execute(makeCall('assess_self', {}));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Self-Assessment');
    expect(result.output).toContain('testing');
    expect(result.output).toContain('85%');
    expect(result.output).toContain('regex');
    expect(result.output).toContain('35%');
    expect(result.output).toContain('Prefers small commits');
  });

  it('returns fallback when no self-model is available', async () => {
    await setupToolkit();
    const result = await toolkit.execute(makeCall('assess_self', {}));

    expect(result.success).toBe(true);
    expect(result.output).toContain('not available');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: LLM-Controlled Context
// ─────────────────────────────────────────────────────────────────────────────

describe('Roadmap Tools — load_context (Phase 4)', () => {
  it('fails when context manager is not available', async () => {
    await setupToolkit();
    const result = await toolkit.execute(makeCall('load_context', { query: 'test patterns' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });

  it('returns "no matching entries" when recall is empty', async () => {
    const mockContextManager = {
      recall: async () => [],
      addToWarmTier: () => ({ added: true, evicted: [] }),
      removeFromWarmTier: () => true,
      getUsage: async () => ({}),
      getStore: () => ({}),
    };
    await setupToolkit({ contextManager: mockContextManager as never });
    const result = await toolkit.execute(makeCall('load_context', { query: 'nonexistent topic' }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('No matching entries');
  });
});

describe('Roadmap Tools — evict_context (Phase 4)', () => {
  it('fails when context manager is not available', async () => {
    await setupToolkit();
    const result = await toolkit.execute(makeCall('evict_context', { key: 'some-key' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });

  it('evicts an entry from the warm tier', async () => {
    const mockContextManager = {
      removeFromWarmTier: (key: string) => key === 'recall:mem-001',
      addToWarmTier: () => ({ added: true, evicted: [] }),
      recall: async () => [],
      getUsage: async () => ({}),
      getStore: () => ({}),
    };
    await setupToolkit({ contextManager: mockContextManager as never });
    const result = await toolkit.execute(makeCall('evict_context', { key: 'recall:mem-001' }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Evicted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: LLM-Initiated Triggers
// ─────────────────────────────────────────────────────────────────────────────

describe('Roadmap Tools — schedule (Phase 5)', () => {
  it('fails when job store is not available', async () => {
    await setupToolkit();
    const result = await toolkit.execute(makeCall('schedule', {
      description: 'Run tests in 2 hours',
      fire_at: 'in 2 hours',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });

  it('schedules a one-shot job with fire_at', async () => {
    const jobs: Array<Record<string, unknown>> = [];
    const mockJobStore = {
      add: (job: Record<string, unknown>) => { jobs.push(job); },
      getActive: () => jobs.filter((j) => j['status'] === 'active'),
      cancel: () => false,
      getById: () => undefined,
    };
    await setupToolkit({ jobStore: mockJobStore as never });
    const result = await toolkit.execute(makeCall('schedule', {
      description: 'Check test results',
      fire_at: 'in 2 hours',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('Scheduled job');
    expect(result.output).toContain('Check test results');
    expect(jobs).toHaveLength(1);
  });

  it('fails when neither fire_at nor cron is provided', async () => {
    const mockJobStore = {
      add: () => {},
      getActive: () => [],
      cancel: () => false,
      getById: () => undefined,
    };
    await setupToolkit({ jobStore: mockJobStore as never });
    const result = await toolkit.execute(makeCall('schedule', {
      description: 'Missing time spec',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('fire_at or cron');
  });
});

describe('Roadmap Tools — list_schedules (Phase 5)', () => {
  it('shows empty list when no jobs are active', async () => {
    const mockJobStore = {
      add: () => {},
      getActive: () => [],
      cancel: () => false,
      getById: () => undefined,
    };
    await setupToolkit({ jobStore: mockJobStore as never });
    const result = await toolkit.execute(makeCall('list_schedules', {}));

    expect(result.success).toBe(true);
    expect(result.output).toContain('No active scheduled jobs');
  });
});

describe('Roadmap Tools — cancel_schedule (Phase 5)', () => {
  it('cancels an existing job', async () => {
    const mockJobStore = {
      add: () => {},
      getActive: () => [],
      cancel: (id: string) => id === 'sched-abc123',
      getById: () => undefined,
    };
    await setupToolkit({ jobStore: mockJobStore as never });
    const result = await toolkit.execute(makeCall('cancel_schedule', { job_id: 'sched-abc123' }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('cancelled');
  });

  it('fails for non-existent job', async () => {
    const mockJobStore = {
      add: () => {},
      getActive: () => [],
      cancel: () => false,
      getById: () => undefined,
    };
    await setupToolkit({ jobStore: mockJobStore as never });
    const result = await toolkit.execute(makeCall('cancel_schedule', { job_id: 'sched-nonexistent' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Supporting: semantic_recall, parallel_reason
// ─────────────────────────────────────────────────────────────────────────────

describe('Roadmap Tools — semantic_recall (Supporting)', () => {
  it('falls back to keyword recall when no embedding provider', async () => {
    const recallResults = [
      {
        entry: { id: 'mem-001', title: 'Test patterns', content: 'Unit test patterns for Vitest', tags: ['testing'], tier: 'cool' as const, source: 'archive' as const, timestamp: new Date().toISOString() },
        score: 3.0,
        matchedKeywords: ['test', 'patterns'],
      },
    ];
    const mockStore = {
      recall: async () => recallResults,
      hybridRecall: async () => recallResults,
    };
    const mockContextManager = {
      getStore: () => mockStore,
      recall: async () => recallResults,
      addToWarmTier: () => ({ added: true, evicted: [] }),
      removeFromWarmTier: () => true,
      getUsage: async () => ({}),
    };
    await setupToolkit({ contextManager: mockContextManager as never });
    const result = await toolkit.execute(makeCall('semantic_recall', {
      query: 'test patterns',
    }));

    expect(result.success).toBe(true);
    expect(result.output).toContain('keyword-only');
    expect(result.output).toContain('Test patterns');
  });
});

describe('Roadmap Tools — parallel_reason (Supporting)', () => {
  it('fails when concurrent provider is not available', async () => {
    await setupToolkit();
    const result = await toolkit.execute(makeCall('parallel_reason', {
      problem: 'Should we use a factory pattern here?',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });
});
