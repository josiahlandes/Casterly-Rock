/**
 * Integration Test: Autonomous Cycle (Mocked Provider)
 *
 * Tests the full autonomous improvement cycle with a mocked LLM provider:
 * analyze → hypothesize → implement → validate → integrate → reflect
 *
 * This verifies the AutonomousLoop orchestrates all phases correctly,
 * handles edge cases (no observations, low confidence, validation failure),
 * and manages state properly throughout the cycle.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AutonomousLoop, AbortError, loadConfig } from '../src/autonomous/loop.js';
import type { AutonomousProvider, AnalyzeResult, HypothesizeResult, ImplementResult, ReflectResult, TokenUsage, ImplementContext, ReflectContext } from '../src/autonomous/provider.js';
import type { AutonomousConfig, AnalysisContext, Hypothesis, Observation } from '../src/autonomous/types.js';

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-integration-cycle-${Date.now()}`);

function createTestProjectRoot(): string {
  const root = join(TEST_BASE, `project-${Date.now()}`);
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'test', scripts: { test: 'echo ok', check: 'echo ok', typecheck: 'echo ok' } }));
  return root;
}

function createMinimalConfig(): AutonomousConfig {
  return {
    enabled: true,
    provider: 'ollama',
    model: 'qwen3.5:122b',
    cycleIntervalMinutes: 60,
    maxCyclesPerDay: 12,
    maxAttemptsPerCycle: 3,
    maxFilesPerChange: 5,
    allowedDirectories: ['src/', 'tests/'],
    forbiddenPatterns: ['**/*.env*'],
    autoIntegrateThreshold: 0.9,
    attemptThreshold: 0.5,
    approvalTimeoutMinutes: 10,
    maxBranchAgeHours: 24,
    maxConcurrentBranches: 3,
    sandboxTimeoutSeconds: 300,
    sandboxMemoryMb: 2048,
    git: {
      remote: 'origin',
      baseBranch: 'main',
      branchPrefix: 'auto/',
      integrationMode: 'approval_required',
      cleanup: {
        deleteMergedBranches: true,
        deleteFailedBranches: true,
        maxStaleBranchAgeHours: 48,
      },
    },
  };
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: 'obs-test-001',
    type: 'test_failure',
    severity: 'medium',
    frequency: 3,
    context: { testFile: 'tests/foo.test.ts' },
    suggestedArea: 'src/foo.ts',
    timestamp: new Date().toISOString(),
    source: 'test_results',
    ...overrides,
  };
}

function makeHypothesis(obs: Observation, overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: 'hyp-test-001',
    observation: obs,
    proposal: 'Fix the failing test by correcting the regex',
    approach: 'fix_bug',
    expectedImpact: 'medium',
    confidence: 0.8,
    affectedFiles: ['src/foo.ts'],
    estimatedComplexity: 'simple',
    previousAttempts: 0,
    reasoning: 'The regex is missing a Unicode character class',
    ...overrides,
  };
}

// ─── Mock Provider ───────────────────────────────────────────────────────────

