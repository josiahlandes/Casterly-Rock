/**
 * AutoHarness Unit Tests
 *
 * Tests for the harness system: executor sandbox, store persistence,
 * orchestrator wrapper, and synthesizer prompt construction.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { HarnessExecutor, createHarnessExecutor } from '../src/harness/executor.js';
import { HarnessStore, createHarnessStore } from '../src/harness/store.js';
import { HarnessSynthesizer, createHarnessSynthesizer } from '../src/harness/synthesizer.js';
import { HarnessOrchestratorWrapper, wrapWithHarness } from '../src/harness/orchestrator-wrapper.js';
import { createToolOrchestrator } from '../src/tools/orchestrator.js';
import type {
  HarnessDefinition,
  HarnessContext,
  HarnessFailure,
} from '../src/harness/types.js';
import type { NativeToolCall, NativeToolResult, GenerateWithToolsResponse, ToolSchema, ToolResultMessage } from '../src/tools/schemas/types.js';
import type { LlmProvider, GenerateRequest } from '../src/providers/base.js';

// ─── Test Fixtures ───────────────────────────────────────────────────────────

function makeHarness(overrides?: Partial<HarnessDefinition>): HarnessDefinition {
  return {
    id: 'test-harness-1',
    name: 'test verifier',
    toolName: 'bash',
    mode: 'action-verifier',
    validationCode: `
      if (ctx.toolInput.command && typeof ctx.toolInput.command === 'string') {
        if (ctx.toolInput.command.includes('rm -rf /')) {
          return { allowed: false, reason: 'Dangerous: rm -rf /' };
        }
        if (ctx.toolInput.command.includes('DROP TABLE')) {
          return { allowed: false, reason: 'Dangerous: SQL DROP TABLE', suggestedFix: 'Use a SELECT query instead' };
        }
      }
      return { allowed: true, reason: 'Command looks safe' };
    `,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    refinementCount: 0,
    evaluationCount: 0,
    blockCount: 0,
    enabled: true,
    description: 'Blocks dangerous bash commands',
    version: 1,
    ...overrides,
  };
}

function makeContext(overrides?: Partial<HarnessContext>): HarnessContext {
  return {
    toolName: 'bash',
    toolInput: { command: 'ls -la' },
    recentCalls: [],
    turnNumber: 1,
    availableTools: ['bash', 'read_file', 'edit_file'],
    ...overrides,
  };
}

function makeToolCall(overrides?: Partial<NativeToolCall>): NativeToolCall {
  return {
    id: 'call-1',
    name: 'bash',
    input: { command: 'ls -la' },
    ...overrides,
  };
}

// ─── HarnessExecutor Tests ──────────────────────────────────────────────────

describe('HarnessExecutor', () => {
  let executor: HarnessExecutor;

  beforeEach(() => {
    executor = createHarnessExecutor({ verbose: false });
  });

  describe('evaluateVerifier', () => {
    it('allows safe commands', () => {
      const harness = makeHarness();
      const ctx = makeContext({ toolInput: { command: 'echo hello' } });

      const verdict = executor.evaluateVerifier(harness, ctx);

      expect(verdict.allowed).toBe(true);
      expect(verdict.reason).toBe('Command looks safe');
    });

    it('blocks dangerous rm -rf / commands', () => {
      const harness = makeHarness();
      const ctx = makeContext({ toolInput: { command: 'rm -rf /' } });

      const verdict = executor.evaluateVerifier(harness, ctx);

      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe('Dangerous: rm -rf /');
    });

    it('provides suggested fix when available', () => {
      const harness = makeHarness();
      const ctx = makeContext({ toolInput: { command: 'DROP TABLE users' } });

      const verdict = executor.evaluateVerifier(harness, ctx);

      expect(verdict.allowed).toBe(false);
      expect(verdict.suggestedFix).toBe('Use a SELECT query instead');
    });

    it('defaults to allowed on evaluation error', () => {
      const harness = makeHarness({
        validationCode: 'throw new Error("broken");',
      });
      const ctx = makeContext();

      const verdict = executor.evaluateVerifier(harness, ctx);

      expect(verdict.allowed).toBe(true);
      expect(verdict.reason).toContain('defaulting to allow');
    });

    it('defaults to allowed when result is not an object', () => {
      const harness = makeHarness({
        validationCode: 'return "not an object";',
      });
      const ctx = makeContext();

      const verdict = executor.evaluateVerifier(harness, ctx);

      expect(verdict.allowed).toBe(true);
    });

    it('returns wrong mode verdict for non-verifier harness', () => {
      const harness = makeHarness({ mode: 'policy' });
      const ctx = makeContext();

      const verdict = executor.evaluateVerifier(harness, ctx);

      expect(verdict.allowed).toBe(true);
      expect(verdict.reason).toContain('Wrong harness mode');
    });

    it('sandboxes dangerous globals', () => {
      const harness = makeHarness({
        validationCode: `
          if (typeof process !== 'undefined') {
            return { allowed: false, reason: 'process is accessible!' };
          }
          return { allowed: true, reason: 'sandbox works' };
        `,
      });
      const ctx = makeContext();

      const verdict = executor.evaluateVerifier(harness, ctx);

      expect(verdict.allowed).toBe(true);
      expect(verdict.reason).toBe('sandbox works');
    });

    it('sandboxes require', () => {
      const harness = makeHarness({
        validationCode: `
          if (typeof require !== 'undefined') {
            return { allowed: false, reason: 'require is accessible!' };
          }
          return { allowed: true, reason: 'sandbox works' };
        `,
      });
      const ctx = makeContext();

      const verdict = executor.evaluateVerifier(harness, ctx);

      expect(verdict.allowed).toBe(true);
      expect(verdict.reason).toBe('sandbox works');
    });

    it('can access recent call history', () => {
      const harness = makeHarness({
        validationCode: `
          var failedBashCount = ctx.recentCalls
            .filter(function(c) { return c.toolName === 'bash' && !c.success; })
            .length;
          if (failedBashCount >= 3) {
            return { allowed: false, reason: 'Too many recent bash failures' };
          }
          return { allowed: true, reason: 'OK' };
        `,
      });

      const recentCalls = [
        { toolName: 'bash', input: {}, success: false, timestamp: '2026-01-01T00:00:00Z' },
        { toolName: 'bash', input: {}, success: false, timestamp: '2026-01-01T00:01:00Z' },
        { toolName: 'bash', input: {}, success: false, timestamp: '2026-01-01T00:02:00Z' },
      ];

      const ctx = makeContext({ recentCalls });
      const verdict = executor.evaluateVerifier(harness, ctx);

      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toBe('Too many recent bash failures');
    });
  });

  describe('evaluateFilter', () => {
    it('returns filtered actions', () => {
      const harness = makeHarness({
        mode: 'action-filter',
        validationCode: `
          return {
            allowedTools: ctx.availableTools.filter(function(t) { return t !== 'bash'; }),
            inputConstraints: {},
            reason: 'Bash is disabled in filter mode',
          };
        `,
      });
      const ctx = makeContext();

      const result = executor.evaluateFilter(harness, ctx);

      expect(result.allowedTools).toEqual(['read_file', 'edit_file']);
      expect(result.reason).toBe('Bash is disabled in filter mode');
    });

    it('returns empty filter on error', () => {
      const harness = makeHarness({
        mode: 'action-filter',
        validationCode: 'throw new Error("fail");',
      });
      const ctx = makeContext();

      const result = executor.evaluateFilter(harness, ctx);

      expect(result.allowedTools).toEqual([]);
    });
  });

  describe('evaluatePolicy', () => {
    it('returns a policy action', () => {
      const harness = makeHarness({
        mode: 'policy',
        validationCode: `
          return {
            toolName: 'read_file',
            toolInput: { path: '/tmp/test.txt' },
            reason: 'Default policy: read first',
          };
        `,
      });
      const ctx = makeContext();

      const result = executor.evaluatePolicy(harness, ctx);

      expect(result.toolName).toBe('read_file');
      expect(result.toolInput).toEqual({ path: '/tmp/test.txt' });
    });
  });

  describe('metrics', () => {
    it('tracks evaluations', () => {
      const harness = makeHarness();
      const ctx = makeContext();

      executor.evaluateVerifier(harness, ctx);
      executor.evaluateVerifier(harness, ctx);

      const metrics = executor.getMetrics(harness.id);
      expect(metrics).toBeDefined();
      expect(metrics!.totalEvaluations).toBe(2);
    });

    it('tracks blocks and precision/recall', () => {
      const harness = makeHarness();

      executor.recordBlock(harness.id);
      executor.recordBlock(harness.id);
      executor.recordFalsePositive(harness.id);

      const metrics = executor.getMetrics(harness.id);
      expect(metrics!.blockedActions).toBe(2);
      expect(metrics!.falsePositives).toBe(1);
      // precision = 2 / (2 + 1) = 0.666...
      expect(metrics!.precision).toBeCloseTo(0.667, 2);
    });
  });
});

// ─── HarnessStore Tests ─────────────────────────────────────────────────────

describe('HarnessStore', () => {
  let tmpDir: string;
  let store: HarnessStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'harness-test-'));
    store = createHarnessStore({ directory: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('starts empty', async () => {
    await store.load();

    expect(store.isLoaded()).toBe(true);
    expect(store.getAll()).toHaveLength(0);
    expect(store.activeCount()).toBe(0);
  });

  it('saves and loads harness definitions', async () => {
    await store.load();

    const harness = makeHarness();
    await store.save(harness);

    // Create a new store and load from disk
    const store2 = createHarnessStore({ directory: tmpDir });
    await store2.load();

    const loaded = store2.get('test-harness-1');
    expect(loaded).toBeDefined();
    expect(loaded!.name).toBe('test verifier');
    expect(loaded!.toolName).toBe('bash');
  });

  it('removes harness from disk and memory', async () => {
    await store.load();

    const harness = makeHarness();
    await store.save(harness);
    expect(store.get('test-harness-1')).toBeDefined();

    await store.remove('test-harness-1');
    expect(store.get('test-harness-1')).toBeUndefined();

    // Verify file is gone
    const files = await readdir(tmpDir);
    expect(files.filter(f => f === 'test-harness-1.json')).toHaveLength(0);
  });

  it('retrieves harnesses by tool name', async () => {
    await store.load();

    await store.save(makeHarness({ id: 'h1', toolName: 'bash' }));
    await store.save(makeHarness({ id: 'h2', toolName: 'bash' }));
    await store.save(makeHarness({ id: 'h3', toolName: 'read_file' }));
    await store.save(makeHarness({ id: 'h4', toolName: '*' })); // Wildcard

    const bashHarnesses = store.getForTool('bash');
    expect(bashHarnesses).toHaveLength(3); // h1, h2, and h4 (wildcard)
  });

  it('records and retrieves failures', async () => {
    await store.load();

    const failure: HarnessFailure = {
      harnessId: 'test-harness-1',
      toolName: 'bash',
      toolInput: { command: 'bad command' },
      errorType: 'false_negative',
      errorMessage: 'Command failed',
      timestamp: '2026-01-01T00:00:00Z',
    };

    await store.recordFailure(failure);

    const failures = store.getFailures('test-harness-1');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.errorMessage).toBe('Command failed');
  });

  it('persists failures to disk', async () => {
    await store.load();

    const failure: HarnessFailure = {
      harnessId: 'test-harness-1',
      toolName: 'bash',
      toolInput: { command: 'bad' },
      errorType: 'false_negative',
      errorMessage: 'Failed',
      timestamp: '2026-01-01T00:00:00Z',
    };

    await store.recordFailure(failure);

    // Check the file exists
    const content = await readFile(
      join(tmpDir, 'failures', 'test-harness-1.json'),
      'utf8',
    );
    const parsed = JSON.parse(content) as HarnessFailure[];
    expect(parsed).toHaveLength(1);
  });

  it('clears failures', async () => {
    await store.load();

    const failure: HarnessFailure = {
      harnessId: 'test-harness-1',
      toolName: 'bash',
      toolInput: {},
      errorType: 'false_negative',
      errorMessage: 'Failed',
      timestamp: '2026-01-01T00:00:00Z',
    };

    await store.recordFailure(failure);
    expect(store.getFailures('test-harness-1')).toHaveLength(1);

    await store.clearFailures('test-harness-1');
    expect(store.getFailures('test-harness-1')).toHaveLength(0);
  });

  it('caps stored failures at maxFailuresPerHarness', async () => {
    store = createHarnessStore({ directory: tmpDir, maxFailuresPerHarness: 3 });
    await store.load();

    for (let i = 0; i < 5; i++) {
      await store.recordFailure({
        harnessId: 'h1',
        toolName: 'bash',
        toolInput: {},
        errorType: 'false_negative',
        errorMessage: `Failure ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    const failures = store.getFailures('h1');
    expect(failures).toHaveLength(3);
    expect(failures[0]!.errorMessage).toBe('Failure 2'); // Oldest capped
  });

  it('respects max harness limit', async () => {
    store = createHarnessStore({ directory: tmpDir, maxHarnesses: 2 });
    await store.load();

    await store.save(makeHarness({ id: 'h1' }));
    await store.save(makeHarness({ id: 'h2' }));

    expect(store.canAdd()).toBe(false);
  });
});

// ─── HarnessOrchestratorWrapper Tests ────────────────────────────────────────

describe('HarnessOrchestratorWrapper', () => {
  let tmpDir: string;
  let store: HarnessStore;
  let executor: HarnessExecutor;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'harness-wrap-'));
    store = createHarnessStore({ directory: tmpDir });
    executor = createHarnessExecutor();
    await store.load();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeOrchestrator() {
    const orch = createToolOrchestrator();
    orch.registerExecutor({
      toolName: 'bash',
      execute: async (call: NativeToolCall): Promise<NativeToolResult> => ({
        toolCallId: call.id,
        success: true,
        output: `Executed: ${call.input['command'] as string}`,
      }),
    });
    orch.registerExecutor({
      toolName: 'read_file',
      execute: async (call: NativeToolCall): Promise<NativeToolResult> => ({
        toolCallId: call.id,
        success: true,
        output: 'file contents',
      }),
    });
    return orch;
  }

  it('passes through when no harnesses are active', async () => {
    const orch = makeOrchestrator();
    const wrapped = wrapWithHarness(orch, store, executor);

    const result = await wrapped.execute(makeToolCall());

    expect(result.success).toBe(true);
    expect(result.output).toBe('Executed: ls -la');
  });

  it('blocks tool calls that fail harness validation', async () => {
    const orch = makeOrchestrator();
    await store.save(makeHarness());
    const wrapped = wrapWithHarness(orch, store, executor);

    const result = await wrapped.execute(
      makeToolCall({ input: { command: 'rm -rf /' } }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('[Harness] Action blocked');
    expect(result.error).toContain('rm -rf /');
  });

  it('allows tool calls that pass harness validation', async () => {
    const orch = makeOrchestrator();
    await store.save(makeHarness());
    const wrapped = wrapWithHarness(orch, store, executor);

    const result = await wrapped.execute(
      makeToolCall({ input: { command: 'echo hello' } }),
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe('Executed: echo hello');
  });

  it('includes suggested fix in rejection', async () => {
    const orch = makeOrchestrator();
    await store.save(makeHarness());
    const wrapped = wrapWithHarness(orch, store, executor);

    const result = await wrapped.execute(
      makeToolCall({ input: { command: 'DROP TABLE users' } }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Suggested fix');
    expect(result.error).toContain('SELECT');
  });

  it('skips harness evaluation when disabled', async () => {
    const orch = makeOrchestrator();
    await store.save(makeHarness());
    const wrapped = wrapWithHarness(orch, store, executor, { enabled: false });

    const result = await wrapped.execute(
      makeToolCall({ input: { command: 'rm -rf /' } }),
    );

    // Passes through because harness is disabled
    expect(result.success).toBe(true);
  });

  it('can be toggled at runtime', async () => {
    const orch = makeOrchestrator();
    await store.save(makeHarness());
    const wrapped = wrapWithHarness(orch, store, executor);

    // Initially enabled — should block
    const r1 = await wrapped.execute(
      makeToolCall({ input: { command: 'rm -rf /' } }),
    );
    expect(r1.success).toBe(false);

    // Disable — should pass through
    wrapped.setEnabled(false);
    const r2 = await wrapped.execute(
      makeToolCall({ id: 'call-2', input: { command: 'rm -rf /' } }),
    );
    expect(r2.success).toBe(true);

    // Re-enable — should block again
    wrapped.setEnabled(true);
    const r3 = await wrapped.execute(
      makeToolCall({ id: 'call-3', input: { command: 'rm -rf /' } }),
    );
    expect(r3.success).toBe(false);
  });

  it('delegates registerExecutor to inner orchestrator', async () => {
    const orch = makeOrchestrator();
    const wrapped = wrapWithHarness(orch, store, executor);

    expect(wrapped.canExecute('bash')).toBe(true);
    expect(wrapped.canExecute('nonexistent')).toBe(false);
    expect(wrapped.getRegisteredTools()).toContain('bash');
    expect(wrapped.getRegisteredTools()).toContain('read_file');
  });

  it('executeAll processes multiple calls', async () => {
    const orch = makeOrchestrator();
    await store.save(makeHarness());
    const wrapped = wrapWithHarness(orch, store, executor);

    const results = await wrapped.executeAll([
      makeToolCall({ id: 'c1', input: { command: 'echo safe' } }),
      makeToolCall({ id: 'c2', input: { command: 'rm -rf /' } }),
      makeToolCall({ id: 'c3', name: 'read_file', input: { path: '/tmp/f' } }),
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false); // Blocked
    expect(results[2]!.success).toBe(true); // Different tool, no harness
  });

  it('updates turn number', async () => {
    const orch = makeOrchestrator();
    const wrapped = wrapWithHarness(orch, store, executor);

    // Harness that checks turn number
    await store.save(makeHarness({
      id: 'turn-check',
      validationCode: `
        if (ctx.turnNumber > 50) {
          return { allowed: false, reason: 'Turn limit exceeded' };
        }
        return { allowed: true, reason: 'Within limits' };
      `,
    }));

    wrapped.setTurnNumber(10);
    const r1 = await wrapped.execute(makeToolCall());
    expect(r1.success).toBe(true);

    wrapped.setTurnNumber(100);
    const r2 = await wrapped.execute(makeToolCall({ id: 'c2' }));
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('Turn limit exceeded');
  });
});

// ─── HarnessSynthesizer Tests ────────────────────────────────────────────────

describe('HarnessSynthesizer', () => {
  function createMockProvider(code: string): LlmProvider {
    return {
      id: 'mock',
      kind: 'local',
      model: 'mock',
      async generateWithTools(
        _request: GenerateRequest,
        _tools: ToolSchema[],
        _previousResults?: ToolResultMessage[],
      ): Promise<GenerateWithToolsResponse> {
        return {
          text: code,
          toolCalls: [],
          providerId: 'mock',
          model: 'mock',
          stopReason: 'end_turn',
        };
      },
    };
  }

  const testToolSchema: ToolSchema = {
    name: 'bash',
    description: 'Execute a bash command',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run' },
      },
      required: ['command'],
    },
  };

  it('synthesizes a harness from LLM output', async () => {
    const synth = createHarnessSynthesizer();
    const provider = createMockProvider(`
      if (ctx.toolInput.command && ctx.toolInput.command.includes('rm')) {
        return { allowed: false, reason: 'No rm allowed' };
      }
      return { allowed: true, reason: 'OK' };
    `);

    const result = await synth.synthesize(
      provider,
      testToolSchema,
      'action-verifier',
      'Block dangerous bash commands',
    );

    expect(result).not.toBeNull();
    expect(result!.toolName).toBe('bash');
    expect(result!.mode).toBe('action-verifier');
    expect(result!.validationCode).toContain('rm');
    expect(result!.version).toBe(1);
  });

  it('rejects code with forbidden patterns', async () => {
    const synth = createHarnessSynthesizer();
    const provider = createMockProvider(`
      var fs = require('fs');
      return { allowed: true, reason: 'OK' };
    `);

    const result = await synth.synthesize(
      provider,
      testToolSchema,
      'action-verifier',
      'Should be rejected',
    );

    expect(result).toBeNull();
  });

  it('rejects code exceeding max length', async () => {
    const synth = createHarnessSynthesizer({ maxCodeLength: 10 });
    const provider = createMockProvider(
      'return { allowed: true, reason: "this is way too long for the limit" };',
    );

    const result = await synth.synthesize(
      provider,
      testToolSchema,
      'action-verifier',
      'Should be too long',
    );

    expect(result).toBeNull();
  });

  it('strips markdown fences from LLM output', async () => {
    const synth = createHarnessSynthesizer();
    const provider = createMockProvider(`\`\`\`javascript
return { allowed: true, reason: 'clean' };
\`\`\``);

    const result = await synth.synthesize(
      provider,
      testToolSchema,
      'action-verifier',
      'Test fence stripping',
    );

    expect(result).not.toBeNull();
    expect(result!.validationCode).not.toContain('```');
  });

  it('refines a harness with failures', async () => {
    const synth = createHarnessSynthesizer();
    const provider = createMockProvider(`
      if (ctx.toolInput.command && ctx.toolInput.command.includes('rm')) {
        return { allowed: false, reason: 'Improved: blocks rm' };
      }
      return { allowed: true, reason: 'OK' };
    `);

    const current = makeHarness({
      validationCode: 'return { allowed: true, reason: "original" };',
    });

    const result = await synth.refine(provider, {
      current,
      failures: [{
        harnessId: current.id,
        toolName: 'bash',
        toolInput: { command: 'rm important_file' },
        errorType: 'false_negative',
        errorMessage: 'Harness allowed rm command',
        timestamp: '2026-01-01T00:00:00Z',
      }],
      maxIterations: 3,
    });

    expect(result.success).toBe(true);
    expect(result.updated).toBeDefined();
    expect(result.updated!.version).toBe(2);
    expect(result.updated!.refinementCount).toBe(1);
    expect(result.iterationsUsed).toBeGreaterThan(0);
  });

  it('handles refinement failure gracefully', async () => {
    const synth = createHarnessSynthesizer();
    const provider: LlmProvider = {
      id: 'failing',
      kind: 'local',
      model: 'failing',
      async generateWithTools(): Promise<GenerateWithToolsResponse> {
        throw new Error('LLM unavailable');
      },
    };

    const current = makeHarness();
    const result = await synth.refine(provider, {
      current,
      failures: [],
      maxIterations: 2,
    });

    expect(result.success).toBe(false);
    expect(result.changelog).toContain('No valid refinement');
  });
});
