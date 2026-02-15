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
import { createReadDocumentExecutor } from './read-document.js';
import { createEditFileExecutor } from './edit-file.js';
import { createGlobFilesExecutor } from './glob-files.js';
import { createGrepFilesExecutor } from './grep-files.js';
import { createValidateFilesExecutor } from './validate-files.js';
import { createSendMessageExecutor } from './send-message.js';
import { createCalendarReadExecutor } from './calendar-read.js';
import { createReminderCreateExecutor } from './reminder-create.js';
import { createHttpGetExecutor } from './http-get.js';

export { createReadFileExecutor } from './read-file.js';
export { createWriteFileExecutor } from './write-file.js';
export { createListFilesExecutor } from './list-files.js';
export { createSearchFilesExecutor } from './search-files.js';
export { createReadDocumentExecutor } from './read-document.js';
export { createEditFileExecutor } from './edit-file.js';
export { createGlobFilesExecutor } from './glob-files.js';
export { createGrepFilesExecutor } from './grep-files.js';
export { createValidateFilesExecutor } from './validate-files.js';
export { createSendMessageExecutor } from './send-message.js';
export { createCalendarReadExecutor } from './calendar-read.js';
export { createReminderCreateExecutor } from './reminder-create.js';
export { createHttpGetExecutor } from './http-get.js';

/**
 * Register all native tool executors with the orchestrator.
 * Call this after creating the orchestrator and bash executor.
 */
export function registerNativeExecutors(orchestrator: ToolOrchestrator): void {
  // Core file tools
  orchestrator.registerExecutor(createReadFileExecutor());
  orchestrator.registerExecutor(createWriteFileExecutor());
  orchestrator.registerExecutor(createListFilesExecutor());
  orchestrator.registerExecutor(createSearchFilesExecutor());
  orchestrator.registerExecutor(createReadDocumentExecutor());
  // Coding tools (powered by src/coding/ module)
  orchestrator.registerExecutor(createEditFileExecutor());
  orchestrator.registerExecutor(createGlobFilesExecutor());
  orchestrator.registerExecutor(createGrepFilesExecutor());
  orchestrator.registerExecutor(createValidateFilesExecutor());
  // Messaging
  orchestrator.registerExecutor(createSendMessageExecutor());
  // Productivity (macOS native + HTTP)
  orchestrator.registerExecutor(createCalendarReadExecutor());
  orchestrator.registerExecutor(createReminderCreateExecutor());
  orchestrator.registerExecutor(createHttpGetExecutor());
}
