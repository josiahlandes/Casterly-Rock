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

// ═══════════════════════════════════════════════════════════════════════════════
// Mode constants — structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('Mode constants — structure', () => {
  const allModes = [CODE_MODE, ARCHITECT_MODE, ASK_MODE, REVIEW_MODE];

  it('all modes have required fields', () => {
    for (const mode of allModes) {
      expect(mode.name).toBeTruthy();
      expect(mode.displayName).toBeTruthy();
      expect(mode.description).toBeTruthy();
      expect(mode.systemPrompt).toBeTruthy();
      expect(Array.isArray(mode.allowedTools)).toBe(true);
      expect(Array.isArray(mode.forbiddenTools)).toBe(true);
      expect(typeof mode.canEdit).toBe('boolean');
      expect(typeof mode.canCreate).toBe('boolean');
      expect(typeof mode.canDelete).toBe('boolean');
      expect(typeof mode.canBash).toBe('boolean');
      expect(typeof mode.canGit).toBe('boolean');
      expect(mode.preferredModel).toBeTruthy();
      expect(mode.fallbackModel).toBeTruthy();
    }
  });

  it('all modes have unique names', () => {
    const names = allModes.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CODE_MODE
// ═══════════════════════════════════════════════════════════════════════════════

describe('CODE_MODE', () => {
  it('has name "code"', () => {
    expect(CODE_MODE.name).toBe('code');
  });

  it('can edit, create, delete, bash, git', () => {
    expect(CODE_MODE.canEdit).toBe(true);
    expect(CODE_MODE.canCreate).toBe(true);
    expect(CODE_MODE.canDelete).toBe(true);
    expect(CODE_MODE.canBash).toBe(true);
    expect(CODE_MODE.canGit).toBe(true);
  });

  it('has empty allowedTools (all tools permitted)', () => {
    expect(CODE_MODE.allowedTools).toEqual([]);
  });

  it('has no forbidden tools', () => {
    expect(CODE_MODE.forbiddenTools).toHaveLength(0);
  });

  it('prefers qwen3-coder-next', () => {
    expect(CODE_MODE.preferredModel).toContain('qwen3-coder');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ARCHITECT_MODE
// ═══════════════════════════════════════════════════════════════════════════════

describe('ARCHITECT_MODE', () => {
  it('has name "architect"', () => {
    expect(ARCHITECT_MODE.name).toBe('architect');
  });

  it('cannot edit, create, delete, bash, git', () => {
    expect(ARCHITECT_MODE.canEdit).toBe(false);
    expect(ARCHITECT_MODE.canCreate).toBe(false);
    expect(ARCHITECT_MODE.canDelete).toBe(false);
    expect(ARCHITECT_MODE.canBash).toBe(false);
    expect(ARCHITECT_MODE.canGit).toBe(false);
  });

  it('forbids edit_file, write_file, bash, send_message', () => {
    expect(ARCHITECT_MODE.forbiddenTools).toContain('edit_file');
    expect(ARCHITECT_MODE.forbiddenTools).toContain('write_file');
    expect(ARCHITECT_MODE.forbiddenTools).toContain('bash');
    expect(ARCHITECT_MODE.forbiddenTools).toContain('send_message');
  });

  it('allows read_file, glob_files, grep_files', () => {
    expect(ARCHITECT_MODE.allowedTools).toContain('read_file');
    expect(ARCHITECT_MODE.allowedTools).toContain('glob_files');
    expect(ARCHITECT_MODE.allowedTools).toContain('grep_files');
  });

  it('prefers qwen3.5:122b', () => {
    expect(ARCHITECT_MODE.preferredModel).toContain('qwen3.5');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ASK_MODE
// ═══════════════════════════════════════════════════════════════════════════════

describe('ASK_MODE', () => {
  it('has name "ask"', () => {
    expect(ASK_MODE.name).toBe('ask');
  });

  it('cannot edit or execute', () => {
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

// ═══════════════════════════════════════════════════════════════════════════════
// REVIEW_MODE
// ═══════════════════════════════════════════════════════════════════════════════

describe('REVIEW_MODE', () => {
  it('has name "review"', () => {
    expect(REVIEW_MODE.name).toBe('review');
  });

  it('cannot edit or execute', () => {
    expect(REVIEW_MODE.canEdit).toBe(false);
    expect(REVIEW_MODE.canBash).toBe(false);
  });

  it('prefers qwen3-coder-next for code review', () => {
    expect(REVIEW_MODE.preferredModel).toContain('qwen3-coder');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MODES record
// ═══════════════════════════════════════════════════════════════════════════════

describe('MODES record', () => {
  it('has 4 modes', () => {
    expect(Object.keys(MODES)).toHaveLength(4);
  });

  it('maps names to correct mode objects', () => {
    expect(MODES.code).toBe(CODE_MODE);
    expect(MODES.architect).toBe(ARCHITECT_MODE);
    expect(MODES.ask).toBe(ASK_MODE);
    expect(MODES.review).toBe(REVIEW_MODE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getMode
// ═══════════════════════════════════════════════════════════════════════════════

describe('getMode', () => {
  it('returns CODE_MODE for "code"', () => {
    expect(getMode('code')).toBe(CODE_MODE);
  });

  it('returns ARCHITECT_MODE for "architect"', () => {
    expect(getMode('architect')).toBe(ARCHITECT_MODE);
  });

  it('returns ASK_MODE for "ask"', () => {
    expect(getMode('ask')).toBe(ASK_MODE);
  });

  it('returns REVIEW_MODE for "review"', () => {
    expect(getMode('review')).toBe(REVIEW_MODE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getModeNames
// ═══════════════════════════════════════════════════════════════════════════════

describe('getModeNames', () => {
  it('returns 4 mode names', () => {
    expect(getModeNames()).toHaveLength(4);
  });

  it('includes all mode names', () => {
    const names = getModeNames();
    expect(names).toContain('code');
    expect(names).toContain('architect');
    expect(names).toContain('ask');
    expect(names).toContain('review');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// isValidMode
// ═══════════════════════════════════════════════════════════════════════════════

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
    expect(isValidMode('CODE')).toBe(false);
    expect(isValidMode('debug')).toBe(false);
  });
});
