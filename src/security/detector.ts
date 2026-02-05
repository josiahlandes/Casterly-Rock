import { matchSensitiveCategories } from './patterns.js';
import type { SensitiveCategory } from './patterns.js';

export interface SensitiveDetectionResult {
  isSensitive: boolean;
  categories: SensitiveCategory[];
  reasons: string[];
}

export interface SensitiveDetectionOptions {
  alwaysLocalCategories: SensitiveCategory[];
}

export function detectSensitiveContent(
  text: string,
  options: SensitiveDetectionOptions
): SensitiveDetectionResult {
  const patternMatches = matchSensitiveCategories(text);
  const alwaysLocalMatches = patternMatches.filter((category) =>
    options.alwaysLocalCategories.includes(category)
  );

  const reasons: string[] = [];

  if (alwaysLocalMatches.length > 0) {
    reasons.push(
      `Matched always-local sensitive categories: ${alwaysLocalMatches.join(', ')}`
    );
  }

  if (patternMatches.length > 0 && alwaysLocalMatches.length === 0) {
    reasons.push(`Matched sensitive patterns: ${patternMatches.join(', ')}`);
  }

  return {
    isSensitive: patternMatches.length > 0,
    categories: patternMatches,
    reasons
  };
}
