/**
 * Go Symbol Extractor
 *
 * Extracts symbols and references from Go files using regex patterns.
 * Handles functions, types (struct, interface), methods, and constants.
 */

import type { Symbol, SymbolKind } from '../types.js';

export interface ExtractionResult {
  symbols: Symbol[];
  references: string[];
}

/**
 * Extract symbols and references from Go content.
 */
export function extractGo(content: string): ExtractionResult {
  const lines = content.split('\n');
  const symbols: Symbol[] = [];
  const references: string[] = [];

  // Extract imports
  references.push(...extractImports(content));

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (line === undefined) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    const description = extractPrecedingComment(lines, lineNum);

    // Function: func Name(...)
    const funcMatch = /^func\s+(\w+)\s*(\([^)]*\))/.exec(line);
    if (funcMatch) {
      const name = funcMatch[1] ?? '';
      symbols.push({
        name,
        kind: 'function',
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: isExported(name),
        ...(description ? { description } : {}),
      });
      continue;
    }

    // Method: func (r *Receiver) Name(...)
    const methodMatch = /^func\s+\((\w+)\s+\*?(\w+)\)\s+(\w+)\s*(\([^)]*\))/.exec(line);
    if (methodMatch) {
      const name = methodMatch[3] ?? '';
      symbols.push({
        name,
        kind: 'method',
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: isExported(name),
        ...(description ? { description } : {}),
      });
      continue;
    }

    // Type definition: type Name struct/interface/...
    const typeMatch = /^type\s+(\w+)\s+(struct|interface)/.exec(line);
    if (typeMatch) {
      const name = typeMatch[1] ?? '';
      const typeKind = typeMatch[2] === 'interface' ? 'interface' : 'class';
      symbols.push({
        name,
        kind: typeKind as SymbolKind,
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: isExported(name),
        ...(description ? { description } : {}),
      });
      continue;
    }

    // Type alias: type Name = ... or type Name SomeType
    const typeAliasMatch = /^type\s+(\w+)\s+(?!=struct|interface)(\w+)/.exec(line);
    if (typeAliasMatch && !typeMatch) {
      const name = typeAliasMatch[1] ?? '';
      symbols.push({
        name,
        kind: 'type',
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: isExported(name),
        ...(description ? { description } : {}),
      });
      continue;
    }

    // Constant: const Name = ...
    const constMatch = /^const\s+(\w+)\s/.exec(line);
    if (constMatch) {
      const name = constMatch[1] ?? '';
      symbols.push({
        name,
        kind: 'const',
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: isExported(name),
        ...(description ? { description } : {}),
      });
      continue;
    }

    // Variable: var Name ...
    const varMatch = /^var\s+(\w+)\s/.exec(line);
    if (varMatch) {
      const name = varMatch[1] ?? '';
      symbols.push({
        name,
        kind: 'var' as SymbolKind,
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: isExported(name),
        ...(description ? { description } : {}),
      });
      continue;
    }
  }

  return { symbols, references };
}

/**
 * Extract import paths from Go content.
 */
function extractImports(content: string): string[] {
  const refs: string[] = [];

  // Single import: import "path"
  const singlePattern = /^import\s+"([^"]+)"/gm;
  let match;
  while ((match = singlePattern.exec(content)) !== null) {
    const p = match[1];
    if (p) refs.push(p);
  }

  // Block import: import ( "path" ... )
  const blockPattern = /import\s*\(([\s\S]*?)\)/g;
  while ((match = blockPattern.exec(content)) !== null) {
    const block = match[1] ?? '';
    const linePattern = /\s*(?:\w+\s+)?"([^"]+)"/g;
    let lineMatch;
    while ((lineMatch = linePattern.exec(block)) !== null) {
      const p = lineMatch[1];
      if (p) refs.push(p);
    }
  }

  return [...new Set(refs)];
}

/**
 * In Go, exported symbols start with an uppercase letter.
 */
function isExported(name: string): boolean {
  return name.length > 0 && name[0] === name[0]?.toUpperCase() && name[0] !== name[0]?.toLowerCase();
}

/**
 * Extract the comment preceding a definition.
 */
function extractPrecedingComment(lines: string[], lineNum: number): string | undefined {
  let i = lineNum - 1;
  const commentLines: string[] = [];

  while (i >= 0) {
    const prevLine = lines[i];
    if (prevLine === undefined) break;
    const trimmed = prevLine.trim();
    if (trimmed.startsWith('//')) {
      commentLines.unshift(trimmed.replace(/^\/\/\s?/, ''));
      i--;
    } else {
      break;
    }
  }

  return commentLines.length > 0 ? commentLines[0] : undefined;
}

/**
 * Clean a Go signature for display.
 */
function cleanSignature(line: string): string {
  return line
    .replace(/\s*\{?\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Get file extensions for Go.
 */
export function getGoExtensions(): string[] {
  return ['.go'];
}
