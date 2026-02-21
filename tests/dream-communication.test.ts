import { describe, expect, it, beforeEach, vi } from 'vitest';

import { SelfModel, createSelfModel } from '../src/autonomous/dream/self-model.js';
import type { SkillAssessment, SelfModelData } from '../src/autonomous/dream/self-model.js';
import { CodeArchaeologist } from '../src/autonomous/dream/archaeology.js';
import type { FragileFile } from '../src/autonomous/dream/archaeology.js';
import { DreamCycleRunner, createDreamCycleRunner } from '../src/autonomous/dream/runner.js';
import type { DreamOutcome } from '../src/autonomous/dream/runner.js';

import {
  MessagePolicy,
  createMessagePolicy,
} from '../src/autonomous/communication/policy.js';
import type {
  NotifiableEvent,
  PolicyDecision,
  ThrottleConfig,
} from '../src/autonomous/communication/policy.js';

import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a date at a specific hour and minute. */
function dateAt(hour: number, minute: number = 0): Date {
  const d = new Date('2026-02-17T00:00:00.000Z');
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

/** Create a mock IssueLog with the minimum interface needed by dream modules. */
function createMockIssueLog(issues: Array<{
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  relatedFiles: string[];
  tags: string[];
}> = []) {
  return {
    getData: () => ({ issues }),
    getOpenIssues: () => issues.filter((i) => i.status === 'open' || i.status === 'investigating'),
    getIssuesByFile: (path: string) =>
      issues.filter((i) => i.relatedFiles.includes(path)),
    fileIssue: vi.fn((params: Record<string, unknown>) => ({
      id: `ISS-${Date.now()}`,
      ...params,
      status: 'open',
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      attempts: [],
    })),
  };
}

/** Create a mock Reflector. */
function createMockReflector(reflections: Array<{
  cycleId: string;
  outcome: string;
  observation: { suggestedArea: string };
  learnings: string;
}> = []) {
  return {
    loadRecentReflections: vi.fn(async () => reflections),
    appendToMemory: vi.fn(async () => undefined),
  };
}

/** Create a mock GoalStack. */
function createMockGoalStack(goals: Array<{
  id: string;
  description: string;
  status: string;
}> = []) {
  return {
    getStaleGoals: () => [],
    getOpenGoals: () => goals.filter((g) => g.status !== 'completed'),
    removeGoal: vi.fn(() => true),
    addGoal: vi.fn((params: Record<string, unknown>) => ({
      id: `GOAL-${Date.now()}`,
      ...params,
      status: 'pending',
    })),
  };
}

/** Create a mock WorldModel. */
function createMockWorldModel() {
  return {
    updateFromCodebase: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
  };
}

/** Create a mock ContextManager. */
function createMockContextManager() {
  return {
    archive: vi.fn(async () => undefined),
    promoteStaleEntries: vi.fn(async () => undefined),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetTracer();
  initTracer({ enabled: false, level: 'error', subsystems: {} });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 6: Self-Model
// ═══════════════════════════════════════════════════════════════════════════════

describe('SelfModel', () => {
  it('should create with default config', () => {
    const sm = createSelfModel();
    const data = sm.getData();
    expect(data.skills).toEqual([]);
    expect(data.preferences).toEqual([]);
    expect(data.version).toBe(0);
  });

  it('should rebuild from issues and reflections', async () => {
    const sm = new SelfModel({ minSampleSize: 1 });

    const issueLog = createMockIssueLog([
      { id: 'I-1', title: 'Fix regex pattern', description: 'Regex bug', status: 'resolved', priority: 'high', relatedFiles: [], tags: [] },
      { id: 'I-2', title: 'Fix regex anchoring', description: 'Another regex', status: 'resolved', priority: 'medium', relatedFiles: [], tags: [] },
      { id: 'I-3', title: 'Regex escaping issue', description: 'Bad regex', status: 'open', priority: 'low', relatedFiles: [], tags: [] },
    ]);

    const reflector = createMockReflector([
      { cycleId: 'c1', outcome: 'success', observation: { suggestedArea: 'Fixed test' }, learnings: 'Tests need better assertions' },
      { cycleId: 'c2', outcome: 'failure', observation: { suggestedArea: 'Testing edge case' }, learnings: 'Edge cases in testing' },
    ]);

    await sm.rebuild(issueLog as any, reflector as any);

    const data = sm.getData();
    expect(data.version).toBe(1);
    expect(data.skills.length).toBeGreaterThan(0);

    // Regex: 2 resolved out of 3 = 66.7%
    const regexSkill = data.skills.find((s) => s.skill === 'regex');
    expect(regexSkill).toBeDefined();
    expect(regexSkill!.successes).toBe(2);
    expect(regexSkill!.failures).toBe(1);
  });

  it('should identify strengths and weaknesses', async () => {
    const sm = new SelfModel({
      minSampleSize: 1,
      strengthThreshold: 0.7,
      weaknessThreshold: 0.5,
    });

    const issueLog = createMockIssueLog([
      // Testing: 4 resolved, 0 open → 100% success
      { id: 'I-1', title: 'Fix test A', description: 'testing', status: 'resolved', priority: 'low', relatedFiles: [], tags: [] },
      { id: 'I-2', title: 'Fix test B', description: 'testing', status: 'resolved', priority: 'low', relatedFiles: [], tags: [] },
      { id: 'I-3', title: 'Fix test C', description: 'testing', status: 'resolved', priority: 'low', relatedFiles: [], tags: [] },
      { id: 'I-4', title: 'Fix test D', description: 'testing', status: 'resolved', priority: 'low', relatedFiles: [], tags: [] },
      // Security: 1 resolved, 3 open → 25%
      { id: 'I-5', title: 'Security vuln A', description: 'vulnerability', status: 'resolved', priority: 'high', relatedFiles: [], tags: [] },
      { id: 'I-6', title: 'Security vuln B', description: 'vulnerability', status: 'open', priority: 'high', relatedFiles: [], tags: [] },
      { id: 'I-7', title: 'Security vuln C', description: 'vulnerability', status: 'open', priority: 'high', relatedFiles: [], tags: [] },
      { id: 'I-8', title: 'Security vuln D', description: 'vulnerability', status: 'open', priority: 'high', relatedFiles: [], tags: [] },
    ]);

    const reflector = createMockReflector();
    await sm.rebuild(issueLog as any, reflector as any);

    const strengths = sm.getStrengths();
    const weaknesses = sm.getWeaknesses();

    // Testing should be a strength (100% > 70%)
    expect(strengths.some((s) => s.skill === 'testing')).toBe(true);
    // Security should be a weakness (25% < 50%)
    expect(weaknesses.some((s) => s.skill === 'security')).toBe(true);
  });

  it('should generate recommendations for weak skills', async () => {
    const sm = new SelfModel({ minSampleSize: 1, weaknessThreshold: 0.5 });

    const issueLog = createMockIssueLog([
      { id: 'I-1', title: 'Regex fail', description: 'regex bug', status: 'open', priority: 'low', relatedFiles: [], tags: [] },
      { id: 'I-2', title: 'Regex fail 2', description: 'regex', status: 'open', priority: 'low', relatedFiles: [], tags: [] },
      { id: 'I-3', title: 'Regex success', description: 'regex', status: 'resolved', priority: 'low', relatedFiles: [], tags: [] },
    ]);

    const reflector = createMockReflector();
    await sm.rebuild(issueLog as any, reflector as any);

    const rec = sm.getRecommendation('Fix a regex pattern');
    expect(rec).not.toBeNull();
    expect(rec).toContain('regex');
    expect(rec).toContain('Be careful');
  });

  it('should return null recommendation for strong skills', async () => {
    const sm = new SelfModel({ minSampleSize: 1 });

    const issueLog = createMockIssueLog([
      { id: 'I-1', title: 'Test fix', description: 'testing', status: 'resolved', priority: 'low', relatedFiles: [], tags: [] },
      { id: 'I-2', title: 'Test fix 2', description: 'testing', status: 'resolved', priority: 'low', relatedFiles: [], tags: [] },
    ]);

    const reflector = createMockReflector();
    await sm.rebuild(issueLog as any, reflector as any);

    const rec = sm.getRecommendation('Fix a test');
    expect(rec).toBeNull();
  });

  it('should extract preferences from successful reflections', async () => {
    const sm = new SelfModel({ minSampleSize: 1 });

    const issueLog = createMockIssueLog();
    const reflector = createMockReflector([
      {
        cycleId: 'c1',
        outcome: 'success',
        observation: { suggestedArea: 'Fixed config' },
        learnings: 'Always validate YAML before parsing to catch syntax errors early.',
      },
    ]);

    await sm.rebuild(issueLog as any, reflector as any);

    const data = sm.getData();
    expect(data.preferences.length).toBeGreaterThan(0);
    expect(data.preferences[0]).toContain('validate YAML');
  });

  it('should return SelfModelSummary for identity prompt', async () => {
    const sm = new SelfModel({ minSampleSize: 1 });

    const issueLog = createMockIssueLog([
      { id: 'I-1', title: 'Test fix', description: 'testing', status: 'resolved', priority: 'low', relatedFiles: [], tags: [] },
      { id: 'I-2', title: 'Test fix', description: 'testing', status: 'resolved', priority: 'low', relatedFiles: [], tags: [] },
    ]);

    const reflector = createMockReflector();
    await sm.rebuild(issueLog as any, reflector as any);

    const summary = sm.getSummary();
    expect(summary).toHaveProperty('strengths');
    expect(summary).toHaveProperty('weaknesses');
    expect(summary).toHaveProperty('preferences');
    expect(Array.isArray(summary.strengths)).toBe(true);
  });

  it('should increment version on each rebuild', async () => {
    const sm = new SelfModel({ minSampleSize: 1 });
    const issueLog = createMockIssueLog();
    const reflector = createMockReflector();

    await sm.rebuild(issueLog as any, reflector as any);
    expect(sm.getData().version).toBe(1);

    await sm.rebuild(issueLog as any, reflector as any);
    expect(sm.getData().version).toBe(2);
  });

  it('should filter by minimum sample size', async () => {
    const sm = new SelfModel({ minSampleSize: 5 });

    const issueLog = createMockIssueLog([
      { id: 'I-1', title: 'Test fix', description: 'testing', status: 'resolved', priority: 'low', relatedFiles: [], tags: [] },
      { id: 'I-2', title: 'Regex fix', description: 'regex', status: 'resolved', priority: 'low', relatedFiles: [], tags: [] },
    ]);

    const reflector = createMockReflector();
    await sm.rebuild(issueLog as any, reflector as any);

    // Both have sample size 1, below the threshold of 5
    expect(sm.getData().skills).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 6: Code Archaeologist
// ═══════════════════════════════════════════════════════════════════════════════

describe('CodeArchaeologist', () => {
  it('should create with default config', () => {
    const arch = new CodeArchaeologist();
    // Just verify it constructs without error
    expect(arch).toBeDefined();
  });

  it('should create with custom config', () => {
    const arch = new CodeArchaeologist({
      projectRoot: '/tmp/test',
      fragileLookbackDays: 30,
      fragileThreshold: 3,
      abandonedMonths: 12,
    });
    expect(arch).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 6: Dream Cycle Runner
// ═══════════════════════════════════════════════════════════════════════════════

describe('DreamCycleRunner', () => {
  it('should create with factory function', () => {
    const runner = createDreamCycleRunner({ enabled: false });
    // Dream cycles are always available — isEnabled() always returns true (see docs/vision.md)
    expect(runner.isEnabled()).toBe(true);
  });

  it('should create enabled by default', () => {
    const runner = new DreamCycleRunner();
    expect(runner.isEnabled()).toBe(true);
  });

  it('should expose the self-model', () => {
    const runner = new DreamCycleRunner();
    const selfModel = runner.getSelfModel();
    expect(selfModel).toBeInstanceOf(SelfModel);
  });

  it('should run a full dream cycle with mocked dependencies', async () => {
    const runner = new DreamCycleRunner({ enabled: true, projectRoot: '/tmp' });

    const worldModel = createMockWorldModel();
    const goalStack = createMockGoalStack();
    const issueLog = createMockIssueLog([
      { id: 'I-1', title: 'Critical bug', description: 'crash', status: 'open', priority: 'critical', relatedFiles: [], tags: [] },
    ]);
    const reflector = createMockReflector([
      { cycleId: 'c1', outcome: 'success', observation: { suggestedArea: 'Fixed test' }, learnings: 'Good fix' },
    ]);
    const contextManager = createMockContextManager();

    // The explore phase will fail because there's no git repo at cwd.
    // That's expected — dream cycles handle individual phase failures gracefully.
    const outcome = await runner.run(
      worldModel as any,
      goalStack as any,
      issueLog as any,
      reflector as any,
      contextManager as any,
    );

    expect(outcome.timestamp).toBeDefined();
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);

    // Consolidation should succeed
    expect(outcome.phasesCompleted).toContain('consolidateReflections');
    expect(outcome.reflectionsConsolidated).toBe(1);

    // World model update should succeed
    expect(outcome.phasesCompleted).toContain('updateWorldModel');
    expect(worldModel.updateFromCodebase).toHaveBeenCalled();

    // Goal reorganization should create a goal for the critical issue
    expect(outcome.phasesCompleted).toContain('reorganizeGoals');
    expect(goalStack.addGoal).toHaveBeenCalled();

    // Retrospective should be written
    expect(outcome.phasesCompleted).toContain('writeRetrospective');
    expect(reflector.appendToMemory).toHaveBeenCalled();
  });

  it('should survive individual phase failures', async () => {
    const runner = new DreamCycleRunner({ enabled: true, projectRoot: '/tmp' });

    // World model that throws
    const worldModel = {
      updateFromCodebase: vi.fn(async () => { throw new Error('Boom'); }),
      save: vi.fn(async () => undefined),
    };

    const goalStack = createMockGoalStack();
    const issueLog = createMockIssueLog();
    const reflector = createMockReflector();

    const outcome = await runner.run(
      worldModel as any,
      goalStack as any,
      issueLog as any,
      reflector as any,
    );

    // updateWorldModel should be skipped
    expect(outcome.phasesSkipped).toContain('updateWorldModel');
    // But other phases should still run
    expect(outcome.phasesCompleted).toContain('consolidateReflections');
    expect(outcome.phasesCompleted).toContain('reorganizeGoals');
  });

  it('should consolidate both success and failure reflections', async () => {
    const runner = new DreamCycleRunner({ enabled: true, projectRoot: '/tmp' });

    const worldModel = createMockWorldModel();
    const goalStack = createMockGoalStack();
    const issueLog = createMockIssueLog();
    const reflector = createMockReflector([
      { cycleId: 'c1', outcome: 'success', observation: { suggestedArea: 'A' }, learnings: 'L1' },
      { cycleId: 'c2', outcome: 'failure', observation: { suggestedArea: 'B' }, learnings: 'L2' },
      { cycleId: 'c3', outcome: 'success', observation: { suggestedArea: 'C' }, learnings: 'L3' },
    ]);
    const contextManager = createMockContextManager();

    const outcome = await runner.run(
      worldModel as any,
      goalStack as any,
      issueLog as any,
      reflector as any,
      contextManager as any,
    );

    expect(outcome.reflectionsConsolidated).toBe(3);
    // archive called for both success and failure patterns
    expect(contextManager.archive).toHaveBeenCalledTimes(2);
  });

  it('should skip consolidation if no reflections exist', async () => {
    const runner = new DreamCycleRunner({ enabled: true, projectRoot: '/tmp' });

    const worldModel = createMockWorldModel();
    const goalStack = createMockGoalStack();
    const issueLog = createMockIssueLog();
    const reflector = createMockReflector([]); // No reflections

    const outcome = await runner.run(
      worldModel as any,
      goalStack as any,
      issueLog as any,
      reflector as any,
    );

    expect(outcome.reflectionsConsolidated).toBe(0);
    expect(outcome.phasesCompleted).toContain('consolidateReflections');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 7: Message Policy
// ═══════════════════════════════════════════════════════════════════════════════

describe('MessagePolicy', () => {
  // ── Construction ──────────────────────────────────────────────────────────

  describe('construction', () => {
    it('should create with default config', () => {
      const policy = createMessagePolicy();
      expect(policy.isEnabled()).toBe(true);
    });

    it('should create disabled', () => {
      const policy = new MessagePolicy({ enabled: false });
      expect(policy.isEnabled()).toBe(false);
    });

    it('should expose throttle config', () => {
      const policy = new MessagePolicy();
      const throttle = policy.getThrottle();
      expect(throttle.maxPerHour).toBe(3);
      expect(throttle.maxPerDay).toBe(10);
      expect(throttle.quietHours).toBe(true);
    });

    it('should allow custom throttle config', () => {
      const policy = new MessagePolicy({
        throttle: { maxPerHour: 5, maxPerDay: 20, quietHours: false, quietStart: '00:00', quietEnd: '00:00' },
      });
      const throttle = policy.getThrottle();
      expect(throttle.maxPerHour).toBe(5);
      expect(throttle.maxPerDay).toBe(20);
      expect(throttle.quietHours).toBe(false);
    });
  });

  // ── Quiet Hours ───────────────────────────────────────────────────────────

  describe('quiet hours', () => {
    it('should block during quiet hours (overnight window)', () => {
      const policy = new MessagePolicy({
        throttle: {
          maxPerHour: 10, maxPerDay: 50,
          quietHours: true, quietStart: '22:00', quietEnd: '08:00',
        },
      });

      const event: NotifiableEvent = { type: 'fix_complete', description: 'Fixed test', branch: 'auto/fix' };

      // 23:00 — during quiet hours
      const decision = policy.shouldNotify(event, dateAt(23, 0));
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('Quiet hours');
    });

    it('should block during quiet hours (early morning)', () => {
      const policy = new MessagePolicy({
        throttle: {
          maxPerHour: 10, maxPerDay: 50,
          quietHours: true, quietStart: '22:00', quietEnd: '08:00',
        },
      });

      const event: NotifiableEvent = { type: 'fix_complete', description: 'Fixed test', branch: 'auto/fix' };

      // 06:00 — still quiet hours
      const decision = policy.shouldNotify(event, dateAt(6, 0));
      expect(decision.allowed).toBe(false);
    });

    it('should allow outside quiet hours', () => {
      const policy = new MessagePolicy({
        throttle: {
          maxPerHour: 10, maxPerDay: 50,
          quietHours: true, quietStart: '22:00', quietEnd: '08:00',
        },
      });

      const event: NotifiableEvent = { type: 'fix_complete', description: 'Fixed test', branch: 'auto/fix' };

      // 14:00 — outside quiet hours
      const decision = policy.shouldNotify(event, dateAt(14, 0));
      expect(decision.allowed).toBe(true);
    });

    it('should allow any time when quiet hours are disabled', () => {
      const policy = new MessagePolicy({
        throttle: {
          maxPerHour: 10, maxPerDay: 50,
          quietHours: false, quietStart: '22:00', quietEnd: '08:00',
        },
      });

      const event: NotifiableEvent = { type: 'fix_complete', description: 'Fixed test', branch: 'auto/fix' };

      // 23:00 — would be quiet but disabled
      const decision = policy.shouldNotify(event, dateAt(23, 0));
      expect(decision.allowed).toBe(true);
    });
  });

  // ── Throttling ────────────────────────────────────────────────────────────

  describe('throttling', () => {
    it('should enforce hourly limit', () => {
      const policy = new MessagePolicy({
        throttle: {
          maxPerHour: 2, maxPerDay: 100,
          quietHours: false, quietStart: '00:00', quietEnd: '00:00',
        },
      });

      const event: NotifiableEvent = { type: 'fix_complete', description: 'Fix', branch: 'b' };
      const now = dateAt(14, 0);

      // Send 2 messages (at the limit)
      policy.recordSent(event, now);
      policy.recordSent(event, now);

      // Third should be blocked
      const decision = policy.shouldNotify(event, now);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('Hourly limit');
    });

    it('should enforce daily limit', () => {
      const policy = new MessagePolicy({
        throttle: {
          maxPerHour: 100, maxPerDay: 3,
          quietHours: false, quietStart: '00:00', quietEnd: '00:00',
        },
      });

      const event: NotifiableEvent = { type: 'fix_complete', description: 'Fix', branch: 'b' };
      const baseTime = dateAt(10, 0);

      // Send messages across different hours but same day
      policy.recordSent(event, new Date(baseTime.getTime()));
      policy.recordSent(event, new Date(baseTime.getTime() + 2 * 60 * 60 * 1000)); // +2h
      policy.recordSent(event, new Date(baseTime.getTime() + 4 * 60 * 60 * 1000)); // +4h

      // Fourth should be blocked (daily limit = 3)
      const decision = policy.shouldNotify(event, new Date(baseTime.getTime() + 6 * 60 * 60 * 1000));
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('Daily limit');
    });

    it('should allow after hourly window passes', () => {
      const policy = new MessagePolicy({
        throttle: {
          maxPerHour: 1, maxPerDay: 100,
          quietHours: false, quietStart: '00:00', quietEnd: '00:00',
        },
      });

      const event: NotifiableEvent = { type: 'fix_complete', description: 'Fix', branch: 'b' };
      const earlyTime = dateAt(10, 0);

      policy.recordSent(event, earlyTime);

      // 1 hour and 1 minute later — should be allowed
      const laterTime = new Date(earlyTime.getTime() + 61 * 60 * 1000);
      const decision = policy.shouldNotify(event, laterTime);
      expect(decision.allowed).toBe(true);
    });

    it('should track message counts correctly', () => {
      const policy = new MessagePolicy({
        throttle: {
          maxPerHour: 10, maxPerDay: 50,
          quietHours: false, quietStart: '00:00', quietEnd: '00:00',
        },
      });

      const event: NotifiableEvent = { type: 'fix_complete', description: 'Fix', branch: 'b' };
      const now = dateAt(14, 0);

      expect(policy.getMessagesSentLastHour(now)).toBe(0);
      expect(policy.getMessagesSentToday(now)).toBe(0);

      policy.recordSent(event, now);
      expect(policy.getMessagesSentLastHour(now)).toBe(1);
      expect(policy.getMessagesSentToday(now)).toBe(1);

      policy.recordSent(event, now);
      expect(policy.getMessagesSentLastHour(now)).toBe(2);
      expect(policy.getMessagesSentToday(now)).toBe(2);
    });
  });

  // ── Event Filtering ───────────────────────────────────────────────────────

  describe('event filtering', () => {
    it('should block when disabled', () => {
      const policy = new MessagePolicy({ enabled: false });
      const event: NotifiableEvent = { type: 'fix_complete', description: 'Fix', branch: 'b' };
      const decision = policy.shouldNotify(event, dateAt(14, 0));
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('disabled');
    });

    it('should filter test failures being investigated', () => {
      const policy = new MessagePolicy({
        testFailureMinSeverity: 'unresolvable',
        throttle: {
          maxPerHour: 10, maxPerDay: 50,
          quietHours: false, quietStart: '00:00', quietEnd: '00:00',
        },
      });

      // Investigating — should not notify
      const investigating: NotifiableEvent = {
        type: 'test_failure', test: 'detector.test.ts', investigating: true,
      };
      expect(policy.shouldNotify(investigating, dateAt(14, 0)).allowed).toBe(false);

      // Not investigating — should notify
      const stuck: NotifiableEvent = {
        type: 'test_failure', test: 'detector.test.ts', investigating: false,
      };
      expect(policy.shouldNotify(stuck, dateAt(14, 0)).allowed).toBe(true);
    });

    it('should always notify test failures when configured to always', () => {
      const policy = new MessagePolicy({
        testFailureMinSeverity: 'always',
        throttle: {
          maxPerHour: 10, maxPerDay: 50,
          quietHours: false, quietStart: '00:00', quietEnd: '00:00',
        },
      });

      const event: NotifiableEvent = {
        type: 'test_failure', test: 'foo.test.ts', investigating: true,
      };
      expect(policy.shouldNotify(event, dateAt(14, 0)).allowed).toBe(true);
    });

    it('should block daily summary when disabled', () => {
      const policy = new MessagePolicy({
        dailySummaryEnabled: false,
        throttle: {
          maxPerHour: 10, maxPerDay: 50,
          quietHours: false, quietStart: '00:00', quietEnd: '00:00',
        },
      });

      const event: NotifiableEvent = {
        type: 'daily_summary',
        stats: { cyclesRun: 5, issuesFixed: 2, testsPassing: 100, testsFailing: 0, healthSummary: 'Good' },
      };
      expect(policy.shouldNotify(event, dateAt(14, 0)).allowed).toBe(false);
    });

    it('should always allow security concerns at event level', () => {
      const policy = new MessagePolicy({
        throttle: {
          maxPerHour: 10, maxPerDay: 50,
          quietHours: false, quietStart: '00:00', quietEnd: '00:00',
        },
      });

      const event: NotifiableEvent = {
        type: 'security_concern', description: 'Exposed API key', severity: 'critical',
      };
      expect(policy.shouldNotify(event, dateAt(14, 0)).allowed).toBe(true);
    });
  });

  // ── Message Formatting ────────────────────────────────────────────────────

  describe('formatting', () => {
    let policy: MessagePolicy;

    beforeEach(() => {
      policy = new MessagePolicy({
        throttle: {
          maxPerHour: 10, maxPerDay: 50,
          quietHours: false, quietStart: '00:00', quietEnd: '00:00',
        },
      });
    });

    it('should format fix_complete messages', () => {
      const msg = policy.formatMessage({
        type: 'fix_complete', description: 'Flaky detector test', branch: 'auto/fix-detector',
      });
      expect(msg).toContain('Flaky detector test');
      expect(msg).toContain('auto/fix-detector');
    });

    it('should format test_failure messages (investigating)', () => {
      const msg = policy.formatMessage({
        type: 'test_failure', test: 'auth.test.ts', investigating: true,
      });
      expect(msg).toContain('auth.test.ts');
      expect(msg).toContain('investigating');
    });

    it('should format test_failure messages (stuck)', () => {
      const msg = policy.formatMessage({
        type: 'test_failure', test: 'auth.test.ts', investigating: false,
      });
      expect(msg).toContain('auth.test.ts');
      expect(msg).toContain('need help');
    });

    it('should format decision_needed messages', () => {
      const msg = policy.formatMessage({
        type: 'decision_needed',
        question: 'Should I refactor the router?',
        options: ['Yes', 'No', 'Later'],
      });
      expect(msg).toContain('refactor the router');
      expect(msg).toContain('Yes');
      expect(msg).toContain('Later');
    });

    it('should format daily_summary messages', () => {
      const msg = policy.formatMessage({
        type: 'daily_summary',
        stats: {
          cyclesRun: 8,
          issuesFixed: 3,
          testsPassing: 247,
          testsFailing: 0,
          healthSummary: 'All systems green',
        },
      });
      expect(msg).toContain('8');
      expect(msg).toContain('3');
      expect(msg).toContain('247');
      expect(msg).toContain('All systems green');
    });

    it('should format security_concern messages', () => {
      const msg = policy.formatMessage({
        type: 'security_concern', description: 'API key in commit', severity: 'high',
      });
      expect(msg).toContain('API key in commit');
      expect(msg).toContain('high');
    });

    it('should include formatted message in policy decision', () => {
      const event: NotifiableEvent = {
        type: 'fix_complete', description: 'Merged PR #42', branch: 'main',
      };
      const decision = policy.shouldNotify(event, dateAt(14, 0));
      expect(decision.allowed).toBe(true);
      expect(decision.formattedMessage).toContain('Merged PR #42');
    });
  });
});
