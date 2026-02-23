/**
 * Tool System — Category-based tool architecture.
 *
 * This module provides the public API for the tool system:
 *
 * - `buildFilteredToolkit()` — Build a toolkit with only specific categories
 * - `buildPresetToolkit()` — Build a toolkit using a task-type preset
 * - `hydrateCategories()` — Progressively add categories to an active toolkit
 * - `buildCompactManifest()` — Generate a ~2KB tool index for small models
 * - `TOOL_MAP` — O(1) lookup from tool name → category
 * - `TASK_CATEGORY_PRESETS` — Default category sets for common task types
 *
 * The full toolkit is still built by `buildAgentToolkit()` from `agent-tools.ts`.
 * This module wraps it with category-awareness and progressive hydration.
 */

export {
  buildFilteredToolkit,
  buildPresetToolkit,
  hydrateCategories,
  buildCompactManifest,
  TOOL_MAP,
  getCategoryTools,
  TASK_CATEGORY_PRESETS,
} from './registry.js';

export type {
  AgentState,
  AgentToolkit,
  AgentToolkitConfig,
  CycleIntrospection,
  CategoryName,
  ToolCategory,
  ExecutorContext,
  ToolExecutorFn,
} from './types.js';

export { getToolCategory, getAllCategories } from './tool-map.js';

export type { ToolMapEntry } from './tool-map.js';
