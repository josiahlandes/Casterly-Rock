import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  DebugTracer,
  getTracer,
  initTracer,
  resetTracer,
} from '../src/autonomous/debug.js';
import type { DebugListener, DebugSubsystem, DebugLevel, TraceSpan } from '../src/autonomous/debug.js';

// ── Test Helpers ───────────────────────────────────────────────────────────

/**
 * A listener that captures all debug events for assertion.
 */
class CapturingListener implements DebugListener {
  spans: { type: 'start' | 'end'; span: TraceSpan }[] = [];
  logs: { subsystem: DebugSubsystem; level: DebugLevel; message: string; meta?: unknown }[] = [];

  onSpanStart(span: TraceSpan): void {
    this.spans.push({ type: 'start', span: { ...span } });
  }

  onSpanEnd(span: TraceSpan): void {
    this.spans.push({ type: 'end', span: { ...span } });
  }

  onLog(subsystem: DebugSubsystem, level: DebugLevel, message: string, meta?: unknown): void {
    this.logs.push({ subsystem, level, message, meta });
  }

  reset(): void {
    this.spans = [];
    this.logs = [];
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('DebugTracer', () => {
  let tracer: DebugTracer;
  let listener: CapturingListener;

  beforeEach(() => {
    resetTracer();
    tracer = new DebugTracer({ enabled: true, level: 'trace', timestamps: false });
    listener = new CapturingListener();
    tracer.addListener(listener);
  });

  afterEach(() => {
    tracer.reset();
    tracer.clearListeners();
  });

  describe('span management', () => {
    it('creates and closes spans with correct lifecycle', () => {
      const span = tracer.startSpan('world-model', 'test-operation');

      expect(span.id).toBe('span-1');
      expect(span.subsystem).toBe('world-model');
      expect(span.name).toBe('test-operation');
      expect(span.status).toBe('running');
      expect(span.depth).toBe(0);
      expect(span.parentId).toBeUndefined();

      span.status = 'success';
      tracer.endSpan(span);

      expect(span.endTime).toBeDefined();
      expect(span.status).toBe('success');
    });

    it('nests spans correctly with parent-child relationships', () => {
      const parent = tracer.startSpan('world-model', 'parent');
      const child = tracer.startSpan('world-model', 'child');

      expect(child.parentId).toBe(parent.id);
      expect(child.depth).toBe(1);

      const grandchild = tracer.startSpan('world-model', 'grandchild');

      expect(grandchild.parentId).toBe(child.id);
      expect(grandchild.depth).toBe(2);

      tracer.endSpan(grandchild);
      tracer.endSpan(child);
      tracer.endSpan(parent);

      expect(tracer.getSpanDepth()).toBe(0);
    });

    it('tracks active spans correctly', () => {
      const span1 = tracer.startSpan('world-model', 'op1');
      const span2 = tracer.startSpan('goal-stack', 'op2');

      expect(tracer.getActiveSpans()).toHaveLength(2);

      tracer.endSpan(span2);

      expect(tracer.getActiveSpans()).toHaveLength(1);

      tracer.endSpan(span1);

      expect(tracer.getActiveSpans()).toHaveLength(0);
    });

    it('notifies listeners on span start and end', () => {
      const span = tracer.startSpan('world-model', 'test');

      expect(listener.spans).toHaveLength(1);
      expect(listener.spans[0]?.type).toBe('start');
      expect(listener.spans[0]?.span.name).toBe('test');

      tracer.endSpan(span);

      expect(listener.spans).toHaveLength(2);
      expect(listener.spans[1]?.type).toBe('end');
    });
  });

  describe('withSpan', () => {
    it('wraps async operations and sets success on completion', async () => {
      const result = await tracer.withSpan('world-model', 'async-op', async () => {
        return 42;
      });

      expect(result).toBe(42);

      const endEvent = listener.spans.find((s) => s.type === 'end');
      expect(endEvent?.span.status).toBe('success');
    });

    it('sets failure status on error and re-throws', async () => {
      const error = new Error('test error');

      await expect(
        tracer.withSpan('world-model', 'failing-op', async () => {
          throw error;
        }),
      ).rejects.toThrow('test error');

      const endEvent = listener.spans.find((s) => s.type === 'end');
      expect(endEvent?.span.status).toBe('failure');
      expect(endEvent?.span.error).toBe('test error');
    });

    it('records span metadata', async () => {
      await tracer.withSpan(
        'world-model',
        'metadata-op',
        async () => 'ok',
        { key: 'value', count: 5 },
      );

      const startEvent = listener.spans.find((s) => s.type === 'start');
      expect(startEvent?.span.metadata).toEqual({ key: 'value', count: 5 });
    });
  });

  describe('withSpanSync', () => {
    it('wraps sync operations and sets success', () => {
      const result = tracer.withSpanSync('goal-stack', 'sync-op', () => {
        return 'done';
      });

      expect(result).toBe('done');

      const endEvent = listener.spans.find((s) => s.type === 'end');
      expect(endEvent?.span.status).toBe('success');
    });

    it('sets failure on sync error and re-throws', () => {
      expect(() =>
        tracer.withSpanSync('goal-stack', 'sync-fail', () => {
          throw new Error('sync error');
        }),
      ).toThrow('sync error');

      const endEvent = listener.spans.find((s) => s.type === 'end');
      expect(endEvent?.span.status).toBe('failure');
    });
  });

  describe('logging', () => {
    it('logs messages at configured level', () => {
      tracer.log('world-model', 'info', 'test message', { data: 123 });

      expect(listener.logs).toHaveLength(1);
      expect(listener.logs[0]?.subsystem).toBe('world-model');
      expect(listener.logs[0]?.level).toBe('info');
      expect(listener.logs[0]?.message).toBe('test message');
      expect(listener.logs[0]?.meta).toEqual({ data: 123 });
    });

    it('respects level filtering', () => {
      tracer.updateConfig({ level: 'warn' });
      tracer.log('world-model', 'debug', 'should be filtered');
      tracer.log('world-model', 'warn', 'should appear');

      expect(listener.logs).toHaveLength(1);
      expect(listener.logs[0]?.level).toBe('warn');
    });

    it('respects subsystem filtering', () => {
      tracer.setSubsystemEnabled('goal-stack', false);
      tracer.log('goal-stack', 'info', 'should be filtered');
      tracer.log('world-model', 'info', 'should appear');

      expect(listener.logs).toHaveLength(1);
      expect(listener.logs[0]?.subsystem).toBe('world-model');
    });

    it('suppresses all output when disabled', () => {
      tracer.updateConfig({ enabled: false });
      tracer.log('world-model', 'error', 'should be filtered');

      expect(listener.logs).toHaveLength(0);
    });
  });

  describe('state change logging', () => {
    it('logs before and after values', () => {
      tracer.logStateChange('world-model', 'health.healthy', false, true);

      expect(listener.logs).toHaveLength(1);
      expect(listener.logs[0]?.message).toContain('State change: health.healthy');
    });
  });

  describe('IO logging', () => {
    it('logs successful IO operations', () => {
      tracer.logIO('world-model', 'read', '/tmp/test.yaml', 42, {
        success: true,
        bytesOrLines: 1024,
      });

      expect(listener.logs).toHaveLength(1);
      expect(listener.logs[0]?.message).toContain('read');
      expect(listener.logs[0]?.message).toContain('/tmp/test.yaml');
      expect(listener.logs[0]?.message).toContain('42ms');
      expect(listener.logs[0]?.message).toContain('[ok]');
    });

    it('logs failed IO operations at error level', () => {
      tracer.logIO('world-model', 'write', '/tmp/test.yaml', 100, {
        success: false,
        error: 'permission denied',
      });

      expect(listener.logs).toHaveLength(1);
      expect(listener.logs[0]?.level).toBe('error');
      expect(listener.logs[0]?.message).toContain('FAILED');
    });
  });

  describe('listener management', () => {
    it('removes specific listeners', () => {
      tracer.removeListener(listener);
      tracer.log('world-model', 'info', 'after removal');

      expect(listener.logs).toHaveLength(0);
    });

    it('clears all listeners', () => {
      const listener2 = new CapturingListener();
      tracer.addListener(listener2);
      tracer.clearListeners();
      tracer.log('world-model', 'info', 'after clear');

      expect(listener.logs).toHaveLength(0);
      expect(listener2.logs).toHaveLength(0);
    });
  });

  describe('reset', () => {
    it('clears all internal state', () => {
      tracer.startSpan('world-model', 'test');
      tracer.reset();

      expect(tracer.getActiveSpans()).toHaveLength(0);
      expect(tracer.getSpanDepth()).toBe(0);
    });
  });
});

describe('global tracer', () => {
  afterEach(() => {
    resetTracer();
  });

  it('getTracer returns the same instance', () => {
    const t1 = getTracer();
    const t2 = getTracer();
    expect(t1).toBe(t2);
  });

  it('initTracer replaces the global instance', () => {
    const t1 = getTracer();
    const t2 = initTracer({ level: 'error' });
    const t3 = getTracer();

    expect(t2).toBe(t3);
    expect(t1).not.toBe(t2);
  });

  it('resetTracer clears the global instance', () => {
    const t1 = getTracer();
    resetTracer();
    const t2 = getTracer();

    expect(t1).not.toBe(t2);
  });
});
