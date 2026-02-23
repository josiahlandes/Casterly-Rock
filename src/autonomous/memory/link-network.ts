/**
 * Zettelkasten Link Network — Bidirectional Memory Links (A-MEM)
 *
 * Creates a network of bidirectional links between memory entries across
 * all subsystems (crystals, journal entries, constitution rules, etc.).
 * Each link has a typed relationship, enabling graph traversal across
 * the entire memory surface.
 *
 * Link types:
 *   - supports: Evidence or reasoning that supports another entry
 *   - contradicts: Evidence that contradicts another entry
 *   - extends: Builds upon or elaborates on another entry
 *   - derived_from: Created as a consequence of another entry
 *   - related: General topical relationship
 *
 * Storage: ~/.casterly/memory/links.json
 *
 * Part of Advanced Memory: Zettelkasten Link Network (A-MEM).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getTracer } from '../debug.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type LinkType = 'supports' | 'contradicts' | 'extends' | 'derived_from' | 'related';

/**
 * A single bidirectional link between two memory entries.
 */
export interface MemoryLink {
  /** Unique link identifier */
  id: string;

  /** Source entry ID */
  sourceId: string;

  /** Target entry ID */
  targetId: string;

  /** Relationship type */
  type: LinkType;

  /** Strength of the link (0-1). Strengthens with co-recall, decays with time. */
  strength: number;

  /** ISO timestamp when this link was created */
  createdAt: string;

  /** ISO timestamp of last access */
  lastAccessed: string;

  /** Optional annotation explaining the link */
  annotation?: string;
}

export interface LinkNetworkConfig {
  /** Path to the link network file */
  path: string;

  /** Maximum links in the network */
  maxLinks: number;

  /** Minimum strength before a link is pruned */
  minStrength: number;

  /** Decay rate per day for unaccessed links */
  decayRatePerDay: number;
}

