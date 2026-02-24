/**
 * Run a Single Autonomous Agent Cycle
 *
 * Runs a single agent cycle (ReAct loop) against real Ollama.
 * The agent loop is the sole execution path — it picks a trigger
 * (goal from the stack, or a scheduled cycle) and executes it.
 *
 * Usage: npx tsx scripts/run-single-cycle.ts
 */

import * as path from 'path';
import { loadConfig, AutonomousLoop } from '../src/autonomous/loop.js';
import { createProvider } from '../src/autonomous/provider.js';

const projectRoot = path.resolve(import.meta.dirname, '..');
const configPath = path.join(projectRoot, 'config', 'autonomous.yaml');

async function main(): Promise<void> {
  console.log('=== Single Autonomous Agent Cycle ===\n');

  // 1. Load config
  console.log('[1] Loading config...');
  const config = await loadConfig(configPath);
  console.log(`  Model: ${config.model}`);
  console.log(`  Integration mode: ${config.git.integrationMode}`);
  console.log(`  Backlog path: ${config.backlogPath}`);
  console.log('');

  // 2. Health check
  console.log('[2] Checking Ollama health...');
  try {
    const resp = await fetch('http://localhost:11434/api/tags');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    console.log('  Ollama: OK');
  } catch (err) {
    console.error('  Ollama: FAILED -', err);
    process.exit(1);
  }
  console.log('');

  // 3. Create provider
  console.log('[3] Creating provider...');
  const provider = await createProvider(config);
  console.log(`  Provider: ${provider.name}, Model: ${provider.model}`);
  console.log('');

  // 4. Create loop and run single agent cycle
  console.log('[4] Running agent cycle...');
  console.log('  (This may take 5-15 minutes with local inference)\n');

  const startTime = Date.now();
  const loop = new AutonomousLoop(config, projectRoot, provider, undefined, config.agentLoop);

  try {
    const outcome = await loop.runAgentCycle();
    console.log(`\n  Stop reason: ${outcome.stopReason}`);
    console.log(`  Turns: ${outcome.totalTurns}`);
    console.log(`  Files modified: ${outcome.filesModified.length}`);
    console.log(`  Issues filed: ${outcome.issuesFiled.length}`);
  } catch (err) {
    console.error('\n  Cycle error:', err instanceof Error ? err.message : String(err));
  }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n=== Cycle completed in ${elapsed.toFixed(1)}s ===`);

  // 5. Show pending branches
  const pending = loop.pendingBranchList;
  if (pending.length > 0) {
    console.log(`\nPending branches for review (${pending.length}):`);
    for (const branch of pending) {
      console.log(`  ${branch.branch}: ${branch.proposal?.substring(0, 100)}`);
    }
  }

  // 6. Token usage
  const tokens = provider.getTokenUsage();
  console.log(`\nToken usage: ${tokens.input} in, ${tokens.output} out`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
