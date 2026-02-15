import { describe, expect, it } from 'vitest';

import {
  createTokenCounter,
  tokenCounter,
  ContextBudget,
} from '../src/coding/token-counter.js';

// ═══════════════════════════════════════════════════════════════════════════════
// createTokenCounter / tokenCounter singleton
// ═══════════════════════════════════════════════════════════════════════════════

describe('createTokenCounter', () => {
  it('returns a counter with all methods', () => {
    const counter = createTokenCounter();
    expect(counter.count).toBeTypeOf('function');
    expect(counter.countMessages).toBeTypeOf('function');
    expect(counter.estimate).toBeTypeOf('function');
  });
});

describe('tokenCounter singleton', () => {
  it('is a valid counter', () => {
    expect(tokenCounter.count).toBeTypeOf('function');
    expect(tokenCounter.estimate).toBeTypeOf('function');
    expect(tokenCounter.countMessages).toBeTypeOf('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// estimate (fast estimation)
// ═══════════════════════════════════════════════════════════════════════════════

describe('tokenCounter.estimate', () => {
  it('returns 0 for empty string', () => {
    expect(tokenCounter.estimate('')).toBe(0);
  });

  it('estimates prose at ~4 chars per token', () => {
    const prose = 'This is a simple English sentence with no code.';
    const estimate = tokenCounter.estimate(prose);
    // ~48 chars / 4 = ~12 tokens, should be in the right ballpark
    expect(estimate).toBeGreaterThan(8);
    expect(estimate).toBeLessThan(25);
  });

  it('estimates code with more tokens per character', () => {
    const code = 'const x = { a: [1, 2], b: { c: "d" } };';
    const estimate = tokenCounter.estimate(code);
    // Code has many symbols, so chars-per-token ratio is lower → more tokens
    // ~40 chars with heavy punctuation
    expect(estimate).toBeGreaterThan(8);
  });

  it('code estimates higher per-character than prose', () => {
    const proseText = 'a'.repeat(100);
    const codeText = '{[()]}=<>;'.repeat(10);
    const proseEstimate = tokenCounter.estimate(proseText);
    const codeEstimate = tokenCounter.estimate(codeText);
    // Same length (100 chars) but code should yield more tokens
    expect(codeEstimate).toBeGreaterThanOrEqual(proseEstimate);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// count (more accurate)
// ═══════════════════════════════════════════════════════════════════════════════

describe('tokenCounter.count', () => {
  it('returns 0 for empty string', () => {
    expect(tokenCounter.count('')).toBe(0);
  });

  it('counts single short word as 1 token', () => {
    expect(tokenCounter.count('hi')).toBeGreaterThanOrEqual(1);
  });

  it('counts multiple words', () => {
    const tokens = tokenCounter.count('hello world foo bar');
    expect(tokens).toBeGreaterThanOrEqual(4);
  });

  it('counts code with brackets as multiple tokens', () => {
    const tokens = tokenCounter.count('function foo(x) { return x; }');
    expect(tokens).toBeGreaterThan(5);
  });

  it('returns integer (ceiling)', () => {
    const tokens = tokenCounter.count('some text');
    expect(Number.isInteger(tokens)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// countMessages
// ═══════════════════════════════════════════════════════════════════════════════

describe('tokenCounter.countMessages', () => {
  it('returns base overhead for empty messages', () => {
    const tokens = tokenCounter.countMessages([]);
    // Conversation overhead = 3
    expect(tokens).toBe(3);
  });

  it('adds per-message overhead', () => {
    const singleMsg = tokenCounter.countMessages([
      { role: 'user', content: 'hi' },
    ]);
    const emptyMsgs = tokenCounter.countMessages([]);
    // Each message adds 4 overhead + content tokens
    expect(singleMsg).toBeGreaterThan(emptyMsgs);
  });

  it('counts multiple messages', () => {
    const tokens = tokenCounter.countMessages([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there, how can I help?' },
    ]);
    // 3 base + 2*(4 overhead) + content tokens
    expect(tokens).toBeGreaterThan(11);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ContextBudget class
// ═══════════════════════════════════════════════════════════════════════════════

describe('ContextBudget', () => {
  it('initializes with total and response reserve', () => {
    const budget = new ContextBudget(10000);
    const b = budget.getBudget();
    expect(b.total).toBe(10000);
    expect(b.response).toBe(2500); // 25% of 10000
    expect(b.system).toBe(0);
    expect(b.files).toBe(0);
  });

  it('getRemaining returns full budget initially', () => {
    const budget = new ContextBudget(10000);
    expect(budget.getRemaining()).toBe(10000);
  });

  it('used returns 0 initially', () => {
    const budget = new ContextBudget(10000);
    expect(budget.used()).toBe(0);
  });

  it('canAdd checks available tokens', () => {
    const budget = new ContextBudget(100);
    // Short text should fit
    expect(budget.canAdd('system', 'hello')).toBe(true);
    // Huge text should not
    expect(budget.canAdd('system', 'x'.repeat(1000))).toBe(false);
  });

  it('add updates category usage', () => {
    const budget = new ContextBudget(10000);
    const tokens = budget.add('system', 'System prompt text');
    expect(tokens).toBeGreaterThan(0);
    expect(budget.used()).toBeGreaterThan(0);
    expect(budget.getRemaining()).toBeLessThan(10000);
  });

  it('add throws when exceeding budget', () => {
    const budget = new ContextBudget(10);
    expect(() => budget.add('system', 'x'.repeat(200))).toThrow('Cannot add');
  });

  it('remove reduces category usage', () => {
    const budget = new ContextBudget(10000);
    budget.add('files', 'Some file content here');
    const usedBefore = budget.used();
    budget.remove('files', 5);
    expect(budget.used()).toBeLessThan(usedBefore);
  });

  it('remove does not go below zero', () => {
    const budget = new ContextBudget(10000);
    budget.remove('files', 1000);
    expect(budget.getBudget().files).toBe(0);
  });

  it('reset sets category to zero', () => {
    const budget = new ContextBudget(10000);
    budget.add('system', 'Some system text');
    expect(budget.getBudget().system).toBeGreaterThan(0);
    budget.reset('system');
    expect(budget.getBudget().system).toBe(0);
  });

  it('summary returns formatted string', () => {
    const budget = new ContextBudget(10000);
    budget.add('system', 'hello');
    const summary = budget.summary();
    expect(summary).toContain('Token Budget:');
    expect(summary).toContain('System:');
    expect(summary).toContain('Remaining:');
  });

  it('accepts custom TokenCounter', () => {
    const mockCounter = {
      count: () => 42,
      countMessages: () => 50,
      estimate: () => 40,
    };
    const budget = new ContextBudget(10000, mockCounter);
    const tokens = budget.add('system', 'anything');
    expect(tokens).toBe(42);
  });
});
