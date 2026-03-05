/**
 * Narrative Identity — Tyrion's persistent sense of self
 *
 * This module builds the identity prompt that is prepended to every
 * interaction context — autonomous cycles, coding sessions, iMessage
 * conversations. It's the single source of "who Tyrion is" and "what
 * he currently knows."
 *
 * The identity prompt is constructed dynamically from:
 *   1. A fixed character prompt (who Tyrion is, how he behaves).
 *   2. World model summary (codebase health, recent activity).
 *   3. Goal stack summary (what he's working on, what's pending).
 *   4. Issue log summary (what's broken, what he's tried).
 *   5. Self-model summary (strengths, weaknesses — Phase 6, placeholder for now).
 *
 * The identity prompt is designed to fit within a fixed token budget
 * (~4,000 tokens by default) so it can always be loaded into the hot
 * tier of context without crowding out working memory.
 *
 * Design principles:
 *   - The character prompt is stable and rarely changes.
 *   - The dynamic sections are regenerated from live data every time.
 *   - The total output is bounded by a configurable token estimate.
 *   - All content is privacy-safe (no sensitive user data).
 */

import { getTracer } from './debug.js';
import type { WorldModel } from './world-model.js';
import type { GoalStack, GoalStackSummary } from './goal-stack.js';
import type { IssueLog, IssueLogSummary } from './issue-log.js';
import type { JournalEntry } from './journal.js';
import type { UserModel } from './world-model.js';
import type { CognitiveMap } from '../metacognition/cognitive-map.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for identity prompt generation.
 */
export interface IdentityConfig {
  /** Approximate maximum character count for the identity prompt */
  maxChars: number;

  /** Whether to include the self-model section (Phase 6 placeholder) */
  includeSelfModel: boolean;

  /** Maximum number of goals to show in the prompt */
  maxGoalsInPrompt: number;

  /** Maximum number of issues to show in the prompt */
  maxIssuesInPrompt: number;

  /** Maximum number of recent activities to show */
  maxActivitiesInPrompt: number;

  /** Whether to include the handoff note from journal */
  includeHandoff: boolean;

  /** Whether to include user model in the prompt */
  includeUserModel: boolean;
}

/**
 * Self-model data — placeholder for Phase 6.
 * For now, this is manually populated or empty.
 */
export interface SelfModelSummary {
  strengths: Array<{ skill: string; successRate: number; sampleSize: number }>;
  weaknesses: Array<{ skill: string; successRate: number; sampleSize: number }>;
  preferences: string[];
}

/**
 * The output of the identity builder: the complete prompt and metadata
 * about what was included.
 */
export interface IdentityPromptResult {
  /** The complete identity prompt text */
  prompt: string;

  /** Approximate character count */
  charCount: number;

  /** What sections were included */
  sections: {
    character: boolean;
    cognitiveMap: boolean;
    knowledgeManifest: boolean;
    worldModel: boolean;
    goalStack: boolean;
    issueLog: boolean;
    selfModel: boolean;
    handoff: boolean;
    userModel: boolean;
  };

