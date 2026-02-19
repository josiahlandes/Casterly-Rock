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
interface ValidationWarning {
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


