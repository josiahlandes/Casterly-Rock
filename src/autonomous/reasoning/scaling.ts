/**
 * Reasoning Scaler — Difficulty-adaptive test-time compute scaling
 *
 * Implements a strategy where the agent allocates more compute to harder
 * problems. Easy problems get a single generation; hard problems get
 * parallel candidate generation with verification.
 *
 * Strategy:
 *   Easy   → Single generation, verify once.
 *   Medium → Generate 2 candidates, pick the better one.
 *   Hard   → Generate up to 4 candidates via bestOfN with judge.
 *
 * Difficulty assessment uses lightweight heuristics based on the problem
 * description and available context (file count, complexity signals).
 *
 * Integration: The agent loop calls `assessDifficulty()` before implementation
 * steps. Easy problems go to the coding model directly. Hard problems go
 * through the concurrent provider for parallel candidate generation.
 *
 * Privacy: All inference is local via Ollama. No data leaves the machine.
 */

import type { ConcurrentProvider, NamedResult, BestOfNResult } from '../../providers/concurrent.js';
import type { GenerateRequest } from '../../providers/base.js';
import type { ToolSchema } from '../../tools/schemas/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Difficulty level for a problem. */
export type Difficulty = 'easy' | 'medium' | 'hard';

/**
 * Configuration for the reasoning scaler.
 */
export interface ReasoningScalerConfig {
  /** Model for reasoning/planning (e.g., hermes3:70b) */
  reasoningModel: string;

  /** Model for code generation (e.g., qwen3.5:122b) */
  codingModel: string;

  /** Maximum parallel candidates for hard problems */
  maxCandidates: number;

  /** Whether test-time scaling is enabled */
  enabled: boolean;
}

/**
 * Context for difficulty assessment.
 */
export interface ProblemContext {
  /** Number of files involved */
  fileCount: number;

  /** Estimated total lines of relevant code */
  totalLines: number;

  /** Whether this involves cross-file changes */
  crossFile: boolean;

  /** Whether there are failing tests related to this problem */
  hasFailingTests: boolean;

  /** Number of previous attempts on this problem */
  previousAttempts: number;

  /** Tags describing the problem domain */
  tags: string[];
}

/**
 * Result of a scaled solve operation.
 */
export interface ScaledSolution {
  /** The best response */
  response: NamedResult;

  /** The difficulty that was assessed */
  difficulty: Difficulty;

  /** How many candidates were generated */
  candidatesGenerated: number;

  /** Judge reasoning if bestOfN was used */
  judgeReasoning?: string;

  /** Total duration in milliseconds */
  durationMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ReasoningScalerConfig = {
  reasoningModel: 'hermes3:70b',
  codingModel: 'qwen3.5:122b',
  maxCandidates: 4,
  enabled: true,
};

/** Keywords that signal higher difficulty. */
const HARD_SIGNALS = [
  'regex', 'concurrency', 'race condition', 'deadlock', 'memory leak',
  'performance', 'optimization', 'security', 'encryption', 'parsing',
  'state machine', 'recursive', 'graph', 'tree traversal', 'async',
  'streaming', 'protocol', 'binary', 'encoding', 'unicode',
  // Multi-file / greenfield project signals
  'build a complete', 'complete game', 'complete project', 'from scratch',
  'every file', 'file structure', 'multiple files', 'multi-file',
];

/** Keywords that signal lower difficulty (only match when they describe the TASK, not the spec). */
const EASY_SIGNALS = [
  'rename', 'typo', 'comment', 'formatting',
  'type annotation', 'straightforward', 'minor',
];

// ─────────────────────────────────────────────────────────────────────────────
// Reasoning Scaler
// ─────────────────────────────────────────────────────────────────────────────

export class ReasoningScaler {
  private readonly config: ReasoningScalerConfig;

