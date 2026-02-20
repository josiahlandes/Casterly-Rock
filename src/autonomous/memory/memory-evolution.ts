/**
 * Memory Evolution — Transformative Memory Lifecycle (A-MEM)
 *
 * Unlike simple CRUD operations, memory evolution allows memories to
 * transform over time through structured operations:
 *
 *   - Strengthen: Increase confidence when corroborated by new evidence
 *   - Weaken: Decrease confidence when contradicted
 *   - Merge: Combine two related memories into one richer memory
 *   - Split: Decompose a complex memory into focused sub-memories
 *   - Generalize: Abstract specific memories into broader principles
 *   - Specialize: Narrow a general memory to a specific context
 *
 * Each evolution is tracked with full lineage, enabling analysis of
 * how knowledge crystallizes over time.
 *
 * Storage: ~/.casterly/memory/evolution-log.json
 *
 * Part of Advanced Memory: Memory Evolution (A-MEM).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EvolutionOp =
  | 'strengthen'
  | 'weaken'
  | 'merge'
  | 'split'
  | 'generalize'
  | 'specialize';

/**
 * Record of a single evolution event.
 */
export interface EvolutionEvent {
  /** Unique event ID */
  id: string;

  /** The operation performed */
  operation: EvolutionOp;

  /** IDs of source memories (inputs to the evolution) */
  sourceIds: string[];

  /** IDs of result memories (outputs of the evolution) */
  resultIds: string[];

  /** Reason for the evolution */
  reason: string;

  /** ISO timestamp */
  timestamp: string;

  /** Confidence delta (for strengthen/weaken) */
  confidenceDelta?: number;
}

/**
 * A memory with evolution metadata.
 */
export interface EvolvableMemory {
  id: string;
  content: string;
  confidence: number;
  generation: number;
  parentIds: string[];
  tags: string[];
  createdAt: string;
  lastEvolvedAt: string;
}

export interface EvolutionConfig {
  /** Path to the evolution log */
  logPath: string;

  /** Maximum events in the log */
  maxEvents: number;

  /** Maximum generation depth before forced pruning */
  maxGeneration: number;

  /** Strength increase per corroboration */
  strengthenDelta: number;

  /** Weakness decrease per contradiction */
  weakenDelta: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: EvolutionConfig = {
  logPath: '~/.casterly/memory/evolution-log.json',
  maxEvents: 500,
  maxGeneration: 10,
  strengthenDelta: 0.1,
  weakenDelta: 0.15,
};

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

function generateEventId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `evo-${ts}-${rand}`;
}

