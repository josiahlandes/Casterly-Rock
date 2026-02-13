/**
 * Approval Response Matcher (ISSUE-004)
 *
 * Parses iMessage text to determine if it's an approval response.
 * Follows the same pattern as src/imessage/message-utils.ts:isAcknowledgementMessage.
 */

export type ApprovalAnswer = 'approve' | 'deny' | 'not_an_answer';

const APPROVE_PATTERN =
  /^(yes|y|yep|yeah|yup|approve|approved|go ahead|do it|proceed|go for it|ok|okay|sure)$/;

const DENY_PATTERN =
  /^(no|n|nah|nope|deny|denied|cancel|abort|stop|don't|dont|reject)$/;

const BLOCKLIST = ['?', 'can you', 'could you', 'please', 'but', 'also', 'however'];

/**
 * Classify a message as an approval response.
 *
 * Returns 'approve', 'deny', or 'not_an_answer'.
 * Messages over 80 characters are never treated as answers (avoids false positives).
 */
export function parseApprovalResponse(text: string): ApprovalAnswer {
  const cleaned = text.trim();
  if (!cleaned || cleaned.length > 80) {
    return 'not_an_answer';
  }

  const lower = cleaned.toLowerCase();

  // Check blocklist first — these indicate the message is conversational, not a yes/no
  if (BLOCKLIST.some((token) => lower.includes(token))) {
    return 'not_an_answer';
  }

  // Strip trailing punctuation for matching
  const stripped = lower.replace(/[!.,]+$/, '');

  if (APPROVE_PATTERN.test(stripped)) {
    return 'approve';
  }

  if (DENY_PATTERN.test(stripped)) {
    return 'deny';
  }

  return 'not_an_answer';
}