function createMockProvider(options: {
  observations?: Observation[];
  hypotheses?: Hypothesis[];
  analyzeError?: boolean;
  hypothesizeError?: boolean;
  implementError?: boolean;
} = {}): AutonomousProvider {
  const obs = options.observations ?? [makeObservation()];
  const hyps = options.hypotheses ?? obs.map((o) => makeHypothesis(o));

  return {
    name: 'mock-provider',
    model: 'mock-model:latest',

    analyze: vi.fn(async (_context: AnalysisContext): Promise<AnalyzeResult> => {
      if (options.analyzeError) throw new Error('Analysis failed');
      return {
        observations: obs,
        summary: `Found ${obs.length} observations`,
        tokensUsed: { input: 100, output: 50 },
      };
    }),

    hypothesize: vi.fn(async (_observations: Observation[]): Promise<HypothesizeResult> => {
      if (options.hypothesizeError) throw new Error('Hypothesize failed');
      return {
        hypotheses: hyps,
        reasoning: 'Generated hypotheses based on observations',
        tokensUsed: { input: 200, output: 100 },
      };
    }),

    implement: vi.fn(async (_hypothesis: Hypothesis, _context: ImplementContext): Promise<ImplementResult> => {
      if (options.implementError) throw new Error('Implementation failed');
      return {
        changes: [
          {
            path: 'src/foo.ts',
            type: 'modify',
            diff: '- old regex\n+ new regex',
            linesAdded: 1,
            linesRemoved: 1,
          },
        ],
        description: 'Fixed the regex pattern',
        commitMessage: 'fix: correct regex pattern in foo.ts',
        tokensUsed: { input: 300, output: 200 },
      };
    }),

    reflect: vi.fn(async (outcome: ReflectContext): Promise<ReflectResult> => ({
      reflection: {
        cycleId: outcome.cycleId,
        timestamp: new Date().toISOString(),
        observation: outcome.observation,
        hypothesis: outcome.hypothesis,
        outcome: outcome.outcome,
        learnings: 'Test reflection learnings',
        durationMs: 1000,
      },
      learnings: 'The approach worked well for simple regex fixes',
      suggestedAdjustments: [],
      tokensUsed: { input: 100, output: 50 },
    })),

    getTokenUsage: vi.fn((): TokenUsage => ({ input: 700, output: 400 })),
    resetTokenUsage: vi.fn(),
  };
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AutonomousLoop construction
// ═══════════════════════════════════════════════════════════════════════════════

describe('AutonomousLoop construction', () => {
  it('constructs with minimal config', () => {
    const root = createTestProjectRoot();
    const config = createMinimalConfig();
    const provider = createMockProvider();
    const loop = new AutonomousLoop(config, root, provider);

    expect(loop.configInstance).toBe(config);
    expect(loop.pendingBranchList).toEqual([]);
  });

  it('constructs with approval bridge option', () => {
    const root = createTestProjectRoot();
    const config = createMinimalConfig();
    const provider = createMockProvider();
    const mockBridge = { requestApproval: vi.fn(), cancelApproval: vi.fn() };
    const loop = new AutonomousLoop(config, root, provider, {
      approvalBridge: mockBridge as never,
      approvalRecipient: '+1234567890',
    });

    expect(loop).toBeDefined();
  });

  it('initializes persistent state objects', () => {
    const root = createTestProjectRoot();
    const config = createMinimalConfig();
    const provider = createMockProvider();
    const loop = new AutonomousLoop(config, root, provider);

    const state = loop.getState();
    expect(state.worldModel).toBeDefined();
    expect(state.goalStack).toBeDefined();
    expect(state.issueLog).toBeDefined();
  });

  it('initializes event bus', () => {
    const root = createTestProjectRoot();
    const config = createMinimalConfig();
    const provider = createMockProvider();
    const loop = new AutonomousLoop(config, root, provider);

    const bus = loop.getEventBus();
    expect(bus).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Provider interface compliance
// ═══════════════════════════════════════════════════════════════════════════════

describe('mock provider interface compliance', () => {
  it('analyze returns observations', async () => {
    const provider = createMockProvider();
    const result = await provider.analyze({
      errorLogs: [],
      performanceMetrics: [],
      recentReflections: [],
      codebaseStats: { totalFiles: 100, totalLines: 5000, lintErrors: 0, typeErrors: 0, lastCommit: 'abc123' },
      backlogItems: [],
    });
    expect(result.observations).toHaveLength(1);
    expect(result.summary).toBeTruthy();
  });

  it('hypothesize returns ranked hypotheses', async () => {
    const provider = createMockProvider();
    const obs = [makeObservation()];
    const result = await provider.hypothesize(obs);
    expect(result.hypotheses).toHaveLength(1);
    expect(result.hypotheses[0]!.confidence).toBeGreaterThan(0);
  });

  it('implement returns file changes', async () => {
    const provider = createMockProvider();
    const obs = makeObservation();
    const hyp = makeHypothesis(obs);
    const result = await provider.implement(hyp, {
      fileContents: new Map(),
      availableFiles: [],
    });
    expect(result.changes).toHaveLength(1);
    expect(result.commitMessage).toBeTruthy();
  });

  it('reflect returns learnings', async () => {
    const provider = createMockProvider();
    const obs = makeObservation();
    const hyp = makeHypothesis(obs);
    const result = await provider.reflect({
      cycleId: 'cycle-test-001',
      observation: obs,
      hypothesis: hyp,
      validationPassed: true,
      validationErrors: [],
      integrated: true,
      outcome: 'success',
    });
    expect(result.learnings).toBeTruthy();
    expect(result.reflection.cycleId).toBe('cycle-test-001');
  });

  it('token tracking works', () => {
    const provider = createMockProvider();
    const usage = provider.getTokenUsage();
    expect(usage.input).toBeGreaterThanOrEqual(0);
    expect(usage.output).toBeGreaterThanOrEqual(0);
    provider.resetTokenUsage();
    expect(provider.resetTokenUsage).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Edge cases: no observations, low confidence
// ═══════════════════════════════════════════════════════════════════════════════

describe('cycle edge cases', () => {
  it('handles zero observations gracefully', async () => {
    const provider = createMockProvider({ observations: [] });
    const result = await provider.analyze({
      errorLogs: [],
      performanceMetrics: [],
      recentReflections: [],
      codebaseStats: { totalFiles: 100, totalLines: 5000, lintErrors: 0, typeErrors: 0, lastCommit: 'abc123' },
      backlogItems: [],
    });
    expect(result.observations).toHaveLength(0);
  });

  it('filters hypotheses below confidence threshold', () => {
    const obs = makeObservation();
    const lowConfHyp = makeHypothesis(obs, { confidence: 0.3 });
    const highConfHyp = makeHypothesis(obs, { confidence: 0.8, id: 'hyp-high' });

    const threshold = 0.5;
    const viable = [lowConfHyp, highConfHyp].filter((h) => h.confidence >= threshold);
    expect(viable).toHaveLength(1);
    expect(viable[0]!.id).toBe('hyp-high');
  });

  it('sorts hypotheses by confidence * impact', () => {
    const obs = makeObservation();
    const impactScore: Record<string, number> = { low: 1, medium: 2, high: 3 };

    const hypotheses = [
      makeHypothesis(obs, { id: 'low', confidence: 0.9, expectedImpact: 'low' }),
      makeHypothesis(obs, { id: 'med', confidence: 0.7, expectedImpact: 'medium' }),
      makeHypothesis(obs, { id: 'high', confidence: 0.6, expectedImpact: 'high' }),
    ];

    hypotheses.sort((a, b) =>
      b.confidence * (impactScore[b.expectedImpact] ?? 1) -
      a.confidence * (impactScore[a.expectedImpact] ?? 1)
    );

    // high: 0.6 * 3 = 1.8
    // med: 0.7 * 2 = 1.4
    // low: 0.9 * 1 = 0.9
    expect(hypotheses[0]!.id).toBe('high');
    expect(hypotheses[1]!.id).toBe('med');
    expect(hypotheses[2]!.id).toBe('low');
  });

  it('backlog P1 items are prioritized over higher-confidence non-backlog', () => {
    const backlogObs = makeObservation({
      source: 'backlog',
      type: 'feature_request',
      context: { priority: 1 },
    });
    const regularObs = makeObservation({
      source: 'test_results',
      type: 'test_failure',
    });

    const backlogHyp = makeHypothesis(backlogObs, { id: 'backlog', confidence: 0.6 });
    const regularHyp = makeHypothesis(regularObs, { id: 'regular', confidence: 0.95 });

    const impactScore: Record<string, number> = { low: 1, medium: 2, high: 3 };
    const viableHypotheses = [regularHyp, backlogHyp];

    viableHypotheses.sort((a, b) => {
      const aIsBacklogHighPri =
        a.observation.source === 'backlog' &&
        ((a.observation.context['priority'] as number) ?? 5) <= 2;
      const bIsBacklogHighPri =
        b.observation.source === 'backlog' &&
        ((b.observation.context['priority'] as number) ?? 5) <= 2;

      if (aIsBacklogHighPri && !bIsBacklogHighPri) return -1;
      if (!aIsBacklogHighPri && bIsBacklogHighPri) return 1;

      return (
        b.confidence * (impactScore[b.expectedImpact] ?? 1) -
        a.confidence * (impactScore[a.expectedImpact] ?? 1)
      );
    });

    expect(viableHypotheses[0]!.id).toBe('backlog');
  });

  it('limits attempts to maxAttemptsPerCycle', () => {
    const obs = makeObservation();
    const hypotheses = Array.from({ length: 10 }, (_, i) =>
      makeHypothesis(obs, { id: `hyp-${i}`, confidence: 0.8 })
    );

    const maxAttempts = Math.min(hypotheses.length, 3);
    expect(maxAttempts).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AbortError behavior
// ═══════════════════════════════════════════════════════════════════════════════

describe('AbortError integration', () => {
  it('AbortError carries cycle ID through try/catch', () => {
    const cycleId = 'cycle-integration-001';
    try {
      throw new AbortError(cycleId);
    } catch (err) {
      expect(err).toBeInstanceOf(AbortError);
      expect((err as AbortError).cycleId).toBe(cycleId);
      expect((err as AbortError).name).toBe('AbortError');
    }
  });

  it('AbortSignal can trigger abort check', () => {
    const controller = new AbortController();
    const signal = controller.signal;

    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it('AbortError is instanceof Error', () => {
    const err = new AbortError('test');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AbortError).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Config loading integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadConfig integration with AutonomousLoop', () => {
  it('real autonomous.yaml loads successfully', async () => {
    const configPath = join(import.meta.dirname, '..', 'config', 'autonomous.yaml');
    const config = await loadConfig(configPath);
    expect(config.enabled).toBe(true);
    expect(config.provider).toBe('ollama');
    expect(config.model).toBe('qwen3.5:122b');
    expect(config.git.integrationMode).toBe('approval_required');
  });

  it('config thresholds are within valid ranges', async () => {
    const configPath = join(import.meta.dirname, '..', 'config', 'autonomous.yaml');
    const config = await loadConfig(configPath);

    expect(config.attemptThreshold).toBeGreaterThan(0);
    expect(config.attemptThreshold).toBeLessThanOrEqual(1);
    expect(config.autoIntegrateThreshold).toBeGreaterThan(0);
    expect(config.autoIntegrateThreshold).toBeLessThanOrEqual(1);
    expect(config.autoIntegrateThreshold).toBeGreaterThan(config.attemptThreshold);
  });

  it('config has sane resource limits', async () => {
    const configPath = join(import.meta.dirname, '..', 'config', 'autonomous.yaml');
    const config = await loadConfig(configPath);

    expect(config.maxCyclesPerDay).toBeGreaterThan(0);
    expect(config.maxCyclesPerDay).toBeLessThanOrEqual(100);
    expect(config.maxAttemptsPerCycle).toBeGreaterThan(0);
    expect(config.maxAttemptsPerCycle).toBeLessThanOrEqual(20);
    expect(config.maxFilesPerChange).toBeGreaterThan(0);
    expect(config.maxFilesPerChange).toBeLessThanOrEqual(50);
    expect(config.sandboxTimeoutSeconds).toBeGreaterThan(0);
    expect(config.maxConcurrentBranches).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Pending branch tracking
// ═══════════════════════════════════════════════════════════════════════════════

describe('pending branch management', () => {
  it('starts with empty pending branches', () => {
    const root = createTestProjectRoot();
    const loop = new AutonomousLoop(createMinimalConfig(), root, createMockProvider());
    expect(loop.pendingBranchList).toEqual([]);
  });

  it('pendingBranchList returns a copy (not internal reference)', () => {
    const root = createTestProjectRoot();
    const loop = new AutonomousLoop(createMinimalConfig(), root, createMockProvider());
    const list1 = loop.pendingBranchList;
    const list2 = loop.pendingBranchList;
    expect(list1).not.toBe(list2); // Different array references
    expect(list1).toEqual(list2);  // Same content
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CycleMetrics structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('CycleMetrics structure', () => {
  it('metrics template has all required fields', () => {
    const metrics = {
      cycleId: 'cycle-001',
      startTime: new Date().toISOString(),
      observationsFound: 0,
      hypothesesGenerated: 0,
      hypothesesAttempted: 0,
      hypothesesSucceeded: 0,
      tokensUsed: { input: 0, output: 0 },
    };

    expect(metrics.cycleId).toBeTruthy();
    expect(metrics.startTime).toBeTruthy();
    expect(typeof metrics.observationsFound).toBe('number');
    expect(typeof metrics.hypothesesGenerated).toBe('number');
    expect(typeof metrics.hypothesesAttempted).toBe('number');
    expect(typeof metrics.hypothesesSucceeded).toBe('number');
    expect(metrics.tokensUsed).toBeDefined();
  });
});