  /** Timestamp when this prompt was generated */
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: IdentityConfig = {
  maxChars: 10000, // ~2,500 tokens at 4 chars/token (increased for metacognition sections)
  includeSelfModel: true,
  maxGoalsInPrompt: 5,
  maxIssuesInPrompt: 5,
  maxActivitiesInPrompt: 5,
  includeHandoff: true,
  includeUserModel: true,
};

/**
 * The fixed character prompt. Defines the agent's operational identity
 * and behavioral principles.
 *
 * NOTE: Personality and communication style are NOT included here.
 * They are applied by the voice filter (src/imessage/voice-filter.ts)
 * as the last step before message delivery. This keeps the reasoning
 * context clean — the agent thinks in a neutral voice and the voice
 * filter rewrites the output.
 */
const CHARACTER_PROMPT = `You are an autonomous agent managing the Casterly codebase.

You have persistent memory: you remember what you've worked on, what failed, and what you plan to try next. You are not starting fresh — you are continuing your ongoing work.

## Operating Principles

- **Think before acting.** Read the world model and your issue log before making changes. Understand the current state before modifying it.
- **Verify your own work.** After generating code, test it. After making changes, run the quality gates. Do not trust that your output is correct — prove it.
- **When something fails, investigate.** Do not simply report the failure and stop. Examine why it failed. File an issue with what you tried and what you'd try next. Come back to it.
- **Delegate deliberately.** Use the delegate tool to route sub-tasks to the appropriate model based on the task type.
- **Be surgical.** Make small, targeted changes. Don't refactor unrelated code.
- **Respect the invariants.** All inference stays local. All user data stays on this machine. Sensitive content is redacted in logs. Quality gates must pass before integration. These are non-negotiable.`;

// ─────────────────────────────────────────────────────────────────────────────
// Identity Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the complete identity prompt from all available state sources.
 *
 * This is the primary entry point. Call this at the start of any interaction
 * to get Tyrion's full identity context.
 */
export function buildIdentityPrompt(
  worldModel: WorldModel | null,
  goalStack: GoalStack | null,
  issueLog: IssueLog | null,
  selfModel?: SelfModelSummary | null,
  handoffNote?: JournalEntry | null,
  userModel?: UserModel | null,
  config?: Partial<IdentityConfig>,
  crystalsPrompt?: string | null,
  constitutionPrompt?: string | null,
  cognitiveMap?: CognitiveMap | null,
  knowledgeManifestPrompt?: string | null,
): IdentityPromptResult {
  const tracer = getTracer();
  return tracer.withSpanSync('identity', 'buildIdentityPrompt', (span) => {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const sections: IdentityPromptResult['sections'] = {
      character: true,
      cognitiveMap: false,
      knowledgeManifest: false,
      worldModel: false,
      goalStack: false,
      issueLog: false,
      selfModel: false,
      handoff: false,
      userModel: false,
    };

    const parts: string[] = [CHARACTER_PROMPT];
    let totalChars = CHARACTER_PROMPT.length;

    tracer.log('identity', 'debug', 'Building identity prompt', {
      hasWorldModel: worldModel !== null,
      hasGoalStack: goalStack !== null,
      hasIssueLog: issueLog !== null,
      hasSelfModel: selfModel !== null && selfModel !== undefined,
      maxChars: cfg.maxChars,
    });

    // ── Cognitive Map Section (Metacognition) ─────────────────────────

    if (cognitiveMap) {
      const cogMapText = cognitiveMap.buildSummary();
      if (cogMapText && totalChars + cogMapText.length + 50 < cfg.maxChars) {
        parts.push('\n# My Environment\n');
        parts.push(cogMapText);
        totalChars += cogMapText.length + 20;
        sections.cognitiveMap = true;
        tracer.log('identity', 'debug', `Cognitive map section: ${cogMapText.length} chars`);
      } else {
        tracer.log('identity', 'debug', 'Cognitive map section skipped (budget exceeded)');
      }
    }

    // ── Knowledge Manifest Section (Metacognition) ──────────────────

    if (knowledgeManifestPrompt && knowledgeManifestPrompt.length > 0) {
      if (totalChars + knowledgeManifestPrompt.length + 50 < cfg.maxChars) {
        parts.push('\n# Knowledge Sources\n');
        parts.push(knowledgeManifestPrompt);
        totalChars += knowledgeManifestPrompt.length + 30;
        sections.knowledgeManifest = true;
        tracer.log('identity', 'debug', `Knowledge manifest section: ${knowledgeManifestPrompt.length} chars`);
      } else {
        tracer.log('identity', 'debug', 'Knowledge manifest section skipped (budget exceeded)');
      }
    }

    // ── World Model Section ────────────────────────────────────────────

    if (worldModel !== null) {
      const worldModelText = worldModel.getSummary();
      if (totalChars + worldModelText.length + 50 < cfg.maxChars) {
        parts.push('\n# Current State\n');
        parts.push(worldModelText);
        totalChars += worldModelText.length + 20;
        sections.worldModel = true;
        tracer.log('identity', 'debug', `World model section: ${worldModelText.length} chars`);
      } else {
        tracer.log('identity', 'debug', 'World model section skipped (budget exceeded)');
      }
    }

    // ── Goal Stack Section ─────────────────────────────────────────────

    if (goalStack !== null) {
      const goalText = buildGoalSection(goalStack, cfg);
      if (totalChars + goalText.length + 50 < cfg.maxChars) {
        parts.push('\n# Your Goals\n');
        parts.push(goalText);
        totalChars += goalText.length + 20;
        sections.goalStack = true;
        tracer.log('identity', 'debug', `Goal stack section: ${goalText.length} chars`);
      } else {
        tracer.log('identity', 'debug', 'Goal stack section skipped (budget exceeded)');
      }
    }

    // ── Issue Log Section ──────────────────────────────────────────────

    if (issueLog !== null) {
      const issueText = buildIssueSection(issueLog, cfg);
      if (totalChars + issueText.length + 50 < cfg.maxChars) {
        parts.push('\n# Known Issues\n');
        parts.push(issueText);
        totalChars += issueText.length + 20;
        sections.issueLog = true;
        tracer.log('identity', 'debug', `Issue log section: ${issueText.length} chars`);
      } else {
        tracer.log('identity', 'debug', 'Issue log section skipped (budget exceeded)');
      }
    }

    // ── Self-Model Section (Phase 6 placeholder) ───────────────────────

    if (cfg.includeSelfModel && selfModel) {
      const selfModelText = buildSelfModelSection(selfModel);
      if (totalChars + selfModelText.length + 50 < cfg.maxChars) {
        parts.push('\n# Self-Assessment\n');
        parts.push(selfModelText);
        totalChars += selfModelText.length + 20;
        sections.selfModel = true;
        tracer.log('identity', 'debug', `Self-model section: ${selfModelText.length} chars`);
      } else {
        tracer.log('identity', 'debug', 'Self-model section skipped (budget exceeded)');
      }
    }

    // ── Crystals Section (Vision Tier 1: Memory Crystallization) ──────────

    if (crystalsPrompt && crystalsPrompt.length > 0) {
      if (totalChars + crystalsPrompt.length + 50 < cfg.maxChars) {
        parts.push('\n# Crystallized Knowledge\n');
        parts.push(crystalsPrompt);
        totalChars += crystalsPrompt.length + 30;
        tracer.log('identity', 'debug', `Crystals section: ${crystalsPrompt.length} chars`);
      } else {
        tracer.log('identity', 'debug', 'Crystals section skipped (budget exceeded)');
      }
    }

    // ── Constitution Section (Vision Tier 1: Self-Governance) ─────────────

    if (constitutionPrompt && constitutionPrompt.length > 0) {
      if (totalChars + constitutionPrompt.length + 50 < cfg.maxChars) {
        parts.push('\n# Operational Rules\n');
        parts.push(constitutionPrompt);
        totalChars += constitutionPrompt.length + 30;
        tracer.log('identity', 'debug', `Constitution section: ${constitutionPrompt.length} chars`);
      } else {
        tracer.log('identity', 'debug', 'Constitution section skipped (budget exceeded)');
      }
    }

    // ── Handoff Note (from journal) ──────────────────────────────────────

    if (cfg.includeHandoff && handoffNote) {
      const handoffText = buildHandoffSection(handoffNote);
      if (totalChars + handoffText.length + 50 < cfg.maxChars) {
        parts.push('\n# Last Session Handoff\n');
        parts.push(handoffText);
        totalChars += handoffText.length + 20;
        sections.handoff = true;
        tracer.log('identity', 'debug', `Handoff section: ${handoffText.length} chars`);
      }
    }

    // ── User Model Section ──────────────────────────────────────────────

    if (cfg.includeUserModel && userModel) {
      const userModelText = buildUserModelSection(userModel);
      if (totalChars + userModelText.length + 50 < cfg.maxChars) {
        parts.push('\n# User Understanding\n');
        parts.push(userModelText);
        totalChars += userModelText.length + 20;
        sections.userModel = true;
        tracer.log('identity', 'debug', `User model section: ${userModelText.length} chars`);
      }
    }

    const prompt = parts.join('\n');
    const result: IdentityPromptResult = {
      prompt,
      charCount: prompt.length,
      sections,
      generatedAt: new Date().toISOString(),
    };

    tracer.log('identity', 'info', 'Identity prompt built', {
      charCount: result.charCount,
      sections: result.sections,
    });
    span.metadata['charCount'] = result.charCount;

    return result;
  });
}

/**
 * Build a minimal identity prompt when state hasn't been loaded yet.
 * Used as a fallback during initialization.
 */
export function buildMinimalIdentityPrompt(): string {
  return CHARACTER_PROMPT;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section Builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the goal stack section for the identity prompt.
 */
function buildGoalSection(goalStack: GoalStack, config: IdentityConfig): string {
  const summary: GoalStackSummary = goalStack.getSummary(config.maxGoalsInPrompt);
  const lines: string[] = [];

  if (summary.inProgress.length > 0) {
    for (const g of summary.inProgress) {
      lines.push(`**Active:** ${g.description} [${g.id}, ${g.source}, attempt #${g.attempts}]`);
      if (g.notes) {
        lines.push(`  Progress: ${g.notes}`);
      }
    }
  }

  if (summary.topPending.length > 0) {
    lines.push('');
    lines.push('Pending:');
    for (const g of summary.topPending) {
      lines.push(`- P${g.priority}: ${g.description} [${g.id}, ${g.source}]`);
    }
  }

  if (summary.blocked.length > 0) {
    lines.push('');
    lines.push('Blocked:');
    for (const g of summary.blocked) {
      lines.push(`- ${g.description}: ${g.notes} [${g.id}]`);
    }
  }

  if (summary.stale.length > 0) {
    lines.push('');
    lines.push(`Stale (needs attention):`);
    for (const g of summary.stale) {
      lines.push(`- ${g.description} [${g.id}, inactive since ${g.updated.split('T')[0]}]`);
    }
  }

  if (lines.length === 0) {
    lines.push('No active goals. Look for improvements or check the issue log.');
  }

  return lines.join('\n');
}

/**
 * Build the issue log section for the identity prompt.
 */
function buildIssueSection(issueLog: IssueLog, config: IdentityConfig): string {
  const summary: IssueLogSummary = issueLog.getSummary();
  const lines: string[] = [];

  if (summary.investigating.length > 0) {
    lines.push('Investigating:');
    for (const i of summary.investigating.slice(0, config.maxIssuesInPrompt)) {
      const attempts = i.attempts.length > 0 ? ` (${i.attempts.length} attempts)` : '';
      lines.push(`- [${i.id}] ${i.title}${attempts}`);
      if (i.nextIdea) {
        lines.push(`  Next idea: ${i.nextIdea}`);
      }
    }
  }

  const openNotInvestigating = summary.openByPriority.filter((i) => i.status === 'open');
  if (openNotInvestigating.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Open:');
    for (const i of openNotInvestigating.slice(0, config.maxIssuesInPrompt)) {
      lines.push(`- [${i.id}] [${i.priority}] ${i.title}`);
    }
  }

  if (summary.stale.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Stale (needs revisiting):');
    for (const i of summary.stale.slice(0, 3)) {
      lines.push(`- [${i.id}] ${i.title} (since ${i.lastUpdated.split('T')[0]})`);
    }
  }

  if (lines.length === 0) {
    lines.push('No known issues. The codebase appears healthy.');
  }

  return lines.join('\n');
}

/**
 * Build the self-model section for the identity prompt.
 * This is a Phase 6 placeholder — data comes from manual input or
 * the future SelfModel class.
 */
function buildSelfModelSection(selfModel: SelfModelSummary): string {
  const lines: string[] = [];

  if (selfModel.strengths.length > 0) {
    lines.push('Strengths:');
    for (const s of selfModel.strengths) {
      lines.push(`- ${s.skill}: ${Math.round(s.successRate * 100)}% success (${s.sampleSize} attempts)`);
    }
  }

  if (selfModel.weaknesses.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Weaknesses (proceed carefully):');
    for (const w of selfModel.weaknesses) {
      lines.push(`- ${w.skill}: ${Math.round(w.successRate * 100)}% success (${w.sampleSize} attempts)`);
    }
  }

  if (selfModel.preferences.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Learned preferences:');
    for (const p of selfModel.preferences) {
      lines.push(`- ${p}`);
    }
  }

  if (lines.length === 0) {
    lines.push('Self-model not yet calibrated. Accumulating data from cycles.');
  }

  return lines.join('\n');
}

/**
 * Build the handoff note section for the identity prompt.
 * This gives Tyrion continuity between sessions.
 */
function buildHandoffSection(handoff: JournalEntry): string {
  const dateStr = handoff.timestamp.split('T')[0];
  const tags = handoff.tags.length > 0 ? ` [${handoff.tags.join(', ')}]` : '';
  return `From ${dateStr}${tags}:\n\n${handoff.content}`;
}

/**
 * Build the user model section for the identity prompt.
 * Gives Tyrion awareness of user preferences and context.
 */
function buildUserModelSection(userModel: UserModel): string {
  const lines: string[] = [];

  if (userModel.communicationStyle) {
    lines.push(`Communication style: ${userModel.communicationStyle}`);
  }

  if (userModel.priorities.length > 0) {
    lines.push(`\nCurrent priorities:`);
    for (const p of userModel.priorities) {
      lines.push(`- ${p}`);
    }
  }

  if (userModel.recentTopics.length > 0) {
    lines.push(`\nRecent topics: ${userModel.recentTopics.join(', ')}`);
  }

  if (userModel.preferences.length > 0) {
    lines.push(`\nPreferences:`);
    for (const p of userModel.preferences) {
      lines.push(`- ${p}`);
    }
  }

  if (lines.length === 0) {
    lines.push('User model not yet populated. Observe interactions to build understanding.');
  }

  return lines.join('\n');
}
