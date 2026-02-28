import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  ConcurrentProvider,
  createConcurrentProvider,
} from '../src/providers/concurrent.js';
import type { NamedResult, BestOfNResult } from '../src/providers/concurrent.js';
import type {
  LlmProvider,
  GenerateRequest,
} from '../src/providers/base.js';
import { ProviderError } from '../src/providers/base.js';
import type {
  GenerateWithToolsResponse,
  ToolSchema,
  ToolResultMessage,
} from '../src/tools/schemas/types.js';

import {
  ReasoningScaler,
  createReasoningScaler,
} from '../src/autonomous/reasoning/scaling.js';
import type { Difficulty, ProblemContext } from '../src/autonomous/reasoning/scaling.js';

import {
  AdversarialTester,
  createAdversarialTester,
} from '../src/autonomous/reasoning/adversarial.js';
import type { TestCase, AttackResult } from '../src/autonomous/reasoning/adversarial.js';

import { resetTracer, initTracer } from '../src/autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock Provider
// ─────────────────────────────────────────────────────────────────────────────

function createMockProvider(
  id: string,
  model: string,
  responseText?: string,
): LlmProvider {
  return {
    id,
    kind: 'local',
    model,
    generateWithTools: vi.fn(
      async (
        _request: GenerateRequest,
        _tools: ToolSchema[],
        _prev?: ToolResultMessage[],
      ): Promise<GenerateWithToolsResponse> => ({
        text: responseText ?? `Response from ${model}`,
        toolCalls: [],
        providerId: id,
        model,
        stopReason: 'end_turn',
      }),
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetTracer();
  initTracer({ enabled: false });
});

// ─────────────────────────────────────────────────────────────────────────────
// ConcurrentProvider Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ConcurrentProvider — Single Generation', () => {
  it('sends request to the correct model', async () => {
    const providerA = createMockProvider('ollama', 'model-a');
    const providerB = createMockProvider('ollama', 'model-b');
    const providers = new Map<string, LlmProvider>([
      ['model-a', providerA],
      ['model-b', providerB],
    ]);

    const cp = createConcurrentProvider(providers);

    const response = await cp.generate('model-a', { prompt: 'Hello' });

    expect(response.text).toBe('Response from model-a');
    expect(providerA.generateWithTools).toHaveBeenCalledOnce();
    expect(providerB.generateWithTools).not.toHaveBeenCalled();
  });

  it('throws for unregistered model', async () => {
    const cp = createConcurrentProvider(new Map());

    await expect(
      cp.generate('nonexistent', { prompt: 'Hello' }),
    ).rejects.toThrow(ProviderError);
  });

  it('tracks active requests', async () => {
    const provider = createMockProvider('ollama', 'model');
    const providers = new Map([['model', provider]]);
    const cp = createConcurrentProvider(providers);

    expect(cp.getActiveRequests()).toBe(0);

    // Start a request but don't await yet
    const promise = cp.generate('model', { prompt: 'Hello' });
    // Request is still in flight... but since the mock is instant,
    // by the time we check it's already done. That's fine for the unit test.
    const response = await promise;

    expect(response.text).toBe('Response from model');
    expect(cp.getActiveRequests()).toBe(0);
  });
});

