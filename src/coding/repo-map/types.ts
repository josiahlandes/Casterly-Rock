/**
 * Repo Map Types
 *
 * Type definitions for the repository map system.
 */

/**
 * Complete repository map.
 */
export interface RepoMap {
  /** Mapped files with symbols */
  files: FileMap[];
  /** Total tokens used by the map */
  totalTokens: number;
  /** When the map was generated */
  generatedAt: string;
  /** Root path of the repository */
  rootPath: string;
}

/**
 * Map of a single file's structure.
 */
export interface FileMap {
  /** Relative path from repo root */
  path: string;
  /** Extracted symbols */
  symbols: Symbol[];
  /** Files this file imports/references */
  references: string[];
  /** PageRank importance score (0-1) */
  importance: number;
  /** Token count for this file's map entry */
  tokens: number;
}

/**
 * A symbol (function, class, interface, etc.)
 */
export interface Symbol {
  /** Symbol name */
  name: string;
  /** Symbol kind */
  kind: SymbolKind;
  /** Full signature (e.g., "async function foo(x: number): Promise<string>") */
  signature: string;
  /** Line number (1-indexed) */
  line: number;
  /** Whether the symbol is exported */
  exported: boolean;
  /** JSDoc or comment description, if present */
  description?: string;
}

/**
 * Types of symbols we extract.
 */
export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'const'
  | 'let'
  | 'var'
  | 'enum'
  | 'namespace'
  | 'method'
  | 'property'
  | 'export';

/**
 * Configuration for repo map generation.
 */
export interface RepoMapConfig {
  /** Root path of the repository */
  rootPath: string;
  /** Token budget for the map (default: 2048) */
  tokenBudget?: number;
  /** Maximum token budget when no files in context (default: 8192) */
  tokenBudgetMax?: number;
  /** Languages to include */
  languages?: Language[];
  /** Glob patterns to include */
  includePatterns?: string[];
  /** Glob patterns to exclude */
  excludePatterns?: string[];
  /** Include private/unexported symbols (default: false) */
  includePrivate?: boolean;
  /** Include method bodies in class maps (default: false) */
  includeMethodBodies?: boolean;
}

/**
 * Supported languages.
 */
export type Language =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'c'
  | 'cpp';

/**
 * File extension to language mapping.
 */
export const EXTENSION_TO_LANGUAGE: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
};

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: Required<Omit<RepoMapConfig, 'rootPath'>> = {
  tokenBudget: 2048,
  tokenBudgetMax: 8192,
  languages: ['typescript', 'javascript'],
  includePatterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
  excludePatterns: [
    'node_modules/**',
    'dist/**',
    'build/**',
    '.git/**',
    'coverage/**',
    '*.min.js',
    '*.d.ts',
  ],
  includePrivate: false,
  includeMethodBodies: false,
};
