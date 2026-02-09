/**
 * Error System Module
 *
 * Exports all error handling utilities.
 */

export {
  // Types
  type ErrorDefinition,

  // Constants
  ERROR_CODES,

  // Classes
  CasterlyError,

  // Functions
  createError,
  wrapError,
  formatErrorForUser,
  isRecoverable,
  shouldRetry,
  getErrorDefinition,
  listErrorsByCategory,
} from './codes.js';
