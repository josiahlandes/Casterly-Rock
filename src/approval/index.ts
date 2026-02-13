/**
 * Approval Module (ISSUE-004)
 *
 * Async approval flow for destructive command execution.
 * Gates dangerous tool calls via iMessage-based user confirmation.
 */

// Types
export type {
  ApprovalStatus,
  ApprovalRequest,
  ApprovalConfig,
  ApprovalStoreData,
} from './types.js';

export { DEFAULT_APPROVAL_CONFIG } from './types.js';

// Matcher
export {
  type ApprovalAnswer,
  parseApprovalResponse,
} from './matcher.js';

// Store
export {
  type ApprovalStore,
  createApprovalStore,
} from './store.js';

// Bridge
export {
  type ApprovalBridge,
  createApprovalBridge,
} from './bridge.js';
