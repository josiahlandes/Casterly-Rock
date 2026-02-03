import { redactSensitiveText } from '../security/redactor.js';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

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
  }
};
