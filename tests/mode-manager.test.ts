import { describe, expect, it } from 'vitest';

import {
  CODE_MODE,
  ARCHITECT_MODE,
  ASK_MODE,
  REVIEW_MODE,
  MODES,
  getMode,
  getModeNames,
  isValidMode,
} from '../src/coding/modes/definitions.js';
import { DEFAULT_MODE_CONFIG } from '../src/coding/modes/types.js';
import {
  ModeManager,
  createModeManager,
  formatModeInfo,
} from '../src/coding/modes/manager.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Mode Definitions
// ═══════════════════════════════════════════════════════════════════════════════

describe('Mode Definitions — CODE_MODE', () => {
  it('has correct name and display name', () => {
    expect(CODE_MODE.name).toBe('code');
    expect(CODE_MODE.displayName).toBe('Code');
  });

  it('allows editing, creating, deleting, bash, and git', () => {
    expect(CODE_MODE.canEdit).toBe(true);
    expect(CODE_MODE.canCreate).toBe(true);
    expect(CODE_MODE.canDelete).toBe(true);
    expect(CODE_MODE.canBash).toBe(true);
    expect(CODE_MODE.canGit).toBe(true);
  });

  it('has empty allowed tools (all tools allowed)', () => {
    expect(CODE_MODE.allowedTools).toEqual([]);
  });

  it('has empty forbidden tools', () => {
    expect(CODE_MODE.forbiddenTools).toEqual([]);
  });

  it('prefers qwen3.5:122b', () => {
    expect(CODE_MODE.preferredModel).toBe('qwen3.5:122b');
    expect(CODE_MODE.fallbackModel).toBe('qwen3.5:122b');
  });
});

describe('Mode Definitions — ARCHITECT_MODE', () => {
  it('has correct name', () => {
    expect(ARCHITECT_MODE.name).toBe('architect');
  });

  it('forbids editing and bash', () => {
    expect(ARCHITECT_MODE.canEdit).toBe(false);
    expect(ARCHITECT_MODE.canCreate).toBe(false);
    expect(ARCHITECT_MODE.canDelete).toBe(false);
    expect(ARCHITECT_MODE.canBash).toBe(false);
    expect(ARCHITECT_MODE.canGit).toBe(false);
  });

  it('explicitly forbids edit_file, write_file, bash, send_message', () => {
    expect(ARCHITECT_MODE.forbiddenTools).toContain('edit_file');
    expect(ARCHITECT_MODE.forbiddenTools).toContain('write_file');
    expect(ARCHITECT_MODE.forbiddenTools).toContain('bash');
    expect(ARCHITECT_MODE.forbiddenTools).toContain('send_message');
  });

  it('allows read-only tools', () => {
    expect(ARCHITECT_MODE.allowedTools).toContain('read_file');
    expect(ARCHITECT_MODE.allowedTools).toContain('glob_files');
    expect(ARCHITECT_MODE.allowedTools).toContain('grep_files');
  });

  it('prefers qwen3.5:122b', () => {
    expect(ARCHITECT_MODE.preferredModel).toBe('qwen3.5:122b');
  });
});

describe('Mode Definitions — ASK_MODE', () => {
  it('has correct name', () => {
    expect(ASK_MODE.name).toBe('ask');
  });

  it('is read-only', () => {
    expect(ASK_MODE.canEdit).toBe(false);
    expect(ASK_MODE.canBash).toBe(false);
    expect(ASK_MODE.canGit).toBe(false);
  });

  it('allows read-only tools', () => {
    expect(ASK_MODE.allowedTools).toContain('read_file');
    expect(ASK_MODE.allowedTools).toContain('glob_files');
    expect(ASK_MODE.allowedTools).toContain('grep_files');
  });
});

describe('Mode Definitions — REVIEW_MODE', () => {
  it('has correct name', () => {
    expect(REVIEW_MODE.name).toBe('review');
  });

  it('is read-only', () => {
    expect(REVIEW_MODE.canEdit).toBe(false);
    expect(REVIEW_MODE.canCreate).toBe(false);
    expect(REVIEW_MODE.canDelete).toBe(false);
  });

  it('prefers qwen3.5:122b', () => {
    expect(REVIEW_MODE.preferredModel).toBe('qwen3.5:122b');
  });
});

describe('Mode Definitions — MODES record', () => {
  it('contains all four modes', () => {
    expect(Object.keys(MODES)).toEqual(['code', 'architect', 'ask', 'review']);
  });

  it('maps names to correct mode objects', () => {
    expect(MODES.code).toBe(CODE_MODE);
    expect(MODES.architect).toBe(ARCHITECT_MODE);
    expect(MODES.ask).toBe(ASK_MODE);
    expect(MODES.review).toBe(REVIEW_MODE);
  });
});

