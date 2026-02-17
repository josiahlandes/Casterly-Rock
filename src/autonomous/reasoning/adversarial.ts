/**
 * Adversarial Tester — Self-attacking code verification
 *
 * After Tyrion writes code, this module generates adversarial inputs
 * and edge cases using the reasoning model, then executes them against
 * the implementation. Failures feed back into the agent loop for fixing.
 *
 * Flow:
 *   1. Tyrion writes code (coding model).
 *   2. Adversarial tester generates edge cases (reasoning model).
 *   3. Edge cases are formatted as test code.
 *   4. Tests are executed.
 *   5. Failures feed back as issues for the agent loop.
 *
 * The reasoning model is used for attack generation because it's better
 * at creative/lateral thinking, while the coding model is better at
 * implementation. This creates a productive adversarial dynamic.
 *
 * Privacy: All inference and testing is local. No data leaves the machine.
 */

import type { LlmProvider, GenerateRequest } from '../../providers/base.js';
import type { GenerateWithToolsResponse } from '../../tools/schemas/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single adversarial test case.
 */
export interface TestCase {
  /** Description of what this test case targets */
  description: string;

  /** The input to test with */
  input: string;

  /** Expected behavior (pass/fail/throws) */
  expectedBehavior: 'should_pass' | 'should_fail' | 'should_throw';

  /** Category of the attack */
  category: AttackCategory;
}

/**
 * Categories of adversarial attacks.
 */
export type AttackCategory =
  | 'empty_input'
  | 'boundary_value'
  | 'unicode'
  | 'injection'
  | 'overflow'
  | 'null_undefined'
  | 'type_coercion'
  | 'concurrency'
  | 'malformed'
  | 'edge_case';

/**
 * Result of executing a single test case.
 */
export interface AttackResult {
  /** The test case that was executed */
  testCase: TestCase;

  /** Whether the test passed (code handled the attack correctly) */
  passed: boolean;

  /** Output from the test */
  output: string;

  /** Error message if the test crashed */
  error?: string;

  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Summary of an adversarial testing session.
 */
export interface AdversarialReport {
  /** Target file that was tested */
  targetFile: string;

  /** Function signature that was tested */
  functionSignature: string;

  /** All test cases generated */
  testCases: TestCase[];

  /** Results of executing test cases */
  results: AttackResult[];

  /** Number of attacks that found issues */
  vulnerabilities: number;

  /** Number of attacks the code handled correctly */
  defended: number;

  /** Overall robustness score (0-1) */
  robustnessScore: number;

  /** Duration of the entire adversarial session */
  durationMs: number;
}

/**
 * Configuration for the adversarial tester.
 */
export interface AdversarialTesterConfig {
  /** Maximum test cases to generate per function */
  maxTestCases: number;

  /** Whether adversarial testing is enabled */
  enabled: boolean;

  /** Temperature for attack generation (higher = more creative) */
  attackTemperature: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AdversarialTesterConfig = {
  maxTestCases: 10,
  enabled: true,
  attackTemperature: 0.7,
};

/**
 * Prompt template for generating adversarial test cases.
 */
function buildAttackPrompt(code: string, functionSignature: string): string {
  return `You are an adversarial tester. Your job is to find edge cases and inputs that would break or expose bugs in the following code.

## Target Function

\`\`\`typescript
${functionSignature}
\`\`\`

## Implementation

\`\`\`typescript
${code}
\`\`\`

## Your Task

Generate adversarial test cases that might break this code. Focus on:

1. **Empty/null inputs** — What happens with empty strings, null, undefined?
2. **Boundary values** — Maximum/minimum values, off-by-one errors.
3. **Unicode** — Non-ASCII characters, emoji, RTL text, zero-width characters.
4. **Injection** — Special characters that might break parsing or escaping.
5. **Type coercion** — Values that JavaScript might coerce unexpectedly.
6. **Malformed input** — Data that looks right but has subtle issues.
7. **Edge cases** — Unusual but valid inputs the developer might not have considered.

For each test case, provide:
- A description of what you're testing
- The specific input
- Whether the code should pass, fail, or throw for that input
- The attack category

Format your response as a JSON array:
\`\`\`json
[
  {
    "description": "Empty string input",
    "input": "",
    "expectedBehavior": "should_throw",
    "category": "empty_input"
  }
]
\`\`\`

Generate ${DEFAULT_CONFIG.maxTestCases} test cases. Be creative and thorough.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial Tester
// ─────────────────────────────────────────────────────────────────────────────

export class AdversarialTester {
  private readonly config: AdversarialTesterConfig;

  constructor(config?: Partial<AdversarialTesterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Attack Generation ──────────────────────────────────────────────────

  /**
   * Generate adversarial test cases for a given function using the
   * reasoning model. The reasoning model is preferred for this because
   * it's better at creative/lateral thinking about edge cases.
   */
  async generateAttacks(
    code: string,
    functionSignature: string,
    provider: LlmProvider,
  ): Promise<TestCase[]> {
    if (!this.config.enabled) {
      return [];
    }

    const request: GenerateRequest = {
      prompt: buildAttackPrompt(code, functionSignature),
      systemPrompt: 'You are an expert adversarial tester. Generate creative, thorough edge case tests. Respond only with a JSON array of test cases.',
      temperature: this.config.attackTemperature,
      maxTokens: 4096,
    };

    const response: GenerateWithToolsResponse = await provider.generateWithTools(
      request,
      [], // No tools needed for generation
    );

    return this.parseTestCases(response.text);
  }

  /**
   * Build a complete adversarial report for a function.
   * This generates attacks but does NOT execute them — that's done by
   * the agent loop via the `run_tests` tool after writing the test file.
   */
  async buildReport(
    code: string,
    functionSignature: string,
    targetFile: string,
    provider: LlmProvider,
  ): Promise<AdversarialReport> {
    const startMs = Date.now();

    const testCases = await this.generateAttacks(code, functionSignature, provider);

    return {
      targetFile,
      functionSignature,
      testCases,
      results: [], // Populated by the agent loop after running tests
      vulnerabilities: 0,
      defended: 0,
      robustnessScore: 0,
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Generate a Vitest test file from adversarial test cases.
   * The agent loop writes this file and then runs it via `run_tests`.
   */
  generateTestFile(
    testCases: TestCase[],
    targetFile: string,
    functionSignature: string,
  ): string {
    const lines: string[] = [
      `// Auto-generated adversarial tests for: ${functionSignature}`,
      `// Target: ${targetFile}`,
      `// Generated by AdversarialTester`,
      '',
      `import { describe, it, expect } from 'vitest';`,
      '',
      `describe('Adversarial: ${functionSignature}', () => {`,
    ];

    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i]!;
      const testName = `[${tc.category}] ${tc.description}`;

