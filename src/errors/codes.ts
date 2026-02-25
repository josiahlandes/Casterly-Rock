/**
 * Casterly Error System
 *
 * Comprehensive error codes with user-friendly messages and actionable suggestions.
 * Error codes are organized by category:
 *
 *   E1xx - Provider errors (Ollama local only)
 *   E3xx - Tool execution errors
 *   E4xx - Configuration errors
 *   E5xx - Network errors
 *   E6xx - Security/Safety errors
 *   E7xx - Session errors
 *   E8xx - Memory errors
 *   E9xx - Skill errors
 *
 * Mac Studio Edition - Local only, no cloud routing.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Error Code Definitions
// ═══════════════════════════════════════════════════════════════════════════════

export interface ErrorDefinition {
  code: string;
  category: string;
  message: string;
  suggestion: string;
  severity: 'warning' | 'error' | 'critical';
}

export const ERROR_CODES: Record<string, ErrorDefinition> = {
  // ─────────────────────────────────────────────────────────────────────────────
  // E1xx - Provider Errors
  // ─────────────────────────────────────────────────────────────────────────────

  E100: {
    code: 'E100',
    category: 'Provider',
    message: 'No providers available',
    suggestion: 'Check that Ollama is running: ollama serve',
    severity: 'critical',
  },

  E101: {
    code: 'E101',
    category: 'Provider',
    message: 'Ollama service not running',
    suggestion: 'Start Ollama with: ollama serve',
    severity: 'error',
  },

  E102: {
    code: 'E102',
    category: 'Provider',
    message: 'Ollama model not found',
    suggestion: 'Pull the model with: ollama pull qwen3:14b',
    severity: 'error',
  },

  E103: {
    code: 'E103',
    category: 'Provider',
    message: 'Ollama request timeout',
    suggestion: 'Model may be loading or system is under heavy load. Try again in a moment.',
    severity: 'warning',
  },

  E104: {
    code: 'E104',
    category: 'Provider',
    message: 'Ollama out of memory',
    suggestion: 'Try a smaller model (llama3.1:8b) or close other applications',
    severity: 'error',
  },

  E120: {
    code: 'E120',
    category: 'Provider',
    message: 'Provider returned empty response',
    suggestion: 'Model may have failed silently. Try rephrasing your request.',
    severity: 'error',
  },

  E121: {
    code: 'E121',
    category: 'Provider',
    message: 'Provider returned invalid response',
    suggestion: 'Unexpected response format. This may be a bug.',
    severity: 'error',
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // E3xx - Tool Execution Errors
  // ─────────────────────────────────────────────────────────────────────────────

  E300: {
    code: 'E300',
    category: 'Tools',
    message: 'Tool execution failed',
    suggestion: 'A command failed to run. Check the command syntax.',
    severity: 'error',
  },

  E301: {
    code: 'E301',
    category: 'Tools',
    message: 'Tool not found',
    suggestion: 'Requested tool is not registered.',
    severity: 'error',
  },

  E302: {
    code: 'E302',
    category: 'Tools',
    message: 'Tool timeout',
    suggestion: 'Command took too long. It may still be running in background.',
    severity: 'warning',
  },

  E303: {
    code: 'E303',
    category: 'Tools',
    message: 'Too many tool iterations',
    suggestion: 'Reached max tool iterations. Task may be too complex.',
    severity: 'warning',
  },

  E304: {
    code: 'E304',
    category: 'Tools',
    message: 'Invalid tool call from model',
    suggestion: 'Model returned malformed tool call. Try rephrasing.',
    severity: 'error',
  },

  E305: {
    code: 'E305',
    category: 'Tools',
    message: 'Tool returned error',
    suggestion: 'Command ran but returned an error. Check the output.',
    severity: 'warning',
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // E4xx - Configuration Errors
  // ─────────────────────────────────────────────────────────────────────────────

  E400: {
    code: 'E400',
    category: 'Config',
    message: 'Configuration file not found',
    suggestion: 'Create config/default.yaml or copy from config/default.yaml.example',
    severity: 'critical',
  },

  E401: {
    code: 'E401',
    category: 'Config',
    message: 'Invalid configuration',
    suggestion: 'Config file has syntax errors. Check YAML formatting.',
    severity: 'critical',
  },

  E402: {
    code: 'E402',
    category: 'Config',
    message: 'Missing required config field',
    suggestion: 'A required configuration field is missing.',
    severity: 'error',
  },

  E403: {
    code: 'E403',
    category: 'Config',
    message: 'Invalid config value',
    suggestion: 'A configuration value is invalid or out of range.',
    severity: 'error',
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // E5xx - Network Errors
  // ─────────────────────────────────────────────────────────────────────────────

  E500: {
    code: 'E500',
    category: 'Network',
    message: 'Connection refused',
    suggestion: 'Service not listening. Check if Ollama/API server is running.',
    severity: 'error',
  },

  E501: {
    code: 'E501',
    category: 'Network',
    message: 'Connection timeout',
    suggestion: 'Network request timed out. Check your connection.',
    severity: 'error',
  },

  E502: {
    code: 'E502',
    category: 'Network',
    message: 'DNS resolution failed',
    suggestion: 'Could not resolve hostname. Check network connection.',
    severity: 'error',
  },

  E503: {
    code: 'E503',
    category: 'Network',
    message: 'SSL/TLS error',
    suggestion: 'Secure connection failed. Check certificates.',
    severity: 'error',
  },

  E504: {
    code: 'E504',
    category: 'Network',
    message: 'Network unreachable',
    suggestion: 'No network connection. Check WiFi/Ethernet.',
    severity: 'error',
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // E6xx - Security/Safety Errors
  // ─────────────────────────────────────────────────────────────────────────────

  E600: {
    code: 'E600',
    category: 'Security',
    message: 'Command blocked by safety filter',
    suggestion: 'This command is not allowed for safety reasons.',
    severity: 'warning',
  },

  E601: {
    code: 'E601',
    category: 'Security',
    message: 'Command requires approval',
    suggestion: 'This action needs explicit confirmation.',
    severity: 'warning',
  },

  E602: {
    code: 'E602',
    category: 'Security',
    message: 'Sensitive data detected in output',
    suggestion: 'Response contained sensitive data that was redacted.',
    severity: 'warning',
  },

  E603: {
    code: 'E603',
    category: 'Security',
    message: 'Permission denied',
    suggestion: 'Insufficient permissions for this operation.',
    severity: 'error',
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // E7xx - Session Errors
  // ─────────────────────────────────────────────────────────────────────────────

  E700: {
    code: 'E700',
    category: 'Session',
    message: 'Session not found',
    suggestion: 'Session may have expired or been cleared.',
    severity: 'warning',
  },

  E701: {
    code: 'E701',
    category: 'Session',
    message: 'Session file corrupted',
    suggestion: 'Session history could not be loaded. Starting fresh.',
    severity: 'warning',
  },

  E702: {
    code: 'E702',
    category: 'Session',
    message: 'Failed to save session',
    suggestion: 'Could not write session file. Check disk space and permissions.',
    severity: 'error',
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // E8xx - Memory Errors
  // ─────────────────────────────────────────────────────────────────────────────

  E800: {
    code: 'E800',
    category: 'Memory',
    message: 'Memory file not found',
    suggestion: 'MEMORY.md does not exist yet. It will be created when needed.',
    severity: 'warning',
  },

  E801: {
    code: 'E801',
    category: 'Memory',
    message: 'Failed to write memory',
    suggestion: 'Could not save to memory file. Check disk space and permissions.',
    severity: 'error',
  },

  E802: {
    code: 'E802',
    category: 'Memory',
    message: 'Memory file corrupted',
    suggestion: 'Memory file could not be parsed. May need manual review.',
    severity: 'warning',
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // E9xx - Skill Errors
  // ─────────────────────────────────────────────────────────────────────────────

  E900: {
    code: 'E900',
    category: 'Skills',
    message: 'Skill not available',
    suggestion: 'Required binary or environment variable not found.',
    severity: 'warning',
  },

  E901: {
    code: 'E901',
    category: 'Skills',
    message: 'Skill file invalid',
    suggestion: 'SKILL.md has syntax errors in frontmatter.',
    severity: 'error',
  },

  E902: {
    code: 'E902',
    category: 'Skills',
    message: 'Skill tool schema invalid',
    suggestion: 'Tool definition in skill has invalid schema.',
    severity: 'error',
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Error Class
// ═══════════════════════════════════════════════════════════════════════════════

export class CasterlyError extends Error {
  code: string;
  category: string;
  suggestion: string;
  severity: 'warning' | 'error' | 'critical';
  details?: Record<string, unknown> | undefined;
  timestamp: string;

  constructor(
    code: keyof typeof ERROR_CODES | string,
    details?: Record<string, unknown>,
    originalError?: Error
  ) {
    const definition = ERROR_CODES[code] || {
      code,
      category: 'Unknown',
      message: 'An unexpected error occurred',
      suggestion: 'Please try again or check the logs.',
      severity: 'error' as const,
    };

    super(definition.message);
    this.name = 'CasterlyError';
    this.code = definition.code;
    this.category = definition.category;
    this.suggestion = definition.suggestion;
    this.severity = definition.severity;
    this.details = details;
    this.timestamp = new Date().toISOString();

    // Preserve original error stack if provided
    if (originalError?.stack) {
      this.stack = `${this.stack}\nCaused by: ${originalError.stack}`;
    }
  }

  /**
   * Format error for user display (no technical details)
   */
  toUserMessage(): string {
    return `[${this.code}] ${this.message}\n→ ${this.suggestion}`;
  }

  /**
   * Format error for iMessage (concise)
   */
  toShortMessage(): string {
    return `Error ${this.code}: ${this.message}. ${this.suggestion}`;
  }

  /**
   * Format error for logging (full details)
   */
  toLogMessage(): string {
    const parts = [
      `[${this.timestamp}] ${this.code} (${this.category}): ${this.message}`,
      `Severity: ${this.severity}`,
      `Suggestion: ${this.suggestion}`,
    ];

    if (this.details) {
      parts.push(`Details: ${JSON.stringify(this.details)}`);
    }

    return parts.join('\n');
  }

  /**
   * Convert to JSON for structured logging
   */
  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      suggestion: this.suggestion,
      severity: this.severity,
      details: this.details,
      timestamp: this.timestamp,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a CasterlyError from an error code
 */
