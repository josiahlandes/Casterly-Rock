/**
 * Input Guard — Physical pre-LLM filtering for inbound iMessages
 *
 * Deterministic guards that run before any message reaches the LLM.
 * These are "physical" checks — regex, size limits, rate limits —
 * not LLM-based reasoning that can be distorted by adversarial input.
 */

import { detectSensitiveContent } from '../security/detector.js';
import type { SensitiveCategory } from '../security/patterns.js';

// ─── Configuration ───────────────────────────────────────────────────────────

export const INPUT_GUARD_CONFIG = {
  MAX_MESSAGE_LENGTH: 30_000,
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_MAX_MESSAGES: 20,
} as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface InputGuardResult {
  allowed: boolean;
  reason?: string;
  sanitized?: string;
  warnings?: string[];
}

// ─── Prompt Injection Patterns ───────────────────────────────────────────────

interface InjectionPattern {
  pattern: RegExp;
  label: string;
}

const INJECTION_PATTERNS: InjectionPattern[] = [
  {
    pattern: /\b(?:ignore|forget|disregard|override|bypass|skip)\b.{0,30}\b(?:previous|prior|above|all|earlier|original|initial)\b.{0,30}\b(?:instructions?|prompts?|rules?|directions?|guidelines?|constraints?)\b/i,
    label: 'instruction-override',
  },
  {
    pattern: /\b(?:you are now|you're now|from now on you are|act as if you are|pretend (?:you are|to be)|behave as|role[- ]?play as)\b/i,
    label: 'role-hijack',
  },
  {
    pattern: /\b(?:enter|enable|activate|switch to|engage)\b.{0,20}\b(?:developer|dev|debug|admin|root|sudo|god|jailbreak|unrestricted|unfiltered|DAN)\b.{0,10}\b(?:mode|access)?\b/i,
    label: 'mode-switch',
  },
  {
    pattern: /\b(?:reveal|show|print|output|display|dump|leak|expose|extract)\b.{0,20}\b(?:system prompt|system message|hidden (?:prompt|instructions?)|internal (?:prompt|instructions?)|initial prompt|original prompt)\b/i,
    label: 'prompt-extraction',
  },
  {
    pattern: /\bDAN\b.{0,30}\b(?:mode|anything|now|enabled)\b/i,
    label: 'DAN-jailbreak',
  },
  {
    pattern: /\bdo\s+anything\s+now\b/i,
    label: 'DAN-jailbreak',
  },
  {
    pattern: /<\s*(?:system|SYSTEM)\s*>/,
    label: 'xml-system-tag',
  },
  {
    pattern: /\[\s*(?:SYSTEM|INST|SYS)\s*\]/,
    label: 'bracket-system-tag',
  },
  {
    pattern: /^#{1,3}\s*(?:SYSTEM|System Prompt|Instructions?)\s*$/m,
    label: 'markdown-system-heading',
  },
  {
    pattern: /(?=[A-Za-z0-9+/]{60,}={0,2})(?=[^\s]*[A-Z])(?=[^\s]*[a-z])(?=[^\s]*[0-9+/])[A-Za-z0-9+/]{60,}={0,2}/,
    label: 'base64-block',
  },
  {
    pattern: /(?:\\x[0-9a-fA-F]{2}){8,}/,
    label: 'hex-encoded-sequence',
  },
];

// ─── Rate Limiting State ─────────────────────────────────────────────────────

const rateLimitMap = new Map<string, number[]>();

export function resetRateLimits(): void {
  rateLimitMap.clear();
}

// ─── Control Character Sanitization ──────────────────────────────────────────

// Remove C0 control characters except \t (0x09), \n (0x0A), \r (0x0D)
// Also remove DEL (0x7F)
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function sanitizeControlChars(text: string): string {
  return text.replace(CONTROL_CHAR_RE, '');
}

// ─── Rate Limit Check ────────────────────────────────────────────────────────

function checkRateLimit(sender: string): boolean {
  const now = Date.now();
  const windowStart = now - INPUT_GUARD_CONFIG.RATE_LIMIT_WINDOW_MS;

  let timestamps = rateLimitMap.get(sender);
  if (!timestamps) {
    timestamps = [];
    rateLimitMap.set(sender, timestamps);
  }

  // Prune expired entries
  const validIdx = timestamps.findIndex((t) => t > windowStart);
  if (validIdx > 0) {
    timestamps.splice(0, validIdx);
  } else if (validIdx === -1) {
    timestamps.length = 0;
  }

  if (timestamps.length >= INPUT_GUARD_CONFIG.RATE_LIMIT_MAX_MESSAGES) {
    return false;
  }

  timestamps.push(now);
  return true;
}

// ─── Injection Detection ─────────────────────────────────────────────────────

function detectInjection(text: string): InjectionPattern | undefined {
  for (const entry of INJECTION_PATTERNS) {
    if (entry.pattern.test(text)) {
      return entry;
    }
  }
  return undefined;
}

// ─── Sensitive Content Warnings ──────────────────────────────────────────────

const ALL_SENSITIVE_CATEGORIES: SensitiveCategory[] = [
  'calendar', 'finances', 'voice_memos', 'health', 'credentials', 'documents', 'contacts', 'location',
];

function getSensitiveWarnings(text: string): string[] {
  const result = detectSensitiveContent(text, {
    alwaysLocalCategories: ALL_SENSITIVE_CATEGORIES,
  });
  return result.reasons;
}

// ─── Main Guard Function ─────────────────────────────────────────────────────

export function guardInboundMessage(text: string, sender: string): InputGuardResult {
  // 1. Size limit
  if (text.length > INPUT_GUARD_CONFIG.MAX_MESSAGE_LENGTH) {
    return {
      allowed: false,
      reason: `Message too large (${text.length} chars, max ${INPUT_GUARD_CONFIG.MAX_MESSAGE_LENGTH})`,
    };
  }

  // 2. Sanitize control characters
  const sanitized = sanitizeControlChars(text);

  // 3. Rate limiting
  if (!checkRateLimit(sender)) {
    return {
      allowed: false,
      reason: `Rate limit exceeded (max ${INPUT_GUARD_CONFIG.RATE_LIMIT_MAX_MESSAGES} messages per ${INPUT_GUARD_CONFIG.RATE_LIMIT_WINDOW_MS / 1000}s)`,
    };
  }

  // 4. Prompt injection detection
  const injection = detectInjection(sanitized);
  if (injection) {
    return {
      allowed: false,
      reason: `Prompt injection detected: ${injection.label}`,
    };
  }

  // 5. Sensitive content warnings (non-blocking)
  const warnings = getSensitiveWarnings(sanitized);

  const result: InputGuardResult = {
    allowed: true,
    sanitized,
  };

  if (warnings.length > 0) {
    result.warnings = warnings;
  }

  return result;
}
