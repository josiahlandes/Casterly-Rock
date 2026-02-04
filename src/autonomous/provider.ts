/**
 * Provider Abstraction for Autonomous Self-Improvement
 *
 * This module defines the interface for AI providers (Claude API, Ollama, etc.)
 * and provides a factory function to create the appropriate provider based on config.
 */

import type {
  AnalysisContext,
  AutonomousConfig,
  Hypothesis,
  Implementation,
  Observation,
  Reflection,
  CycleOutcome,
  FileChange,
} from './types.js';

// ============================================================================
// PROVIDER INTERFACE
// ============================================================================

/**
 * Abstract interface for autonomous improvement providers.
 * Implementations handle the actual LLM calls for each phase of the improvement cycle.
 */
export interface AutonomousProvider {
  /** Provider name for logging */
  readonly name: string;

  /** Model being used */
  readonly model: string;

  /**
   * Analyze error logs, performance metrics, and codebase to find issues.
   * Returns observations that could be addressed.
   */
  analyze(context: AnalysisContext): Promise<AnalyzeResult>;

  /**
   * Generate hypotheses for how to address observations.
   * Returns ranked list of improvement ideas.
   */
  hypothesize(observations: Observation[]): Promise<HypothesizeResult>;

  /**
   * Implement a hypothesis by generating code changes.
   * Returns the file changes to apply.
   */
  implement(hypothesis: Hypothesis, context: ImplementContext): Promise<ImplementResult>;

  /**
   * Generate a reflection on the outcome of an improvement cycle.
   * Used for learning and improving future hypotheses.
   */
  reflect(outcome: ReflectContext): Promise<ReflectResult>;

  /**
   * Get token usage for cost tracking (API phase).
   */
  getTokenUsage(): TokenUsage;

  /**
   * Reset token usage counters (called at start of each cycle).
   */
  resetTokenUsage(): void;
}

// ============================================================================
// RESULT TYPES
// ============================================================================

export interface AnalyzeResult {
  observations: Observation[];
  summary: string;
  tokensUsed: TokenUsage;
}

export interface HypothesizeResult {
  hypotheses: Hypothesis[];
  reasoning: string;
  tokensUsed: TokenUsage;
}

export interface ImplementContext {
  /** Current file contents that may need modification */
  fileContents: Map<string, string>;
  /** Files available in the codebase */
  availableFiles: string[];
  /** Recent similar implementations for reference */
  recentImplementations?: Implementation[] | undefined;
}

export interface ImplementResult {
  changes: FileChange[];
  description: string;
  commitMessage: string;
  tokensUsed: TokenUsage;
}

export interface ReflectContext {
  cycleId: string;
  observation: Observation;
  hypothesis: Hypothesis;
  implementation?: Implementation | undefined;
  validationPassed: boolean;
  validationErrors: string[];
  integrated: boolean;
  outcome: CycleOutcome;
}

export interface ReflectResult {
  reflection: Reflection;
  learnings: string;
  suggestedAdjustments?: string[];
  tokensUsed: TokenUsage;
}

export interface TokenUsage {
  input: number;
  output: number;
}

// ============================================================================
// BASE PROVIDER CLASS
// ============================================================================

/**
 * Base class with common functionality for all providers.
 */
export abstract class BaseAutonomousProvider implements AutonomousProvider {
  abstract readonly name: string;
  abstract readonly model: string;

  protected tokenUsage: TokenUsage = { input: 0, output: 0 };
  protected config: AutonomousConfig;

  constructor(config: AutonomousConfig) {
    this.config = config;
  }

  abstract analyze(context: AnalysisContext): Promise<AnalyzeResult>;
  abstract hypothesize(observations: Observation[]): Promise<HypothesizeResult>;
  abstract implement(hypothesis: Hypothesis, context: ImplementContext): Promise<ImplementResult>;
  abstract reflect(outcome: ReflectContext): Promise<ReflectResult>;

  getTokenUsage(): TokenUsage {
    return { ...this.tokenUsage };
  }

  resetTokenUsage(): void {
    this.tokenUsage = { input: 0, output: 0 };
  }

