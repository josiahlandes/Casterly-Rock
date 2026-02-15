import { describe, expect, it } from 'vitest';

import { filterSkillsForNotes } from '../src/skills/loader.js';
import type { Skill } from '../src/skills/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════════════════════════════
// filterSkillsForNotes
// ═══════════════════════════════════════════════════════════════════════════════

describe('filterSkillsForNotes', () => {
  it('returns all skills when no notes skills present', () => {
    const skills = [makeSkill('weather'), makeSkill('calendar')];
    const result = filterSkillsForNotes(skills);
    expect(result).toHaveLength(2);
  });

  it('returns all skills when only non-preferred notes skill present', () => {
    // bear-notes is a notes skill but not the preferred one (apple-notes)
    // When the preferred one is absent, all skills pass through
    const skills = [makeSkill('bear-notes'), makeSkill('weather')];
    const result = filterSkillsForNotes(skills);
    expect(result).toHaveLength(2);
  });

  it('keeps only apple-notes when both notes skills present', () => {
    const skills = [
      makeSkill('apple-notes'),
      makeSkill('bear-notes'),
      makeSkill('weather'),
    ];
    const result = filterSkillsForNotes(skills);
    expect(result).toHaveLength(2);
    const ids = result.map((s) => s.id);
    expect(ids).toContain('apple-notes');
    expect(ids).toContain('weather');
    expect(ids).not.toContain('bear-notes');
  });

  it('keeps apple-notes when it is the only notes skill', () => {
    const skills = [makeSkill('apple-notes'), makeSkill('calendar')];
    const result = filterSkillsForNotes(skills);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id)).toContain('apple-notes');
  });

  it('handles empty array', () => {
    expect(filterSkillsForNotes([])).toEqual([]);
  });

  it('does not affect non-notes skills', () => {
    const skills = [
      makeSkill('apple-notes'),
      makeSkill('bear-notes'),
      makeSkill('weather'),
      makeSkill('calendar'),
      makeSkill('spotify-player'),
    ];
    const result = filterSkillsForNotes(skills);
    const ids = result.map((s) => s.id);
    expect(ids).toContain('weather');
    expect(ids).toContain('calendar');
    expect(ids).toContain('spotify-player');
  });
});
