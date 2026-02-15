import { describe, expect, it } from 'vitest';

import { evaluateResult, formatTestResult, formatTestSummary } from '../src/testing/test-runner.js';
import type { TestCase, TestResult } from '../src/testing/test-cases.js';
import type { RequestTrace, TraceSummary } from '../src/testing/trace.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeTrace(overrides: Partial<RequestTrace> = {}): RequestTrace {
  return {
    traceId: 'trace-test',
    startTime: 1000,
    endTime: 2000,
    input: 'test input',
    events: [],
    summary: {
      totalDurationMs: 1000,
      providerSelected: { provider: 'local', model: 'test-model' },
      llmCalls: 1,
      toolCallsRequested: 0,
      toolCallsExecuted: 0,
      toolCallsBlocked: 0,
      iterations: 1,
      provider: 'local',
      model: 'test-model',
    },
    ...overrides,
  };
}

function makeTestCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'test-001',
    name: 'Test case',
    description: 'A test case',
    input: 'Hello',
    expected: { shouldSucceed: true },
    ...overrides,
  };
}

function makeResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    testCase: makeTestCase(),
    passed: true,
    failures: [],
    warnings: [],
    actualOutcome: {
      provider: 'local',
      model: 'test-model',
      toolsCalled: [],
      toolCallCount: 0,
      response: 'Hello!',
      durationMs: 500,
      error: null,
    },
    trace: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// evaluateResult — shouldSucceed
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateResult — shouldSucceed', () => {
  it('passes when shouldSucceed=true and no error', () => {
    const tc = makeTestCase({ expected: { shouldSucceed: true } });
    const trace = makeTrace();
    const result = evaluateResult(tc, trace, 'Hi!', null);
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('fails when shouldSucceed=true but has error', () => {
    const tc = makeTestCase({ expected: { shouldSucceed: true } });
    const trace = makeTrace();
    const result = evaluateResult(tc, trace, '', 'Timeout');
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('error'))).toBe(true);
  });

  it('passes when shouldSucceed=false and has error', () => {
    const tc = makeTestCase({ expected: { shouldSucceed: false } });
    const trace = makeTrace();
    const result = evaluateResult(tc, trace, '', 'Expected error');
    expect(result.passed).toBe(true);
  });

  it('fails when shouldSucceed=false but no error', () => {
    const tc = makeTestCase({ expected: { shouldSucceed: false } });
    const trace = makeTrace();
    const result = evaluateResult(tc, trace, 'Success!', null);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('Expected error'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evaluateResult — shouldCallTools
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateResult — shouldCallTools', () => {
  it('passes when tools expected and called', () => {
    const tc = makeTestCase({ expected: { shouldCallTools: true } });
    const trace = makeTrace({
      events: [{ id: 'e1', type: 'tool_call_received', timestamp: 1000, data: { toolName: 'bash' } }],
      summary: {
        totalDurationMs: 1000,
        providerSelected: null,
        llmCalls: 1,
        toolCallsRequested: 1,
        toolCallsExecuted: 1,
        toolCallsBlocked: 0,
        iterations: 1,
        provider: null,
        model: null,
      },
    });
    const result = evaluateResult(tc, trace, 'Done', null);
    expect(result.passed).toBe(true);
  });

  it('fails when tools expected but not called', () => {
    const tc = makeTestCase({ expected: { shouldCallTools: true } });
    const trace = makeTrace();
    const result = evaluateResult(tc, trace, 'Done', null);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('Expected tool calls'))).toBe(true);
  });

  it('fails when no tools expected but called', () => {
    const tc = makeTestCase({ expected: { shouldCallTools: false } });
    const trace = makeTrace({
      summary: {
        totalDurationMs: 1000,
        providerSelected: null,
        llmCalls: 1,
        toolCallsRequested: 2,
        toolCallsExecuted: 2,
        toolCallsBlocked: 0,
        iterations: 1,
        provider: null,
        model: null,
      },
    });
    const result = evaluateResult(tc, trace, 'Done', null);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('no tool calls'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evaluateResult — expectedToolNames
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateResult — expectedToolNames', () => {
  it('passes when expected tools are called', () => {
    const tc = makeTestCase({ expected: { expectedToolNames: ['bash'] } });
    const trace = makeTrace({
      events: [{ id: 'e1', type: 'tool_call_received', timestamp: 1000, data: { toolName: 'bash' } }],
    });
    const result = evaluateResult(tc, trace, 'Done', null);
    expect(result.passed).toBe(true);
  });

  it('fails when expected tool is not called', () => {
    const tc = makeTestCase({ expected: { expectedToolNames: ['bash'] } });
    const trace = makeTrace({ events: [] });
    const result = evaluateResult(tc, trace, 'Done', null);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('"bash" not called'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evaluateResult — toolCallCount
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateResult — toolCallCount', () => {
  it('passes when count in range', () => {
    const tc = makeTestCase({ expected: { toolCallCount: { min: 1, max: 3 } } });
    const trace = makeTrace({
      summary: {
        totalDurationMs: 1000,
        providerSelected: null,
        llmCalls: 1,
        toolCallsRequested: 2,
        toolCallsExecuted: 2,
        toolCallsBlocked: 0,
        iterations: 1,
        provider: null,
        model: null,
      },
    });
    const result = evaluateResult(tc, trace, 'Done', null);
    expect(result.passed).toBe(true);
  });

  it('fails when count below min', () => {
    const tc = makeTestCase({ expected: { toolCallCount: { min: 2 } } });
    const trace = makeTrace({
      summary: {
        totalDurationMs: 1000,
        providerSelected: null,
        llmCalls: 1,
        toolCallsRequested: 1,
        toolCallsExecuted: 1,
        toolCallsBlocked: 0,
        iterations: 1,
        provider: null,
        model: null,
      },
    });
    const result = evaluateResult(tc, trace, 'Done', null);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('below minimum'))).toBe(true);
  });

  it('fails when count above max', () => {
    const tc = makeTestCase({ expected: { toolCallCount: { max: 1 } } });
    const trace = makeTrace({
      summary: {
        totalDurationMs: 1000,
        providerSelected: null,
        llmCalls: 1,
        toolCallsRequested: 5,
        toolCallsExecuted: 5,
        toolCallsBlocked: 0,
        iterations: 1,
        provider: null,
        model: null,
      },
    });
    const result = evaluateResult(tc, trace, 'Done', null);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('above maximum'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evaluateResult — response patterns
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateResult — response patterns', () => {
  it('passes when responsePattern matches', () => {
    const tc = makeTestCase({ expected: { responsePattern: /\d{4}/ } });
    const trace = makeTrace();
    const result = evaluateResult(tc, trace, 'The year is 2025', null);
    expect(result.passed).toBe(true);
  });

  it('fails when responsePattern does not match', () => {
    const tc = makeTestCase({ expected: { responsePattern: /\d{4}/ } });
    const trace = makeTrace();
    const result = evaluateResult(tc, trace, 'Hello world', null);
    expect(result.passed).toBe(false);
  });

  it('passes when responseExcludePattern does not match', () => {
    const tc = makeTestCase({ expected: { responseExcludePattern: /error/i } });
    const trace = makeTrace();
    const result = evaluateResult(tc, trace, 'All good!', null);
    expect(result.passed).toBe(true);
  });

  it('fails when responseExcludePattern matches', () => {
    const tc = makeTestCase({ expected: { responseExcludePattern: /error/i } });
    const trace = makeTrace();
    const result = evaluateResult(tc, trace, 'An Error occurred', null);
    expect(result.passed).toBe(false);
  });

  it('passes when responseContains keywords present', () => {
    const tc = makeTestCase({ expected: { responseContains: ['Paris', 'France'] } });
    const trace = makeTrace();
    const result = evaluateResult(tc, trace, 'Paris is the capital of France', null);
    expect(result.passed).toBe(true);
  });

  it('fails when responseContains keyword missing', () => {
    const tc = makeTestCase({ expected: { responseContains: ['Paris', 'Berlin'] } });
    const trace = makeTrace();
    const result = evaluateResult(tc, trace, 'Paris is the capital of France', null);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('Berlin'))).toBe(true);
  });

  it('responseContains is case insensitive', () => {
    const tc = makeTestCase({ expected: { responseContains: ['paris'] } });
    const trace = makeTrace();
    const result = evaluateResult(tc, trace, 'PARIS is the capital', null);
    expect(result.passed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evaluateResult — maxDurationMs
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateResult — maxDurationMs', () => {
  it('passes when duration within limit', () => {
    const tc = makeTestCase({ expected: { maxDurationMs: 5000 } });
    const trace = makeTrace();
    const result = evaluateResult(tc, trace, 'Done', null);
    expect(result.passed).toBe(true);
  });

  it('fails when duration exceeds limit', () => {
    const tc = makeTestCase({ expected: { maxDurationMs: 500 } });
    const trace = makeTrace({
      summary: {
        totalDurationMs: 10000,
        providerSelected: null,
        llmCalls: 1,
        toolCallsRequested: 0,
        toolCallsExecuted: 0,
        toolCallsBlocked: 0,
        iterations: 1,
        provider: null,
        model: null,
      },
    });
    const result = evaluateResult(tc, trace, 'Done', null);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('exceeds maximum'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evaluateResult — actualOutcome
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateResult — actualOutcome', () => {
  it('populates actual outcome fields', () => {
    const tc = makeTestCase();
    const trace = makeTrace({
      events: [
        { id: 'e1', type: 'tool_call_received', timestamp: 1000, data: { toolName: 'bash' } },
        { id: 'e2', type: 'tool_call_received', timestamp: 1001, data: { toolName: 'read_file' } },
      ],
    });
    const result = evaluateResult(tc, trace, 'Response text', null);
    expect(result.actualOutcome.response).toBe('Response text');
    expect(result.actualOutcome.toolsCalled).toEqual(['bash', 'read_file']);
    expect(result.actualOutcome.error).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatTestResult
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatTestResult', () => {
  it('shows PASS for passing test', () => {
    const result = makeResult();
    const formatted = formatTestResult(result);
    expect(formatted).toContain('PASS');
    expect(formatted).toContain('test-001');
  });

  it('shows FAIL for failing test', () => {
    const result = makeResult({
      passed: false,
      failures: ['Something went wrong'],
    });
    const formatted = formatTestResult(result);
    expect(formatted).toContain('FAIL');
    expect(formatted).toContain('Something went wrong');
  });

  it('includes details for failing test', () => {
    const result = makeResult({
      passed: false,
      failures: ['Error A'],
    });
    const formatted = formatTestResult(result);
    expect(formatted).toContain('Description:');
    expect(formatted).toContain('Input:');
  });

  it('includes details when verbose', () => {
    const result = makeResult();
    const formatted = formatTestResult(result, true);
    expect(formatted).toContain('Duration:');
    expect(formatted).toContain('Provider:');
  });

  it('shows warnings when present', () => {
    const result = makeResult({ warnings: ['Minor issue'] });
    const formatted = formatTestResult(result, true);
    expect(formatted).toContain('Minor issue');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatTestSummary
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatTestSummary', () => {
  it('formats summary with counts', () => {
    const summary = {
      totalTests: 10,
      passed: 8,
      failed: 2,
      skipped: 0,
      totalDurationMs: 5000,
      results: [],
    };
    const formatted = formatTestSummary(summary);
    expect(formatted).toContain('Total Tests: 10');
    expect(formatted).toContain('Passed: 8');
    expect(formatted).toContain('Failed: 2');
    expect(formatted).toContain('5000ms');
  });

  it('lists failed test details', () => {
    const failResult = makeResult({
      passed: false,
      failures: ['Tool not called'],
    });
    const summary = {
      totalTests: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      totalDurationMs: 1000,
      results: [failResult],
    };
    const formatted = formatTestSummary(summary);
    expect(formatted).toContain('Failed Tests:');
    expect(formatted).toContain('Tool not called');
  });

  it('includes summary header', () => {
    const summary = {
      totalTests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      totalDurationMs: 0,
      results: [],
    };
    const formatted = formatTestSummary(summary);
    expect(formatted).toContain('TEST RUN SUMMARY');
  });
});
