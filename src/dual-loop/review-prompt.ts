/**
 * Review Prompt — System prompts and builders for the 3-phase verification pipeline.
 *
 * Phase 1 (automated gates) and Phase 2 (smoke tests) are deterministic —
 * no LLM involved, no prompts needed.
 *
 * Phase 3 (intent review) uses the 27B reasoner with thinking ON and tools
 * (read_file, grep, glob) to verify that the code matches the user's intent.
 *
 * Parse failures default to approved — phantom rejections from malformed JSON
 * were the primary cause of infinite revision loops.
 *
 * See docs/dual-loop-architecture.md Section 5.4.
 */

import type { TaskArtifact, ReviewResult, FileOperation } from './task-board-types.js';
import { extractJsonFromResponse } from './deep-loop.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The structured result of reviewing a task's artifacts.
 */
export interface ReviewOutcome {
  result: ReviewResult;
  notes: string;           // Human-readable summary of findings
  feedback?: string | undefined;  // Specific feedback for DeepLoop (if changes_requested)
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured Output Schema (Ollama format parameter)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON Schema for the review response. Passed as Ollama's `format` parameter
 * to guarantee valid, schema-conformant JSON output without parsing fallbacks.
 */
export const REVIEW_FORMAT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    result: {
      type: 'string',
      enum: ['approved', 'changes_requested', 'rejected'],
    },
    notes: {
      type: 'string',
    },
    feedback: {
      type: 'string',
    },
  },
  required: ['result', 'notes'],
};

// ─────────────────────────────────────────────────────────────────────────────
// FastLoop Review Prompt (single-shot, no tools)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * System prompt for FastLoop code review (single structured-output call).
 * Used by the 35B fast model for lightweight review without tools.
 */
export const REVIEW_SYSTEM_PROMPT = `You are a code reviewer. Review the provided diff(s) for:

1. **Correctness** — Does the code do what the plan intended?
2. **Security** — Are there injection risks, credential leaks, or unsafe operations?
3. **Style** — Does the code follow existing patterns and conventions?
4. **Completeness** — Are edge cases handled? Are tests included?
5. **File Structure** — Are file paths consistent? Are there duplicate basenames at different paths (e.g., config.js at root AND js/config.js)? Does the entry point reference the correct file names and IDs?

Respond with a JSON object:
{
  "result": "approved" | "changes_requested" | "rejected",
  "notes": "Summary of what you found",
  "feedback": "Specific changes needed (only for changes_requested)"
}

When in doubt about runtime behavior or cross-module wiring, request changes.
Only request changes for clear correctness, security, or file structure issues.

Verification checklist:
- All imports resolve to exported symbols
- Method calls on imported objects match the actual API surface
- Data flows are complete (return values captured, callbacks wired, events subscribed)
- No standalone function calls that ignore return values needed by the system`;

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3: Intent Review Prompt (DeepLoop 3-phase pipeline)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * System prompt for the Phase 3 intent review.
 *
 * The code has already passed automated gates (typecheck, lint, tests, static
 * analysis) and runtime smoke tests. The reviewer focuses exclusively on
 * intent matching and subtle logic errors that tools cannot catch.
 *
 * The reviewer has read-only tools (read_file, grep, glob) to inspect files
 * on demand instead of relying on pre-injected content.
 */
export const INTENT_REVIEW_SYSTEM_PROMPT = `You are a code reviewer with access to tools. The code has already passed automated checks (typecheck, lint, tests, static analysis, and runtime smoke tests). It compiles and runs.

Your job is ONLY to verify intent and catch subtle logic errors that tools cannot detect:

1. **Intent Match** — Does the code do what the user originally asked for? Read the original request carefully and verify each requirement is met.
2. **Architecture** — Is the approach appropriate for the problem? Are there simpler solutions the implementation missed?
3. **Logic Errors** — Subtle bugs: wrong comparisons, off-by-one, missing edge cases, incorrect state transitions, race conditions.
4. **Completeness** — Are all requested features implemented? Are important edge cases handled?

You have tools: read_file, grep, glob. Use them to inspect specific files on demand instead of relying on the manifest alone.

DO NOT check for:
- Type errors (already caught by typecheck)
- Import/export mismatches (already caught by validate_project)
- Runtime crashes (already caught by smoke tests)
- Lint violations (already caught by linter)

After inspecting the relevant files, respond with a JSON object:
{
  "result": "approved" | "changes_requested",
  "notes": "Summary of what you found",
  "feedback": "Specific changes needed (only for changes_requested)"
}

When in doubt, approve. The automated gates caught the mechanical bugs — only reject for genuine intent mismatches or logic errors that would surprise the user.`;

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the review prompt from a task's plan, artifacts, and optional context.
 * Used by processRevision() and legacy callers.
 */