describe('getMode', () => {
  it('returns the correct mode by name', () => {
    expect(getMode('code')).toBe(CODE_MODE);
    expect(getMode('architect')).toBe(ARCHITECT_MODE);
  });
});

describe('getModeNames', () => {
  it('returns all mode names', () => {
    const names = getModeNames();
    expect(names).toContain('code');
    expect(names).toContain('architect');
    expect(names).toContain('ask');
    expect(names).toContain('review');
    expect(names.length).toBe(4);
  });
});

describe('isValidMode', () => {
  it('returns true for valid modes', () => {
    expect(isValidMode('code')).toBe(true);
    expect(isValidMode('architect')).toBe(true);
    expect(isValidMode('ask')).toBe(true);
    expect(isValidMode('review')).toBe(true);
  });

  it('returns false for invalid modes', () => {
    expect(isValidMode('invalid')).toBe(false);
    expect(isValidMode('')).toBe(false);
    expect(isValidMode('Code')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT_MODE_CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

describe('DEFAULT_MODE_CONFIG', () => {
  it('defaults to code mode', () => {
    expect(DEFAULT_MODE_CONFIG.defaultMode).toBe('code');
  });

  it('has autoDetect enabled', () => {
    expect(DEFAULT_MODE_CONFIG.autoDetect).toBe(true);
  });

  it('has confirmModeChange disabled', () => {
    expect(DEFAULT_MODE_CONFIG.confirmModeChange).toBe(false);
  });

  it('allows override', () => {
    expect(DEFAULT_MODE_CONFIG.allowOverride).toBe(true);
  });

  it('has model mappings for all modes', () => {
    expect(DEFAULT_MODE_CONFIG.models.code).toBe('qwen3.5:122b');
    expect(DEFAULT_MODE_CONFIG.models.architect).toBe('qwen3.5:122b');
    expect(DEFAULT_MODE_CONFIG.models.ask).toBe('qwen3.5:122b');
    expect(DEFAULT_MODE_CONFIG.models.review).toBe('qwen3.5:122b');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ModeManager — construction
// ═══════════════════════════════════════════════════════════════════════════════

describe('ModeManager — construction', () => {
  it('starts in default mode (code)', () => {
    const manager = new ModeManager();
    expect(manager.getCurrentModeName()).toBe('code');
  });

  it('accepts custom default mode', () => {
    const manager = new ModeManager({ defaultMode: 'ask' });
    expect(manager.getCurrentModeName()).toBe('ask');
  });

  it('starts with empty history', () => {
    const manager = new ModeManager();
    expect(manager.getHistory()).toEqual([]);
  });

  it('starts with autoDetected false', () => {
    const manager = new ModeManager();
    expect(manager.getState().autoDetected).toBe(false);
  });
});

describe('createModeManager', () => {
  it('creates a manager with defaults', () => {
    const manager = createModeManager();
    expect(manager.getCurrentModeName()).toBe('code');
  });

  it('creates a manager with custom config', () => {
    const manager = createModeManager({ defaultMode: 'review' });
    expect(manager.getCurrentModeName()).toBe('review');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ModeManager — switchMode
// ═══════════════════════════════════════════════════════════════════════════════

describe('ModeManager — switchMode', () => {
  it('switches to a valid mode', () => {
    const manager = new ModeManager();
    const mode = manager.switchMode('architect', 'Planning phase');
    expect(mode.name).toBe('architect');
    expect(manager.getCurrentModeName()).toBe('architect');
  });

  it('records transition in history', () => {
    const manager = new ModeManager();
    manager.switchMode('architect', 'Planning phase');
    const history = manager.getHistory();
    expect(history.length).toBe(1);
    expect(history[0]!.from).toBe('code');
    expect(history[0]!.to).toBe('architect');
    expect(history[0]!.reason).toBe('Planning phase');
    expect(history[0]!.timestamp).toBeTruthy();
  });

  it('sets previous mode', () => {
    const manager = new ModeManager();
    manager.switchMode('architect');
    expect(manager.getState().previous).toBe('code');
  });

  it('does not add history when switching to same mode', () => {
    const manager = new ModeManager();
    manager.switchMode('code');
    expect(manager.getHistory()).toEqual([]);
  });

  it('resets autoDetected on manual switch', () => {
    const manager = new ModeManager();
    // Simulate auto-detection
    manager.autoDetectAndSwitch('how does routing work?');
    expect(manager.getState().autoDetected).toBe(true);
    // Manual switch resets it
    manager.switchMode('code', 'Manual');
    expect(manager.getState().autoDetected).toBe(false);
  });

  it('throws for invalid mode', () => {
    const manager = new ModeManager();
    expect(() => manager.switchMode('invalid' as never)).toThrow('Invalid mode');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ModeManager — returnToPreviousMode
// ═══════════════════════════════════════════════════════════════════════════════

describe('ModeManager — returnToPreviousMode', () => {
  it('returns to previous mode', () => {
    const manager = new ModeManager();
    manager.switchMode('architect');
    const mode = manager.returnToPreviousMode();
    expect(mode.name).toBe('code');
    expect(manager.getCurrentModeName()).toBe('code');
  });

  it('returns current mode if no previous', () => {
    const manager = new ModeManager();
    const mode = manager.returnToPreviousMode();
    expect(mode.name).toBe('code');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ModeManager — detectMode
// ═══════════════════════════════════════════════════════════════════════════════

describe('ModeManager — detectMode', () => {
  it('detects explicit /code command', () => {
    const manager = new ModeManager();
    const detection = manager.detectMode('/code');
    expect(detection.mode).toBe('code');
    expect(detection.confidence).toBe(1.0);
    expect(detection.triggers).toContain('/code');
  });

  it('detects explicit /architect command', () => {
    const manager = new ModeManager();
    const detection = manager.detectMode('/architect');
    expect(detection.mode).toBe('architect');
    expect(detection.confidence).toBe(1.0);
  });

  it('detects explicit /ask command', () => {
    const manager = new ModeManager();
    const detection = manager.detectMode('/ask');
    expect(detection.mode).toBe('ask');
    expect(detection.confidence).toBe(1.0);
  });

  it('detects explicit /review command', () => {
    const manager = new ModeManager();
    const detection = manager.detectMode('/review');
    expect(detection.mode).toBe('review');
    expect(detection.confidence).toBe(1.0);
  });

  it('detects "switch to code" phrase', () => {
    const manager = new ModeManager();
    const detection = manager.detectMode('please switch to code mode');
    expect(detection.mode).toBe('code');
    expect(detection.confidence).toBe(1.0);
  });

  it('detects architect keywords', () => {
    const manager = new ModeManager();
    const detection = manager.detectMode('plan the implementation for feature X');
    expect(detection.mode).toBe('architect');
    expect(detection.confidence).toBe(0.8);
    expect(detection.triggers).toContain('plan');
  });

  it('detects review keywords', () => {
    const manager = new ModeManager();
    const detection = manager.detectMode('review my code for security issues');
    expect(detection.mode).toBe('review');
    expect(detection.confidence).toBe(0.8);
    expect(detection.triggers).toContain('review');
  });

  it('detects ask keywords', () => {
    const manager = new ModeManager();
    const detection = manager.detectMode('what is the purpose of the router?');
    expect(detection.mode).toBe('ask');
    expect(detection.confidence).toBe(0.7);
  });

  it('detects code keywords', () => {
    const manager = new ModeManager();
    const detection = manager.detectMode('implement the authentication module');
    expect(detection.mode).toBe('code');
    expect(detection.confidence).toBe(0.8);
    expect(detection.triggers).toContain('implement');
  });

  it('returns default mode for ambiguous input', () => {
    const manager = new ModeManager();
    const detection = manager.detectMode('hello there');
    expect(detection.mode).toBe('code'); // default
    expect(detection.confidence).toBe(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ModeManager — autoDetectAndSwitch
// ═══════════════════════════════════════════════════════════════════════════════

describe('ModeManager — autoDetectAndSwitch', () => {
  it('returns null when autoDetect is disabled', () => {
    const manager = new ModeManager({ autoDetect: false });
    const result = manager.autoDetectAndSwitch('plan the implementation');
    expect(result).toBeNull();
  });

  it('switches mode when confidence >= 0.7', () => {
    const manager = new ModeManager(); // starts in code
    const detection = manager.autoDetectAndSwitch('plan the architecture for this');
    expect(detection).not.toBeNull();
    expect(manager.getCurrentModeName()).toBe('architect');
    expect(manager.getState().autoDetected).toBe(true);
  });

  it('does not switch when confidence < 0.7', () => {
    const manager = new ModeManager({ defaultMode: 'architect' });
    const detection = manager.autoDetectAndSwitch('hello there');
    expect(detection).not.toBeNull();
    expect(manager.getCurrentModeName()).toBe('architect'); // unchanged
  });

  it('does not switch when already in detected mode', () => {
    const manager = new ModeManager(); // code
    const detection = manager.autoDetectAndSwitch('implement the feature');
    expect(detection).not.toBeNull();
    // Already in code mode, so no transition
    expect(manager.getHistory()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ModeManager — isToolAllowed
// ═══════════════════════════════════════════════════════════════════════════════

describe('ModeManager — isToolAllowed', () => {
  it('allows all tools in code mode (empty allowedTools = permissive)', () => {
    const manager = new ModeManager();
    expect(manager.isToolAllowed('read_file')).toBe(true);
    expect(manager.isToolAllowed('edit_file')).toBe(true);
    expect(manager.isToolAllowed('write_file')).toBe(true);
    expect(manager.isToolAllowed('bash')).toBe(true);
    expect(manager.isToolAllowed('send_message')).toBe(true);
    expect(manager.isToolAllowed('any-custom-tool')).toBe(true);
  });

  it('forbids edit_file and bash in architect mode', () => {
    const manager = new ModeManager({ defaultMode: 'architect' });
    expect(manager.isToolAllowed('edit_file')).toBe(false);
    expect(manager.isToolAllowed('write_file')).toBe(false);
    expect(manager.isToolAllowed('bash')).toBe(false);
    expect(manager.isToolAllowed('send_message')).toBe(false);
  });

  it('allows read-only tools in architect mode', () => {
    const manager = new ModeManager({ defaultMode: 'architect' });
    expect(manager.isToolAllowed('read_file')).toBe(true);
    expect(manager.isToolAllowed('glob_files')).toBe(true);
    expect(manager.isToolAllowed('grep_files')).toBe(true);
    expect(manager.isToolAllowed('read_document')).toBe(true);
  });

  it('rejects unlisted tools when allowedTools is non-empty', () => {
    const manager = new ModeManager({ defaultMode: 'ask' });
    // ask mode allows only specific read-only tools
    expect(manager.isToolAllowed('custom-tool')).toBe(false);
    expect(manager.isToolAllowed('schedule_reminder')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ModeManager — getPreferredModel
// ═══════════════════════════════════════════════════════════════════════════════

describe('ModeManager — getPreferredModel', () => {
  it('returns config model for current mode', () => {
    const manager = new ModeManager();
    expect(manager.getPreferredModel()).toBe('qwen3.5:122b');
  });

  it('returns config model for architect mode', () => {
    const manager = new ModeManager({ defaultMode: 'architect' });
    expect(manager.getPreferredModel()).toBe('qwen3.5:122b');
  });

  it('uses custom model mapping if provided', () => {
    const manager = new ModeManager({
      models: { code: 'custom-model:7b' },
    });
    expect(manager.getPreferredModel()).toBe('custom-model:7b');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ModeManager — reset / getAllModes
// ═══════════════════════════════════════════════════════════════════════════════

describe('ModeManager — reset', () => {
  it('resets to default mode', () => {
    const manager = new ModeManager();
    manager.switchMode('architect');
    manager.switchMode('review');
    manager.reset();
    expect(manager.getCurrentModeName()).toBe('code');
    expect(manager.getHistory()).toEqual([]);
    expect(manager.getState().autoDetected).toBe(false);
  });
});

describe('ModeManager — getAllModes', () => {
  it('returns all 4 modes', () => {
    const manager = new ModeManager();
    const modes = manager.getAllModes();
    expect(modes.length).toBe(4);
    const names = modes.map((m) => m.name);
    expect(names).toContain('code');
    expect(names).toContain('architect');
    expect(names).toContain('ask');
    expect(names).toContain('review');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatModeInfo
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatModeInfo', () => {
  it('includes mode name and description', () => {
    const info = formatModeInfo(CODE_MODE);
    expect(info).toContain('Mode: Code');
    expect(info).toContain('Description: Make changes to files');
  });

  it('shows capabilities with checkmarks for code mode', () => {
    const info = formatModeInfo(CODE_MODE);
    expect(info).toContain('Edit files: ✓');
    expect(info).toContain('Create files: ✓');
    expect(info).toContain('Run bash: ✓');
    expect(info).toContain('Git operations: ✓');
  });

  it('shows capabilities with crosses for ask mode', () => {
    const info = formatModeInfo(ASK_MODE);
    expect(info).toContain('Edit files: ✗');
    expect(info).toContain('Run bash: ✗');
    expect(info).toContain('Git operations: ✗');
  });

  it('lists allowed tools', () => {
    const info = formatModeInfo(ARCHITECT_MODE);
    expect(info).toContain('Allowed tools:');
    expect(info).toContain('read_file');
    expect(info).toContain('glob_files');
  });

  it('lists forbidden tools when present', () => {
    const info = formatModeInfo(ARCHITECT_MODE);
    expect(info).toContain('Forbidden tools:');
    expect(info).toContain('edit_file');
    expect(info).toContain('bash');
  });

  it('omits forbidden tools line when empty', () => {
    const info = formatModeInfo(CODE_MODE);
    expect(info).not.toContain('Forbidden tools:');
  });
});
