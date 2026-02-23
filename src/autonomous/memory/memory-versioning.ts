/**
 * Git-Backed Memory Versioning — Memory State Snapshots (Letta)
 *
 * Versions all memory state files using git-like snapshots. Each snapshot
 * records the state of key memory files (crystals, constitution, goals,
 * issues, journal summary) at a point in time, enabling rollback and
 * diff analysis.
 *
 * This is NOT actual git — it's a lightweight internal versioning system
 * that stores snapshots as JSON. Diffs are computed in-memory.
 *
 * Storage: ~/.casterly/memory/versions/
 *   - snapshots.json — ordered list of snapshots
 *   - data/<snapshot-id>.json — snapshot data
 *
 * Part of Advanced Memory: Git-Backed Memory Versioning (Letta).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A snapshot of memory state at a point in time.
 */
export interface MemorySnapshot {
  /** Unique snapshot ID */
  id: string;

  /** ISO timestamp of the snapshot */
  timestamp: string;

  /** What triggered this snapshot (dream_cycle, manual, pre_mutation) */
  trigger: string;

  /** Optional message describing the snapshot */
  message: string;

  /** Hash of the snapshot data for quick comparison */
  contentHash: string;

  /** Stored memory contents keyed by subsystem name */
  data: Record<string, string>;
}

/**
 * A diff between two snapshots for a single subsystem.
 */
export interface SnapshotDiff {
  subsystem: string;
  linesAdded: number;
  linesRemoved: number;
  additions: string[];
  removals: string[];
}

/**
 * Full diff between two snapshots.
 */
export interface VersionDiff {
  fromId: string;
  toId: string;
  diffs: SnapshotDiff[];
  subsystemsChanged: string[];
  subsystemsAdded: string[];
  subsystemsRemoved: string[];
}

export interface MemoryVersioningConfig {
  /** Base directory for version storage */
  basePath: string;

  /** Maximum snapshots to retain */
  maxSnapshots: number;

  /** Paths to monitor for snapshotting */
  monitoredPaths: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: MemoryVersioningConfig = {
  basePath: '~/.casterly/memory/versions',
  maxSnapshots: 50,
  monitoredPaths: {
    crystals: '~/.casterly/crystals.yaml',
    constitution: '~/.casterly/constitution.yaml',
    goals: '~/.casterly/goals.yaml',
    issues: '~/.casterly/issues.yaml',
  },
};

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

function generateSnapshotId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `snap-${ts}-${rand}`;
}

/**
 * Simple content hash (djb2 algorithm).
 */
