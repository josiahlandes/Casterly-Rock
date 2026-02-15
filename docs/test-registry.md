# Test Registry

Complete mapping of all test files to their source modules. Updated automatically by the autonomous loop.

## Running Tests

```bash
# All tests
npm run test

# With coverage
npm run test:coverage

# Single file
npx vitest run tests/tool-executor.test.ts

# By pattern
npx vitest run tests/autonomous-*

# Structured JSON output (for parsers)
npx vitest run --reporter=json
```

## Test Files by Domain

### Autonomous (`src/autonomous/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `analyzer.test.ts` | `src/autonomous/analyzer.ts` | Error log parsing, performance metrics, reflections, codebase stats |
| `autonomous-controller.test.ts` | `src/autonomous/controller.ts` | Start/stop, tick, interrupt, status, daily report |
| `autonomous-loop.test.ts` | `src/autonomous/loop.ts` | AbortError class, loadConfig YAML parsing |
| `autonomous-provider.test.ts` | `src/autonomous/provider.ts` | Provider abstraction, prompts, token usage |
| `autonomous-reflector.test.ts` | `src/autonomous/reflector.ts` | Reflection storage, statistics, memory entries |
| `autonomous-report.test.ts` | `src/autonomous/report.ts` | Daily report formatting, token counts, truncation |
| `autonomous-validator.test.ts` | `src/autonomous/validator.ts` | Invariant checks, test running, validation results |
| `git-operations.test.ts` | `src/autonomous/git.ts` | Branch management, commits, merges, reverts |
| `test-parser.test.ts` | `src/autonomous/test-parser.ts` | Vitest JSON parsing, coverage parsing, failure conversion |

### Benchmark (`src/benchmark/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `benchmark-compare.test.ts` | `src/benchmark/compare.ts` | Model comparison logic |
| `benchmark-metrics.test.ts` | `src/benchmark/metrics.ts` | Ollama metrics collection |
| `benchmark-report.test.ts` | `src/benchmark/report.ts` | Report formatting |
| `benchmark-scorer.test.ts` | `src/benchmark/scorer.ts` | Multi-dimension scoring |
| `benchmark-store.test.ts` | `src/benchmark/store.ts` | Persistent benchmark storage |
| `benchmark-suite.test.ts` | `src/benchmark/suite.ts` | Test suite execution |

### Coding (`src/coding/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `coding-edit.test.ts` | `src/coding/edit.ts` | Search-replace edit operations |
| `coding-glob.test.ts` | `src/coding/glob.ts` | File glob matching |
| `coding-grep.test.ts` | `src/coding/grep.ts` | File content searching |
| `coding-read.test.ts` | `src/coding/read.ts` | File reading |
| `coding-tools.test.ts` | `src/coding/tools.ts` | Coding tool schemas |
| `coding-write.test.ts` | `src/coding/write.ts` | File writing |
| `config-schema.test.ts` | `src/coding/config-schema.ts` | Coding config validation |
| `file-tracker.test.ts` | `src/coding/file-tracker.ts` | File change tracking |
| `mode-definitions.test.ts` | `src/coding/mode-definitions.ts` | Code/architect/ask/review modes |
| `mode-manager.test.ts` | `src/coding/mode-manager.ts` | Mode switching logic |
| `repo-map-builder.test.ts` | `src/coding/repo-map-builder.ts` | Repository map generation |
| `session-manager.test.ts` | `src/coding/session-manager.ts` | Coding session lifecycle |
| `session-memory-manager.test.ts` | `src/coding/session-memory-manager.ts` | In-memory session state |
| `session-memory-persistence.test.ts` | `src/coding/session-memory-persistence.ts` | Session persistence to disk |
| `session-persistence.test.ts` | `src/coding/session-persistence.ts` | Session save/load |
| `typescript-extractor.test.ts` | `src/coding/repo-map/extractors/typescript.ts` | Symbol extraction from TS/JS files |
| `python-extractor.test.ts` | `src/coding/repo-map/extractors/python.ts` | Symbol extraction from Python files |
| `go-extractor.test.ts` | `src/coding/repo-map/extractors/go.ts` | Symbol extraction from Go files |
| `rust-extractor.test.ts` | `src/coding/repo-map/extractors/rust.ts` | Symbol extraction from Rust files |
| `validation-parser.test.ts` | `src/coding/validation-parser.ts` | Edit validation output parsing |
| `validation-pipeline.test.ts` | `src/coding/validation-pipeline.ts` | Multi-stage validation pipeline |
| `validation-runner.test.ts` | `src/coding/validation-runner.ts` | Validation execution |

