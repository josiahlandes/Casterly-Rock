import { describe, expect, it } from 'vitest';

import { filterSkillsForNotes } from '../src/skills/loader.js';
import type { Skill } from '../src/skills/types.js';

function makeSkill(id: string, available = true): Skill {
  return {
    id,
    available,
    frontmatter: { name: id, description: `${id} skill` },
    instructions: '',
    path: `/tmp/${id}`
  };
}

describe('filterSkillsForNotes', () => {
  it('prefers apple-notes when available', () => {
    const skills = [
      makeSkill('apple-notes'),
      makeSkill('bear-notes'),
      makeSkill('weather')
    ];

    const result = filterSkillsForNotes(skills);

    expect(result.map((skill) => skill.id)).toEqual(['apple-notes', 'weather']);
  });

  it('keeps bear-notes when apple-notes is absent', () => {
    const skills = [
      makeSkill('bear-notes'),
      makeSkill('weather')
    ];

    const result = filterSkillsForNotes(skills);

    expect(result.map((skill) => skill.id)).toEqual(['bear-notes', 'weather']);
  });
});
