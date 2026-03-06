/**
 * Lenient Tool Argument Repair
 *
 * Local Qwen models via Ollama frequently emit malformed JSON in tool call
 * arguments: trailing commas, unquoted keys, single-quoted strings, truncated
 * objects, etc. Rather than wasting an entire DeepLoop turn on a syntax error,
 * we apply a 3-tier fallback:
 *
 *   Tier 1 — Strict:    JSON.parse() as-is
 *   Tier 2 — Auto-repair: Fix common JSON defects and retry
 *   Tier 3 — Heuristic:  Extract key-value pairs via regex
 *
 * Privacy: This operates on tool argument strings only — no user content
 * is logged or transmitted.
 */

import type { ToolInputSchema } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RepairResult {
  /** The parsed arguments object */
  parsed: Record<string, unknown>;

  /** Which tier succeeded: 'strict' | 'auto-repair' | 'heuristic' | 'failed' */
  tier: 'strict' | 'auto-repair' | 'heuristic' | 'failed';

  /** Whether any repairs were applied */
  repaired: boolean;

  /** Description of what was fixed (empty if strict parse succeeded) */
  repairs: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1: Strict JSON parse
// ─────────────────────────────────────────────────────────────────────────────

function tryStrictParse(raw: string): Record<string, unknown> | null {
  try {
    const result = JSON.parse(raw);
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2: Auto-repair common JSON defects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to fix common JSON defects emitted by local models.
 * Returns [repairedString, listOfRepairsApplied] or null if unfixable.
 */
function autoRepair(raw: string): { fixed: string; repairs: string[] } {
  let s = raw.trim();
  const repairs: string[] = [];

  // 1. Strip markdown code fences that models sometimes wrap args in
  const fenceMatch = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch?.[1]) {
    s = fenceMatch[1].trim();
    repairs.push('stripped markdown code fences');
  }

  // 2. Wrap bare content in braces if missing
  if (!s.startsWith('{') && !s.startsWith('[')) {
    s = `{${s}}`;
    repairs.push('added missing outer braces');
  }

  // 3. Replace single quotes with double quotes
  // Only apply if the string uses single quotes as JSON delimiters
  // (i.e., has patterns like {'key': 'value'} rather than legitimate
  // apostrophes inside double-quoted strings)
  if (/[{,]\s*'/.test(s) || /:\s*'/.test(s)) {
    // Replace all single quotes that act as JSON string delimiters.
    // Walk the string and swap ' for " when not inside a double-quoted string.
    let singleQuoteFixed = '';
    let inDouble = false;
    let prevEscaped = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (prevEscaped) { singleQuoteFixed += ch; prevEscaped = false; continue; }
      if (ch === '\\') { singleQuoteFixed += ch; prevEscaped = true; continue; }
      if (ch === '"') { inDouble = !inDouble; singleQuoteFixed += ch; continue; }
      if (ch === "'" && !inDouble) { singleQuoteFixed += '"'; continue; }
      singleQuoteFixed += ch;
    }
    if (singleQuoteFixed !== s) {
      s = singleQuoteFixed;
      repairs.push('replaced single quotes with double quotes');
    }
  }

  // 4. Quote unquoted keys: key: value → "key": value
  // Use a capture group for the delimiter instead of variable-length lookbehind
  const unquotedKeyFixed = s.replace(
    /([\{,]\s*)([a-zA-Z_]\w*)\s*:/g,
    '$1"$2":'
  );
  if (unquotedKeyFixed !== s) {
    s = unquotedKeyFixed;
    repairs.push('quoted unquoted keys');
  }

  // 5. Remove trailing commas before } or ]
  const trailingCommaFixed = s.replace(/,\s*([}\]])/g, '$1');
  if (trailingCommaFixed !== s) {
    s = trailingCommaFixed;
    repairs.push('removed trailing commas');
  }

  // 6. Fix truncated JSON — close unclosed braces/brackets
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') openBraces++;
    else if (ch === '}') openBraces--;
    else if (ch === '[') openBrackets++;
    else if (ch === ']') openBrackets--;
  }
  if (openBraces > 0 || openBrackets > 0) {
    // Remove any trailing comma/whitespace before closing
    s = s.replace(/,?\s*$/, '');
    s += ']'.repeat(Math.max(0, openBrackets));
    s += '}'.repeat(Math.max(0, openBraces));
    repairs.push('closed truncated braces/brackets');
  }

  // 7. Replace Python-style True/False/None
  const pythonFixed = s
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null');
  if (pythonFixed !== s) {
    s = pythonFixed;
    repairs.push('fixed Python-style booleans/null');
  }

  return { fixed: s, repairs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3: Heuristic key-value extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Last-resort extraction: use the schema to find expected keys and
 * pull their values from the raw string via regex.
 */
function heuristicExtract(
  raw: string,
  schema?: ToolInputSchema,
): Record<string, unknown> | null {
  if (!schema) return null;

  const result: Record<string, unknown> = {};
  let foundAny = false;

  for (const [key, prop] of Object.entries(schema.properties)) {
    // Try to find "key": value or key: value patterns
    const patterns = [
      // "key": "value" or "key": 'value'
      new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']([^"']*?)["']`, 'i'),
      // "key": 123 or key: true/false/null
      new RegExp(`["']?${key}["']?\\s*[:=]\\s*([\\d.]+|true|false|null)\\b`, 'i'),
      // "key": [...] — grab the array
      new RegExp(`["']?${key}["']?\\s*[:=]\\s*(\\[[^\\]]*\\])`, 'i'),
    ];

    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match?.[1] !== undefined) {
        let value: unknown = match[1];

        // Coerce based on schema type
        if (prop.type === 'number' || prop.type === 'integer') {
          const num = Number(value);
          if (!isNaN(num)) value = num;
        } else if (prop.type === 'boolean') {
          value = value === 'true';
        } else if (prop.type === 'array') {
          try { value = JSON.parse(value as string); } catch { /* keep string */ }
        } else if (value === 'null') {
          value = null;
        }

        result[key] = value;
        foundAny = true;
        break;
      }
    }
  }

  return foundAny ? result : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse and repair tool call arguments with 3-tier fallback.
 *
 * @param raw - The raw arguments string from the LLM
 * @param schema - Optional tool input schema for heuristic extraction
 * @returns RepairResult with parsed args and metadata about what was fixed
 */
