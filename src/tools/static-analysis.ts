/**
 * Static Analysis Utilities
 *
 * Extracted from deep-loop.ts to enable reuse as a standalone tool.
 * Provides cross-file API validation: import binding extraction,
 * member access detection, API surface extraction, and project-wide
 * consistency checks.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Binding entry: a local variable name mapped to the source file it was imported from. */
export interface ImportBinding {
  localName: string;
  source: string;
  isDefault: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Import / Export Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse import statements and map each local binding name to the source file path.
 * Only returns relative imports (starting with . or /).
 */
export function extractImportBindings(content: string): ImportBinding[] {
  const bindings: ImportBinding[] = [];

  // Strip comments to avoid false positives
  const stripped = content
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // Combined default + named: import Foo, { A, B } from './bar.js'
  for (const m of stripped.matchAll(
    /\bimport\s+(\w+)\s*,\s*\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]/g,
  )) {
    const source = m[3]!;
    bindings.push({ localName: m[1]!, source, isDefault: true });
    for (const name of m[2]!.split(',')) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+as\s+/);
      const local = (parts.length > 1 ? parts[1] : parts[0])!.trim();
      if (local) bindings.push({ localName: local, source, isDefault: false });
    }
  }

  // Default import: import Foo from './bar.js'
  // Must NOT match combined imports (already handled above)
  for (const m of stripped.matchAll(
    /\bimport\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
  )) {
    // Skip if this was already captured as a combined import
    const alreadyCaptured = bindings.some(
      (b) => b.localName === m[1]! && b.source === m[2]!,
    );
    if (!alreadyCaptured) {
      bindings.push({ localName: m[1]!, source: m[2]!, isDefault: true });
    }
  }

  // Named imports: import { A, B as C } from './config.js'
  // Must NOT match combined imports
  for (const m of stripped.matchAll(
    /\bimport\s*\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]/g,
  )) {
    const source = m[2]!;
    // Skip if already captured from combined
    const existingForSource = bindings.filter((b) => b.source === source && !b.isDefault);
    if (existingForSource.length > 0) continue;

    for (const name of m[1]!.split(',')) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+as\s+/);
      const local = (parts.length > 1 ? parts[1] : parts[0])!.trim();
      if (local) bindings.push({ localName: local, source, isDefault: false });
    }
  }

  // Namespace import: import * as Foo from './bar.js'
  for (const m of stripped.matchAll(
    /\bimport\s*\*\s*as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
  )) {
    bindings.push({ localName: m[1]!, source: m[2]!, isDefault: false });
  }

  // Only keep relative imports
  return bindings.filter((b) => b.source.startsWith('.') || b.source.startsWith('/'));
}

/**
 * Find all `identifier.memberName` patterns in file content.
 * Returns deduplicated member names.
 */
