/**
 * Interface Layer
 * The layer between raw user input and the LLM prompt
 * Handles bootstrap files, prompt construction, sessions, and context assembly
 */

// Bootstrap files
export {
  BOOTSTRAP_FILES,
  type BootstrapFileName,
  type BootstrapConfig,
  type BootstrapFile,
  type BootstrapResult,
  getDefaultWorkspacePath,
  getWorkspacePaths,
  findWorkspacePath,
  loadBootstrapFile,
  loadBootstrapFiles,
  formatBootstrapSection,
} from './bootstrap.js';

// Prompt builder
export {
  type PromptMode,
  type Channel,
  type PromptBuilderOptions,
  type BuiltPrompt,
  buildSystemPrompt,
  buildIMessagePrompt,
} from './prompt-builder.js';

// Session management
export {
  type SessionScope,
  type SessionConfig,
  type ConversationMessage,
  type SessionState,
  type Session,
  type SessionManager,
  generateSessionKey,
  getSessionFilePath,
  loadSessionState,
  saveSessionState,
  createSession,
  createSessionManager,
} from './session.js';

// Context assembly
export {
  type ContextConfig,
  type ContextAssemblyOptions,
  type AssembledContext,
  estimateTokens,
  formatMessage,
  formatHistory,
  trimHistoryToFit,
  assembleContext,
  assembleIMessageContext,
} from './context.js';

// Memory system
export {
  type MemoryConfig,
  type MemoryEntry,
  type MemoryState,
  type MemoryManager,
  type MemoryCommand,
  getTodayDate,
  getMemoryPath,
  getDailyLogPath,
  ensureMemoryDirs,
  readLongTermMemory,
  writeLongTermMemory,
  readDailyLog,
  appendToDailyLog,
  getRecentDailyLogs,
  loadMemoryState,
  formatMemorySection,
  createMemoryManager,
  parseMemoryCommands,
  executeMemoryCommands,
} from './memory.js';

// Multi-user management
export {
  type UserProfile,
  type UsersConfig,
  normalizePhoneNumber,
  getUsersConfigPath,
  getUserWorkspaceBasePath,
  loadUsersConfig,
  saveUsersConfig,
  findUserByPhone,
  getAllowedPhoneNumbers,
  ensureUserWorkspace,
  createDefaultBootstrapFiles,
  addUser,
  removeUser,
  setUserEnabled,
  listUsers,
} from './users.js';
