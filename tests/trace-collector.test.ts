import { describe, expect, it, beforeEach } from 'vitest';

import {
  createTraceCollector,
  formatTrace,
  traceToJson,
  storeTrace,
  getStoredTrace,
  getAllStoredTraces,
  clearStoredTraces,
  type TraceCollector,
  type RequestTrace,
} from '../src/testing/trace.js';

// ═══════════════════════════════════════════════════════════════════════════════
// createTraceCollector
// ═══════════════════════════════════════════════════════════════════════════════

describe('createTraceCollector', () => {
  it('creates a collector with trace id and input', () => {
    const collector = createTraceCollector('hello world');
    const trace = collector.getTrace();
    expect(trace.traceId).toMatch(/^trace_/);
    expect(trace.input).toBe('hello world');
    expect(trace.startTime).toBeGreaterThan(0);
    expect(trace.events).toEqual([]);
  });

  it('each collector gets a unique trace id', () => {
    const c1 = createTraceCollector('a');
    const c2 = createTraceCollector('b');
    expect(c1.getTrace().traceId).not.toBe(c2.getTrace().traceId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// addEvent
// ═══════════════════════════════════════════════════════════════════════════════

describe('addEvent', () => {
  it('adds an event to the trace', () => {
    const collector = createTraceCollector('test');
    collector.addEvent('request_start', { input: 'hello' });

    const events = collector.getTrace().events;
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('request_start');
    expect(events[0]?.data.input).toBe('hello');
  });

  it('returns a unique event id', () => {
    const collector = createTraceCollector('test');
    const id1 = collector.addEvent('request_start');
    const id2 = collector.addEvent('llm_request');
    expect(id1).toMatch(/^evt_/);
    expect(id2).toMatch(/^evt_/);
    expect(id1).not.toBe(id2);
  });

  it('records timestamp on each event', () => {
    const collector = createTraceCollector('test');
    const before = Date.now();
    collector.addEvent('request_start');
    const after = Date.now();

    const event = collector.getTrace().events[0];
    expect(event?.timestamp).toBeGreaterThanOrEqual(before);
    expect(event?.timestamp).toBeLessThanOrEqual(after);
  });

  it('defaults data to empty object', () => {
    const collector = createTraceCollector('test');
    collector.addEvent('request_start');
    expect(collector.getTrace().events[0]?.data).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// startTimedEvent / endTimedEvent
// ═══════════════════════════════════════════════════════════════════════════════

describe('timed events', () => {
  it('startTimedEvent creates an event and returns its id', () => {
    const collector = createTraceCollector('test');
    const eventId = collector.startTimedEvent('llm_request', { iteration: 1 });
    expect(eventId).toMatch(/^evt_/);

    const event = collector.getTrace().events[0];
    expect(event?.type).toBe('llm_request');
    expect(event?.data.iteration).toBe(1);
  });

  it('endTimedEvent sets durationMs on the event', async () => {
    const collector = createTraceCollector('test');
    const eventId = collector.startTimedEvent('llm_request');

    // Small delay to ensure measurable duration
    await new Promise((r) => setTimeout(r, 10));

    collector.endTimedEvent(eventId, { tokens: 42 });

    const event = collector.getTrace().events[0];
    expect(event?.durationMs).toBeGreaterThanOrEqual(0);
    expect(event?.data.tokens).toBe(42);
  });

  it('endTimedEvent on unknown id is a no-op', () => {
    const collector = createTraceCollector('test');
    // Should not throw
    collector.endTimedEvent('nonexistent', { foo: 'bar' });
    expect(collector.getTrace().events).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// setFinalResponse / setError
// ═══════════════════════════════════════════════════════════════════════════════

describe('setFinalResponse / setError', () => {
  it('setFinalResponse stores the response', () => {
    const collector = createTraceCollector('test');
    collector.setFinalResponse('The answer is 42');
    expect(collector.getTrace().finalResponse).toBe('The answer is 42');
  });

  it('setError stores the error and adds an error event', () => {
    const collector = createTraceCollector('test');
    collector.setError('Something broke');

    expect(collector.getTrace().error).toBe('Something broke');
    expect(collector.getTrace().events).toHaveLength(1);
    expect(collector.getTrace().events[0]?.type).toBe('error');
    expect(collector.getTrace().events[0]?.data.error).toBe('Something broke');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// complete
// ═══════════════════════════════════════════════════════════════════════════════

describe('complete', () => {
  it('sets endTime and generates summary', () => {
    const collector = createTraceCollector('test');
    collector.addEvent('provider_selected', { provider: 'local', model: 'gpt-oss:120b' });
    collector.addEvent('llm_response', {
      providerId: 'ollama',
      model: 'gpt-oss:120b',
      textLength: 100,
      toolCalls: 0,
      stopReason: 'end_turn',
    });

    const trace = collector.complete();
    expect(trace.endTime).toBeGreaterThan(0);
    expect(trace.summary).toBeDefined();
  });

  it('returns the trace object', () => {
    const collector = createTraceCollector('test');
    const trace = collector.complete();
    expect(trace).toBe(collector.getTrace());
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// generateSummary
// ═══════════════════════════════════════════════════════════════════════════════

describe('generateSummary', () => {
  it('counts LLM calls correctly', () => {
    const collector = createTraceCollector('test');
    collector.addEvent('llm_response', { providerId: 'a', model: 'm1', textLength: 5, toolCalls: 0, stopReason: 'end_turn' });
    collector.addEvent('llm_response', { providerId: 'a', model: 'm1', textLength: 10, toolCalls: 1, stopReason: 'tool_use' });

    const summary = collector.generateSummary();
    expect(summary.llmCalls).toBe(2);
  });

  it('counts tool calls requested', () => {
    const collector = createTraceCollector('test');
    collector.addEvent('tool_call_received', { toolName: 'bash', toolId: '1' });
    collector.addEvent('tool_call_received', { toolName: 'read_file', toolId: '2' });
    collector.addEvent('tool_call_received', { toolName: 'bash', toolId: '3' });

    const summary = collector.generateSummary();
    expect(summary.toolCallsRequested).toBe(3);
  });

  it('counts tool calls executed', () => {
    const collector = createTraceCollector('test');
    collector.addEvent('tool_execution_result', { toolCallId: '1', success: true, outputLength: 50 });
    collector.addEvent('tool_execution_result', { toolCallId: '2', success: false, error: 'timeout' });

    const summary = collector.generateSummary();
    expect(summary.toolCallsExecuted).toBe(2);
  });

  it('counts blocked tool calls', () => {
    const collector = createTraceCollector('test');
    collector.addEvent('tool_filter_check', { blocked: true, reason: 'osascript' });
    collector.addEvent('tool_filter_check', { blocked: false });

    const summary = collector.generateSummary();
    expect(summary.toolCallsBlocked).toBe(1);
  });

  it('counts iterations', () => {
    const collector = createTraceCollector('test');
    collector.addEvent('tool_loop_iteration', { iteration: 1 });
    collector.addEvent('tool_loop_iteration', { iteration: 2 });

    const summary = collector.generateSummary();
    expect(summary.iterations).toBe(2);
  });

  it('extracts provider and model from last llm_response', () => {
    const collector = createTraceCollector('test');
    collector.addEvent('llm_response', { providerId: 'ollama', model: 'model-a', textLength: 5, toolCalls: 0, stopReason: 'tool_use' });
    collector.addEvent('llm_response', { providerId: 'ollama', model: 'model-b', textLength: 10, toolCalls: 0, stopReason: 'end_turn' });

    const summary = collector.generateSummary();
    expect(summary.provider).toBe('ollama');
    expect(summary.model).toBe('model-b');
  });

  it('extracts provider info from provider_selected event', () => {
    const collector = createTraceCollector('test');
    collector.addEvent('provider_selected', { provider: 'local', model: 'gpt-oss:120b' });

    const summary = collector.generateSummary();
    expect(summary.providerSelected).toEqual({ provider: 'local', model: 'gpt-oss:120b' });
  });

  it('returns null for provider/model when no events', () => {
    const collector = createTraceCollector('test');
    const summary = collector.generateSummary();
    expect(summary.provider).toBeNull();
    expect(summary.model).toBeNull();
    expect(summary.providerSelected).toBeNull();
  });

  it('calculates totalDurationMs', () => {
    const collector = createTraceCollector('test');
    const trace = collector.complete();
    expect(trace.summary?.totalDurationMs).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatTrace
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatTrace', () => {
  it('includes trace id', () => {
    const collector = createTraceCollector('hello');
    const trace = collector.complete();
    const output = formatTrace(trace);
    expect(output).toContain(trace.traceId);
  });

  it('includes input text', () => {
    const collector = createTraceCollector('what is 2+2');
    const trace = collector.complete();
    const output = formatTrace(trace);
    expect(output).toContain('what is 2+2');
  });

  it('includes event types', () => {
    const collector = createTraceCollector('test');
    collector.addEvent('request_start', { input: 'test' });
    collector.addEvent('provider_selected', { provider: 'local', model: 'foo' });
    const trace = collector.complete();

    const output = formatTrace(trace);
    expect(output).toContain('request_start');
    expect(output).toContain('provider_selected');
  });

  it('includes final response section', () => {
    const collector = createTraceCollector('test');
    collector.setFinalResponse('The answer is 42');
    const trace = collector.complete();

    const output = formatTrace(trace);
    expect(output).toContain('FINAL RESPONSE');
    expect(output).toContain('The answer is 42');
  });

  it('includes error section when error is set', () => {
    const collector = createTraceCollector('test');
    collector.setError('Oops');
    const trace = collector.complete();

    const output = formatTrace(trace);
    expect(output).toContain('ERROR');
    expect(output).toContain('Oops');
  });

  it('includes summary section', () => {
    const collector = createTraceCollector('test');
    collector.addEvent('llm_response', { providerId: 'ollama', model: 'gpt-oss:120b', textLength: 5, toolCalls: 0, stopReason: 'end_turn' });
    const trace = collector.complete();

    const output = formatTrace(trace);
    expect(output).toContain('SUMMARY');
    expect(output).toContain('LLM Calls: 1');
  });

  it('truncates long input', () => {
    const longInput = 'a'.repeat(200);
    const collector = createTraceCollector(longInput);
    const trace = collector.complete();

    const output = formatTrace(trace);
    expect(output).toContain('...');
  });

  it('shows duration for timed events', async () => {
    const collector = createTraceCollector('test');
    const id = collector.startTimedEvent('llm_request');
    await new Promise((r) => setTimeout(r, 5));
    collector.endTimedEvent(id);
    const trace = collector.complete();

    const output = formatTrace(trace);
    expect(output).toMatch(/llm_request \(\d+ms\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// traceToJson
// ═══════════════════════════════════════════════════════════════════════════════

describe('traceToJson', () => {
  it('returns valid JSON', () => {
    const collector = createTraceCollector('test');
    collector.addEvent('request_start');
    const trace = collector.complete();

    const json = traceToJson(trace);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('round-trips trace data', () => {
    const collector = createTraceCollector('test input');
    collector.addEvent('request_start', { input: 'test input' });
    collector.setFinalResponse('output');
    const trace = collector.complete();

    const parsed = JSON.parse(traceToJson(trace)) as RequestTrace;
    expect(parsed.traceId).toBe(trace.traceId);
    expect(parsed.input).toBe('test input');
    expect(parsed.finalResponse).toBe('output');
    expect(parsed.events).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Trace store (global storage)
// ═══════════════════════════════════════════════════════════════════════════════

describe('trace store', () => {
  beforeEach(() => {
    clearStoredTraces();
  });

  it('stores and retrieves a trace', () => {
    const collector = createTraceCollector('test');
    const trace = collector.complete();
    storeTrace(trace);

    const retrieved = getStoredTrace(trace.traceId);
    expect(retrieved).toBe(trace);
  });

  it('returns undefined for unknown trace id', () => {
    expect(getStoredTrace('nonexistent')).toBeUndefined();
  });

  it('getAllStoredTraces returns all stored traces', () => {
    const c1 = createTraceCollector('a');
    const c2 = createTraceCollector('b');
    const t1 = c1.complete();
    const t2 = c2.complete();
    storeTrace(t1);
    storeTrace(t2);

    const all = getAllStoredTraces();
    expect(all).toHaveLength(2);
  });

  it('clearStoredTraces removes all traces', () => {
    const collector = createTraceCollector('test');
    storeTrace(collector.complete());
    expect(getAllStoredTraces()).toHaveLength(1);

    clearStoredTraces();
    expect(getAllStoredTraces()).toHaveLength(0);
  });
});
