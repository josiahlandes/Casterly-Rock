/**
 * Ollama Provider for Autonomous Self-Improvement
 *
 * Mac Studio Edition - Local Ollama Only
 *
 * This provider uses local Ollama for the autonomous improvement loop.
 * Optimized for Mac Studio M4 Max with 128GB unified memory.
 */

import {
  BaseAutonomousProvider,
  PROMPTS,
  type AnalyzeResult,
  type HypothesizeResult,
  type ImplementContext,
  type ImplementResult,
  type ReflectContext,
  type ReflectResult,
  type TokenUsage,
} from '../provider.js';
import type {
  AnalysisContext,
  AutonomousConfig,
  Hypothesis,
  Observation,
  Reflection,
} from '../types.js';

// ============================================================================
// TYPES
// ============================================================================

interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  system?: string;
  stream: false;
  options?: {
    temperature?: number;
    num_predict?: number;
  };
}

interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

// ============================================================================
// OLLAMA AUTONOMOUS PROVIDER
// ============================================================================

export class OllamaAutonomousProvider extends BaseAutonomousProvider {
  readonly name = 'ollama';
  readonly model: string;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: AutonomousConfig) {
    super(config);
    this.model = config.model;
    this.baseUrl = process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434';
    this.timeoutMs = 300_000; // 5 minutes for local inference (can be slow)
  }

  // --------------------------------------------------------------------------
  // ANALYZE
  // --------------------------------------------------------------------------

  async analyze(context: AnalysisContext): Promise<AnalyzeResult> {
    const prompt = this.buildAnalyzePrompt(context);

    const response = await this.callOllama(prompt, {
      systemPrompt: `You are an expert code analyzer for the Casterly project.
Identify issues and opportunities for improvement.
Return your analysis as a JSON object with an "observations" array.
Each observation must have: id, type, severity, frequency, context, suggestedArea, timestamp, source.
IMPORTANT: Return ONLY valid JSON, no other text.`,
    });

    const parsed = this.parseJsonResponse<{ observations: Observation[]; summary?: string }>(
      response.text,
      { observations: [], summary: '' }
    );

    // Ensure each observation has required fields
    const observations = parsed.observations.map((obs) => ({
      ...obs,
      id: obs.id || this.generateId('obs'),
      timestamp: obs.timestamp || new Date().toISOString(),
      source: obs.source || 'error_logs',
      frequency: obs.frequency || 1,
    }));

    this.addTokenUsage(response.usage);

    return {
      observations,
      summary: parsed.summary || `Found ${observations.length} observations`,
      tokensUsed: response.usage,
    };
  }

  private buildAnalyzePrompt(context: AnalysisContext): string {
    let prompt = PROMPTS.analyze;

    // Format error logs
    const errorLogsStr =
      context.errorLogs.length > 0
        ? context.errorLogs
            .slice(0, 20)
            .map((e) => `[${e.code}] ${e.message} (x${e.frequency})`)
            .join('\n')
        : 'No recent errors';
    prompt = prompt.replace('{{errorLogs}}', errorLogsStr);

    // Format performance metrics
    const perfStr =
      context.performanceMetrics.length > 0
        ? context.performanceMetrics
            .map((m) => `${m.name}: p50=${m.p50}ms, p95=${m.p95}ms, trend=${m.trend}`)
            .join('\n')
        : 'No performance metrics available';
    prompt = prompt.replace('{{performanceMetrics}}', perfStr);

    // Format recent reflections
    const reflectionsStr =
      context.recentReflections.length > 0
        ? context.recentReflections
            .slice(0, 5)
            .map((r) => `[${r.outcome}] ${r.hypothesis.proposal}: ${r.learnings}`)
            .join('\n')
        : 'No recent reflections';
    prompt = prompt.replace('{{recentReflections}}', reflectionsStr);

    // Format codebase stats
    const statsStr = `Files: ${context.codebaseStats.totalFiles}, Lines: ${context.codebaseStats.totalLines}, Lint errors: ${context.codebaseStats.lintErrors}, Type errors: ${context.codebaseStats.typeErrors}`;
    prompt = prompt.replace('{{codebaseStats}}', statsStr);

    return prompt;
  }

  // --------------------------------------------------------------------------
  // HYPOTHESIZE
  // --------------------------------------------------------------------------

  async hypothesize(observations: Observation[]): Promise<HypothesizeResult> {
    const prompt = this.buildHypothesizePrompt(observations);

    const response = await this.callOllama(prompt, {
      systemPrompt: `You are an expert software architect for the Casterly project.
Generate hypotheses for improving the codebase based on observations.
Return your hypotheses as a JSON object with a "hypotheses" array and "reasoning" string.
Each hypothesis must have: id, observation, proposal, approach, expectedImpact, confidence, affectedFiles, estimatedComplexity, previousAttempts, reasoning.
IMPORTANT: Return ONLY valid JSON, no other text.`,
    });

    const parsed = this.parseJsonResponse<{ hypotheses: Hypothesis[]; reasoning?: string }>(
      response.text,
      { hypotheses: [], reasoning: '' }
    );

    // Ensure each hypothesis has required fields and link to observation
    const hypotheses = parsed.hypotheses.map((hyp) => ({
      ...hyp,
      id: hyp.id || this.generateId('hyp'),
      observation: hyp.observation || observations[0],
      previousAttempts: hyp.previousAttempts || 0,
      confidence: Math.max(0, Math.min(1, hyp.confidence || 0.5)),
    }));

    // Sort by confidence * impact
    const impactScore = { low: 1, medium: 2, high: 3 };
    hypotheses.sort(
      (a, b) =>
        b.confidence * impactScore[b.expectedImpact] - a.confidence * impactScore[a.expectedImpact]
    );

    this.addTokenUsage(response.usage);

    return {
      hypotheses,
      reasoning: parsed.reasoning || 'Hypotheses generated based on observations',
      tokensUsed: response.usage,
    };
  }

  private buildHypothesizePrompt(observations: Observation[]): string {
    let prompt = PROMPTS.hypothesize;

    const observationsStr = JSON.stringify(observations, null, 2);
    prompt = prompt.replace('{{observations}}', observationsStr);

    return prompt;
  }

  // --------------------------------------------------------------------------
  // IMPLEMENT
  // --------------------------------------------------------------------------

  async implement(hypothesis: Hypothesis, context: ImplementContext): Promise<ImplementResult> {
    const prompt = this.buildImplementPrompt(hypothesis, context);

    const response = await this.callOllama(prompt, {
      systemPrompt: `You are an expert TypeScript developer for the Casterly project.
Implement the proposed change with minimal, focused modifications.
Return your implementation as a JSON object with:
- changes: array of { path, type, content } objects
- description: what the implementation does
- commitMessage: conventional commit message

For "modify" type changes, provide the COMPLETE new file content.
Preserve existing code style and don't break functionality.
IMPORTANT: Return ONLY valid JSON, no other text.`,
      maxTokens: 16384, // Local models can handle larger outputs
    });

    const parsed = this.parseJsonResponse<{
      changes: Array<{ path: string; type: 'create' | 'modify' | 'delete'; content?: string }>;
      description?: string;
      commitMessage?: string;
    }>(response.text, { changes: [], description: '', commitMessage: '' });

    this.addTokenUsage(response.usage);

    return {
      changes: parsed.changes.map((c) => ({
        path: c.path,
        type: c.type,
        diff: c.content,
      })),
      description: parsed.description || hypothesis.proposal,
      commitMessage: parsed.commitMessage || `auto: ${hypothesis.approach} - ${hypothesis.proposal}`,
      tokensUsed: response.usage,
    };
  }

  private buildImplementPrompt(hypothesis: Hypothesis, context: ImplementContext): string {
    let prompt = PROMPTS.implement;

    prompt = prompt.replace('{{hypothesis}}', JSON.stringify(hypothesis, null, 2));

    // Format file contents (only relevant files)
    const fileContentsStr = Array.from(context.fileContents.entries())
      .filter(([path]) => hypothesis.affectedFiles.some((af) => path.includes(af)))
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
      .join('\n\n');
    prompt = prompt.replace('{{fileContents}}', fileContentsStr || 'No relevant files loaded');

    // Format available files
    const availableFilesStr = context.availableFiles.slice(0, 100).join('\n');
    prompt = prompt.replace('{{availableFiles}}', availableFilesStr);

    return prompt;
  }

  // --------------------------------------------------------------------------
  // REFLECT
  // --------------------------------------------------------------------------

  async reflect(context: ReflectContext): Promise<ReflectResult> {
    const prompt = this.buildReflectPrompt(context);

    const response = await this.callOllama(prompt, {
      systemPrompt: `You are reflecting on an improvement cycle for the Casterly project.
Analyze what happened and extract learnings for future cycles.
Return your reflection as a JSON object with "learnings" (string) and "suggestedAdjustments" (string array).
IMPORTANT: Return ONLY valid JSON, no other text.`,
    });

    const parsed = this.parseJsonResponse<{
      learnings?: string;
      suggestedAdjustments?: string[];
    }>(response.text, { learnings: '', suggestedAdjustments: [] });

    this.addTokenUsage(response.usage);

    const reflection: Reflection = {
      cycleId: context.cycleId,
      timestamp: new Date().toISOString(),
      observation: context.observation,
      hypothesis: context.hypothesis,
      implementation: context.implementation,
      validation: context.validationPassed
        ? {
            passed: true,
            invariantsHold: true,
            testsPassed: true,
            testsRun: 0,
            testsFailed: 0,
            errors: [],
            warnings: [],
            metrics: { testDurationMs: 0 },
          }
        : {
            passed: false,
            invariantsHold: false,
            testsPassed: false,
            testsRun: 0,
            testsFailed: context.validationErrors.length,
            errors: context.validationErrors,
            warnings: [],
            metrics: { testDurationMs: 0 },
          },
      outcome: context.outcome,
      learnings: parsed.learnings || 'No specific learnings extracted',
      tokensUsed: this.getTokenUsage(),
      durationMs: 0,
    };

    return {
      reflection,
      learnings: parsed.learnings || '',
      suggestedAdjustments: parsed.suggestedAdjustments || [],
      tokensUsed: response.usage,
    };
  }

  private buildReflectPrompt(context: ReflectContext): string {
    let prompt = PROMPTS.reflect;

    prompt = prompt.replace('{{cycleId}}', context.cycleId);
    prompt = prompt.replace('{{outcome}}', context.outcome);
    prompt = prompt.replace('{{observation}}', JSON.stringify(context.observation, null, 2));
    prompt = prompt.replace('{{hypothesis}}', JSON.stringify(context.hypothesis, null, 2));
    prompt = prompt.replace(
      '{{implementation}}',
      context.implementation ? JSON.stringify(context.implementation, null, 2) : 'N/A'
    );
    prompt = prompt.replace('{{validationPassed}}', String(context.validationPassed));
    prompt = prompt.replace('{{validationErrors}}', context.validationErrors.join(', ') || 'None');
    prompt = prompt.replace('{{integrated}}', String(context.integrated));

    return prompt;
  }

  // --------------------------------------------------------------------------
  // COST ESTIMATION (always 0 for local)
  // --------------------------------------------------------------------------

  override estimateCostUsd(): number {
    return 0; // Local inference has no per-token cost
  }

  // --------------------------------------------------------------------------
  // INTERNAL HELPERS
  // --------------------------------------------------------------------------

  private async callOllama(
    prompt: string,
    options: { systemPrompt?: string; maxTokens?: number }
  ): Promise<{ text: string; usage: TokenUsage }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const fullPrompt = options.systemPrompt
        ? `${options.systemPrompt}\n\n${prompt}`
        : prompt;

      const requestBody: OllamaGenerateRequest = {
        model: this.model,
        prompt: fullPrompt,
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: options.maxTokens || 4096,
        },
      };

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as OllamaGenerateResponse;

      return {
        text: data.response,
        usage: {
          input: data.prompt_eval_count || 0,
          output: data.eval_count || 0,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Ollama request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseJsonResponse<T>(text: string, defaultValue: T): T {
    try {
      // Try to extract JSON from the response
      let jsonStr = text;

      // Remove markdown code blocks if present
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch && jsonMatch[1]) {
        jsonStr = jsonMatch[1];
      }

      // Try to find JSON object or array
      const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
      const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);

      if (objectMatch) {
        return JSON.parse(objectMatch[0]) as T;
      } else if (arrayMatch) {
        return JSON.parse(arrayMatch[0]) as T;
      }

      return defaultValue;
    } catch {
      return defaultValue;
    }
  }
}
