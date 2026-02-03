/**
 * Trace Collector
 *
 * Captures and stores trace events throughout the request pipeline.
 * Enables debugging and verification of the entire chain of events.
 */

export type TraceEventType =
  | 'request_start'
  | 'sensitivity_check'
  | 'routing_start'
  | 'routing_tool_call'
  | 'routing_decision'
  | 'context_assembly'
  | 'llm_request'
  | 'llm_response'
  | 'tool_call_received'
  | 'tool_filter_check'
  | 'tool_execution_start'
  | 'tool_execution_result'
  | 'tool_loop_iteration'
  | 'response_complete'
  | 'error';

export interface TraceEvent {
  id: string;
  type: TraceEventType;
  timestamp: number;
  durationMs?: number | undefined;
  data: Record<string, unknown>;
}

export interface RequestTrace {
  traceId: string;
  startTime: number;
  endTime?: number | undefined;
  input: string;
  events: TraceEvent[];
  finalResponse?: string | undefined;
  error?: string | undefined;
  summary?: TraceSummary | undefined;
}

export interface TraceSummary {
  totalDurationMs: number;
  routingDecision: {
    route: 'local' | 'cloud';
    reason: string;
    confidence: number;
    sensitiveCategories: string[];
  } | null;
  llmCalls: number;
  toolCallsRequested: number;
  toolCallsExecuted: number;
  toolCallsBlocked: number;
  iterations: number;
  provider: string | null;
  model: string | null;
}

let eventIdCounter = 0;

function generateEventId(): string {
  return `evt_${Date.now()}_${++eventIdCounter}`;
}

function generateTraceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Create a new trace collector for a request
 */
export function createTraceCollector(input: string): TraceCollector {
  const trace: RequestTrace = {
    traceId: generateTraceId(),
    startTime: Date.now(),
    input,
    events: [],
  };

  const eventTimers = new Map<string, number>();

  return {
    trace,

    addEvent(type: TraceEventType, data: Record<string, unknown> = {}): string {
      const eventId = generateEventId();
      const event: TraceEvent = {
        id: eventId,
        type,
        timestamp: Date.now(),
        data,
      };
      trace.events.push(event);
      return eventId;
    },

    startTimedEvent(type: TraceEventType, data: Record<string, unknown> = {}): string {
      const eventId = this.addEvent(type, data);
      eventTimers.set(eventId, Date.now());
      return eventId;
    },

    endTimedEvent(eventId: string, additionalData: Record<string, unknown> = {}): void {
      const startTime = eventTimers.get(eventId);
      const event = trace.events.find((e) => e.id === eventId);

      if (event && startTime) {
        event.durationMs = Date.now() - startTime;
        Object.assign(event.data, additionalData);
        eventTimers.delete(eventId);
      }
    },

    setFinalResponse(response: string): void {
      trace.finalResponse = response;
    },

    setError(error: string): void {
      trace.error = error;
      this.addEvent('error', { error });
    },

    complete(): RequestTrace {
      trace.endTime = Date.now();
      trace.summary = this.generateSummary();
      return trace;
    },

    generateSummary(): TraceSummary {
      const routingEvent = trace.events.find((e) => e.type === 'routing_decision');
      const llmResponses = trace.events.filter((e) => e.type === 'llm_response');
      const toolCallsReceived = trace.events.filter((e) => e.type === 'tool_call_received');
      const toolExecutions = trace.events.filter((e) => e.type === 'tool_execution_result');
      const toolFiltered = trace.events.filter(
        (e) => e.type === 'tool_filter_check' && (e.data.blocked as boolean)
      );
      const iterations = trace.events.filter((e) => e.type === 'tool_loop_iteration');

      const lastLlmResponse = llmResponses[llmResponses.length - 1];

      return {
        totalDurationMs: (trace.endTime ?? Date.now()) - trace.startTime,
        routingDecision: routingEvent
          ? {
              route: routingEvent.data.route as 'local' | 'cloud',
              reason: routingEvent.data.reason as string,
              confidence: routingEvent.data.confidence as number,
              sensitiveCategories: routingEvent.data.sensitiveCategories as string[],
            }
          : null,
        llmCalls: llmResponses.length,
        toolCallsRequested: toolCallsReceived.length,
        toolCallsExecuted: toolExecutions.length,
        toolCallsBlocked: toolFiltered.length,
        iterations: iterations.length,
        provider: (lastLlmResponse?.data.providerId as string) ?? null,
        model: (lastLlmResponse?.data.model as string) ?? null,
      };
    },

    getTrace(): RequestTrace {
      return trace;
    },
  };
}

