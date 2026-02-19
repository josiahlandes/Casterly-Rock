/**
 * Prompt Store — Self-Modifying System Prompt (Vision Tier 2)
 *
 * The system prompt is the architecture. Modifying the prompt is
 * self-modification. This module manages a versioned, editable
 * system prompt that the LLM can refine based on experience.
 *
 * What the LLM CAN modify:
 *   - Workflow guidance ("after modifying 2+ files, run tests first")
 *   - Default strategies ("skip planning for single-file edits")
 *   - Tool preferences ("prefer recall_journal for debugging context")
 *   - Context heuristics ("load full file for refactoring tasks")
 *   - Self-correction triggers ("test regex before using it")
 *
 * What the LLM CANNOT modify (protected patterns):
 *   - Safety boundary
 *   - Path guards
 *   - Redaction rules
 *   - Security invariants
 *
 * Every revision is versioned with a rationale and can be reverted.
 *
 * Storage:
 *   - ~/.casterly/system-prompt.md — The editable prompt source
 *   - ~/.casterly/prompt-versions.json — Version history
 *
 * Part of Vision Tier 2: Self-Modifying Prompts.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getTracer } from './debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single prompt version — a snapshot of the system prompt at a point in time.
 */
export interface PromptVersion {
  /** Version number (monotonically increasing) */
  version: number;

  /** ISO timestamp when this version was created */
  timestamp: string;

  /** The full prompt content at this version */
  content: string;

  /** Why this edit was made */
  rationale: string;

  /** Cycle ID that produced this version */
  cycleId?: string;

  /** Performance metrics at the time of this version */
  metrics?: VersionMetrics;
}

/**
 * Performance metrics tagged to a prompt version.
 */
export interface VersionMetrics {
  /** Number of cycles run with this version */
  cyclesRun: number;

  /** Success rate (0-1) over those cycles */
  successRate: number;

  /** Average turns per cycle */
  avgTurns: number;
}

/**
 * The result of a prompt edit operation.
 */
export interface EditResult {
  /** Whether the edit was applied */
  success: boolean;

  /** The new version number if successful */
  version?: number;

  /** Error message if the edit was rejected */
  error?: string;
}

/**
 * Configuration for the prompt store.
 */
export interface PromptStoreConfig {
  /** Path to the editable system prompt */
  promptPath: string;

  /** Path to version history */
  versionsPath: string;

  /** Maximum number of versions to retain */
  maxVersions: number;

  /** Patterns that are protected from modification */
  protectedPatterns: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PromptStoreConfig = {
  promptPath: '~/.casterly/system-prompt.md',
  versionsPath: '~/.casterly/prompt-versions.json',
  maxVersions: 20,
  protectedPatterns: [
    'Safety Boundary',
    'Path Guards',
    'Redaction Rules',
    'Security Invariants',
    'NEVER',
    'non-negotiable',
  ],
};

/**
 * The initial system prompt content — serves as version 0.
 * This is the baseline that can be edited but never deleted.
 */
const INITIAL_PROMPT = `## Workflow Guidance

- After modifying more than 2 files, run tests before reporting success.
- For complex tasks, think step-by-step before executing.
- Prefer reading existing code before making modifications.

## Default Strategies

- Skip planning for simple single-file edits.
- Use planning for multi-file refactoring or architecture changes.
- Verify file contents before editing when unsure about the current state.

## Tool Preferences

- Use recall_journal for debugging-related context.
- Use recall for general knowledge and past approaches.
- Use think for complex reasoning before acting.

## Self-Correction Triggers

- If uncertain about a regex, test it before applying.
- If a test fails unexpectedly, read the test file before fixing.
- If you've made 3+ edits without testing, run tests now.
`;

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Store
// ─────────────────────────────────────────────────────────────────────────────

export class PromptStore {
  private readonly config: PromptStoreConfig;
  private currentContent: string = '';
  private versions: PromptVersion[] = [];
  private currentVersion: number = 0;
  private loaded: boolean = false;

