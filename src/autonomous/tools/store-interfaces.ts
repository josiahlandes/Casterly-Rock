/**
 * Lightweight store interfaces for the AgentState type.
 *
 * These decouple tools/types.ts from concrete store implementations
 * (crystal-store.ts, constitution-store.ts, trace-replay.ts,
 * communication/*) so that those modules can be removed without
 * breaking the shared AgentToolkit type used by the dual-loop.
 *
 * TypeScript structural typing means the concrete classes satisfy
 * these interfaces without explicit `implements` clauses.
 */

// ─── Crystal Store ───────────────────────────────────────────────────────────

export interface Crystal {
  id: string;
  content: string;
  sourceEntries: string[];
  formedDate: string;
  lastValidated: string;
  recallCount: number;
  confidence: number;
}

export interface CrystalResult {
  success: boolean;
  crystalId?: string;
  error?: string;
}

export interface ICrystalStore {
  crystallize(params: {
    content: string;
    sourceEntries?: string[];
    confidence?: number;
  }): CrystalResult;
  dissolve(crystalId: string, reason?: string): CrystalResult;
  getAll(): ReadonlyArray<Crystal>;
  estimateTotalTokens(): number;
  save(): Promise<void>;
}

// ─── Constitution Store ──────────────────────────────────────────────────────

export interface ConstitutionalRule {
  id: string;
  rule: string;
  added: string;
  motivation: string;
  confidence: number;
  invocations: number;
  successes: number;
}

export interface RuleResult {
  success: boolean;
  ruleId?: string;
  error?: string;
}

export interface IConstitutionStore {
  createRule(params: {
    rule: string;
    motivation: string;
    confidence?: number;
  }): RuleResult;
  updateRule(
    ruleId: string,
    updates: { rule?: string; motivation?: string; confidence?: number },
  ): RuleResult;
  getAll(): ReadonlyArray<ConstitutionalRule>;
  estimateTotalTokens(): number;
  save(): Promise<void>;
}

// ─── Trace Replay Store ──────────────────────────────────────────────────────

export interface TraceStep {
  step: number;
  timestamp: string;
  toolCalled: string;
  parameters: Record<string, unknown>;
  result: string;
  reasoning?: string;
  durationMs?: number;
}

export interface ExecutionTrace {
  cycleId: string;
  startedAt: string;
  endedAt: string;
  outcome: 'success' | 'failure' | 'partial';
  trigger: string;
  steps: TraceStep[];
  toolsUsed: string[];
  tags: string[];
  pinned: boolean;
}

export interface TraceComparison {
  cycleA: string;
  cycleB: string;
  commonTools: string[];
  uniqueToA: string[];
  uniqueToB: string[];
  stepCountDiff: number;
  outcomeA: string;
  outcomeB: string;
  summary: string;
}

export interface TraceIndexEntry {
  cycleId: string;
  startedAt: string;
  outcome: 'success' | 'failure' | 'partial';
  trigger: string;
  toolsUsed: string[];
  stepCount: number;
  tags: string[];
  pinned: boolean;
}

export interface ITraceReplayStore {
  replay(cycleId: string, options?: {
    stepRange?: [number, number];
    toolFilter?: string;
  }): Promise<ExecutionTrace | null>;
  compareTraces(cycleIdA: string, cycleIdB: string): Promise<TraceComparison | null>;
  searchTraces(criteria: {
    outcome?: 'success' | 'failure' | 'partial';
    trigger?: string;
    tool?: string;
    since?: string;
    limit?: number;
  }): TraceIndexEntry[];
}

// ─── Message Policy ──────────────────────────────────────────────────────────

export interface DailySummaryStats {
  cyclesRun: number;
  issuesFixed: number;
  testsPassing: number;
}

export type NotifiableEvent =
  | { type: 'fix_complete'; description: string; branch: string }
  | { type: 'test_failure'; test: string; investigating: boolean }
  | { type: 'decision_needed'; question: string; options: string[] }
  | { type: 'daily_summary'; stats: DailySummaryStats }
  | { type: 'security_concern'; description: string; severity: 'low' | 'medium' | 'high' | 'critical' };

export interface PolicyDecision {
  allowed: boolean;
  reason?: string | undefined;
  formattedMessage?: string | undefined;
}

export interface IMessagePolicy {
  shouldNotify(event: NotifiableEvent, now?: Date): PolicyDecision;
  recordSent(event: NotifiableEvent, now?: Date): void;
}

// ─── Message Delivery ────────────────────────────────────────────────────────

export interface DeliveryResult {
  delivered: boolean;
  channel: string;
  error?: string | undefined;
}

export interface IMessageDelivery {
  send(message: string, urgency: string): Promise<DeliveryResult>;
  readonly channel: string;
}
