/**
 * Native Tool Executors
 *
 * Registers all native tool executors with the orchestrator.
 * These replace common bash passthrough operations with typed,
 * validated, structured alternatives.
 */

import type { ToolOrchestrator } from '../orchestrator.js';
import { createReadFileExecutor } from './read-file.js';
import { createWriteFileExecutor } from './write-file.js';
import { createListFilesExecutor } from './list-files.js';
import { createSearchFilesExecutor } from './search-files.js';

export { createReadFileExecutor } from './read-file.js';
export { createWriteFileExecutor } from './write-file.js';
export { createListFilesExecutor } from './list-files.js';
export { createSearchFilesExecutor } from './search-files.js';

/**
 * Register all native tool executors with the orchestrator.
 * Call this after creating the orchestrator and bash executor.
 */
export function registerNativeExecutors(orchestrator: ToolOrchestrator): void {
  orchestrator.registerExecutor(createReadFileExecutor());
  orchestrator.registerExecutor(createWriteFileExecutor());
  orchestrator.registerExecutor(createListFilesExecutor());
  orchestrator.registerExecutor(createSearchFilesExecutor());
}
