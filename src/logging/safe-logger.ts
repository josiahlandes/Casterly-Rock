import { redactSensitiveText } from '../security/redactor.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Minimum log level. Messages below this level are suppressed.
 * Controlled by the LOG_LEVEL environment variable (default: "info").
 */
let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';
if (!(minLevel in LEVEL_PRIORITY)) {
  minLevel = 'info';
}

function sanitize(value: unknown): string {
  if (value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }

  try {
    const serialized = JSON.stringify(value);
    return redactSensitiveText(serialized);
  } catch {
    return '[UNSERIALIZABLE]';
  }
}

function log(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const safeMessage = redactSensitiveText(message);
  const safeMeta = sanitize(meta);
  const prefix = `[${level.toUpperCase()}]`;

  if (safeMeta) {
    console.log(prefix, safeMessage, safeMeta);
    return;
  }

  console.log(prefix, safeMessage);
}

export const safeLogger = {
  info(message: string, meta?: unknown): void {
    log('info', message, meta);
  },
  warn(message: string, meta?: unknown): void {
    log('warn', message, meta);
  },
  error(message: string, meta?: unknown): void {
    log('error', message, meta);
  },
  debug(message: string, meta?: unknown): void {
    log('debug', message, meta);
  },
  /** Change the minimum log level at runtime. */
  setLevel(level: LogLevel): void {
    minLevel = level;
  },
  /** Get the current minimum log level. */
  getLevel(): LogLevel {
    return minLevel;
  },
};
