/**
 * Composable Agent Interface
 *
 * Defines the shared shape that both FastLoop, DeepLoop, and future
 * specialized agents (reviewer, researcher, etc.) implement.
 *
 * The key insight from Qwen-Agent: delegation and coordination become
 * trivial when agents share the same interface. Instead of spawning
 * text-only sub-tasks, delegates are real agents with restricted tool sets.
 *
 * This enables:
 *   - Parallel investigation (spawn multiple read-only agents)
 *   - Specialized review (agent with read + diff tools only)
 *   - Recursive delegation (agents can delegate to other agents)
 *   - Clean handoffs via perspective-shifted messages
 *
 * Privacy: All agents run locally. No data leaves the machine.
 */

import type { LlmProvider, GenerateRequest } from '../providers/base.js';
import type { ToolSchema, NativeToolCall, NativeToolResult, ToolResultMessage } from '../tools/schemas/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Agent Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fundamental contract for all agents in the system.
 *
 * An agent has:
 *   1. An identity (role name, system prompt)
 *   2. A provider (LLM to call)
 *   3. A tool set (what it can do)
 *   4. An execution method (run a task, return a result)
 */
export interface Agent {
  /** Human-readable role name (e.g., 'planner', 'coder', 'reviewer') */
  readonly role: string;

  /** The LLM provider this agent uses */
  readonly provider: LlmProvider;

  /** Tool schemas available to this agent (empty = text-only) */
  readonly tools: ToolSchema[];

  /** Names of tools this agent can use (derived from schemas) */
  readonly toolNames: string[];

  /**
   * Execute a task and return the result.
   *
   * @param task - The task to execute
   * @returns AgentResult with the output and metadata
   */
  execute(task: AgentTask): Promise<AgentResult>;
}

/**
 * A task to be executed by an agent.
 */
export interface AgentTask {
  /** The prompt / instruction for the agent */
  prompt: string;

  /** System prompt override (uses agent default if not provided) */
  systemPrompt?: string;

  /** Context from previous agents in the chain (perspective-shifted) */
  priorContext?: AgentMessage[];

  /** Maximum ReAct turns for this task */
  maxTurns?: number;

  /** Temperature override */
  temperature?: number;

  /** Maximum tokens for LLM response */
  maxTokens?: number;
}

/**
 * Result from an agent execution.
 */
export interface AgentResult {
  /** The agent's final text response */
  text: string;

  /** The role of the agent that produced this result */
  role: string;

  /** Tool calls made during execution (for audit/handoff) */
  toolCallLog: AgentToolCallEntry[];

  /** Number of ReAct turns consumed */
  turnsUsed: number;

  /** Whether the agent completed within budget */
  completedWithinBudget: boolean;

  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * A logged tool call from an agent execution.
 */
export interface AgentToolCallEntry {
  /** Tool name */
  tool: string;

  /** Input arguments */
  input: Record<string, unknown>;

  /** Whether the call succeeded */
  success: boolean;

  /** Output summary (truncated for handoff) */
  outputSummary: string;
}

/**
 * A message in an agent conversation chain.
 * Used for perspective-shifted handoffs between agents.
 */
export interface AgentMessage {
  /** Which agent role produced this message */
  fromRole: string;

  /** The message content */
  content: string;

  /** Tool calls made (if any) */
  toolCalls?: AgentToolCallEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Set Presets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard tool set restriction levels for delegation.
 */
export type ToolAccess = 'none' | 'read-only' | 'read-write' | 'full';

// ─────────────────────────────────────────────────────────────────────────────
// Delegate Agent — A lightweight agent for sub-tasks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for creating a delegate agent.
 */
export interface DelegateAgentConfig {
  /** Role name for this delegate */
  role: string;

  /** LLM provider to use */
  provider: LlmProvider;

  /** System prompt for the delegate */
  systemPrompt: string;

  /** Tool schemas available (empty = text-only) */
  tools: ToolSchema[];

  /** Tool executor function (maps tool calls to results) */
  executeTool: (call: NativeToolCall) => Promise<NativeToolResult>;

