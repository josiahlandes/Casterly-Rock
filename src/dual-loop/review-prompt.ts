/**
 * Review Prompt — System prompts for FastLoop code review.
 *
 * The FastLoop (35B-A3B) reviews diffs produced by DeepLoop before
 * changes are committed. The review is advisory — DeepLoop can override
 * with explanation, but cannot ignore.
 *
 * See docs/dual-loop-architecture.md Section 5.4 and Section 4 (Phase 4).
 */

import type { TaskArtifact, ReviewResult } from './task-board-types.js';

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

Respond with a JSON object:
{
  "result": "approved" | "changes_requested" | "rejected",
  "notes": "Summary of what you found",
  "feedback": "Specific changes needed (only for changes_requested)"
}

When in doubt, approve. The deep thinker has more context than you.
Only request changes for clear correctness or security issues.`;

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the review prompt from a task's plan and artifacts.
 */
export function buildReviewPrompt(params: {
  plan: string;
  artifacts: TaskArtifact[];
}): string {
  const parts: string[] = [
    '## Plan\n',
    params.plan,
    '\n\n## Artifacts\n',
  ];

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
