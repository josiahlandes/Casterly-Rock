# Casterly Testing & Verification

This document describes the testing infrastructure for tracing, debugging, and verifying Casterly's request pipeline.

## Overview

The testing system provides:

1. **Trace Collection** - Capture events throughout request processing
2. **Built-in Test Cases** - Verify routing, tools, safety gates
3. **Test Runner** - Execute tests and evaluate outcomes
4. **CLI Interface** - Run tests and trace requests interactively

```
┌─────────────────────────────────────────────────────────────────┐
│                      Test CLI                                   │
│   npx tsx src/test-cli.ts [options]                             │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Testable Runner                               │
│   Wraps pipeline with trace instrumentation                     │
└───────────────────────────────┬─────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐       ┌───────────────┐       ┌───────────────┐
│ Trace         │       │ Test Cases    │       │ Test Runner   │
│ Collector     │       │ & Expected    │       │ & Evaluator   │
│               │       │ Outcomes      │       │               │
└───────────────┘       └───────────────┘       └───────────────┘
```

## Quick Start

```bash
# Run all tests
npm run test:e2e

# Trace a single request
npm run test:trace "What files are on my desktop?"

# Interactive debugging mode
npm run test:interactive

# Run tests with specific tag
npx tsx src/test-cli.ts --tag routing

# Run a specific test
npx tsx src/test-cli.ts --id route-002

# List all available tests
npx tsx src/test-cli.ts list
```

## Trace Collection

### Event Types

The trace collector captures these events throughout the pipeline:

| Event Type | Description |
|------------|-------------|
| `request_start` | Initial request received |
| `sensitivity_check` | Sensitive content detection |
| `routing_start` | Begin routing decision |
| `routing_tool_call` | Router calls route_decision tool |
| `routing_decision` | Final routing decision made |
| `context_assembly` | System prompt and history assembled |
| `llm_request` | Request sent to LLM provider |
| `llm_response` | Response received from LLM |
| `tool_call_received` | Model returned tool call |
| `tool_filter_check` | Safety gate check performed |
| `tool_execution_start` | Begin tool execution |
| `tool_execution_result` | Tool execution completed |
| `tool_loop_iteration` | Multi-turn tool loop iteration |
| `response_complete` | Final response ready |
| `error` | Error occurred |

### Trace Output Example

```
══════════════════════════════════════════════════════════════════
TRACE: tr_1706123456789_abc123
══════════════════════════════════════════════════════════════════
Input: "What files are on my desktop?"
──────────────────────────────────────────────────────────────────

EVENTS:
──────────────────────────────────────────────────────────────────
[0ms] request_start
  └─ input: "What files are on my desktop?"

[15ms] routing_start
  └─ inputLength: 32

[142ms] routing_decision
  └─ route: "local"
  └─ reason: "Simple file listing request, no sensitive data"
  └─ confidence: 0.85

[156ms] context_assembly
  └─ estimatedTokens: 1250
  └─ historyMessages: 0
  └─ skillsIncluded: 3

[178ms] llm_request
  └─ provider: "ollama-local"
  └─ iteration: 1

[2341ms] llm_response
  └─ toolCalls: 1
  └─ stopReason: "tool_use"

[2345ms] tool_call_received
  └─ toolName: "bash"
  └─ toolId: "toolu_01abc..."
  └─ input: {"command": "ls ~/Desktop"}

[2348ms] tool_execution_start
  └─ toolName: "bash"

[2412ms] tool_execution_result
  └─ success: true
  └─ outputLength: 156

[2420ms] tool_loop_iteration
  └─ iteration: 2

[3890ms] llm_response
  └─ toolCalls: 0
  └─ stopReason: "end_turn"

[3895ms] response_complete
  └─ iterations: 2
  └─ responseLength: 245

SUMMARY:
──────────────────────────────────────────────────────────────────
Duration:     3895ms
Route:        local
Tool Calls:   1 (bash)
Final Status: completed

══════════════════════════════════════════════════════════════════
```

### Using Trace Collector Programmatically

```typescript
import { createTraceCollector, formatTrace } from './testing/index.js';
import { createTestableRunner } from './testing/testable-runner.js';

const runner = createTestableRunner();
const collector = createTraceCollector("What's on my calendar?");

try {
  const response = await runner.processRequest("What's on my calendar?", collector);
  const trace = collector.complete();

  console.log(formatTrace(trace));
  console.log('Response:', response);
} catch (error) {
  collector.setError(error.message);
  const trace = collector.complete();
  console.log(formatTrace(trace));
}
```

## Test Cases

### Built-in Test Cases

The system includes built-in tests covering:

#### Routing Tests
| ID | Name | Verifies |
|----|------|----------|
| `route-001` | Simple greeting routes locally | Basic local routing |
| `route-002` | SSN detection routes locally | Sensitive data detection |
| `route-003` | Calendar query routes locally | Calendar privacy |
| `route-004` | Complex coding routes to cloud | Cloud routing for complex tasks |
| `route-005` | Financial query routes locally | Financial privacy |

#### Tool Tests
| ID | Name | Verifies |
|----|------|----------|
| `tool-001` | List files triggers bash tool | Tool calling works |
| `tool-002` | Get date triggers bash tool | System commands work |
| `tool-003` | Simple question no tools | Model doesn't over-use tools |

#### Safety Tests
| ID | Name | Verifies |
|----|------|----------|
| `safety-001` | Destructive rm blocked | Dangerous commands blocked |
| `safety-002` | Fork bomb blocked | System attacks prevented |

#### Multi-step Tests
| ID | Name | Verifies |
|----|------|----------|
| `multi-001` | Multi-step file operation | Tool loop works correctly |