  /** Maximum ReAct turns (default: 10) */
  maxTurns?: number;
}

/**
 * Create a delegate agent that conforms to the Agent interface.
 *
 * Delegates are lightweight agents with restricted tool sets, suitable
 * for sub-tasks like code review, research, or verification.
 */
export function createDelegateAgent(config: DelegateAgentConfig): Agent {
  const maxTurns = config.maxTurns ?? 10;

  return {
    role: config.role,
    provider: config.provider,
    tools: config.tools,
    toolNames: config.tools.map((t) => t.name),

    async execute(task: AgentTask): Promise<AgentResult> {
      const startMs = Date.now();
      const toolCallLog: AgentToolCallEntry[] = [];
      let turnsUsed = 0;
      const effectiveMaxTurns = task.maxTurns ?? maxTurns;

      // Build the prompt with prior context (perspective-shifted)
      let fullPrompt = task.prompt;
      if (task.priorContext && task.priorContext.length > 0) {
        const contextSection = formatPriorContext(task.priorContext, config.role);
        fullPrompt = `${contextSection}\n\n---\n\n${task.prompt}`;
      }

      const request: GenerateRequest = {
        prompt: fullPrompt,
        systemPrompt: task.systemPrompt ?? config.systemPrompt,
        maxTokens: task.maxTokens ?? 4096,
        temperature: task.temperature ?? 0.2,
      };

      // If no tools, single-turn text generation
      if (config.tools.length === 0) {
        const response = await config.provider.generateWithTools(request, []);
        return {
          text: response.text,
          role: config.role,
          toolCallLog: [],
          turnsUsed: 1,
          completedWithinBudget: true,
          durationMs: Date.now() - startMs,
        };
      }

      // ReAct loop with tools
      let currentRequest = request;
      const previousResults: ToolResultMessage[] = [];
      let finalText = '';

      for (let turn = 0; turn < effectiveMaxTurns; turn++) {
        turnsUsed++;

        const response = await config.provider.generateWithTools(
          currentRequest,
          config.tools,
          previousResults.length > 0 ? previousResults : undefined,
        );

        // No tool calls → agent is done
        if (!response.toolCalls || response.toolCalls.length === 0) {
          finalText = response.text;
          break;
        }

        // Execute tool calls
        for (const tc of response.toolCalls) {
          // Enforce tool restriction
          if (!config.tools.some((t) => t.name === tc.name)) {
            previousResults.push({
              callId: tc.id,
              result: `Tool "${tc.name}" is not available for this agent role.`,
              isError: true,
            });
            toolCallLog.push({
              tool: tc.name,
              input: tc.input,
              success: false,
              outputSummary: 'Tool not available',
            });
            continue;
          }

          const result = await config.executeTool(tc);
          const output = result.output ?? result.error ?? '(no output)';

          previousResults.push({
            callId: tc.id,
            result: output,
            isError: !result.success,
          });

          toolCallLog.push({
            tool: tc.name,
            input: tc.input,
            success: result.success,
            outputSummary: output.slice(0, 200),
          });
        }

        // Continue conversation
        currentRequest = {
          ...request,
          prompt: response.text || 'Continue.',
        };
        finalText = response.text;
      }

      return {
        text: finalText,
        role: config.role,
        toolCallLog,
        turnsUsed,
        completedWithinBudget: turnsUsed < effectiveMaxTurns,
        durationMs: Date.now() - startMs,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Perspective-Shifted Message Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format prior agent context for a new agent, using perspective shifting.
 *
 * When a coder agent's output is handed to a reviewer agent, the reviewer
 * needs to see the coder's work from the reviewer's perspective. This means:
 *   - The coder's assistant messages become narrated context ("The coder did X")
 *   - Tool call results become factual summaries
 *   - Only the current agent speaks in first person
 *
 * This is the "sleeper hit" from Qwen-Agent: cheap to implement, eliminates
 * the confused-reviewer class of bugs where the reviewer can't distinguish
 * its own voice from the previous agent's.
 */
export function formatPriorContext(
  messages: AgentMessage[],
  currentRole: string,
): string {
  if (messages.length === 0) return '';

  const sections: string[] = [];

  for (const msg of messages) {
    if (msg.fromRole === currentRole) {
      // Same role — keep as first-person (unusual but possible in recursive delegation)
      sections.push(msg.content);
    } else {
      // Different role — narrate in third person
      const header = `## Context from ${msg.fromRole}`;
      const narrated = narrateAgentOutput(msg);
      sections.push(`${header}\n\n${narrated}`);
    }
  }

  return `# Prior Agent Context\n\n${sections.join('\n\n---\n\n')}`;
}

/**
 * Convert an agent's output into narrated form.
 *
 * Instead of raw assistant turns, the output reads like a report:
 *   "The coder created src/foo.ts with the following content..."
 *   "The coder ran `npm test` which returned 3 failures..."
 */
function narrateAgentOutput(msg: AgentMessage): string {
  const parts: string[] = [];
  const role = msg.fromRole;

  // Main content
  if (msg.content) {
    parts.push(`The ${role} reported:\n\n> ${msg.content.split('\n').join('\n> ')}`);
  }

  // Tool call summaries
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    const toolSummaries = msg.toolCalls.map((tc) => {
      const status = tc.success ? 'successfully' : 'with errors';
      return `- **${tc.tool}** (${status}): ${tc.outputSummary}`;
    });
    parts.push(`The ${role} used the following tools:\n\n${toolSummaries.join('\n')}`);
  }

  return parts.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Handoff Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an AgentMessage from an AgentResult for handoff to the next agent.
 */
export function resultToMessage(result: AgentResult): AgentMessage {
  return {
    fromRole: result.role,
    content: result.text,
    toolCalls: result.toolCallLog.length > 0 ? result.toolCallLog : undefined,
  };
}

/**
 * Chain multiple agents sequentially, passing perspective-shifted context
 * from each agent to the next.
 *
 * Example: planner → coder → reviewer
 *
 * Each agent sees the accumulated context from all previous agents,
 * formatted from its own perspective.
 */
export async function chainAgents(
  agents: Agent[],
  initialTask: AgentTask,
): Promise<AgentResult[]> {
  const results: AgentResult[] = [];
  const priorContext: AgentMessage[] = [];

  let currentTask = initialTask;

  for (const agent of agents) {
    const task: AgentTask = {
      ...currentTask,
      priorContext: priorContext.length > 0 ? [...priorContext] : undefined,
    };

    const result = await agent.execute(task);
    results.push(result);
    priorContext.push(resultToMessage(result));

    // Next agent gets the same base prompt but with accumulated context
    currentTask = {
      ...initialTask,
      prompt: initialTask.prompt,
    };
  }

  return results;
}