export function extractMemberAccesses(content: string, identifier: string): string[] {
  const members = new Set<string>();

  // Strip comments
  const stripped = content
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\.(\\w+)`, 'g');
  for (const m of stripped.matchAll(regex)) {
    members.add(m[1]!);
  }
  return [...members];
}

// ─────────────────────────────────────────────────────────────────────────────
// API Surface Extraction
// ─────────────────────────────────────────────────────────────────────────────

/** Keywords that look like method definitions but aren't. */
const METHOD_EXCLUDE = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'constructor',
  'return', 'throw', 'new', 'typeof', 'delete', 'void',
]);

/**
 * Extract the publicly-accessible API surface from a module's source code.
 * Returns a set of method/property/function names.
 */
export function extractAPISurface(content: string): Set<string> {
  const api = new Set<string>();

  // Strip comments
  const stripped = content
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // Exported functions: export (default )?(async )?function name(
  for (const m of stripped.matchAll(
    /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g,
  )) {
    api.add(m[1]!);
  }

  // Exported variables: export (const|let|var) name
  for (const m of stripped.matchAll(
    /\bexport\s+(?:const|let|var)\s+(\w+)/g,
  )) {
    api.add(m[1]!);
  }

  // Re-exports: export { A, B }
  for (const m of stripped.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const name of m[1]!.split(',')) {
      const trimmed = name.trim().split(/\s+as\s+/);
      const exported = (trimmed.length > 1 ? trimmed[1] : trimmed[0])!.trim();
      if (exported) api.add(exported);
    }
  }

  // Class methods — find class bodies and extract method definitions
  // Track brace depth to isolate class body
  const classStarts = [...stripped.matchAll(/\bclass\s+\w+[^{]*\{/g)];
  for (const classMatch of classStarts) {
    const startIdx = classMatch.index! + classMatch[0].length;
    let depth = 1;
    let classEnd = startIdx;
    for (let i = startIdx; i < stripped.length && depth > 0; i++) {
      if (stripped[i] === '{') depth++;
      else if (stripped[i] === '}') {
        depth--;
        if (depth === 0) classEnd = i;
      }
    }

    const classBody = stripped.slice(startIdx, classEnd);

    // Method definitions at class body level (depth 0 within class)
    // Match: methodName( or async methodName(
    for (const m of classBody.matchAll(
      /^\s+(?:async\s+)?(\w+)\s*\(/gm,
    )) {
      const name = m[1]!;
      if (!METHOD_EXCLUDE.has(name)) {
        api.add(name);
      }
    }

    // Getters and setters: get name( / set name(
    for (const m of classBody.matchAll(/^\s+(?:get|set)\s+(\w+)\s*\(/gm)) {
      api.add(m[1]!);
    }
  }

  // Default export of instantiated class: export default new ClassName()
  // The API is the class's methods — already captured above if class is in same file
  for (const m of stripped.matchAll(
    /\bexport\s+default\s+new\s+(\w+)/g,
  )) {
    // Class methods already captured — just note the class name for reference
    api.add(m[1]!);
  }

  return api;
}

/**
 * For config-like modules, extract top-level property keys from an object literal
 * assigned to the given variable name.
 * e.g., `export const ENEMIES = { baseSpeed: 50, rows: 5 }` -> ['baseSpeed', 'rows']
 */
export function extractObjectPropertyNames(content: string, varName: string): string[] {
  // Strip comments
  const stripped = content
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignMatch = stripped.match(
    new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=\\s*\\{`),
  );
  if (!assignMatch) return [];

  const startIdx = assignMatch.index! + assignMatch[0].length - 1; // position of '{'

  // Find balanced closing brace
  let depth = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }

  if (endIdx <= startIdx) return [];

  const body = stripped.slice(startIdx + 1, endIdx);

  // Extract top-level property keys (only lines at depth 0 within this body)
  // We need to track nested braces to only get top-level keys
  const keys: string[] = [];
  let innerDepth = 0;
  for (const line of body.split('\n')) {
    // Extract keys BEFORE counting braces so that `player: {` is captured at depth 0
    // but `width: 40` inside the nested object (depth 1) is skipped
    if (innerDepth === 0) {
      const keyMatch = line.match(/^\s*(\w+)\s*:/);
      if (keyMatch) {
        keys.push(keyMatch[1]!);
      }
    }

    // Count braces on this line for depth tracking (after key extraction)
    for (const ch of line) {
      if (ch === '{' || ch === '[' || ch === '(') innerDepth++;
      else if (ch === '}' || ch === ']' || ch === ')') innerDepth--;
    }
  }

  return keys;
}

// ─────────────────────────────────────────────────────────────────────────────
// Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a relative import path against the importing file's directory.
 * E.g., resolveImportPath('projects/game/js/main.js', './config.js')
 *       -> 'projects/game/js/config.js'
 */
