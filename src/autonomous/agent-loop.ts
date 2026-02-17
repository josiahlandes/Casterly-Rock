/**
 * Agent Loop — Tyrion's ReAct reasoning engine
 *
 * This module replaces the rigid 4-phase pipeline (analyze → hypothesize →
 * implement → validate) with a flexible reason → act → observe loop. The
 * LLM decides what to do next based on the full conversation history,
 * available tools, and current state.
 *
 * The ReAct pattern:
 *   1. The agent receives a trigger (scheduled cycle, event, user message, goal).
 *   2. The identity prompt is prepended (who Tyrion is, world state, goals, issues).
 *   3. A system prompt describes the available tools and behavioral expectations.
 *   4. The LLM generates either:
 *      a. A tool call → we execute it, append the result, and loop.
 *      b. A text response with no tool calls → the agent is "done" for this cycle.
 *   5. On completion: state is saved, outcome is recorded.
 *
 * Budget controls:
 *   - max_turns: Hard limit on reasoning loops per cycle (default 20).
 *   - max_tokens: Soft limit on total tokens consumed per cycle (default 50000).
 *   - Each turn that exceeds the budget triggers a forced completion.
 *
 * Transparency:
 *   - Every turn is logged through the debug tracer as a nested span.
 *   - Tool calls and their results are logged with timing.
 *   - The full conversation history is available for inspection.
 *
 * Interruptibility:
 *   - The agent loop checks an abort signal before each turn.
 *   - User messages can set the abort signal to preempt autonomous work.
 *
 * Privacy:
 *   - All conversation content passes through the debug tracer's redaction.
 *   - The conversation history is not persisted to disk (it lives in memory
 *     for the duration of the cycle).
 */

import { getTracer } from './debug.js';
import { buildIdentityPrompt } from './identity.js';
import type { AgentToolkit, AgentState } from './agent-tools.js';
import type { LlmProvider, GenerateRequest } from '../providers/base.js';
import type { ToolSchema, NativeToolCall, NativeToolResult, ToolResultMessage } from '../tools/schemas/types.js';
import type { WorldModel } from './world-model.js';
import type { GoalStack, Goal } from './goal-stack.js';
import type { IssueLog } from './issue-log.js';
import type { SelfModelSummary } from './identity.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What triggered this agent cycle.
 */
export type AgentTrigger =
  | { type: 'scheduled' }
  | { type: 'event'; event: AgentEvent }
  | { type: 'user'; message: string; sender: string }
  | { type: 'goal'; goal: Goal };

/**
 * System events that can trigger the agent (Phase 3 will add more).
 */
export interface AgentEvent {
  kind: string;
  description: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Configuration for the agent loop.
 */
export interface AgentLoopConfig {
  /** Maximum number of reason-act-observe turns per cycle */
  maxTurns: number;

  /** Soft limit on total tokens per cycle (input + output) */
  maxTokensPerCycle: number;

  /** Which model to use for reasoning/planning */
  reasoningModel: string;

  /** Which model to use for code generation */
  codingModel: string;

  /** Whether the think tool is enabled */
  thinkToolEnabled: boolean;

  /** Whether delegation to other models is enabled */
  delegationEnabled: boolean;

  /** Whether user messaging is enabled */
  userMessagingEnabled: boolean;

  /** Temperature for the reasoning model */
  temperature: number;

  /** Maximum tokens per individual LLM response */
  maxResponseTokens: number;
}

/**
 * A single turn in the agent conversation.
 */
export interface AgentTurn {
  /** Turn number (1-indexed) */
  turnNumber: number;

  /** What the LLM said (reasoning text) */
  reasoning: string;

  /** Tool calls made in this turn */
  toolCalls: NativeToolCall[];

  /** Results of the tool calls */
  toolResults: ToolResultMessage[];

  /** Duration of this turn in milliseconds */
  durationMs: number;

  /** Timestamp when this turn started */
  timestamp: string;
}

/**
 * The outcome of a complete agent cycle.
 */
export interface AgentOutcome {
  /** How the cycle was triggered */
  trigger: AgentTrigger;

  /** Whether the agent completed its work successfully */
  success: boolean;

