/**
 * Temporal Invalidation — Time-Based Memory Expiry (Mem0)
 *
 * Manages time-to-live (TTL) policies for memory entries. Different
 * memory types have different natural lifetimes:
 *
 *   - Facts about code: Long TTL (90 days) — code changes slowly
 *   - Observations: Medium TTL (30 days) — context may shift
 *   - Opinions: Short TTL (14 days) — should be re-evaluated
 *   - Working notes: Very short TTL (7 days) — ephemeral
 *
 * Decay can be linear or exponential. Access resets the TTL clock
 * (entries that are actively used stay alive longer).
 *
 * Part of Advanced Memory: Temporal Invalidation (Mem0).
 */

import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DecayFunction = 'linear' | 'exponential';

/**
 * TTL policy for a category of memory.
 */
export interface TtlPolicy {
  /** Category name */
  category: string;

  /** Time to live in days */
  ttlDays: number;

  /** Decay function */
  decay: DecayFunction;

  /** Whether access resets the TTL */
  accessResetsExpiry: boolean;

  /** Grace period after expiry before hard deletion (days) */
  gracePeriodDays: number;
}

/**
 * An entry being tracked for temporal invalidation.
 */
export interface TrackedEntry {
  /** Entry ID */
  id: string;

  /** Which TTL category this entry belongs to */
  category: string;

  /** ISO timestamp when the entry was created */
  createdAt: string;

  /** ISO timestamp of last access */
  lastAccessedAt: string;

  /** Current freshness (0-1, 1 = fresh, 0 = expired) */
  freshness: number;

  /** Whether this entry is expired */
  expired: boolean;

  /** Whether this entry is in the grace period */
  inGracePeriod: boolean;
}

/**
 * Summary of a temporal invalidation sweep.
 */
export interface InvalidationReport {
  /** Total entries evaluated */
  evaluated: number;

  /** Entries still fresh */
  fresh: number;

  /** Entries newly expired */
  newlyExpired: number;

  /** Entries past grace period (ready for deletion) */
  readyForDeletion: number;

  /** IDs of entries ready for deletion */
  deletionCandidates: string[];

  /** Timestamp */
  timestamp: string;
}