export function repairToolArgs(
  raw: string,
  schema?: ToolInputSchema,
): RepairResult {
  // Tier 1: Strict parse
  const strict = tryStrictParse(raw);
  if (strict) {
    return { parsed: strict, tier: 'strict', repaired: false, repairs: [] };
  }

  // Tier 2: Auto-repair and retry
  const { fixed, repairs } = autoRepair(raw);
  const repaired = tryStrictParse(fixed);
  if (repaired) {
    return { parsed: repaired, tier: 'auto-repair', repaired: true, repairs };
  }

  // Tier 3: Heuristic extraction using schema
  const heuristic = heuristicExtract(raw, schema);
  if (heuristic) {
    return {
      parsed: heuristic,
      tier: 'heuristic',
      repaired: true,
      repairs: [...repairs, 'fell back to heuristic key-value extraction'],
    };
  }

  // All tiers failed — return raw string as fallback
  return {
    parsed: { raw },
    tier: 'failed',
    repaired: false,
    repairs: [...repairs, 'all parse tiers failed'],
  };
}

/**
 * Convenience: repair tool args that are already partially parsed.
 * Handles the case where the provider gave us { raw: "..." } from
 * a failed JSON.parse().
 */
export function repairToolCallInput(
  input: Record<string, unknown>,
  schema?: ToolInputSchema,
): { input: Record<string, unknown>; result: RepairResult | null } {
  // If input has real keys (not just 'raw'), it was already parsed fine
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== 'raw' || typeof input['raw'] !== 'string') {
    return { input, result: null };
  }

  // We have a { raw: "..." } fallback — try to repair
  const result = repairToolArgs(input['raw'] as string, schema);
  if (result.tier !== 'failed') {
    return { input: result.parsed, result };
  }

  return { input, result };
}
