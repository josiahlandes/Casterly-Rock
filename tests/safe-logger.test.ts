import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { safeLogger } from '../src/logging/safe-logger.js';

// ═══════════════════════════════════════════════════════════════════════════════
// safeLogger
// ═══════════════════════════════════════════════════════════════════════════════

describe('safeLogger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('has info, warn, error, debug methods', () => {
    expect(typeof safeLogger.info).toBe('function');
    expect(typeof safeLogger.warn).toBe('function');
    expect(typeof safeLogger.error).toBe('function');
    expect(typeof safeLogger.debug).toBe('function');
  });

  it('info logs with [INFO] prefix', () => {
    safeLogger.info('Test message');
    expect(logSpy).toHaveBeenCalledWith('[INFO]', 'Test message');
  });

  it('warn logs with [WARN] prefix', () => {
    safeLogger.warn('Warning message');
    expect(logSpy).toHaveBeenCalledWith('[WARN]', 'Warning message');
  });

  it('error logs with [ERROR] prefix', () => {
    safeLogger.error('Error message');
    expect(logSpy).toHaveBeenCalledWith('[ERROR]', 'Error message');
  });

  it('debug logs with [DEBUG] prefix', () => {
    safeLogger.debug('Debug message');
    expect(logSpy).toHaveBeenCalledWith('[DEBUG]', 'Debug message');
  });

  it('includes metadata when provided', () => {
    safeLogger.info('With meta', { key: 'value' });
    expect(logSpy).toHaveBeenCalled();
    const args = logSpy.mock.calls[0]!;
    expect(args[0]).toBe('[INFO]');
    expect(args[1]).toBe('With meta');
    // Third arg is the stringified/redacted meta
    expect(args.length).toBe(3);
    expect(args[2]).toContain('value');
  });

  it('omits metadata arg when undefined', () => {
    safeLogger.info('No meta');
    expect(logSpy).toHaveBeenCalledWith('[INFO]', 'No meta');
    expect(logSpy.mock.calls[0]!.length).toBe(2);
  });

  it('handles unserializable metadata', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    safeLogger.info('Circular', circular);
    expect(logSpy).toHaveBeenCalled();
    // Should not throw, should log [UNSERIALIZABLE]
    const args = logSpy.mock.calls[0]!;
    expect(args[2]).toBe('[UNSERIALIZABLE]');
  });

  it('handles numeric metadata', () => {
    safeLogger.info('Number', 42);
    expect(logSpy).toHaveBeenCalled();
    const args = logSpy.mock.calls[0]!;
    expect(args[2]).toContain('42');
  });
});
