/**
 * Smoke Tests Types — Shared types for the 3-phase verification pipeline.
 *
 * Phase 1: Automated gates (typecheck, lint, tests, static analysis)
 * Phase 2: Project-type smoke tests (browser, CLI, Python)
 * Phase 3: Intent review (27B reasoner with tools)
 *
 * See docs/dual-loop-architecture.md Section 5.4.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Project Type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detected project type, used to select which gates and smoke tests to run.
 * Detection priority: web > node-cli > python > typescript > generic.
 */
export type ProjectType = 'web' | 'node-cli' | 'python' | 'typescript' | 'generic';

// ─────────────────────────────────────────────────────────────────────────────
// Gate Results
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of a single verification gate (e.g. typecheck, lint, browser_test).
 */
export interface GateResult {
  /** Gate identifier (e.g. 'typecheck', 'lint', 'browser_test') */
  gate: string;
  /** Whether this gate passed */
  passed: boolean;
  /** Raw command/tool output — fed to coder as revision feedback on failure */
  output: string;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** True when the gate doesn't apply to this project type */
  skipped?: boolean;
}

/**
 * Aggregated result of a verification phase (Phase 1 or Phase 2).
 */
export interface PhaseResult {
  /** Which phase produced this result */
  phase: 'automated_gates' | 'smoke_tests';
  /** Whether all gates in this phase passed (skipped gates count as passed) */
  passed: boolean;
  /** Individual gate results */
  gates: GateResult[];
  /** Total wall-clock duration in milliseconds */
  totalDurationMs: number;
  /** Concatenated failing gate outputs, formatted for revision feedback */
  revisionFeedback?: string;
}