  constructor(config?: Partial<ReasoningScalerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Difficulty Assessment ───────────────────────────────────────────────

  /**
   * Assess the difficulty of a problem from its description and context.
   * Uses lightweight heuristics — no LLM call needed.
   */
  assessDifficulty(problem: string, context?: Partial<ProblemContext>): Difficulty {
    let score = 0;
    const problemLower = problem.toLowerCase();

    // Signal-based scoring
    for (const signal of HARD_SIGNALS) {
      if (problemLower.includes(signal)) {
        score += 2;
      }
    }

    for (const signal of EASY_SIGNALS) {
      if (problemLower.includes(signal)) {
        score -= 2;
      }
    }

    // Context-based scoring
    if (context) {
      // Cross-file changes are harder
      if (context.crossFile) score += 2;

      // Many files involved → harder
      if (context.fileCount && context.fileCount > 5) score += 2;
      if (context.fileCount && context.fileCount > 10) score += 2;

      // Large codebase scope → harder
      if (context.totalLines && context.totalLines > 500) score += 1;
      if (context.totalLines && context.totalLines > 2000) score += 2;

      // Failing tests → medium difficulty at minimum
      if (context.hasFailingTests) score += 1;

      // Previous failed attempts → escalate difficulty
      if (context.previousAttempts && context.previousAttempts >= 1) score += 2;
      if (context.previousAttempts && context.previousAttempts >= 3) score += 3;

      // Domain-specific tags
      if (context.tags) {
        for (const tag of context.tags) {
          if (HARD_SIGNALS.includes(tag.toLowerCase())) score += 1;
        }
      }
    }

    // Problem length as a rough proxy for complexity
    if (problem.length > 500) score += 1;
    if (problem.length > 1000) score += 1;

    // Map score to difficulty
    if (score <= 0) return 'easy';
    if (score <= 4) return 'medium';
    return 'hard';
  }

  // ── Scaled Solving ──────────────────────────────────────────────────────

  /**
   * Solve a problem using difficulty-adapted compute scaling.
   *
   * - Easy: single generation from the coding model.
   * - Medium: two candidates (coding + reasoning models), pick better.
   * - Hard: up to maxCandidates via bestOfN with judge.
   */
  async solve(
    problem: string,
    difficulty: Difficulty,
    provider: ConcurrentProvider,
    tools?: ToolSchema[],
  ): Promise<ScaledSolution> {
    const startMs = Date.now();

    if (!this.config.enabled) {
      // Scaling disabled — always use single generation
      return this.solveEasy(problem, provider, startMs, tools);
    }

    switch (difficulty) {
      case 'easy':
        return this.solveEasy(problem, provider, startMs, tools);

      case 'medium':
        return this.solveMedium(problem, provider, startMs, tools);

      case 'hard':
        return this.solveHard(problem, provider, startMs, tools);
    }
  }

  // ── Strategy Implementations ───────────────────────────────────────────

  /**
   * Easy: single generation, no parallelism.
   */
  private async solveEasy(
    problem: string,
    provider: ConcurrentProvider,
    startMs: number,
    tools?: ToolSchema[],
  ): Promise<ScaledSolution> {
    const request: GenerateRequest = {
      prompt: problem,
      temperature: 0.1,
      maxTokens: 4096,
    };

    const response = await provider.generate(
      this.config.codingModel,
      request,
      tools,
    );

    return {
      response: {
        model: this.config.codingModel,
        response,
        durationMs: Date.now() - startMs,
      },
      difficulty: 'easy',
      candidatesGenerated: 1,
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Medium: two candidates from different models, pick the longer/richer one.
   * Uses a simple heuristic (response length + tool call count) rather than
   * a full judge model call to save compute.
   */
  private async solveMedium(
    problem: string,
    provider: ConcurrentProvider,
    startMs: number,
    tools?: ToolSchema[],
  ): Promise<ScaledSolution> {
    const request: GenerateRequest = {
      prompt: problem,
      temperature: 0.2,
      maxTokens: 4096,
    };

    const models = [this.config.codingModel, this.config.reasoningModel];
    const candidates = await provider.parallel(models, request, tools);

    // Simple heuristic: pick the more substantive response
    const best = candidates.reduce((a, b) => {
      const scoreA = a.response.text.length + a.response.toolCalls.length * 100;
      const scoreB = b.response.text.length + b.response.toolCalls.length * 100;
      return scoreA >= scoreB ? a : b;
    });

    return {
      response: best,
      difficulty: 'medium',
      candidatesGenerated: candidates.length,
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Hard: up to maxCandidates via bestOfN with judge model.
   */
  private async solveHard(
    problem: string,
    provider: ConcurrentProvider,
    startMs: number,
    tools?: ToolSchema[],
  ): Promise<ScaledSolution> {
    const request: GenerateRequest = {
      prompt: problem,
      temperature: 0.3, // Slightly higher for diversity
      maxTokens: 4096,
    };

    // Build model list: alternate between coding and reasoning models
    const models: string[] = [];
    for (let i = 0; i < this.config.maxCandidates; i++) {
      models.push(i % 2 === 0 ? this.config.codingModel : this.config.reasoningModel);
    }

    const result: BestOfNResult = await provider.bestOfN(
      models,
      request,
      this.config.reasoningModel,
      tools,
    );

    return {
      response: result.best,
      difficulty: 'hard',
      candidatesGenerated: result.candidates.length,
      judgeReasoning: result.judgeReasoning,
      durationMs: Date.now() - startMs,
    };
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  /**
   * Check if scaling is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): Readonly<ReasoningScalerConfig> {
    return this.config;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a reasoning scaler with the given configuration.
 */
export function createReasoningScaler(
  config?: Partial<ReasoningScalerConfig>,
): ReasoningScaler {
  return new ReasoningScaler(config);
}