describe('ConcurrentProvider — Parallel Generation', () => {
  it('sends same prompt to multiple models', async () => {
    const providerA = createMockProvider('ollama', 'model-a', 'Result A');
    const providerB = createMockProvider('ollama', 'model-b', 'Result B');
    const providers = new Map<string, LlmProvider>([
      ['model-a', providerA],
      ['model-b', providerB],
    ]);

    const cp = createConcurrentProvider(providers);
    const results = await cp.parallel(
      ['model-a', 'model-b'],
      { prompt: 'Solve this' },
    );

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.model).sort()).toEqual(['model-a', 'model-b']);
    expect(results.map((r) => r.response.text).sort()).toEqual(['Result A', 'Result B']);
  });

  it('returns partial results when some models fail', async () => {
    const goodProvider = createMockProvider('ollama', 'good', 'Good result');
    const badProvider: LlmProvider = {
      id: 'ollama',
      kind: 'local',
      model: 'bad',
      generateWithTools: vi.fn(async () => {
        throw new Error('Model crashed');
      }),
    };
    const providers = new Map<string, LlmProvider>([
      ['good', goodProvider],
      ['bad', badProvider],
    ]);

    const cp = createConcurrentProvider(providers);
    const results = await cp.parallel(
      ['good', 'bad'],
      { prompt: 'Test' },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.model).toBe('good');
  });

  it('throws when all models fail', async () => {
    const badProvider: LlmProvider = {
      id: 'ollama',
      kind: 'local',
      model: 'bad',
      generateWithTools: vi.fn(async () => {
        throw new Error('Failed');
      }),
    };
    const providers = new Map<string, LlmProvider>([['bad', badProvider]]);

    const cp = createConcurrentProvider(providers);

    await expect(
      cp.parallel(['bad'], { prompt: 'Test' }),
    ).rejects.toThrow('All 1 parallel generations failed');
  });

  it('throws for empty model list', async () => {
    const cp = createConcurrentProvider(new Map());

    await expect(
      cp.parallel([], { prompt: 'Test' }),
    ).rejects.toThrow('No models specified');
  });

  it('throws when exceeding max parallel generations', async () => {
    const provider = createMockProvider('ollama', 'model');
    const providers = new Map([['model', provider]]);
    const cp = createConcurrentProvider(providers, { maxParallelGenerations: 2 });

    await expect(
      cp.parallel(['model', 'model', 'model'], { prompt: 'Test' }),
    ).rejects.toThrow('Too many parallel models');
  });

  it('records duration for each result', async () => {
    const provider = createMockProvider('ollama', 'model');
    const providers = new Map([['model', provider]]);
    const cp = createConcurrentProvider(providers);

    const results = await cp.parallel(['model'], { prompt: 'Test' });

    expect(results[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('ConcurrentProvider — Best of N', () => {
  it('returns the only candidate when one succeeds', async () => {
    const provider = createMockProvider('ollama', 'model', 'Only result');
    const judge = createMockProvider('ollama', 'judge', 'Candidate 1 is best');
    const providers = new Map<string, LlmProvider>([
      ['model', provider],
      ['judge', judge],
    ]);

    const cp = createConcurrentProvider(providers);
    const result = await cp.bestOfN(
      ['model'],
      { prompt: 'Solve' },
      'judge',
    );

    expect(result.best.model).toBe('model');
    expect(result.candidates).toHaveLength(1);
  });

  it('uses judge to select best candidate', async () => {
    const providerA = createMockProvider('ollama', 'model-a', 'Short answer');
    const providerB = createMockProvider('ollama', 'model-b', 'A much more detailed and thorough answer');
    const judge = createMockProvider('ollama', 'judge', 'Candidate 2 is better because it is more thorough.');
    const providers = new Map<string, LlmProvider>([
      ['model-a', providerA],
      ['model-b', providerB],
      ['judge', judge],
    ]);

    const cp = createConcurrentProvider(providers);
    const result = await cp.bestOfN(
      ['model-a', 'model-b'],
      { prompt: 'Explain X' },
      'judge',
    );

    expect(result.candidates).toHaveLength(2);
    expect(result.judgeModel).toBe('judge');
    expect(result.judgeReasoning).toContain('Candidate 2');
    expect(result.best.model).toBe('model-b');
  });

  it('falls back to first candidate when judge output is unparseable', async () => {
    const provider = createMockProvider('ollama', 'model', 'Answer');
    const judge = createMockProvider('ollama', 'judge', 'I cannot decide.');
    const providers = new Map<string, LlmProvider>([
      ['model', provider],
      ['judge', judge],
    ]);

    const cp = createConcurrentProvider(providers);
    const result = await cp.bestOfN(
      ['model', 'model'],
      { prompt: 'Test' },
      'judge',
    );

    expect(result.best.model).toBe('model');
    expect(result.judgeReasoning).toContain('Defaulting to candidate 1');
  });
});

describe('ConcurrentProvider — Provider Management', () => {
  it('registers and queries providers', () => {
    const cp = createConcurrentProvider(new Map());

    expect(cp.getRegisteredModels()).toHaveLength(0);
    expect(cp.hasModel('model')).toBe(false);

    cp.registerProvider('model', createMockProvider('ollama', 'model'));

    expect(cp.getRegisteredModels()).toEqual(['model']);
    expect(cp.hasModel('model')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ReasoningScaler Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ReasoningScaler — Difficulty Assessment', () => {
  let scaler: ReasoningScaler;

  beforeEach(() => {
    scaler = createReasoningScaler();
  });

  it('rates simple tasks as easy', () => {
    expect(scaler.assessDifficulty('Rename the variable x to count')).toBe('easy');
    expect(scaler.assessDifficulty('Fix a typo in the comment')).toBe('easy');
    expect(scaler.assessDifficulty('Add a type annotation to the config')).toBe('easy');
  });

  it('rates complex tasks as hard', () => {
    expect(scaler.assessDifficulty(
      'Fix the race condition in the concurrent streaming parser with unicode support',
    )).toBe('hard');
  });

  it('escalates difficulty based on previous attempts', () => {
    const problem = 'Update the import statement';

    const easy = scaler.assessDifficulty(problem, { previousAttempts: 0 } as ProblemContext);
    const harder = scaler.assessDifficulty(problem, {
      previousAttempts: 3,
      fileCount: 1,
      totalLines: 10,
      crossFile: false,
      hasFailingTests: false,
      tags: [],
    });

    // With 3 previous attempts, it should be at least medium
    expect(['medium', 'hard']).toContain(harder);
    // Without attempts, simple rename is easy
    expect(easy).toBe('easy');
  });

  it('considers cross-file changes as harder', () => {
    const simple = scaler.assessDifficulty('Update function', {
      fileCount: 1,
      totalLines: 20,
      crossFile: false,
      hasFailingTests: false,
      previousAttempts: 0,
      tags: [],
    });
    const complex = scaler.assessDifficulty('Update function', {
      fileCount: 15,
      totalLines: 3000,
      crossFile: true,
      hasFailingTests: true,
      previousAttempts: 0,
      tags: [],
    });

    expect(simple).toBe('easy');
    expect(complex).toBe('hard');
  });
});

describe('ReasoningScaler — Scaled Solving', () => {
  it('uses single generation for easy problems', async () => {
    const codingProvider = createMockProvider('ollama', 'coder', 'Easy fix');
    const reasoningProvider = createMockProvider('ollama', 'reasoner', 'Reasoning');
    const providers = new Map<string, LlmProvider>([
      ['qwen3.5:122b', codingProvider],
      ['hermes3:70b', reasoningProvider],
    ]);
    const cp = createConcurrentProvider(providers);

    const scaler = createReasoningScaler();
    const result = await scaler.solve('Fix the typo', 'easy', cp);

    expect(result.difficulty).toBe('easy');
    expect(result.candidatesGenerated).toBe(1);
    expect(result.response.model).toBe('qwen3.5:122b');
    expect(codingProvider.generateWithTools).toHaveBeenCalledOnce();
    expect(reasoningProvider.generateWithTools).not.toHaveBeenCalled();
  });

  it('uses parallel generation for medium problems', async () => {
    const codingProvider = createMockProvider('ollama', 'coder', 'Code solution');
    const reasoningProvider = createMockProvider('ollama', 'reasoner', 'Reasoning solution with more detail');
    const providers = new Map<string, LlmProvider>([
      ['qwen3.5:122b', codingProvider],
      ['hermes3:70b', reasoningProvider],
    ]);
    const cp = createConcurrentProvider(providers);

    const scaler = createReasoningScaler();
    const result = await scaler.solve('Fix the bug', 'medium', cp);

    expect(result.difficulty).toBe('medium');
    expect(result.candidatesGenerated).toBe(2);
    // Both providers should have been called
    expect(codingProvider.generateWithTools).toHaveBeenCalled();
    expect(reasoningProvider.generateWithTools).toHaveBeenCalled();
  });

  it('uses bestOfN with judge for hard problems', async () => {
    const codingProvider = createMockProvider('ollama', 'coder', 'Coding answer');
    const reasoningProvider = createMockProvider('ollama', 'reasoner', 'Select candidate 1 because it is correct.');
    const providers = new Map<string, LlmProvider>([
      ['qwen3.5:122b', codingProvider],
      ['hermes3:70b', reasoningProvider],
    ]);
    const cp = createConcurrentProvider(providers);

    const scaler = createReasoningScaler({ maxCandidates: 2 });
    const result = await scaler.solve('Fix the complex race condition', 'hard', cp);

    expect(result.difficulty).toBe('hard');
    expect(result.candidatesGenerated).toBeGreaterThanOrEqual(1);
    expect(result.judgeReasoning).toBeDefined();
  });

  it('falls back to single generation when disabled', async () => {
    const codingProvider = createMockProvider('ollama', 'coder', 'Answer');
    const providers = new Map<string, LlmProvider>([
      ['qwen3.5:122b', codingProvider],
      ['hermes3:70b', createMockProvider('ollama', 'reasoner')],
    ]);
    const cp = createConcurrentProvider(providers);

    const scaler = createReasoningScaler({ enabled: false });
    const result = await scaler.solve('Hard problem', 'hard', cp);

    // Even though difficulty is 'hard', it should use single generation
    expect(result.candidatesGenerated).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AdversarialTester Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('AdversarialTester — Attack Generation', () => {
  it('generates test cases from LLM response', async () => {
    const testCasesJson = JSON.stringify([
      {
        description: 'Empty string input',
        input: '',
        expectedBehavior: 'should_throw',
        category: 'empty_input',
      },
      {
        description: 'Unicode emoji input',
        input: '🎉🎊',
        expectedBehavior: 'should_pass',
        category: 'unicode',
      },
    ]);

    const provider = createMockProvider(
      'ollama', 'reasoner',
      `Here are the test cases:\n\`\`\`json\n${testCasesJson}\n\`\`\``,
    );

    const tester = createAdversarialTester();
    const cases = await tester.generateAttacks(
      'function parse(input: string): Result { ... }',
      'parse(input: string): Result',
      provider,
    );

    expect(cases).toHaveLength(2);
    expect(cases[0]!.category).toBe('empty_input');
    expect(cases[1]!.category).toBe('unicode');
    expect(cases[0]!.expectedBehavior).toBe('should_throw');
  });

  it('returns empty array when disabled', async () => {
    const provider = createMockProvider('ollama', 'reasoner');
    const tester = createAdversarialTester({ enabled: false });

    const cases = await tester.generateAttacks('code', 'func()', provider);
    expect(cases).toHaveLength(0);
  });

  it('handles malformed LLM response gracefully', async () => {
    const provider = createMockProvider(
      'ollama', 'reasoner',
      'This is not valid JSON at all!',
    );

    const tester = createAdversarialTester();
    const cases = await tester.generateAttacks('code', 'func()', provider);

    expect(cases).toHaveLength(0); // Graceful degradation
  });

  it('validates attack categories', async () => {
    const testCasesJson = JSON.stringify([
      {
        description: 'Test',
        input: 'x',
        expectedBehavior: 'should_pass',
        category: 'nonexistent_category',
      },
    ]);

    const provider = createMockProvider(
      'ollama', 'reasoner',
      `\`\`\`json\n${testCasesJson}\n\`\`\``,
    );

    const tester = createAdversarialTester();
    const cases = await tester.generateAttacks('code', 'func()', provider);

    expect(cases[0]!.category).toBe('edge_case'); // Invalid → defaults to edge_case
  });

  it('respects maxTestCases limit', async () => {
    const manyCases = Array.from({ length: 20 }, (_, i) => ({
      description: `Test ${i}`,
      input: `input-${i}`,
      expectedBehavior: 'should_pass',
      category: 'edge_case',
    }));

    const provider = createMockProvider(
      'ollama', 'reasoner',
      `\`\`\`json\n${JSON.stringify(manyCases)}\n\`\`\``,
    );

    const tester = createAdversarialTester({ maxTestCases: 5 });
    const cases = await tester.generateAttacks('code', 'func()', provider);

    expect(cases).toHaveLength(5);
  });
});

describe('AdversarialTester — Test File Generation', () => {
  it('generates a valid vitest test file', () => {
    const tester = createAdversarialTester();
    const testCases: TestCase[] = [
      {
        description: 'Empty input',
        input: '',
        expectedBehavior: 'should_throw',
        category: 'empty_input',
      },
      {
        description: 'Normal input',
        input: 'hello',
        expectedBehavior: 'should_pass',
        category: 'edge_case',
      },
    ];

    const file = tester.generateTestFile(
      testCases,
      'src/parser.ts',
      'parse(input: string)',
    );

    expect(file).toContain("import { describe, it, expect } from 'vitest'");
    expect(file).toContain('Adversarial: parse(input: string)');
    expect(file).toContain('[empty_input] Empty input');
    expect(file).toContain('.toThrow()');
    expect(file).toContain('.not.toThrow()');
  });

  it('escapes single quotes in test names', () => {
    const tester = createAdversarialTester();
    const testCases: TestCase[] = [
      {
        description: "It's a test",
        input: '',
        expectedBehavior: 'should_pass',
        category: 'edge_case',
      },
    ];

    const file = tester.generateTestFile(testCases, 'src/x.ts', 'fn()');
    expect(file).toContain("\\'s a test");
  });
});

describe('AdversarialTester — Result Scoring', () => {
  it('calculates robustness score correctly', () => {
    const tester = createAdversarialTester();

    const report = {
      targetFile: 'src/test.ts',
      functionSignature: 'fn()',
      testCases: [],
      results: [],
      vulnerabilities: 0,
      defended: 0,
      robustnessScore: 0,
      durationMs: 100,
    };

    const results: AttackResult[] = [
      { testCase: {} as TestCase, passed: true, output: 'OK', durationMs: 10 },
      { testCase: {} as TestCase, passed: true, output: 'OK', durationMs: 10 },
      { testCase: {} as TestCase, passed: false, output: 'FAIL', error: 'error', durationMs: 10 },
    ];

    const scored = tester.scoreResults(report, results);

    expect(scored.defended).toBe(2);
    expect(scored.vulnerabilities).toBe(1);
    expect(scored.robustnessScore).toBeCloseTo(2 / 3);
  });

  it('handles empty results', () => {
    const tester = createAdversarialTester();

    const report = {
      targetFile: 'src/test.ts',
      functionSignature: 'fn()',
      testCases: [],
      results: [],
      vulnerabilities: 0,
      defended: 0,
      robustnessScore: 0,
      durationMs: 0,
    };

    const scored = tester.scoreResults(report, []);
    expect(scored.robustnessScore).toBe(0);
  });
});

describe('AdversarialTester — Report Building', () => {
  it('builds a report with test cases', async () => {
    const testCasesJson = JSON.stringify([
      {
        description: 'Empty input',
        input: '',
        expectedBehavior: 'should_throw',
        category: 'empty_input',
      },
    ]);

    const provider = createMockProvider(
      'ollama', 'reasoner',
      `\`\`\`json\n${testCasesJson}\n\`\`\``,
    );

    const tester = createAdversarialTester();
    const report = await tester.buildReport(
      'function parse(s: string) { return s; }',
      'parse(s: string)',
      'src/parser.ts',
      provider,
    );

    expect(report.targetFile).toBe('src/parser.ts');
    expect(report.functionSignature).toBe('parse(s: string)');
    expect(report.testCases).toHaveLength(1);
    expect(report.results).toHaveLength(0); // Not executed yet
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Factory Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Factories', () => {
  it('createConcurrentProvider creates a working instance', () => {
    const cp = createConcurrentProvider(new Map());
    expect(cp.getRegisteredModels()).toHaveLength(0);
    expect(cp.getActiveRequests()).toBe(0);
  });

  it('createReasoningScaler creates a working instance', () => {
    const scaler = createReasoningScaler({ enabled: false });
    expect(scaler.isEnabled()).toBe(false);
  });

  it('createAdversarialTester creates a working instance', () => {
    const tester = createAdversarialTester({ maxTestCases: 5 });
    expect(tester.isEnabled()).toBe(true);
    expect(tester.getConfig().maxTestCases).toBe(5);
  });
});
