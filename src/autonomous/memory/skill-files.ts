/**
 * Skill Files — Persistent Skill Definitions (Letta)
 *
 * Manages persistent skill definitions that capture learned capabilities.
 * Each skill represents a task pattern the agent has mastered, with:
 *
 *   - Steps: Ordered actions to accomplish the task
 *   - Preconditions: What must be true before using this skill
 *   - Success criteria: How to verify the skill worked
 *   - Mastery level: How well the agent performs this skill
 *   - Usage tracking: When and how often the skill is used
 *
 * Skills are discovered during active cycles and refined during dream
 * cycles. They serve as reusable procedural memory.
 *
 * Storage: ~/.casterly/memory/skills.json
 *
 * Part of Advanced Memory: Skill Files (Letta).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type MasteryLevel = 'novice' | 'competent' | 'proficient' | 'expert';

/**
 * A persistent skill definition.
 */
export interface SkillFile {
  /** Unique skill ID */
  id: string;

  /** Skill name (e.g., "fix-typescript-errors") */
  name: string;

  /** Description of what this skill does */
  description: string;

  /** Ordered steps to perform this skill */
  steps: string[];

  /** What must be true before applying this skill */
  preconditions: string[];

  /** How to verify the skill was applied correctly */
  successCriteria: string[];

  /** Tags for discovery */
  tags: string[];

  /** Mastery level */
  mastery: MasteryLevel;

  /** Number of times this skill was used */
  useCount: number;

  /** Number of successful uses */
  successCount: number;

  /** ISO timestamp when this skill was first learned */
  learnedAt: string;

  /** ISO timestamp of last use */
  lastUsedAt: string;

  /** ISO timestamp of last refinement */
  lastRefinedAt: string;

  /** Version number (incremented on refinement) */
  version: number;
}

export interface SkillFilesConfig {
  /** Path to the skills file */
  path: string;

  /** Maximum number of skills */
  maxSkills: number;

  /** Minimum success rate to reach 'proficient' */
  proficientThreshold: number;

  /** Minimum success rate to reach 'expert' */
  expertThreshold: number;

  /** Minimum uses to graduate from 'novice' */
  competentMinUses: number;
}

