/**
 * Harness-Wrapped Tool Orchestrator
 *
 * Wraps a standard ToolOrchestrator with AutoHarness validation.
 * Before each tool call is executed, applicable harnesses are evaluated:
 *
 *   1. Lookup active harnesses for the tool (by name and '*' wildcard).
 *   2. Evaluate each action-verifier harness against the call context.
 *   3. If any harness blocks the call, return a structured rejection
 *      instead of executing the tool. The rejection includes the harness
 *      reason and optional suggested fix, so the LLM can retry.
 *   4. After execution, if the tool fails, record the failure against
 *      applicable harnesses for future refinement.
 *
 * This wrapper is transparent to the rest of the system: it implements
 * the same ToolOrchestrator interface. When no harnesses are active,
 * it behaves identically to the unwrapped orchestrator.
 */

import { safeLogger } from '../logging/safe-logger.js';
import type { ToolOrchestrator } from '../tools/orchestrator.js';
import type { NativeToolCall, NativeToolResult, NativeToolExecutor } from '../tools/schemas/types.js';
import type { HarnessContext, RecentToolCall } from './types.js';
import type { HarnessStore } from './store.js';
import { HarnessExecutor } from './executor.js';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface HarnessWrapperConfig {
  /** Maximum recent calls to keep for context */
  maxRecentCalls: number;

  /** Whether to record failures for refinement */
  recordFailures: boolean;

  /** Whether the wrapper is active (can be toggled at runtime) */
  enabled: boolean;
}

const DEFAULT_CONFIG: HarnessWrapperConfig = {
  maxRecentCalls: 20,
  recordFailures: true,
  enabled: true,
};

// ─── Wrapper ─────────────────────────────────────────────────────────────────

export class HarnessOrchestratorWrapper implements ToolOrchestrator {
  private readonly inner: ToolOrchestrator;
  private readonly store: HarnessStore;
  private readonly executor: HarnessExecutor;
  private readonly config: HarnessWrapperConfig;

  /** Rolling window of recent tool calls for context. */
  private recentCalls: RecentToolCall[] = [];

  /** Current agent turn (updated externally). */
  private turnNumber = 0;

  constructor(
    inner: ToolOrchestrator,
    store: HarnessStore,
    executor?: HarnessExecutor,
    config?: Partial<HarnessWrapperConfig>,
  ) {
    this.inner = inner;
    this.store = store;
    this.executor = executor ?? new HarnessExecutor();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Update the current turn number (called by the agent loop). */
  setTurnNumber(turn: number): void {
    this.turnNumber = turn;
  }

  /** Enable or disable harness evaluation at runtime. */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /** Whether harness evaluation is currently active. */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ── ToolOrchestrator Interface ─────────────────────────────────────────────

  registerExecutor(executor: NativeToolExecutor): void {
    this.inner.registerExecutor(executor);
  }

  canExecute(toolName: string): boolean {
    return this.inner.canExecute(toolName);
  }

  getRegisteredTools(): string[] {
    return this.inner.getRegisteredTools();
  }

  async execute(call: NativeToolCall): Promise<NativeToolResult> {
    // If disabled or no harnesses, pass through directly
    if (!this.config.enabled) {
      return this.executeAndRecord(call);
    }

    const harnesses = this.store.getForTool(call.name);
    if (harnesses.length === 0) {
      return this.executeAndRecord(call);
    }

    // Build context for harness evaluation
    const ctx: HarnessContext = {
      toolName: call.name,
      toolInput: call.input,
      recentCalls: this.recentCalls.slice(-this.config.maxRecentCalls),
      turnNumber: this.turnNumber,
      availableTools: this.inner.getRegisteredTools(),
    };

    // Evaluate all action-verifier harnesses
    for (const harness of harnesses) {
      if (harness.mode !== 'action-verifier') continue;

      const verdict = this.executor.evaluateVerifier(harness, ctx);

      if (!verdict.allowed) {
        // Increment harness block count
        harness.blockCount++;
        harness.evaluationCount++;
        this.executor.recordBlock(harness.id);

        safeLogger.info('Harness blocked tool call', {
          harnessId: harness.id,
          toolName: call.name,
          reason: verdict.reason.slice(0, 200),
        });

        // Record in recent calls as a blocked attempt
        this.pushRecentCall({
          toolName: call.name,
          input: call.input,
          success: false,
          timestamp: new Date().toISOString(),
        });

        // Return a structured rejection
        const fixHint = verdict.suggestedFix
          ? ` Suggested fix: ${verdict.suggestedFix}`
          : '';

        return {
          toolCallId: call.id,
          success: false,
          error: `[Harness] Action blocked: ${verdict.reason}${fixHint}`,
        };
      }

      harness.evaluationCount++;
    }

    // All harnesses passed — execute the tool
    return this.executeAndRecord(call);
  }

  async executeAll(calls: NativeToolCall[]): Promise<NativeToolResult[]> {
    const results: NativeToolResult[] = [];
    for (const call of calls) {
      results.push(await this.execute(call));
    }
    return results;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async executeAndRecord(call: NativeToolCall): Promise<NativeToolResult> {
    const result = await this.inner.execute(call);

    // Record in recent calls
    this.pushRecentCall({
      toolName: call.name,
      input: call.input,
      success: result.success,
      timestamp: new Date().toISOString(),
    });

    // If the tool failed, record failure against applicable harnesses
    if (!result.success && this.config.recordFailures) {
      const harnesses = this.store.getForTool(call.name);
      for (const harness of harnesses) {
        if (harness.mode === 'action-verifier') {
          // This is a false negative — the harness should have blocked this
          this.executor.recordFalseNegative(harness.id);

          await this.store.recordFailure({
            harnessId: harness.id,
            toolName: call.name,
            toolInput: call.input,
            errorType: 'false_negative',
            errorMessage: result.error ?? 'Tool execution failed',
            toolResult: {
              success: result.success,
              output: result.output,
              error: result.error,
            },
            timestamp: new Date().toISOString(),
          }).catch((err) => {
            safeLogger.warn('Failed to record harness failure', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    }

    return result;
  }

  private pushRecentCall(call: RecentToolCall): void {
    this.recentCalls.push(call);
    if (this.recentCalls.length > this.config.maxRecentCalls * 2) {
      this.recentCalls = this.recentCalls.slice(-this.config.maxRecentCalls);
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function wrapWithHarness(
  orchestrator: ToolOrchestrator,
  store: HarnessStore,
  executor?: HarnessExecutor,
  config?: Partial<HarnessWrapperConfig>,
): HarnessOrchestratorWrapper {
  return new HarnessOrchestratorWrapper(orchestrator, store, executor, config);
}