  /** Why the agent stopped */
  stopReason: 'completed' | 'max_turns' | 'max_tokens' | 'aborted' | 'error';

  /** Human-readable summary of what was accomplished */
  summary: string;

  /** Full turn history for this cycle */
  turns: AgentTurn[];

  /** Total turns used */
  totalTurns: number;

  /** Approximate total tokens consumed */
  totalTokensEstimate: number;

  /** Total duration in milliseconds */
  durationMs: number;

  /** Timestamp when the cycle started */
  startedAt: string;

  /** Timestamp when the cycle ended */
  endedAt: string;

  /** Error message if stopReason is 'error' */
  error?: string;

  /** Files that were modified during this cycle */
  filesModified: string[];

  /** Issues filed during this cycle */
  issuesFiled: string[];

  /** Goals updated during this cycle */
  goalsUpdated: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: AgentLoopConfig = {
  maxTurns: 20,
  maxTokensPerCycle: 50_000,
  reasoningModel: 'hermes3:70b',
  codingModel: 'qwen3-coder-next:latest',
  thinkToolEnabled: true,
  delegationEnabled: true,
  userMessagingEnabled: false,
  temperature: 0.2,
  maxResponseTokens: 4096,
};

/**
 * System prompt that describes the agent's behavioral expectations and
 * tool usage guidelines. This is prepended after the identity prompt.
 */
function buildSystemPrompt(trigger: AgentTrigger, tools: ToolSchema[]): string {
  const toolList = tools.map((t) => `- **${t.name}**: ${t.description.split('\n')[0]}`).join('\n');

  const triggerDescription = describeTrigger(trigger);

  return `## Current Task

${triggerDescription}

## How to Work

You operate in a reason → act → observe loop. Each turn, you can either:
1. Call one or more tools to gather information or make changes.
2. Return a text response with no tool calls to signal you are done.

Guidelines:
- **Think first.** Use the \`think\` tool to plan your approach before making changes.
- **Read before writing.** Always read a file before editing it.
- **Test after changing.** After modifying code, run \`typecheck\` and \`run_tests\` to verify.
- **File issues for problems you can't fix now.** Use \`file_issue\` to record problems for later.
- **Update your goals.** Use \`update_goal\` to track progress on the current goal.
- **Be surgical.** Make small, targeted changes. Don't refactor unrelated code.
- **Know when to stop.** If you've completed the task or can't make further progress, stop. Don't loop endlessly.

## Available Tools

${toolList}

## Completion

When you are done (task completed, blocked, or no further progress possible), respond with a text message summarizing:
1. What you accomplished
2. What issues remain (if any)
3. What you'd do next (if continuing)

Do NOT call any tools in your final response.`;
}

/**
 * Describe the trigger in human-readable form for the system prompt.
 */
function describeTrigger(trigger: AgentTrigger): string {
  switch (trigger.type) {
    case 'scheduled':
      return 'This is a scheduled autonomous cycle. Check your goal stack and issue log for the most important work to do. If nothing is pressing, consider running a codebase health check or investigating stale issues.';

    case 'event':
      return `An event has occurred that needs your attention:\n\n**${trigger.event.kind}**: ${trigger.event.description}\n\nInvestigate this event, determine if action is needed, and take appropriate steps.`;

    case 'user':
      return `The user (${trigger.sender}) has sent you a message:\n\n> ${trigger.message}\n\nRespond to their request. User tasks take priority over autonomous work.`;

    case 'goal':
      return `You are working on goal **${trigger.goal.id}**: ${trigger.goal.description}\n\nSource: ${trigger.goal.source} | Priority: ${trigger.goal.priority} | Attempts: ${trigger.goal.attempts}\n${trigger.goal.notes ? `Notes: ${trigger.goal.notes}` : ''}\n\nContinue working on this goal. If you've already attempted it, review what was tried and take a different approach.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Estimation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rough token estimate: ~4 characters per token for English text.
 * This is intentionally conservative (over-estimates) to stay within budget.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Loop
// ─────────────────────────────────────────────────────────────────────────────

export class AgentLoop {
  private readonly config: AgentLoopConfig;
  private readonly provider: LlmProvider;
  private readonly toolkit: AgentToolkit;
  private readonly state: AgentState;
  private readonly selfModel: SelfModelSummary | null;

  /** Signal to abort the loop (set externally for interrupts) */
  private aborted: boolean = false;

  constructor(
    config: Partial<AgentLoopConfig>,
    provider: LlmProvider,
    toolkit: AgentToolkit,
    state: AgentState,
    selfModel?: SelfModelSummary | null,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.provider = provider;
    this.toolkit = toolkit;
    this.state = state;
    this.selfModel = selfModel ?? null;
  }

  /**
   * Abort the current cycle. Call this to preempt autonomous work
   * (e.g., when a user message arrives).
   */
  abort(): void {
    this.aborted = true;
    const tracer = getTracer();
    tracer.log('agent-loop', 'warn', 'Agent loop abort requested');
  }

  /**
   * Check if the loop has been aborted.
   */
  isAborted(): boolean {
    return this.aborted;
  }

  /**
   * Run the agent loop for a single cycle. This is the main entry point.
   *
   * The loop:
   * 1. Builds the identity + system prompt.
   * 2. Enters a turn-by-turn loop:
   *    a. Send the conversation to the LLM.
   *    b. If the LLM returns tool calls → execute them, append results, continue.
   *    c. If the LLM returns only text → cycle is complete.
   * 3. Returns the outcome with full turn history.
   */
  async run(trigger: AgentTrigger): Promise<AgentOutcome> {
    const tracer = getTracer();
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    return tracer.withSpan('agent-loop', 'run', async (rootSpan) => {
      tracer.log('agent-loop', 'info', `Agent loop starting. Trigger: ${trigger.type}`, {
        maxTurns: this.config.maxTurns,
        maxTokens: this.config.maxTokensPerCycle,
      });

      // Track state changes for the outcome
      const filesModified: Set<string> = new Set();
      const issuesFiled: Set<string> = new Set();
      const goalsUpdated: Set<string> = new Set();
      const turns: AgentTurn[] = [];
      let totalTokensEstimate = 0;

      // ── Build initial context ────────────────────────────────────────

      const identityResult = buildIdentityPrompt(
        this.state.worldModel,
        this.state.goalStack,
        this.state.issueLog,
        this.selfModel,
      );

      const systemPrompt = buildSystemPrompt(trigger, this.toolkit.schemas);
      const fullSystemPrompt = `${identityResult.prompt}\n\n${systemPrompt}`;

      totalTokensEstimate += estimateTokens(fullSystemPrompt);

      tracer.log('agent-loop', 'debug', 'Identity prompt built', {
        charCount: identityResult.charCount,
        sections: identityResult.sections,
      });

      // ── Conversation history ─────────────────────────────────────────

      // The conversation accumulates tool call results across turns.
      // We track the full "user message" that grows with tool results.
      const toolResults: ToolResultMessage[] = [];
      let userPrompt = this.buildInitialPrompt(trigger);
      totalTokensEstimate += estimateTokens(userPrompt);

      // ── Main ReAct Loop ──────────────────────────────────────────────

      let stopReason: AgentOutcome['stopReason'] = 'completed';
      let summary = '';
      let error: string | undefined;

      for (let turnNumber = 1; turnNumber <= this.config.maxTurns; turnNumber++) {
        // Check abort signal
        if (this.aborted) {
          tracer.log('agent-loop', 'warn', `Aborted at turn ${turnNumber}`);
          stopReason = 'aborted';
          summary = `Aborted at turn ${turnNumber} (external interrupt).`;
          break;
        }

        // Check token budget
        if (totalTokensEstimate >= this.config.maxTokensPerCycle) {
          tracer.log('agent-loop', 'warn', `Token budget exceeded at turn ${turnNumber}`, {
            estimated: totalTokensEstimate,
            budget: this.config.maxTokensPerCycle,
          });
          stopReason = 'max_tokens';
          summary = `Token budget exceeded at turn ${turnNumber}. Estimated ${totalTokensEstimate} tokens used.`;
          break;
        }

        const turnStartMs = Date.now();
        const turnTimestamp = new Date().toISOString();

        tracer.log('agent-loop', 'debug', `── Turn ${turnNumber}/${this.config.maxTurns} ──`);

        try {
          // ── Call the LLM ───────────────────────────────────────────

          const request: GenerateRequest = {
            prompt: userPrompt,
            systemPrompt: fullSystemPrompt,
            maxTokens: this.config.maxResponseTokens,
            temperature: this.config.temperature,
          };

          const response = await tracer.withSpan(
            'agent-loop',
            `llm-call:turn-${turnNumber}`,
            async () => {
              return this.provider.generateWithTools(
                request,
                this.toolkit.schemas,
                toolResults.length > 0 ? toolResults : undefined,
              );
            },
          );

          // Estimate tokens for this response
          const responseTokens = estimateTokens(response.text);
          totalTokensEstimate += responseTokens;

          tracer.log('agent-loop', 'debug', `LLM response: ${response.text.length} chars, ${response.toolCalls.length} tool calls`, {
            stopReason: response.stopReason,
            estimatedTokens: responseTokens,
          });

          // ── No tool calls → agent is done ──────────────────────────

          if (response.toolCalls.length === 0) {
            const turn: AgentTurn = {
              turnNumber,
              reasoning: response.text,
              toolCalls: [],
              toolResults: [],
              durationMs: Date.now() - turnStartMs,
              timestamp: turnTimestamp,
            };
            turns.push(turn);

            summary = response.text;
            stopReason = 'completed';

            tracer.log('agent-loop', 'info', `Agent completed at turn ${turnNumber}`, {
              summaryLength: summary.length,
            });
            break;
          }

          // ── Execute tool calls ─────────────────────────────────────

          const turnToolResults: ToolResultMessage[] = [];

          for (const toolCall of response.toolCalls) {
            const result = await tracer.withSpan(
              'agent-loop',
              `tool:${toolCall.name}`,
              async () => {
                return this.toolkit.execute(toolCall);
              },
              { toolCallId: toolCall.id },
            );

            const toolResultMsg: ToolResultMessage = {
              callId: toolCall.id,
              result: result.output ?? result.error ?? '(no output)',
              isError: !result.success,
            };
            turnToolResults.push(toolResultMsg);
            toolResults.push(toolResultMsg);

            // Track state changes
            this.trackStateChanges(
              toolCall,
              result,
              filesModified,
              issuesFiled,
              goalsUpdated,
            );

            // Add tokens for tool result
            totalTokensEstimate += estimateTokens(toolResultMsg.result);
          }

          // Record the turn
          const turn: AgentTurn = {
            turnNumber,
            reasoning: response.text,
            toolCalls: response.toolCalls,
            toolResults: turnToolResults,
            durationMs: Date.now() - turnStartMs,
            timestamp: turnTimestamp,
          };
          turns.push(turn);

          tracer.log('agent-loop', 'debug', `Turn ${turnNumber} complete: ${response.toolCalls.length} tools called`, {
            durationMs: turn.durationMs,
            toolNames: response.toolCalls.map((tc) => tc.name),
          });

          // Update the prompt for the next turn — include reasoning + tool results
          // The LLM provider handles multi-turn via previousResults, so we just
          // keep the same prompt and let tool results accumulate.
          userPrompt = response.text || 'Continue.';

        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          tracer.log('agent-loop', 'error', `Turn ${turnNumber} failed: ${errorMsg}`);

          const turn: AgentTurn = {
            turnNumber,
            reasoning: '',
            toolCalls: [],
            toolResults: [],
            durationMs: Date.now() - turnStartMs,
            timestamp: turnTimestamp,
          };
          turns.push(turn);

          stopReason = 'error';
          error = errorMsg;
          summary = `Agent loop failed at turn ${turnNumber}: ${errorMsg}`;
          break;
        }

        // Check if we've hit max turns
        if (turnNumber === this.config.maxTurns) {
          tracer.log('agent-loop', 'warn', `Max turns (${this.config.maxTurns}) reached`);
          stopReason = 'max_turns';
          summary = `Max turns (${this.config.maxTurns}) reached. Work may be incomplete.`;
        }
      }

      // ── Build outcome ──────────────────────────────────────────────

      const endedAt = new Date().toISOString();
      const durationMs = Date.now() - startMs;

      const outcome: AgentOutcome = {
        trigger,
        success: stopReason === 'completed',
        stopReason,
        summary,
        turns,
        totalTurns: turns.length,
        totalTokensEstimate,
        durationMs,
        startedAt,
        endedAt,
        filesModified: Array.from(filesModified),
        issuesFiled: Array.from(issuesFiled),
        goalsUpdated: Array.from(goalsUpdated),
        ...(error !== undefined ? { error } : {}),
      };

      rootSpan.metadata['totalTurns'] = outcome.totalTurns;
      rootSpan.metadata['stopReason'] = outcome.stopReason;
      rootSpan.metadata['success'] = outcome.success;

      tracer.log('agent-loop', 'info', `Agent loop complete`, {
        stopReason: outcome.stopReason,
        totalTurns: outcome.totalTurns,
        durationMs: outcome.durationMs,
        filesModified: outcome.filesModified.length,
        issuesFiled: outcome.issuesFiled.length,
        goalsUpdated: outcome.goalsUpdated.length,
        estimatedTokens: outcome.totalTokensEstimate,
      });

      return outcome;
    });
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  /**
   * Build the initial user prompt based on the trigger type.
   */
  private buildInitialPrompt(trigger: AgentTrigger): string {
    switch (trigger.type) {
      case 'scheduled':
        return 'This is a scheduled autonomous cycle. Review your goal stack and issue log, then work on the highest-priority item. If nothing is urgent, check codebase health or investigate stale issues.';

      case 'event':
        return `An event occurred: [${trigger.event.kind}] ${trigger.event.description}\n\nInvestigate and take action as needed.`;

      case 'user':
        return trigger.message;

      case 'goal':
        return `Work on goal ${trigger.goal.id}: ${trigger.goal.description}\n\n${trigger.goal.notes ? `Previous progress: ${trigger.goal.notes}` : 'This is a fresh start on this goal.'}`;
    }
  }

  /**
   * Track which files, issues, and goals were modified by tool calls.
   * This feeds into the outcome for state persistence.
   */
  private trackStateChanges(
    toolCall: NativeToolCall,
    _result: NativeToolResult,
    filesModified: Set<string>,
    issuesFiled: Set<string>,
    goalsUpdated: Set<string>,
  ): void {
    const path = toolCall.input['path'];
    const filePath = typeof path === 'string' ? path : undefined;

    switch (toolCall.name) {
      case 'edit_file':
      case 'create_file':
        if (filePath && _result.success) {
          filesModified.add(filePath);
        }
        break;

      case 'file_issue':
        if (_result.success && _result.output) {
          // Extract issue ID from output (e.g., "Issue ISS-001: ...")
          const match = /Issue (ISS-\d+)/.exec(_result.output);
          if (match?.[1]) {
            issuesFiled.add(match[1]);
          }
        }
        break;

      case 'close_issue': {
        const issueId = toolCall.input['issue_id'];
        if (typeof issueId === 'string' && _result.success) {
          issuesFiled.add(issueId);
        }
        break;
      }

      case 'update_goal': {
        const goalId = toolCall.input['goal_id'];
        if (typeof goalId === 'string' && _result.success) {
          goalsUpdated.add(goalId);
        }
        break;
      }

      case 'git_commit':
        if (_result.success) {
          const files = toolCall.input['files'];
          if (Array.isArray(files)) {
            for (const f of files) {
              if (typeof f === 'string') {
                filesModified.add(f);
              }
            }
          }
        }
        break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an agent loop with the given configuration and dependencies.
 * This is the preferred way to construct an AgentLoop — it wires up
 * all the pieces cleanly.
 */
export function createAgentLoop(
  config: Partial<AgentLoopConfig>,
  provider: LlmProvider,
  toolkit: AgentToolkit,
  state: AgentState,
  selfModel?: SelfModelSummary | null,
): AgentLoop {
  return new AgentLoop(config, provider, toolkit, state, selfModel);
}
