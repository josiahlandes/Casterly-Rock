import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ConstitutionStore, createConstitutionStore } from '../src/autonomous/constitution-store.js';
import type { ConstitutionalRule } from '../src/autonomous/constitution-store.js';
import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  resetTracer();
  initTracer({ enabled: false });
  tempDir = await mkdtemp(join(tmpdir(), 'casterly-constitution-'));
});

afterEach(async () => {
  resetTracer();
  await rm(tempDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constitution Store Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ConstitutionStore — Rule Creation', () => {
  let store: ConstitutionStore;

  beforeEach(() => {
    store = new ConstitutionStore({
      path: join(tempDir, 'constitution.yaml'),
      maxRules: 5,
      constitutionBudgetTokens: 500,
      minConfidence: 0.3,
    });
  });

  it('creates a rule with all required fields', () => {
    const rule = store.createRule({
      rule: 'For tasks touching 3+ files, generate a plan before starting.',
      motivation: 'journal#2847: skipped planning on a 5-file refactor',
      confidence: 0.85,
      tags: ['planning', 'multi-file'],
    });

    expect(rule).not.toBeNull();
    expect(rule!.id).toMatch(/^rule-/);
    expect(rule!.rule).toContain('3+ files');
    expect(rule!.motivation).toContain('journal#2847');
    expect(rule!.confidence).toBe(0.85);
    expect(rule!.invocations).toBe(0);
    expect(rule!.successes).toBe(0);
    expect(rule!.tags).toEqual(['planning', 'multi-file']);
  });

  it('rejects duplicate rules and strengthens existing', () => {
    const first = store.createRule({
      rule: 'Always run tests before committing.',
      motivation: 'learned the hard way',
      confidence: 0.7,
    });

    const second = store.createRule({
      rule: 'Always run tests before committing.',
      motivation: 'another failure',
      confidence: 0.8,
    });

    expect(store.count()).toBe(1);
    expect(second!.id).toBe(first!.id);
    expect(second!.confidence).toBeGreaterThan(0.7);
  });

  it('enforces maxRules by evicting lowest confidence', () => {
    for (let i = 0; i < 5; i++) {
      store.createRule({
        rule: `Rule number ${i}`,
        motivation: 'test',
        confidence: 0.5 + i * 0.05,
      });
    }
    expect(store.count()).toBe(5);

    const newRule = store.createRule({
      rule: 'A very important new rule',
      motivation: 'critical failure',
      confidence: 0.95,
    });

    expect(newRule).not.toBeNull();
    expect(store.count()).toBe(5);
  });

  it('returns null when full and new rule is lower confidence', () => {
    for (let i = 0; i < 5; i++) {
      store.createRule({
        rule: `Rule number ${i}`,
        motivation: 'test',
        confidence: 0.9,
      });
    }

    const result = store.createRule({
      rule: 'Low confidence rule',
      motivation: 'minor observation',
      confidence: 0.3,
    });

    expect(result).toBeNull();
  });
});

describe('ConstitutionStore — Rule Lifecycle', () => {
  let store: ConstitutionStore;

  beforeEach(() => {
    store = new ConstitutionStore({
      path: join(tempDir, 'constitution.yaml'),
      maxRules: 20,
      minConfidence: 0.3,
    });
  });

  it('records success and strengthens confidence', () => {
    const rule = store.createRule({
      rule: 'Test rule',
      motivation: 'test',
      confidence: 0.7,
    });

    store.recordSuccess(rule!.id);

    const updated = store.get(rule!.id);
    expect(updated!.invocations).toBe(1);
    expect(updated!.successes).toBe(1);
    expect(updated!.confidence).toBeGreaterThan(0.7);
  });

  it('records failure and slightly decays confidence', () => {
    const rule = store.createRule({
      rule: 'Test rule',
      motivation: 'test',
      confidence: 0.7,
    });

    store.recordFailure(rule!.id);

    const updated = store.get(rule!.id);
    expect(updated!.invocations).toBe(1);
    expect(updated!.successes).toBe(0);
    expect(updated!.confidence).toBeLessThan(0.7);
  });

  it('records violation+success and decays confidence more', () => {
    const rule = store.createRule({
      rule: 'Test rule',
      motivation: 'test',
      confidence: 0.7,
    });

    store.recordViolationSuccess(rule!.id);

    const updated = store.get(rule!.id);
    expect(updated!.invocations).toBe(1);
    expect(updated!.confidence).toBeLessThan(0.7);
    // Violation+success should decay more than simple failure
    const afterViolation = updated!.confidence;

    const rule2 = store.createRule({
      rule: 'Another rule',
      motivation: 'test',
      confidence: 0.7,
    });
    store.recordFailure(rule2!.id);
    const afterFailure = store.get(rule2!.id)!.confidence;

    expect(afterViolation).toBeLessThan(afterFailure);
  });

  it('updates rule text and confidence', () => {
    const rule = store.createRule({
      rule: 'Original rule',
      motivation: 'test',
      confidence: 0.7,
    });

    store.updateRule(rule!.id, {
      rule: 'Refined rule based on more experience',
      confidence: 0.85,
    });

    const updated = store.get(rule!.id);
    expect(updated!.rule).toBe('Refined rule based on more experience');
    expect(updated!.confidence).toBe(0.85);
  });

  it('deletes a rule by ID', () => {
    const rule = store.createRule({
      rule: 'To be deleted',
      motivation: 'test',
      confidence: 0.7,
    });

    expect(store.deleteRule(rule!.id)).toBe(true);
    expect(store.count()).toBe(0);
    expect(store.deleteRule('nonexistent')).toBe(false);
  });

  it('prunes rules below minConfidence', () => {
    store.createRule({ rule: 'Strong rule', motivation: 'test', confidence: 0.9 });
    store.createRule({ rule: 'Weak rule', motivation: 'test', confidence: 0.2 });
    store.createRule({ rule: 'Another weak', motivation: 'test', confidence: 0.1 });

    const pruned = store.prune();
    expect(pruned.length).toBe(2);
    expect(store.count()).toBe(1);
  });
});

describe('ConstitutionStore — Search', () => {
  it('searches rules by keyword', () => {
    const store = new ConstitutionStore({
      path: join(tempDir, 'constitution.yaml'),
    });

    store.createRule({ rule: 'Always run tests before committing.', motivation: 'test', confidence: 0.8, tags: ['testing'] });
    store.createRule({ rule: 'Plan before multi-file refactors.', motivation: 'test', confidence: 0.7, tags: ['planning'] });
    store.createRule({ rule: 'Check types after editing providers.', motivation: 'test', confidence: 0.6, tags: ['types'] });

    const testResults = store.search('test');
    expect(testResults.length).toBe(1);
    expect(testResults[0]!.rule).toContain('tests');

    const planResults = store.search('planning');
    expect(planResults.length).toBe(1);
    expect(planResults[0]!.rule).toContain('Plan');
  });
});

describe('ConstitutionStore — Persistence', () => {
  it('saves and loads rules from disk', async () => {
    const path = join(tempDir, 'constitution.yaml');

    const store1 = new ConstitutionStore({ path });
    store1.createRule({ rule: 'Rule A', motivation: 'test A', confidence: 0.9, tags: ['a'] });
    store1.createRule({ rule: 'Rule B', motivation: 'test B', confidence: 0.7, tags: ['b'] });
    await store1.save();

    const store2 = new ConstitutionStore({ path });
    await store2.load();

    expect(store2.count()).toBe(2);
    const all = store2.getAll();
    expect(all[0]!.rule).toBe('Rule A');
    expect(all[1]!.rule).toBe('Rule B');
  });

  it('handles missing file gracefully', async () => {
    const store = new ConstitutionStore({
      path: join(tempDir, 'nonexistent.yaml'),
    });
    await store.load();
    expect(store.count()).toBe(0);
    expect(store.isLoaded()).toBe(true);
  });
});

describe('ConstitutionStore — Hot Tier Integration', () => {
  it('builds a prompt with rules sorted by confidence', () => {
    const store = new ConstitutionStore({
      path: join(tempDir, 'constitution.yaml'),
      constitutionBudgetTokens: 1000,
    });

    store.createRule({ rule: 'Low confidence rule', motivation: 'test', confidence: 0.5 });
    store.createRule({ rule: 'High confidence rule', motivation: 'test', confidence: 0.95 });

    const prompt = store.buildConstitutionPrompt();
    expect(prompt).toContain('High confidence rule');
    expect(prompt).toContain('Low confidence rule');
    expect(prompt.indexOf('High confidence')).toBeLessThan(prompt.indexOf('Low confidence'));
  });

  it('includes success rate in prompt', () => {
    const store = new ConstitutionStore({
      path: join(tempDir, 'constitution.yaml'),
      constitutionBudgetTokens: 1000,
    });

    const rule = store.createRule({ rule: 'Test rule', motivation: 'test', confidence: 0.8 });
    store.recordSuccess(rule!.id);
    store.recordSuccess(rule!.id);
    store.recordFailure(rule!.id);

    const prompt = store.buildConstitutionPrompt();
    expect(prompt).toContain('67%'); // 2/3 = 66.7% rounded
  });

  it('returns empty string when no rules', () => {
    const store = new ConstitutionStore({ path: join(tempDir, 'constitution.yaml') });
    expect(store.buildConstitutionPrompt()).toBe('');
  });
});

describe('ConstitutionStore — Factory', () => {
  it('creates store with default config', () => {
    const store = createConstitutionStore();
    expect(store).toBeInstanceOf(ConstitutionStore);
  });
});
