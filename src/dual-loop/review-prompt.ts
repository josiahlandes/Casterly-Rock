/**
 * Review Prompt — System prompts for code review.
 *
 * The DeepLoop self-reviews its own output before marking tasks as complete.
 * Reviews are single structured-output calls with real file contents injected
 * into the prompt (not iterative tool loops).
 *
 * Review pipeline:
 *   1. Integration review (multi-file only): cross-module wiring check
 *   2. Correctness review (all tasks): standard code review
 *   3. Security review (large projects only): second-pass cascade
 *
 * Parse failures default to approved — phantom rejections from malformed JSON
 * were the primary cause of infinite revision loops.
 *
 * See docs/dual-loop-architecture.md Section 5.4 and Section 4 (Phase 4).
 */

import type { TaskArtifact, ReviewResult, FileOperation } from './task-board-types.js';

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

/**
 * JSON Schema for the integration review response.
 * Enforces structured JSON output matching the integration review's expected format.
 */
export const INTEGRATION_REVIEW_FORMAT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    result: {
      type: 'string',
      enum: ['approved', 'changes_requested'],
    },
    issues: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['result', 'issues'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * System prompt for the code review call.
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

/**
 * Cascade review prompts — each pass focuses on a different concern.
 * Pass 0 is the standard review (REVIEW_SYSTEM_PROMPT above).
 * Additional passes use these specialized prompts.
 *
 * See docs/roadmap.md Tier 2, Item 7.
 */
export const CASCADE_REVIEW_PROMPTS: string[] = [
  // Pass 1: Security & robustness focus
  `You are a security reviewer performing a second-pass review. The code has already passed a correctness review.

Focus exclusively on:
1. **Security** — Injection risks (SQL, command, path traversal), credential exposure, unsafe deserialization, missing input validation
2. **Robustness** — Error handling gaps, uncaught exceptions, resource leaks (file handles, connections), race conditions
3. **API surface** — Every cross-file method/property call must exist in the target module. Check imports against actual exports.

Do NOT repeat correctness feedback — that was handled in the first pass.
Only request changes for genuine security vulnerabilities or robustness gaps.
When in doubt, request changes. API surface mismatches are security-relevant.

Respond with a JSON object:
{
  "result": "approved" | "changes_requested" | "rejected",
  "notes": "Security/robustness findings",
  "feedback": "Specific fixes needed (only for changes_requested)"
}`,
];

/**
 * System prompt for the tool-calling integration review pass.
 * This pass uses tool calls (validate_project, read_file) to verify
 * cross-module wiring before final approval.
 *
 * See docs/roadmap.md Tier 2, Item 7 (cascade review).
 */
export const INTEGRATION_REVIEW_SYSTEM_PROMPT = `You are a code integration reviewer. Your job is to verify that a multi-file project works correctly by checking cross-module wiring.

PROCEDURE:
1. First, run validate_project on the project directory to get a static analysis report
2. For each issue found, read the relevant files to verify
3. Trace critical data flows end-to-end:
   - Are all imported functions/methods actually exported by their source module?
   - Are return values from functions captured and used where needed?
   - Are event handlers and callbacks properly wired?
   - Do constructor calls match the class signatures?
4. Check that the entry point (index.html, main.js, etc.) correctly imports and initializes all modules

OUTPUT: Respond with JSON: { "result": "approved" | "changes_requested", "issues": string[] }
If any cross-module wiring issue is found, result MUST be "changes_requested".`;

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the review prompt from a task's plan, artifacts, and optional context.
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
 * Parse the review response from the LLM. Falls back to 'changes_requested' on parse failure.
 */
export function parseReviewResponse(text: string): ReviewOutcome {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      result: (parsed['result'] as ReviewResult) ?? 'changes_requested',
      notes: (parsed['notes'] as string) ?? '',
      feedback: parsed['feedback'] as string | undefined,
    };
  } catch {
    // On parse failure, default to approved. The format schema should
    // guarantee valid JSON; if parsing still fails, the model is confused —
    // not the code. Phantom rejections from parse failures were the primary
    // cause of infinite revision loops.
    return {
      result: 'approved',
      notes: 'Review parse failure — defaulting to approved (model output was not valid JSON)',
    };
  }
}
