/**
 * TypeScript/JavaScript Symbol Extractor
 *
 * Extracts symbols and references from TypeScript/JavaScript files
 * using regex patterns. This is a portable implementation that
 * doesn't require native tree-sitter bindings.
 */

import type { Symbol, SymbolKind } from '../types.js';

/**
 * Result of extracting from a file.
 */
export interface ExtractionResult {
  symbols: Symbol[];
  references: string[];
}

/**
 * Pattern definitions for TypeScript/JavaScript.
 */
interface PatternDef {
  pattern: RegExp;
  kind: SymbolKind;
  extractName: (match: RegExpExecArray) => string;
  extractSignature: (match: RegExpExecArray, line: string) => string;
  isExport: (match: RegExpExecArray, line: string) => boolean;
}

/**
 * Extract symbols and references from TypeScript/JavaScript content.
 */
export function extractTypeScript(content: string): ExtractionResult {
  const lines = content.split('\n');
  const symbols: Symbol[] = [];
  const references: string[] = [];

  // Extract imports first
  const importRefs = extractImports(content);
  references.push(...importRefs);

  // Process each line for symbols
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (line === undefined) continue;

    // Skip empty lines and comments
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) {
      continue;
    }

    // Get preceding JSDoc if any
    const description = extractPrecedingJsDoc(lines, lineNum);

    // Try each pattern
    for (const patternDef of PATTERNS) {
      const match = patternDef.pattern.exec(line);
      if (match) {
        const name = patternDef.extractName(match);
        if (name && !isReservedWord(name)) {
          symbols.push({
            name,
            kind: patternDef.kind,
            signature: patternDef.extractSignature(match, line),
            line: lineNum + 1,
            exported: patternDef.isExport(match, line),
            ...(description ? { description } : {}),
          });
        }
        break; // Only match first pattern per line
      }
    }
  }

  return { symbols, references };
}

/**
 * Extract import references from file content.
 */
function extractImports(content: string): string[] {
  const refs: string[] = [];

  // ES6 imports: import ... from 'module'
  const esImportPattern = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = esImportPattern.exec(content)) !== null) {
    const modulePath = match[1];
    if (modulePath && isLocalImport(modulePath)) {
      refs.push(normalizeImportPath(modulePath));
    }
  }

  // Dynamic imports: import('module')
  const dynamicPattern = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicPattern.exec(content)) !== null) {
    const modulePath = match[1];
    if (modulePath && isLocalImport(modulePath)) {
      refs.push(normalizeImportPath(modulePath));
    }
  }

  // require(): require('module')
  const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requirePattern.exec(content)) !== null) {
    const modulePath = match[1];
    if (modulePath && isLocalImport(modulePath)) {
      refs.push(normalizeImportPath(modulePath));
    }
  }

  // Dedupe
  return [...new Set(refs)];
}

/**
 * Check if an import path is local (relative or absolute file).
 */
function isLocalImport(path: string): boolean {
  return path.startsWith('.') || path.startsWith('/');
}

/**
 * Normalize an import path to a relative file path.
 */