export function createError(
  code: keyof typeof ERROR_CODES,
  details?: Record<string, unknown>,
  originalError?: Error
): CasterlyError {
  return new CasterlyError(code, details, originalError);
}

/**
 * Wrap an unknown error into a CasterlyError
 */
export function wrapError(error: unknown, fallbackCode: keyof typeof ERROR_CODES = 'E121'): CasterlyError {
  if (error instanceof CasterlyError) {
    return error;
  }

  const originalError = error instanceof Error ? error : new Error(String(error));
  const message = originalError.message.toLowerCase();

  // Try to detect specific error types
  if (message.includes('econnrefused') || message.includes('connection refused')) {
    return createError('E500', { originalMessage: originalError.message }, originalError);
  }

  if (message.includes('timeout') || message.includes('timed out')) {
    return createError('E501', { originalMessage: originalError.message }, originalError);
  }

  if (message.includes('enotfound') || message.includes('getaddrinfo')) {
    return createError('E502', { originalMessage: originalError.message }, originalError);
  }

  // NOTE: Cloud-only errors (billing E112, rate-limit E113, auth E111) removed.
  // Casterly is local-only via Ollama — these conditions never arise.

  if (message.includes('model') && message.includes('not found')) {
    return createError('E102', { originalMessage: originalError.message }, originalError);
  }

  if (message.includes('out of memory') || message.includes('oom')) {
    return createError('E104', { originalMessage: originalError.message }, originalError);
  }

  // Default to fallback code
  return createError(fallbackCode, { originalMessage: originalError.message }, originalError);
}

/**
 * Format error for user response based on channel
 */
export function formatErrorForUser(
  error: CasterlyError,
  channel: 'imessage' | 'cli' | 'http' = 'cli'
): string {
  switch (channel) {
    case 'imessage':
      // Concise for text messages
      return error.toShortMessage();

    case 'http':
      // JSON for API responses
      return JSON.stringify(error.toJSON());

    case 'cli':
    default:
      // Full format for CLI
      return error.toUserMessage();
  }
}

/**
 * Check if an error is recoverable
 */
export function isRecoverable(error: CasterlyError): boolean {
  return error.severity === 'warning';
}

/**
 * Check if we should retry after this error
 */
export function shouldRetry(error: CasterlyError): boolean {
  const retryableCodes = ['E103', 'E302', 'E501'];
  return retryableCodes.includes(error.code);
}

/**
 * Get error by code
 */
export function getErrorDefinition(code: string): ErrorDefinition | undefined {
  return ERROR_CODES[code];
}

/**
 * List all error codes by category
 */
export function listErrorsByCategory(category?: string): ErrorDefinition[] {
  const errors = Object.values(ERROR_CODES);
  if (category) {
    return errors.filter((e) => e.category.toLowerCase() === category.toLowerCase());
  }
  return errors;
}
