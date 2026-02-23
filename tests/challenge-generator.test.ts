import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ChallengeGenerator,
  createChallengeGenerator,
} from '../src/autonomous/dream/challenge-generator.js';
import type {
  ChallengeBatch,
  ChallengeResult,
  ChallengeBatchSummary,
} from '../src/autonomous/dream/challenge-generator.js';
import {
  ChallengeEvaluator,
  createChallengeEvaluator,
} from '../src/autonomous/dream/challenge-evaluator.js';
import { SelfModel } from '../src/autonomous/dream/self-model.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-challenge-'));
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Build a SelfModel pre-loaded with specific skill data for testing.
 */
function buildSelfModel(skills: Array<{ skill: string; successRate: number; sampleSize: number }>): SelfModel {
  const model = new SelfModel({
    path: join(tempDir, 'self-model.yaml'),
    minSampleSize: 1,
    strengthThreshold: 0.7,
    weaknessThreshold: 0.5,
  });
  // Access internal data via the public getData pattern — we set it by
  // rebuilding through internal state. Instead we use a typed cast to
  // inject skills directly for unit-testing purposes.
  const data = model.getData() as {
    lastRebuilt: string;
    skills: typeof skills extends Array<infer _> ? Array<{
      skill: string;
      successRate: number;
      sampleSize: number;
      successes: number;
      failures: number;
      lastAssessed: string;
    }> : never;
    preferences: string[];
    version: number;
  };
  data.skills = skills.map((s) => ({
    skill: s.skill,
    successRate: s.successRate,
    sampleSize: s.sampleSize,
    successes: Math.round(s.successRate * s.sampleSize),
    failures: s.sampleSize - Math.round(s.successRate * s.sampleSize),
    lastAssessed: new Date().toISOString(),
  }));
  return model;
}

/**
 * Create mock challenge results for a batch.
 */
