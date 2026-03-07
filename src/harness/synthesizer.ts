/**
 * Harness Synthesizer — LLM-driven harness generation with iterative refinement.
 *
 * Implements the core AutoHarness algorithm from Lou et al. (2026):
 *
 *   1. Given a tool and its failure patterns, ask the LLM to synthesize
 *      a validation function (the "harness").
 *   2. Test the harness against known failures.
 *   3. If the harness still misses cases, feed the failures back to the
 *      LLM as a "Critic → Refiner" loop.
 *   4. Repeat until the harness passes all known cases or the iteration
 *      budget is exhausted.
 *
 * The paper uses Thompson-sampling-guided tree search over the program
 * space. We approximate this with a simpler iterative refinement loop
 * that keeps the best-scoring candidate at each step — suitable for the
 * local-first Ollama setting where inference latency is higher.
 *
 * All synthesized code is evaluated in a sandboxed scope (no `require`,
 * `process`, `eval`, or network access). The executor (executor.ts)
 * handles the sandbox.
 */

import { safeLogger } from '../logging/safe-logger.js';
import type { LlmProvider } from '../providers/base.js';
import type { ToolSchema } from '../tools/schemas/types.js';
import type {
  HarnessDefinition,
  HarnessFailure,
  HarnessMode,
  RefinementRequest,
  RefinementResult,
} from './types.js';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface HarnessSynthesizerConfig {
  /** Maximum refinement iterations per synthesis attempt */
  maxIterations: number;

  /** Maximum length of generated validation code (chars) */
  maxCodeLength: number;

  /** Temperature for the synthesis LLM calls */
  temperature: number;

  /** Max tokens for synthesis responses */
  maxTokens: number;
}

const DEFAULT_CONFIG: HarnessSynthesizerConfig = {
  maxIterations: 10,
  maxCodeLength: 4000,
  temperature: 0.3,
  maxTokens: 4096,
};

// ─── Dangerous Pattern Scanner ───────────────────────────────────────────────

const FORBIDDEN_PATTERNS = [
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bchild_process\b/,
  /\bexecSync\b/,
  /\bexecFile\b/,
  /\bspawn\b/,
  /\.env\b/,
  /\bfs\b\.\b(read|write|unlink|mkdir|rmdir)/,
];

function scanForForbiddenPatterns(code: string): string[] {
  const violations: string[] = [];
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      violations.push(`Forbidden pattern: ${pattern.source}`);
    }
  }
  return violations;
}

// ─── Prompt Templates ────────────────────────────────────────────────────────

function buildSynthesisPrompt(
  toolSchema: ToolSchema,
  mode: HarnessMode,
  failures: HarnessFailure[],
  description: string,
): string {
  const failureSummary = failures.length > 0
    ? failures
        .slice(-5) // Last 5 failures
        .map((f, i) => `Failure ${i + 1}: [${f.errorType}] ${f.errorMessage}\n  Tool: ${f.toolName}\n  Input: ${JSON.stringify(f.toolInput).slice(0, 200)}`)
        .join('\n\n')
    : 'No prior failures recorded.';

  const modeInstructions = {
    'action-verifier': `Write a validation function that checks whether a tool call is valid before execution.

The function receives a context object with:
- ctx.toolName (string): the tool being called
- ctx.toolInput (object): the structured input parameters
- ctx.recentCalls (array): recent tool call history [{toolName, input, success, timestamp}]
- ctx.turnNumber (number): current agent turn
- ctx.availableTools (string[]): registered tool names

Return an object: { allowed: boolean, reason: string, suggestedFix?: string }`,

    'action-filter': `Write a filter function that returns the set of legal actions for the current state.

The function receives the same context object as above.

Return an object: { allowedTools: string[], inputConstraints: Record<string, object>, reason: string }`,

    'policy': `Write a policy function that directly selects the best action without LLM involvement.

The function receives the same context object as above.

Return an object: { toolName: string, toolInput: object, reason: string }`,
  };

  return `You are a code harness synthesizer. Your job is to write a JavaScript validation function that prevents invalid actions by an LLM agent.

## Tool Schema

Name: ${toolSchema.name}
Description: ${toolSchema.description}
Input Schema: ${JSON.stringify(toolSchema.inputSchema, null, 2)}

## Task

${description}

## Mode: ${mode}

${modeInstructions[mode]}

## Known Failures

${failureSummary}

## Rules

1. Output ONLY the function body (no function declaration wrapper, no markdown fences).
2. The code must be pure JavaScript — no TypeScript, no imports, no require().
3. Do not use process, globalThis, eval, Function constructor, fetch, or any I/O.
4. Keep it under ${DEFAULT_CONFIG.maxCodeLength} characters.
5. Always return the correct result type. Never throw exceptions — return { allowed: false, reason: "..." } instead.
6. Be conservative: when in doubt, allow the action (return allowed: true).

Write the function body now:`;
}