export interface SkillResult {
  success: boolean;
  skillId?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SkillFilesConfig = {
  path: '~/.casterly/memory/skills.json',
  maxSkills: 100,
  proficientThreshold: 0.8,
  expertThreshold: 0.95,
  competentMinUses: 3,
};

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

function generateSkillId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `skill-${ts}-${rand}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill Files Manager
// ─────────────────────────────────────────────────────────────────────────────

export class SkillFilesManager {
  private readonly config: SkillFilesConfig;
  private skills: SkillFile[] = [];
  private loaded: boolean = false;

  constructor(config?: Partial<SkillFilesConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  async load(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    try {
      const content = await readFile(resolvedPath, 'utf8');
      const data = JSON.parse(content) as { skills: SkillFile[] };
      this.skills = data.skills ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        tracer.log('memory', 'warn', 'Failed to load skill files', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.skills = [];
    }

    this.loaded = true;
    tracer.log('memory', 'debug', `Skill files loaded: ${this.skills.length} skills`);
  }

  async save(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(
      resolvedPath,
      JSON.stringify({ skills: this.skills }, null, 2),
      'utf8',
    );

    tracer.log('memory', 'debug', `Skill files saved: ${this.skills.length} skills`);
  }

  // ── Skill Operations ──────────────────────────────────────────────────────

  /**
   * Learn a new skill from a successful task execution.
   */
  learn(params: {
    name: string;
    description: string;
    steps: string[];
    preconditions?: string[];
    successCriteria?: string[];
    tags?: string[];
  }): SkillResult {
    const tracer = getTracer();

    // Check for existing skill with the same name
    const existing = this.skills.find(
      (s) => s.name.toLowerCase() === params.name.toLowerCase(),
    );
    if (existing) {
      return {
        success: false,
        error: `Skill "${params.name}" already exists (${existing.id}). Use refine() to update.`,
      };
    }

    if (this.skills.length >= this.config.maxSkills) {
      // Evict the least-used skill
      this.evictLeastUsed();
    }

    const now = new Date().toISOString();
    const skill: SkillFile = {
      id: generateSkillId(),
      name: params.name,
      description: params.description,
      steps: params.steps,
      preconditions: params.preconditions ?? [],
      successCriteria: params.successCriteria ?? [],
      tags: params.tags ?? [],
      mastery: 'novice',
      useCount: 0,
      successCount: 0,
      learnedAt: now,
      lastUsedAt: now,
      lastRefinedAt: now,
      version: 1,
    };

    this.skills.push(skill);

    tracer.log('memory', 'info', `Skill learned: ${skill.name} (${skill.id})`);

    return { success: true, skillId: skill.id };
  }

  /**
   * Refine an existing skill with updated steps or criteria.
   */
  refine(
    skillId: string,
    updates: {
      steps?: string[];
      preconditions?: string[];
      successCriteria?: string[];
      description?: string;
    },
  ): SkillResult {
    const skill = this.skills.find((s) => s.id === skillId);
    if (!skill) return { success: false, error: `Skill not found: ${skillId}` };

    if (updates.steps) skill.steps = updates.steps;
    if (updates.preconditions) skill.preconditions = updates.preconditions;
    if (updates.successCriteria) skill.successCriteria = updates.successCriteria;
    if (updates.description) skill.description = updates.description;

    skill.version++;
    skill.lastRefinedAt = new Date().toISOString();

    const tracer = getTracer();
    tracer.log('memory', 'info', `Skill refined: ${skill.name} v${skill.version}`);

    return { success: true, skillId };
  }

  /**
   * Record a use of a skill and whether it succeeded.
   */
  recordUse(skillId: string, success: boolean): boolean {
    const skill = this.skills.find((s) => s.id === skillId);
    if (!skill) return false;

    skill.useCount++;
    if (success) skill.successCount++;
    skill.lastUsedAt = new Date().toISOString();

    // Update mastery level
    this.updateMastery(skill);

    return true;
  }

  /**
   * Remove a skill by ID.
   */
  remove(skillId: string): boolean {
    const idx = this.skills.findIndex((s) => s.id === skillId);
    if (idx < 0) return false;
    this.skills.splice(idx, 1);
    return true;
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  /**
   * Find skills matching a query (searches name, description, tags).
   */
  search(query: string): SkillFile[] {
    const lower = query.toLowerCase();
    return this.skills.filter(
      (s) =>
        s.name.toLowerCase().includes(lower) ||
        s.description.toLowerCase().includes(lower) ||
        s.tags.some((t) => t.toLowerCase().includes(lower)),
    );
  }

  /**
   * Get skills by mastery level.
   */
  getByMastery(level: MasteryLevel): SkillFile[] {
    return this.skills.filter((s) => s.mastery === level);
  }

  /**
   * Get a skill by ID.
   */
  getById(id: string): SkillFile | undefined {
    return this.skills.find((s) => s.id === id);
  }

  /**
   * Get a skill by name.
   */
  getByName(name: string): SkillFile | undefined {
    return this.skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
  }

  /**
   * Get all skills sorted by use count (most used first).
   */
  getAll(): ReadonlyArray<SkillFile> {
    return [...this.skills].sort((a, b) => b.useCount - a.useCount);
  }

  count(): number {
    return this.skills.length;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Get the success rate for a skill.
   */
  getSuccessRate(skillId: string): number | null {
    const skill = this.skills.find((s) => s.id === skillId);
    if (!skill || skill.useCount === 0) return null;
    return skill.successCount / skill.useCount;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private updateMastery(skill: SkillFile): void {
    if (skill.useCount < this.config.competentMinUses) {
      skill.mastery = 'novice';
      return;
    }

    const successRate = skill.successCount / skill.useCount;

    if (successRate >= this.config.expertThreshold) {
      skill.mastery = 'expert';
    } else if (successRate >= this.config.proficientThreshold) {
      skill.mastery = 'proficient';
    } else {
      skill.mastery = 'competent';
    }
  }

  private evictLeastUsed(): void {
    if (this.skills.length === 0) return;

    let leastIdx = 0;
    let leastUses = this.skills[0]!.useCount;

    for (let i = 1; i < this.skills.length; i++) {
      if (this.skills[i]!.useCount < leastUses) {
        leastIdx = i;
        leastUses = this.skills[i]!.useCount;
      }
    }

    this.skills.splice(leastIdx, 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createSkillFilesManager(
  config?: Partial<SkillFilesConfig>,
): SkillFilesManager {
  return new SkillFilesManager(config);
}
