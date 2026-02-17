/**
 * Self-Model — Tyrion's computed understanding of his own capabilities
 *
 * The self-model is rebuilt periodically from historical data:
 *   - Issue log: what categories of problems have been attempted and
 *     their outcomes (success/failure rates per domain).
 *   - Reflections: patterns in what worked and what didn't.
 *
 * The output is a structured assessment of strengths (>70% success rate)
 * and weaknesses (<50% success rate), stored at ~/.casterly/self-model.yaml.
 *
 * The self-model feeds into:
 *   - The identity prompt (Phase 1): "Be careful with regex (40% success)."
 *   - The reasoning scaler (Phase 5): escalate difficulty for weak domains.
 *   - Dream cycles: identify areas to practice/explore.
 *
 * Privacy: The self-model contains only aggregate statistics about
 * Tyrion's performance. No sensitive user data.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import YAML from 'yaml';
import { getTracer } from '../debug.js';
import type { IssueLog } from '../issue-log.js';
import type { Reflector } from '../reflector.js';
import type { Reflection } from '../types.js';
import type { SelfModelSummary } from '../identity.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single skill assessment.
 */
export interface SkillAssessment {
  /** The skill/domain name */
  skill: string;

  /** Success rate (0.0 - 1.0) */
  successRate: number;

  /** Total number of attempts */
  sampleSize: number;

  /** Number of successes */
  successes: number;

  /** Number of failures */
  failures: number;

  /** Last assessed timestamp */
  lastAssessed: string;
}

/**
 * The full self-model data structure (stored in YAML).
 */
export interface SelfModelData {
  /** When this model was last rebuilt */
  lastRebuilt: string;

  /** All assessed skills */
  skills: SkillAssessment[];

  /** Learned preferences (patterns that tend to work) */
  preferences: string[];

  /** Version counter for tracking changes */
  version: number;
}

/**
 * Configuration for the self-model.
 */
export interface SelfModelConfig {
  /** Path to the self-model YAML file */
  path: string;

  /** Minimum sample size for a skill to be assessed */
  minSampleSize: number;

  /** Threshold above which a skill is a "strength" */
  strengthThreshold: number;

