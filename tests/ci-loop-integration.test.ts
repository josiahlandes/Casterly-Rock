import { describe, expect, it } from 'vitest';

import type { LlmProvider, GenerateRequest } from '../src/providers/base.js';
import type {
  ToolSchema,
  ToolResultMessage,
  GenerateWithToolsResponse,
  NativeToolCall,
  NativeToolResult,
} from '../src/tools/schemas/types.js';
import { compareTestRuns, getPassingTests, getFailingTests } from '../src/ci-loop/regression-guard.js';
import { computeNormalizedChange, computeEvoScore } from '../src/ci-loop/metrics.js';
import type { TestRunResult, RegressionReport, NormalizedChange } from '../src/ci-loop/types.js';
import { DEFAULT_CI_LOOP_CONFIG } from '../src/ci-loop/types.js';
import { ARCHITECT_TOOLS } from '../src/ci-loop/architect.js';
import { PROGRAMMER_TOOLS } from '../src/ci-loop/programmer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTestRun(tests: Array<{ name: string; status: 'passed' | 'failed' }>): TestRunResult {
  return {
    tests: tests.map((t) => ({ name: t.name, status: t.status })),
    total: tests.length,
    passed: tests.filter((t) => t.status === 'passed').length,
    failed: tests.filter((t) => t.status === 'failed').length,
    errored: 0,
    skipped: 0,
    exitCode: 0,
    rawOutput: '',
    timestamp: Date.now(),
  };
}

function createMockProvider(responses: GenerateWithToolsResponse[]): LlmProvider {
  let callIndex = 0;
  return {
    id: 'mock-provider',
    kind: 'local',
    model: 'mock-model',
    async generateWithTools(
      _request: GenerateRequest,
      _tools: ToolSchema[],
      _previousResults?: ToolResultMessage[],
    ): Promise<GenerateWithToolsResponse> {
      if (callIndex >= responses.length) {
        return {
          text: 'No more mock responses.',
          toolCalls: [],
          providerId: 'mock-provider',
          model: 'mock-model',
          stopReason: 'end_turn',
        };
      }
      const response = responses[callIndex]!;
      callIndex++;
      return response;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Integration Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('CI Loop Integration', () => {
  describe('End-to-end regression + metrics flow', () => {
    it('should compute correct metrics for a 3-iteration improvement scenario', () => {
      // Simulate 3 iterations of improvement
      const iter0Pre = makeTestRun([
        { name: 'test-a', status: 'passed' },
        { name: 'test-b', status: 'failed' },
        { name: 'test-c', status: 'failed' },
        { name: 'test-d', status: 'failed' },
        { name: 'test-e', status: 'passed' },
      ]);
      const iter0Post = makeTestRun([
        { name: 'test-a', status: 'passed' },
        { name: 'test-b', status: 'passed' },  // fixed
        { name: 'test-c', status: 'failed' },
        { name: 'test-d', status: 'failed' },
        { name: 'test-e', status: 'passed' },
      ]);

      const iter1Pre = iter0Post;
      const iter1Post = makeTestRun([
        { name: 'test-a', status: 'passed' },
        { name: 'test-b', status: 'passed' },
        { name: 'test-c', status: 'passed' },  // fixed
        { name: 'test-d', status: 'failed' },
        { name: 'test-e', status: 'passed' },
      ]);

      const iter2Pre = iter1Post;
      const iter2Post = makeTestRun([
        { name: 'test-a', status: 'passed' },
        { name: 'test-b', status: 'passed' },
        { name: 'test-c', status: 'passed' },
        { name: 'test-d', status: 'passed' },  // fixed
        { name: 'test-e', status: 'passed' },
      ]);

      // Compute regression reports
      const reg0 = compareTestRuns(iter0Pre, iter0Post);
      const reg1 = compareTestRuns(iter1Pre, iter1Post);
      const reg2 = compareTestRuns(iter2Pre, iter2Post);

      // No regressions in any iteration
      expect(reg0.hasRegressions).toBe(false);
      expect(reg1.hasRegressions).toBe(false);
      expect(reg2.hasRegressions).toBe(false);

      // Compute NC for each iteration
      const nc0 = computeNormalizedChange(reg0, 3, 2, 0, 5);
      const nc1 = computeNormalizedChange(reg1, 2, 3, 1, 5);
      const nc2 = computeNormalizedChange(reg2, 1, 4, 2, 5);

      // All positive (improvement each iteration)
      expect(nc0.value).toBeGreaterThan(0);
      expect(nc1.value).toBeGreaterThan(0);
      expect(nc2.value).toBeGreaterThan(0);

      // EvoScore should be positive
      const evoScore = computeEvoScore([nc0, nc1, nc2], 1.0);
      expect(evoScore).toBeGreaterThan(0);
    });

    it('should compute correct metrics for a regression-heavy scenario', () => {
      const iter0Pre = makeTestRun([
        { name: 'test-a', status: 'passed' },
        { name: 'test-b', status: 'passed' },
        { name: 'test-c', status: 'failed' },
      ]);
      const iter0Post = makeTestRun([
        { name: 'test-a', status: 'failed' },  // REGRESSED
        { name: 'test-b', status: 'passed' },
        { name: 'test-c', status: 'passed' },  // fixed
      ]);

      const reg0 = compareTestRuns(iter0Pre, iter0Post);
      expect(reg0.hasRegressions).toBe(true);
      expect(reg0.regressionCount).toBe(1);
      expect(reg0.fixedCount).toBe(1);

      // NC should be 0 (net change = 0)
      const nc0 = computeNormalizedChange(reg0, 1, 2, 0, 3);
      expect(nc0.value).toBe(0);
    });
  });

  describe('Tool definitions', () => {
    it('should have valid architect tools (read-only)', () => {
      expect(ARCHITECT_TOOLS.length).toBeGreaterThan(0);
      for (const tool of ARCHITECT_TOOLS) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema.type).toBe('object');
        // Architect should not have write tools
        expect(tool.name).not.toBe('edit_file');
        expect(tool.name).not.toBe('write_file');
      }
    });

    it('should have valid programmer tools (read-write)', () => {
      expect(PROGRAMMER_TOOLS.length).toBeGreaterThan(0);
      const toolNames = PROGRAMMER_TOOLS.map((t) => t.name);
      // Programmer should have write capabilities
      expect(toolNames).toContain('edit_file');
      expect(toolNames).toContain('write_file');
      // And read capabilities
      expect(toolNames).toContain('read_file');
    });
  });

  describe('Default configuration', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_CI_LOOP_CONFIG.maxIterations).toBeGreaterThan(0);
      expect(DEFAULT_CI_LOOP_CONFIG.maxRequirementsPerIteration).toBe(5);
      expect(DEFAULT_CI_LOOP_CONFIG.gamma).toBe(1.0);
      expect(DEFAULT_CI_LOOP_CONFIG.stopOnAllPass).toBe(true);
      expect(DEFAULT_CI_LOOP_CONFIG.stagnationLimit).toBeGreaterThan(0);
    });
  });

  describe('Passing/failing test extraction', () => {
    it('should correctly extract test categories', () => {
      const result = makeTestRun([
        { name: 'pass-1', status: 'passed' },
        { name: 'pass-2', status: 'passed' },
        { name: 'fail-1', status: 'failed' },
      ]);

      expect(getPassingTests(result)).toEqual(['pass-1', 'pass-2']);
      expect(getFailingTests(result)).toEqual(['fail-1']);
    });
  });
});
