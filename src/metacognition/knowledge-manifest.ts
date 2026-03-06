/**
 * Knowledge Manifest — Hot-Tier Table of Contents
 *
 * A compact summary of what Tyrion knows and where it lives. Injected into
 * the identity prompt so Tyrion always has a map of his own knowledge,
 * even when the knowledge itself is in cool/cold storage.
 *
 * This is the "I know that I know" layer. It doesn't contain knowledge —
 * it contains pointers to knowledge. The preflection step uses this
 * manifest to decide what to retrieve before responding.
 *
 * The manifest is rebuilt dynamically from live state (not persisted
 * separately). It's cheap to generate and always up to date.
 */

import type { CognitiveMap } from './cognitive-map.js';
import type { WorldModel } from '../autonomous/world-model.js';
import type { GoalStack } from '../autonomous/goal-stack.js';
import type { IssueLog } from '../autonomous/issue-log.js';
import type { Journal } from '../autonomous/journal.js';
import { getTracer } from '../autonomous/debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single knowledge source entry in the manifest.
 */
export interface KnowledgeSource {
  /** What domain this source covers */
  domain: string;
  /** Where the data lives (file path, store name, or CLI command) */
  location: string;
  /** Whether this source is currently populated (has data) */
  populated: boolean;
  /** Rough token cost to retrieve this source */
  retrievalCostTokens: number;
}

/**
 * Inputs needed to build the manifest.
 */
export interface ManifestInputs {
  cognitiveMap: CognitiveMap | null;
  worldModel: WorldModel | null;
  goalStack: GoalStack | null;
  issueLog: IssueLog | null;
  journal: Journal | null;
  hasCrystals: boolean;
  hasConstitution: boolean;
  hasSelfModel: boolean;
  hasSkillFiles: boolean;
  hasGraphMemory: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the knowledge manifest from current system state.
 *
 * Returns both a structured list of sources (for programmatic use by
 * the preflection step) and a compact text summary (for hot-tier injection).
 */
export function buildKnowledgeManifest(inputs: ManifestInputs): {
  sources: KnowledgeSource[];
  prompt: string;
} {
  const tracer = getTracer();
  const sources: KnowledgeSource[] = [];

  // ── Machine & Environment ──────────────────────────────────────────────

  if (inputs.cognitiveMap) {
    const machine = inputs.cognitiveMap.getMachine();
    sources.push({
      domain: 'hardware, OS, infrastructure',
      location: '~/.casterly/cognitive-map.yaml § machine',
      populated: machine.hostname !== '',
      retrievalCostTokens: 50,
    });

    const runtime = inputs.cognitiveMap.getRuntime();
    sources.push({
      domain: 'Ollama endpoint, loaded models, Node version',
      location: '~/.casterly/cognitive-map.yaml § runtime',
      populated: runtime.ollamaEndpoint !== '',
      retrievalCostTokens: 40,
    });

    sources.push({
      domain: 'filesystem layout, directory purposes',
      location: '~/.casterly/cognitive-map.yaml § directories',
      populated: inputs.cognitiveMap.getDirectories().length > 0,
      retrievalCostTokens: 100,
    });
  }

  // ── Codebase State ─────────────────────────────────────────────────────

  if (inputs.worldModel) {
    sources.push({
      domain: 'codebase health (tests, typecheck, lint)',
      location: '~/.casterly/world-model.yaml § health',
      populated: true,
      retrievalCostTokens: 80,
    });

    sources.push({
      domain: 'codebase stats (files, lines, branch, commits)',
      location: '~/.casterly/world-model.yaml § stats',
      populated: true,
      retrievalCostTokens: 40,
    });

    sources.push({
      domain: 'active concerns and observations',
      location: '~/.casterly/world-model.yaml § concerns',
      populated: inputs.worldModel.getConcerns().length > 0,
      retrievalCostTokens: 60,
    });

    const userModel = inputs.worldModel.getUserModel();
    sources.push({
      domain: 'user preferences, communication style, priorities',
      location: '~/.casterly/world-model.yaml § userModel',
      populated: userModel !== undefined && userModel.communicationStyle !== '',
      retrievalCostTokens: 50,
    });
  }

  // ── Work State ─────────────────────────────────────────────────────────

  if (inputs.goalStack) {
    sources.push({
      domain: 'current goals, priorities, progress',
      location: '~/.casterly/goals.yaml',
      populated: true,
      retrievalCostTokens: 80,
    });
  }

  if (inputs.issueLog) {
    sources.push({
      domain: 'known issues, past attempts, failure history',
      location: '~/.casterly/issues.yaml',
      populated: true,
      retrievalCostTokens: 100,
    });
  }

  // ── Memory & Learning ──────────────────────────────────────────────────

  if (inputs.journal) {
    sources.push({
      domain: 'narrative history, reflections, handoff notes',
      location: '~/.casterly/journal.jsonl',
      populated: true,
      retrievalCostTokens: 200,
    });
  }

  if (inputs.hasCrystals) {
    sources.push({
      domain: 'permanent learned insights',
      location: '~/.casterly/crystals.yaml',
      populated: true,
      retrievalCostTokens: 50,
    });
  }

  if (inputs.hasConstitution) {
    sources.push({
      domain: 'self-authored operational rules',
      location: '~/.casterly/constitution.yaml',
      populated: true,
      retrievalCostTokens: 60,
    });
  }

  if (inputs.hasSelfModel) {
    sources.push({
      domain: 'my strengths, weaknesses, skill success rates',
      location: '~/.casterly/self-model.yaml',
      populated: true,
      retrievalCostTokens: 60,
    });
  }

  if (inputs.hasSkillFiles) {
    sources.push({
      domain: 'learned procedures and skills',
      location: '~/.casterly/memory/skills.json',
      populated: true,
      retrievalCostTokens: 100,
    });
  }

  if (inputs.hasGraphMemory) {
    sources.push({
      domain: 'entity relationships (files, concepts, patterns)',
      location: '~/.casterly/memory/graph.json',
      populated: true,
      retrievalCostTokens: 150,
    });
  }

  // ── Architecture Self-Knowledge ────────────────────────────────────────

  sources.push({
    domain: 'my architecture (dual-loop, FastLoop/DeepLoop, agent loop)',
    location: 'docs/casterly-plan.md, src/autonomous/',
    populated: true,
    retrievalCostTokens: 300,
  });

  sources.push({
    domain: 'project rules and invariants',
    location: 'docs/rulebook.md',
    populated: true,
    retrievalCostTokens: 150,
  });

  // ── Build prompt ───────────────────────────────────────────────────────

  const populated = sources.filter((s) => s.populated);
  const lines: string[] = [
    '## What I Know & Where To Find It',
    '',
  ];

  for (const s of populated) {
    lines.push(`- **${s.domain}** → ${s.location}`);
  }

  lines.push('');
  lines.push('To answer a question, I MUST retrieve from these sources.');
  lines.push('If none contain the answer, I say so — I NEVER guess.');

  const prompt = lines.join('\n');

  tracer.log('metacognition', 'debug', 'Knowledge manifest built', {
    totalSources: sources.length,
    populatedSources: populated.length,
    promptChars: prompt.length,
  });

  return { sources, prompt };
}
