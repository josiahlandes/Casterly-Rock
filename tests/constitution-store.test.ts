import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';
import { ConstitutionStore } from '../src/autonomous/constitution-store.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Constitution Store Tests
// ═══════════════════════════════════════════════════════════════════════════════

let tempDir: string;
let store: ConstitutionStore;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-constitution-'));
  store = new ConstitutionStore({
    path: join(tempDir, 'constitution.yaml'),
    maxRules: 5,
    budgetTokens: 300,
    minConfidence: 0.3,
  });
  await store.load();
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

describe('ConstitutionStore — Lifecycle', () => {
  it('starts empty after load', () => {
    expect(store.count()).toBe(0);
    expect(store.isLoaded()).toBe(true);
  });

  it('persists rules across save/load', async () => {
    store.createRule({ rule: 'Plan before multi-file edits', motivation: 'learned from failure' });
    await store.save();

    const store2 = new ConstitutionStore({ path: join(tempDir, 'constitution.yaml') });
    await store2.load();

    expect(store2.count()).toBe(1);
    expect(store2.getAll()[0]!.rule).toBe('Plan before multi-file edits');
  });

  it('handles missing file gracefully', async () => {
    const store2 = new ConstitutionStore({ path: join(tempDir, 'nonexistent.yaml') });
    await store2.load();
    expect(store2.count()).toBe(0);
    expect(store2.isLoaded()).toBe(true);
  });
});

