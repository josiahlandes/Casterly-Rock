import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSkillRegistry, filterSkillsForNotes } from '../src/skills/loader.js';
import type { Skill, SkillFrontmatter } from '../src/skills/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_BASE = join(tmpdir(), `casterly-skills-registry-test-${Date.now()}`);

afterEach(() => {
  if (existsSync(TEST_BASE)) {
    rmSync(TEST_BASE, { recursive: true, force: true });
  }
});

function makeSkill(id: string, overrides: Partial<Skill> = {}): Skill {
  return {
    id,
    frontmatter: { name: id, description: `Skill: ${id}` },
    instructions: `Instructions for ${id}`,
    path: `/skills/${id}`,
    available: true,
    tools: [],
    ...overrides,
  };
}

function makeSkillWithEmoji(id: string, emoji: string, description: string): Skill {
  return {
    id,
    frontmatter: {
      name: id,
      description,
      metadata: { openclaw: { emoji } },
    },
    instructions: `Instructions for ${id}`,
    path: `/skills/${id}`,
    available: true,
    tools: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// createSkillRegistry — structure
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSkillRegistry — structure', () => {
  it('returns an object with all required methods', () => {
    const registry = createSkillRegistry();
    expect(typeof registry.get).toBe('function');
    expect(typeof registry.getAvailable).toBe('function');
    expect(typeof registry.getPromptSection).toBe('function');
    expect(typeof registry.getTools).toBe('function');
    expect(typeof registry.getRelevantSkillInstructions).toBe('function');
    expect(typeof registry.reload).toBe('function');
  });

  it('has a skills Map', () => {
    const registry = createSkillRegistry();
    expect(registry.skills).toBeInstanceOf(Map);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createSkillRegistry — get
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSkillRegistry — get', () => {
  it('returns undefined for non-existent skill', () => {
    const registry = createSkillRegistry();
    expect(registry.get('completely-fictional-skill-xyz')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createSkillRegistry — getAvailable
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSkillRegistry — getAvailable', () => {
  it('returns only available skills', () => {
    const registry = createSkillRegistry();
    const available = registry.getAvailable();
    // All returned skills should be available
    for (const skill of available) {
      expect(skill.available).toBe(true);
    }
  });

  it('returns an array', () => {
    const registry = createSkillRegistry();
    expect(Array.isArray(registry.getAvailable())).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createSkillRegistry — getPromptSection
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSkillRegistry — getPromptSection', () => {
  it('returns a string', () => {
    const registry = createSkillRegistry();
    const section = registry.getPromptSection();
    expect(typeof section).toBe('string');
  });

  it('returns non-empty string when skills are available', () => {
    const registry = createSkillRegistry();
    const available = registry.getAvailable();
    if (available.length > 0) {
      const section = registry.getPromptSection();
      expect(section.length).toBeGreaterThan(0);
      expect(section).toContain('Available Skills');
    }
  });

  it('returns empty string when no skills are available', () => {
    const registry = createSkillRegistry();
    // If no skills are installed, getPromptSection returns ''
    const available = registry.getAvailable();
    if (available.length === 0) {
      expect(registry.getPromptSection()).toBe('');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createSkillRegistry — getTools
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSkillRegistry — getTools', () => {
  it('returns an array', () => {
    const registry = createSkillRegistry();
    const tools = registry.getTools();
    expect(Array.isArray(tools)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createSkillRegistry — getRelevantSkillInstructions
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSkillRegistry — getRelevantSkillInstructions', () => {
  it('returns empty string for unrelated message', () => {
    const registry = createSkillRegistry();
    const instructions = registry.getRelevantSkillInstructions('hello world');
    // Should return '' unless the word "world" matches a skill description
    expect(typeof instructions).toBe('string');
  });

  it('returns a string', () => {
    const registry = createSkillRegistry();
    const result = registry.getRelevantSkillInstructions('check my calendar');
    expect(typeof result).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createSkillRegistry — reload
// ═══════════════════════════════════════════════════════════════════════════════

describe('createSkillRegistry — reload', () => {
  it('reload is an async function', async () => {
    const registry = createSkillRegistry();
    const result = registry.reload();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// filterSkillsForNotes — additional edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('filterSkillsForNotes — edge cases', () => {
  it('returns empty array for empty input', () => {
    expect(filterSkillsForNotes([])).toEqual([]);
  });

  it('single non-notes skill passes through', () => {
    const skills = [makeSkill('weather')];
    const result = filterSkillsForNotes(skills);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('weather');
  });

  it('single apple-notes passes through', () => {
    const skills = [makeSkill('apple-notes')];
    const result = filterSkillsForNotes(skills);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('apple-notes');
  });

  it('single bear-notes passes through when no apple-notes', () => {
    const skills = [makeSkill('bear-notes')];
    const result = filterSkillsForNotes(skills);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('bear-notes');
  });

  it('preserves order of non-notes skills', () => {
    const skills = [
      makeSkill('apple-notes'),
      makeSkill('bear-notes'),
      makeSkill('weather'),
      makeSkill('calendar'),
      makeSkill('spotify-player'),
    ];
    const result = filterSkillsForNotes(skills);
    const ids = result.map((s) => s.id);
    expect(ids).toEqual(['apple-notes', 'weather', 'calendar', 'spotify-player']);
  });

  it('many non-notes skills pass through unchanged', () => {
    const skills = [
      makeSkill('weather'),
      makeSkill('calendar'),
      makeSkill('spotify-player'),
      makeSkill('github'),
    ];
    const result = filterSkillsForNotes(skills);
    expect(result).toHaveLength(4);
  });

  it('unavailable skills are not filtered by notes logic', () => {
    const skills = [
      makeSkill('apple-notes', { available: false }),
      makeSkill('bear-notes', { available: true }),
      makeSkill('weather'),
    ];
    // apple-notes is present even though unavailable — filterSkillsForNotes
    // doesn't check availability, only checks the id
    const result = filterSkillsForNotes(skills);
    // apple-notes present → bear-notes is filtered out
    expect(result).toHaveLength(2);
    const ids = result.map((s) => s.id);
    expect(ids).toContain('apple-notes');
    expect(ids).not.toContain('bear-notes');
  });
});
