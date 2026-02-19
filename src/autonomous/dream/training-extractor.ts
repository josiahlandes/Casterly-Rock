/**
 * Training Data Extractor — LoRA Fine-Tuning (Vision Tier 3)
 *
 * Extracts decision-outcome pairs from the journal and issue log,
 * formats them as training examples for LoRA fine-tuning. Examples
 * are grouped by skill domain for domain-specific adapters.
 *
 * Data formats:
 *   1. Instruction/completion pairs (supervised fine-tuning)
 *   2. Preference pairs: chosen/rejected (DPO)
 *
 * Privacy: Training data comes only from the local journal and issue
 * log. No user data is included — only Tyrion's own reasoning,
 * decisions, and technical observations.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getTracer } from '../debug.js';
import type { Journal, JournalEntry } from '../journal.js';
import type { IssueLog, Issue, IssueAttempt } from '../issue-log.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single training example in instruction/completion format.
 */
export interface TrainingExample {
  /** Unique identifier */
  id: string;

  /** Skill domain this example belongs to */
  skill: string;

  /** The instruction/prompt */
  instruction: string;

  /** The completion/response */
  completion: string;

  /** Whether this is a positive or negative example */
  outcome: 'success' | 'failure';

  /** Source of this example */
  source: 'journal' | 'issue_log';

  /** Source entry ID */
  sourceId: string;

  /** When this example was extracted */
  extractedAt: string;
}

/**
 * A preference pair for DPO training.
 */
export interface PreferencePair {
  /** Unique identifier */
  id: string;

  /** Skill domain */
  skill: string;

  /** The instruction/context */
  instruction: string;

  /** The preferred (chosen) response */
  chosen: string;

  /** The rejected response */
  rejected: string;

  /** Source IDs */
  chosenSourceId: string;
  rejectedSourceId: string;

  /** When this pair was extracted */
  extractedAt: string;
}

/**
 * A complete training dataset grouped by skill.
 */
export interface TrainingDataset {
  /** When this dataset was extracted */
  extractedAt: string;

  /** Lookback period in days */
  lookbackDays: number;

  /** Instruction/completion examples by skill */
  examplesBySkill: Record<string, TrainingExample[]>;

  /** Preference pairs by skill */
  preferencesBySkill: Record<string, PreferencePair[]>;

  /** Total counts */
  totalExamples: number;
  totalPreferences: number;
}

/**
 * Configuration for the training extractor.
 */
export interface TrainingExtractorConfig {
  /** Path to store extracted training data */
  outputPath: string;

  /** How many days back to look for training data */
  lookbackDays: number;

  /** Minimum content length for a valid example */
  minContentLength: number;

  /** Maximum content length for a single example */
  maxContentLength: number;

