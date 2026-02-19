/**
 * Challenge Generator — Adversarial Dual-Model Self-Testing (Vision Tier 3)
 *
 * During dream cycles, generates challenges in domains where the self-model
 * reports low confidence. The coding model generates challenges and the
 * reasoning model attempts them. Results feed back into the self-model
 * with higher fidelity than real-task tracking.
 *
 * Three modes:
 *   1. Challenge Generation — domain-specific coding challenges
 *   2. Adversarial Code Review — intentionally buggy code for detection
 *   3. Strategy Debate — two models propose and critique approaches
 *
 * Privacy: All challenge generation and evaluation is local.
 * No user data is involved — challenges are synthetic.
 */

import { getTracer } from '../debug.js';
import type { SelfModel, SkillAssessment } from './self-model.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single challenge for self-testing.
 */
export interface Challenge {
  /** Unique identifier */
  id: string;

  /** Which skill domain this tests */
  skill: string;

  /** Optional sub-skill for granular tracking */
  subSkill?: string;

  /** The challenge type */
  type: ChallengeType;

  /** Difficulty level (1-5) */
  difficulty: number;

  /** The challenge prompt/description */
  prompt: string;

  /** Expected solution or criteria for success */
  expectedSolution: string;

  /** Time limit in seconds for attempting this challenge */
  timeLimitSeconds: number;
}

/**
 * Types of challenges that can be generated.
 */
export type ChallengeType =
  | 'code_completion'
  | 'bug_detection'
  | 'regex_construction'
  | 'refactoring_decision'
  | 'security_review';

/**
 * Result of attempting a challenge.
 */
export interface ChallengeResult {
  /** The challenge that was attempted */
  challengeId: string;

  /** Whether the challenge was passed */
  passed: boolean;

  /** The response given */
  response: string;

  /** Why the result was scored this way */
  evaluation: string;

  /** Duration in milliseconds */
  durationMs: number;

  /** Skill and sub-skill for self-model update */
  skill: string;
  subSkill?: string;
}

/**
 * A batch of challenges and their results.
 */
export interface ChallengeBatch {
  /** Unique batch identifier */
  id: string;

  /** When this batch was generated */
  timestamp: string;

  /** The cycle that generated this batch */
  cycleId: string;

  /** The challenges in this batch */
  challenges: Challenge[];

  /** Results (filled in after evaluation) */
  results: ChallengeResult[];

  /** Summary statistics */
  summary?: ChallengeBatchSummary;
}

/**
 * Summary of a challenge batch's outcomes.
 */
export interface ChallengeBatchSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  bySkill: Record<string, { total: number; passed: number; rate: number }>;
  bySubSkill: Record<string, { total: number; passed: number; rate: number }>;
  weakestAreas: string[];
}

/**
 * Configuration for challenge generation.
 */
export interface ChallengeGeneratorConfig {
  /** Maximum challenges per batch */
  challengeBudget: number;

  /** Whether to prioritize weak skills */
  prioritizeWeakSkills: boolean;

  /** Challenge types to include */
  challengeTypes: ChallengeType[];

  /** Time limit per challenge in seconds */
  defaultTimeLimitSeconds: number;

  /** Minimum difficulty (1-5) */
  minDifficulty: number;