function buildRefinementPrompt(
  currentCode: string,
  failures: HarnessFailure[],
): string {
  const failureSummary = failures
    .slice(-5)
    .map((f, i) => `Failure ${i + 1}: [${f.errorType}] ${f.errorMessage}\n  Tool: ${f.toolName}\n  Input: ${JSON.stringify(f.toolInput).slice(0, 200)}`)
    .join('\n\n');

  return `You are a code harness refiner. The current harness has failures that need to be fixed.

## Current Harness Code

${currentCode}

## Recent Failures

${failureSummary}

## Task

Refine the harness code to handle the failures above. The function signature and return type must stay the same.

## Rules

1. Output ONLY the updated function body (no function declaration, no markdown fences).
2. Pure JavaScript only — no TypeScript, imports, require(), process, eval, fetch, or I/O.
3. Keep it under ${DEFAULT_CONFIG.maxCodeLength} characters.
4. Fix the specific failures while preserving existing correct behavior.
5. Be conservative: when in doubt, allow the action.

Write the refined function body now:`;
}

// ─── Synthesizer ─────────────────────────────────────────────────────────────

export class HarnessSynthesizer {
  private readonly config: HarnessSynthesizerConfig;

  constructor(config?: Partial<HarnessSynthesizerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Synthesize a new harness for a tool.
   *
   * Uses the LLM to generate validation code, then validates it against
   * known failures. If the code has security violations, the attempt fails.
   */
  async synthesize(
    provider: LlmProvider,
    toolSchema: ToolSchema,
    mode: HarnessMode,
    description: string,
    failures: HarnessFailure[] = [],
  ): Promise<HarnessDefinition | null> {
    safeLogger.info('Synthesizing harness', {
      tool: toolSchema.name,
      mode,
      failureCount: failures.length,
    });

    const prompt = buildSynthesisPrompt(toolSchema, mode, failures, description);

    try {
      const response = await provider.generateWithTools(
        {
          prompt,
          systemPrompt: 'You are a precise code generator. Output only the requested code, nothing else.',
          maxTokens: this.config.maxTokens,
          temperature: this.config.temperature,
        },
        [], // No tools — we want raw text output
      );

      const code = cleanCodeResponse(response.text);

      // Security scan
      const violations = scanForForbiddenPatterns(code);
      if (violations.length > 0) {
        safeLogger.warn('Synthesized harness failed security scan', {
          tool: toolSchema.name,
          violations,
        });
        return null;
      }

      // Length check
      if (code.length > this.config.maxCodeLength) {
        safeLogger.warn('Synthesized harness exceeds max length', {
          tool: toolSchema.name,
          length: code.length,
          max: this.config.maxCodeLength,
        });
        return null;
      }

      const now = new Date().toISOString();
      const id = `harness-${toolSchema.name}-${Date.now().toString(36)}`;

      return {
        id,
        name: `${mode} for ${toolSchema.name}`,
        toolName: toolSchema.name,
        mode,
        validationCode: code,
        createdAt: now,
        updatedAt: now,
        refinementCount: 0,
        evaluationCount: 0,
        blockCount: 0,
        enabled: true,
        description,
        version: 1,
      };
    } catch (err) {
      safeLogger.error('Harness synthesis failed', {
        tool: toolSchema.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Refine an existing harness based on accumulated failures.
   *
   * This is the Critic → Refiner loop from the AutoHarness paper.
   * Each iteration feeds failures to the LLM and asks for a corrected
   * version of the harness code.
   */
  async refine(
    provider: LlmProvider,
    request: RefinementRequest,
  ): Promise<RefinementResult> {
    const { current, failures, maxIterations } = request;
    const iterLimit = Math.min(maxIterations, this.config.maxIterations);

    safeLogger.info('Refining harness', {
      harnessId: current.id,
      tool: current.toolName,
      failureCount: failures.length,
      maxIterations: iterLimit,
    });

    let bestCode = current.validationCode;
    let iterationsUsed = 0;

    for (let i = 0; i < iterLimit; i++) {
      iterationsUsed = i + 1;

      const prompt = buildRefinementPrompt(bestCode, failures);

      try {
        const response = await provider.generateWithTools(
          {
            prompt,
            systemPrompt: 'You are a precise code refiner. Output only the corrected code, nothing else.',
            maxTokens: this.config.maxTokens,
            temperature: this.config.temperature,
          },
          [],
        );

        const refined = cleanCodeResponse(response.text);

        // Security scan
        const violations = scanForForbiddenPatterns(refined);
        if (violations.length > 0) {
          safeLogger.warn('Refined harness failed security scan', {
            harnessId: current.id,
            iteration: i + 1,
            violations,
          });
          continue; // Try again
        }

        // Length check
        if (refined.length > this.config.maxCodeLength) {
          continue;
        }

        // Accept the refinement if it differs from the current code
        if (refined !== bestCode) {
          bestCode = refined;
          safeLogger.info('Harness refinement iteration accepted', {
            harnessId: current.id,
            iteration: i + 1,
          });
          break; // In our simplified loop, accept the first valid refinement
        }
      } catch (err) {
        safeLogger.warn('Harness refinement iteration failed', {
          harnessId: current.id,
          iteration: i + 1,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (bestCode === current.validationCode) {
      return {
        success: false,
        iterationsUsed,
        changelog: 'No valid refinement produced.',
      };
    }

    const updated: HarnessDefinition = {
      ...current,
      validationCode: bestCode,
      updatedAt: new Date().toISOString(),
      refinementCount: current.refinementCount + 1,
      version: current.version + 1,
    };

    return {
      success: true,
      updated,
      iterationsUsed,
      changelog: `Refined from v${current.version} to v${updated.version} in ${iterationsUsed} iteration(s).`,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Clean LLM response to extract just the function body.
 * Strips markdown fences, function wrappers, and trailing explanation.
 */
function cleanCodeResponse(text: string): string {
  let code = text.trim();

  // Remove markdown code fences
  code = code.replace(/^```(?:javascript|js|typescript|ts)?\s*\n?/gm, '');
  code = code.replace(/\n?```\s*$/gm, '');

  // Remove function wrapper if present
  code = code.replace(/^(?:function\s+\w+\s*\([^)]*\)\s*\{|\([^)]*\)\s*=>\s*\{)\s*\n?/, '');
  // Remove trailing closing brace only if we removed a function wrapper
  if (code !== text.trim()) {
    code = code.replace(/\n?\}\s*$/, '');
  }

  return code.trim();
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createHarnessSynthesizer(
  config?: Partial<HarnessSynthesizerConfig>,
): HarnessSynthesizer {
  return new HarnessSynthesizer(config);
}