  protected addTokenUsage(usage: TokenUsage): void {
    this.tokenUsage.input += usage.input;
    this.tokenUsage.output += usage.output;
  }

  /**
   * Estimate cost based on token usage (for API providers).
   * Override in specific providers with actual pricing.
   */
  estimateCostUsd(): number {
    return 0;
  }

  /**
   * Generate a unique ID for observations, hypotheses, etc.
   */
  protected generateId(prefix: string): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 7);
    return `${prefix}-${timestamp}-${random}`;
  }
}

// ============================================================================
// PROVIDER FACTORY
// ============================================================================

/**
 * Create an autonomous provider based on configuration.
 * This allows swapping between Claude API and local Ollama with just a config change.
 */
export async function createProvider(config: AutonomousConfig): Promise<AutonomousProvider> {
  switch (config.provider) {
    case 'claude': {
      const { ClaudeAutonomousProvider } = await import('./providers/claude.js');
      return new ClaudeAutonomousProvider(config);
    }
    case 'ollama': {
      const { OllamaAutonomousProvider } = await import('./providers/ollama.js');
      return new OllamaAutonomousProvider(config);
    }
    default:
      throw new Error(`Unknown autonomous provider: ${config.provider}`);
  }
}

// ============================================================================
// PROMPT TEMPLATES
// ============================================================================

/**
 * Shared prompt templates used by all providers.
 * These define the structure and expectations for each phase.
 */
export const PROMPTS = {
  analyze: `You are analyzing the Casterly codebase to identify issues that could be improved.

Review the following context and identify observations (issues, patterns, or opportunities):

## Error Logs
{{errorLogs}}

## Performance Metrics
{{performanceMetrics}}

## Recent Reflections (past improvements)
{{recentReflections}}

## Codebase Stats
{{codebaseStats}}

For each observation, provide:
1. type: error_pattern | performance_issue | capability_gap | resource_concern | test_failure | code_smell
2. severity: low | medium | high | critical
3. frequency: how often this occurs
4. context: relevant details
5. suggestedArea: which part of the codebase to look at

Return observations as JSON array. Focus on actionable issues that can be fixed programmatically.`,

  hypothesize: `You are generating improvement hypotheses for the Casterly codebase.

Based on these observations:
{{observations}}

Generate hypotheses for how to address them. For each hypothesis:
1. proposal: clear description of what to change
2. approach: fix_bug | optimize_performance | add_tool | add_test | refactor | update_config | improve_docs
3. expectedImpact: low | medium | high
4. confidence: 0-1 (how confident you are this will work)
5. affectedFiles: list of files that would need changes
6. estimatedComplexity: trivial | simple | moderate | complex
7. reasoning: why this approach should work

Return hypotheses as JSON array, ranked by (confidence * expectedImpact).
Only propose changes you're confident can be implemented correctly.`,

  implement: `You are implementing an improvement to the Casterly codebase.

## Hypothesis
{{hypothesis}}

## Current File Contents
{{fileContents}}

## Available Files
{{availableFiles}}

Implement the proposed change. For each file change, provide:
1. path: file path
2. type: create | modify | delete
3. content: the new/modified content (full file for create, or just the changed section for modify)

Also provide:
- description: what this implementation does
- commitMessage: a good commit message (conventional commits style)

Return as JSON with { changes: [...], description: string, commitMessage: string }

IMPORTANT:
- Make minimal, focused changes
- Preserve existing code style
- Don't break existing functionality
- Include any necessary imports`,

  reflect: `You are reflecting on an improvement cycle for the Casterly codebase.

## Cycle Details
- Cycle ID: {{cycleId}}
- Outcome: {{outcome}}

## Observation
{{observation}}

## Hypothesis
{{hypothesis}}

## Implementation
{{implementation}}

## Validation
- Passed: {{validationPassed}}
- Errors: {{validationErrors}}
- Integrated: {{integrated}}

Reflect on this cycle:
1. What worked well?
2. What didn't work?
3. What can be learned for future improvements?
4. Any suggested adjustments to approach?

Return as JSON with { learnings: string, suggestedAdjustments: string[] }`,
};