function normalizeImportPath(importPath: string): string {
  // Remove leading ./ if present
  let normalized = importPath.replace(/^\.\//, '');

  // Add .ts extension if no extension
  if (!normalized.match(/\.[a-z]+$/i)) {
    normalized += '.ts';
  }

  // Handle .js -> .ts for TypeScript
  normalized = normalized.replace(/\.js$/, '.ts');
  normalized = normalized.replace(/\.jsx$/, '.tsx');

  return normalized;
}

/**
 * Extract preceding JSDoc comment for a symbol.
 */
function extractPrecedingJsDoc(lines: string[], lineNum: number): string | undefined {
  // Look for /** ... */ above the line
  let i = lineNum - 1;

  // Skip empty lines
  while (i >= 0) {
    const prevLine = lines[i];
    if (prevLine === undefined) break;
    const trimmed = prevLine.trim();
    if (trimmed === '') {
      i--;
      continue;
    }
    break;
  }

  if (i < 0) return undefined;

  const prevLine = lines[i];
  if (prevLine === undefined) return undefined;

  // Check if it ends with */
  if (!prevLine.trim().endsWith('*/')) {
    return undefined;
  }

  // Find the start of the JSDoc
  let start = i;
  while (start >= 0) {
    const line = lines[start];
    if (line === undefined) break;
    if (line.includes('/**')) {
      break;
    }
    start--;
  }

  if (start < 0) return undefined;

  // Extract and clean the JSDoc
  const jsdocLines = lines.slice(start, i + 1);
  const description = jsdocLines
    .map((l) => l?.trim() ?? '')
    .join(' ')
    .replace(/\/\*\*/, '')
    .replace(/\*\//, '')
    .replace(/\s*\*\s*/g, ' ')
    .replace(/@\w+[^@]*/g, '') // Remove tags
    .trim();

  return description || undefined;
}

/**
 * Check if a name is a reserved JavaScript word.
 */
function isReservedWord(name: string): boolean {
  const reserved = new Set([
    'break',
    'case',
    'catch',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'finally',
    'for',
    'function',
    'if',
    'in',
    'instanceof',
    'new',
    'return',
    'switch',
    'this',
    'throw',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
    'class',
    'const',
    'enum',
    'export',
    'extends',
    'import',
    'super',
    'implements',
    'interface',
    'let',
    'package',
    'private',
    'protected',
    'public',
    'static',
    'yield',
    'async',
    'await',
  ]);
  return reserved.has(name);
}

/**
 * Clean a signature for display.
 */
function cleanSignature(sig: string): string {
  return sig
    .replace(/\s+/g, ' ')
    .replace(/\s*{\s*$/, '')
    .trim();
}

/**
 * Pattern definitions for TypeScript/JavaScript symbols.
 */
const PATTERNS: PatternDef[] = [
  // Exported function: export function name(...)
  {
    pattern: /^(\s*)export\s+(async\s+)?function\s+(\w+)\s*(<[^>]+>)?\s*\(([^)]*)\)/,
    kind: 'function',
    extractName: (m) => m[3] ?? '',
    extractSignature: (m, line) => cleanSignature(line),
    isExport: () => true,
  },
  // Exported arrow function: export const name = (...) =>
  {
    pattern: /^(\s*)export\s+const\s+(\w+)\s*=\s*(async\s+)?\(?([^)]*)\)?\s*=>/,
    kind: 'function',
    extractName: (m) => m[2] ?? '',
    extractSignature: (m, line) => cleanSignature(line),
    isExport: () => true,
  },
  // Regular function: function name(...)
  {
    pattern: /^(\s*)(async\s+)?function\s+(\w+)\s*(<[^>]+>)?\s*\(([^)]*)\)/,
    kind: 'function',
    extractName: (m) => m[3] ?? '',
    extractSignature: (m, line) => cleanSignature(line),
    isExport: (_, line) => line.includes('export'),
  },
  // Arrow function: const name = (...) =>
  {
    pattern: /^(\s*)(?:const|let|var)\s+(\w+)\s*=\s*(async\s+)?\(?([^)]*)\)?\s*=>/,
    kind: 'function',
    extractName: (m) => m[2] ?? '',
    extractSignature: (m, line) => cleanSignature(line),
    isExport: (_, line) => line.includes('export'),
  },
  // Class: class Name
  {
    pattern: /^(\s*)(export\s+)?(abstract\s+)?class\s+(\w+)(\s+extends\s+\w+)?(\s+implements\s+[\w,\s]+)?/,
    kind: 'class',
    extractName: (m) => m[4] ?? '',
    extractSignature: (m, line) => cleanSignature(line),
    isExport: (m) => !!m[2],
  },
  // Interface: interface Name
  {
    pattern: /^(\s*)(export\s+)?interface\s+(\w+)(<[^>]+>)?(\s+extends\s+[\w,\s<>]+)?/,
    kind: 'interface',
    extractName: (m) => m[3] ?? '',
    extractSignature: (m, line) => cleanSignature(line),
    isExport: (m) => !!m[2],
  },
  // Type alias: type Name =
  {
    pattern: /^(\s*)(export\s+)?type\s+(\w+)(<[^>]+>)?\s*=/,
    kind: 'type',
    extractName: (m) => m[3] ?? '',
    extractSignature: (m, line) => cleanSignature(line),
    isExport: (m) => !!m[2],
  },
  // Enum: enum Name
  {
    pattern: /^(\s*)(export\s+)?(const\s+)?enum\s+(\w+)/,
    kind: 'enum',
    extractName: (m) => m[4] ?? '',
    extractSignature: (m, line) => cleanSignature(line),
    isExport: (m) => !!m[2],
  },
  // Namespace: namespace Name
  {
    pattern: /^(\s*)(export\s+)?namespace\s+(\w+)/,
    kind: 'namespace',
    extractName: (m) => m[3] ?? '',
    extractSignature: (m, line) => cleanSignature(line),
    isExport: (m) => !!m[2],
  },
  // Exported const/let: export const name =
  {
    pattern: /^(\s*)export\s+(const|let)\s+(\w+)\s*(?::\s*([^=]+))?\s*=/,
    kind: 'const',
    extractName: (m) => m[3] ?? '',
    extractSignature: (m) => {
      const name = m[3] ?? '';
      const type = m[4]?.trim();
      return type ? `${m[2]} ${name}: ${type}` : `${m[2]} ${name}`;
    },
    isExport: () => true,
  },
  // Method inside class (simplified detection)
  {
    pattern:
      /^(\s+)(public\s+|private\s+|protected\s+)?(static\s+)?(async\s+)?(\w+)\s*(<[^>]+>)?\s*\(([^)]*)\)\s*(?::\s*([^{]+))?/,
    kind: 'method',
    extractName: (m) => m[5] ?? '',
    extractSignature: (m, line) => {
      // Skip constructor
      if (m[5] === 'constructor') {
        return cleanSignature(line);
      }
      return cleanSignature(line);
    },
    isExport: (m) => !m[2]?.includes('private'),
  },
];

/**
 * Get file extension patterns for TypeScript/JavaScript.
 */
export function getTypeScriptExtensions(): string[] {
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
}
