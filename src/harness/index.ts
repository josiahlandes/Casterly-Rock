/**
 * AutoHarness Module
 *
 * Automatically synthesizes code harnesses to validate and constrain
 * LLM agent tool calls. Inspired by:
 *
 *   Lou et al. (2026). "AutoHarness: improving LLM agents by automatically
 *   synthesizing a code harness." arXiv:2603.03329.
 *
 * Usage:
 *   import { createHarnessStore, createHarnessExecutor, wrapWithHarness } from './harness';
 *
 *   const store = createHarnessStore();
 *   await store.load();
 *
 *   const executor = createHarnessExecutor();
 *   const wrapped = wrapWithHarness(orchestrator, store, executor);
 */

export type {
  HarnessMode,
  HarnessDefinition,
  HarnessContext,
  RecentToolCall,
  HarnessVerdict,
  FilteredActions,
  PolicyAction,
  HarnessFailure,
  RefinementRequest,
  RefinementResult,
  HarnessMetrics,
} from './types.js';

export { HarnessStore, createHarnessStore } from './store.js';
export type { HarnessStoreConfig } from './store.js';

export { HarnessSynthesizer, createHarnessSynthesizer } from './synthesizer.js';
export type { HarnessSynthesizerConfig } from './synthesizer.js';

export { HarnessExecutor, createHarnessExecutor } from './executor.js';
export type { HarnessExecutorConfig } from './executor.js';

export { HarnessOrchestratorWrapper, wrapWithHarness } from './orchestrator-wrapper.js';
export type { HarnessWrapperConfig } from './orchestrator-wrapper.js';
