/**
 * Tool Map — Lightweight manifest for progressive schema hydration.
 *
 * This is the key optimization for small models: instead of sending all 96 tool
 * schemas (thousands of tokens), send this compact map first. The model identifies
 * which categories it needs, and only those get "hydrated" (full schemas loaded).
 *
 * For large-context models, all schemas are sent at once (backwards compatible).
 *
 * Usage:
 *   import { TOOL_MAP, getToolCategory, getCategoryTools } from './tool-map.js';
 *
 *   // Find which category a tool belongs to
 *   getToolCategory('git_commit')  // → 'git'
 *
 *   // Get all tools in a category
 *   getCategoryTools('git')  // → ['git_status', 'git_diff', 'git_commit', 'git_log']
 */

import type { CategoryName } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tool Map Entry
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolMapEntry {
  /** Which category this tool belongs to */
  category: CategoryName;
  /** One-line description (for the compact map sent to small models) */
  brief: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The Map
// ─────────────────────────────────────────────────────────────────────────────

export const TOOL_MAP: Record<string, ToolMapEntry> = {
  // ── core ──
  think:       { category: 'core', brief: 'Reason step-by-step before acting' },
  read_file:   { category: 'core', brief: 'Read file contents with line numbers' },
  edit_file:   { category: 'core', brief: 'Replace text in a file' },
  create_file: { category: 'core', brief: 'Create a new file' },
  grep:        { category: 'core', brief: 'Search file contents by regex' },
  glob:        { category: 'core', brief: 'Find files by name pattern' },
  bash:        { category: 'core', brief: 'Execute a shell command' },

  // ── quality ──
  run_tests: { category: 'quality', brief: 'Run the test suite' },
  typecheck: { category: 'quality', brief: 'Run TypeScript type checker' },
  lint:      { category: 'quality', brief: 'Run the project linter' },

  // ── git ──
  git_status: { category: 'git', brief: 'Show git branch and working tree status' },
  git_diff:   { category: 'git', brief: 'Show git diff (staged or unstaged)' },
  git_commit: { category: 'git', brief: 'Stage files and commit' },
  git_log:    { category: 'git', brief: 'Show recent git history' },

  // ── state ──
  file_issue:        { category: 'state', brief: 'File or update an issue' },
  close_issue:       { category: 'state', brief: 'Resolve an issue' },
  update_goal:       { category: 'state', brief: 'Update goal status or notes' },
  update_world_model: { category: 'state', brief: 'Track or resolve a world model concern' },

  // ── reasoning ──
  delegate:         { category: 'reasoning', brief: 'Send sub-task to another model' },
  adversarial_test: { category: 'reasoning', brief: 'Generate adversarial test cases' },
  parallel_reason:  { category: 'reasoning', brief: 'Send problem to multiple models in parallel' },
  meta:             { category: 'reasoning', brief: 'Override default pipeline strategy' },
  classify:         { category: 'reasoning', brief: 'Classify a task by type and complexity' },
  plan:             { category: 'reasoning', brief: 'Generate a structured execution plan' },
  verify:           { category: 'reasoning', brief: 'Verify task completion against criteria' },

  // ── memory ──
  recall:          { category: 'memory', brief: 'Search memory for past observations' },
  archive:         { category: 'memory', brief: 'Save a note to memory' },
  recall_journal:  { category: 'memory', brief: 'Search journal entries' },
  consolidate:     { category: 'memory', brief: 'Summarize and clear working memory' },
  semantic_recall: { category: 'memory', brief: 'Hybrid keyword + semantic memory search' },

  // ── communication ──
  message_user: { category: 'communication', brief: 'Send a message to the user' },

  // ── introspection ──
  peek_queue:    { category: 'introspection', brief: 'View pending event queue' },
  check_budget:  { category: 'introspection', brief: 'Check turn/token budget usage' },
  list_context:  { category: 'introspection', brief: 'View memory tier contents' },
  review_steps:  { category: 'introspection', brief: 'Review tool call history this cycle' },
  assess_self:   { category: 'introspection', brief: 'Query self-model for skill assessment' },
  load_context:  { category: 'introspection', brief: 'Load memory entries into warm tier' },
  evict_context: { category: 'introspection', brief: 'Remove entry from warm tier' },
  set_budget:    { category: 'introspection', brief: 'Adjust memory tier token budgets' },

  // ── scheduling ──
  schedule:        { category: 'scheduling', brief: 'Schedule a future task or reminder' },
  list_schedules:  { category: 'scheduling', brief: 'List active scheduled jobs' },
  cancel_schedule: { category: 'scheduling', brief: 'Cancel a scheduled job' },

  // ── vision-t1 ──
  crystallize:     { category: 'vision-t1', brief: 'Promote insight to permanent crystal' },
  dissolve:        { category: 'vision-t1', brief: 'Remove an invalid crystal' },
  list_crystals:   { category: 'vision-t1', brief: 'List all crystals with confidence' },
  create_rule:     { category: 'vision-t1', brief: 'Create an operational rule' },
  update_rule:     { category: 'vision-t1', brief: 'Update an existing rule' },
  list_rules:      { category: 'vision-t1', brief: 'List constitutional rules' },
  replay:          { category: 'vision-t1', brief: 'Replay a past execution trace' },
  compare_traces:  { category: 'vision-t1', brief: 'Compare two execution traces' },
  search_traces:   { category: 'vision-t1', brief: 'Search past traces by criteria' },

  // ── vision-t2 ──
  edit_prompt:       { category: 'vision-t2', brief: 'Edit your own system prompt' },
  revert_prompt:     { category: 'vision-t2', brief: 'Revert prompt to a previous version' },
  get_prompt:        { category: 'vision-t2', brief: 'View current prompt and history' },
  shadow:            { category: 'vision-t2', brief: 'Record an alternative approach' },
  list_shadows:      { category: 'vision-t2', brief: 'List recent shadow judgments' },
  create_tool:       { category: 'vision-t2', brief: 'Create a new custom tool' },
  manage_tools:      { category: 'vision-t2', brief: 'Archive/reactivate/delete custom tools' },
  list_custom_tools: { category: 'vision-t2', brief: 'List all custom tools' },

  // ── vision-t3 ──
  run_challenges:       { category: 'vision-t3', brief: 'Generate self-testing challenges' },
  challenge_history:    { category: 'vision-t3', brief: 'View challenge history and skill stats' },
  evolve_prompt:        { category: 'vision-t3', brief: 'Manage prompt genetic algorithm' },
  evolution_status:     { category: 'vision-t3', brief: 'View prompt evolution state' },
  extract_training_data: { category: 'vision-t3', brief: 'Extract LoRA training data' },
  list_adapters:        { category: 'vision-t3', brief: 'List LoRA adapters' },
  load_adapter:         { category: 'vision-t3', brief: 'Load a LoRA adapter' },

  // ── dream ──
  consolidate_reflections: { category: 'dream', brief: 'Archive consolidated reflection insights' },
  reorganize_goals:        { category: 'dream', brief: 'Prune stale goals, create from issues' },
  explore_codebase:        { category: 'dream', brief: 'Find fragile and abandoned code' },
  rebuild_self_model:      { category: 'dream', brief: 'Recalculate self-model from history' },
  write_retrospective:     { category: 'dream', brief: 'Write retrospective to MEMORY.md' },

  // ── advanced-memory ──
  link_memories:          { category: 'advanced-memory', brief: 'Create typed link between memory entries' },
  get_links:              { category: 'advanced-memory', brief: 'Get links for a memory entry' },
  traverse_links:         { category: 'advanced-memory', brief: 'Traverse link network from entry' },
  audn_enqueue:           { category: 'advanced-memory', brief: 'Queue memory for AUDN evaluation' },
  audn_status:            { category: 'advanced-memory', brief: 'Check AUDN consolidation queue' },
  entropy_score:          { category: 'advanced-memory', brief: 'Calculate text entropy score' },
  evaluate_tiers:         { category: 'advanced-memory', brief: 'Evaluate tier migration recommendations' },
  snapshot_memory:        { category: 'advanced-memory', brief: 'Create point-in-time memory snapshot' },
  list_snapshots:         { category: 'advanced-memory', brief: 'List memory snapshots' },
  diff_snapshots:         { category: 'advanced-memory', brief: 'Compare two memory snapshots' },
  evolve_memory:          { category: 'advanced-memory', brief: 'Transform memory (strengthen/weaken/merge/split)' },
  evolution_lineage:      { category: 'advanced-memory', brief: 'Get evolution history of a memory' },
  evolution_log:          { category: 'advanced-memory', brief: 'View recent evolution events' },
  register_temporal:      { category: 'advanced-memory', brief: 'Register memory for TTL tracking' },
  check_freshness:        { category: 'advanced-memory', brief: 'Check memory freshness/expiry' },
  sweep_expired:          { category: 'advanced-memory', brief: 'Sweep expired memories for deletion' },
  learn_skill:            { category: 'advanced-memory', brief: 'Learn a reusable procedural skill' },
  refine_skill:           { category: 'advanced-memory', brief: 'Refine an existing skill' },
  search_skills:          { category: 'advanced-memory', brief: 'Search skills by query' },
  record_skill_use:       { category: 'advanced-memory', brief: 'Record skill use and outcome' },
  dream_concurrency_config: { category: 'advanced-memory', brief: 'View concurrent dream config' },
  graph_add_node:         { category: 'advanced-memory', brief: 'Add entity node to knowledge graph' },
  graph_add_edge:         { category: 'advanced-memory', brief: 'Add relationship edge in graph' },
  graph_search:           { category: 'advanced-memory', brief: 'Search knowledge graph nodes' },
  check_memory:           { category: 'advanced-memory', brief: 'Validate memory before storage' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Lookup Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Get the category a tool belongs to. */
export function getToolCategory(toolName: string): CategoryName | undefined {
  return TOOL_MAP[toolName]?.category;
}

/** Get all tool names in a category. */
export function getCategoryTools(category: CategoryName): string[] {
  return Object.entries(TOOL_MAP)
    .filter(([, entry]) => entry.category === category)
    .map(([name]) => name);
}

/** Get all category names that have at least one tool. */
export function getAllCategories(): CategoryName[] {
  const seen = new Set<CategoryName>();
  for (const entry of Object.values(TOOL_MAP)) {
    seen.add(entry.category);
  }
  return [...seen];
}

/**
 * Build a compact tool manifest string for small models.
 *
 * This is ~2KB instead of ~50KB for full schemas — a 25x reduction.
 * The model reads this and tells the agent loop which categories
 * it needs hydrated.
 *
 * Format:
 *   [core] think: Reason step-by-step | read_file: Read file contents | ...
 *   [git]  git_status: Show branch status | git_diff: Show diff | ...
 */
export function buildCompactManifest(categories?: CategoryName[]): string {
  const allCats = categories ?? getAllCategories();
  const lines: string[] = [];

  for (const cat of allCats) {
    const tools = getCategoryTools(cat);
    const entries = tools.map((name) => `${name}: ${TOOL_MAP[name]!.brief}`);
    lines.push(`[${cat}] ${entries.join(' | ')}`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Task-to-Category Mapping (for automatic category selection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default category sets for common task types.
 * The classifier output maps to one of these sets.
 * 'core' is always included.
 */
export const TASK_CATEGORY_PRESETS: Record<string, CategoryName[]> = {
  /** Minimal set for simple coding tasks */
  coding_simple: ['core', 'quality', 'git', 'state'],

  /** Full set for complex multi-file tasks */
  coding_complex: ['core', 'quality', 'git', 'state', 'reasoning', 'memory', 'introspection'],

  /** Conversation / Q&A — recall, reasoning, messaging, and scheduling */
  conversation: ['core', 'memory', 'reasoning', 'communication', 'scheduling'],

  /** Dream cycle — everything dream-related */
  dream_cycle: ['core', 'dream', 'advanced-memory', 'vision-t1', 'vision-t3', 'introspection', 'memory'],

  /** Self-improvement — vision tiers + dream */
  self_improvement: ['core', 'vision-t1', 'vision-t2', 'vision-t3', 'dream', 'introspection'],

  /** Full — all categories (for large-context models) */
  full: [
    'core', 'quality', 'git', 'state', 'reasoning', 'memory',
    'communication', 'introspection', 'scheduling', 'vision-t1',
    'vision-t2', 'vision-t3', 'dream', 'advanced-memory',
  ],
};