export interface TraceCollector {
  trace: RequestTrace;
  addEvent(type: TraceEventType, data?: Record<string, unknown>): string;
  startTimedEvent(type: TraceEventType, data?: Record<string, unknown>): string;
  endTimedEvent(eventId: string, additionalData?: Record<string, unknown>): void;
  setFinalResponse(response: string): void;
  setError(error: string): void;
  complete(): RequestTrace;
  generateSummary(): TraceSummary;
  getTrace(): RequestTrace;
}

/**
 * Format a trace for display
 */
export function formatTrace(trace: RequestTrace): string {
  const lines: string[] = [];

  lines.push('═'.repeat(80));
  lines.push(`TRACE: ${trace.traceId}`);
  lines.push('═'.repeat(80));
  lines.push(`Input: "${trace.input.substring(0, 100)}${trace.input.length > 100 ? '...' : ''}"`);
  lines.push(`Started: ${new Date(trace.startTime).toISOString()}`);
  lines.push('');
  lines.push('─'.repeat(80));
  lines.push('EVENTS:');
  lines.push('─'.repeat(80));

  for (const event of trace.events) {
    const time = new Date(event.timestamp).toISOString().split('T')[1];
    const duration = event.durationMs ? ` (${event.durationMs}ms)` : '';
    lines.push(`[${time}] ${event.type}${duration}`);

    // Format event data
    for (const [key, value] of Object.entries(event.data)) {
      const valueStr =
        typeof value === 'string'
          ? value.length > 100
            ? value.substring(0, 100) + '...'
            : value
          : JSON.stringify(value);
      lines.push(`    ${key}: ${valueStr}`);
    }
  }

  if (trace.summary) {
    lines.push('');
    lines.push('─'.repeat(80));
    lines.push('SUMMARY:');
    lines.push('─'.repeat(80));
    lines.push(`  Total Duration: ${trace.summary.totalDurationMs}ms`);
    lines.push(`  Provider: ${trace.summary.provider ?? 'N/A'}`);
    lines.push(`  Model: ${trace.summary.model ?? 'N/A'}`);

    if (trace.summary.routingDecision) {
      lines.push(`  Route: ${trace.summary.routingDecision.route}`);
      lines.push(`  Routing Reason: ${trace.summary.routingDecision.reason}`);
      lines.push(`  Confidence: ${trace.summary.routingDecision.confidence}`);
      lines.push(
        `  Sensitive Categories: ${trace.summary.routingDecision.sensitiveCategories.join(', ') || 'none'}`
      );
    }

    lines.push(`  LLM Calls: ${trace.summary.llmCalls}`);
    lines.push(`  Tool Calls Requested: ${trace.summary.toolCallsRequested}`);
    lines.push(`  Tool Calls Executed: ${trace.summary.toolCallsExecuted}`);
    lines.push(`  Tool Calls Blocked: ${trace.summary.toolCallsBlocked}`);
    lines.push(`  Iterations: ${trace.summary.iterations}`);
  }

  if (trace.finalResponse) {
    lines.push('');
    lines.push('─'.repeat(80));
    lines.push('FINAL RESPONSE:');
    lines.push('─'.repeat(80));
    lines.push(trace.finalResponse);
  }

  if (trace.error) {
    lines.push('');
    lines.push('─'.repeat(80));
    lines.push('ERROR:');
    lines.push('─'.repeat(80));
    lines.push(trace.error);
  }

  lines.push('═'.repeat(80));

  return lines.join('\n');
}

/**
 * Export trace as JSON for storage/analysis
 */
export function traceToJson(trace: RequestTrace): string {
  return JSON.stringify(trace, null, 2);
}

/**
 * Global trace storage for test runs
 */
const traceStore: Map<string, RequestTrace> = new Map();

export function storeTrace(trace: RequestTrace): void {
  traceStore.set(trace.traceId, trace);
}

export function getStoredTrace(traceId: string): RequestTrace | undefined {
  return traceStore.get(traceId);
}

export function getAllStoredTraces(): RequestTrace[] {
  return Array.from(traceStore.values());
}

export function clearStoredTraces(): void {
  traceStore.clear();
}
