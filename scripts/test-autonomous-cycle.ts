/**
 * Test Autonomous Cycle — Real Ollama E2E
 *
 * Runs the ANALYZE and HYPOTHESIZE phases against real Ollama inference
 * to verify the autonomous provider works end-to-end. Skips git/integrate
 * phases to avoid modifying the repo state.
 *
 * Usage: npx tsx scripts/test-autonomous-cycle.ts
 */

import * as path from 'path';
import { loadConfig } from '../src/autonomous/loop.js';
import { createProvider } from '../src/autonomous/provider.js';
import { Analyzer } from '../src/autonomous/analyzer.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const configPath = path.join(projectRoot, 'config', 'autonomous.yaml');

async function main(): Promise<void> {
  console.log('=== Autonomous Cycle E2E Test ===\n');

  // 1. Load config
  console.log('[1/5] Loading config...');
  const config = await loadConfig(configPath);
  console.log(`  Provider: ${config.provider}`);
  console.log(`  Model: ${config.model}`);
  console.log(`  Attempt threshold: ${config.attemptThreshold}`);
  console.log(`  Auto-integrate threshold: ${config.autoIntegrateThreshold}`);
  console.log('');

  // 2. Create provider (real Ollama)
  console.log('[2/5] Creating Ollama provider...');
  const provider = await createProvider(config);
  console.log(`  Provider: ${provider.name}, Model: ${provider.model}`);

  // Quick health check
  try {
    const healthResp = await fetch('http://localhost:11434/api/tags');
    if (!healthResp.ok) throw new Error(`HTTP ${healthResp.status}`);
    console.log('  Ollama health: OK');
  } catch (err) {
    console.error('  Ollama health: FAILED -', err);
    process.exit(1);
  }
  console.log('');

  // 3. ANALYZE — gather real context from the codebase
  console.log('[3/5] Phase 1: ANALYZE — gathering codebase context...');
  const startAnalyze = Date.now();
  const analyzer = new Analyzer(projectRoot);
  const context = await analyzer.gatherContext();

  console.log(`  Error logs: ${context.errorLogs.length}`);
  console.log(`  Performance metrics: ${context.performanceMetrics.length}`);
  console.log(`  Recent reflections: ${context.recentReflections.length}`);
  console.log(`  Codebase stats: ${context.codebaseStats.totalFiles} files, ${context.codebaseStats.totalLines} lines`);
  console.log(`  Lint errors: ${context.codebaseStats.lintErrors}, Type errors: ${context.codebaseStats.typeErrors}`);
  console.log(`  Context gathered in ${Date.now() - startAnalyze}ms`);
  console.log('');

  // 4. ANALYZE — send context to Ollama for observation extraction
  console.log('[4/5] Phase 1 continued: Sending context to Ollama for analysis...');
  console.log('  (This will take a while — local inference on 80B model)');
  const startLlm = Date.now();

  try {
    const analyzeResult = await provider.analyze(context);
    const analyzeTime = Date.now() - startLlm;

    console.log(`  Analysis complete in ${(analyzeTime / 1000).toFixed(1)}s`);
    console.log(`  Observations found: ${analyzeResult.observations.length}`);
    console.log(`  Tokens used: ${analyzeResult.tokensUsed.input} in, ${analyzeResult.tokensUsed.output} out`);
    console.log('');

    if (analyzeResult.observations.length > 0) {
      console.log('  Observations:');
      for (const obs of analyzeResult.observations.slice(0, 5)) {
        const contextStr = typeof obs.context === 'string'
          ? (obs.context as string).substring(0, 120)
          : JSON.stringify(obs.context).substring(0, 120);
        console.log(`    [${obs.severity}] ${obs.type}: ${contextStr}`);
        console.log(`      Area: ${obs.suggestedArea ?? 'unknown'}`);
      }
      console.log('');
    }

    // 5. HYPOTHESIZE — generate improvement ideas
    console.log('[5/5] Phase 2: HYPOTHESIZE — generating improvement ideas...');
    const startHyp = Date.now();

    const hypothesizeResult = await provider.hypothesize(analyzeResult.observations);
    const hypTime = Date.now() - startHyp;

    console.log(`  Hypotheses generated in ${(hypTime / 1000).toFixed(1)}s`);
    console.log(`  Hypotheses: ${hypothesizeResult.hypotheses.length}`);
    console.log(`  Tokens used: ${hypothesizeResult.tokensUsed.input} in, ${hypothesizeResult.tokensUsed.output} out`);
    console.log('');

    if (hypothesizeResult.hypotheses.length > 0) {
      console.log('  Ranked hypotheses:');
      for (const hyp of hypothesizeResult.hypotheses.slice(0, 5)) {
        const viable = hyp.confidence >= config.attemptThreshold ? '✓ VIABLE' : '✗ below threshold';
        console.log(`    [${viable}] confidence=${hyp.confidence.toFixed(2)} impact=${hyp.expectedImpact}`);
        console.log(`      Proposal: ${hyp.proposal?.substring(0, 120) ?? 'no proposal'}`);
        console.log(`      Approach: ${hyp.approach}, Complexity: ${hyp.estimatedComplexity}`);
        console.log(`      Files: ${hyp.affectedFiles?.join(', ') ?? 'none'}`);
        console.log('');
      }
    }

    // Summary
    const totalTokens = provider.getTokenUsage();
    const totalTime = Date.now() - startAnalyze;

    console.log('=== Summary ===');
    console.log(`  Total time: ${(totalTime / 1000).toFixed(1)}s`);
    console.log(`  Total tokens: ${totalTokens.input} in, ${totalTokens.output} out`);
    console.log(`  Observations: ${analyzeResult.observations.length}`);
    console.log(`  Hypotheses: ${hypothesizeResult.hypotheses.length}`);
    const viable = hypothesizeResult.hypotheses.filter((h) => h.confidence >= config.attemptThreshold);
    console.log(`  Viable hypotheses (>= ${config.attemptThreshold}): ${viable.length}`);
    console.log('');
    console.log('  ✓ ANALYZE + HYPOTHESIZE phases work end-to-end with real Ollama');
    console.log('  Next: "start autonomous" via iMessage to run full cycle with git integration');
  } catch (err) {
    const elapsed = Date.now() - startLlm;
    console.error(`\n  ✗ Ollama inference failed after ${(elapsed / 1000).toFixed(1)}s`);
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