  /** Threshold below which a skill is a "weakness" */
  weaknessThreshold: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SelfModelConfig = {
  path: '~/.casterly/self-model.yaml',
  minSampleSize: 3,
  strengthThreshold: 0.7,
  weaknessThreshold: 0.5,
};

/**
 * Map issue tags/titles to skill domains for assessment.
 */
const SKILL_PATTERNS: Array<{ pattern: RegExp; skill: string }> = [
  { pattern: /\bregex\b/i, skill: 'regex' },
  { pattern: /\btypes?\b|typescript/i, skill: 'typescript-types' },
  { pattern: /\btest\b|testing/i, skill: 'testing' },
  { pattern: /\brefactor/i, skill: 'refactoring' },
  { pattern: /\bsecurity\b|vulnerab/i, skill: 'security' },
  { pattern: /\bperformance\b|optimi/i, skill: 'performance' },
  { pattern: /\bconcurrenc|async|race/i, skill: 'concurrency' },
  { pattern: /\bpars(?:e|ing)\b/i, skill: 'parsing' },
  { pattern: /\bconfig/i, skill: 'configuration' },
  { pattern: /\bgit\b/i, skill: 'git-operations' },
  { pattern: /\bbug\s*fix|fix\b/i, skill: 'bug-fixing' },
  { pattern: /\bdocument/i, skill: 'documentation' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Self-Model
// ─────────────────────────────────────────────────────────────────────────────

export class SelfModel {
  private readonly config: SelfModelConfig;
  private data: SelfModelData;

  constructor(config?: Partial<SelfModelConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.data = {
      lastRebuilt: new Date().toISOString(),
      skills: [],
      preferences: [],
      version: 0,
    };
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  /**
   * Load the self-model from disk.
   */
  async load(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = this.config.path.replace(/^~/, process.env['HOME'] ?? '~');

    try {
      const content = await readFile(resolvedPath, 'utf8');
      const parsed = YAML.parse(content) as SelfModelData;
      if (parsed && typeof parsed === 'object') {
        this.data = parsed;
        tracer.log('dream', 'debug', `Self-model loaded: ${this.data.skills.length} skills`);
      }
    } catch {
      tracer.log('dream', 'debug', 'No existing self-model found, starting fresh');
    }
  }

  /**
   * Save the self-model to disk.
   */
  async save(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = this.config.path.replace(/^~/, process.env['HOME'] ?? '~');

    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, YAML.stringify(this.data), 'utf8');

    tracer.log('dream', 'info', `Self-model saved: ${this.data.skills.length} skills, v${this.data.version}`);
  }

  // ── Rebuild ─────────────────────────────────────────────────────────────

  /**
   * Rebuild the self-model from issue log and reflections.
   * This is the main entry point — called during dream cycles.
   */
  async rebuild(issueLog: IssueLog, reflector: Reflector): Promise<void> {
    const tracer = getTracer();

    return tracer.withSpan('dream', 'rebuildSelfModel', async () => {
      const issues = issueLog.getData().issues;
      const reflections = await reflector.loadRecentReflections(200);

      // Count outcomes per skill domain
      const skillCounts = new Map<string, { successes: number; failures: number }>();

      // Analyze issues
      for (const issue of issues) {
        const skills = this.classifySkills(issue.title + ' ' + issue.description);
        const succeeded = issue.status === 'resolved';

        for (const skill of skills) {
          const counts = skillCounts.get(skill) ?? { successes: 0, failures: 0 };
          if (succeeded) {
            counts.successes++;
          } else {
            counts.failures++;
          }
          skillCounts.set(skill, counts);
        }
      }

      // Analyze reflections
      for (const reflection of reflections) {
        const text = reflection.observation.suggestedArea + ' ' + reflection.learnings;
        const skills = this.classifySkills(text);
        const succeeded = reflection.outcome === 'success';

        for (const skill of skills) {
          const counts = skillCounts.get(skill) ?? { successes: 0, failures: 0 };
          if (succeeded) {
            counts.successes++;
          } else if (reflection.outcome === 'failure') {
            counts.failures++;
          }
          skillCounts.set(skill, counts);
        }
      }

      // Build skill assessments
      const now = new Date().toISOString();
      const assessments: SkillAssessment[] = [];

      for (const [skill, counts] of skillCounts) {
        const total = counts.successes + counts.failures;
        if (total >= this.config.minSampleSize) {
          assessments.push({
            skill,
            successRate: counts.successes / total,
            sampleSize: total,
            successes: counts.successes,
            failures: counts.failures,
            lastAssessed: now,
          });
        }
      }

      // Sort by success rate
      assessments.sort((a, b) => b.successRate - a.successRate);

      // Extract preferences from successful reflections
      const preferences = this.extractPreferences(reflections);

      this.data = {
        lastRebuilt: now,
        skills: assessments,
        preferences,
        version: this.data.version + 1,
      };

      tracer.log('dream', 'info', `Self-model rebuilt: ${assessments.length} skills assessed`, {
        strengths: this.getStrengths().length,
        weaknesses: this.getWeaknesses().length,
        version: this.data.version,
      });
    });
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  /**
   * Get skills with success rate above the strength threshold.
   */
  getStrengths(): SkillAssessment[] {
    return this.data.skills.filter(
      (s) => s.successRate >= this.config.strengthThreshold,
    );
  }

  /**
   * Get skills with success rate below the weakness threshold.
   */
  getWeaknesses(): SkillAssessment[] {
    return this.data.skills.filter(
      (s) => s.successRate < this.config.weaknessThreshold,
    );
  }

  /**
   * Get a recommendation for a specific task type.
   */
  getRecommendation(taskDescription: string): string | null {
    const skills = this.classifySkills(taskDescription);

    for (const skill of skills) {
      const assessment = this.data.skills.find((s) => s.skill === skill);
      if (assessment && assessment.successRate < this.config.weaknessThreshold) {
        return `Be careful with ${skill} (${Math.round(assessment.successRate * 100)}% success rate over ${assessment.sampleSize} attempts). Consider extra verification.`;
      }
    }

    return null;
  }

  /**
   * Get the summary format used by the identity prompt.
   */
  getSummary(): SelfModelSummary {
    return {
      strengths: this.getStrengths().map((s) => ({
        skill: s.skill,
        successRate: s.successRate,
        sampleSize: s.sampleSize,
      })),
      weaknesses: this.getWeaknesses().map((s) => ({
        skill: s.skill,
        successRate: s.successRate,
        sampleSize: s.sampleSize,
      })),
      preferences: this.data.preferences,
    };
  }

  /**
   * Get the full data (for testing/inspection).
   */
  getData(): Readonly<SelfModelData> {
    return this.data;
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Classify text into skill domains.
   */
  private classifySkills(text: string): string[] {
    const matches: string[] = [];
    for (const { pattern, skill } of SKILL_PATTERNS) {
      if (pattern.test(text)) {
        matches.push(skill);
      }
    }
    return matches.length > 0 ? matches : ['general'];
  }

  /**
   * Extract learned preferences from successful reflections.
   */
  private extractPreferences(reflections: Reflection[]): string[] {
    const successful = reflections.filter((r) => r.outcome === 'success');
    const preferences: string[] = [];

    // Keep existing preferences that are still valid
    for (const pref of this.data.preferences) {
      if (preferences.length < 10) {
        preferences.push(pref);
      }
    }

    // Look for learnings from successful cycles
    for (const r of successful.slice(-20)) {
      if (r.learnings && r.learnings.length > 10 && r.learnings.length < 200) {
        const pref = r.learnings.trim();
        if (!preferences.includes(pref) && preferences.length < 10) {
          preferences.push(pref);
        }
      }
    }

    return preferences;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createSelfModel(
  config?: Partial<SelfModelConfig>,
): SelfModel {
  return new SelfModel(config);
}