function createResults(
  batch: ChallengeBatch,
  passRate: number,
): ChallengeResult[] {
  return batch.challenges.map((ch, i) => ({
    challengeId: ch.id,
    passed: i / batch.challenges.length < passRate,
    response: `Response for ${ch.id}`,
    evaluation: `Evaluation for ${ch.id}`,
    durationMs: 1000 + i * 100,
    skill: ch.skill,
    ...(ch.subSkill !== undefined ? { subSkill: ch.subSkill } : {}),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// ChallengeGenerator Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ChallengeGenerator — Default Config', () => {
  it('creates with default configuration', () => {
    const gen = new ChallengeGenerator();
    // Should not throw, should be constructable
    expect(gen).toBeInstanceOf(ChallengeGenerator);
  });

  it('createChallengeGenerator factory returns a ChallengeGenerator', () => {
    const gen = createChallengeGenerator({ challengeBudget: 5 });
    expect(gen).toBeInstanceOf(ChallengeGenerator);
  });
});

describe('ChallengeGenerator — Batch Generation', () => {
  it('generates a batch with weaknesses prioritized', () => {
    const gen = new ChallengeGenerator({
      challengeBudget: 10,
      prioritizeWeakSkills: true,
    });

    const selfModel = buildSelfModel([
      { skill: 'regex', successRate: 0.3, sampleSize: 10 },
      { skill: 'testing', successRate: 0.8, sampleSize: 10 },
      { skill: 'security', successRate: 0.4, sampleSize: 10 },
    ]);

    const batch = gen.generateBatch(selfModel, 'cycle-001');

    expect(batch.challenges.length).toBeGreaterThan(0);
    expect(batch.challenges.length).toBeLessThanOrEqual(10);
    expect(batch.cycleId).toBe('cycle-001');
    expect(batch.results).toHaveLength(0);

    // Weak skills (regex, security) should have more challenges
    const regexCount = batch.challenges.filter((c) => c.skill === 'regex').length;
    const securityCount = batch.challenges.filter((c) => c.skill === 'security').length;
    const testingCount = batch.challenges.filter((c) => c.skill === 'testing').length;

    expect(regexCount + securityCount).toBeGreaterThanOrEqual(testingCount);
  });

  it('generates an even distribution when no weaknesses are present', () => {
    const gen = new ChallengeGenerator({
      challengeBudget: 15,
      prioritizeWeakSkills: true,
    });

    const selfModel = buildSelfModel([
      { skill: 'regex', successRate: 0.8, sampleSize: 10 },
      { skill: 'testing', successRate: 0.9, sampleSize: 10 },
      { skill: 'security', successRate: 0.75, sampleSize: 10 },
    ]);

    const batch = gen.generateBatch(selfModel, 'cycle-002');

    expect(batch.challenges.length).toBeGreaterThan(0);

    // With no weaknesses, distribution should be more even
    const skills = new Set(batch.challenges.map((c) => c.skill));
    expect(skills.size).toBeGreaterThanOrEqual(2);
  });

  it('generates challenges with even distribution when prioritizeWeakSkills is false', () => {
    const gen = new ChallengeGenerator({
      challengeBudget: 12,
      prioritizeWeakSkills: false,
    });

    const selfModel = buildSelfModel([
      { skill: 'regex', successRate: 0.2, sampleSize: 10 },
      { skill: 'testing', successRate: 0.9, sampleSize: 10 },
    ]);

    const batch = gen.generateBatch(selfModel, 'cycle-003');

    expect(batch.challenges.length).toBeGreaterThan(0);
    expect(batch.challenges.length).toBeLessThanOrEqual(12);
  });

  it('assigns skill-specific challenge types (regex -> regex_construction)', () => {
    const gen = new ChallengeGenerator({
      challengeBudget: 5,
      challengeTypes: ['code_completion', 'regex_construction', 'security_review'],
    });

    const selfModel = buildSelfModel([
      { skill: 'regex', successRate: 0.3, sampleSize: 10 },
    ]);

    const batch = gen.generateBatch(selfModel, 'cycle-004');
    const regexChallenges = batch.challenges.filter((c) => c.skill === 'regex');

    for (const ch of regexChallenges) {
      expect(ch.type).toBe('regex_construction');
    }
  });

  it('respects the challenge budget limit', () => {
    const gen = new ChallengeGenerator({ challengeBudget: 3 });

    const selfModel = buildSelfModel([
      { skill: 'regex', successRate: 0.3, sampleSize: 50 },
      { skill: 'testing', successRate: 0.3, sampleSize: 50 },
      { skill: 'security', successRate: 0.3, sampleSize: 50 },
      { skill: 'refactoring', successRate: 0.3, sampleSize: 50 },
    ]);

    const batch = gen.generateBatch(selfModel, 'cycle-005');
    expect(batch.challenges.length).toBeLessThanOrEqual(3);
  });

  it('assigns sub-skills from the sub-skill map', () => {
    const gen = new ChallengeGenerator({ challengeBudget: 10 });

    const selfModel = buildSelfModel([
      { skill: 'regex', successRate: 0.4, sampleSize: 10 },
    ]);

    const batch = gen.generateBatch(selfModel, 'cycle-006');
    const regexChallenges = batch.challenges.filter((c) => c.skill === 'regex');

    // regex sub-skills include: lookaheads, backreferences, character_classes, etc.
    for (const ch of regexChallenges) {
      expect(ch.subSkill).toBeDefined();
    }
  });
});

describe('ChallengeGenerator — Difficulty Selection', () => {
  it('assigns lower difficulty for low success rates', () => {
    const gen = new ChallengeGenerator({
      challengeBudget: 5,
      minDifficulty: 1,
      maxDifficulty: 5,
    });

    const selfModel = buildSelfModel([
      { skill: 'regex', successRate: 0.1, sampleSize: 10 },
    ]);

    const batch = gen.generateBatch(selfModel, 'cycle-007');
    const difficulties = batch.challenges.map((c) => c.difficulty);

    // With 10% success rate, difficulties should be on the lower end
    for (const d of difficulties) {
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(5);
    }
    // Average difficulty should be low for a 0.1 success rate
    const avg = difficulties.reduce((a, b) => a + b, 0) / difficulties.length;
    expect(avg).toBeLessThanOrEqual(3);
  });

  it('assigns higher difficulty for high success rates', () => {
    const gen = new ChallengeGenerator({
      challengeBudget: 5,
      minDifficulty: 1,
      maxDifficulty: 5,
    });

    const selfModel = buildSelfModel([
      { skill: 'regex', successRate: 0.9, sampleSize: 10 },
    ]);

    const batch = gen.generateBatch(selfModel, 'cycle-008');
    const difficulties = batch.challenges.map((c) => c.difficulty);

    // With 90% success rate, difficulties should be on the higher end
    const avg = difficulties.reduce((a, b) => a + b, 0) / difficulties.length;
    expect(avg).toBeGreaterThanOrEqual(3);
  });
});

describe('ChallengeGenerator — Batch Summarization', () => {
  it('summarizes a completed batch', () => {
    const gen = new ChallengeGenerator({ challengeBudget: 6 });

    const selfModel = buildSelfModel([
      { skill: 'regex', successRate: 0.5, sampleSize: 10 },
      { skill: 'testing', successRate: 0.5, sampleSize: 10 },
    ]);

    const batch = gen.generateBatch(selfModel, 'cycle-009');
    batch.results = createResults(batch, 0.5);

    const summary = gen.summarizeBatch(batch);

    expect(summary.total).toBe(batch.results.length);
    expect(summary.passed + summary.failed).toBe(summary.total);
    expect(summary.passRate).toBeGreaterThanOrEqual(0);
    expect(summary.passRate).toBeLessThanOrEqual(1);
    expect(summary.bySkill).toBeDefined();
    expect(batch.summary).toBe(summary);
  });

  it('tracks per-skill statistics in the summary', () => {
    const gen = new ChallengeGenerator({ challengeBudget: 10 });

    const selfModel = buildSelfModel([
      { skill: 'regex', successRate: 0.3, sampleSize: 10 },
      { skill: 'testing', successRate: 0.8, sampleSize: 10 },
    ]);

    const batch = gen.generateBatch(selfModel, 'cycle-010');
    batch.results = createResults(batch, 0.5);

    const summary = gen.summarizeBatch(batch);

    // bySkill should include entries for each skill in the batch
    const skillsInBatch = new Set(batch.challenges.map((c) => c.skill));
    for (const skill of skillsInBatch) {
      expect(summary.bySkill[skill]).toBeDefined();
      expect(summary.bySkill[skill]!.total).toBeGreaterThan(0);
    }
  });
});

describe('ChallengeGenerator — Report Formatting', () => {
  it('formats a readable report from a batch', () => {
    const gen = new ChallengeGenerator({ challengeBudget: 6 });

    const selfModel = buildSelfModel([
      { skill: 'regex', successRate: 0.5, sampleSize: 10 },
    ]);

    const batch = gen.generateBatch(selfModel, 'cycle-011');
    batch.results = createResults(batch, 0.5);

    const report = gen.formatReport(batch);

    expect(report).toContain('Challenge Batch Report');
    expect(report).toContain('Overall:');
    expect(report).toContain('By Skill:');
    expect(report).toContain('regex');
  });

  it('auto-summarizes if summary is missing when formatting', () => {
    const gen = new ChallengeGenerator({ challengeBudget: 4 });

    const selfModel = buildSelfModel([
      { skill: 'regex', successRate: 0.5, sampleSize: 10 },
    ]);

    const batch = gen.generateBatch(selfModel, 'cycle-012');
    batch.results = createResults(batch, 0.75);
    // Do not call summarizeBatch — formatReport should do it automatically
    expect(batch.summary).toBeUndefined();

    const report = gen.formatReport(batch);

    expect(report).toContain('Challenge Batch Report');
    expect(batch.summary).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ChallengeEvaluator Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ChallengeEvaluator — Recording Batches', () => {
  let evaluator: ChallengeEvaluator;

  beforeEach(() => {
    evaluator = new ChallengeEvaluator({
      historyPath: join(tempDir, 'challenge-history.json'),
      maxBatchRecords: 5,
      minSubSkillSamples: 2,
    });
  });

  it('records a batch and updates history', () => {
    const summary: ChallengeBatchSummary = {
      total: 10,
      passed: 7,
      failed: 3,
      passRate: 0.7,
      bySkill: { regex: { total: 5, passed: 3, rate: 0.6 } },
      bySubSkill: {},
      weakestAreas: [],
    };

    const batch: ChallengeBatch = {
      id: 'batch-001',
      timestamp: new Date().toISOString(),
      cycleId: 'cycle-001',
      challenges: [],
      results: [
        {
          challengeId: 'ch-1',
          passed: true,
          response: 'ok',
          evaluation: 'correct',
          durationMs: 100,
          skill: 'regex',
          subSkill: 'lookaheads',
        },
        {
          challengeId: 'ch-2',
          passed: false,
          response: 'wrong',
          evaluation: 'incorrect',
          durationMs: 200,
          skill: 'regex',
          subSkill: 'backreferences',
        },
      ],
    };

    evaluator.recordBatch(batch, summary);

    const history = evaluator.getHistory();
    expect(history.batches).toHaveLength(1);
    expect(history.batches[0]!.batchId).toBe('batch-001');
    expect(history.subSkills).toHaveLength(2);
  });

  it('tracks sub-skill assessments across results', () => {
    const batch: ChallengeBatch = {
      id: 'batch-002',
      timestamp: new Date().toISOString(),
      cycleId: 'cycle-002',
      challenges: [],
      results: [
        { challengeId: 'ch-1', passed: true, response: '', evaluation: '', durationMs: 100, skill: 'regex', subSkill: 'lookaheads' },
        { challengeId: 'ch-2', passed: true, response: '', evaluation: '', durationMs: 100, skill: 'regex', subSkill: 'lookaheads' },
        { challengeId: 'ch-3', passed: false, response: '', evaluation: '', durationMs: 100, skill: 'regex', subSkill: 'lookaheads' },
      ],
    };

    const summary: ChallengeBatchSummary = {
      total: 3, passed: 2, failed: 1, passRate: 0.67,
      bySkill: {}, bySubSkill: {}, weakestAreas: [],
    };

    evaluator.recordBatch(batch, summary);

    const subSkills = evaluator.getSubSkillAssessments('regex');
    const lookaheads = subSkills.find((s) => s.subSkill === 'lookaheads');

    expect(lookaheads).toBeDefined();
    expect(lookaheads!.challengeAttempts).toBe(3);
    expect(lookaheads!.challengeSuccesses).toBe(2);
    expect(lookaheads!.challengeSuccessRate).toBeCloseTo(2 / 3, 2);
  });

  it('prunes batch records when over the max', () => {
    const summary: ChallengeBatchSummary = {
      total: 1, passed: 1, failed: 0, passRate: 1,
      bySkill: {}, bySubSkill: {}, weakestAreas: [],
    };

    for (let i = 0; i < 8; i++) {
      evaluator.recordBatch(
        { id: `batch-${i}`, timestamp: new Date().toISOString(), cycleId: `c-${i}`, challenges: [], results: [] },
        summary,
      );
    }

    // maxBatchRecords is 5
    expect(evaluator.getHistory().batches.length).toBeLessThanOrEqual(5);
  });
});

describe('ChallengeEvaluator — Trend and Skill Tracking', () => {
  let evaluator: ChallengeEvaluator;

  beforeEach(() => {
    evaluator = new ChallengeEvaluator({
      historyPath: join(tempDir, 'challenge-history.json'),
      minSubSkillSamples: 2,
    });
  });

  it('returns skill trend over recent batches', () => {
    for (let i = 0; i < 3; i++) {
      const rate = 0.5 + i * 0.1;
      evaluator.recordBatch(
        { id: `batch-${i}`, timestamp: new Date().toISOString(), cycleId: `c-${i}`, challenges: [], results: [] },
        {
          total: 10, passed: Math.round(rate * 10), failed: 10 - Math.round(rate * 10), passRate: rate,
          bySkill: { regex: { total: 10, passed: Math.round(rate * 10), rate } },
          bySubSkill: {}, weakestAreas: [],
        },
      );
    }

    const trend = evaluator.getSkillTrend('regex', 3);
    expect(trend).toHaveLength(3);
    // Most recent batch is first in history
    expect(trend[0]!.rate).toBeCloseTo(0.7, 1);
  });

  it('identifies weakest sub-skills', () => {
    // Record results with different sub-skill pass rates
    const results: ChallengeResult[] = [
      { challengeId: 'c1', passed: false, response: '', evaluation: '', durationMs: 100, skill: 'regex', subSkill: 'lookaheads' },
      { challengeId: 'c2', passed: false, response: '', evaluation: '', durationMs: 100, skill: 'regex', subSkill: 'lookaheads' },
      { challengeId: 'c3', passed: true, response: '', evaluation: '', durationMs: 100, skill: 'regex', subSkill: 'groups' },
      { challengeId: 'c4', passed: true, response: '', evaluation: '', durationMs: 100, skill: 'regex', subSkill: 'groups' },
    ];

    evaluator.recordBatch(
      { id: 'batch-1', timestamp: new Date().toISOString(), cycleId: 'c-1', challenges: [], results },
      { total: 4, passed: 2, failed: 2, passRate: 0.5, bySkill: {}, bySubSkill: {}, weakestAreas: [] },
    );

    const weakest = evaluator.getWeakestSubSkills(2, 10);
    expect(weakest.length).toBeGreaterThan(0);
    expect(weakest[0]!.key).toBe('regex.lookaheads');
    expect(weakest[0]!.challengeSuccessRate).toBe(0);
  });

  it('identifies strongest sub-skills', () => {
    const results: ChallengeResult[] = [
      { challengeId: 'c1', passed: true, response: '', evaluation: '', durationMs: 100, skill: 'regex', subSkill: 'groups' },
      { challengeId: 'c2', passed: true, response: '', evaluation: '', durationMs: 100, skill: 'regex', subSkill: 'groups' },
      { challengeId: 'c3', passed: false, response: '', evaluation: '', durationMs: 100, skill: 'regex', subSkill: 'lookaheads' },
      { challengeId: 'c4', passed: false, response: '', evaluation: '', durationMs: 100, skill: 'regex', subSkill: 'lookaheads' },
    ];

    evaluator.recordBatch(
      { id: 'batch-1', timestamp: new Date().toISOString(), cycleId: 'c-1', challenges: [], results },
      { total: 4, passed: 2, failed: 2, passRate: 0.5, bySkill: {}, bySubSkill: {}, weakestAreas: [] },
    );

    const strongest = evaluator.getStrongestSubSkills(2, 10);
    expect(strongest.length).toBeGreaterThan(0);
    expect(strongest[0]!.key).toBe('regex.groups');
    expect(strongest[0]!.challengeSuccessRate).toBe(1);
  });
});

describe('ChallengeEvaluator — Persistence', () => {
  it('saves and reloads evaluation history', async () => {
    const evaluator = new ChallengeEvaluator({
      historyPath: join(tempDir, 'challenge-history.json'),
    });

    evaluator.recordBatch(
      {
        id: 'batch-persist',
        timestamp: new Date().toISOString(),
        cycleId: 'cycle-persist',
        challenges: [],
        results: [
          { challengeId: 'c1', passed: true, response: '', evaluation: '', durationMs: 100, skill: 'regex', subSkill: 'groups' },
        ],
      },
      { total: 1, passed: 1, failed: 0, passRate: 1, bySkill: {}, bySubSkill: {}, weakestAreas: [] },
    );

    await evaluator.save();

    const evaluator2 = new ChallengeEvaluator({
      historyPath: join(tempDir, 'challenge-history.json'),
    });
    await evaluator2.load();

    const history = evaluator2.getHistory();
    expect(history.batches).toHaveLength(1);
    expect(history.batches[0]!.batchId).toBe('batch-persist');
    expect(history.subSkills).toHaveLength(1);
  });

  it('createChallengeEvaluator factory returns an evaluator', () => {
    const ev = createChallengeEvaluator({
      historyPath: join(tempDir, 'test-eval.json'),
    });
    expect(ev).toBeInstanceOf(ChallengeEvaluator);
  });
});
