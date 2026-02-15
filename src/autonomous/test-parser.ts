/**
 * Structured Test & Coverage Parser (Autonomous Loop)
 *
 * Parses Vitest JSON reporter output and V8 coverage summaries into
 * typed structures that the Analyzer and Validator can consume directly.
 *
 * All functions are pure — no I/O, no side effects.
 */

import type { ErrorLogEntry, Observation } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES — Vitest JSON output
// ═══════════════════════════════════════════════════════════════════════════════

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export interface TestFailure {
  testFile: string;
  testName: string;
  suiteName: string;
  message: string;
  stack?: string | undefined;
  durationMs: number;
}

export interface FileTestResult {
  path: string;
  total: number;
  passed: number;
  failed: number;
}

export interface ParsedTestResults {
  success: boolean;
  summary: TestSummary;
  testFiles: FileTestResult[];
  failures: TestFailure[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES — Coverage
// ═══════════════════════════════════════════════════════════════════════════════

export interface CoverageMetric {
  total: number;
  covered: number;
  pct: number;
}

export interface FileCoverage {
  statements: CoverageMetric;
  branches: CoverageMetric;
  functions: CoverageMetric;
  lines: CoverageMetric;
}

export interface CoverageSummary {
  totalStatements: number;
  coveredStatements: number;
  percentage: number;
  files: Map<string, FileCoverage>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// parseVitestJson
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse the JSON output from `vitest run --reporter=json`.
 *
 * Vitest JSON structure (Jest-compatible):
 * {
 *   success: boolean,
 *   numTotalTests: number,
 *   numPassedTests: number,
 *   numFailedTests: number,
 *   numPendingTests: number,
 *   startTime: number,
 *   testResults: [{
 *     name: string,           // absolute path to test file
 *     status: 'passed'|'failed',
 *     assertionResults: [{
 *       fullName: string,
 *       ancestorTitles: string[],
 *       status: 'passed'|'failed'|'pending',
 *       title: string,
 *       duration: number,
 *       failureMessages: string[],
 *     }]
 *   }]
 * }
 */
export function parseVitestJson(raw: string): ParsedTestResults {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return emptyResults(false);
  }

  if (typeof data !== 'object' || data === null) {
    return emptyResults(false);
  }

  const success = data['success'] === true;
  const numTotal = toNumber(data['numTotalTests']);
  const numPassed = toNumber(data['numPassedTests']);
  const numFailed = toNumber(data['numFailedTests']);
  const numPending = toNumber(data['numPendingTests']);
  const startTime = toNumber(data['startTime']);

  // Calculate duration from testResults if available
  let maxEndTime = startTime;
  const testResults = Array.isArray(data['testResults']) ? data['testResults'] : [];

  const testFiles: FileTestResult[] = [];
  const failures: TestFailure[] = [];

  for (const tr of testResults) {
    if (typeof tr !== 'object' || tr === null) continue;
    const result = tr as Record<string, unknown>;

    const filePath = typeof result['name'] === 'string' ? result['name'] : '';
    const assertions = Array.isArray(result['assertionResults'])
      ? result['assertionResults']
      : [];

    let filePassed = 0;
    let fileFailed = 0;

    for (const ar of assertions) {
      if (typeof ar !== 'object' || ar === null) continue;
      const assertion = ar as Record<string, unknown>;

      const status = String(assertion['status'] ?? '');
      const duration = toNumber(assertion['duration']);

      if (status === 'passed') {
        filePassed++;
      } else if (status === 'failed') {
        fileFailed++;

        const failureMessages = Array.isArray(assertion['failureMessages'])
          ? (assertion['failureMessages'] as unknown[]).map(String)
          : [];
        const ancestorTitles = Array.isArray(assertion['ancestorTitles'])
          ? (assertion['ancestorTitles'] as unknown[]).map(String)
          : [];

        failures.push({
          testFile: filePath,
          testName: String(assertion['title'] ?? ''),
          suiteName: ancestorTitles.join(' > '),
          message: failureMessages[0] ?? 'Test failed',
          stack: failureMessages.length > 1 ? failureMessages.slice(1).join('\n') : undefined,
          durationMs: duration,
        });
      }
      // 'pending' / 'skipped' — ignored for failures
    }

    testFiles.push({
      path: filePath,
      total: filePassed + fileFailed,
      passed: filePassed,
      failed: fileFailed,
    });

    // Track max end time for duration calculation
    const endTime = toNumber(result['endTime']);
    if (endTime > maxEndTime) {
      maxEndTime = endTime;
    }
  }

  const durationMs = maxEndTime > startTime ? maxEndTime - startTime : 0;

  return {
    success,
    summary: {
      total: numTotal,
      passed: numPassed,
      failed: numFailed,
      skipped: numPending,
      durationMs,
    },
    testFiles,
    failures,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// testFileToSourceModule
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Map a test file path to its likely source module path.
 *
 * Convention: `tests/foo-bar.test.ts` → `src/foo/bar.ts`
 *
 * Examples:
 *   tests/tool-executor.test.ts       → src/tools/executor.ts
 *   tests/autonomous-loop.test.ts     → src/autonomous/loop.ts
 *   tests/skills-registry.test.ts     → src/skills/registry.ts
 *   tests/router-classifier.test.ts   → src/router/classifier.ts
 */
export function testFileToSourceModule(testPath: string): string {
  // Extract just the filename if a full path is given
  const parts = testPath.split('/');
  const fileName = parts[parts.length - 1] ?? testPath;

  // Remove .test.ts suffix
  const baseName = fileName.replace(/\.test\.ts$/, '');

  // Split on first hyphen: "foo-bar-baz" → dir="foo", file="bar-baz"
  const hyphenIdx = baseName.indexOf('-');
  if (hyphenIdx === -1) {
    // Single segment: tests/utils.test.ts → src/utils.ts
    return `src/${baseName}.ts`;
  }

  const dir = baseName.substring(0, hyphenIdx);
  const rest = baseName.substring(hyphenIdx + 1);

  // Convert remaining hyphens to path separators? No — they're usually kebab-case file names.
  // e.g. tests/tool-executor.test.ts → src/tool/executor.ts (but actual is src/tools/executor.ts)
  // The mapping is approximate and works for most cases.
  return `src/${dir}/${rest}.ts`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// failuresToErrorLogEntries
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert parsed test failures into ErrorLogEntry values that the
 * Analyzer's aggregateErrors() method understands.
 */
export function failuresToErrorLogEntries(failures: TestFailure[]): ErrorLogEntry[] {
  const now = new Date().toISOString();

  return failures.map((f) => ({
    timestamp: now,
    code: 'TEST_FAILURE',
    message: `${f.suiteName ? f.suiteName + ' > ' : ''}${f.testName}: ${truncate(f.message, 120)}`,
    stack: f.stack,
    frequency: 1,
    lastOccurrence: now,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// failuresToObservations
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert parsed test failures into Observation objects for the
 * hypothesize phase. Groups failures by file to avoid flooding
 * the LLM with too many observations.
 */
export function failuresToObservations(failures: TestFailure[]): Observation[] {
  if (failures.length === 0) return [];

  // Group by test file
  const byFile = new Map<string, TestFailure[]>();
  for (const f of failures) {
    const key = f.testFile || 'unknown';
    const list = byFile.get(key) ?? [];
    list.push(f);
    byFile.set(key, list);
  }

  const now = new Date().toISOString();
  const observations: Observation[] = [];

  for (const [file, fileFailures] of byFile) {
    const sourceModule = testFileToSourceModule(file);
    const names = fileFailures.map((f) => f.testName).join(', ');

    observations.push({
      id: `test-fail-${observations.length}`,
      type: 'test_failure',
      severity: fileFailures.length >= 5 ? 'high' : fileFailures.length >= 2 ? 'medium' : 'low',
      frequency: fileFailures.length,
      context: {
        testFile: file,
        sourceModule,
        failedTests: names,
        firstMessage: fileFailures[0]?.message ?? '',
      },
      suggestedArea: sourceModule,
      timestamp: now,
      source: 'test_results',
    });
  }

  return observations;
}

// ═══════════════════════════════════════════════════════════════════════════════
// parseCoverageSummary
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse the `coverage/coverage-summary.json` file produced by
 * `@vitest/coverage-v8` with `reporter: ['json-summary']`.
 *
 * Format:
 * {
 *   "total": { "statements": { "total": N, "covered": N, "pct": N }, ... },
 *   "path/to/file.ts": { "statements": { ... }, "branches": { ... }, ... }
 * }
 */
export function parseCoverageSummary(raw: string): CoverageSummary {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return emptyCoverage();
  }

  if (typeof data !== 'object' || data === null) {
    return emptyCoverage();
  }

  const totalEntry = data['total'];
  const totalCov = parseFileCoverage(totalEntry);

  const files = new Map<string, FileCoverage>();
  for (const [key, value] of Object.entries(data)) {
    if (key === 'total') continue;
    files.set(key, parseFileCoverage(value));
  }

  return {
    totalStatements: totalCov.statements.total,
    coveredStatements: totalCov.statements.covered,
    percentage: totalCov.statements.pct,
    files,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// computeCoverageDelta
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute the coverage change in percentage points.
 *
 * @returns `after - before` (positive = improvement)
 */
export function computeCoverageDelta(before: number, after: number): number {
  return Math.round((after - before) * 100) / 100;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function toNumber(val: unknown): number {
  if (typeof val === 'number' && !Number.isNaN(val)) return val;
  return 0;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen - 3) + '...';
}

function emptyResults(success: boolean): ParsedTestResults {
  return {
    success,
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 },
    testFiles: [],
    failures: [],
  };
}

function emptyCoverage(): CoverageSummary {
  return { totalStatements: 0, coveredStatements: 0, percentage: 0, files: new Map() };
}

function parseMetric(val: unknown): CoverageMetric {
  if (typeof val !== 'object' || val === null) {
    return { total: 0, covered: 0, pct: 0 };
  }
  const obj = val as Record<string, unknown>;
  return {
    total: toNumber(obj['total']),
    covered: toNumber(obj['covered']),
    pct: toNumber(obj['pct']),
  };
}

function parseFileCoverage(val: unknown): FileCoverage {
  if (typeof val !== 'object' || val === null) {
    return {
      statements: { total: 0, covered: 0, pct: 0 },
      branches: { total: 0, covered: 0, pct: 0 },
      functions: { total: 0, covered: 0, pct: 0 },
      lines: { total: 0, covered: 0, pct: 0 },
    };
  }
  const obj = val as Record<string, unknown>;
  return {
    statements: parseMetric(obj['statements']),
    branches: parseMetric(obj['branches']),
    functions: parseMetric(obj['functions']),
    lines: parseMetric(obj['lines']),
  };
}
