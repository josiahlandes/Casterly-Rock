/**
 * Mode Manager
 *
 * Manages mode state, transitions, and detection.
 */

import type {
  ModeName,
  Mode,
  ModeState,
  ModeTransition,
  ModeDetection,
  ModeConfig,
} from './types.js';
import { DEFAULT_MODE_CONFIG } from './types.js';
import { getMode, isValidMode, MODES } from './definitions.js';

/**
 * Mode manager for handling mode state and transitions.
 */
export class ModeManager {
  private config: Required<ModeConfig>;
  private state: ModeState;

  constructor(config: Partial<ModeConfig> = {}) {
    this.config = {
      ...DEFAULT_MODE_CONFIG,
      ...config,
    };

    this.state = {
      current: this.config.defaultMode,
      history: [],
      autoDetected: false,
    };
  }

  /**
   * Get the current mode.
   */
  getCurrentMode(): Mode {
    return getMode(this.state.current);
  }

  /**
   * Get the current mode name.
   */
  getCurrentModeName(): ModeName {
    return this.state.current;
  }

  /**
   * Switch to a different mode.
   */
  switchMode(to: ModeName, reason: string = 'User requested'): Mode {
    if (!isValidMode(to)) {
      throw new Error(`Invalid mode: ${to}`);
    }

    const from = this.state.current;

    if (from !== to) {
      const transition: ModeTransition = {
        from,
        to,
        reason,
        timestamp: new Date().toISOString(),
      };

      this.state.previous = from;
      this.state.current = to;
      this.state.history.push(transition);
      this.state.autoDetected = false;
    }

    return getMode(to);
  }

  /**
   * Return to the previous mode.
   */
  returnToPreviousMode(): Mode {
    if (this.state.previous) {
      return this.switchMode(this.state.previous, 'Returning to previous mode');
    }
    return this.getCurrentMode();
  }

  /**
   * Auto-detect mode from user input.
   */
  detectMode(input: string): ModeDetection {
    const inputLower = input.toLowerCase();
    const triggers: string[] = [];
    let mode: ModeName = this.config.defaultMode;
    let confidence = 0.5;
    let reason = 'Default mode';

    // Check for explicit mode requests
    if (inputLower.includes('/code') || inputLower.includes('switch to code')) {
      mode = 'code';
      confidence = 1.0;
      reason = 'Explicit mode request';
      triggers.push('/code');
    } else if (inputLower.includes('/architect') || inputLower.includes('switch to architect')) {
      mode = 'architect';
      confidence = 1.0;
      reason = 'Explicit mode request';
      triggers.push('/architect');
    } else if (inputLower.includes('/ask') || inputLower.includes('switch to ask')) {
      mode = 'ask';
      confidence = 1.0;
      reason = 'Explicit mode request';
      triggers.push('/ask');
    } else if (inputLower.includes('/review') || inputLower.includes('switch to review')) {
      mode = 'review';
      confidence = 1.0;
      reason = 'Explicit mode request';
      triggers.push('/review');
    }
    // Check for architect keywords
    else if (this.hasArchitectKeywords(inputLower)) {
      mode = 'architect';
      confidence = 0.8;
      reason = 'Planning/architecture keywords detected';
      triggers.push(...this.findArchitectKeywords(inputLower));
    }
    // Check for review keywords
    else if (this.hasReviewKeywords(inputLower)) {
      mode = 'review';
      confidence = 0.8;
      reason = 'Review keywords detected';
      triggers.push(...this.findReviewKeywords(inputLower));
    }
    // Check for ask/question keywords
    else if (this.hasAskKeywords(inputLower)) {
      mode = 'ask';
      confidence = 0.7;
      reason = 'Question keywords detected';
      triggers.push(...this.findAskKeywords(inputLower));
    }
    // Check for code/edit keywords
    else if (this.hasCodeKeywords(inputLower)) {
      mode = 'code';
      confidence = 0.8;
      reason = 'Editing keywords detected';
      triggers.push(...this.findCodeKeywords(inputLower));
    }

    return { mode, confidence, reason, triggers };
  }

  /**
   * Auto-detect and switch mode if enabled.
   */
  autoDetectAndSwitch(input: string): ModeDetection | null {
    if (!this.config.autoDetect) {
      return null;
    }

    const detection = this.detectMode(input);

    // Only auto-switch if confidence is high enough
    if (detection.confidence >= 0.7 && detection.mode !== this.state.current) {
      this.switchMode(detection.mode, detection.reason);
      this.state.autoDetected = true;
    }

    return detection;
  }