export interface TemporalInvalidationConfig {
  /** Default policies per category */
  policies: TtlPolicy[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_POLICIES: TtlPolicy[] = [
  {
    category: 'fact',
    ttlDays: 90,
    decay: 'linear',
    accessResetsExpiry: true,
    gracePeriodDays: 14,
  },
  {
    category: 'observation',
    ttlDays: 30,
    decay: 'linear',
    accessResetsExpiry: true,
    gracePeriodDays: 7,
  },
  {
    category: 'opinion',
    ttlDays: 14,
    decay: 'exponential',
    accessResetsExpiry: true,
    gracePeriodDays: 3,
  },
  {
    category: 'working_note',
    ttlDays: 7,
    decay: 'exponential',
    accessResetsExpiry: false,
    gracePeriodDays: 1,
  },
  {
    category: 'crystal',
    ttlDays: 180,
    decay: 'linear',
    accessResetsExpiry: true,
    gracePeriodDays: 30,
  },
  {
    category: 'rule',
    ttlDays: 120,
    decay: 'linear',
    accessResetsExpiry: true,
    gracePeriodDays: 14,
  },
];

const DEFAULT_CONFIG: TemporalInvalidationConfig = {
  policies: DEFAULT_POLICIES,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Temporal Invalidation Engine
// ─────────────────────────────────────────────────────────────────────────────

export class TemporalInvalidation {
  private readonly config: TemporalInvalidationConfig;
  private readonly policyMap: Map<string, TtlPolicy>;
  private tracked: Map<string, TrackedEntry> = new Map();

  constructor(config?: Partial<TemporalInvalidationConfig>) {
    this.config = {
      policies: config?.policies ?? DEFAULT_CONFIG.policies,
    };
    this.policyMap = new Map(this.config.policies.map((p) => [p.category, p]));
  }

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Register an entry for temporal tracking.
   */
  register(params: {
    id: string;
    category: string;
    createdAt?: string;
    lastAccessedAt?: string;
  }): TrackedEntry {
    const now = new Date().toISOString();
    const entry: TrackedEntry = {
      id: params.id,
      category: params.category,
      createdAt: params.createdAt ?? now,
      lastAccessedAt: params.lastAccessedAt ?? now,
      freshness: 1.0,
      expired: false,
      inGracePeriod: false,
    };

    this.tracked.set(params.id, entry);
    return entry;
  }

  /**
   * Record an access to an entry (may reset its expiry clock).
   */
  recordAccess(entryId: string): boolean {
    const entry = this.tracked.get(entryId);
    if (!entry) return false;

    const policy = this.policyMap.get(entry.category);
    entry.lastAccessedAt = new Date().toISOString();

    if (policy?.accessResetsExpiry) {
      entry.freshness = 1.0;
      entry.expired = false;
      entry.inGracePeriod = false;
    }

    return true;
  }

  /**
   * Remove an entry from tracking.
   */
  unregister(entryId: string): boolean {
    return this.tracked.delete(entryId);
  }

  // ── Evaluation ─────────────────────────────────────────────────────────────

  /**
   * Sweep all tracked entries and update their freshness/expiry status.
   */
  sweep(): InvalidationReport {
    const tracer = getTracer();
    const now = Date.now();
    let fresh = 0;
    let newlyExpired = 0;
    let readyForDeletion = 0;
    const deletionCandidates: string[] = [];

    for (const entry of this.tracked.values()) {
      const policy = this.policyMap.get(entry.category);
      if (!policy) {
        fresh++;
        continue;
      }

      const wasExpired = entry.expired;
      this.updateFreshness(entry, policy, now);

      if (entry.expired && !wasExpired) {
        newlyExpired++;
      }

      if (entry.expired && !entry.inGracePeriod) {
        readyForDeletion++;
        deletionCandidates.push(entry.id);
      } else if (!entry.expired) {
        fresh++;
      }
    }

    const report: InvalidationReport = {
      evaluated: this.tracked.size,
      fresh,
      newlyExpired,
      readyForDeletion,
      deletionCandidates,
      timestamp: new Date().toISOString(),
    };

    if (newlyExpired > 0 || readyForDeletion > 0) {
      tracer.log('memory', 'info', `Temporal sweep: ${newlyExpired} expired, ${readyForDeletion} for deletion`);
    }

    return report;
  }

  /**
   * Get the freshness of a specific entry.
   */
  getFreshness(entryId: string): number | null {
    const entry = this.tracked.get(entryId);
    if (!entry) return null;

    const policy = this.policyMap.get(entry.category);
    if (policy) {
      this.updateFreshness(entry, policy, Date.now());
    }

    return entry.freshness;
  }

  /**
   * Check if an entry is expired.
   */
  isExpired(entryId: string): boolean {
    const entry = this.tracked.get(entryId);
    if (!entry) return false;

    const policy = this.policyMap.get(entry.category);
    if (policy) {
      this.updateFreshness(entry, policy, Date.now());
    }

    return entry.expired;
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  /**
   * Get all tracked entries.
   */
  getAll(): ReadonlyArray<TrackedEntry> {
    return [...this.tracked.values()];
  }

  /**
   * Get entries by category.
   */
  getByCategory(category: string): TrackedEntry[] {
    return [...this.tracked.values()].filter((e) => e.category === category);
  }

  /**
   * Get the number of tracked entries.
   */
  count(): number {
    return this.tracked.size;
  }

  /**
   * Get a policy by category.
   */
  getPolicy(category: string): TtlPolicy | undefined {
    return this.policyMap.get(category);
  }

  /**
   * Get all available policies.
   */
  getPolicies(): ReadonlyArray<TtlPolicy> {
    return this.config.policies;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private updateFreshness(entry: TrackedEntry, policy: TtlPolicy, nowMs: number): void {
    const referenceTime = policy.accessResetsExpiry
      ? new Date(entry.lastAccessedAt).getTime()
      : new Date(entry.createdAt).getTime();

    const elapsedDays = (nowMs - referenceTime) / MS_PER_DAY;
    const ttlDays = policy.ttlDays;

    if (policy.decay === 'linear') {
      entry.freshness = Math.max(0, 1 - elapsedDays / ttlDays);
    } else {
      // Exponential: half-life at ttlDays/2
      const halfLife = ttlDays / 2;
      entry.freshness = Math.pow(0.5, elapsedDays / halfLife);
      if (entry.freshness < 0.01) entry.freshness = 0;
    }

    entry.expired = entry.freshness <= 0;

    if (entry.expired) {
      const totalExpiryDays = ttlDays + policy.gracePeriodDays;
      entry.inGracePeriod = elapsedDays <= totalExpiryDays;
    } else {
      entry.inGracePeriod = false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createTemporalInvalidation(
  config?: Partial<TemporalInvalidationConfig>,
): TemporalInvalidation {
  return new TemporalInvalidation(config);
}