function generateMemoryId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `emem-${ts}-${rand}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory Evolution Engine
// ─────────────────────────────────────────────────────────────────────────────

export class MemoryEvolution {
  private readonly config: EvolutionConfig;
  private events: EvolutionEvent[] = [];
  private loaded: boolean = false;

  constructor(config?: Partial<EvolutionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  async load(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.logPath);

    try {
      const content = await readFile(resolvedPath, 'utf8');
      const data = JSON.parse(content) as { events: EvolutionEvent[] };
      this.events = data.events ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        tracer.log('memory', 'warn', 'Failed to load evolution log', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.events = [];
    }

    this.loaded = true;
    tracer.log('memory', 'debug', `Evolution log loaded: ${this.events.length} events`);
  }

  async save(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.logPath);

    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(
      resolvedPath,
      JSON.stringify({ events: this.events }, null, 2),
      'utf8',
    );

    tracer.log('memory', 'debug', `Evolution log saved: ${this.events.length} events`);
  }

  // ── Evolution Operations ──────────────────────────────────────────────────

  /**
   * Strengthen a memory — increase confidence due to corroboration.
   */
  strengthen(memory: EvolvableMemory, reason: string): EvolvableMemory {
    const delta = this.config.strengthenDelta;
    memory.confidence = Math.min(1.0, memory.confidence + delta);
    memory.lastEvolvedAt = new Date().toISOString();

    this.recordEvent({
      operation: 'strengthen',
      sourceIds: [memory.id],
      resultIds: [memory.id],
      reason,
      confidenceDelta: delta,
    });

    return memory;
  }

  /**
   * Weaken a memory — decrease confidence due to contradiction.
   */
  weaken(memory: EvolvableMemory, reason: string): EvolvableMemory {
    const delta = this.config.weakenDelta;
    memory.confidence = Math.max(0, memory.confidence - delta);
    memory.lastEvolvedAt = new Date().toISOString();

    this.recordEvent({
      operation: 'weaken',
      sourceIds: [memory.id],
      resultIds: [memory.id],
      reason,
      confidenceDelta: -delta,
    });

    return memory;
  }

  /**
   * Merge two memories into a single richer memory.
   * Returns the merged memory. The originals should be marked for deletion.
   */
  merge(
    memoryA: EvolvableMemory,
    memoryB: EvolvableMemory,
    mergedContent: string,
    reason: string,
  ): EvolvableMemory {
    const now = new Date().toISOString();
    const merged: EvolvableMemory = {
      id: generateMemoryId(),
      content: mergedContent,
      confidence: Math.max(memoryA.confidence, memoryB.confidence),
      generation: Math.max(memoryA.generation, memoryB.generation) + 1,
      parentIds: [memoryA.id, memoryB.id],
      tags: [...new Set([...memoryA.tags, ...memoryB.tags])],
      createdAt: now,
      lastEvolvedAt: now,
    };

    this.recordEvent({
      operation: 'merge',
      sourceIds: [memoryA.id, memoryB.id],
      resultIds: [merged.id],
      reason,
    });

    return merged;
  }

  /**
   * Split a memory into multiple focused sub-memories.
   * Returns the sub-memories. The original should be marked for deletion.
   */
  split(
    memory: EvolvableMemory,
    splitContents: string[],
    reason: string,
  ): EvolvableMemory[] {
    const now = new Date().toISOString();
    const results: EvolvableMemory[] = splitContents.map((content) => ({
      id: generateMemoryId(),
      content,
      confidence: memory.confidence,
      generation: memory.generation + 1,
      parentIds: [memory.id],
      tags: [...memory.tags],
      createdAt: now,
      lastEvolvedAt: now,
    }));

    this.recordEvent({
      operation: 'split',
      sourceIds: [memory.id],
      resultIds: results.map((r) => r.id),
      reason,
    });

    return results;
  }

  /**
   * Generalize a specific memory into a broader principle.
   */
  generalize(
    memory: EvolvableMemory,
    generalizedContent: string,
    reason: string,
  ): EvolvableMemory {
    const now = new Date().toISOString();
    const generalized: EvolvableMemory = {
      id: generateMemoryId(),
      content: generalizedContent,
      confidence: memory.confidence * 0.9, // Slightly less confident
      generation: memory.generation + 1,
      parentIds: [memory.id],
      tags: [...memory.tags, 'generalized'],
      createdAt: now,
      lastEvolvedAt: now,
    };

    this.recordEvent({
      operation: 'generalize',
      sourceIds: [memory.id],
      resultIds: [generalized.id],
      reason,
    });

    return generalized;
  }

  /**
   * Specialize a general memory to a specific context.
   */
  specialize(
    memory: EvolvableMemory,
    specializedContent: string,
    reason: string,
  ): EvolvableMemory {
    const now = new Date().toISOString();
    const specialized: EvolvableMemory = {
      id: generateMemoryId(),
      content: specializedContent,
      confidence: memory.confidence,
      generation: memory.generation + 1,
      parentIds: [memory.id],
      tags: [...memory.tags, 'specialized'],
      createdAt: now,
      lastEvolvedAt: now,
    };

    this.recordEvent({
      operation: 'specialize',
      sourceIds: [memory.id],
      resultIds: [specialized.id],
      reason,
    });

    return specialized;
  }

  // ── Lineage ────────────────────────────────────────────────────────────────

  /**
   * Get the evolution history of a specific memory (ancestors).
   */
  getLineage(memoryId: string): EvolutionEvent[] {
    return this.events.filter(
      (e) => e.sourceIds.includes(memoryId) || e.resultIds.includes(memoryId),
    );
  }

  /**
   * Get all events of a specific operation type.
   */
  getEventsByType(operation: EvolutionOp): EvolutionEvent[] {
    return this.events.filter((e) => e.operation === operation);
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  eventCount(): number {
    return this.events.length;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  getEvents(): ReadonlyArray<EvolutionEvent> {
    return this.events;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private recordEvent(
    params: Omit<EvolutionEvent, 'id' | 'timestamp'>,
  ): void {
    const event: EvolutionEvent = {
      ...params,
      id: generateEventId(),
      timestamp: new Date().toISOString(),
    };

    this.events.push(event);

    // Trim old events
    if (this.events.length > this.config.maxEvents) {
      this.events = this.events.slice(-this.config.maxEvents);
    }

    const tracer = getTracer();
    tracer.log('memory', 'debug', `Evolution: ${event.operation} (${event.sourceIds.join(',')} → ${event.resultIds.join(',')})`, {
      reason: event.reason.slice(0, 80),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createMemoryEvolution(
  config?: Partial<EvolutionConfig>,
): MemoryEvolution {
  return new MemoryEvolution(config);
}
