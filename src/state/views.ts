/**
 * Role-Scoped View Types
 *
 * Defines what each role (planner, coder, reviewer) can see of system state.
 * Views are narrow projections of AllStores — each role gets only the state
 * it needs, enforcing least-privilege at the type level.
 *
 * - PlannerView: Rich context for planning (world model, goals, issues, skills, memory systems).
 * - CoderView: Minimal — just projectDir and toolkit. The coder doesn't need state stores.
 * - ReviewerView: Read-only access for informed review without mutation risk.
 */

import type { WorldModel } from '../autonomous/world-model.js';
import type { GoalStack } from '../autonomous/goal-stack.js';
import type { IssueLog } from '../autonomous/issue-log.js';
import type { SkillFilesManager } from '../autonomous/memory/skill-files.js';
import type { Journal } from '../autonomous/journal.js';
import type { ContextManager } from '../autonomous/context-manager.js';
import type { LinkNetwork } from '../autonomous/memory/link-network.js';
import type { MemoryEvolution } from '../autonomous/memory/memory-evolution.js';
import type { GraphMemory } from '../autonomous/memory/graph-memory.js';
import type { AgentToolkit } from '../autonomous/tools/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Planner View
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the planner sees — rich context for planning decisions.
 *
 * Includes world model (codebase health), goal stack (priorities),
 * issue log (known problems), skill files (learned capabilities),
 * journal (narrative memory), context manager (tiered memory),
 * link network (memory relationships), memory evolution (memory ops),
 * and graph memory (entity-relationship knowledge).
 */
export interface PlannerView {
  worldModel: WorldModel;
  goalStack: GoalStack;
  issueLog: IssueLog;
  skillFiles: SkillFilesManager;
  journal: Journal;
  contextManager: ContextManager;
  linkNetwork: LinkNetwork;
  memoryEvolution: MemoryEvolution;
  graphMemory: GraphMemory;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coder View
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the coder sees — minimal context, just the project and tools.
 *
 * The coder doesn't need access to state stores. It operates on files
 * via the toolkit (read_file, edit_file, grep, bash, etc.) and knows
 * where the project lives.
 */
export interface CoderView {
  projectDir: string;
  toolkit: AgentToolkit | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reviewer View
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the reviewer sees — read-only state for informed review.
 *
 * The reviewer can inspect world model, goals, and issues to understand
 * context, but cannot mutate them. Readonly<T> enforces this at the
 * type level.
 */
export interface ReviewerView {
  worldModel: Readonly<WorldModel>;
  goalStack: Readonly<GoalStack>;
  issueLog: Readonly<IssueLog>;
}
