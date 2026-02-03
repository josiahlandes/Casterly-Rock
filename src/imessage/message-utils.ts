const ACKNOWLEDGEMENT_PATTERN =
  /^(thanks|thank you|thx|awesome|great|cool|nice|got it|ok|okay|sounds good|appreciate( it)?|sweet|perfect|all good|cheers)([!.,]|\s|$)/i;

const ACKNOWLEDGEMENT_BLOCKLIST = [
  'can you',
  'could you',
  'would you',
  'please',
  'also',
  'but',
  'however',
  'next',
  'another',
  'one more'
];

export function isAcknowledgementMessage(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (cleaned.length > 80) return false;
  const lower = cleaned.toLowerCase();

  if (lower.includes('?')) return false;
  if (!ACKNOWLEDGEMENT_PATTERN.test(lower)) return false;

  if (ACKNOWLEDGEMENT_BLOCKLIST.some((token) => lower.includes(token))) {
    return false;
  }

  return true;
}
