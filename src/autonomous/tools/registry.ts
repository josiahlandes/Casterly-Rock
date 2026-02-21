/**
 * Tool Registry — Category-aware toolkit builder with progressive hydration.
 *
 * This module wraps the existing agent-tools monolith and adds:
 *
 * 1. **Category filtering** — Build a toolkit with only the categories
 *    a small model needs (e.g., `buildFilteredToolkit(['core', 'git', 'quality'])`).
 *
 * 2. **Tool map routing** — O(1) lookup from tool name → category.
 *
 * 3. **Progressive hydration** — Small models get a compact manifest (~2KB)
 *    instead of full schemas (~50KB). They request categories, which get
 *    hydrated on the next turn.
 *
 * For large-context models, `buildAgentToolkit` works exactly as before —
 * all 96 tools are sent. The new path is opt-in.
 *
 * Architecture:
 *   ┌─────────────────────────────────────┐
 *   │         Tool Map (tool-map.ts)      │  ~2KB compact manifest
 *   │  tool_name → { category, brief }   │
 *   └───────────────┬─────────────────────┘
 *                   │ routes to
 *   ┌───────────────▼─────────────────────┐
 *   │       Registry (this file)          │  category-aware builder
 *   │  buildFilteredToolkit(categories)   │
 *   └───────────────┬─────────────────────┘
 *                   │ delegates to
 *   ┌───────────────▼─────────────────────┐
 *   │    agent-tools.ts (monolith)        │  existing 96 schemas + executors
 *   │    buildAgentToolkit(config, state)  │
 *   └─────────────────────────────────────┘
 */

import type { ToolSchema, NativeToolCall, NativeToolResult } from '../../tools/schemas/types.js';
import type { AgentToolkitConfig, AgentToolkit, AgentState } from './types.js';
import type { CategoryName } from './types.js';
import type { LlmProvider } from '../../providers/base.js';
import { TOOL_MAP, getCategoryTools, buildCompactManifest, TASK_CATEGORY_PRESETS } from './tool-map.js';
import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Filtered Toolkit Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a filtered toolkit containing only tools from the specified categories.
 *
 * This is the key optimization for small models: instead of sending all 96 tool
 * schemas, send only the 10-15 tools relevant to the current task.
 *
 * @param fullToolkit - The complete toolkit (from buildAgentToolkit)
 * @param categories - Which categories to include
 * @returns A filtered toolkit with only the matching schemas + executors
 */
export function buildFilteredToolkit(
  fullToolkit: AgentToolkit,
  categories: CategoryName[],
): AgentToolkit {
  const tracer = getTracer();
  const categorySet = new Set(categories);

  // Collect tool names for the requested categories
  const allowedTools = new Set<string>();
  for (const cat of categories) {
    for (const toolName of getCategoryTools(cat)) {
      allowedTools.add(toolName);
    }
  }

  // Filter schemas
  const filteredSchemas = fullToolkit.schemas.filter(
    (s) => allowedTools.has(s.name),
  );

  tracer.log('agent-loop', 'info', `Filtered toolkit: ${filteredSchemas.length}/${fullToolkit.schemas.length} tools from categories [${categories.join(', ')}]`);

  return {
    schemas: filteredSchemas,
    toolNames: filteredSchemas.map((s) => s.name),

    async execute(call: NativeToolCall): Promise<NativeToolResult> {
      // Allow execution of any tool (even if not in filtered schemas)
      // because the model might call a tool from a category that was
      // hydrated after the initial filter.
      return fullToolkit.execute(call);
    },
  };
}

/**
 * Build a filtered toolkit using a task type preset.
 *
 * @param fullToolkit - The complete toolkit
 * @param taskType - One of the TASK_CATEGORY_PRESETS keys
 * @returns A filtered toolkit with the preset's categories
 */
export function buildPresetToolkit(
  fullToolkit: AgentToolkit,
  taskType: keyof typeof TASK_CATEGORY_PRESETS,
): AgentToolkit {
  const categories = TASK_CATEGORY_PRESETS[taskType] ?? TASK_CATEGORY_PRESETS['full']!;
  return buildFilteredToolkit(fullToolkit, categories);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hydration Support
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hydrate additional categories into an existing filtered toolkit.
 *
 * Use this when the model requests tools from categories it doesn't have yet.
 * The new schemas are appended; executors for all tools are always available.
 *
 * @param currentToolkit - The currently active (filtered) toolkit
 * @param fullToolkit - The complete toolkit (for sourcing new schemas)
 * @param additionalCategories - Categories to add
 * @returns A new toolkit with the additional schemas merged in
 */
export function hydrateCategories(
  currentToolkit: AgentToolkit,
  fullToolkit: AgentToolkit,
  additionalCategories: CategoryName[],
): AgentToolkit {
  const tracer = getTracer();
  const currentNames = new Set(currentToolkit.toolNames);

  // Collect new tool names
  const newTools = new Set<string>();
  for (const cat of additionalCategories) {
    for (const toolName of getCategoryTools(cat)) {
      if (!currentNames.has(toolName)) {
        newTools.add(toolName);
      }
    }
  }

  if (newTools.size === 0) {
    return currentToolkit;
  }

  // Get new schemas from the full toolkit
  const newSchemas = fullToolkit.schemas.filter((s) => newTools.has(s.name));
  const mergedSchemas = [...currentToolkit.schemas, ...newSchemas];

  tracer.log('agent-loop', 'info', `Hydrated ${newSchemas.length} tools from categories [${additionalCategories.join(', ')}]`);

  return {
    schemas: mergedSchemas,
    toolNames: mergedSchemas.map((s) => s.name),
    execute: fullToolkit.execute.bind(fullToolkit),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports for convenience
// ─────────────────────────────────────────────────────────────────────────────

export {
  TOOL_MAP,
  getCategoryTools,
  buildCompactManifest,
  TASK_CATEGORY_PRESETS,
} from './tool-map.js';

export type {
  AgentState,
  AgentToolkit,
  AgentToolkitConfig,
  CycleIntrospection,
  CategoryName,
  ToolCategory,
  ExecutorContext,
} from './types.js';