export interface LinkResult {
  success: boolean;
  linkId?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: LinkNetworkConfig = {
  path: '~/.casterly/memory/links.json',
  maxLinks: 500,
  minStrength: 0.1,
  decayRatePerDay: 0.02,
};

function resolvePath(filePath: string): string {
  if (filePath.startsWith('~')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
    return filePath.replace('~', home);
  }
  return filePath;
}

function generateLinkId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 6);
  return `link-${ts}-${rand}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Link Network
// ─────────────────────────────────────────────────────────────────────────────

export class LinkNetwork {
  private readonly config: LinkNetworkConfig;
  private links: MemoryLink[] = [];
  private loaded: boolean = false;

  /** Index: entryId → set of link IDs connected to it */
  private adjacency: Map<string, Set<string>> = new Map();

  constructor(config?: Partial<LinkNetworkConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  async load(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    try {
      const content = await readFile(resolvedPath, 'utf8');
      const data = JSON.parse(content) as { links: MemoryLink[] };
      this.links = data.links ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        tracer.log('memory', 'warn', 'Failed to load link network', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.links = [];
    }

    this.rebuildIndex();
    this.loaded = true;
    tracer.log('memory', 'debug', `Link network loaded: ${this.links.length} links`);
  }

  async save(): Promise<void> {
    const tracer = getTracer();
    const resolvedPath = resolvePath(this.config.path);

    await mkdir(dirname(resolvedPath), { recursive: true });
    await writeFile(
      resolvedPath,
      JSON.stringify({ links: this.links }, null, 2),
      'utf8',
    );

    tracer.log('memory', 'debug', `Link network saved: ${this.links.length} links`);
  }

  // ── Link Operations ───────────────────────────────────────────────────────

  /**
   * Create a bidirectional link between two memory entries.
   */
  createLink(params: {
    sourceId: string;
    targetId: string;
    type: LinkType;
    strength?: number;
    annotation?: string;
  }): LinkResult {
    const tracer = getTracer();

    if (params.sourceId === params.targetId) {
      return { success: false, error: 'Cannot link an entry to itself' };
    }

    // Check for existing link between the same pair
    const existing = this.findLink(params.sourceId, params.targetId);
    if (existing) {
      // Strengthen the existing link
      existing.strength = Math.min(1.0, existing.strength + 0.1);
      existing.lastAccessed = new Date().toISOString();
      if (params.annotation) existing.annotation = params.annotation;
      return { success: true, linkId: existing.id };
    }

    if (this.links.length >= this.config.maxLinks) {
      // Evict the weakest link
      this.evictWeakest();
    }

    const now = new Date().toISOString();
    const link: MemoryLink = {
      id: generateLinkId(),
      sourceId: params.sourceId,
      targetId: params.targetId,
      type: params.type,
      strength: params.strength ?? 0.5,
      createdAt: now,
      lastAccessed: now,
      ...(params.annotation !== undefined ? { annotation: params.annotation } : {}),
    };

    this.links.push(link);
    this.indexLink(link);

    tracer.log('memory', 'debug', `Link created: ${link.id} (${params.sourceId} -[${params.type}]-> ${params.targetId})`);

    return { success: true, linkId: link.id };
  }

  /**
   * Remove a link by ID.
   */
  removeLink(linkId: string): boolean {
    const idx = this.links.findIndex((l) => l.id === linkId);
    if (idx < 0) return false;

    const link = this.links[idx]!;
    this.links.splice(idx, 1);
    this.deindexLink(link);
    return true;
  }

  /**
   * Remove all links connected to an entry (when an entry is deleted).
   */
  removeLinksForEntry(entryId: string): number {
    const linkIds = this.adjacency.get(entryId);
    if (!linkIds || linkIds.size === 0) return 0;

    let removed = 0;
    for (const linkId of [...linkIds]) {
      if (this.removeLink(linkId)) removed++;
    }
    return removed;
  }

  // ── Traversal ──────────────────────────────────────────────────────────────

  /**
   * Get all links connected to an entry (both directions).
   */
  getLinksForEntry(entryId: string): MemoryLink[] {
    const linkIds = this.adjacency.get(entryId);
    if (!linkIds) return [];

    const now = new Date().toISOString();
    return [...linkIds]
      .map((id) => this.links.find((l) => l.id === id))
      .filter((l): l is MemoryLink => l !== undefined)
      .map((l) => {
        l.lastAccessed = now;
        return l;
      })
      .sort((a, b) => b.strength - a.strength);
  }

  /**
   * Get IDs of entries directly connected to the given entry.
   */
  getNeighbors(entryId: string): string[] {
    const links = this.getLinksForEntry(entryId);
    const neighbors = new Set<string>();

    for (const link of links) {
      if (link.sourceId === entryId) neighbors.add(link.targetId);
      if (link.targetId === entryId) neighbors.add(link.sourceId);
    }

    return [...neighbors];
  }

  /**
   * Get the N-hop neighborhood of an entry (breadth-first traversal).
   */
  getNeighborhood(entryId: string, hops: number): string[] {
    const visited = new Set<string>();
    let frontier = new Set([entryId]);

    for (let i = 0; i < hops; i++) {
      const nextFrontier = new Set<string>();
      for (const id of frontier) {
        if (visited.has(id)) continue;
        visited.add(id);
        for (const neighbor of this.getNeighbors(id)) {
          if (!visited.has(neighbor)) {
            nextFrontier.add(neighbor);
          }
        }
      }
      frontier = nextFrontier;
    }

    // Add remaining frontier
    for (const id of frontier) visited.add(id);

    visited.delete(entryId); // Exclude the start node
    return [...visited];
  }

  /**
   * Find a link between two specific entries (either direction).
   */
  findLink(entryA: string, entryB: string): MemoryLink | undefined {
    return this.links.find(
      (l) =>
        (l.sourceId === entryA && l.targetId === entryB) ||
        (l.sourceId === entryB && l.targetId === entryA),
    );
  }

  /**
   * Get links filtered by type.
   */
  getLinksByType(type: LinkType): MemoryLink[] {
    return this.links.filter((l) => l.type === type);
  }

  // ── Maintenance ────────────────────────────────────────────────────────────

  /**
   * Apply time-based decay to all links. Links below minStrength are pruned.
   * Returns the number of pruned links.
   */
  applyDecay(): number {
    const now = Date.now();
    let pruned = 0;

    this.links = this.links.filter((link) => {
      const lastAccessed = new Date(link.lastAccessed).getTime();
      const daysSinceAccess = (now - lastAccessed) / (1000 * 60 * 60 * 24);
      link.strength -= this.config.decayRatePerDay * daysSinceAccess;

      if (link.strength < this.config.minStrength) {
        this.deindexLink(link);
        pruned++;
        return false;
      }
      return true;
    });

    if (pruned > 0) {
      const tracer = getTracer();
      tracer.log('memory', 'info', `Link decay pruned ${pruned} weak links`);
    }

    return pruned;
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  count(): number {
    return this.links.length;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  getAll(): ReadonlyArray<MemoryLink> {
    return this.links;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private rebuildIndex(): void {
    this.adjacency.clear();
    for (const link of this.links) {
      this.indexLink(link);
    }
  }

  private indexLink(link: MemoryLink): void {
    if (!this.adjacency.has(link.sourceId)) {
      this.adjacency.set(link.sourceId, new Set());
    }
    this.adjacency.get(link.sourceId)!.add(link.id);

    if (!this.adjacency.has(link.targetId)) {
      this.adjacency.set(link.targetId, new Set());
    }
    this.adjacency.get(link.targetId)!.add(link.id);
  }

  private deindexLink(link: MemoryLink): void {
    this.adjacency.get(link.sourceId)?.delete(link.id);
    this.adjacency.get(link.targetId)?.delete(link.id);
  }

  private evictWeakest(): void {
    if (this.links.length === 0) return;

    let weakestIdx = 0;
    let weakestStrength = this.links[0]!.strength;

    for (let i = 1; i < this.links.length; i++) {
      if (this.links[i]!.strength < weakestStrength) {
        weakestIdx = i;
        weakestStrength = this.links[i]!.strength;
      }
    }

    const evicted = this.links[weakestIdx]!;
    this.links.splice(weakestIdx, 1);
    this.deindexLink(evicted);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createLinkNetwork(
  config?: Partial<LinkNetworkConfig>,
): LinkNetwork {
  return new LinkNetwork(config);
}
