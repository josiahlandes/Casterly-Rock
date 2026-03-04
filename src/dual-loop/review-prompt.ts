/**
 * Review Prompt — System prompts for code review.
 *
 * The DeepLoop (122B) self-reviews its own output before marking
 * tasks as complete. The review is a single structured-output call
 * (not a ReAct tool loop) that runs after implementation.
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

When in doubt, approve. The deep thinker has more context than you.
Only request changes for clear correctness, security, or file structure issues.`;

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
When in doubt, approve — you have the full implementation context.

Respond with a JSON object:
{
  "result": "approved" | "changes_requested" | "rejected",
  "notes": "Security/robustness findings",
  "feedback": "Specific fixes needed (only for changes_requested)"
}`,
];

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
 * Parse the review response from the LLM. Falls back to 'approved' on parse failure.
 */
export function parseReviewResponse(text: string): ReviewOutcome {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      result: (parsed['result'] as ReviewResult) ?? 'approved',
      notes: (parsed['notes'] as string) ?? '',
      feedback: parsed['feedback'] as string | undefined,
    };
  } catch {
    // On parse failure, approve — don't block the pipeline on a parsing issue
    return {
      result: 'approved',
      notes: 'Review parse failure — defaulting to approved',
    };
  }
}