      lines.push(`  it('${escapeTestName(testName)}', () => {`);
      lines.push(`    // Input: ${JSON.stringify(tc.input).slice(0, 100)}`);
      lines.push(`    // Expected: ${tc.expectedBehavior}`);

      switch (tc.expectedBehavior) {
        case 'should_pass':
          lines.push(`    // Should handle this input without errors`);
          lines.push(`    expect(() => { /* TODO: call function with input */ }).not.toThrow();`);
          break;
        case 'should_fail':
          lines.push(`    // Should reject this input gracefully`);
          lines.push(`    // TODO: verify graceful handling`);
          break;
        case 'should_throw':
          lines.push(`    // Should throw an error for this input`);
          lines.push(`    expect(() => { /* TODO: call function with input */ }).toThrow();`);
          break;
      }

      lines.push(`  });`);
      lines.push('');
    }

    lines.push('});');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Score the results of an adversarial testing session.
   * Returns an updated report with results filled in.
   */
  scoreResults(
    report: AdversarialReport,
    results: AttackResult[],
  ): AdversarialReport {
    const defended = results.filter((r) => r.passed).length;
    const vulnerabilities = results.filter((r) => !r.passed).length;
    const total = results.length;

    return {
      ...report,
      results,
      vulnerabilities,
      defended,
      robustnessScore: total > 0 ? defended / total : 0,
    };
  }

  // ── Parsing ────────────────────────────────────────────────────────────

  /**
   * Parse test cases from the LLM's response text.
   * Handles JSON embedded in markdown code blocks.
   */
  private parseTestCases(text: string): TestCase[] {
    // Try to extract JSON from the response
    const jsonMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    const jsonStr = jsonMatch ? jsonMatch[1]! : text;

    try {
      const parsed = JSON.parse(jsonStr.trim()) as unknown;

      if (!Array.isArray(parsed)) {
        return [];
      }

      const validCategories: Set<string> = new Set([
        'empty_input', 'boundary_value', 'unicode', 'injection',
        'overflow', 'null_undefined', 'type_coercion', 'concurrency',
        'malformed', 'edge_case',
      ]);

      return parsed
        .filter((item: unknown): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null,
        )
        .map((item) => ({
          description: String(item['description'] ?? 'Unknown test'),
          input: String(item['input'] ?? ''),
          expectedBehavior: validateBehavior(String(item['expectedBehavior'] ?? 'should_pass')),
          category: validateCategory(String(item['category'] ?? 'edge_case'), validCategories),
        }))
        .slice(0, this.config.maxTestCases);
    } catch {
      // JSON parsing failed — try to salvage partial data
      return [];
    }
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  /**
   * Check if adversarial testing is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): Readonly<AdversarialTesterConfig> {
    return this.config;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate and normalize the expected behavior string.
 */
function validateBehavior(value: string): TestCase['expectedBehavior'] {
  const valid: TestCase['expectedBehavior'][] = ['should_pass', 'should_fail', 'should_throw'];
  return valid.includes(value as TestCase['expectedBehavior'])
    ? (value as TestCase['expectedBehavior'])
    : 'should_pass';
}

/**
 * Validate and normalize the attack category string.
 */
function validateCategory(value: string, valid: Set<string>): AttackCategory {
  return valid.has(value) ? (value as AttackCategory) : 'edge_case';
}

/**
 * Escape a test name for use in a vitest `it()` call.
 */
function escapeTestName(name: string): string {
  return name.replace(/'/g, "\\'").replace(/\n/g, ' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an adversarial tester with the given configuration.
 */
export function createAdversarialTester(
  config?: Partial<AdversarialTesterConfig>,
): AdversarialTester {
  return new AdversarialTester(config);
}
