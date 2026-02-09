#!/usr/bin/env node
/**
 * Casterly Test CLI
 *
 * Run verification tests and trace requests through the pipeline.
 *
 * Usage:
 *   npx tsx src/test-cli.ts                     # Run all tests
 *   npx tsx src/test-cli.ts --tag routing       # Run tests with tag
 *   npx tsx src/test-cli.ts --id route-001      # Run specific test
 *   npx tsx src/test-cli.ts --trace "Hello"     # Trace a single request
 *   npx tsx src/test-cli.ts --interactive       # Interactive mode
 */

import { parseArgs } from 'node:util';
import * as readline from 'node:readline';

import {
  createTraceCollector,
  formatTrace,
  storeTrace,
  getAllStoredTraces,
  clearStoredTraces,
  BUILT_IN_TEST_CASES,
  getTestCasesByTag,
  getTestCaseById,
  getAllTestCases,
  createTestRunner,
  formatTestResult,
  formatTestSummary,
  type TestCase,
} from './testing/index.js';
import { createTestableRunner } from './testing/testable-runner.js';

// ═══════════════════════════════════════════════════════════════════════════
// CLI ARGUMENT PARSING
// ═══════════════════════════════════════════════════════════════════════════

const args = parseArgs({
  options: {
    // Test selection
    tag: { type: 'string', short: 't' },
    id: { type: 'string', short: 'i' },
    all: { type: 'boolean', short: 'a', default: false },

    // Single request tracing
    trace: { type: 'string' },

    // Interactive mode
    interactive: { type: 'boolean', default: false },

    // Output options
    verbose: { type: 'boolean', short: 'v', default: false },
    json: { type: 'boolean', default: false },

    // Execution options
    'stop-on-failure': { type: 'boolean', default: false },
    'no-tools': { type: 'boolean', default: false },

    // Help
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

// ═══════════════════════════════════════════════════════════════════════════
// HELP TEXT
// ═══════════════════════════════════════════════════════════════════════════

const HELP_TEXT = `
Casterly Test CLI - Verification and tracing tools

USAGE:
  npx tsx src/test-cli.ts [options] [command]

COMMANDS:
  (none)               Run all tests (default)
  list                 List all available test cases
  tags                 List all available tags

TEST OPTIONS:
  -a, --all            Run all tests (including skipped)
  -t, --tag <tag>      Run tests with specified tag
  -i, --id <id>        Run a specific test by ID
  --stop-on-failure    Stop test run on first failure

TRACING OPTIONS:
  --trace "<message>"  Trace a single request through the pipeline
  --interactive        Enter interactive tracing mode

OUTPUT OPTIONS:
  -v, --verbose        Show detailed output for each test
  --json               Output results as JSON

EXECUTION OPTIONS:
  --no-tools           Disable tool execution

EXAMPLES:
  # Run all routing tests
  npx tsx src/test-cli.ts --tag routing

  # Run a specific test
  npx tsx src/test-cli.ts --id route-001

  # Trace a single request
  npx tsx src/test-cli.ts --trace "What is my schedule today?"

  # Interactive mode for debugging
  npx tsx src/test-cli.ts --interactive

  # List all tests
  npx tsx src/test-cli.ts list
`;

// ═══════════════════════════════════════════════════════════════════════════
// MAIN FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

async function runSingleTrace(input: string, options: { verbose: boolean; json: boolean; enableTools: boolean }) {
  console.log('Creating testable runner...');
  const runner = createTestableRunner({
    enableTools: options.enableTools,
    autoApproveBash: true,
  });

  console.log(`\nTracing request: "${input.substring(0, 60)}${input.length > 60 ? '...' : ''}"\n`);

  const collector = createTraceCollector(input);

  try {
    const response = await runner.processRequest(input, collector);
    const trace = collector.complete();
    storeTrace(trace);

    if (options.json) {
      console.log(JSON.stringify(trace, null, 2));
    } else {
      console.log(formatTrace(trace));
    }

    return { success: true, response, trace };
  } catch (error) {
    collector.setError(error instanceof Error ? error.message : String(error));
    const trace = collector.complete();
    storeTrace(trace);

    if (options.json) {
      console.log(JSON.stringify(trace, null, 2));
    } else {
      console.log(formatTrace(trace));
    }

    return { success: false, error: error instanceof Error ? error.message : String(error), trace };
  }
}

async function runTests(
  testCases: TestCase[],
  options: { verbose: boolean; json: boolean; stopOnFailure: boolean; enableTools: boolean }
) {
  console.log('Creating testable runner...');
  const runner = createTestableRunner({
    enableTools: options.enableTools,
    autoApproveBash: true,
  });

  console.log(`\nRunning ${testCases.length} tests...\n`);

  const testRunner = createTestRunner({
    executeRequest: (input, collector) => runner.processRequest(input, collector),
    timeoutMs: 120000,
    continueOnFailure: !options.stopOnFailure,
    onTestComplete: (result) => {
      console.log(formatTestResult(result, options.verbose));
      console.log('');
    },
  });

  const summary = await testRunner.runTests(testCases, createTraceCollector);

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatTestSummary(summary));
  }

  return summary;
}

async function listTests() {
  console.log('Available Test Cases:\n');
  console.log('═'.repeat(80));

  for (const testCase of BUILT_IN_TEST_CASES) {
    const skip = testCase.skip ? ' [SKIP]' : '';
    const tags = testCase.tags ? ` (${testCase.tags.join(', ')})` : '';
    console.log(`${testCase.id}${skip}: ${testCase.name}${tags}`);
    console.log(`  ${testCase.description}`);
    console.log('');
  }

  console.log('═'.repeat(80));
  console.log(`Total: ${BUILT_IN_TEST_CASES.length} tests`);
}

function listTags() {
  const tags = new Set<string>();
  for (const tc of BUILT_IN_TEST_CASES) {
    for (const tag of tc.tags ?? []) {
      tags.add(tag);
    }
  }

  console.log('Available Tags:\n');
  for (const tag of Array.from(tags).sort()) {
    const count = getTestCasesByTag(tag).length;
    console.log(`  ${tag} (${count} tests)`);
  }
}

async function interactiveMode(options: { verbose: boolean; enableTools: boolean }) {
  console.log('Creating testable runner...');
  const runner = createTestableRunner({
    enableTools: options.enableTools,
    autoApproveBash: true,
  });

  console.log('\nInteractive Trace Mode');
  console.log('─'.repeat(40));
  console.log('Type a message to trace it through the pipeline.');
  console.log('Commands:');
  console.log('  /traces    - Show all stored traces');
  console.log('  /clear     - Clear stored traces');
  console.log('  /exit      - Exit interactive mode');
  console.log('─'.repeat(40));
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question('> ', async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed === '/exit' || trimmed === '/quit') {
        console.log('Goodbye!');
        rl.close();
        return;
      }

      if (trimmed === '/traces') {
        const traces = getAllStoredTraces();
        console.log(`\nStored traces: ${traces.length}`);
        for (const trace of traces) {
          const duration = trace.summary?.totalDurationMs ?? 0;
          console.log(`  ${trace.traceId}: "${trace.input.substring(0, 40)}..." (${duration}ms)`);
        }
        console.log('');
        prompt();
        return;
      }

      if (trimmed === '/clear') {
        clearStoredTraces();
        console.log('Traces cleared.\n');
        prompt();
        return;
      }

      // Trace the input
      console.log('');
      const collector = createTraceCollector(trimmed);

      try {
        const response = await runner.processRequest(trimmed, collector);
        const trace = collector.complete();
        storeTrace(trace);

        console.log(formatTrace(trace));
      } catch (error) {
        collector.setError(error instanceof Error ? error.message : String(error));
        const trace = collector.complete();
        storeTrace(trace);

        console.log(formatTrace(trace));
      }

      console.log('');
      prompt();
    });
  };

  prompt();
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const { values: opts, positionals } = args;

  if (opts.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const command = positionals[0];
  const commonOptions = {
    verbose: opts.verbose ?? false,
    json: opts.json ?? false,
    enableTools: !(opts['no-tools'] ?? false),
  };

  // Handle commands
  if (command === 'list') {
    await listTests();
    process.exit(0);
  }

  if (command === 'tags') {
    listTags();
    process.exit(0);
  }

  // Interactive mode
  if (opts.interactive) {
    await interactiveMode(commonOptions);
    return;
  }

  // Single trace mode
  if (opts.trace) {
    const result = await runSingleTrace(opts.trace, commonOptions);
    process.exit(result.success ? 0 : 1);
  }

  // Test execution modes
  let testCases: TestCase[] = [];

  if (opts.id) {
    const tc = getTestCaseById(opts.id);
    if (!tc) {
      console.error(`Test case not found: ${opts.id}`);
      process.exit(1);
    }
    testCases = [tc];
  } else if (opts.tag) {
    testCases = getTestCasesByTag(opts.tag);
    if (testCases.length === 0) {
      console.error(`No tests found with tag: ${opts.tag}`);
      process.exit(1);
    }
  } else {
    // Run all tests
    testCases = opts.all ? BUILT_IN_TEST_CASES : getAllTestCases();
  }

  const summary = await runTests(testCases, {
    ...commonOptions,
    stopOnFailure: opts['stop-on-failure'] ?? false,
  });

  // Exit with appropriate code
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