### Context (`src/context/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `auto-context.test.ts` | `src/context/auto-context.ts` | Automatic context assembly |
| `budget-allocator.test.ts` | `src/context/budget-allocator.ts` | Token budget allocation |
| `context-manager.test.ts` | `src/context/context-manager.ts` | Context lifecycle management |
| `context-profiles.test.ts` | `src/context/profiles.ts` | Scoped context profiles |
| `pagerank.test.ts` | `src/context/pagerank.ts` | PageRank for file importance |
| `prompt-builder.test.ts` | `src/context/prompt-builder.ts` | System prompt construction |
| `token-counter.test.ts` | `src/context/token-counter.ts` | Token counting utilities |

### Interface (`src/interface/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `interface-bootstrap.test.ts` | `src/interface/bootstrap.ts` | Interface initialization |
| `interface-bootstrap-memory.test.ts` | `src/interface/bootstrap-memory.ts` | Bootstrap with memory |
| `interface-context.test.ts` | `src/interface/context.ts` | Interface context management |
| `interface-context-profiles.test.ts` | `src/interface/context-profiles.ts` | Interface-level context profiles |
| `interface-memory.test.ts` | `src/interface/memory.ts` | Interface memory |
| `interface-prompt-builder.test.ts` | `src/interface/prompt-builder.ts` | Interface prompt building |
| `interface-session.test.ts` | `src/interface/session.ts` | Interface sessions |
| `interface-users.test.ts` | `src/interface/users.ts` | User management |

### Logging (`src/logging/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `safe-logger.test.ts` | `src/logging/safe-logger.ts` | Safe logging (no sensitive data) |

### Models (`src/models/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `model-enrichment.test.ts` | `src/models/enrichment.ts` | Model-specific prompt enrichment |
| `model-profiles.test.ts` | `src/models/profiles.ts` | Per-model configuration profiles |

### Pipeline (`src/pipeline/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `execution-log.test.ts` | `src/pipeline/execution-log.ts` | Execution log store |
| `task-classifier.test.ts` | `src/pipeline/task-classifier.ts` | Task type classification |
| `task-manager.test.ts` | `src/pipeline/task-manager.ts` | Task lifecycle management |
| `task-planner.test.ts` | `src/pipeline/task-planner.ts` | Task planning |
| `task-runner.test.ts` | `src/pipeline/task-runner.ts` | Task execution |
| `task-verifier.test.ts` | `src/pipeline/task-verifier.ts` | Task result verification |

### Providers (`src/providers/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `provider-base.test.ts` | `src/providers/base.ts` | Base provider abstraction |

### Router (`src/router/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `classifier.test.ts` | `src/router/classifier.ts` | Route classification logic |

### Scheduler (`src/scheduler/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `scheduler-checker.test.ts` | `src/scheduler/checker.ts` | Due job checking |
| `scheduler-cron.test.ts` | `src/scheduler/cron.ts` | Cron expression parsing |
| `scheduler-cron-trigger.test.ts` | `src/scheduler/cron-trigger.ts` | Cron trigger evaluation |
| `scheduler-executor.test.ts` | `src/scheduler/executor.ts` | Job execution |
| `scheduler-store.test.ts` | `src/scheduler/store.ts` | Persistent job store |
| `scheduler-tools.test.ts` | `src/scheduler/tools.ts` | Scheduler tool schemas |
| `scheduler-trigger.test.ts` | `src/scheduler/trigger.ts` | Trigger matching |