  /** Maximum difficulty (1-5) */
  maxDifficulty: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ChallengeGeneratorConfig = {
  challengeBudget: 20,
  prioritizeWeakSkills: true,
  challengeTypes: [
    'code_completion',
    'bug_detection',
    'regex_construction',
    'refactoring_decision',
    'security_review',
  ],
  defaultTimeLimitSeconds: 60,
  minDifficulty: 1,
  maxDifficulty: 5,
};

/**
 * Sub-skill definitions for granular tracking.
 */
const SUB_SKILL_MAP: Record<string, string[]> = {
  regex: ['lookaheads', 'backreferences', 'character_classes', 'quantifiers', 'groups'],
  'typescript-types': ['generics', 'conditional_types', 'mapped_types', 'utility_types', 'overloads'],
  testing: ['unit_tests', 'integration_tests', 'mocking', 'edge_cases', 'assertions'],
  security: ['injection', 'xss', 'path_traversal', 'auth_bypass', 'secrets_exposure'],
  refactoring: ['extract_function', 'rename', 'inline', 'decompose', 'simplify'],
  parsing: ['json', 'yaml', 'csv', 'custom_format', 'error_recovery'],
  performance: ['time_complexity', 'space_complexity', 'caching', 'lazy_eval', 'batching'],
  concurrency: ['race_conditions', 'deadlocks', 'async_await', 'promises', 'streams'],
};

/**
 * Challenge templates per type. Each template generates a prompt when
 * combined with a skill domain and difficulty level.
 */
const CHALLENGE_TEMPLATES: Record<ChallengeType, (skill: string, subSkill: string, difficulty: number) => { prompt: string; expectedSolution: string }> = {
  code_completion: (skill, subSkill, difficulty) => ({
    prompt: `Write a ${skill} function (sub-area: ${subSkill}) at difficulty ${difficulty}/5. The function should handle edge cases and follow best practices.`,
    expectedSolution: `A correct, well-structured implementation handling edge cases for ${skill}/${subSkill} at difficulty ${difficulty}.`,
  }),
  bug_detection: (skill, subSkill, difficulty) => ({
    prompt: `Find the ${difficulty} bug(s) in this ${skill} code (sub-area: ${subSkill}). Explain each bug and how to fix it.`,
    expectedSolution: `All ${difficulty} bugs identified with correct explanations and fixes for ${skill}/${subSkill}.`,
  }),
  regex_construction: (_skill, subSkill, difficulty) => ({
    prompt: `Write a regex pattern using ${subSkill} techniques at difficulty ${difficulty}/5. The pattern should be correct and efficient.`,
    expectedSolution: `A correct regex using ${subSkill} that passes all test cases at difficulty ${difficulty}.`,
  }),
  refactoring_decision: (skill, subSkill, difficulty) => ({
    prompt: `Given this ${skill} code (${subSkill}), decide whether and how to refactor it. Difficulty: ${difficulty}/5.`,
    expectedSolution: `Correct refactoring decision with sound reasoning for ${skill}/${subSkill} at difficulty ${difficulty}.`,
  }),
  security_review: (skill, subSkill, difficulty) => ({
    prompt: `Review this ${skill} code for ${subSkill} vulnerabilities. Difficulty: ${difficulty}/5 hidden security issues.`,
    expectedSolution: `All security issues found with correct explanations for ${skill}/${subSkill} at difficulty ${difficulty}.`,
  }),
};

// ─────────────────────────────────────────────────────────────────────────────
// Challenge Generator
// ─────────────────────────────────────────────────────────────────────────────

export class ChallengeGenerator {
  private readonly config: ChallengeGeneratorConfig;

