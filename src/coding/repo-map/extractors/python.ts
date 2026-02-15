/**
 * Python Symbol Extractor
 *
 * Extracts symbols and references from Python files using regex patterns.
 * Handles functions, classes, methods, module-level constants, and imports.
 */

import type { Symbol, SymbolKind } from '../types.js';

export interface ExtractionResult {
  symbols: Symbol[];
  references: string[];
}

/**
 * Extract symbols and references from Python content.
 */
export function extractPython(content: string): ExtractionResult {
  const lines = content.split('\n');
  const symbols: Symbol[] = [];
  const references: string[] = [];

  // Extract imports
  references.push(...extractImports(content));

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (line === undefined) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const description = extractPrecedingDocstring(lines, lineNum);

    // Module-level function: def name(...)
    const funcMatch = /^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/.exec(line);
    if (funcMatch) {
      const name = funcMatch[2] ?? '';
      const isPrivate = name.startsWith('_') && !name.startsWith('__');
      symbols.push({
        name,
        kind: 'function',
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: !isPrivate,
        ...(description ? { description } : {}),
      });
      continue;
    }

    // Class: class Name(...)
    const classMatch = /^class\s+(\w+)\s*(?:\(([^)]*)\))?/.exec(line);
    if (classMatch) {
      const name = classMatch[1] ?? '';
      const isPrivate = name.startsWith('_') && !name.startsWith('__');
      symbols.push({
        name,
        kind: 'class',
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: !isPrivate,
        ...(description ? { description } : {}),
      });
      continue;
    }

    // Method inside class (indented def)
    const methodMatch = /^(\s+)(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/.exec(line);
    if (methodMatch && methodMatch[1] && methodMatch[1].length > 0) {
      const name = methodMatch[3] ?? '';
      const isPrivate = name.startsWith('_') && !name.startsWith('__');
      const isDunder = name.startsWith('__') && name.endsWith('__');
      symbols.push({
        name,
        kind: 'method',
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: isDunder || !isPrivate,
        ...(description ? { description } : {}),
      });
      continue;
    }

    // Module-level constant: NAME = ... (ALL_CAPS at top level, no indent)
    const constMatch = /^([A-Z][A-Z0-9_]+)\s*(?::\s*[^=]+)?\s*=/.exec(line);
    if (constMatch) {
      const name = constMatch[1] ?? '';
      symbols.push({
        name,
        kind: 'const',
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: true,
        ...(description ? { description } : {}),
      });
      continue;
    }
  }

  return { symbols, references };
}

/**
 * Extract import references from Python content.
 */
function extractImports(content: string): string[] {
  const refs: string[] = [];

  // import module / from module import ...
  const importPattern = /^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
  let match;
  while ((match = importPattern.exec(content)) !== null) {
    const modulePath = match[1] ?? match[2];
    if (modulePath && isLocalImport(modulePath)) {
      refs.push(moduleToPath(modulePath));
    }
  }

  return [...new Set(refs)];
}

/**
 * Check if a Python import is local (relative).
 */
function isLocalImport(modulePath: string): boolean {
  return modulePath.startsWith('.');
}

/**
 * Convert a dotted Python module path to a file path.
 */
function moduleToPath(modulePath: string): string {
  return modulePath.replace(/\./g, '/') + '.py';
}

/**
 * Extract the docstring preceding a definition.
 */
function extractPrecedingDocstring(lines: string[], lineNum: number): string | undefined {
  // Look at the line after the definition for inline docstring
  const nextIdx = lineNum + 1;
  if (nextIdx >= lines.length) return undefined;

  const nextLine = lines[nextIdx];
  if (nextLine === undefined) return undefined;
  const trimmed = nextLine.trim();

  // Single-line docstring: """...""" or '''...'''
  const singleMatch = /^(?:"""|''')(.+?)(?:"""|''')/.exec(trimmed);
  if (singleMatch) {
    return singleMatch[1]?.trim();
  }

  // Multi-line docstring start: """ or '''
  if (trimmed === '"""' || trimmed === "'''") {
    const quote = trimmed;
    const docLines: string[] = [];
    for (let i = nextIdx + 1; i < lines.length; i++) {
      const dl = lines[i];
      if (dl === undefined) break;
      if (dl.trim().endsWith(quote)) {
        const last = dl.trim().replace(new RegExp(`${quote}$`), '').trim();
        if (last) docLines.push(last);
        break;
      }
      const cleaned = dl.trim();
      if (cleaned) docLines.push(cleaned);
    }
    return docLines.length > 0 ? docLines[0] : undefined;
  }

  return undefined;
}

/**
 * Clean a Python signature for display.
 */
function cleanSignature(line: string): string {
  return line
    .replace(/:\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Get file extensions for Python.
 */
export function getPythonExtensions(): string[] {
  return ['.py', '.pyi'];
}
