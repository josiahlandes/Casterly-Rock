import { describe, expect, it } from 'vitest';

import {
  BaseAutonomousProvider,
  PROMPTS,
  type AnalyzeResult,
  type HypothesizeResult,
  type ImplementResult,
  type ReflectResult,
  type TokenUsage,
  type ImplementContext,
  type ReflectContext,
} from '../src/autonomous/provider.js';
import type { AnalysisContext, Hypothesis, Observation } from '../src/autonomous/types.js';

// ─── Concrete test subclass ──────────────────────────────────────────────────

class TestProvider extends BaseAutonomousProvider {
  readonly name = 'test-provider';
  readonly model = 'test-model:7b';

  async analyze(_context: AnalysisContext): Promise<AnalyzeResult> {
    const usage: TokenUsage = { input: 100, output: 50 };
    this.addTokenUsage(usage);
    return { observations: [], summary: 'test', tokensUsed: usage };
  }

  async hypothesize(_observations: Observation[]): Promise<HypothesizeResult> {
    const usage: TokenUsage = { input: 200, output: 100 };
    this.addTokenUsage(usage);
    return { hypotheses: [], reasoning: 'test', tokensUsed: usage };
  }

  async implement(
    _hypothesis: Hypothesis,
    _context: ImplementContext
  ): Promise<ImplementResult> {
    const usage: TokenUsage = { input: 300, output: 200 };
    this.addTokenUsage(usage);
    return { changes: [], description: 'test', commitMessage: 'test', tokensUsed: usage };
  }

  async reflect(_outcome: ReflectContext): Promise<ReflectResult> {
    const usage: TokenUsage = { input: 50, output: 25 };
    this.addTokenUsage(usage);
    const obs: Observation = {
      id: 'obs-1', type: 'code_smell', severity: 'low', frequency: 1,
      context: {}, suggestedArea: 'src/', timestamp: new Date().toISOString(),
      source: 'static_analysis',
    };
    const hyp: Hypothesis = {
      id: 'hyp-1', observation: obs, proposal: 'test', approach: 'fix_bug',
      expectedImpact: 'low', confidence: 0.5, affectedFiles: [],
      estimatedComplexity: 'trivial', previousAttempts: 0, reasoning: 'test',
    };
    return {
      reflection: {
        cycleId: 'test',
        timestamp: new Date().toISOString(),
        learnings: 'learned something',
        outcome: 'success',
        observation: obs,
        hypothesis: hyp,
        durationMs: 100,
      },
      learnings: 'test',
      tokensUsed: usage,
    };
  }

  // Expose protected method for testing
  public testGenerateId(prefix: string): string {
    return this.generateId(prefix);
  }
}

function makeConfig() {
  return {
    enabled: false,
    cycle_interval_minutes: 60,
    model: 'test-model:7b',
    provider: { type: 'ollama' as const, baseUrl: 'http://localhost:11434', model: 'test:7b' },
    git: {
      remote: 'origin',
      baseBranch: 'main',
      branchPrefix: 'auto/',
      integrationMode: 'direct' as const,
      cleanup: { deleteMergedBranches: true, deleteFailedBranches: true, maxStaleBranchAgeHours: 72 },
    },
    safety: { maxFilesPerCycle: 5, maxChangesPerFile: 100, forbiddenPaths: [], requiredChecks: [] },
    quiet_hours: { enabled: false, start: '22:00', end: '06:00' },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BaseAutonomousProvider — token tracking
// ═══════════════════════════════════════════════════════════════════════════════

describe('BaseAutonomousProvider — token tracking', () => {
  it('starts with zero token usage', () => {
    const provider = new TestProvider(makeConfig() as never);
    const usage = provider.getTokenUsage();
    expect(usage.input).toBe(0);
    expect(usage.output).toBe(0);
  });

  it('accumulates token usage across calls', async () => {
    const provider = new TestProvider(makeConfig() as never);
    await provider.analyze({ errorLogs: [], performanceMetrics: [], recentReflections: [], codebaseStats: { totalFiles: 0, totalLines: 0, lintErrors: 0, typeErrors: 0, lastCommit: '' } });
    await provider.hypothesize([]);

    const usage = provider.getTokenUsage();
    expect(usage.input).toBe(300);   // 100 + 200
    expect(usage.output).toBe(150);  // 50 + 100
  });

  it('resets token usage', async () => {
    const provider = new TestProvider(makeConfig() as never);
    await provider.analyze({ errorLogs: [], performanceMetrics: [], recentReflections: [], codebaseStats: { totalFiles: 0, totalLines: 0, lintErrors: 0, typeErrors: 0, lastCommit: '' } });
    provider.resetTokenUsage();
    const usage = provider.getTokenUsage();
    expect(usage.input).toBe(0);
    expect(usage.output).toBe(0);
  });

  it('getTokenUsage returns a copy', () => {
    const provider = new TestProvider(makeConfig() as never);
    const usage1 = provider.getTokenUsage();
    usage1.input = 999;
    const usage2 = provider.getTokenUsage();
    expect(usage2.input).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BaseAutonomousProvider — utility methods
// ═══════════════════════════════════════════════════════════════════════════════

describe('BaseAutonomousProvider — utility methods', () => {
  it('estimateCostUsd returns 0 for local inference', () => {
    const provider = new TestProvider(makeConfig() as never);
    expect(provider.estimateCostUsd()).toBe(0);
  });

  it('generateId creates unique prefixed IDs', () => {
    const provider = new TestProvider(makeConfig() as never);
    const id1 = provider.testGenerateId('obs');
    const id2 = provider.testGenerateId('obs');
    expect(id1).toMatch(/^obs-/);
    expect(id2).toMatch(/^obs-/);
    expect(id1).not.toBe(id2);
  });

  it('generateId uses different prefixes', () => {
    const provider = new TestProvider(makeConfig() as never);
    const obsId = provider.testGenerateId('obs');
    const hypId = provider.testGenerateId('hyp');
    expect(obsId.startsWith('obs-')).toBe(true);
    expect(hypId.startsWith('hyp-')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROMPTS constant
// ═══════════════════════════════════════════════════════════════════════════════

describe('PROMPTS', () => {
  it('has analyze prompt', () => {
    expect(PROMPTS.analyze).toBeTruthy();
    expect(PROMPTS.analyze).toContain('observations');
    expect(PROMPTS.analyze).toContain('Error Logs');
  });

  it('has hypothesize prompt', () => {
    expect(PROMPTS.hypothesize).toBeTruthy();
    expect(PROMPTS.hypothesize).toContain('hypotheses');
    expect(PROMPTS.hypothesize).toContain('confidence');
  });

  it('has implement prompt', () => {
    expect(PROMPTS.implement).toBeTruthy();
    expect(PROMPTS.implement).toContain('Hypothesis');
    expect(PROMPTS.implement).toContain('commitMessage');
  });

  it('has reflect prompt', () => {
    expect(PROMPTS.reflect).toBeTruthy();
    expect(PROMPTS.reflect).toContain('Cycle');
    expect(PROMPTS.reflect).toContain('learnings');
  });

  it('all prompts use template placeholders', () => {
    expect(PROMPTS.analyze).toContain('{{errorLogs}}');
    expect(PROMPTS.hypothesize).toContain('{{observations}}');
    expect(PROMPTS.implement).toContain('{{hypothesis}}');
    expect(PROMPTS.reflect).toContain('{{cycleId}}');
  });
});
