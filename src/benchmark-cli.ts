/**
 * Benchmark CLI (ISSUE-008)
 *
 * Standalone CLI for running model benchmarks against Ollama.
 *
 * Usage:
 *   tsx src/benchmark-cli.ts run --models gpt-oss:120b,qwen3-coder-next:latest [--category tool_use] [--difficulty moderate]
 *   tsx src/benchmark-cli.ts compare --models gpt-oss:120b,qwen3-coder-next:latest
 *   tsx src/benchmark-cli.ts history [--model gpt-oss:120b]
 *   tsx src/benchmark-cli.ts list
 */

import { parseArgs } from 'node:util';
import { loadConfig } from './config/index.js';
import {
  BENCHMARK_SUITE,
  BENCHMARK_SUITE_ID,
  getBenchmarkCasesByCategory,
  getBenchmarkCasesByDifficulty,
  AGENT_BENCHMARK_SUITE,
  AGENT_BENCHMARK_SUITE_ID,
  getAgentBenchmarkCasesByCategory,
  getAgentBenchmarkCasesByDifficulty,
  ollamaBenchmarkChat,
  extractMetrics,
  scoreCase,
  aggregateScores,
  createBenchmarkStore,
  compareRuns,
  formatRunSummary,
  formatComparison,
  formatRunAsJson,
  type BenchmarkCase,
  type BenchmarkRun,
  type CaseResult,
  type OllamaChatMessage,
} from './benchmark/index.js';
import { V1_SCORING_PROFILE, V2_SCORING_PROFILE } from './benchmark/types.js';
import { AGENT_TOOL_SCHEMAS } from './benchmark/agent-suite-tools.js';
import { evaluateResult } from './testing/test-runner.js';
import { createTraceCollector } from './testing/trace.js';
import type { BenchmarkCategory, BenchmarkDifficulty } from './benchmark/types.js';
import { BASH_TOOL } from './tools/schemas/core.js';
import {
  resolveModelProfile,
  enrichToolDescriptions,
  getGenerationOverrides,
} from './models/index.js';

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    models: { type: 'string', short: 'm' },
    model: { type: 'string' },
    category: { type: 'string', short: 'c' },
    difficulty: { type: 'string', short: 'd' },
    suite: { type: 'string', short: 's' },
    timeout: { type: 'string', short: 't' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const command = positionals[0] ?? 'help';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
Casterly Benchmark CLI

Usage:
  tsx src/benchmark-cli.ts run --models model1,model2 [options]
  tsx src/benchmark-cli.ts compare --models model1,model2
  tsx src/benchmark-cli.ts history [--model model_id]
  tsx src/benchmark-cli.ts list

Commands:
  run       Run benchmarks against one or more Ollama models
  compare   Compare latest runs for specified models
  history   Show stored benchmark runs
  list      List all benchmark cases

Options:
  --models, -m     Comma-separated model IDs (required for run/compare)
  --model          Single model ID (for history filtering)
  --suite, -s      Benchmark suite: v1 (basic) or v2 (agent) (default: v1)
  --category, -c   Filter by category (conversation, tool_use, reasoning, delegation, etc.)
  --difficulty, -d Filter by difficulty (trivial, simple, moderate, complex, expert)
  --timeout, -t    Request timeout in seconds (default: 120)
  --json           Output results as JSON
  --help, -h       Show this help
`);
}

/** Resolve which suite to use based on --suite flag */
function isV2(): boolean {
  return values.suite === 'v2' || values.suite === 'agent';
}

function getActiveSuiteId(): string {
  return isV2() ? AGENT_BENCHMARK_SUITE_ID : BENCHMARK_SUITE_ID;
}

function getActiveSuite(): BenchmarkCase[] {
  return isV2() ? AGENT_BENCHMARK_SUITE : BENCHMARK_SUITE;
}

function filterCases(
  categoryFilter?: string,
  difficultyFilter?: string,
): BenchmarkCase[] {
  const useV2 = isV2();

  let cases: BenchmarkCase[] = useV2 ? AGENT_BENCHMARK_SUITE : BENCHMARK_SUITE;

  if (categoryFilter) {
    cases = useV2
      ? getAgentBenchmarkCasesByCategory(categoryFilter as BenchmarkCategory)
      : getBenchmarkCasesByCategory(categoryFilter as BenchmarkCategory);
  }
  if (difficultyFilter) {
    const diffFiltered = useV2
      ? getAgentBenchmarkCasesByDifficulty(difficultyFilter as BenchmarkDifficulty)
      : getBenchmarkCasesByDifficulty(difficultyFilter as BenchmarkDifficulty);
    if (categoryFilter) {
      // Intersect
      const diffIds = new Set(diffFiltered.map((c) => c.id));
      cases = cases.filter((c) => diffIds.has(c.id));
    } else {
      cases = diffFiltered;
    }
  }

  return cases;
}

// ─── Run Command ─────────────────────────────────────────────────────────────

async function runBenchmarks(): Promise<void> {
  const modelList = values.models?.split(',').map((m) => m.trim()).filter(Boolean);
  if (!modelList || modelList.length === 0) {
    console.error('Error: --models is required for the run command');
    process.exit(1);
  }

  const config = loadConfig();
  const baseUrl = config.local.baseUrl;
  const store = createBenchmarkStore();
  const cases = filterCases(values.category, values.difficulty);

  if (cases.length === 0) {
    console.error('No benchmark cases match the given filters');
    process.exit(1);
  }

  const suiteId = getActiveSuiteId();
  const useV2 = isV2();
  const scoringProfile = useV2 ? V2_SCORING_PROFILE : V1_SCORING_PROFILE;

  console.log(`Running benchmark suite "${suiteId}" (${cases.length} cases)`);
  console.log(`Models: ${modelList.join(', ')}`);
  if (useV2) {
    console.log('Mode: Agent (v2) — full toolkit, agent-oriented scoring');
  }
  console.log('');

  const runs: BenchmarkRun[] = [];

  let modelIndex = 0;
  for (const modelId of modelList) {
    modelIndex++;
    console.log(`Model ${modelIndex}/${modelList.length}: ${modelId}`);

    // Resolve tools: v2 uses full agent toolkit, v1 uses bash only
    let benchmarkTools: { type: 'function'; function: { name: string; description: string; parameters: unknown } }[];
    if (useV2) {
      benchmarkTools = AGENT_TOOL_SCHEMAS;
    } else {
      const profile = resolveModelProfile(modelId);
      const enrichedTools = enrichToolDescriptions([BASH_TOOL], profile);
      benchmarkTools = enrichedTools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }

    const caseResults: CaseResult[] = [];
    let caseIndex = 0;

    for (const benchCase of cases) {
      caseIndex++;
      const progress = `[${caseIndex}/${cases.length}]`;

      try {
        // Build messages for Ollama
        const messages: OllamaChatMessage[] = [
          { role: 'user', content: benchCase.input },
        ];

        // Call Ollama with profile-enriched tool definitions
        const timeoutMs = values.timeout ? Number(values.timeout) * 1000 : undefined;
        const response = await ollamaBenchmarkChat(baseUrl, modelId, messages, benchmarkTools, timeoutMs);
        const metrics = extractMetrics(response);

        // Get response text and tool calls
        const responseText = response.message?.content ?? '';
        const toolCalls = response.message?.tool_calls ?? [];

        // Build a trace for evaluateResult
        const collector = createTraceCollector(benchCase.input);
        collector.addEvent('provider_selected', { provider: 'local', model: modelId });
        collector.addEvent('llm_response', {
          providerId: 'ollama',
          model: modelId,
          textLength: responseText.length,
          toolCalls: toolCalls.length,
          stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
        });

        // Record each tool call so evaluateResult can find them
        for (const tc of toolCalls) {
          collector.addEvent('tool_call_received', {
            toolName: tc.function?.name ?? 'unknown',
            arguments: tc.function?.arguments ?? '',
          });
        }

        const trace = collector.complete();

        // Evaluate structural checks
        const testResult = evaluateResult(benchCase, trace, responseText, null);

        // Extract tool names for v2 scoring
        const toolsCalled = toolCalls.map((tc) => tc.function?.name ?? 'unknown');

        // Score (v2 passes toolsCalled for agent dimension scoring)
        const caseResult = scoreCase(benchCase, testResult, metrics, useV2 ? toolsCalled : undefined);
        caseResults.push(caseResult);

        const status = caseResult.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
        console.log(`  ${progress} ${status} ${benchCase.id} (${metrics.totalMs.toFixed(0)}ms)`);
      } catch (error) {
        console.error(`  ${progress} ERROR ${benchCase.id}: ${error instanceof Error ? error.message : String(error)}`);
        caseResults.push({
          caseId: benchCase.id,
          passed: false,
          structuralScore: 0,
          toolEfficiency: 0,
          tokensInput: 0,
          tokensOutput: 0,
          ttftMs: 0,
          totalMs: 0,
          evalRate: 0,
          failures: [`Error: ${error instanceof Error ? error.message : String(error)}`],
        });
      }
    }

    // Aggregate with appropriate scoring profile
    const aggregate = aggregateScores(caseResults, cases, scoringProfile);
    const run: BenchmarkRun = {
      id: `run-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`,
      modelId,
      timestamp: Date.now(),
      suiteId: suiteId,
      cases: caseResults,
      aggregate,
    };

    store.add(run);
    runs.push(run);

    if (values.json) {
      console.log(formatRunAsJson(run));
    } else {
      console.log(formatRunSummary(run));
    }
  }

  // Multi-model comparison
  if (runs.length > 1 && !values.json) {
    const comparison = compareRuns(runs);
    console.log(formatComparison(comparison));
  }
}

// ─── Compare Command ─────────────────────────────────────────────────────────

function runCompare(): void {
  const modelList = values.models?.split(',').map((m) => m.trim()).filter(Boolean);
  if (!modelList || modelList.length < 2) {
    console.error('Error: --models with at least 2 models is required for compare');
    process.exit(1);
  }

  const store = createBenchmarkStore();
  const runs: BenchmarkRun[] = [];

  for (const modelId of modelList) {
    const latest = store.getLatest(modelId);
    if (!latest) {
      console.error(`No stored runs found for model: ${modelId}`);
      process.exit(1);
    }
    runs.push(latest);
  }

  const comparison = compareRuns(runs);
  console.log(formatComparison(comparison));
}

// ─── History Command ─────────────────────────────────────────────────────────

function runHistory(): void {
  const store = createBenchmarkStore();
  const modelFilter = values.model;

  const runs = modelFilter
    ? store.getByModel(modelFilter)
    : store.getAll();

  if (runs.length === 0) {
    console.log('No benchmark runs found.');
    return;
  }

  console.log(`\nStored Runs (${runs.length}):`);
  console.log('─'.repeat(60));

  for (const run of runs) {
    const date = new Date(run.timestamp).toISOString().split('T')[0];
    console.log(`  ${date}  ${run.modelId.padEnd(20)}  ${run.aggregate.overall}/100  (${run.cases.length} cases)`);
  }
}

// ─── List Command ────────────────────────────────────────────────────────────

function runList(): void {
  const suite = getActiveSuite();
  const suiteId = getActiveSuiteId();

  console.log(`\nBenchmark Suite: ${suiteId} (${suite.length} cases)`);
  console.log('═'.repeat(60));

  for (const c of suite) {
    console.log(`  [${c.id}]`);
    console.log(`    ${c.name}`);
    console.log(`    Difficulty: ${c.difficulty}  |  Category: ${c.category}`);
    if (c.optimalToolCalls !== undefined) {
      console.log(`    Optimal tool calls: ${c.optimalToolCalls}`);
    }
    if (c.preferredTools) {
      console.log(`    Preferred tools: ${c.preferredTools.join(', ')}`);
    }
    if (c.shouldReason !== undefined) {
      console.log(`    Should reason: ${c.shouldReason}`);
    }
    if (c.shouldDelegate !== undefined) {
      console.log(`    Should delegate: ${c.shouldDelegate}`);
    }
    console.log('');
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (values.help || command === 'help') {
    printUsage();
    return;
  }

  switch (command) {
    case 'run':
      await runBenchmarks();
      break;
    case 'compare':
      runCompare();
      break;
    case 'history':
      runHistory();
      break;
    case 'list':
      runList();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