  constructor(config?: Partial<PromptStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /**
   * Load the prompt and version history from disk.
   */
  async load(): Promise<void> {
    const tracer = getTracer();

    // Load version history
    try {
      const versionsContent = await readFile(
        resolvePath(this.config.versionsPath), 'utf8',
      );
      const parsed = JSON.parse(versionsContent) as PromptVersion[];
      if (Array.isArray(parsed)) {
        this.versions = parsed;
        this.currentVersion = parsed.length > 0
          ? Math.max(...parsed.map((v) => v.version))
          : 0;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        tracer.log('memory', 'warn', 'Failed to load prompt versions', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.versions = [];
      this.currentVersion = 0;
    }

    // Load current prompt content
    try {
      this.currentContent = await readFile(
        resolvePath(this.config.promptPath), 'utf8',
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Initialize with default prompt
        this.currentContent = INITIAL_PROMPT;
        await this.savePrompt();

        // Create version 0
        this.versions.push({
          version: 0,
          timestamp: new Date().toISOString(),
          content: INITIAL_PROMPT,
          rationale: 'Initial system prompt.',
        });
        await this.saveVersions();
      } else {
        tracer.log('memory', 'warn', 'Failed to load system prompt', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.currentContent = INITIAL_PROMPT;
      }
    }

    this.loaded = true;
    tracer.log('memory', 'debug', `Prompt store loaded: version ${this.currentVersion}, ${this.versions.length} versions`);
  }

  /**
   * Save the current prompt to disk.
   */
  private async savePrompt(): Promise<void> {
    const resolvedPath = resolvePath(this.config.promptPath);
    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, this.currentContent, 'utf8');
  }

  /**
   * Save version history to disk.
   */
  private async saveVersions(): Promise<void> {
    const resolvedPath = resolvePath(this.config.versionsPath);
    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, JSON.stringify(this.versions, null, 2), 'utf8');
  }

  // ── Edit Operations ──────────────────────────────────────────────────────

  /**
   * Edit the system prompt. Finds `oldText` and replaces it with `newText`.
   * Returns an error if protected patterns are involved or the text isn't found.
   */
  editPrompt(params: {
    oldText: string;
    newText: string;
    rationale: string;
    cycleId?: string;
  }): EditResult {
    const tracer = getTracer();

    // Validate: oldText must exist in the current prompt
    if (!this.currentContent.includes(params.oldText)) {
      return {
        success: false,
        error: 'The specified old text was not found in the current prompt.',
      };
    }

    // Validate: protected patterns cannot be removed
    const protectionViolation = this.checkProtectedPatterns(
      params.oldText, params.newText,
    );
    if (protectionViolation) {
      tracer.log('memory', 'warn', `Prompt edit rejected: ${protectionViolation}`);
      return {
        success: false,
        error: protectionViolation,
      };
    }

    // Apply the edit
    const newContent = this.currentContent.replace(params.oldText, params.newText);
    this.currentVersion++;

    // Record version
    const version: PromptVersion = {
      version: this.currentVersion,
      timestamp: new Date().toISOString(),
      content: newContent,
      rationale: params.rationale,
      ...(params.cycleId !== undefined ? { cycleId: params.cycleId } : {}),
    };

    this.versions.push(version);
    this.currentContent = newContent;

    // Prune old versions if needed
    while (this.versions.length > this.config.maxVersions) {
      // Keep version 0 (initial), remove oldest non-initial
      const removeIndex = this.versions.findIndex((v) => v.version > 0);
      if (removeIndex >= 0) {
        this.versions.splice(removeIndex, 1);
      } else {
        break;
      }
    }

    tracer.log('memory', 'info', `Prompt edited: version ${this.currentVersion}`, {
      rationale: params.rationale.slice(0, 80),
    });

    return {
      success: true,
      version: this.currentVersion,
    };
  }

  /**
   * Revert to a specific version.
   */
  revertPrompt(targetVersion: number, rationale: string): EditResult {
    const tracer = getTracer();

    const target = this.versions.find((v) => v.version === targetVersion);
    if (!target) {
      return {
        success: false,
        error: `Version ${targetVersion} not found. Available versions: ${this.versions.map((v) => v.version).join(', ')}`,
      };
    }

    this.currentVersion++;

    const revertVersion: PromptVersion = {
      version: this.currentVersion,
      timestamp: new Date().toISOString(),
      content: target.content,
      rationale: `Revert to v${targetVersion}: ${rationale}`,
    };

    this.versions.push(revertVersion);
    this.currentContent = target.content;

    tracer.log('memory', 'info', `Prompt reverted to v${targetVersion} as v${this.currentVersion}`, {
      rationale,
    });

    return {
      success: true,
      version: this.currentVersion,
    };
  }

  /**
   * Save all state to disk (call after edits).
   */
  async save(): Promise<void> {
    await this.savePrompt();
    await this.saveVersions();
    getTracer().log('memory', 'debug', `Prompt store saved: version ${this.currentVersion}`);
  }

  // ── Metrics Tracking ─────────────────────────────────────────────────────

  /**
   * Record performance metrics for the current prompt version.
   */
  recordMetrics(metrics: VersionMetrics): void {
    const current = this.versions.find((v) => v.version === this.currentVersion);
    if (current) {
      current.metrics = metrics;
    }
  }

  /**
   * Get a comparison of metrics across recent versions.
   */
  getPerformanceTrend(): Array<{
    version: number;
    metrics: VersionMetrics | undefined;
  }> {
    return this.versions
      .filter((v) => v.metrics)
      .map((v) => ({
        version: v.version,
        metrics: v.metrics,
      }));
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /**
   * Get the current prompt content.
   */
  getContent(): string {
    return this.currentContent;
  }

  /**
   * Get the current version number.
   */
  getVersion(): number {
    return this.currentVersion;
  }

  /**
   * Get all versions (sorted by version number).
   */
  getVersions(): ReadonlyArray<PromptVersion> {
    return [...this.versions].sort((a, b) => a.version - b.version);
  }

  /**
   * Get a specific version.
   */
  getVersionContent(version: number): PromptVersion | undefined {
    return this.versions.find((v) => v.version === version);
  }

  /**
   * Get a diff between two versions (simple line comparison).
   */
  diffVersions(versionA: number, versionB: number): string | null {
    const a = this.versions.find((v) => v.version === versionA);
    const b = this.versions.find((v) => v.version === versionB);

    if (!a || !b) return null;

    const linesA = a.content.split('\n');
    const linesB = b.content.split('\n');
    const diff: string[] = [`--- v${versionA}`, `+++ v${versionB}`];

    const maxLines = Math.max(linesA.length, linesB.length);
    for (let i = 0; i < maxLines; i++) {
      const lineA = linesA[i] ?? '';
      const lineB = linesB[i] ?? '';
      if (lineA !== lineB) {
        if (lineA) diff.push(`- ${lineA}`);
        if (lineB) diff.push(`+ ${lineB}`);
      }
    }

    return diff.length > 2 ? diff.join('\n') : 'No differences.';
  }

  /**
   * Check if the store has been loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Build text for inclusion in the identity prompt.
   */
  buildPromptSection(): string {
    if (this.currentContent.length === 0) return '';
    return this.currentContent;
  }

  // ── Protected Patterns ───────────────────────────────────────────────────

  /**
   * Check if an edit would violate protected patterns.
   * Protected patterns present in oldText must also appear in newText.
   */
  private checkProtectedPatterns(oldText: string, newText: string): string | null {
    for (const pattern of this.config.protectedPatterns) {
      const patternLower = pattern.toLowerCase();
      const oldHasPattern = oldText.toLowerCase().includes(patternLower);
      const newHasPattern = newText.toLowerCase().includes(patternLower);

      if (oldHasPattern && !newHasPattern) {
        return `Protected pattern "${pattern}" would be removed by this edit. Safety-critical patterns cannot be deleted.`;
      }
    }
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createPromptStore(
  config?: Partial<PromptStoreConfig>,
): PromptStore {
  return new PromptStore(config);
}