function hashContent(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory Versioning
// ─────────────────────────────────────────────────────────────────────────────

export class MemoryVersioning {
  private readonly config: MemoryVersioningConfig;
  private snapshots: MemorySnapshot[] = [];
  private loaded: boolean = false;

  constructor(config?: Partial<MemoryVersioningConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  async load(): Promise<void> {
    const tracer = getTracer();
    const indexPath = join(resolvePath(this.config.basePath), 'snapshots.json');

    try {
      const content = await readFile(indexPath, 'utf8');
      const data = JSON.parse(content) as { snapshots: MemorySnapshot[] };
      this.snapshots = data.snapshots ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        tracer.log('memory', 'warn', 'Failed to load version history', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.snapshots = [];
    }

    this.loaded = true;
    tracer.log('memory', 'debug', `Version history loaded: ${this.snapshots.length} snapshots`);
  }

  async save(): Promise<void> {
    const tracer = getTracer();
    const basePath = resolvePath(this.config.basePath);
    const indexPath = join(basePath, 'snapshots.json');

    await mkdir(basePath, { recursive: true });
    await writeFile(
      indexPath,
      JSON.stringify({ snapshots: this.snapshots }, null, 2),
      'utf8',
    );

    tracer.log('memory', 'debug', `Version history saved: ${this.snapshots.length} snapshots`);
  }

  // ── Snapshot Operations ────────────────────────────────────────────────────

  /**
   * Create a snapshot of current memory state by reading all monitored files.
   */
  async createSnapshot(params: {
    trigger: string;
    message: string;
  }): Promise<MemorySnapshot> {
    const tracer = getTracer();
    const data: Record<string, string> = {};

    // Read each monitored file
    for (const [name, path] of Object.entries(this.config.monitoredPaths)) {
      try {
        data[name] = await readFile(resolvePath(path), 'utf8');
      } catch {
        data[name] = '';
      }
    }

    const combined = Object.values(data).join('\n---\n');
    const snapshot: MemorySnapshot = {
      id: generateSnapshotId(),
      timestamp: new Date().toISOString(),
      trigger: params.trigger,
      message: params.message,
      contentHash: hashContent(combined),
      data,
    };

    // Check if state actually changed from last snapshot
    if (this.snapshots.length > 0) {
      const last = this.snapshots[this.snapshots.length - 1]!;
      if (last.contentHash === snapshot.contentHash) {
        tracer.log('memory', 'debug', 'Snapshot skipped — no changes since last');
        return last;
      }
    }

    this.snapshots.push(snapshot);

    // Trim old snapshots
    if (this.snapshots.length > this.config.maxSnapshots) {
      this.snapshots = this.snapshots.slice(-this.config.maxSnapshots);
    }

    tracer.log('memory', 'info', `Snapshot created: ${snapshot.id}`, {
      trigger: params.trigger,
      subsystems: Object.keys(data).length,
    });

    return snapshot;
  }

  /**
   * Create a snapshot from externally provided data (no file reads).
   */
  createSnapshotFromData(params: {
    trigger: string;
    message: string;
    data: Record<string, string>;
  }): MemorySnapshot {
    const combined = Object.values(params.data).join('\n---\n');
    const snapshot: MemorySnapshot = {
      id: generateSnapshotId(),
      timestamp: new Date().toISOString(),
      trigger: params.trigger,
      message: params.message,
      contentHash: hashContent(combined),
      data: params.data,
    };

    this.snapshots.push(snapshot);

    if (this.snapshots.length > this.config.maxSnapshots) {
      this.snapshots = this.snapshots.slice(-this.config.maxSnapshots);
    }

    return snapshot;
  }

  /**
   * Diff two snapshots. If only one ID is given, diffs against the
   * snapshot immediately before it.
   */
  diff(toId: string, fromId?: string): VersionDiff | null {
    const toSnap = this.snapshots.find((s) => s.id === toId);
    if (!toSnap) return null;

    let fromSnap: MemorySnapshot | undefined;
    if (fromId) {
      fromSnap = this.snapshots.find((s) => s.id === fromId);
    } else {
      const idx = this.snapshots.indexOf(toSnap);
      if (idx > 0) fromSnap = this.snapshots[idx - 1];
    }

    if (!fromSnap) {
      return {
        fromId: '',
        toId,
        diffs: [],
        subsystemsChanged: [],
        subsystemsAdded: Object.keys(toSnap.data),
        subsystemsRemoved: [],
      };
    }

    const allKeys = new Set([
      ...Object.keys(fromSnap.data),
      ...Object.keys(toSnap.data),
    ]);

    const diffs: SnapshotDiff[] = [];
    const subsystemsChanged: string[] = [];
    const subsystemsAdded: string[] = [];
    const subsystemsRemoved: string[] = [];

    for (const key of allKeys) {
      const fromContent = fromSnap.data[key];
      const toContent = toSnap.data[key];

      if (fromContent === undefined) {
        subsystemsAdded.push(key);
        continue;
      }
      if (toContent === undefined) {
        subsystemsRemoved.push(key);
        continue;
      }
      if (fromContent === toContent) continue;

      subsystemsChanged.push(key);
      const lineDiff = diffLines(fromContent, toContent);
      diffs.push({
        subsystem: key,
        ...lineDiff,
      });
    }

    return {
      fromId: fromSnap.id,
      toId,
      diffs,
      subsystemsChanged,
      subsystemsAdded,
      subsystemsRemoved,
    };
  }

  /**
   * Get a specific snapshot by ID.
   */
  getSnapshot(id: string): MemorySnapshot | undefined {
    return this.snapshots.find((s) => s.id === id);
  }

  /**
   * Get the most recent snapshot.
   */
  getLatest(): MemorySnapshot | undefined {
    return this.snapshots.length > 0
      ? this.snapshots[this.snapshots.length - 1]
      : undefined;
  }

  /**
   * List all snapshots (newest first).
   */
  listSnapshots(): ReadonlyArray<{ id: string; timestamp: string; trigger: string; message: string }> {
    return [...this.snapshots]
      .reverse()
      .map((s) => ({
        id: s.id,
        timestamp: s.timestamp,
        trigger: s.trigger,
        message: s.message,
      }));
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  count(): number {
    return this.snapshots.length;
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Line Diff Helper
// ─────────────────────────────────────────────────────────────────────────────

function diffLines(before: string, after: string): {
  linesAdded: number;
  linesRemoved: number;
  additions: string[];
  removals: string[];
} {
  const beforeLines = new Set(before.split('\n'));
  const afterLines = new Set(after.split('\n'));

  const additions: string[] = [];
  const removals: string[] = [];

  for (const line of afterLines) {
    if (!beforeLines.has(line) && line.trim()) {
      additions.push(line);
    }
  }

  for (const line of beforeLines) {
    if (!afterLines.has(line) && line.trim()) {
      removals.push(line);
    }
  }

  return {
    linesAdded: additions.length,
    linesRemoved: removals.length,
    additions: additions.slice(0, 20), // Cap for readability
    removals: removals.slice(0, 20),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createMemoryVersioning(
  config?: Partial<MemoryVersioningConfig>,
): MemoryVersioning {
  return new MemoryVersioning(config);
}
