/**
 * Rust Symbol Extractor
 *
 * Extracts symbols and references from Rust files using regex patterns.
 * Handles functions, structs, enums, traits, impl blocks, and constants.
 */

import type { Symbol, SymbolKind } from '../types.js';

export interface ExtractionResult {
  symbols: Symbol[];
  references: string[];
}

/**
 * Extract symbols and references from Rust content.
 */
export function extractRust(content: string): ExtractionResult {
  const lines = content.split('\n');
  const symbols: Symbol[] = [];
  const references: string[] = [];

  // Extract imports (use statements)
  references.push(...extractImports(content));

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (line === undefined) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    const description = extractPrecedingComment(lines, lineNum);

    // Function: pub fn name(...)  or  fn name(...)
    const funcMatch = /^(\s*)(pub(?:\(crate\))?\s+)?(async\s+)?fn\s+(\w+)\s*(<[^>]+>)?\s*\(/.exec(line);
    if (funcMatch) {
      const indent = funcMatch[1] ?? '';
      const name = funcMatch[4] ?? '';
      const isPub = !!funcMatch[2];
      // Indented fn inside impl = method
      const kind: SymbolKind = indent.length > 0 ? 'method' : 'function';
      symbols.push({
        name,
        kind,
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: isPub,
        ...(description ? { description } : {}),
      });
      continue;
    }

    // Struct: pub struct Name
    const structMatch = /^(pub(?:\(crate\))?\s+)?struct\s+(\w+)/.exec(line);
    if (structMatch) {
      const name = structMatch[2] ?? '';
      symbols.push({
        name,
        kind: 'class',
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: !!structMatch[1],
        ...(description ? { description } : {}),
      });
      continue;
    }

    // Enum: pub enum Name
    const enumMatch = /^(pub(?:\(crate\))?\s+)?enum\s+(\w+)/.exec(line);
    if (enumMatch) {
      const name = enumMatch[2] ?? '';
      symbols.push({
        name,
        kind: 'enum',
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: !!enumMatch[1],
        ...(description ? { description } : {}),
      });
      continue;
    }

    // Trait: pub trait Name
    const traitMatch = /^(pub(?:\(crate\))?\s+)?trait\s+(\w+)/.exec(line);
    if (traitMatch) {
      const name = traitMatch[2] ?? '';
      symbols.push({
        name,
        kind: 'interface',
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: !!traitMatch[1],
        ...(description ? { description } : {}),
      });
      continue;
    }

    // Type alias: pub type Name = ...
    const typeMatch = /^(pub(?:\(crate\))?\s+)?type\s+(\w+)/.exec(line);
    if (typeMatch) {
      const name = typeMatch[2] ?? '';
      symbols.push({
        name,
        kind: 'type',
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: !!typeMatch[1],
        ...(description ? { description } : {}),
      });
      continue;
    }

    // Constant: pub const NAME: ... = ...
    const constMatch = /^(pub(?:\(crate\))?\s+)?const\s+(\w+)\s*:/.exec(line);
    if (constMatch) {
      const name = constMatch[2] ?? '';
      symbols.push({
        name,
        kind: 'const',
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: !!constMatch[1],
        ...(description ? { description } : {}),
      });
      continue;
    }

    // Static: pub static NAME: ... = ...
    const staticMatch = /^(pub(?:\(crate\))?\s+)?static\s+(mut\s+)?(\w+)\s*:/.exec(line);
    if (staticMatch) {
      const name = staticMatch[3] ?? '';
      symbols.push({
        name,
        kind: 'const',
        signature: cleanSignature(line),
        line: lineNum + 1,
        exported: !!staticMatch[1],
        ...(description ? { description } : {}),
      });
      continue;
    }
  }

  return { symbols, references };
}

/**
 * Extract use/mod references from Rust content.
 */
function extractImports(content: string): string[] {
  const refs: string[] = [];

  // use statements: use crate::module::... or use super::...
  const usePattern = /^use\s+((?:crate|super|self)(?:::\w+)+)/gm;
  let match;
  while ((match = usePattern.exec(content)) !== null) {
    const p = match[1];
    if (p) refs.push(p);
  }

  // mod statements: mod name;
  const modPattern = /^mod\s+(\w+)\s*;/gm;
  while ((match = modPattern.exec(content)) !== null) {
    const p = match[1];
    if (p) refs.push(p);
  }

  return [...new Set(refs)];
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
    // Rust doc comments: /// or //!
    if (trimmed.startsWith('///') || trimmed.startsWith('//!')) {
      commentLines.unshift(trimmed.replace(/^\/\/[\/!]\s?/, ''));
      i--;
    } else if (trimmed.startsWith('//')) {
      commentLines.unshift(trimmed.replace(/^\/\/\s?/, ''));
      i--;
    } else if (trimmed.startsWith('#[')) {
      // Skip attributes
      i--;
    } else {
      break;
    }
  }

  return commentLines.length > 0 ? commentLines[0] : undefined;
}

/**
 * Clean a Rust signature for display.
 */
function cleanSignature(line: string): string {
  return line
    .replace(/\s*\{?\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Get file extensions for Rust.
 */
export function getRustExtensions(): string[] {
  return ['.rs'];
}