### Security (`src/security/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `error-codes.test.ts` | `src/security/error-codes.ts` | Error code definitions |
| `redactor.test.ts` | `src/security/redactor.ts` | Sensitive data redaction |
| `security-detection.test.ts` | `src/security/detection.ts` | Threat detection patterns |
| `security-patterns.test.ts` | `src/security/patterns.ts` | Security pattern matching |

### Skills (`src/skills/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `skills-filter.test.ts` | `src/skills/loader.ts` | Skill filtering (notes dedup) |
| `skills-loader.test.ts` | `src/skills/loader.ts` | Skill loading from disk |
| `skills-registry.test.ts` | `src/skills/loader.ts` | Skill registry CRUD + notes edge cases |

### Testing (`src/testing/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `test-cases.test.ts` | `src/testing/test-cases.ts` | Built-in E2E test case definitions |
| `test-runner.test.ts` | `src/testing/test-runner.ts` | E2E test execution and evaluation |
| `trace-collector.test.ts` | `src/testing/trace.ts` | Request trace collection |

### Tools (`src/tools/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `bash-executor.test.ts` | `src/tools/executor.ts` | Bash command execution |
| `tool-executor.test.ts` | `src/tools/executor.ts` | Approval, blocking, safety gates |
| `tool-filter.test.ts` | `src/tools/filter.ts` | Tool filtering logic |
| `tool-orchestrator.test.ts` | `src/tools/orchestrator.ts` | Multi-tool orchestration |
| `tool-registry.test.ts` | `src/tools/registry.ts` | Tool registration and lookup |
| `tool-schemas.test.ts` | `src/tools/schemas/*.ts` | All tool schema definitions |

### Tool Executors (`src/tools/executors/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `edit-file-executor.test.ts` | `src/tools/executors/edit-file.ts` | Edit file executor |
| `glob-files-executor.test.ts` | `src/tools/executors/glob-files.ts` | Glob files executor |
| `grep-files-executor.test.ts` | `src/tools/executors/grep-files.ts` | Grep files executor |
| `list-files-executor.test.ts` | `src/tools/executors/list-files.ts` | List files executor |
| `read-file-executor.test.ts` | `src/tools/executors/read-file.ts` | Read file executor |
| `search-files-executor.test.ts` | `src/tools/executors/search-files.ts` | Search files executor |
| `send-message-executor.test.ts` | `src/tools/executors/send-message.ts` | Send message executor |
| `validate-files-executor.test.ts` | `src/tools/executors/validate-files.ts` | Validate files executor |
| `write-file-executor.test.ts` | `src/tools/executors/write-file.ts` | Write file executor |

### Document Parsers (`src/tools/executors/parsers/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `document-csv.test.ts` | `src/tools/executors/parsers/csv.ts` | CSV parsing |
| `document-docx.test.ts` | `src/tools/executors/parsers/docx.ts` | DOCX parsing |
| `document-pdf.test.ts` | `src/tools/executors/parsers/pdf.ts` | PDF parsing |
| `document-xlsx.test.ts` | `src/tools/executors/parsers/xlsx.ts` | XLSX parsing |
| `read-document.test.ts` | `src/tools/executors/read-document.ts` | Document reader dispatcher |

### Approval (`src/approval/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `approval-bridge.test.ts` | `src/approval/bridge.ts` | Async approval bridge |
| `approval-matcher.test.ts` | `src/approval/matcher.ts` | Approval request matching |
| `approval-store.test.ts` | `src/approval/store.ts` | Approval state persistence |

### iMessage (`src/imessage/`)

| Test File | Source Module | Description |
|-----------|-------------|-------------|
| `message-utils.test.ts` | `src/imessage/utils.ts` | Message parsing utilities |

## Summary

- **Total test files**: 101
- **Total domains**: 16
- **Framework**: Vitest 4.x (ES modules)
- **Coverage tool**: @vitest/coverage-v8
- **Coverage output**: `coverage/coverage-summary.json`