export function resolveImportPath(fromFile: string, importTarget: string): string {
  const fromParts = fromFile.split('/');
  fromParts.pop(); // remove filename, keep directory
  const targetParts = importTarget.split('/');

  const resolved = [...fromParts];
  for (const part of targetParts) {
    if (part === '.') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join('/');
}

// ─────────────────────────────────────────────────────────────────────────────
// Project-Level Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate cross-file API consistency for a set of files.
 * For each file, extracts imports and their bindings, then checks:
 *   1. The target file exists in the map
 *   2. The imported symbol is exported by the target file
 *   3. Method calls on the imported object match the target's API surface
 * Returns an array of issue descriptions.
 */
export function validateProjectAPIs(files: Map<string, string>): string[] {
  const issues: string[] = [];

  for (const [filePath, content] of files) {
    const bindings = extractImportBindings(content);

    for (const binding of bindings) {
      // Resolve the source path
      const resolvedSource = resolveImportPath(filePath, binding.source);

      // Find source content (try exact path, then basename match)
      let sourceContent = files.get(resolvedSource);
      if (!sourceContent) {
        const targetBaseName = resolvedSource.split('/').pop() ?? '';
        for (const [p, c] of files) {
          if (p.endsWith(`/${targetBaseName}`) || p === targetBaseName) {
            sourceContent = c;
            break;
          }
        }
      }

      if (!sourceContent) {
        // Target file not in project map — report as missing
        const fileBaseName = filePath.split('/').pop() ?? filePath;
        issues.push(
          `${fileBaseName}: imports from '${binding.source}' but target file not found in project`,
        );
        continue;
      }

      // Extract member accesses on this binding
      const memberAccesses = extractMemberAccesses(content, binding.localName);
      if (memberAccesses.length === 0) continue;

      // Build the available API surface
      const apiSurface = extractAPISurface(sourceContent);

      // For named imports, also check object property names
      const objProps = extractObjectPropertyNames(sourceContent, binding.localName);
      const allAvailable = new Set(apiSurface);
      for (const prop of objProps) {
        allAvailable.add(prop);
      }

      // Cross-reference: find missing members
      const missing = memberAccesses.filter((m) => !allAvailable.has(m));
      if (missing.length > 0) {
        const sourceBaseName = resolvedSource.split('/').pop() ?? resolvedSource;
        const fileBaseName = filePath.split('/').pop() ?? filePath;
        const availableList = [...allAvailable].sort().slice(0, 20).join(', ');
        for (const m of missing) {
          issues.push(
            `${fileBaseName}: calls ${binding.localName}.${m}() but '${m}' not found in ${sourceBaseName} (available: ${availableList})`,
          );
        }
      }
    }
  }

  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Uncaptured Return Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect function/method calls whose return values are not captured.
 * Flags patterns like `obj.method()` on its own line where `method`
 * has return statements in its definition.
 *
 * Classic bug pattern: `this.fireRandomBullet();` where `fireRandomBullet()`
 * returns a bullet object but the return is ignored.
 */
export function detectUncapturedReturns(files: Map<string, string>): string[] {
  const issues: string[] = [];

  // First pass: build a map of function names to whether they have non-void returns
  const functionsWithReturns = new Set<string>();

  for (const [, content] of files) {
    const stripped = content
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    // Find all function/method definitions and check for return statements with values
    // Match: function name(...) { ... } or name(...) { ... } (class methods)
    const funcPatterns = [
      // Standalone/exported functions: (export )?(async )?function name(
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/g,
      // Class methods: (async )?name(
      /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/gm,
    ];

    for (const pattern of funcPatterns) {
      for (const match of stripped.matchAll(pattern)) {
        const funcName = match[1]!;
        const startIdx = match.index! + match[0].length;

        // Find the matching closing brace for this function body
        let depth = 1;
        let bodyEnd = startIdx;
        for (let i = startIdx; i < stripped.length && depth > 0; i++) {
          if (stripped[i] === '{') depth++;
          else if (stripped[i] === '}') {
            depth--;
            if (depth === 0) {
              bodyEnd = i;
            }
          }
        }

        const body = stripped.slice(startIdx, bodyEnd);

        // Check for return statements that return a value (not bare `return;`)
        // Match: return <something>; but not return; or return\n
        const hasValueReturn = /\breturn\s+[^;\s]/.test(body);

        if (hasValueReturn) {
          functionsWithReturns.add(funcName);
        }
      }
    }
  }

  if (functionsWithReturns.size === 0) return issues;

  // Second pass: find standalone expression statements that call these functions
  for (const [filePath, content] of files) {
    const fileBaseName = filePath.split('/').pop() ?? filePath;
    const stripped = content
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    const lines = stripped.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();

      // Skip blank lines, declarations, assignments, returns, conditionals, etc.
      if (!line || line.startsWith('//') || line.startsWith('*')) continue;
      if (/^(?:const|let|var|return|if|else|for|while|switch|case|throw|export|import|class|function)\b/.test(line)) continue;
      // Skip assignments: something = expr
      if (/^\w[\w.]*\s*[+\-*/%]?=\s/.test(line)) continue;
      // Skip chained assignments: this.x = expr
      if (/^this\.\w+\s*=\s/.test(line)) continue;

      // Match standalone calls: identifier.method(...); or identifier(...);
      // Pattern: optional `this.` or `identifier.`, then methodName(...)
      const callMatch = line.match(
        /^(?:(?:this|[\w$]+)\.)*(\w+)\s*\([^)]*\)\s*;?\s*$/,
      );
      if (!callMatch) continue;

      const calledName = callMatch[1]!;

      // Skip common void-by-convention methods
      const voidConventions = new Set([
        'addEventListener', 'removeEventListener', 'preventDefault',
        'stopPropagation', 'console', 'log', 'warn', 'error', 'info',
        'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath',
        'moveTo', 'lineTo', 'arc', 'fill', 'stroke', 'save', 'restore',
        'translate', 'rotate', 'scale', 'setTransform', 'resetTransform',
        'drawImage', 'fillText', 'strokeText', 'clearTimeout', 'clearInterval',
        'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse',
        'forEach', 'set', 'delete', 'clear', 'add', 'emit', 'on', 'off',
        'resolve', 'reject', 'then', 'catch', 'finally',
      ]);
      if (voidConventions.has(calledName)) continue;

      if (functionsWithReturns.has(calledName)) {
        issues.push(
          `${fileBaseName}:${i + 1}: return value of '${calledName}()' is not captured (function returns a value)`,
        );
      }
    }
  }

  return issues;
}
