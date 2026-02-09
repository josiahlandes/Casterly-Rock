/**
 * Validation Module
 *
 * Provides a validation pipeline for checking edits:
 * parse -> lint -> typecheck -> test
 */

export {
  ValidationPipeline,
  createValidationPipeline,
  formatValidationResult,
  getErrorSummary,
} from './pipeline.js';
export { parseFile, parseFiles } from './parser.js';
export type { ParseResult } from './parser.js';
export {
  executeCommand,
  runLint,
  runTypecheck,
  runTest,
  parseTypeScriptErrors,
  parseEslintErrors,
  parseTestErrors,
} from './runner.js';
export type { CommandResult } from './runner.js';
export * from './types.js';