describe('ConstitutionStore — Create Rule', () => {
  it('creates a rule with generated ID', () => {
    const result = store.createRule({
      rule: 'For tasks touching 3+ files, plan first',
      motivation: 'journal#2847',
    });
    expect(result.success).toBe(true);
    expect(result.ruleId).toMatch(/^rule-/);
    expect(store.count()).toBe(1);
  });

  it('stores motivation and default confidence', () => {
    store.createRule({
      rule: 'Test rule',
      motivation: 'some failure reference',
    });

    const rule = store.getAll()[0]!;
    expect(rule.motivation).toBe('some failure reference');
    expect(rule.confidence).toBe(0.8);
    expect(rule.invocations).toBe(0);
    expect(rule.successes).toBe(0);
  });

  it('accepts custom confidence', () => {
    store.createRule({
      rule: 'Custom confidence',
      motivation: 'test',
      confidence: 0.5,
    });
    expect(store.getAll()[0]!.confidence).toBe(0.5);
  });

  it('rejects when max rules reached', () => {
    for (let i = 0; i < 5; i++) {
      store.createRule({ rule: `Rule ${i}`, motivation: 'fill' });
    }
    const result = store.createRule({ rule: 'One too many', motivation: 'overflow' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Maximum rule limit');
  });

  it('rejects when token budget exceeded', () => {
    store.createRule({ rule: 'R'.repeat(1180), motivation: 'big rule' });
    const result = store.createRule({ rule: 'S'.repeat(100), motivation: 'overflow' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Token budget exceeded');
  });

  it('rejects duplicate rule text', () => {
    store.createRule({ rule: 'Unique rule', motivation: 'first' });
    const result = store.createRule({ rule: 'Unique rule', motivation: 'second' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Duplicate rule');
  });
});

describe('ConstitutionStore — Update Rule', () => {
  it('updates rule text', () => {
    const result = store.createRule({ rule: 'Original', motivation: 'test' });
    store.updateRule(result.ruleId!, { rule: 'Updated rule' });

    expect(store.getById(result.ruleId!)!.rule).toBe('Updated rule');
  });

  it('updates motivation', () => {
    const result = store.createRule({ rule: 'Test', motivation: 'old motivation' });
    store.updateRule(result.ruleId!, { motivation: 'new motivation' });

    expect(store.getById(result.ruleId!)!.motivation).toBe('new motivation');
  });

  it('updates confidence with clamping', () => {
    const result = store.createRule({ rule: 'Test', motivation: 'test' });

    store.updateRule(result.ruleId!, { confidence: 1.5 });
    expect(store.getById(result.ruleId!)!.confidence).toBe(1.0);

    store.updateRule(result.ruleId!, { confidence: -0.5 });
    expect(store.getById(result.ruleId!)!.confidence).toBe(0);
  });

  it('returns error for unknown ID', () => {
    const result = store.updateRule('rule-nonexistent', { rule: 'Updated' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('checks token budget when updating rule text', () => {
    store.createRule({ rule: 'R'.repeat(1100), motivation: 'big' });
    const result2 = store.createRule({ rule: 'Small rule', motivation: 'test' });

    const updateResult = store.updateRule(result2.ruleId!, { rule: 'X'.repeat(500) });
    expect(updateResult.success).toBe(false);
    expect(updateResult.error).toContain('Token budget');
  });
});

describe('ConstitutionStore — Remove Rule', () => {
  it('removes a rule by ID', () => {
    const result = store.createRule({ rule: 'Temporary', motivation: 'test' });
    expect(store.count()).toBe(1);

    const removed = store.removeRule(result.ruleId!);
    expect(removed.success).toBe(true);
    expect(store.count()).toBe(0);
  });

  it('returns error for unknown ID', () => {
    const result = store.removeRule('rule-nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('ConstitutionStore — Outcome Tracking', () => {
  it('recordOutcome success increases confidence', () => {
    const result = store.createRule({ rule: 'Tracked', motivation: 'test', confidence: 0.5 });
    store.recordOutcome(result.ruleId!, true);

    const rule = store.getById(result.ruleId!)!;
    expect(rule.invocations).toBe(1);
    expect(rule.successes).toBe(1);
    expect(rule.confidence).toBeCloseTo(0.55, 2);
  });

  it('recordOutcome failure decreases confidence', () => {
    const result = store.createRule({ rule: 'Tracked', motivation: 'test', confidence: 0.8 });
    store.recordOutcome(result.ruleId!, false);

    const rule = store.getById(result.ruleId!)!;
    expect(rule.invocations).toBe(1);
    expect(rule.successes).toBe(0);
    expect(rule.confidence).toBeCloseTo(0.7, 2);
  });

  it('returns false for unknown rule', () => {
    expect(store.recordOutcome('rule-nonexistent', true)).toBe(false);
  });
});

describe('ConstitutionStore — Pruning', () => {
  it('prunes low-confidence rules with enough invocations', () => {
    const r1 = store.createRule({ rule: 'Low conf', motivation: 'test', confidence: 0.2 });
    store.createRule({ rule: 'High conf', motivation: 'test', confidence: 0.9 });

    // Need at least 3 invocations to be eligible for pruning
    store.recordOutcome(r1.ruleId!, false);
    store.recordOutcome(r1.ruleId!, false);
    store.recordOutcome(r1.ruleId!, false);

    const pruned = store.pruneByConfidence();
    expect(pruned).toHaveLength(1);
    expect(store.count()).toBe(1);
  });

  it('does not prune low-confidence rules with insufficient invocations', () => {
    store.createRule({ rule: 'New low conf', motivation: 'test', confidence: 0.2 });
    const pruned = store.pruneByConfidence();
    expect(pruned).toHaveLength(0);
    expect(store.count()).toBe(1);
  });
});

describe('ConstitutionStore — Query', () => {
  it('getAll returns sorted by confidence descending', () => {
    store.createRule({ rule: 'Low', motivation: 'test', confidence: 0.4 });
    store.createRule({ rule: 'High', motivation: 'test', confidence: 0.9 });
    store.createRule({ rule: 'Mid', motivation: 'test', confidence: 0.6 });

    const all = store.getAll();
    expect(all[0]!.rule).toBe('High');
    expect(all[1]!.rule).toBe('Mid');
    expect(all[2]!.rule).toBe('Low');
  });

  it('buildPromptSection formats rules for hot tier', () => {
    store.createRule({ rule: 'Plan for multi-file edits', motivation: 'test', confidence: 0.85 });
    store.createRule({ rule: 'Test regex before applying', motivation: 'test', confidence: 0.7 });

    const section = store.buildPromptSection();
    expect(section).toContain('## Constitution');
    expect(section).toContain('Plan for multi-file edits');
    expect(section).toContain('85% confidence');
    expect(section).toContain('Test regex before applying');
  });

  it('buildPromptSection returns empty for no rules', () => {
    expect(store.buildPromptSection()).toBe('');
  });
});
