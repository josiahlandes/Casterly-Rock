/**
 * Reasoner Monitor — Intelligent progress evaluation for the coder loop.
 *
 * Instead of hard turn limits, the 27B reasoner evaluates progress at regular
 * checkpoints during coder execution. It decides whether the coder should
 * continue, has completed, is stuck, or needs replanning.
 *
 * Design principles:
 *   - Lightweight: compact context tier, ~300 token prompts, 256 max output
 *   - Fail-open: on timeout or error, defaults to 'continue' (never blocks)
 *   - Fast: thinking ON for reasoning quality, but minimal input/output
 *   - Deterministic stall detection as a fast heuristic (no LLM needed)
 */

import type { LlmProvider, GenerateRequest } from '../providers/base.js';
import type { DeepTierConfig } from './context-tiers.js';
import { buildProviderOptions } from './context-tiers.js';
import { extractJsonFromResponse } from './deep-loop.js';
import { getTracer } from '../autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ReasonerVerdict = 'continue' | 'complete' | 'stuck' | 'replan';

export interface CheckpointContext {
  /** Current step description (truncated) */
  stepDescription: string;
  /** Total turns elapsed in this dispatch */
  turnsElapsed: number;
  /** Number of file operations produced so far */
  fileOpsCount: number;
  /** Turns since last new file operation */
  turnsSinceLastFileOp: number;
  /** Recent tool call names (last 5) */
  recentToolCalls: string[];
  /** Whether the heuristic loop detector has fired */
  loopDetected: boolean;
  /** Brief manifest summary: file count + paths */
  manifestSummary: string;
  /** Current phase hint: 'implement' | 'verify' | 'enhance' */
  currentPhase: string;
  /** Original task description (truncated) */
  taskSummary: string;
}

export interface CheckpointResult {
  verdict: ReasonerVerdict;
  reason: string;
  suggestion?: string;
}

export interface ReasonerMonitorConfig {
  /** The LLM provider for the 27B reasoner */
  provider: LlmProvider;
  /** Model ID for the reasoner */
  model: string;
  /** Timeout per checkpoint call (ms) */
  timeoutMs: number;
  /** Context tier config for provider options */
  tiers: DeepTierConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

const CHECKPOINT_SYSTEM_PROMPT = `You are a progress monitor for a coding agent. Your job is to evaluate whether the agent's current coding step is complete, should continue, is stuck, or needs replanning.

Respond with ONLY a valid JSON object. No other text.

Verdicts:
- "complete": The step goal appears fulfilled — files created, logic implemented, ready for review.
- "continue": Meaningful progress is being made and more work is needed. The agent should keep going.
- "stuck": No meaningful progress — repeated patterns, spinning on the same files, or unable to proceed.
- "replan": The approach is fundamentally wrong or blocked. The step needs a different strategy.

When in doubt, prefer "continue" — it is better to let the agent keep working than to prematurely stop it.`;

function buildCheckpointPrompt(ctx: CheckpointContext): string {
  return `## Step Goal
${ctx.stepDescription}

## Progress
- Turns used: ${ctx.turnsElapsed}
- Files created/modified: ${ctx.fileOpsCount}
- Turns since last file change: ${ctx.turnsSinceLastFileOp}
- Loop detection fired: ${ctx.loopDetected ? 'YES' : 'no'}
- Recent tools: ${ctx.recentToolCalls.join(', ') || '(none)'}
- Phase: ${ctx.currentPhase}

## Workspace
${ctx.manifestSummary || '(no files yet)'}

## Task
${ctx.taskSummary}

Evaluate progress and respond with JSON: {"verdict":"continue|complete|stuck|replan","reason":"brief explanation"}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stall Detection (pure heuristic, no LLM)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect whether the coder is stalled based on turns without file operations.
 *
 * Immediate stall if loop detection has already fired AND we're past half the
 * threshold. Otherwise, simple threshold comparison.
 */
export function detectStall(
  turnsSinceLastFileOp: number,
  stallThreshold: number,
  loopDetected: boolean,
): boolean {
  if (loopDetected && turnsSinceLastFileOp >= Math.floor(stallThreshold / 2)) {
    return true;
  }
  return turnsSinceLastFileOp >= stallThreshold;
}

// ─────────────────────────────────────────────────────────────────────────────
// ReasonerMonitor
// ─────────────────────────────────────────────────────────────────────────────

const VALID_VERDICTS = new Set<ReasonerVerdict>(['continue', 'complete', 'stuck', 'replan']);

export class ReasonerMonitor {
  private readonly provider: LlmProvider;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly tiers: DeepTierConfig;

  constructor(config: ReasonerMonitorConfig) {
    this.provider = config.provider;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
    this.tiers = config.tiers;
  }

  /**
   * Evaluate progress at a checkpoint.
   *
   * Uses compact tier, thinking ON, maxTokens 256. On timeout or error,
   * defaults to 'continue' (fail-open — never blocks the coder).
   */
  async evaluate(ctx: CheckpointContext): Promise<CheckpointResult> {
    const tracer = getTracer();

    const request: GenerateRequest = {
      prompt: buildCheckpointPrompt(ctx),
      systemPrompt: CHECKPOINT_SYSTEM_PROMPT,
      temperature: 0.1,
      maxTokens: 256,
      providerOptions: {
        ...buildProviderOptions(this.tiers, 'compact'),
        think: true,
      },
    };

    try {
      const response = await Promise.race([
        this.provider.generateWithTools(request, []),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('checkpoint timeout')), this.timeoutMs),
        ),
      ]);

      const { json } = extractJsonFromResponse(response.text);
      const verdict = String(json['verdict'] ?? 'continue') as ReasonerVerdict;
      const reason = String(json['reason'] ?? '');
      const suggestion = json['suggestion'] ? String(json['suggestion']) : undefined;

      if (!VALID_VERDICTS.has(verdict)) {
        tracer.log('deep-loop', 'warn', `Invalid verdict "${verdict}" — defaulting to continue`);
        return { verdict: 'continue', reason: `invalid verdict: ${verdict}` };
      }

      return { verdict, reason, ...(suggestion ? { suggestion } : {}) };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      tracer.log('deep-loop', 'warn', `Checkpoint failed (fail-open → continue): ${msg}`);
      return { verdict: 'continue', reason: `checkpoint error: ${msg}` };
    }
  }
}