  /**
   * Check if a tool is allowed in the current mode.
   */
  isToolAllowed(tool: string): boolean {
    const mode = this.getCurrentMode();

    if (mode.forbiddenTools.includes(tool)) {
      return false;
    }

    if (mode.allowedTools.length > 0 && !mode.allowedTools.includes(tool)) {
      return false;
    }

    return true;
  }

  /**
   * Get the preferred model for the current mode.
   */
  getPreferredModel(): string {
    const modeName = this.state.current;
    const configModel = this.config.models[modeName];
    if (configModel) {
      return configModel;
    }
    return this.getCurrentMode().preferredModel;
  }

  /**
   * Get the mode state.
   */
  getState(): ModeState {
    return { ...this.state };
  }

  /**
   * Get mode history.
   */
  getHistory(): ModeTransition[] {
    return [...this.state.history];
  }

  /**
   * Reset to default mode.
   */
  reset(): void {
    this.state = {
      current: this.config.defaultMode,
      history: [],
      autoDetected: false,
    };
  }

  /**
   * Get all available modes.
   */
  getAllModes(): Mode[] {
    return Object.values(MODES);
  }

  // ========== Private Helper Methods ==========

  private hasArchitectKeywords(input: string): boolean {
    const keywords = [
      'plan',
      'design',
      'architect',
      'structure',
      'outline',
      'approach',
      'strategy',
      'before implementing',
      'how should',
      'what approach',
      'best way to structure',
    ];
    return keywords.some((kw) => input.includes(kw));
  }

  private findArchitectKeywords(input: string): string[] {
    const keywords = [
      'plan',
      'design',
      'architect',
      'structure',
      'outline',
      'approach',
      'strategy',
    ];
    return keywords.filter((kw) => input.includes(kw));
  }

  private hasReviewKeywords(input: string): boolean {
    const keywords = [
      'review',
      'check',
      'audit',
      'analyze',
      'look at',
      'evaluate',
      'assess',
      'find issues',
      'find bugs',
      'security review',
      'code review',
    ];
    return keywords.some((kw) => input.includes(kw));
  }

  private findReviewKeywords(input: string): string[] {
    const keywords = ['review', 'check', 'audit', 'analyze', 'evaluate', 'assess'];
    return keywords.filter((kw) => input.includes(kw));
  }

  private hasAskKeywords(input: string): boolean {
    const keywords = [
      'what is',
      'what does',
      'how does',
      'why does',
      'where is',
      'explain',
      'tell me',
      'describe',
      'understand',
      'clarify',
      '?',
    ];
    return keywords.some((kw) => input.includes(kw));
  }

  private findAskKeywords(input: string): string[] {
    const keywords = ['what', 'how', 'why', 'where', 'explain', 'describe'];
    return keywords.filter((kw) => input.includes(kw));
  }

  private hasCodeKeywords(input: string): boolean {
    const keywords = [
      'add',
      'create',
      'implement',
      'fix',
      'change',
      'update',
      'modify',
      'edit',
      'remove',
      'delete',
      'refactor',
      'rename',
      'move',
      'write',
    ];
    return keywords.some((kw) => input.includes(kw));
  }

  private findCodeKeywords(input: string): string[] {
    const keywords = [
      'add',
      'create',
      'implement',
      'fix',
      'change',
      'update',
      'modify',
      'edit',
      'remove',
      'refactor',
    ];
    return keywords.filter((kw) => input.includes(kw));
  }
}

/**
 * Create a mode manager.
 */
export function createModeManager(config: Partial<ModeConfig> = {}): ModeManager {
  return new ModeManager(config);
}

/**
 * Format mode info for display.
 */
export function formatModeInfo(mode: Mode): string {
  const lines: string[] = [];

  lines.push(`Mode: ${mode.displayName}`);
  lines.push(`Description: ${mode.description}`);
  lines.push('');
  lines.push('Capabilities:');
  lines.push(`  Edit files: ${mode.canEdit ? '✓' : '✗'}`);
  lines.push(`  Create files: ${mode.canCreate ? '✓' : '✗'}`);
  lines.push(`  Delete files: ${mode.canDelete ? '✓' : '✗'}`);
  lines.push(`  Run bash: ${mode.canBash ? '✓' : '✗'}`);
  lines.push(`  Git operations: ${mode.canGit ? '✓' : '✗'}`);
  lines.push('');
  lines.push(`Allowed tools: ${mode.allowedTools.join(', ')}`);

  if (mode.forbiddenTools.length > 0) {
    lines.push(`Forbidden tools: ${mode.forbiddenTools.join(', ')}`);
  }

  return lines.join('\n');
}
