import { SENSITIVE_PATTERNS } from './patterns.js';

const SECRET_LIKE_PATTERNS: RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b(?:sk|pk|rk|ak)-[a-z0-9]{10,}\b/gi,
  /\bapi[_-]?key\s*[:=]\s*['\"]?[a-z0-9\-\._~\+\/]{8,}['\"]?/gi,
  /\bbearer\s+[a-z0-9\-\._~\+\/]+=*/gi
];

function toGlobal(pattern: RegExp): RegExp {
  if (pattern.flags.includes('g')) {
    return pattern;
  }

  return new RegExp(pattern.source, `${pattern.flags}g`);
}

export function redactSensitiveText(text: string): string {
  let redacted = text;

  for (const categoryPatterns of Object.values(SENSITIVE_PATTERNS)) {
    for (const pattern of categoryPatterns) {
      redacted = redacted.replace(toGlobal(pattern), '[REDACTED]');
    }
  }

  for (const pattern of SECRET_LIKE_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }

  return redacted;
}