#### Hallucination Tests
| ID | Name | Verifies |
|----|------|----------|
| `halluc-001` | No hallucinated file ops | Model actually uses tools |

#### Performance Tests
| ID | Name | Verifies |
|----|------|----------|
| `perf-001` | Simple response under 30s | Response time acceptable |

### Expected Outcomes

Each test case defines expected outcomes:

```typescript
interface ExpectedOutcome {
  // Routing
  route?: 'local' | 'cloud';
  sensitiveCategories?: string[];

  // Tool usage
  shouldCallTools?: boolean;
  expectedToolNames?: string[];
  toolCallCount?: { min?: number; max?: number };

  // Response content
  responsePattern?: RegExp;
  responseExcludePattern?: RegExp;
  responseContains?: string[];

  // Execution
  shouldSucceed?: boolean;
  maxDurationMs?: number;
}
```

### Adding Custom Test Cases

```typescript
import type { TestCase } from './testing/test-cases.js';

const customTests: TestCase[] = [
  {
    id: 'custom-001',
    name: 'Email draft stays local',
    description: 'Drafting emails should route locally for privacy',
    input: 'Draft an email to john@example.com about the project update',
    expected: {
      route: 'local',
      sensitiveCategories: ['contacts'],
      shouldSucceed: true,
    },
    tags: ['routing', 'email', 'custom'],
  },
];
```

## Test Runner

### Running Tests

```bash
# All tests
npx tsx src/test-cli.ts

# By tag
npx tsx src/test-cli.ts --tag routing
npx tsx src/test-cli.ts --tag tools
npx tsx src/test-cli.ts --tag safety

# Specific test
npx tsx src/test-cli.ts --id route-002

# Stop on first failure
npx tsx src/test-cli.ts --stop-on-failure

# Verbose output
npx tsx src/test-cli.ts --verbose

# JSON output (for CI)
npx tsx src/test-cli.ts --json
```

### Test Output

```
Running 12 tests...

✓ route-001: Simple greeting routes locally (1234ms)

✓ route-002: SSN detection routes locally (856ms)

✗ route-003: Calendar query routes locally (2341ms)
  FAILURES:
  - Expected route 'local' but got 'cloud'
  - Expected sensitive category 'calendar' not detected

...

═══════════════════════════════════════════════════════════════
TEST SUMMARY
═══════════════════════════════════════════════════════════════
Total:    12
Passed:   10
Failed:   2
Skipped:  0
Duration: 45.2s

FAILED TESTS:
- route-003: Calendar query routes locally
- safety-001: Destructive rm command blocked
═══════════════════════════════════════════════════════════════
```

## Interactive Mode

Interactive mode allows real-time debugging:

```bash
npm run test:interactive
```

```
Interactive Trace Mode
────────────────────────────────────────
Type a message to trace it through the pipeline.
Commands:
  /traces    - Show all stored traces
  /clear     - Clear stored traces
  /exit      - Exit interactive mode
────────────────────────────────────────

> What time is it?

══════════════════════════════════════════════════════════════════
TRACE: tr_1706123456789_def456
...
[trace output]
...

> /traces
Stored traces: 1
  tr_1706123456789_def456: "What time is it?..." (2341ms)

> /exit
Goodbye!
```

## CLI Reference

```
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
```

## Module Structure

```
src/testing/
├── index.ts              # Module exports
├── trace.ts              # TraceCollector, formatTrace, event types
├── test-cases.ts         # TestCase definitions, BUILT_IN_TEST_CASES
├── test-runner.ts        # Test execution, evaluation, formatting
└── testable-runner.ts    # Pipeline wrapper with instrumentation

src/test-cli.ts           # CLI entry point
```

## Debugging Common Issues

### Route Goes to Wrong Provider

1. Run the test with `--verbose` to see full trace
2. Check `routing_decision` event for confidence and reason
3. If confidence is low, model may be uncertain - add more context
4. Check if sensitive category patterns need updating

### Tools Not Being Called

1. Check `llm_response` event for `toolCalls` count
2. Verify model supports native tool use
3. Check tool schemas are being passed correctly
4. Look for hallucinated tool claims vs actual tool calls

### Safety Gate Blocking Legitimate Commands

1. Check `tool_filter_check` event for rejection reason
2. Review safety patterns in `src/tools/executor.ts`
3. Consider if command should actually be allowed

### Slow Response Times

1. Check `llm_request` and `llm_response` event timings
2. Look at `tool_loop_iteration` count - too many iterations?
3. Consider model size and hardware limitations
4. Check for unnecessary tool calls

## CI Integration

Add to your CI pipeline:

```yaml
# .github/workflows/test.yml
test-e2e:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
    - run: npm ci
    - run: npm run test:e2e -- --json > test-results.json
    - uses: actions/upload-artifact@v4
      with:
        name: test-results
        path: test-results.json
```

## Extending the System

### Custom Trace Events

```typescript
// Add event to collector
collector.addEvent('custom_event', { customData: 'value' });

// Timed events
const eventId = collector.startTimedEvent('long_operation');
// ... operation ...
collector.endTimedEvent(eventId, { result: 'success' });
```

### Custom Test Evaluation

```typescript
import { evaluateResult } from './testing/test-runner.js';

// Custom evaluation logic
const result = evaluateResult(testCase, trace, response, error);
if (result.failures.length > 0) {
  // Handle failures
}
```

### Trace Storage

Traces are stored in memory during a session. For persistent storage:

```typescript
import { storeTrace, getAllStoredTraces, clearStoredTraces } from './testing/index.js';

// Store trace
storeTrace(trace);

// Retrieve all traces
const traces = getAllStoredTraces();

// Clear storage
clearStoredTraces();
```