export function buildReviewPrompt(params: {
  plan: string;
  artifacts: TaskArtifact[];
  manifest?: FileOperation[];
  originalMessage?: string;
}): string {
  const parts: string[] = [];

  // Original request gives the reviewer context about what was asked for
  if (params.originalMessage) {
    parts.push('## Original Request\n');
    parts.push(params.originalMessage);
    parts.push('\n');
  }

  parts.push('## Plan\n');
  parts.push(params.plan);

  // File structure manifest lets the reviewer check for path issues
  if (params.manifest && params.manifest.length > 0) {
    parts.push('\n\n## File Structure\n');
    parts.push('Files created/modified during implementation:\n');
    for (const file of params.manifest) {
      parts.push(`- ${file.path} (${file.action}${file.lines !== undefined ? `, ${file.lines} lines` : ''})`);
    }
    parts.push('\n');
  }

  parts.push('\n\n## Artifacts\n');

  for (const artifact of params.artifacts) {
    parts.push(`### ${artifact.type}${artifact.path ? ` — ${artifact.path}` : ''}\n`);
    parts.push(artifact.content ?? '(no content)');
    parts.push('\n');
  }

  return parts.join('\n');
}

/**
 * Build a lightweight prompt for Phase 3 intent review.
 *
 * Includes the original request, plan, and manifest listing but NO file contents.
 * The reviewer reads files on demand via tools, eliminating truncation issues.
 */
export function buildIntentReviewPrompt(params: {
  originalMessage?: string;
  plan: string;
  manifest: FileOperation[];
  projectDir?: string;
}): string {
  const parts: string[] = [];

  if (params.originalMessage) {
    parts.push('## Original Request\n');
    parts.push(params.originalMessage);
  }

  parts.push('\n## Plan\n');
  parts.push(params.plan);

  if (params.manifest.length > 0) {
    parts.push('\n## Files Created/Modified\n');
    for (const file of params.manifest) {
      const lineInfo = file.lines !== undefined ? `, ${file.lines} lines` : '';
      const exports = file.exports?.length ? `, exports: ${file.exports.join(', ')}` : '';
      parts.push(`- \`${file.path}\` (${file.action}${lineInfo}${exports})`);
    }
  }

  if (params.projectDir) {
    parts.push(`\n## Project Directory: \`${params.projectDir}\``);
  }

  parts.push('\n## Instructions\n');
  parts.push('Use read_file, grep, and glob to inspect the actual files. Verify the implementation matches the original request. Do NOT rely on the plan alone — read the code.');

  return parts.join('\n');
}

/**
 * Count the total lines across all diff artifacts.
 * Used by FastLoop to select the review context tier.
 */
export function countDiffLines(artifacts: TaskArtifact[]): number {
  let total = 0;
  for (const artifact of artifacts) {
    if (artifact.type === 'file_diff' && artifact.content) {
      total += artifact.content.split('\n').length;
    }
  }
  return total;
}

/**
 * Parse the review response from the LLM.
 *
 * Handles <think>...</think> tags from the reasoner (thinking ON) by using
 * extractJsonFromResponse. Falls back to 'approved' on parse failure.
 */
export function parseReviewResponse(text: string): ReviewOutcome {
  try {
    const { json: parsed } = extractJsonFromResponse(text);
    return {
      result: (parsed['result'] as ReviewResult) ?? 'changes_requested',
      notes: (parsed['notes'] as string) ?? '',
      feedback: parsed['feedback'] as string | undefined,
    };
  } catch {
    // On parse failure, default to approved. Phantom rejections from
    // malformed JSON were the primary cause of infinite revision loops.
    return {
      result: 'approved',
      notes: 'Review parse failure — defaulting to approved (model output was not valid JSON)',
    };
  }
}