  constructor(config?: Partial<ChallengeGeneratorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate a batch of challenges prioritized by self-model weaknesses.
   */
  generateBatch(selfModel: SelfModel, cycleId: string): ChallengeBatch {
    const tracer = getTracer();
    const weaknesses = selfModel.getWeaknesses();
    const strengths = selfModel.getStrengths();
    const allSkills = selfModel.getData().skills;

    // Determine skill allocation
    const skillAllocation = this.allocateSkills(weaknesses, strengths, allSkills);

    const challenges: Challenge[] = [];
    let challengeIndex = 0;

    for (const { skill, count, assessedRate } of skillAllocation) {
      if (challenges.length >= this.config.challengeBudget) break;

      const subSkills = SUB_SKILL_MAP[skill] ?? ['general'];
      const challengesForSkill = Math.min(count, this.config.challengeBudget - challenges.length);

      for (let i = 0; i < challengesForSkill; i++) {
        const subSkill = subSkills[i % subSkills.length] ?? 'general';
        const type = this.selectChallengeType(skill);
        const difficulty = this.selectDifficulty(assessedRate);

        const template = CHALLENGE_TEMPLATES[type];
        const { prompt, expectedSolution } = template(skill, subSkill, difficulty);

        challenges.push({
          id: `ch-${cycleId}-${challengeIndex++}`,
          skill,
          subSkill,
          type,
          difficulty,
          prompt,
          expectedSolution,
          timeLimitSeconds: this.config.defaultTimeLimitSeconds,
        });
      }
    }

    tracer.log('dream', 'info', `Generated ${challenges.length} challenges`, {
      skills: [...new Set(challenges.map((c) => c.skill))],
      types: [...new Set(challenges.map((c) => c.type))],
    });

    return {
      id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      cycleId,
      challenges,
      results: [],
    };
  }

  /**
   * Evaluate challenge results and produce a summary.
   */
  summarizeBatch(batch: ChallengeBatch): ChallengeBatchSummary {
    const passed = batch.results.filter((r) => r.passed).length;
    const total = batch.results.length;

    const bySkill: Record<string, { total: number; passed: number; rate: number }> = {};
    const bySubSkill: Record<string, { total: number; passed: number; rate: number }> = {};

    for (const result of batch.results) {
      // Track by skill
      const skillKey = result.skill;
      const skillData = bySkill[skillKey] ?? { total: 0, passed: 0, rate: 0 };
      skillData.total++;
      if (result.passed) skillData.passed++;
      skillData.rate = skillData.passed / skillData.total;
      bySkill[skillKey] = skillData;

      // Track by sub-skill
      if (result.subSkill) {
        const subKey = `${result.skill}.${result.subSkill}`;
        const subData = bySubSkill[subKey] ?? { total: 0, passed: 0, rate: 0 };
        subData.total++;
        if (result.passed) subData.passed++;
        subData.rate = subData.passed / subData.total;
        bySubSkill[subKey] = subData;
      }
    }

    // Find weakest areas (sub-skills with lowest pass rates, min 2 samples)
    const weakestAreas = Object.entries(bySubSkill)
      .filter(([, data]) => data.total >= 2)
      .sort(([, a], [, b]) => a.rate - b.rate)
      .slice(0, 5)
      .map(([key]) => key);

    const summary: ChallengeBatchSummary = {
      total,
      passed,
      failed: total - passed,
      passRate: total > 0 ? passed / total : 0,
      bySkill,
      bySubSkill,
      weakestAreas,
    };

    batch.summary = summary;
    return summary;
  }

  /**
   * Build a formatted report of challenge results for logging.
   */
  formatReport(batch: ChallengeBatch): string {
    const summary = batch.summary ?? this.summarizeBatch(batch);
    const lines: string[] = [
      `Challenge Batch Report (${batch.id})`,
      `Generated: ${batch.timestamp}`,
      `Overall: ${summary.passed}/${summary.total} passed (${Math.round(summary.passRate * 100)}%)`,
      '',
      'By Skill:',
    ];

    for (const [skill, data] of Object.entries(summary.bySkill)) {
      lines.push(`  ${skill}: ${data.passed}/${data.total} (${Math.round(data.rate * 100)}%)`);
    }

    if (summary.weakestAreas.length > 0) {
      lines.push('');
      lines.push('Weakest Sub-Skills:');
      for (const area of summary.weakestAreas) {
        const data = summary.bySubSkill[area];
        if (data) {
          lines.push(`  ${area}: ${data.passed}/${data.total} (${Math.round(data.rate * 100)}%)`);
        }
      }
    }

    return lines.join('\n');
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Allocate challenges across skills based on priorities.
   */
  private allocateSkills(
    weaknesses: SkillAssessment[],
    _strengths: SkillAssessment[],
    allSkills: readonly SkillAssessment[],
  ): Array<{ skill: string; count: number; assessedRate: number }> {
    const allocation: Array<{ skill: string; count: number; assessedRate: number }> = [];
    const budget = this.config.challengeBudget;

    if (this.config.prioritizeWeakSkills && weaknesses.length > 0) {
      // Give 60% of budget to weak skills, 40% to others
      const weakBudget = Math.ceil(budget * 0.6);
      const otherBudget = budget - weakBudget;

      // Allocate weak skills
      const perWeak = Math.max(1, Math.floor(weakBudget / weaknesses.length));
      for (const w of weaknesses) {
        allocation.push({
          skill: w.skill,
          count: Math.min(perWeak, 10),
          assessedRate: w.successRate,
        });
      }

      // Allocate remaining budget to other skills
      const otherSkills = allSkills.filter(
        (s) => !weaknesses.some((w) => w.skill === s.skill),
      );
      if (otherSkills.length > 0) {
        const perOther = Math.max(1, Math.floor(otherBudget / otherSkills.length));
        for (const s of otherSkills.slice(0, 5)) {
          allocation.push({
            skill: s.skill,
            count: Math.min(perOther, 5),
            assessedRate: s.successRate,
          });
        }
      }
    } else {
      // Even distribution
      const skillList = allSkills.length > 0
        ? allSkills
        : [{ skill: 'general', successRate: 0.5, sampleSize: 0, successes: 0, failures: 0, lastAssessed: '' }];
      const perSkill = Math.max(1, Math.floor(budget / skillList.length));
      for (const s of skillList) {
        allocation.push({
          skill: s.skill,
          count: Math.min(perSkill, 10),
          assessedRate: s.successRate,
        });
      }
    }

    return allocation;
  }

  /**
   * Select a challenge type appropriate for the skill.
   */
  private selectChallengeType(skill: string): ChallengeType {
    const available = this.config.challengeTypes;

    // Skill-specific preferences
    if (skill === 'regex') return available.includes('regex_construction') ? 'regex_construction' : available[0]!;
    if (skill === 'security') return available.includes('security_review') ? 'security_review' : available[0]!;
    if (skill === 'refactoring') return available.includes('refactoring_decision') ? 'refactoring_decision' : available[0]!;

    // Default: rotate through types
    const index = Math.floor(Math.random() * available.length);
    return available[index]!;
  }

  /**
   * Select difficulty based on current assessed success rate.
   * Low success rate → easier challenges. High → harder.
   */
  private selectDifficulty(assessedRate: number): number {
    const { minDifficulty, maxDifficulty } = this.config;
    const range = maxDifficulty - minDifficulty;

    // Scale difficulty: 0% success → min difficulty, 100% → max difficulty
    const scaled = minDifficulty + Math.round(assessedRate * range);
    return Math.max(minDifficulty, Math.min(maxDifficulty, scaled));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createChallengeGenerator(
  config?: Partial<ChallengeGeneratorConfig>,
): ChallengeGenerator {
  return new ChallengeGenerator(config);
}
