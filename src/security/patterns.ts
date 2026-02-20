/**
 * Sensitive Content Patterns
 *
 * Patterns for detecting sensitive content that should be redacted
 * or handled with extra care.
 */

export type SensitiveCategory =
  | 'calendar'
  | 'finances'
  | 'voice_memos'
  | 'health'
  | 'credentials'
  | 'documents'
  | 'contacts'
  | 'location';

export const SENSITIVE_PATTERNS: Record<SensitiveCategory, RegExp[]> = {
  calendar: [/\bmy calendar\b/i, /\bschedule\b/i, /\bappointment\b/i],
  finances: [
    /\b\d{3}-\d{2}-\d{4}\b/, // US SSN-like pattern
    /credit card/i,
    /bank account/i,
    /routing number/i,
    /transaction/i,
  ],
  voice_memos: [/voice memo/i, /journal/i, /private note/i, /personal note/i],
  health: [/diagnosis/i, /prescription/i, /medical/i, /health record/i],
  credentials: [/password/i, /api[_-]?key/i, /bearer\s+[a-z0-9\-\._~\+\/]+=*/i],
  documents: [/contract/i, /confidential/i, /private document/i, /nda/i],
  contacts: [/my contact/i, /phone number/i, /address book/i, /my friend/i],
  location: [
    /\bmy location\b/i,
    /\bgps\b/i,
    /\bcoordinates?\b/i,
    /\bmy address\b/i,
    /\bhome address\b/i,
    /\bwork address\b/i,
    /\bwhere i (am|live|work)\b/i,
    /\b\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}\b/, // lat,lon pair
  ],
};

export function matchSensitiveCategories(text: string): SensitiveCategory[] {
  const matches: SensitiveCategory[] = [];

  for (const [category, patterns] of Object.entries(SENSITIVE_PATTERNS) as [
    SensitiveCategory,
    RegExp[]
  ][]) {
    if (patterns.some((pattern) => pattern.test(text))) {
      matches.push(category);
    }
  }

  return matches;
}