  /** Maximum examples per skill domain */
  maxExamplesPerSkill: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: TrainingExtractorConfig = {
  outputPath: '~/.casterly/training-data.json',
  lookbackDays: 90,
  minContentLength: 20,
  maxContentLength: 2000,
  maxExamplesPerSkill: 100,
};

/**
 * Map tags and titles to skill domains.
 */
const SKILL_PATTERNS: Array<{ pattern: RegExp; skill: string }> = [
  { pattern: /\bregex\b/i, skill: 'regex' },
  { pattern: /\btypes?\b|typescript/i, skill: 'typescript' },
  { pattern: /\btest\b|testing/i, skill: 'testing' },
  { pattern: /\brefactor/i, skill: 'refactoring' },
  { pattern: /\bsecurity\b|vulnerab/i, skill: 'security' },
  { pattern: /\bperformance\b|optimi/i, skill: 'performance' },
  { pattern: /\bconcurrenc|async|race/i, skill: 'concurrency' },
  { pattern: /\bpars(?:e|ing)\b/i, skill: 'parsing' },
  { pattern: /\bconfig/i, skill: 'configuration' },
  { pattern: /\bgit\b/i, skill: 'git' },
  { pattern: /\bbug\s*fix|fix\b/i, skill: 'bug-fixing' },
  { pattern: /\bdocument/i, skill: 'documentation' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Training Extractor
// ─────────────────────────────────────────────────────────────────────────────

export class TrainingExtractor {
  private readonly config: TrainingExtractorConfig;

  constructor(config?: Partial<TrainingExtractorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Extract training data from journal and issue log.
   */
  async extract(journal: Journal, issueLog: IssueLog): Promise<TrainingDataset> {
    const tracer = getTracer();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.config.lookbackDays);
    const cutoffIso = cutoff.toISOString();

    const examplesBySkill: Record<string, TrainingExample[]> = {};
    const preferencesBySkill: Record<string, PreferencePair[]> = {};

    // Extract from journal
    const journalExamples = this.extractFromJournal(journal, cutoffIso);
    for (const example of journalExamples) {
      const list = examplesBySkill[example.skill] ?? [];
      if (list.length < this.config.maxExamplesPerSkill) {
        list.push(example);
        examplesBySkill[example.skill] = list;
      }
    }

    // Extract from issue log
    const issueExamples = this.extractFromIssueLog(issueLog, cutoffIso);
    for (const example of issueExamples) {
      const list = examplesBySkill[example.skill] ?? [];
      if (list.length < this.config.maxExamplesPerSkill) {
        list.push(example);
        examplesBySkill[example.skill] = list;
      }
    }

    // Build preference pairs from issue attempts
    const preferences = this.buildPreferencePairs(issueLog, cutoffIso);
    for (const pref of preferences) {
      const list = preferencesBySkill[pref.skill] ?? [];
      list.push(pref);
      preferencesBySkill[pref.skill] = list;
    }

    let totalExamples = 0;
    for (const list of Object.values(examplesBySkill)) {
      totalExamples += list.length;
    }

    let totalPreferences = 0;
    for (const list of Object.values(preferencesBySkill)) {
      totalPreferences += list.length;
    }

    const dataset: TrainingDataset = {
      extractedAt: new Date().toISOString(),
      lookbackDays: this.config.lookbackDays,
      examplesBySkill,
      preferencesBySkill,
      totalExamples,
      totalPreferences,
    };

    tracer.log('dream', 'info', `Training data extracted: ${totalExamples} examples, ${totalPreferences} preference pairs`, {
      skills: Object.keys(examplesBySkill),
    });

    return dataset;
  }

  /**
   * Save a training dataset to disk.
   */
  async saveDataset(dataset: TrainingDataset): Promise<void> {
    const resolvedPath = this.config.outputPath.replace(/^~/, process.env['HOME'] ?? '~');
    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, JSON.stringify(dataset, null, 2), 'utf8');

    getTracer().log('dream', 'debug', `Training dataset saved: ${dataset.totalExamples} examples`);
  }

  /**
   * Load a previously saved training dataset.
   */
  async loadDataset(): Promise<TrainingDataset | null> {
    const resolvedPath = this.config.outputPath.replace(/^~/, process.env['HOME'] ?? '~');

    try {
      const content = await readFile(resolvedPath, 'utf8');
      return JSON.parse(content) as TrainingDataset;
    } catch {
      return null;
    }
  }

  /**
   * Get a summary of the extracted dataset.
   */
  summarizeDataset(dataset: TrainingDataset): string {
    const lines: string[] = [
      `Training Dataset Summary`,
      `Extracted: ${dataset.extractedAt}`,
      `Lookback: ${dataset.lookbackDays} days`,
      `Total examples: ${dataset.totalExamples}`,
      `Total preference pairs: ${dataset.totalPreferences}`,
      '',
      'Examples by skill:',
    ];

    for (const [skill, examples] of Object.entries(dataset.examplesBySkill)) {
      const successes = examples.filter((e) => e.outcome === 'success').length;
      lines.push(`  ${skill}: ${examples.length} (${successes} success, ${examples.length - successes} failure)`);
    }

    if (Object.keys(dataset.preferencesBySkill).length > 0) {
      lines.push('');
      lines.push('Preference pairs by skill:');
      for (const [skill, pairs] of Object.entries(dataset.preferencesBySkill)) {
        lines.push(`  ${skill}: ${pairs.length} pairs`);
      }
    }

    return lines.join('\n');
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Extract training examples from journal entries.
   */
  private extractFromJournal(journal: Journal, cutoffIso: string): TrainingExample[] {
    const examples: TrainingExample[] = [];
    const entries = journal.getAllEntries();

    for (const entry of entries) {
      if (entry.timestamp < cutoffIso) continue;
      if (entry.content.length < this.config.minContentLength) continue;

      // Only use reflection and handoff entries (they contain decisions/outcomes)
      if (entry.type !== 'reflection' && entry.type !== 'handoff') continue;

      const skills = this.classifySkills(entry.content, entry.tags);
      const content = this.truncateContent(entry.content);

      for (const skill of skills) {
        examples.push({
          id: `train-journal-${entry.id}`,
          skill,
          instruction: this.buildJournalInstruction(entry),
          completion: content,
          outcome: this.inferOutcome(entry),
          source: 'journal',
          sourceId: entry.id,
          extractedAt: new Date().toISOString(),
        });
      }
    }

    return examples;
  }

  /**
   * Extract training examples from issue log attempts.
   */
  private extractFromIssueLog(issueLog: IssueLog, cutoffIso: string): TrainingExample[] {
    const examples: TrainingExample[] = [];
    const issues = issueLog.getData().issues;

    for (const issue of issues) {
      if (issue.lastUpdated < cutoffIso) continue;

      const skills = this.classifySkills(
        issue.title + ' ' + issue.description,
        issue.tags,
      );

      for (const attempt of issue.attempts) {
        if (attempt.approach.length < this.config.minContentLength) continue;

        for (const skill of skills) {
          examples.push({
            id: `train-issue-${issue.id}-${examples.length}`,
            skill,
            instruction: `Fix issue: ${issue.title}\nDescription: ${this.truncateContent(issue.description)}`,
            completion: this.truncateContent(attempt.approach + '\nOutcome: ' + attempt.details),
            outcome: attempt.outcome === 'success' ? 'success' : 'failure',
            source: 'issue_log',
            sourceId: issue.id,
            extractedAt: new Date().toISOString(),
          });
        }
      }
    }

    return examples;
  }

  /**
   * Build preference pairs from issue attempts (successful vs failed approaches).
   */
  private buildPreferencePairs(issueLog: IssueLog, cutoffIso: string): PreferencePair[] {
    const pairs: PreferencePair[] = [];
    const issues = issueLog.getData().issues;

    for (const issue of issues) {
      if (issue.lastUpdated < cutoffIso) continue;
      if (issue.attempts.length < 2) continue;

      const successes = issue.attempts.filter((a) => a.outcome === 'success');
      const failures = issue.attempts.filter((a) => a.outcome === 'failure');

      if (successes.length === 0 || failures.length === 0) continue;

      const skills = this.classifySkills(
        issue.title + ' ' + issue.description,
        issue.tags,
      );

      // Pair each success with a failure
      for (const success of successes) {
        for (const failure of failures) {
          for (const skill of skills) {
            pairs.push({
              id: `pref-${issue.id}-${pairs.length}`,
              skill,
              instruction: `Fix issue: ${issue.title}`,
              chosen: this.truncateContent(success.approach),
              rejected: this.truncateContent(failure.approach),
              chosenSourceId: issue.id,
              rejectedSourceId: issue.id,
              extractedAt: new Date().toISOString(),
            });
          }
        }
      }
    }

    return pairs;
  }

  /**
   * Classify text into skill domains.
   */
  private classifySkills(text: string, tags: string[] = []): string[] {
    const combined = text + ' ' + tags.join(' ');
    const matches: string[] = [];

    for (const { pattern, skill } of SKILL_PATTERNS) {
      if (pattern.test(combined)) {
        matches.push(skill);
      }
    }

    return matches.length > 0 ? matches : ['general'];
  }

  /**
   * Build an instruction prompt from a journal entry.
   */
  private buildJournalInstruction(entry: JournalEntry): string {
    const prefix = entry.type === 'reflection'
      ? 'Reflect on what was learned:'
      : 'Write a handoff note summarizing the session:';

    return `${prefix}\nTags: ${entry.tags.join(', ')}`;
  }

  /**
   * Infer outcome from a journal entry.
   */
  private inferOutcome(entry: JournalEntry): 'success' | 'failure' {
    const text = entry.content.toLowerCase();
    const failureSignals = ['failed', 'broken', 'error', 'bug', 'wrong', 'stuck', 'blocked'];
    const failureCount = failureSignals.filter((s) => text.includes(s)).length;
    return failureCount >= 2 ? 'failure' : 'success';
  }

  /**
   * Truncate content to the configured maximum.
   */
  private truncateContent(content: string): string {
    if (content.length <= this.config.maxContentLength) return content;
    return content.slice(0, this.config.maxContentLength) + '...';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createTrainingExtractor(
  config?: Partial<TrainingExtractorConfig>,
): TrainingExtractor {
  return new TrainingExtractor(config);
}
