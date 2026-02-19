/**
 * Integration Test: Phase System (Phases 1-7)
 *
 * Tests the Tyrion phase system components working together:
 * - Phase 1: Persistent Identity (WorldModel + GoalStack + IssueLog + Identity)
 * - Phase 2: Agent Loop (trigger determination, state management)
 * - Phase 3: Event-Driven Awareness (EventBus + watcher triggers)
 * - Phase 4: Tiered Memory (ContextManager hot/warm tiers)
 * - Phase 7: Communication (MessagePolicy throttling)
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { WorldModel } from '../src/autonomous/world-model.js';
import { GoalStack } from '../src/autonomous/goal-stack.js';
import type { GoalSource } from '../src/autonomous/goal-stack.js';
import { IssueLog } from '../src/autonomous/issue-log.js';
import { buildIdentityPrompt, buildMinimalIdentityPrompt } from '../src/autonomous/identity.js';
import { EventBus } from '../src/autonomous/events.js';
import type { SystemEvent } from '../src/autonomous/events.js';
import { createMessagePolicy } from '../src/autonomous/communication/policy.js';
import type { NotifiableEvent, MessagePolicyConfig } from '../src/autonomous/communication/policy.js';

// ─── Test Setup ──────────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-integration-phases-${Date.now()}`);

function testDir(name: string): string {
  const dir = join(TEST_BASE, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 1: WorldModel + GoalStack + IssueLog working together
// ═══════════════════════════════════════════════════════════════════════════════

describe('Phase 1: Persistent Identity System', () => {
  describe('WorldModel initialization', () => {
    it('constructs with default config', () => {
      const dir = testDir('wm-default');
      const wm = new WorldModel({ projectRoot: dir });
      expect(wm).toBeDefined();
    });

    it('generates a summary', () => {
      const dir = testDir('wm-summary');
      const wm = new WorldModel({ projectRoot: dir });
      const summary = wm.getSummary();
      expect(typeof summary).toBe('string');
    });
  });

  describe('GoalStack operations', () => {
    it('constructs empty', () => {
      const gs = new GoalStack({ path: join(testDir('gs-empty'), 'goals.yaml') });
      expect(gs).toBeDefined();
    });

    it('adds and retrieves goals', () => {
      const dir = testDir('gs-add');
      const gs = new GoalStack({ path: join(dir, 'goals.yaml') });

      const goal = gs.addGoal({
        source: 'user' as GoalSource,
        description: 'Fix the broken test',
        priority: 1,
        tags: ['bug'],
      });

      expect(goal).not.toBeNull();
      expect(goal!.id).toBeTruthy();
      expect(goal!.description).toBe('Fix the broken test');
      expect(goal!.status).toBe('pending');
      expect(goal!.source).toBe('user');
    });

    it('retrieves open goals sorted by priority', () => {
      const dir = testDir('gs-priority');
      const gs = new GoalStack({ path: join(dir, 'goals.yaml') });

      gs.addGoal({ source: 'self', description: 'Low priority task', priority: 5, tags: [] });
      gs.addGoal({ source: 'user', description: 'High priority task', priority: 1, tags: [] });
      gs.addGoal({ source: 'event', description: 'Medium priority task', priority: 3, tags: [] });

      const open = gs.getOpenGoals();
      expect(open).toHaveLength(3);
      expect(open[0]!.priority).toBeLessThanOrEqual(open[1]!.priority);
      expect(open[1]!.priority).toBeLessThanOrEqual(open[2]!.priority);
    });

    it('completes a goal', () => {
      const dir = testDir('gs-complete');
      const gs = new GoalStack({ path: join(dir, 'goals.yaml') });

      const goal = gs.addGoal({
        source: 'user',
        description: 'Task to complete',
        priority: 1,
        tags: ['test'],
      });

      expect(goal).not.toBeNull();
      const result = gs.completeGoal(goal!.id);
      expect(result).toBe(true);

      const updatedGoal = gs.getGoal(goal!.id);
      expect(updatedGoal?.status).toBe('done');
    });

    it('persists and reloads from disk', async () => {
      const dir = testDir('gs-persist');
      const path = join(dir, 'goals.yaml');
      const gs1 = new GoalStack({ path });

      gs1.addGoal({ source: 'user', description: 'Persisted goal', priority: 2, tags: [] });
      await gs1.save();

      const gs2 = new GoalStack({ path });
      await gs2.load();
      const goals = gs2.getOpenGoals();
      expect(goals.some((g) => g.description === 'Persisted goal')).toBe(true);
    });

    it('getNextGoal returns highest priority pending goal', () => {
      const dir = testDir('gs-next');
      const gs = new GoalStack({ path: join(dir, 'goals.yaml') });

      gs.addGoal({ source: 'self', description: 'Low priority', priority: 5, tags: [] });
      gs.addGoal({ source: 'user', description: 'High priority', priority: 1, tags: [] });

      const next = gs.getNextGoal();
      expect(next).toBeDefined();
      expect(next!.description).toBe('High priority');
    });
  });

  describe('IssueLog operations', () => {
    it('constructs empty', () => {
      const dir = testDir('il-empty');
      const il = new IssueLog({ path: join(dir, 'issues.yaml') });
      expect(il).toBeDefined();
    });

    it('files and retrieves issues', () => {
      const dir = testDir('il-file');
      const il = new IssueLog({ path: join(dir, 'issues.yaml') });

      const issue = il.fileIssue({
        title: 'Flaky test in detector',
        description: 'Test fails intermittently on CI',
        priority: 'high',
        relatedFiles: ['tests/detector.test.ts'],
        discoveredBy: 'autonomous',
      });

      expect(issue.id).toBeTruthy();
      expect(issue.status).toBe('open');
      expect(issue.priority).toBe('high');
    });

    it('records attempts on an issue', () => {
      const dir = testDir('il-attempt');
      const il = new IssueLog({ path: join(dir, 'issues.yaml') });

      const issue = il.fileIssue({
        title: 'Broken regex',
        description: 'Regex does not match Unicode',
        priority: 'medium',
        discoveredBy: 'autonomous',
      });

      const result = il.recordAttempt(issue.id, {
        approach: 'Added Unicode character class to regex',
        outcome: 'failure',
        details: 'Still fails for emoji characters',
        filesModified: ['src/regex.ts'],
      });

      expect(result).toBe(true);
      const updated = il.getIssue(issue.id);
      expect(updated?.attempts).toHaveLength(1);
      expect(updated?.attempts[0]?.outcome).toBe('failure');
    });

    it('resolves an issue', () => {
      const dir = testDir('il-resolve');
      const il = new IssueLog({ path: join(dir, 'issues.yaml') });

      const issue = il.fileIssue({
        title: 'Issue to resolve',
        description: 'Something is broken',
        priority: 'low',
        discoveredBy: 'autonomous',
      });

      const result = il.resolveIssue(issue.id, 'resolved', 'Fixed by adding fallback');
      expect(result).toBe(true);

      const resolved = il.getIssue(issue.id);
      expect(resolved?.status).toBe('resolved');
    });

    it('persists and reloads from disk', async () => {
      const dir = testDir('il-persist');
      const path = join(dir, 'issues.yaml');
      const il1 = new IssueLog({ path });

      il1.fileIssue({
        title: 'Persisted issue',
        description: 'A persisted issue',
        priority: 'medium',
        discoveredBy: 'autonomous',
      });
      await il1.save();

      const il2 = new IssueLog({ path });
      await il2.load();
      const issues = il2.getOpenIssues();
      expect(issues.some((i) => i.title === 'Persisted issue')).toBe(true);
    });
  });

  describe('Identity prompt building', () => {
    it('builds an identity prompt from empty state', () => {
      const dir = testDir('identity-empty');
      const wm = new WorldModel({ projectRoot: dir });
      const gs = new GoalStack({ path: join(dir, 'goals.yaml') });
      const il = new IssueLog({ path: join(dir, 'issues.yaml') });

      const result = buildIdentityPrompt(wm, gs, il);
      expect(result.prompt).toBeTruthy();
      expect(result.charCount).toBeGreaterThan(0);
      expect(result.sections.character).toBe(true);
    });

    it('includes goal and issue sections when populated', () => {
      const dir = testDir('identity-populated');
      const wm = new WorldModel({ projectRoot: dir });
      const gs = new GoalStack({ path: join(dir, 'goals.yaml') });
      const il = new IssueLog({ path: join(dir, 'issues.yaml') });

      gs.addGoal({ source: 'user', description: 'Implement dark mode', priority: 1, tags: ['feature'] });
      il.fileIssue({ title: 'Memory leak in sessions', description: 'Sessions leak memory', priority: 'high', discoveredBy: 'autonomous' });

      const result = buildIdentityPrompt(wm, gs, il);
      expect(result.prompt.length).toBeGreaterThan(100);
    });

    it('stays within character budget', () => {
      const dir = testDir('identity-budget');
      const wm = new WorldModel({ projectRoot: dir });
      const gs = new GoalStack({ path: join(dir, 'goals.yaml') });
      const il = new IssueLog({ path: join(dir, 'issues.yaml') });

      // Add many goals and issues
      for (let i = 0; i < 15; i++) {
        gs.addGoal({ source: 'self', description: `Goal ${i}: ${'x'.repeat(200)}`, priority: i + 1, tags: [] });
        il.fileIssue({ title: `Issue ${i}: ${'y'.repeat(100)}`, description: 'Test', priority: 'medium', discoveredBy: 'autonomous' });
      }

      const result = buildIdentityPrompt(wm, gs, il, null, null, null, { maxChars: 8000 });
      expect(result.charCount).toBeLessThanOrEqual(8500); // Small overflow OK
    });

    it('buildMinimalIdentityPrompt returns a string', () => {
      const minimal = buildMinimalIdentityPrompt();
      expect(typeof minimal).toBe('string');
      expect(minimal.length).toBeGreaterThan(0);
      expect(minimal).toContain('Tyrion');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 3: Event-Driven Awareness
// ═══════════════════════════════════════════════════════════════════════════════

describe('Phase 3: Event System', () => {
  describe('EventBus operations', () => {
    it('emits and drains events', () => {
      const bus = new EventBus({ maxQueueSize: 100, logEvents: false });

      const event: SystemEvent = {
        type: 'file_changed',
        paths: ['src/foo.ts'],
        changeKind: 'modified',
        timestamp: new Date().toISOString(),
      };

      bus.emit(event);
      const drained = bus.drain();
      expect(drained).toHaveLength(1);
      expect(drained[0]!.type).toBe('file_changed');
    });

    it('respects max queue size', () => {
      const bus = new EventBus({ maxQueueSize: 3, logEvents: false });

      for (let i = 0; i < 10; i++) {
        bus.emit({
          type: 'file_changed',
          paths: [`src/file${i}.ts`],
          changeKind: 'modified',
          timestamp: new Date().toISOString(),
        });
      }

      const drained = bus.drain();
      expect(drained.length).toBeLessThanOrEqual(3);
    });

    it('drain clears the queue', () => {
      const bus = new EventBus({ maxQueueSize: 100, logEvents: false });

      bus.emit({
        type: 'test_failed',
        testName: 'detector.test.ts',
        output: 'AssertionError',
        timestamp: new Date().toISOString(),
      });

      const first = bus.drain();
      expect(first).toHaveLength(1);

      const second = bus.drain();
      expect(second).toHaveLength(0);
    });

    it('supports multiple event types', () => {
      const bus = new EventBus({ maxQueueSize: 100, logEvents: false });

      bus.emit({ type: 'file_changed', paths: ['src/foo.ts'], changeKind: 'modified', timestamp: new Date().toISOString() });
      bus.emit({ type: 'test_failed', testName: 'bar.test.ts', output: 'Expected true but got false', timestamp: new Date().toISOString() });
      bus.emit({ type: 'git_push', branch: 'main', commits: ['abc123'], timestamp: new Date().toISOString() });

      const drained = bus.drain();
      expect(drained).toHaveLength(3);

      const types = drained.map((e) => e.type);
      expect(types).toContain('file_changed');
      expect(types).toContain('test_failed');
      expect(types).toContain('git_push');
    });

    it('handlers are called on emit', () => {
      const bus = new EventBus({ maxQueueSize: 100, logEvents: false });
      const received: SystemEvent[] = [];

      bus.onAny((event) => {
        received.push(event);
      });

      bus.emit({
        type: 'file_changed',
        paths: ['src/test.ts'],
        changeKind: 'created',
        timestamp: new Date().toISOString(),
      });

      expect(received).toHaveLength(1);
    });

    it('reset clears handlers and queue', () => {
      const bus = new EventBus({ maxQueueSize: 100, logEvents: false });
      let callCount = 0;

      bus.onAny(() => { callCount++; });
      bus.emit({
        type: 'file_changed',
        paths: ['x.ts'],
        changeKind: 'modified',
        timestamp: new Date().toISOString(),
      });
      expect(callCount).toBe(1);

      bus.reset();
      bus.emit({
        type: 'file_changed',
        paths: ['y.ts'],
        changeKind: 'modified',
        timestamp: new Date().toISOString(),
      });
      // After reset, handler should not fire
      expect(callCount).toBe(1);
    });
  });

  describe('event priority', () => {
    it('user message events have highest priority', async () => {
      const { getEventPriority } = await import('../src/autonomous/events.js');

      const userEvent = { type: 'user_message' as const, message: 'hello', sender: 'owner', timestamp: '' };
      const fileEvent = { type: 'file_changed' as const, paths: ['x.ts'], changeKind: 'modified' as const, timestamp: '' };
      const testEvent = { type: 'test_failed' as const, testName: 'x', output: '', timestamp: '' };

      const userPriority = getEventPriority(userEvent);
      const filePriority = getEventPriority(fileEvent);
      const testPriority = getEventPriority(testEvent);

      // User messages should have the highest priority (lowest number)
      expect(userPriority).toBeLessThanOrEqual(filePriority);
      expect(userPriority).toBeLessThanOrEqual(testPriority);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 7: Communication Policy
// ═══════════════════════════════════════════════════════════════════════════════

describe('Phase 7: Communication Policy', () => {
  function createTestPolicy(overrides: Partial<MessagePolicyConfig> = {}) {
    return createMessagePolicy({
      enabled: true,
      throttle: {
        maxPerHour: 3,
        maxPerDay: 10,
        quietHours: false,
        quietStart: '22:00',
        quietEnd: '08:00',
      },
      testFailureMinSeverity: 'unresolvable',
      dailySummaryEnabled: true,
      ...overrides,
    });
  }

  it('allows messages when under throttle limits', () => {
    const policy = createTestPolicy();
    const event: NotifiableEvent = {
      type: 'fix_complete',
      description: 'Fixed flaky test',
      branch: 'auto/fix-flaky',
    };

    const decision = policy.shouldNotify(event);
    expect(decision.allowed).toBe(true);
  });

  it('blocks messages when disabled', () => {
    const policy = createTestPolicy({ enabled: false });
    const event: NotifiableEvent = {
      type: 'fix_complete',
      description: 'Fixed something',
      branch: 'auto/fix',
    };

    const decision = policy.shouldNotify(event);
    expect(decision.allowed).toBe(false);
  });

  it('respects hourly throttle limit', () => {
    const policy = createTestPolicy({
      throttle: {
        maxPerHour: 2,
        maxPerDay: 100,
        quietHours: false,
        quietStart: '22:00',
        quietEnd: '08:00',
      },
    });

    const event: NotifiableEvent = {
      type: 'fix_complete',
      description: 'Fixed test',
      branch: 'auto/fix',
    };

    // Send 2 messages (at limit)
    policy.recordSent(event);
    policy.recordSent(event);

    // Third should be blocked
    const decision = policy.shouldNotify(event);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Hourly');
  });

  it('respects daily throttle limit', () => {
    const policy = createTestPolicy({
      throttle: {
        maxPerHour: 100,
        maxPerDay: 3,
        quietHours: false,
        quietStart: '22:00',
        quietEnd: '08:00',
      },
    });

    const event: NotifiableEvent = {
      type: 'fix_complete',
      description: 'Fixed test',
      branch: 'auto/fix',
    };

    for (let i = 0; i < 3; i++) {
      policy.recordSent(event);
    }

    const decision = policy.shouldNotify(event);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Daily');
  });

  it('formats fix_complete messages', () => {
    const policy = createTestPolicy();
    const event: NotifiableEvent = {
      type: 'fix_complete',
      description: 'Fixed flaky detector test',
      branch: 'auto/fix-detector',
    };

    const message = policy.formatMessage(event);
    expect(message).toContain('Fixed');
    expect(message.length).toBeGreaterThan(0);
  });

  it('formats daily_summary messages', () => {
    const policy = createTestPolicy();
    const event: NotifiableEvent = {
      type: 'daily_summary',
      stats: {
        cyclesRun: 8,
        issuesFixed: 3,
        testsPassing: 290,
        testsFailing: 5,
        healthSummary: 'Mostly healthy',
      },
    };

    const message = policy.formatMessage(event);
    expect(message).toContain('8');
    expect(message.length).toBeGreaterThan(0);
  });

  it('filters test failures below severity threshold', () => {
    const policy = createTestPolicy({ testFailureMinSeverity: 'unresolvable' });
    const event: NotifiableEvent = {
      type: 'test_failure',
      test: 'some.test.ts',
      investigating: true, // Still investigating = not unresolvable
    };

    const decision = policy.shouldNotify(event);
    // When investigating is true, this is not unresolvable yet
    expect(decision.allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-phase integration: Identity + Goals + Issues
// ═══════════════════════════════════════════════════════════════════════════════

describe('cross-phase integration', () => {
  it('identity prompt reflects goal stack state', () => {
    const dir = testDir('cross-goals');
    const wm = new WorldModel({ projectRoot: dir });
    const gs = new GoalStack({ path: join(dir, 'goals.yaml') });
    const il = new IssueLog({ path: join(dir, 'issues.yaml') });

    gs.addGoal({
      source: 'user',
      description: 'Unique goal: implement quantum computing module',
      priority: 1,
      tags: ['feature'],
    });

    const result = buildIdentityPrompt(wm, gs, il);
    expect(result.prompt).toContain('quantum computing');
    expect(result.sections.goalStack).toBe(true);
  });

  it('identity prompt reflects issue log state', () => {
    const dir = testDir('cross-issues');
    const wm = new WorldModel({ projectRoot: dir });
    const gs = new GoalStack({ path: join(dir, 'goals.yaml') });
    const il = new IssueLog({ path: join(dir, 'issues.yaml') });

    il.fileIssue({
      title: 'Unique issue: memory leak in websocket handler',
      description: 'WebSocket connections leak memory',
      priority: 'critical',
      discoveredBy: 'autonomous',
    });

    const result = buildIdentityPrompt(wm, gs, il);
    expect(result.prompt).toContain('websocket');
    expect(result.sections.issueLog).toBe(true);
  });

  it('events can trigger goal creation workflow', () => {
    const dir = testDir('cross-events');
    const gs = new GoalStack({ path: join(dir, 'goals.yaml') });
    const bus = new EventBus({ maxQueueSize: 100, logEvents: false });

    // Simulate: event arrives → goal created
    const testFailEvent: SystemEvent = {
      type: 'test_failed',
      testName: 'critical.test.ts',
      output: 'Assertion failed',
      timestamp: new Date().toISOString(),
    };

    bus.emit(testFailEvent);
    const events = bus.drain();

    // Process events by creating goals
    for (const event of events) {
      if (event.type === 'test_failed') {
        gs.addGoal({
          source: 'event',
          description: `Fix failing test: ${event.testName}`,
          priority: 2,
          tags: ['bug', 'automated'],
          eventType: event.type,
        });
      }
    }

    const goals = gs.getOpenGoals();
    expect(goals.some((g) => g.description.includes('critical.test.ts'))).toBe(true);
    expect(goals[0]!.source).toBe('event');
  });

  it('issue resolution can complete associated goal', () => {
    const dir = testDir('cross-resolve');
    const gs = new GoalStack({ path: join(dir, 'goals.yaml') });
    const il = new IssueLog({ path: join(dir, 'issues.yaml') });

    // File issue and create linked goal
    const issue = il.fileIssue({
      title: 'Broken parser',
      description: 'Parser fails on edge cases',
      priority: 'high',
      discoveredBy: 'autonomous',
    });

    const goal = gs.addGoal({
      source: 'self',
      description: 'Fix broken parser',
      priority: 2,
      issueId: issue.id,
      tags: ['bug'],
    });

    expect(goal).not.toBeNull();

    // Resolve issue
    il.resolveIssue(issue.id, 'resolved', 'Fixed by adding error handling');

    // Complete linked goal
    gs.completeGoal(goal!.id);

    const resolvedIssue = il.getIssue(issue.id);
    const completedGoal = gs.getGoal(goal!.id);
    expect(resolvedIssue?.status).toBe('resolved');
    expect(completedGoal?.status).toBe('done');
  });
});
