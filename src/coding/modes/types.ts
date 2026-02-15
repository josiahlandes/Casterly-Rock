/**
 * Coding Modes Types
 *
 * Type definitions for the different operational modes.
 */

/**
 * Available modes.
 */
export type ModeName = 'code' | 'architect' | 'ask' | 'review';

/**
 * Mode definition.
 */
export interface Mode {
  /** Mode name */
  name: ModeName;
  /** Human-readable display name */
  displayName: string;
  /** Description of what the mode is for */
  description: string;
  /** System prompt for this mode */
  systemPrompt: string;
  /** Tools available in this mode */
  allowedTools: string[];
  /** Tools explicitly forbidden in this mode */
  forbiddenTools: string[];
  /** Whether editing is allowed */
  canEdit: boolean;
  /** Whether file creation is allowed */
  canCreate: boolean;
  /** Whether file deletion is allowed */
  canDelete: boolean;
  /** Whether bash commands are allowed */
  canBash: boolean;
  /** Whether git operations are allowed */
  canGit: boolean;
  /** Preferred model for this mode */
  preferredModel: string;
  /** Fallback model if preferred is unavailable */
  fallbackModel: string;
}

/**
 * Mode transition.
 */
export interface ModeTransition {
  /** From mode */
  from: ModeName;
  /** To mode */
  to: ModeName;
  /** Reason for transition */
  reason: string;
  /** Timestamp */
  timestamp: string;
}

/**
 * Mode state.
 */
export interface ModeState {
  /** Current mode */
  current: ModeName;
  /** Previous mode (for returning) */
  previous?: ModeName;
  /** Mode history */
  history: ModeTransition[];
  /** Whether mode was auto-detected */
  autoDetected: boolean;
}

/**
 * Mode detection result.
 */
export interface ModeDetection {
  /** Detected mode */
  mode: ModeName;
  /** Confidence (0-1) */
  confidence: number;
  /** Reason for detection */
  reason: string;
  /** Keywords that triggered detection */
  triggers: string[];
}

/**
 * Mode configuration.
 */
export interface ModeConfig {
  /** Default mode */
  defaultMode?: ModeName;
  /** Auto-detect mode from user input */
  autoDetect?: boolean;
  /** Require confirmation for mode changes */
  confirmModeChange?: boolean;
  /** Allow user to override detected mode */
  allowOverride?: boolean;
  /** Model mappings */
  models?: Partial<Record<ModeName, string>>;
}

/**
 * Default mode configuration.
 */
export const DEFAULT_MODE_CONFIG: Required<ModeConfig> = {
  defaultMode: 'code',
  autoDetect: true,
  confirmModeChange: false,
  allowOverride: true,
  models: {
    code: 'qwen3-coder-next:latest',
    architect: 'gpt-oss:120b',
    ask: 'gpt-oss:120b',
    review: 'qwen3-coder-next:latest',
  },
};
