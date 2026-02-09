/**
 * Validation Loop Types
 *
 * Type definitions for the validation pipeline.
 */

/**
 * Validation step result.
 */
export interface ValidationStepResult {
  /** Step name */
  step: ValidationStep;
  /** Whether the step passed */
  passed: boolean;
  /** Error messages if failed */
  errors: ValidationError[];
  /** Warning messages */
  warnings: ValidationWarning[];
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether the step was skipped */
  skipped: boolean;
  /** Reason for skipping */
  skipReason?: string;
}

/**
 * Validation step names.
 */
export type ValidationStep = 'parse' | 'lint' | 'typecheck' | 'test' | 'commit';

/**
 * A validation error.
 */
export interface ValidationError {
  /** File path (relative) */
  file: string;
  /** Line number (1-indexed) */
  line?: number;
  /** Column number (1-indexed) */
  column?: number;
  /** Error message */
  message: string;
  /** Error code/rule */
  code?: string;
  /** Severity */
  severity: 'error' | 'warning';
  /** Suggested fix */
  fix?: string;
}

/**
 * A validation warning.
 */
export interface ValidationWarning {
  /** File path */
  file?: string;
  /** Warning message */
  message: string;
  /** Warning code */
  code?: string;
}

/**
 * Complete validation result.
 */
export interface ValidationResult {
  /** Whether all required steps passed */
  success: boolean;
  /** Results for each step */
  steps: ValidationStepResult[];
  /** Total duration in milliseconds */
  totalDurationMs: number;
  /** Files that were validated */
  files: string[];
  /** Summary message */
  summary: string;
}

/**
 * Validation configuration.
 */
export interface ValidationConfig {
  /** Root path of the repository */
  rootPath: string;
  /** Check syntax/parse (default: true) */
  parseCheck?: boolean;
  /** Run lint after edits (default: true) */
  lintOnEdit?: boolean;
  /** Run typecheck after edits (default: true) */
  typecheckOnEdit?: boolean;
  /** Run tests after edits (default: false) */
  testOnEdit?: boolean;
  /** Auto-commit after successful validation (default: false) */
  autoCommit?: boolean;
  /** Commit message style */
  commitMessageStyle?: 'conventional' | 'descriptive';
  /** Custom lint command */
  lintCommand?: string;
  /** Custom typecheck command */
  typecheckCommand?: string;
  /** Custom test command */
  testCommand?: string;
  /** Timeout for each step in milliseconds */
  stepTimeout?: number;
  /** Only report new errors (not pre-existing) */
  onlyNewErrors?: boolean;
}

/**
 * Default validation configuration.
 */
export const DEFAULT_VALIDATION_CONFIG: Required<Omit<ValidationConfig, 'rootPath'>> = {
  parseCheck: true,
  lintOnEdit: true,
  typecheckOnEdit: true,
  testOnEdit: false,
  autoCommit: false,
  commitMessageStyle: 'conventional',
  lintCommand: 'npm run lint',
  typecheckCommand: 'npm run typecheck',
  testCommand: 'npm test',
  stepTimeout: 60000, // 1 minute
  onlyNewErrors: true,
};

/**
 * Validation presets for different scenarios.
 */
export const VALIDATION_PRESETS = {
  /** Quick validation - parse and lint only */
  quick: {
    parseCheck: true,
    lintOnEdit: true,
    typecheckOnEdit: false,
    testOnEdit: false,
    autoCommit: false,
  },
  /** Standard validation - parse, lint, typecheck */
  standard: {
    parseCheck: true,
    lintOnEdit: true,
    typecheckOnEdit: true,
    testOnEdit: false,
    autoCommit: false,
  },
  /** Full validation - all checks including tests */
  full: {
    parseCheck: true,
    lintOnEdit: true,
    typecheckOnEdit: true,
    testOnEdit: true,
    autoCommit: false,
  },
  /** CI mode - full validation with auto-commit */
  ci: {
    parseCheck: true,
    lintOnEdit: true,
    typecheckOnEdit: true,
    testOnEdit: true,
    autoCommit: true,
  },
} as const;

/**
 * Language-specific parser configuration.
 */
export interface ParserConfig {
  /** File extensions this parser handles */
  extensions: string[];
  /** Parser name */
  name: string;
  /** Whether the parser is available */
  available: boolean;
}

/**
 * Supported parsers.
 */
export const SUPPORTED_PARSERS: ParserConfig[] = [
  {
    extensions: ['.ts', '.tsx'],
    name: 'typescript',
    available: true,
  },
  {
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    name: 'javascript',
    available: true,
  },
  {
    extensions: ['.json'],
    name: 'json',
    available: true,
  },
  {
    extensions: ['.yaml', '.yml'],
    name: 'yaml',
    available: true,
  },
];
